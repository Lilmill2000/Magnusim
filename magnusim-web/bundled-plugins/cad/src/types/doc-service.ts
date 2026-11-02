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
import type { BodyDef, BodyId, CadDoc, CadView, EnclosureSide, Feature, FeatureAction, FeatureId, FeatureStatus, FeatureType, Param, ParamId, PersistentRef, SavedCamera, SavedSection, ScaleModelPlace, StoredFileRef, Vec2, Vec3 } from './doc';
import type { BodyInfo, KernelAdapter } from './kernel';
import type { BBox, OffsetFaceAbout, ShapeId } from './kernel-protocol';
import type { FaceNames } from './naming';
import type { SketchOutput, SketchSolverClient } from './sketch';
import type { ConstructOutput } from './references';
import type { ReadonlyStateStore } from './state';
import type { UndoSnapshot } from './undo';
import type { Expr, UnitsService } from './units';

/** Autosave state for the status chip: "Saved" / "Saving…" / "Not saved: <why>". */
export type SaveState =
  | { state: 'saved'; at: string | null }
  | { state: 'pending' }
  | { state: 'saving' }
  /** `message` is the why of "Not saved: <why>" (the save is retried by itself). */
  | { state: 'error'; message: string }
  /**
   * Another tab wrote the model while this tab had a change not saved (both tabs edited): edits are
   * paused until the user picks Reload (this tab's change is lost) or Keep mine (the other tab's is).
   */
  | { state: 'conflict'; message: string }
  /**
   * Another tab saved a newer model while this tab had no change of its own (L3 review B1): nothing
   * here is unsaved, so the page is not dirty; edits wait for Reload ("Updated in another tab").
   * Leaving reloads it in place and links (or skips) without asking.
   */
  | { state: 'updated'; message: string };

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
export type FeatureOutput = SketchOutput | ImportOutput | EnclosureOutput
  // P4a: what a CONSTRUCT feature built (REFERENCE, src/types/references.ts)
  | ConstructOutput
  // P4a: the edges a Fillet or Chamfer rounded (SOLIDS)
  | EdgeChainOutput
  // P4b: the copies a pattern or mirror made (PATTERN)
  | PatternOutput
  // Press-pull on curved faces (kernel API 6): what Press-pull did, for its panel
  | PressPullOutput
  // Move/copy body: the pivot it turned about, for its panel
  | MoveBodyOutput
  // Delete faces (kernel API 8): how the faces came off, and "the rest" on a red result
  | DeleteFacesOutput;

/**
 * What a Delete faces did, for its panel and get_model (kernel API 8): `how` is 'fillets' when
 * Analysis Situs took the faces off as fillets (OCCT's heal could not), 'corners' (kernel API 9)
 * when the rounds came off one at a time with the corner faces of other fillets at their ends
 * (delete_faces/corners.ts), null when it failed; on a red result, "the rest": faces of the body
 * just before it that would make the pick whole (the rest of the fillet chains and holes the
 * picked faces are part of, or every fillet up to the largest picked radius), by index on that
 * body and as references the panel's Add the rest adds and get_model writes as face selectors.
 * Published when the faces came off as fillets or with their corners, and on a failure with a rest
 * (an ok heal publishes nothing: its result stays as before API 8).
 */
export interface DeleteFacesOutput {
  type: 'delete-faces';
  how: 'fillets' | 'corners' | null;
  rest: number[];
  restRefs: PersistentRef[];
}

/**
 * What a Move/copy body did, for its panel: the centre of the bodies' box just before it (the
 * pivot when none is typed), and the line it turned about (null: no turn).
 */
export interface MoveBodyOutput {
  type: 'move_body';
  /** The centre of the bodies' box just before it (the pivot when none is typed). */
  centre: Vec3 | null;
  /** The line it turned about (null: no turn). */
  axis: { origin: Vec3; dir: Vec3 } | null;
  /** About a picked axis: that axis as found just before it, also with no turn (null: not found, or not about one). */
  turnAxis?: { origin: Vec3; dir: Vec3 } | null;
  /** The rigid motion it applied to each body (3x4 row-major, as the kernel's `copies`): the view's handle previews from it. */
  matrix?: number[];
}

