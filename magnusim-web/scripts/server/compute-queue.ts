/**
 * Disk-backed compute FIFO. The browser chip edits this list; Node starts
 * the next mesh/solve after the live slot frees. Closing a tab does not
 * drop queued work while the Magnusim window stays open.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WEB_ROOT } from '../python-env.js';
import { PROJECTS_ROOT } from '../project-isolation.js';

export type ComputeQueueKind = 'mesh' | 'solve';

export type ComputeQueueItem = {
  id: string;
  kind: ComputeQueueKind;
  mesh_id?: string | null;
  run_id?: string | null;
  simulation_id?: string | null;
  project_id?: string | null;
  name?: string;
  settings?: Record<string, unknown> | null;
};

export type ComputeStartResult = {
  ok?: boolean;
  busy?: boolean;
  missing?: boolean;
  skip?: boolean;
};

export type ComputeLiveSnap = {
  kind: ComputeQueueKind | null;
  mesh_id?: string | null;
  run_id?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  mesh_name?: string | null;
  generate_id?: string | null;
  path_kind?: string | null;
  started_at?: string | null;
};

export type ComputeQueueDeps = {
  isBusy?: () => boolean;
  meshIsGenerating?: (meshId: string, projectId: string) => boolean;
  startMesh?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  startSolve?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  live?: () => ComputeLiveSnap | null;
};

export type ComputeQueueSnapshot = {
  ok: boolean;
  items: Array<ComputeQueueItem & { position?: number }>;
  /** The running job, only when it belongs to the asked project. */
  live: ComputeLiveSnap | null;
  /** The running job in any project: what a queued row is waiting on. */
  busy?: ComputeLiveSnap | null;
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

let filePath = DEFAULT_PATH;
let items: ComputeQueueItem[] = [];
let loaded = false;
let kicking = false;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let deps: ComputeQueueDeps = {};

function normId(value: unknown): string {
  return value == null || value === '' ? '' : String(value);
}

/** Mesh and run ids repeat across projects (every project has a mesh_1), so the project is part of the key. */
function jobKey(
  item: { kind?: unknown; mesh_id?: unknown; run_id?: unknown; project_id?: unknown } | null | undefined,
): string {
  if (!item) return '';
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
): 'retry' | 'dequeue' | 'hold' | 'skip' {
  if (result && result.busy) return 'retry';
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

function insertSolveAfterMesh(list: ComputeQueueItem[], item: ComputeQueueItem): ComputeQueueItem[] {
  const next = list.slice();
  const at = queueIndexOfMesh(next, item.mesh_id, item.project_id);
  if (at < 0) next.push(item);
  else next.splice(at + 1, 0, item);
  return next;
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

function parseStoredQueueItems(raw: unknown): ComputeQueueItem[] {
  let stored = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return (Array.isArray(stored) ? stored : [])
    .map((row) => normalizeItem(row))
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
  bodyExtra?: { error?: unknown } | null;
} | null | undefined): ComputeStartResult {
  if (started && started.ok) return { ok: true };
  const status = started && started.status;
  const err = String((started && started.bodyExtra && started.bodyExtra.error) || '');
  if (status === 409 || /already running|already in progress|already solving/i.test(err)) {
    if (/already finished/i.test(err)) return { ok: false, skip: true };
    if (/already solving/i.test(err)) return { ok: false, skip: true };
    return { ok: false, busy: true };
  }
  if (status === 404 || /not found|was deleted|mesh_id required/i.test(err)) {
    return { ok: false, missing: true };
  }
  return { ok: false };
}

function normalizeItem(raw: unknown): ComputeQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
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
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ items }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(filePath)) {
    items = [];
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { items?: unknown } | unknown;
    const list = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown }).items
      : raw;
    items = parseStoredQueueItems(list);
  } catch {
    items = [];
  }
}

export function configureComputeQueue(next: ComputeQueueDeps): void {
  deps = { ...deps, ...next };
}

export function resetComputeQueueForTests(opts?: {
  filePath?: string;
  items?: ComputeQueueItem[] | null;
  deps?: ComputeQueueDeps;
  reload?: boolean;
}): void {
  if (kickTimer) {
    clearTimeout(kickTimer);
    kickTimer = null;
  }
  kicking = false;
  filePath = opts && opts.filePath ? opts.filePath : DEFAULT_PATH;
  deps = (opts && opts.deps) || {};
  if (opts && opts.reload) {
    loaded = false;
    items = [];
    return;
  }
  loaded = true;
  const seed = opts && Array.isArray(opts.items) ? opts.items : [];
  items = seed.map((row) => normalizeItem(row)).filter((row): row is ComputeQueueItem => !!row);
  persist();
}

export function snapshotComputeQueue(projectId?: string | null): ComputeQueueSnapshot {
  ensureLoaded();
  const raw = deps.live ? deps.live() : null;
  const live = raw && raw.kind ? raw : null;
  if (projectId === undefined) {
    return { ok: true, items: items.slice(), live, busy: live };
  }
  const want = normId(projectId);
  const rows = want
    ? items.map((row, i) => ({ ...row, position: i + 1 })).filter((row) => normId(row.project_id) === want)
    : [];
  const liveOk = live && want && normId(live.project_id) === want ? live : null;
  return { ok: true, items: rows, live: liveOk, busy: live };
}

