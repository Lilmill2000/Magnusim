// The Part document, schema v2: what is saved, undone and rebuilt.
// Owner: DOC-CORE (schema, migration, rebuild). Everyone else reads it.
// Changes: add new feature types to the Feature union (below) and bump nothing
// else without DOC-CORE; a breaking change needs DOC_SCHEMA + a migration.
// Schema history (src/doc/schema.ts readDoc migrates every older one):
//   1  P1: box, cylinder; a body is made by the one feature whose `creates` names it.
//   2  P2/P3 (docs/p2p3-plan.md §1): import, delete_faces, press_pull, split,
//      combine, sketch, extrude. A feature may make several bodies (import, split),
//      so a schema-1 reader would drop their names and colours on its next save:
//      it refuses schema 2 instead ("saved by a newer Magnusim CAD"). 1 -> 2 changes
//      no field (box and cylinder are unchanged).
//   SD (2026-10-01): Box and Cylinder are no longer built (REMOVED_FEATURE_TYPES):
//      a stored one stays in the Part as a red "Removed feature" row. Enclosure is
//      new. The schema stays 2 (no released build reads schema 2).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { DocUnits, Expr } from './units';
import type { AxisRef, CurveRef, EdgeRef, FaceRef, PlaneRef, PointRef } from './references';

export const DOC_SCHEMA = 2 as const;
/** Every schema readDoc reads (older ones are migrated on read and written back as DOC_SCHEMA). */
export const DOC_SCHEMAS_READ: readonly number[] = [1, 2];

/**
 * Ids are opaque strings with a type prefix (src/lib/ids.ts): f_ feature, b_ body,
 * p_ param, pt_ sketch point, e_ sketch entity, c_ sketch constraint or dimension.
 * Derived body ids (split pieces) are `<target body>.<feature id without f_>.<k>`
 * (deriveBodyId in src/doc/features/body-ids.ts): stable across rebuilds without
 * being stored.
 */
export type FeatureId = string;
export type BodyId = string;
export type ParamId = string;
export type SketchPointId = string;
export type SketchEntityId = string;
export type SketchConstraintId = string;

/** A 3-vector of expressions (each evaluates as a length unless noted). */
export type ExprVec3 = [Expr, Expr, Expr];
export type Vec3 = [number, number, number];
/** A point in a sketch's own 2D frame (mm along the plane's xdir and ydir = normal x xdir). */
export type Vec2 = [number, number];

/**
 * The implicit origin feature: always present, never stored in `features`,
 * never suppressed or deleted. The tree shows it as "Origin" with the three
 * planes and axes; references to it use these ids.
 */
export type OriginRef = 'origin:point' | 'origin:top' | 'origin:front' | 'origin:right' | 'origin:x' | 'origin:y' | 'origin:z';
/** The origin's planes (their geometry is ORIGIN_PLANES). */
export type OriginPlaneRef = 'origin:top' | 'origin:front' | 'origin:right';
export type OriginAxisRef = 'origin:x' | 'origin:y' | 'origin:z';

/** A plane with its own 2D frame (mm): `normal` points at the viewer of a sketch on it, ydir = normal x xdir. */
export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  xdir: Vec3;
}

/**
 * Where the three origin planes are (mm). Z is up, as in the core viewer
 * (runtime.js setViewUp(0, 0, 1); default view direction [-0.55, -0.75, 0.42]).
 * Top = XY plane (normal +Z), Front = XZ plane (normal -Y, facing a viewer at -Y),
 * Right = YZ plane (normal +X).
 */