/**
 * What a Press-pull built (kernel API 6), for its panel's words ("Bore radius 10 mm -> 8 mm").
 * `method`: prism (flat faces, the API 3 prisms: no slanted neighbour, so the same as an
 * offset), offset (a true offset: neighbours extended or trimmed), refillet / offset+refillet
 * (fillets rounded again at their new radius), thicken (OCCT's offset refused: the faces
 * thickened and joined). `faces`: the picked faces as offset_faces describes them (empty on
 * the prism path); `tangent`: how many faces moved with them because they are tangent to
 * them; `note`: why the result differs visibly from a true offset, or null.
 */
export interface PressPullOutput {
  type: 'press-pull';
  method: 'prism' | 'offset' | 'refillet' | 'offset+refillet' | 'thicken' | 'cylinder';
  faces: OffsetFaceAbout[];
  tangent: number;
  note: string | null;
  /** Fix round 1: the fillets and chamfers beside the moved faces that were put back at their size. */
  carried?: { fillets: number; chamfers: number };
  /** Fix round 1: a feature made before version 2 (the prism path, kept for saved documents). */
  legacy?: boolean;
  /** Fix round 1: on a failure, OCCT's own words (the panel's Details), never in the red text. */
  detail?: string;
}

/**
 * P4b (PATTERN): what a Linear pattern, Circular pattern or Mirror built, for its panel and the
 * markers drawn on each copy (a click on one leaves that copy out). `at` is where the copy's marker
 * goes (the source's centre moved as the copy is); `skipped` copies are not made; `failed` names
 * copies the operation could not use (they turned the feature red).
 */
export interface PatternOutput {
  type: 'pattern';
  copies: { key: string; label: string; at: Vec3; skipped: boolean; failed?: boolean }[];
  /** Copies made (not skipped). */
  made: number;
  /** The source's centre (the original's marker). */
  origin: Vec3 | null;
}

/**
 * P4a (SOLIDS): what a Fillet or Chamfer built: how many edges it picked (and that its
 * faces gave), and how many it rounded with their tangent chains (the kernel's contours).
 */
export interface EdgeChainOutput {
  type: 'edge-chain';
  picked: number;
  done: number;
  /** Chamfer with two distances: the faces Distance 1 runs on, in words (P4a review: nothing said which). */
  distance1On?: string;
}

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
  /**
   * LINK: the save counter of the stored design (the model file's
   * `source_version`): it goes up by one with every save and never down. 0 until
   * the Part is read.
   */
  sourceVersion: number;
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
  /** The Assistant step that opened it ('assistant:<call id>', AssistantStep.owner); absent on the person's own sessions. */
  readonly owner?: string;
}

/** Result of a refused edit, in words for the UI ("Box 2 uses Box 1: move it after …"). */
export type EditResult = { ok: true } | { ok: false; reason: string };

/** How the person took over an Assistant step (AssistantStep.takenOver, the 'assistant:taken-over' event). */
export type TakeOverWhy = 'escape' | 'enter' | 'undo' | 'command' | 'edit' | 'draft';

/** A point to go back to: the model, the rollback bar and both undo lists, in the load they were taken in. */
export interface DocMark {
  readonly doc: CadDoc;
  readonly rollback: number | null;
  readonly history: UndoSnapshot<CadDoc>;
  readonly loadSeq: number;
}

/**
 * One Assistant edit call, all or nothing (doc.assistant.begin). While it is open and only it
 * changed the model, the stored model stays the mark (the save hold): a reload, crash or Back
 * mid-call never stores a half step. The person always comes first: a step never commits the
 * person's open session, and the person's own edits, undo and panels take it over.
 */
