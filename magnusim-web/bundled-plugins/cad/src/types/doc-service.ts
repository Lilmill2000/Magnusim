// The document service: the one owner of the model, its rebuild, undo and saves.
// Owner: DOC-CORE (src/doc/). UI-SHELL and VIEWPORT read `state` and call methods.
// State is immutable: `state.doc` and everything in it is frozen (undo keeps
// snapshots of it); change the model only through the methods below.
// P2/P3 additions (docs/p2p3-plan.md §3.2): feature types declare the bodies
// they make and read, their expression fields and whether the rebuild stops
// after them while they are edited; builds get stored files, the outputs of
// earlier features (a sketch's regions), the sketch solver and face names;
// RebuildState publishes every feature's output.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyDef, BodyId, CadDoc, CadView, EnclosureSide, Feature, FeatureAction, FeatureId, FeatureStatus, FeatureType, Param, ParamId, SavedCamera, StoredFileRef, Vec3 } from './doc';
import type { BodyInfo, KernelAdapter } from './kernel';
import type { BBox, ShapeId } from './kernel-protocol';
import type { FaceNames } from './naming';
import type { SketchOutput, SketchSolverClient } from './sketch';
import type { ReadonlyStateStore } from './state';
import type { Expr, UnitsService } from './units';

/** Autosave state for the status chip: "Saved" / "Saving…" / "Not saved: <why>". */
export type SaveState =
  | { state: 'saved'; at: string | null }
  | { state: 'pending' }
  | { state: 'saving' }
  /** `message` is the why of "Not saved: <why>" (the save is retried by itself). */
  | { state: 'error'; message: string }
  /** Another tab wrote the model: edits are paused until the user reloads ("Changed in another tab · Reload"). */
  | { state: 'conflict'; message: string };

/** What an import's rebuild did (its panel says "Loaded from the stored BREP in 1.2 s"; never re-heals). */
export interface ImportOutput {
  type: 'import';
  /**
   * 'brep': read the stored healed BREP (always, after the import is made);
   * 'source': the BREP was written by another OCCT, so the stored STEP was healed again.
   */
  from: 'brep' | 'source';
  bytes: number;
  ms: number;
}

/**
 * A feature's build output besides its bodies, published in
 * RebuildState.outputs and BuildContext.outputs (later features read it: an
 * extrude reads its sketch's regions). Add members as features need them.
 */
export type FeatureOutput = SketchOutput | ImportOutput | EnclosureOutput;

/**
 * What an Enclosure built (its panel and its drag arrows read it): the exact
 * bounding box of the bodies it encloses, each side's padding as built, and
 * the shape it made.
 */
export interface EnclosureOutput {
  type: 'enclosure';
  /** The bodies it enclosed. */
  bodies: BodyId[];
  /** Their exact bounding box together [xmin, ymin, zmin, xmax, ymax, zmax] (mm). */
  bbox: BBox;
  /** Each side's padding as built (mm): the box's six sides, or the cylinder's radius, top and bottom. */
  pad: Partial<Record<EnclosureSide, number>>;
  /** A box: its corners (mm). */
  box?: { min: Vec3; max: Vec3 };
  /** A cylinder: the centre of its bottom, its axis, radius and length (mm); r0 = the radius with no padding. */
  cylinder?: { base: Vec3; axis: Vec3; r: number; h: number; r0: number };
}

export interface RebuildState {
  status: 'idle' | 'running' | 'done' | 'failed';
  /** Increments on every finished rebuild. */
  seq: number;
  features: Record<FeatureId, FeatureStatus>;
  /** Bodies at the rollback position, in creation order. */
  bodies: BodyInfo[];
  /** Outputs of the features built (sketch regions, import info), by feature id. */
  outputs: Record<FeatureId, FeatureOutput>;
  ms: number | null;
  /** A whole-rebuild failure (kernel down), not a feature error. */
  message: string | null;
}

