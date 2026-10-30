/**
 * The workspace bridge, frame side: what a plugin's workspace page imports
 * (`import { connect } from '@magnusim/workspace'`, served as
 * `/plugin-sdk/workspace.js`).
 *
 * A workspace runs in a sandboxed frame with an opaque origin: it cannot reach
 * the app's page or its API, has no localStorage, IndexedDB or cookies, and
 * talks to the app only through this bridge. `connect()` says hello to the
 * host, which answers with the context (plugin, project, study, units, look) and a
 * private MessageChannel port; every call then goes over that port, and the
 * host checks it against an allowlist scoped to this plugin, project and study.
 *
 * Self-contained: no imports, so the host can serve it to any frame.
 */

/**
 * The bridge's version; a host accepts a workspace built for the same major version.
 * 1.4.0 (host 1.7): ws.prefs, context.geometry and context.launch, ws.project.geometrySource
 * and ws.project.geometryFaces, and linkGeometry's `originalNames` (editing a project geometry).
 */
export const SDK_VERSION = '1.4.0';

/** A project-level study record (plugins/<key>/studies/<sid>/study.json) plus the plugin's own fields. */
export interface StudyRecord {
  id: string;
  kind: string;
  title: string;
  schema_version: number;
  rev: number;
  plugin: string;
  plugin_name: string;
  plugin_version: string;
  created_at: string;
  updated_at: string;
  /**
   * Reserved (host 1.5): the version of the design this study saved last. A linking
   * plugin writes it with study.update after each save; the host only reads it, and
   * the linked geometry's row says "Not up to date" while it is newer than the
   * version the geometry was last updated from.
   */
  source_version?: number;
  [field: string]: unknown;
}

export type UnitSystem = 'metric' | 'imperial';

export interface ThemeInfo {
  /**
   * The stylesheet's name, 'light' on every host so far: it holds the dark set too, and
   * context.appearance says which one the page shows (unreleased, 1.9).
   */
  name: 'light';
  /** The stylesheet with the design tokens and base styles the host serves. */
  stylesheet: string;
}

/**
 * The app's look, as the person set it in Settings → Appearance (unreleased, 1.9):
 * context.appearance, and the `appearance` event after each change. The SDK shows it on this
 * page's <html> itself, before any listener hears it: data-theme (`theme`: theme.css's --mg-*
 * tokens and its color-scheme follow it), data-theme-pref (`preference`), --mg-text-scale and
 * --mg-icon-scale (the size tokens follow them). The page's first paint has it already: the
 * host puts it on the page as it loads it. A page on the tokens needs no code for it; what it
 * draws on screen itself (a canvas, a plot) reads `theme`. A picture or recording it keeps as a
 * file stays light whatever the theme: drawn with light colours read off an element that carries
 * data-theme="light" (theme.css gives that element the light set's tokens, text and background).
 * A host without it sends none, and its pages are light.
 */
export interface Appearance {
  /** The theme on screen: 'light' or 'dark' (a 'system' choice already decided). */
  theme: 'light' | 'dark';
  /** What the person chose: 'light', 'dark' or 'system' (the system's, followed as it changes). */
  preference: 'light' | 'dark' | 'system';
  /** The text size: 1 is the default (Settings offers 0.9, 1, 1.15 and 1.3). */
  textScale: number;
  /** The icon size: 1 is the default (Settings offers 0.85, 1, 1.25 and 1.5). */
  iconScale: number;
}

export interface WorkspaceContext {
  plugin: string;
  workspace: string;
  project: { id: string; title: string };
  study: StudyRecord;
  units: UnitSystem;
  theme: ThemeInfo;
  /**
   * The host's bridge API version ("1.7"). To use a call a later host added,
   * compare it as numbers, major then minor (ws.nav.setDirty needs 1.2,
   * ws.compute and ws.results need 1.3, ws.project.linkGeometry 1.5,
   * ws.nav.onLeave 1.6, ws.prefs and ws.project.geometrySource 1.7), or catch the
   * refusal: an older host rejects a call it does not know with code "not_allowed".
   * `ws.assistant` (unreleased in 1.8: check that it exists).
   */
  hostVersion: string;
  /**
   * The project geometry this study edits (host 1.7; absent on an older host): the one the
   * user chose "Edit in …" on (a `[[geometry_actions]]` entry), or the one this study links.
   * null for a study that edits no project geometry. Read its file with
   * ws.project.geometrySource() and its faces with ws.project.geometryFaces().
   */
  geometry?: EditedGeometry | null;
  /**
   * What the user right-clicked to open this page (host 1.7): a face label ("face 3@Body1")
   * or a body ("Body1") of `geometry`, from the viewport's menu. Given once, to the page load
   * the action opened; a reload has none. null or absent otherwise.
   */
  launch?: LaunchTarget | null;
  /**
   * The app shows its own Assistant panel, which offers the person Stop and "Undo these changes"
   * for a turn (unreleased, 1.9; absent on an older host). ws.assistant.docked reads it.
   */
  assistantDock?: boolean;
  /**
   * The keys that open and close the app's Assistant panel when the person changed them in
   * Settings → Keybinds: combos as a commands file writes them (Cmd counts as Ctrl), [] when they
   * left it no key. null for its default, Ctrl+/ (Cmd+/ on macOS) on the key that types "/"
   * (unreleased, 1.9; absent on an older host). The `assistantKeys` event says when they change.
   * While docked the page leaves these keys to the app (ws.assistant.docked): no command of its own
   * should answer them.
   */
  assistantKeys?: string[] | null;
  /**
   * The app's look (Appearance): light or dark, and the text and icon sizes (unreleased, 1.9;
   * absent on an older host, whose pages are light). The `appearance` event says when it changes.
   */
  appearance?: Appearance;
  /**
   * false: this app takes no study's design into a project as a geometry, so it runs no
   * simulation of it (Magnusim CAD). ws.project.linkGeometry, linkedGeometry and followGeometry are
   * refused there (`not_allowed`); leave out what only matters to a simulation (unreleased, 1.9).
   * Absent where they work, and on an older host: read absent as true.
   */
  projectLinks?: boolean;
}

/** What a geometry action was started on (host 1.7). */
export interface LaunchTarget {
  /** A host face label of the edited geometry, "face <n>@<body ref>". */
  face?: string;
  /** A body ref of the edited geometry ("Body1"). */
  body?: string;
}

/** The project geometry a study edits (host 1.7), as context.geometry gives it. */
export interface EditedGeometry {
  /** The geometry's id in the project. */
  id: string;
  name: string;
  /** What it was imported from: STEP, IGES, or a BREP (a linked geometry). */
  format: 'step' | 'iges' | 'brep';
  /** The file it was imported from, as the user named it; null when unknown. */
  fileName: string | null;
  /** True when this study links it (ws.project.linkedGeometry() has it): edits already went back once. */
  linked: boolean;
  /** Its revision: 0 for a plain import, then one more for each shape update. */
  rev: number;
  /** Its bodies (solids) and faces, in the host's numbering. */
  bodies: number;
  faces: number;
}

/** The file a project geometry was made from (host 1.7), as ws.project.geometrySource() gives it. */
export interface GeometrySource {
  geometryId: string;
  /** The STEP file: the import itself, or the host's own STEP of an IGES or BREP import. */
  file: File;
  /** 1.7 serves only 'step'. */
  format: 'step';
  size: number;
  /** The file's SHA-256 (hex): GeometryFaces.sourceSha256 for the same file. */
  sha256: string;
  /** True once an edit of this study went back to the project: the file is the original kept since. */
  adopted: boolean;
}

/** A body of a project geometry (host 1.7), in the host's order. */
export interface GeometryBody {
  /** 1-based, the host's order. */
  index: number;
  /** The host's body ref ("Body1"), as face labels use it. */
  ref: string;
  /** The body id a face-name sidecar gave it; null for a plain import. */
  id: string | null;
  name: string | null;
}

/** Where a face is used by a study's setup (host 1.7). */
export interface GeometryFaceUse {
  studyId: string;
  studyTitle: string;
  /** bc: a boundary condition; material: a material's volume; refinement: a mesh refinement; monitor: a result control. */
  kind: 'bc' | 'material' | 'refinement' | 'monitor';
  /** The record's name ("Inlet"). */
  item: string;
}

/** A face of a project geometry (host 1.7), in the host's face order. */
export interface GeometryFace {
  /** 1-based, the host's order: the order a face-name sidecar's rows follow. */
  index: number;
  /** Its body's index (1-based). */
  body: number;
  /** The host's label, "face <n>@<body ref>". */
  label: string;
  /** mm², and mm. */
  area: number;
  centroid: [number, number, number];
  /** The surface's normal at the face's middle (its u, v centre), outward; null when it has none. */
  normal: [number, number, number] | null;
  /** "plane", "cylinder", "cone", "sphere", "torus", "bspline", …; null when unknown. */
  surfaceType: string | null;
  /**
   * When two bodies share this face (it is inside the part): the index of the same face's
   * visit in the other body; else null.
   */
  sharedWith: number | null;
  /** The name a face-name sidecar gave it; null for a plain import. */
  name: string | null;
  uses: GeometryFaceUse[];
}

/** The faces of the geometry a study edits (host 1.7), as ws.project.geometryFaces() gives them. */
export interface GeometryFaces {
  geometryId: string;
  rev: number;
  lengthUnit: 'mm';
  /**
   * The SHA-256 of the file these faces were read from (GeometrySource.sha256 before the
   * first edit went back): an `originalNames` file gives it as its `shape_sha256`.
   */
  sourceSha256: string;
  bodies: GeometryBody[];
  faces: GeometryFace[];
}

/** ws.project.geometrySource's options (host 1.7). */
export interface GeometrySourceOptions {
  /** Aborting it stops the read (rejects with the signal's reason). */
  signal?: AbortSignal;
  /** Called as the file arrives, with the bytes so far and the total. */
  onProgress?: (done: number, total: number) => void;
}

export interface JobEvent {
  event: string;
  [field: string]: unknown;
}

