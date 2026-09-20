export type QueueItem = { id?: string | number | null } & Record<string, unknown>;

export type QueueRowBox = {
  id: string | number;
  top: number;
  height: number;
};

export type QueueInsert = {
  ids: string[];
  destId: string;
  before: boolean;
  unchanged: boolean;
};

/**
 * Reorder the compute queue by job id. Unknown ids are ignored; leftover
 * items (not listed) stay at the end so persist never drops a job.
 */
export function orderedQueueItems<T extends QueueItem>(items: T[] | null | undefined, ids: unknown): T[] {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const byId = new Map<string, T>();
  for (const rec of list) {
    if (rec.id == null || rec.id === '') continue;
    byId.set(String(rec.id), rec);
  }
  const next: T[] = [];
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
    const id = rec.id == null ? '' : String(rec.id);
    if (!id || seen.has(id)) continue;
    next.push(rec);
    seen.add(id);
  }
  return next;
}

/**
 * Insert `dragId` before the first row whose vertical midpoint is below
 * `clientY`, otherwise append. `rows` are `{ id, top, height }` in current order.
 */
export function queueInsertFromY(
  rows: QueueRowBox[] | null | undefined,
  dragId: unknown,
  clientY: number
): QueueInsert | null {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id != null && row.id !== '');
  if (list.length < 2) return null;
  const drag = String(dragId || '');
  if (!drag) return null;
  const current = list.map((row) => String(row.id));
  if (!current.includes(drag)) return null;
  let beforeId: string | null = null;
  for (const row of list) {
    if (String(row.id) === drag) continue;
    const top = Number(row.top);
    const height = Number(row.height);
    if (!Number.isFinite(top) || !Number.isFinite(height)) continue;
    if (clientY < top + height / 2) {
      beforeId = String(row.id);
      break;
    }
  }
  const next = current.filter((id) => id !== drag);
  if (beforeId) {
    const at = next.indexOf(beforeId);
    if (at < 0) next.push(drag);
    else next.splice(at, 0, drag);
  } else {
    next.push(drag);
  }
  const unchanged = next.length === current.length && next.every((id, i) => id === current[i]);
  return {
    ids: next,
    destId: beforeId || String(list[list.length - 1].id),
    before: !!beforeId,
    unchanged,
  };
}

function escapeAttr(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '');
}

export type QueueDragApi = {
  list?: HTMLElement | null;
  applyOrder: (ids: string[]) => unknown;
  setDragging?: (on: boolean) => void;
  orderAllowed?: (ids: string[]) => boolean;
};

/** Pointer drag on the Queue chip. Drop rewrites the real job array via `applyOrder`. */
export function bindJobQueuePointerDrag(host: HTMLElement, api: QueueDragApi): () => void {
  const list = api.list || host;
  let dragId: string | null = null;
  let dragInsert: QueueInsert | null = null;
  let startY = 0;
  let dragging = false;

  const rowsFromDom = () =>
    [...list.querySelectorAll(':scope > li[data-q-id]')].map((node) => {
      const box = node.getBoundingClientRect();
      return { id: String(node.getAttribute('data-q-id') || ''), top: box.top, height: box.height };
    });

  const clearMarks = () => {
    list.querySelectorAll('.is-dragging, .is-drag-over, .is-drag-over-after').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drag-over', 'is-drag-over-after');
    });
  };

  const reset = () => {
    dragId = null;
    dragInsert = null;
    dragging = false;
    clearMarks();
    api.setDragging?.(false);
  };

  const onDown = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.closest('[data-q-remove]')) return;
    const li = t.closest('li[data-q-id]') as HTMLElement | null;
    if (!li || !host.contains(li)) return;
    dragId = li.getAttribute('data-q-id');
    startY = e.clientY;
    dragInsert = null;
    dragging = false;
  };

  const onMove = (ev: Event) => {
    const e = ev as PointerEvent;
    if (!dragId) return;
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < 5) return;
      dragging = true;
      api.setDragging?.(true);
      const li = list.querySelector('li[data-q-id="' + escapeAttr(dragId) + '"]');
      if (li) li.classList.add('is-dragging');
      try {
        host.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    e.preventDefault();
    const insert = queueInsertFromY(rowsFromDom(), dragId, e.clientY);
    const allowed = insert && !insert.unchanged && (!api.orderAllowed || api.orderAllowed(insert.ids));
    dragInsert = insert && !allowed ? { ...insert, unchanged: true } : insert;
    list.querySelectorAll('.is-drag-over, .is-drag-over-after').forEach((el) => {
      el.classList.remove('is-drag-over', 'is-drag-over-after');
    });
    if (insert && insert.destId && allowed) {
      const dest = list.querySelector('li[data-q-id="' + escapeAttr(String(insert.destId)) + '"]');
      if (dest) dest.classList.add(insert.before ? 'is-drag-over' : 'is-drag-over-after');
    }
  };

  const onUp = (ev: Event) => {
    if (!dragId) return;
    const e = ev as PointerEvent;
    const insert = dragInsert || queueInsertFromY(rowsFromDom(), dragId, e.clientY);
    const ids = dragging && insert && !insert.unchanged ? insert.ids : null;
    const allowed = !ids || !api.orderAllowed || api.orderAllowed(ids);
    reset();
    if (ids && allowed) api.applyOrder(ids);
  };

  const onCancel = () => {
    if (!dragId) return;
    reset();
  };

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onCancel);
  host.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return () => {
    host.removeEventListener('pointerdown', onDown);
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointercancel', onCancel);
    host.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
}

