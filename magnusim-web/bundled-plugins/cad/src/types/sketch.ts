// Sketches: what a built sketch publishes (SketchOutput, read by extrude and the
// region overlay), the solver worker client, and the sketch-mode API.
// Owners: SketchOutput and the sketch feature's build -> P3-PROFILES
// (src/features/sketch/); the solver client and sketch mode -> P3-SKETCH
// (src/sketch/, src/solver-worker/). docs/p2p3-plan.md §3.4, §3.5.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId, PlaneFrame, SketchConstraintId, SketchEntityId, SketchFeature, SketchPointId, Vec2 } from './doc';
import type { AssistantStep } from './doc-service';
import type { KernelRegion, SketchCurve } from './kernel-protocol';

// ------------------------------------------------------------ built sketch

/** A region with its shading triangles (sketch u/v, mm). */
export interface SketchRegion extends KernelRegion {
  /** Triangles: positions (u,v pairs) and indices into them. */
  tri: { uv: Float32Array; idx: Uint32Array };
}

/** How the stored geometry was used at this rebuild. */
export type SketchSolveSource =
  /** Every driving dimension evaluated to its stored value: the stored coordinates as they are. */
  | 'stored'
  /** A parameter changed a dimension: re-solved from the stored coordinates in the solver worker. */
  | 'solved'
  /** It had to be re-solved but the solver is not running (yet): the stored coordinates, with a warning. */
  | 'stored-unsolved';

/**
 * The output of a built sketch feature (FeatureBuildResult.output, published in
 * RebuildState.outputs[sketchId]). Everything downstream (extrude, the region
 * overlay, sketch mode's region shading) reads this, never the raw feature.
 */
export interface SketchOutput {
  type: 'sketch';
  /** The plane at this rebuild (the support resolved; or the stored snapshot when a face was lost). */
  plane: PlaneFrame;
  /** Solved coordinates used (stored or re-solved), SKETCH_ORIGIN included. */
  points: Record<SketchPointId, Vec2>;
  /** Circle radii used. */
  radii: Record<SketchEntityId, number>;
  /** The non-construction curves given to the kernel (also what extrude_regions gets). */
  curves: SketchCurve[];
  regions: SketchRegion[];
  /** Open ends (the open-profile markers). */
  open: { at: Vec2; entity: string; point: string | null }[];
  dangling: SketchEntityId[];
  /** Driven dimensions' measured values (mm or deg), for their labels. */
  measured: Record<SketchConstraintId, number>;
  source: SketchSolveSource;
  /** The face support could not be found: the sketch stayed on its stored plane. */
  supportLost?: boolean;
  /**
   * P4b (SELECT): each link as this rebuild found it: 'ok' (re-projected), 'lost' (its source is
   * gone: the entities keep their last place, amber), 'changed' (a face, silhouette or section now
   * has another number of curves: shown as it was until the sketch is opened), with the words.
   */
  links?: Record<string, { state: 'ok' | 'lost' | 'changed'; message?: string; lost?: string[] }>;
  /**
   * P4b (SELECT, fix round 1): the sketch's entities as this build used them, when a re-projection
   * changed them (new linked curves, moved or detached points); the model-mode overlay draws these.
   */
  entities?: import('./doc').SketchEntity[];
}

// ------------------------------------------------------------ solver (PlaneGCS worker)

/**
 * The sketch as the solver takes it (src/solver-worker/solver-api.mjs). Built
 * from a SketchFeature by toSolverSketch (src/sketch/model.ts, P3-SKETCH):
 * SKETCH_ORIGIN becomes a fixed point, dimensions get their evaluated `value`,
 * driven dimensions go as driving:false, collinear becomes two point_on_line.
 */
