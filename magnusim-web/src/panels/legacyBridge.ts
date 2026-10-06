/**
 * The one place React islands are allowed to reach into `workbench/runtime.js`.
 *
 * While the island cut is in progress the runtime still owns job state, the
 * tree, and the solve gate. Islands call the functions below instead of
 * clicking hidden buttons, and listen for these events instead of reading
 * hidden DOM:
 *
 *   cfd:faces          (document) face picks        -> viewer/pick.subscribeFacePicks
 *   cfd:bodies         (document) body picks        -> viewer/pick.subscribeBodyPicks
 *   cfd:material       (window)   material saved or units changed; reload
 *   cfd:mesh-job       (window)   mesh job state    -> subscribeMeshJob
 *   cfd:mesh-settings  (window)   mesh settings the runtime wants shown -> subscribeMeshSettings
 *   cfd:mesh-copy      (window)   copy-from-mesh state -> subscribeMeshCopy
 *   cfd:bcs            (window)   boundary conditions -> subscribeBcState
 *   cfd:run-state      (window)   run panel state   -> subscribeRunState
 *   cfd:study          (window)   study panel state -> subscribeStudyState
 *   cfd:geometry       (window)   geometry panel state -> subscribeGeometryState
 *
 * Every function is safe to call before the runtime has booted; it returns
 * false or undefined rather than throwing.
 */

export interface MeshGenerateOptions {
  mesh_id?: string;
  settings?: Record<string, unknown>;
}

export type MeshGenerateKind = 'generating' | 'queued' | 'queue' | 'generate';

/** Open a tree flyout by its runtime key, e.g. 'mesh', 'bc-picker', 'sim-control'. */
export function openTreeDetail(key: string, opts?: { toggle?: boolean }): boolean {
  const fn = window.__CFD_OPEN_TREE_DETAIL__;
  if (!fn) return false;
  return !!fn(key, opts);
}

/** Open the boundary-condition editor on one record and arm face picking. */
export function openBc(id: string): boolean {
  const fn = window.__CFD_OPEN_BC__;
  if (!fn || !id) return false;
  return !!fn(id);
}

/**
 * Generate / Add to queue / Remove from queue through the runtime so job
 * state, the queue, the viewport chip and the tree ticks all stay in one path.
 */
export async function generateMesh(opts: MeshGenerateOptions): Promise<unknown> {
  const click = window.__CFD_MESH_GENERATE_CLICK__;
  if (click) return click(opts);
  const raw = window.__CFD_W21_GENERATE__;
  if (!raw) throw new Error('Mesh generate is not ready yet.');
  return raw(opts);
}

export async function deleteMesh(): Promise<unknown> {
  const fn = window.__CFD_DELETE_MESH__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn();
}

export async function renameMesh(name: string): Promise<string> {
  const fn = window.__CFD_MESH_RENAME__;
  if (!fn) throw new Error('Rename is not ready yet.');
  return fn(name);
}

export async function restoreMeshDefaults(): Promise<unknown> {
  const fn = window.__CFD_MESH_RESTORE_DEFAULTS__;
  if (!fn) throw new Error('Restore defaults is not ready yet.');
  return fn();
}

/** Open the settings flyout for a mesh (the inspect card's Settings link). */
export function openMeshSettings(meshId?: string): boolean {
  const fn = window.__CFD_MESH_OPEN_SETTINGS__;
  if (!fn) return false;
  fn(meshId);
  return true;
}

/** Arm or disarm "copy from another mesh" (tree rows become pick targets). */
export function meshCopyPick(on: boolean, destId?: string): void {
  window.__CFD_MESH_COPY_PICK__?.(on, destId);
}

export async function copyMeshSettings(sourceId: string): Promise<unknown> {
  const fn = window.__CFD_COPY_MESH_SETTINGS__;
  if (!fn) throw new Error('Copy is not ready yet.');
  return fn(sourceId);
}

export async function simStart(scope?: string): Promise<unknown> {
  if (scope) window.__CFD_RUN_SCOPE__ = scope;
  const fn = window.__CFD_SIM_START__;
  if (!fn) throw new Error('Start is not ready yet.');
  return fn();
}

export async function simStop(): Promise<unknown> {
  const fn = window.__CFD_SIM_STOP__;
  if (!fn) return undefined;
  return fn();
}

export function refreshTree(): void {
  window.__CFD_REFRESH_TREE__?.();
}

export function watchJob(jobId: string): void {
  window.__CFD_WATCH_JOB__?.(jobId);
}

function subscribe<T>(name: string, onEvent: (detail: T) => void): () => void {
  const fn = (ev: Event) => onEvent((ev as CustomEvent<T>).detail);
  window.addEventListener(name, fn);
  return () => window.removeEventListener(name, fn);
}