function normId(value: unknown): string {
  return value == null || value === '' ? '' : String(value);
}

function uniqueIds(values: unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values || []) {
    const id = normId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Pick the mesh a run should queue against. Prefer the saved assignment,
 * then the dropdown, then the mesh that is generating / the only study mesh.
 */
export function resolveRunMeshId(opts: {
  runMeshId?: unknown;
  selectedMeshId?: unknown;
  liveMeshId?: unknown;
  queuedMeshIds?: unknown[];
  studyMeshIds?: unknown[];
}): string {
  const run = normId(opts && opts.runMeshId);
  if (run) return run;
  const selected = normId(opts && opts.selectedMeshId);
  if (selected) return selected;
  const live = normId(opts && opts.liveMeshId);
  if (live) return live;
  const queued = uniqueIds(opts && opts.queuedMeshIds);
  if (queued.length === 1) return queued[0];
  const study = uniqueIds(opts && opts.studyMeshIds);
  if (study.length === 1) return study[0];
  return '';
}

/** True when this mesh is generating now or already sitting in the queue. */
export function meshIsQueuedOrGenerating(opts: {
  meshId?: unknown;
  liveMeshId?: unknown;
  queuedMeshIds?: unknown[];
  generatingIds?: unknown[];
}): boolean {
  const id = normId(opts && opts.meshId);
  if (!id) return false;
  if (normId(opts && opts.liveMeshId) === id) return true;
  if (uniqueIds(opts && opts.queuedMeshIds).includes(id)) return true;
  if (uniqueIds(opts && opts.generatingIds).includes(id)) return true;
  return false;
}

/** A solve can sit in the queue only when Air is assigned to a volume. */
export function canQueueSolveJob(opts: {
  hasRun?: boolean;
  running?: boolean;
  done?: boolean;
  meshReady?: boolean;
  meshSoon?: boolean;
  hasMaterial?: boolean;
}): boolean {
  return !!(
    opts &&
    opts.hasRun &&
    !opts.running &&
    !opts.done &&
    (opts.meshReady || opts.meshSoon) &&
    opts.hasMaterial
  );
}

/**
 * After a queued start attempt: keep the job at the front on validation
 * failure so the next mesh/run cannot jump the line.
 */
export function queueKickAfterStart(
  result: { ok?: boolean; busy?: boolean; missing?: boolean; skip?: boolean } | null | undefined,
  computeRunning: boolean
): 'retry' | 'dequeue' | 'hold' | 'skip' {
  if (result && result.busy) return 'retry';
  if (result && (result.missing || result.skip)) return 'skip';
  if (result && result.ok === false) return 'hold';
  if (computeRunning) return 'dequeue';
  return 'hold';
}

export type QueueDepItem = QueueItem & {
  kind?: string | null;
  mesh_id?: string | number | null;
  run_id?: string | number | null;
  project_id?: string | number | null;
};

export function queueIndexOfMesh(items: QueueDepItem[] | null | undefined, meshId: unknown): number {
  const want = meshId == null || meshId === '' ? '' : String(meshId);
  if (!want) return -1;
  return (items || []).findIndex((row) => row && row.kind === 'mesh' && String(row.mesh_id) === want);
}

/** True when a solve sits before the queued generate of the mesh it uses. */
export function queueHasMeshDepViolation(items: QueueDepItem[] | null | undefined): boolean {
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || row.kind !== 'solve' || row.mesh_id == null || row.mesh_id === '') continue;
    const meshAt = queueIndexOfMesh(list, row.mesh_id);
    if (meshAt >= 0 && i < meshAt) return true;
  }
  return false;
}

