import { safeProjectPath } from './safe-path.js';
import { projectIdOrActive } from './request-scope.js';
// @ts-nocheck
/**
 * Simulation Control — runs: a study's case, written by its analysis
 * (prepare_run) from the project mesh, materials and boundary conditions, and
 * solved with the program its launch spec names. Does not re-split polyMesh.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, pyTool } from './python-env.js';
import { wslCasePath, wslDistro } from './wsl-env.js';
import { hardwarePrefs } from './prefs.js';
import { probeWslMpiSlots } from './hardware-profile.js';
import { matchesStudy } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, liveStudyRows } from './w17-sim-catalog.js';
import { TRANSIENT_LARGE_MESH_CELLS, simIsTransient } from './w30-transient.js';
import { createJobLogger } from './log.js';
import { envGet } from './env-compat.js';
import { spawnJob } from './job-runner.js';
import { commitRpc, commitRpcSync } from './py-json.js';
import {
  assembleAllRuns,
  assembleMeshDoc,
  assembleRuns,
  persistRun,
  readStudyJson,
  runFolderOf,
  studyFilePath,
  writeStudyJson,
} from './study-io.js';
import { listFoamTimeDirs } from './project-layout.js';
import { solveStartBlockReason } from './solve-start-block.js';
import {
  algorithmLabelFor,
  analysisByKey,
  analysisKeyFor,
  analysisSupportsTimeDependency,
  requiredPluginError,
  runDefaultsFor,
} from './registry-defaults.js';
import { removeComputeJob, scheduleComputeQueueKick } from './server/compute-queue.ts';
import { polyMeshComplete } from './poly-mesh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const REPORT_DIR = join(ROOT, '.cache', 'jobs', 'run');
const WSL_DISTRO = wslDistro();
const INCREMENT = 'W27';
const LARGE_MESH_CELLS = 200000;

/**
 * A run's iteration count or write interval as a positive whole number, or
 * null when it is unset. The values themselves are the run's analysis's (its
 * run model's defaults and limits, analysis.run_normalize); the core keeps none.
 */
function positiveInt(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Physical core count (not SMT threads). One MPI rank per physical core is the
 * fastest configuration measured on this box (Ball Test, 264k cells, 120 fixed
 * steps): 16 ranks 140 ms/step, 15 → 144, 14 → 148, 12 → 163, 8 → 213, and
 * 32 ranks on hyperthreads 2542 ms/step. Binding flags, MPI transport flags and
 * renumberMesh changed nothing, so only the rank count is tuned here.
 * Resolved once, asynchronously, from CIM; `resolveNProcs` falls back to the
 * logical count if it has not answered yet.
 */
let PHYSICAL_CORES = 0;
function detectPhysicalCores() {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('close', () => {
      const n = Number(String(out).trim());
      if (Number.isFinite(n) && n >= 1) PHYSICAL_CORES = Math.floor(n);
    });
    child.on('error', () => {});
  } catch {
    /* keep fallback */
  }
}
detectPhysicalCores();

/** @type {null | { child: import('node:child_process').ChildProcess, run_id: string, wsl_case: string, project_id: string, progress: ReturnType<typeof newProgressState>, wsl_case_path?: string, jobLog?: object, protocol?: string, baseRunning?: Record<string, any>, stop_requested?: boolean, stop_requested_at?: number, stop_timer?: ReturnType<typeof setTimeout> }} */
let liveRun = null;

function newProgressState() {
  return { buf: '', series: [], stage: 'starting', current: null, pending: null, solve_started_at: null, saved_times: [] };
}

const LATE_SOLVE_STAGES = new Set(['reconstruct', 'stopping']);

/** True when the run has already left "starting" even if stage was never stamped. */
export function runHasSolveProgress(rec) {
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

/** Keep reconstruct/copy/stopping; promote starting/decompose once progress exists. */
export function solveDisplayStage(rec) {
  const stage = rec && rec.stage != null ? String(rec.stage) : '';
  if (stage === 'reconstruct' || stage === 'copy' || stage === 'stopping') return stage;
  if (runHasSolveProgress(rec) && (!stage || stage === 'starting' || stage === 'decompose')) return 'solve';
  return stage || null;
}

function enterSolveStage(state) {
  if (!state) return;
  const st = String(state.stage || '');
  if (LATE_SOLVE_STAGES.has(st)) return;
  state.stage = 'solve';
}

function parseEventPayload(line) {
  let raw = String(line || '').trim();
  if (raw.startsWith('MAGNUSIM_EVENT ')) raw = raw.slice('MAGNUSIM_EVENT '.length).trim();
  else if (raw.startsWith('CFDDESK_EVENT ')) raw = raw.slice('CFDDESK_EVENT '.length).trim();
  if (!raw.startsWith('{')) return null;
  try {
    const ev = JSON.parse(raw);
    if (ev && typeof ev === 'object' && ev.event) return ev;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Apply one MAGNUSIM_EVENT / CFDDESK_EVENT JSONL object to the live progress
 * state. The solver's output is parsed once, in Python (the analysis's log
 * parser, named by its launch spec); Node only aggregates the events.
 * Keeps snapshotProgress / enrichRunDoc shape unchanged for /api/run/status.
 */
function applyJobEvent(state, ev) {
  if (!state || !ev || typeof ev !== 'object') return;
  const kind = ev.event;
  if (kind === 'stage') {
    const st = String(ev.stage || '');
    if (st === 'decompose') state.stage = 'decompose';
    else if (st === 'solve') state.stage = 'solve';
    else if (st === 'reconstruct' || st === 'solve_end') state.stage = 'reconstruct';
    else if (st === 'copy' || st === 'copy_to_wsl') state.stage = 'copy';
    return;
  }
  if (kind === 'time_saved') {
    enterSolveStage(state);
    const t = Number(ev.t);
    if (Number.isFinite(t) && !(state.saved_times || []).includes(t)) {
      if (!state.saved_times) state.saved_times = [];
      state.saved_times.push(t);
    }
    return;
  }
  if (kind === 'progress') {
    enterSolveStage(state);
    if (state.stage !== 'solve') return;
    if (state.current && Number.isFinite(state.current.t)) state.series.push(state.current);
    const t = Number(ev.time != null ? ev.time : ev.sim_time);
    const prev = state.current || {};
    const pend = state.pending || {};
    state.pending = null;
    state.current = { t };
    for (const k of ['delta_t', 'co_max', 'co_mean']) {
      if (Number.isFinite(Number(ev[k]))) state.current[k] = Number(ev[k]);
      else if (Number.isFinite(pend[k])) state.current[k] = pend[k];
      else if (Number.isFinite(prev[k])) state.current[k] = prev[k];
    }
    if (!state.solve_started_at && Number.isFinite(t) && t > 0) {
      state.solve_started_at = new Date().toISOString();
    }
    return;
  }
  if (kind === 'residual') {
    enterSolveStage(state);
    const t = Number(ev.time != null ? ev.time : ev.sim_time);
    if (!state.current && Number.isFinite(t)) state.current = { t };
    if (!state.current) return;
    const field = ev.field;
    const initial = Number(ev.initial);
    if (field && Number.isFinite(initial)) state.current[field] = initial;
    if (ev.fields && typeof ev.fields === 'object') {
      for (const [k, v] of Object.entries(ev.fields)) {
        const n = Number(v);
        if (Number.isFinite(n)) state.current[k] = n;
      }
    }
    return;
  }
  if (kind === 'phase') {
    // Wall-clock seconds of one solve phase (copy_in, decompose, solve, reconstruct, copy_back).
    const secs = Number(ev.seconds);
    if (ev.phase && Number.isFinite(secs)) {
      if (!state.phases) state.phases = {};
      state.phases[String(ev.phase)] = secs;
    }
    return;
  }
  if (kind === 'courant') {
    enterSolveStage(state);
    if (!state.pending) state.pending = {};
    if (Number.isFinite(Number(ev.mean))) state.pending.co_mean = Number(ev.mean);
    if (Number.isFinite(Number(ev.max))) state.pending.co_max = Number(ev.max);
    if (Number.isFinite(Number(ev.delta_t))) state.pending.delta_t = Number(ev.delta_t);
    return;
  }
}

function parsePrepareRunStdout(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** The residual series a run's analysis plots (its contract's residual_series). */
function residualSeriesFor(analysisKey) {
  const row = analysisKey ? analysisByKey(analysisKey) : null;
  return row && Array.isArray(row.residual_series) ? row.residual_series : [];
}

/**
 * The analysis a run solved with. Runs from before runs were stamped with it
 * are the default analysis family's; its transient sibling plots the steady
 * series plus the Courant number, so it reads either kind of old run.
 */
function runAnalysisKeyOf(doc) {
  return (doc && doc.analysis_key) || analysisKeyFor('', 'Transient');
}

/**
 * One plotted point: each series takes the largest of its solver fields (U of
 * Ux/Uy/Uz, say), plus a per-step metric's max. An analysis that declares no
 * series keeps every number as it came.
 */
export function compactResidual(row, series) {
  if (!series || !series.length) {
    const out = { t: row.t };
    for (const [k, v] of Object.entries(row)) if (k !== 't' && Number.isFinite(Number(v))) out[k] = Number(v);
    return out;
  }
  const out = { t: row.t };
  for (const s of series) {
    const fields = s.fields && s.fields.length ? s.fields : [s.key];
    const bits = fields.map((k) => Number(row[k])).filter(Number.isFinite);
    if (bits.length) out[s.key] = Math.max(...bits);
    if (s.max_key && Number.isFinite(Number(row[s.max_key]))) out[s.max_key] = Number(row[s.max_key]);
  }
  return out;
}

function downsampleResiduals(series, maxPts = 200, spec = []) {
  if (!Array.isArray(series) || !series.length) return [];
  const compact = series.map((row) => compactResidual(row, spec));
  if (compact.length <= maxPts) return compact;
  const out = [];
  const last = compact.length - 1;
  for (let i = 0; i < maxPts - 1; i++) {
    out.push(compact[Math.round((i / (maxPts - 1)) * last)]);
  }
  out.push(compact[last]);
  return out;
}

/**
 * A solver iteration's row, not a lone metric line: two of its residual fields
 * (or every one, for an analysis that solves a single field).
 */
function rowHasResidual(row, spec = []) {
  const solved = spec.filter((s) => !s.dashed);
  const fields = solved.length
    ? solved.flatMap((s) => (s.fields && s.fields.length ? s.fields : [s.key]))
    : Object.keys(row || {}).filter((k) => k !== 't');
  const n = fields.filter((k) => Number.isFinite(Number(row && row[k]))).length;
  return n >= Math.min(2, fields.length);
}

function snapshotProgress(state) {
  const series = state.series.slice();
  if (state.current && Number.isFinite(state.current.t)) {
    const last = series[series.length - 1];
    if (!last || last.t !== state.current.t) series.push({ ...state.current });
    else series[series.length - 1] = { ...state.current };
  }
  const last = series[series.length - 1];
  const out = {
    stage: state.stage,
    iteration: last && Number.isFinite(last.t) ? Math.round(last.t) : 0,
    // Physical time for transient runs (same number as iteration for steady).
    sim_time: last && Number.isFinite(last.t) ? last.t : 0,
    n_steps: series.length,
    residuals: downsampleResiduals(
      series.filter((row) => rowHasResidual(row, state.residual_series || [])),
      200,
      state.residual_series || [],
    ),
    solve_started_at: state.solve_started_at || null,
  };
  if (last && Number.isFinite(last.co_max)) out.co_max = last.co_max;
  if (last && Number.isFinite(last.co_mean)) out.co_mean = last.co_mean;
  if (last && Number.isFinite(last.delta_t)) out.delta_t = last.delta_t;
  if (state.saved_times && state.saved_times.length) {
    const times = state.saved_times.slice().sort((a, b) => a - b);
    out.live_saved_times = times;
  }
  if (state.phases && Object.keys(state.phases).length) out.phases = { ...state.phases };
  return out;
}

/**
 * Progress snapshot from a run's recorded job events (JSONL, with or without the
 * MAGNUSIM_EVENT prefix). Raw solver lines are not parsed here: that is the
 * analysis's log parser's job, and it already turned them into these events.
 */
export function parseSolveProgress(text, analysisKey) {
  const state = newProgressState();
  state.residual_series = residualSeriesFor(analysisKey);
  for (const line of String(text || '').split(/\r?\n/)) {
    const ev = parseEventPayload(line);
    if (ev) applyJobEvent(state, ev);
  }
  return snapshotProgress(state);
}

/** Catalog-sized run for first paint. No log re-parse, no residual series. */
export function slimRunDoc(doc) {
  if (!doc) return doc;
  return {
    id: doc.id || doc.run_id || null,
    run_id: doc.run_id || doc.id || null,
    name: doc.name || null,
    status: doc.status || null,
    mode: doc.mode || null,
    path_kind: doc.path_kind || null,
    case_dir: doc.case_dir || null,
    mesh_id: doc.mesh_id || null,
    mesh_name: doc.mesh_name || null,
    has_results: !!doc.has_results,
    n_saved_times: doc.n_saved_times != null ? doc.n_saved_times : null,
    last_saved_iteration: doc.last_saved_iteration != null ? doc.last_saved_iteration : null,
    iteration: doc.iteration != null ? doc.iteration : null,
    sim_time: doc.sim_time != null ? doc.sim_time : null,
    n_steps: doc.n_steps != null ? doc.n_steps : null,
    endTime: doc.endTime != null ? doc.endTime : null,
    writeInterval: doc.writeInterval != null ? doc.writeInterval : null,
    started_at: doc.started_at || null,
    finished_at: doc.finished_at || null,
    solve_started_at: doc.solve_started_at || null,
    simulation_id: doc.simulation_id || null,
    time_dependency: doc.time_dependency || null,
    result_controls: Array.isArray(doc.result_controls) ? doc.result_controls : [],
    pid: doc.pid != null ? doc.pid : null,
    n_procs: doc.n_procs != null ? doc.n_procs : null,
    stage: solveDisplayStage(doc) || doc.stage || null,
    project_id: doc.project_id || null,
    project_title: doc.project_title || null,
    study_label: doc.study_label || null,
  };
}

function progressSnapshotIsThin(progress) {
  if (!progress) return true;
  return !runHasSolveProgress(progress);
}

function enrichRunDoc(doc, opts) {
  if (!doc) return doc;
  if (opts && opts.slim) return slimRunDoc(doc);
  const sameLive =
    liveRun &&
    liveRun.progress &&
    String(liveRun.run_id) === String(doc.run_id || doc.id);
  let progress = sameLive ? snapshotProgress(liveRun.progress) : null;
  let fromLog = false;
  if (progressSnapshotIsThin(progress)) {
    for (const logPath of [doc.log_jsonl_path, doc.log_path]) {
      if (!logPath || !existsSync(logPath)) continue;
      try {
        const parsed = parseSolveProgress(readFileSync(logPath, 'utf8'), runAnalysisKeyOf(doc));
        if (!progressSnapshotIsThin(parsed) || (parsed && parsed.stage && parsed.stage !== 'starting')) {
          progress = parsed;
          fromLog = true;
          break;
        }
      } catch {
        /* try the next log */
      }
    }
    if (progressSnapshotIsThin(progress) && runHasSolveProgress(doc)) {
      progress = null;
      fromLog = false;
    }
  }
  const saved = liveSavedFields(doc);
  if (!progress) {
    const next = { ...doc, ...saved };
    const shown = solveDisplayStage(next);
    if (shown) next.stage = shown;
    return next;
  }
  // A log re-parse stamps solve_started_at with the parse time, which is
  // meaningless for the ETA; fall back to the run's start time instead.
  const startedAt = fromLog
    ? doc.solve_started_at || doc.started_at || null
    : progress.solve_started_at || doc.solve_started_at || null;
  const simTime = Math.max(
    Number(progress.sim_time) || 0,
    Number(doc.sim_time) || 0,
    Number(doc.iteration) || 0,
    Number(saved.last_saved_iteration) || 0
  );
  const next = {
    ...doc,
    stage: progress.stage || doc.stage,
    iteration: Math.max(Number(progress.iteration) || 0, Number(doc.iteration) || 0, simTime),
    sim_time: simTime,
    n_steps: Math.max(Number(progress.n_steps) || 0, Number(doc.n_steps) || 0),
    ...(progress.co_max != null ? { co_max: progress.co_max } : {}),
    ...(progress.co_mean != null ? { co_mean: progress.co_mean } : {}),
    ...(progress.delta_t != null ? { delta_t: progress.delta_t } : {}),
    residuals:
      Array.isArray(progress.residuals) && progress.residuals.length
        ? progress.residuals
        : doc.residuals,
    solve_started_at: startedAt,
    ...saved,
  };
  const shown = solveDisplayStage(next);
  if (shown) next.stage = shown;
  return next;
}

/**
 * The solve script copies each finished time directory to the Windows run
 * folder as it is written. Report what is on disk so Results can open mid-run
 * and still open after an early stop, even if run.json still says
 * has_results: false from the start stamp.
 */
function liveSavedFields(doc) {
  if (!doc) return {};
  const caseDir = doc.case_dir || (doc.prepare_run && doc.prepare_run.case_dir);
  if (!caseDir) return {};
  const times = listSavedTimes(caseDir);
  if (!times.length) return {};
  const last = times[times.length - 1];
  return {
    has_results: true,
    last_saved_iteration: last,
    n_saved_times: times.length,
    saved_times: times,
  };
}

function applySavedTimesFromDiskInPlace(rec) {
  if (!rec) return false;
  const extra = liveSavedFields(rec);
  if (!extra.has_results) return false;
  let dirty =
    !rec.has_results ||
    Number(rec.n_saved_times) !== extra.n_saved_times ||
    rec.last_saved_iteration !== extra.last_saved_iteration;
  rec.has_results = true;
  rec.n_saved_times = extra.n_saved_times;
  rec.last_saved_iteration = extra.last_saved_iteration;
  if (!(Number(rec.sim_time) > extra.last_saved_iteration)) {
    rec.sim_time = extra.last_saved_iteration;
    dirty = true;
  }
  const shown = solveDisplayStage(rec);
  if (shown && shown !== rec.stage) dirty = true;
  if (shown) rec.stage = shown;
  return dirty;
}

/** A restarted run used to keep stop_requested/stage from the previous Stop. */
function overlayLiveRunFlags(doc) {
  if (!doc || !liveRun) return doc;
  if (String(liveRun.run_id) !== String(doc.run_id || doc.id)) return doc;
  if (liveRun.stop_requested) {
    doc.stop_requested = true;
    return doc;
  }
  doc.stop_requested = false;
  const liveStage = liveRun.progress && liveRun.progress.stage;
  if (liveStage && liveStage !== 'copy' && liveStage !== 'reconstruct') {
    doc.stage = liveStage;
  } else if (doc.stage === 'stopping' || doc.stage === 'copy' || doc.stage === 'reconstruct') {
    doc.stage = 'solve';
  }
  const shown = solveDisplayStage(doc);
  if (shown) doc.stage = shown;
  return doc;
}

function stampId() {
  return randomBytes(4).toString('hex');
}

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE_PATH, 'utf8')).project_id || null;
  } catch {
    return null;
  }
}

