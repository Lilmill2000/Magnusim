// @ts-check
/**
 * The boot check: once per server process, before the first request and before
 * boot(), look for solves and step-list runs (plugin cases) a previous server left
 * running, and hold the compute slot while they are probed and for as long as
 * one still runs.
 *
 * Core runs: their WSL processes are probed (wsl_case_procs.py, which also sees
 * reconstructPar and the copy back). Dead → the doc is reaped; live or unknown →
 * followed like a drain until they are gone (no relay follows them any more, so
 * their phase is `draining` and a Stop ends their WSL processes). Runner records:
 * their relay is checked by identity; alive → adopted, gone → afterRelayGone.
 * The probes take 20 s at most; one that has not answered counts as unknown.
 */
import { wslCaseRoot } from './wsl-env.js';
import {
  claimComputeSlot,
  markBootOnce,
  patchComputeSlot,
  releaseComputeSlot,
} from './compute-slot.js';
import { LOST_TEXT, probeWslCase, watchWslCaseGone } from './wsl-case-watch.js';
import { listSolveDocsToCheck, reapCheckedSolveDoc, runDocStopRequested } from './w27-solve.js';
import { listFoamRecords, readFoamRecord } from './foam-store.js';
import { adoptFoamCase, foamRunPhase, reconcileFoamQueue, relayAlive, rowNameOf } from './foam-runner.js';
import { pushComputeNotice } from './server/compute-queue.ts';

export const BOOT_PROBE_BOUND_MS = 20_000;

const DEFAULTS = {
  listCore: listSolveDocsToCheck,
  listRunner: () => listFoamRecords({ status: 'running' }),
  reconcile: reconcileFoamQueue,
  wslRoot: wslCaseRoot,
  probe: probeWslCase,
  relayAlive,
  reap: reapCheckedSolveDoc,
  runDocStopRequested,
  watch: watchWslCaseGone,
  adopt: adoptFoamCase,
  runnerPhase: foamRunPhase,
  readRecord: readFoamRecord,
  notice: pushComputeNotice,
  boundMs: BOOT_PROBE_BOUND_MS,
};

/**
 * @param {any} job
 */
function kindOf(job) {
  return job.type === 'core' ? 'solve' : String(job.rec.kind || 'foam');
}

/**
 * The job's phase now (the claim is handed to a job later than it was found, and a
 * runner job whose relay died since then drains).
 * @param {any} job
 * @param {any} d
 */
function phaseOf(job, d) {
  if (job.type === 'core') return 'draining';
  let now;
  try {
    now = d.runnerPhase(job.rec.id);
  } catch {
    now = null;
  }
  return now || (job.relayGone ? 'draining' : 'running');
}

/** @param {any} job */
function projectOf(job) {
  return String(job.type === 'core' ? job.doc.project_id : job.rec.project_id);
}

/**
 * Whether a stop was asked for the job, as its doc or record says now.
 * @param {any} job
 * @param {any} d
 */
function stopAskedOf(job, d) {
  try {
    if (job.type === 'core') return !!d.runDocStopRequested(job.doc.project_id, job.doc.run_id);
    const rec = d.readRecord(job.rec.id);
    return !!(rec || job.rec).stop;
  } catch {
    return job.type === 'core' ? !!job.doc.stop_requested : !!job.rec.stop;
  }
}

/**
 * @param {any} job
 * @param {any} d
 */
function infoOf(job, d) {
  if (job.type === 'core') {
    return {
      project_id: job.doc.project_id,
      run_id: job.doc.run_id,
      name: job.doc.name || job.doc.run_id,
      stop_requested: stopAskedOf(job, d),
      job_id: null,
      plugin: null,
      study_id: null,
    };
  }
  const rec = job.rec;
  return {
    project_id: rec.project_id,
    job_id: rec.id,
    plugin: rec.plugin,
    study_id: rec.study_id,
    name: rec.kind === 'foam' ? rowNameOf(rec) : rec.study_title || rec.id,
    stop_requested: stopAskedOf(job, d),
    run_id: null,
  };
}

/**
 * Runs synchronously up to the claim, then probes; returns the promise of the
 * whole check (null when there is nothing to check, or it already ran).
 * @param {{ deps?: Partial<typeof DEFAULTS> }} [opts]
 * @returns {Promise<{ followed: number }> | null}
 */
