// The kernel worker protocol and the facade's operations, as TypeScript.
// Mirrors the C facade (kernel-build/facade/facade.cpp, CONTRACT "Kernel facade").
// Owner: KERNEL-HARDENING. Add ops to KernelOps as the facade gains them; keep
// field names identical to the C++ JSON. DOC-CORE's KernelAdapter reads this.
// API 3 (P2/P3, docs/p2p3-plan.md §2): import diagnostics, heal (+ sew),
// brep_write / brep_read, press_pull, combine, measure, sketch_regions,
// extrude_regions. The ops marked "API 3" below are the contract the KERNEL
// builder implements (all of them exist since 2026-10-01; changes to this file
// during the build: docs/p2p3-plan.md §8). API 4 (P4a, the SOLIDS builder):
// revolve_regions, sweep_regions, loft_regions, extrude_face, edge_eval, the
// extents to_vertex / to_point, fillet contours and diagnose, chamfer d2 / flip,
// shell outside, topo edge_ends / vertex_faces. API 5 (P4b, the PATTERN builder):
// B-spline sketch curves (SKETCH's R1), copies (patterns), project, section,
// silhouette (SELECT); `version` answers api: 5. API 6 (press-pull on curved faces):
// offset_faces, and press_pull taking curved faces. API 7 (2026-10-30): volumes (props,
// press-pull's check) integrate B-spline, swept and offset faces by Gauss-Kronrod over the
// knot spans, the plain rule only where it is exact. API 8 (2026-11-02): Analysis Situs asiAlgo
// 2026.1.1 in the kernel: recognize (fillets and drilled holes found by their shape),
// suppress_blends (every fillet up to R taken off as fillets, with history), debug_reshape
// (tests); `version` answers api: 8 and asi: '2026.1.1', and the ready message carries both.
// API 9 (2026-11-02): defeature takes a time budget (budget_ms, far_budget_ms, far_skip) and a heal
// stopped in time answers `stopped` with no shape (OCCT polls while it trims grown faces:
// kernel-build/occt-patches/0002); recognize has two face limits (max_fillet_faces 5,000,
// max_hole_faces 2,600) and its refusal names both; suppress_blends' budget refusal names the time
// and the allowance; debug_budget_words (tests). `version` answers api: 9.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneFrame, Vec2, Vec3 } from './doc';

// ---------------------------------------------------------------- messages

/** worker -> main, always the first message: the kernel is loaded and answered `version`. */
export interface KernelReadyMsg {
  type: 'ready';
  variant: 'wasm32';
  /** OCCT version the kernel was built from, "7.9.3". */
  occt: string;
  /** API 8: the facade contract revision `version` answers (8 = fillet and hole recognition, 9 = defeature's time budget). */
  api: number;
  /** API 8: the Analysis Situs release linked into the kernel ("2026.1.1"), or null when it has none. */
  asi: string | null;
  /** Milliseconds from the worker module's start to `ready` (import + instantiate). */
  init_ms: number;
  heap_bytes: number;
}

/** worker -> main: the kernel could not start (bad URL, CSP, instantiate failed). */
export interface KernelFatalMsg {
  type: 'fatal';
  error: string;
}

/** main -> worker: one call. `bytes` (transferred) becomes params.ptr/len inside the worker. */
export interface KernelCallMsg {
  type: 'call';
  id: number;
  op: string;
  params: Record<string, unknown>;
  bytes?: ArrayBuffer;
}

export type KernelErrorKind =
  /** OCCT refused or failed (Standard_Failure): the model is wrong, the kernel is fine. */
  | 'occt'
  /** Bad parameters (missing id, unknown op). */
  | 'input'
  /** A facade bug or an allocation failure. */
  | 'internal'
  /** The wasm instance trapped (unreachable, out of bounds): the worker must be respawned. */
  | 'trap';

export interface KernelErrorInfo {
  message: string;
  kind: KernelErrorKind;
  /** Out of memory: respawn the worker at the next idle moment. */
  oom?: boolean;
  low_memory?: boolean;
}

/** Binary outputs, copied out of the wasm heap (never views into it). */
export type KernelBuffers = Record<string, ArrayBuffer>;

/** worker -> main: the answer to one call (buffers are in the transfer list). */
export type KernelResultMsg =
  | { type: 'result'; id: number; ok: true; result: Record<string, unknown>; buffers?: KernelBuffers; ms: number; heap_bytes: number }
  | { type: 'result'; id: number; ok: false; error: KernelErrorInfo; ms: number; heap_bytes: number };

export type KernelWorkerMsg = KernelReadyMsg | KernelFatalMsg | KernelResultMsg;

// ---------------------------------------------------------------- ops

/** Shape ids are integers owned by the worker; they die with it (respawn => rebuild). */
export type ShapeId = number;
export type BBox = [number, number, number, number, number, number];

/** Where an output face/edge came from. Sweeps name profile segments (`seg`) and caps. */
export interface HistorySource {
  shape?: ShapeId;
  face?: number;
  edge?: number;
  vertex?: number;
  /** Extrude/revolve: the profile segment id that generated this face. */
  seg?: string;
  /** Extrude/revolve: 'start' or 'end' cap. */
  cap?: 'start' | 'end';
  how: 'modified' | 'generated' | 'same';
}

/**
 * Operation history (every modelling op): what each output face/edge came from,
 * always against the ids the caller passed in (work copies are never exposed).
 * The TypeScript naming layer (DOC-CORE, P4a) runs on this.
 */
export interface OpHistory {
  faces: { out: number; from: HistorySource[] }[];
  edges: { out: number; from: HistorySource[] }[];
  deleted: { shape: ShapeId; face?: number; edge?: number }[];
  /** Extrude/revolve: side face per profile segment id, plus the caps (null when there is none). */
  sides?: Record<string, number>;
  start?: number | null;
  end?: number | null;
  /** Revolve: profile segments lying on the axis (they sweep no face). */
  on_axis?: string[];
  /**
   * extrude_regions (API 3): the caps per requested region key. Regions that
   * merged (adjacent regions extruded together) share their cap faces.
   */
  caps?: Record<string, { start: number | null; end: number | null }>;
}

/** One BRepCheck finding: a status on a sub-shape (index in the result's own index space). */
export interface CheckProblem {
  /** BRepCheck status without the prefix: 'UnorientableShape', 'NotClosed', 'SelfIntersectingWire', ... */
  status: string;
  type: 'vertex' | 'edge' | 'wire' | 'face' | 'shell' | 'solid' | 'compsolid' | 'compound';
  index: number;
  /** For a status found in the context of a bigger sub-shape (an edge in a face). */
  in?: { type: CheckProblem['type']; index: number };
}

/**
 * Validity, reported by every op that makes a shape (decision 3, 02 - P0 results):
 * BRepCheck_Analyzer on the stored result. An invalid result is still stored and
 * returned (ok:true, valid:false) with the reasons, so the document can show a red
 * feature and offer `repair`; it is never passed off as valid. With {check:false}
 * the facade skips the analysis and returns checked:false and no `valid`; the
 * KernelAdapter then calls `check`, so callers of the adapter always get `valid`.
 */
