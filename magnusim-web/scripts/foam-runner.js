// @ts-check
/**
 * The step-list runner: one way to run a list of OpenFOAM steps on the compute
 * slot, for any caller. A plugin OpenFOAM case (queue kind `foam`) is its first
 * user; a plugin mesher (queue kind `mesh`) calls the same API later.
 *
 * ## API (host code only; plugins see the WSL step table in compatibility.md)
 *
 *   runFoamSteps(plan) → {ok:true} | {busy:true} | {ok:false, final:true, code, error}
 *   registerStepRunKind(kind, {onEvent(rec, ev), onEnd(rec)})
 *   prepareFromJob(row, params, {jobId, caseDir}) → plan.prepare
 *   stopFoamCase(id, {force, by, reason}), stepRunRecord(id)
 *
 * runFoamSteps is synchronous: no await and no RPC. The caller has created the
 * store record (foam-store.js, status `queued`) and resolved everything that
 * needs an RPC before it calls. In order it: (1) answers {busy:true} while the
 * slot is held, taking no claim (except a `solve` plan's own held claim: see
 * claim_token); (2) needs the record `queued` and of this
 * projects root, else final `missing`; (3) checks the case folder (below), else
 * final `not_found` or `invalid_path`; (4) removes a leftover `.magnusim-stop` and
 * writes the spec file (.cache/foam-specs/<job_id>.json) atomically; (5) claims the
 * slot, marks the record `running` and launches the relay through its hidden
 * starter. A throw anywhere releases the claim (if taken) and finishes the record
 * `failed`, code `launch`.
 *
 * ### The plan
 *   job_id      the store record (`fc-…`).
 *   claim       {kind, project_id, name, …info}: what the slot holds and the Queue
 *               shows. `foam` for plugin cases; `mesh` for the mesher path, whose
 *               branch in startMeshGenerateBody must leave w21's liveJob alone;
 *               `solve` for a core solve ({kind, project_id, run_id, name, job_id}).
 *   claim_token a `solve` plan only: the token of the `solve` claim its Start
 *               already holds. runFoamSteps adopts that claim (phase running, job_id)
 *               instead of answering busy or claiming again; the caller then keeps it
 *               (slot.keep()), and the runner releases it once, at the run's end. The
 *               caller checks its own stop request before it calls.
 *   case_base   the folder the case lies in, inside <projects root>/<project_id>
 *               (a plugin case: that project's plugins/<key>; a core solve: its run
 *               folder, simulation_runs/<run>).
 *   case_parts  the case folder's parts below case_base, as spelled on disk; each a
 *               directory and not a link (junctions count as links). A core solve: ['case'].
 *   case_dir    case_base joined with case_parts.
 *   plugin      the plugin that owns the run (a core solve: its analysis's plugin).
 *   run_id, simulation_id  a core solve only: its run and study (spec extras).
 *   wsl_case    the WSL case id (cfddesk-pf-<plugin>-<study>-<token> for plugin cases,
 *               cfddesk-w27-<run_id> for a core solve).
 *   wsl_root    the WSL case root when the run was queued; every probe and kill uses it.
 *   token       8 hex: names the run's WSL scripts (foam-pre-<token>.sh, solve-pf-<token>.sh).
 *   prepare     null, or a JobKind run on the host before anything reaches WSL:
 *               {job, runtime:'core'|'plugin', args, env} (prepareFromJob builds it
 *               from a jobs.describe row). The spec names no program: the relay
 *               finds the owning plugin's own tool and interpreter itself.
 *   pre         the WSL steps [{tool, args?, parallel?}] from the one allowlist
 *               (python/cfddesk/wsl/foam_case.py); may be empty.
 *   n_procs     the ranks of parallel steps and of the solver; slots_hint the saved
 *               WSL MPI slot count (the relay clamps by WSL's own count).
 *   solver      null, or {app, keep_frames, process_names, stop_strategy, frame_fields, parallel,
 *               analysis?}; analysis (a core solve) names the analysis whose log parser
 *               the relay uses.
 *   owner, hooks  solve hooks, only with a solver.
 *   At least one of prepare, pre and solver.
 * The record gets log_path, the run's job log (spawnJob's jobLog), at the spawn.
 *
 * ### Events
 * The relay's events are mapped to frame events and given to the kind's
 * onEvent(rec, ev): queued {ahead}; start; stage {stage}; prepare {job, exit_code};
 * prepare_stage {stage}; pre {tool, index, exit_code, parallel?, n_procs?, skipped?};
 * ranks {n_procs}; phase {phase, seconds}; progress {time, n_steps, residuals,
 * co_max?, co_mean?, delta_t?, points} (at most one per 250 ms, plus one at each
 * stage change and at the end; a `solve` run's also carries open, the step the
 * solver is on); time_saved {t}; warning {code, message};
 * end {status, error, code, result}. None carries a path, a pid, a log line or
 * exception text.
 *
 * ### End statuses (from evidence, never from an exit code)
 * done, failed, stopped or lost. A stop that was asked for gives `stopped`; done
 * needs the relay's clean outcome for the plan's last phase (solve, else pre, else
 * prepare), or, when the relay died, a status file that saw the clean end. Codes:
 * the gate's refusal codes, prepare, prepare_unavailable, invalid_spec, launch,
 * relay_failed, lost, stuck, missing. Every finish calls the kind's onEnd once.
 *
 * ### Rules every caller keeps
 * One compute slot: claimed (or the Start's held `solve` claim adopted) at the
 * spawn, released only when the relay has ended and WSL is verified gone (a
 * drain watches the case copy until then). The step allowlist, argument and
 * path rules are checked only in the relay's gate. One run per case folder
 * (.magnusim-ran, written before the prepare step). Nothing
 * reaches WSL before the gate and the prepare step have passed. The prepare step
 * is the owning plugin's own JobKind tool, on the core interpreter or that
 * plugin's own ready environment, never another program.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PYTHON, WEB_ROOT, pyTool } from './python-env.js';
import { PROJECTS_ROOT } from './project-isolation.js';
import { spawnJob } from './job-runner.js';
import {
  claimComputeSlot,
  computeSlotHolder,
  patchComputeSlot,
  releaseComputeSlot,
  sameProjectFolder,
} from './compute-slot.js';
import { killWslCase, probeWslCase, watchWslCaseGone } from './wsl-case-watch.js';
import {
  createFoamRecord,
  emitFoamEvent,
  listFoamRecords,
  readFoamRecord,
  thinPoints,
  updateFoamRecord,
} from './foam-store.js';
import {
  dropComputeRows,
  dropFoamJobs,
  pushComputeNotice,
  queueAheadOf,
  queueHasRow,
  removeComputeJob,
  snapshotComputeQueue,
} from './server/compute-queue.ts';
import { liveRegistryLoaded, pluginLoaded, solverForApplication } from './registry-defaults.js';
import { hardwarePrefs } from './prefs.js';
import { solveHookNames } from './solve-hooks.js';
import { jobArgsFromParams, pluginJobEnv } from './server/registered-tool.js';
import { LEGACY_FRAME_FIELDS, listFoamTimeDirs } from './project-layout.js';
import { hardwareRankCap } from './ranks.js';
import { STEP_METRICS, closeStep as closeSolveStep, foldSolveEvent, newSolveFold } from './solve-fold.js';

export { createFoamRecord };

const WIN = process.platform === 'win32';
const STATUS_FILE = '.magnusim-run.json';
const STOP_FILE = '.magnusim-stop';
const POLL_STATUS_MS = 2_000;
const POLL_ALIVE_MS = 10_000;
const RELAY_KILL_AFTER_MS = 120_000;
const PROGRESS_EVERY_MS = 250;
const POINTS_MAX = 400;
const PENDING_MAX = 2000;
const CTL_TIMEOUT_MS = 15_000;
const LEVELS = ['graceful', 'solver', 'all'];
const FRAME_STAGES = new Set([
  'prepare',
  'pre_copy_in',
  'pre_copy_back',
  'copy_to_wsl',
  'decompose',
  'solve',
  'reconstruct',
  'copy',
  'cleanup',
  'stopping',
  'ending',
]);
const FRAME_PHASES = new Set(['prepare', 'pre', 'copy_in', 'decompose', 'solve', 'reconstruct', 'copy_back']);
const STAGE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** Fixed texts (no paths, no exception text). */
export const FOAM_TEXT = Object.freeze({
  launch: 'The case could not start',
  relayFailed: 'The case could not start. See the log',
  lost: 'The app lost track of this case while it ran. Results saved before then are in the case folder',
  unreachable: 'WSL stopped answering while this case ran. Results saved before then are in the case folder',
  stuck: 'Its processes in WSL would not stop. Restart WSL (wsl --shutdown) before running more cases',
  removed: 'Removed from the queue before it started',
  lostQueue: 'Lost from the queue',
  lostBefore: 'Lost before it started',
  studyGone: 'The study was deleted',
  notLoaded: 'The plugin list is not loaded yet',
  missing: 'The run is no longer in the list',
});

