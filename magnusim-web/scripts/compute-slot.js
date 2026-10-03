// @ts-check
/**
 * The one compute slot of this server process.
 *
 * A mesh, a solve, a run of the step-list runner (a plugin OpenFOAM case) and the
 * boot check each hold it through one claim; nothing else counts as busy. The
 * claim lives on the process (globalThis), so a Vite re-import of this module
 * sees the same claim, and a job started by an old module instance still frees
 * it when it ends.
 *
 * Every call here is synchronous. A release calls the hook boot() installs (a
 * queue kick); before boot(), and in a test process, a release kicks nothing.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PROJECTS_ROOT } from './project-isolation.js';

const KINDS = new Set(['mesh', 'solve', 'foam', 'check', 'geometry']);
const PHASES = new Set(['checking', 'starting', 'running', 'draining']);
/** Claim fields besides token, kind, phase, since and stop_requested. */
const INFO_FIELDS = [
  'project_id',
  'project_ids',
  'name',
  'run_id',
  'mesh_id',
  'mesh_name',
  'generate_id',
  'path_kind',
  'started_at',
  'job_id',
  'plugin',
  'study_id',
  'geometry_id',
];
const START_ID_RE = /^[a-z0-9-]{8,40}$/;
const PENDING_STOP_MS = 10_000;
const WIN = process.platform === 'win32';

/**
 * @typedef {{
 *   token: string, kind: 'mesh'|'solve'|'foam'|'check'|'geometry', phase: 'checking'|'starting'|'running'|'draining',
 *   project_id: string|null, project_ids?: string[]|null, name: string, since: number, stop_requested: boolean,
 *   run_id?: string|null, mesh_id?: string|null, mesh_name?: string|null, generate_id?: string|null,
 *   path_kind?: string|null, started_at?: string|null, job_id?: string|null, plugin?: string|null, study_id?: string|null,
 *   geometry_id?: string|null,
 *   boot?: boolean,
 * }} SlotClaim
 */

/**
 * @typedef {{
 *   claim: SlotClaim | null, next: number, bootPid: number | null,
 *   releaseHook: (() => void) | null, pendingStops: Map<string, number>, now: () => number,
 * }} SlotState
 */

/** @returns {SlotState} */
function state() {
  const key = Symbol.for('magnusim.computeSlot');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) {
    g[key] = { claim: null, next: 1, bootPid: null, releaseHook: null, pendingStops: new Map(), now: () => Date.now() };
  }
  return g[key];
}

/** @param {Record<string, any>} info */
function pickInfo(info) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of INFO_FIELDS) {
    if (!info || !Object.prototype.hasOwnProperty.call(info, name)) continue;
    const value = info[name];
    if (name === 'project_ids') out[name] = Array.isArray(value) ? value.map((v) => String(v)) : null;
    else out[name] = value === undefined || value === null ? null : String(value);
  }
  return out;
}

/**
 * A copy of the claim, or null.
 * @returns {SlotClaim | null}
 */
export function computeSlotHolder() {
  const c = state().claim;
  if (!c) return null;
  return { ...c, ...(Array.isArray(c.project_ids) ? { project_ids: c.project_ids.slice() } : {}) };
}

/**
 * Take the slot. It fails while any claim exists.
 * @param {'mesh'|'solve'|'foam'|'check'|'geometry'} kind
 * @param {Record<string, any>} info
 * @param {{ phase?: string }} [opts]
 * @returns {{ ok: true, token: string } | { ok: false, holder: SlotClaim | null }}
 */
export function claimComputeSlot(kind, info, opts = {}) {
  const s = state();
  if (s.claim) return { ok: false, holder: computeSlotHolder() };
  if (!KINDS.has(kind)) throw new Error(`compute slot: unknown kind ${String(kind)}`);
  const phase = opts && opts.phase && PHASES.has(opts.phase) ? opts.phase : 'running';
  const token = `slot-${process.pid}-${s.next++}`;
  const picked = pickInfo(info || {});
  s.claim = /** @type {SlotClaim} */ ({
    project_id: null,
    name: '',
    ...picked,
    token,
    kind,
    phase,
    since: s.now(),
    stop_requested: false,
    // The boot check's claim: it is handed to each job the check follows, in turn.
    ...(kind === 'check' ? { boot: true } : {}),
  });
  if (!s.claim.name) {
    s.claim.name =
      kind === 'mesh' ? 'Mesh' : kind === 'solve' ? 'Run' : kind === 'check' ? 'Checking for jobs left running' : kind === 'geometry' ? 'Geometry update' : 'Plugin case';
  }
  return { ok: true, token };
}