export type MeshPhase = 'failed' | 'generating' | 'finishing' | 'ready' | 'idle' | 'queued';

/** What runtime.publishMeshJobState publishes instead of writing panel DOM. */
export interface MeshJobState {
  /** The mesh the tree is viewing; falls back to the job's mesh. */
  mesh_id: string | null;
  job_mesh_id: string | null;
  name: string;
  can_delete: boolean;
  /** True when the live job belongs to the viewed mesh. */
  mine: boolean;
  phase: MeshPhase;
  status: string;
  stage_text: string;
  error: string;
  n_cells: number | null;
  n_points: number | null;
  counts_source: string;
  /** Engine, layers, hex core, surface size; elapsed is appended by the panel. */
  meta_bits: string[];
  started_at: number | null;
  finished_at: number | null;
  elapsed_ms: number | null;
  generate_kind: MeshGenerateKind;
  /** Set while this mesh waits in the server compute queue. */
  queue?: {
    /** 1-based place in the server-wide queue (all projects). */
    position: number | null;
    /** The running job it waits on, e.g. "Mesh 1 in Sample project". */
    behind: string;
  } | null;
}

export function subscribeMeshJob(onState: (state: MeshJobState) => void): () => void {
  return subscribe<MeshJobState>('cfd:mesh-job', onState);
}

export function meshJobNow(): MeshJobState | null {
  return window.__CFD_MESH_JOB__ || null;
}

export interface MeshSettingsEvent {
  mesh_id: string | null;
  settings: Record<string, unknown>;
}

/** The runtime applied settings (copy, restore, hydrate) and wants the panel to show them. */
export function subscribeMeshSettings(onEvent: (ev: MeshSettingsEvent) => void): () => void {
  return subscribe<MeshSettingsEvent>('cfd:mesh-settings', onEvent);
}

export interface MeshCopyState {
  dest_id: string | null;
  available: boolean;
  picking: boolean;
  note: string;
  sources: Array<{ id: string; label: string }>;
}

export function subscribeMeshCopy(onState: (state: MeshCopyState) => void): () => void {
  return subscribe<MeshCopyState>('cfd:mesh-copy', onState);
}

export function meshCopyNow(): MeshCopyState | null {
  return window.__CFD_MESH_COPY__ || null;
}

export interface RunGateState {
  run_id?: string;
  canStart: boolean;
  running: boolean;
  done: boolean;
  failed?: boolean;
  transient?: boolean;
  reasons: string[];
}

/** A transient run's control block. Its fields are the analysis's run model's (run_defaults). */
export type TransientSettings = Record<string, unknown>;

/** What the analysis's run model resolves for a run now (analysis.run_preview). */
export interface RunPreview {
  ok?: boolean;
  partial?: boolean;
  reason?: string | null;
  control?: Record<string, unknown>;
}

/** What runtime.publishRunState dispatches as `cfd:run-state` for the selected run. */
export interface RunState {
  has_run: boolean;
  run_id: string;
  name: string;
  status: string;
  transient: boolean;
  /** Started or finished runs keep their settings. */
  locked: boolean;
  running: boolean;
  done: boolean;
  can_start: boolean;
  queued: boolean;
  start: { visible: boolean; enabled: boolean; label: string; title: string };
  stop: { visible: boolean; label: string; title: string };
  can_delete: boolean;
  /** Why Start is off (or what it is doing), with the label of the fix link. */
  reason: { text: string; fix_label: string } | null;
  /** Steady iterations / write interval (null only before the registry has loaded). */
  settings: { end_time: number | null; write_interval: number | null };
  /** The analysis the run solves with (its settings component and residual series). */
  analysis_key: string;
  transient_settings: TransientSettings;
  /** A transient run's resolved numbers (null until the preview arrives, or steady). */
  run_preview: RunPreview | null;
  progress: {
    show: boolean;
    title: string;
    line: string;
    elapsed: string;
    eta: string;
    meta: string;
    residuals: Array<Record<string, number>>;
    end: number;
  };
  copy: { available: boolean; picking: boolean; note: string; sources: Array<{ id: string; label: string }> };
  mesh_ready: boolean;
  /** The run's analysis reports no setup issue (null until it answers). */
  setup_ready: boolean | null;
  /** Made on an older version of its linked geometry (API 1.5, D26): the line the panel shows, else ''. */
  older_geometry?: string;
  /** Cores the run asks for: a whole number, or null for Auto. */
  cores?: number | null;
  /** Whether the run's launch is parallel (its last plan's); null before it started. */
  launch_parallel?: boolean | null;
}

export function subscribeRunState(onState: (state: RunState) => void): () => void {
  return subscribe<RunState>('cfd:run-state', onState);
}