export function enqueueComputeJob(
  raw: unknown,
  opts?: { hasMaterial?: boolean; meshGenerating?: boolean },
): { ok: boolean; error?: string; item?: ComputeQueueItem; items: ComputeQueueItem[] } {
  ensureLoaded();
  const item = normalizeItem(raw);
  if (!item) {
    return { ok: false, error: 'kind must be mesh or solve', items: items.slice() };
  }
  if (!normId(item.project_id)) {
    return { ok: false, error: 'project_id required', items: items.slice() };
  }
  if (item.kind === 'solve' && opts && opts.hasMaterial === false) {
    return { ok: false, error: 'Assign Air to a volume first', items: items.slice() };
  }
  const existing = items.find((row) => jobKey(row) === jobKey(item));
  if (existing) {
    return { ok: true, item: existing, items: items.slice() };
  }
  if (item.kind === 'mesh') {
    items = insertMeshBeforeDependentSolves(items, item);
  } else if (opts && opts.meshGenerating) {
    const meshAlreadyQueued = queueIndexOfMesh(items, item.mesh_id, item.project_id) >= 0;
    items = meshAlreadyQueued ? insertSolveAfterMesh(items, item) : [item, ...items];
  } else {
    items = insertSolveAfterMesh(items, item);
  }
  persist();
  return { ok: true, item, items: items.slice() };
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
  const live = deps.live ? deps.live() : null;
  const liveKey = live && live.kind ? jobKey(live) : '';
  const rows = parseStoredQueueItems(incoming).filter((row) => !liveKey || jobKey(row) !== liveKey);
  items = mergeStoredQueueItems(items, rows);
  persist();
  return snapshotComputeQueue();
}

/** Remove by queue row id, or by mesh/run id within projectId. */
export function removeComputeJob(kind: unknown, id: unknown, projectId?: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const want = normId(id);
  if (!want) return snapshotComputeQueue();
  const before = items.length;
  items = items.filter((row) => {
    if (row.id === want) return false;
    if (!sameProject(row, projectId)) return true;
    if (kind === 'mesh') return !(row.kind === 'mesh' && normId(row.mesh_id) === want);
    if (kind === 'solve') return !(row.kind === 'solve' && normId(row.run_id) === want);
    if (!kind) {
      return !(normId(row.mesh_id) === want || normId(row.run_id) === want);
    }
    return true;
  });
  if (items.length !== before) persist();
  return snapshotComputeQueue();
}

export function dropComputeJobsForMesh(meshId: unknown, projectId?: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const next = dropQueueJobsForMesh(items, meshId, projectId);
  if (next.length !== items.length) {
    items = next;
    persist();
  }
  return snapshotComputeQueue();
}

export function reorderComputeQueue(ids: unknown): ComputeQueueSnapshot & { error?: string } {
  ensureLoaded();
  const next = orderedQueueItems(items, ids);
  if (queueHasMeshDepViolation(next)) {
    const snap = snapshotComputeQueue();
    return { ...snap, ok: false, error: 'A run cannot sit above the mesh it uses' };
  }
  items = next;
  persist();
  return snapshotComputeQueue();
}

function slotBusy(): boolean {
  return !!(deps.isBusy && deps.isBusy());
}

function meshGenerating(meshId: unknown, projectId: unknown): boolean {
  const id = normId(meshId);
  if (!id || !deps.meshIsGenerating) return false;
  return !!deps.meshIsGenerating(id, normId(projectId));
}

export async function kickComputeQueue(projectId?: string | null): Promise<ComputeQueueSnapshot> {
  ensureLoaded();
  const scoped = projectId !== undefined;
  const want = scoped ? normId(projectId) : '';
  const snap = () => (scoped ? snapshotComputeQueue(want) : snapshotComputeQueue());
  if (kicking) return snap();
  kicking = true;
  try {
    for (;;) {
      if (slotBusy()) return snap();
      const next = scoped ? items.find((row) => normId(row.project_id) === want) : items[0];
      if (!next) return snap();
      if (next.kind === 'solve' && meshGenerating(next.mesh_id, next.project_id)) {
        return snap();
      }
      const started =
        next.kind === 'mesh'
          ? deps.startMesh
            ? await deps.startMesh(next)
            : { ok: false }
          : deps.startSolve
            ? await deps.startSolve(next)
            : { ok: false };
      const action = queueKickAfterStart(started, slotBusy() || !!(started && started.ok));
      if (action === 'skip') {
        items = items.filter((row) => row.id !== next.id);
        persist();
        continue;
      }
      if (action === 'dequeue') {
        items = items.filter((row) => row.id !== next.id);
        persist();
      } else if (action === 'retry') {
        scheduleComputeQueueKick(1500);
      }
      return snap();
    }
  } catch {
    return snap();
  } finally {
    kicking = false;
  }
}

export function scheduleComputeQueueKick(delay?: number): void {
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    kickTimer = null;
    kickComputeQueue().catch(() => {});
  }, delay == null ? 250 : delay);
}