export const ORIGIN_PLANES: Record<OriginPlaneRef, { label: string } & PlaneFrame> = {
  'origin:top': { label: 'Top plane', origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
  'origin:front': { label: 'Front plane', origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
  'origin:right': { label: 'Right plane', origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] },
};

/** How a body-making feature combines with existing bodies (Fusion's "Operation"). */
export type BodyOp = 'new' | 'join' | 'cut' | 'intersect';

/** A user parameter. `name` is an identifier usable in any expression. */
export interface Param {
  id: ParamId;
  /** /^[A-Za-z_][A-Za-z0-9_]*$/, unique in the document, not a unit or function name. */
  name: string;
  expr: Expr;
  quantity: 'length' | 'angle' | 'scalar';
  comment?: string;
  favorite?: boolean;
}

/** A body's saved identity. Geometry is never saved: it is rebuilt from features. */
export interface BodyDef {
  name: string;
  /** "#rrggbb"; defaults to the core body colour #bdc9db. */
  color: string;
  /**
   * LINK: false when the user left this body out of the simulation (the Bodies
   * row's "Include in simulation" toggle). Absent means included: every solid
   * body goes to the project's linked geometry unless it says false here. A
   * surface body is never sent, whatever this says.
   */
  simulation?: false;
}

interface FeatureBase<T extends string> {
  id: FeatureId;
  type: T;
  /** Tree label, "Box 1". Renamed in the tree or the panel's title pencil. */
  name: string;
  suppressed?: boolean;
}

/**
 * Fields every body-making feature has. `op: 'new'` creates the body `creates`
 * (its id is fixed when the feature is made, so body ids survive rebuilds).
 * Join/cut/intersect act on `scope` (target bodies; empty = every body the
 * tool touches, decided at rebuild whatever is hidden) and create nothing
 * (`creates` is null for them).
 */
export interface BodyMaking {
  op: BodyOp;
  creates: BodyId | null;
  scope: BodyId[];
  /**
   * Set by "Try repair" after a boolean gave an invalid solid: the booleans of
   * this feature run with this fuzzy tolerance (mm). Absent = exact booleans.
   */
  repair?: { fuzzy: number };
}

// ------------------------------------------------------------ references (§4.5)

/** What a stored reference points at. */
export type RefKind = 'face' | 'edge' | 'vertex';

/**
 * Geometric fingerprint of a face, edge or vertex when it was picked (or last
 * re-anchored), from the kernel's `topo` (mm, mm²). Used to check every name
 * match and, when no name matches, to find the entity again (accepted only when
 * the runner-up is at least 50% worse). src/naming/signature.ts compares them.
 */
export interface RefSignature {
  kind: RefKind;
  /** Face: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other'; edge: 'line' | 'circle' | ... (TopoResult types). */
  type: string;
  /** Face area (mm²) or edge length (mm). */
  size?: number;
  /** Face centroid, edge midpoint or vertex position (mm). */
  at: Vec3;
  /** Plane normal (out of the material), cylinder/cone axis or line direction. */
  dir?: Vec3 | null;
  radius?: number | null;
  /** Exact bounding box [xmin, ymin, zmin, xmax, ymax, zmax] (mm). */
  bbox?: [number, number, number, number, number, number] | null;
}

/** The second resolution step: what the entity was, in words the naming layer can test. */
export interface RefSemantic {
  /** The feature that made it, when known ("f_..."). */
  feature?: FeatureId;
  /** 'side' / 'start' / 'end' of a sweep, a face of an import, a cut face of a split, ... */
  role?: 'side' | 'start' | 'end' | 'import' | 'primitive' | 'cut' | 'heal' | 'moved' | 'other';
}

/**
 * A stored reference to a face, edge or vertex of a body (proposal §4.5 point 4).
 * Resolves by name, then by the semantic hint, then by signature; the signature
 * is also checked on every name match. Nothing is repaired silently: a repair
 * is a warning on the feature ("Reference repaired · check"), a miss an error
 * ("Face not found after rebuild").
 * Name grammar (src/naming/names.ts): faces `F:<feature>:<role>[:<detail>][#k]`,
 * merged faces `A|B` (sorted), edges `E:<faceA>&<faceB>` (sorted), vertices
 * `V:<faceA>&<faceB>&<faceC>` (sorted).
 */
export interface PersistentRef {
  name: string;
  semantic?: RefSemantic;
  signature: RefSignature;
}

/** A reference to a face, edge or vertex of one body. */
export interface BodyRef {
  body: BodyId;
  ref: PersistentRef;
}

// ------------------------------------------------------------ removed feature types

/**
 * Feature types this version no longer builds (decision 2026-10-01, "fully
 * sketch-driven": no one-click solids). P1's Box and Cylinder were dev-only, so
 * there is no migration: a Part that still has one keeps the row, which shows
 * "This part uses a removed feature (Box 1)" in red and can be
 * deleted (src/doc/features/removed.ts). Nothing is dropped silently.
 */
export const REMOVED_FEATURE_TYPES: Readonly<Record<string, string>> = { box: 'Box', cylinder: 'Cylinder' };

// ------------------------------------------------------------ SD: CFD prep

/** A side of an Enclosure: the six faces of a box, or a cylinder's radius, top (+axis end) and bottom. */
export type EnclosureSide = '+x' | '-x' | '+y' | '-y' | '+z' | '-z' | 'radius' | 'top' | 'bottom';

/**
 * Enclosure (decision 2026-10-01, CFD prep): a box or a cylinder around the
 * exact bounding box of bodies made before it, as a new body. It never cuts:
 * the air volume is always a separate Combine (Cut, keep tools). Parametric:
 * it follows the bounding box of the bodies it encloses when they change, and
 * keeps the sides the user set.
 * Each side sits out from the bounding box by the padding: Zero (tight to the
 * part, the default), a percent of the part's size along that direction, or a
 * fixed distance; a side the user typed or dragged keeps its own value
 * (`sides`). Face names: F:<id>:enclosure:<side> (src/features/enclosure/def.ts).
 */
export interface EnclosureFeature extends FeatureBase<'enclosure'> {
  shape: 'box' | 'cylinder';
  /** The cylinder's axis (an origin axis); kept while the shape is Box. */
  axis: OriginAxisRef;
  /** The bodies it wraps; empty = every solid body made before it (other enclosures left out). */
  bodies: BodyId[];
  padding: 'zero' | 'percent' | 'fixed';
  /** Percent of the part's size (a plain number expression, "10"). Kept while another padding is chosen. */
  percent: Expr;
  /** The fixed distance (a length expression, "10 mm"). Kept while another padding is chosen. */
  distance: Expr;
  /** Sides the user set on their own (typed or dragged), as lengths; the others follow the padding. */
  sides: Partial<Record<EnclosureSide, Expr>>;
  /** The body it makes (fixed when it is made). */
  creates: BodyId;
}

// ------------------------------------------------------------ P2: STEP editing

/**
 * A file the Part keeps in the plugin's project folder through ws.files
 * (host API 1.2). `rel` is relative to that folder; files of a Part live under
 * `studies/<sid>/` so deleting the Part deletes them.
 */
export interface StoredFileRef {
  rel: string;
  /** Bytes. */
  size: number;
  /** Hex SHA-256 of the bytes (identical uploads are stored once). */
  sha256: string;
}

/** What the import checked and fixed (shown in its panel; the kernel's import_step diagnostics, trimmed). */
export interface ImportDiagnosticsSummary {
  /** BRepCheck problems on the shapes as read, before healing. */
  problemsBefore: number;
  /** ... and after healing (and sewing). 0 = "0 problems". */
  problemsAfter: number;
  /** Shapes ShapeFix changed. */
  fixed: number;
  /** Faces sewn into closed shells (knit), when sewing ran. */
  sewn?: number;
  /** Free (unshared) edges left after sewing: > 0 means the model is still open. */
  freeEdges?: number;
  /** A large file (over 50 MB) was healed while it was read: there is no separate "before" count. */
  healedOnRead?: boolean;
}

/**
 * Imported STEP (proposal §2.8, §4.9): one feature at the top of the history
 * that makes one body per solid (or per open shell kept as a surface body) of
 * the file. The rebuild reads the stored healed BREP, never the STEP (§4.5
 * point 6: healing output depends on the OCCT version and the tolerance), so a
 * reopen never re-heals. Re-healing with another tolerance writes a new BREP
 * from the kept `source` (no new upload).
 */
export interface ImportFeature extends FeatureBase<'import'> {
  /** The STEP as uploaded: `studies/<sid>/imports/<sha256>/source.step`. */
  source: StoredFileRef & {
    /** The file name the user picked ("flange.step"), for labels. */
    fileName: string;
    /** Length unit the file declared ("inch"), for the panel; the kernel converts to mm. */
    unit?: string | null;
  };
  /**
   * The healed shapes, one compound in OCCT's binary BREP format (BinTools):
   * `studies/<sid>/imports/<sha256>/healed-<tolerance key>.brep`.
   */
  brep: StoredFileRef & {
    /** OCCT version that wrote it ("7.9.3"): another version re-heals from `source` (a new import revision, §4.5 point 6). */
    occt: string;
  };
  /** How `brep` was made. */
  heal: {
    /** ShapeFix precision and max tolerance (mm). Default 0.001. */
    tolerance: number;
    /** Sewing (knit) ran: faces of an open model were sewn into shells, closed shells made solids. */
    sew: boolean;
  };
  /**
   * The bodies this feature makes (ids fixed when the feature is made), in
   * compound order: each one's child index in the BREP compound and what the
   * STEP called it. Its ownsBody hook answers from this list.
   */
  items: {
    body: BodyId;
    index: number;
    stepName: string;
    /** "#rrggbb" from the STEP, or null. */
    stepColor: string | null;
    kind: 'solid' | 'shell';
    /**
     * BRepCheck of the healed shape when the BREP was written. The rebuild reads
     * the same bytes (sha256 checked), so it keeps this instead of checking
     * again (6 s on the 113 MB part); an invalid body shows red with its reason.
     */
    valid: boolean;
    reason?: string;
  }[];
  diagnostics?: ImportDiagnosticsSummary;
}

/**
 * Delete faces and heal (proposal §2.8): the kernel's `defeature`
 * (BRepAlgoAPI_Defeaturing, with history) on `body`; the neighbours grow to
 * close the gap. The body keeps its id.
 */
export interface DeleteFacesFeature extends FeatureBase<'delete_faces'> {
  body: BodyId;
  faces: PersistentRef[];
  /** Set by "Try repair" (DocService.repair): ShapeFix on an invalid result. */
  repair?: { fuzzy: number };
}

/**
 * Press-pull of planar faces (proposal §2.8, §3.4): each face moves along its
 * own normal by `distance` (> 0 adds material, < 0 removes it). Kernel op
 * `press_pull` (prism of the faces, then fuse or cut, then UnifySameDomain,
 * with history; docs/p2p3-plan.md §2.4). The body keeps its id; the moved face
 * keeps its name.
 */
export interface PressPullFeature extends FeatureBase<'press_pull'> {
  body: BodyId;
  faces: PersistentRef[];
  distance: Expr;
  repair?: { fuzzy: number };
}

/** What a Split cuts with. */
export type SplitTool =
  /** An origin plane moved `offset` along its normal. */
  | { kind: 'plane'; plane: OriginPlaneRef; offset: Expr }
  /** The (infinite) plane of a planar face. */
  | { kind: 'face'; body: BodyId; face: PersistentRef }
  /** Another body's boundary; `keepTool: false` removes the tool body afterwards. */
  | { kind: 'body'; body: BodyId; keepTool: boolean };

/**
 * Split bodies (proposal §2.7; decision 2026-09-30: "split body by body is the
 * basis for the fluid domain"). Each target's first piece keeps the target's
 * id; piece k >= 1 gets the derived id deriveBodyId(feature, target, k).
 * Pieces are ordered as the kernel's `split` orders them (along the plane
 * normal; largest volume first for a tool body).
 */
export interface SplitFeature extends FeatureBase<'split'> {
  targets: BodyId[];
  tool: SplitTool;
  /** Set by "Try repair" (DocService.repair): ShapeFix on the invalid pieces. */
  repair?: { fuzzy: number };
}

/**
 * Combine (decision 2026-09-30, MVP): Join / Cut / Intersect with several
 * targets and several tools, "Keep tools". Join fuses targets and tools into
 * the first target (the other targets go); Cut removes every tool from each
 * target; Intersect keeps what each target shares with all the tools (review
 * P2/P3 round 4). Tools go unless `keepTools`.
 */
export interface CombineFeature extends FeatureBase<'combine'> {
  op: 'join' | 'cut' | 'intersect';
  targets: BodyId[];
  tools: BodyId[];
  keepTools: boolean;
  repair?: { fuzzy: number };
}

// ------------------------------------------------------------ P3: sketches

/** A sketch's reserved origin point: always at [0, 0], fixed, never stored in `points`; constraints may use it. */
export const SKETCH_ORIGIN = 'origin' as const;

interface SketchEntityBase {
  id: SketchEntityId;
  /** Construction geometry: drawn dashed, never part of a profile. */
  construction?: boolean;
  /**
   * Lineage (§4.5 point 1): when trim or split breaks an entity, one piece keeps
   * its id and each other piece gets `<id>.b`, `<id>.c`, ... with `parent` = the id
   * it came from. Region keys and references resolve through it.
   */
  parent?: SketchEntityId | null;
  /**
   * P4b (SELECT): made by this link (SketchFeature.links): fixed (the solver gets a fix per point,
   * a fixed radius for a circle), drawn purple, re-projected at every rebuild. Break link deletes
   * the tag: the entity becomes ordinary free geometry where it is.
   */
  link?: SketchLinkId;
}

// ---- P4b (SELECT): linked sketch geometry (Project, Silhouette, Intersect, auto-projected snaps)
export type SketchLinkId = string;

/** What a link reads; it is read again at every rebuild. */
export type SketchLinkSource =
  /** Project: one edge of a body (a straight edge seen end-on projects to a point). */
  | { kind: 'edge'; body: BodyId; ref: PersistentRef }
  /** Project: one vertex of a body (a sketch point). */
  | { kind: 'vertex'; body: BodyId; ref: PersistentRef }
  /** Project: a face's outer boundary, one curve per edge of its outer wire (keyed by edge name). */
  | { kind: 'face'; body: BodyId; ref: PersistentRef }
  /** Project, Silhouette: a body's outline seen along the sketch normal (closed loops). */
  | { kind: 'silhouette'; body: BodyId }
  /** Intersect: where the sketch plane cuts a body. */
  | { kind: 'section'; body: BodyId }
  /** A snap while drawing: where an edge pierces the sketch plane (the crossing nearest `near`, model mm). */
  | { kind: 'pierce'; body: BodyId; ref: PersistentRef; near?: Vec3 };

export interface SketchLink {
  id: SketchLinkId;
  /** 'projected' (Project, Silhouette, auto-projected snaps) or 'intersection' (Intersect). */
  type: 'projected' | 'intersection';
  source: SketchLinkSource;
  /** Made by a snap on model geometry while drawing (Fusion's auto project): drawn lighter. */
  auto?: boolean;
  /** Each curve it made: its key in the source ('e', 'v', an edge name, 'c<k>') and the entity. */
  entities: { key: string; entity: SketchEntityId }[];
  /**
   * Keys the user took out of the link (Delete of a projected curve, or Break link): never added again
   * by a re-projection and never reported as changed (P4b fix round 1, B-2).
   */
  dropped?: string[];
}
// ---- end P4b (SELECT)

/** Sketch geometry (solver-neutral; maps 1:1 onto src/solver-worker/solver-api.mjs). Coordinates are in `points`. */
export type SketchEntity =
  | (SketchEntityBase & { kind: 'point'; p: SketchPointId })
  | (SketchEntityBase & {
      kind: 'line';
      p: [SketchPointId, SketchPointId];
      /** A centerline: construction, drawn dash-dot, usable as a revolve or mirror axis. */
      centerline?: boolean;
    })
  /** `r` is the solved radius (mm). */
  | (SketchEntityBase & { kind: 'circle'; c: SketchPointId; r: number })
  /** From `a` to `b` about `c`, counter-clockwise about the sketch normal unless ccw:false. */
  | (SketchEntityBase & { kind: 'arc'; c: SketchPointId; a: SketchPointId; b: SketchPointId; ccw?: boolean })
  // ---- P4b (SKETCH): splines
  | SketchSplineEntity;

/**
 * P4b (SKETCH): a spline. Its curve is a pure function of its points (src/sketch/tools/bspline.ts):
 * no hidden solver unknowns, so its freedoms are its points' (2 each, handles included).
 */
export type SketchSplineEntity = SketchEntityBase & {
  kind: 'spline';
  /** 'fit': a C2 cubic through `pts` (chord-length parameters); 'control': `pts` are the poles of a uniform B-spline. */
  form: 'fit' | 'control';
  /** Point ids in order (fit points, or poles). A closed spline does not repeat its first point. */
  pts: SketchPointId[];
  /** fit: 3; control: 3 (default) or 5. */
  degree: number;
  /** Closed: no ends; the curve runs back to pts[0] smoothly. */
  closed?: boolean;
  /** fit, open: end-tangent handles (point ids or null): the curve's second and second-last poles. */
  handles?: [SketchPointId | null, SketchPointId | null];
  /**
   * control, after a trim: the exact piece's clamped knot vector (distinct knots and their
   * multiplicities, OCCT form). Absent: uniform knots on [0, 1].
   */
  knots?: number[];
  mults?: number[];
  /**
   * fit, open, after a trim (fix1 B4): the first and last spans' parameter lengths as multiples of
   * their chords, so the kept piece is exactly the curve it was. Absent: 1 (plain chord lengths).
   */
  spans?: [number, number];
};

/**
 * P4b (SKETCH): a sketch pattern or an offset. Its copies are ordinary entities; what ties
 * them to their sources is derived from this row at every solve (src/sketch/tools/ties.ts), so
 * editing the count, the spacing or the distance re-lays them out, and they follow their sources.
 */
export interface SketchTie {
  id: string;
  kind: 'linear' | 'circular' | 'offset';
  /** The source entities, in order. */
  sources: SketchEntityId[];
  /**
   * One row per copy: where it sits ([i, k] along the two directions of a linear pattern; [i, 0]
   * round a circular one; [side, 0] for an offset, side 1 or -1) and the source -> copy maps.
   */
  copies: { at: [number, number]; entities: Record<SketchEntityId, SketchEntityId>; points: Record<SketchPointId, SketchPointId> }[];
  /** Instances per direction, the sources counting as one (circular and offset: [n, 1]). */
  count: [number, number];
  /**
   * Its values as expressions: linear `spacing1`, `angle1`, `spacing2`, `angle2` (an angle is the
   * direction from the sketch's u axis); circular `angle` (the total; 360 deg when full); offset
   * `distance`. Evaluated with the dimensions (key `<tie id>:<name>` in SketchSolvedState.values).
   */
  exprs: Record<string, Expr>;
  /** fix1 B5: instances the user deleted ([i, k]); a re-layout leaves them out. */
  skip?: [number, number][];
  /** linear: a line each direction runs along instead of its angle (null: the angle). */
  along?: [SketchEntityId | null, SketchEntityId | null];
  /** circular: the centre point (SKETCH_ORIGIN allowed); full: equal spacing round the whole circle. */
  centre?: SketchPointId;
  full?: boolean;
}
// ---- end P4b (SKETCH)

export type SketchEntityKind = SketchEntity['kind'];

/** Geometric relations (glyphs on the sketch). collinear = two point_on_line in the solver. */
export type SketchRelationKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'equal'
  | 'midpoint'
  | 'symmetric'
  | 'point_on_line'
  | 'point_on_circle'
  | 'concentric'
  | 'collinear'
  | 'fix';

/** Dimensions (Smart Dimension picks the kind from the selection). */
export type SketchDimensionKind = 'distance' | 'distance_x' | 'distance_y' | 'radius' | 'diameter' | 'angle';

export interface SketchRelation {
  id: SketchConstraintId;
  kind: SketchRelationKind;
  /** Point ids, entity ids or SKETCH_ORIGIN, in the solver's order for the kind. */
  refs: string[];
  /** fix: the locked position (mm, u/v). */
  value?: Vec2;
  /** Added by inference while drawing (same constraint; the UI may show it lighter until touched). */
  inferred?: boolean;
}

export interface SketchDimension {
  id: SketchConstraintId;
  kind: SketchDimensionKind;
  refs: string[];
  /** "40 mm", "width/2", "15 deg". Driven dimensions keep the value they showed when made driven. */
  expr: Expr;
  /** false = driven (reference): measured, shown grey in parentheses, never given to the solver. */
  driving: boolean;
  /** Where its label sits (mm, sketch u/v). */
  at?: Vec2;
}

export type SketchConstraint = SketchRelation | SketchDimension;

/** Where a sketch lies. */
export type SketchSupport =
  | { kind: 'plane'; plane: OriginPlaneRef }
  | { kind: 'face'; body: BodyId; face: PersistentRef }
  /** P4a (REFERENCE): a CONSTRUCT plane (its PlaneOutput); a sketch on it follows the plane. */
  | { kind: 'feature'; feature: FeatureId };

/** What the stored geometry satisfies, so an unchanged model rebuilds without the solver. */
export interface SketchSolvedState {
  /**
   * Each driving dimension's value (mm or deg) when `points` and the radii were
   * solved. A rebuild whose evaluated values all match (1e-9 relative) uses the
   * stored geometry as it is; otherwise it re-solves from it (same branch).
   */
  values: Record<SketchConstraintId, number>;
  /** Degrees of freedom left at the last analysis (sketch mode). */
  dof: number;
  /** Tree prefix and status chip: (-) under, none fully, (+) over, (?) unsolved. */
  state: 'under' | 'fully' | 'over' | 'unsolved';
  /**
   * An under-defined sketch's entities that are fully defined (the last analysis in sketch
   * mode), so model mode draws them in the fully defined colour as sketch mode does. Absent
   * when none are, or for a sketch not analysed since this was added.
   */
  fully?: SketchEntityId[];
}

/**
 * A 2D sketch (proposal §2.1-2.3, §3.3, §4.5). Stable ids everywhere; solved
 * coordinates are stored (proposal §4.4). Its profile regions are computed by
 * the kernel (`sketch_regions`) at rebuild and published as the feature's
 * output (SketchOutput); extrudes keep RegionRefs.
 */
export interface SketchFeature extends FeatureBase<'sketch'> {
  support: SketchSupport;
  /**
   * The sketch frame when the support last resolved (§4.5 point 5). For a face
   * support it is kept when the face is lost (the sketch then warns and stays
   * where it was).
   */
  plane: PlaneFrame;
  /** Solved point coordinates (mm, sketch u/v). SKETCH_ORIGIN is implicit. */
  points: Record<SketchPointId, Vec2>;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  solved: SketchSolvedState;
  /** P4b (SELECT): linked geometry sources (Project, Silhouette, Intersect). Absent = none. */
  links?: SketchLink[];
  /** P4b (SKETCH): sketch patterns and offsets (absent = none). */
  ties?: SketchTie[];
}

// ------------------------------------------------------------ P3: extrude

/**
 * A profile region of a sketch, kept by an extrude (§4.5 point 2). `region` is
 * the canonical region key (KernelRegion.key). When it is not found after a
 * change, the region with the same boundary entities is taken if there is
 * exactly one (a warning: "Profile repaired · check"); otherwise "Profile lost".
 */
export interface RegionRef {
  sketch: FeatureId;
  region: string;
  /** Sorted ids of the entities on its boundary when it was picked. */
  entities: SketchEntityId[];
  /** A point inside it then (mm, sketch u/v): the tie-break among candidates. */
  sample: Vec2;
}

/** How far an extrude goes (distances are expressions; the direction is the sketch normal, or the opposite with flip). */
export type ExtrudeExtentDef =
  | { kind: 'blind'; distance: Expr }
  /** `distance` is the whole length, half on each side of the sketch. */
  | { kind: 'symmetric'; distance: Expr }
  /** `distance` along the direction, `distance2` against it. */
  | { kind: 'two'; distance: Expr; distance2: Expr }
  /**
   * P4a: past every body before it (or the scope's bodies), on one side or both. `distance` is
   * the last blind distance, kept so going back to Blind gives it back.
   */
  | { kind: 'through_all'; both: boolean; distance: Expr }
  /**
   * P4a: up to a face (its plane: the end cap lies on it, tilted or not) or a vertex (the plane
   * through it parallel to the sketch) of a body; `offset` goes further along the direction.
   * `target.ref.signature.kind` says which. `distance` as for through_all.
   */
  | { kind: 'to'; target: BodyRef | null; offset: Expr; distance: Expr };

/**
 * Extrude (proposal §2.5): profiles of one sketch, an extent, an Operation.
 * Face names: F:<id>:side:<sub-segment token>; caps F:<id>:start / F:<id>:end
 * with one profile, F:<id>:start:<n> / F:<id>:end:<n> (n = index in `profiles`)
 * with several (docs/p2p3-plan.md §1.8).
 */
export interface ExtrudeFeature extends FeatureBase<'extrude'>, BodyMaking {
  profiles: RegionRef[];
  extent: ExtrudeExtentDef;
  /** Against the sketch normal. */
  flip: boolean;
  /**
   * P4a (Daniel's item 8): a flat face of a body extruded directly, with no sketch (then
   * `profiles` is empty). The direction is the face's outward normal (flip: into the body).
   * Side faces are named by the edge they were swept from (F:<id>:side:E:<a>&<b>).
   */
  face?: BodyRef | null;
  /**
   * P4a: extrude along this axis (a sketch line, an edge, an origin axis, a CONSTRUCT axis)
   * instead of the profile's normal; flip reverses it. Absent or null: the normal.
   */
  direction?: AxisRef | null;
}

// ------------------------------------------------------------ P4a: solids (SOLIDS)

/** How far a revolve turns (angle expressions; 360 in all is a full turn, with no end caps). */
export type RevolveExtentDef =
  /** `angle` from the sketch about the axis (right hand), or the other way with flip. */
  | { kind: 'one'; angle: Expr }
  /** `angle` in all, half on each side of the sketch. */
  | { kind: 'symmetric'; angle: Expr }
  /** `angle` one way, `angle2` the other. */
  | { kind: 'two'; angle: Expr; angle2: Expr };

/**
 * Revolve (proposal §2.5): profiles of one sketch turned about an axis (a sketch centerline or
 * line, a straight model edge, an origin axis or a CONSTRUCT axis: AxisRef), with an
 * Operation. Face names as Extrude's: F:<id>:side:<sub-segment token>, caps start / end
 * (start:<n> / end:<n> with several profiles); a full turn has no caps.
 */
export interface RevolveFeature extends FeatureBase<'revolve'>, BodyMaking {
  profiles: RegionRef[];
  axis: AxisRef | null;
  extent: RevolveExtentDef;
  /** Turn the other way about the axis. */
  flip: boolean;
}

/**
 * Sweep (proposal §2.5): profiles of one sketch along a path made of curves of another sketch
 * (lines and arcs end to end, or one circle). `orientation` follow: the profile turns with
 * the path; fixed: it keeps its orientation. Side faces F:<id>:side:<token>@<path entity>,
 * caps start / end (none on a closed path).
 */
export interface SweepFeature extends FeatureBase<'sweep'>, BodyMaking {
  profiles: RegionRef[];
  /** The path's sketch and its curves (entity ids, in no order); empty = every curve of it that is not construction. */
  path: { sketch: FeatureId; entities: SketchEntityId[] } | null;
  orientation: 'follow' | 'fixed';
}

/**
 * Loft (proposal §2.5; guide rails are V1): a solid through two or more profiles, one per
 * sketch, in order. ruled: flat faces between neighbouring profiles. Side faces by the first
 * profile's sub-segment tokens, caps start (first profile) / end (last).
 */
export interface LoftFeature extends FeatureBase<'loft'>, BodyMaking {
  sections: RegionRef[];
  ruled: boolean;
}

/**
 * Fillet (proposal §2.5): constant radius on edges of one body. A picked edge takes its
 * tangent chain with it (the kernel follows tangency); a picked face takes all its edges.
 * The body keeps its id; a fillet face is F:<id>:fillet:E:<a>&<b> (the edge it replaced).
 */
export interface FilletFeature extends FeatureBase<'fillet'> {
  body: BodyId;
  /** Edge references (E:<faceA>&<faceB>). */
  edges: PersistentRef[];
  /** Face references: every edge of each face. */
  faces: PersistentRef[];
  radius: Expr;
}

/** Chamfer (proposal §2.5): an equal distance, or two distances (`flip` swaps their sides). Same picks as Fillet. */
export interface ChamferFeature extends FeatureBase<'chamfer'> {
  body: BodyId;
  edges: PersistentRef[];
  faces: PersistentRef[];
  mode: 'distance' | 'two';
  distance: Expr;
  /** The second distance (mode two); kept while mode is distance. */
  distance2: Expr;
  flip: boolean;
}

/**
 * Shell (proposal §2.5): hollow a body to a wall thickness, the picked faces removed (open).
 * inside: the outer size stays; outside: the body becomes the cavity. Inner faces are named
 * F:<id>:inner:<the face they were offset from>.
 */
export interface ShellFeature extends FeatureBase<'shell'> {
  body: BodyId;
  faces: PersistentRef[];
  thickness: Expr;
  direction: 'inside' | 'outside';
}

// ------------------------------------------------------------ P4b: patterns and mirror (PATTERN)

/**
 * What a pattern or a mirror repeats (Daniel's item 7):
 *   features  the tool body of each listed body-making feature (an Extrude, Revolve, Sweep, Loft, or
 *             a pattern or mirror), made again per copy and applied with the Operation
 *   bodies    a copy of each listed body (New body: each copy its own body; Join: fused to the body it
 *             came from; Cut / Intersect: applied to the scope's bodies)
 *   faces     faces of one body: the local feature they bound (a boss, a pocket, a hole) copied onto
 *             the same body (OCCT removes the faces to find it; when it cannot, the feature fails and says so)
 */
export type PatternOf = 'features' | 'bodies' | 'faces';

/** A pattern's Operation: a body op, or 'source' (features: each feature's own Operation). */
export type PatternOp = BodyOp | 'source';

/**
 * Fields every pattern and the mirror have. Copies are keyed (`skip`, names): a linear pattern's
 * "i" or "i.j" (i along direction 1, j along direction 2; negative on the other side of a symmetric
 * one; "0" / "0.0" is the original), a circular pattern's "i", the mirror's "m". A copy's faces are
 * named F:<pattern id>:i<key>:<source face name> (the mirror's F:<id>:m:<name>), so an edge picked on
 * copy 3 keeps its name when the count goes from 4 to 5.
 */
export interface PatternCommon {
  of: PatternOf;
  /** of features: the features repeated, in history order. */
  features: FeatureId[];
  /** of bodies: the bodies copied. */
  bodies: BodyId[];
  /** of faces: the body the faces are on, and the faces. */
  faceBody: BodyId | '';
  faces: PersistentRef[];
  op: PatternOp;
  /** New body with features: the first copy's body (later copies derive their ids from it). Null otherwise. */
  creates: BodyId | null;
  /** Bodies a Join / Cut / Intersect acts on; empty = the bodies the copies meet (as Extrude). */
  scope: BodyId[];
  /** Copies left out, by key ("2", "1.3", "-1"); a click on a copy's marker toggles it. */
  skip: string[];
  /** Set by Try repair (as BodyMaking's). */
  repair?: { fuzzy: number };
}

/** One direction of a linear pattern. */
export interface PatternDirection {
  /** Along an axis, an edge, a sketch line, or a plane's normal (null: not picked yet). */
  axis: AxisRef | null;
  flip: boolean;
  /** Copies along it, the original included (per side when symmetric): a whole number >= 1. */
  count: Expr;
  /** 'spacing': `distance` between neighbours; 'extent': `distance` from the original to the last copy. */
  mode: 'spacing' | 'extent';
  distance: Expr;
  /** The same copies on the other side of the original too. */
  symmetric: boolean;
}

/** Linear pattern: one or two directions (Fusion's Rectangular pattern, SolidWorks' Linear Pattern). */
export interface LinearPatternFeature extends FeatureBase<'pattern_linear'>, PatternCommon {
  dir1: PatternDirection;
  /** The second direction, or null for one. */
  dir2: PatternDirection | null;
}

/**
 * Circular pattern: copies turned about an axis (an origin axis, a CONSTRUCT axis, a straight edge,
 * a round face or edge, a sketch line). 'full': `count` copies equally around 360 degrees; 'angle':
 * `count` copies over `angle` (the first to the last), and with `symmetric` the same on the other side.
 */
export interface CircularPatternFeature extends FeatureBase<'pattern_circular'>, PatternCommon {
  axis: AxisRef | null;
  flip: boolean;
  count: Expr;
  mode: 'full' | 'angle';
  angle: Expr;
  symmetric: boolean;
}

/** Mirror: one copy reflected in a plane (an origin plane, a CONSTRUCT plane or a flat face). */
export interface MirrorFeature extends FeatureBase<'mirror'>, PatternCommon {
  plane: PlaneRef | null;
}

// ------------------------------------------------------------ P4a: reference geometry (REFERENCE)

/**
 * How a reference Plane is made (CONSTRUCT > Plane; Daniel's must-have 9):
 *   offset          `plane` moved `distance` along its normal (`flip`: the other way)
 *   angle           `plane` turned `angle` about `axis` (an axis in or parallel to the plane)
 *   three_points    through `points[0..2]` (normal by the right-hand rule, `flip` turns it)
 *   midplane        halfway between `plane` and `plane2` (parallel: the middle; crossing: the bisector)
 *   normal_to_curve normal to the curve `edge` (an edge, or a sketch curve such as a Sweep path) at
 *                   `points[0]` on it, or at `percent` of its length
 */
export type RefPlaneMethod = 'offset' | 'angle' | 'three_points' | 'midplane' | 'normal_to_curve';

/** A reference Plane (src/features/refgeom/): makes no body; publishes a PlaneOutput (a sketch can lie on it). */
export interface RefPlaneFeature extends FeatureBase<'ref_plane'> {
  method: RefPlaneMethod;
  plane: PlaneRef | null;
  plane2: PlaneRef | null;
  axis: AxisRef | null;
  points: PointRef[];
  /** normal_to_curve: an edge of a body or a curve of a sketch (a Sweep path). */
  edge: CurveRef | null;
  /** offset: a length expression. */
  distance: Expr;
  /** angle: an angle expression ("30 deg"). */
  angle: Expr;
  /** normal_to_curve without a point: where along the edge, a plain number 0..100 ("50"). */
  percent: Expr;
  flip: boolean;
}

/**
 * How a reference Axis is made (CONSTRUCT > Axis):
 *   two_points  through `points[0]` and `points[1]`
 *   cylinder    the axis of the cylindrical or conical face `face`
 *   edge        along the straight edge `edge`, or the axis of a circular one
 *   two_planes  where `planes[0]` and `planes[1]` cross
 */
export type RefAxisMethod = 'two_points' | 'cylinder' | 'edge' | 'two_planes';

/** A reference Axis: makes no body; publishes an AxisOutput (a revolve or pattern axis, an extrude direction). */
export interface RefAxisFeature extends FeatureBase<'ref_axis'> {
  method: RefAxisMethod;
  points: PointRef[];
  face: FaceRef | null;
  edge: EdgeRef | null;
  planes: PlaneRef[];
  /** The direction reversed. */
  flip: boolean;
}

/**
 * How a reference Point is made (CONSTRUCT > Point):
 *   vertex       at the vertex `vertex`
 *   center       the centre of the arc or circle `edge`, or of the spherical face `face`
 *   on_edge      on `edge` at `distance` (mm) or `percent` of its length from its start (`fromEnd`: from its end)
 *   edge_plane   where `edge` crosses `plane`
 *   coordinates  at `xyz` (lengths)
 */
export type RefPointMethod = 'vertex' | 'center' | 'on_edge' | 'edge_plane' | 'coordinates';

/** A reference Point: makes no body; publishes a PointOutput. */
export interface RefPointFeature extends FeatureBase<'ref_point'> {
  method: RefPointMethod;
  vertex: PointRef | null;
  /** on_edge: an edge or a sketch curve; center and edge_plane: an edge of a body. */
  edge: CurveRef | null;
  face: FaceRef | null;
  plane: PlaneRef | null;
  along: 'distance' | 'percent';
  distance: Expr;
  percent: Expr;
  fromEnd: boolean;
  xyz: ExprVec3;
}

/**
 * Every stored feature. The origin is implicit (OriginRef). Later phases add
 * revolve, fillet, chamfer, shell, ... as new members of this union.
 */
export type Feature =
  | ImportFeature
  | DeleteFacesFeature
  | PressPullFeature
  | SplitFeature
  | CombineFeature
  | SketchFeature
  | ExtrudeFeature
  | EnclosureFeature
  // P4a: solids (SOLIDS)
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  // P4a: reference geometry (REFERENCE)
  | RefPlaneFeature
  | RefAxisFeature
  | RefPointFeature
  // P4b: patterns and mirror (PATTERN)
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature;
export type FeatureType = Feature['type'];
/** The feature of one type. */
export type FeatureOf<T extends FeatureType> = Extract<Feature, { type: T }>;

/** The saved, undoable model. Stored outside the study record (see DocStore). */
export interface CadDoc {
  schema: typeof DOC_SCHEMA;
  units: DocUnits;
  params: Param[];
  bodies: Record<BodyId, BodyDef>;
  /** In history order. The rollback bar position lives in CadView. */
  features: Feature[];
  meta: {
    created_at: string;
    /** Plugin version that last wrote the document. */
    written_by: string;
  };
}

/** Where the viewport camera was, saved per Part (mm, model coordinates; Z up). */
export interface SavedCamera {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Orthographic projection: the view's height at the target (mm). */
  orthoHeight: number;
  projection: 'perspective' | 'orthographic';
}

/** Saved but not undoable: where the rollback bar is, what is hidden, tree state, how the part is viewed. */
export interface CadView {
  /** Features with index >= rollback are rolled back (not built). null = at the end. */
  rollback: number | null;
  hiddenBodies: BodyId[];
  /** Tree node keys that are expanded (e.g. "origin"). */
  expanded: string[];
  /** The origin planes: drawn only when needed ('auto', the default) or all the time ('always'). */
  planes?: 'auto' | 'always';
  /** The camera when the Part was last looked at; absent until it first moves. */
  camera?: SavedCamera | null;
  /**
   * Sketches the user showed or hid in model mode (eye in the tree). A sketch
   * with no entry is shown until a later feature uses it (Fusion).
   */
  sketches?: Record<FeatureId, 'shown' | 'hidden'>;
}

/**
 * An action a failed feature offers (a button beside its message):
 * `repair` -> DocService.repair(id) ("Try repair": booleans again with a
 * tolerance, one undo step); `retry` -> DocService.retry(id) (build again a
 * feature the kernel stopped: watchdog, crash or out of memory).
 */
export type FeatureAction = 'repair' | 'retry';
export const FEATURE_ACTION_LABELS: Record<FeatureAction, string> = { repair: 'Try repair', retry: 'Retry' };

/** Per-feature rebuild outcome, shown in the tree (red/amber rows) and the panel foot. */
export interface FeatureStatus {
  state: 'ok' | 'error' | 'warning' | 'suppressed' | 'rolled-back' | 'pending';
  /** "Fillet failed: radius 5 mm is too large for edge Top · Side 2". */
  message?: string;
  ms?: number;
  /** What the user can do about an error (absent when nothing). */
  actions?: FeatureAction[];
  /**
   * How many bodies exist just before this feature in history (as built by the
   * last rebuild; absent when the feature was not reached: rolled back, or the
   * rebuild stopped). A Join, Cut or Intersect needs at least one.
   */
  bodiesBefore?: number;
}