export interface DocState {
  status: 'loading' | 'ready' | 'error';
  /** Why loading failed ("Could not read the part: …"). */
  error: string | null;
  doc: CadDoc;
  view: CadView;
  rebuild: RebuildState;
  save: SaveState;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  /** The panel session open right now (its feature is being edited), or null. */
  session: { id: string; feature: FeatureId; isNew: boolean } | null;
}

/**
 * A panel session: every valid field change applies live (rebuild + save), and
 * the whole session is ONE undo step. `commit` (Done) keeps it; `discard`
 * (Delete on a new feature, or closing a new feature whose inputs are
 * incomplete) removes what the session added.
 */
export interface EditSession {
  readonly id: string;
  readonly feature: FeatureId;
  readonly isNew: boolean;
  /** The feature as last typed, valid or not (the document holds the last valid version). */
  readonly draft: Feature;
  /** False once committed or discarded (or replaced by another session). */
  readonly open: boolean;
  /**
   * Replace fields of the session's feature; applies live when the feature
   * validates. Switching `op` to "new" gives the feature a body (the same one
   * as before in this session); switching away from "new" clears `creates`.
   */
  update(patch: Partial<Feature>): void;
  /** Why Done is disabled ("Height: Enter a value"), or null. */
  incomplete(): string | null;
  /** Done. A new feature that is still incomplete is discarded instead. */
  commit(): void;
  discard(): void;
  /** Whether the part differs from before the session: what Done would keep as one undo step. */
  readonly changed?: boolean;
}

/** Result of a refused edit, in words for the UI ("Box 2 uses Box 1: move it after …"). */
export type EditResult = { ok: true } | { ok: false; reason: string };

/** Exact properties of a body (mm, mm², mm³). */
export interface BodyProps {
  volume: number;
  area: number;
  centroid: [number, number, number] | null;
  bbox: BBox;
  faces: number;
  edges: number;
  solids: number;
}

export interface DocService {
  readonly state: ReadonlyStateStore<DocState>;
  readonly units: UnitsService;
  readonly features: FeatureRegistry;
  /** Read the model (or start an empty one), then rebuild. Resolves when ready or errored. */
  load(): Promise<void>;
  /** true, or why the model cannot be edited now ("The part is still loading", "Changed in another tab · Reload"). */
  editable(): true | string;

  // --- edits: each is one undo step and triggers rebuild + autosave ---
  /**
   * Opens a panel session on a new feature of `type` (defaults from the
   * registry), inserted at the rollback bar. Commits any open session first.
   * Throws when the model is not editable (check `editable()` first).
   */
  beginNew(type: FeatureType, init?: Partial<Feature>): EditSession;
  /** Opens a panel session on an existing feature (the open one when it is the same feature). */
  beginEdit(id: FeatureId): EditSession;
  /** The open session, or null. */
  session(): EditSession | null;
  rename(id: FeatureId, name: string): EditResult;
  setSuppressed(id: FeatureId, suppressed: boolean): EditResult;
  /** Refused while later features depend on it ("Cylinder 1 uses Body 1 of Box 1: …"). A refusal leaves an open panel session on it as it was. */
  remove(id: FeatureId): EditResult;
  /**
   * Why `remove(id)` would be refused now (a later feature uses it), or null
   * when it can be removed. Changes nothing: panels show their Delete only
   * when this is null. For a feature with an open session, both the feature
   * as edited and as it was before the panel opened are checked.
   */
  removeBlock(id: FeatureId): string | null;
  /** Reorder with the parent/child guard. */
  move(id: FeatureId, toIndex: number): EditResult;
  /** A body made by a feature (also a split piece with a derived id, which gets its BodyDef here). */
  renameBody(id: BodyId, name: string): EditResult;
  setBodyColor(id: BodyId, color: string): EditResult;
  addParam(p: Omit<Param, 'id'>): ParamId | EditResult;
  /** A rename also renames the parameter in every expression that uses it. */
  updateParam(id: ParamId, patch: Partial<Omit<Param, 'id'>>): EditResult;
  /** Refused while an expression uses it. */
  removeParam(id: ParamId): EditResult;
  undo(): void;
  redo(): void;
  /** "Try repair" on a feature whose result was not a valid solid (one undo step). */
  repair(id: FeatureId): EditResult;
  /** Build again a feature the kernel stopped (watchdog, crash, out of memory). Not an undo step. */
  retry(id: FeatureId): EditResult;