/** Place a solve after its mesh job when that mesh is already queued. */
export function insertSolveAfterMesh<T extends QueueDepItem>(items: T[] | null | undefined, item: T): T[] {
  const list = Array.isArray(items) ? items.slice() : [];
  const at = queueIndexOfMesh(list, item && item.mesh_id);
  if (at < 0) list.push(item);
  else list.splice(at + 1, 0, item);
  return list;
}

/** Place a mesh generate before any queued solve that uses it. */
export function insertMeshBeforeDependentSolves<T extends QueueDepItem>(items: T[] | null | undefined, item: T): T[] {
  const list = Array.isArray(items) ? items.slice() : [];
  const meshId = item && item.mesh_id != null ? String(item.mesh_id) : '';
  const firstSolve = meshId
    ? list.findIndex((row) => row && row.kind === 'solve' && String(row.mesh_id) === meshId)
    : -1;
  if (firstSolve < 0) list.push(item);
  else list.splice(firstSolve, 0, item);
  return list;
}

function sameCasePathKey(a: unknown, b: unknown): boolean {
  const n = (p: unknown) => String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const left = n(a);
  const right = n(b);
  return !!left && left === right;
}

/**
 * Opening Results must not POST /api/case/attach over a live mesh generate
 * (that case is the mesher's). Fields still load from the run folder via ?case=.
 */
export function resultsAttachStealsServerCase(opts?: { meshGenerateLive?: boolean }): boolean {
  return !opts?.meshGenerateLive;
}

/** First Results open must not sit behind another run's attach/warmup. */
export const RESULTS_PREFETCH_WAIT_MS = 2500;
export const RESULTS_ATTACH_WAIT_MS = 8000;
export const RESULTS_WARMUP_MS = 20000;

/** Background prefetch must not steal /api/case while a solve is writing frames. */
export function resultsPrefetchMayStealAttach(opts?: {
  attachRequested?: boolean;
  resultsViewOpen?: boolean;
  meshInspectOpen?: boolean;
  meshGenerateLive?: boolean;
  catalogSolving?: boolean;
}): boolean {
  if (!opts?.attachRequested) return false;
  if (opts.resultsViewOpen || opts.meshInspectOpen) return false;
  if (opts.meshGenerateLive) return false;
  if (opts.catalogSolving) return false;
  return true;
}

/** Opening Results waits this run's inflight only — never the whole prefetch queue. */
export function resultsOpenWaitsFullPrefetchQueue(): boolean {
  return false;
}

/** Wait for an in-flight attach only when it is already this case. */
export function resultsAttachWaitMs(opts?: { sameCaseAlreadyAttaching?: boolean }): number {
  return opts?.sameCaseAlreadyAttaching ? RESULTS_ATTACH_WAIT_MS : 0;
}

/** A live write that has only U or only p is not a readable frame. */
export function foamTimeDirIsComplete(files?: string[] | null): boolean {
  const names = new Set((Array.isArray(files) ? files : []).map((n) => String(n || '')));
  const hasU = names.has('U') || names.has('U.gz');
  const hasP = names.has('p') || names.has('p.gz');
  return hasU && hasP;
}

export function pickReadyResultTime(times?: Array<string | number> | null): string {
  const list = (Array.isArray(times) ? times : []).map((t) => String(t)).filter(Boolean);
  return list.length ? list[list.length - 1] : '';
}