/** A WSL step a plugin case may run before its solver (host 1.3; compatibility.md lists their arguments). */
export type PreTool =
  | 'blockMesh'
  | 'gmshToFoam'
  | 'surfaceFeatureExtract'
  | 'snappyHexMesh'
  | 'extrudeMesh'
  | 'changeDictionary'
  | 'createPatch'
  | 'checkMesh'
  | 'renumberMesh'
  | 'decomposePar'
  | 'reconstructParMesh';

/**
 * One WSL step. `parallel: true` runs it with `mpirun -np N … -parallel`, only
 * between a decomposePar step and the reconstructParMesh step after it, and
 * only for the tools that can run in parallel.
 */
export interface PreStep {
  tool: PreTool;
  args?: string[];
  parallel?: boolean;
}

/** A case the page wrote in its study's folder, to run with OpenFOAM in WSL (host 1.3). */
export interface SubmitOpenFOAM {
  /** The case folder inside this study's folder ("cases/c1"). It must not have run before. */
  caseRel: string;
  /** The solver application, as system/controlDict names it; a registered solver. */
  app: string;
  /** Ranks for a parallel solve and parallel steps (1 to 64; the host clamps it to the PC). */
  nProcs?: number;
  pre?: PreStep[];
  results: {
    /** Fields the solver writes divided by density; shown multiplied by rho. */
    kinematicFields: string[];
    rho?: number;
    /** Fields copied back for each saved frame (default U and p). */
    frameFields?: string[];
  };
}

export type ComputeStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'lost';

/** A plugin case as the page sees it: no paths. */
export interface ComputeJob {
  id: string;
  caseRel: string;
  app: string;
  nProcs: number;
  status: ComputeStatus;
  /** Where a running case is (pre_copy_in, solve, copy, stopping, …); null before it starts. */
  stage: string | null;
  /** A stop was asked for and the case has not ended yet. */
  stopping: boolean;
  /** How many jobs run or wait before it, or null when it is not queued. */
  ahead: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Why it was refused or did not finish ("has_results", "launch", "lost", …). */
  code: string | null;
  /** Once it has ended: the saved frames' times, the last one, seconds per phase, and how the solver wrote its fields. */
  result: { savedTimes: number[]; lastSaved: number | null; phases: Record<string, number>; writeFormat: string | null } | null;
  /** The last event's number. */
  seq: number;
}

/** A file the page wrote in its study's folder (host 1.5): its hash, or the etag ws.files.stat gave. */
export interface LinkFile {
  /** Its path from the plugin's folder, under studies/<this study>/. */
  rel: string;
  /** What ws.files.write returned; or `etag` (exactly one of the two). */
  sha256?: string;
  /** What ws.files.stat returned, for a file the plugin's backend wrote. */
  etag?: string;
}

export interface LinkShape extends LinkFile {
  /** 1.5 reads only 'brep': an OCCT BREP, binary (BinTools) or text (BRepTools). */
  format: 'brep';
}

export type LinkStage = 'queued' | 'reading' | 'meshing' | 'naming' | 'matching' | 'waiting' | 'saving' | 'finishing';

/** A face (or body) assignment an update could not place, kept on its record (host 1.5). */
export interface LostFace {
  studyId: string;
  studyTitle: string;
  kind: 'bc' | 'material' | 'result_control' | 'refinement' | 'mesh_doc' | 'run_doc' | 'run_result_control';
  /** The record's registry key (its BC kind, result-control kind or mesher); a plugin's own kinds show here. */
  registryKey: string | null;
  /** The record's name. */
  item: string;
  /** The field, e.g. "faces" or "assigned_volumes". */
  field: string;
  /** The label it had ("face 12@Body1"), or a body label ("Body1"). */
  old: string;
  /** The face or body name it had (the match key). */
  name: string | null;
  /** The display label it had, when the sidecar gave one. */
  label: string | null;
  reason: 'gone' | 'claimed_twice' | 'held_elsewhere' | 'stale';
}

/** A face that boundary conditions of one study claimed after their faces merged: nobody keeps it until the user picks. */
export interface ClaimedTwice {
  studyId: string;
  studyTitle: string;
  /** The new host face label, e.g. "face 7@Body1". */
  target: string;
  name: string | null;
  label: string | null;
  /** The boundary conditions that claimed it. */
  items: string[];
}

export interface LinkOptions {
  /** Required: one compound of solids, in mm. */
  shape: LinkShape;
  /** The face-name sidecar (magnusim_sdk.link.write_face_names writes it). */
  faceNames?: LinkFile;
  /**
   * Host 1.7, for the first link of a study that edits a project geometry (context.geometry
   * with `linked` false): a face-name sidecar of the ORIGINAL geometry, one row per face of
   * ws.project.geometryFaces() in its order, its `shape_sha256` that call's `sourceSha256`,
   * and each named row with the fingerprint of the face it names (`centroid`, `area`,
   * `normal`: that face's in geometryFaces(), mm). The host puts these names on the
   * original's faces, so the boundary conditions follow each face to the face of the new
   * shape with the same name (then by shape). A row whose fingerprint is not its host face's
   * loses its name (counted in LinkResult.unverified); more than 20 % of such rows, or a
   * file that does not describe the original, is refused with `bad_face_names`, at the call.
   * A face with no name follows by shape only. Ignored by every later link.
   */
  originalNames?: LinkFile;
  /** The plugin's own version of the SAVED design: a whole number that never goes down. */
  sourceVersion: number;
  /** The geometry rev this page last read (linkedGeometry().rev); null before the first link. */
  basedOnRev: number | null;
  /** The geometry's name; the default is the study's title. */
  name?: string;
  /**
   * The camera the project's viewport lands with when the workspace closes (host 1.6). It
   * stays in the app's page and is never sent to the server; the exit hook's own `view`
   * (nav.onLeave) replaces it when it comes later. After "Continue in background" the
   * page closes before its hook returns: only this view lands. A bad view is dropped.
   */
  view?: ViewState;
  /** Called as the update moves through its stages (queued with the jobs ahead of it). */
  onProgress?: (p: { stage: LinkStage; fraction: number | null; label?: string; ahead?: number }) => void;
}

export interface LinkResult {
  geometryId: string;
  name: string;
  rev: number;
  fromRev: number | null;
  /** This call made the geometry: a first link, or the user chose "Save as new geometry" (a new geometryId). */
  created: boolean;
  /**
   * none: nothing but sourceVersion recorded; names: names or colours only, the rev
   * kept; faces: the same shape but lost faces came back by name (rev + 1); shape: rev + 1.
   */
  change: 'none' | 'names' | 'faces' | 'shape';
  bodies: number;
  faces: number;
  /** Faces that carry a name from the sidecar. */
  named: number;
  match: { byName: number; byShape: number; split: number; merged: number; movedFar: number };
  /** Assignments this update could not place. */
  lost: LostFace[];
  /** Lost assignments that came back with this update. */
  returned: LostFace[];
  /** Open lost entries on this geometry's records after this update. */
  stillLost: number;
  claimedTwice: ClaimedTwice[];
  outOfDate: { meshes: { studyId: string; studyTitle: string; meshId: string; meshName: string }[]; runs: number };
  seconds: number;
  /** Host 1.7: true on the update that took over the project geometry this study edits (its first link). */
  adopted?: boolean;
  /**
   * Host 1.7, with `adopted`: how many `originalNames` rows did not match their face (their
   * fingerprint is not the host face's). Their names were dropped, so those faces followed by
   * shape only; a face that also moved is then lost (`lost`).
   */
  unverified?: number;
}

/** The project geometry this study links, as the host has it. */
export interface LinkedGeometry {
  geometryId: string;
  name: string;
  rev: number;
  sourceVersion: number;
  shapeSha256: string;
  namesSha256: string | null;
  syncedAt: string;
  state: 'ok' | 'queued' | 'updating' | 'failed';
  error: string | null;
  lostFaces: number;
  /** Host 1.7: the geometry was a plain import before this study's first link took it over. */
  adopted?: boolean;
  /** Host 1.7: the file it was imported from, kept since (null when it was never a plain import). */
  original?: { fileName: string | null; format: string; sha256: string } | null;
}

/**
 * A camera (host 1.6), the same for every plugin: model mm in the frame of the exported
 * shape (the BREP has no transform), Z up as the app's viewport. `fovDeg` is the vertical
 * angle of a perspective view (as three.js PerspectiveCamera.fov); `height` is the full
 * visible height in mm of an orthographic one. The app's window has another width, so the
 * sides crop differently; the vertical extent matches.
 */
export interface ViewState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  projection: 'perspective' | 'orthographic';
  fovDeg?: number;
  height?: number;
}

/**
 * Why the user leaves the workspace (host 1.6): the header's Back (`back`), the page's own
 * nav.back() (`frame-back`), the browser's Back or Forward or a typed link (`history`),
 * another project (`project`), Home (`home`), or results.openIn3D (`results`).
 */
export type LeaveReason = 'back' | 'frame-back' | 'history' | 'project' | 'home' | 'results';

/** What an exit hook gets (host 1.6). */
export interface LeaveEvent {
  reason: LeaveReason;
  /** Aborted when the user cancels or stays, or the hook stalls (30 s with no progress and no call). */
  signal: AbortSignal;
  /** Say how far it is (0 to 1, or null) and what it does: shown in the workspace header. */
  progress(fraction: number | null, label?: string): void;
}

/**
 * An exit hook (host 1.6): save the design, then link it (ws.project.linkGeometry), then
 * return. The camera it returns is the one the project's viewport lands with (not after
 * "Continue in background": the page closes before the hook returns, so pass the camera
 * on linkGeometry's `view`).
 */
export type LeaveHandler = (leave: LeaveEvent) => Promise<{ view?: ViewState } | void> | { view?: ViewState } | void;

/**
 * How much a tool of the app's assistant may change (unreleased, next host minor 1.9).
 * `read` changes nothing; `edit` changes this page's own state; `compute` starts work that
 * takes time or the app's compute slot; `destructive` can't be undone. The app asks the user
 * before every `compute` and `destructive` call. An unknown risk counts as `destructive`.
 */
