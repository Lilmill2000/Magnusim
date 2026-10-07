/**
 * Disk-backed compute FIFO. The browser chip edits this list; Node starts
 * the next mesh/solve/plugin case after the live slot frees. Closing a tab does
 * not drop queued work while the Magnusim window stays open.
 *
 * The queue's state lives on the process (globalThis), like the compute slot: a
 * Vite re-import of this module, and closures of the old instance (a run that
 * ends, a drain, a timer), act on the same list with the newest deps.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WEB_ROOT } from '../python-env.js';
import { PROJECTS_ROOT } from '../project-isolation.js';
import { sameProjectFolder } from '../compute-slot.js';

export type ComputeQueueKind = 'mesh' | 'solve' | 'foam' | 'geometry';

export type ComputeQueueItem = {
  id: string;
  kind: ComputeQueueKind;
  mesh_id?: string | null;
  run_id?: string | null;
  simulation_id?: string | null;
  project_id?: string | null;
  name?: string;
  settings?: Record<string, unknown> | null;
  /** Plugin cases (kind foam): the case's record in the store, and whose it is. */
  job_id?: string | null;
  foam?: { plugin: string; study_id: string } | null;
  /** Geometry updates (kind geometry, API 1.5): the link job's study and geometry. */
  geometry?: { plugin: string; study_id: string; geometry_id: string } | null;
};

export type ComputeStartResult = {
  ok?: boolean;
  busy?: boolean;
  missing?: boolean;
  skip?: boolean;
  /** Refused for good: the row leaves at once, with no retries (plugin cases). */
  final?: boolean;
  /**
   * Cannot start yet for a reason of its own project, with the slot free (a geometry
   * update waiting for a create of its study): it keeps its place, and the kick tries the
   * rows of other projects behind it. Whatever ends the wait kicks the queue again.
   */
  deferred?: boolean;
  /** Why the start was refused (shown to the user when the job leaves the queue). */
  error?: string;
};

export type ComputeLiveSnap = {
  kind: ComputeQueueKind | 'check' | null;
  phase?: string | null;
  name?: string | null;
  stopping?: boolean;
  mesh_id?: string | null;
  run_id?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  mesh_name?: string | null;
  generate_id?: string | null;
  path_kind?: string | null;
  started_at?: string | null;
  job_id?: string | null;
  plugin?: string | null;
  study_id?: string | null;
  geometry_id?: string | null;
};

export type ComputeLeaveReason = 'removed' | 'skipped' | 'failed' | 'dropped';

export type ComputeQueueDeps = {
  isBusy?: () => boolean;
  meshIsGenerating?: (meshId: string, projectId: string) => boolean;
  startMesh?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  startSolve?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  startFoam?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  startGeometry?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  /**
   * Called by the kick right after it finds the slot free: true when it claimed the
   * slot for work that goes before every queued row (the link recovery), and the
   * kick then stops as if the slot were busy.
   */
  runFirst?: () => boolean;
  live?: () => ComputeLiveSnap | null;
  /** A row left the queue without being started (removed, skipped, failed or dropped). */
  onLeave?: (row: ComputeQueueItem, reason: ComputeLeaveReason, error?: string) => void;
  /** After every write of the list. */
  onChange?: () => void;
  /** The slot holder is this row's job (its start went through before it threw). */
  holdsRow?: (row: ComputeQueueItem) => boolean;
};

export type ComputeQueueSnapshot = {
  ok: boolean;
  items: Array<ComputeQueueItem & { position?: number }>;
  /** The running job, only when it belongs to the asked project. */
  live: ComputeLiveSnap | null;
  /** The running job in any project: what a queued row is waiting on. */
  busy?: ComputeLiveSnap | null;
  /** Jobs that left the queue because they could not start (newest last). */
  failed?: ComputeQueueFailure[];
};

/** A queued job that could not start; it is taken off the queue so the rest can run. */
export type ComputeQueueFailure = {
  id: string;
  kind: ComputeQueueKind;
  mesh_id: string | null;
  run_id: string | null;
  simulation_id: string | null;
  project_id: string | null;
  name: string;
  error: string;
  at: number;
  job_id?: string | null;
  /** Missing means failed (could not start). */
  reason?: 'failed' | 'dropped' | 'stopped';
};

/**
 * Queue rows name projects under one projects root, so each root gets its own
 * file: an e2e or scratch server must not start (or drop) the dev server's jobs.
 */
export function computeQueueFileFor(projectsRoot: string): string {
  const root = resolve(projectsRoot);
  if (root.toLowerCase() === resolve(WEB_ROOT, 'projects').toLowerCase()) {
    return join(WEB_ROOT, '.cache', 'compute-queue.json');
  }
  const tag = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10);
  return join(WEB_ROOT, '.cache', `compute-queue-${tag}.json`);
}

