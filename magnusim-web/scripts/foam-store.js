// @ts-check
/**
 * Records of the step-list runner's runs (plugin OpenFOAM cases, plugin meshers,
 * core solves): one per run, kept in memory on the process (globalThis) and written
 * to .cache/foam-cases.json for the default projects root, else
 * .cache/foam-cases-<tag>.json (the queue file's rule). The in-memory record is
 * the truth: a write that fails is skipped and logged, and the next write writes
 * the whole record again.
 *
 * Also the runs' events: each gets the next per-job seq; the last 400 frame
 * events and 2000 progress points per job stay in memory on a process-wide emitter.
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WEB_ROOT } from './python-env.js';
import { PROJECTS_ROOT } from './project-isolation.js';

const KEEP_FINISHED_MS = 30 * 24 * 3600_000;
const KEEP_FINISHED_MAX = 200;
const PROGRESS_WRITE_MS = 5_000;
const WRITE_RETRIES = 5;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const EVENTS_KEPT = 400;
const POINTS_KEPT = 2000;
export const FOAM_JOB_RE = /^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
const ACTIVE = new Set(['queued', 'running']);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * @typedef {{
 *   id: string, kind: 'foam'|'mesh'|'solve', projects_root: string, project_id: string,
 *   plugin: string|null, plugin_name: string|null, study_id: string|null, study_title: string|null,
 *   case_rel: string|null, case_parts: string[], case_key: string|null, case_dir: string, case_base: string,
 *   token: string, wsl_case: string, wsl_root: string, prepare: null | { job: string, runtime: string },
 *   app: string|null, n_procs: number, pre: Array<{ tool: string, args: string[], parallel: boolean }>,
 *   results: null | { rho?: number, kinematic_fields: string[], frame_fields: string[] },
 *   launch: null | Record<string, any>, spec_path: string|null,
 *   status: 'queued'|'running'|'done'|'failed'|'stopped'|'lost', stage: string|null, row_id: string|null,
 *   stop: null | { at: string, by: string, level: 'graceful'|'solver'|'all', reason: string|null, seq?: number },
 *   node_pid: number|null, created_at: string, started_at: string|null, finished_at: string|null,
 *   error: string|null, code: string|null, result: Record<string, any> | null, seq: number,
 *   log_path?: string, run_id?: string, run_name?: string, simulation_id?: string,
 *   [extra: string]: any,
 * }} FoamRecord
 */

/** The projects root as records name it (normalized, lowercase). */
export function normRoot(root) {
  return resolve(String(root || PROJECTS_ROOT)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** @param {string} projectsRoot */
export function foamStoreFileFor(projectsRoot) {
  const root = resolve(projectsRoot);
  if (root.toLowerCase() === resolve(WEB_ROOT, 'projects').toLowerCase()) {
    return join(WEB_ROOT, '.cache', 'foam-cases.json');
  }
  const tag = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10);
  return join(WEB_ROOT, '.cache', `foam-cases-${tag}.json`);
}

/**
 * @typedef {{
 *   filePath: string, root: string, loaded: boolean, records: Map<string, FoamRecord>,
 *   progressTimer: ReturnType<typeof setTimeout> | null,
 *   fs: { writeFileSync: typeof writeFileSync, renameSync: typeof renameSync },
 *   bus: EventEmitter, recent: Map<string, { events: any[], points: any[] }>,
 * }} StoreState
 */

/** @returns {StoreState} */
function S() {
  const key = Symbol.for('magnusim.foamCases');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) {
    g[key] = {
      filePath: foamStoreFileFor(PROJECTS_ROOT),
      root: normRoot(PROJECTS_ROOT),
      loaded: false,
      records: new Map(),
      progressTimer: null,
      fs: { writeFileSync, renameSync },
    };
  }
  const s = g[key];
  const busKey = Symbol.for('magnusim.foamEvents');
  if (!g[busKey]) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    g[busKey] = { bus, recent: new Map() };
  }
  s.bus = g[busKey].bus;
  s.recent = g[busKey].recent;
  return s;
}

function ensureLoaded() {
  const s = S();
  if (s.loaded) return s;
  s.loaded = true;
  if (!existsSync(s.filePath)) return s;
  try {
    const raw = JSON.parse(readFileSync(s.filePath, 'utf8'));
    const list = raw && Array.isArray(raw.records) ? raw.records : [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object' || !FOAM_JOB_RE.test(String(rec.id || ''))) continue;
      if (normRoot(rec.projects_root) !== s.root) continue;
      if (!s.records.has(rec.id)) s.records.set(rec.id, rec);
    }
  } catch (e) {
    console.warn('[CFD foam store] could not read', s.filePath, e && /** @type {any} */ (e).message);
  }
  return s;
}

