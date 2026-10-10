// @ts-check
/**
 * The per-project gate (host API 1.5, proposal 5.16).
 *
 * A geometry update's plan, swap and apply rewrite a project's study records and
 * geometry files. Node's record writers and the readers of those files are not on the
 * Python main lane, so they pass one gate per project, taken once per request in the
 * router's dispatch, right before the route's handler:
 *
 * - open: a gated request counts itself in, and out when its response ends;
 * - closed (only by an overwrite or its recovery, for plan, swap and apply): a new
 *   gated request waits; a write that has waited 20 s, or a read 2 minutes, answers
 *   503 geometry_updating with Retry-After: 2;
 * - closing drains: it waits up to 3 s for the open requests to end, else opens again.
 *
 * The state is on globalThis, keyed by the project's folder, so a Vite re-import of
 * this module (or of the router) shares it. Which routes are gated is one table,
 * gateClassOf, which the census test checks against every registered route.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECTS_ROOT } from '../project-isolation.js';
import { canonicalFilterKey } from './legacy-aliases.ts';

const WIN = process.platform === 'win32';

/** Prefixes (whole path segments) whose routes pass the gate. */
export const GATED_PREFIXES = Object.freeze([
  '/api/project',
  '/api/geometry',
  '/api/simulation',
  '/api/bcs',
  '/api/materials',
  '/api/mesh',
  '/api/mesh-refinements',
  '/api/result-controls',
  '/api/area-average',
  '/api/run',
  '/api/runs',
  '/api/particle-trace',
]);

/**
 * Reviewed exceptions under a gated prefix: filter reads of a mesh case, which read no
 * record and no geometry file (a slow one never holds an update's drain open).
 */
export const GATE_EXCEPTIONS = Object.freeze(['/api/mesh/surface', '/api/mesh/section']);

/** Worker methods /api/worker passes without the gate (they read or write no study record). */
export const WORKER_UNGATED = Object.freeze(['bc.menu', 'registry.reload', 'sim.get']);

/**
 * Reviewed prefixes that are not gated. A route under none of these and no gated prefix
 * fails the census until someone decides.
 */
export const UNGATED_PREFIXES = Object.freeze([
  '/api/_routes',
  // A geometry action's resolver (API 1.7): reads the geometry, writes only a plugin study's record.
  '/api/geometry-actions',
  '/api/case',
  '/api/compute-queue',
  '/api/cut-plane',
  '/api/fields',
  '/api/folders',
  '/api/inspect',
  '/api/iso-surface',
  '/api/iso-volume',
  '/api/jobs',
  '/api/media',
  '/api/mesh-section',
  '/api/mesh-surface',
  '/api/plot-over-path',
  '/api/plugin',
  '/api/plugin-cases',
  '/api/plugin-data',
  '/api/plugin-files',
  '/api/plugin-geometry',
  '/api/plugin-prefs',
  '/api/plugin-studies',
  '/api/plugins',
  '/api/prefs',
  '/api/projects',
  '/api/registry',
  '/api/simulation-control',
  '/api/test',
  '/api/times',
  '/api/volume',
]);

/**
 * A path as the gate reads it: the second segment's underscores read as hyphens (the
 * router adds an underscore alias of every hyphenated route).
 * @param {string} pathname
 */
function canonicalPath(pathname) {
  const parts = String(pathname || '').split('/');
  if (parts.length > 2) parts[2] = parts[2].replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, '-');
  return parts.join('/');
}

/** @param {string} path @param {string} prefix */
function under(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * How the gate treats a path: 'gated', 'filter' (gated only for a particle trace),
 * 'worker' (gated but for WORKER_UNGATED), 'exception', 'reviewed' (not gated) or
 * 'unreviewed' (nobody decided: the census fails).
 * @param {string} pathname
 */
export function gateClassOf(pathname) {
  const path = canonicalPath(pathname);
  if (!path.startsWith('/api/')) return 'reviewed';
  if (GATE_EXCEPTIONS.some((p) => under(path, p))) return 'exception';
  if (path === '/api/worker') return 'worker';
  if (under(path, '/api/filter')) return 'filter';
  if (GATED_PREFIXES.some((p) => under(path, p))) return 'gated';
  if (UNGATED_PREFIXES.some((p) => under(path, p))) return 'reviewed';
  return 'unreviewed';
}

/**
 * Whether this request passes the gate.
 * @param {string} method
 * @param {string} pathname
 * @param {Record<string, any> | null} body
 */
export function requestIsGated(method, pathname, body) {
  const cls = gateClassOf(pathname);
  if (cls === 'gated') return true;
  if (cls === 'worker') return !WORKER_UNGATED.includes(String((body && body.method) || ''));
  if (cls === 'filter') {
    const parts = canonicalPath(pathname).split('/');
    return parts.length >= 4 && canonicalFilterKey(decodeURIComponentSafe(parts[3])) === 'particle_trace';
  }
  return false;
}

/** @param {string} s */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The active project (a request that names none acts on it). */
function activeProjectId() {
  try {
    const doc = JSON.parse(readFileSync(join(PROJECTS_ROOT, 'active.json'), 'utf8'));
    return String((doc && (doc.project_id || doc.id)) || '').trim();
  } catch {
    return '';
  }
}

/**
 * The project a gated request acts on: the scope's project, for /api/worker also its
 * params.project_id or params.id (as that route reads it), else the active project.
 * @param {string} pathname
 * @param {string} scopeProjectId
 * @param {Record<string, any> | null} body
 */
export function gateProjectOf(pathname, scopeProjectId, body) {
  if (canonicalPath(pathname) === '/api/worker') {
    const raw = body && body.params && typeof body.params === 'object' ? body.params : {};
    const id = String(raw.project_id || raw.id || scopeProjectId || '').trim();
    if (id) return id;
  }
  return String(scopeProjectId || '').trim() || activeProjectId();
}

/**
 * The key of a project's gate: its real folder (a short name, a junction or another
 * letter case is the same project), else its id.
 * @param {string} projectId
 */
export function gateKey(projectId) {
  const id = String(projectId || '').trim();
  const dir = resolve(PROJECTS_ROOT, id);
  let key = dir;
  if (existsSync(dir)) {
    try {
      key = realpathSync.native(dir);
    } catch {
      key = dir;
    }
  }
  return WIN ? key.toLowerCase() : key;
}

/**
 * @typedef {{ open: number, closed: { name: string, since: number } | null, waiters: Set<() => void> }} GateEntry
 * @typedef {{ gates: Map<string, GateEntry>, timing: { writeWaitMs: number, readWaitMs: number, drainMs: number } }} GateState
 */

/** @returns {GateState} */
function G() {
  const key = Symbol.for('magnusim.linkGate');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) g[key] = { gates: new Map(), timing: { writeWaitMs: 20_000, readWaitMs: 120_000, drainMs: 3_000 } };
  return g[key];
}