/**
 * Merge phase, stop_requested, name and the info fields into the claim. `kind`
 * changes only on the claim the boot check took (never back to `check`): that is
 * how the check hands its claim to each job it follows, one after another. A
 * claim taken by a job keeps its kind. A token that is not current does nothing.
 * @param {string} token
 * @param {Record<string, any>} patch
 * @returns {boolean}
 */
export function patchComputeSlot(token, patch) {
  const s = state();
  const c = s.claim;
  if (!c || !token || c.token !== token || !patch || typeof patch !== 'object') return false;
  const info = pickInfo(patch);
  for (const [name, value] of Object.entries(info)) {
    if (name === 'project_ids' && value === null) delete c.project_ids;
    else /** @type {any} */ (c)[name] = value;
  }
  if (typeof patch.phase === 'string' && PHASES.has(patch.phase)) c.phase = /** @type {any} */ (patch.phase);
  if (typeof patch.stop_requested === 'boolean') c.stop_requested = patch.stop_requested;
  if (c.boot === true && typeof patch.kind === 'string' && KINDS.has(patch.kind) && patch.kind !== 'check') {
    c.kind = /** @type {any} */ (patch.kind);
  }
  return true;
}

/** @returns {string | null} */
export function currentSlotToken() {
  const c = state().claim;
  return c ? c.token : null;
}

/**
 * Free the slot, then call the release hook (it never makes a release throw).
 * @param {string} token
 * @returns {boolean} true when this token held the slot
 */
export function releaseComputeSlot(token) {
  const s = state();
  if (!s.claim || !token || s.claim.token !== token) return false;
  s.claim = null;
  const hook = s.releaseHook;
  if (hook) {
    try {
      hook();
    } catch (e) {
      console.warn('[CFD slot] release hook failed', e);
    }
  }
  return true;
}

/**
 * What a release does after it frees the slot. registerLiveRoutes clears it and
 * boot() installs the queue kick, so a process that never boots never kicks.
 * @param {(() => void) | null} fn
 */
export function setSlotReleaseHook(fn) {
  state().releaseHook = typeof fn === 'function' ? fn : null;
}

/**
 * Run a start under its claim: the claim is released when the returned promise
 * settles (a refusal, a return or a throw), unless the body called keep() because
 * its job now holds the slot. A rejection is passed on after the release.
 * @template T
 * @param {string} token
 * @param {(slot: { token: string, stopRequested: () => boolean, keep: () => void }) => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function runClaimed(token, body) {
  let kept = false;
  const slot = {
    token,
    stopRequested: () => {
      const c = state().claim;
      return !!(c && c.token === token && c.stop_requested);
    },
    keep: () => {
      kept = true;
    },
  };
  try {
    return await body(slot);
  } finally {
    if (!kept) releaseComputeSlot(token);
  }
}

/**
 * The answer of a start refused because the slot is held. The client's solve and
 * mesh checks read "already running" and queue the job.
 * @param {SlotClaim | null} holder
 */
export function slotRefusal(holder) {
  const h = holder || /** @type {any} */ ({});
  return {
    ok: false,
    status: 409,
    bodyExtra: {
      error: 'Another job is already running',
      code: 'busy',
      busy: { kind: h.kind || null, phase: h.phase || null, project_id: h.project_id || null, name: h.name || '' },
    },
  };
}

/**
 * What a solve Start does with the holder it finds: 'claim' (free), 'same_run'
 * (this run is starting or solving in this project) or 'busy' (any other job,
 * this run's own drain included, and a start of this run that was cancelled but
 * has not reached its stop check yet: the new Start queues behind it).
 * @param {SlotClaim | null} holder
 * @param {{ runId?: unknown, sameFolder?: boolean }} opts
 * @returns {'claim' | 'same_run' | 'busy'}
 */
export function solveClaimDecision(holder, { runId, sameFolder } = {}) {
  if (!holder) return 'claim';
  if (
    holder.kind === 'solve' &&
    sameFolder === true &&
    runId !== undefined &&
    runId !== null &&
    String(holder.run_id) === String(runId) &&
    (holder.phase === 'running' || (holder.phase === 'starting' && !holder.stop_requested))
  ) {
    return 'same_run';
  }
  return 'busy';
}

function prunePendingStops() {
  const s = state();
  const now = s.now();
  for (const [id, at] of s.pendingStops) if (now - at > PENDING_STOP_MS) s.pendingStops.delete(id);
}

/**
 * A Stop that reached the server for a Start it does not hold yet: kept 10 s,
 * under that click's start_id only.
 * @param {unknown} startId
 * @returns {boolean} true when stored
 */
export function noteStartCancel(startId) {
  prunePendingStops();
  if (typeof startId !== 'string' || !START_ID_RE.test(startId)) return false;
  const s = state();
  s.pendingStops.set(startId, s.now());
  return true;
}

/**
 * True (once) when a Stop of this click's start_id arrived in the last 10 s.
 * @param {unknown} startId
 */