export interface Validity {
  valid: boolean;
  checked?: false;
  check_ms?: number;
  /** When invalid: "invalid result (BRepCheck): UnorientableShape x1, ...". */
  reason?: string;
  /** When invalid: the first 40 findings. */
  problems?: CheckProblem[];
  problem_counts?: Record<string, number>;
  problem_total?: number;
}

/** Result of any op that makes one shape. */
export interface ShapeResult extends Validity {
  id: ShapeId;
  history?: OpHistory;
  /** API 3: face count of the result (TopExp::MapShapes), so names can be made without a `props` call. */
  faces?: number;
  timings?: Record<string, number>;
}

export interface Profile {
  plane: { origin: Vec3; normal: Vec3; xdir: Vec3 };
  loops: ProfileSeg[][];
}
export type ProfileSeg =
  | { id: string; kind: 'line'; a: [number, number]; b: [number, number] }
  | { id: string; kind: 'arc'; c: [number, number]; r: number; a0: number; a1: number; ccw: boolean }
  | { id: string; kind: 'circle'; c: [number, number]; r: number };

/**
 * Extrude extents, as distances (mm) along the extrude direction (the profile
 * plane's normal, or the opposite with flip:true). through_all and to_face are
 * kernel-only for now: not offered in the UI.
 */
export type ExtrudeExtent =
  | { kind: 'blind'; d: number }
  | { kind: 'symmetric'; d: number }
  | { kind: 'two'; d1: number; d2: number }
  /**
   * Past everything in `targets` (both sides of the profile with both:true), by a margin; with
   * fit:true (New body, Join) exactly to their farthest extent, refused when the profile misses them.
   */
  | { kind: 'through_all'; targets: ShapeId[]; both?: boolean; fit?: boolean }
  /** Up to the plane of planar face `face` of `target` (tilted or not); offset goes further. */
  | { kind: 'to_face'; target: ShapeId; face: number; offset?: number }
  /** API 4: up to the plane through vertex `vertex` of `target`, parallel to the profile; offset goes further. */
  | { kind: 'to_vertex'; target: ShapeId; vertex: number; offset?: number }
  /** API 4: up to the plane through a point (mm), parallel to the profile. */
  | { kind: 'to_point'; point: Vec3; offset?: number };

/** API 4: how far a revolve turns (degrees; 360 in all is a full turn). */
export type RevolveExtent = { kind: 'one'; angle: number } | { kind: 'symmetric'; angle: number } | { kind: 'two'; angle: number; angle2: number };

/**
 * API 4: what fillet {diagnose: true} answers (nothing is stored): done = the fillet works
 * and is valid at that radius; failed = OCCT refused outright (else the result was invalid);
 * faulty = input edges of the contours OCCT could not fillet; max_ok = the largest radius
 * found to work (smaller radii tried, then bisected), or null.
 */
export interface FilletDiagnosis {
  done: boolean;
  failed: boolean;
  faulty: number[];
  max_ok: number | null;
}

/** API 4: the regions of one sketch (as extrude_regions takes them). */
export interface RegionSection {
  plane: PlaneFrame;
  curves: SketchCurve[];
  regions: string[];
  tol?: number;
}

/** Common to every shape op: skip the BRepCheck of the result (see Validity). A type
 * alias, not an interface, so params stay assignable to Record<string, unknown>. */
type CheckParam = { check?: boolean };

/**
 * Edge display flags: tessellate's `edge_flags` buffer holds one byte per edge
 * index. EDGE_HIDDEN edges are not model edges (a viewport skips them).
 */
export const EDGE_FLAG = {
  /** Closes a periodic face on itself (cylinder, cone, sphere seam). */
  seam: 1,
  /** A pole (no length): sphere and cone tips. */
  degenerated: 2,
  /** INTERNAL/EXTERNAL inside a face (a tangent join can leave one). */
  internal: 4,
  /** Between two faces on the same surface (a split left behind). */
  same_domain: 8,
  /** Tangent-continuous between its two faces (a fillet boundary). */
  smooth: 16,
  /** On one face only (boundary of an open shell). */
  free: 32,
} as const;
export const EDGE_HIDDEN = EDGE_FLAG.seam | EDGE_FLAG.degenerated | EDGE_FLAG.internal | EDGE_FLAG.same_domain;

/** A topo selector: all (default), none, some indices, or a chunk {start, count}. */
export type TopoSelector = 'all' | 'none' | number[] | { start: number; count: number };

/**
 * op name -> params / result. Lengths in mm, angles in degrees. Buffers named
 * in `buffers` come back as ArrayBuffers in the reply.
 */
