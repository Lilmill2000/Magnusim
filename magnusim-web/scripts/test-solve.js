// @ts-check
/**
 * The fake solve (tests only, MAGNUSIM_TEST_COMPUTE=fake; test-compute.js): a Start that
 * passed every check of a real one (the run's mesh, its analysis's verdict, its settings)
 * solves nothing. Its run holds the compute slot and its doc says running, counting
 * iterations to its end over MAGNUSIM_TEST_SOLVE_SECONDS (default 6), then done; Stop
 * ends it at once, stopped. No case is written, so it has no results to show.
 * MAGNUSIM_TEST_SOLVE_RESULT=fail ends it failed ("Fake solver failed").
 * MAGNUSIM_TEST_SOLVE_STOP_SECONDS=n: a plain Stop holds it "stopping" (writing its current
 * step) for n seconds, then it ends stopped; a repeated plain Stop answers that it is already
 * stopping (stop-decision.js), and only force ends it at once.
 */
import { patchComputeSlot, releaseComputeSlot } from './compute-slot.js';
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

/**
 * Start the fake solve of a run whose Start holds `slot` (runClaimed's): the slot is kept
 * until the run ends.
 * @param {{ id: string, runId: string, simId: string, slot: { token: string, keep: () => void }, endTime: number, onDone?: (r: any) => void }} c
 */
export function startFakeSolve({ id, runId, simId, slot, endTime, onDone }) {
  slot.keep();
  patchComputeSlot(slot.token, { phase: 'running', run_id: runId, project_id: id });
  const end = Math.max(1, Math.round(Number(endTime) || 100));
  const started = new Date().toISOString();
  const ticks = Math.max(1, Math.round(solveSeconds() * 4));
  let tick = 0;
  const ids = { id: runId, run_id: runId, simulation_id: simId };
  persistRun(id, simId, { ...ids, status: 'running', stage: 'solve', iteration: 0, endTime: end, started_at: started, finished_at: null, error: null, pid: null });
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