export interface AssistantStep {
  /** 'assistant:<call id>'. */
  readonly owner: string;
  readonly mark: DocMark;
  /**
   * Synchronous: sessions opened, undo steps pushed and other changes made inside fn are this
   * step's (sessions carry `owner`). Inside fn, an edit that would commit a session this step does
   * not own throws PersonEditing instead (the person's session stays open, uncommitted). Throws after end().
   */
  run<T>(fn: () => T): T;
  /**
   * Only this step changed the model since begin, and the person did not take it over: the undo
   * history moved by exactly this step's own changes, no load, the bar where this step left it, and
   * the model the one this step's own changes left. A person's panel opened on top counts by what it
   * began on: its live draft is no change of the Part until its Done (the save hold holds it too).
   */
  readonly clean: boolean;
  /** How the person took this step over, or null. */
  readonly takenOver: TakeOverWhy | null;
  readonly ended: boolean;
  /**
   * Merge this step's own undo steps into one {tag, label}. It joins the group below when that has
   * the same tag and ends where this step began. After an undo, redo or restore made inside the step
   * (the undo tool), the history that left stands and only steps pushed after it are merged; with
   * none, seal changes nothing. Throws unless clean, while this step's own session is still open, or
   * after end().
   */
  seal(tag: string, label: string): void;
  /**
   * Back to the mark (model, bar, both undo lists) when only this step changed the model; a take-over
   * by itself does not prevent it (it completes the person's discard). {ok:false, reason} otherwise,
   * and nothing changes. Idempotent: later calls, and calls after end(), return the first result.
   */
  revert(): EditResult;
  /**
   * The labels of this step's own undo steps still in the history, unsealed ("Plane 1"): what
   * stayed of it after a revert the person's change refused. Empty once reverted or sealed.
   */
  left(): string[];
  /**
   * Release the save hold (idempotent): a write follows when the model differs from what is stored.
   * 'assistant:step-ended' is emitted (once), so a panel the step showed with no session closes.
   */
  end(): void;
}

export interface AssistantDoc {
  /**
   * Open a step. Throws when a step is open or the Part is not editable, and PersonEditing while a
   * panel session is open (the person's).
   */
  begin(owner: string): AssistantStep;
  /** The open step, or null. */
  current(): AssistantStep | null;
  mark(): DocMark;
  /**
   * Put a mark back: model, bar and both undo lists; one rebuild; no new undo step. A session the
   * Assistant owns is closed with it. The person's open session stays open on the restored model
   * when what its draft reads (the feature it edits, the features it uses, the parameters it names)
   * is there as it was when the panel opened; a draft it had applied goes back in on top, still the
   * person's. Refused otherwise (nothing changes), after a load, or while not editable.
   */
  restore(mark: DocMark): EditResult;
  /** The newest undo step when it carries a tag, or null. */
  topGroup(): { tag: string; label: string; after: CadDoc } | null;
  /** doc.undo() when the newest undo step carries `tag`; refused otherwise, or while a panel session is open. */
  undoGroup(tag: string): EditResult;
  /**
   * The person took over the Assistant's open session (its panel's Escape or Enter, a command, a draft
   * change): it is discarded, the open step is marked `takenOver`, and 'assistant:taken-over' is emitted.
   * False (nothing done) when no session the Assistant owns is open. With `owner` (a panel the
   * Assistant shows with no session, its Parameters panel): that step, while it is the open one, is
   * marked and the event emitted even with no session open.
   */
  takeOver(why: TakeOverWhy, opts?: { owner?: string }): boolean;
  /**
   * The person's Undo or Redo now would take the open Assistant step over whole: the step changed
   * the Part, only it did, and no panel session is open. Every piece of it goes back to its mark
   * (nothing else is undone), the step is marked `takenOver` 'undo' and 'assistant:taken-over' is emitted.
   */
  undoTakesOver(): boolean;
}

/** Rows for DocService.editParams: all applied in one undo step. */
export interface ParamRows {
  add: Array<Omit<Param, 'id'>>;
  change: Array<{ id: ParamId; patch: Partial<Omit<Param, 'id'>> }>;
  remove: ParamId[];
}

/** What editParams did: the new parameters' ids by name, or the refusal and the row at fault ("add[0]", "change[1]", "remove[0]"). */
export type ParamsResult = EditResult & { ids?: Record<string, ParamId>; row?: string };

