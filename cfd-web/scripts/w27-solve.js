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
  writeFileSync,
  readdirSync,
  statSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, pyTool } from './python-env.js';
import { wslCasePath, wslDistro } from './wsl-env.js';
import { hardwarePrefs } from './prefs.js';
import { matchesStudy } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation } from './w17-sim-catalog.js';
import {
  TRANSIENT_DEFAULTS,
  TRANSIENT_LARGE_MESH_CELLS,
  simIsTransient,
  normalizeTransient,
  resolveTransientControl,
  transientControlDict,
  transientFvSchemes,
  transientFvSolution,
  transientProgressFromLine,
  describeTransient,
} from './w30-transient.js';
import { createJobLogger } from './log.js';
import { envGet } from './env-compat.js';
import { spawnJob } from './job-runner.js';

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

/** @type {null | { child: import('node:child_process').ChildProcess, run_id: string, wsl_case: string, project_id: string, progress: ReturnType<typeof newProgressState> }} */
let liveRun = null;

function newProgressState() {
  return { buf: '', series: [], stage: 'starting', current: null, pending: null, solve_started_at: null, saved_times: [] };
}

function applyProgressLine(state, raw) {
  const line = String(raw || '').replace(/^\s*\[\d+\]\s*/, '');
  if (state && state._jobLog && /W27_/.test(line)) { try { state._jobLog.info('progress', { line: line.slice(0, 200) }); } catch {} }
  if (/W27_DECOMPOSE_BEGIN/.test(line)) state.stage = 'decompose';
  else if (/W27_SIMPLEFOAM_BEGIN/.test(line)) state.stage = 'solve';
  else if (/W27_SIMPLEFOAM_END/.test(line)) state.stage = 'reconstruct';
  else if (/W27_RUN_END/.test(line)) state.stage = 'copy';
  // The solve script echoes this after each time directory has been copied to
  // the Windows run folder mid-run (live results).
  const saved = line.match(/W27_TIME_SAVED t=([0-9.eE+-]+)/);
  if (saved) {
    const t = Number(saved[1]);
    if (Number.isFinite(t) && !state.saved_times.includes(t)) state.saved_times.push(t);
    return;
  }
  const tm = line.match(/^Time\s*=\s*([0-9.+-eE]+)\s*$/);
  if (tm) {
    // reconstructPar echoes every saved time too; those are not progress.
    if (state.stage !== 'solve') return;
    if (state.current && Number.isFinite(state.current.t)) state.series.push(state.current);
    const t = Number(tm[1]);
    // pimpleFoam prints "Courant Number" and "deltaT" just BEFORE the
    // "Time =" line of the step they belong to; they were parked in
    // `pending`. Carry the previous step's values when a line is missing
    // (fixed Δt prints no deltaT line) so a snapshot is never blank.
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
  // Transient-only lines (Courant number, deltaT); no-ops for simpleFoam.
  if (state.stage === 'solve') {
    if (!state.pending) state.pending = {};
    if (transientProgressFromLine(line, state.pending)) return;
  }
  const rm = line.match(/Solving for (Ux|Uy|Uz|p|omega|k), Initial residual = ([0-9.eE+-]+)/);
  if (rm && state.current) {
    const v = Number(rm[2]);
    if (Number.isFinite(v)) state.current[rm[1]] = v;
  }
}

function consumeProgressChunk(state, chunk) {
  state.buf += String(chunk || '');
  const parts = state.buf.split(/\r?\n/);
  state.buf = parts.pop() || '';
  for (const line of parts) applyProgressLine(state, line);
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
    const t = Number(ev.t);
    if (Number.isFinite(t) && !(state.saved_times || []).includes(t)) {
      if (!state.saved_times) state.saved_times = [];
      state.saved_times.push(t);
    }
    return;
  }
  if (kind === 'progress') {
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
  for (const line of String(text || '').split(/\r?\n/)) applyProgressLine(state, line);
  return snapshotProgress(state);
}

function enrichRunDoc(doc) {
  if (!doc) return doc;
  const sameLive =
    liveRun &&
    liveRun.progress &&
    String(liveRun.run_id) === String(doc.run_id || doc.id);
  let progress = sameLive ? snapshotProgress(liveRun.progress) : null;
  let fromLog = false;
  if (!progress && doc.log_path && existsSync(doc.log_path)) {
    try {
      progress = parseSolveProgress(readFileSync(doc.log_path, 'utf8'));
      fromLog = true;
      // New JSONL path may leave a thin text log; keep stamped residuals.
      if ((!progress.n_steps || progress.n_steps === 0) && Array.isArray(doc.residuals) && doc.residuals.length) {
        progress = null;
        fromLog = false;
      }
    } catch {
      progress = null;
    }
  }
  if (!progress) return doc;
  // A log re-parse stamps solve_started_at with the parse time, which is
  // meaningless for the ETA; fall back to the run's start time instead.
  const startedAt = fromLog
    ? doc.solve_started_at || doc.started_at || null
    : progress.solve_started_at || doc.solve_started_at || null;
  return {
    ...doc,
    stage: progress.stage,
    iteration: progress.iteration,
    sim_time: progress.sim_time,
    n_steps: progress.n_steps,
    ...(progress.co_max != null ? { co_max: progress.co_max } : {}),
    ...(progress.co_mean != null ? { co_mean: progress.co_mean } : {}),
    ...(progress.delta_t != null ? { delta_t: progress.delta_t } : {}),
    residuals: progress.residuals,
    solve_started_at: startedAt,
    ...liveSavedFields(doc),
  };
}

/**
 * While a run is solving, the solve script copies each finished time
 * directory to the Windows run folder. Report what is there so Results can
 * open mid-run; finished runs keep the values stamped at exit.
 */
function liveSavedFields(doc) {
  if (!doc || doc.status !== 'running' || !doc.case_dir) return {};
  const times = listSavedTimes(doc.case_dir);
  const last = times.length ? times[times.length - 1] : 0;
  return {
    has_results: last > 0,
    last_saved_iteration: last,
    n_saved_times: times.length,
    saved_times: times,
  };
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
  return join(PROJECTS_ROOT, id);
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

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
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
 * Read from geometry/cad_preview.json; computed once for projects imported
 * before face properties were part of the preview.
 */
export function loadFaceProps(projectId) {
  const geo = join(projectDir(projectId), 'geometry');
  const metaPath = join(geo, 'cad_preview.json');
  let meta = readJsonSafe(metaPath);
  if (!(meta && Array.isArray(meta.faces) && meta.faces.length)) {
    const step = join(geo, 'source.step');
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

/**
 * Area-weighted unit normal pointing INTO the fluid for a set of CAD faces
 * (the CAD normals are outward, same orientation as the mesh patch). Null when
 * no face has a normal.
 */
function facesInwardNormal(faces, props) {
  let n = [0, 0, 0];
  let any = false;
  for (const f of faces || []) {
    const p = props && props[f];
    if (!p || !Array.isArray(p.normal) || p.normal.length !== 3) continue;
    const a = Number.isFinite(p.area) && p.area > 0 ? p.area : 1;
    n = [n[0] - a * p.normal[0], n[1] - a * p.normal[1], n[2] - a * p.normal[2]];
    any = true;
  }
  if (!any) return null;
  const m = Math.hypot(n[0], n[1], n[2]);
  return m > 0 ? n.map((x) => x / m) : null;
}

/**
 * Velocity vector written for a Fixed → Vector inlet: the air enters at the
 * typed speed, moving along the vector — U = speed · d̂, exactly as typed.
 * The component through the face is speed · (d̂ · n_in); for a vector 70° off
 * the face normal only 34 % of the speed crosses the face. That is geometry,
 * not something to correct for, but it is recorded so the UI can show it.
 */
function vectorInletVelocity(bc, faceProps) {
  const spd = Math.abs(inletSpeedMs(bc));
  const dir = inletDirection(bc);
  if (!dir) return null;
  const nIn = facesInwardNormal(bcFaces(bc), faceProps);
  const cos = nIn ? dir[0] * nIn[0] + dir[1] * nIn[1] + dir[2] * nIn[2] : null;
  return {
    U: dir.map((d) => d * spd),
    magnitude: spd,
    speed_through_face: cos != null ? spd * cos : null,
    cos,
  };
}

/** Hydraulic diameter of a set of faces (equivalent circle of the total area). */
function hydraulicDiameter(faces, props) {
  const a = facesArea(faces, props);
  return a > 0 ? 2 * Math.sqrt(a / Math.PI) : null;
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
  const caseDir = live && live.case_dir;
  const poly = (live && live.mesh_path) || (caseDir ? join(caseDir, 'constant', 'polyMesh') : null);
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
  const mesh = id ? readJsonSafe(join(projectDir(id), 'mesh.json')) : null;
  if (!mesh) return [];
  const list = Array.isArray(mesh.meshes) && mesh.meshes.length ? mesh.meshes : [mesh];
  const sim = activeStudy(id, simulationId);
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
  const mesh = readJsonSafe(join(projectDir(id), 'mesh.json'));
  if (!mesh) return { ok: false, error: 'mesh.json missing — generate a mesh first', project_id: id };

  const meshes = Array.isArray(mesh.meshes) ? mesh.meshes : [];
  const sim = activeStudy(id, simulationId);
  const legacy = legacyStudyId(id);
  const scoped = meshes.filter((m) => m && matchesStudy(m, sim && sim.id, legacy));
  const wanted = meshId
    ? scoped.find((m) => String(m.id) === String(meshId))
    : scoped.find((m) => String(m.id) === String(mesh.active_id)) || null;
  if (meshId && !wanted) {
    return { ok: false, error: 'mesh not found in this study', project_id: id, mesh_id: meshId };
  }

  const candidates = [];
  if (wanted && wanted.live_mesh_result) candidates.push(wanted.live_mesh_result);

  let live = null;
  for (const c of candidates) {
    const caseDir = c && c.case_dir;
    const poly = (c && c.mesh_path) || (caseDir ? join(caseDir, 'constant', 'polyMesh') : null);
    if (caseDir && existsSync(caseDir) && poly && existsSync(join(poly, 'owner')) && existsSync(join(poly, 'points'))) {
      live = c;
      break;
    }
  }

  const case_dir = (live && live.case_dir) || null;
  const poly =
    (live && live.mesh_path) ||
    (case_dir ? join(case_dir, 'constant', 'polyMesh') : null);

  if (wanted && !live) {
    return {
      ok: false,
      error: 'Generate "' + (wanted.name || 'that mesh') + '" before using it on a run',
      project_id: id,
      mesh_id: wanted.id,
    };
  }
  if (!case_dir || !existsSync(case_dir)) {
    return { ok: false, error: 'Generated mesh case missing — generate a mesh first', project_id: id, case_dir };
  }
  if (!poly || !existsSync(poly) || !existsSync(join(poly, 'owner')) || !existsSync(join(poly, 'points'))) {
    return { ok: false, error: 'polyMesh incomplete (owner/points)', project_id: id, case_dir, mesh_path: poly };
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

export function getSimulationControl(projectId) {
  const id = projectId || readActiveId();
  const defaults = { endTime: DEFAULT_END_TIME, writeInterval: DEFAULT_WRITE_INTERVAL };
  if (!id) return { ...defaults, project_id: null };
  const doc = readJsonSafe(join(projectDir(id), 'simulation_control.json')) || {};
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

export function saveSimulationControl(projectId, partial) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no active project' };
  const prev = getSimulationControl(id);
  const next = {
    project_id: id,
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
  writeJson(join(projectDir(id), 'simulation_control.json'), next);
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
  return Math.max(1, nProcs);
}

function foamHeader(cls, obj) {
  return `FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};
    object      ${obj};
}
`;
}

function writeFoamDict(path, cls, obj, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, foamHeader(cls, obj) + '\n' + body.trim() + '\n', 'utf8');
}

function writeVolField(path, { object, cls, dims, internal, patches }) {
  const lines = [
    foamHeader(cls, object).trimEnd(),
    '',
    `dimensions      ${dims};`,
    '',
    `internalField   ${internal};`,
    '',
    'boundaryField',
    '{',
  ];
  for (const [name, block] of Object.entries(patches)) {
    lines.push(`    ${name}`);
    lines.push('    {');
    for (const [k, v] of Object.entries(block)) {
      lines.push(`        ${k}          ${v};`);
    }
    lines.push('    }');
  }
  lines.push('}');
  lines.push('');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'), 'utf8');
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

function usesVector(bc) {
  return /vector/i.test(String((bc && bc.direction) || '')) && Array.isArray(bc && bc.vector);
}

/** Unit direction vector for a Fixed → Vector inlet; null when degenerate. */
function inletDirection(bc) {
  if (!usesVector(bc)) return null;
  const v = bc.vector.map((x) => Number(x) || 0);
  const m = Math.hypot(v[0], v[1], v[2]);
  if (!(m > 0)) return null;
  return v.map((x) => x / m);
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

/**
 * k / omega freestream values from turbulence intensity I and length scale L.
 * L is 7 % of the inlet hydraulic diameter (fully developed pipe flow).
 */
function kOmegaFromScales(speed, dHyd) {
  const U = Math.max(Math.abs(Number(speed) || 0), 0.1);
  const I = 0.05;
  const k = 1.5 * (I * U) * (I * U);
  const L = Math.max(0.07 * (Number(dHyd) || 0), 1e-3);
  const omega = Math.sqrt(k) / (0.09 ** 0.25 * L);
  return { k, omega, I, L };
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

function mapBcToPatch(bc, patchNames, webBcs) {
  const want = sanitizePatchName(bc.name);
  if (patchNames.has(want)) return want;
  const faces = bcFaces(bc);
  for (const f of faces) {
    const alt = sanitizePatchName(f);
    if (patchNames.has(alt)) return alt;
  }
  for (const baked of webBcs || []) {
    if (!facesOverlap(bc, baked)) continue;
    const fromBaked = sanitizePatchName(baked.name);
    if (patchNames.has(fromBaked)) return fromBaked;
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
  const mats = readJsonSafe(join(projectDir(id), 'materials.json'));
  const bcs = readJsonSafe(join(projectDir(id), 'boundary_conditions.json'));
  const aa =
    (opts && opts.aa) ||
    readJsonSafe(join(projectDir(id), 'area_average.json')) ||
    readJsonSafe(join(projectDir(id), 'result_controls.json'));
  const air = airFromMaterials(mats, sim && sim.id, legacy);
  const records = listBcRecords(bcs).filter((b) => matchesStudy(b, sim && sim.id, legacy));
  const inlets = records.filter((b) => isVelocityInlet(b) && bcFaces(b).length);
  const pressures = records.filter((b) => isPressureBc(b) && bcFaces(b).length);
  const patchNames = new Set((mesh.patches || []).map((p) => p.name));
  const webBcs = loadMeshWebBcs(mesh);

  if (!sim) return { ok: false, error: 'Create an Incompressible simulation first', project_id: id };
  if (!air || !air.assigned) return { ok: false, error: 'Assign Air to a volume first', project_id: id };
  if (!inlets.length && pressures.length < 2) {
    return {
      ok: false,
      error: 'Add a velocity inlet, or two pressure boundaries, each with an assigned face',
      project_id: id,
    };
  }
  if (!pressures.length) return { ok: false, error: 'Add a pressure boundary with an assigned face', project_id: id };

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

export function writeSolveCase(winOut, ready, { endTime, writeInterval, nProcs, transient }) {
  const polySrc = ready.mesh.mesh_path;
  const polyDst = join(winOut, 'constant', 'polyMesh');
  mkdirSync(join(winOut, 'constant'), { recursive: true });
  mkdirSync(join(winOut, '0'), { recursive: true });
  mkdirSync(join(winOut, 'system'), { recursive: true });
  // A restart (e.g. of a stopped run) must not keep iterations or monitor
  // histories from the previous attempt.
  try {
    for (const d of readdirSync(winOut, { withFileTypes: true })) {
      // Numeric time dirs other than 0 (0 is rewritten below), plus any
      // half-copied live frame (.sync_<t>) left by an interrupted run.
      const isTime = d.isDirectory() && /^\d+(\.\d+)?(?:[eE][+-]?\d+)?$/.test(d.name) && Number(d.name) > 0;
      const isTmp = d.isDirectory() && d.name.startsWith('.sync_');
      if (isTime || isTmp) rmSync(join(winOut, d.name), { recursive: true, force: true });
    }
  } catch {}
  for (const stale of ['postProcessing', 'log.simpleFoam', 'log.pimpleFoam', 'log.decomposePar', 'log.reconstructPar', 'log.reconstructPar.live', 'log.livesync']) {
    try { if (existsSync(join(winOut, stale))) rmSync(join(winOut, stale), { recursive: true, force: true }); } catch {}
  }
  if (existsSync(polyDst)) rmSync(polyDst, { recursive: true, force: true });
  cpSync(polySrc, polyDst, { recursive: true });

  const patchList = ready.mesh.patches.length ? ready.mesh.patches : parseBoundaryPatches(join(polyDst, 'boundary'));
  const patchNames = patchList.map((p) => p.name);
  const role = {};
  for (const { bc, patch } of ready.mapped) {
    if (isVelocityInlet(bc)) role[patch] = { kind: 'inlet', bc };
    else if (isPressureBc(bc)) role[patch] = { kind: 'pressure', bc };
    else if (isVelocityOutlet(bc)) role[patch] = { kind: 'velOutlet', bc };
    else if (isWallBc(bc)) role[patch] = { kind: 'wall', bc, treatment: wallTreatment(bc) };
  }
  const wallDefault = ready.wallDefault || 'No-slip';

  const rho = ready.air.rho || 1.196;
  const faceProps = ready.faceProps || loadFaceProps(ready.project_id);

  // Reference speed and length for turbulence: the velocity inlet(s), or for a
  // pressure-driven case the Bernoulli speed of the pressure difference on the
  // smallest pressure face.
  let speedRef = 1;
  let dHyd = null;
  const inletsMapped = ready.mapped.filter((m) => isVelocityInlet(m.bc));
  if (inletsMapped.length) {
    let best = 0;
    let bestArea = 0;
    for (const m of inletsMapped) {
      const a = facesArea(bcFaces(m.bc), faceProps);
      const s = inletRefSpeed(m.bc, a / Math.max(1, bcFaces(m.bc).length), rho);
      if (s > best) best = s;
      if (a > bestArea) bestArea = a;
    }
    speedRef = Math.max(best, 0.1);
    dHyd = bestArea > 0 ? 2 * Math.sqrt(bestArea / Math.PI) : null;
  } else {
    const pm = ready.mapped.filter((m) => isPressureBc(m.bc));
    const pvals = pm.map((m) => pressurePa(m.bc));
    if (pvals.length >= 2) {
      const dp = Math.max(...pvals) - Math.min(...pvals);
      speedRef = Math.max(1, Math.sqrt((2 * Math.abs(dp)) / rho));
    }
    let minArea = Infinity;
    for (const m of pm) {
      const a = facesArea(bcFaces(m.bc), faceProps);
      if (a > 0 && a < minArea) minArea = a;
    }
    dHyd = Number.isFinite(minArea) ? 2 * Math.sqrt(minArea / Math.PI) : null;
  }
  if (!dHyd) {
    // no CAD face data: fall back to a tenth of the smallest mesh extent
    const b = ready.mesh && ready.mesh.bounds;
    dHyd = b ? 0.1 * Math.min(b[1] - b[0], b[3] - b[2], b[5] - b[4]) : 0.05;
  }
  const speedForK = speedRef;
  const turb = kOmegaFromScales(speedRef, dHyd);
  const kStr = turb.k.toPrecision(6);
  const wStr = turb.omega.toPrecision(6);

  const U = {};
  const p = {};
  const k = {};
  const omega = {};
  const nut = {};
  for (const name of patchNames) {
    const r = role[name];
    const kind = r ? r.kind : 'wall';
    if (kind === 'inlet') {
      const bc = r.bc;
      const nFaces = Math.max(1, bcFaces(bc).length);
      if (usesFlowRate(bc) && isMassFlow(bc) && massFlowKgs(bc) != null) {
        // apply_per_face: every assigned face carries the value, so the patch
        // (all faces of this BC) carries n × value
        U[name] = {
          type: 'flowRateInletVelocity',
          massFlowRate: `constant ${(massFlowKgs(bc) * nFaces).toPrecision(8)}`,
          rhoInlet: `${rho}`,
          extrapolateProfile: 'false',
          value: 'uniform (0 0 0)',
        };
      } else if (usesFlowRate(bc) && volumetricM3s(bc) != null) {
        U[name] = {
          type: 'flowRateInletVelocity',
          volumetricFlowRate: `constant ${(volumetricM3s(bc) * nFaces).toPrecision(8)}`,
          extrapolateProfile: 'false',
          value: 'uniform (0 0 0)',
        };
      } else {
        const spd = Math.abs(inletSpeedMs(bc));
        const vec = vectorInletVelocity(bc, faceProps);
        if (vec) {
          const v = vec.U.map((c) => c.toPrecision(8));
          U[name] = { type: 'fixedValue', value: `uniform (${v.join(' ')})` };
        } else {
          // into the domain, normal to the face (negative refValue = inflow)
          U[name] = {
            type: 'surfaceNormalFixedValue',
            refValue: `uniform ${-spd}`,
            value: 'uniform (0 0 0)',
          };
        }
      }
      p[name] = { type: 'zeroGradient' };
      k[name] = { type: 'fixedValue', value: `uniform ${kStr}` };
      omega[name] = { type: 'fixedValue', value: `uniform ${wStr}` };
      nut[name] = { type: 'calculated', value: 'uniform 0' };
    } else if (kind === 'pressure') {
      // Static (gauge) pressure on the face. simpleFoam's p is kinematic, so
      // Pa / rho. Flow may enter or leave: pressureInletOutletVelocity takes
      // the velocity from the interior for outflow and normal to the face for
      // inflow; k / omega fall back to the freestream values on inflow.
      const pKin = pressurePa(r.bc) / rho;
      U[name] = {
        type: 'pressureInletOutletVelocity',
        value: 'uniform (0 0 0)',
      };
      p[name] = { type: 'fixedValue', value: `uniform ${pKin.toPrecision(8)}` };
      k[name] = { type: 'inletOutlet', inletValue: `uniform ${kStr}`, value: `uniform ${kStr}` };
      omega[name] = { type: 'inletOutlet', inletValue: `uniform ${wStr}`, value: `uniform ${wStr}` };
      nut[name] = { type: 'calculated', value: 'uniform 0' };
    } else if (kind === 'velOutlet') {
      U[name] = { type: 'inletOutlet', inletValue: 'uniform (0 0 0)', value: 'uniform (0 0 0)' };
      p[name] = { type: 'zeroGradient' };
      k[name] = { type: 'inletOutlet', inletValue: `uniform ${kStr}`, value: `uniform ${kStr}` };
      omega[name] = { type: 'inletOutlet', inletValue: `uniform ${wStr}`, value: `uniform ${wStr}` };
      nut[name] = { type: 'calculated', value: 'uniform 0' };
    } else {
      // Walls: explicit Wall BCs carry their own treatment; every patch no BC
      // claims (the mesher's `walls`) takes the project default.
      const treatment = r && r.kind === 'wall' ? r.treatment : wallDefault;
      if (treatment === 'Slip') {
        // Free-slip: zero normal velocity, no shear. No wall functions — there
        // is no boundary layer to model, so turbulence just sees zero gradient.
        U[name] = { type: 'slip' };
        p[name] = { type: 'zeroGradient' };
        k[name] = { type: 'zeroGradient' };
        omega[name] = { type: 'zeroGradient' };
        nut[name] = { type: 'calculated', value: 'uniform 0' };
      } else {
        U[name] = { type: 'noSlip' };
        p[name] = { type: 'zeroGradient' };
        k[name] = { type: 'kqRWallFunction', value: `uniform ${kStr}` };
        omega[name] = { type: 'omegaWallFunction', value: `uniform ${wStr}` };
        nut[name] = { type: 'nutkWallFunction', value: 'uniform 0' };
      }
    }
  }

  writeVolField(join(winOut, '0', 'U'), {
    object: 'U',
    cls: 'volVectorField',
    dims: '[0 1 -1 0 0 0 0]',
    internal: 'uniform (0 0 0)',
    patches: U,
  });
  writeVolField(join(winOut, '0', 'p'), {
    object: 'p',
    cls: 'volScalarField',
    dims: '[0 2 -2 0 0 0 0]',
    internal: 'uniform 0',
    patches: p,
  });
  writeVolField(join(winOut, '0', 'k'), {
    object: 'k',
    cls: 'volScalarField',
    dims: '[0 2 -2 0 0 0 0]',
    internal: `uniform ${kStr}`,
    patches: k,
  });
  writeVolField(join(winOut, '0', 'omega'), {
    object: 'omega',
    cls: 'volScalarField',
    dims: '[0 0 -1 0 0 0 0]',
    internal: `uniform ${wStr}`,
    patches: omega,
  });
  writeVolField(join(winOut, '0', 'nut'), {
    object: 'nut',
    cls: 'volScalarField',
    dims: '[0 2 -1 0 0 0 0]',
    internal: 'uniform 0',
    patches: nut,
  });

  writeFoamDict(
    join(winOut, 'constant', 'transportProperties'),
    'dictionary',
    'transportProperties',
    `transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] ${ready.air.nu};`
  );
  writeFoamDict(
    join(winOut, 'constant', 'turbulenceProperties'),
    'dictionary',
    'turbulenceProperties',
    `simulationType  RAS;
RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}`
  );

  // Monitors: every inlet / outlet patch gets an area average of U and p and a
  // flow-rate sum every iteration, so mass balance and the "Area average"
  // monitors read straight from postProcessing/. Faces the user monitors that
  // are not a BC patch cannot be sampled (they are part of "walls").
  const monitoredPatches = new Set();
  for (const m of ready.mapped) {
    if (isVelocityInlet(m.bc) || isPressureBc(m.bc) || isVelocityOutlet(m.bc)) monitoredPatches.add(m.patch);
  }
  for (const lab of listAaFaces(ready.aa)) {
    const owner = ready.mapped.find((m) => bcFaces(m.bc).includes(lab));
    if (owner && patchNames.includes(owner.patch)) monitoredPatches.add(owner.patch);
  }
  // Transient (W30): pimpleFoam with its own controlDict / fvSchemes /
  // fvSolution; everything else (mesh, fields, BCs, monitors) is shared.
  const isTransient = !!transient;
  // Steady: one monitor row per iteration. Transient: rows at a physical
  // interval (50 per result frame; `runTime` does not clip Δt to hit them) —
  // per-step rows with an adaptive Δt would be tens of thousands of lines.
  const monWrite = isTransient
    ? `writeControl    runTime;
        writeInterval   ${Number(transient.write_interval / 50).toPrecision(6)};`
    : `writeControl    timeStep;
        writeInterval   1;`;
  const aaFos = [];
  for (const patch of monitoredPatches) {
    aaFos.push(`    mon_${patch}
    {
        type            surfaceFieldValue;
        libs            ("libfieldFunctionObjects.so");
        ${monWrite}
        log             true;
        writeFields     false;
        regionType      patch;
        name            ${patch};
        operation       areaAverage;
        fields          ( U p );
    }
    flow_${patch}
    {
        type            surfaceFieldValue;
        libs            ("libfieldFunctionObjects.so");
        ${monWrite}
        log             false;
        writeFields     false;
        regionType      patch;
        name            ${patch};
        operation       sum;
        fields          ( phi );
    }`);
  }

  const functionsText = aaFos.join('\n') || '    // no area-average probes';
  if (isTransient) {
    writeFoamDict(join(winOut, 'system', 'controlDict'), 'dictionary', 'controlDict', transientControlDict(transient, functionsText));
    writeFoamDict(join(winOut, 'system', 'fvSchemes'), 'dictionary', 'fvSchemes', transientFvSchemes(transient));
    writeFoamDict(join(winOut, 'system', 'fvSolution'), 'dictionary', 'fvSolution', transientFvSolution(transient));
  }

  if (!isTransient) writeFoamDict(
    join(winOut, 'system', 'controlDict'),
    'dictionary',
    'controlDict',
    `application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         ${endTime};
deltaT          1;
writeControl    timeStep;
writeInterval   ${writeInterval};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{
${functionsText}
}`
  );

  if (!isTransient) writeFoamDict(
    join(winOut, 'system', 'fvSchemes'),
    'dictionary',
    'fvSchemes',
    // Second-order convection for momentum (linearUpwind), first-order for the
    // turbulence scalars — the usual steady RANS setup for hybrid hex/tet meshes.
    `ddtSchemes { default steadyState; }
gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
    grad(k)         cellLimited Gauss linear 1;
    grad(omega)     cellLimited Gauss linear 1;
}
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }`
  );

  // Classic SIMPLE with standard relaxation. The pressure boundary fixes the
  // pressure level, so no pRefCell. residualControl stops the run early once
  // all initial residuals are below the tolerance.
  if (!isTransient) writeFoamDict(
    join(winOut, 'system', 'fvSolution'),
    'dictionary',
    'fvSolution',
    `solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }
}
SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      no;
    residualControl { p 1e-4; U 1e-4; "(k|omega)" 1e-4; }
}
relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.7;
        omega           0.7;
    }
}`
  );

  // Velocity guard against the first SIMPLE iterations overshooting on a
  // pressure-driven start. 10x the expected speed never touches a converged
  // solution.
  const uMax = Math.max(50, 10 * Math.abs(speedForK));
  writeFoamDict(
    join(winOut, 'system', 'fvOptions'),
    'dictionary',
    'fvOptions',
    `limitU
{
    type            limitVelocity;
    active          yes;
    selectionMode   all;
    max             ${uMax.toPrecision(6)};
}`
  );

  if (nProcs > 1) {
    writeFoamDict(
      join(winOut, 'system', 'decomposeParDict'),
      'dictionary',
      'decomposeParDict',
      `numberOfSubdomains ${nProcs};
method          scotch;`
    );
  }

  writeFileSync(join(winOut, 'case.foam'), '', 'ascii');
  writeJson(join(winOut, 'w27-case.json'), {
    increment: INCREMENT,
    endTime,
    writeInterval,
    nProcs,
    solver: isTransient ? 'pimpleFoam' : 'simpleFoam',
    time_dependency: isTransient ? 'Transient' : 'Steady-state',
    ...(isTransient ? { transient } : {}),
    nu: ready.air.nu,
    rho,
    patches: patchNames,
    wall_default: wallDefault,
    mapped: ready.mapped.map((m) => ({
      name: m.bc.name,
      bc_type: m.bc.bc_type,
      patch: m.patch,
      faces: bcFaces(m.bc),
      value: m.bc.value,
      unit: m.bc.unit || null,
      ...(isWallBc(m.bc) ? { wall_type: wallTreatment(m.bc) } : {}),
      face_area_m2: facesArea(bcFaces(m.bc), faceProps) || null,
      ...(isVelocityInlet(m.bc) && !usesFlowRate(m.bc) && usesVector(m.bc)
        ? (() => {
            const vec = vectorInletVelocity(m.bc, faceProps);
            return vec
              ? {
                  inlet_vector_U: vec.U,
                  inlet_vector_cos: vec.cos,
                  inlet_speed_through_face: vec.speed_through_face,
                }
              : {};
          })()
        : {}),
    })),
    monitors: Array.from(monitoredPatches),
    turbulence: {
      model: 'kOmegaSST',
      intensity: turb.I,
      length_scale_m: turb.L,
      hydraulic_diameter_m: dHyd,
      speed_ref_m_s: speedRef,
      k: turb.k,
      omega: turb.omega,
    },
    n_cells: ready.mesh.n_cells,
    mesh_id: ready.mesh.mesh_id || null,
    mesh_name: ready.mesh.mesh_name || null,
    result_controls: (ready.aa && ready.aa.result_controls) || [],
    numerics: isTransient ? 'pimple-linearUpwind' : 'simple-linearUpwind',
  });
  return { patches: patchNames, nProcs, turb };
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

function loadCatalog(projectId) {
  const existing = readJsonSafe(catalogPath(projectId));
  const scanned = scanRunFolders(projectId);
  const byId = new Map();
  if (existing && Array.isArray(existing.runs)) {
    for (const rec of existing.runs) {
      if (rec && rec.id) byId.set(String(rec.id), { ...rec });
    }
  }
  for (const item of scanned) {
    if (!byId.has(item.id)) continue;
    const prev = byId.get(item.id);
    const doc = item.sidecar || {};
    byId.set(item.id, {
      ...(prev || {}),
      id: item.id,
      name: (prev && prev.name) || doc.name || null,
      status: doc.status || (prev && prev.status) || inferRunStatus(item.case_dir, item.meta.endTime),
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
    if (rec.last_saved_iteration == null && rec.status !== 'running' && rec.status !== 'starting') {
      const saved = listSavedTimes(item.case_dir);
      rec.last_saved_iteration = saved.length ? saved[saved.length - 1] : 0;
      rec.has_results = rec.has_results || rec.last_saved_iteration > 0;
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
  return cat;
}

function saveCatalog(projectId, cat) {
  mkdirSync(runsDir(projectId), { recursive: true });
  writeJson(catalogPath(projectId), {
    active_id: cat.active_id || null,
    runs: cat.runs || [],
    updated_at: new Date().toISOString(),
  });
}

function upsertCatalogRun(projectId, doc) {
  if (!projectId || !doc || !doc.run_id) return loadCatalog(projectId);
  const cat = loadCatalog(projectId);
  const idx = cat.runs.findIndex((r) => String(r.id) === String(doc.run_id));
  const prev = idx >= 0 ? cat.runs[idx] : null;
  const name = (prev && prev.name) || doc.name || nextRunName(cat.runs);
  const entry = catalogEntryFromDoc({ ...doc, name }, name, prev);
  if (idx >= 0) cat.runs[idx] = { ...cat.runs[idx], ...entry };
  else cat.runs.push(entry);
  cat.active_id = doc.run_id;
  saveCatalog(projectId, cat);
  return cat;
}

function renameCatalogRun(projectId, runId, name, simulationId) {
  const cat = loadCatalog(projectId);
  const rec = cat.runs.find((r) => String(r.id) === String(runId));
  if (!rec) return { ok: false, error: 'Run not found' };
  const next = String(name || '').trim();
  if (!next) return { ok: false, error: 'Name is required' };
  rec.name = next.slice(0, 64);
  saveCatalog(projectId, cat);
  const side = readJsonSafe(runSidecarPath(projectId, runId));
  if (side) {
    side.name = rec.name;
    writeJson(runSidecarPath(projectId, runId), side);
  }
  return {
    ok: true,
    ...runListPayload(projectId, cat, { simulation_id: simulationId || rec.simulation_id }),
    name: rec.name,
    run_id: runId,
  };
}

export function createDraftRun({ projectId, name, simulationId } = {}) {
  const id = projectId || readActiveId();
  if (!id) return { ok: false, error: 'no active project' };
  const cat = loadCatalog(id);
  const runId = stampId();
  const sim = activeStudy(id, simulationId);
  const meshes = listGeneratedMeshes(id, sim && sim.id);
  const defaultMesh = meshes.find((m) => m.ready && m.active) || meshes.find((m) => m.ready) || null;
  const ctrl = getSimulationControl(id);
  const transient = projectIsTransient(id, sim && sim.id);
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
    simulation_id: (sim && sim.id) || null,
    created_at: new Date().toISOString(),
  };
  cat.runs.push(rec);
  cat.active_id = runId;
  saveCatalog(id, cat);
  writeJson(runSidecarPath(id, runId), {
    ...rec,
    run_id: runId,
    project_id: id,
    increment: INCREMENT,
  });
  return { ok: true, run: rec, ...runListPayload(id, cat, { simulation_id: sim && sim.id }), meshes };
}

export function updateRunSettings(projectId, partial) {
  const id = projectId || readActiveId();
  const runId = partial && (partial.run_id || partial.id);
  if (!id || !runId) return { ok: false, error: 'run_id required' };
  const cat = loadCatalog(id);
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
    // Remember the latest transient settings as the project default for new runs.
    saveSimulationControl(id, { transient: rec.transient });
  }
  if (partial.time_dependency != null && (!rec.status || rec.status === 'draft')) {
    rec.time_dependency = /transient/i.test(String(partial.time_dependency)) ? 'Transient' : 'Steady-state';
  }
  if (partial.mesh_id != null) {
    const meshes = listGeneratedMeshes(id);
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
  saveCatalog(id, cat);
  const side = readJsonSafe(runSidecarPath(id, runId)) || { run_id: runId, project_id: id };
  writeJson(runSidecarPath(id, runId), { ...side, ...rec, run_id: runId, project_id: id, increment: INCREMENT });
  return {
    ok: true,
    run: rec,
    ...runListPayload(id, cat, { simulation_id: (partial && partial.simulation_id) || rec.simulation_id }),
    meshes: listGeneratedMeshes(id, (partial && partial.simulation_id) || rec.simulation_id),
  };
}

export function deleteCatalogRun(projectId, runId, simulationId) {
  const id = projectId || readActiveId();
  if (!id || !runId) return { ok: false, error: 'run_id required' };
  if (liveRun && String(liveRun.run_id) === String(runId)) {
    return { ok: false, error: 'Stop the run before deleting it' };
  }
  const cat = loadCatalog(id);
  const rec = cat.runs.find((r) => String(r.id) === String(runId));
  if (!rec) return { ok: false, error: 'Run not found' };
  cat.runs = cat.runs.filter((r) => String(r.id) !== String(runId));
  if (String(cat.active_id) === String(runId)) {
    const sibs = runsForActiveStudy(id, cat.runs);
    cat.active_id = sibs.length ? sibs[sibs.length - 1].id : null;
  }
  saveCatalog(id, cat);
  try {
    if (existsSync(runSidecarPath(id, runId))) rmSync(runSidecarPath(id, runId), { force: true });
  } catch {}
  const caseDir = join(runsDir(id), `run-${runId}`);
  try {
    if (existsSync(caseDir)) rmSync(caseDir, { recursive: true, force: true });
  } catch {}
  return {
    ok: true,
    deleted: true,
    run_id: runId,
    ...runListPayload(id, cat, { simulation_id: simulationId || rec.simulation_id }),
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

function persistRunDoc(projectId, doc) {
  const runsDirPath = runsDir(projectId);
  mkdirSync(runsDirPath, { recursive: true });
  const cat = upsertCatalogRun(projectId, doc);
  const named = (cat.runs.find((r) => String(r.id) === String(doc.run_id)) || {}).name;
  const withName = named ? { ...doc, name: named } : doc;
  if (doc.run_id) writeJson(runSidecarPath(projectId, doc.run_id), withName);
  const projPath = join(projectDir(projectId), 'project.json');
  if (existsSync(projPath)) {
    try {
      const proj = JSON.parse(readFileSync(projPath, 'utf8'));
      proj.run_1 = {
        run_id: withName.run_id,
        name: withName.name || null,
        status: withName.status,
        pid: withName.pid,
        case_dir: withName.case_dir,
        log_path: withName.log_path,
        increment: INCREMENT,
        updated_at: withName.finished_at || withName.started_at,
      };
      proj.updated_at = new Date().toISOString();
      writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf8');
    } catch {}
  }
}

function buildSolveScript({ runId, wslWinOut, wslRunCase, nProcs, solver }) {
  const n = Math.max(1, Number(nProcs) || 1);
  // simpleFoam (steady) or pimpleFoam (transient). The W27_SIMPLEFOAM_* stage
  // markers are kept verbatim for both: the progress parser keys on them.
  const app = solver === 'pimpleFoam' ? 'pimpleFoam' : 'simpleFoam';
  return `#!/usr/bin/env bash
set -uo pipefail
DST="${wslRunCase}"
WIN_OUT="${wslWinOut}"
NPROCS="${n}"
RUN_ID="${runId}"
APP="${app}"
echo "W27_RUN_START run_id=$RUN_ID bash_pid=$$ dst=$DST nprocs=$NPROCS app=$APP increment=W27"
if [ ! -d "$WIN_OUT/constant/polyMesh" ]; then
  echo "W27_MESH_FAIL missing polyMesh in $WIN_OUT"
  echo "W27_RUN_END exit=46"
  exit 46
fi
rm -rf "$DST"
mkdir -p "$DST"
cp -a "$WIN_OUT/." "$DST/"
cd "$DST" || exit 47
echo "W27_CWD=$(pwd)"
EC=0

# ---- Live results ---------------------------------------------------------
# While the solver runs, finished time directories are reconstructed (parallel)
# and copied to the Windows run folder, so Results can be opened mid-run. A
# time directory counts as finished once the solver has moved on to a later
# one, or nothing in it has changed for SYNC_SETTLE seconds. Each frame lands
# under a temporary name and is renamed into place, so the UI never sees a
# half-copied folder.
SYNC_EVERY=10
SYNC_SETTLE_MIN=0.2
sync_results() {
  local src="$DST"
  [ "$NPROCS" -gt 1 ] && src="$DST/processor0"
  local newest="" t d
  local list=()
  for d in "$src"/[0-9]*; do
    [ -d "$d" ] || continue
    t=$(basename "$d")
    [ "$t" = "0" ] && continue
    list+=("$t")
    if [ -z "$newest" ] || awk -v a="$t" -v b="$newest" 'BEGIN{exit !(a+0 > b+0)}'; then newest="$t"; fi
  done
  [ "\${#list[@]}" -gt 0 ] || return 0
  local todo=()
  for t in "\${list[@]}"; do
    [ -d "$WIN_OUT/$t" ] && continue
    if [ "$NPROCS" -gt 1 ]; then
      # Every rank must have written this time, and none may still be writing it.
      [ "$(ls -d "$DST"/processor*/"$t" 2>/dev/null | wc -l)" -ge "$NPROCS" ] || continue
      [ -z "$(find "$DST"/processor*/"$t" -type f -mmin -$SYNC_SETTLE_MIN -print -quit 2>/dev/null)" ] || continue
    elif [ "$t" = "$newest" ]; then
      # Still being written? (any file touched in the last ~12 s)
      [ -z "$(find "$src/$t" -type f -mmin -$SYNC_SETTLE_MIN -print -quit 2>/dev/null)" ] || continue
    fi
    todo+=("$t")
  done
  [ "\${#todo[@]}" -gt 0 ] || return 0
  if [ "$NPROCS" -gt 1 ]; then
    local tl; tl=$(IFS=,; echo "\${todo[*]}")
    openfoam2606 bash -c "cd '$DST' && reconstructPar -time '$tl'" >> log.reconstructPar.live 2>&1 || true
  fi
  for t in "\${todo[@]}"; do
    if [ ! -f "$DST/$t/U" ] && [ ! -f "$DST/$t/p" ]; then
      # Reconstruction did not produce fields: drop the stub so the final
      # reconstructPar redoes this time.
      [ "$NPROCS" -gt 1 ] && rm -rf "$DST/$t"
      continue
    fi
    rm -rf "$WIN_OUT/.sync_$t" 2>/dev/null
    local ok=0 tries=0
    if cp -a "$DST/$t" "$WIN_OUT/.sync_$t" 2>>log.livesync; then
      # The rename can be refused while a Windows process (indexer, watcher)
      # holds a handle inside the new folder; retry briefly.
      while [ "$tries" -lt 5 ]; do
        if mv "$WIN_OUT/.sync_$t" "$WIN_OUT/$t" 2>>log.livesync; then ok=1; break; fi
        tries=$((tries + 1))
        sleep 1
      done
    fi
    if [ "$ok" -eq 1 ]; then
      echo "W27_TIME_SAVED t=$t"
    else
      echo "W27_TIME_SYNC_RETRY t=$t" >> log.livesync
      rm -rf "$WIN_OUT/.sync_$t" 2>/dev/null
    fi
  done
  # Monitor histories (Graphs) update alongside the frames.
  if [ -d postProcessing ]; then cp -a postProcessing "$WIN_OUT/" 2>/dev/null || true; fi
  return 0
}
live_sync_loop() {
  local n=0
  while kill -0 "$1" 2>/dev/null; do
    sleep 2
    n=$((n + 2))
    if [ "$n" -ge "$SYNC_EVERY" ]; then n=0; sync_results; fi
  done
}

if [ "$NPROCS" -gt 1 ]; then
  echo "W27_DECOMPOSE_BEGIN n=$NPROCS"
  openfoam2606 bash -c "cd '$DST' && decomposePar -force" 2>&1 | tee log.decomposePar
  EC=\${PIPESTATUS[0]}
  echo "W27_DECOMPOSE_END exit=$EC"
  if [ "$EC" -ne 0 ]; then
    echo "W27_RUN_END exit=$EC"
    exit $EC
  fi
  echo "W27_SIMPLEFOAM_BEGIN parallel n=$NPROCS app=$APP"
  ( openfoam2606 bash -c "cd '$DST' && mpirun -np $NPROCS $APP -parallel" 2>&1 | tee "log.$APP"; exit "\${PIPESTATUS[0]}" ) &
  SOLVER_PID=$!
  live_sync_loop "$SOLVER_PID"
  wait "$SOLVER_PID"
  EC=$?
  echo "W27_SIMPLEFOAM_END exit=$EC"
  openfoam2606 bash -c "cd '$DST' && reconstructPar -newTimes" 2>&1 | tee log.reconstructPar || true
else
  echo "W27_SIMPLEFOAM_BEGIN serial app=$APP"
  ( openfoam2606 bash -c "cd '$DST' && $APP" 2>&1 | tee "log.$APP"; exit "\${PIPESTATUS[0]}" ) &
  SOLVER_PID=$!
  live_sync_loop "$SOLVER_PID"
  wait "$SOLVER_PID"
  EC=$?
  echo "W27_SIMPLEFOAM_END exit=$EC"
fi
mkdir -p "$WIN_OUT"
for d in "log.$APP" log.decomposePar log.reconstructPar log.reconstructPar.live log.livesync postProcessing; do
  [ -e "$d" ] && cp -a "$d" "$WIN_OUT/" 2>/dev/null || true
done
for d in [0-9]*; do
  [ -d "$d" ] || continue
  # Frames already copied live are complete; only bring over the rest.
  if [ "$d" != "0" ] && [ -d "$WIN_OUT/$d" ]; then continue; fi
  cp -a "$d" "$WIN_OUT/" 2>/dev/null || true
done
echo "W27_RUN_END exit=$EC win_out=$WIN_OUT"
exit $EC
`;
}

export function startSolve({ projectId, endTime, writeInterval, runId, transient: transientIn } = {}) {
  if (liveRun && liveRun.child && liveRun.child.exitCode == null && !liveRun.child.killed) {
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

  if (!runId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'Create a run first, then start it', increment: INCREMENT },
    };
  }

  const id = projectId || readActiveId();
  const cat = loadCatalog(id);
  const draft = cat.runs.find((r) => String(r.id) === String(runId)) || null;
  if (!draft) {
    return { ok: false, status: 404, bodyExtra: { error: 'Run not found', increment: INCREMENT } };
  }
  if (draft && draft.status === 'done') {
    return {
      ok: false,
      status: 409,
      bodyExtra: { error: 'This run already finished. Create a new run to solve again.', increment: INCREMENT },
    };
  }
  if (draft && draft.status === 'running') {
    return { ok: false, status: 409, bodyExtra: { error: 'This run is already running', increment: INCREMENT } };
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
    saveSimulationControl(id, { endTime: et, writeInterval: wi, transient: settings });
  } else {
    saveSimulationControl(id, { endTime: et, writeInterval: wi });
  }
  const solver = isTransient ? 'pimpleFoam' : 'simpleFoam';
  const nProcs = resolveNProcs(ready.mesh.n_cells, { transient: isTransient });
  const winOut = join(projectDir(id), 'runs', `run-${runId}`);
  mkdirSync(winOut, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  // Phase 1 land4: Python prepare_run writes the case; job-runner spawns run_solve.
  // writeSolveCase / buildSolveScript remain in this file until land5 soft-pass kill.
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
      return {
        ok: false,
        status: 500,
        bodyExtra: { error: 'Failed to prepare solve case: ' + errMsg, increment: INCREMENT },
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 500,
      bodyExtra: { error: 'Failed to prepare solve case: ' + String(err), increment: INCREMENT },
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
  };

  const { child, jobLog } = spawnJob({
    kind: 'solve',
    jobId: String(runId),
    script: pyTool('run_solve.py'),
    args: runSolveArgs,
    onEvent: (ev) => {
      if (liveRun && liveRun.progress) applyJobEvent(liveRun.progress, ev);
      try {
        const line =
          ev && ev.event === 'log' && ev.line
            ? String(ev.line) + '\n'
            : JSON.stringify(ev) + '\n';
        logBuf += line;
        writeFileSync(winLog, logBuf, 'utf8');
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

export function stopSolve({ projectId } = {}) {
  const id = projectId || readActiveId();
  const run = liveRun;
  if (!run || !run.child) {
    return {
      ok: false,
      status: 409,
      bodyExtra: { error: 'No run is in progress', increment: INCREMENT },
    };
  }
  const caseId = run.wsl_case || '';
  const caseQ = caseId.startsWith('/') ? caseId : wslCasePath(caseId);
  if (run.stop_requested) {
    // Second click: the graceful stop is still draining — force it.
    killSolveNow(run);
    return {
      ok: true,
      status: 200,
      bodyExtra: { ok: true, stopped: true, forced: true, run_id: run.run_id, increment: INCREMENT },
    };
  }
  // Graceful stop, like cancelling a SimScale run: ask simpleFoam to write the
  // current iteration and exit (controlDict is runTimeModifiable), so the solve
  // script still reconstructs and copies the partial results back. If the
  // solver has not exited after the grace period, kill it.
  run.stop_requested = true;
  run.stop_requested_at = Date.now();
  try {
    spawn(
      PYTHON,
      [pyTool('stop_solve.py'), '--wsl-case', caseId, '--run-id', String(run.run_id || '')],
      { windowsHide: true, stdio: 'ignore' }
    );
  } catch {
    try {
      spawn(
        'wsl',
        [
          '-d',
          WSL_DISTRO,
          '--',
          'bash',
          '-lc',
          `sed -i 's/^stopAt .*/stopAt          writeNow;/' ${JSON.stringify(caseQ + '/system/controlDict')} 2>/dev/null || true`,
        ],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch {}
  }
  run.stop_timer = setTimeout(() => {
    if (liveRun === run && run.child && run.child.exitCode == null) killSolveNow(run);
  }, STOP_GRACE_MS);
  const doc = (id && run.run_id && loadRunDoc(id, run.run_id)) || {};
  persistRunDoc(id || run.project_id, {
    ...doc,
    status: 'running',
    stage: 'stopping',
    stop_requested: true,
    note: 'Stopping — writing the current iteration.',
    increment: INCREMENT,
  });
  return {
    ok: true,
    status: 200,
    bodyExtra: { ok: true, stopping: true, run_id: run.run_id, increment: INCREMENT },
  };
}

const STOP_GRACE_MS = 120000;

function killSolveNow(run) {
  const caseId = run.wsl_case || '';
  const caseQ = caseId.startsWith('/') ? caseId : wslCasePath(caseId);
  try {
    run.child.kill();
  } catch {}
  try {
    spawn(
      PYTHON,
      [pyTool('stop_solve.py'), '--wsl-case', caseId, '--run-id', String(run.run_id || ''), '--force'],
      { windowsHide: true, stdio: 'ignore' }
    );
  } catch {
    try {
      spawn(
        'wsl',
        [
          '-d',
          WSL_DISTRO,
          '--',
          'bash',
          '-lc',
          `pkill -f ${JSON.stringify(caseQ)} 2>/dev/null || true; pkill -f ${JSON.stringify('cfddesk-w27-' + run.run_id)} 2>/dev/null || true`,
        ],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch {}
  }
}

// Saved iteration folders (numeric, > 0) in the Windows-side run case.
function listSavedTimes(caseDir) {
  try {
    if (!caseDir || !existsSync(caseDir)) return [];
    return readdirSync(caseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+(\.\d+)?(?:[eE][+-]?\d+)?$/.test(d.name))
      // A directory is a saved time once its fields are in it (the live copy
      // lands atomically, but a hand-copied folder may still be filling).
      .filter((d) => existsSync(join(caseDir, d.name, 'U')) || existsSync(join(caseDir, d.name, 'p')))
      .map((d) => Number(d.name))
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

export function getRunStatus(projectId, runId, simulationId) {
  const id = projectId || readActiveId();
  const ctrl = getSimulationControl(id);
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
  const cat = loadCatalog(id);
  for (const rec of cat.runs || []) {
    if (rec && rec.mesh_id && !rec.mesh_name) {
      const hit = meshes.find((m) => String(m.id) === String(rec.mesh_id));
      if (hit) rec.mesh_name = hit.name;
    }
  }
  const liveId = liveRun && liveRun.run_id;
  const scopedRuns = runsForActiveStudy(id, cat.runs, simulationId);
  const inScope = (rid) =>
    rid && scopedRuns.some((r) => r && String(r.id) === String(rid));
  const wantId =
    (runId && inScope(runId) && runId) ||
    (liveId && inScope(liveId) && liveId) ||
    (cat.active_id && inScope(cat.active_id) && cat.active_id) ||
    null;
  const doc = wantId ? loadRunDoc(id, wantId) : null;
  if (doc && doc.status === 'running' && runLivePid() == null && doc.finished_at == null) {
    // process gone without exit handler — leave as-is; client will keep polling
  }
  const rec = (cat.runs || []).find((r) => doc && String(r.id) === String(doc.run_id));
  const projTransient = projectIsTransient(id, simulationId);
  const run = enrichRunDoc(doc ? { ...doc, name: (doc && doc.name) || (rec && rec.name) || null } : doc);
  // The tree reads the catalog entry: mirror the live saved-frame count onto
  // it so the Results node opens as soon as the first frame is copied.
  if (rec && run && run.status === 'running' && run.n_saved_times != null) {
    rec.has_results = !!run.has_results;
    rec.last_saved_iteration = run.last_saved_iteration;
    rec.n_saved_times = run.n_saved_times;
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project_id: id,
      run,
      runs: scopedRuns,
      meshes,
      active_run_id: wantId || null,
      live_run_id: liveId || null,
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
      const saved = saveSimulationControl(body.project_id || u.searchParams.get('project_id'), body);
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
      });
      if (!started.ok) {
        return sendJson(res, started.status, { ok: false, ...(started.bodyExtra || {}) });
      }
      res.setHeader('X-CFD-Increment', INCREMENT);
      return sendJson(res, started.status, { ok: true, ...started.bodyExtra });
    }
    if (req.method === 'POST' && b === 'stop') {
      const stopped = stopSolve({ projectId: u.searchParams.get('project_id') });
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
      const created = createDraftRun({
        projectId: body.project_id || u.searchParams.get('project_id'),
        name: body.name,
        simulationId: body.simulation_id || u.searchParams.get('simulation_id'),
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
      const updated = updateRunSettings(id, body);
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
      const deleted = deleteCatalogRun(id, body.run_id || body.id, body.simulation_id);
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
      const renamed = renameCatalogRun(id, body.run_id || body.id, body.name, body.simulation_id);
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
      const cat = loadCatalog(id);
      if (!(cat.runs || []).some((r) => String(r.id) === String(runId))) {
        return sendJson(res, 404, { ok: false, error: 'Run not found', increment: INCREMENT });
      }
      cat.active_id = runId;
      saveCatalog(id, cat);
      const st = getRunStatus(id, runId, body.simulation_id || u.searchParams.get('simulation_id'));
      return sendJson(res, 200, st.body);
    }
    return false;
  }

  return false;
}