export interface SolverSketch {
  points: Record<string, Vec2>;
  entities: (
    | { id: string; kind: 'point'; p: string; construction?: boolean }
    | { id: string; kind: 'line'; p: [string, string]; construction?: boolean }
    | { id: string; kind: 'circle'; c: string; r: number; construction?: boolean }
    | { id: string; kind: 'arc'; c: string; a: string; b: string; ccw?: boolean; construction?: boolean }
    // P4b (SKETCH): a spline (its points are solver points; the curve adds no unknowns).
    | { id: string; kind: 'spline'; form: 'fit' | 'control'; pts: string[]; degree: number; closed?: boolean; handles?: [string | null, string | null]; knots?: number[]; mults?: number[]; spans?: [number, number]; construction?: boolean }
    // Ellipses, arcs of an ellipse or a parabola, rho conics (src/sketch/tools/conic.ts): the solver adds their hidden unknowns.
    | { id: string; kind: 'ellipse'; c: string; major: string; minor: string; construction?: boolean }
    | { id: string; kind: 'ellipse_arc'; c: string; major: string; minor: string; a: string; b: string; ccw?: boolean; construction?: boolean }
    | { id: string; kind: 'parabola'; f: string; v: string; a: string; b: string; construction?: boolean }
    | { id: string; kind: 'conic'; a: string; b: string; t: string; rho: number; construction?: boolean }
  )[];
  // P4b (SKETCH): number[] for the solver-only pattern ties (src/sketch/tools/ties.ts).
  constraints: { id: string; kind: string; refs: string[]; value?: number | Vec2 | number[]; driving?: boolean }[];
}

/** Solved values (solver-api `values()`): points, radii, driven measures. */
export interface SolverValues {
  points: Record<string, Vec2>;
  radii: Record<string, number>;
  measures: Record<string, number | null>;
}

export interface SolverSolveResult {
  status: string;
  solved: boolean;
  dof: number;
  conflicting: string[];
  redundant: string[];
  partiallyRedundant?: string[];
  values: SolverValues;
  ms: number;
}

/** Per-entity definition state for colouring (solver-api `analyze()`). */
export type DefinitionState = 'under' | 'fully' | 'over';

export interface SolverAnalysis {
  dof: number;
  perEntity: Record<string, DefinitionState>;
  perPoint: Record<string, DefinitionState>;
  /** The parameters still free, as "<point or entity id>.<u|v|r|...>" ("pt_3.u", "e_2.r"); "#<n>" for one with no owner. */
  dependentParams: string[];
  conflicting: string[];
  redundant: string[];
  ms: number;
}

/** A sketch solved and analysed apart (analyzeFeature): the solve, then the analysis of its result. */
export interface SolverFeatureAnalysis {
  solve: SolverSolveResult;
  analysis: SolverAnalysis;
}

/**
 * The main-thread client of the solver worker (workspace/solver/solver-worker.js,
 * started with ws.spawnWorker). One worker per page; calls are queued; drag
 * moves are coalesced (only the newest is solved). P3-SKETCH implements it in
 * src/sketch/solver-client.ts and publishes it in services.apis (`solver`).
 * The rebuild uses only `solveOnce`.
 */
export interface SketchSolverClient {
  /** Resolves when the worker answered ready (rejects with a plain reason when it cannot start). */
  ready(): Promise<void>;
  /**
   * The rebuild's re-solve of a sketch whose driving dimensions evaluate to
   * other values than `f.solved.values` (a parameter changed): starts from the
   * stored coordinates, solves with `values` (constraint id -> mm or deg),
   * returns the solved values. Stateless (its own load, then forgets); never
   * touches an interactive sketch-mode session. The client builds the solver
   * sketch itself (toSolverSketch, src/sketch/), so the sketch feature's build
   * (P3-PROFILES) needs nothing from src/sketch/.
   */
  solveFeature(f: SketchFeature, values: Record<SketchConstraintId, number>): Promise<SolverSolveResult>;
  /**
   * The same solve, apart (the worker's analyzeOnce, on the instance the rebuild's re-solve uses),
   * then the analysis of its result: the DOF, the free parameters, what conflicts or is redundant.
   * Never touches the sketch sketch mode is editing. The Assistant's headless check of a sketch.
   */
  analyzeFeature(f: SketchFeature, values: Record<SketchConstraintId, number>): Promise<SolverFeatureAnalysis>;
  load(sketch: SolverSketch): Promise<{ params: number; unknowns: number; constraints: number }>;
  solve(): Promise<SolverSolveResult>;
  analyze(): Promise<SolverAnalysis>;
  setValue(constraint: string, value: number | Vec2): Promise<SolverSolveResult>;
  dragStart(point: string, opts?: { freeze?: boolean }): Promise<{ ok: boolean; reason?: string; movable: boolean; at?: Vec2 }>;
  /** Superseded moves resolve with { superseded: true }. */
  dragMove(u: number, v: number): Promise<{ status: string; values?: SolverValues; superseded?: boolean }>;
  dragEnd(): Promise<SolverSolveResult>;
  dispose(): void;
}