/** solve.sh error codes the frame is told about. */
const WARNING_TEXT = Object.freeze({
  46: 'The case has no mesh (constant/polyMesh)',
  47: 'The case copy could not be opened in WSL',
  48: 'A result frame could not be copied back',
});

/** What the relay's gate refusals say when it gave no text of its own. */
const GATE_TEXT = Object.freeze({
  bad_request: 'The case settings are not valid',
  invalid_path: 'The case path cannot be used',
  not_a_case: 'The folder is not an OpenFOAM case',
  has_results: 'This case already ran. Write a new case folder for each run.',
  app_not_allowed: 'That solver is not allowed',
  pre_not_allowed: 'A step is not allowed',
  not_found: 'The case folder is missing',
  invalid_spec: 'The prepare step is not one this plugin can run',
  prepare_unavailable: 'The prepare step cannot run right now',
});

// ---- the process-wide state ----

/**
 * @typedef {{
 *   token: string, kind: string, adopted: boolean, launcherExit: number | null, relayGone: boolean,
 *   allKilledAt: number | null, timers: Set<ReturnType<typeof setTimeout>>, release: () => void,
 *   gone: boolean, fold: ReturnType<typeof newFoamFold>, savedSeen: Set<number>, lastStage: string | null,
 *   relayKillTimer: ReturnType<typeof setTimeout> | null, staleLogged: boolean,
 * }} Entry
 */

/** @returns {{ entries: Map<string, Entry>, kinds: Map<string, { onEvent: Function, onEnd: Function }>, epochs: { all: number, byKey: Map<string, number> }, aheads: Map<string, number | null>, testDeps: Record<string, any> | null, unhandled: Set<string> }} */
function R() {
  const key = Symbol.for('magnusim.foamRunner');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) {
    g[key] = {
      entries: new Map(),
      kinds: new Map(),
      epochs: { all: 0, byKey: new Map() },
      aheads: new Map(),
      testDeps: null,
      unhandled: new Set(),
    };
  }
  return g[key];
}

/** The calls the runner makes outside itself (tests replace them). */
const DEFAULT_DEPS = {
  spawnJob,
  probeWslCase,
  killWslCase,
  watchWslCaseGone,
  relayAlive,
  killRelay,
  queueHasRow,
  queueAheadOf,
  queueRows: () => snapshotComputeQueue().items,
  removeComputeJob,
  dropFoamJobs,
  dropComputeRows,
  pushComputeNotice,
  liveRegistryLoaded,
  pluginLoaded,
  solverForApplication,
  hardwareRankCap,
  slotsHint: () => {
    const hw = hardwarePrefs();
    const n = hw && Number(hw.wsl_mpi_slots);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  },
  hookNames: solveHookNames,
  specDir: () => join(WEB_ROOT, '.cache', 'foam-specs'),
};

