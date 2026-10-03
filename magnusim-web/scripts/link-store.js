// @ts-check
/**
 * Records of link jobs (host API 1.5): one per accepted linkGeometry call that is
 * not answered at once. Built like foam-store.js: the records live on the process
 * (globalThis), so a Vite re-import shares them, and are written to
 * .cache/link-jobs.json for the default projects root, else .cache/link-jobs-<tag>.json.
 * The in-memory record is the truth: a write that fails is skipped and logged.
 *
 * Not jobs.ts: its ids are its own, every server start fails its queued jobs, and any
 * page of the project could stop them. A queued update survives a restart, and
 * nothing stops a link job from a page (proposal 5.2).
 *
 * Each record: id (gl-<ms base36>-<6 hex>), op ('create' | 'update'), project_id,
 * plugin, study_id, geometry_id, status, stage, row_id, staging (from the project
 * folder), the call's fields, result, error, code, seq. Statuses: queued, running,
 * done, failed, cancelled, superseded, gone, busy, stale, and choosing (the host's
 * question waits for the user's answer, proposal 5.0: no row, no slot, its staging kept;
 * it survives a restart). Events: each gets the next per-job seq; the last 200 per job
 * stay in memory on a process-wide emitter.
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WEB_ROOT } from './python-env.js';
import { PROJECTS_ROOT } from './project-isolation.js';

export const LINK_JOB_RE = /^gl-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
export const LINK_ACTIVE = Object.freeze(['queued', 'running', 'choosing']);
export const LINK_ENDED = Object.freeze(['done', 'failed', 'cancelled', 'superseded', 'gone', 'busy', 'stale']);
const KEEP_FINISHED_MS = 30 * 24 * 3600_000;
const KEEP_FINISHED_MAX = 200;
const EVENTS_KEPT = 200;
const WRITE_RETRIES = 5;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** The projects root as records name it (normalized, lowercase). */
export function normLinkRoot(root) {
  return resolve(String(root || PROJECTS_ROOT)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** @param {string} projectsRoot */
export function linkStoreFileFor(projectsRoot) {
  const root = resolve(projectsRoot);
  if (root.toLowerCase() === resolve(WEB_ROOT, 'projects').toLowerCase()) {
    return join(WEB_ROOT, '.cache', 'link-jobs.json');
  }
  const tag = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 10);
  return join(WEB_ROOT, '.cache', `link-jobs-${tag}.json`);
}

/**
 * @typedef {{
 *   filePath: string, root: string, loaded: boolean, records: Map<string, any>,
 *   bus: EventEmitter, recent: Map<string, Array<{ seq: number, ev: any }>>,
 * }} LinkStoreState
 */

/** @returns {LinkStoreState} */
function S() {
  const key = Symbol.for('magnusim.linkJobsStore');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    g[key] = {
      filePath: linkStoreFileFor(PROJECTS_ROOT),
      root: normLinkRoot(PROJECTS_ROOT),
      loaded: false,
      records: new Map(),
      bus,
      recent: new Map(),
    };
  }
  return g[key];
}

function ensureLoaded() {
  const s = S();
  if (s.loaded) return s;
  s.loaded = true;
  if (!existsSync(s.filePath)) return s;
  try {
    const raw = JSON.parse(readFileSync(s.filePath, 'utf8'));
    for (const rec of raw && Array.isArray(raw.records) ? raw.records : []) {
      if (!rec || typeof rec !== 'object' || !LINK_JOB_RE.test(String(rec.id || ''))) continue;
      if (normLinkRoot(rec.projects_root) !== s.root) continue;
      if (!s.records.has(rec.id)) s.records.set(rec.id, rec);
    }
  } catch (e) {
    console.warn('[CFD link store] could not read', s.filePath, e && /** @type {any} */ (e).message);
  }
  return s;
}