/** Exact properties of a body (mm, mm², mm³). */
export interface BodyProps {
  volume: number;
  area: number;
  centroid: [number, number, number] | null;
  bbox: BBox;
  faces: number;
  edges: number;
  solids: number;
  /**
   * Shells in the whole body, counted over every solid (the kernel gives totals only):
   * a closed solid with a sealed inner void has 2, and so do two separate solids.
   * For a body of closed solids, shells - solids is the number of sealed voids.
   */
  shells: number;
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
  /**
   * Suppress every feature of a removed type (Box, Cylinder: REMOVED_FEATURE_TYPES) that is not
   * suppressed yet, in one undo step (L3 review B2: the in-CAD notice's "Suppress them"). The
   * features stay in the Part with their data; Unsuppress or Undo brings them back.
   */
  suppressRemoved(): EditResult;
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
  /**
   * The person's newest `count` undo steps joined into one labelled `label` (a Hole's sketch and its
   * cut; several features deleted at once), as the Assistant's request is one step. Refused while an
   * Assistant step or a panel session is open, or when those steps are not all the person's.
   */
  joinSteps(count: number, label: string): EditResult;
  /** A body made by a feature (also a split piece with a derived id, which gets its BodyDef here). */
  renameBody(id: BodyId, name: string): EditResult;
  setBodyColor(id: BodyId, color: string): EditResult;
  /**
   * LINK: whether a body goes to the project's linked geometry ("Include in
   * simulation", on by default). One undo step; a model change, so it is saved
   * and counts as a new version of the design.
   */
  setBodyInSimulation(id: BodyId, include: boolean): EditResult;
  addParam(p: Omit<Param, 'id'>): ParamId | EditResult;
  /** A rename also renames the parameter in every expression that uses it. */
  updateParam(id: ParamId, patch: Partial<Omit<Param, 'id'>>): EditResult;
  /** Refused while an expression uses it. */
  removeParam(id: ParamId): EditResult;
  /**
   * Add, change and remove parameters in one undo step ("Parameters: 3 changed", or `label`). The
   * final set is checked once, so any row order works (a parameter may use one added after it, and
   * two may swap which uses which); a rename rewrites every use; a removed name still used in the
   * final model refuses the whole edit. A refusal names the row at fault.
   */
  editParams(rows: ParamRows, label?: string): ParamsResult;
  undo(): void;
  redo(): void;
  /** "Try repair" on a feature whose result was not a valid solid (one undo step). */
  repair(id: FeatureId): EditResult;
  /** Build again a feature the kernel stopped (watchdog, crash, out of memory). Not an undo step. */
  retry(id: FeatureId): EditResult;

  // --- view state: saved, not undoable ---
  setRollback(index: number | null): void;
  setBodyVisible(id: BodyId, visible: boolean): void;
  /** Draw bodies see-through (on) or opaque again (CadView.seeThroughBodies). */
  setBodiesSeeThrough(ids: readonly BodyId[], on: boolean): void;
  setExpanded(key: string, expanded: boolean): void;
  /** The origin planes' mode, kept per Part. */
  setPlanes(mode: 'auto' | 'always'): void;
  /** Where the camera is, kept per Part (written on the view's cadence; not undoable). */
  setCamera(camera: SavedCamera): void;
  /** The section view, kept per Part while it is on (null: off); not undoable (src/features/section). */
  setSection(section: SavedSection | null): void;
  /** Show or hide a sketch in model mode (the tree's eye); null forgets the choice (shown until used). */
  setSketchVisibility(id: FeatureId, mode: 'shown' | 'hidden' | null): void;
  /**
   * ux010 (TOOLBAR builder): show the banana for scale at `place`, or remove it (null). Kept with
   * the view (CadView.scaleModels): saved, not undoable, never part of the model.
   */
  setScaleModel(kind: 'banana', place: ScaleModelPlace | null): void;
  /** ux010: the taped banana in sketch `feature` at `at` (its centre, sketch u/v mm), or removed (null). Kept with the view, as setScaleModel. */
  setSketchBanana(feature: FeatureId, at: Vec2 | null): void;