export interface KernelOps {
  /**
   * `api`: facade contract revision (3 = docs/p2p3-plan.md §2; 4 = P4a solids; 5 = P4b; 6 = offset_faces;
   * 7 = volumes; 8 = Analysis Situs, this file's header). `asi`: the Analysis Situs release linked in
   * (API 8; absent from a build without it, such as wasm64).
   */
  version: { params: Record<string, never>; result: { occt: string; build: 'wasm32' | 'wasm64'; api?: number; asi?: string } };
  mem: {
    params: Record<string, never>;
    result: { heap_bytes: number; used_bytes: number; sbrk_top: number; shapes: number; alloc_failures: number; reserve: boolean };
  };
  release: { params: { ids: ShapeId[] } | { all: true }; result: Record<string, never> };
  box: { params: CheckParam & { dx: number; dy: number; dz: number; origin?: Vec3 }; result: ShapeResult };
  cylinder: { params: CheckParam & { r: number; h: number; origin?: Vec3; axis?: Vec3 }; result: ShapeResult };
  sphere: { params: CheckParam & { r: number; center?: Vec3 }; result: ShapeResult };
  extrude: {
    params: CheckParam & { profile: Profile; extent: ExtrudeExtent; flip?: boolean; taper_deg?: number };
    /** from/to: the span used along `direction` (resolved for through_all / to_face). */
    result: ShapeResult & { from: number; to: number; direction: Vec3 };
  };
  revolve: { params: CheckParam & { profile: Profile; axis: { origin: Vec3 | [number, number]; dir: Vec3 | [number, number] }; angle_deg: number }; result: ShapeResult };
  /**
   * Join / cut / intersect; runs on work copies of every input. fuzzy: extra
   * tolerance (mm) for nearly coincident geometry. glue: OCCT's gluing for bodies
   * that only touch ('shift' partial, 'full' identical faces): faster and more
   * robust there, but WRONG (valid, un-subtracted) on bodies that really overlap,
   * so never on by default. unify (default true): merge same-domain faces, with history.
   */
  boolean: {
    params: CheckParam & {
      op: 'fuse' | 'cut' | 'common';
      targets: ShapeId[];
      tools: ShapeId[];
      keep_tools?: boolean;
      fuzzy?: number;
      glue?: 'off' | 'shift' | 'full';
      unify?: boolean;
      check_inverted?: boolean;
    };
    result: ShapeResult & { empty: boolean; solids: number; warnings: boolean; warning_text?: string; fuzzy: number; glue: 'off' | 'shift' | 'full' };
  };
  /**
   * Split by a plane or by a tool body; `valid` is true only if every piece is and
   * no input face is lost: `lost_faces` > 0 (OCCT's splitter dropped a piece without
   * an error) makes it false, with the reason, even with check:false.
   */
  split: {
    params: CheckParam & ({ id: ShapeId; plane: { origin: Vec3; normal: Vec3 } } | { id: ShapeId; tool: ShapeId });
    result: {
      ids: ShapeId[];
      valid: boolean;
      checked?: false;
      pieces_valid?: boolean[];
      reason?: string;
      piece_problems?: Record<string, Validity>;
      history: { pieces: { id: ShapeId; faces: OpHistory['faces']; edges: OpHistory['edges'] }[]; deleted: OpHistory['deleted'] };
      /** API 3: the face count of each piece, in the order of `ids`. */
      faces: number[];
      /** API 3: input faces in no piece (0 for a split that kept all of the body). */
      lost_faces: number;
    };
  };
  /**
   * Local ops run on a work copy: the input never changes. OCCT failing outright is
   * ok:false ("... the body is unchanged"); OCCT "succeeding" with an invalid solid
   * is ok:true, valid:false with the reasons.
   */
  /**
   * API 4: `contours` = the input edges each contour runs along (a picked edge takes its
   * tangent neighbours with it). With diagnose:true nothing is stored: the answer is
   * FilletDiagnosis (why it fails and the largest radius that works).
   */
  fillet: { params: CheckParam & { id: ShapeId; edges: number[]; r: number; diagnose?: boolean }; result: ShapeResult & { contours?: number[][] } };
  /**
   * API 4: d2 (two distances: d on each edge's reference face, its lower-numbered face, d2 on
   * the other; flip:true swaps which face is the reference); `contours` as fillet.
   */
  chamfer: { params: CheckParam & { id: ShapeId; edges: number[]; d: number; d2?: number; flip?: boolean }; result: ShapeResult & { contours?: number[][] } };
  /**
   * OCCT's BRepAlgoAPI_Defeaturing: the faces taken off and the gap healed; history against the input, always.
   * API 9, a time budget (none given: the heal runs to the end, as before): budget_ms stops OCCT's
   * heal at its first progress poll after that long (kernel-build/occt-patches/0002 polls while each
   * grown face is trimmed); far_budget_ms is the budget instead when the heal would grow a kept curved
   * face (not a plane, cylinder, cone, sphere or torus, and turned more than half a turn by the growth:
   * a flat B-spline is not) more than 4 times its own size (the smaller of the two when both are
   * given); far_skip does not start such a heal at all. The page sends budget_ms (the call's watchdog
   * limit) and, first on a version 2 Delete faces, far_skip; never far_budget_ms. A stopped heal answers
   * `stopped` and nothing else (no id, history or validity: the body is unchanged); a result of a
   * call with a budget that found such faces reports them in `far_grown`.
   */
  defeature: {
    params: CheckParam & { id: ShapeId; faces: number[]; budget_ms?: number; far_budget_ms?: number; far_skip?: boolean };
    result: ShapeResult & { history: OpHistory; warnings: boolean; warning_text?: string; far_grown?: number[]; stopped?: DefeatureStopped };
  };
  /**
   * API 8. Fillets and drilled holes of a body found by their shape (Analysis Situs asiAlgo
   * RecognizeBlends and RecognizeDrillHoles), whatever made them. Read-only: nothing is stored.
   * Face indices are the body's (0-based); every list is sorted by its smallest face. Refused in
   * words: no solid ("no solid in this body (fillets and holes are found on solids only)"), and a
   * body over a face limit. API 9: two limits, max_fillet_faces (5,000) for a query that finds
   * fillets and max_hole_faces (2,600) for one that finds holes, and the words name both, the one
   * the query ran into first: "this body has 5,400 faces: fillets are found on bodies of up to 5,000
   * faces and holes on bodies of up to 2,600", "this body has 3,000 faces: holes are found on bodies
   * of up to 2,600 faces and fillets on bodies of up to 5,000". max_faces sets both (API 8's one
   * limit) and keeps API 8's words: "this body has 2,002 faces: fillets and holes are found on
   * bodies of up to 2,000". The page sends both of its own (RECOGNIZE_MAX_FILLET_FACES and
   * RECOGNIZE_MAX_HOLE_FACES in src/kernel/timeouts.ts, the kernel's defaults).
   */
  recognize: {
    params: {
      id: ShapeId;
      blends?: boolean;
      holes?: boolean;
      /** One limit for the call, fillets and holes alike (API 8's parameter); max_fillet_faces and max_hole_faces override it. */
      max_faces?: number;
      /** API 9: the largest body whose fillets are found (default 5,000 faces, measured: a running call cannot be stopped). */
      max_fillet_faces?: number;
      /** API 9: the largest body whose holes are found (default 2,600 faces; the drill-hole search is quadratic). */
      max_hole_faces?: number;
      /** Analysis Situs' own radius limit: the set suppress_blends takes at R (default: every fillet). */
      max_r?: number;
      /** asiAlgo_RecognizeDrillHoles' mode (default soft). */
      holes_mode?: 'soft' | 'hard';
    };
    result: RecognizeResult;
  };
  /**
   * API 8. Take fillets off one solid as fillets (asiAlgo_SuppressBlendsInc). The picked faces must
   * be every fillet of the solid up to the largest picked radius R (checked against its own
   * recognition at R), and the run must be predicted to fit the kernel's budget (`budget_ms` may
   * only lower it), else words such as "taking 404 fillet faces off as fillets on a body of 810
   * faces would take about 20 s; Delete faces allows 1.4 s for taking fillets off as fillets"
   * (API 9; below 10 s one decimal, never at or under the allowance). The history walks every input face to all its
   * images; the kernel refuses unless exactly the picked faces are gone and every result face has a
   * source. Nothing taken off is refused, never passed through.
   */
  suppress_blends: {
    params: CheckParam & { id: ShapeId; faces: number[]; budget_ms?: number; debug_history?: 'leaves' | 'convert_to_occ' };
    result: SuppressBlendsResult;
  };
  /**
   * API 8, tests only: an exporter-like "messy" copy of a body (bspline: every surface and curve a
   * B-spline; split_closed: closed faces cut in two; tolerance_scale: every tolerance multiplied).
   * A new stored shape with `valid` and no history; the input never changes.
   */
  debug_reshape: { params: CheckParam & { id: ShapeId; bspline?: boolean; split_closed?: boolean; tolerance_scale?: number }; result: ShapeResult };
  /**
   * API 9, tests only: suppress_blends' words for a run predicted at `predicted_ms` over its budget
   * (budget_ms may only lower suppress_blends' own 1,400 ms), so tests can check the rounding at
   * chosen times. `refused` is whether suppress_blends would refuse that prediction.
   */
  debug_budget_words: { params: { picks: number; faces: number; predicted_ms: number; budget_ms?: number }; result: { refused: boolean; budget_ms: number; words: string } };
  /** API 4: outside:true puts the wall outside the body's faces (the body becomes the cavity). */
  shell: { params: CheckParam & { id: ShapeId; faces: number[]; t: number; tol?: number; outside?: boolean }; result: ShapeResult };
  /**
   * Try to make a body valid: ShapeFix_Shape then UnifySameDomain (unify, default
   * true) on a work copy, with history against the input. A new body with its own
   * `valid`; `fixed` says whether ShapeFix changed anything. A valid repair is not
   * necessarily a right one: compare volume / faces before accepting it.
   */
  repair: {
    params: CheckParam & { id: ShapeId; tol?: number; max_tol?: number; unify?: boolean };
    result: ShapeResult & {
      fixed: boolean;
      before: { faces: number; edges: number; vertices: number };
      after: { faces: number; edges: number; vertices: number };
    };
  };
  /** BRepCheck of a stored body. */
  check: { params: { id: ShapeId; max_problems?: number }; result: Validity & { valid: boolean; check_ms: number } };
  /**
   * Cheap by default: counts and a fast bounding box (padded by the shape's
   * tolerances, so it always encloses the body). volume / area / exact bbox on
   * request (they take 20-90 s on a 100 MB part). bbox_mode is the older spelling
   * ('optimal' = 'exact').
   */
  props: {
    /** volume_eps (API 3): adaptive volume integration to that relative error (the default is off by ~1.5e-7 on B-spline parts); the result adds volume_error. */
    params: { id: ShapeId; volume?: boolean; area?: boolean; bbox?: 'fast' | 'exact' | 'none'; bbox_mode?: 'fast' | 'optimal'; volume_eps?: number };
    result: {
      faces: number;
      edges: number;
      vertices: number;
      solids: number;
      shells: number;
      bbox?: BBox | null;
      bbox_mode: 'fast' | 'exact' | 'none';
      /**
       * API 7: the plain Gauss rule on faces where it is exact (analytic surfaces bounded by
       * lines and circles), Gauss-Kronrod over the knot spans to 1e-9 on the others (B-spline,
       * swept and offset faces, B-spline boundaries); over 2000 faces the plain rule throughout.
       */
      volume?: number;
      /** With volume_eps, or when any face took Gauss-Kronrod: the integration's error estimate. */
      volume_error?: number;
      /** 'spans' when any face took Gauss-Kronrod (API 7; API 5: sketch-spline faces only). */
      integration?: 'spans';
      /** The plain rule's over every face (API 7: Gauss-Kronrod gives the volume only). */
      centroid?: Vec3 | null;
      area?: number;
      timings: Record<string, number>;
    };
  };
  /**
   * Naming signatures. Everything by default; on large parts select what is needed
   * (faces/edges/vertices: TopoSelector) and walk big parts in chunks
   * (src/kernel-worker/topo-chunks.ts). face_bbox 'exact' (default) is the slow part.
   */
  topo: {
    params: {
      id: ShapeId;
      faces?: TopoSelector;
      edges?: TopoSelector;
      vertices?: TopoSelector;
      face_bbox?: 'exact' | 'fast' | 'none';
      face_mass?: boolean;
      edge_length?: boolean;
      /** API 4: edges also give first / last (parameter order), their vertex indices and a line's dir. */
      edge_ends?: boolean;
      /** API 4: vertices also give the sorted indices of their faces. */
      vertex_faces?: boolean;
    };
    result: TopoResult;
  };
  /**
   * Buffers: positions f32 (xyz), normals f32, indices u32, face_ranges u32
   * (per face index: [start in indices, count of indices]), edge_positions f32
   * (segment pairs), edge_ranges u32 (per edge index: [start point, point count]),
   * edge_flags u8 (per edge index: EDGE_FLAG bits; absent with edge_flags:false).
   */
  tessellate: {
    params: { id: ShapeId; lin_defl?: number; ang_defl_deg?: number; edge_flags?: boolean; smooth?: boolean };
    result: {
      triangles: number;
      vertices: number;
      lin_defl: number;
      mesh_status: number;
      faces_without_triangles: number;
      hidden_edges: number;
      timings: Record<string, number>;
    };
  };
  /**
   * Read a STEP (bytes in, as params.ptr/len). API 3 adds `diagnose` (BRepCheck
   * of every shape as read, before any healing) and the file's length unit.
   * P2 imports with heal:false and then calls `heal`, so the panel can show the
   * problems before and after and "Heal all" can run again with another
   * tolerance without reading the file again (the raw ids stay alive until
   * released). heal:true (default, P1 behaviour) heals in the same call.
   */
  import_step: {
    params: { name: string; heal?: boolean; tol?: number; xcaf?: boolean; bbox_mode?: 'fast' | 'optimal'; diagnose?: boolean };
    result: {
      /**
       * One shape per solid, or one surface body (type 'shell': its shells and
       * loose faces together) per STEP product without solids. API 3: `faces`;
       * with diagnose, `valid` (+ `reason`) of the shape returned.
       */
      shapes: (ImportedShape & { color_linear: [number, number, number] | null; valid?: boolean; reason?: string })[];
      faces: number;
      edges: number;
      bbox: BBox | null;
      /** API 3: the length unit the file declared ("inch", "millimetre"), or null. */
      unit?: string | null;
      /** API 3, with heal: on how many shapes ShapeFix changed something. */
      fixed?: number;
      /**
       * API 3, with diagnose (default true): problems of the shapes returned (as
       * read with heal:false; healed with heal:true), with their ids and index spaces.
       */
      diagnostics?: ShapeDiagnostics;
      timings: Record<string, number>;
    };
  };
  /**
   * API 3. Heal shapes (work copies; the inputs never change): ShapeFix_Shape at
   * `tol` (precision and max tolerance), then, unless sew is false,
   * BRepBuilderAPI_Sewing at `sew_tol` (default tol) of every face that is not in
   * a valid closed solid, over all inputs together (a surface model often comes
   * as one shell per face), and closed shells made into solids (ShapeFix_Solid).
   * sew: true and 'auto' (default) are the same: only faces outside valid closed
   * solids are sewn, so valid solids are never touched by sewing. Outputs: every
   * valid closed solid, every knitted solid, and per input the faces left open as
   * one surface body (type 'shell'); with sew:false one output per input. Ordered
   * by `from` (the first input each came from); the STEP name and colour are that
   * input's (import_step keeps them with the shape). Every output reports `valid`
   * and its own `history` (its faces -> input faces, ShapeFix + sewing);
   * `deleted` lists input faces in no output.
   */
  heal: {
    params: CheckParam & { ids: ShapeId[]; tol?: number; sew?: boolean | 'auto'; sew_tol?: number; diagnose?: boolean };
    result: {
      shapes: (ImportedShape & Validity & { from: ShapeId; faces: number; history: OpHistory })[];
      /** Inputs ShapeFix changed something on. */
      fixed: number;
      /** Faces that went through sewing (0 when it did not run). */
      sewn: number;
      /** Free (unshared) edges on all outputs: an open model stays a surface body. */
      free_edges: number;
      /** Input faces that are in no output. */
      deleted: OpHistory['deleted'];
      /** With diagnose (default true): the outputs' problems. */
      diagnostics?: ShapeDiagnostics;
      timings: Record<string, number>;
    };
  };
  /**
   * API 3. The shapes, in order, as one compound in OCCT's binary BREP format
   * (BinTools::Write, no triangulation). Buffer: brep (u8). Used to store an
   * import's healed shapes in ws.files; brep_read gives the same shapes back with
   * the same face/edge/vertex indices.
   */
  brep_write: {
    params: { ids: ShapeId[] };
    result: { bytes: number; occt: string; timings: Record<string, number> };
  };
  /**
   * API 3. Bytes (params.ptr/len) written by brep_write -> one shape per
   * compound child, in order. No healing. check:false by default (the import
   * stored its validity); with check:true each shape reports `valid`.
   */
  /**
   * LINK (host API 1.5). The design as the app links it: one compound of the
   * SOLIDS of `ids`, in order, as a BinTools BREP (format version 4, pinned: the
   * app's OCP 7.9.3 reads it), no triangulation; buffer `brep`. With it the app's
   * face numbering (magnusim_sdk.link.face_visits): every TopExp_Explorer(FACE)
   * visit over the compound, no de-duplication, as `visit_body[i]` (the 1-based
   * solid it is explored in) and `visit_face[i]` (the face's 0-based index in its
   * own shape's face map). `solids[k]` is solid k + 1: its shape's index in `ids`
   * (`src`), its place among that shape's solids (`piece`, 1-based) and its visits.
   * `empty`: the indices in `ids` of shapes with no solid (left out). No solid at
   * all: ok:false.
   */
  link_export: {
    params: { ids: ShapeId[] };
    result: {
      bytes: number;
      occt: string;
      format_version: number;
      solids: { src: number; piece: number; faces: number }[];
      empty: number[];
      visit_body: number[];
      visit_face: number[];
      timings: Record<string, number>;
    };
  };
  brep_read: {
    params: { check?: boolean };
    result: {
      shapes: { id: ShapeId; type: 'solid' | 'shell' | 'other'; faces: number; valid?: boolean; reason?: string }[];
      occt: string;
      timings: Record<string, number>;
    };
  };
  /**
   * API 3. Press-pull faces of one body (work copy): a prism of each flat face
   * along its own outward normal by d (d > 0, fused) or against it by |d|
   * (d < 0, cut), all tools in one boolean, then UnifySameDomain with history.
   * API 6: a curved face's tool is the face thickened by d (BRepOffset_MakeOffset
   * thickening a copy of it); its walls are its `sides`. `moved[i]`: the result face where input face faces[i] now lies (-1 if it is
   * gone). `sides`: result face per boundary edge of a moved face, keyed
   * "<input face>:<input edge>" (absent where the side merged with a neighbour
   * that already lay in that plane). d so negative that nothing is left is
   * ok:false ("press-pull would remove the whole body"). `unified`: faces on the
   * same surface were merged (false when merging made the result invalid and the
   * unmerged one is valid: see combine). glue 'shift' (kernel-only) is OCCT's
   * gluing, right only when the prisms merely touch the body.
   */
  press_pull: {
    params: CheckParam & { id: ShapeId; faces: number[]; d: number; fuzzy?: number; glue?: 'off' | 'shift'; unify?: boolean };
    result: ShapeResult & { moved: number[]; sides: Record<string, number>; op: 'fuse' | 'cut'; empty: boolean; solids: number; unified: boolean };
  };
  /**
   * API 6. Offset picked faces of one body by d along their outward normals (d > 0 adds
   * material), as one true offset on a work copy: BRepOffset_MakeOffset with d on the
   * picked faces, 0 on the others and join type Intersection, so the neighbours are
   * extended or trimmed to meet them (no step). A cylinder's, cone's, sphere's or torus's
   * radius changes; a fillet (a cylinder or torus blend of less than half a turn between
   * two tangent faces) is taken off (BRepAlgoAPI_Defeaturing) and its edge rounded again at
   * the new radius, so it stays tangent. OCCT moves faces tangent to a moved one with it
   * (`tangent`). Every face keeps its name (history `modified`); a re-rounded fillet's faces
   * are `modified` from the old fillet. A result that is invalid, cuts through itself
   * (BRepAlgoAPI_Check) or loses a face next to a picked one is refused, as is a d that
   * takes a radius to 0: the answer then has `refused` instead of `id` (not an error), and
   * with diagnose:true `max_ok`, the largest |d| (same sign) found to work by bisection on
   * fresh work copies (at most 10 runs), or null.
   */
  offset_faces: {
    /**
     * Fix round 1: `carry` (faces, e.g. a Chamfer feature's by name, put back at their own size
     * when next to a pick; fillets next to a pick are found by shape) and `chain` (when the
     * offset is refused: a cylinder's ring, then the prisms / thickened faces; never a method
     * that would leave a step). Every result passes the accept rule: valid, not cutting
     * through itself, the picked faces and every other face kept, no split from adding
     * material, the volume change within 0.5x-2x of the faces' expected change.
     */
    params: CheckParam & { id: ShapeId; faces: number[]; d: number; self_check?: boolean; diagnose?: boolean; carry?: number[]; chain?: boolean };
    result: OffsetFacesResult;
  };
  /**
   * API 3. Join / Cut / Intersect with several targets and several tools, one
   * call: join fuses every target and tool into one shape; cut and intersect
   * give one result per target (target minus / common with the union of the
   * tools). Work copies of every input (copied together). Each result reports
   * valid / empty / solids / faces and its history against the input ids. Whether
   * tool bodies stay is the document's business (inputs never change).
   * UnifySameDomain (unify, default true) runs on a copy and is checked: when the
   * merged result is invalid and the unmerged one valid (OCCT 7.9.3 can merge two
   * coincident cylinders with different seams into a broken face), the unmerged
   * one is kept and `unified` is false.
   */
  combine: {
    params: CheckParam & {
      op: 'join' | 'cut' | 'intersect';
      targets: ShapeId[];
      tools: ShapeId[];
      fuzzy?: number;
      unify?: boolean;
    };
    result: {
      results: (Validity & { target: ShapeId; id: ShapeId; empty: boolean; solids: number; faces: number; unified: boolean; history: OpHistory; warning_text?: string })[];
      timings: Record<string, number>;
    };
  };
  /**
   * API 3. Measure one entity, or two (BRepExtrema_DistShapeShape for the
   * minimum distance; analytic angles for planes, lines and axes). A whole body
   * reports volume, area and centroid only when it is the one target.
   */
  measure: {
    params: { a: MeasureTarget; b?: MeasureTarget };
    result: MeasureResult;
  };
  /**
   * API 3. Closed profile regions of a sketch, computed in the kernel: every
   * non-construction curve becomes an edge on `plane`, the edges are split at
   * every crossing (BOPAlgo_Builder, general fuse), a planar face covering them
   * all is split by them (BOPAlgo_BuilderFace), and the faces that do not touch
   * the covering face's outer boundary are the regions. Each region comes back
   * with its canonical key (docs/p2p3-plan.md §2.8: cyclic oriented
   * sub-segments, split points named by sketch point ids or by the crossing
   * entity pair plus a pair-canonical ordinal, so a dimension change keeps the
   * key), area, a point inside, and (tess:true, default) a triangulation for
   * shading. Open ends (degree-1 vertices of the split curves) and entities on
   * no region's boundary are reported. Buffers: tri_uv f32 (u,v pairs),
   * tri_idx u32, tri_ranges u32 (per region: [start in tri_idx, count]).
   * Points are accepted and ignored (they never bound a region).
   */
  sketch_regions: {
    params: { plane: PlaneFrame; curves: SketchCurve[]; tol?: number; tess?: boolean; deflection?: number };
    result: {
      regions: KernelRegion[];
      open: { at: Vec2; entity: string; point: string | null }[];
      /** Non-construction entities that bound no region (open chains, lines sticking out). */
      dangling: string[];
      /** The tolerance used (mm; default 1e-7 x the sketch's extent). */
      tol: number;
      timings: Record<string, number>;
    };
  };
  /**
   * API 3. Extrude sketch regions by key. The kernel derives the regions again
   * from the curves (same algorithm as sketch_regions) and refuses keys it does
   * not find (InputError "region not found: <key>"); adjacent regions are fused
   * into one face first, so their shared sub-segments sweep no face. History:
   * `sides` keyed by the unsigned sub-segment token (`<entity>[<from>><to>]`),
   * `caps` per region key, `start`/`end` = the first region's caps. Same extents
   * and flip as `extrude` (through_all / to_face kernel-only).
   */
  extrude_regions: {
    /** API 4: direction (unit, model) instead of the plane normal; not in the plane, no taper with it. */
    params: CheckParam & { plane: PlaneFrame; curves: SketchCurve[]; regions: string[]; extent: ExtrudeExtent; flip?: boolean; taper_deg?: number; tol?: number; direction?: Vec3 };
    result: ShapeResult & { from: number; to: number; direction: Vec3; solids: number };
  };
  /**
   * API 4. Revolve sketch regions (as extrude_regions picks and merges them) about an axis
   * (model mm): one side, symmetric or two sides; flip turns the other way. Refused: an axis
   * perpendicular to the sketch plane, a profile across an axis in its plane, more than 360.
   * History as extrude_regions plus `on_axis` (sub-segments on the axis sweep no face).
   */
  revolve_regions: {
    params: CheckParam & RegionSection & { axis: { origin: Vec3; dir: Vec3 }; extent: RevolveExtent; flip?: boolean };
    result: ShapeResult & { full: boolean; from_deg: number; to_deg: number; solids: number };
  };
  /**
   * API 4. Sweep sketch regions along a path: curves of a sketch (lines, arcs, or one
   * circle) chained end to end (`entities` picks some). orientation 'follow' (default) or
   * 'fixed'. History: `sides` keyed "<sub-segment token>@<path curve id>", caps start/end
   * (none on a closed path), `caps` per region key. Refused: a gap, a branch, no curves.
   */
  sweep_regions: {
    params: CheckParam & RegionSection & { path: { plane: PlaneFrame; curves: SketchCurve[]; entities?: string[] }; orientation?: 'follow' | 'fixed' };
    result: ShapeResult & { closed_path: boolean; solids: number };
  };
  /**
   * API 4. Loft through 2+ sections (each the regions of one sketch making one face without
   * holes), in order; ruled: straight between sections. History: sides by the first
   * section's tokens ("<token>@<section>" for faces only a later section made), caps.
   */
  loft_regions: {
    params: CheckParam & { sections: RegionSection[]; ruled?: boolean };
    result: ShapeResult & { solids: number };
  };
  /**
   * API 4. Extrude a flat face of a body (no sketch): its outward normal is the direction
   * (flip: inward); extents as extrude, no taper. The body is not changed. History: sides
   * `seg` "e<i>" (input edge i), caps start (on the face) / end.
   */
  extrude_face: {
    params: CheckParam & { id: ShapeId; face: number; extent: ExtrudeExtent; flip?: boolean; direction?: Vec3 };
    result: ShapeResult & { from: number; to: number; direction: Vec3 };
  };
  /**
   * API 4 (REFERENCE's R2). Points of an edge by arc length from `first` or by fraction,
   * every crossing with a plane (none for an edge in it), the nearest point to a point. The
   * edge's orientation is ignored (first = the curve's first parameter).
   */
  edge_eval: {
    params: { id: ShapeId; edge: number; at?: ({ distance: number } | { fraction: number })[]; plane?: { origin: Vec3; normal: Vec3 }; near?: Vec3 };
    result: {
      type: 'line' | 'circle' | 'ellipse' | 'bspline' | 'other' | 'degenerate';
      length: number;
      first: Vec3;
      last: Vec3;
      closed: boolean;
      points: { p: Vec3; tangent: Vec3 }[];
      crossings: { p: Vec3; tangent: Vec3 }[];
      nearest?: { p: Vec3; tangent: Vec3; distance: number };
    };
  };
  /**
   * API 5 (P4b patterns). Copies of a shape, one per transform (a rotation or a mirror: an
   * orthonormal 3x3 with determinant +-1, plus a translation; no scale), each its own shape. A copy
   * keeps its source's numbering (`maps[k]` null); when OCCT renumbered a mirrored copy, maps[k][i]
   * is the copy's face index of source face i. Each copy checked (valid[k], reasons[k]) unless
   * check:false. The source never changes.
   */
  copies: {
    params: CheckParam & { id: ShapeId; transforms: KernelTransform[] };
    result: { ids: ShapeId[]; faces: number[]; maps: (number[] | null)[]; valid?: boolean[]; reasons?: (string | null)[]; all_valid?: boolean; checked?: false };
  };
  /**
   * API 5 (SELECT's Project). Each item projected along the plane normal onto the plane, in the
   * plane's u/v: an edge's curve (a line seen end-on is a point, a circle seen edge-on a line, an
   * ellipse a rational B-spline); a face's outer wire edges, head to tail (all_wires: the holes'
   * edges too); a vertex a point. `src` names the body's edge / vertex each curve came from.
   */
  project: {
    params: { plane: PlaneFrame; items: { id: ShapeId; face?: number; all_wires?: boolean; edge?: number; vertex?: number }[]; tol?: number; cubic?: boolean };
    result: { items: { curves: (PlaneCurve & { src: PlaneCurveSrc })[]; message?: string }[] };
  };
  /**
   * API 5 (SELECT's Intersect). Where the (infinite) plane cuts each body (BRepAlgoAPI_Section), in
   * the plane's u/v, chained head to tail into loops; `src.face` = the body's face a curve lies on.
   * A body the plane misses has `loops: []`.
   */
  section: {
    params: { plane: PlaneFrame; ids: ShapeId[]; tol?: number; cubic?: boolean };
    result: { bodies: { id: ShapeId; loops: { closed: boolean; curves: (PlaneCurve & { src: PlaneCurveSrc })[] }[] }[] };
  };
  /**
   * API 5 (SELECT's Silhouette). The outline of what the bodies cover, seen along the plane normal
   * (HLR visible sharp edges and outlines, the covered regions merged): closed loops head to tail,
   * the outer ones (hole: false) and the holes one can see through (hole: true); `empty` when the
   * bodies cover nothing.
   */
  silhouette: {
    params: { plane: PlaneFrame; ids: ShapeId[]; tol?: number; cubic?: boolean };
    result: { loops: { curves: PlaneCurve[]; hole: boolean }[]; empty: boolean };
  };
  /** Buffer: step (u8, the file's bytes). */
  export_step: { params: { shapes: { id: ShapeId; name: string; color?: [number, number, number] }[]; schema: 'AP214' | 'AP242' }; result: Record<string, never> };
}