function projectDir(id) {
  return safeProjectPath(PROJECTS_ROOT, id);
}

function winToWsl(winPath) {
  const posix = String(winPath).replace(/\\/g, '/');
  const m = posix.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : posix;
}

function readJsonSafe(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readProject(id) {
  return id ? readJsonSafe(join(projectDir(id), 'project.json')) : null;
}

function projectTitleOf(projectId) {
  const proj = readProject(projectId);
  const t = proj && (proj.title || proj.name);
  return t ? String(t) : '';
}

function studyLabelOf(projectId, simulationId) {
  try {
    const sim = getActiveSimulation(projectId, readProject(projectId), simulationId);
    if (!sim) return '';
    return String(sim.geometry_name || sim.name || '');
  } catch {
    return '';
  }
}

function decorateJobOwner(doc, projectId) {
  if (!doc) return doc;
  const pid = projectId || doc.project_id || null;
  const title = doc.project_title || projectTitleOf(pid);
  const study = doc.study_label || studyLabelOf(pid, doc.simulation_id);
  return {
    ...doc,
    project_id: pid || doc.project_id || null,
    project_title: title || doc.project_title || null,
    study_label: study || doc.study_label || null,
  };
}

function activeStudy(id, explicitId) {
  return getActiveSimulation(id, readProject(id), explicitId);
}

function legacyStudyId(id) {
  return firstLegacySimId(id, readProject(id));
}

function runsForActiveStudy(projectId, runs, explicitId) {
  const sim = activeStudy(projectId, explicitId);
  return (runs || []).filter((r) => matchesStudy(r, sim && sim.id, legacyStudyId(projectId)));
}

function runListPayload(projectId, cat, extra) {
  const explicit = extra && extra.simulation_id;
  const rest = { ...(extra || {}) };
  delete rest.simulation_id;
  const runs = runsForActiveStudy(projectId, cat && cat.runs, explicit);
  const aid = cat && cat.active_id;
  const active_run_id = aid && runs.some((r) => r && String(r.id) === String(aid)) ? aid : null;
  return { runs, active_run_id, ...rest };
}


export function parseBoundaryPatches(boundaryPath) {
  if (!boundaryPath || !existsSync(boundaryPath)) return [];
  const text = readFileSync(boundaryPath, 'utf8');
  const out = [];
  const re = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*\r?\n\s*\{\s*\r?\n\s*type\s+(\S+);/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({ name: m[1], type: String(m[2]).replace(/;$/, '') });
  }
  return out;
}

function meshRecordReady(rec) {
  const live = rec && rec.live_mesh_result;
  const caseDir = (live && live.case_dir) || (rec && rec.case_dir);
  const polyFromCase = caseDir ? join(caseDir, 'constant', 'polyMesh') : null;
  const poly = (polyMeshComplete(polyFromCase) ? polyFromCase : null) || (live && live.mesh_path) || polyFromCase;
  return !!(live && live.status === 'done' && caseDir && existsSync(caseDir) && polyMeshComplete(poly));
}

export function listGeneratedMeshes(projectId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  const sim = activeStudy(id, simulationId);
  const mesh = id && sim ? assembleMeshDoc(id, sim.id) : null;
  if (!mesh) return [];
  const list = Array.isArray(mesh.meshes) && mesh.meshes.length ? mesh.meshes : [mesh];
  const legacy = legacyStudyId(id);
  return list
    .filter((m) => m && (m.id || m.name) && matchesStudy(m, sim && sim.id, legacy))
    .map((m) => {
      const live = m.live_mesh_result || null;
      return {
        id: m.id || null,
        name: m.name || 'Mesh',
        ready: meshRecordReady(m),
        n_cells: live && live.n_cells != null ? live.n_cells : null,
        case_dir: live && live.case_dir ? live.case_dir : null,
        active: String(m.id) === String(mesh.active_id),
      };
    });
}

export function resolveProjectMesh(projectId, meshId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no active project' };
  const sim = activeStudy(id, simulationId);
  const mesh = sim ? assembleMeshDoc(id, sim.id) : null;
  if (!mesh || !(mesh.meshes || []).length) {
    return {
      ok: false,
      error: 'mesh.json missing — generate a mesh first',
      project_id: id,
      fix: { go: 'mesh-hub' },
    };
  }

  const meshes = Array.isArray(mesh.meshes) ? mesh.meshes : [];
  const legacy = legacyStudyId(id);
  const scoped = meshes.filter((m) => m && matchesStudy(m, sim && sim.id, legacy));
  const wanted = meshId
    ? scoped.find((m) => String(m.id) === String(meshId))
    : scoped.find((m) => String(m.id) === String(mesh.active_id)) || null;
  if (meshId && !wanted) {
    return {
      ok: false,
      error: 'mesh not found in this study',
      project_id: id,
      mesh_id: meshId,
      fix: { go: 'mesh-hub' },
    };
  }

  const case_dir = (wanted && wanted.case_dir) || (wanted && wanted.live_mesh_result && wanted.live_mesh_result.case_dir) || null;
  const stalePath = wanted && wanted.live_mesh_result && wanted.live_mesh_result.mesh_path;
  const polyFromCase = case_dir ? join(case_dir, 'constant', 'polyMesh') : null;
  const polyComplete = (p) => polyMeshComplete(p);
  const poly = polyComplete(polyFromCase) ? polyFromCase : polyComplete(stalePath) ? stalePath : polyFromCase || stalePath;
  const live =
    wanted &&
    wanted.live_mesh_result &&
    case_dir &&
    existsSync(case_dir) &&
    polyComplete(poly)
      ? { ...wanted.live_mesh_result, case_dir, mesh_path: poly }
      : null;

  if (wanted && !live) {
    return {
      ok: false,
      error: 'Generate "' + (wanted.name || 'that mesh') + '" before using it on a run',
      project_id: id,
      mesh_id: wanted.id,
      fix: { go: 'mesh', id: wanted.id, name: wanted.name || 'Mesh' },
    };
  }
  if (!case_dir || !existsSync(case_dir)) {
    return {
      ok: false,
      error: 'Generated mesh case missing — generate a mesh first',
      project_id: id,
      case_dir,
      fix: { go: wanted && wanted.id ? 'mesh' : 'mesh-hub', id: wanted && wanted.id, name: wanted && wanted.name },
    };
  }
  if (!polyMeshComplete(poly)) {
    return {
      ok: false,
      error: 'The mesh files are incomplete — generate the mesh again',
      project_id: id,
      case_dir,
      mesh_path: poly,
      fix: { go: wanted && wanted.id ? 'mesh' : 'mesh-hub', id: wanted && wanted.id, name: wanted && wanted.name },
    };
  }
  const bound = join(poly, 'boundary');
  const patches = parseBoundaryPatches(bound);
  return {
    ok: true,
    project_id: id,
    case_dir,
    wsl_case: (live && live.wsl_case) || null,
    mesh_path: poly,
    n_cells: live && live.n_cells != null ? live.n_cells : null,
    n_points: live && live.n_points != null ? live.n_points : null,
    patches,
    mesh_id: (wanted && wanted.id) || null,
    mesh_name: (wanted && wanted.name) || null,
  };
}

export function getSimulationControl(projectId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { endTime: null, writeInterval: null, project_id: null };
  const sim = activeStudy(id, simulationId);
  const doc =
    (sim && readStudyJson(id, sim.id, 'control')) ||
    readJsonSafe(join(projectDir(id), 'simulation_control.json')) ||
    {};
  // The last saved, else the study's steady analysis's run defaults (null when it has none).
  const steady = steadyRunDefaults(sim);
  const endTime = positiveInt(doc.endTime) ?? positiveInt(steady.end_time);
  const writeInterval = positiveInt(doc.writeInterval) ?? positiveInt(steady.write_interval);
  return {
    project_id: id,
    endTime,
    writeInterval,
    // A new transient run's settings: the last saved (its analysis cleaned
    // them when they were stored) over its analysis's run defaults.
    transient: {
      ...transientRunDefaults(sim),
      ...(doc.transient && typeof doc.transient === 'object' ? doc.transient : {}),
    },
    updated_at: doc.updated_at || null,
  };
}

/**
 * The run defaults of a study's transient analysis (its contract's
 * run_defaults), or {} when its family has none.
 */
function transientRunDefaults(sim) {
  const type = sim && sim.analysis_type;
  if (!analysisSupportsTimeDependency(type, 'Transient')) return {};
  return runDefaultsFor(analysisKeyFor(type, 'Transient'));
}

/** The run defaults of a study's steady analysis, or {} when its family has none. */
function steadyRunDefaults(sim) {
  const type = sim && sim.analysis_type;
  if (!analysisSupportsTimeDependency(type, 'Steady-state')) return {};
  return runDefaultsFor(analysisKeyFor(type, 'Steady-state'));
}

/**
 * Transient run settings as the run's analysis stores them: the edits over
 * what is stored, cleaned up by its run model (analysis.run_normalize). The
 * limits (frame count, correctors, …) are the analysis's own, not the core's.
 * Throws when the worker cannot answer.
 * @param {string} projectId
 * @param {{ simulationId?: string, runId?: string, settings?: object, base?: object }} opts
 */
function normalizeTransientSettings(projectId, opts) {
  return normalizeRunSettings(projectId, { ...opts, timeDependency: 'Transient' });
}

/**
 * Steady run settings ({ end_time, write_interval } in iterations) as the
 * run's analysis stores them, the same way: the core clamps nothing itself.
 * @param {string} projectId
 * @param {{ simulationId?: string, runId?: string, settings?: object, base?: object }} opts
 */
function normalizeSteadySettings(projectId, opts) {
  return normalizeRunSettings(projectId, { ...opts, timeDependency: 'Steady-state' });
}

/** The run's iteration count and write interval as the steady settings block its analysis reads. */
function steadyBlock(rec) {
  /** @type {Record<string, number>} */
  const out = {};
  const end = positiveInt(rec && rec.endTime);
  const every = positiveInt(rec && rec.writeInterval);
  if (end != null) out.end_time = end;
  if (every != null) out.write_interval = every;
  return out;
}

/**
 * @param {string} projectId
 * @param {{ simulationId?: string, runId?: string, timeDependency: string, settings?: object, base?: object }} opts
 */
async function normalizeRunSettings(projectId, { simulationId, runId, timeDependency, settings, base }) {
  const out = await commitRpc('analysis.run_normalize', {
    project_id: projectId,
    simulation_id: simulationId || '',
    run_id: runId ? String(runId) : '',
    time_dependency: timeDependency,
    settings: settings && typeof settings === 'object' ? settings : {},
    base: base && typeof base === 'object' ? base : {},
  });
  if (!out || !out.settings || typeof out.settings !== 'object') {
    throw new Error((out && out.error) || 'the analysis returned no run settings');
  }
  return out.settings;
}

export async function saveSimulationControl(projectId, partial, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no active project' };
  const sim = activeStudy(id, simulationId || (partial && partial.simulation_id));
  const prev = getSimulationControl(id, sim && sim.id);
  const next = {
    project_id: id,
    simulation_id: (sim && sim.id) || null,
    // Callers pass values its analysis already cleaned (normalizeSteadySettings).
    endTime: partial.endTime != null ? positiveInt(partial.endTime) ?? prev.endTime : prev.endTime,
    writeInterval: partial.writeInterval != null ? positiveInt(partial.writeInterval) ?? prev.writeInterval : prev.writeInterval,
    // Callers pass a block its analysis already cleaned (normalizeTransientSettings).
    transient:
      partial.transient && typeof partial.transient === 'object'
        ? { ...prev.transient, ...partial.transient }
        : prev.transient,
    updated_at: new Date().toISOString(),
    increment: INCREMENT,
  };
  try {
    if (sim && sim.id) writeStudyJson(id, sim.id, 'control', next);
    else {
      await commitRpc('sim_control.set', {
        project_dir: projectDir(id),
        sim_id: String((sim && sim.id) || ''),
        body: next,
      });
    }
  } catch (e) {
    console.warn('[CFD] save sim control', e);
  }
  return { ok: true, ...next };
}

/** Active study time dependency. Do not read leftover simulation.json. */
function projectIsTransient(projectId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return false;
  const sim = activeStudy(id, simulationId);
  if (sim) return simIsTransient(sim);
  return false;
}

function runIsTransient(rec) {
  return !!(rec && /transient/i.test(String(rec.time_dependency || '')));
}

function resolveNProcs(nCells, opts) {
  const n = Number(nCells) || 0;
  const threshold = opts && opts.transient ? TRANSIENT_LARGE_MESH_CELLS : LARGE_MESH_CELLS;
  if (n > 0 && n < threshold) return 1;
  const logical = Math.max(1, (cpus() || []).length);
  // One rank per physical core. Never oversubscribe hyperthreads: OpenMPI
  // ranks busy-poll, and two ranks on one core ran ~18x slower in testing.
  let nProcs;
  if (PHYSICAL_CORES >= 1) nProcs = Math.max(2, Math.min(PHYSICAL_CORES, logical));
  else nProcs = Math.max(2, logical >= 8 ? Math.floor(logical / 2) : logical);
  const hw = hardwarePrefs();
  const cap = hw && Number(hw.n_procs);
  if (Number.isFinite(cap) && cap >= 1) nProcs = Math.min(nProcs, Math.floor(cap));
  // Windows CIM core counts can exceed Open MPI's WSL slot count (hybrid CPUs).
  const savedSlots = hw && Number(hw.wsl_mpi_slots);
  const liveSlots = probeWslMpiSlots(WSL_DISTRO);
  const slots = liveSlots >= 1 ? liveSlots : Number.isFinite(savedSlots) && savedSlots >= 1 ? Math.floor(savedSlots) : 0;
  if (slots >= 1) nProcs = Math.min(nProcs, slots);
  return Math.max(1, nProcs);
}

/**
 * What every analysis needs before a run can start: its study's mesh, the
 * study itself, and the required plugins. What else blocks a run (materials,
 * boundary conditions, the analysis's own settings) is the analysis's call:
 * startSolve asks it through the worker (analysis.validate_ready).
 */
export function validateSolveReady(projectId, opts) {
  // Without its required plugin no run can start, whatever its mesh: say that first.
  const blocked = requiredPluginError();
  if (blocked) return { ok: false, error: blocked, project_id: projectId, required_plugin_missing: true, fix: { go: 'plugins' } };
  const mesh = resolveProjectMesh(projectId, opts && opts.meshId, opts && opts.simulationId);
  if (!mesh.ok) return mesh;
  const id = mesh.project_id;
  const sim = activeStudy(id, opts && opts.simulationId);
  if (!sim) {
    return { ok: false, error: 'Create a simulation first', project_id: id, fix: { go: 'create-sim' } };
  }
  return { ok: true, project_id: id, mesh, sim };
}

/**
 * A run's monitor results, read by the analysis the run solves with
 * (analysis.run_monitors): per-patch and custom monitors in display units, and
 * the mass balance across the monitored openings.
 */
export async function getRunMonitors(projectId, runId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no active project' };
  const cat = loadCatalog(id);
  const scoped = runsForActiveStudy(id, cat.runs, simulationId);
  const rec =
    scoped.find((r) => String(r.id) === String(runId || '')) ||
    (cat.active_id && scoped.find((r) => String(r.id) === String(cat.active_id))) ||
    null;
  if (!rec) return { ok: false, error: 'Run not found', ...runListPayload(id, cat, { simulation_id: simulationId }) };
  let res = null;
  try {
    res = await commitRpc('analysis.run_monitors', {
      project_id: id,
      run_id: String(rec.id),
      simulation_id: rec.simulation_id || simulationId || '',
      case_dir: rec.case_dir || join(runsDir(id), `run-${rec.id}`),
      time_dependency: rec.time_dependency || '',
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'monitor results failed' };
  return {
    ok: true,
    project_id: id,
    run_id: rec.id,
    status: rec.status || null,
    transient: runIsTransient(rec),
    time_dependency: rec.time_dependency || null,
    rho: res.rho,
    monitors: res.monitors || [],
    custom: res.custom || [],
    balance: res.balance || null,
    // Why there are none: the run's analysis is not installed.
    unavailable: res.unavailable || null,
  };
}

/**
 * "<app> 4 ranks — <family> / <physics> / <algorithm>[ · <detail>]". The
 * physics, algorithm and detail (a transient run's time, frames and Courant
 * limit) are what the analysis wrote the case with: prepare_run's
 * physics_label / algorithm / note_detail. An analysis without them names none.
 */
function runNote({ app, nProcs, analysisKey, sim, prep }) {
  const row = analysisByKey(analysisKey);
  const family = (row && row.family && row.family.label) || (sim && sim.analysis) || '';
  const algorithm = (prep && prep.algorithm) || algorithmLabelFor(analysisKey) || '';
  const parts = [family, (prep && prep.physics_label) || '', algorithm].filter(Boolean).join(' / ');
  const head = `${app} ${nProcs > 1 ? nProcs + ' ranks' : 'serial'}` + (parts ? ` — ${parts}` : '');
  const detail = (prep && prep.note_detail) || '';
  return detail ? `${head} · ${detail}` : head;
}

function runsDir(projectId) {
  return join(projectDir(projectId), 'runs');
}

function catalogPath(projectId) {
  return join(runsDir(projectId), 'catalog.json');
}

function runSidecarPath(projectId, runId) {
  return join(runsDir(projectId), `run-${runId}.json`);
}

function nextRunName(list) {
  let max = 0;
  for (const rec of list || []) {
    const m = String((rec && rec.name) || '').match(/^Run\s+(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'Run ' + (max + 1);
}

function inferRunStatus(caseDir, endTime) {
  let maxT = 0;
  try {
    for (const name of readdirSync(caseDir)) {
      if (/^\d+(\.\d+)?$/.test(name)) maxT = Math.max(maxT, Number(name));
    }
  } catch {}
  const end = Number(endTime);
  if (Number.isFinite(end) && end > 0 && maxT > 0 && maxT + 1e-9 < end) return 'stopped';
  if (maxT > 0) return 'done';
  return null;
}

function catalogEntryFromDoc(doc, name, prev) {
  const rcs = Array.isArray(doc.result_controls)
    ? doc.result_controls
    : prev && Array.isArray(prev.result_controls)
      ? prev.result_controls
      : [];
  return {
    id: doc.run_id || doc.id,
    name: name || doc.name || (prev && prev.name) || 'Run 1',
    status: doc.status || (prev && prev.status) || null,
    case_dir: doc.case_dir || (prev && prev.case_dir) || null,
    started_at: doc.started_at || (prev && prev.started_at) || null,
    finished_at: doc.finished_at || (prev && prev.finished_at) || null,
    endTime: doc.endTime != null ? doc.endTime : prev ? prev.endTime : null,
    writeInterval: doc.writeInterval != null ? doc.writeInterval : prev ? prev.writeInterval : null,
    // W30: which time dependency the run was (or will be) solved with, and
    // its transient settings. Steady runs carry neither.
    time_dependency: doc.time_dependency || (prev && prev.time_dependency) || null,
    transient: doc.transient || (prev && prev.transient) || null,
    mesh_id: doc.mesh_id || (prev && prev.mesh_id) || null,
    mesh_name: doc.mesh_name || (prev && prev.mesh_name) || null,
    result_controls: rcs,
    iteration: doc.iteration != null ? doc.iteration : prev ? prev.iteration : null,
    sim_time: doc.sim_time != null ? doc.sim_time : prev ? prev.sim_time ?? null : null,
    n_procs: doc.n_procs != null ? doc.n_procs : prev ? prev.n_procs : null,
    exit_code: doc.exit_code == null ? (prev ? prev.exit_code : null) : doc.exit_code,
    // Stopped runs keep whatever iterations were written; the tree/Results
    // panel read these to decide whether partial results can be opened.
    last_saved_iteration:
      doc.last_saved_iteration != null
        ? doc.last_saved_iteration
        : prev
          ? prev.last_saved_iteration ?? null
          : null,
    has_results: doc.has_results != null ? !!doc.has_results : prev ? !!prev.has_results : false,
    n_saved_times: doc.n_saved_times != null ? doc.n_saved_times : prev ? prev.n_saved_times ?? null : null,
    stop_requested: doc.stop_requested != null ? !!doc.stop_requested : prev ? !!prev.stop_requested : false,
    created_at: doc.created_at || (prev && prev.created_at) || null,
  };
}

function scanRunFolders(projectId) {
  const dir = runsDir(projectId);
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const m = String(name).match(/^run-([0-9a-f]{8})$/i);
    if (!m) continue;
    const caseDir = join(dir, name);
    try {
      if (!statSync(caseDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const sidecar = readJsonSafe(runSidecarPath(projectId, m[1]));
    const meta = readJsonSafe(join(caseDir, 'w27-case.json')) || {};
    let mtime = 0;
    try {
      mtime = statSync(caseDir).mtimeMs || 0;
    } catch {}
    found.push({
      id: m[1],
      sidecar,
      meta,
      case_dir: caseDir,
      mtime,
    });
  }
  found.sort((a, b) => {
    const ta = Date.parse((a.sidecar && a.sidecar.started_at) || '') || a.mtime;
    const tb = Date.parse((b.sidecar && b.sidecar.started_at) || '') || b.mtime;
    return ta - tb;
  });
  return found;
}

function loadCatalog(projectId, opts) {
  const sim = activeStudy(projectId, opts && opts.simulation_id);
  if (sim && sim.id) {
    const runs = assembleRuns(projectId, sim.id);
    const saved = readStudyJson(projectId, sim.id, 'runs');
    const wanted = (opts && opts.active_id) || (saved && saved.active_id);
    const latest = [...runs].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    return {
      runs,
      active_id: (wanted && runs.some((r) => r.id === wanted) ? wanted : null) || (latest && latest.id) || null,
      simulation_id: sim.id,
    };
  }
  const existing = readJsonSafe(catalogPath(projectId));
  const scanned = scanRunFolders(projectId);
  const byId = new Map();
  if (existing && Array.isArray(existing.runs)) {
    for (const rec of existing.runs) {
      if (rec && rec.id) byId.set(String(rec.id), { ...rec });
    }
  }
  let catalogDirty = false;
  const study = activeStudy(projectId);
  for (const item of scanned) {
    if (!byId.has(item.id)) {
      // A later catalog rewrite used to drop real case folders. Bring them back.
      const doc = item.sidecar || {};
      const inferred = inferRunStatus(item.case_dir, doc.endTime || item.meta.endTime);
      const running = !!(liveRun && String(liveRun.run_id) === String(item.id));
      const saved = listSavedTimes(item.case_dir);
      const lastSaved = saved.length ? saved[saved.length - 1] : 0;
      byId.set(
        item.id,
        catalogEntryFromDoc(
          {
            ...doc,
            id: item.id,
            run_id: item.id,
            case_dir: doc.case_dir || item.case_dir,
            status: running
              ? doc.status || 'running'
              : inferred || (doc.status === 'running' ? 'stopped' : doc.status) || 'done',
            last_saved_iteration: lastSaved,
            has_results: lastSaved > 0 || !!doc.has_results,
            simulation_id:
              doc.simulation_id ||
              (existing && existing.simulation_id) ||
              (study && study.id) ||
              null,
          },
          doc.name,
          null
        )
      );
      catalogDirty = true;
      continue;
    }
    const prev = byId.get(item.id);
    const doc = item.sidecar || {};
    const running = !!(liveRun && String(liveRun.run_id) === String(item.id));
    const inferred = inferRunStatus(item.case_dir, doc.endTime || item.meta.endTime || (prev && prev.endTime));
    const staleLive = !running && (doc.status === 'running' || doc.status === 'starting' || (prev && (prev.status === 'running' || prev.status === 'starting')));
    const status = running
      ? 'running'
      : inferred || (staleLive ? 'stopped' : doc.status || (prev && prev.status) || null);
    byId.set(item.id, {
      ...(prev || {}),
      id: item.id,
      name: (prev && prev.name) || doc.name || null,
      status,
      case_dir: doc.case_dir || item.case_dir,
      started_at: doc.started_at || (prev && prev.started_at) || null,
      finished_at: doc.finished_at || (prev && prev.finished_at) || null,
      endTime: doc.endTime || item.meta.endTime || (prev && prev.endTime) || null,
      writeInterval: doc.writeInterval || item.meta.writeInterval || (prev && prev.writeInterval) || null,
      time_dependency: doc.time_dependency || item.meta.time_dependency || (prev && prev.time_dependency) || null,
      transient: doc.transient || item.meta.transient || (prev && prev.transient) || null,
      mesh_id: doc.mesh_id || (prev && prev.mesh_id) || null,
      mesh_name: doc.mesh_name || (prev && prev.mesh_name) || null,
      result_controls: Array.isArray(doc.result_controls)
        ? doc.result_controls
        : (prev && prev.result_controls) || [],
      iteration: doc.iteration || (prev && prev.iteration) || null,
      sim_time: doc.sim_time != null ? doc.sim_time : prev && prev.sim_time != null ? prev.sim_time : null,
      n_procs: doc.n_procs || item.meta.nProcs || (prev && prev.n_procs) || null,
      exit_code: doc.exit_code != null ? doc.exit_code : prev ? prev.exit_code : null,
      last_saved_iteration:
        doc.last_saved_iteration != null
          ? doc.last_saved_iteration
          : prev && prev.last_saved_iteration != null
            ? prev.last_saved_iteration
            : null,
      has_results: doc.has_results != null ? !!doc.has_results : prev ? !!prev.has_results : false,
      stop_requested: doc.stop_requested != null ? !!doc.stop_requested : prev ? !!prev.stop_requested : false,
    });
    // Older sidecars (before graceful stop) never recorded what was written;
    // fall back to the time directories on disk.
    const rec = byId.get(item.id);
    if (!running) {
      const saved = listSavedTimes(item.case_dir);
      const last = saved.length ? saved[saved.length - 1] : 0;
      if (rec.last_saved_iteration == null || last > (Number(rec.last_saved_iteration) || 0)) {
        rec.last_saved_iteration = last;
        catalogDirty = true;
      }
      const had = !!rec.has_results;
      rec.has_results = !!(rec.has_results || rec.last_saved_iteration > 0);
      if (had !== rec.has_results) catalogDirty = true;
      if (staleLive && rec.status !== doc.status) catalogDirty = true;
    }
  }
  const runs = Array.from(byId.values());
  for (const rec of runs) {
    if (!rec.name) rec.name = nextRunName(runs.filter((r) => r.name));
  }
  const liveId = liveRun && liveRun.run_id;
  const active_id =
    (liveId && byId.has(String(liveId)) ? String(liveId) : null) ||
    (existing && existing.active_id && byId.has(String(existing.active_id))
      ? String(existing.active_id)
      : null);
  const cat = { active_id, runs, updated_at: new Date().toISOString() };
  if (catalogDirty && (!opts || opts.persist !== false)) {
    try {
      saveCatalog(projectId, cat);
    } catch (e) {
      console.warn('[CFD] heal run catalog', e);
    }
  }
  return cat;
}

function saveCatalog(projectId, cat, opts) {
  const sim = activeStudy(projectId, cat && cat.simulation_id);
  if (sim && sim.id) {
    const only = opts && (opts.onlyRunId || opts.only_run_id);
    const skipRuns = !!(opts && opts.skipRuns);
    if (!skipRuns) {
      for (const rec of cat.runs || []) {
        if (!rec || !(rec.id || rec.run_id)) continue;
        if (only && String(rec.id || rec.run_id) !== String(only)) continue;
        persistRun(projectId, sim.id, rec);
      }
    }
    writeStudyJson(projectId, sim.id, 'runs', { active_id: cat.active_id || null });
    return Promise.resolve({ ok: true });
  }
  try {
    const write = commitRpc('runs.catalog.set', {
      project_dir: projectDir(projectId),
      sim_id: String((sim && sim.id) || ''),
      body: {
        active_id: cat.active_id || null,
        runs: cat.runs || [],
        updated_at: new Date().toISOString(),
      },
    });
    if (write && typeof write.then === 'function') {
      write.catch((e) => console.warn('[CFD] save run catalog', e));
    }
    return write;
  } catch (e) {
    console.warn('[CFD] save run catalog', e);
  }
}

function upsertCatalogRun(projectId, doc) {
  if (!projectId || !doc || !doc.run_id) return loadCatalog(projectId);
  const cat = loadCatalog(projectId, { simulation_id: doc.simulation_id });
  const idx = cat.runs.findIndex((r) => String(r.id) === String(doc.run_id));
  const prev = idx >= 0 ? cat.runs[idx] : null;
  const name = (prev && prev.name) || doc.name || nextRunName(cat.runs);
  const entry = catalogEntryFromDoc({ ...doc, name }, name, prev);
  if (idx >= 0) cat.runs[idx] = { ...cat.runs[idx], ...entry };
  else cat.runs.push(entry);
  cat.active_id = doc.run_id;
  saveCatalog(projectId, cat, { onlyRunId: doc.run_id });
  return cat;
}

async function renameCatalogRun(projectId, runId, name, simulationId) {
  const cat = loadCatalog(projectId, { simulation_id: simulationId });
  const rec = cat.runs.find((r) => String(r.id) === String(runId));
  if (!rec) return { ok: false, error: 'Run not found' };
  const next = String(name || '').trim();
  if (!next) return { ok: false, error: 'Name is required' };
  rec.name = next.slice(0, 64);
  await saveCatalog(projectId, cat, { onlyRunId: runId });
  const side = readJsonSafe(runSidecarPath(projectId, runId));
  if (side) {
    side.name = rec.name;
    // Wait for it: a Delete right after a rename otherwise races this write
    // into the folder being removed (EPERM, or the folder comes back).
    await writeRunSidecar(projectId, runId, side);
  }
  return {
    ok: true,
    ...runListPayload(projectId, cat, { simulation_id: simulationId || rec.simulation_id }),
    name: rec.name,
    run_id: runId,
  };
}

/** @param {{projectId?: string, name?: string, simulationId?: string, runId?: string, meshId?: string}} [opts] */
export async function createDraftRun({ projectId, name, simulationId, runId: requestedId, meshId } = {}) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no active project' };
  const sim = activeStudy(id, simulationId);
  if (!sim || !sim.id) return { ok: false, error: 'Create a simulation first' };
  const cat = loadCatalog(id, { simulation_id: sim.id });
  const runId = String(requestedId || '').trim() || stampId();
  const meshes = listGeneratedMeshes(id, sim.id);
  const wantMesh = meshId != null && meshId !== '' ? String(meshId) : '';
  const defaultMesh =
    (wantMesh && meshes.find((m) => String(m.id) === wantMesh)) ||
    meshes.find((m) => m.ready && m.active) ||
    meshes.find((m) => m.ready) ||
    meshes.find((m) => m.active) ||
    meshes[0] ||
    (wantMesh ? { id: wantMesh, name: 'Mesh' } : null);
  const ctrl = getSimulationControl(id, sim.id);
  const transient = projectIsTransient(id, sim.id);
  // The study's steady analysis's own run defaults (analysis contract run_defaults).
  const runDefaults = steadyRunDefaults(sim);
  const rec = {
    id: runId,
    name: String(name || '').trim().slice(0, 64) || nextRunName(cat.runs),
    status: 'draft',
    mesh_id: defaultMesh && defaultMesh.id,
    mesh_name: defaultMesh && defaultMesh.name,
    endTime: positiveInt(runDefaults.end_time),
    writeInterval: positiveInt(runDefaults.write_interval),
    // A draft follows the simulation's time dependency; the choice is frozen
    // onto the run when it starts.
    time_dependency: transient ? 'Transient' : 'Steady-state',
    transient: { ...ctrl.transient },
    result_controls: [],
    case_dir: null,
    simulation_id: sim.id,
    created_at: new Date().toISOString(),
  };
  persistRun(id, sim.id, rec);
  cat.runs.push(rec);
  cat.active_id = runId;
  await saveCatalog(id, cat, { onlyRunId: runId });
  await writeRunSidecar(id, runId, {
    ...rec,
    run_id: runId,
    project_id: id,
    increment: INCREMENT,
  });
  return { ok: true, run: rec, ...runListPayload(id, cat, { simulation_id: sim.id }), meshes };
}

function catalogForRun(projectId, runId, hintSimId) {
  const folder = runFolderOf(projectId, runId, hintSimId) || runFolderOf(projectId, runId);
  const sid = (folder && folder.simulation_id) || hintSimId || null;
  return { cat: loadCatalog(projectId, { simulation_id: sid }), sid, folder };
}

/** Settings updates in flight per run: each read-modify-write of a run waits for
 * the one before, so two quick edits (or two tabs) never undo each other. */
const runSettingsUpdates = new Map();

export function updateRunSettings(projectId, partial) {
  const id = projectId || projectIdOrActive('', readActiveId);
  const runId = partial && (partial.run_id || partial.id);
  if (!id || !runId) return Promise.resolve({ ok: false, error: 'run_id required' });
  const key = `${id}\u0000${runId}`;
  const apply = () => applyRunSettings(id, runId, partial);
  const next = (runSettingsUpdates.get(key) || Promise.resolve()).then(apply, apply);
  runSettingsUpdates.set(key, next);
  const settle = () => {
    if (runSettingsUpdates.get(key) === next) runSettingsUpdates.delete(key);
  };
  next.then(settle, settle);
  return next;
}

async function applyRunSettings(id, runId, partial) {
  const found = catalogForRun(id, runId, partial && partial.simulation_id);
  const cat = found.cat;
  const rec = cat.runs.find((r) => String(r.id) === String(runId));
  if (!rec) return { ok: false, error: 'Run not found' };
  if (partial.name != null) {
    const next = String(partial.name || '').trim();
    if (next) rec.name = next.slice(0, 64);
  }
  // Steady settings, stored as the run's analysis cleans them (its limits and defaults).
  if (partial.endTime != null || partial.writeInterval != null) {
    // As typed: rounding, limits and what a non-number means are the analysis's call.
    /** @type {Record<string, unknown>} */
    const edits = {};
    if (partial.endTime != null) edits.end_time = partial.endTime;
    if (partial.writeInterval != null) edits.write_interval = partial.writeInterval;
    let clean;
    try {
      clean = await normalizeSteadySettings(id, {
        simulationId: rec.simulation_id || found.sid,
        runId,
        settings: edits,
        base: steadyBlock(rec),
      });
    } catch (e) {
      return { ok: false, error: 'Run settings not saved: ' + String((e && e.message) || e) };
    }
    rec.endTime = positiveInt(clean.end_time) ?? rec.endTime ?? null;
    rec.writeInterval = positiveInt(clean.write_interval) ?? rec.writeInterval ?? null;
  }
  // W30 transient settings. Drafts may also switch time dependency (the
  // Incompressible panel changed it); started runs keep what they solved with.
  if (partial.transient && typeof partial.transient === 'object') {
    try {
      rec.transient = await normalizeTransientSettings(id, {
        simulationId: rec.simulation_id || found.sid,
        runId,
        settings: partial.transient,
        base: rec.transient,
      });
    } catch (e) {
      return { ok: false, error: 'Run settings not saved: ' + String((e && e.message) || e) };
    }
    // Remember the latest transient settings as the study default for new runs.
    await saveSimulationControl(id, { transient: rec.transient }, rec.simulation_id || found.sid);
  }
  if (partial.time_dependency != null && (!rec.status || rec.status === 'draft')) {
    rec.time_dependency = /transient/i.test(String(partial.time_dependency)) ? 'Transient' : 'Steady-state';
  }
  if (partial.mesh_id != null) {
    const meshes = listGeneratedMeshes(id, (partial && partial.simulation_id) || rec.simulation_id);
    const picked = meshes.find((m) => String(m.id) === String(partial.mesh_id));
    rec.mesh_id = picked ? picked.id : partial.mesh_id || null;
    rec.mesh_name = picked ? picked.name : rec.mesh_name;
  }
  if (Array.isArray(partial.result_controls)) rec.result_controls = partial.result_controls;
  // Post-processing state: `views` are named filter sets the user saved for
  // this run; `current_view` is the auto-saved live filter set so Results
  // reopen exactly as they were left.
  if (Array.isArray(partial.views)) rec.views = partial.views.slice(0, 50);
  if (partial.current_view !== undefined) rec.current_view = partial.current_view || null;
  await saveCatalog(id, cat, { onlyRunId: runId });
  const side = readJsonSafe(runSidecarPath(id, runId)) || { run_id: runId, project_id: id };
  await writeRunSidecar(id, runId, { ...side, ...rec, run_id: runId, project_id: id, increment: INCREMENT });
  return {
    ok: true,
    run: rec,
    ...runListPayload(id, cat, { simulation_id: rec.simulation_id || found.sid || (partial && partial.simulation_id) }),
    meshes: listGeneratedMeshes(id, rec.simulation_id || found.sid || (partial && partial.simulation_id)),
  };
}

export async function deleteCatalogRun(projectId, runId, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id || !runId) return { ok: false, error: 'run_id required' };
  if (liveRun && String(liveRun.run_id) === String(runId)) {
    return { ok: false, error: 'Stop the run before deleting it' };
  }
  const folder = runFolderOf(id, runId, simulationId) || runFolderOf(id, runId);
  if (!folder) {
    try {
      removeComputeJob('solve', runId, id);
    } catch {}
    return { ok: false, error: 'Run not found' };
  }
  const sid = simulationId || folder.simulation_id || null;
  const inFlight = pendingRunWrites.get(String(runId));
  if (inFlight) await inFlight;
  // A settings save still queued for this run would write into the folder being removed.
  const queued = runSettingsUpdates.get(`${id} ${runId}`);
  if (queued) {
    try {
      await queued;
    } catch (_) {}
  }
  try {
    // Windows can hold a just-written file for a moment (indexer, antivirus): retry
    // (linear back-off, about 5 s in all).
    rmSync(folder.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    return { ok: false, error: 'Could not delete run folder: ' + String((e && e.message) || e) };
  }
  try {
    if (existsSync(runSidecarPath(id, runId))) rmSync(runSidecarPath(id, runId), { force: true });
  } catch {}
  // Off the compute queue now, not when it reaches the head and fails to start.
  try {
    removeComputeJob('solve', runId, id);
  } catch {}
  const cat = loadCatalog(id, { simulation_id: sid });
  return {
    ok: true,
    deleted: true,
    run_id: runId,
    ...runListPayload(id, cat, { simulation_id: sid }),
  };
}

function loadRunDoc(projectId, runId) {
  if (!runId) return null;
  const cat = loadCatalog(projectId);
  const rec = (cat.runs || []).find((r) => String(r.id) === String(runId));
  if (!rec) return null;
  const side = readJsonSafe(runSidecarPath(projectId, runId));
  const merged = { ...rec, ...(side || {}), run_id: runId, project_id: projectId };
  if (rec.name) merged.name = rec.name;
  if (rec.mesh_id) merged.mesh_id = rec.mesh_id;
  if (rec.mesh_name) merged.mesh_name = rec.mesh_name;
  if (Array.isArray(rec.result_controls)) merged.result_controls = rec.result_controls;
  if (Array.isArray(rec.views)) merged.views = rec.views;
  if (rec.current_view !== undefined) merged.current_view = rec.current_view;
  if (rec.endTime != null) merged.endTime = rec.endTime;
  if (rec.writeInterval != null) merged.writeInterval = rec.writeInterval;
  if (rec.time_dependency) merged.time_dependency = rec.time_dependency;
  if (rec.transient) merged.transient = rec.transient;
  if (rec.status) merged.status = rec.status;
  return merged;
}

/** run.json writes still in flight on the worker, per run: delete waits for them. */
const pendingRunWrites = new Map();

function writeRunSidecar(projectId, runId, body) {
  const payload = { ...(body || {}), id: runId, run_id: runId, project_id: projectId };
  try {
    const write = commitRpc('runs.upsert', {
      project_dir: projectDir(projectId),
      run_id: String(runId),
      sim_id: String((body && body.simulation_id) || ''),
      body: payload,
    });
    if (write && typeof write.then === 'function') {
      write.catch((e) => console.warn('[CFD] write run sidecar', e));
      const key = String(runId);
      const settled = write.then(() => {}, () => {});
      pendingRunWrites.set(key, settled);
      settled.then(() => {
        if (pendingRunWrites.get(key) === settled) pendingRunWrites.delete(key);
      });
    }
    return write;
  } catch (e) {
    console.warn('[CFD] write run sidecar', e);
  }
}

function persistRunDoc(projectId, doc) {
  try {
    const cat = upsertCatalogRun(projectId, doc);
    const named = (cat.runs.find((r) => String(r.id) === String(doc.run_id)) || {}).name;
    const withName = named ? { ...doc, name: named } : doc;
    if (doc.run_id) {
      // Catalog already saved by upsertCatalogRun; stamp run_1 via run-upsert --stamp-project.
      commitRpcSync('runs.upsert', {
        project_dir: projectDir(projectId),
        run_id: String(doc.run_id),
        sim_id: String(withName.simulation_id || ''),
        stamp_project: true,
        body: { ...withName, id: doc.run_id, run_id: doc.run_id, project_id: projectId, increment: INCREMENT },
      });
    }
  } catch (e) {
    console.warn('[CFD] persist run doc', e);
  }
}

/**
 * @param {{
 *   projectId?: string,
 *   simulationId?: string,
 *   endTime?: number,
 *   writeInterval?: number,
 *   runId?: string,
 *   transient?: object,
 *   onDone?: (result: { status: string, exit_code?: number, run_id?: string, project_id?: string, error?: string|null }) => void,
 * }} [opts]
 */

export async function startSolve(opts = {}) {
  const { projectId, endTime, writeInterval, runId, transient: transientIn, onDone, simulationId } = opts;
  if (liveRun && liveRun.child && liveRun.child.exitCode == null && !liveRun.child.killed) {
    if (!runId || String(liveRun.run_id) !== String(runId)) {
      return {
        ok: false,
        status: 409,
        bodyExtra: {
          error: 'A run is already in progress',
          pid: liveRun.child.pid || null,
          run_id: liveRun.run_id,
          increment: INCREMENT,
        },
      };
    }
  }
  const otherLive = discoverLiveSolves().find((row) => row && String(row.run_id) !== String(runId || ''));
  if (otherLive) {
    return {
      ok: false,
      status: 409,
      bodyExtra: {
        error: 'A run is already in progress',
        run_id: otherLive.run_id,
        increment: INCREMENT,
      },
    };
  }

  if (!runId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'Create a run first, then start it', increment: INCREMENT, fix: { go: 'sim-hub' } },
    };
  }

  const id = projectId || projectIdOrActive('', readActiveId);
  const found = runFolderOf(id, runId, simulationId) || runFolderOf(id, runId);
  const cat = loadCatalog(id, { simulation_id: simulationId || (found && found.simulation_id) });
  let draft = cat.runs.find((r) => String(r.id) === String(runId)) || found || null;
  if (!draft) {
    return { ok: false, status: 404, bodyExtra: { error: 'Run not found', increment: INCREMENT } };
  }
  if (draft && draft.status === 'done') {
    return {
      ok: false,
      status: 409,
      bodyExtra: {
        error: 'This run already finished. Create a new run to solve again.',
        increment: INCREMENT,
        fix: { go: 'sim-hub' },
      },
    };
  }
  if (draft && (draft.status === 'running' || draft.status === 'starting')) {
    const wslState = draft.wsl_case ? probeWslSolveSync(draft.wsl_case, draft) : 'dead';
    const block = solveStartBlockReason(draft, {
      windowsLive: runProcessIsLive(draft),
      wslLive: wslState === 'live' || wslState === 'unknown',
    });
    if (block === 'already_running') {
      return {
        ok: false,
        status: 409,
        bodyExtra: {
          error: 'This run is already solving. Click Stop if you want to end it.',
          increment: INCREMENT,
        },
      };
    }
    if (block === 'draining') {
      forceKillDoc(draft, liveRun && String(liveRun.run_id) === String(draft.id || draft.run_id) ? liveRun : null);
    } else {
      draft = reapStaleRunningDoc(id, draft);
    }
  }

  const ready = validateSolveReady(id, {
    meshId: draft && draft.mesh_id,
    aa: draft ? { result_controls: draft.result_controls || [] } : null,
    simulationId: draft && draft.simulation_id,
  });
  if (!ready.ok) {
    return { ok: false, status: 400, bodyExtra: { ...ready, increment: INCREMENT } };
  }
  // The rest of what blocks this run is its analysis's call (analysis contract:
  // materials, boundary conditions, its own settings), asked before the run is
  // marked running so a refused Start leaves it as it was.
  const readyTd = draft && draft.time_dependency ? draft.time_dependency : ready.sim && ready.sim.time_dependency;
  let verdict = null;
  try {
    verdict = await commitRpc('analysis.validate_ready', {
      project_id: id,
      simulation_id: (draft && draft.simulation_id) || (ready.sim && ready.sim.id) || '',
      run_id: String(runId),
      mesh_id: (draft && draft.mesh_id) || (ready.mesh && ready.mesh.mesh_id) || '',
      time_dependency: runIsTransient({ time_dependency: readyTd }) ? 'Transient' : 'Steady-state',
    });
  } catch (e) {
    return {
      ok: false,
      status: 500,
      bodyExtra: { error: 'Could not check whether this run can start: ' + String((e && e.message) || e), increment: INCREMENT },
    };
  }
  const issue = verdict && verdict.ready === false && Array.isArray(verdict.issues) ? verdict.issues[0] : null;
  if (issue) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        ok: false,
        error: String(issue.message || 'This run is not ready to start'),
        project_id: id,
        ...(issue.fix ? { fix: issue.fix } : {}),
        ...(Array.isArray(issue.patches) ? { patches: issue.patches } : {}),
        increment: INCREMENT,
      },
    };
  }
  // The one time-dependency decision for this run, by the rule the Run panel
  // shows: the run's own stamp (a started run keeps the mode it solved with;
  // drafts follow their study), else its study. prepare_run is told this
  // explicitly and reports the solver its case was written for; Node launches
  // exactly that, never a second guess of its own.
  const isTransient = draft && draft.time_dependency ? runIsTransient(draft) : simIsTransient(ready.sim);
  // A transient run solves with its settings as its analysis cleans them.
  let transientSettings = null;
  if (isTransient) {
    try {
      transientSettings = await normalizeTransientSettings(id, {
        simulationId: (draft && draft.simulation_id) || (ready.sim && ready.sim.id),
        runId,
        settings: transientIn,
        base: {
          ...getSimulationControl(id, draft && draft.simulation_id).transient,
          ...((draft && draft.transient) || {}),
        },
      });
    } catch (e) {
      return {
        ok: false,
        status: 500,
        bodyExtra: { error: 'Could not read this run\'s settings: ' + String((e && e.message) || e), increment: INCREMENT },
      };
    }
  }
  // A second Start of this run arrived while the check ran: the first one has it.
  if (liveRun && String(liveRun.run_id) === String(runId) && liveRun.child && liveRun.child.exitCode == null && !liveRun.child.killed) {
    return {
      ok: false,
      status: 409,
      bodyExtra: { error: 'This run is already solving. Click Stop if you want to end it.', increment: INCREMENT },
    };
  }
  // Iterations and write interval: what Start sends over the run's own, as its
  // analysis cleans them for a steady run (a transient run keeps them as stored).
  const ctrl = getSimulationControl(id, (draft && draft.simulation_id) || (ready.sim && ready.sim.id));
  const rawEnd = endTime != null ? endTime : draft && draft.endTime;
  const rawEvery = writeInterval != null ? writeInterval : draft && draft.writeInterval;
  let et = positiveInt(rawEnd) ?? ctrl.endTime;
  let wi = positiveInt(rawEvery) ?? ctrl.writeInterval;
  if (!isTransient) {
    try {
      const clean = await normalizeSteadySettings(id, {
        simulationId: (draft && draft.simulation_id) || (ready.sim && ready.sim.id),
        runId,
        settings: { ...(rawEnd != null ? { end_time: rawEnd } : {}), ...(rawEvery != null ? { write_interval: rawEvery } : {}) },
        base: steadyBlock({ endTime: ctrl.endTime, writeInterval: ctrl.writeInterval }),
      });
      et = positiveInt(clean.end_time) ?? et;
      wi = positiveInt(clean.write_interval) ?? wi;
    } catch (e) {
      return {
        ok: false,
        status: 500,
        bodyExtra: { error: 'Could not read this run\'s settings: ' + String((e && e.message) || e), increment: INCREMENT },
      };
    }
  }
  let transient = null;
  if (isTransient) {
    saveSimulationControl(id, { endTime: et, writeInterval: wi, transient: transientSettings }, draft && draft.simulation_id);
  } else {
    saveSimulationControl(id, { endTime: et, writeInterval: wi }, draft && draft.simulation_id);
  }
  const timeDependency = isTransient ? 'Transient' : 'Steady-state';
  const nProcs = resolveNProcs(ready.mesh.n_cells, { transient: isTransient });
  const simId = (draft && draft.simulation_id) || (ready.sim && ready.sim.id);
  const stored = persistRun(id, simId, {
    id: runId,
    run_id: runId,
    name: (draft && draft.name) || 'Run 1',
    simulation_id: simId,
    mesh_id: (draft && draft.mesh_id) || (ready.mesh && ready.mesh.mesh_id) || null,
    status: 'running',
  });
  const winOut = stored.case_dir;
  mkdirSync(winOut, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  // Phase 1: Python prepare_run writes the case; job-runner spawns run_solve.
  const prepArgs = [
    pyTool('prepare_run.py'),
    '--project-dir',
    projectDir(id),
    '--run-id',
    String(runId),
    '--out-dir',
    winOut,
    '--n-procs',
    String(nProcs),
  ];
  if (draft && draft.mesh_id) prepArgs.push('--mesh-id', String(draft.mesh_id));
  if (draft && draft.simulation_id) prepArgs.push('--simulation-id', String(draft.simulation_id));
  prepArgs.push('--time-dependency', timeDependency);
  if (isTransient && transientSettings) {
    // The settings this run solves with; Python resolves the time step from them
    // with the mesh and reference speed, and reports the numbers it wrote.
    const settingsPath = join(REPORT_DIR, `transient-${runId}.json`);
    writeFileSync(settingsPath, JSON.stringify(transientSettings), 'utf8');
    prepArgs.push('--transient-json', settingsPath);
  }
  let prepResult = null;
  const prepT0 = Date.now();
  try {
    const prep = spawnSync(PYTHON, prepArgs, {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    prepResult = parsePrepareRunStdout(prep.stdout);
    if (prep.status !== 0 || !prepResult || !prepResult.ok) {
      const errMsg =
        (prepResult && (prepResult.error || prepResult.message)) ||
        String(prep.stderr || prep.stdout || '').slice(0, 800) ||
        `prepare_run exited ${prep.status}`;
      const error = 'Failed to prepare solve case: ' + errMsg;
      // A run its analysis found not ready (it changed after the check) keeps the analysis's fix.
      const fix = (prepResult && prepResult.fix) || null;
      try {
        persistRun(id, simId, {
          ...stored,
          status: 'failed',
          error,
          note: error,
          fix,
          finished_at: new Date().toISOString(),
          pid: null,
        });
      } catch (_) {}
      return {
        ok: false,
        status: 500,
        bodyExtra: { error, increment: INCREMENT, run_id: runId, simulation_id: simId, ...(fix ? { fix } : {}) },
      };
    }
  } catch (err) {
    const error = 'Failed to prepare solve case: ' + String(err);
    try {
      persistRun(id, simId, {
        ...stored,
        status: 'failed',
        error,
        note: error,
        finished_at: new Date().toISOString(),
        pid: null,
      });
    } catch (_) {}
    return {
      ok: false,
      status: 500,
      bodyExtra: { error, increment: INCREMENT, run_id: runId, simulation_id: simId },
    };
  }

  // The solver this run launches is the one prepare_run wrote the case for
  // (the registered analysis's app). prepare_run was told the time dependency,
  // so a case written for the other one is a bug: fail rather than solve it.
  const solver = String((prepResult && prepResult.app) || '');
  const preparedTd = String((prepResult && prepResult.time_dependency) || '');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(solver) || preparedTd !== timeDependency) {
    const error = !solver
      ? 'Preparing the case did not name the solver to run.'
      : preparedTd !== timeDependency
        ? `The case was written for a ${preparedTd || 'different'} run (${solver}), but this run is ${timeDependency}.`
        : `The case names an invalid solver (${solver}).`;
    try {
      persistRun(id, simId, {
        ...stored,
        status: 'failed',
        error,
        note: error,
        finished_at: new Date().toISOString(),
        pid: null,
      });
    } catch (_) {}
    return { ok: false, status: 500, bodyExtra: { error, increment: INCREMENT, run_id: runId, simulation_id: simId } };
  }
  // The numbers written to controlDict (Δt, max Δt, write interval), recorded on
  // the run so the Run panel shows what the solver really uses.
  if (isTransient) transient = (prepResult && prepResult.transient_control) || null;
  // How the analysis runs this case (launch spec): frames kept, the solver's
  // process names (for Stop and the live probe) and its log parser.
  const launch = (prepResult && prepResult.launch) || {
    app: solver,
    keep_frames: isTransient ? 'all' : 'latest',
    process_names: [solver],
    log_parser: null,
  };

  // Phase 1 land5: Python run_solve/stop_solve expect a single-segment id
  // (validate_wsl_case_id); wslCasePath() is only for legacy WSL sed fallbacks.
  const wslCaseId = `cfddesk-w27-${runId}`;
  const wslRunCasePath = wslCasePath(wslCaseId);
  const winLog = join(REPORT_DIR, `run-${runId}.log`);
  const started_at = new Date().toISOString();
  let logBuf = '';
  const progress = newProgressState();
  progress.residual_series = residualSeriesFor((prepResult && prepResult.analysis_key) || '');
  // Seconds per phase of this solve, so where the time goes is on record.
  progress.phases = { prepare: Math.round(Date.now() - prepT0) / 1000 };
  const runSolveArgs = [
    '--case-dir',
    winOut,
    '--wsl-case',
    wslCaseId,
    '--n-procs',
    String(nProcs),
    '--app',
    solver,
    '--keep-frames',
    String(launch.keep_frames || 'latest'),
    '--process-names',
    (Array.isArray(launch.process_names) && launch.process_names.length ? launch.process_names : [solver]).join(','),
    '--frame-fields',
    (Array.isArray(launch.frame_fields) && launch.frame_fields.length ? launch.frame_fields : ['U', 'p']).join(','),
    ...(launch.log_parser ? ['--log-parser', JSON.stringify(launch.log_parser)] : []),
    '--run-id',
    String(runId),
  ];
  const argv = [PYTHON, pyTool('run_solve.py'), ...runSolveArgs];

  let runFinished = false;
  const finishRun = (code, signal, errMsg) => {
    if (runFinished) return;
    runFinished = true;
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const snap = liveRun && liveRun.progress ? snapshotProgress(liveRun.progress) : parseSolveProgress(logBuf, (prepResult && prepResult.analysis_key) || '');
    const stopRequested = !!(liveRun && liveRun.stop_requested);
    if (liveRun && liveRun.stop_timer) clearTimeout(liveRun.stop_timer);
    const base = (liveRun && liveRun.baseRunning) || {};
    liveRun = null;
    const savedTimes = listSavedTimes(winOut);
    const lastSaved = savedTimes.length ? savedTimes[savedTimes.length - 1] : 0;
    const stopped = stopRequested || (exit_code !== 0 && signal === 'SIGTERM');
    const status = errMsg ? 'failed' : stopped ? 'stopped' : exit_code === 0 ? 'done' : 'failed';
    const unit = isTransient ? 't = ' + lastSaved + ' s' : 'iteration ' + lastSaved;
    persistRunDoc(id, {
      ...base,
      status,
      exit_code,
      signal: signal || null,
      stop_requested: stopRequested,
      finished_at: new Date().toISOString(),
      log_excerpt: logBuf.slice(-6000),
      stage: snap.stage,
      iteration: snap.iteration,
      sim_time: snap.sim_time,
      n_steps: snap.n_steps,
      residuals: snap.residuals || [],
      ...(snap.co_max != null ? { co_max: snap.co_max } : {}),
      ...(snap.co_mean != null ? { co_mean: snap.co_mean } : {}),
      ...(snap.delta_t != null ? { delta_t: snap.delta_t } : {}),
      ...(snap.phases ? { phases: snap.phases } : {}),
      last_saved_iteration: lastSaved,
      n_saved_times: savedTimes.length,
      has_results: lastSaved > 0,
      ...(errMsg ? { error: errMsg } : {}),
      note: errMsg
        ? `Failed to start ${solver}: ` + errMsg
        : status === 'done'
          ? `${solver} finished. Results are in the run folder.`
          : status === 'stopped'
            ? lastSaved > 0
              ? `Run stopped. Results up to ${unit} are available.`
              : 'Run stopped before the first saved ' + (isTransient ? 'time step.' : 'iteration.')
            : `${solver} failed (exit ${exit_code}${signal ? ' ' + signal : ''}).`,
    });
    if (typeof onDone === 'function') {
      onDone({ status, exit_code, run_id: runId, project_id: id, error: errMsg || null });
    }
    scheduleComputeQueueKick(250);
  };

  const { child, jobLog } = spawnJob({
    kind: 'solve',
    jobId: String(runId),
    script: pyTool('run_solve.py'),
    args: runSolveArgs,
    onEvent: (ev) => {
      if (liveRun && liveRun.progress) applyJobEvent(liveRun.progress, ev);
      if (ev && ev.event === 'time_saved' && liveRun) {
        const times = (liveRun.progress && liveRun.progress.saved_times) || [];
        if (liveRun.baseRunning) {
          liveRun.baseRunning.has_results = times.length > 0;
          liveRun.baseRunning.n_saved_times = times.length;
          liveRun.baseRunning.last_saved_iteration = times.length ? times[times.length - 1] : 0;
          liveRun.baseRunning.stage = 'solve';
        }
        try {
          const snap = liveRun.progress ? snapshotProgress(liveRun.progress) : null;
          persistRun(id, simId, {
            id: runId,
            run_id: runId,
            simulation_id: simId,
            has_results: times.length > 0,
            n_saved_times: times.length,
            last_saved_iteration: times.length ? times[times.length - 1] : 0,
            stage: 'solve',
            sim_time: (snap && snap.sim_time) || (times.length ? times[times.length - 1] : 0),
          });
        } catch (e) {
          console.warn('[CFD] stamp live results', e);
        }
      }
      try {
        const line =
          ev && ev.event === 'log' && ev.line
            ? String(ev.line) + '\n'
            : JSON.stringify(ev) + '\n';
        logBuf = (logBuf + line).slice(-1024 * 1024);
        // Phase 1 land10: structured log via job-runner createJobLogger (.cache/logs), not projects/.
      } catch {}
    },
    onExit: (code, signal) => finishRun(code, signal, null),
  });
  progress._jobLog = jobLog;
  liveRun = {
    child,
    run_id: runId,
    wsl_case: wslCaseId,
    wsl_case_path: wslRunCasePath,
    project_id: id,
    progress,
    jobLog,
    protocol: 'magnusim-jsonl',
  };
  const baseRunning = {
    simulation_id: simId,
    status: 'running',
    mode: 'solve',
    path_kind: solver,
    analysis_key: (prepResult && prepResult.analysis_key) || null,
    launch,
    time_dependency: timeDependency,
    ...(isTransient ? { transient } : {}),
    run_id: runId,
    name: (draft && draft.name) || null,
    mesh_id: (draft && draft.mesh_id) || ready.mesh.mesh_id || null,
    mesh_name: (draft && draft.mesh_name) || ready.mesh.mesh_name || null,
    result_controls: (draft && Array.isArray(draft.result_controls) ? draft.result_controls : []) || [],
    created_at: (draft && draft.created_at) || null,
    pid: child.pid || null,
    exit_code: null,
    // Fresh start: nothing saved yet (a restarted stopped run had frames).
    has_results: false,
    last_saved_iteration: 0,
    n_saved_times: 0,
    stop_requested: false,
    stage: 'starting',
    finished_at: null,
    command: argv.join(' '),
    argv,
    started_at,
    log_path: winLog,
    log_jsonl_path: jobLog.path,
    log_excerpt: '',
    wsl_case: wslCaseId,
    wsl_case_path: wslRunCasePath,
    case_dir: winOut,
    n_procs: nProcs,
    endTime: et,
    writeInterval: wi,
    prepare_run: prepResult,
    solve_protocol: 'magnusim-jsonl',
    mesh_source: {
      case_dir: ready.mesh.case_dir,
      mesh_path: ready.mesh.mesh_path,
      n_cells: ready.mesh.n_cells,
      n_points: ready.mesh.n_points,
    },
    // The boundary-to-patch mapping the case was written with (prepare_run).
    bcs: Array.isArray(prepResult && prepResult.bcs) ? prepResult.bcs : [],
    wall_default: (prepResult && prepResult.wall_default) || 'No-slip',
    project_id: id,
    // The app, the analysis family, and the physics and algorithm the case was
    // written with (a k-epsilon run used to read "k-ω SST").
    note: runNote({
      app: solver,
      nProcs,
      analysisKey: (prepResult && prepResult.analysis_key) || '',
      sim: ready.sim,
      prep: prepResult,
    }),
    increment: INCREMENT,
  };
  liveRun.baseRunning = baseRunning;
  persistRunDoc(id, baseRunning);
  const cat0 = loadCatalog(id);
  const named0 = (cat0.runs.find((r) => String(r.id) === String(runId)) || {}).name;
  if (named0) baseRunning.name = named0;

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning, runs: cat0.runs, active_run_id: runId },
  };
}

const STOP_GRACE_MS = 20000;
const wslLiveCache = new Map();
const wslProbeInflight = new Set();

function runIdOf(doc) {
  return doc && (doc.run_id || doc.id);
}

function wslCaseOf(doc, run) {
  return (doc && (doc.wsl_case || doc.wsl_case_id)) || (run && run.wsl_case) || '';
}

function writeNowSed(controlDictPath) {
  return `sed -i 's/^[[:space:]]*stopAt.*/stopAt          writeNow;/' ${JSON.stringify(controlDictPath)} 2>/dev/null || true`;
}

function cachedWslState(caseId) {
  const id = String(caseId || '').trim();
  if (!id) return null;
  const hit = wslLiveCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > 30000 && hit.state === 'live') return null;
  return hit.state;
}

/**
 * `--process-names a,b` for stop_solve.py: the solver processes the run's launch
 * spec names (runs from before H8 have none; stop_solve then uses the legacy set).
 */
function processNamesArgs(doc) {
  const names = doc && doc.launch && Array.isArray(doc.launch.process_names) ? doc.launch.process_names : [];
  const clean = names.map((n) => String(n || '')).filter((n) => /^[A-Za-z][A-Za-z0-9]*$/.test(n));
  return clean.length ? ['--process-names', clean.join(',')] : [];
}

function probeWslSolveSync(caseId, doc) {
  const id = String(caseId || '').trim();
  if (!id) return 'dead';
  try {
    const r = spawnSync(PYTHON, [pyTool('stop_solve.py'), '--wsl-case', id, '--probe', ...processNamesArgs(doc)], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
    });
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
    if (j && typeof j.live === 'boolean') {
      wslLiveCache.set(id, { state: j.live ? 'live' : 'dead', at: Date.now() });
      return j.live ? 'live' : 'dead';
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function scheduleWslProbe(caseId, doc) {
  const id = String(caseId || '').trim();
  if (!id || wslProbeInflight.has(id)) return;
  wslProbeInflight.add(id);
  try {
    const child = spawn(PYTHON, [pyTool('stop_solve.py'), '--wsl-case', id, '--probe', ...processNamesArgs(doc)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => {
      wslProbeInflight.delete(id);
      try {
        const j = JSON.parse(out.trim().split('\n').pop() || '{}');
        wslLiveCache.set(id, { state: j.live ? 'live' : 'dead', at: Date.now() });
      } catch {
        wslLiveCache.set(id, { state: 'unknown', at: Date.now() });
      }
    });
    child.on('error', () => {
      wslProbeInflight.delete(id);
    });
  } catch {
    wslProbeInflight.delete(id);
  }
}

function invalidateWslLive(caseId) {
  if (caseId) wslLiveCache.delete(String(caseId));
}

function requestWriteNow(caseId, runId) {
  if (!caseId) return;
  const caseQ = caseId.startsWith('/') ? caseId : wslCasePath(caseId);
  try {
    spawn(PYTHON, [pyTool('stop_solve.py'), '--wsl-case', caseId, '--run-id', String(runId || '')], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    try {
      spawn(
        'wsl',
        ['-d', WSL_DISTRO, '--', 'bash', '-lc', writeNowSed(caseQ + '/system/controlDict')],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {}
  }
}

function forceKillDoc(rec, run) {
  const caseId = wslCaseOf(rec, run);
  const rid = runIdOf(rec) || (run && run.run_id);
  invalidateWslLive(caseId);
  if (run && run.child) {
    try {
      run.child.kill();
    } catch {}
  } else if (liveRun && String(liveRun.run_id) === String(rid) && liveRun.child) {
    try {
      liveRun.child.kill();
    } catch {}
  }
  try {
    spawn(
      PYTHON,
      [pyTool('stop_solve.py'), '--wsl-case', caseId, '--run-id', String(rid || ''), '--force', ...processNamesArgs(rec || run)],
      { windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    try {
      const caseQ = caseId.startsWith('/') ? caseId : wslCasePath(caseId);
      spawn(
        'wsl',
        [
          '-d',
          WSL_DISTRO,
          '--',
          'bash',
          '-lc',
          `pkill -f ${JSON.stringify(caseQ)} 2>/dev/null || true; pkill -f ${JSON.stringify('cfddesk-w27-' + rid)} 2>/dev/null || true`,
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {}
  }
}

function persistStopping(projectId, rec, extra) {
  if (!projectId || !rec) return;
  persistRunDoc(projectId, {
    ...rec,
    status: rec.status === 'starting' ? 'starting' : 'running',
    stage: 'stopping',
    stop_requested: true,
    note: (extra && extra.note) || 'Stopping — writing the current iteration.',
    increment: INCREMENT,
  });
}

function resolveStopTarget(projectId, runId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (liveRun && liveRun.child && liveRun.child.exitCode == null) {
    if (id && liveRun.project_id && String(liveRun.project_id) !== String(id)) {
      return { error: 'The active solve belongs to another project' };
    }
    const rec = (id && liveRun.run_id && loadRunDoc(id, liveRun.run_id)) || {};
    return {
      run: liveRun,
      rec: {
        ...rec,
        wsl_case: rec.wsl_case || liveRun.wsl_case,
        run_id: liveRun.run_id,
        id: liveRun.run_id,
        project_id: liveRun.project_id || id,
        stop_requested: !!(rec.stop_requested || liveRun.stop_requested),
      },
    };
  }
  if (!id) return null;
  const rows = assembleAllRuns(id) || [];
  const running = rows.filter((r) => r && (r.status === 'running' || r.status === 'starting'));
  const pick = runId
    ? running.find((r) => String(r.id || r.run_id) === String(runId)) || running[0]
    : running[0];
  if (!pick) return null;
  const pidLive = pidIsAlive(pick.pid);
  const wslState = cachedWslState(pick.wsl_case);
  if (!pidLive && pick.wsl_case && wslState !== 'dead') scheduleWslProbe(pick.wsl_case, pick);
  if (!pidLive && wslState === 'dead') {
    return { reaped: [reapStaleRunningDoc(id, pick)] };
  }
  return { run: null, rec: pick };
}

/** @param {{ projectId?: string, force?: boolean, runId?: string }} [opts] */
export function stopSolve({ projectId, force, runId } = {}) {
  const id = projectId || projectIdOrActive('', readActiveId);
  const target = resolveStopTarget(id, runId);
  if (target && target.error) {
    return { ok: false, status: 409, bodyExtra: { error: target.error, increment: INCREMENT } };
  }
  if (target && target.reaped) {
    const rec = target.reaped[0] || {};
    scheduleComputeQueueKick(250);
    return {
      ok: true,
      status: 200,
      bodyExtra: {
        ok: true,
        stopped: true,
        stale: true,
        run_id: rec.run_id || rec.id,
        increment: INCREMENT,
      },
    };
  }
  if (!target || !target.rec) {
    return {
      ok: false,
      status: 409,
      bodyExtra: { error: 'No run is in progress', increment: INCREMENT },
    };
  }
  const { run, rec } = target;
  const already = !!(run && run.stop_requested) || !!rec.stop_requested;
  if (force || already) {
    if (run && run.stop_timer) {
      try {
        clearTimeout(run.stop_timer);
      } catch {}
    }
    forceKillDoc(rec, run);
    if (run) run.stop_requested = true;
    persistStopping(id || rec.project_id, rec, { note: 'Force-stopping.' });
    scheduleComputeQueueKick(250);
    return {
      ok: true,
      status: 200,
      bodyExtra: { ok: true, stopped: true, forced: true, run_id: rec.run_id || rec.id, increment: INCREMENT },
    };
  }
  if (run) {
    run.stop_requested = true;
    run.stop_requested_at = Date.now();
  }
  requestWriteNow(wslCaseOf(rec, run), rec.run_id || rec.id);
  persistStopping(id || rec.project_id, rec);
  const recSnap = { ...rec, stop_requested: true };
  const timer = setTimeout(() => {
    forceKillDoc(recSnap, run && liveRun === run ? run : null);
  }, STOP_GRACE_MS);
  if (run) run.stop_timer = timer;
  return {
    ok: true,
    status: 200,
    bodyExtra: { ok: true, stopping: true, run_id: rec.run_id || rec.id, increment: INCREMENT },
  };
}

function killSolveNow(run) {
  forceKillDoc(
    { wsl_case: run && run.wsl_case, run_id: run && run.run_id, id: run && run.run_id },
    run,
  );
}

// Saved iteration folders (numeric, > 0) in the Windows-side run case.
function listSavedTimes(caseDir) {
  try {
    return listFoamTimeDirs(caseDir, { complete: true })
      .map((name) => Number(name))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function runLivePid() {
  if (liveRun && liveRun.child && liveRun.child.exitCode == null) return liveRun.child.pid || null;
  return null;
}

function pidIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function runProcessIsLive(doc) {
  const rid = doc && (doc.run_id || doc.id);
  if (
    rid &&
    liveRun &&
    String(liveRun.run_id) === String(rid) &&
    liveRun.child &&
    liveRun.child.exitCode == null &&
    !liveRun.child.killed
  ) {
    return true;
  }
  return pidIsAlive(doc && doc.pid);
}

/** Vite/Node restart used to leave run.json at "running" forever. Persist stopped/failed. */
function reapStaleRunningDoc(projectId, doc) {
  if (!doc || !projectId) return doc;
  const st = String(doc.status || '');
  if (st !== 'running' && st !== 'starting') return doc;
  if (runProcessIsLive(doc)) return doc;
  // Windows pid can die after Vite/HMR while the WSL solver keeps going.
  // Do not mark stopped until a probe says the case is dead.
  if (doc.wsl_case) {
    const wslState = cachedWslState(doc.wsl_case);
    if (wslState !== 'dead') {
      scheduleWslProbe(doc.wsl_case, doc);
      return doc;
    }
  }
  const savedTimes = listSavedTimes(doc.case_dir);
  const lastSaved = savedTimes.length ? savedTimes[savedTimes.length - 1] : 0;
  const next = {
    ...doc,
    status: lastSaved > 0 ? 'stopped' : 'failed',
    exit_code: doc.exit_code != null ? doc.exit_code : -1,
    finished_at: doc.finished_at || new Date().toISOString(),
    last_saved_iteration: lastSaved,
    n_saved_times: savedTimes.length,
    has_results: lastSaved > 0 || !!doc.has_results,
    pid: null,
    error: lastSaved > 0 ? null : 'Solver process exited before the first saved iteration.',
    note:
      lastSaved > 0
        ? 'Solver process is gone. Results up to iteration ' + lastSaved + ' are available.'
        : 'Solver process is gone. It never wrote a result frame — Start again to retry.',
  };
  if (next.simulation_id) {
    try {
      persistRun(projectId, next.simulation_id, next);
    } catch (e) {
      console.warn('[CFD] reap stale run', e);
    }
  }
  return next;
}

function solvingScore(rec) {
  const n = Number(rec && rec.n_saved_times) || 0;
  const last = Number(rec && rec.last_saved_iteration) || 0;
  const t = Number(rec && rec.sim_time) || 0;
  return n * 1000 + Math.max(last > 0 ? last : 0, t > 0 ? t : 0);
}

let discoverLiveCache = { at: 0, found: [] };

export function isLiveSolveHeld() {
  if (liveRun && liveRun.child && liveRun.child.exitCode == null && !liveRun.child.killed) return true;
  return discoverLiveSolves().length > 0;
}

export function liveSolveJobSnapshot() {
  if (liveRun && liveRun.child && liveRun.child.exitCode == null && !liveRun.child.killed) {
    return {
      kind: 'solve',
      run_id: liveRun.run_id || null,
      project_id: liveRun.project_id || null,
      pid: liveRun.child.pid || null,
    };
  }
  const found = discoverLiveSolves();
  if (!found.length) return null;
  return {
    kind: 'solve',
    run_id: found[0].run_id || null,
    project_id: found[0].project_id || null,
    pid: null,
  };
}

function discoverLiveSolves() {
  if (Date.now() - discoverLiveCache.at < 4000) return discoverLiveCache.found;
  const found = [];
  try {
    if (!existsSync(PROJECTS_ROOT)) {
      discoverLiveCache = { at: Date.now(), found };
      return found;
    }
    for (const name of readdirSync(PROJECTS_ROOT)) {
      if (!existsSync(join(projectDir(name), 'project.json'))) continue;
      for (const rec of assembleAllRuns(name) || []) {
        if (!rec || (rec.status !== 'running' && rec.status !== 'starting')) continue;
        if (!runProcessIsLive(rec)) continue;
        found.push({ project_id: name, run_id: rec.id || rec.run_id, rec });
      }
    }
  } catch {
    discoverLiveCache = { at: Date.now(), found };
    return found;
  }
  discoverLiveCache = { at: Date.now(), found };
  return found;
}

function discoverLiveSolve() {
  const found = discoverLiveSolves();
  if (!found.length) return null;
  found.sort((a, b) => solvingScore(b.rec) - solvingScore(a.rec));
  return found[0];
}

/**
 * The latest point of a run solving in this server (its solver's events, kept
 * in memory): { t, solve_started_at }, or null. No disk or log read.
 */
function liveProgressPoint(state) {
  if (!state) return null;
  const cur = state.current && Number.isFinite(state.current.t) ? state.current : null;
  const last = cur || (Array.isArray(state.series) ? state.series[state.series.length - 1] : null);
  if (!last || !Number.isFinite(last.t)) return null;
  return { t: last.t, solve_started_at: state.solve_started_at || null };
}

/** A run's progress axis, its analysis's x_axis (contract): 'seconds' or 'iterations'. */
function runXAxis(doc) {
  const row = doc && doc.analysis_key ? analysisByKey(doc.analysis_key) : null;
  const axis = row && row.x_axis;
  if (axis === 'seconds' || axis === 'iterations') return axis;
  return runIsTransient(doc) ? 'seconds' : 'iterations';
}

export function projectSolveSummary(projectId) {
  const empty = { simulating: false, has_run: false, run_status: null, run_started_at: null };
  if (!projectId) return empty;
  const rows = assembleAllRuns(projectId) || [];
  const hasRun = rows.some((r) => r && (r.status || r.id || r.run_id));
  let rec = null;
  if (liveRun && String(liveRun.project_id) === String(projectId) && liveRun.run_id) {
    rec = loadRunDoc(projectId, liveRun.run_id) || liveRun.baseRunning || null;
  }
  const ranked = (rows || [])
    .filter((r) => r && (r.status === 'running' || r.status === 'starting'))
    .slice()
    .sort((a, b) => solvingScore(b) - solvingScore(a));
  if (ranked[0] && (!rec || solvingScore(ranked[0]) > solvingScore(rec))) rec = ranked[0];
  if (!rec) rec = ranked[0] || null;
  if (!rec) {
    return { ...empty, has_run: hasRun, run_status: (rows[0] && rows[0].status) || null };
  }
  const doc = reapStaleRunningDoc(projectId, rec);
  const running = !!(doc && (doc.status === 'running' || doc.status === 'starting'));
  if (!running) {
    return {
      simulating: false,
      has_run: hasRun,
      run_status: (doc && doc.status) || rec.status || null,
      run_started_at: (doc && doc.started_at) || rec.started_at || null,
    };
  }
  // Home cards must not readdir live time folders or parse the solve log.
  // That used to block /api/projects for tens of seconds on a writing case.
  // A run solving in this server has its progress in memory: its saved doc
  // has its time only at each saved frame and its iteration only at the end.
  const docRunId = String(doc.run_id || doc.id || rec.run_id || rec.id || '');
  const live =
    liveRun && String(liveRun.project_id) === String(projectId) && String(liveRun.run_id) === docRunId
      ? liveProgressPoint(liveRun.progress)
      : null;
  const liveT = live ? live.t : 0;
  return {
    simulating: true,
    has_run: true,
    run_status: doc.status || 'running',
    run_started_at: doc.started_at || rec.started_at || null,
    solve_started_at: doc.solve_started_at || rec.solve_started_at || (live && live.solve_started_at) || null,
    sim_time: Math.max(liveT, Number(doc.sim_time) || 0) || Number(doc.last_saved_iteration) || 0,
    sim_end: Number(doc.transient && doc.transient.end_time) || Number(rec.transient && rec.transient.end_time) || 0,
    time_dependency: doc.time_dependency || rec.time_dependency || null,
    x_axis: runXAxis({ ...rec, ...doc }),
    iteration: Math.max(Math.round(liveT), Number(doc.iteration) || 0),
    endTime: Number(doc.endTime) || Number(rec.endTime) || 0,
  };
}

export function getRunStatus(projectId, runId, simulationId, opts) {
  const id = projectId || projectIdOrActive('', readActiveId);
  const ctrl = getSimulationControl(id, simulationId);
  const meshes = id ? listGeneratedMeshes(id, simulationId) : [];
  if (!id) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        run: null,
        runs: [],
        meshes,
        simulation_control: ctrl,
        increment: INCREMENT,
      },
    };
  }
  const slim = !!(opts && opts.slim);
  const cat = loadCatalog(id, { ...opts, simulation_id: simulationId });
  if (Array.isArray(cat.runs) && !slim) {
    cat.runs = cat.runs.map((rec) => reapStaleRunningDoc(id, rec));
  }
  for (const rec of cat.runs || []) {
    overlayLiveRunFlags(rec);
    if (rec && rec.mesh_id && !rec.mesh_name) {
      const hit = meshes.find((m) => String(m.id) === String(rec.mesh_id));
      if (hit) rec.mesh_name = hit.name;
    }
  }
  const discovered = liveRun && liveRun.run_id ? null : slim ? null : discoverLiveSolve();
  const liveId = (liveRun && liveRun.run_id) || (discovered && discovered.run_id);
  const livePid = (liveRun && liveRun.project_id) || (discovered && discovered.project_id) || null;
  const scopedRuns = runsForActiveStudy(id, cat.runs, simulationId);
  const inScope = (rid) =>
    rid && scopedRuns.some((r) => r && String(r.id) === String(rid));
  const wantId =
    (runId && inScope(runId) && runId) ||
    (liveId && inScope(liveId) && liveId) ||
    (cat.active_id && inScope(cat.active_id) && cat.active_id) ||
    null;
  const doc = wantId ? overlayLiveRunFlags(reapStaleRunningDoc(id, loadRunDoc(id, wantId))) : null;
  const rec = (cat.runs || []).find((r) => doc && String(r.id) === String(doc.run_id));
  const projTransient = projectIsTransient(id, simulationId);
  const run = enrichRunDoc(doc ? { ...doc, name: (doc && doc.name) || (rec && rec.name) || null } : doc, opts);
  let liveDoc = null;
  if (liveId && doc && String(doc.run_id) === String(liveId)) {
    liveDoc = doc;
  } else if (liveId) {
    const raw =
      (livePid && loadRunDoc(livePid, liveId)) ||
      (liveRun && liveRun.baseRunning) ||
      (discovered && discovered.rec) ||
      null;
    liveDoc = raw ? reapStaleRunningDoc(livePid || id, raw) : null;
  }
  const liveRec = (cat.runs || []).find((r) => liveDoc && String(r.id) === String(liveDoc.run_id));
  const live_run = liveDoc
    ? decorateJobOwner(
        enrichRunDoc({
          ...liveDoc,
          name:
            (liveDoc && liveDoc.name) ||
            (liveRec && liveRec.name) ||
            (liveRun && liveRun.baseRunning && liveRun.baseRunning.name) ||
            null,
        }, opts),
        livePid || (liveDoc && liveDoc.project_id) || id
      )
    : null;
  // Hydrate/Home must not readdir live foam times. Poll only lists the
  // open/live run so Results can light up without copying every case.
  if (!slim) {
    for (const row of scopedRuns) {
      const rid = String((row && (row.id || row.run_id)) || '');
      const watch = (liveId && rid === String(liveId)) || (wantId && rid === String(wantId));
      if (watch) applySavedTimesFromDiskInPlace(row);
      if (
        watch &&
        row &&
        row.simulation_id &&
        (row.status === 'running' || row.status === 'starting') &&
        row.stage === 'solve'
      ) {
        const disk = loadRunDoc(id, row.id || row.run_id);
        const diskStage = disk && disk.stage != null ? String(disk.stage) : '';
        if (disk && (diskStage === 'starting' || diskStage === 'decompose' || !diskStage)) {
          try {
            persistRun(id, row.simulation_id, {
              id: row.id || row.run_id,
              run_id: row.id || row.run_id,
              simulation_id: row.simulation_id,
              stage: 'solve',
              has_results: row.has_results,
              n_saved_times: row.n_saved_times,
              last_saved_iteration: row.last_saved_iteration,
              ...(Number(row.sim_time) > 0 ? { sim_time: row.sim_time } : {}),
            });
          } catch (e) {
            console.warn('[CFD] stamp live stage from disk', e);
          }
        }
      }
    }
    if (rec && run) {
      applySavedTimesFromDiskInPlace(run);
      rec.has_results = !!(rec.has_results || run.has_results);
      if (run.last_saved_iteration != null) rec.last_saved_iteration = run.last_saved_iteration;
      if (run.n_saved_times != null) rec.n_saved_times = run.n_saved_times;
    }
  }
  const allRuns = assembleAllRuns(id).map((row) => (slim ? row : reapStaleRunningDoc(id, row)));
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: id,
      simulation_id: simulationId || null,
      run,
      runs: slim ? scopedRuns.map((row) => slimRunDoc(row)) : scopedRuns,
      runs_all: slim ? allRuns.map((row) => slimRunDoc(row)) : allRuns,
      meshes,
      active_run_id: wantId || null,
      live_run_id: liveId || null,
      live_run,
      simulation_control: ctrl,
      time_dependency: projTransient ? 'Transient' : 'Steady-state',
      transient_defaults: transientRunDefaults(activeStudy(id, simulationId)),
      steady_defaults: steadyRunDefaults(activeStudy(id, simulationId)),
      live_pid: runLivePid(),
      increment: INCREMENT,
    },
  };
}

/**
 * W30: the numbers a transient run would solve with right now — auto time
 * step, frame interval, step estimate, flow-through time. `settings` are the
 * form values (unsaved edits included); the run's stored block fills the rest.
 */
export async function previewTransient(projectId, runId, settings, simulationId) {
  const id = projectId || projectIdOrActive('', readActiveId);
  if (!id) return { ok: false, error: 'no active project' };
  const cat = loadCatalog(id);
  const scoped = runsForActiveStudy(id, cat.runs, simulationId);
  const rec = runId ? scoped.find((r) => String(r.id) === String(runId)) : null;
  const sid = (rec && rec.simulation_id) || simulationId || null;
  const ctrl = getSimulationControl(id, sid);
  // The form's values over the run's stored ones; the analysis's run model
  // cleans them as it previews (the same clean-up a save applies).
  const merged = {
    ...ctrl.transient,
    ...((rec && rec.transient) || {}),
    ...(settings && typeof settings === 'object' ? settings : {}),
  };
  // The analysis's run model computes it with the same code prepare_run writes
  // the case with (load_run_spec, the run's mesh and reference speed), so the
  // Δt shown is the Δt written.
  const pv = await commitRpc('analysis.run_preview', {
    project_id: id,
    run_id: runId || '',
    simulation_id: sid || '',
    mesh_id: (rec && rec.mesh_id) || '',
    time_dependency: 'Transient',
    settings: merged,
  });
  return pv && typeof pv === 'object' ? pv : { ok: false, error: 'transient preview failed' };
}

export async function handleW27Api(req, res, u, parts, { sendJson, readJsonBody }) {
  const a = parts[1];
  const b = parts[2];

  if (a === 'simulation-control' || a === 'simulation_control') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...getSimulationControl(u.searchParams.get('project_id')), increment: INCREMENT });
    }
    if (req.method === 'POST') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const pid = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      if (body.transient && typeof body.transient === 'object') {
        try {
          body.transient = await normalizeTransientSettings(pid, {
            simulationId: body.simulation_id,
            settings: body.transient,
            base: getSimulationControl(pid, body.simulation_id).transient,
          });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: 'Settings not saved: ' + String((e && e.message) || e) });
        }
      }
      const saved = await saveSimulationControl(pid, body);
      if (!saved.ok) return sendJson(res, 400, saved);
      return sendJson(res, 200, { ok: true, ...saved });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (a === 'run' || a === 'runs') {
    if (req.method === 'POST' && (b === 'start' || b === '1' || b === undefined)) {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const started = await startSolve({
        projectId: body.project_id,
        endTime: body.endTime || body.end_time,
        writeInterval: body.writeInterval || body.write_interval,
        runId: body.run_id || body.id,
        transient: body.transient,
        simulationId: body.simulation_id || u.searchParams.get('simulation_id'),
      });
      if (!started.ok) {
        return sendJson(res, started.status, { ok: false, ...(started.bodyExtra || {}) });
      }
      res.setHeader('X-CFD-Increment', INCREMENT);
      return sendJson(res, started.status, { ok: true, ...started.bodyExtra });
    }
    if (req.method === 'POST' && b === 'stop') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const stopped = stopSolve({
        projectId: body.project_id || u.searchParams.get('project_id'),
        runId: body.run_id || body.id || u.searchParams.get('run_id'),
        force: body.force === true || body.force === '1' || u.searchParams.get('force') === '1',
      });
      return sendJson(res, stopped.status, { ok: stopped.ok, ...(stopped.bodyExtra || {}) });
    }
    if (req.method === 'GET' && (b === 'status' || b === '1' || b === undefined)) {
      const st = getRunStatus(
        u.searchParams.get('project_id'),
        u.searchParams.get('run_id'),
        u.searchParams.get('simulation_id')
      );
      return sendJson(res, st.status, st.body);
    }
    if (req.method === 'GET' && b === 'ready') {
      // What blocks this run, as its analysis sees it (the page's Start gate).
      const pid = u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      try {
        const verdict = await commitRpc('analysis.validate_ready', {
          project_id: pid,
          simulation_id: u.searchParams.get('simulation_id') || '',
          run_id: u.searchParams.get('run_id') || '',
          mesh_id: u.searchParams.get('mesh_id') || '',
          time_dependency: u.searchParams.get('time_dependency') || '',
        });
        return sendJson(res, 200, { ok: true, ...(verdict || {}), increment: INCREMENT });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }
    if (req.method === 'GET' && b === 'monitors') {
      const mon = await getRunMonitors(
        u.searchParams.get('project_id'),
        u.searchParams.get('run_id'),
        u.searchParams.get('simulation_id')
      );
      return sendJson(res, mon.ok ? 200 : 404, { ...mon, increment: INCREMENT });
    }
    if (req.method === 'POST' && (b === 'transient-preview' || b === 'transient_preview')) {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const id = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const pv = await previewTransient(
        id,
        body.run_id || body.id,
        body.transient || body,
        body.simulation_id || u.searchParams.get('simulation_id')
      );
      return sendJson(res, pv.ok ? 200 : 400, { ...pv, increment: INCREMENT });
    }
    if (req.method === 'POST' && b === 'create') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const created = await createDraftRun({
        projectId: body.project_id || u.searchParams.get('project_id'),
        name: body.name,
        simulationId: body.simulation_id || u.searchParams.get('simulation_id'),
        runId: body.run_id || body.id,
        meshId: body.mesh_id || body.meshId,
      });
      if (!created.ok) return sendJson(res, 400, created);
      return sendJson(res, 200, { ok: true, ...created, increment: INCREMENT });
    }
    if (req.method === 'POST' && b === 'update') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const id = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const updated = await updateRunSettings(id, body);
      if (!updated.ok) return sendJson(res, 400, updated);
      return sendJson(res, 200, { ok: true, ...updated, increment: INCREMENT });
    }
    if (req.method === 'POST' && b === 'delete') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const id = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const deleted = await deleteCatalogRun(id, body.run_id || body.id, body.simulation_id);
      if (!deleted.ok) return sendJson(res, deleted.error && /Stop the run/.test(deleted.error) ? 409 : 400, deleted);
      return sendJson(res, 200, { ok: true, ...deleted, increment: INCREMENT });
    }
    if (req.method === 'POST' && b === 'rename') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const id = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const renamed = await renameCatalogRun(id, body.run_id || body.id, body.name, body.simulation_id);
      if (!renamed.ok) return sendJson(res, 400, renamed);
      return sendJson(res, 200, {
        ok: true,
        run_id: renamed.run_id,
        name: renamed.name,
        runs: renamed.runs,
        active_run_id: renamed.active_run_id,
        increment: INCREMENT,
      });
    }
    if (req.method === 'POST' && b === 'activate') {
      let body = {};
      try {
        body = (await readJsonBody(req)) || {};
      } catch {
        body = {};
      }
      const id = body.project_id || u.searchParams.get('project_id') || projectIdOrActive('', readActiveId);
      const runId = body.run_id || body.id;
      const found = catalogForRun(id, runId, body.simulation_id || u.searchParams.get('simulation_id'));
      const cat = found.cat;
      if (!(cat.runs || []).some((r) => String(r.id) === String(runId))) {
        return sendJson(res, 404, { ok: false, error: 'Run not found', increment: INCREMENT });
      }
      cat.active_id = runId;
      await saveCatalog(id, cat, { skipRuns: true });
      const st = getRunStatus(id, runId, found.sid || body.simulation_id || u.searchParams.get('simulation_id'));
      return sendJson(res, 200, st.body);
    }
    return false;
  }

  return false;
}