export function rediscoverAtBoot(opts = {}) {
  if (!markBootOnce()) return null;
  const d = { ...DEFAULTS, ...(opts.deps || {}) };
  /** @type {any[]} */
  let core = [];
  /** @type {any[]} */
  let runner = [];
  try {
    core = d.listCore() || [];
  } catch (e) {
    console.warn('[CFD boot check] could not list runs', e);
  }
  try {
    runner = d.listRunner() || [];
  } catch (e) {
    console.warn('[CFD boot check] could not list plugin cases', e);
  }
  try {
    d.reconcile();
  } catch (e) {
    console.warn('[CFD boot check] queue reconcile failed', e);
  }
  if (!core.length && !runner.length) return null;
  const projectIds = [...new Set([...core.map((c) => String(c.project_id)), ...runner.map((r) => String(r.project_id))])];
  const claimed = claimComputeSlot('check', { name: 'Checking for jobs left running', project_ids: projectIds }, { phase: 'checking' });
  if (!claimed.ok) return null;
  const token = claimed.token;
  /** @type {string | null} */
  let root = null;
  if (core.length) {
    try {
      root = d.wslRoot();
    } catch {
      root = null;
    }
  }
  console.info(`[CFD boot check] ${core.length} run(s) and ${runner.length} plugin case(s) left running: checking`);
  /** @type {string[]} */
  const coreStates = core.map(() => 'unknown');
  /** @type {Array<boolean | null>} */
  const alive = runner.map(() => null);
  const probes = Promise.all([
    ...core.map((doc, i) =>
      Promise.resolve()
        .then(() => d.probe({ wslCase: doc.wsl_case, scripts: [`solve-${doc.run_id}.sh`], root }))
        .then((s) => {
          coreStates[i] = s === 'live' || s === 'dead' ? s : 'unknown';
        })
        .catch(() => {}),
    ),
    ...runner.map((rec, i) =>
      Promise.resolve()
        .then(() => d.relayAlive(rec.id))
        .then((a) => {
          alive[i] = typeof a === 'boolean' ? a : null;
        })
        .catch(() => {}),
    ),
  ]);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const bound = new Promise((done) => {
    timer = setTimeout(done, d.boundMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([probes, bound])
    .catch(() => {})
    .then(() => {
      if (timer) clearTimeout(timer);
      return settle(d, token, root, core, runner, coreStates.slice(), alive.slice());
    });
}

/**
 * Synchronous: reap, follow, or release the check claim.
 * @param {any} d
 * @param {string} token
 * @param {string | null} root
 * @param {any[]} core
 * @param {any[]} runner
 * @param {string[]} coreStates
 * @param {Array<boolean | null>} alive
 */
function settle(d, token, root, core, runner, coreStates, alive) {
  /** @type {any[]} */
  const followed = [];
  let started = false;
  try {
    core.forEach((doc, i) => {
      if (coreStates[i] === 'dead') {
        try {
          d.reap(doc.project_id, doc.run_id);
        } catch (e) {
          console.warn(`[CFD boot check] reap ${doc.run_id} failed`, e);
        }
      } else {
        followed.push({ type: 'core', doc });
      }
    });
    runner.forEach((rec, i) => followed.push({ type: 'runner', rec, relayGone: alive[i] === false }));
    if (!followed.length) {
      console.info('[CFD boot check] nothing left running');
      return { followed: 0 };
    }
    const ended = new Set();
    // The claim describes one job at a time (its kind, phase and ids); while more
    // than one is followed, project_ids keeps naming every project that still has one,
    // so none of them can be deleted under its job.
    const projectsLeft = () => {
      const ids = [...new Set(followed.filter((j) => !ended.has(j)).map(projectOf))];
      return ids.length > 1 ? ids : null;
    };
    /** @param {any} job */
    const describe = (job) => ({ kind: kindOf(job), phase: phaseOf(job, d), ...infoOf(job, d), project_ids: projectsLeft() });
    patchComputeSlot(token, describe(followed[0]));
    /** @param {any} job */
    const endOne = (job) => {
      if (ended.has(job)) return;
      ended.add(job);
      const next = followed.find((j) => !ended.has(j));
      try {
        if (next) patchComputeSlot(token, describe(next));
      } finally {
        if (!next) releaseComputeSlot(token);
      }
    };
    started = true;
    for (const job of followed) {
      try {
        if (job.type === 'core') followCore(d, token, root, job, () => endOne(job));
        else d.adopt(job.rec, token, () => endOne(job), { relayGone: job.relayGone });
      } catch (e) {
        console.warn('[CFD boot check] could not follow a job', e);
        endOne(job);
      }
    }
    return { followed: followed.length };
  } finally {
    if (!started) releaseComputeSlot(token);
  }
}

/**
 * A core run left running: wait for its WSL processes like a drain.
 * @param {any} d
 * @param {string} token
 * @param {string | null} root
 * @param {any} job
 * @param {() => void} release
 */
function followCore(d, token, root, job, release) {
  const { project_id: pid, run_id: runId, wsl_case: wslCase, name } = job.doc;
  d.watch({
    token,
    wslCase,
    scripts: [`solve-${runId}.sh`],
    root,
    stop: () => d.runDocStopRequested(pid, runId),
    onGone: () => d.reap(pid, runId),
    onLost: (/** @type {'stuck' | 'unreachable'} */ reason) =>
      d.notice({
        id: `solve-${runId}`,
        kind: 'solve',
        run_id: runId,
        project_id: pid,
        name: name || runId,
        error: LOST_TEXT[reason] || reason,
        reason: 'stopped',
      }),
    release,
  });
}