/**
 * API 8: one recognised fillet face. `r` is Analysis Situs' own radius (one sample per face);
 * r_min / r_max are exact for a cylinder, a torus (its tube radius) and a sphere, otherwise
 * 1 / the largest principal curvature over a 5 x 5 grid of the face. `convex` is null when mixed
 * or not known. kind 'cliff' is tangent on one side only, 'uncertain' could not be classed: neither
 * is counted as a fillet by the app. `chain`: index into `chains`, null for none.
 */
export interface RecognizedBlend {
  face: number;
  r: number;
  r_min: number;
  r_max: number;
  convex: boolean | null;
  kind: 'ordinary' | 'vertex' | 'cliff' | 'uncertain';
  chain: number | null;
}

/** API 8: what `recognize` answers. Faces are the body's (0-based); each list sorted by its smallest face. */
export interface RecognizeResult {
  faces: number;
  solids: number;
  blends: RecognizedBlend[];
  /** Fillet faces joined smoothly into one chain (the faces SuppressBlendsInc takes off together). */
  chains: { faces: number[]; r_min: number; r_max: number; length: number }[];
  /**
   * Drilled holes: their faces (wall, bottom, countersink, rounded rim), the narrowest and widest
   * bore (2 x the smallest and largest cylinder radius; null when the hole has no cylinder) and
   * whether it goes through (no face of the hole closes its axis).
   */
  holes: { faces: number[]; d_min: number | null; d_max: number | null; through: boolean }[];
  timings: { copy_ms: number; aag_ms: number; blends_ms: number; holes_ms: number };
}

