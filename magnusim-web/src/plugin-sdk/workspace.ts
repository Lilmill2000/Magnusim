/**
 * The workspace bridge, frame side: what a plugin's workspace page imports
 * (`import { connect } from '@magnusim/workspace'`, served as
 * `/plugin-sdk/workspace.js`).
 *
 * A workspace runs in a sandboxed frame with an opaque origin: it cannot reach
 * the app's page or its API, has no localStorage, IndexedDB or cookies, and
 * talks to the app only through this bridge. `connect()` says hello to the
 * host, which answers with the context (plugin, project, study, units) and a
 * private MessageChannel port; every call then goes over that port, and the
 * host checks it against an allowlist scoped to this plugin, project and study.
 *
 * Self-contained: no imports, so the host can serve it to any frame.
 */

/** The bridge's version; a host accepts a workspace built for the same major version. */
export const SDK_VERSION = '1.3.0';

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
  name: 'light';
  /** The stylesheet with the design tokens and base styles the host serves. */
  stylesheet: string;
}

export interface WorkspaceContext {
  plugin: string;
  workspace: string;
  project: { id: string; title: string };
  study: StudyRecord;
  units: UnitSystem;
  theme: ThemeInfo;
  /**
   * The host's bridge API version ("1.6"). To use a call a later host added,
   * compare it as numbers, major then minor (ws.nav.setDirty needs 1.2,
   * ws.compute and ws.results need 1.3, ws.project.linkGeometry 1.5,
   * ws.nav.onLeave 1.6), or catch the refusal: an older host
   * rejects a call it does not know with code "not_allowed".
   */
  hostVersion: string;
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

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The confirming button's label ("Delete", "Replace", ...). */
  confirmLabel?: string;
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
  error?: { message?: string; code?: string };
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
  // The exit hook (host 1.6), and the leaves it is running, by the host's id for each.
  let leaveHandler: LeaveHandler | null = null;
  const leaves = new Map<string, AbortController>();
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
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'The host refused the call'), { code: msg.error.code }));
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
    if (msg.event === 'leave') {
      void runLeave(msg.data);
      return;
    }
    if (msg.event === 'leaveAbort') {
      const id = String(((msg.data || {}) as { leave?: unknown }).leave || '');
      leaves.get(id)?.abort(new DOMException('The leave was cancelled', 'AbortError'));
      return;
    }
    if (msg.event === 'units') ctx.units = msg.data as UnitSystem;
    if (msg.event === 'theme') ctx.theme = msg.data as ThemeInfo;
    if (msg.event === 'study') ctx.study = msg.data as StudyRecord;
    for (const fn of listeners.get(String(msg.event)) || []) fn(msg.data);
  };
  port.start();

  function call<T = unknown>(method: string, params: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (transfer && transfer.length) port.postMessage({ id, method, params }, transfer);
      else port.postMessage({ id, method, params });
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