export function runStateNow(): RunState | null {
  return window.__CFD_RUN_STATE__ || window.__CFD_RUN_STATE_NOW__?.() || null;
}

/** The Start gate for the selected run (kept for plugins and tests). */
export function runGate(runId?: string): RunGateState | null {
  const fn = window.__CFD_RUN_GATE__;
  if (!fn) return null;
  return fn(runId) || null;
}

export async function saveRunSettings(patch: { end_time?: number; write_interval?: number }): Promise<unknown> {
  const fn = window.__CFD_RUN_SAVE__;
  if (!fn) throw new Error('Run settings are not ready yet.');
  return fn(patch);
}

export async function saveTransientSettings(t: TransientSettings): Promise<unknown> {
  const fn = window.__CFD_RUN_TRANSIENT_SAVE__;
  if (!fn) throw new Error('Run settings are not ready yet.');
  return fn(t);
}

/** Save the selected run's Cores: a whole number, or null for Auto. */
export async function saveRunCores(cores: number | null): Promise<unknown> {
  const fn = window.__CFD_RUN_CORES_SAVE__;
  if (!fn) throw new Error('Run settings are not ready yet.');
  return fn(cores);
}

export async function renameRun(name: string): Promise<unknown> {
  const fn = window.__CFD_RUN_RENAME__;
  if (!fn) throw new Error('Rename is not ready yet.');
  return fn(name);
}

export async function deleteRun(): Promise<unknown> {
  const fn = window.__CFD_RUN_DELETE__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn();
}

/** Arm or disarm "copy from previous run" (tree runs become pick targets). */
export function runCopyPick(on: boolean): void {
  window.__CFD_RUN_COPY_PICK__?.(on);
}

export async function copyRunFrom(runId: string): Promise<unknown> {
  const fn = window.__CFD_RUN_COPY_FROM__;
  if (!fn) throw new Error('Copy is not ready yet.');
  return fn(runId);
}

/** Geometry panel state: V0.1.0's Name / Representation / Volume rows. */
export interface GeometryState {
  has_geometry: boolean;
  id?: string;
  title?: string;
  name?: string;
  representation?: string;
  volume?: string;
  can_delete?: boolean;
}

export function subscribeGeometryState(onState: (state: GeometryState) => void): () => void {
  return subscribe<GeometryState>('cfd:geometry', onState);
}

export function geometryStateNow(): GeometryState | null {
  return window.__CFD_GEOMETRY_STATE__ || window.__CFD_GEOMETRY_STATE_NOW__?.() || null;
}

/** Remove the selected geometry (the runtime asks to confirm first). Resolves true when removed. */
export async function deleteGeometry(): Promise<boolean> {
  const fn = window.__CFD_GEOMETRY_DELETE__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn();
}

export type TimeDependency = 'Steady-state' | 'Transient';

/** Study (simulation) panel state. `record` is the saved study, physics keys included. */
export interface StudyState {
  has_study: boolean;
  id?: string;
  project_id?: string;
  name?: string;
  analysis?: string;
  analysis_type?: string;
  time_dependency?: TimeDependency;
  algorithm?: string;
  record?: Record<string, unknown>;
}

export function subscribeStudyState(onState: (state: StudyState) => void): () => void {
  return subscribe<StudyState>('cfd:study', onState);
}

export function studyStateNow(): StudyState | null {
  return window.__CFD_STUDY_STATE__ || window.__CFD_STUDY_STATE_NOW__?.() || null;
}

/** Save study fields (the analysis's settings and numerics) on the active study. */
export async function saveStudy(patch: Record<string, unknown>): Promise<unknown> {
  const fn = window.__CFD_STUDY_UPDATE__;
  if (!fn) throw new Error('Simulation settings are not ready yet.');
  return fn(patch);
}

/** Switch the study to its analysis family's steady or transient sibling; draft runs follow. */
export async function setStudyTimeDependency(value: TimeDependency): Promise<unknown> {
  const fn = window.__CFD_STUDY_TIME__;
  if (!fn) throw new Error('Time dependency is not ready yet.');
  return fn(value);
}

export async function deleteStudy(): Promise<unknown> {
  const fn = window.__CFD_STUDY_DELETE__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn();
}

/** Follow the reason's fix link (open Materials, the mesh, a BC, …). */
export function runSetupFix(): void {
  window.__CFD_RUN_SETUP_FIX__?.();
}

/** One boundary condition as saved on disk (what the case writer reads). */
export interface BcRecord {
  id: string;
  name: string;
  bc_type: string;
  faces: string[];
  face?: string | null;
  value?: number | null;
  unit?: string;
  velocity_type?: string;
  flow_rate_type?: string;
  direction?: string;
  vector?: number[];
  wall_type?: string;
  pressure_type?: string;
  [key: string]: unknown;
}