const DEFAULT_PATH = computeQueueFileFor(PROJECTS_ROOT);

const HOLD_RETRIES = 3;
const FAILURE_KEEP_MS = 15 * 60 * 1000;
const FAILURE_MAX = 50;
const FOAM_JOB_RE = /^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
const LINK_JOB_RE = /^gl-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
const GEOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const START_THREW_ERROR = 'Start failed on the server. See the server log';

type QueueState = {
  filePath: string;
  items: ComputeQueueItem[];
  loaded: boolean;
  kicking: boolean;
  kickTimer: ReturnType<typeof setTimeout> | null;
  deps: ComputeQueueDeps;
  failures: ComputeQueueFailure[];
  /** Refused starts per queue row: a refusal right after its mesh finished is a race, not a failure. */
  holdTries: Map<string, number>;
  holdRetryMs: number;
};

const Q: QueueState = (() => {
  const key = Symbol.for('magnusim.computeQueue');
  const g = globalThis as unknown as Record<symbol, QueueState | undefined>;
  if (!g[key]) {
    g[key] = {
      filePath: DEFAULT_PATH,
      items: [],
      loaded: false,
      kicking: false,
      kickTimer: null,
      deps: {},
      failures: [],
      holdTries: new Map(),
      holdRetryMs: 2000,
    };
  }
  return g[key] as QueueState;
})();

function normId(value: unknown): string {
  return value == null || value === '' ? '' : String(value);
}

/** Mesh and run ids repeat across projects (every project has a mesh_1), so the project is part of the key. */
function jobKey(
  item: { kind?: unknown; mesh_id?: unknown; run_id?: unknown; project_id?: unknown; job_id?: unknown } | null | undefined,
): string {
  if (!item) return '';
  if (item.kind === 'foam' || item.kind === 'geometry') {
    const job = normId(item.job_id);
    return job ? `${item.kind}:${normId(item.project_id)}:${job}` : '';
  }
  const kind = item.kind === 'mesh' || item.kind === 'solve' ? item.kind : '';
  const id = kind === 'mesh' ? normId(item.mesh_id) : normId(item.run_id);
  return kind && id ? `${kind}:${normId(item.project_id)}:${id}` : '';
}

/** No projectId means any project (older callers). */
function sameProject(row: { project_id?: unknown }, projectId: unknown): boolean {
  const want = normId(projectId);
  return !want || normId(row.project_id) === want;
}