  // --- view state: saved, not undoable ---
  setRollback(index: number | null): void;
  setBodyVisible(id: BodyId, visible: boolean): void;
  setExpanded(key: string, expanded: boolean): void;
  /** The origin planes' mode, kept per Part. */
  setPlanes(mode: 'auto' | 'always'): void;
  /** Where the camera is, kept per Part (written on the view's cadence; not undoable). */
  setCamera(camera: SavedCamera): void;
  /** Show or hide a sketch in model mode (the tree's eye); null forgets the choice (shown until used). */
  setSketchVisibility(id: FeatureId, mode: 'shown' | 'hidden' | null): void;

  /**
   * Exact volume, area and bounding box of a body at the current rebuild
   * (small parts are measured with every rebuild; large ones on request, with
   * the kernel's long timeout). Also fills BodyInfo.volume / area / bbox.
   */
  measure(id: BodyId): Promise<BodyProps>;
  /** Save now whatever is pending (model and view). */
  flush(): Promise<void>;
  /** Try a save that failed ("Not saved: <why>") again now. */
  retrySave(): void;
  /** Re-read after a conflict ("Changed in another tab · Reload"). */
  reload(): Promise<void>;
  dispose(): void;
}

/** A body as the rebuild holds it between features. */
export interface BuiltBody {
  id: BodyId;
  /** Kernel id in the current worker. */
  shape: ShapeId;
  valid: boolean;
  /** The feature that last changed it. */
  feature: FeatureId;
  /** Its faces' persistent names (src/naming), or null when the feature that made it gave none (P1 primitives before naming). */
  names: FaceNames | null;
}

/** Read access to the Part's stored files (ws.files) for feature builds. */
export interface FeatureFiles {
  /** The bytes, checked against ref.sha256 (a mismatch rejects: "the stored file changed"). null when the file is gone. */
  read(ref: StoredFileRef): Promise<ArrayBuffer | null>;
}

/** Context a feature's build gets: the kernel and the bodies built before it. */
export interface BuildContext {
  kernel: KernelAdapter;
  /** Evaluates against the document being built. */
  units: UnitsService;
  /** Bodies as they are just before this feature (by body id, creation order). */
  bodies: ReadonlyMap<BodyId, BuiltBody>;
  doc: CadDoc;
  /** The body names for messages ("Body 1"). */
  bodyName(id: BodyId): string;
  /** A feature's name for messages ("Sketch 1"), or "a deleted feature". */
  featureName(id: FeatureId): string;
  /** A shape's bounding box (fast: tolerance-padded, always enclosing; cached per shape). */
  bbox(shape: ShapeId): Promise<BBox>;
  /** A shape's face count (cached per shape): large inputs get longer kernel timeouts. */
  faces(shape: ShapeId): Promise<number>;
  /** Free kernel shapes the build made and does not return. */
  release(ids: ShapeId[]): Promise<void>;
  /** Outputs of the features built before this one in this rebuild (a sketch's regions). Absent = not built (failed, suppressed, rolled back). */
  outputs: ReadonlyMap<FeatureId, FeatureOutput>;
  /** The Part's stored files; null on a host without ws.files (API 1.1): an import then fails with that reason. */
  files: FeatureFiles | null;
  /** The sketch solver (re-solving a sketch whose dimensions changed); null until sketch mode's module started it. */
  solver: SketchSolverClient | null;
}

/** What a feature's build returns: bodies it created or changed, or an error. */
export type FeatureBuildResult =
  | {
      ok: true;
      /**
       * `name` / `color`: what a body with no BodyDef is called and drawn in (a
       * split piece "Body 1 (2)" in its target's colour) until the user renames
       * or recolours it (that stores a BodyDef).
       */
      bodies: { id: BodyId; shape: ShapeId; valid: boolean; names?: FaceNames | null; name?: string; color?: string }[];
      removed: BodyId[];
      warning?: string;
      /** Published in RebuildState.outputs and to later features' BuildContext.outputs. */
      output?: FeatureOutput;
    }
  | {
      ok: false;
      message: string;
      actions?: FeatureAction[];
      /**
       * What the feature found before it failed, for its own panel (an Enclosure that cannot be made
       * still knows the bodies it encloses and their box, so its panel names the side at fault).
       * Published in RebuildState.outputs as a success's is.
       */
      output?: FeatureOutput;
    };