/** What runtime.publishBcState dispatches as `cfd:bcs`. */
export interface BcState {
  simulation_id: string | null;
  bcs: BcRecord[];
  /** The BC the editor is showing and faces are being assigned to. */
  active_id: string | null;
  draft_faces: string[];
  focus_face: string | null;
  defaults: { wall_type: string };
  /** "Unassigned faces: no-slip walls" */
  defaults_summary: string;
  /** Faces clicked in the viewport while the picker is open; Add assigns them. */
  pending_faces: string[];
  imperial: boolean;
  /** The study's analysis: the BC families it offers (its registry row's bc_types). */
  analysis_key?: string;
  /** The study's record as saved (a BC family's fields may depend on it, e.g. its turbulence model). */
  study?: Record<string, unknown> | null;
}

export function subscribeBcState(onState: (state: BcState) => void): () => void {
  return subscribe<BcState>('cfd:bcs', onState);
}

/** The latest state, asking the runtime to publish if nothing has been sent yet. */
export function bcStateNow(): BcState | null {
  return window.__CFD_BCS__ || window.__CFD_BC_STATE__?.() || null;
}

export function openBcPicker(): boolean {
  const fn = window.__CFD_BC_OPEN_PICKER__;
  if (!fn) return false;
  fn();
  return true;
}

export function openBcDefaults(): boolean {
  const fn = window.__CFD_BC_OPEN_DEFAULTS__;
  if (!fn) return false;
  fn();
  return true;
}

/** Create a BC of this type with the faces picked while the picker was open, then open its editor. */
export async function createBc(bcType: string): Promise<unknown> {
  const fn = window.__CFD_BC_CREATE__;
  if (!fn) throw new Error('Boundary conditions are not ready yet.');
  return fn(bcType);
}

/** Merge fields into one BC and save it (type change and unit conversion happen in the runtime). */
export async function updateBc(id: string, patch: Partial<BcRecord>): Promise<unknown> {
  const fn = window.__CFD_BC_UPDATE__;
  if (!fn) throw new Error('Boundary conditions are not ready yet.');
  return fn(id, patch);
}

export async function deleteBc(id: string): Promise<unknown> {
  const fn = window.__CFD_BC_DELETE__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn(id);
}

/** A lost face entry on a record (a linked geometry's update put it there; API 1.5). */
export interface LostFaceEntry {
  field: string;
  old: string;
  name?: string | null;
  label?: string | null;
  reason: 'gone' | 'claimed_twice' | 'held_elsewhere' | 'stale';
  targets?: string[];
}

/** Forget lost faces: one entry, a record's, a study's, or the whole geometry's (no id). */
export async function forgetLostFaces(opts: {
  geometry_id?: string;
  study_id?: string;
  kind?: string;
  id?: string;
  mesh_id?: string;
  run_id?: string;
  entry?: { field: string; old: string } | null;
}): Promise<unknown> {
  const fn = window.__CFD_FORGET_LOST__;
  if (!fn) throw new Error('The project is not open yet.');
  return fn(opts);
}

export function unassignBcFace(face: string): void {
  window.__CFD_BC_UNASSIGN_FACE__?.(face);
}

export function focusBcFace(face: string): void {
  window.__CFD_BC_FOCUS_FACE__?.(face);
}

/**
 * What a BC editor needs to turn a velocity into a flow rate and back: the mean
 * area of one of these faces (m², null without geometry) and the study's fluid
 * density (kg/m³, 0 when the runtime is not there).
 */
export function bcFlowBasis(faces: string[]): { face_area_m2: number | null; density: number } {
  return window.__CFD_BC_FLOW_BASIS__?.(faces) || { face_area_m2: null, density: 0 };
}

export async function clearBcFaces(): Promise<unknown> {
  const fn = window.__CFD_BC_CLEAR_FACES__;
  if (!fn) return undefined;
  return fn();
}

/**
 * Hand a material saved through `materials.set` to the runtime so the tree
 * checkmark, the Start gate (the analysis's readiness) and the viewport agree.
 */
export function applyMaterial(material: Record<string, unknown>, projectId?: string): boolean {
  const fn = window.__CFD_MATERIAL_APPLY__;
  if (!fn) return false;
  fn(material, projectId);
  return true;
}

export async function deleteMaterial(): Promise<unknown> {
  const fn = window.__CFD_MATERIAL_DELETE__;
  if (!fn) throw new Error('Delete is not ready yet.');
  return fn();
}

/** Body names of the open geometry ("Body1", ...), in viewport pick order. */
export function geometryBodies(): string[] {
  const fn = window.__CFD_GEOMETRY_BODIES__;
  try {
    return fn ? fn().map(String) : [];
  } catch {
    return [];
  }
}