export function previousResultTime(
  times?: Array<string | number> | null,
  current?: unknown
): string {
  const list = (Array.isArray(times) ? times : []).map((t) => String(t)).filter(Boolean);
  if (list.length < 2) return '';
  const cur = current != null && String(current) !== '' ? String(current) : list[list.length - 1];
  const idx = list.indexOf(cur);
  if (idx > 0) return list[idx - 1];
  return list[list.length - 2];
}

/**
 * A poll must not call openRunResults again while that run is already
 * opening or shown — the second call toggles the view closed.
 */
export function liveFramesShouldOpenResults(opts?: {
  resultsViewOpen?: boolean;
  resultsRunId?: unknown;
  openingRunId?: unknown;
  selectedKey?: unknown;
  runId?: unknown;
}): boolean {
  const id = opts && opts.runId != null && String(opts.runId) !== '' ? String(opts.runId) : '';
  if (!id) return false;
  if (opts && opts.resultsViewOpen) return false;
  if (opts && String(opts.openingRunId || '') === id) return false;
  if (opts && String(opts.resultsRunId || '') === id) return false;
  return String((opts && opts.selectedKey) || '') === 'runresults:' + id;
}

/** Live / finished transient copy: "15 / 30 frames" or "3 frames". */
export function transientFrameCountLabel(opts?: {
  nSaved?: unknown;
  writeCount?: unknown;
}): string {
  const n = Math.max(0, Math.round(Number(opts && opts.nSaved) || 0));
  const total = Math.max(0, Math.round(Number(opts && opts.writeCount) || 0));
  if (total > 0) return n + ' / ' + total + ' frames';
  if (n <= 0) return '';
  return n + (n === 1 ? ' frame' : ' frames');
}

/** True when the solver has already produced time, residuals, or saved frames. */
export function runHasSolveProgress(rec?: {
  sim_time?: unknown;
  iteration?: unknown;
  n_steps?: unknown;
  n_saved_times?: unknown;
  last_saved_iteration?: unknown;
  residuals?: unknown;
  saved_times?: unknown;
  live_saved_times?: unknown;
  co_max?: unknown;
} | null): boolean {
  if (!rec) return false;
  const simT = Number(rec.sim_time != null ? rec.sim_time : rec.iteration);
  if (Number.isFinite(simT) && simT > 0) return true;
  if (Number(rec.n_steps) > 0) return true;
  if (Number(rec.n_saved_times) > 0) return true;
  if (Number(rec.last_saved_iteration) > 0) return true;
  if (Array.isArray(rec.residuals) && rec.residuals.length) return true;
  if (Array.isArray(rec.saved_times) && rec.saved_times.some((t) => Number(t) > 0)) return true;
  if (Array.isArray(rec.live_saved_times) && rec.live_saved_times.length) return true;
  if (Number.isFinite(Number(rec.co_max)) && Number(rec.co_max) > 0) return true;
  return false;
}

/** Keep reconstruct/copy/stopping; never leave a live run on Starting once it has progress. */
export function solveDisplayStage(
  rec?: {
    stage?: unknown;
    sim_time?: unknown;
    iteration?: unknown;
    n_steps?: unknown;
    n_saved_times?: unknown;
    last_saved_iteration?: unknown;
    residuals?: unknown;
    saved_times?: unknown;
    live_saved_times?: unknown;
    co_max?: unknown;
  } | null
): string | null {
  const stage = rec && rec.stage != null ? String(rec.stage) : '';
  if (stage === 'reconstruct' || stage === 'copy' || stage === 'stopping') return stage;
  if (runHasSolveProgress(rec) && (!stage || stage === 'starting' || stage === 'decompose')) return 'solve';
  return stage || null;
}

export function runStatusIsSolving(status?: unknown): boolean {
  const st = String(status || '');
  return st === 'running' || st === 'starting';
}

/**
 * A leftover in-memory solve handle is not "still running" once the catalog
 * row is terminal. Kick uses this so a finished solve cannot stall the queue.
 */
