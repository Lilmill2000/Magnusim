// @ts-check
/**
 * The fake solve (tests only, MAGNUSIM_TEST_COMPUTE=fake; test-compute.js): a Start that
 * passed every check of a real one (the run's mesh, its analysis's verdict, its settings)
 * solves nothing. Its run holds the compute slot and its doc says running, counting
 * iterations to its end over MAGNUSIM_TEST_SOLVE_SECONDS (default 6), then done; Stop
 * ends it at once, stopped. No case is written, so it has no results to show.
 * MAGNUSIM_TEST_SOLVE_RESULT=fail ends it failed ("Fake solver failed"). Its health is not
 * checked (`health_checked: false`): it has no solver output.
 * MAGNUSIM_TEST_SOLVE_STOP_SECONDS=n: a plain Stop holds it "stopping" (writing its current
 * step) for n seconds, then it ends stopped; a repeated plain Stop answers that it is already
 * stopping (stop-decision.js), and only force ends it at once.
 *
 * MAGNUSIM_TEST_SOLVE_LOG=<fixture> (RH1): the run "solves" that solver log instead. The fake
 * runs the real health tracker over it (`python -m magnusim_sdk.health replay --events`,
 * MAGNUSIM_TEST_SOLVE_PACE_MS a time step, default 40), which writes the fixture into
 * `<run>/case/log.<app>` as it goes; the run doc gets the case folder and the solver, each step's
 * time, Courant number and time step, and each health event through healthPatch (the shape check
 * and the scrub the runner's path uses). The hints are MAGNUSIM_TEST_SOLVE_HINTS, else the
 * fixture's `<name>.hints.json` (or the one of its name before the first "-"). The run ends done
 * once the log is read and MAGNUSIM_TEST_SOLVE_SECONDS have passed, or stopped by Stop.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { patchComputeSlot, releaseComputeSlot } from './compute-slot.js';
import { corePythonPath } from './job-runner.js';
import { PYTHON, WEB_ROOT } from './python-env.js';
import { healthPatch } from './run-health-shape.js';
import { scheduleComputeQueueKick } from './server/compute-queue.ts';
import { persistRun } from './study-io.js';
import { stopDecision } from './stop-decision.js';

/** @type {Map<string, { projectId: string, simId: string, token: string, timer: NodeJS.Timeout, stopping?: boolean, stopTimer?: NodeJS.Timeout | null, onDone?: (r: any) => void, end: (status: 'done' | 'failed' | 'stopped') => void }>} */
const running = new Map();

