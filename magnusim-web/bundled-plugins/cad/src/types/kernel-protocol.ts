// The kernel worker protocol and the facade's operations, as TypeScript.
// Mirrors the C facade (kernel-build/facade/facade.cpp, CONTRACT "Kernel facade").
// Owner: KERNEL-HARDENING. Add ops to KernelOps as the facade gains them; keep
// field names identical to the C++ JSON. DOC-CORE's KernelAdapter reads this.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3 } from './doc';

// ---------------------------------------------------------------- messages

/** worker -> main, always the first message: the kernel is loaded and answered `version`. */
export interface KernelReadyMsg {
  type: 'ready';
  variant: 'wasm32';
  /** OCCT version the kernel was built from, "7.9.3". */
  occt: string;
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
  /** Past everything in `targets` (both sides of the profile with both:true). */
  | { kind: 'through_all'; targets: ShapeId[]; both?: boolean }
  /** Up to the plane of planar face `face` of `target` (tilted or not); offset goes further. */
  | { kind: 'to_face'; target: ShapeId; face: number; offset?: number };

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
  /** `api`: facade contract revision (2 = this file). */
  version: { params: Record<string, never>; result: { occt: string; build: 'wasm32' | 'wasm64'; api?: number } };
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
  /** Split by a plane or by a tool body; `valid` is true only if every piece is. */
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
    };
  };
  /**
   * Local ops run on a work copy: the input never changes. OCCT failing outright is
   * ok:false ("... the body is unchanged"); OCCT "succeeding" with an invalid solid
   * is ok:true, valid:false with the reasons.
   */
  fillet: { params: CheckParam & { id: ShapeId; edges: number[]; r: number }; result: ShapeResult };
  chamfer: { params: CheckParam & { id: ShapeId; edges: number[]; d: number }; result: ShapeResult };
  defeature: { params: CheckParam & { id: ShapeId; faces: number[] }; result: ShapeResult & { warnings: boolean; warning_text?: string } };
  shell: { params: CheckParam & { id: ShapeId; faces: number[]; t: number; tol?: number }; result: ShapeResult };
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
    params: { id: ShapeId; volume?: boolean; area?: boolean; bbox?: 'fast' | 'exact' | 'none'; bbox_mode?: 'fast' | 'optimal' };
    result: {
      faces: number;
      edges: number;
      vertices: number;
      solids: number;
      shells: number;
      bbox?: BBox | null;
      bbox_mode: 'fast' | 'exact' | 'none';
      volume?: number;
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
  import_step: {
    params: { name: string; heal?: boolean; tol?: number; xcaf?: boolean; bbox_mode?: 'fast' | 'optimal' };
    result: {
      shapes: { id: ShapeId; name: string; color: [number, number, number] | null; color_linear: [number, number, number] | null; type: 'solid' | 'shell' | 'other' }[];
      faces: number;
      edges: number;
      bbox: BBox | null;
      timings: Record<string, number>;
    };
  };
  /** Buffer: step (u8, the file's bytes). */
  export_step: { params: { shapes: { id: ShapeId; name: string; color?: [number, number, number] }[]; schema: 'AP214' | 'AP242' }; result: Record<string, never> };
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
  }[];
  vertices: { i: number; p: Vec3 }[];
  /** Totals for the shape (for chunked walks). */
  counts: { faces: number; edges: number; vertices: number };
  timings: Record<string, number>;
}