export type AssistantRisk = 'read' | 'edit' | 'compute' | 'destructive';

/**
 * A tool's input, in the subset of JSON Schema the app accepts (unreleased, 1.9): every object
 * lists its `properties` and says `additionalProperties: false`. No `$ref`, `oneOf`, `anyOf`,
 * `allOf`, `pattern`, `format` or `default`.
 */
export type AssistantSchema =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number; enum?: number[] }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: AssistantSchema; minItems?: number; maxItems?: number }
  | AssistantObjectSchema;

/** An object in a tool's input schema (unreleased, 1.9): the tool's whole input is one. */
export interface AssistantObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, AssistantSchema>;
  required?: string[];
  additionalProperties: false;
}

/**
 * A tool the app's assistant may call while this workspace is open (unreleased, 1.9). The app
 * checks every constraint before your handler runs; the model may see the numeric and length
 * limits only as words in the description.
 */
export interface AssistantTool {
  /** 1 to 32 of a-z, 0-9 and "_", starting with a letter, never "__". Unique in this page. */
  name: string;
  /** A short name for the user (the app's question names the tool by it). */
  title?: string;
  /** What it does, for the model: plain text, at most 1024 characters. */
  description: string;
  inputSchema: AssistantObjectSchema;
  risk: AssistantRisk;
  /** Seconds with no progress before the call counts as stalled (1–600, default 60). Progress resets it; there is no total limit. */
  timeoutS?: number;
  /**
   * For a `destructive` tool: what the app's question before each call says the call does, in
   * place of "can't be undone" (unreleased, 1.9). One sentence of fixed text, at most 120
   * characters, with no project data ("Deletes features from the Part; Ctrl+Z brings them back.").
   */
  confirm?: string;
  /**
   * Which of your tools a local model keeps when the tools don't all fit its context (unreleased,
   * 1.9): 0 to 100, higher stays, default 50. The app's own tools go first, then yours, the
   * lowest priority first (the later name among equals).
   */
  priority?: number;
}

/** One call of a tool, as the handler gets it (unreleased, 1.9). */
export interface AssistantCall {
  /** The call's id. */
  call: string;
  /**
   * The assistant's turn that made the call: calls of one turn share it (one undo step, for example).
   * A call from another app on this PC (MCP) has no turn: it reads "mcp:" and the app's connection id,
   * the same for every call on that connection. A connection may stay open as long as the app runs,
   * so end such a group after a pause or a change the user made, too.
   */
  turn: string;
  /** The tool's name, as registered. */
  tool: string;
  /** The input, already checked against the tool's inputSchema. */
  input: Record<string, unknown>;
  /**
   * The call's place in its step: one answer of the model, whose calls run one after another
   * (unreleased, 1.9). `step` numbers the answers of the turn from 1; `callsLeftInStep` is how many
   * calls of that answer come after this one; `editsLeftInStep` how many of those are this page's
   * `edit` or `destructive` tools (of the workspace the turn is bound to). A page that shows the
   * model a picture after its edits can take it once, when no edit follows. Absent for a call from
   * another app on this PC (MCP) or a coding agent, and on an older host.
   */
  step?: number;
  callsLeftInStep?: number;
  editsLeftInStep?: number;
  /** Aborted when the user stops the turn, the call stalls, or the workspace closes: stop then, and change nothing more. */
  signal: AbortSignal;
  /**
   * Say how far it is (0 to 1, or null) and what it does. Each call resets the stall window.
   * `{waiting: true}` says the call waits for the person (a panel of theirs open, their
   * answer): that time doesn't count toward the turn's minutes, until the next progress
   * without it or the call's end (20 minutes of one call's waits at most). Keep calling it
   * while you wait, every few seconds.
   */
  progress(fraction: number | null, label?: string, opts?: AssistantProgressOptions): void;
  /**
   * Read a file the person attached in the Assistant panel, in this turn's conversation, by the
   * attachment_id the model was given for it (unreleased, 1.9; absent on an older host, so check
   * that it exists). Only while this call runs: a read keeps the call alive like any call of the
   * page, and one still going when the call ends stops. Resolves a File with the attachment's name
   * and bytes, typed application/octet-stream whatever it holds (never image/svg+xml: an SVG may
   * carry a script, so read its text rather than showing the file). A drawing (SVG, DXF) is at
   * most 20 MiB, a geometry file at most 500 MiB. Rejects with `.code` "not_found" (the
   * conversation has no such file, or the call came from another app on this PC over MCP, which
   * has no attachments), "not_allowed" (the call ended, or a host without it), "bad_request" (an
   * id that is not att- and 16 hex digits) or "failed" (the read did not complete: try again).
   */
  readAttachment?(id: string): Promise<File>;
}

/** What else a call's progress says (unreleased, 1.9). */
export interface AssistantProgressOptions {
  /** The call waits for the person (only while it does). */
  waiting?: boolean;
}

/** A picture in a tool's result (unreleased, 1.9): at most 4 per result, each at most 1.5 MB and 2000 px a side (more fails the call with code "too_large"). */
export interface AssistantImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Blob;
}

/**
 * What a handler returns (unreleased, 1.9): text, or `{text?, data?, images?, summary?}` (`text`
 * at most 64 KB, `data` plain JSON of at most 256 KB), or nothing. A larger result fails the call
 * with code "too_large". Everything in it but `summary` reaches the model as data, never as
 * instructions. `summary` is one line for the turn's log that names what the call did ("Added 2:
 * the counter is 2"), at most 160 characters: the person reads it, the model never gets it.
 * Without one the log says "Done".
 */
export type AssistantResult = string | { text?: string; data?: unknown; images?: AssistantImage[]; summary?: string } | void;

/**
 * Runs a tool call (unreleased, 1.9). A throw fails the call: an error's `.code` is kept when it
 * is "invalid_input", "busy" or "not_ready", and reads "failed" otherwise. Its `.message` says
 * what went wrong, its `.hint` how to fix it (one sentence, at most 500 characters), and its
 * `.detail` holds plain JSON for the model to act on (what the hint refers to: the field, the
 * candidates, the allowed range), at most 4 KB as JSON: a larger one is dropped, and the message
 * says so. All three reach the model with the code.
 */
export type AssistantHandler = (call: AssistantCall) => AssistantResult | Promise<AssistantResult>;

/**
 * Review rounds a page asks for when it registers its tools (unreleased, 1.9): when the model ends
 * its answer in a turn bound to this tab after at least one of this page's `edit` or `destructive`
 * tools succeeded, the app sends it `prompt` ("Review round 1 of 3: <prompt>") and the turn goes on.
 * The turn ends when a round makes no successful edit, when `rounds` are used up, or at the turn's
 * usual limits. `rounds`: 1 to 5. `prompt`: fixed text with no project data, at most 1500
 * characters (its lines kept), like the guide.
 */
export interface AssistantReview {
  rounds: number;
  prompt: string;
}

/** The app's answer to ws.assistant.register (unreleased, 1.9). */
export interface AssistantRegistration {
  /** False when the app's assistant could not take the tools now (`reason` says why); nothing changed then. */
  available: boolean;
  /** The names of the tools the assistant may call. */
  accepted: string[];
  /** The tools it refused, each with why. */
  refused: Array<{ name: string; code: string; message: string }>;
  /** Why not available: "not_connected" (try again later), "no_assistant", "remote", … */
  reason?: string;
}

/**
 * A turn of the app's assistant bound to this page's tab (unreleased, 1.9): what the person asked,
 * as the page hears it with ws.assistant.onTurn. `running` as it starts and again after each change
 * (at most once a second); `ended` once, at its end.
 */
export interface AssistantTurn {
  /** The turn's id: AssistantCall.turn of each of its calls. */
  id: string;
  state: 'running' | 'ended';
  /** The first line of the person's request, as plain text, at most 60 characters ("Assistant: <title>" names an undo step well). */
  title: string;
  /**
   * The conversation it runs in (unreleased, 1.9): the same for each turn of one conversation,
   * so a page can keep what it tells the model per conversation. Absent on an older host.
   */
  conversation?: string | null;
  /** It runs on a local server (a smaller model, often with less room: keep results short). */
  local: boolean;
  /** The model's context in tokens, when the app knows it (null otherwise). */
  contextTokens: number | null;
  /** Whether the model reads images, when the app knows it (null otherwise, as for a coding agent's). */
  images: boolean | null;
  /**
   * What it used so far and its limits, as they are in force now: tool calls (`steps`) and dollars
   * (`usd`; 0 on a local server). A turn on a coding agent counts its tool calls against its own
   * cap, and no dollars: `usd` and `usdCap` are 0 (the agent bills the person's own account). It
   * also counts its changes (its calls of tools that are not reads) against its change limit:
   * past `changesCap`, its changes are refused while its reads go on. `changesCap` is 0 for any
   * other turn (no such limit). `usdLeft`, when dollars are counted, is what is left for its next
   * request: the smaller of what its own limit and the person's daily limit leave (other requests
   * spend from the day too), so it can be less than `usdCap - usd`. Absent on a local server, for
   * a coding agent and on an older host.
   */
  used: { steps: number; stepsCap: number; changes: number; changesCap: number; usd: number; usdCap: number; usdLeft?: number };
  /** How it ended (with `ended`); absent when this page did not hear it end (its tab's link was down then). */
  end?: { state: 'done' | 'stopped' | 'failed' | 'capped'; reason: string };
  /** The review round it is in (the page's `review` at registration): absent before its first round. */
  review?: { round: number; of: number };
}

/**
 * ws.assistant.stop's answer (unreleased, 1.9). `reason` when not stopped: "not_this_tab" (no turn of
 * that id was told to this page), "ended" (it already ended), "not_connected", "no_assistant",
 * "not_allowed" (a host without the call), or the app's code ("unknown_turn").
 */
export interface AssistantStopAnswer {
  stopped: boolean;
  reason?: string;
}

/**
 * ws.assistant.setUndo's answer (unreleased, 1.9): whether the app now offers the person to undo
 * that turn's changes. `reason` when not: "not_this_tab" (no turn of that id was told to this page),
 * "no_assistant", "not_allowed" (a host without the call); a withdrawal answers offered false with
 * no reason.
 */