/**
 * API 9: a defeature its budget stopped (the body is unchanged): the budget it ran with (0 when
 * far_skip did not start it), how long it ran, and the kept curved faces OCCT would grow more than
 * 4 times their size and turn more than half a turn (0-based on the input; empty when there are
 * none) with the largest ratio of growth to size.
 */
export interface DefeatureStopped {
  budget_ms: number;
  after_ms: number;
  far_grown: number[];
  far_ratio?: number;
  /** far_skip: the heal was not started. */
  skipped?: boolean;
}

/** API 8: what `suppress_blends` answers (a shape result with the history every naming step reads). */
export interface SuppressBlendsResult extends ShapeResult {
  history: OpHistory;
  faces: number;
  /** Chains SuppressBlendsInc took off. */
  chains: number;
  /** The largest picked fillet radius, and the limit SuppressBlendsInc ran with (r x 1.001). */
  r: number;
  max_r: number;
  asked: number;
  removed: number;
  left: number;
  /** The kernel's self-check (split may be > 0 on a returned result; the others are 0). */
  self_check: { split: number; stale_leaves: number; dropped: number };
  /** Analysis Situs' ConvertToOcc read against the facade's own history (comparison only). */
  convert_to_occ: { disagree: number; fewer_images: number; no_source: number };
  /** The run-time prediction the kernel checked before SuppressBlendsInc ran, and its budget. */
  cost: {
    /** Chains of the pick at R; the adjacency work of one graph build before and after the picks are gone; chains among and picks that are free-form faces. */
    chains: number;
    pair_work: number;
    pair_work_after: number;
    free_form_chains: number;
    free_form_picks: number;
    predicted_ms: number;
    budget_ms: number;
  };
  timings: { copy_ms: number; recognize_ms: number; suppress_ms: number; history_ms: number; op_ms: number };
}