/**
 * Finished records: 30 days, 200 per kind at most (oldest first out), so many
 * core solves never push plugin cases' history out, nor the other way round.
 */
function prune() {
  const s = S();
  const now = Date.now();
  const finished = [...s.records.values()]
    .filter((r) => !ACTIVE.has(r.status))
    .sort((a, b) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')));
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const r of finished) {
    const kind = String(r.kind || 'foam');
    const i = seen.get(kind) || 0;
    seen.set(kind, i + 1);
    const at = Date.parse(String(r.finished_at || r.created_at || '')) || 0;
    if (i >= KEEP_FINISHED_MAX || (at && now - at > KEEP_FINISHED_MS)) {
      s.records.delete(r.id);
      s.recent.delete(r.id);
    }
  }
}

/**
 * Write every record of this root atomically (temp file, rename; 5 retries at
 * 50 ms on EPERM/EBUSY). A write that still fails is skipped and logged.
 * @returns {boolean}
 */
export function writeFoamStore() {
  const s = ensureLoaded();
  if (s.progressTimer) {
    clearTimeout(s.progressTimer);
    s.progressTimer = null;
  }
  prune();
  const body = JSON.stringify({ records: [...s.records.values()] }, null, 2);
  const tmp = `${s.filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(s.filePath), { recursive: true });
    s.fs.writeFileSync(tmp, body, 'utf8');
  } catch (e) {
    console.warn('[CFD foam store] write skipped', e && /** @type {any} */ (e).message);
    return false;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      s.fs.renameSync(tmp, s.filePath);
      return true;
    } catch (e) {
      const code = e && /** @type {any} */ (e).code;
      if (!RETRY_CODES.has(code) || attempt >= WRITE_RETRIES) {
        try {
          unlinkSync(tmp);
        } catch {
          /* gone */
        }
        console.warn('[CFD foam store] write skipped', code || (e && /** @type {any} */ (e).message));
        return false;
      }
      Atomics.wait(sleepCell, 0, 0, 50);
    }
  }
}

/** A progress write, at most every 5 s. */
function writeSoon() {
  const s = S();
  if (s.progressTimer) return;
  s.progressTimer = setTimeout(() => {
    s.progressTimer = null;
    writeFoamStore();
  }, PROGRESS_WRITE_MS);
  if (typeof s.progressTimer.unref === 'function') s.progressTimer.unref();
}

/** A new record id: fc-<ms base36>-<6 hex>. */
export function newFoamJobId() {
  return `fc-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** @param {any} rec */
function copy(rec) {
  return rec ? JSON.parse(JSON.stringify(rec)) : null;
}

/**
 * Store a new record (status `queued`) and write it.
 * @param {Partial<FoamRecord> & { id?: string }} fields
 * @returns {FoamRecord}
 */
export function createFoamRecord(fields) {
  const s = ensureLoaded();
  const id = fields.id && FOAM_JOB_RE.test(fields.id) ? fields.id : newFoamJobId();
  /** @type {FoamRecord} */
  const rec = /** @type {any} */ ({
    kind: 'foam',
    plugin: null,
    plugin_name: null,
    study_id: null,
    study_title: null,
    case_rel: null,
    case_parts: [],
    case_key: null,
    prepare: null,
    app: null,
    n_procs: 1,
    pre: [],
    results: null,
    launch: null,
    spec_path: null,
    stage: null,
    row_id: null,
    stop: null,
    node_pid: null,
    started_at: null,
    finished_at: null,
    error: null,
    code: null,
    result: null,
    ...copy(fields),
    id,
    projects_root: s.root,
    status: 'queued',
    created_at: new Date().toISOString(),
    seq: 0,
  });
  s.records.set(id, rec);
  writeFoamStore();
  return copy(rec);
}

/**
 * A copy of a record of this projects root, or null.
 * @param {unknown} id
 * @returns {FoamRecord | null}
 */
export function readFoamRecord(id) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  return rec && normRoot(rec.projects_root) === s.root ? copy(rec) : null;
}

/**
 * Records of this projects root, newest first.
 * @param {{ kind?: string, status?: string | string[] }} [filter]
 * @returns {FoamRecord[]}
 */