export interface AssistantUndoOffer {
  offered: boolean;
  reason?: string;
}

/**
 * What an onUndo handler answers (unreleased, 1.9): `undone` once the turn's changes went back as one
 * step, else why not: "not_newest" (something changed after them), "busy" (try again in a moment),
 * or the page's own word. The SDK answers "no_answer" for a handler that takes over 10 s, "failed"
 * for one that throws, and "no_handler" with none.
 */
export interface AssistantUndoAnswer {
  undone: boolean;
  reason?: string;
}

/** Tools this page offers to the app's assistant (unreleased, next host minor 1.9). */
export interface WorkspaceAssistant {
  /**
   * Set this page's tools and their handler in one step; register([], null) withdraws them.
   * `guide`: fixed notes for the model about this workspace (no project data; it is kept for a whole conversation).
   * `review`: review rounds at the end of a turn that edited through these tools (AssistantReview).
   * Resolves once the app has the list. available:false with reason 'not_connected' means the app could not
   * reach the assistant from this tab yet (for example the tab opened in the background): call register again
   * later, e.g. on visibilitychange. With available:false nothing changed: the earlier tools and handler stay.
   * Calls of a tool the app did not accept answer "no_tool". The tools go when the page closes or reloads.
   */
  register(tools: AssistantTool[], handler: AssistantHandler | null, opts?: { guide?: string; review?: AssistantReview }): Promise<AssistantRegistration>;
  /**
   * Hear the assistant's turns bound to this tab: each start, change and end (AssistantTurn). Listen
   * before register: the turns already running are told to a page once it offers tools. Returns a
   * function that stops listening.
   */
  onTurn(fn: (turn: AssistantTurn) => void): () => void;
  /**
   * Stop a turn this page was told of (onTurn), as the person's Stop: its running call is aborted
   * and it ends `stopped`. Resolves once it ended (or, after 5 s, while it is stopping).
   */
  stop(turn: string): Promise<AssistantStopAnswer>;
  /**
   * The app shows its own Assistant panel (its dock), with Stop and "Undo these changes" for each
   * turn: a page that has its own Stop and Undo for a turn leaves them out then, so no control shows
   * twice. False on an older host, and on a host without the panel. Read once, as the page connects.
   * While docked, the panel's key typed in the page (Ctrl+/, Cmd+/ on macOS, or the keys the person
   * chose: context.assistantKeys) goes to the app's panel, as it does in the app, unless a keydown
   * handler of the page calls preventDefault() for it.
   */
  readonly docked: boolean;
  /**
   * Say that a turn's changes can be undone now as one step (`label`, "Assistant: <title>", names
   * it), or no longer (null), so the app's panel offers "Undo these changes" for it. Only a turn told
   * to this page (onTurn) can be offered. Call it again whenever that changes: after the turn ended,
   * and with null once something else changed on top of its changes. The offers go when the page
   * closes or reloads.
   */
  setUndo(turn: string, label: string | null): Promise<AssistantUndoOffer>;
  /**
   * The person asked the app's panel to undo a turn's changes that this page offered (setUndo): undo
   * them as one step and answer {undone: true}, or {undone: false, reason} ("not_newest" when
   * something changed after them). One handler per page; a newer one replaces it, null clears it.
   * Answer within 10 s ("no_answer" after that). Returns a function that clears this handler.
   */
  onUndo(fn: ((turn: string) => AssistantUndoAnswer | Promise<AssistantUndoAnswer>) | null): () => void;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The confirming button's label ("Delete", "Replace", ...). */
  confirmLabel?: string;
  /** Unreleased (1.9): the confirming button answers only a deliberate click, made once it is enabled; a key press never does. */
  guard?: boolean;
  /** Unreleased (1.9): Cancel has the focus, and Enter, like Escape, answers Cancel. */
  safe?: boolean;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  confirmLabel?: string;
}

/** A file in this plugin's folder of the project. */
export interface FileInfo {
  /** Its path from the plugin's folder ("meshes/wing.stl"), spelled as on disk. */
  rel: string;
  size: number;
  /** When it last changed (ISO-8601, UTC). */
  mtime: string;
  /** Changes whenever the file does; pass it as `ifMatch` to act only on the version you read. */
  etag: string;
}

export interface FileWriteResult extends FileInfo {
  /** The SHA-256 of what was written (hex). */
  sha256: string;
}

export interface FileReadOptions {
  /** The first byte to read (default 0). */
  offset?: number;
  /** How many bytes to read (default: to the end). */
  length?: number;
  /** Read only while the file has this etag (else rejects with code "changed"). */
  ifMatch?: string;
}

export interface FileWriteOptions {
  /** A string: replace only the version with this etag. null: only create a file that is not there yet. */
  ifMatch?: string | null;
  /** The data's SHA-256 (hex): the host checks it before the file is replaced. */
  sha256?: string;
  /** Called after each chunk has arrived, with the bytes sent so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /** Aborting it stops the write; the file is left as it was. */
  signal?: AbortSignal;
}