function newQueueId(): string {
  return `q-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

export function queueKickAfterStart(
  result: ComputeStartResult | null | undefined,
  computeRunning: boolean,
): 'retry' | 'dequeue' | 'hold' | 'skip' | 'fail' | 'defer' {
  if (result && result.deferred) return 'defer';
  if (result && result.busy) return 'retry';
  if (result && result.final) return 'fail';
  if (result && (result.missing || result.skip)) return 'skip';
  if (result && result.ok === false) return 'hold';
  if (computeRunning) return 'dequeue';
  return 'hold';
}

function queueIndexOfMesh(list: ComputeQueueItem[], meshId: unknown, projectId?: unknown): number {
  const want = normId(meshId);
  if (!want) return -1;
  return list.findIndex(
    (row) => row && row.kind === 'mesh' && normId(row.mesh_id) === want && sameProject(row, projectId),
  );
}

export function queueHasMeshDepViolation(list: ComputeQueueItem[] | null | undefined): boolean {
  const rows = Array.isArray(list) ? list : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.kind !== 'solve' || !normId(row.mesh_id)) continue;
    const meshAt = queueIndexOfMesh(rows, row.mesh_id, row.project_id);
    if (meshAt >= 0 && i < meshAt) return true;
  }
  return false;
}

function insertMeshBeforeDependentSolves(list: ComputeQueueItem[], item: ComputeQueueItem): ComputeQueueItem[] {
  const next = list.slice();
  const meshId = normId(item.mesh_id);
  const firstSolve = meshId
    ? next.findIndex(
        (row) => row && row.kind === 'solve' && normId(row.mesh_id) === meshId && sameProject(row, item.project_id),
      )
    : -1;
  if (firstSolve < 0) next.push(item);
  else next.splice(firstSolve, 0, item);
  return next;
}

function parseStoredQueueItems(raw: unknown, opts?: { foam?: boolean; geometry?: boolean }): ComputeQueueItem[] {
  let stored = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return (Array.isArray(stored) ? stored : [])
    .map((row) => normalizeItem(row, opts))
    .filter((row): row is ComputeQueueItem => !!row);
}

function mergeStoredQueueItems(...lists: Array<ComputeQueueItem[] | null | undefined>): ComputeQueueItem[] {
  const out: ComputeQueueItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const k = jobKey(row);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
  }
  return out;
}

function dropQueueJobsForMesh(list: ComputeQueueItem[], meshId: unknown, projectId?: unknown): ComputeQueueItem[] {
  const id = normId(meshId);
  if (!id) return list.slice();
  return list.filter((row) => !(normId(row.mesh_id) === id && sameProject(row, projectId)));
}

function orderedQueueItems(list: ComputeQueueItem[], ids: unknown): ComputeQueueItem[] {
  const byId = new Map<string, ComputeQueueItem>();
  for (const rec of list) {
    if (rec.id) byId.set(String(rec.id), rec);
  }
  const next: ComputeQueueItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '');
    if (!id || seen.has(id)) continue;
    const rec = byId.get(id);
    if (!rec) continue;
    next.push(rec);
    seen.add(id);
  }
  for (const rec of list) {
    if (!rec.id || seen.has(rec.id)) continue;
    next.push(rec);
    seen.add(rec.id);
  }
  return next;
}

export function startResultFromEngine(started: {
  ok?: boolean;
  status?: number;
  bodyExtra?: { error?: unknown; stopped?: unknown; final?: unknown } | null;
} | null | undefined): ComputeStartResult {
  if (started && started.ok) return { ok: true };
  const status = started && started.status;
  const err = String((started && started.bodyExtra && started.bodyExtra.error) || '');
  // A refusal waiting cannot end (a linked geometry's face claimed twice, its update left
  // half done): the row leaves at once, with its reason in the notice.
  if (started && started.bodyExtra && started.bodyExtra.final === true) return { ok: false, final: true, error: err };
  // Stopped before it started (a Stop while the queue started it): it leaves the queue.
  if (started && started.bodyExtra && started.bodyExtra.stopped === true) return { ok: false, skip: true, error: err };
  if (status === 409 || /already running|already in progress|already solving/i.test(err)) {
    if (/already finished/i.test(err)) return { ok: false, skip: true, error: err };
    if (/already solving/i.test(err)) return { ok: false, skip: true, error: err };
    return { ok: false, busy: true, error: err };
  }
  if (status === 404 || /not found|was deleted|mesh_id required/i.test(err)) {
    return { ok: false, missing: true, error: err };
  }
  return { ok: false, error: err };
}

/**
 * One queue row from stored or posted data, or null. A plugin case row (kind foam)
 * and a geometry update row (kind geometry) are accepted only from the host's own
 * writers (`foam: true`, `geometry: true`): a browser merge or the generic POST can
 * never add one.
 */
function normalizeItem(raw: unknown, opts?: { foam?: boolean; geometry?: boolean }): ComputeQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === 'geometry') {
    if (!opts || !opts.geometry) return null;
    const jobId = normId(row.job_id);
    const geo = row.geometry && typeof row.geometry === 'object' ? (row.geometry as Record<string, unknown>) : null;
    const plugin = normId(geo && geo.plugin);
    const studyId = normId(geo && geo.study_id);
    const geometryId = normId(geo && geo.geometry_id);
    const projectId = normId(row.project_id);
    if (!LINK_JOB_RE.test(jobId) || !PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin)) return null;
    if (!STUDY_ID_RE.test(studyId) || !GEOM_ID_RE.test(geometryId) || !projectId) return null;
    return {
      id: normId(row.id) || newQueueId(),
      kind: 'geometry',
      project_id: projectId,
      name: row.name != null ? String(row.name) : 'Geometry update',
      mesh_id: null,
      run_id: null,
      simulation_id: null,
      settings: null,
      job_id: jobId,
      geometry: { plugin, study_id: studyId, geometry_id: geometryId },
    };
  }
  if (row.kind === 'foam') {
    if (!opts || !opts.foam) return null;
    const jobId = normId(row.job_id);
    const foam = row.foam && typeof row.foam === 'object' ? (row.foam as Record<string, unknown>) : null;
    const plugin = normId(foam && foam.plugin);
    const studyId = normId(foam && foam.study_id);
    const projectId = normId(row.project_id);
    if (!FOAM_JOB_RE.test(jobId) || !PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin)) return null;
    if (!STUDY_ID_RE.test(studyId) || !projectId) return null;
    return {
      id: normId(row.id) || newQueueId(),
      kind: 'foam',
      project_id: projectId,
      name: row.name != null ? String(row.name) : 'Plugin case',
      mesh_id: null,
      run_id: null,
      simulation_id: null,
      settings: null,
      job_id: jobId,
      foam: { plugin, study_id: studyId },
    };
  }
  const kind = row.kind === 'mesh' || row.kind === 'solve' ? row.kind : null;
  if (!kind) return null;
  const meshId = normId(row.mesh_id) || null;
  const runId = normId(row.run_id) || null;
  if (kind === 'mesh' && !meshId) return null;
  if (kind === 'solve' && !runId) return null;
  const settings =
    row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : null;
  return {
    id: normId(row.id) || newQueueId(),
    kind,
    mesh_id: meshId,
    run_id: runId,
    simulation_id: normId(row.simulation_id) || null,
    project_id: normId(row.project_id) || null,
    name: row.name != null ? String(row.name) : kind === 'mesh' ? 'Mesh' : 'Run',
    settings,
  };
}

function persist(): void {
  try {
    mkdirSync(dirname(Q.filePath), { recursive: true });
    writeFileSync(Q.filePath, JSON.stringify({ items: Q.items }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  if (Q.deps.onChange) {
    try {
      Q.deps.onChange();
    } catch (e) {
      console.warn('[CFD queue] onChange failed', e);
    }
  }
}

function ensureLoaded(): void {
  if (Q.loaded) return;
  Q.loaded = true;
  if (!existsSync(Q.filePath)) {
    Q.items = [];
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(Q.filePath, 'utf8')) as { items?: unknown } | unknown;
    const list = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown }).items
      : raw;
    Q.items = parseStoredQueueItems(list, { foam: true, geometry: true });
  } catch {
    Q.items = [];
  }
}

function defaultName(kind: ComputeQueueKind): string {
  return kind === 'mesh' ? 'Mesh' : kind === 'solve' ? 'Run' : kind === 'geometry' ? 'Geometry update' : 'Plugin case';
}

function pruneFailures(): void {
  const now = Date.now();
  Q.failures = Q.failures.filter((f) => now - f.at < FAILURE_KEEP_MS);
  if (Q.failures.length > FAILURE_MAX) Q.failures = Q.failures.slice(-FAILURE_MAX);
}

/** No closing full stop: the toast adds one. */
function noStop(text: string): string {
  return String(text || '').replace(/\.\s*$/, '');
}

function pushFailure(row: ComputeQueueItem, error: string, reason: 'failed' | 'dropped' | 'stopped'): void {
  Q.failures.push({
    id: row.id,
    kind: row.kind,
    mesh_id: row.mesh_id ?? null,
    run_id: row.run_id ?? null,
    simulation_id: row.simulation_id ?? null,
    project_id: row.project_id ?? null,
    name: row.name || defaultName(row.kind),
    error: noStop(error),
    at: Date.now(),
    ...(row.job_id ? { job_id: row.job_id } : {}),
    ...(reason !== 'failed' ? { reason } : {}),
  });
  pruneFailures();
}

function leave(row: ComputeQueueItem, reason: ComputeLeaveReason, error?: string): void {
  if (!Q.deps.onLeave) return;
  try {
    Q.deps.onLeave(row, reason, error);
  } catch (e) {
    console.warn('[CFD queue] onLeave failed', e);
  }
}

export function configureComputeQueue(next: ComputeQueueDeps): void {
  Q.deps = { ...Q.deps, ...next };
}

export function resetComputeQueueForTests(opts?: {
  filePath?: string;
  items?: ComputeQueueItem[] | null;
  deps?: ComputeQueueDeps;
  reload?: boolean;
  holdRetryMs?: number;
}): void {
  Q.holdTries.clear();
  Q.failures = [];
  Q.holdRetryMs = opts && opts.holdRetryMs != null ? opts.holdRetryMs : 2000;
  if (Q.kickTimer) {
    clearTimeout(Q.kickTimer);
    Q.kickTimer = null;
  }
  Q.kicking = false;
  Q.filePath = opts && opts.filePath ? opts.filePath : DEFAULT_PATH;
  Q.deps = (opts && opts.deps) || {};
  if (opts && opts.reload) {
    Q.loaded = false;
    Q.items = [];
    return;
  }
  Q.loaded = true;
  const seed = opts && Array.isArray(opts.items) ? opts.items : [];
  Q.items = seed.map((row) => normalizeItem(row, { foam: true, geometry: true })).filter((row): row is ComputeQueueItem => !!row);
  persist();
}

export function snapshotComputeQueue(projectId?: string | null): ComputeQueueSnapshot {
  ensureLoaded();
  const raw = Q.deps.live ? Q.deps.live() : null;
  const live = raw && raw.kind ? raw : null;
  pruneFailures();
  if (projectId === undefined || projectId === null || projectId === '') {
    return {
      ok: true,
      items: Q.items.map((row, i) => ({ ...row, position: i + 1 })),
      live,
      busy: live,
      failed: Q.failures.slice(),
    };
  }
  const want = normId(projectId);
  const rows = Q.items.map((row, i) => ({ ...row, position: i + 1 })).filter((row) => normId(row.project_id) === want);
  const liveOk = live && normId(live.project_id) === want ? live : null;
  return {
    ok: true,
    items: rows,
    live: liveOk,
    busy: live,
    failed: Q.failures.filter((f) => normId(f.project_id) === want),
  };
}

export function enqueueComputeJob(
  raw: unknown,
  opts?: { setupIssue?: string; meshGenerating?: boolean },
): { ok: boolean; error?: string; item?: ComputeQueueItem; items: ComputeQueueItem[] } {
  ensureLoaded();
  const item = normalizeItem(raw);
  if (!item) {
    return { ok: false, error: 'kind must be mesh or solve', items: Q.items.slice() };
  }
  if (!normId(item.project_id)) {
    return { ok: false, error: 'project_id required', items: Q.items.slice() };
  }
  // A run whose analysis reports a setup issue (other than its mesh) is not queued.
  if (item.kind === 'solve' && opts && opts.setupIssue) {
    return { ok: false, error: String(opts.setupIssue), items: Q.items.slice() };
  }
  const existing = Q.items.find((row) => jobKey(row) === jobKey(item));
  if (existing) {
    return { ok: true, item: existing, items: Q.items.slice() };
  }
  if (item.kind === 'mesh') {
    Q.items = insertMeshBeforeDependentSolves(Q.items, item);
  } else {
    // First come, first served. A run whose mesh is queued goes to the back,
    // which is behind that mesh anyway; one whose mesh is generating right now
    // waits for it at the head (kick checks meshGenerating). Putting it right
    // after its mesh, or at the front, let it jump jobs queued before it,
    // including other projects' jobs.
    Q.items = [...Q.items, item];
  }
  persist();
  return { ok: true, item, items: Q.items.slice() };
}

/** A plugin case at the back of the queue (its record is already in the store). */
export function enqueueFoamJob(raw: unknown): { ok: boolean; error?: string; item?: ComputeQueueItem } {
  ensureLoaded();
  const item = normalizeItem(raw, { foam: true });
  if (!item || item.kind !== 'foam') return { ok: false, error: 'not a plugin case row' };
  const existing = Q.items.find((row) => jobKey(row) === jobKey(item));
  if (existing) return { ok: true, item: existing };
  Q.items = [...Q.items, item];
  persist();
  logQueue('queued', item);
  return { ok: true, item };
}

/** A geometry update at the back of the queue (its record is already in the link store). */
export function enqueueGeometryJob(raw: unknown): { ok: boolean; error?: string; item?: ComputeQueueItem } {
  ensureLoaded();
  const item = normalizeItem(raw, { geometry: true });
  if (!item || item.kind !== 'geometry') return { ok: false, error: 'not a geometry update row' };
  const existing = Q.items.find((row) => jobKey(row) === jobKey(item));
  if (existing) return { ok: true, item: existing };
  Q.items = [...Q.items, item];
  persist();
  logQueue('queued', item);
  return { ok: true, item };
}

/** The queued row of a link job, or null. */
export function queuedGeometryRow(jobId: unknown): ComputeQueueItem | null {
  ensureLoaded();
  const want = normId(jobId);
  return (want && Q.items.find((row) => row.kind === 'geometry' && row.job_id === want)) || null;
}

/**
 * POST /api/mesh/generate with queue_if_busy. When another mesh or solve holds
 * the one compute slot (possibly in another project), queue this mesh instead
 * of answering 409; the queue starts it when the slot frees, even with no tab
 * open on that project. Returns null when the request should start as usual
 * (slot free, or this very mesh is the live job).
 */
export function enqueueMeshWhenBusy(
  req: {
    mesh_id?: unknown;
    project_id?: unknown;
    simulation_id?: unknown;
    name?: unknown;
    settings?: Record<string, unknown> | null;
  },
  live: ComputeLiveSnap | null,
): { status: number; body: Record<string, unknown> } | null {
  const meshId = normId(req.mesh_id);
  const projectId = normId(req.project_id);
  if (!meshId || !projectId || !live || !live.kind) return null;
  if (live.kind === 'mesh' && normId(live.mesh_id) === meshId && normId(live.project_id) === projectId) return null;
  const enqueued = enqueueComputeJob({
    kind: 'mesh',
    mesh_id: meshId,
    project_id: projectId,
    simulation_id: normId(req.simulation_id) || null,
    name: req.name ? String(req.name) : undefined,
    settings: req.settings || null,
  });
  if (!enqueued.ok) return { status: 400, body: { ok: false, error: enqueued.error } };
  return {
    status: 202,
    body: { ...snapshotComputeQueue(projectId), ok: true, queued: true, item: enqueued.item },
  };
}

/** Leftover browser-side rows. A row for the job running right now is already done being queued. */
export function mergeComputeQueueItems(incoming: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const live = Q.deps.live ? Q.deps.live() : null;
  const liveKey = live && live.kind ? jobKey(live) : '';
  const rows = parseStoredQueueItems(incoming).filter((row) => !liveKey || jobKey(row) !== liveKey);
  Q.items = mergeStoredQueueItems(Q.items, rows);
  persist();
  return snapshotComputeQueue();
}

/** Remove by queue row id, or by mesh/run id within projectId. */
export function removeComputeJob(kind: unknown, id: unknown, projectId?: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const want = normId(id);
  if (!want) return snapshotComputeQueue();
  const before = Q.items.length;
  const was = Q.items.slice();
  Q.items = Q.items.filter((row) => {
    if (row.id === want) return false;
    if (!sameProject(row, projectId)) return true;
    if (kind === 'mesh') return !(row.kind === 'mesh' && normId(row.mesh_id) === want);
    if (kind === 'solve') return !(row.kind === 'solve' && normId(row.run_id) === want);
    if (!kind) {
      return !(normId(row.mesh_id) === want || normId(row.run_id) === want);
    }
    return true;
  });
  if (Q.items.length !== before) {
    persist();
    for (const row of was) {
      if (Q.items.includes(row)) continue;
      Q.holdTries.delete(row.id);
      logQueue('removed', row, `request ${String(kind || '')} ${want}`);
      leave(row, 'removed');
    }
  }
  return snapshotComputeQueue();
}

export function dropComputeJobsForMesh(meshId: unknown, projectId?: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const next = dropQueueJobsForMesh(Q.items, meshId, projectId);
  if (next.length !== Q.items.length) {
    Q.items = next;
    persist();
  }
  return snapshotComputeQueue();
}

/** Remove these rows; each leaves with `as` (a drop also shows a notice). */
function dropRows(hit: ComputeQueueItem[], reason: string, as: 'dropped' | 'skipped'): ComputeQueueItem[] {
  if (!hit.length) return [];
  Q.items = Q.items.filter((row) => !hit.includes(row));
  if (as === 'dropped') for (const row of hit) pushFailure(row, reason, 'dropped');
  persist();
  for (const row of hit) {
    Q.holdTries.delete(row.id);
    logQueue(as, row, reason);
    leave(row, as, reason);
  }
  return hit;
}

/**
 * Drop queued plugin cases matching the filter (a study or project deleted, a
 * plugin turned off). Project ids compare by folder. A study id is unique only in
 * its project, so a filter naming a study but no project drops nothing.
 */
export function dropFoamJobs(
  filter: { project_id?: unknown; plugin?: unknown; study_id?: unknown; job_id?: unknown },
  reason: string,
): ComputeQueueItem[] {
  ensureLoaded();
  const f = filter || {};
  if (normId(f.study_id) && !normId(f.project_id)) return [];
  const hit = Q.items.filter((row) => {
    if (row.kind !== 'foam') return false;
    if (normId(f.project_id) && !sameProjectFolder(row.project_id, f.project_id)) return false;
    if (normId(f.plugin) && (!row.foam || row.foam.plugin !== normId(f.plugin))) return false;
    if (normId(f.study_id) && (!row.foam || row.foam.study_id !== normId(f.study_id))) return false;
    if (normId(f.job_id) && row.job_id !== normId(f.job_id)) return false;
    return true;
  });
  return dropRows(hit, reason, 'dropped');
}

/** Row ids of every job queued in this project (by folder), any kind. */
export function computeRowsForProject(projectId: unknown): string[] {
  ensureLoaded();
  if (!normId(projectId)) return [];
  return Q.items.filter((row) => sameProjectFolder(row.project_id, projectId)).map((row) => row.id);
}

/** Remove rows by id: `dropped` (with a notice) or `skipped` (no notice). */
export function dropComputeRows(ids: unknown, reason: string, as: 'dropped' | 'skipped' = 'dropped'): ComputeQueueItem[] {
  ensureLoaded();
  const want = new Set((Array.isArray(ids) ? ids : []).map((x) => normId(x)).filter(Boolean));
  if (!want.size) return [];
  return dropRows(
    Q.items.filter((row) => want.has(row.id)),
    reason,
    as,
  );
}

/** A plugin study was renamed: its queued cases read "<title> · <case> · <plugin>". */
export function relabelFoamJobs(projectId: unknown, plugin: unknown, studyId: unknown, title: unknown): number {
  ensureLoaded();
  let n = 0;
  for (const row of Q.items) {
    if (row.kind !== 'foam' || !row.foam) continue;
    if (!sameProjectFolder(row.project_id, projectId) || row.foam.plugin !== normId(plugin) || row.foam.study_id !== normId(studyId)) continue;
    const parts = String(row.name || '').split(' · ');
    row.name = [String(title || ''), ...(parts.length >= 3 ? parts.slice(-2) : parts.slice(1))].join(' · ');
    n += 1;
  }
  if (n) persist();
  return n;
}

/** Jobs before this row (plus the running one); null when it is not queued. */
export function queueAheadOf(rowId: unknown): number | null {
  ensureLoaded();
  const i = Q.items.findIndex((row) => row.id === normId(rowId));
  if (i < 0) return null;
  return i + (slotBusy() ? 1 : 0);
}

/** The names of every queued case of one plugin, in every project (core solves of its analyses among them). */
export function queuedFoamNames(plugin: unknown): string[] {
  ensureLoaded();
  return Q.items.filter((row) => row.kind === 'foam' && !!row.foam && row.foam.plugin === normId(plugin)).map((row) => String(row.name || row.id));
}

/** Queued plugin cases of one plugin in one project. */
export function queuedFoamCount(projectId: unknown, plugin: unknown): number {
  ensureLoaded();
  return Q.items.filter(
    (row) => row.kind === 'foam' && !!row.foam && row.foam.plugin === normId(plugin) && sameProjectFolder(row.project_id, projectId),
  ).length;
}

export function queueHasRow(rowId: unknown): boolean {
  ensureLoaded();
  const want = normId(rowId);
  return !!want && Q.items.some((row) => row.id === want);
}

/** A notice the Queue chip shows (kept 15 minutes, 50 at most). Never throws. */
export function pushComputeNotice(entry: Partial<ComputeQueueFailure> & { name?: string; error?: string }): void {
  try {
    const kind: ComputeQueueKind =
      entry.kind === 'mesh' || entry.kind === 'solve' || entry.kind === 'foam' || entry.kind === 'geometry' ? entry.kind : 'solve';
    Q.failures.push({
      id: normId(entry.id) || newQueueId(),
      kind,
      mesh_id: entry.mesh_id ?? null,
      run_id: entry.run_id ?? null,
      simulation_id: entry.simulation_id ?? null,
      project_id: entry.project_id ?? null,
      name: String(entry.name || defaultName(kind)),
      error: noStop(String(entry.error || '')),
      at: Date.now(),
      ...(entry.job_id ? { job_id: entry.job_id } : {}),
      ...(entry.reason && entry.reason !== 'failed' ? { reason: entry.reason } : {}),
    });
    pruneFailures();
  } catch {
    /* a notice never breaks its caller */
  }
}

/**
 * A tab only lists (and drags) its own project's rows. Reorder just those rows
 * among the places they already hold, so another project's job keeps its place
 * instead of dropping to the back.
 */
function reorderWithinSlots(list: ComputeQueueItem[], ids: unknown): ComputeQueueItem[] {
  const want = (Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter(Boolean);
  const inSet = new Set(want);
  const moving = list.filter((row) => row.id && inSet.has(row.id));
  if (moving.length < 2) return list.slice();
  const ordered = orderedQueueItems(moving, want);
  let k = 0;
  return list.map((row) => (row.id && inSet.has(row.id) ? ordered[k++] : row));
}

export function reorderComputeQueue(ids: unknown): ComputeQueueSnapshot & { error?: string } {
  ensureLoaded();
  const next = reorderWithinSlots(Q.items, ids);
  if (queueHasMeshDepViolation(next)) {
    const snap = snapshotComputeQueue();
    return { ...snap, ok: false, error: 'A run cannot sit above the mesh it uses' };
  }
  Q.items = next;
  persist();
  return snapshotComputeQueue();
}

/** One line per queue decision, so a job that vanished can be traced. */
function logQueue(what: string, row: ComputeQueueItem | null | undefined, extra?: string): void {
  if (process.env.MAGNUSIM_QUEUE_QUIET === '1') return;
  const ref = row ? (row.kind === 'mesh' ? row.mesh_id : row.kind === 'foam' || row.kind === 'geometry' ? row.job_id : row.run_id) : '';
  const id = row ? `${row.kind} ${ref} (${row.project_id})` : '';
  console.info(`[CFD queue] ${what} ${id}${extra ? ' — ' + extra : ''}`);
}

function slotBusy(): boolean {
  return !!(Q.deps.isBusy && Q.deps.isBusy());
}

/** Work that goes before every queued row (the link recovery) took the free slot. */
function runFirst(): boolean {
  if (!Q.deps.runFirst) return false;
  try {
    return !!Q.deps.runFirst();
  } catch (e) {
    console.warn('[CFD queue] runFirst failed', e);
    return false;
  }
}

function meshGenerating(meshId: unknown, projectId: unknown): boolean {
  const id = normId(meshId);
  if (!id || !Q.deps.meshIsGenerating) return false;
  return !!Q.deps.meshIsGenerating(id, normId(projectId));
}

async function startRow(next: ComputeQueueItem): Promise<ComputeStartResult> {
  const deps = Q.deps;
  switch (next.kind) {
    case 'mesh':
      return deps.startMesh ? await deps.startMesh(next) : { ok: false };
    case 'solve':
      return deps.startSolve ? await deps.startSolve(next) : { ok: false };
    case 'foam':
      return deps.startFoam ? await deps.startFoam(next) : { ok: false };
    case 'geometry':
      return deps.startGeometry ? await deps.startGeometry(next) : { ok: false };
    default:
      return { missing: true };
  }
}

/**
 * A refused start keeps its place at the head and is tried again at 2, 4 and 6 s;
 * on the fourth refusal it leaves the queue with its reason. True when it left.
 */
function holdOrDrop(row: ComputeQueueItem, error: string): boolean {
  // Right after its mesh finishes a run can be refused for a moment, so try again a
  // few times while it keeps its place at the head. If it still cannot start, holding
  // it there would stall every job behind it in every project: take it off, say why,
  // and start the next one.
  const tries = (Q.holdTries.get(row.id) || 0) + 1;
  if (tries <= HOLD_RETRIES) {
    Q.holdTries.set(row.id, tries);
    scheduleComputeQueueKick(Q.holdRetryMs * tries);
    return false;
  }
  Q.holdTries.delete(row.id);
  Q.items = Q.items.filter((r) => r.id !== row.id);
  pushFailure(row, error || 'Could not start', 'failed');
  persist();
  leave(row, 'failed', error || 'Could not start');
  return true;
}

export async function kickComputeQueue(projectId?: string | null): Promise<ComputeQueueSnapshot> {
  ensureLoaded();
  // Any tab may ask for a kick, but the queue runs in its own order across
  // projects: the head starts, whichever project asked. projectId only scopes
  // the snapshot sent back.
  const scoped = projectId !== undefined && projectId !== null && projectId !== '';
  const want = scoped ? normId(projectId) : '';
  const snap = () => (scoped ? snapshotComputeQueue(want) : snapshotComputeQueue());
  if (Q.kicking) return snap();
  Q.kicking = true;
  /** The row whose start is in progress (a throw is charged to it). */
  let current: ComputeQueueItem | null = null;
  /** Projects of rows that deferred this kick: their later rows stay behind them. */
  const deferred = new Set<string>();
  try {
    for (;;) {
      current = null;
      if (slotBusy()) return snap();
      if (runFirst()) return snap();
      const next = Q.items.find((row) => !deferred.has(normId(row.project_id)));
      if (!next) return snap();
      if (next.kind === 'solve' && meshGenerating(next.mesh_id, next.project_id)) {
        return snap();
      }
      current = next;
      const started = await startRow(next);
      current = null;
      const action = queueKickAfterStart(started, slotBusy() || !!(started && started.ok));
      const error = started && started.error ? String(started.error) : '';
      logQueue(`start -> ${action}`, next, error);
      if (action === 'defer') {
        deferred.add(normId(next.project_id));
        continue;
      }
      if (action === 'skip') {
        Q.holdTries.delete(next.id);
        Q.items = Q.items.filter((row) => row.id !== next.id);
        persist();
        leave(next, 'skipped', error);
        continue;
      }
      if (action === 'fail') {
        Q.holdTries.delete(next.id);
        Q.items = Q.items.filter((row) => row.id !== next.id);
        pushFailure(next, error || 'Could not start', 'failed');
        persist();
        leave(next, 'failed', error || 'Could not start');
        continue;
      }
      if (action === 'hold') {
        if (holdOrDrop(next, error)) continue;
        return snap();
      }
      Q.holdTries.delete(next.id);
      if (action === 'dequeue') {
        Q.items = Q.items.filter((row) => row.id !== next.id);
        persist();
      } else if (action === 'retry') {
        scheduleComputeQueueKick(1500);
      }
      return snap();
    }
  } catch (e) {
    console.warn('[CFD queue] start threw', e instanceof Error ? e.message : String(e));
    const row = current;
    if (row) {
      if (Q.deps.holdsRow && safeHolds(row)) {
        // Its job started before the throw: it leaves as started, never to start again.
        Q.holdTries.delete(row.id);
        Q.items = Q.items.filter((r) => r.id !== row.id);
        persist();
        logQueue('started (threw after start)', row);
      } else if (Q.items[0] && Q.items[0].id === row.id) {
        if (holdOrDrop(row, START_THREW_ERROR)) scheduleComputeQueueKick(50);
      }
    }
    return snap();
  } finally {
    Q.kicking = false;
  }
}

function safeHolds(row: ComputeQueueItem): boolean {
  try {
    return !!(Q.deps.holdsRow && Q.deps.holdsRow(row));
  } catch {
    return false;
  }
}

export function scheduleComputeQueueKick(delay?: number): void {
  if (Q.kickTimer) clearTimeout(Q.kickTimer);
  Q.kickTimer = setTimeout(() => {
    Q.kickTimer = null;
    kickComputeQueue().catch(() => {});
  }, delay == null ? 250 : delay);
}