export function listFoamRecords(filter = {}) {
  const s = ensureLoaded();
  const want = filter.status === undefined || filter.status === null ? null : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  return [...s.records.values()]
    .filter((r) => normRoot(r.projects_root) === s.root)
    .filter((r) => !filter.kind || r.kind === filter.kind)
    .filter((r) => !want || want.has(r.status))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map((r) => copy(r));
}

/**
 * Merge fields into a record. `write`: 'now' (status, stage, stop, finish),
 * 'soon' (progress: at most every 5 s) or 'none'.
 * @param {unknown} id
 * @param {Record<string, any>} patch
 * @param {{ write?: 'now' | 'soon' | 'none' }} [opts]
 * @returns {FoamRecord | null}
 */
export function updateFoamRecord(id, patch, opts = {}) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  if (!rec || normRoot(rec.projects_root) !== s.root) return null;
  Object.assign(rec, copy(patch) || {});
  const write = opts.write || 'now';
  if (write === 'now') writeFoamStore();
  else if (write === 'soon') writeSoon();
  return copy(rec);
}

/**
 * The next per-job event number (kept with the record).
 * @param {string} id
 */
export function nextFoamSeq(id) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  if (!rec) return 0;
  rec.seq = (Number(rec.seq) || 0) + 1;
  return rec.seq;
}

/** The process-wide event emitter: 'event' with { job_id, seq, ev, project_id, plugin, study_id, kind }. */
export function foamEventBus() {
  return S().bus;
}

/**
 * Publish one frame event of a run: it gets the next seq, is kept (the last 400,
 * progress points the last 2000) and goes to every listener.
 * @param {string} id
 * @param {Record<string, any>} ev
 * @returns {number} the seq, 0 when the record is gone
 */
export function emitFoamEvent(id, ev) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  if (!rec) return 0;
  const seq = nextFoamSeq(id);
  let kept = s.recent.get(id);
  if (!kept) {
    kept = { events: [], points: [] };
    s.recent.set(id, kept);
  }
  kept.events.push({ seq, ev });
  if (kept.events.length > EVENTS_KEPT) kept.events.splice(0, kept.events.length - EVENTS_KEPT);
  if (ev && ev.event === 'progress' && Array.isArray(ev.points) && ev.points.length) {
    kept.points.push(...ev.points);
    if (kept.points.length > POINTS_KEPT) kept.points.splice(0, kept.points.length - POINTS_KEPT);
  }
  writeSoon();
  const out = { job_id: id, seq, ev, project_id: rec.project_id, plugin: rec.plugin, study_id: rec.study_id, kind: rec.kind };
  try {
    s.bus.emit('event', out);
  } catch (e) {
    console.warn('[CFD foam store] event listener failed', e);
  }
  return seq;
}

/**
 * The progress points kept for a run (the last `max`, evenly thinned to `max`).
 * @param {string} id
 * @param {number} [max]
 */
export function recentFoamPoints(id, max = 400) {
  const kept = S().recent.get(String(id || ''));
  const pts = kept ? kept.points : [];
  return thinPoints(pts, max);
}

/** The frame events kept for a run (the last 400). */
export function recentFoamEvents(id) {
  const kept = S().recent.get(String(id || ''));
  return kept ? kept.events.slice() : [];
}

/**
 * At most `max` points, evenly thinned, always keeping the last.
 * @template T
 * @param {T[]} pts
 * @param {number} max
 * @returns {T[]}
 */
export function thinPoints(pts, max) {
  const list = Array.isArray(pts) ? pts : [];
  if (list.length <= max) return list.slice();
  if (max <= 1) return list.slice(-1);
  const out = [];
  const step = (list.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(list[Math.round(i * step)]);
  out[out.length - 1] = list[list.length - 1];
  return out;
}

/**
 * @param {{ filePath?: string, root?: string, writeFileSync?: typeof writeFileSync, renameSync?: typeof renameSync }} [opts]
 */
export function resetFoamStoreForTests(opts = {}) {
  const s = S();
  if (s.progressTimer) clearTimeout(s.progressTimer);
  s.progressTimer = null;
  s.filePath = opts.filePath || foamStoreFileFor(PROJECTS_ROOT);
  s.root = normRoot(opts.root || PROJECTS_ROOT);
  s.loaded = false;
  s.records = new Map();
  s.fs = { writeFileSync: opts.writeFileSync || writeFileSync, renameSync: opts.renameSync || renameSync };
  s.recent.clear();
  s.bus.removeAllListeners();
}