/** @param {string} key @returns {GateEntry} */
function entry(key) {
  const s = G();
  let e = s.gates.get(key);
  if (!e) {
    e = { open: 0, closed: null, waiters: new Set() };
    s.gates.set(key, e);
  }
  return e;
}

/** @param {string} key */
function dropIfIdle(key) {
  const e = G().gates.get(key);
  if (e && !e.open && !e.closed && !e.waiters.size) G().gates.delete(key);
}

/** @param {GateEntry} e */
function wake(e) {
  for (const fn of [...e.waiters]) fn();
}

/** The open (counted) requests of a project. @param {string} projectId */
export function gateOpenCount(projectId) {
  const e = G().gates.get(gateKey(projectId));
  return e ? e.open : 0;
}

/** @param {string} projectId */
export function gateIsClosed(projectId) {
  const e = G().gates.get(gateKey(projectId));
  return !!(e && e.closed);
}

/** The 503 a gated request gets after its wait. @param {string} name */
export function gateBusyAnswer(name) {
  return {
    ok: false,
    code: 'geometry_updating',
    error: `Updating ${name || 'the geometry'}. Try again in a moment.`,
  };
}

/**
 * Let a gated request in, or answer why not. Counts it in until its response ends.
 * @param {{ projectId: string, method: string, res: any }} req
 * @returns {Promise<{ ok: boolean, body?: Record<string, any> }>}
 */
export async function admitThroughGate({ projectId, method, res }) {
  const key = gateKey(projectId);
  const e = entry(key);
  if (e.closed) {
    const read = method === 'GET' || method === 'HEAD';
    const waitMs = read ? G().timing.readWaitMs : G().timing.writeWaitMs;
    const name = e.closed.name;
    const opened = await new Promise((done) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      const fn = () => {
        if (e.closed) return;
        e.waiters.delete(fn);
        if (timer) clearTimeout(timer);
        // Count in now, in the same turn as the open: openGate drops an idle entry right
        // after waking its waiters, and a count made after the await would land on that
        // dropped entry, so the next close would drain at once while this request runs.
        e.open += 1;
        done(true);
      };
      e.waiters.add(fn);
      timer = setTimeout(() => {
        e.waiters.delete(fn);
        done(false);
      }, waitMs);
    });
    if (!opened) {
      dropIfIdle(key);
      return { ok: false, body: gateBusyAnswer(name) };
    }
  } else {
    e.open += 1;
  }
  let counted = true;
  const out = () => {
    if (!counted) return;
    counted = false;
    e.open = Math.max(0, e.open - 1);
    if (!e.open) wake(e);
    dropIfIdle(key);
  };
  if (res && typeof res.on === 'function') {
    res.on('finish', out);
    res.on('close', out);
  } else {
    // A test double with no events: count out at once.
    out();
  }
  return { ok: true };
}

/**
 * Close a project's gate and drain it: new gated requests wait; resolves true once no
 * request is open, or false (the gate open again) when one is still open after the drain time.
 * @param {string} projectId
 * @param {string} name what the 503 names ("Updating <name>")
 * @param {{ drainMs?: number }} [opts]
 */
export async function closeGate(projectId, name, opts = {}) {
  const key = gateKey(projectId);
  const e = entry(key);
  if (e.closed) return false;
  e.closed = { name: String(name || ''), since: Date.now() };
  if (!e.open) return true;
  const drainMs = opts.drainMs ?? G().timing.drainMs;
  const drained = await new Promise((done) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const fn = () => {
      if (e.open) return;
      e.waiters.delete(fn);
      if (timer) clearTimeout(timer);
      done(true);
    };
    e.waiters.add(fn);
    timer = setTimeout(() => {
      e.waiters.delete(fn);
      done(false);
    }, drainMs);
  });
  if (!drained) openGate(projectId);
  return drained;
}

/** @param {string} projectId */
export function openGate(projectId) {
  const key = gateKey(projectId);
  const e = G().gates.get(key);
  if (!e) return;
  e.closed = null;
  wake(e);
  dropIfIdle(key);
}

/** @param {{ writeWaitMs?: number, readWaitMs?: number, drainMs?: number } | null} [timing] */
export function resetLinkGateForTests(timing = null) {
  const s = G();
  for (const e of s.gates.values()) {
    e.closed = null;
    wake(e);
  }
  s.gates = new Map();
  s.timing = { writeWaitMs: 20_000, readWaitMs: 120_000, drainMs: 3_000, ...(timing || {}) };
}