  /**
   * Exact volume, area and bounding box of a body at the current rebuild
   * (small parts are measured with every rebuild; large ones on request, with
   * the kernel's long timeout). Also fills BodyInfo.volume / area / bbox.
   */
  measure(id: BodyId): Promise<BodyProps>;
  /** Save now whatever is pending (model and view). */
  flush(): Promise<void>;
  /**
   * L3: tell the app again whether the page has unsaved work (nav.setDirty), and wait until it
   * has heard it. The link says "clean" to the app for the saved design; a value still typed in
   * a field (not applied) is unsaved work all the same, so the exit's question asks about it.
   */
  retellDirty(): Promise<void>;
  /** Try a save that failed ("Not saved: <why>") again now. */
  retrySave(): void;
  /** Re-read after a conflict ("Changed in another tab · Reload"). */
  reload(): Promise<void>;
  /**
   * After a conflict ("Changed in another tab"): write this tab's model over the
   * other tab's save ("Keep mine"). The caller has warned the user. Resolves once
   * written; refused again when a third save came in between.
   */
  keepMine(): Promise<void>;
  /**
   * LINK: the bodies at the end of the history (the rollback bar ignored), built
   * from the model as it is now, for the export. Rejects when the part cannot be
   * built (the kernel is down).
   */
  bodiesAtEnd(): Promise<EndBodies>;
  /**
   * The bodies as they are just before `feature` (the features above it, whatever the
   * rollback bar), built from the model as it is now through the rebuild's cache, with
   * no tessellation; the page's view is not touched. Rejects when the feature is not in
   * the part, the part is not ready, or the kernel stopped on the way.
   */
  bodiesBefore(feature: FeatureId): Promise<EndBodies>;
  /**
   * Resolves once the rebuild of the current model and view has finished (its status
   * 'done' or 'failed'), with that rebuild: the part is ready, nothing is rebuilding
   * or waiting to, the shown result was built from this very document at the bar the
   * rebuild uses now (a sketch's isolated build while its session is open), and no
   * kernel respawn is under way. Driven by state changes, never by timers. Rejects when
   * `signal` aborts, a load starts, the part could not be read, or the service is disposed.
   */
  settled(signal?: AbortSignal): Promise<RebuildState>;
  /**
   * The model as committed: while a panel session is open, the document from before it
   * (live drafts are not committed); otherwise state.doc.
   */
  committed(): CadDoc;
  /** LINK: the newest save counter the study record holds or is about to (waits for its write). */
  recordSettled(): Promise<void>;
  /** Assistant steps: all-or-nothing edits, the save hold, take-over, seal and restore. */
  readonly assistant: AssistantDoc;
  /**
   * Model writes wait until the returned release() (an arrow being dragged applies live; one write
   * follows the release). Leaving still writes.
   */
  holdSaves(): () => void;
  /**
   * Is what is stored still what this tab stored or loaded? When another tab saved over it and this
   * tab has no change of its own, the save state becomes "updated" ("Updated in another tab": not
   * dirty, Reload only). A tab with a change finds out when it saves ("conflict").
   */
  checkStored(): Promise<void>;
  dispose(): void;
}

/** LINK: a body at the end of the history, as the export needs it (src/link). */
export interface EndBody {
  id: BodyId;
  /** Kernel id in the current worker. */
  shape: ShapeId;
  valid: boolean;
  feature: FeatureId;
  /** Its faces' persistent names, or null when none were made. */
  names: FaceNames | null;
  name: string;
  color: string;
  /** BuiltBody.placement. */
  placement?: number[] | null;
}

/** LINK: what DocService.bodiesAtEnd() built: the bodies, and the features that failed on the way. */
export interface EndBodies {
  bodies: EndBody[];
  /** Features of the history that failed or were stopped (red in the tree), by name. */
  failed: string[];
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
  /** Where Move/copy body features took it since it was made (src/naming/placement.ts); absent or null: nowhere. */
  placement?: number[] | null;
}

/** Read access to the Part's stored files (ws.files) for feature builds. */
export interface FeatureFiles {
  /** The bytes, checked against ref.sha256 (a mismatch rejects: "the stored file changed"). null when the file is gone. */
  read(ref: StoredFileRef): Promise<ArrayBuffer | null>;
  /**
   * Where a stored file gone missing is not, in the person's words: "in the project" where the host
   * has projects (Magnusim), "with the Part" in Magnusim CAD ("... is not in the project any more").
   * Absent: the project's words.
   */
  where?: string;
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
  /**
   * P4b (PATTERN): the feature types, so a feature pattern builds its source features' tool bodies
   * again through their own builds. Absent in contexts that do not give it (unit fakes).
   */
  registry?: FeatureRegistry;
}

/** What a feature's build returns: bodies it created or changed, or an error. */
export type FeatureBuildResult =
  | {
      ok: true;
      /**
       * `name` / `color`: what a body with no BodyDef is called and drawn in (a
       * split piece "Body 1 (2)" in its target's colour) until the user renames
       * or recolours it (that stores a BodyDef). `placement`: where it is now
       * against where it was made (a Move/copy body sets it); absent, a body keeps
       * the one it had, and a new one takes its source's (a split piece) or none.
       */
      bodies: { id: BodyId; shape: ShapeId; valid: boolean; names?: FaceNames | null; name?: string; color?: string; placement?: number[] | null }[];
      removed: BodyId[];
      warning?: string;
      /**
       * What the result is when it may well be what the user meant, said but not warned: a Join
       * whose tools do not touch the target keeps the pieces apart in one body (FeatureStatus.note).
       */
      note?: string;
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
