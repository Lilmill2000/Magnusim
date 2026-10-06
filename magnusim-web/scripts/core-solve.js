// @ts-check
/**
 * A core study's solve on the step-list runner (runner kind `solve`, host-only).
 *
 * Start (w27-solve.js startSolveBody) checks the run and plans it through its
 * analysis (worker RPC analysis.plan_run); launchCoreSolve hands it to the runner:
 * a `solve` record, the run doc marked running with that record's id
 * (runner_job_id), then runFoamSteps with the Start's held claim. From there the
 * run is the runner's: the relay runs the analysis's prepare JobKind (it writes
 * the case), copies the case to WSL as cfddesk-w27-<run id>, solves it with the
 * analysis's log parser and copies the frames back (foam-runner.js, foam_relay.py).
 *
 * This module follows the run from the runner's frame events and keeps its run
 * doc as the Run panel reads it:
 * - Live progress per runner job (liveSolveOf), in w27's progress shape
 *   (newProgressState): the stage, every step's residuals (the frames' points;
 *   the runner folds a core solve's residuals by the 'last' rule, the one its
 *   Run panel always plotted), the step the solver is on (the frame's `open`),
 *   saved frames and phase times. w27's enrichRunDoc and projectSolveSummary read it.
 * - Stages: prepare shows "Writing the case"; the WSL steps before the solver (a
 *   potential-flow start's potentialFoam, between pre_copy_in and pre_copy_back)
 *   show "initialise"; the copy to WSL, the copy back and
 *   the cleanup show "copy" (as before); decompose, solve and reconstruct show
 *   themselves; stopping and ending keep the stage shown (the doc's
 *   stop_requested says Stopping, as before).
 * - time_saved → the doc's saved-frame counts; ranks → n_procs and the note's
 *   "N ranks" / "serial".
 * - The end → the final doc (endedRunDoc: the texts the old run path wrote; a
 *   `lost` run is stopped when it saved frames, else failed, with the runner's
 *   text), the Start's onDone, the live-solve cache, a queue kick.
 *
 * w27-solve.js gives it the run-doc writer and the progress snapshot
 * (attachCoreSolveHost) when it loads, before the boot check can adopt a run.
 * The state is process-wide (globalThis), so a re-imported module keeps it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FOAM_TEXT, finishFoam, prepareFromJob, registerStepRunKind, runFoamSteps, stepRunRecord } from './foam-runner.js';
import { createFoamRecord, listFoamRecords, newFoamJobId } from './foam-store.js';
import { LEGACY_FRAME_FIELDS, listFoamTimeDirs } from './project-layout.js';
import { persistRun, runFolderOf } from './study-io.js';
import { scheduleComputeQueueKick } from './server/compute-queue.ts';

const ACTIVE = new Set(['queued', 'running']);
/** Stages after the solver: a step or a saved frame does not bring "solve" back. */
const LATE_STAGES = new Set(['reconstruct', 'stopping']);
/** How much of the solver's log a finished run keeps (log_excerpt). */
export const LOG_EXCERPT_CHARS = 6000;

/**
 * @typedef {{
 *   newState: () => any,
 *   snapshot: (state: any) => any,
 *   residualSeries: (analysisKey: string) => any[],
 *   logProgress: (logPath: string, analysisKey: string) => any,
 *   writeRunDoc: (projectId: string, doc: Record<string, any>) => void,
 *   invalidate: () => void,
 * }} CoreSolveHost
 */

/** @returns {{ live: Map<string, any>, done: Map<string, Function>, host: CoreSolveHost | null }} */
function S() {
  const key = Symbol.for('magnusim.coreSolves');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) g[key] = { live: new Map(), done: new Map(), host: null };
  return g[key];
}

/** @param {CoreSolveHost} host */
export function attachCoreSolveHost(host) {
  S().host = host;
}

export function resetCoreSolvesForTests() {
  S().live.clear();
  S().done.clear();
}

/**
 * The call's answer, or null when it throws.
 * @template T
 * @param {() => T} fn
 * @returns {T | null}
 */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** @param {unknown} v */