/** The resolved values of a feature's expressions, or what is wrong with them. */
export type ResolveResult<V> = { ok: true; values: V } | { ok: false; message: string };

/** One expression field of a feature: `path` is its JSON path ("extent.distance", "constraints[3].expr"). */
export interface ExprField {
  path: string;
  expr: Expr;
}

/** One feature type: defaults, validation and its kernel build. */
export interface FeatureTypeDef<F extends Feature = Feature, V = unknown> {
  type: F['type'];
  /** "Box" (the tree numbers them "Box 1", "Box 2"). */
  label: string;
  /** SVG path d, 24x24 outline (tree row and toolbar). */
  icon: string;
  /** A new feature with defaults (in the document's display units). */
  create(doc: CadDoc, init?: Partial<F>): F;
  /** Every expression evaluated (mm / deg), or the first problem in words ("Height must be more than 0"). */
  resolve(f: F, units: UnitsService): ResolveResult<V>;
  /** Why it cannot be built yet (incomplete inputs or a bad expression), or null. */
  incomplete(f: F, units: UnitsService): string | null;
  /** Feature ids this one depends on (parent/child guard, and the rebuild cache key), besides the bodies it uses. */
  parents(f: F): FeatureId[];
  build(f: F, values: V, ctx: BuildContext): Promise<FeatureBuildResult>;

  // --- P2/P3 hooks (optional; the defaults are the P1 behaviour of body-making features) ---
  /**
   * Bodies whose geometry the build reads or changes: the rebuild cache key
   * and the parent/child guard ("Combine 1 uses Body 2 of Split 1"). 'all' =
   * every body before it. Default: BodyMaking -> op 'new' none, else its scope
   * (empty scope = 'all'); any other feature none.
   */
  uses?(f: F): BodyId[] | 'all';
  /**
   * Whether this feature makes body `id` (keeps its BodyDef alive, and makes
   * this feature the parent of features that use it). Default: BodyMaking ->
   * id === creates. Split answers true for its derived piece ids.
   */
  ownsBody?(f: F, id: BodyId): boolean;
  /**
   * BodyDefs to add when the feature enters the document (import: one per STEP
   * body with its name and colour). Ids already in doc.bodies are kept as they are.
   */
  newBodies?(f: F, doc: CadDoc): Record<BodyId, BodyDef>;
  /**
   * Whether body `id` (one this feature owns) is drawn see-through: translucent, and a click
   * through it picks the opaque body behind (SD pass: an Enclosure's body, so the part inside and
   * the air around it are both seen; review round 1: it hid the part and z-fought with it).
   */
  seeThrough?(f: F, id: BodyId): boolean;
  /**
   * The feature's expression fields (parameter use and rename). Default: every
   * string field except id, type, name, op, creates, scope, axis, suppressed,
   * repair (right for box and cylinder). A feature holding other strings
   * (references, region keys, file paths) MUST give this, or a parameter
   * rename would rewrite them.
   */
  exprs?(f: F): ExprField[];
  /** Rewrite every expression field (a parameter rename); required with `exprs`. */
  mapExprs?(f: F, fn: (e: Expr) => Expr): F;
  /**
   * While a panel session edits it, the rebuild stops after it (later features
   * show rolled back; nothing downstream rebuilds on every edit). Sketches set
   * this (Fusion: editing a sketch rolls the timeline to it).
   */
  isolateWhileEditing?: boolean;
}

export interface FeatureRegistry {
  register<F extends Feature, V>(def: FeatureTypeDef<F, V>): void;
  get(type: FeatureType): FeatureTypeDef | undefined;
  all(): FeatureTypeDef[];
}
