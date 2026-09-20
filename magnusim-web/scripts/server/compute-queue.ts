/**
 * Disk-backed compute FIFO. The browser chip edits this list; Node starts
 * the next mesh/solve after the live slot frees. Closing a tab does not
 * drop queued work while the Magnusim window stays open.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WEB_ROOT } from '../python-env.js';

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
};

export type ComputeQueueDeps = {
  isBusy?: () => boolean;
  meshIsGenerating?: (meshId: string) => boolean;
  startMesh?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  startSolve?: (item: ComputeQueueItem) => ComputeStartResult | Promise<ComputeStartResult>;
  live?: () => ComputeLiveSnap | null;
};

export type ComputeQueueSnapshot = {
  ok: boolean;
  items: ComputeQueueItem[];
  live: ComputeLiveSnap | null;
};

const DEFAULT_PATH = join(WEB_ROOT, '.cache', 'compute-queue.json');

let filePath = DEFAULT_PATH;
let items: ComputeQueueItem[] = [];
let loaded = false;
let kicking = false;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let deps: ComputeQueueDeps = {};

function normId(value: unknown): string {
  return value == null || value === '' ? '' : String(value);
}

function jobKey(item: { kind?: unknown; mesh_id?: unknown; run_id?: unknown } | null | undefined): string {
  if (!item) return '';
  const kind = item.kind === 'mesh' || item.kind === 'solve' ? item.kind : '';
  const id = kind === 'mesh' ? normId(item.mesh_id) : normId(item.run_id);
  return kind && id ? `${kind}:${id}` : '';
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

function queueIndexOfMesh(list: ComputeQueueItem[], meshId: unknown): number {
  const want = normId(meshId);
  if (!want) return -1;
  return list.findIndex((row) => row && row.kind === 'mesh' && normId(row.mesh_id) === want);
}

export function queueHasMeshDepViolation(list: ComputeQueueItem[] | null | undefined): boolean {
  const rows = Array.isArray(list) ? list : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.kind !== 'solve' || !normId(row.mesh_id)) continue;
    const meshAt = queueIndexOfMesh(rows, row.mesh_id);
    if (meshAt >= 0 && i < meshAt) return true;
  }
  return false;
}

function insertSolveAfterMesh(list: ComputeQueueItem[], item: ComputeQueueItem): ComputeQueueItem[] {
  const next = list.slice();
  const at = queueIndexOfMesh(next, item.mesh_id);
  if (at < 0) next.push(item);
  else next.splice(at + 1, 0, item);
  return next;
}

function insertMeshBeforeDependentSolves(list: ComputeQueueItem[], item: ComputeQueueItem): ComputeQueueItem[] {
  const next = list.slice();
  const meshId = normId(item.mesh_id);
  const firstSolve = meshId
    ? next.findIndex((row) => row && row.kind === 'solve' && normId(row.mesh_id) === meshId)
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

function dropQueueJobsForMesh(list: ComputeQueueItem[], meshId: unknown): ComputeQueueItem[] {
  const id = normId(meshId);
  if (!id) return list.slice();
  return list.filter((row) => {
    if (row.kind === 'mesh' && normId(row.mesh_id) === id) return false;
    if (row.kind === 'solve' && normId(row.mesh_id) === id) return false;
    return true;
  });
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

export function snapshotComputeQueue(): ComputeQueueSnapshot {
  ensureLoaded();
  const live = deps.live ? deps.live() : null;
  return {
    ok: true,
    items: items.slice(),
    live: live && live.kind ? live : null,
  };
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
    const meshAlreadyQueued = items.some((row) => row.kind === 'mesh' && normId(row.mesh_id) === normId(item.mesh_id));
    items = meshAlreadyQueued ? insertSolveAfterMesh(items, item) : [item, ...items];
  } else {
    items = insertSolveAfterMesh(items, item);
  }
  persist();
  return { ok: true, item, items: items.slice() };
}

export function mergeComputeQueueItems(incoming: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  items = mergeStoredQueueItems(items, parseStoredQueueItems(incoming));
  persist();
  return snapshotComputeQueue();
}

export function removeComputeJob(kind: unknown, id: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const want = normId(id);
  if (!want) return snapshotComputeQueue();
  const before = items.length;
  items = items.filter((row) => {
    if (row.id === want) return false;
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

export function dropComputeJobsForMesh(meshId: unknown): ComputeQueueSnapshot {
  ensureLoaded();
  const next = dropQueueJobsForMesh(items, meshId);
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

function meshGenerating(meshId: unknown): boolean {
  const id = normId(meshId);
  if (!id || !deps.meshIsGenerating) return false;
  return !!deps.meshIsGenerating(id);
}

export async function kickComputeQueue(): Promise<ComputeQueueSnapshot> {
  ensureLoaded();
  if (kicking) return snapshotComputeQueue();
  kicking = true;
  try {
    for (;;) {
      if (slotBusy()) return snapshotComputeQueue();
      const next = items[0];
      if (!next) return snapshotComputeQueue();
      if (next.kind === 'solve' && meshGenerating(next.mesh_id)) {
        return snapshotComputeQueue();
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
      return snapshotComputeQueue();
    }
  } catch {
    return snapshotComputeQueue();
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