/** How long a plain Stop holds the fake solve at "stopping" (0: it ends at once). */
function stopSeconds() {
  const n = Number(process.env.MAGNUSIM_TEST_SOLVE_STOP_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.min(600, n) : 0;
}

const key = (/** @type {string} */ projectId, /** @type {string} */ runId) => `${projectId}|${runId}`;

function solveSeconds() {
  const n = Number(process.env.MAGNUSIM_TEST_SOLVE_SECONDS);
  return Number.isFinite(n) && n >= 0 ? Math.min(600, n) : 6;
}

/** The solver log a fake solve replays (MAGNUSIM_TEST_SOLVE_LOG), absolute, or ''. */
function solveLog() {
  const raw = String(process.env.MAGNUSIM_TEST_SOLVE_LOG || '').trim();
  if (!raw) return '';
  const path = isAbsolute(raw) ? raw : join(WEB_ROOT, raw);
  return existsSync(path) ? path : '';
}

/** The replayed log's health hints file, or ''. @param {string} log */
function hintsFor(log) {
  const given = String(process.env.MAGNUSIM_TEST_SOLVE_HINTS || '').trim();
  if (given) return isAbsolute(given) ? given : join(WEB_ROOT, given);
  const stem = basename(log).replace(/\.gz$/, '').replace(/\.log$/, '');
  for (const name of [`${stem}.hints.json`, `${stem.split('-')[0]}.hints.json`]) {
    const p = join(dirname(log), name);
    if (existsSync(p)) return p;
  }
  return '';
}

/**
 * Start the fake solve of a run whose Start holds `slot` (runClaimed's): the slot is kept
 * until the run ends.
 * @param {{ id: string, runId: string, simId: string, slot: { token: string, keep: () => void }, endTime: number, onDone?: (r: any) => void, caseDir?: string | null }} c
 */
export function startFakeSolve({ id, runId, simId, slot, endTime, onDone, caseDir }) {
  slot.keep();
  patchComputeSlot(slot.token, { phase: 'running', run_id: runId, project_id: id });
  const log = solveLog();
  if (log && caseDir) return startLogReplay({ id, runId, simId, slot, endTime, onDone, caseDir, log });
  const end = Math.max(1, Math.round(Number(endTime) || 100));
  const started = new Date().toISOString();
  const ticks = Math.max(1, Math.round(solveSeconds() * 4));
  let tick = 0;
  const ids = { id: runId, run_id: runId, simulation_id: simId };
  persistRun(id, simId, { ...ids, status: 'running', stage: 'solve', iteration: 0, endTime: end, started_at: started, finished_at: null, error: null, pid: null, health: null, health_checked: false });
  const finish = (/** @type {'done' | 'failed' | 'stopped'} */ status) => {
    const rec = running.get(key(id, runId));
    if (!rec) return;
    running.delete(key(id, runId));
    clearInterval(rec.timer);
    if (rec.stopTimer) clearTimeout(rec.stopTimer);
    const at = Math.min(end, Math.round((tick / ticks) * end));
    persistRun(id, simId, {
      ...ids,
      status,
      stage: status,
      iteration: status === 'done' ? end : at,
      finished_at: new Date().toISOString(),
      error: status === 'failed' ? 'Fake solver failed' : null,
      note: status === 'stopped' ? 'Stopped.' : status === 'done' ? 'Fake solve done.' : 'Fake solver failed',
      stop_requested: false,
      pid: null,
    });
    releaseComputeSlot(slot.token);
    scheduleComputeQueueKick(250);
    try {
      onDone?.({ status, run_id: runId, error: status === 'failed' ? 'Fake solver failed' : null });
    } catch {
      /* a listener never stops the end */
    }
  };
  const timer = setInterval(() => {
    tick += 1;
    if (tick >= ticks) {
      finish(process.env.MAGNUSIM_TEST_SOLVE_RESULT === 'fail' ? 'failed' : 'done');
      return;
    }
    persistRun(id, simId, { ...ids, status: 'running', stage: 'solve', iteration: Math.round((tick / ticks) * end) });
  }, 250);
  timer.unref?.();
  running.set(key(id, runId), { projectId: id, simId, token: slot.token, timer, onDone, end: finish });
  return { ok: true, status: 202, bodyExtra: { ok: true, status: 'running', run_id: runId, simulation_id: simId, fake: true } };
}

/**
 * The fake solve of a solver log (MAGNUSIM_TEST_SOLVE_LOG): the real tracker over it.
 * @param {{ id: string, runId: string, simId: string, slot: { token: string }, endTime: number, onDone?: (r: any) => void, caseDir: string, log: string }} c
 */
function startLogReplay({ id, runId, simId, slot, endTime, onDone, caseDir, log }) {
  const hints = hintsFor(log);
  let app = 'pimpleFoam';
  try {
    if (hints) app = String(JSON.parse(readFileSync(hints, 'utf8')).app || app);
  } catch {
    /* the default */
  }
  mkdirSync(caseDir, { recursive: true });
  const target = join(caseDir, `log.${app}`);
  rmSync(target, { force: true });
  const ids = { id: runId, run_id: runId, simulation_id: simId };
  const started = new Date().toISOString();
  persistRun(id, simId, {
    ...ids,
    status: 'running',
    stage: 'solve',
    iteration: 0,
    sim_time: 0,
    n_steps: 0,
    endTime,
    started_at: started,
    solve_started_at: started,
    finished_at: null,
    error: null,
    pid: null,
    case_dir: caseDir,
    path_kind: app,
    app,
    health: null,
    health_checked: true,
  });
  const pace = Number(process.env.MAGNUSIM_TEST_SOLVE_PACE_MS);
  const args = ['-m', 'magnusim_sdk.health', 'replay', log, '--events', '--pace', String(Number.isFinite(pace) && pace >= 0 ? pace : 40), '--copy-to', target];
  if (hints) args.push('--hints', hints);
  const child = spawn(PYTHON, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONPATH: corePythonPath(process.env.PYTHONPATH) },
  });
  /** @type {any} */
  let health = null;
  let lastProgressAt = 0;
  /** @type {Record<string, any>} */
  let progress = {};
  let replayDone = false;
  const startedAt = Date.now();
  const flushProgress = () => {
    if (!running.has(key(id, runId)) || !Object.keys(progress).length) return;
    persistRun(id, simId, { ...ids, status: 'running', stage: 'solve', ...progress });
  };
  /** @param {any} ev */
  const onEvent = (ev) => {
    if (!running.has(key(id, runId))) return;
    if (ev.event === 'progress') {
      const t = Number(ev.time);
      /** @param {unknown} v */
      const num = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
      progress = {
        sim_time: t,
        iteration: t,
        n_steps: Number(ev.step) || 0,
        ...(num(ev.co_mean) ? { co_mean: Number(ev.co_mean) } : {}),
        ...(num(ev.co_max) ? { co_max: Number(ev.co_max) } : {}),
        ...(num(ev.delta_t) ? { delta_t: Number(ev.delta_t) } : {}),
      };
      if (Date.now() - lastProgressAt > 300) {
        lastProgressAt = Date.now();
        flushProgress();
      }
    } else if (ev.event === 'health') {
      // The fake still "solves" after its log is read: its record stays live until it ends.
      const next = healthPatch(health, { ...ev, live: true });
      if (next) {
        health = next;
        persistRun(id, simId, { ...ids, health });
      }
    }
  };
  let pending = '';
  child.stdout?.on('data', (d) => {
    pending += String(d);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* not an event */
      }
    }
  });
  child.on('close', () => {
    replayDone = true;
    flushProgress();
  });
  const finish = (/** @type {'done' | 'failed' | 'stopped'} */ status) => {
    const rec = running.get(key(id, runId));
    if (!rec) return;
    running.delete(key(id, runId));
    clearInterval(rec.timer);
    try {
      child.kill();
    } catch {
      /* gone */
    }
    persistRun(id, simId, {
      ...ids,
      status,
      stage: status,
      ...progress,
      finished_at: new Date().toISOString(),
      error: status === 'failed' ? 'Fake solver failed' : null,
      note: status === 'stopped' ? 'Stopped.' : status === 'done' ? 'Fake solve done.' : 'Fake solver failed',
      pid: null,
      ...(health ? { health: { ...health, live: false } } : {}),
    });
    releaseComputeSlot(slot.token);
    scheduleComputeQueueKick(250);
    try {
      onDone?.({ status, run_id: runId, error: status === 'failed' ? 'Fake solver failed' : null });
    } catch {
      /* a listener never stops the end */
    }
  };
  // Done once the log is read and the run's seconds have passed (Stop ends it before).
  const timer = setInterval(() => {
    if (replayDone && Date.now() - startedAt >= solveSeconds() * 1000) finish(process.env.MAGNUSIM_TEST_SOLVE_RESULT === 'fail' ? 'failed' : 'done');
  }, 250);
  timer.unref?.();
  running.set(key(id, runId), { projectId: id, simId, token: slot.token, timer, onDone, end: finish });
  return { ok: true, status: 202, bodyExtra: { ok: true, status: 'running', run_id: runId, simulation_id: simId, fake: true } };
}