function prune() {
  const s = S();
  const now = Date.now();
  const finished = [...s.records.values()]
    .filter((r) => !LINK_ACTIVE.includes(r.status))
    .sort((a, b) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')));
  finished.forEach((r, i) => {
    const at = Date.parse(String(r.finished_at || r.created_at || '')) || 0;
    if (i >= KEEP_FINISHED_MAX || (at && now - at > KEEP_FINISHED_MS)) {
      s.records.delete(r.id);
      s.recent.delete(r.id);
    }
  });
}

/** Write every record of this root atomically; a write that still fails is skipped. */
export function writeLinkStore() {
  const s = ensureLoaded();
  prune();
  const body = JSON.stringify({ records: [...s.records.values()] }, null, 2);
  const tmp = `${s.filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(s.filePath), { recursive: true });
    writeFileSync(tmp, body, 'utf8');
  } catch (e) {
    console.warn('[CFD link store] write skipped', e && /** @type {any} */ (e).message);
    return false;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, s.filePath);
      return true;
    } catch (e) {
      const code = e && /** @type {any} */ (e).code;
      if (!RETRY_CODES.has(code) || attempt >= WRITE_RETRIES) {
        try {
          unlinkSync(tmp);
        } catch {
          /* gone */
        }
        console.warn('[CFD link store] write skipped', code || (e && /** @type {any} */ (e).message));
        return false;
      }
      Atomics.wait(sleepCell, 0, 0, 50);
    }
  }
}

/** A new record id: gl-<ms base36>-<6 hex>. */
export function newLinkJobId() {
  return `gl-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** @param {any} rec */
function copy(rec) {
  return rec ? JSON.parse(JSON.stringify(rec)) : null;
}

/**
 * Store a new record and write it.
 * @param {Record<string, any>} fields
 */
export function createLinkRecord(fields) {
  const s = ensureLoaded();
  const id = fields.id && LINK_JOB_RE.test(fields.id) ? fields.id : newLinkJobId();
  const rec = {
    op: 'update',
    status: 'queued',
    stage: null,
    row_id: null,
    staging: null,
    result: null,
    error: null,
    code: null,
    started_at: null,
    finished_at: null,
    ...copy(fields),
    id,
    projects_root: s.root,
    created_at: new Date().toISOString(),
    seq: 0,
  };
  s.records.set(id, rec);
  writeLinkStore();
  return copy(rec);
}

/** A copy of a record of this projects root, or null. @param {unknown} id */
export function readLinkRecord(id) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  return rec && normLinkRoot(rec.projects_root) === s.root ? copy(rec) : null;
}

/**
 * Records of this projects root, newest first.
 * @param {{ status?: string | readonly string[], filter?: (r: any) => boolean }} [opts]
 */
export function listLinkRecords(opts = {}) {
  const s = ensureLoaded();
  const want = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
  return [...s.records.values()]
    .filter((r) => normLinkRoot(r.projects_root) === s.root)
    .filter((r) => !want || want.has(r.status))
    .filter((r) => !opts.filter || opts.filter(r))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map((r) => copy(r));
}

/**
 * Merge fields into a record and write it.
 * @param {unknown} id
 * @param {Record<string, any>} patch
 * @param {{ write?: boolean }} [opts]
 */
export function updateLinkRecord(id, patch, opts = {}) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  if (!rec || normLinkRoot(rec.projects_root) !== s.root) return null;
  Object.assign(rec, copy(patch) || {});
  if (opts.write !== false) writeLinkStore();
  return copy(rec);
}

/** The process-wide emitter: 'event' with { job_id, seq, ev, project_id, plugin, study_id }. */
export function linkEventBus() {
  return S().bus;
}

/**
 * Publish one event of a job: it gets the next seq, is kept (the last 200) and goes
 * to every listener. Returns the seq (0 when the record is gone).
 * @param {string} id
 * @param {Record<string, any>} ev
 */
export function emitLinkEvent(id, ev) {
  const s = ensureLoaded();
  const rec = s.records.get(String(id || ''));
  if (!rec) return 0;
  rec.seq = (Number(rec.seq) || 0) + 1;
  const seq = rec.seq;
  let kept = s.recent.get(id);
  if (!kept) {
    kept = [];
    s.recent.set(id, kept);
  }
  kept.push({ seq, ev });
  if (kept.length > EVENTS_KEPT) kept.splice(0, kept.length - EVENTS_KEPT);
  const out = { job_id: id, seq, ev, project_id: rec.project_id, plugin: rec.plugin, study_id: rec.study_id };
  try {
    s.bus.emit('event', out);
  } catch (e) {
    console.warn('[CFD link store] event listener failed', e);
  }
  return seq;
}

/** The events kept for a job. @param {string} id */
export function recentLinkEvents(id) {
  const kept = S().recent.get(String(id || ''));
  return kept ? kept.slice() : [];
}

/** @param {{ filePath?: string, root?: string }} [opts] */
export function resetLinkStoreForTests(opts = {}) {
  const s = S();
  s.filePath = opts.filePath || linkStoreFileFor(PROJECTS_ROOT);
  s.root = normLinkRoot(opts.root || PROJECTS_ROOT);
  s.loaded = false;
  s.records = new Map();
  s.recent.clear();
  s.bus.removeAllListeners();
}