export function solveHandleStillLive(opts?: {
  liveKind?: unknown;
  liveRunId?: unknown;
  starting?: boolean;
  catalogRows?: Array<LiveSolveRow | null | undefined> | null;
}): boolean {
  if (opts && opts.starting) return true;
  if (!opts || opts.liveKind !== 'solve') return false;
  const id = opts.liveRunId != null && String(opts.liveRunId) !== '' ? String(opts.liveRunId) : '';
  const rows = (Array.isArray(opts.catalogRows) ? opts.catalogRows : []).filter(
    (r): r is LiveSolveRow => !!r
  );
  if (id) {
    const match = rows.find((r) => String(r.id ?? '') === id || String(r.run_id ?? '') === id);
    if (match) return runStatusIsSolving(match.status);
    return true;
  }
  return catalogSolvingRuns(rows).length > 0;
}

export type LiveSolveRow = {
  status?: unknown;
  id?: unknown;
  run_id?: unknown;
  n_saved_times?: unknown;
  last_saved_iteration?: unknown;
  sim_time?: unknown;
};

export function catalogSolvingRuns<T extends LiveSolveRow>(
  rows?: Array<T | null | undefined> | null
): T[] {
  return (Array.isArray(rows) ? rows : []).filter((r): r is T => !!(r && runStatusIsSolving(r.status)));
}

export function runDisplayedSimTime(rec?: {
  sim_time?: unknown;
  last_saved_iteration?: unknown;
} | null): number {
  const t = Number(rec && rec.sim_time);
  const last = Number(rec && rec.last_saved_iteration);
  return Math.max(Number.isFinite(t) && t > 0 ? t : 0, Number.isFinite(last) && last > 0 ? last : 0);
}

export function liveSolveScore(rec?: LiveSolveRow | null): number {
  if (!rec) return 0;
  return (Number(rec.n_saved_times) || 0) * 1000 + runDisplayedSimTime(rec);
}

/** Home / hydrate must not hide the solve the user was watching behind a sibling. */
export function pickLiveSolveFromCatalog<T extends LiveSolveRow>(
  rows?: Array<T | null | undefined> | null,
  preferId?: unknown
): T | null {
  const solving = catalogSolvingRuns(rows);
  if (!solving.length) return null;
  const pref = preferId != null && String(preferId) !== '' ? String(preferId) : '';
  const pinned = pref
    ? solving.find((r) => String(r.id ?? '') === pref || String(r.run_id ?? '') === pref) || null
    : null;
  const ranked = solving.slice().sort((a, b) => liveSolveScore(b) - liveSolveScore(a));
  if (ranked[0] && liveSolveScore(ranked[0]) > 0) return ranked[0];
  return pinned || ranked[0] || null;
}

/** A lost in-memory handle is not "the solve finished" if a catalog row is still live. */
export function shouldKickQueueAfterLiveHandleLost(opts?: {
  hadLiveId?: unknown;
  nextLiveId?: unknown;
  catalogRows?: Array<LiveSolveRow | null | undefined> | null;
}): boolean {
  if (!(opts && opts.hadLiveId) || (opts && opts.nextLiveId)) return false;
  return catalogSolvingRuns(opts.catalogRows).length === 0;
}

/** True when a run has at least one saved time/iteration to open. */
export function runHasVisibleResults(rec?: {
  status?: unknown;
  has_results?: unknown;
  n_saved_times?: unknown;
  last_saved_iteration?: unknown;
  case_dir?: unknown;
  prepare_run?: { case_dir?: unknown } | null;
} | null): boolean {
  if (!rec) return false;
  const n = Number(rec.n_saved_times);
  if (Number.isFinite(n) && n > 0) return true;
  const last = Number(rec.last_saved_iteration);
  if (Number.isFinite(last) && last > 0) return true;
  if (rec.has_results === true) return true;
  const hasCase = !!(rec.case_dir || (rec.prepare_run && rec.prepare_run.case_dir));
  return String(rec.status || '') === 'done' && hasCase;
}