export interface Workspace {
  readonly context: WorkspaceContext;
  /**
   * Any bridge call by name; the typed helpers below use it. Rejects with the
   * host's message. `transfer` hands buffers over instead of copying them.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
  /** Call a method of this plugin's backend (its service, or its in-process methods). */
  service<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  study: {
    get(): Promise<StudyRecord>;
    /** Save fields of this study; `rev` is the one you read (a stale one is refused). */
    update(patch: Record<string, unknown>, rev: number): Promise<StudyRecord>;
  };
  data: {
    /** A JSON file from this plugin's folder in the project (null when there is none). */
    read<T = unknown>(rel: string): Promise<T | null>;
    write(rel: string, doc: unknown): Promise<void>;
  };
  /**
   * This plugin's own preferences for the user, the same in every project (host 1.7;
   * absent on an older host): small JSON values such as a toolbar layout or the last
   * options used. A name is 1 to 64 of a-z, 0-9, ".", "_" and "-". A plugin keeps at
   * most 64 KB in all; past that `set` rejects with `.code` "too_large".
   */
  prefs: {
    /** The value, or null when there is none. */
    get<T = unknown>(key: string): Promise<T | null>;
    /** Store a JSON value (null removes it). */
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    /** A change made in another tab or window (value null when removed); not this page's own. */
    onChange(fn: (key: string, value: unknown) => void): () => void;
  };
  /**
   * Files of any kind in the same folder (`data` is its JSON view). Paths are
   * relative to it; a study's study.json is read-only here, and files go inside
   * a study's folder (studies/<id>/...), never directly in studies/. Rejections
   * carry `.code`: "changed", "too_large", "quota", "study_record",
   * "study_not_found", "invalid_path", "not_found", "plugin_off", ...
   */
  files: {
    /** The file's bytes, or a range of them (null when there is no such file). */
    read(rel: string, opts?: FileReadOptions): Promise<ArrayBuffer | null>;
    /** As read, as a Blob. */
    readBlob(rel: string, opts?: FileReadOptions): Promise<Blob | null>;
    stat(rel: string): Promise<FileInfo | null>;
    /**
     * Write a whole file: sent in chunks, and it replaces the old one only once
     * every byte has arrived. A string is written as UTF-8. While the write is
     * on its way, leaving the workspace asks the user first.
     */
    write(rel: string, data: ArrayBuffer | ArrayBufferView | Blob | string, opts?: FileWriteOptions): Promise<FileWriteResult>;
    /** Every file under a folder ("": the plugin's folder), at any depth, sorted by rel. */
    list(prefix?: string): Promise<FileInfo[]>;
    /** Delete a file, or a folder with `recursive`; says how many files went. */
    delete(rel: string, opts?: { recursive?: boolean }): Promise<{ deleted: number }>;
  };
  jobs: {
    /** Start one of this plugin's job kinds; returns its id. */
    start(kind: string, params?: Record<string, unknown>): Promise<{ id: string }>;
    /** Follow a job this workspace started; returns a function that stops listening. */
    events(jobId: string, onEvent: (ev: JobEvent) => void): () => void;
    stop(jobId: string): Promise<void>;
  };
  project: {
    info(): Promise<{ id: string; title: string; units: UnitSystem }>;
    /**
     * Link this study's saved design into the project as a geometry (host 1.5, a study
     * kind with `links_geometry`). Write the files first (ws.files.write gives their
     * sha256); the host copies them at the call, so the page may write again at once.
     * The first call creates the geometry; a later one with equal bytes changes nothing
     * (`none`), one that changes only names updates it in place, and one that changes
     * the shape updates it as a queued job (it may wait for a running mesh or solve).
     * Resolves when the update is committed. Refusals carry `.code`: "unsaved" (the page
     * is dirty: save first), "stale" (an older design, or another tab's), "changed",
     * "bad_brep", "empty", "bad_face_names", "unsupported_format", "plugin_needed",
     * "busy", "gone", "cancelled" (the user removed it from the Queue: stay as you are,
     * show no error), "superseded", "not_allowed", …
     */
    linkGeometry(o: LinkOptions): Promise<LinkResult>;
    /** The geometry this study links now; null before the first link, or after the user removed it. */
    linkedGeometry(): Promise<LinkedGeometry | null>;
    /**
     * The file of the geometry this study edits (host 1.7; context.geometry): a STEP file,
     * the import itself or the host's own STEP of an IGES import. Once an edit went back to
     * the project (`adopted`), the original the host kept. Refusals carry `.code`:
     * "not_allowed" (this study edits no geometry), "gone" (it was removed), "adopted"
     * (another study took it over), "no_source" (the geometry has no such file, e.g. one a
     * link made, or its STEP is missing), "not_ready" (it is updating: try again after
     * `.retryAfter` seconds).
     */
    geometrySource(o?: GeometrySourceOptions): Promise<GeometrySource>;
    /**
     * The faces of the geometry this study edits (host 1.7), in the host's order, with the
     * study setup that uses each one. Before the first edit went back, the faces of the
     * original. Refusals as geometrySource; "not_ready" also when the app has not read the
     * geometry's faces yet (it reads them when the geometry is shown).
     */
    geometryFaces(): Promise<GeometryFaces>;
  };
  ui: {
    toast(message: string, opts?: { kind?: 'info' | 'success' | 'error' }): Promise<void>;
    /**
     * The app's own question dialog. The app shows one dialog at a time, so this
     * one may wait its turn. Resolves false without showing it when the user has
     * chosen to leave the workspace by then.
     */
    confirm(opts: ConfirmOptions): Promise<boolean>;
    /** The app's own name prompt, in turn as confirm: null when cancelled or not shown. */
    prompt(opts: PromptOptions): Promise<string | null>;
  };
  nav: {
    /**
     * Close the workspace and go back to the project. While the page is dirty
     * the app asks the user first, and this resolves false if they choose to
     * stay. When the workspace does close, this page unloads, so the promise
     * may never settle.
     */
    back(): Promise<boolean>;
    /**
     * Mark or clear unsaved work (host 1.2). While dirty, every way out of the
     * workspace asks the user first; closing or reloading the browser tab shows
     * the browser's own prompt. `message` is plain text, at most 200 characters
     * after cleaning, shown in the app's dialog after the plugin's name (never
     * in the browser's prompt). The flag belongs to this page load: a reload of
     * the frame, a closed channel or an approved leave clears it, so do not
     * reload your own page while dirty. Clear it after saving, and before
     * nav.back() to leave without a question.
     */
    setDirty(dirty: boolean, message?: string): Promise<void>;
    /**
     * The exit hook (host 1.6; an older host rejects with code "not_allowed"): the app runs
     * it on every way out it owns (Back, nav.back(), browser Back and links, another project,
     * Home, results.openIn3D), before it asks about unsaved work. The handler saves, calls
     * setDirty(false), links (ws.project.linkGeometry), and returns; a page's own "Done"
     * just calls nav.back(). Its linkGeometry call may meet the app's question ("Save as
     * new", "Overwrite", "Keep editing"): it stays pending meanwhile, and "Keep editing"
     * rejects it with `cancelled`, ends the leave and keeps the workspace open (return at
     * once then). A throw, `signal` aborting, or 30 s with no progress and no call ends in
     * one question to the user ("Couldn't update the project"). One handler per page load;
     * null clears it. Turning the plugin off, closing or reloading the tab, and a crashed
     * page run no hook: the geometry keeps its last update.
     */
    onLeave(handler: LeaveHandler | null): Promise<void>;
  };
  /**
   * OpenFOAM cases this study's page writes and runs (host 1.3: check
   * `context.hostVersion`; an older host refuses with code "not_allowed").
   * A case runs once, from its `0/` folder, on the app's one compute slot, so
   * it may wait in the queue. Refusals carry `.code` ("app_not_allowed",
   * "has_results", "invalid_path", "busy", …).
   */
  compute: {
    /** Queue a case; `existing` when that folder is already queued or running (its id comes back). */
    submitOpenFOAM(opts: SubmitOpenFOAM): Promise<{ id: string; ahead: number; existing: boolean }>;
    /**
     * Follow a case of this study: first where it is now (queued, start, or end),
     * then each event (stage, pre, ranks, phase, progress, time_saved, warning, end).
     * Returns a function that stops listening.
     */
    events(jobId: string, onEvent: (ev: JobEvent) => void): () => void;
    /** Stop a case: a queued one leaves the queue; a running one saves its latest frame and ends. Again to stop harder; `force` at once. */
    stop(jobId: string, opts?: { force?: boolean }): Promise<{ status: string; stopping: boolean }>;
    status(jobId: string): Promise<ComputeJob>;
    /** This study's cases, newest first (a reopened page finds its running case here). */
    list(): Promise<ComputeJob[]>;
  };
  results: {
    /**
     * Show a finished case's saved frames in the project's 3D view. The app asks
     * first when other results are on screen, and when the page has unsaved work.
     * Resolves { opened: false } when the user cancels or stays; when it opens,
     * the workspace closes, so the promise may never settle.
     */
    openIn3D(caseRel: string): Promise<{ opened: boolean }>;
  };
  /**
   * Tools this page offers to the app's assistant (unreleased, next host minor 1.9; absent on an
   * older host, so check that it exists, and catch "not_allowed" from a host without it).
   */
  readonly assistant?: WorkspaceAssistant;
  /**
   * Live changes the host pushes. Returns a function that stops listening.
   * `study`: the study changed (renamed in the header, or saved): save next with its `rev`.
   */
  on(event: 'units', fn: (units: UnitSystem) => void): () => void;
  on(event: 'theme', fn: (theme: ThemeInfo) => void): () => void;
  on(event: 'study', fn: (study: StudyRecord) => void): () => void;
  /** `prefs` (host 1.7): a pref of this plugin changed in another tab (ws.prefs.onChange is the same). */
  on(event: 'prefs', fn: (change: { key: string; value: unknown }) => void): () => void;
  /**
   * `geometry` (host 1.5): the geometry this study links was updated (by this page or
   * another tab of the same study). Only the page of the study that owns it hears it.
   */
  on(event: 'geometry', fn: (g: { geometryId: string; rev: number; fromRev: number | null }) => void): () => void;
  /**
   * `assistantKeys` (unreleased, 1.9): the person changed the keys of the app's Assistant panel
   * (context.assistantKeys holds them now): null for its default, Ctrl+/.
   */
  on(event: 'assistantKeys', fn: (keys: string[] | null) => void): () => void;
  /**
   * `appearance` (unreleased, 1.9): the person changed the app's look, or the system turned light
   * or dark under a 'system' choice. context.appearance and this page's <html> have it already
   * when a listener hears it; each listener gets its own copy.
   */
  on(event: 'appearance', fn: (appearance: Appearance) => void): () => void;
  /**
   * Start an ES-module worker. A sandboxed frame cannot start a worker from a
   * URL or a module worker from a blob; this starts a classic blob worker that
   * imports your module. Messages posted before your module has loaded are held
   * and handed to it, in order, once it has.
   */
  spawnWorker(url: string | URL): Worker;
}

interface HostReply {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: string; retryAfter?: number };
  event?: string;
  data?: unknown;
  jobId?: string;
}

const HELLO = 'hello';
/** A commit refused as "busy" (another program has the file open) is tried again this often, this far apart. */
const COMMIT_RETRIES = 3;
const COMMIT_RETRY_MS = 1000;

/** Settles as `p` does, or rejects with `stopped()` as soon as the signal aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, stopped: () => unknown): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function newInstance(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The codes a tool's error keeps (unreleased, 1.9); any other reads "failed". */
const ASSISTANT_PAGE_CODES = new Set(['invalid_input', 'busy', 'not_ready', 'failed']);
/** The most of a tool error's hint the SDK sends (the host caps it again). */
const ASSISTANT_HINT_MAX = 500;
/** How long an onUndo handler has to answer before the app hears "no_answer" (unreleased, 1.9). */
const ASSISTANT_UNDO_MS = 10_000;

/** A handler's result as the host takes it: text alone becomes `{text}`, nothing `{}`; only text, data, images and summary go. */
function assistantResultOf(out: unknown): unknown {
  if (out === undefined || out === null) return {};
  if (typeof out === 'string') return { text: out };
  if (typeof out !== 'object' || Array.isArray(out)) return out;
  const r = out as { text?: unknown; data?: unknown; images?: unknown; summary?: unknown };
  const result: Record<string, unknown> = {};
  if (r.text !== undefined) result.text = r.text;
  if (r.data !== undefined) result.data = r.data;
  if (r.images !== undefined) result.images = r.images;
  if (r.summary !== undefined) result.summary = r.summary;
  return result;
}

/** `v` as JSON makes it (a copy the host can always take), or undefined when it has no JSON form. */
function jsonCopy(v: unknown): unknown {
  try {
    const text = JSON.stringify(v);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    // A cycle, a BigInt, a getter that throws: no detail.
    return undefined;
  }
}

/** The key that types a punctuation character on a US layout (src/keybinds/combo.ts keyCode). */
const TYPED_CODE: Readonly<Record<string, string>> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ' ': 'Space',
};

/** The Assistant panel's keys as the host sent them: a list of combos, or null for its default. */
function assistantKeysOf(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : null;
}

const PREFERENCES: readonly string[] = ['light', 'dark', 'system'];

/**
 * The app's look as the host sent it (unreleased, 1.9), or null when it sent none: any theme but
 * "dark" is light, a choice it does not know is the theme, a size outside 0.5 to 3 is 1.
 */
function appearanceOf(v: unknown): Appearance | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const theme = o.theme === 'dark' ? 'dark' : 'light';
  const scale = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0.5 && x <= 3 ? x : 1);
  return {
    theme,
    preference: PREFERENCES.includes(o.preference as string) ? (o.preference as Appearance['preference']) : theme,
    textScale: scale(o.textScale),
    iconScale: scale(o.iconScale),
  };
}

/** The look on this page's <html>, as the app's own page has it (theme.css follows; never an inline color-scheme). */
function showAppearance(a: Appearance): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.dataset.theme = a.theme;
  html.dataset.themePref = a.preference;
  html.style.setProperty('--mg-text-scale', String(a.textScale));
  html.style.setProperty('--mg-icon-scale', String(a.iconScale));
}

/**
 * Whether a press is the app's Assistant panel key. The person's keys are read as the app reads a
 * press (src/keybinds/commands.ts comboOf, combo.ts typedCombo): Cmd counts as Ctrl, a Latin letter
 * by the letter it types, the number pad's digits and Enter as Digit and Enter, any other key by its
 * place, and punctuation by the character it types too. The default: Ctrl or Cmd (or both), no Alt
 * or Shift, on the key that types "/" (another layout's Slash key may be its minus: Ctrl+- zooms).
 */
