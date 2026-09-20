import { safeProjectPath } from './safe-path.js';
// @ts-nocheck
/**
 * Simulation Control — incompressible steady simpleFoam from the project mesh,
 * Air, and assigned BCs. Does not re-split polyMesh. No bank face57/71 gates.
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
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, pyTool } from './python-env.js';
import { wslCasePath, wslDistro } from './wsl-env.js';
import { hardwarePrefs } from './prefs.js';
import { probeWslMpiSlots } from './hardware-profile.js';
import { matchesStudy } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, liveStudyRows } from './w17-sim-catalog.js';
import {
  TRANSIENT_DEFAULTS,
  TRANSIENT_LARGE_MESH_CELLS,
  simIsTransient,
  normalizeTransient,
  resolveTransientControl,
  describeTransient,
} from './w30-transient.js';
import { createJobLogger } from './log.js';
import { envGet } from './env-compat.js';
import { spawnJob } from './job-runner.js';
import { pyJson, pyJsonSync } from './py-json.js';
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
import { listFoamTimeDirs, walkGeometries } from './project-layout.js';
import { solveStartBlockReason } from './solve-start-block.js';
import { scheduleComputeQueueKick } from './server/compute-queue.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const REPORT_DIR = join(ROOT, '.cache', 'jobs', 'run');
const WSL_DISTRO = wslDistro();
const INCREMENT = 'W27';
const DEFAULT_END_TIME = 200;
const DEFAULT_WRITE_INTERVAL = 50;
const LARGE_MESH_CELLS = 200000;

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
 * Raw OpenFOAM log-line progress (residuals / Time / Courant). W27_* bash
 * markers removed with legacy bash solve script (land6). Live runs use applyJobEvent.
 */
function applyProgressLine(state, raw) {
  const line = String(raw || '').replace(/^\s*\[\d+\]\s*/, '');
  const tm = line.match(/^Time\s*=\s*([0-9.+-eE]+)\s*$/);
  if (tm) {
    enterSolveStage(state);
    if (state.stage !== 'solve') return;
    if (state.current && Number.isFinite(state.current.t)) state.series.push(state.current);
    const t = Number(tm[1]);
    const prev = state.current || {};
    const pend = state.pending || {};
    state.pending = null;
    state.current = { t };
    for (const k of ['delta_t', 'co_max', 'co_mean']) {
      if (Number.isFinite(pend[k])) state.current[k] = pend[k];
      else if (Number.isFinite(prev[k])) state.current[k] = prev[k];
    }
    if (!state.solve_started_at && Number.isFinite(t) && t > 0) {
      state.solve_started_at = new Date().toISOString();
    }
    return;
  }
  const co = line.match(/^Courant Number mean:\s*([0-9.eE+-]+)\s+max:\s*([0-9.eE+-]+)/);
  if (co) {
    enterSolveStage(state);
    if (state.stage !== 'solve') return;
    if (!state.pending) state.pending = {};
    const mean = Number(co[1]);
    const v = Number(co[2]);
    if (Number.isFinite(mean)) state.pending.co_mean = mean;
    if (Number.isFinite(v)) state.pending.co_max = v;
    return;
  }
  const dt = line.match(/^deltaT\s*=\s*([0-9.eE+-]+)/);
  if (dt) {
    enterSolveStage(state);
    if (state.stage !== 'solve') return;
    if (!state.pending) state.pending = {};
    const v = Number(dt[1]);
    if (Number.isFinite(v)) state.pending.delta_t = v;
    return;
  }
  const rm = line.match(/Solving for (Ux|Uy|Uz|p|omega|k), Initial residual = ([0-9.eE+-]+)/);
  if (rm && state.current) {
    const v = Number(rm[2]);
    if (Number.isFinite(v)) state.current[rm[1]] = v;
  }
}