/** Merge a catalog refresh so a settings save cannot drop mesh or results. */
export function mergeRunCatalogRow<T extends Record<string, unknown>>(
  prev: T | null | undefined,
  next: T | null | undefined
): T | null {
  if (!next) return (prev as T) || null;
  if (!prev) return next;
  const nSaved = Math.max(Number(next.n_saved_times) || 0, Number(prev.n_saved_times) || 0);
  const lastNext = Number(next.last_saved_iteration);
  const lastPrev = Number(prev.last_saved_iteration);
  const last = Number.isFinite(lastNext) && Number.isFinite(lastPrev)
    ? Math.max(lastNext, lastPrev)
    : Number.isFinite(lastNext)
      ? lastNext
      : Number.isFinite(lastPrev)
        ? lastPrev
        : next.last_saved_iteration ?? prev.last_saved_iteration;
  const simPrev = Number(prev.sim_time);
  const simNext = Number(next.sim_time);
  const simTime = Math.max(
    Number.isFinite(simPrev) && simPrev > 0 ? simPrev : 0,
    Number.isFinite(simNext) && simNext > 0 ? simNext : 0,
    Number.isFinite(Number(last)) && Number(last) > 0 ? Number(last) : 0
  );
  const merged = {
    ...prev,
    ...next,
    mesh_id: next.mesh_id || prev.mesh_id,
    mesh_name: next.mesh_name || prev.mesh_name,
    case_dir: next.case_dir || prev.case_dir,
    has_results: !!(
      next.has_results ||
      prev.has_results ||
      nSaved > 0 ||
      (Number.isFinite(Number(last)) && Number(last) > 0)
    ),
    n_saved_times: nSaved || next.n_saved_times || prev.n_saved_times,
    last_saved_iteration: last,
    sim_time: simTime,
  } as T;
  const shown = solveDisplayStage(merged);
  if (shown) (merged as T & { stage: string }).stage = shown;
  return merged;
}

/**
 * Start should queue only for a different live job or a mesh that is
 * still generating. A run's own "Starting…" flag is not another job.
 */
export function startShouldEnqueue(opts?: {
  otherJobRunning?: boolean;
  waitForMesh?: boolean;
  sameRunStillSolving?: boolean;
}): boolean {
  if (!opts) return false;
  return !!(opts.waitForMesh || opts.otherJobRunning || opts.sameRunStillSolving);
}

/**
 * Keep a finished run's Results view up while a different run is started
 * from the queue. Starting the same run still leaves Results.
 */
export function keepResultsWhileStartingRun(opts?: {
  resultsOpen?: boolean;
  resultsRunId?: unknown;
  selectedRunId?: unknown;
  startingRunId?: unknown;
}): boolean {
  if (!opts?.resultsOpen) return false;
  const viewing = normId(opts.resultsRunId) || normId(opts.selectedRunId);
  const starting = normId(opts.startingRunId);
  if (!viewing || !starting) return false;
  return viewing !== starting;
}

/** Drop /api/case snaps that belong to a mesh/solve other than the viewed results. */
/** Status for one study must not replace another study's run list. */
export function catalogReplacesStudyRuns(
  payload: { simulation_id?: unknown; runs?: Array<{ simulation_id?: unknown }> | null } | null | undefined,
  currentStudyId: unknown
): boolean {
  const cur = currentStudyId != null ? String(currentStudyId).trim() : '';
  if (!cur) return true;
  const sid = payload && payload.simulation_id != null ? String(payload.simulation_id).trim() : '';
  if (sid) return sid === cur;
  const tagged = (payload && payload.runs ? payload.runs : []).filter((r) => r && r.simulation_id);
  if (!tagged.length) return true;
  return tagged.some((r) => String(r.simulation_id) === cur);
}

/** Keep the open run when a poll from another study arrives. */
export function selectedRunAfterCatalog(opts?: {
  selectedId?: unknown;
  incomingRuns?: Array<{ id?: unknown; run_id?: unknown }> | null;
  replaceStudyRuns?: boolean;
}): string | null {
  const selected = opts && opts.selectedId != null && String(opts.selectedId) !== '' ? String(opts.selectedId) : '';
  if (!selected) return null;
  if (opts && opts.replaceStudyRuns === false) return selected;
  const runs = (opts && opts.incomingRuns) || [];
  const still = runs.some((r) => r && (String(r.id) === selected || String(r.run_id) === selected));
  return still ? selected : null;
}

export function runBelongsToOpenProject(
  rec?: { project_id?: unknown } | null,
  projectId?: unknown
): boolean {
  const cur = projectId != null && String(projectId) !== '' ? String(projectId) : '';
  const pid = rec && rec.project_id != null && String(rec.project_id) !== '' ? String(rec.project_id) : '';
  if (!cur || !pid) return true;
  return pid === cur;
}