export function takeStartCancel(startId) {
  prunePendingStops();
  if (typeof startId !== 'string' || !START_ID_RE.test(startId)) return false;
  const s = state();
  if (!s.pendingStops.has(startId)) return false;
  s.pendingStops.delete(startId);
  return true;
}

/** @param {string} id */
function realProjectFolder(id) {
  if (!id || id === '.' || id === '..' || id !== basename(id)) return null;
  const dir = join(PROJECTS_ROOT, id);
  if (!existsSync(dir)) return null;
  try {
    const real = realpathSync.native(dir);
    return WIN ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/**
 * Two project ids name the same folder: the same id, or (when both folders exist)
 * the same real folder (a Windows short name, a junction, another letter case),
 * else the same id in any case on Windows.
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameProjectFolder(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const rx = realProjectFolder(x);
  const ry = realProjectFolder(y);
  if (rx && ry) return rx === ry;
  return WIN ? x.toLowerCase() === y.toLowerCase() : false;
}

/**
 * The holder names this project: its job's project, or one the boot check looks at.
 * @param {SlotClaim | null} holder
 * @param {unknown} id
 */
export function holderNamesProject(holder, id) {
  if (!holder) return false;
  if (sameProjectFolder(holder.project_id, id)) return true;
  return Array.isArray(holder.project_ids) && holder.project_ids.some((p) => sameProjectFolder(p, id));
}

/**
 * The holder's job is in another project, and this one is named only because the
 * boot check still follows a job left running there (project_ids).
 * @param {SlotClaim} holder
 * @param {unknown} id
 */
function namedByBootOnly(holder, id) {
  return holder.kind !== 'check' && id !== undefined && !sameProjectFolder(holder.project_id, id);
}

/**
 * @param {SlotClaim | null} holder
 * @param {unknown} [id] the project asked about
 */
export function projectBusyMessage(holder, id) {
  if (!holder) return '';
  if (holder.kind === 'check') return 'The app is checking this project for jobs left running. Try again in a few seconds.';
  if (namedByBootOnly(holder, id)) return 'A job left running in this project has not ended yet. Try again when it has ended.';
  if (holder.phase === 'draining') return 'A job in this project is still stopping. Try again when it has stopped.';
  if (holder.kind === 'foam') return 'A plugin case in this project is running. Stop it before deleting the project.';
  if (holder.kind === 'geometry') return 'A geometry in this project is updating. Try again when it has finished.';
  if (holder.kind === 'mesh') return 'A mesh in this project is generating. Stop it before deleting the project.';
  return 'A run in this project is solving. Stop it before deleting the project.';
}

/**
 * @param {SlotClaim | null} holder
 * @param {string} title
 * @param {unknown} [id] that project's id
 */
export function folderBusyMessage(holder, title, id) {
  if (!holder) return '';
  if (holder.kind === 'check') return `The app is checking ${title} for jobs left running. Try again in a few seconds.`;
  if (namedByBootOnly(holder, id)) return `A job left running in ${title} has not ended yet. Try again when it has ended.`;
  if (holder.phase === 'draining') return `A job in ${title} is still stopping. Try again when it has stopped.`;
  if (holder.kind === 'geometry') return `A geometry in ${title} is updating. Try again when it has finished.`;
  return `A job in ${title} is running. Stop it before deleting the folder.`;
}

/**
 * The claim is the job of this queue row: its mesh, its run, its plugin case or its geometry update,
 * in the row's project.
 * @param {SlotClaim | null} holder
 * @param {{ kind?: string, project_id?: unknown, mesh_id?: unknown, run_id?: unknown, job_id?: unknown } | null} row
 */
export function holderIsRow(holder, row) {
  if (!holder || !row) return false;
  if (!sameProjectFolder(holder.project_id, row.project_id)) return false;
  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => a !== undefined && a !== null && a !== '' && String(a) === String(b);
  if (row.kind === 'mesh') return holder.kind === 'mesh' && same(holder.mesh_id, row.mesh_id);
  if (row.kind === 'solve') return holder.kind === 'solve' && same(holder.run_id, row.run_id);
  if (row.kind === 'foam') return holder.kind === 'foam' && same(holder.job_id, row.job_id);
  if (row.kind === 'geometry') return holder.kind === 'geometry' && same(holder.job_id, row.job_id);
  return false;
}

/** True the first time in a process (the boot check runs once per process). */
export function markBootOnce() {
  const s = state();
  if (s.bootPid === process.pid) return false;
  s.bootPid = process.pid;
  return true;
}

/** @param {{ now?: () => number }} [opts] */
export function resetComputeSlotForTests(opts = {}) {
  const s = state();
  s.claim = null;
  s.next = 1;
  s.bootPid = null;
  s.releaseHook = null;
  s.pendingStops = new Map();
  s.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
}