/**
 * Apply one MAGNUSIM_EVENT / CFDDESK_EVENT JSONL object to the live progress
 * state (twin of cfddesk.wsl.solve_run.ProgressParser event handling).
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

function compactResidual(row) {
  const ux = Number(row.Ux);
  const uy = Number(row.Uy);
  const uz = Number(row.Uz);
  const uBits = [ux, uy, uz].filter(Number.isFinite);
  const out = { t: row.t };
  if (uBits.length) out.U = Math.max(...uBits);
  if (Number.isFinite(Number(row.p))) out.p = Number(row.p);
  if (Number.isFinite(Number(row.k))) out.k = Number(row.k);
  if (Number.isFinite(Number(row.omega))) out.omega = Number(row.omega);
  // Transient runs: Courant number per step (drawn on the residual plot).
  if (Number.isFinite(Number(row.co_mean))) out.co_mean = Number(row.co_mean);
  if (Number.isFinite(Number(row.co_max))) out.co_max = Number(row.co_max);
  return out;
}

function downsampleResiduals(series, maxPts = 200) {
  if (!Array.isArray(series) || !series.length) return [];
  const compact = series.map(compactResidual);
  if (compact.length <= maxPts) return compact;
  const out = [];
  const last = compact.length - 1;
  for (let i = 0; i < maxPts - 1; i++) {
    out.push(compact[Math.round((i / (maxPts - 1)) * last)]);
  }
  out.push(compact[last]);
  return out;
}

function rowHasResidual(row) {
  const n = ['Ux', 'Uy', 'Uz', 'p', 'k', 'omega'].filter((k) => Number.isFinite(Number(row && row[k]))).length;
  return n >= 2;
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
    residuals: downsampleResiduals(series.filter(rowHasResidual)),
    solve_started_at: state.solve_started_at || null,
  };
  if (last && Number.isFinite(last.co_max)) out.co_max = last.co_max;
  if (last && Number.isFinite(last.co_mean)) out.co_mean = last.co_mean;
  if (last && Number.isFinite(last.delta_t)) out.delta_t = last.delta_t;
  if (state.saved_times && state.saved_times.length) {
    const times = state.saved_times.slice().sort((a, b) => a - b);
    out.live_saved_times = times;
  }
  return out;
}

export function parseSolveProgress(text) {
  const state = newProgressState();
  for (const line of String(text || '').split(/\r?\n/)) {
    const ev = parseEventPayload(line);
    if (ev) {
      applyJobEvent(state, ev);
      continue;
    }
    applyProgressLine(state, line);
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
        const parsed = parseSolveProgress(readFileSync(logPath, 'utf8'));
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


export function sanitizePatchName(label) {
  let base = String(label || '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'patch';
  if (/^\d/.test(base)) base = 'p_' + base;
  return base;
}

export function listBcRecords(bcs) {
  if (!bcs) return [];
  if (Array.isArray(bcs.boundary_conditions)) return bcs.boundary_conditions.filter(Boolean);
  return [];
}

export function bcFaces(bc) {
  const faces = Array.isArray(bc && bc.faces) ? bc.faces.slice() : [];
  if (bc && bc.face && !faces.includes(bc.face)) faces.push(bc.face);
  return faces.filter(Boolean);
}

export function isVelocityInlet(bc) {
  return /velocity\s*inlet/i.test(String((bc && bc.bc_type) || ''));
}

export function isVelocityOutlet(bc) {
  return /velocity\s*outlet/i.test(String((bc && bc.bc_type) || ''));
}

export function isPressureBc(bc) {
  return /^pressure/i.test(String((bc && bc.bc_type) || ''));
}

export function isWallBc(bc) {
  return /^wall$/i.test(String((bc && bc.bc_type) || '').trim());
}

/** 'Slip' | 'No-slip' for a wall BC record or a defaults object. */
export function wallTreatment(rec) {
  const t = String((rec && rec.wall_type) || '').toLowerCase().replace(/[\s_-]+/g, '');
  return t === 'slip' ? 'Slip' : 'No-slip';
}

function airFromMaterials(mats, simId, legacyId) {
  const list = (mats && Array.isArray(mats.materials) && mats.materials) || [];
  const scoped = list.filter((m) => matchesStudy(m, simId, legacyId));
  const air = scoped.find((m) => /air/i.test(String(m.name || ''))) || null;
  if (!air) return null;
  const vols = Array.isArray(air.assigned_volumes) ? air.assigned_volumes : [];
  const nu = Number(air.kinematic_viscosity);
  const rho = Number(air.density);
  return {
    name: air.name || 'Air',
    nu: Number.isFinite(nu) && nu > 0 ? nu : 1.529e-5,
    // simpleFoam works with kinematic pressure (p/rho); rho converts Pa <-> m2/s2
    rho: Number.isFinite(rho) && rho > 0 ? rho : 1.196,
    assigned: vols.length > 0 || !!air.assigned_volume,
  };
}

const CAD_PREVIEW_SCRIPT = pyTool('export_step_cad_preview.py');

/**
 * CAD face properties in metres: { 'face 10@Body1': { area, centroid, normal } }.
 * Read from geometries/Geometry_…/cad_preview.json (legacy geometry folder is fallback).
 */
export function loadFaceProps(projectId) {
  const root = projectDir(projectId);
  const candidates = walkGeometries(root).map((g) => join(g.dir, 'cad_preview.json'));
  candidates.push(join(root, 'geometry', 'cad_preview.json'));
  let meta = null;
  let metaPath = null;
  for (const p of candidates) {
    const j = readJsonSafe(p);
    if (j && Array.isArray(j.faces) && j.faces.length) {
      meta = j;
      metaPath = p;
      break;
    }
  }
  if (!(meta && Array.isArray(meta.faces) && meta.faces.length)) {
    const geom = walkGeometries(root)[0];
    const step = geom ? join(geom.dir, 'source.step') : join(root, 'geometry', 'source.step');
    metaPath = geom ? join(geom.dir, 'cad_preview.json') : join(root, 'geometry', 'cad_preview.json');
    if (existsSync(step) && existsSync(PYTHON) && existsSync(CAD_PREVIEW_SCRIPT)) {
      try {
        spawnSync(PYTHON, [CAD_PREVIEW_SCRIPT, '--step', step, '--meta', metaPath, '--faces-only'], {
          windowsHide: true,
          timeout: 120000,
        });
      } catch {}
      meta = readJsonSafe(metaPath);
    }
  }
  const out = {};
  if (!(meta && Array.isArray(meta.faces))) return out;
  const unit = String(meta.faces_length_unit || 'mm').toLowerCase();
  const s = unit === 'm' ? 1 : unit === 'in' ? 0.0254 : 0.001;
  const body = (Array.isArray(meta.bodies) && meta.bodies[0]) || 'Body1';
  for (const f of meta.faces) {
    if (!f || f.id == null) continue;
    out[`face ${f.id}@${body}`] = {
      area: Number(f.area) * s * s,
      centroid: Array.isArray(f.centroid) ? f.centroid.map((c) => Number(c) * s) : null,
      normal: Array.isArray(f.normal) ? f.normal.map(Number) : null,
    };
  }
  return out;
}