function isAssistantKey(e: KeyboardEvent, keys: readonly string[] | null): boolean {
  if (!keys) return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '/';
  if (!keys.length) return false;
  const held = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean).join('+');
  const named = (code: string) => (held ? `${held}+${code}` : code);
  const ch = e.key.length === 1 ? e.key : '';
  const letter = /[a-z]/i.test(ch);
  const pad = /^Numpad(\d)$/.exec(e.code);
  const placed = letter ? `Key${ch.toUpperCase()}` : pad ? `Digit${pad[1]}` : e.code === 'NumpadEnter' ? 'Enter' : e.code;
  if (keys.includes(named(placed))) return true;
  const typed = !ch || letter ? '' : /\d/.test(ch) ? `Digit${ch}` : TYPED_CODE[ch] || '';
  return !!typed && keys.includes(named(typed));
}

/**
 * A handler's throw as the call's error: its message, its code only when the page may give it,
 * its hint (text, cut to 500 characters) and its detail (as JSON makes it).
 */
function assistantErrorOf(e: unknown): { code: string; message: string; hint?: string; detail?: unknown } {
  const fields = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; hint?: unknown; detail?: unknown };
  const code = fields.code;
  let message = '';
  try {
    // An Error's (or a DOMException's) message, else the thrown value as text.
    message = typeof fields.message === 'string' ? fields.message : e && typeof e === 'object' ? '' : String(e ?? '');
  } catch {
    // Not text at all: no message.
  }
  const out: { code: string; message: string; hint?: string; detail?: unknown } = {
    code: typeof code === 'string' && ASSISTANT_PAGE_CODES.has(code) ? code : 'failed',
    message: message || 'The tool failed.',
  };
  try {
    const hint = fields.hint;
    if (typeof hint === 'string' && hint) out.hint = hint.slice(0, ASSISTANT_HINT_MAX);
    const detail = fields.detail === undefined || fields.detail === null ? undefined : jsonCopy(fields.detail);
    if (detail !== undefined && detail !== null) out.detail = detail;
  } catch {
    // A getter that throws: the error goes without them.
  }
  return out;
}

/**
 * Say hello to the host and get the workspace's context and bridge.
 * Rejects when the page is not a Magnusim workspace or the host does not answer.
 */
export function connect(opts: { timeoutMs?: number } = {}): Promise<Workspace> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const instance = newInstance();
  return new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error('Not inside a Magnusim workspace'));
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onWelcome);
      reject(new Error('The Magnusim host did not answer'));
    }, timeoutMs);
    function onWelcome(event: MessageEvent) {
      const data = event.data as { magnusim?: string; instance?: string; context?: WorkspaceContext } | null;
      if (event.source !== window.parent || !data || data.magnusim !== 'welcome' || data.instance !== instance) return;
      const port = event.ports[0];
      if (!port || !data.context) return;
      clearTimeout(timer);
      window.removeEventListener('message', onWelcome);
      // The host asks after each frame load whether this document is still the one it talks to.
      window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { magnusim?: string; instance?: string } | null;
        if (e.source === window.parent && d && d.magnusim === 'probe' && d.instance === instance) {
          window.parent.postMessage({ magnusim: 'alive', instance }, '*');
        }
      });
      resolve(makeWorkspace(port, data.context));
    }
    window.addEventListener('message', onWelcome);
    window.parent.postMessage({ magnusim: HELLO, sdkVersion: SDK_VERSION, instance }, '*');
  });
}