function D() {
  const over = R().testDeps;
  return over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

/** @param {Record<string, any> | null} deps */
export function setFoamRunnerDepsForTests(deps) {
  R().testDeps = deps ? { ...deps } : null;
}

export function resetFoamRunnerForTests() {
  const r = R();
  for (const entry of r.entries.values()) clearEntryTimers(entry);
  r.entries.clear();
  r.epochs = { all: 0, byKey: new Map() };
  r.aheads.clear();
  r.unhandled.clear();
  r.testDeps = null;
}

/** @param {Entry} entry */
function clearEntryTimers(entry) {
  for (const t of entry.timers) clearTimeout(t);
  entry.timers.clear();
  if (entry.relayKillTimer) clearTimeout(entry.relayKillTimer);
  entry.relayKillTimer = null;
  if (entry.fold && entry.fold.timer) clearTimeout(entry.fold.timer);
  if (entry.fold) entry.fold.timer = null;
}

/**
 * @param {Entry} entry
 * @param {() => void} fn
 * @param {number} ms
 */
function later(entry, fn, ms) {
  const t = setTimeout(() => {
    entry.timers.delete(t);
    fn();
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  entry.timers.add(t);
  return t;
}

/**
 * @param {{ token: string, kind: string, adopted: boolean, release: () => void }} base
 * @returns {Entry}
 */
function newEntry(base) {
  return {
    ...base,
    launcherExit: null,
    relayGone: false,
    allKilledAt: null,
    timers: new Set(),
    gone: false,
    fold: newFoamFold(),
    savedSeen: new Set(),
    lastStage: null,
    relayKillTimer: null,
    staleLogged: false,
  };
}

// ---- kinds ----

/**
 * The handlers of one kind of run (registered at module load, so a run adopted
 * after a restart reaches them too). A re-imported module replaces them.
 * @param {string} kind
 * @param {{ onEvent?: (rec: any, ev: any) => void, onEnd?: (rec: any) => void }} handlers
 */
export function registerStepRunKind(kind, handlers) {
  R().kinds.set(String(kind), {
    onEvent: typeof handlers.onEvent === 'function' ? handlers.onEvent : () => {},
    onEnd: typeof handlers.onEnd === 'function' ? handlers.onEnd : () => {},
  });
}

/** @param {any} rec */
function handlersOf(rec) {
  const h = rec ? R().kinds.get(String(rec.kind)) : null;
  if (!h && rec && !R().unhandled.has(rec.id)) {
    R().unhandled.add(rec.id);
    console.info(`[CFD runner] ${rec.id}: no handler for kind ${rec.kind}; followed and finished in the store only`);
  }
  return h || null;
}

/**
 * Hand one frame event to the run's kind.
 * @param {string} id
 * @param {Record<string, any>} ev
 */
function deliver(id, ev) {
  const rec = readFoamRecord(id);
  const h = handlersOf(rec);
  if (!h) return;
  try {
    h.onEvent(rec, ev);
  } catch (e) {
    console.warn(`[CFD runner] ${id}: onEvent failed`, e);
  }
}

/** The record of any kind of run, or null. */
export function stepRunRecord(id) {
  return readFoamRecord(id);
}

// ---- paths and files ----

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  const x = resolve(a);
  const y = resolve(b);
  return WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The case folder rule: case_base inside <projects root>/<project_id> (a plugin
 * case: its plugins/<key>; a core solve: a run folder, whose parent folder is
 * simulation_runs, with case_parts ['case']), case_dir = case_base + case_parts,
 * and every folder from case_base down a directory and not a link.
 * @param {{ project_id?: unknown, case_base?: unknown, case_parts?: unknown, case_dir?: unknown, plugin?: unknown, kind?: unknown, case_rel?: unknown }} p
 * @returns {{ code: 'not_found' | 'invalid_path', error: string } | null}
 */
export function caseFolderProblem(p) {
  const invalid = { code: /** @type {'invalid_path'} */ ('invalid_path'), error: 'The case folder path cannot be used' };
  const pid = String(p.project_id || '');
  if (!pid || pid !== basename(pid) || pid === '.' || pid === '..') return invalid;
  const projDir = resolve(PROJECTS_ROOT, pid);
  const base = resolve(String(p.case_base || ''));
  if (!p.case_base) return invalid;
  const inside = base.length > projDir.length && samePath(base.slice(0, projDir.length), projDir) && /[\\/]/.test(base[projDir.length]);
  if (!inside) return invalid;
  if (p.kind === 'foam' && !samePath(base, join(projDir, 'plugins', String(p.plugin || '')))) return invalid;
  const parts = Array.isArray(p.case_parts) ? p.case_parts.map(String) : [];
  if (!parts.length || parts.some((x) => !x || x === '.' || x === '..' || /[\\/]/.test(x))) return invalid;
  if (p.kind === 'solve') {
    const runs = basename(dirname(base));
    if (parts.length !== 1 || parts[0] !== 'case' || (WIN ? runs.toLowerCase() : runs) !== 'simulation_runs') return invalid;
  }
  if (!p.case_dir || !samePath(String(p.case_dir), join(base, ...parts))) return invalid;
  let cur = base;
  for (let i = -1; i < parts.length; i += 1) {
    if (i >= 0) cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return { code: 'not_found', error: `${String(p.case_rel || parts.slice(-1)[0] || 'The case folder')} is missing` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return invalid;
  }
  return null;
}

/**
 * @param {string} path
 * @param {string} text
 */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = e && /** @type {any} */ (e).code;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 5) {
        try {
          unlinkSync(tmp);
        } catch {
          /* gone */
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** @param {string} caseDir */
function readStatusFile(caseDir) {
  try {
    const doc = JSON.parse(readFileSync(join(caseDir, STATUS_FILE), 'utf8'));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/** @param {string} caseDir */
function removeStopMarker(caseDir) {
  try {
    rmSync(join(caseDir, STOP_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

/** @param {any} rec */
function writeStopMarker(rec) {
  const stop = rec.stop || {};
  writeAtomic(
    join(rec.case_dir, STOP_FILE),
    JSON.stringify({ level: stop.level || 'graceful', seq: Number(stop.seq) || 1, at: stop.at || new Date().toISOString(), by: stop.by || 'user' }),
  );
}

/** @param {any} rec */
function scriptsOf(rec) {
  return [`foam-pre-${rec.token}.sh`, `solve-pf-${rec.token}.sh`];
}

/** @param {any} v */
function finite(v) {
  return typeof v === 'number' ? Number.isFinite(v) : v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

// ---- the spec ----

/**
 * The spec file the relay reads (it trusts nothing in it: its gate checks all).
 * @param {any} plan
 */
export function buildFoamSpec(plan) {
  const s = plan.solver;
  const solver = s
    ? {
        app: String(s.app || ''),
        keep_frames: String(s.keep_frames || 'latest'),
        frame_fields: (Array.isArray(s.frame_fields) ? s.frame_fields : []).map(String),
        process_names: (Array.isArray(s.process_names) && s.process_names.length ? s.process_names : [s.app]).map(String),
        stop_strategy: String(s.stop_strategy || 'kill'),
        parallel: String(s.parallel || 'none'),
        ...(s.analysis ? { analysis: String(s.analysis) } : {}),
      }
    : null;
  const p = plan.prepare;
  const kind = String((plan.claim && plan.claim.kind) || 'foam');
  return {
    v: 1,
    kind,
    job_id: String(plan.job_id),
    token: String(plan.token),
    project_id: String((plan.claim && plan.claim.project_id) || plan.project_id || ''),
    case_dir: String(plan.case_dir),
    case_base: String(plan.case_base),
    case_parts: (plan.case_parts || []).map(String),
    plugin: plan.plugin ? String(plan.plugin) : null,
    wsl_case: String(plan.wsl_case),
    wsl_root: String(plan.wsl_root),
    n_procs: Math.max(1, Math.floor(Number(plan.n_procs) || 1)),
    slots_hint: finite(plan.slots_hint) && Number(plan.slots_hint) >= 1 ? Math.floor(Number(plan.slots_hint)) : null,
    prepare: p
      ? {
          job: String(p.job),
          runtime: p.runtime === 'plugin' ? 'plugin' : 'core',
          args: (Array.isArray(p.args) ? p.args : []).map(String),
          env: Object.fromEntries(Object.entries(p.env || {}).map(([k, v]) => [k, String(v)])),
        }
      : null,
    pre: (Array.isArray(plan.pre) ? plan.pre : []).map((step) => ({
      tool: String(step.tool),
      args: (Array.isArray(step.args) ? step.args : []).map(String),
      parallel: step.parallel === true,
    })),
    solver,
    owner: solver && plan.owner ? String(plan.owner) : null,
    hooks: solver && plan.owner && Array.isArray(plan.hooks) ? plan.hooks.map(String) : [],
    // A core solve's run and study (the relay checks wsl_case against the run id).
    ...(kind === 'solve'
      ? {
          run_id: String(plan.run_id || (plan.claim && plan.claim.run_id) || ''),
          simulation_id: String(plan.simulation_id || ''),
        }
      : {}),
  };
}

/**
 * plan.prepare from a jobs.describe row: args and env exactly as /api/jobs builds
 * them, with MAGNUSIM_JOB_ID the record id and MAGNUSIM_CASE_DIR the case folder.
 * The relay resolves the tool and interpreter itself.
 * @param {{ key?: string, kind?: string, runtime?: string, plugin?: string, args_from_params?: string[] }} row
 * @param {Record<string, unknown>} params
 * @param {{ jobId: string, caseDir: string }} ids
 */
export function prepareFromJob(row, params, { jobId, caseDir }) {
  const env = { ...pluginJobEnv(row, params || {}, { id: jobId }), MAGNUSIM_JOB_ID: String(jobId), MAGNUSIM_CASE_DIR: String(caseDir) };
  return {
    job: String(row.key || row.kind || ''),
    runtime: row.runtime === 'plugin' ? 'plugin' : 'core',
    args: jobArgsFromParams(row, params || {}),
    env,
  };
}

// ---- running ----

/**
 * @param {string} id
 * @param {string} code
 * @param {string} error
 * @returns {{ ok: false, final: true, code: string, error: string }}
 */
function finalFail(id, code, error) {
  finishFoam(id, 'failed', { code, error });
  return { ok: false, final: true, code, error };
}

/**
 * The slot holder is the `solve` claim this core solve's Start holds (plan.claim_token).
 * @param {any} plan
 * @param {{ token: string, kind: string }} holder
 */
function heldSolveClaim(plan, holder) {
  if (!plan || !plan.claim_token || holder.kind !== 'solve') return false;
  if (String((plan.claim && plan.claim.kind) || '') !== 'solve') return false;
  return holder.token === String(plan.claim_token);
}

/**
 * Run a plan (see the top of this file). Synchronous.
 * @param {any} plan
 * @returns {{ ok: true } | { busy: true } | { ok: false, final: true, code: string, error: string }}
 */
export function runFoamSteps(plan) {
  const holder = computeSlotHolder();
  const adopt = !!(holder && heldSolveClaim(plan, holder));
  if (holder && !adopt) return { busy: true };
  const id = plan && plan.job_id ? String(plan.job_id) : '';
  const rec = id ? readFoamRecord(id) : null;
  if (!rec || rec.status !== 'queued') return { ok: false, final: true, code: 'missing', error: FOAM_TEXT.missing };
  /** @type {string | null} */
  let token = null;
  try {
    if (!plan.prepare && !(Array.isArray(plan.pre) && plan.pre.length) && !plan.solver) {
      return finalFail(id, 'invalid_spec', 'The run has no steps');
    }
    const kind = String((plan.claim && plan.claim.kind) || rec.kind || 'foam');
    const bad = caseFolderProblem({ ...plan, project_id: (plan.claim && plan.claim.project_id) || rec.project_id, kind, case_rel: rec.case_rel });
    if (bad) return finalFail(id, bad.code, bad.error);
    // Host writes: a stop marker left over from an earlier run goes; the spec file.
    removeStopMarker(String(plan.case_dir));
    const dir = D().specDir();
    mkdirSync(dir, { recursive: true });
    const specPath = join(dir, `${id}.json`);
    writeAtomic(specPath, JSON.stringify(buildFoamSpec({ ...plan, claim: { ...(plan.claim || {}), kind } }), null, 2));
    // Claim (or adopt the Start's held claim), persist, spawn: in this order, in this tick.
    if (adopt) {
      const held = String(plan.claim_token);
      if (!patchComputeSlot(held, { ...(plan.claim || {}), job_id: id, phase: 'running' })) return { busy: true };
      token = held;
    } else {
      const claimed = claimComputeSlot(/** @type {any} */ (kind), { ...(plan.claim || {}), job_id: id }, { phase: 'running' });
      if (!claimed.ok) return { busy: true };
      token = claimed.token;
    }
    const own = token;
    updateFoamRecord(id, { status: 'running', stage: 'starting', node_pid: process.pid, started_at: new Date().toISOString(), spec_path: specPath });
    const entry = newEntry({ token: own, kind, adopted: false, release: () => releaseComputeSlot(own) });
    R().entries.set(id, entry);
    const spawned = D().spawnJob({
      kind,
      jobId: id,
      script: pyTool('run_foam_case.py'),
      args: ['--launch', '--spec', specPath],
      onEvent: (/** @type {any} */ ev) => onRelayEvent(id, ev),
      onExit: (/** @type {number | null} */ code) => {
        entry.launcherExit = typeof code === 'number' ? code : -1;
        console.info(`[CFD runner] ${id}: starter exited ${entry.launcherExit}`);
      },
      onClose: () => afterRelayGone(id),
    });
    const logPath = spawned && spawned.jobLog && spawned.jobLog.path;
    if (logPath) updateFoamRecord(id, { log_path: String(logPath) });
    deliver(id, { event: 'start' });
    return { ok: true };
  } catch (e) {
    console.warn(`[CFD runner] ${id}: the run could not start`, e);
    if (token) {
      const entry = R().entries.get(id);
      if (entry && entry.token === token) R().entries.delete(id);
      releaseComputeSlot(token);
    }
    finishFoam(id, 'failed', { code: 'launch', error: FOAM_TEXT.launch });
    return { ok: false, final: true, code: 'launch', error: FOAM_TEXT.launch };
  }
}

// ---- events ----

/** A fresh progress fold: the shared step fold (solve-fold.js) and the frame's points. */
export function newFoamFold() {
  return {
    ...newSolveFold(),
    steps: 0,
    /** @type {any[]} */
    pending: [],
    /** @type {any} */
    last: null,
    /** @type {number | null} */
    lastEmitAt: null,
    /** @type {ReturnType<typeof setTimeout> | null} */
    timer: null,
    dirty: false,
  };
}

/**
 * A closed step becomes the frame's next point.
 * @param {ReturnType<typeof newFoamFold>} state
 * @param {Record<string, number> | null} step
 */
function takeStep(state, step) {
  if (!step) return;
  const point = { ...step };
  state.steps += 1;
  state.pending.push(point);
  if (state.pending.length > PENDING_MAX) state.pending.splice(0, state.pending.length - PENDING_MAX);
  state.last = point;
  state.dirty = true;
}

/** @param {ReturnType<typeof newFoamFold>} state */
function closeStep(state) {
  takeStep(state, closeSolveStep(state));
}

/**
 * Fold one solver event into the steps (solve-fold.js): a `progress` event closes
 * the step before it; a Courant/deltaT block printed before `Time = t` is step t's;
 * per step the largest initial residual of each field is kept ('max', plugin cases)
 * or its last one ('last': a core solve, the rule its Run panel always plotted).
 * @param {ReturnType<typeof newFoamFold>} state
 * @param {any} ev
 * @param {'max' | 'last'} [residual]
 */
export function foldFoamEvent(state, ev, residual = 'max') {
  if (!ev || !state) return;
  takeStep(state, foldSolveEvent(state, ev, { residual }));
}

/**
 * The progress frame for what was folded since the last one, or null.
 * @param {ReturnType<typeof newFoamFold>} state
 * @param {number} now
 */
export function takeProgressFrame(state, now) {
  if (!state.dirty) return null;
  state.dirty = false;
  state.lastEmitAt = now;
  const points = thinPoints(state.pending, POINTS_MAX);
  state.pending = [];
  const last = state.last || {};
  /** @type {Record<string, number>} */
  const residuals = {};
  for (const [k, v] of Object.entries(last)) if (k !== 't' && !STEP_METRICS.includes(k)) residuals[k] = /** @type {number} */ (v);
  /** @type {Record<string, any>} */
  const ev = { event: 'progress', time: last.t, n_steps: state.steps, residuals, points };
  for (const k of STEP_METRICS) if (finite(last[k])) ev[k] = last[k];
  return ev;
}

/**
 * @param {string} id
 * @param {Entry} entry
 */
function emitProgress(id, entry) {
  const st = entry.fold;
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  const ev = takeProgressFrame(st, Date.now());
  if (!ev) return;
  // A core solve's Run panel shows the step the solver is on (its time and Courant number).
  if (entry.kind === 'solve' && st.current) ev.open = { ...st.current };
  updateFoamRecord(id, { time: ev.time, n_steps: ev.n_steps }, { write: 'soon' });
  deliver(id, ev);
}

/**
 * At most one progress frame every 250 ms; a later one waits on a timer.
 * @param {string} id
 * @param {Entry} entry
 */
function maybeEmitProgress(id, entry) {
  const st = entry.fold;
  if (!st.dirty) return;
  const now = Date.now();
  if (st.lastEmitAt === null || now - st.lastEmitAt >= PROGRESS_EVERY_MS) {
    emitProgress(id, entry);
    return;
  }
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    emitProgress(id, entry);
  }, PROGRESS_EVERY_MS - (now - st.lastEmitAt));
  if (typeof st.timer.unref === 'function') st.timer.unref();
}

/**
 * @param {string} id
 * @param {string} stage
 */
function setStage(id, stage) {
  const entry = R().entries.get(id);
  if (entry) {
    emitProgress(id, entry);
    if (entry.lastStage === stage) return;
    entry.lastStage = stage;
  }
  updateFoamRecord(id, { stage });
  deliver(id, { event: 'stage', stage });
}

/**
 * One event line of the relay (or its starter).
 * @param {string} id
 * @param {any} ev
 */
function onRelayEvent(id, ev) {
  const entry = R().entries.get(id);
  if (!entry || !ev || typeof ev.event !== 'string') return;
  try {
    relayEvent(id, entry, ev);
  } catch (e) {
    console.warn(`[CFD runner] ${id}: event ${ev.event} failed`, e);
  }
}

/**
 * Relay events → frame events (only frame-ready ones pass).
 * @param {string} id
 * @param {Entry} entry
 * @param {any} ev
 */
export function relayEvent(id, entry, ev) {
  switch (ev.event) {
    case 'stage': {
      const stage = String(ev.stage || '');
      if (FRAME_STAGES.has(stage) && stage !== 'stopping' && stage !== 'ending') setStage(id, stage);
      return;
    }
    case 'prepare': {
      const exit = Number(ev.exit_code);
      deliver(id, { event: 'prepare', job: String(ev.job || ''), exit_code: Number.isFinite(exit) ? exit : null });
      return;
    }
    case 'prepare_stage': {
      const stage = String(ev.stage || '');
      if (STAGE_NAME_RE.test(stage)) deliver(id, { event: 'prepare_stage', stage });
      return;
    }
    case 'pre': {
      const tool = String(ev.tool || '');
      if (!TOOL_RE.test(tool)) return;
      /** @type {Record<string, any>} */
      const out = { event: 'pre', tool, index: Number(ev.index) || 0, exit_code: finite(ev.exit_code) ? Number(ev.exit_code) : null };
      if (typeof ev.parallel === 'boolean') out.parallel = ev.parallel;
      if (finite(ev.n_procs)) out.n_procs = Number(ev.n_procs);
      if (ev.skipped === true) out.skipped = true;
      deliver(id, out);
      return;
    }
    case 'ranks': {
      const n = Math.floor(Number(ev.n_procs));
      if (!Number.isFinite(n) || n < 1) return;
      updateFoamRecord(id, { n_procs_run: n }, { write: 'soon' });
      deliver(id, { event: 'ranks', n_procs: n });
      return;
    }
    case 'phase': {
      const phase = String(ev.phase || '');
      const seconds = Number(ev.seconds);
      if (!FRAME_PHASES.has(phase) || !Number.isFinite(seconds)) return;
      const rec = readFoamRecord(id);
      const phases = { ...((rec && rec.phases) || {}), [phase]: seconds };
      updateFoamRecord(id, { phases }, { write: 'soon' });
      deliver(id, { event: 'phase', phase, seconds });
      return;
    }
    case 'progress':
    case 'residual':
    case 'courant':
      foldFoamEvent(entry.fold, ev, entry.kind === 'solve' ? 'last' : 'max');
      maybeEmitProgress(id, entry);
      return;
    case 'time_saved': {
      const t = Number(ev.t);
      if (!Number.isFinite(t) || entry.savedSeen.has(t)) return;
      entry.savedSeen.add(t);
      deliver(id, { event: 'time_saved', t });
      return;
    }
    case 'error': {
      const code = Number(ev.code);
      const message = /** @type {any} */ (WARNING_TEXT)[code];
      if (message) deliver(id, { event: 'warning', code, message });
      return;
    }
    default:
      // start, result, pre_result, log, refused, relay_launch, relay_end: not frame events.
      return;
  }
}

// ---- ending ----

/** @param {any} rec */
function lastPhaseOf(rec) {
  if (rec && rec.app) return 'solve';
  if (rec && Array.isArray(rec.pre) && rec.pre.length) return 'pre';
  return 'prepare';
}

/** @param {any} rec */
function savedTimesOf(rec) {
  if (!rec || !rec.app) return [];
  try {
    return listFoamTimeDirs(rec.case_dir, { complete: true })
      .map((n) => Number(n))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * The status a run ends with, from its record and the relay's status file (never
 * from an exit code).
 * @param {any} rec
 * @param {any} status the status file, or null
 * @returns {{ status: 'done'|'failed'|'stopped'|'lost', code: string | null, error: string | null }}
 */
export function foamEndFromEvidence(rec, status) {
  const outcome = status && status.outcome && typeof status.outcome === 'object' ? status.outcome : null;
  if (rec && rec.stop) {
    const host = rec.stop.by && rec.stop.by !== 'user';
    return { status: 'stopped', code: null, error: host ? `Stopped: ${rec.stop.reason || 'stopped by the app'}` : null };
  }
  if (outcome) {
    const exit = finite(outcome.exit_code) ? Number(outcome.exit_code) : finite(status.exit_code) ? Number(status.exit_code) : null;
    if (outcome.stopped === true) return { status: 'stopped', code: null, error: null };
    if (outcome.ok === true && String(outcome.phase || '') === lastPhaseOf(rec)) return { status: 'done', code: null, error: null };
    if (outcome.ok === true) return { status: 'failed', code: null, error: 'The run ended before its last step' };
    const phase = String(outcome.phase || '');
    if (phase === 'gate') {
      const code = typeof outcome.code === 'string' && /^[a-z_]{2,40}$/.test(outcome.code) ? outcome.code : 'bad_request';
      const given = typeof outcome.error === 'string' && outcome.error.length <= 300 ? outcome.error : '';
      return { status: 'failed', code, error: given || /** @type {any} */ (GATE_TEXT)[code] || 'The case was refused' };
    }
    if (phase === 'prepare') {
      const job = typeof outcome.job === 'string' && SAFE_ID_RE.test(outcome.job.replace(/:/g, '-')) ? outcome.job : (rec.prepare && rec.prepare.job) || 'job';
      return { status: 'failed', code: 'prepare', error: `Prepare step ${job} failed (exit ${exit ?? '?'}). See log.prepare in the case folder` };
    }
    if (phase === 'pre') {
      const tool = typeof outcome.tool === 'string' && TOOL_RE.test(outcome.tool) ? outcome.tool : 'A step';
      const index = Number(outcome.index) || 0;
      if (exit === 50) return { status: 'failed', code: null, error: `${tool} wrote a time folder` };
      if (exit === 46) return { status: 'failed', code: null, error: WARNING_TEXT[46] };
      return { status: 'failed', code: null, error: `${tool} failed (exit ${exit ?? '?'}). See log.${tool}.${index} in the case folder` };
    }
    if (phase === 'solve') {
      if (exit !== null && /** @type {any} */ (WARNING_TEXT)[exit]) return { status: 'failed', code: null, error: /** @type {any} */ (WARNING_TEXT)[exit] };
      return { status: 'failed', code: null, error: `${rec.app || 'The solver'} failed (exit ${exit ?? '?'})` };
    }
    const code = typeof outcome.code === 'string' && /^[a-z_]{2,40}$/.test(outcome.code) ? outcome.code : null;
    const given = typeof outcome.error === 'string' && outcome.error.length <= 300 ? outcome.error : '';
    return { status: 'failed', code, error: given || 'The run failed' };
  }
  // No outcome: the relay died.
  const cleanEnd = rec && rec.app ? !!(status && (status.cleanup_seen || status.result_ok)) : !!(status && status.pre_ok);
  if (cleanEnd) return { status: 'done', code: null, error: null };
  if (!status || !status.wsl_reached) return { status: 'failed', code: 'relay_failed', error: FOAM_TEXT.relayFailed };
  return { status: 'lost', code: 'lost', error: FOAM_TEXT.lost };
}

/**
 * Finish a run once: only a `queued` or `running` record; a second call does
 * nothing. Emits `end` once and calls the kind's onEnd once, even when the store
 * write fails.
 * @param {string} id
 * @param {'done'|'failed'|'stopped'|'lost'} status
 * @param {{ code?: string | null, error?: string | null, result?: any }} [fields]
 */
export function finishFoam(id, status, fields = {}) {
  const before = readFoamRecord(id);
  if (!before || (before.status !== 'queued' && before.status !== 'running')) return false;
  const entry = R().entries.get(id);
  if (entry) {
    try {
      if (entry.fold.current) {
        closeStep(entry.fold);
      }
      emitProgress(id, entry);
    } catch {
      /* best effort */
    }
    clearEntryTimers(entry);
    R().entries.delete(id);
  }
  const patch = {
    status,
    finished_at: new Date().toISOString(),
    error: fields.error ?? null,
    code: fields.code ?? null,
    result: fields.result ?? null,
  };
  /** @type {any} */
  let rec = null;
  try {
    rec = updateFoamRecord(id, patch);
  } catch (e) {
    console.warn(`[CFD runner] ${id}: the finish was not written`, e);
  }
  if (!rec) rec = { ...before, ...patch };
  R().aheads.delete(id);
  const h = handlersOf(rec);
  if (h) {
    try {
      h.onEvent(rec, { event: 'end', status, error: patch.error, code: patch.code, result: patch.result });
    } catch (e) {
      console.warn(`[CFD runner] ${id}: end event failed`, e);
    }
    try {
      h.onEnd(rec);
    } catch (e) {
      console.warn(`[CFD runner] ${id}: onEnd failed`, e);
    }
  }
  return true;
}

/**
 * Finish a run from what it left: the record's stop and the status file.
 * @param {any} rec
 * @param {any} [status] the status file (read when not given)
 */
export function finishFoamFromEvidence(rec, status) {
  if (!rec) return null;
  const st = status === undefined ? readStatusFile(rec.case_dir) : status;
  const end = foamEndFromEvidence(rec, st);
  const saved = savedTimesOf(rec);
  const outcome = st && st.outcome && typeof st.outcome === 'object' ? st.outcome : {};
  const exit = finite(st && st.exit_code) ? Number(st.exit_code) : finite(outcome.exit_code) ? Number(outcome.exit_code) : null;
  const result = {
    exit_code: exit,
    n_procs: Number(rec.n_procs_run || (st && st.n_procs) || rec.n_procs) || 1,
    phases: rec.phases || {},
    saved_times: saved,
    last_saved: saved.length ? saved[saved.length - 1] : null,
    write_format: rec.app ? (rec.launch && rec.launch.write_format) || null : null,
  };
  finishFoam(rec.id, end.status, { code: end.code, error: end.error, result });
  return end.status;
}

/**
 * The relay has ended (own: the starter's pipes closed; adopted: it is no longer
 * running). A clean final status finishes the run; a starter that never started
 * the relay fails it; anything else drains: the slot stays held until the case
 * copy's processes in WSL are gone.
 * @param {string} id
 */
export function afterRelayGone(id) {
  const entry = R().entries.get(id);
  if (!entry || entry.gone) return;
  entry.gone = true;
  entry.relayGone = true;
  for (const t of entry.timers) clearTimeout(t);
  entry.timers.clear();
  let draining = false;
  try {
    const rec = readFoamRecord(id);
    if (!rec || rec.status !== 'running') {
      R().entries.delete(id);
      return;
    }
    const status = readStatusFile(rec.case_dir);
    if (status && status.outcome && status.clean === true) {
      try {
        finishFoamFromEvidence(rec, status);
      } catch (e) {
        console.warn(`[CFD runner] ${id}: finish failed`, e);
      }
      removeStopMarker(rec.case_dir);
      try {
        if (rec.spec_path) rmSync(String(rec.spec_path), { force: true });
      } catch {
        /* best effort */
      }
      return;
    }
    if (!status && (entry.launcherExit === 3 || entry.launcherExit === -1)) {
      try {
        finishFoam(id, 'failed', { code: 'launch', error: FOAM_TEXT.launch });
      } catch (e) {
        console.warn(`[CFD runner] ${id}: finish failed`, e);
      }
      return;
    }
    startDrain(id, entry, rec);
    draining = true;
  } catch (e) {
    console.warn(`[CFD runner] ${id}: after the relay ended`, e);
  } finally {
    if (!draining) {
      try {
        entry.release();
      } catch (e) {
        console.warn(`[CFD runner] ${id}: release failed`, e);
      }
    }
  }
}

/**
 * @param {string} id
 * @param {Entry} entry
 * @param {any} rec
 */
function startDrain(id, entry, rec) {
  patchComputeSlotFor(id, { phase: 'draining', stop_requested: !!rec.stop });
  const stage = rec.stop ? 'stopping' : 'ending';
  try {
    emitProgress(id, entry);
    entry.lastStage = stage;
    updateFoamRecord(id, { stage });
    deliver(id, { event: 'stage', stage });
  } catch (e) {
    console.warn(`[CFD runner] ${id}: stage not written`, e);
  }
  D().watchWslCaseGone({
    token: entry.token,
    wslCase: rec.wsl_case,
    scripts: scriptsOf(rec),
    root: rec.wsl_root,
    stop: () => {
      const now = readFoamRecord(id);
      return !!(now && now.stop);
    },
    onGone: () => {
      finishFoamFromEvidence(readFoamRecord(id));
    },
    onLost: (/** @type {string} */ reason) => {
      if (reason === 'stuck') finishFoam(id, 'stopped', { code: 'stuck', error: FOAM_TEXT.stuck });
      else finishFoam(id, 'lost', { code: 'lost', error: FOAM_TEXT.unreachable });
    },
    release: entry.release,
  });
}

// ---- adoption after a restart ----

/**
 * Follow a run another server process started (the boot check found its record
 * `running`). `release` ends this run's hold on the slot (the boot check's).
 * @param {any} rec
 * @param {string} token
 * @param {() => void} release
 * @param {{ relayGone?: boolean }} [opts]
 */
export function adoptFoamCase(rec, token, release, { relayGone = false } = {}) {
  const id = String(rec.id);
  const entry = newEntry({ token, kind: String(rec.kind || 'foam'), adopted: true, release });
  R().entries.set(id, entry);
  if (rec.stop && !existsSync(join(rec.case_dir, STOP_FILE))) {
    try {
      writeStopMarker(rec);
    } catch (e) {
      console.warn(`[CFD runner] ${id}: stop marker not written`, e);
    }
  }
  if (relayGone) {
    afterRelayGone(id);
    return;
  }
  const statusTick = () => {
    if (entry.gone) return;
    try {
      const now = readFoamRecord(id);
      const st = now ? readStatusFile(now.case_dir) : null;
      if (st) applyStatus(id, entry, st);
    } catch (e) {
      if (!entry.staleLogged) {
        entry.staleLogged = true;
        console.warn(`[CFD runner] ${id}: status file not read`, e);
      }
    }
    later(entry, statusTick, POLL_STATUS_MS);
  };
  const aliveTick = async () => {
    if (entry.gone) return;
    /** @type {boolean | null} */
    let alive;
    try {
      alive = await D().relayAlive(id);
    } catch {
      alive = null;
    }
    if (entry.gone) return;
    if (alive === false) {
      afterRelayGone(id);
      return;
    }
    later(entry, () => void aliveTick(), POLL_ALIVE_MS);
  };
  later(entry, statusTick, POLL_STATUS_MS);
  later(entry, () => void aliveTick(), POLL_ALIVE_MS);
}

/**
 * Stage, saved frames and progress (no points) from an adopted relay's status file.
 * @param {string} id
 * @param {Entry} entry
 * @param {any} st
 */
function applyStatus(id, entry, st) {
  const stage = String(st.stage || '');
  if (FRAME_STAGES.has(stage) && stage !== entry.lastStage) setStage(id, stage);
  for (const raw of Array.isArray(st.saved) ? st.saved : []) {
    const t = Number(raw);
    if (!Number.isFinite(t) || entry.savedSeen.has(t)) continue;
    entry.savedSeen.add(t);
    deliver(id, { event: 'time_saved', t });
  }
  const time = Number(st.time);
  const steps = Number(st.n_steps);
  if (Number.isFinite(time) && Number.isFinite(steps) && (!entry.fold.last || entry.fold.last.t !== time)) {
    entry.fold.last = { t: time };
    entry.fold.steps = steps;
    updateFoamRecord(id, { time, n_steps: steps }, { write: 'soon' });
    deliver(id, { event: 'progress', time, n_steps: steps, residuals: {}, points: [] });
  }
}

// ---- relay control (by identity: foam_relay_ctl.py) ----

/**
 * @param {'alive'|'kill'} action
 * @param {string} jobId
 * @returns {Promise<any>}
 */
function relayCtl(action, jobId) {
  return new Promise((done) => {
    let out = '';
    let finished = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @param {any} v */
    const finish = (v) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      done(v);
    };
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(PYTHON, [pyTool('foam_relay_ctl.py'), action, '--job-id', jobId], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, CTL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    if (child.stdout) child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        finish(JSON.parse(lines[lines.length - 1] || 'null'));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Is this run's relay (or its prepare tool) still running? null when unknown.
 * @param {string} jobId
 * @returns {Promise<boolean | null>}
 */
export async function relayAlive(jobId) {
  const answer = await relayCtl('alive', jobId);
  return answer && answer.ok === true && typeof answer.alive === 'boolean' ? answer.alive : null;
}

/** @param {string} jobId */
export function killRelay(jobId) {
  void relayCtl('kill', jobId);
}

// ---- stop ----

/**
 * Stop a run. The first stop is saved (with who and why) before anything else, so
 * a restart keeps it; a later user stop raises the level (graceful → solver →
 * all, or to all with force); a host stop of a run already stopping changes
 * nothing. A queued plugin case leaves the queue.
 * @param {string} id
 * @param {{ force?: boolean, by?: string, reason?: string | null }} [opts]
 * @returns {{ ok: boolean, status: string, stopping: boolean }}
 */
export function stopFoamCase(id, { force = false, by = 'user', reason = null } = {}) {
  const rec = readFoamRecord(id);
  if (!rec) return { ok: false, status: 'missing', stopping: false };
  if (rec.status !== 'queued' && rec.status !== 'running') return { ok: true, status: rec.status, stopping: false };
  const host = by !== 'user';
  if (rec.status === 'queued') {
    if (rec.row_id && D().queueHasRow(rec.row_id)) D().removeComputeJob(null, rec.row_id);
    finishFoam(id, 'stopped', { error: host && reason ? `Stopped: ${reason}` : FOAM_TEXT.removed });
    const after = readFoamRecord(id);
    return { ok: true, status: after ? after.status : 'stopped', stopping: false };
  }
  if (rec.stop && host) return { ok: true, status: rec.status, stopping: true };
  const at = new Date().toISOString();
  let stop;
  if (!rec.stop) {
    stop = { at, by: String(by), level: force ? 'all' : 'graceful', reason: reason === undefined || reason === null ? null : String(reason), seq: 1 };
  } else {
    const i = LEVELS.indexOf(rec.stop.level);
    const level = force ? 'all' : LEVELS[Math.min(LEVELS.length - 1, (i < 0 ? 0 : i) + 1)];
    stop = { ...rec.stop, level, seq: (Number(rec.stop.seq) || 1) + 1 };
  }
  const raisedToAll = stop.level === 'all' && (!rec.stop || rec.stop.level !== 'all');
  const saved = updateFoamRecord(id, { stop }) || { ...rec, stop };
  patchComputeSlotFor(id, { stop_requested: true });
  try {
    writeStopMarker(saved);
  } catch (e) {
    console.warn(`[CFD runner] ${id}: stop marker not written`, e);
  }
  const entry = R().entries.get(id);
  if (entry) {
    // A drain (the relay is gone) reads the stop at its next probe; a live relay
    // applies the marker by stage, and at level all its WSL processes end now.
    if (raisedToAll && !entry.gone) {
      D().killWslCase({ wslCase: saved.wsl_case, scripts: scriptsOf(saved), root: saved.wsl_root });
      entry.allKilledAt = Date.now();
      armRelayKill(id, entry);
    }
    if (entry.lastStage !== 'stopping') setStage(id, 'stopping');
  }
  return { ok: true, status: 'running', stopping: true };
}

/**
 * Patch the claim only while it describes this run. The boot check shares one claim
 * among the jobs it follows and describes one at a time; another one's drain or
 * stop must not change what the Queue says of the one described.
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function patchComputeSlotFor(id, patch) {
  const entry = R().entries.get(id);
  const holder = computeSlotHolder();
  if (entry && holder && holder.token === entry.token && holder.job_id === id) {
    patchComputeSlot(entry.token, patch);
  }
}

/**
 * The phase a claim of this run shows now: `draining` once its relay is gone, else
 * `running`; null when this process does not follow it (yet).
 * @param {unknown} id
 * @returns {'running' | 'draining' | null}
 */
export function foamRunPhase(id) {
  const entry = R().entries.get(String(id));
  if (!entry) return null;
  return entry.relayGone ? 'draining' : 'running';
}

/**
 * 120 s after a level-all kill: a relay still alive while WSL is dead is ended
 * by identity (never because its status file is old).
 * @param {string} id
 * @param {Entry} entry
 */
function armRelayKill(id, entry) {
  if (entry.relayKillTimer) return;
  entry.relayKillTimer = setTimeout(() => {
    entry.relayKillTimer = null;
    void (async () => {
      if (entry.gone) return;
      const alive = entry.adopted ? await D().relayAlive(id) : !entry.gone;
      if (!alive || entry.gone) return;
      const rec = readFoamRecord(id);
      if (!rec) return;
      const state = await D().probeWslCase({ wslCase: rec.wsl_case, scripts: scriptsOf(rec), root: rec.wsl_root });
      if (state === 'dead' && !entry.gone) D().killRelay(id);
    })().catch((e) => console.warn(`[CFD runner] ${id}: relay kill check failed`, e));
  }, RELAY_KILL_AFTER_MS);
  if (typeof entry.relayKillTimer.unref === 'function') entry.relayKillTimer.unref();
}

/**
 * The host stops a plugin's cases (turned off, environment removed, plugins
 * reloaded): running ones stop gracefully with a notice; one already stopping is
 * left alone; queued ones are dropped with a notice.
 * @param {{ project_id?: unknown, plugin?: unknown, study_id?: unknown }} filter
 * @param {string} by
 * @param {string} reason
 */
export function stopFoamCasesFor(filter, by, reason) {
  const f = filter || {};
  const out = { stopped: /** @type {string[]} */ ([]), dropped: /** @type {string[]} */ ([]) };
  for (const rec of listFoamRecords({ kind: 'foam', status: 'running' })) {
    if (f.project_id && !sameProjectFolder(rec.project_id, f.project_id)) continue;
    if (f.plugin && rec.plugin !== String(f.plugin)) continue;
    if (f.study_id && rec.study_id !== String(f.study_id)) continue;
    if (rec.stop) continue;
    stopFoamCase(rec.id, { by, reason });
    D().pushComputeNotice({
      id: rec.row_id || rec.id,
      kind: 'foam',
      project_id: rec.project_id,
      name: rowNameOf(rec),
      error: reason,
      job_id: rec.id,
      reason: 'stopped',
    });
    out.stopped.push(rec.id);
  }
  const dropped = D().dropFoamJobs({ project_id: f.project_id, plugin: f.plugin, study_id: f.study_id }, reason) || [];
  out.dropped = dropped.map((/** @type {any} */ r) => r.job_id);
  return out;
}

/** "<study title> · <case> · <plugin name>" @param {any} rec */
export function rowNameOf(rec) {
  const parts = String(rec.case_rel || '').split('/');
  return `${rec.study_title || rec.study_id || 'Study'} · ${parts[parts.length - 1] || 'case'} · ${rec.plugin_name || rec.plugin || 'Plugin'}`;
}

// ---- busy folders ----

/**
 * case_keys of this plugin's running cases in this project (a draining case is
 * running until its record finishes).
 * @param {unknown} projectId
 * @param {unknown} plugin
 */
export function activeCaseKeys(projectId, plugin) {
  return listFoamRecords({ kind: 'foam', status: 'running' })
    .filter((r) => r.plugin === String(plugin || '') && sameProjectFolder(r.project_id, projectId) && r.case_key)
    .map((r) => String(r.case_key));
}

/**
 * @param {unknown} projectId
 * @param {unknown} plugin
 * @param {unknown} studyId
 */
export function studyHasActiveCase(projectId, plugin, studyId) {
  const sid = String(studyId || '').toLowerCase();
  return listFoamRecords({ kind: 'foam', status: 'running' }).some(
    (r) => r.plugin === String(plugin || '') && String(r.study_id || '').toLowerCase() === sid && sameProjectFolder(r.project_id, projectId),
  );
}

// ---- the plugin epoch ----

/**
 * Turning a plugin off, removing its environment or the Reload button bump it; a
 * submit checks it after each await, so one that raced such a change fails.
 * @param {string} key a plugin key, or '*' for every plugin
 */
export function bumpPluginEpoch(key) {
  const e = R().epochs;
  if (key === '*') e.all += 1;
  else e.byKey.set(String(key), (e.byKey.get(String(key)) || 0) + 1);
}

/** @param {string} key */
export function pluginEpoch(key) {
  const e = R().epochs;
  return `${e.all}.${e.byKey.get(String(key)) || 0}`;
}

// ---- the queue's side ----

/**
 * A queue row of a plugin case left without being started.
 * @param {any} row
 * @param {'removed'|'skipped'|'failed'|'dropped'} reason
 * @param {string} [error]
 */
export function onQueueLeave(row, reason, error) {
  if (!row || row.kind !== 'foam' || !row.job_id) return;
  const rec = readFoamRecord(row.job_id);
  if (!rec) return;
  if (reason === 'removed') finishFoam(rec.id, 'stopped', { error: FOAM_TEXT.removed });
  else if (reason === 'skipped') {
    if (rec.status === 'queued') finishFoam(rec.id, 'failed', { error: FOAM_TEXT.lostQueue });
  } else if (reason === 'failed') finishFoam(rec.id, 'failed', { error: error || 'Could not start' });
  else if (reason === 'dropped') finishFoam(rec.id, 'stopped', { error: error || 'Taken off the queue' });
}

/** After every queue write: tell each queued case how many jobs are ahead of it, when that changed. */
export function onQueueChange() {
  const r = R();
  for (const rec of listFoamRecords({ status: 'queued' })) {
    if (!rec.row_id) continue;
    const ahead = D().queueAheadOf(rec.row_id);
    if (ahead === null || ahead === undefined) continue;
    if (r.aheads.get(rec.id) === ahead) continue;
    r.aheads.set(rec.id, ahead);
    deliver(rec.id, { event: 'queued', ahead });
  }
}

/**
 * At boot: queued plugin cases with no queue row, foam rows with no queued
 * record, and runs of other kinds left queued by a caller that died.
 */
export function reconcileFoamQueue() {
  const rows = (D().queueRows() || []).filter((/** @type {any} */ row) => row && row.kind === 'foam');
  const queuedJobs = new Set(rows.map((/** @type {any} */ row) => row.job_id));
  for (const rec of listFoamRecords({ status: 'queued' })) {
    if (rec.kind !== 'foam') finishFoam(rec.id, 'failed', { error: FOAM_TEXT.lostBefore });
    else if (!queuedJobs.has(rec.id)) finishFoam(rec.id, 'failed', { error: FOAM_TEXT.lostQueue });
  }
  const stale = rows.filter((/** @type {any} */ row) => {
    const rec = readFoamRecord(row.job_id);
    return !rec || rec.status !== 'queued';
  });
  if (stale.length) D().dropComputeRows(stale.map((/** @type {any} */ row) => row.id), FOAM_TEXT.lostQueue, 'skipped');
}

// ---- the plugin case ----

/**
 * The queue starts a plugin case. Synchronous: no RPC, no await. Steps 2-9 take no
 * claim; runFoamSteps claims at the spawn.
 * @param {any} row
 * @returns {{ ok?: boolean, busy?: boolean, missing?: boolean, final?: boolean, error?: string, code?: string }}
 */
export function startFoam(row) {
  const id = row && row.job_id ? String(row.job_id) : '';
  try {
    if (computeSlotHolder()) return { busy: true };
    const rec = id ? readFoamRecord(id) : null;
    if (!rec || rec.kind !== 'foam' || rec.status !== 'queued' || !D().queueHasRow(row.id)) return { missing: true };
    if (!D().liveRegistryLoaded()) return { ok: false, error: FOAM_TEXT.notLoaded };
    const name = rec.plugin_name || rec.plugin;
    if (!D().pluginLoaded(rec.plugin)) return finalFail(id, 'plugin_off', `${name} is off. Turn it on in Settings → Plugins`);
    const solver = D().solverForApplication(rec.app);
    if (!solver) return finalFail(id, 'app_not_allowed', `${rec.app} is no longer a registered solver`);
    const studyJson = join(String(rec.case_base), 'studies', String(rec.study_id), 'study.json');
    let studyOk = false;
    try {
      studyOk = statSync(studyJson).isFile();
    } catch {
      studyOk = false;
    }
    if (!studyOk) return finalFail(id, 'study_not_found', FOAM_TEXT.studyGone);
    const bad = caseFolderProblem({ ...rec, kind: 'foam' });
    if (bad) return finalFail(id, bad.code, bad.error);
    const launch = rec.launch || {};
    const parallel = String(solver.parallel || launch.parallel || 'none');
    const anyParallel = (rec.pre || []).some((/** @type {any} */ s) => s && s.parallel === true);
    const cap = Math.max(1, Number(D().hardwareRankCap()) || 1);
    const nProcs = parallel === 'none' && !anyParallel ? 1 : Math.min(cap, Math.max(1, Math.floor(Number(rec.n_procs) || 1)));
    const timeDependency = String(solver.time_dependency || launch.time_dependency || 'steady');
    const frameFields = (rec.results && rec.results.frame_fields) || launch.frame_fields || LEGACY_FRAME_FIELDS;
    /** @type {Record<string, any>} */
    const sidecar = {
      kinematic_fields: (rec.results && rec.results.kinematic_fields) || [],
      frame_fields: frameFields,
      app: rec.app,
      plugin: rec.plugin,
      study_id: rec.study_id,
    };
    if (rec.results && finite(rec.results.rho)) sidecar.rho = Number(rec.results.rho);
    writeAtomic(join(rec.case_dir, 'w27-case.json'), JSON.stringify(sidecar, null, 2));
    const hooks = D().hookNames();
    const owner = hooks.length ? `plugin:${rec.project_id}/${rec.plugin}/${rec.study_id}` : null;
    updateFoamRecord(id, { n_procs: nProcs, launch: { ...launch, time_dependency: timeDependency } }, { write: 'none' });
    return runFoamSteps({
      job_id: id,
      claim: { kind: 'foam', project_id: rec.project_id, job_id: id, name: rowNameOf(rec), plugin: rec.plugin, study_id: rec.study_id },
      case_base: rec.case_base,
      case_parts: rec.case_parts,
      case_dir: rec.case_dir,
      plugin: rec.plugin,
      wsl_case: rec.wsl_case,
      wsl_root: rec.wsl_root,
      token: rec.token,
      prepare: null,
      pre: rec.pre || [],
      n_procs: nProcs,
      slots_hint: D().slotsHint(),
      solver: {
        app: rec.app,
        keep_frames: timeDependency === 'transient' ? 'all' : 'latest',
        process_names: [rec.app],
        stop_strategy: String(solver.stop_strategy || launch.stop_strategy || 'kill'),
        frame_fields: frameFields,
        parallel,
      },
      owner,
      hooks: owner ? hooks : [],
    });
  } catch (e) {
    console.warn(`[CFD runner] ${id}: the case could not start`, e);
    if (id) finishFoam(id, 'failed', { code: 'launch', error: FOAM_TEXT.launch });
    return { ok: false, final: true, error: FOAM_TEXT.launch };
  }
}

// The plugin case's frame events go to the study's stream (plugin-cases.ts).
registerStepRunKind('foam', {
  onEvent(rec, ev) {
    emitFoamEvent(rec.id, ev);
  },
  onEnd(rec) {
    console.info(`[CFD runner] ${rec.id}: ended ${rec.status}${rec.code ? ' (' + rec.code + ')' : ''}`);
  },
});

/** A run's WSL case id: cfddesk-pf-<plugin>-<study>-<token> (lowercase, like slugify_wsl_case_id). */
export function foamWslCaseId(plugin, studyId, token) {
  const slug = (/** @type {unknown} */ s) => {
    let out = String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '');
    if (!out) out = 'x';
    return out;
  };
  return `cfddesk-pf-${slug(plugin)}-${slug(studyId)}-${String(token)}`;
}

/** A token for a new run: 8 hex, drawn again while its WSL case id is in use. */
export function newFoamToken(plugin, studyId) {
  const used = new Set(listFoamRecords().map((r) => r.wsl_case));
  for (let i = 0; i < 20; i += 1) {
    const token = randomBytes(4).toString('hex');
    if (!used.has(foamWslCaseId(plugin, studyId, token))) return token;
  }
  return randomBytes(4).toString('hex');
}