function facesArea(faces, props) {
  let a = 0;
  for (const f of faces || []) {
    const p = props && props[f];
    if (p && Number.isFinite(p.area)) a += p.area;
  }
  return a;
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
  const poly =
    (polyFromCase && existsSync(join(polyFromCase, 'owner')) && existsSync(join(polyFromCase, 'points'))
      ? polyFromCase
      : null) ||
    (live && live.mesh_path) ||
    polyFromCase;
  return !!(
    live &&
    live.status === 'done' &&
    caseDir &&
    existsSync(caseDir) &&
    poly &&
    existsSync(join(poly, 'owner')) &&
    existsSync(join(poly, 'points'))
  );
}

export function listGeneratedMeshes(projectId, simulationId) {
  const id = projectId || readActiveId();
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
  const id = projectId || readActiveId();
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
  const polyComplete = (p) => !!(p && existsSync(join(p, 'owner')) && existsSync(join(p, 'points')));
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
  if (!poly || !existsSync(poly) || !existsSync(join(poly, 'owner')) || !existsSync(join(poly, 'points'))) {
    return {
      ok: false,
      error: 'polyMesh incomplete (owner/points)',
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
  const id = projectId || readActiveId();
  const defaults = { endTime: DEFAULT_END_TIME, writeInterval: DEFAULT_WRITE_INTERVAL };
  if (!id) return { ...defaults, project_id: null };
  const sim = activeStudy(id, simulationId);
  const doc =
    (sim && readStudyJson(id, sim.id, 'control')) ||
    readJsonSafe(join(projectDir(id), 'simulation_control.json')) ||
    {};
  const endTime = Math.max(1, Math.round(Number(doc.endTime) || DEFAULT_END_TIME));
  const writeInterval = Math.max(1, Math.round(Number(doc.writeInterval) || DEFAULT_WRITE_INTERVAL));
  return {
    project_id: id,
    endTime,
    writeInterval,
    // Transient defaults for new runs (W30); steady fields above are untouched.
    transient: normalizeTransient(doc.transient),
    updated_at: doc.updated_at || null,
  };
}

export async function saveSimulationControl(projectId, partial, simulationId) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no active project' };
  const sim = activeStudy(id, simulationId || (partial && partial.simulation_id));
  const prev = getSimulationControl(id, sim && sim.id);
  const next = {
    project_id: id,
    simulation_id: (sim && sim.id) || null,
    endTime: Math.max(1, Math.round(Number(partial.endTime != null ? partial.endTime : prev.endTime))),
    writeInterval: Math.max(
      1,
      Math.round(Number(partial.writeInterval != null ? partial.writeInterval : prev.writeInterval))
    ),
    transient:
      partial.transient && typeof partial.transient === 'object'
        ? normalizeTransient(partial.transient, prev.transient)
        : prev.transient,
    updated_at: new Date().toISOString(),
    increment: INCREMENT,
  };
  try {
    if (sim && sim.id) writeStudyJson(id, sim.id, 'control', next);
    else {
      await pyJson(
        'project_cli.py',
        ['set-sim-control', '--project-dir', projectDir(id), '--sim-id', String((sim && sim.id) || '')],
        next,
      );
    }
  } catch (e) {
    console.warn('[CFD] save sim control', e);
  }
  return { ok: true, ...next };
}

/** Active study time dependency. Do not read leftover simulation.json. */
function projectIsTransient(projectId, simulationId) {
  const id = projectId || readActiveId();
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

/** Volumetric flow rate in m³/s for a Flow rate → Volumetric flow inlet. */
function volumetricM3s(bc) {
  const v = Number(bc && bc.value);
  if (!Number.isFinite(v)) return null;
  const unit = String((bc && bc.unit) || '').toLowerCase();
  if (unit.includes('ft') && unit.includes('min')) return v * 0.00047194745;
  if (unit.includes('l/min')) return v / 60000;
  if (unit.includes('l/s')) return v / 1000;
  if (unit.includes('m3') || unit.includes('m³') || unit.includes('m^3')) return v;
  return null;
}

/** Mass flow rate in kg/s for a Flow rate → Mass flow inlet. */
function massFlowKgs(bc) {
  const v = Number(bc && bc.value);
  if (!Number.isFinite(v)) return null;
  const unit = String((bc && bc.unit) || '').toLowerCase();
  if (unit === 'kg/s') return v;
  if (unit === 'lb/s') return v * 0.45359237;
  if (unit === 'kg/h') return v / 3600;
  return null;
}

function isMassFlow(bc) {
  if (/mass/i.test(String((bc && bc.flow_rate_type) || ''))) return true;
  return massFlowKgs(bc) != null && volumetricM3s(bc) == null;
}

/** Inlet speed in m/s for a Fixed velocity inlet. */
function inletSpeedMs(bc) {
  const v = Number(bc && bc.value);
  if (!Number.isFinite(v)) return 1;
  const unit = String((bc && bc.unit) || '').toLowerCase();
  if (unit === 'm/s' || unit === 'm s-1' || unit === '') return v;
  if (unit === 'ft/s') return v * 0.3048;
  if (unit === 'ft/min' || unit === 'fpm') return (v * 0.3048) / 60;
  if (unit === 'km/h') return v / 3.6;
  if (unit === 'mph') return v * 0.44704;
  return v;
}

/** Static pressure in Pa (gauge) for a Pressure boundary. */
function pressurePa(bc) {
  const v = Number(bc && bc.value);
  if (!Number.isFinite(v)) return 0;
  const unit = String((bc && bc.unit) || 'Pa').toLowerCase();
  if (unit === 'pa' || unit === '') return v;
  if (unit === 'kpa') return v * 1e3;
  if (unit === 'bar') return v * 1e5;
  if (unit === 'psi') return v * 6894.757;
  if (unit === 'inh2o' || unit === 'in h2o' || unit === 'inwc') return v * 249.089;
  if (unit === 'mmh2o') return v * 9.80665;
  return v;
}

function usesFlowRate(bc) {
  if (/flow\s*rate/i.test(String((bc && bc.velocity_type) || ''))) return true;
  const unit = String((bc && bc.unit) || '');
  return /ft³\/min|ft3\/min|m³\/s|m3\/s|kg\/s|lb\/s/i.test(unit);
}

/**
 * Representative speed of an inlet in m/s (for turbulence and the velocity
 * guard). Flow-rate inlets use the assigned face area when it is known.
 */
function inletRefSpeed(bc, faceArea, rho) {
  if (usesFlowRate(bc)) {
    const q = isMassFlow(bc) ? (massFlowKgs(bc) || 0) / (rho || 1.2) : volumetricM3s(bc) || 0;
    const n = Math.max(1, bcFaces(bc).length);
    const a = faceArea > 0 ? faceArea : null;
    return a ? (Math.abs(q) * n) / a : Math.max(1, Math.abs(q) * 1000);
  }
  return Math.abs(inletSpeedMs(bc));
}

function loadMeshWebBcs(mesh) {
  const caseDir = mesh && mesh.case_dir;
  if (!caseDir) return [];
  const meta = readJsonSafe(join(caseDir, 'standard-meta.json'));
  return meta && Array.isArray(meta.web_bcs) ? meta.web_bcs : [];
}

function facesOverlap(a, b) {
  const have = new Set(bcFaces(a));
  if (!have.size) return false;
  return bcFaces(b).some((f) => have.has(f));
}

export function uniqueNumberedPatch(want, patchNames) {
  if (patchNames.has(want)) return want;
  if (!want) return null;
  const re = new RegExp('^' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:_\\d+)?$');
  const hits = [...patchNames].filter((p) => re.test(p));
  return hits.length === 1 ? hits[0] : null;
}

export function mapBcToPatch(bc, patchNames, webBcs) {
  const want = sanitizePatchName(bc.name);
  const exact = uniqueNumberedPatch(want, patchNames);
  if (exact) return exact;
  const faces = bcFaces(bc);
  for (const f of faces) {
    const alt = uniqueNumberedPatch(sanitizePatchName(f), patchNames);
    if (alt) return alt;
  }
  for (const baked of webBcs || []) {
    if (!facesOverlap(bc, baked)) continue;
    const fromBaked = uniqueNumberedPatch(sanitizePatchName(baked.name), patchNames);
    if (fromBaked) return fromBaked;
  }
  return want;
}

function isAreaAverageRc(rec) {
  if (!rec) return false;
  return /area average/i.test(String(rec.kind || '')) || /area average/i.test(String(rec.name || ''));
}

function listAaFaces(aa) {
  const recs = [];
  if (aa && aa.area_average_1) recs.push(aa.area_average_1);
  if (aa && Array.isArray(aa.result_controls)) {
    for (const rec of aa.result_controls) {
      if (isAreaAverageRc(rec)) recs.push(rec);
    }
  }
  const faces = [];
  for (const rec of recs) {
    for (const f of Array.isArray(rec && rec.faces) ? rec.faces : []) {
      if (f && !faces.includes(f)) faces.push(f);
    }
  }
  return faces;
}

export function validateSolveReady(projectId, opts) {
  const mesh = resolveProjectMesh(projectId, opts && opts.meshId, opts && opts.simulationId);
  if (!mesh.ok) return mesh;
  const id = mesh.project_id;
  const sim = activeStudy(id, opts && opts.simulationId);
  const legacy = legacyStudyId(id);
  const mats = sim ? readStudyJson(id, sim.id, 'materials') : null;
  const bcs = sim ? readStudyJson(id, sim.id, 'bcs') : null;
  const aa = (opts && opts.aa) || (sim ? readStudyJson(id, sim.id, 'result_controls') : null);
  const air = airFromMaterials(mats, sim && sim.id, legacy);
  const records = listBcRecords(bcs).filter((b) => matchesStudy(b, sim && sim.id, legacy));
  const inlets = records.filter((b) => isVelocityInlet(b) && bcFaces(b).length);
  const pressures = records.filter((b) => isPressureBc(b) && bcFaces(b).length);
  const patchNames = new Set((mesh.patches || []).map((p) => p.name));
  const webBcs = loadMeshWebBcs(mesh);

  if (!sim) {
    return { ok: false, error: 'Create an Incompressible simulation first', project_id: id, fix: { go: 'create-sim' } };
  }
  if (!air || !air.assigned) {
    return { ok: false, error: 'Assign Air to a volume first', project_id: id, fix: { go: 'material' } };
  }
  if (!inlets.length && pressures.length < 2) {
    const incomplete = records.find((b) => !bcFaces(b).length);
    return {
      ok: false,
      error: 'Add a velocity inlet, or two pressure boundaries, each with an assigned face',
      project_id: id,
      fix: incomplete
        ? { go: 'bc', id: incomplete.id, name: incomplete.name }
        : { go: 'bc-picker' },
    };
  }
  if (!pressures.length) {
    return {
      ok: false,
      error: 'Add a pressure boundary with an assigned face',
      project_id: id,
      fix: { go: 'bc-picker' },
    };
  }

  const mapped = [];
  for (const bc of records) {
    if (!bcFaces(bc).length) continue;
    const patch = mapBcToPatch(bc, patchNames, webBcs);
    if (!patchNames.has(patch)) {
      return {
        ok: false,
        error: `Mesh has no patch for "${bc.name}" (looked for ${patch}). Generate the mesh after assigning BCs.`,
        project_id: id,
        patches: Array.from(patchNames),
        fix: { go: 'mesh', id: mesh.mesh_id, name: mesh.mesh_name },
      };
    }
    mapped.push({ bc, patch });
  }
  if (!inlets.length && pressures.length >= 2) {
    const vals = pressures.map((b) => pressurePa(b));
    if (Math.max(...vals) - Math.min(...vals) === 0) {
      return {
        ok: false,
        error: 'Both pressure boundaries have the same value, so nothing drives the flow. Give them different pressures or add a velocity inlet.',
        project_id: id,
        fix: { go: 'bc', id: pressures[0].id, name: pressures[0].name },
      };
    }
  }
  return {
    ok: true,
    project_id: id,
    mesh,
    sim,
    air,
    bcs: records,
    // Faces no BC claims end up in the mesh's `walls` patch; this decides
    // whether that patch is no-slip (default) or slip.
    wallDefault: wallTreatment(bcs && bcs.defaults),
    mapped,
    aa,
    patchNames,
    faceProps: loadFaceProps(id),
  };
}

// ---------------------------------------------------------------------------
// Monitor results: postProcessing/<mon_|flow_><patch>/<time>/surfaceFieldValue.dat

function parseSurfaceFieldValueDat(text) {
  const out = { area: null, faces: null, columns: [], rows: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      let m = line.match(/^#\s*Area\s*:\s*([0-9.eE+-]+)/);
      if (m) out.area = Number(m[1]);
      m = line.match(/^#\s*Faces\s*:\s*(\d+)/);
      if (m) out.faces = Number(m[1]);
      m = line.match(/^#\s*Time\s+(.*)$/);
      if (m) out.columns = m[1].trim().split(/\s+/);
      continue;
    }
    // tokens: numbers or "(a b c)" vectors
    const toks = [];
    const re = /\(([^)]*)\)|([0-9.eE+-]+)/g;
    let t;
    while ((t = re.exec(line))) {
      if (t[1] != null) toks.push(t[1].trim().split(/\s+/).map(Number));
      else toks.push(Number(t[2]));
    }
    if (!toks.length || !Number.isFinite(toks[0])) continue;
    out.rows.push(toks);
  }
  return out;
}

function readMonitorDat(caseDir, name) {
  const dir = join(caseDir, 'postProcessing', name);
  if (!existsSync(dir)) return null;
  let merged = null;
  let times = [];
  try {
    times = readdirSync(dir)
      .filter((d) => /^\d+(\.\d+)?$/.test(d))
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return null;
  }
  for (const t of times) {
    const f = join(dir, t, 'surfaceFieldValue.dat');
    if (!existsSync(f)) continue;
    let parsed;
    try {
      parsed = parseSurfaceFieldValueDat(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!merged) merged = parsed;
    else {
      // restarts append a new time folder; later rows supersede earlier ones
      const firstT = parsed.rows.length ? parsed.rows[0][0] : Infinity;
      merged.rows = merged.rows.filter((r) => r[0] < firstT).concat(parsed.rows);
      if (parsed.area != null) merged.area = parsed.area;
    }
  }
  return merged;
}

/**
 * Per-patch monitor summary for a finished or running run.
 * Velocities in m/s, pressure in Pa (kinematic × rho), flow in m³/s and kg/s.
 * A negative flow rate is flow INTO the domain (OpenFOAM face normals point out).
 */
export function getRunMonitors(projectId, runId, simulationId) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no active project' };
  const cat = loadCatalog(id);
  const scoped = runsForActiveStudy(id, cat.runs, simulationId);
  const rec =
    scoped.find((r) => String(r.id) === String(runId || '')) ||
    (cat.active_id && scoped.find((r) => String(r.id) === String(cat.active_id))) ||
    null;
  if (!rec) return { ok: false, error: 'Run not found', ...runListPayload(id, cat, { simulation_id: simulationId }) };
  const caseDir = rec.case_dir || join(runsDir(id), `run-${rec.id}`);
  const meta = readJsonSafe(join(caseDir, 'w27-case.json')) || {};
  const rho = Number(meta.rho) || 1.196;
  const mapped = Array.isArray(meta.mapped) ? meta.mapped : [];
  const patches = Array.isArray(meta.monitors) && meta.monitors.length ? meta.monitors : mapped.map((m) => m.patch);
  const out = [];
  for (const patch of patches) {
    const mon = readMonitorDat(caseDir, `mon_${patch}`) || readMonitorDat(caseDir, `aa_${patch}`);
    const flow = readMonitorDat(caseDir, `flow_${patch}`);
    if (!mon && !flow) continue;
    const bc = mapped.find((m) => m.patch === patch) || null;
    const area = (mon && mon.area) || (flow && flow.area) || (bc && bc.face_area_m2) || null;
    const uCol = mon ? mon.columns.findIndex((c) => /areaAverage\(U\)/.test(c)) : -1;
    const pCol = mon ? mon.columns.findIndex((c) => /areaAverage\(p\)/.test(c)) : -1;
    const series = [];
    const flowByT = new Map();
    if (flow) for (const r of flow.rows) flowByT.set(r[0], r[1]);
    const rows = mon ? mon.rows : flow ? flow.rows : [];
    for (const r of rows) {
      const t = r[0];
      const U = mon && uCol >= 0 && Array.isArray(r[1 + uCol]) ? r[1 + uCol] : null;
      const pKin = mon && pCol >= 0 && Number.isFinite(r[1 + pCol]) ? r[1 + pCol] : null;
      const q = flowByT.has(t) ? flowByT.get(t) : null;
      series.push({
        t,
        U,
        Umag: U ? Math.hypot(U[0], U[1], U[2]) : null,
        p_Pa: pKin != null ? pKin * rho : null,
        Q_m3s: q,
        Un_m_s: q != null && area ? q / area : null,
      });
    }
    const last = series[series.length - 1] || null;
    out.push({
      patch,
      name: (bc && bc.name) || patch,
      bc_type: (bc && bc.bc_type) || null,
      faces: (bc && bc.faces) || [],
      area_m2: area,
      n_faces: mon && mon.faces != null ? mon.faces : flow ? flow.faces : null,
      rho,
      last,
      // final values in display units
      final: last
        ? {
            iteration: last.t,
            mean_velocity_vector: last.U,
            mean_velocity_magnitude: last.Umag,
            mean_normal_velocity: last.Un_m_s,
            pressure_Pa: last.p_Pa,
            volumetric_flow_m3s: last.Q_m3s,
            mass_flow_kgs: last.Q_m3s != null ? last.Q_m3s * rho : null,
          }
        : null,
      series,
    });
  }
  // mass balance across all monitored openings
  let sumIn = 0;
  let sumOut = 0;
  for (const m of out) {
    const q = m.last && m.last.Q_m3s;
    if (!Number.isFinite(q)) continue;
    if (q < 0) sumIn += -q;
    else sumOut += q;
  }
  return {
    ok: true,
    project_id: id,
    run_id: rec.id,
    status: rec.status || null,
    transient: runIsTransient(rec),
    time_dependency: rec.time_dependency || null,
    rho,
    monitors: out,
    balance:
      out.length && (sumIn > 0 || sumOut > 0)
        ? {
            in_m3s: sumIn,
            out_m3s: sumOut,
            imbalance: sumIn > 0 ? (sumOut - sumIn) / sumIn : null,
          }
        : null,
  };
}

/**
 * Mesh-generation metadata (standard-meta.json) for the mesh a run uses; the
 * transient time-step estimate reads the recorded cell sizes from it.
 */
function loadMeshMeta(mesh) {
  const caseDir = mesh && mesh.case_dir;
  if (!caseDir) return null;
  const meta = readJsonSafe(join(caseDir, 'standard-meta.json')) || {};
  // checkMesh's smallest cell is what limits the Courant number.
  try {
    const logPath = join(caseDir, 'log.checkMesh');
    if (existsSync(logPath)) {
      const txt = readFileSync(logPath, 'utf8');
      // "Min volume = 4.97e-09. Max volume = ..." — the sentence period must
      // not be swallowed into the number.
      const numRe = '([0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)';
      const mv = txt.match(new RegExp('Min volume\\s*=\\s*' + numRe));
      const tv = txt.match(new RegExp('Total volume\\s*=\\s*' + numRe));
      if (mv && Number(mv[1]) > 0) meta.min_cell_volume_m3 = Number(mv[1]);
      if (tv && Number(tv[1]) > 0) meta.total_volume_m3 = Number(tv[1]);
    }
  } catch {}
  return meta;
}

/**
 * Reference speed for the case: the fastest velocity inlet, or the Bernoulli
 * speed of the pressure difference for a pressure-driven case. Shared by the
 * turbulence scales (steady + transient) and the transient time-step estimate.
 */
function referenceSpeed(ready, faceProps) {
  const rho = (ready.air && ready.air.rho) || 1.196;
  const inletsMapped = ready.mapped.filter((m) => isVelocityInlet(m.bc));
  if (inletsMapped.length) {
    let best = 0;
    for (const m of inletsMapped) {
      const a = facesArea(bcFaces(m.bc), faceProps);
      const s = inletRefSpeed(m.bc, a / Math.max(1, bcFaces(m.bc).length), rho);
      if (s > best) best = s;
    }
    return Math.max(best, 0.1);
  }
  const pvals = ready.mapped.filter((m) => isPressureBc(m.bc)).map((m) => pressurePa(m.bc));
  if (pvals.length >= 2) {
    const dp = Math.max(...pvals) - Math.min(...pvals);
    return Math.max(1, Math.sqrt((2 * Math.abs(dp)) / rho));
  }
  return 1;
}

/**
 * Transient numbers for a run: user settings + the mesh/flow it will solve.
 * Used both by the writer and by /api/run/status (so the panel can show the
 * calculated time step / frame interval before the run starts).
 */
export function transientControlFor(ready, settings) {
  const faceProps = ready.faceProps || loadFaceProps(ready.project_id);
  return resolveTransientControl(settings, {
    meshMeta: loadMeshMeta(ready.mesh),
    nCells: ready.mesh && ready.mesh.n_cells,
    speedRef: referenceSpeed(ready, faceProps),
  });
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
    const write = pyJson(
      'project_cli.py',
      ['save-catalog', '--project-dir', projectDir(projectId), '--sim-id', String((sim && sim.id) || '')],
      {
        active_id: cat.active_id || null,
        runs: cat.runs || [],
        updated_at: new Date().toISOString(),
      },
    );
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
    writeRunSidecar(projectId, runId, side);
  }
  return {
    ok: true,
    ...runListPayload(projectId, cat, { simulation_id: simulationId || rec.simulation_id }),
    name: rec.name,
    run_id: runId,
  };
}

/** @param {{projectId?: string, name?: string, simulationId?: string, runId?: string}} [opts] */
export async function createDraftRun({ projectId, name, simulationId, runId: requestedId, meshId } = {}) {
  const id = projectId || readActiveId();
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
  const rec = {
    id: runId,
    name: String(name || '').trim().slice(0, 64) || nextRunName(cat.runs),
    status: 'draft',
    mesh_id: defaultMesh && defaultMesh.id,
    mesh_name: defaultMesh && defaultMesh.name,
    endTime: DEFAULT_END_TIME,
    writeInterval: DEFAULT_WRITE_INTERVAL,
    // A draft follows the simulation's time dependency; the choice is frozen
    // onto the run when it starts.
    time_dependency: transient ? 'Transient' : 'Steady-state',
    transient: normalizeTransient(ctrl.transient),
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

export async function updateRunSettings(projectId, partial) {
  const id = projectId || readActiveId();
  const runId = partial && (partial.run_id || partial.id);
  if (!id || !runId) return { ok: false, error: 'run_id required' };
  const found = catalogForRun(id, runId, partial && partial.simulation_id);
  const cat = found.cat;
  const rec = cat.runs.find((r) => String(r.id) === String(runId));
  if (!rec) return { ok: false, error: 'Run not found' };
  if (partial.name != null) {
    const next = String(partial.name || '').trim();
    if (next) rec.name = next.slice(0, 64);
  }
  if (partial.endTime != null) rec.endTime = Math.max(1, Math.round(Number(partial.endTime) || DEFAULT_END_TIME));
  if (partial.writeInterval != null) {
    rec.writeInterval = Math.max(1, Math.round(Number(partial.writeInterval) || DEFAULT_WRITE_INTERVAL));
  }
  // W30 transient settings. Drafts may also switch time dependency (the
  // Incompressible panel changed it); started runs keep what they solved with.
  if (partial.transient && typeof partial.transient === 'object') {
    rec.transient = normalizeTransient(partial.transient, rec.transient);
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
  const id = projectId || readActiveId();
  if (!id || !runId) return { ok: false, error: 'run_id required' };
  if (liveRun && String(liveRun.run_id) === String(runId)) {
    return { ok: false, error: 'Stop the run before deleting it' };
  }
  const folder = runFolderOf(id, runId, simulationId) || runFolderOf(id, runId);
  if (!folder) return { ok: false, error: 'Run not found' };
  const sid = simulationId || folder.simulation_id || null;
  try {
    rmSync(folder.dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: 'Could not delete run folder: ' + String((e && e.message) || e) };
  }
  try {
    if (existsSync(runSidecarPath(id, runId))) rmSync(runSidecarPath(id, runId), { force: true });
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

function writeRunSidecar(projectId, runId, body) {
  const payload = { ...(body || {}), id: runId, run_id: runId, project_id: projectId };
  try {
    const write = pyJson(
      'project_cli.py',
      ['run-upsert', '--project-dir', projectDir(projectId), '--run-id', String(runId), '--sim-id', String((body && body.simulation_id) || '')],
      payload,
    );
    if (write && typeof write.then === 'function') {
      write.catch((e) => console.warn('[CFD] write run sidecar', e));
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
      pyJsonSync(
        'project_cli.py',
        [
          'run-upsert',
          '--project-dir',
          projectDir(projectId),
          '--run-id',
          String(doc.run_id),
          '--sim-id',
          String(withName.simulation_id || ''),
          '--stamp-project',
        ],
        { ...withName, id: doc.run_id, run_id: doc.run_id, project_id: projectId, increment: INCREMENT },
      );
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
export function startSolve(opts = {}) {
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

  const id = projectId || readActiveId();
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
    const wslState = draft.wsl_case ? probeWslSolveSync(draft.wsl_case) : 'dead';
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
  const et = Math.max(
    1,
    Math.round(Number(endTime != null ? endTime : draft && draft.endTime) || getSimulationControl(id).endTime)
  );
  const wi = Math.max(
    1,
    Math.round(
      Number(writeInterval != null ? writeInterval : draft && draft.writeInterval) ||
        getSimulationControl(id).writeInterval
    )
  );
  // W30: a transient simulation solves with pimpleFoam over physical time. The
  // run's own time_dependency wins when set (a draft made while the simulation
  // was steady stays steady); otherwise follow simulation.json.
  const isTransient = draft && draft.time_dependency ? runIsTransient(draft) : simIsTransient(ready.sim);
  let transient = null;
  if (isTransient) {
    const settings = normalizeTransient(
      transientIn && typeof transientIn === 'object' ? transientIn : null,
      normalizeTransient(draft && draft.transient, getSimulationControl(id).transient)
    );
    transient = transientControlFor(ready, settings);
    saveSimulationControl(id, { endTime: et, writeInterval: wi, transient: settings }, draft && draft.simulation_id);
  } else {
    saveSimulationControl(id, { endTime: et, writeInterval: wi }, draft && draft.simulation_id);
  }
  const solver = isTransient ? 'pimpleFoam' : 'simpleFoam';
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
  let prepResult = null;
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

  // Phase 1 land5: Python run_solve/stop_solve expect a single-segment id
  // (validate_wsl_case_id); wslCasePath() is only for legacy WSL sed fallbacks.
  const wslCaseId = `cfddesk-w27-${runId}`;
  const wslRunCasePath = wslCasePath(wslCaseId);
  const winLog = join(REPORT_DIR, `run-${runId}.log`);
  const started_at = new Date().toISOString();
  let logBuf = '';
  const progress = newProgressState();
  const runSolveArgs = [
    '--case-dir',
    winOut,
    '--wsl-case',
    wslCaseId,
    '--n-procs',
    String(nProcs),
    '--app',
    solver,
    '--run-id',
    String(runId),
  ];
  const argv = [PYTHON, pyTool('run_solve.py'), ...runSolveArgs];

  let runFinished = false;
  const finishRun = (code, signal, errMsg) => {
    if (runFinished) return;
    runFinished = true;
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const snap = liveRun && liveRun.progress ? snapshotProgress(liveRun.progress) : parseSolveProgress(logBuf);
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
    time_dependency: isTransient ? 'Transient' : 'Steady-state',
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
    finished_at: null,
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
    bcs: ready.mapped.map((m) => ({
      name: m.bc.name,
      bc_type: m.bc.bc_type,
      patch: m.patch,
      faces: bcFaces(m.bc),
      value: m.bc.value,
      unit: m.bc.unit || null,
      ...(isWallBc(m.bc) ? { wall_type: wallTreatment(m.bc) } : {}),
    })),
    wall_default: ready.wallDefault || 'No-slip',
    project_id: id,
    note: isTransient
      ? `pimpleFoam ${nProcs > 1 ? nProcs + ' ranks' : 'serial'} — Incompressible / k-ω SST / PIMPLE · ${describeTransient(transient)}`
      : `simpleFoam ${nProcs > 1 ? nProcs + ' ranks' : 'serial'} — Incompressible / k-ω SST / SIMPLE`,
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

function probeWslSolveSync(caseId) {
  const id = String(caseId || '').trim();
  if (!id) return 'dead';
  try {
    const r = spawnSync(PYTHON, [pyTool('stop_solve.py'), '--wsl-case', id, '--probe'], {
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

function scheduleWslProbe(caseId) {
  const id = String(caseId || '').trim();
  if (!id || wslProbeInflight.has(id)) return;
  wslProbeInflight.add(id);
  try {
    const child = spawn(PYTHON, [pyTool('stop_solve.py'), '--wsl-case', id, '--probe'], {
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
      [pyTool('stop_solve.py'), '--wsl-case', caseId, '--run-id', String(rid || ''), '--force'],
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
  const id = projectId || readActiveId();
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
  if (!pidLive && pick.wsl_case && wslState !== 'dead') scheduleWslProbe(pick.wsl_case);
  if (!pidLive && wslState === 'dead') {
    return { reaped: [reapStaleRunningDoc(id, pick)] };
  }
  return { run: null, rec: pick };
}

export function stopSolve({ projectId, force, runId } = {}) {
  const id = projectId || readActiveId();
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
  // Windows pid can die after Vite/HMR while WSL pimpleFoam keeps going.
  // Do not mark stopped until a probe says the case is dead.
  if (doc.wsl_case) {
    const wslState = cachedWslState(doc.wsl_case);
    if (wslState !== 'dead') {
      scheduleWslProbe(doc.wsl_case);
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
  return {
    simulating: true,
    has_run: true,
    run_status: doc.status || 'running',
    run_started_at: doc.started_at || rec.started_at || null,
    solve_started_at: doc.solve_started_at || rec.solve_started_at || null,
    sim_time: Number(doc.sim_time) || Number(doc.last_saved_iteration) || 0,
    sim_end: Number(doc.transient && doc.transient.end_time) || Number(rec.transient && rec.transient.end_time) || 0,
    time_dependency: doc.time_dependency || rec.time_dependency || null,
    iteration: Number(doc.iteration) || 0,
    endTime: Number(doc.endTime) || Number(rec.endTime) || 0,
  };
}

export function getRunStatus(projectId, runId, simulationId, opts) {
  const id = projectId || readActiveId();
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
      transient_defaults: TRANSIENT_DEFAULTS,
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
export function previewTransient(projectId, runId, settings, simulationId) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no active project' };
  const cat = loadCatalog(id);
  const scoped = runsForActiveStudy(id, cat.runs, simulationId);
  const rec = runId ? scoped.find((r) => String(r.id) === String(runId)) : null;
  const ctrl = getSimulationControl(id);
  const merged = normalizeTransient(settings, normalizeTransient(rec && rec.transient, ctrl.transient));
  const ready = validateSolveReady(id, {
    meshId: rec && rec.mesh_id,
    aa: { result_controls: (rec && rec.result_controls) || [] },
    simulationId: rec && rec.simulation_id,
  });
  if (!ready.ok) {
    // No mesh / BCs yet: still resolve what does not need the case.
    return { ok: true, partial: true, reason: ready.error || null, control: resolveTransientControl(merged, {}) };
  }
  return { ok: true, partial: false, control: transientControlFor(ready, merged), n_cells: ready.mesh.n_cells };
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
      const saved = await saveSimulationControl(body.project_id || u.searchParams.get('project_id'), body);
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
      const started = startSolve({
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
    if (req.method === 'GET' && b === 'monitors') {
      const mon = getRunMonitors(
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
      const id = body.project_id || u.searchParams.get('project_id') || readActiveId();
      const pv = previewTransient(
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
      const id = body.project_id || u.searchParams.get('project_id') || readActiveId();
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
      const id = body.project_id || u.searchParams.get('project_id') || readActiveId();
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
      const id = body.project_id || u.searchParams.get('project_id') || readActiveId();
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
      const id = body.project_id || u.searchParams.get('project_id') || readActiveId();
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