// ------------------------------------------------------------ sketch mode

/** The drawing tools sketch mode offers (each one a command in the sketch toolbar). */
export type SketchToolId =
  | 'select'
  | 'line'
  | 'rectangle-corner'
  | 'rectangle-center'
  | 'circle'
  | 'arc-3pt'
  | 'arc-tangent'
  | 'point'
  | 'centerline'
  | 'dimension'
  | 'trim'
  | 'extend'
  // ---- P4b (SKETCH): splines, mirror, patterns, offset, fillet and chamfer
  | 'spline-fit'
  | 'spline-control'
  | 'mirror'
  | 'pattern-linear'
  | 'pattern-circular'
  | 'offset'
  | 'fillet'
  | 'chamfer'
  // ---- P4b (SELECT): linked geometry
  | 'project'
  | 'intersect'
  // ---- Import SVG/DXF (src/sketch/import/tool.ts): what a drawing read, then OK
  | 'import'
  // ---- Paste (src/sketch/tools/paste.ts): the copy follows the pointer, a click places it
  | 'paste'
  // ---- v0.5.0 (SHAPES): the person's tools for the Assistant's shape macros (src/sketch/tools/shapes.ts)
  | 'line-midpoint'
  | 'rectangle-3pt'
  | 'rectangle-center-3pt'
  | 'parallelogram'
  | 'circle-3pt'
  | 'arc-center'
  | 'slot-center'
  | 'slot-overall'
  | 'slot-center-point'
  | 'slot-arc-3pt'
  | 'slot-arc-center'
  | 'polygon'
  | 'sector'
  // ---- ellipses, parabolas and conics
  | 'ellipse'
  | 'ellipse-partial'
  | 'parabola'
  | 'conic';

/** Sketch mode's live state (one store; written only by src/sketch/). */
export interface SketchModeState {
  /** The sketch being edited, or null outside sketch mode. */
  feature: FeatureId | null;
  tool: SketchToolId;
  /** The last analysis: "Under defined · 2 DOF" / "Fully defined" / "Over defined · 1 conflicting". */
  status: { state: 'under' | 'fully' | 'over' | 'unsolved'; dof: number; conflicting: SketchConstraintId[]; redundant: SketchConstraintId[] } | null;
  /** Analysis running (colours may be one step behind). */
  analyzing: boolean;
  /** Typing a value in an on-canvas box (the keyboard belongs to it). */
  typing: boolean;
  /** ux010 (DRAW): construction drawing is on (what the drawing tools make is construction); off when the sketch opens. */
  drawConstruction?: boolean;
}

/**
 * Sketch mode (proposal §3.3). Entered when a panel session opens on a sketch
 * feature (new or edit), left when it closes. While it is on: services.mode is
 * 'sketch', the toolbar shows DRAW / MODIFY / CONSTRAIN / DIMENSION and Finish
 * sketch, the camera looks at the sketch plane, the rebuild stops after the
 * sketch (later features show rolled back), and the viewport's pointer belongs
 * to the sketch's tool (Alt + drag orbits; middle and right drag as usual).
 * Published by P3-SKETCH as services.apis.get().sketch.
 */
export interface SketchModeApi {
  readonly state: import('./state').ReadonlyStateStore<SketchModeState>;
  /** Start a new sketch on an origin plane or a planar face (opens its panel session; enters sketch mode). */
  newSketch(support: SketchFeature['support']): void;
  /** Edit an existing sketch (opens its panel session). */
  edit(feature: FeatureId): void;
  /**
   * Finish sketch (Done): commit the session, leave sketch mode. The person's Finish on a sketch the
   * Assistant draws takes it over (discarded). With the Assistant's `step`: its honest Done, null
   * when the sketch was kept, else why not.
   */
  finish(opts?: { step?: AssistantStep }): Promise<string | null>;
  setTool(tool: SketchToolId): void;
  /**
   * Leave the tool in hand entirely, as Escape pressed until it is gone (its open step dropped
   * as Escape drops it; then Select). The tool's own key pressed again (src/app/keyboard.ts
   * toolKeyAgain). False when there was no tool but Select to leave.
   */
  leaveTool(): boolean;
}