/** Workbench run lists are one project. A leftover row from another project must not stay. */
export function catalogRowsForOpenProject<T extends { project_id?: unknown }>(
  rows?: Array<T | null | undefined> | null,
  projectId?: unknown
): T[] {
  const list = (Array.isArray(rows) ? rows : []).filter((r): r is T => !!r);
  const cur = projectId != null && String(projectId) !== '' ? String(projectId) : '';
  if (!cur) return list;
  return list.filter((r) => runBelongsToOpenProject(r, cur));
}

export function pickHydrateLiveRunForProject<T extends LiveSolveRow & { project_id?: unknown }>(
  rows?: Array<T | null | undefined> | null,
  preferId?: unknown,
  projectId?: unknown
): T | null {
  return pickLiveSolveFromCatalog(catalogRowsForOpenProject(rows, projectId), preferId);
}

/** Never show another run's live solve on this run's panel. */
export function runPanelDoc<T extends Record<string, unknown>>(
  rec: T | null | undefined,
  live?: { id?: unknown; run_id?: unknown; name?: unknown; project_id?: unknown } | null,
  projectId?: unknown
): (T & { run_id: unknown }) | null {
  if (!rec) return null;
  if (!runBelongsToOpenProject(rec, projectId)) return null;
  const rid = rec.id ?? rec.run_id;
  const sameId = !!(live && String(live.run_id ?? live.id ?? '') === String(rid ?? ''));
  if (sameId && runBelongsToOpenProject(live, projectId)) {
    return { ...rec, ...live, name: rec.name || live.name, run_id: rid } as T & { run_id: unknown };
  }
  return { ...rec, run_id: rid } as T & { run_id: unknown };
}

/** Persist/activate must target the run's study, not only the open one. */
export function runOwnerStudyIds(
  rec: { simulation_id?: unknown; geometry_id?: unknown } | null | undefined,
  fallback?: { simulation_id?: unknown; geometry_id?: unknown } | null
): { simulation_id?: string; geometry_id?: string } {
  const sid = (rec && rec.simulation_id) || (fallback && fallback.simulation_id);
  const gid = (rec && rec.geometry_id) || (fallback && fallback.geometry_id);
  const out: { simulation_id?: string; geometry_id?: string } = {};
  if (sid) out.simulation_id = String(sid);
  if (gid) out.geometry_id = String(gid);
  return out;
}

export function ignoreForeignCaseSnap(opts?: {
  resultsOpen?: boolean;
  viewedCaseDir?: unknown;
  snapCaseDir?: unknown;
}): boolean {
  if (!opts?.resultsOpen) return false;
  const viewed = String(opts.viewedCaseDir || '').trim();
  const snap = String(opts.snapCaseDir || '').trim();
  if (!viewed || !snap) return false;
  return !sameCasePathKey(viewed, snap);
}

/** One session key for the whole FIFO, including jobs from other projects. */
export const JOB_QUEUE_STORAGE_KEY = 'cfd-job-queue';
export const JOB_QUEUE_STORAGE_PREFIX = 'cfd-job-queue:';

export function isJobQueueStorageKey(key: unknown): boolean {
  const k = String(key || '');
  return k === JOB_QUEUE_STORAGE_KEY || k.startsWith(JOB_QUEUE_STORAGE_PREFIX);
}

export function parseStoredQueueItems<T extends QueueDepItem>(raw: unknown): T[] {
  let stored = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch (_) {
      return [];
    }
  }
  return (Array.isArray(stored) ? stored : []).filter(
    (r): r is T => !!(r && (r.kind === 'mesh' || r.kind === 'solve'))
  );
}

/** First list keeps order; later shards only append jobs that are not already present. */
export function mergeStoredQueueItems<T extends QueueDepItem>(
  ...lists: Array<T[] | null | undefined>
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || (row.kind !== 'mesh' && row.kind !== 'solve')) continue;
      const k = String(row.kind || '') + ':' + String(row.kind === 'mesh' ? row.mesh_id : row.run_id);
      if (!k || k.endsWith(':') || seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
  }
  return out;
}