/** A shape as import_step / heal give it back. */
export interface ImportedShape {
  id: ShapeId;
  /** The STEP product or body name ("Body1"), or the file name. */
  name: string;
  /** sRGB 0..1, when the file gave one. */
  color: [number, number, number] | null;
  type: 'solid' | 'shell' | 'other';
  faces?: number;
}

/** BRepCheck (and, for shells, free-edge) findings per shape, for the import diagnostics panel. */
export interface ShapeDiagnostics {
  /** Problems in all (sum of problem_total). */
  total: number;
  shapes: {
    id: ShapeId;
    valid: boolean;
    /** Up to 40 findings, indices in the shape's own index space. */
    problems: CheckProblem[];
    problem_counts: Record<string, number>;
    problem_total: number;
    /** Edges on one face only (an open shell). */
    free_edges: number;
    /** Closed (watertight) solid. */
    closed: boolean;
  }[];
}

/** API 6: what a face picked for offset_faces is, and its radius before and after. */
export interface OffsetFaceAbout {
  face: number;
  type: TopoResult['faces'][number]['type'] | 'other';
  /**
   * flat; bore (a concave cylinder: a hole); cylinder (convex: a boss, a shaft); cone;
   * sphere; torus; fillet (a cylinder or torus blend between two tangent faces: re-rounded);
   * surface (B-spline or other free-form).
   */
  role: 'flat' | 'bore' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'fillet' | 'surface';
  /** The material is on the inside of the curve (a boss, a ball, a convex fillet). */
  convex: boolean;
  /** Cylinder, sphere and fillet radius, torus tube radius, a cone's radius at its wide end (mm). */
  radius?: number;
  new_radius?: number;
  /** Faces OCCT moves with it: tangent to it, transitively (input indices). */
  tangent: number[];
}

