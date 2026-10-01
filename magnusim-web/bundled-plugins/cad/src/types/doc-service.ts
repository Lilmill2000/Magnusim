// The document service: the one owner of the model, its rebuild, undo and saves.
// Owner: DOC-CORE (src/doc/). UI-SHELL and VIEWPORT read `state` and call methods.
// State is immutable: `state.doc` and everything in it is frozen (undo keeps
// snapshots of it); change the model only through the methods below.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, CadDoc, CadView, Feature, FeatureAction, FeatureId, FeatureStatus, FeatureType, Param, ParamId, SavedCamera } from './doc';
import type { BodyInfo, KernelAdapter } from './kernel';
import type { BBox, ShapeId } from './kernel-protocol';
import type { ReadonlyStateStore } from './state';
import type { UnitsService } from './units';

/** Autosave state for the status chip: "Saved" / "Saving…" / "Not saved: <why>". */
export type SaveState =
  | { state: 'saved'; at: string | null }
  | { state: 'pending' }
  | { state: 'saving' }
  /** `message` is the why of "Not saved: <why>" (the save is retried by itself). */
  | { state: 'error'; message: string }
  /** Another tab wrote the model: edits are paused until the user reloads ("Changed in another tab · Reload"). */
  | { state: 'conflict'; message: string };

export interface RebuildState {
  status: 'idle' | 'running' | 'done' | 'failed';
  /** Increments on every finished rebuild. */
  seq: number;
  features: Record<FeatureId, FeatureStatus>;
  /** Bodies at the rollback position, in creation order. */
  bodies: BodyInfo[];
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
  /** Refused while later features depend on it ("Cylinder 1 uses Body 1 of Box 1: …"). */
  remove(id: FeatureId): EditResult;
  /** Reorder with the parent/child guard. */
  move(id: FeatureId, toIndex: number): EditResult;
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
  /** A shape's bounding box (fast: tolerance-padded, always enclosing; cached per shape). */
  bbox(shape: ShapeId): Promise<BBox>;
  /** A shape's face count (cached per shape): large inputs get longer kernel timeouts. */
  faces(shape: ShapeId): Promise<number>;
  /** Free kernel shapes the build made and does not return. */
  release(ids: ShapeId[]): Promise<void>;
}

/** What a feature's build returns: bodies it created or changed, or an error. */
export type FeatureBuildResult =
  | { ok: true; bodies: { id: BodyId; shape: ShapeId; valid: boolean }[]; removed: BodyId[]; warning?: string }
  | { ok: false; message: string; actions?: FeatureAction[] };

/** The resolved values of a feature's expressions, or what is wrong with them. */
export type ResolveResult<V> = { ok: true; values: V } | { ok: false; message: string };

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
  /** Feature ids this one depends on (parent/child guard), besides the bodies in its scope. */
  parents(f: F): FeatureId[];
  build(f: F, values: V, ctx: BuildContext): Promise<FeatureBuildResult>;
}

export interface FeatureRegistry {
  register<F extends Feature, V>(def: FeatureTypeDef<F, V>): void;
  get(type: FeatureType): FeatureTypeDef | undefined;
  all(): FeatureTypeDef[];
}