/** Drop queue rows whose mesh or run is no longer in the project catalogs. */
export function dropMissingQueueJobs<T extends QueueDepItem>(
  items: T[] | null | undefined,
  known?: { meshIds?: unknown[]; runIds?: unknown[]; currentProjectId?: unknown } | null
): T[] {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const meshes = new Set(uniqueIds(known && known.meshIds));
  const runs = new Set(uniqueIds(known && known.runIds));
  if (!meshes.size && !runs.size) return list.slice();
  const cur = known && known.currentProjectId != null && String(known.currentProjectId) !== ''
    ? String(known.currentProjectId)
    : '';
  return list.filter((row) => {
    if (!row) return false;
    const pid = row.project_id != null && String(row.project_id) !== '' ? String(row.project_id) : '';
    if (cur && pid && pid !== cur) return true;
    if (row.kind === 'mesh') return !meshes.size || meshes.has(normId(row.mesh_id));
    if (row.kind === 'solve') return !runs.size || runs.has(normId(row.run_id));
    return false;
  });
}

/** Drop a deleted mesh and any queued solves that were waiting on it. */
export function dropQueueJobsForMesh<T extends QueueItem>(
  items: T[] | null | undefined,
  meshId: unknown
): T[] {
  const id = normId(meshId);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!id) return list.slice();
  return list.filter((r) => {
    if (String(r.kind) === 'mesh' && normId(r.mesh_id) === id) return false;
    if (String(r.kind) === 'solve' && normId(r.mesh_id) === id) return false;
    return true;
  });
}

export function isTerminalJobStatus(status: unknown): boolean {
  const s = String(status || '');
  return s === 'done' || s === 'failed' || s === 'stopped';
}

/** Mesh panel clock. A leftover liveCompute flag must not keep "Generating". */
export function meshProgressPhase(opts?: {
  jobStatus?: unknown;
  computeLive?: boolean;
  meshReady?: boolean;
  failed?: boolean;
}): 'failed' | 'generating' | 'finishing' | 'ready' | 'idle' {
  if (opts && opts.failed) return 'failed';
  if (opts && opts.meshReady) return 'ready';
  const status = opts && opts.jobStatus;
  if (String(status || '') === 'running') return 'generating';
  if (opts && opts.computeLive && !isTerminalJobStatus(status)) return 'generating';
  if (String(status || '') === 'done') return 'finishing';
  return 'idle';
}

/**
 * A snap from Mesh 1 / an omitted id must not finish or rewrite Mesh 2.
 * GET /api/case used to leave mesh_id off; empty snap + live id is a miss.
 */
export function snapMatchesLiveMeshJob(opts?: {
  snapMeshId?: unknown;
  liveMeshId?: unknown;
  snapKickId?: unknown;
  liveKickId?: unknown;
}): boolean {
  const snapMesh = normId(opts && opts.snapMeshId);
  const liveMesh = normId(opts && opts.liveMeshId);
  const snapKick = normId(opts && opts.snapKickId);
  const liveKick = normId(opts && opts.liveKickId);
  if (snapMesh && liveMesh) return snapMesh === liveMesh;
  if (snapKick && liveKick) return snapKick === liveKick;
  if (liveMesh || liveKick) return false;
  return true;
}

/** Keep Generate vs Add to queue stable while this mesh is the live job. */
export function meshGenerateButtonKind(opts?: {
  viewingMeshId?: unknown;
  liveMeshId?: unknown;
  generateLive?: boolean;
  computeBusy?: boolean;
  queued?: boolean;
}): 'generating' | 'queued' | 'queue' | 'generate' {
  const view = normId(opts && opts.viewingMeshId);
  const live = normId(opts && opts.liveMeshId);
  const thisLive = !!(opts && opts.generateLive) && !!view && (!live || live === view);
  if (thisLive) return 'generating';
  if (opts && opts.queued) return 'queued';
  if (opts && (opts.computeBusy || opts.generateLive)) return 'queue';
  return 'generate';
}

/** While Results is attaching, the chip says Loading results — not Meshing/Solving. */
export function viewportChipPrefersResultsLoad(opts?: {
  resultsOpen?: boolean;
  attaching?: boolean;
  resultsBusy?: boolean;
}): boolean {
  return !!(opts?.resultsOpen && (opts.attaching || opts.resultsBusy));
}