/** API 6: offset_faces' answer: a result, or a refusal. */
export type OffsetFacesResult =
  | (ShapeResult & {
      refused?: undefined;
      solids: number;
      /** Per picked face: the result face where it now lies (-1 if gone). */
      moved: number[];
      about: OffsetFaceAbout[];
      tangent: number[];
      method: 'offset' | 'refillet' | 'offset+refillet' | 'cylinder' | 'prism' | 'thicken';
      /** Fix round 1: the faces taken off and put back at their size (fillets, chamfers). */
      carried?: number[];
    })
  | {
      id?: undefined;
      refused: {
        /**
         * radius: a radius would reach 0 (`words`); empty: nothing left; gone: a picked face is cut
         * away; lost: another face is gone (`face`); vanish: a face next to a pick shrinks to
         * nothing (`face`); split: adding material made separate solids; volume: the volume moves
         * the wrong way or by far less / more than expected (`dv`, `expected`); self: cuts through
         * itself; invalid: BRepCheck (`detail`); fillet: a fillet or chamfer could not be taken off
         * or put back (`words`); step: a neighbour (`face`) is not square to the face and no method
         * that extends it worked; occt: OCCT's offset failed (`detail`).
         */
        code: 'radius' | 'empty' | 'gone' | 'lost' | 'vanish' | 'split' | 'volume' | 'self' | 'invalid' | 'fillet' | 'step' | 'occt';
        words?: string;
        detail?: string;
        face?: number;
        dv?: number;
        expected?: number;
        d?: number;
      };
      about: OffsetFaceAbout[];
      /** With diagnose: the largest |d| found to work (same sign), or null. */
      max_ok?: number | null;
      diagnose_runs?: number;
      timings?: Record<string, number>;
    };

