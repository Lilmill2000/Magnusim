// The Part document, schema v1: what is saved, undone and rebuilt.
// Owner: DOC-CORE (schema, migration, rebuild). Everyone else reads it.
// Changes: add new feature types to the Feature union (below) and bump nothing
// else without DOC-CORE; a breaking change needs DOC_SCHEMA + a migration.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { DocUnits, Expr } from './units';

export const DOC_SCHEMA = 1 as const;

/** Ids are opaque strings with a type prefix: f_ feature, b_ body, p_ param (src/lib/ids.ts). */
export type FeatureId = string;
export type BodyId = string;
export type ParamId = string;

/** A 3-vector of expressions (each evaluates as a length unless noted). */
export type ExprVec3 = [Expr, Expr, Expr];
export type Vec3 = [number, number, number];

/**
 * The implicit origin feature: always present, never stored in `features`,
 * never suppressed or deleted. The tree shows it as "Origin" with the three
 * planes and axes; references to it use these ids.
 */
export type OriginRef = 'origin:point' | 'origin:top' | 'origin:front' | 'origin:right' | 'origin:x' | 'origin:y' | 'origin:z';
/** The origin's planes (their geometry is ORIGIN_PLANES). */
export type OriginPlaneRef = 'origin:top' | 'origin:front' | 'origin:right';
export type OriginAxisRef = 'origin:x' | 'origin:y' | 'origin:z';

/**
 * Where the three origin planes are (mm). Z is up, as in the core viewer
 * (runtime.js setViewUp(0, 0, 1); default view direction [-0.55, -0.75, 0.42]).
 * Top = XY plane (normal +Z), Front = XZ plane (normal -Y, facing a viewer at -Y),
 * Right = YZ plane (normal +X).
 */
export const ORIGIN_PLANES: Record<OriginPlaneRef, { label: string; origin: Vec3; normal: Vec3; xdir: Vec3 }> = {
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

/** Box primitive: a corner at `origin`, sizes along +X, +Y, +Z (mm expressions). */
export interface BoxFeature extends FeatureBase<'box'>, BodyMaking {
  origin: ExprVec3;
  size: ExprVec3;
}

/** Cylinder primitive: base centre at `origin`, along an origin axis. */
export interface CylinderFeature extends FeatureBase<'cylinder'>, BodyMaking {
  origin: ExprVec3;
  axis: OriginAxisRef;
  diameter: Expr;
  height: Expr;
}

/**
 * Every stored feature. P1: box, cylinder (origin is implicit, see OriginRef).
 * Later phases add sketch, extrude, revolve, fillet, chamfer, shell, combine,
 * split, imported, ... as new members of this union.
 */
export type Feature = BoxFeature | CylinderFeature;
export type FeatureType = Feature['type'];

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