/**
 * Stop a fake solve of this project (that run, when given): its answer, as a real Stop's;
 * null when none runs. With MAGNUSIM_TEST_SOLVE_STOP_SECONDS a plain Stop holds it stopping
 * (stopDecision, as the runner's Stop: a repeated plain Stop answers `already`), and `force`
 * ends it at once.
 * @param {string} projectId
 * @param {string | undefined | null} runId
 * @param {boolean} [force]
 */
export function stopFakeSolve(projectId, runId, force = false) {
  for (const [k, rec] of running) {
    if (rec.projectId !== projectId) continue;
    const rid = k.slice(projectId.length + 1);
    if (runId && rid !== String(runId)) continue;
    const hold = stopSeconds();
    const d = stopDecision({ stop_requested: !!rec.stopping }, force);
    if (!hold || d.forced) {
      rec.end('stopped');
      return { ok: true, status: 200, bodyExtra: { ok: true, stopped: true, ...(d.forced ? { forced: true } : {}), run_id: rid } };
    }
    if (!rec.stopping) {
      // Writing its current step: it shows stopping, its progress stops, then it ends stopped.
      rec.stopping = true;
      clearInterval(rec.timer);
      persistRun(projectId, rec.simId, { id: rid, run_id: rid, simulation_id: rec.simId, status: 'running', stage: 'stopping', stop_requested: true, note: d.note });
      patchComputeSlot(rec.token, { stop_requested: true });
      rec.stopTimer = setTimeout(() => rec.end('stopped'), hold * 1000);
      rec.stopTimer.unref?.();
    }
    return { ok: true, status: 200, bodyExtra: { ok: true, stopping: true, ...(d.already ? { already: true } : {}), run_id: rid } };
  }
  return null;
}