/** What `measure` measures: a sub-shape of a stored shape, a whole shape, a point or an origin plane/axis. */
export type MeasureTarget =
  | { id: ShapeId; face?: number; edge?: number; vertex?: number }
  | { point: Vec3 }
  | { plane: { origin: Vec3; normal: Vec3 } }
  | { axis: { origin: Vec3; dir: Vec3 } };

/** One entity's measures (mm, mm², mm³, degrees). */
export interface MeasureOne {
  kind: 'face' | 'edge' | 'vertex' | 'body' | 'point' | 'plane' | 'axis';
  /** Surface or curve type (TopoResult names). */
  type?: string;
  area?: number;
  length?: number;
  volume?: number;
  radius?: number;
  /** Circle / arc / sphere centre, or a face's centroid. */
  center?: Vec3;
  /** Plane normal (out of the material) or line / axis direction. */
  dir?: Vec3;
  point?: Vec3;
}

export interface MeasureResult {
  a: MeasureOne;
  b?: MeasureOne;
  /** With two targets: minimum distance (BRepExtrema) and where it is reached. */
  distance?: number;
  p1?: Vec3;
  p2?: Vec3;
  /** p2 - p1. */
  delta?: Vec3;
  /** Angle between two directions (planes, lines, axes), 0..90 for planes and lines, when both have one. */
  angle_deg?: number;
  parallel?: boolean;
  /** Two circles/cylinders/spheres: distance between centres (or axes, when parallel). */
  center_distance?: number;
  timings: Record<string, number>;
}

/**
 * A sketch curve as the kernel takes it (mm, sketch u/v; arc angles in degrees
 * from the sketch's xdir, counter-clockwise about the normal). `pa`/`pb` are the
 * sketch point ids at the curve's ends (arc: at a0 / a1), `pc` the centre's:
 * the kernel names split points by them (p:<id>).
 */
export type SketchCurve =
  | { id: string; kind: 'line'; a: Vec2; b: Vec2; pa?: string; pb?: string }
  | { id: string; kind: 'arc'; c: Vec2; r: number; a0: number; a1: number; ccw: boolean; pa?: string; pb?: string; pc?: string }
  | { id: string; kind: 'circle'; c: Vec2; r: number; pc?: string }
  | { id: string; kind: 'point'; p: Vec2; pid?: string }
  /**
   * API 5 (SKETCH's R1): a clamped (non-periodic) B-spline, OCCT's Geom2d_BSplineCurve(poles[,
   * weights], knots, mults, degree): knots strictly increasing, the end mults at most degree + 1, inner
   * ones at most degree, sum(mults) = poles + degree + 1. Closed when poles[0] == poles[last] (pa ==
   * pb: one named point). Crossings with it are numbered along its own parameter. `weights` (one per
   * pole, > 0) only for rational curves (projected ellipses); absent = non-rational.
   */
  | { id: string; kind: 'bspline'; degree: number; poles: Vec2[]; knots: number[]; mults: number[]; weights?: number[]; pa?: string; pb?: string };

/** API 5: a rigid transform or a mirror, row-major [r00 r01 r02 tx r10 r11 r12 ty r20 r21 r22 tz] (mm). */
export interface KernelTransform {
  matrix: number[];
}

/**
 * API 5: a curve in a plane's own coordinates (mm, u along xdir, v along normal x xdir; arc angles
 * in degrees from u, ccw about the normal when `ccw`), as project / section / silhouette give them.
 * The same shapes as SketchCurve's kinds, so they go straight back into sketch_regions. With
 * `cubic: true` on the op every B-spline is non-rational and of degree 3 (an approximation within the
 * op's tolerance where it was not one), as the sketch's own splines are.
 */
export type PlaneCurve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number; ccw: boolean }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'bspline'; degree: number; poles: Vec2[]; knots: number[]; mults: number[]; weights?: number[] }
  | { kind: 'point'; p: Vec2 };
/** API 5: where a projected or section curve came from on the body (its index space at the call). */
export interface PlaneCurveSrc {
  edge?: number;
  vertex?: number;
  face?: number;
}

/** A closed region of a sketch (sketch_regions). */
export interface KernelRegion {
  /** Canonical key: loops of signed sub-segment tokens (docs/p2p3-plan.md §2.8). */
  key: string;
  /** Outer loop then holes, each as signed tokens ("+e_1[p:pt_a>p:pt_b]"), canonical rotation. */
  loops: string[][];
  /** Sorted ids of the entities on its boundary. */
  entities: string[];
  /** mm². */
  area: number;
  /** A point strictly inside (mm, u/v). */
  sample: Vec2;
  /** [umin, vmin, umax, vmax]. */
  bbox: [number, number, number, number];
}

export type KernelOp = keyof KernelOps;
export type KernelParams<Op extends KernelOp> = KernelOps[Op]['params'];
export type KernelResult<Op extends KernelOp> = KernelOps[Op]['result'];

export interface TopoResult {
  faces: {
    i: number;
    type: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
    /** Absent with face_mass:false. */
    area?: number;
    centroid?: Vec3 | null;
    normal?: Vec3;
    axis?: { origin: Vec3; dir: Vec3 };
    radius?: number;
    minor_radius?: number;
    semi_angle_deg?: number;
    /** Absent with face_bbox:'none'. */
    bbox?: BBox | null;
  }[];
  edges: {
    i: number;
    type: 'line' | 'circle' | 'ellipse' | 'bspline' | 'other' | 'degenerate';
    /** Absent with edge_length:false. */
    length?: number;
    mid?: Vec3;
    center?: Vec3;
    radius?: number;
    axis_dir?: Vec3;
    faces: number[];
    /** API 4, edge_ends: points at the first / last parameter, their vertex indices (-1 when missing), a line's unit direction. */
    first?: Vec3;
    last?: Vec3;
    vertices?: [number, number];
    dir?: Vec3;
  }[];
  /** API 4, vertex_faces: `faces` = the sorted indices of the faces containing the vertex. */
  vertices: { i: number; p: Vec3; faces?: number[] }[];
  /** Totals for the shape (for chunked walks). */
  counts: { faces: number; edges: number; vertices: number };
  timings: Record<string, number>;
}