function makeWorkspace(port: MessagePort, context: WorkspaceContext): Workspace {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const jobListeners = new Map<string, Set<(ev: JobEvent) => void>>();
  // linkGeometry calls in flight, by their token: the progress the host sends for each.
  const linkProgress = new Map<string, NonNullable<LinkOptions['onProgress']>>();
  // geometrySource reads in flight (host 1.7), by their token: the progress the host sends for each.
  const sourceProgress = new Map<string, NonNullable<GeometrySourceOptions['onProgress']>>();
  // The exit hook (host 1.6), and the leaves it is running, by the host's id for each.
  let leaveHandler: LeaveHandler | null = null;
  const leaves = new Map<string, AbortController>();
  // The tools this page offers the app's assistant (unreleased, 1.9): the handler and the names the
  // host accepted, committed together once it answers; the calls running, by the host's id for each.
  let assistantHandler: AssistantHandler | null = null;
  let assistantAccepted = new Set<string>();
  let assistantSerial = 0;
  const assistantCalls = new Map<string, AbortController>();
  // Who hears the assistant's turns bound to this tab (ws.assistant.onTurn).
  const turnListeners = new Set<(turn: AssistantTurn) => void>();
  // Who undoes a turn's changes when the app's panel asks (ws.assistant.onUndo), and the asks running.
  let undoHandler: ((turn: string) => AssistantUndoAnswer | Promise<AssistantUndoAnswer>) | null = null;
  const undoing = new Set<string>();
  // The turns whose undo handler still runs (past its 10 s answer too): a second ask answers busy.
  const undoRunning = new Set<string>();
  let followingGeometry = false;
  // The follow calls already sent ("<method> <id>"): one per job and kind of job.
  const followed = new Set<string>();
  const ctx: WorkspaceContext = { ...context };

  port.onmessage = (event: MessageEvent) => {
    const msg = (event.data || {}) as HostReply;
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const extra = typeof msg.error.retryAfter === 'number' ? { retryAfter: msg.error.retryAfter } : {};
        p.reject(Object.assign(new Error(msg.error.message || 'The host refused the call'), { code: msg.error.code }, extra));
      }
      else p.resolve(msg.result);
      return;
    }
    if (msg.event === 'job' && msg.jobId) {
      for (const fn of jobListeners.get(msg.jobId) || []) fn(msg.data as JobEvent);
      return;
    }
    if (msg.event === 'linkProgress') {
      const p = (msg.data || {}) as { token?: string; stage?: LinkStage; fraction?: number | null; label?: string; ahead?: number };
      const fn = p.token ? linkProgress.get(p.token) : undefined;
      if (fn && p.stage) {
        try {
          fn({ stage: p.stage, fraction: p.fraction ?? null, ...(p.label ? { label: p.label } : {}), ...(typeof p.ahead === 'number' ? { ahead: p.ahead } : {}) });
        } catch (e) {
          console.warn('[workspace] onProgress', e);
        }
      }
      return;
    }
    if (msg.event === 'sourceProgress') {
      const p = (msg.data || {}) as { token?: string; done?: number; total?: number };
      const fn = p.token ? sourceProgress.get(p.token) : undefined;
      if (fn && typeof p.done === 'number' && typeof p.total === 'number') {
        try {
          fn(p.done, p.total);
        } catch (e) {
          console.warn('[workspace] geometrySource onProgress', e);
        }
      }
      return;
    }
    if (msg.event === 'leave') {
      void runLeave(msg.data);
      return;
    }
    if (msg.event === 'leaveAbort') {
      const id = String(((msg.data || {}) as { leave?: unknown }).leave || '');
      leaves.get(id)?.abort(new DOMException('The leave was cancelled', 'AbortError'));
      return;
    }
    if (msg.event === 'assistantInvoke') {
      void runAssistantCall(msg.data);
      return;
    }
    if (msg.event === 'assistantAbort') {
      const id = String(((msg.data || {}) as { call?: unknown }).call || '');
      assistantCalls.get(id)?.abort(new DOMException('The call was stopped', 'AbortError'));
      return;
    }
    if (msg.event === 'assistantTurn') {
      // Each listener its own copy: one that changes it changes nothing for the others.
      for (const fn of [...turnListeners]) {
        const turn = jsonCopy(msg.data);
        if (!turn || typeof turn !== 'object') return;
        try {
          fn(turn as AssistantTurn);
        } catch (e) {
          console.warn('[workspace] assistant.onTurn', e);
        }
      }
      return;
    }
    if (msg.event === 'assistantUndo') {
      void runUndo(msg.data);
      return;
    }
    if (msg.event === 'appearance') {
      // The page has the look before its listeners hear it, each its own copy.
      const next = appearanceOf(msg.data);
      if (!next) return;
      ctx.appearance = next;
      showAppearance(next);
      for (const fn of [...(listeners.get('appearance') || [])]) {
        try {
          fn({ ...next });
        } catch (e) {
          console.warn('[workspace] appearance', e);
        }
      }
      return;
    }
    if (msg.event === 'units') ctx.units = msg.data as UnitSystem;
    if (msg.event === 'theme') ctx.theme = msg.data as ThemeInfo;
    if (msg.event === 'study') ctx.study = msg.data as StudyRecord;
    if (msg.event === 'assistantKeys') ctx.assistantKeys = assistantKeysOf(msg.data);
    for (const fn of listeners.get(String(msg.event)) || []) fn(msg.data);
  };
  // The app's look (unreleased, 1.9) on this page from the start, before a change the host sent
  // since; an older host sends none, and the page stays as it was served (light).
  const look = appearanceOf(ctx.appearance);
  if (look) {
    ctx.appearance = look;
    showAppearance(look);
  } else delete ctx.appearance;
  port.start();

  // The app's Assistant panel opens and closes with its key (Ctrl+/, Cmd+/ on macOS, or the
  // person's: context.assistantKeys); keys typed in this frame never reach the app's page, so they
  // go on as assistant.dock (unreleased, 1.9). Heard first (capture), sent once the event is
  // through, so a page that keeps the key for itself (preventDefault) keeps it. Only on a host
  // that has the panel.
  if (ctx.assistantDock === true && typeof window !== 'undefined') {
    ctx.assistantKeys = assistantKeysOf(ctx.assistantKeys);
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.isComposing || e.repeat || !isAssistantKey(e, ctx.assistantKeys ?? null)) return;
        setTimeout(() => {
          if (!e.defaultPrevented) void call('assistant.dock').catch(() => undefined);
        }, 0);
      },
      true,
    );
  }

  /** Ask the host; `sent` runs once the message left the page (never when it could not be copied). */
  function call<T = unknown>(method: string, params: Record<string, unknown> = {}, transfer?: Transferable[], sent?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        if (transfer && transfer.length) port.postMessage({ id, method, params }, transfer);
        else port.postMessage({ id, method, params });
      } catch (e) {
        // Not sent (a DataCloneError: something in it cannot be copied to the host): no answer comes.
        pending.delete(id);
        throw e;
      }
      sent?.();
    });
  }

  /**
   * The host runs the exit hook for one leave: the handler's progress goes back as
   * nav.leaveProgress, its end (and its camera) as nav.leaveDone. With no handler (cleared
   * meanwhile) the leave is done at once.
   */
  async function runLeave(data: unknown): Promise<void> {
    const d = (data || {}) as { leave?: unknown; reason?: unknown };
    const id = typeof d.leave === 'string' ? d.leave : '';
    if (!id || leaves.has(id)) return;
    const ctl = new AbortController();
    leaves.set(id, ctl);
    const handler = leaveHandler;
    let done: Record<string, unknown>;
    try {
      const out = handler
        ? await handler({
            reason: String(d.reason || 'back') as LeaveReason,
            signal: ctl.signal,
            progress: (fraction, label) => {
              if (ctl.signal.aborted) return;
              const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
              void call('nav.leaveProgress', { leave: id, fraction: f, ...(label ? { label: String(label) } : {}) }).catch(() => undefined);
            },
          })
        : undefined;
      const view = out && typeof out === 'object' ? (out as { view?: unknown }).view : undefined;
      done = { leave: id, ok: true, ...(view !== undefined ? { view } : {}) };
    } catch (e) {
      done = { leave: id, ok: false, message: e instanceof Error ? e.message : String(e ?? '') };
    } finally {
      leaves.delete(id);
    }
    void call('nav.leaveDone', done).catch(() => undefined);
  }

  /**
   * The app's assistant calls a tool of this page (unreleased, 1.9): the handler runs with the
   * call's input, a signal and progress (sent as assistant.progress); its end goes back as
   * assistant.result. A tool the host did not accept, or no handler, answers "no_tool" at once.
   */
  async function runAssistantCall(data: unknown): Promise<void> {
    const d = (data || {}) as { call?: unknown; turn?: unknown; tool?: unknown; input?: unknown; step?: unknown; calls_left_in_step?: unknown; edits_left_in_step?: unknown };
    const id = typeof d.call === 'string' ? d.call : '';
    if (!id || assistantCalls.has(id)) return;
    const tool = typeof d.tool === 'string' ? d.tool : '';
    const handler = assistantHandler;
    const send = (answer: Record<string, unknown>) => call('assistant.result', { call: id, ...answer });
    if (!handler || !assistantAccepted.has(tool)) {
      void send({ ok: false, error: { code: 'no_tool', message: `This page has no tool named ${JSON.stringify(tool)}.` } }).catch(() => undefined);
      return;
    }
    const ctl = new AbortController();
    assistantCalls.set(id, ctl);
    const input = d.input && typeof d.input === 'object' && !Array.isArray(d.input) ? (d.input as Record<string, unknown>) : {};
    const whole = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
    const [step, callsLeft, editsLeft] = [whole(d.step), whole(d.calls_left_in_step), whole(d.edits_left_in_step)];
    const place = step !== null && callsLeft !== null && editsLeft !== null ? { step, callsLeftInStep: callsLeft, editsLeftInStep: editsLeft } : {};
    let answer: Record<string, unknown>;
    try {
      const out = await handler({
        call: id,
        turn: typeof d.turn === 'string' ? d.turn : '',
        tool,
        input,
        ...place,
        signal: ctl.signal,
        progress: (fraction, label, opts) => {
          if (ctl.signal.aborted) return;
          const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
          const waiting = opts && typeof opts === 'object' && opts.waiting === true ? { waiting: true } : {};
          void call('assistant.progress', { call: id, fraction: f, ...(label ? { label: String(label) } : {}), ...waiting }).catch(() => undefined);
        },
        readAttachment: async (attachment) => {
          const r = await call<{ blob: Blob; fileName: string; size: number; sha256: string }>('assistant.attachment', { call: id, id: String(attachment) });
          // Its bytes, typed as nothing the page could render (an SVG may carry a script).
          return new File([r.blob], r.fileName || 'attachment', { type: 'application/octet-stream' });
        },
      });
      answer = { ok: true, result: assistantResultOf(out) };
    } catch (e) {
      answer = { ok: false, error: assistantErrorOf(e) };
    } finally {
      assistantCalls.delete(id);
    }
    try {
      await send(answer);
    } catch (e) {
      // The result could not be copied to the host (a function, a class instance it cannot clone):
      // the call fails instead of never ending.
      const err = (e && typeof e === 'object' ? e : {}) as { name?: unknown; message?: unknown };
      if (err.name !== 'DataCloneError') return;
      const why = typeof err.message === 'string' && err.message ? `: ${err.message}` : '';
      void send({ ok: false, error: { code: 'failed', message: `The result could not be sent to the app${why}` } }).catch(() => undefined);
    }
  }

  /**
   * The app's panel asks this page to undo a turn's changes (unreleased, 1.9): the onUndo handler's
   * answer goes back as assistant.undone {req, undone, reason?}; no handler answers no_handler, a
   * throw failed, and no answer within ASSISTANT_UNDO_MS no_answer.
   */
  async function runUndo(data: unknown): Promise<void> {
    const d = (data || {}) as { req?: unknown; turn?: unknown };
    const req = typeof d.req === 'string' ? d.req : '';
    const turn = typeof d.turn === 'string' ? d.turn : '';
    if (!req || !turn || undoing.has(req)) return;
    undoing.add(req);
    const handler = undoHandler;
    let answer: AssistantUndoAnswer;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!handler) answer = { undone: false, reason: 'no_handler' };
      else if (undoRunning.has(turn)) {
        // The page still undoes this turn (an ask that took over 10 s): never a second undo of it.
        answer = { undone: false, reason: 'busy' };
      } else {
        const late = new Promise<'late'>((done) => {
          timer = setTimeout(() => done('late'), ASSISTANT_UNDO_MS);
        });
        undoRunning.add(turn);
        const run = Promise.resolve().then(() => handler(turn));
        void run.then(
          () => undoRunning.delete(turn),
          () => undoRunning.delete(turn),
        );
        const out = await Promise.race([run, late]);
        if (out === 'late') answer = { undone: false, reason: 'no_answer' };
        else {
          const o = (out && typeof out === 'object' ? out : {}) as { undone?: unknown; reason?: unknown };
          answer = o.undone === true ? { undone: true } : { undone: false, reason: typeof o.reason === 'string' && o.reason ? o.reason.slice(0, 64) : 'failed' };
        }
      }
    } catch (e) {
      console.warn('[workspace] assistant.onUndo', e);
      answer = { undone: false, reason: 'failed' };
    } finally {
      clearTimeout(timer);
      undoing.delete(req);
    }
    void call('assistant.undone', { req, ...answer }).catch(() => undefined);
  }

  /** Listen to a job's events; the first listener asks the host to follow it (`method`). */
  function follow(method: string, jobId: string, onEvent: (ev: JobEvent) => void): () => void {
    let set = jobListeners.get(jobId);
    if (!set) {
      set = new Set();
      jobListeners.set(jobId, set);
    }
    set.add(onEvent);
    const key = `${method} ${jobId}`;
    if (!followed.has(key)) {
      followed.add(key);
      void call(method, { jobId }).catch((e: Error) => {
        const ev: JobEvent = { event: 'error', message: e.message };
        const code = (e as { code?: unknown }).code;
        if (typeof code === 'string' && code) ev.code = code;
        onEvent(ev);
      });
    }
    const listening = set;
    return () => {
      listening.delete(onEvent);
    };
  }

  async function readBlob(rel: string, opts: FileReadOptions = {}): Promise<Blob | null> {
    const r = await call<{ blob: Blob; size: number; etag: string } | null>('files.read', { ...opts, rel });
    return r ? r.blob : null;
  }

  async function writeFile(
    rel: string,
    data: ArrayBuffer | ArrayBufferView | Blob | string,
    opts: FileWriteOptions = {},
  ): Promise<FileWriteResult> {
    let size: number;
    let piece: (start: number, end: number) => [ArrayBuffer | Blob, Transferable[]?];
    if (data instanceof Blob) {
      const blob = data;
      size = blob.size;
      piece = (start, end) => [blob.slice(start, end)];
    } else {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
      if (!bytes) throw new TypeError('files.write takes an ArrayBuffer, a typed array, a Blob or a string');
      size = bytes.byteLength;
      // Each chunk is a copy that is handed over (not copied again), so the caller's buffer stays as it was.
      piece = (start, end) => {
        const copy = bytes.slice(start, end).buffer;
        return [copy, [copy]];
      };
    }
    const { signal, onProgress } = opts;
    const stopped = () => (signal && signal.reason !== undefined ? signal.reason : new DOMException('The write was aborted', 'AbortError'));
    if (signal?.aborted) throw stopped();
    const begin: Record<string, unknown> = { rel, size };
    if (opts.ifMatch !== undefined) begin.ifMatch = opts.ifMatch;
    const { upload, chunkBytes } = await call<{ upload: string; chunkBytes: number }>('files.write.begin', begin);
    try {
      for (let offset = 0; offset < size;) {
        if (signal?.aborted) throw stopped();
        const end = Math.min(size, offset + chunkBytes);
        const [chunk, transfer] = piece(offset, end);
        await untilAborted(call('files.write.chunk', { upload, offset, data: chunk }, transfer), signal, stopped);
        offset = end;
        onProgress?.(end, size);
      }
      const commit: Record<string, unknown> = { upload };
      if (opts.sha256 !== undefined) commit.sha256 = opts.sha256;
      for (let retries = 0; ; retries++) {
        if (signal?.aborted) throw stopped();
        try {
          // Not cut short by the signal: once sent, the commit may already have replaced the file.
          return await call<FileWriteResult>('files.write.commit', commit);
        } catch (err) {
          if (retries >= COMMIT_RETRIES || (err as { code?: unknown }).code !== 'busy') throw err;
        }
        await untilAborted(new Promise<void>((r) => setTimeout(r, COMMIT_RETRY_MS)), signal, stopped);
      }
    } catch (err) {
      void call('files.write.abort', { upload }).catch(() => undefined);
      throw err;
    }
  }

  const ws: Workspace = {
    get context() {
      return ctx;
    },
    call,
    service: (method, params = {}) => call('service.call', { method, params }),
    study: {
      get: () => call('study.get'),
      update: (patch, rev) => call('study.update', { patch, rev }),
    },
    data: {
      read: (rel) => call('data.read', { rel }),
      write: async (rel, doc) => {
        await call('data.write', { rel, doc });
      },
    },
    files: {
      read: async (rel, opts) => {
        const blob = await readBlob(rel, opts);
        return blob ? blob.arrayBuffer() : null;
      },
      readBlob,
      stat: (rel) => call('files.stat', { rel }),
      write: writeFile,
      list: (prefix = '') => call('files.list', { prefix }),
      delete: (rel, opts = {}) => call('files.delete', { rel, recursive: !!opts.recursive }),
    },
    prefs: {
      get: (key) => call('prefs.get', { key }),
      set: async (key, value) => {
        await call('prefs.set', { key, value: value ?? null });
      },
      remove: async (key) => {
        await call('prefs.remove', { key });
      },
      onChange: (fn) => ws.on('prefs', (c) => fn(c.key, c.value)),
    },
    jobs: {
      start: (kind, params = {}) => call('jobs.start', { kind, params }),
      events: (jobId, onEvent) => follow('jobs.events', jobId, onEvent),
      stop: async (jobId) => {
        await call('jobs.stop', { jobId });
      },
    },
    compute: {
      submitOpenFOAM: (opts) => call('compute.submitOpenFOAM', { ...opts }),
      events: (jobId, onEvent) => follow('compute.events', jobId, onEvent),
      stop: (jobId, opts = {}) => call('compute.stop', { jobId, force: opts.force === true }),
      status: (jobId) => call('compute.status', { jobId }),
      list: () => call('compute.list'),
    },
    results: {
      openIn3D: async (caseRel) => {
        const r = await call<{ opened?: boolean } | null>('results.openIn3D', { caseRel });
        return { opened: !!r && r.opened === true };
      },
    },
    project: {
      info: () => call('project.info'),
      linkGeometry: async (o) => {
        // The callback stays in the page; the host gets the call's fields (the camera stays
        // in the app's page: the server never gets it).
        const { onProgress, ...rest } = (o || {}) as LinkOptions;
        const token = newInstance();
        if (typeof onProgress === 'function') linkProgress.set(token, onProgress);
        try {
          return await call<LinkResult>('project.linkGeometry', { ...rest, token });
        } finally {
          linkProgress.delete(token);
        }
      },
      linkedGeometry: () => call('project.linkedGeometry'),
      geometrySource: async (o = {}) => {
        const { signal, onProgress } = o;
        const stopped = () => (signal && signal.reason !== undefined ? signal.reason : new DOMException('The read was aborted', 'AbortError'));
        if (signal?.aborted) throw stopped();
        const token = newInstance();
        if (typeof onProgress === 'function') sourceProgress.set(token, onProgress);
        // The host stops its own read too.
        const onAbort = () => void call('project.geometrySourceAbort', { token }).catch(() => undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const r = await untilAborted(
            call<{ geometryId: string; blob: Blob; fileName: string; format: 'step'; size: number; sha256: string; adopted: boolean }>(
              'project.geometrySource',
              { formats: ['step'], token },
            ),
            signal,
            stopped,
          );
          const file = new File([r.blob], r.fileName || 'source.step', { type: 'application/step' });
          return { geometryId: r.geometryId, file, format: 'step', size: r.size, sha256: r.sha256, adopted: r.adopted === true };
        } finally {
          sourceProgress.delete(token);
          signal?.removeEventListener('abort', onAbort);
        }
      },
      geometryFaces: () => call('project.geometryFaces'),
    },
    ui: {
      toast: async (message, opts = {}) => {
        await call('ui.toast', { message, kind: opts.kind || 'info' });
      },
      confirm: (opts) => call('ui.confirm', { ...opts }),
      prompt: (opts) => call('ui.prompt', { ...opts }),
    },
    nav: {
      // A 1.1 host answers { ok: true } without `left`: it always left.
      back: async () => (await call<{ left?: boolean } | null>('nav.back'))?.left !== false,
      setDirty: async (dirty, message) => {
        await call('nav.setDirty', { dirty: dirty === true, message: String(message ?? '') });
      },
      onLeave: async (handler) => {
        if (handler !== null && typeof handler !== 'function') throw new TypeError('nav.onLeave takes a function, or null to clear it');
        await call('nav.leaveHook', { on: !!handler });
        leaveHandler = handler;
      },
    },
    assistant: {
      register: async (tools, handler, opts = {}) => {
        if (!Array.isArray(tools)) throw new TypeError('assistant.register takes a list of tools ([] withdraws them)');
        if (handler !== null && typeof handler !== 'function') throw new TypeError('assistant.register takes a function, or null with no tools');
        if (tools.length > 0 && !handler) throw new TypeError('assistant.register needs a handler for its tools');
        // Only the fields the host reads go: a tool object may carry the page's own things.
        const wire = tools.map((t) => {
          const tool = (t || {}) as Partial<AssistantTool>;
          const out: Record<string, unknown> = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk };
          if (tool.title !== undefined) out.title = tool.title;
          if (tool.timeoutS !== undefined) out.timeoutS = tool.timeoutS;
          if (tool.confirm !== undefined) out.confirm = tool.confirm;
          if (tool.priority !== undefined) out.priority = tool.priority;
          return out;
        });
        const params: Record<string, unknown> = { tools: wire };
        if (opts && opts.guide !== undefined) params.guide = String(opts.guide);
        // Only its two fields go; the host checks them.
        if (opts && opts.review !== undefined && opts.review !== null) {
          const r = opts.review as Partial<AssistantReview>;
          params.review = { rounds: r.rounds, prompt: r.prompt };
        }
        // Only a list that reached the host is the last one: the host counts each register it got
        // (one it refused too), and one that could not be copied never got there.
        let serial = 0;
        // The host answers once the app has the list; the handler is kept only then (an older
        // host's "not_allowed" rejects, and nothing is kept).
        const answer =
          (await call<AssistantRegistration | null>('assistant.register', params, undefined, () => {
            serial = ++assistantSerial;
          })) || ({} as AssistantRegistration);
        const reg: AssistantRegistration = {
          available: answer.available === true,
          accepted: Array.isArray(answer.accepted) ? answer.accepted.filter((n): n is string => typeof n === 'string') : [],
          refused: Array.isArray(answer.refused) ? answer.refused : [],
          ...(typeof answer.reason === 'string' && answer.reason ? { reason: answer.reason } : {}),
        };
        // A later register call that went out meanwhile wins, whichever answer comes last.
        if (reg.available && serial === assistantSerial) {
          assistantHandler = tools.length ? handler : null;
          assistantAccepted = new Set(tools.length ? reg.accepted : []);
        }
        return reg;
      },
      onTurn: (fn) => {
        if (typeof fn !== 'function') throw new TypeError('assistant.onTurn takes a function');
        turnListeners.add(fn);
        return () => {
          turnListeners.delete(fn);
        };
      },
      stop: async (turn) => {
        if (typeof turn !== 'string' || !turn) throw new TypeError('assistant.stop takes the id of a turn this page was told of');
        let answer: { stopped?: unknown; reason?: unknown } | null;
        try {
          answer = await call<{ stopped?: unknown; reason?: unknown } | null>('assistant.stop', { turn });
        } catch (e) {
          // A host without the call: nothing was stopped.
          if ((e as { code?: unknown } | null)?.code === 'not_allowed') return { stopped: false, reason: 'not_allowed' };
          throw e;
        }
        if (answer?.stopped === true) return { stopped: true };
        return { stopped: false, reason: typeof answer?.reason === 'string' && answer.reason ? answer.reason : 'failed' };
      },
      docked: ctx.assistantDock === true,
      setUndo: async (turn, label) => {
        if (typeof turn !== 'string' || !turn) throw new TypeError('assistant.setUndo takes the id of a turn this page was told of');
        if (label !== null && typeof label !== 'string') throw new TypeError('assistant.setUndo takes a label, or null to withdraw the offer');
        let answer: { offered?: unknown; reason?: unknown } | null;
        try {
          answer = await call<{ offered?: unknown; reason?: unknown } | null>('assistant.undoable', { turn, label });
        } catch (e) {
          // A host without the call: nothing is offered.
          if ((e as { code?: unknown } | null)?.code === 'not_allowed') return { offered: false, reason: 'not_allowed' };
          throw e;
        }
        if (answer?.offered === true) return { offered: true };
        return typeof answer?.reason === 'string' && answer.reason ? { offered: false, reason: answer.reason } : { offered: false };
      },
      onUndo: (fn) => {
        if (fn !== null && typeof fn !== 'function') throw new TypeError('assistant.onUndo takes a function, or null to clear it');
        undoHandler = fn;
        return () => {
          if (undoHandler === fn) undoHandler = null;
        };
      },
    },
    on(event: string, fn: (data: never) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      if (event === 'geometry' && !followingGeometry) {
        // The host hears this study's geometry updates for this page from now on.
        followingGeometry = true;
        void call('project.followGeometry').catch(() => {
          followingGeometry = false;
        });
      }
      const f = fn as (data: unknown) => void;
      set.add(f);
      return () => set?.delete(f);
    },
    spawnWorker(url: string | URL): Worker {
      const href = new URL(String(url), location.href).href;
      // Messages posted before the module has attached its listener would be lost:
      // hold them until it has loaded, then hand them over in order.
      const boot = [
        'const held = [];',
        'const hold = (e) => { e.stopImmediatePropagation(); held.push(e); };',
        "self.addEventListener('message', hold);",
        `import(${JSON.stringify(href)}).then(() => {`,
        "  self.removeEventListener('message', hold);",
        "  for (const e of held) self.dispatchEvent(new MessageEvent('message', { data: e.data, ports: [...e.ports] }));",
        '}, (e) => { setTimeout(() => { throw e; }); });',
      ].join('\n');
      return new Worker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })));
    },
  };
  return ws;
}