function finite(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/** @param {any} rec */
export function runnerJobActive(rec) {
  return !!rec && ACTIVE.has(String(rec.status));
}

/**
 * The runner record of a run doc on the runner: null for a doc of the old run path
 * (no runner_job_id) or when the store no longer has it.
 * @param {any} doc
 */
export function runnerRecordOf(doc) {
  const id = doc && doc.runner_job_id;
  return id ? stepRunRecord(String(id)) : null;
}

/**
 * Core solves the runner has queued or running, newest first.
 * @param {unknown} [projectId]
 */
export function activeCoreSolves(projectId) {
  return listFoamRecords({ kind: 'solve', status: ['queued', 'running'] }).filter(
    (r) => !projectId || String(r.project_id) === String(projectId),
  );
}

/** A run's live progress (the runner job's), or null. @param {unknown} jobId */
export function liveSolveOf(jobId) {
  return (jobId && S().live.get(String(jobId))) || null;
}

/**
 * The doc stage a runner stage shows; stopping, ending and anything else keep the
 * one shown.
 * @param {unknown} stage
 * @param {string} current
 */
export function docStageOf(stage, current) {
  switch (String(stage || '')) {
    case 'prepare':
      return 'prepare';
    case 'pre_copy_in':
    case 'pre_copy_back':
      // The case's own WSL steps before the solver (w27-case.json pre_steps): a potential-flow start.
      return 'initialise';
    case 'copy_to_wsl':
    case 'copy':
    case 'cleanup':
      return 'copy';
    case 'decompose':
      return 'decompose';
    case 'solve':
      return 'solve';
    case 'reconstruct':
      return 'reconstruct';
    default:
      return current;
  }
}

/** Saved frames in a run's case folder (time folders > 0, complete), ascending. @param {unknown} caseDir */
export function savedTimesIn(caseDir) {
  if (!caseDir) return [];
  try {
    return listFoamTimeDirs(String(caseDir), { complete: true })
      .map((name) => Number(name))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** The tail of the solver's own log in the case (log.<app>), or null. @param {any} rec */
export function solverLogExcerpt(rec) {
  const app = String((rec && rec.app) || '');
  if (!rec || !rec.case_dir || !/^[A-Za-z][A-Za-z0-9_]*$/.test(app)) return null;
  const file = join(String(rec.case_dir), `log.${app}`);
  let fd = null;
  try {
    const size = statSync(file).size;
    const want = Math.min(size, LOG_EXCERPT_CHARS * 4);
    const buf = Buffer.alloc(want);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8').slice(-LOG_EXCERPT_CHARS);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

/** A run's run.json as on disk, or null. @param {string} projectId @param {string} runId @param {string} [simId] */
export function readRunDocFile(projectId, runId, simId) {
  try {
    const folder = runFolderOf(projectId, runId, simId) || runFolderOf(projectId, runId);
    if (!folder || !folder.dir) return null;
    const doc = JSON.parse(readFileSync(join(folder.dir, 'run.json'), 'utf8').replace(/^\u{FEFF}/u, ''));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The note's "<app> N ranks" / "<app> serial" for the ranks the run got.
 * @param {unknown} note
 * @param {number} n
 */
export function noteWithRanks(note, n) {
  const text = String(note || '');
  return text.replace(/^(\S+) (?:\d+ ranks|serial)(?=$| )/, `$1 ${n > 1 ? `${n} ranks` : 'serial'}`);
}

// ---- following a run ----

/**
 * @param {any} rec
 * @param {boolean} adopted the first event is not the run's start (followed after a restart)
 */
function newLive(rec, adopted) {
  const host = S().host;
  const state = host
    ? host.newState()
    : { series: [], stage: 'starting', current: null, held: null, solve_started_at: null, saved_times: [], thinned: 0, cur_at: 0, step_at: null };
  Object.assign(state, {
    job_id: String(rec.id),
    run_id: String(rec.run_id || ''),
    project_id: String(rec.project_id || ''),
    simulation_id: String(rec.simulation_id || ''),
    case_dir: rec.case_dir || null,
    steps: 0,
    phases: { ...(rec.phases || {}) },
    residual_series: host ? host.residualSeries(String(rec.analysis_key || '')) : [],
  });
  // Followed after a restart: the frames it saved before are on disk.
  if (adopted) state.saved_times = savedTimesIn(rec.case_dir);
  return state;
}

/** @param {any} live */
function enterSolveStage(live) {
  if (!LATE_STAGES.has(String(live.stage || ''))) live.stage = 'solve';
}

/**
 * A progress frame: its points are the steps closed since the last frame (evenly
 * thinned when there were many: then each point's step number is kept, as for a
 * thinned job log), `open` the step the solver is on.
 * @param {any} live
 * @param {any} ev
 */
export function foldProgressFrame(live, ev) {
  const points = (Array.isArray(ev.points) ? ev.points : []).filter((p) => p && finite(p.t));
  const total = finite(ev.n_steps) ? Math.floor(Number(ev.n_steps)) : null;
  const before = Number(live.steps) || 0;
  if (points.length) {
    enterSolveStage(live);
    const made = total !== null && total >= before + points.length ? total - before : points.length;
    if (made > points.length && !live.step_at) live.step_at = live.series.map((/** @type {any} */ _, /** @type {number} */ i) => i);
    points.forEach((p, i) => {
      /** @type {Record<string, number>} */
      const row = { t: Number(p.t) };
      for (const [k, v] of Object.entries(p)) if (k !== 't' && finite(v)) row[k] = Number(v);
      live.series.push(row);
      if (live.step_at) {
        const at = points.length === 1 ? made - 1 : Math.round((i * (made - 1)) / (points.length - 1));
        live.step_at.push(before + at);
      }
    });
    live.steps = before + made;
  } else if (total !== null && total > before) {
    // Followed after a restart: a time and a step count, no points.
    live.steps = total;
  }
  live.thinned = Math.max(0, live.steps - live.series.length);
  live.cur_at = live.steps;
  if (ev.open && finite(ev.open.t)) {
    enterSolveStage(live);
    /** @type {Record<string, number>} */
    const open = { t: Number(ev.open.t) };
    for (const [k, v] of Object.entries(ev.open)) if (k !== 't' && finite(v)) open[k] = Number(v);
    live.current = open;
  } else if (!points.length && finite(ev.time)) {
    enterSolveStage(live);
    live.current = { t: Number(ev.time) };
  } else {
    live.current = null;
  }
  const last = live.current || live.series[live.series.length - 1];
  if (!live.solve_started_at && last && Number(last.t) > 0) live.solve_started_at = new Date().toISOString();
}

/**
 * Merge fields into the run's run.json (the study's run folder).
 * @param {any} rec
 * @param {Record<string, any>} fields
 */
function patchRun(rec, fields) {
  try {
    persistRun(String(rec.project_id), String(rec.simulation_id), {
      id: String(rec.run_id),
      run_id: String(rec.run_id),
      simulation_id: String(rec.simulation_id),
      ...fields,
    });
  } catch (e) {
    console.warn(`[CFD core solve] ${rec.id}: run doc not written`, e);
  }
}

/**
 * One frame event of a core solve.
 * @param {any} rec
 * @param {any} ev
 */
export function onCoreSolveEvent(rec, ev) {
  if (!rec || !ev || ev.event === 'end') return;
  const s = S();
  let live = s.live.get(String(rec.id));
  if (!live) {
    live = newLive(rec, ev.event !== 'start');
    s.live.set(String(rec.id), live);
  }
  switch (ev.event) {
    case 'stage':
      live.stage = docStageOf(ev.stage, live.stage);
      return;
    case 'phase':
      if (ev.phase && finite(ev.seconds)) live.phases = { ...(live.phases || {}), [String(ev.phase)]: Number(ev.seconds) };
      return;
    case 'progress':
      foldProgressFrame(live, ev);
      return;
    case 'time_saved': {
      const t = Number(ev.t);
      if (!Number.isFinite(t)) return;
      enterSolveStage(live);
      if (!live.saved_times.includes(t)) live.saved_times.push(t);
      const times = live.saved_times;
      const lastT = times[times.length - 1];
      const host = s.host;
      const snap = host ? attempt(() => host.snapshot(live)) : null;
      patchRun(rec, {
        has_results: times.length > 0,
        n_saved_times: times.length,
        last_saved_iteration: lastT,
        stage: 'solve',
        sim_time: (snap && snap.sim_time) || lastT,
      });
      return;
    }
    case 'relay': {
      // The relay's pid while the run solves (the Run panel's "PID n"); the end clears it.
      const pid = Math.floor(Number(ev.pid));
      if (!Number.isFinite(pid) || pid < 1) return;
      live.pid = pid;
      patchRun(rec, { pid });
      return;
    }
    case 'ranks': {
      const n = Math.floor(Number(ev.n_procs));
      if (!Number.isFinite(n) || n < 1) return;
      live.n_procs = n;
      const doc = readRunDocFile(String(rec.project_id), String(rec.run_id), String(rec.simulation_id));
      const note = doc && doc.note;
      const next = note ? noteWithRanks(note, n) : note;
      patchRun(rec, { n_procs: n, ...(next && next !== note ? { note: next } : {}) });
      return;
    }
    default:
      return;
  }
}

// ---- the end ----

/**
 * What an ended runner record makes of its run doc: the status and the texts the
 * old run path wrote, the last progress, saved frames and the log's tail.
 * done → done; stopped → stopped; failed → failed; lost → stopped when frames
 * were saved, else failed (the runner's text in both).
 * @param {any} doc the run doc
 * @param {any} rec the ended runner record
 * @param {{ snap?: any, saved?: number[], excerpt?: string | null, now?: string }} [ctx]
 */
export function endedRunDoc(doc, rec, ctx = {}) {
  const d = doc || {};
  const app = String(rec.app || d.path_kind || (d.launch && d.launch.app) || 'The solver');
  const transient = /transient/i.test(String(d.time_dependency || ''));
  const saved = Array.isArray(ctx.saved) ? ctx.saved : [];
  const lastSaved = saved.length ? saved[saved.length - 1] : 0;
  const unit = transient ? `t = ${lastSaved} s` : `iteration ${lastSaved}`;
  const runnerText = rec.error ? String(rec.error) : null;
  /** @param {string} t */
  const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
  let status = String(rec.status || '');
  if (status === 'lost') status = lastSaved > 0 ? 'stopped' : 'failed';
  if (status !== 'done' && status !== 'stopped' && status !== 'failed') status = 'failed';
  const result = rec.result && typeof rec.result === 'object' ? rec.result : {};
  const exit = finite(result.exit_code) ? Number(result.exit_code) : status === 'done' ? 0 : -1;
  /** @type {string} */
  let note;
  /** @type {string | null} */
  let error = null;
  if (status === 'done') {
    note = `${app} finished. Results are in the run folder.`;
  } else if (status === 'stopped') {
    error = runnerText;
    if (rec.status === 'lost' && runnerText) note = sentence(runnerText);
    else note = lastSaved > 0 ? `Run stopped. Results up to ${unit} are available.` : `Run stopped before the first saved ${transient ? 'time step.' : 'iteration.'}`;
  } else if (rec.code === 'launch' || rec.code === 'relay_failed') {
    error = runnerText || FOAM_TEXT.launch;
    note = `Failed to start ${app}: ${error}`;
  } else if (runnerText && /^\S+ failed \(exit [^)]*\)$/.test(runnerText)) {
    // The solver's own exit: the note the old path wrote ("simpleFoam failed (exit 1).").
    note = sentence(runnerText);
  } else {
    error = runnerText || `${app} failed`;
    note = sentence(error);
  }
  const snap = ctx.snap || null;
  const phases = { ...((snap && snap.phases) || {}), ...(rec.phases || {}) };
  const n = Math.floor(Number(rec.n_procs_run || result.n_procs || d.n_procs));
  /** @type {Record<string, any>} */
  const out = {
    status,
    exit_code: exit,
    signal: null,
    stop_requested: !!rec.stop,
    finished_at: rec.finished_at || ctx.now || new Date().toISOString(),
    pid: null,
    last_saved_iteration: lastSaved,
    n_saved_times: saved.length,
    has_results: lastSaved > 0,
    error,
    note,
  };
  if (snap) {
    if (snap.stage) out.stage = snap.stage;
    out.iteration = snap.iteration;
    out.sim_time = snap.sim_time;
    out.n_steps = snap.n_steps;
    out.residuals = Array.isArray(snap.residuals) ? snap.residuals : [];
    for (const k of ['co_max', 'co_mean', 'delta_t']) if (snap[k] !== null && snap[k] !== undefined) out[k] = snap[k];
  }
  if (Object.keys(phases).length) out.phases = phases;
  if (Number.isFinite(n) && n >= 1) out.n_procs = n;
  if (typeof ctx.excerpt === 'string') out.log_excerpt = ctx.excerpt;
  return out;
}

/**
 * The progress a run ended with: its live progress, with the job log's residuals
 * when the live progress has none (a run followed after a restart).
 * @param {any} live
 * @param {any} rec
 */
function endProgress(live, rec) {
  const host = S().host;
  if (!host) return null;
  const snap = live ? attempt(() => host.snapshot(live)) : null;
  if (snap && Array.isArray(snap.residuals) && snap.residuals.length) return snap;
  const fromLog = rec.log_path ? attempt(() => host.logProgress(String(rec.log_path), String(rec.analysis_key || ''))) : null;
  if (!fromLog) return snap;
  if (!snap) return fromLog;
  return {
    ...fromLog,
    ...snap,
    residuals: fromLog.residuals || [],
    n_steps: Math.max(Number(snap.n_steps) || 0, Number(fromLog.n_steps) || 0),
    stage: snap.stage || fromLog.stage,
  };
}

/** The status the Start's onDone hears (failed for anything not done or stopped). @param {string} status */
function doneStatus(status) {
  return status === 'done' || status === 'stopped' ? status : 'failed';
}

/** @param {any} rec */
export function onCoreSolveEnd(rec) {
  if (!rec) return;
  const s = S();
  const id = String(rec.id);
  const live = s.live.get(id) || null;
  s.live.delete(id);
  const done = s.done.get(id);
  s.done.delete(id);
  /** @type {Record<string, any> | null} */
  let out = null;
  try {
    const doc = readRunDocFile(String(rec.project_id), String(rec.run_id), String(rec.simulation_id));
    out = endedRunDoc(doc || {}, rec, {
      snap: endProgress(live, rec),
      saved: savedTimesIn(rec.case_dir),
      excerpt: solverLogExcerpt(rec),
    });
    // A run deleted meanwhile stays deleted.
    if (doc && s.host) s.host.writeRunDoc(String(rec.project_id), { ...doc, ...out, run_id: String(rec.run_id) });
  } catch (e) {
    console.warn(`[CFD core solve] ${id}: the end was not written`, e);
  }
  try {
    if (s.host) s.host.invalidate();
  } catch (e) {
    console.warn(`[CFD core solve] ${id}: live cache`, e);
  }
  if (typeof done === 'function') {
    try {
      const status = out ? out.status : doneStatus(String(rec.status));
      done({
        status: doneStatus(status),
        exit_code: out ? out.exit_code : null,
        run_id: String(rec.run_id),
        project_id: String(rec.project_id),
        error: (out && out.error) || (status === 'done' ? null : rec.error || null),
      });
    } catch (e) {
      console.warn(`[CFD core solve] ${id}: onDone`, e);
    }
  }
  scheduleComputeQueueKick(250);
}

/**
 * A run doc that says running while its runner record has ended (the server stopped
 * between the two writes): the end the record says, written now. A doc whose record
 * is still active, or that does not say running, is returned as it is.
 * @param {string} projectId
 * @param {any} doc
 * @param {any} rec its runner record
 */
export function reconcileEndedRun(projectId, doc, rec) {
  if (!doc || !rec || runnerJobActive(rec)) return doc;
  const st = String(doc.status || '');
  if (st !== 'running' && st !== 'starting') return doc;
  const next = {
    ...doc,
    ...endedRunDoc(doc, rec, { snap: endProgress(null, rec), saved: savedTimesIn(rec.case_dir), excerpt: solverLogExcerpt(rec) }),
  };
  const sid = String(doc.simulation_id || rec.simulation_id || '');
  if (sid) {
    try {
      persistRun(projectId, sid, next);
    } catch (e) {
      console.warn('[CFD core solve] reconcile', e);
    }
  }
  return next;
}

// ---- the start ----

/**
 * Hand a planned core solve to the runner. Synchronous (no await): the record is
 * made, `persistStarted(rec)` marks the run doc running (with runner_job_id), and
 * runFoamSteps adopts the Start's held claim and spawns, all in one tick.
 * @param {{
 *   projectId: string, simulationId: string, runId: string, runName: string, caseDir: string,
 *   plugin: string, analysisKey: string, app: string, launch: Record<string, any>,
 *   prepareRow: Record<string, any>, prepareParams: Record<string, unknown>,
 *   nProcs: number, slotsHint: number | null, claimToken: string, wslRoot: string,
 *   owner: string | null, hooks: string[], onDone?: Function | null,
 *   persistStarted: (rec: any) => void,
 * }} p
 * @returns {{ ok: true, record: any } | { ok: false, error: string, code?: string }}
 */
export function launchCoreSolve(p) {
  const id = newFoamJobId();
  const caseBase = dirname(p.caseDir);
  const token = randomBytes(4).toString('hex');
  const wslCase = `cfddesk-w27-${p.runId}`;
  const prepare = prepareFromJob(/** @type {any} */ (p.prepareRow), p.prepareParams, { jobId: id, caseDir: p.caseDir });
  const launch = p.launch || {};
  const names = Array.isArray(launch.process_names) && launch.process_names.length ? launch.process_names.map(String) : [p.app];
  const frames = Array.isArray(launch.frame_fields) && launch.frame_fields.length ? launch.frame_fields.map(String) : [...LEGACY_FRAME_FIELDS];
  const solver = {
    app: p.app,
    keep_frames: String(launch.keep_frames || 'latest'),
    process_names: names,
    stop_strategy: String(launch.stop_strategy || 'stopAt_writeNow'),
    frame_fields: frames,
    parallel: launch.parallel === false ? 'none' : 'mpirun',
    analysis: p.analysisKey,
  };
  const rec = createFoamRecord({
    id,
    kind: 'solve',
    project_id: p.projectId,
    run_id: p.runId,
    run_name: p.runName,
    simulation_id: p.simulationId,
    plugin: p.plugin,
    analysis_key: p.analysisKey,
    case_base: caseBase,
    case_parts: ['case'],
    case_dir: p.caseDir,
    token,
    wsl_case: wslCase,
    wsl_root: p.wslRoot,
    app: p.app,
    n_procs: p.nProcs,
    launch,
    prepare: { job: prepare.job, runtime: prepare.runtime },
  });
  try {
    p.persistStarted(rec);
  } catch (e) {
    console.warn(`[CFD core solve] ${id}: the run doc was not marked running`, e);
  }
  // A run started again (it stopped, failed or finished before): its case still has the
  // last attempt's relay files. This attempt's relay writes its own; until then the old
  // ones would name the old attempt (its status file is read if the new relay dies first).
  for (const name of ['.magnusim-run.json', '.magnusim-ran']) {
    try {
      rmSync(join(p.caseDir, name), { force: true });
    } catch (e) {
      console.warn(`[CFD core solve] ${id}: ${name} of the last attempt not removed`, e);
    }
  }
  const out = runFoamSteps({
    job_id: id,
    claim: { kind: 'solve', project_id: p.projectId, run_id: p.runId, name: p.runName, job_id: id },
    claim_token: p.claimToken,
    case_base: caseBase,
    case_parts: ['case'],
    case_dir: p.caseDir,
    plugin: p.plugin,
    wsl_case: wslCase,
    wsl_root: p.wslRoot,
    token,
    prepare,
    pre: [],
    n_procs: p.nProcs,
    slots_hint: p.slotsHint,
    solver,
    owner: p.owner,
    hooks: p.owner ? p.hooks : [],
    run_id: p.runId,
    simulation_id: p.simulationId,
  });
  if ('ok' in out && out.ok) {
    // Only a run that started tells its Start's caller how it ended (a refused one is the Start's answer).
    if (typeof p.onDone === 'function') S().done.set(id, p.onDone);
    return { ok: true, record: rec };
  }
  if ('busy' in out && out.busy) {
    // Its claim was taken from it: the run ends here (onEnd writes the doc).
    finishFoam(id, 'failed', { code: 'launch', error: FOAM_TEXT.launch });
    return { ok: false, error: FOAM_TEXT.launch, code: 'launch' };
  }
  const failed = /** @type {{ error?: string, code?: string }} */ (out);
  return { ok: false, error: String(failed.error || FOAM_TEXT.launch), code: failed.code };
}

// Registered at import (w27-solve.js imports this module), so a run the boot check
// adopts after a restart reaches it too.
registerStepRunKind('solve', { onEvent: onCoreSolveEvent, onEnd: onCoreSolveEnd });
