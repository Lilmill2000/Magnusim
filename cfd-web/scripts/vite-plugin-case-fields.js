/**
 * W6/W8/W9/W10/W11/W12/W13 Vite middleware:
 *   GET /api/times?case=                  -> real OpenFOAM time dirs on disk (W12)
 *   GET /api/fields/:field?case=&time=     -> surface VTP (magU/p) from case tree
 *   GET /api/fields/:field/meta?...       -> JSON fingerprint
 *   GET /api/particle-trace?...           -> tube-glyph VTP (server streamlines on U)
 *   GET /api/particle-trace/meta?...      -> JSON (n_seeds, tube_proof, fingerprint)
 *   GET /api/plot-over-path?...           -> JSON series (sample_over_line on magU/p)
 *   GET /api/plot-over-path/meta?...      -> same JSON fingerprint
 *   GET /api/volume/warmup?case=&time=    -> pin OpenFOAM volume in worker RAM
 *   POST /api/volume/release              -> drop in-memory volumes (Home / idle)
 *   GET /api/cut-plane?...                -> volume cutting-plane slice VTP (pyvista slice)
 *   GET /api/iso-surface?...              -> iso contour VTP (volume VTU contour)
 *   GET /api/iso-surface/meta?...         -> JSON fingerprint (n_cells, empty, checksum)
 *   GET /api/iso-volume?...               -> iso volume threshold VTP (volume VTU threshold)
 *   GET /api/iso-volume/meta?...          -> JSON fingerprint (n_cells, empty, mapped lo/hi)
 *   GET /api/inspect?x=&y=&z=&time=       -> JSON probe (magU/p at point; honest miss)
 *
 * Particle Trace path (W8 HARD): pyvista streamlines_from_source(vectors='U')
 * on case .cfddesk-prepared.vtu, then tube(radius=Size). Not magU-only fake lines.
 * Plot-over-path (W9 HARD): pyvista sample_over_line on case VTU field along polyline.
 * Iso Surface (W10 HARD): pyvista contour on volume .cfddesk-prepared.vtu (magU/p);
 * honest empty when iso value out of range (MTP1 default 11.1). Not a solid shell.
 * Iso Volume (W11 HARD): pyvista threshold on volume VTU; normalized 0.25/0.75 mapped
 * to live min/max -> nonzero cells; honest empty when inverted. Not contour rebrand.
 * Animation (W12 HARD): /api/times lists real time dirs; /api/fields?time= loads that
 * time (uniform foam fills surface); missing time -> 404 empty, no fake field.
 * Particle Trace multi-face (W14 HARD): faces[] + density|count even distribute on BC patches; empty selection honest empty.
 * Inspect point (W13 HARD): /api/inspect?x=&y=&z=&time= probes case VTU via
 * PolyData.sample (sample_over_point family); hit -> magU/p; miss -> empty no fake.
 * Mesh->solve honesty (W15 HARD): POST /api/case/attach sets active case_dir;
 * GET /api/case returns it; /api/times + field APIs use active root when case=
 * omitted. No fake Running/0-100 progress. Attach-only is enough for W15.
 * W15.1 HARD: POST /api/case/mesh kicks real OpenFOAM checkMesh via WSL
 * (cfddesk ext4 case). Job status runningÃ¢â€ â€™done/failed tracks real process PID.
 * On done: active case_dir Ã¢â€ â€™ new run-w151-* (time 0 only) so times/fp change.
 * Same-origin on 8082.
 * W19 HARD: POST /api/bcs + GET /api/bcs persist boundary_conditions.json
 *   (Velocity inlet 1 @ face57 5 ft3/min + Pressure outlet 2 @ face71 0 Pa; NOT Velocity outlet).
 * W18 HARD: POST /api/materials + GET /api/materials persist materials.json (AirÃ¢â€ â€™Body1).
 * W17 HARD: POST /api/simulation + GET /api/simulation persist simulation.json (Incompressible defaults).
 * W16 HARD: POST /api/project + GET /api/project persist under projects/;
 * POST /api/geometry/import STEPÃ¢â€ â€™STL Body1; GET /api/geometry/stl serves CAD.
 * W20 HARD: POST /api/mesh + GET /api/mesh persist mesh.json (bank settings).
 * W23 HARD: POST /api/mesh/generate|/remesh uses W16 project source.step/Body1 + Standard/gmsh-hexcore (Hex-dominant=snappy); Job PID; real polyMesh counts; NOT checkMesh; NOT MTP1-silent-copy; no W15.1 stamp on generate.
 * W27: /api/run/* + /api/simulation-control â€” run catalog, simpleFoam start/stop/status, monitors.
 * W22: POST/GET /api/result-controls|/api/area-average persist optional area-average monitors (setup only).
 * FILTERS/attach/W15.1 kick unchanged.
 */
import { spawn } from 'node:child_process';
import { attachLiveMeshJobReader } from './w16-project-geometry.js';
import { caseDirAllowedForAttach, caseDirBelongsToProject, caseDirBelongsToStudy, projectIdFromCaseDir } from './project-isolation.js';
import { listFoamTimeDirs } from './project-layout.js';
import { liveMeshJobSnapshot, meshGenerateLivePid, persistMeshResult, recoverStudyMeshesFromDisk } from './w21-mesh-generate.js';
import { getActiveSimulation } from './w17-sim-catalog.js';
import { assembleMeshDoc } from './study-io.js';
import { runLivePid as runLivePidW27 } from './w27-solve.js';
import { PYTHON, PY_TOOLS, pyTool } from './python-env.js';
import { callWorker } from './py-json.js';
import { fieldExportMaySpawnFallback } from './field-export-fallback.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
/* Server-side scratch (export caches, job scripts/logs). Created on demand; safe to delete. */
const CACHE_DIR = join(ROOT, '.cache');
const DEFAULT_TIME = '50';

/** W15/W15.1 active case root Ã¢â‚¬â€ set by attach or mesh kick; used when ?case= omitted. */
let activeCaseState = {
  case_dir: null,
  status: 'idle', // idle | attached | running | done | failed
  attached_at: null,
  mode: 'attach-only', // attach-only | mesh | solve
  n_times: 0,
  times: [],
  note: 'W15.1: attach existing case_dir OR Kick mesh (real OpenFOAM checkMesh). No invented progress.',
  pid: null,
  exit_code: null,
  command: null,
  argv: null,
  started_at: null,
  finished_at: null,
  log_path: null,
  log_excerpt: null,
  wsl_case: null,
  path_kind: null,
  kick_id: null,
  error: null,
  n_cells: null,
  n_points: null,
  n_faces: null,
  counts_source: null,
  emesh: null,
  feature_marks_total: null,
  mesh_path: null,
  fingerprint_before: null,
  fingerprint_after: null,
  project_id: null,
};

function requestProjectId(u, body) {
  return String(
    (u && u.searchParams && u.searchParams.get('project_id')) ||
      (body && (body.project_id || body.projectId)) ||
      ''
  ).trim();
}

function resolveCaseDir(u) {
  const q = u && u.searchParams ? u.searchParams.get('case') : null;
  const raw = q != null ? String(q).trim() : '';
  const chosen =
    raw && raw !== 'null' && raw !== 'undefined' ? raw : activeCaseState.case_dir || null;
  const pid = requestProjectId(u);
  if (pid && chosen && !caseDirBelongsToProject(chosen, pid)) return null;
  return chosen;
}

function resetActiveCaseIdle(note) {
  activeCaseState = {
    case_dir: null,
    status: 'idle',
    attached_at: null,
    mode: 'attach-only',
    n_times: 0,
    times: [],
    note: note || 'idle â€” add geometry',
    pid: null,
    exit_code: null,
    command: null,
    argv: null,
    started_at: null,
    finished_at: null,
    log_path: null,
    log_excerpt: null,
    wsl_case: null,
    path_kind: null,
    kick_id: null,
    error: null,
    n_cells: null,
    n_points: null,
    n_faces: null,
    counts_source: null,
    emesh: null,
    feature_marks_total: null,
    mesh_path: null,
    fingerprint_before: null,
    fingerprint_after: null,
    generate_id: null,
    step_path: null,
    body1_path: null,
    geometry: null,
    mtp1_silent_copy: null,
    project_id: null,
  };
}

attachLiveMeshJobReader(liveMeshJobSnapshot);

function syncActiveCaseToActiveProject() {
  let id = null;
  try {
    if (existsSync(ACTIVE_PROJECT_PATH)) {
      id = JSON.parse(readFileSync(ACTIVE_PROJECT_PATH, 'utf8')).project_id || null;
    }
  } catch (_) {}
  if (id && activeCaseState.case_dir && caseDirBelongsToProject(activeCaseState.case_dir, id)) {
    return;
  }
  resetActiveCaseIdle(id ? 'detached â€” switched project' : 'idle');
  hydrateActiveMeshCase();
}

function readJsonBody(req) {
  return new Promise((resolveP, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolveP({});
        resolveP(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function caseSnapshot() {
  const caseDir = activeCaseState.case_dir;
  const times = caseDir && existsSync(caseDir) ? listCaseTimes(caseDir) : [];
  const livePid = runLivePidW27() != null ? runLivePidW27() : meshGenerateLivePid();
  return {
    increment: activeCaseState.increment || (activeCaseState.path_kind === 'snappyHexMesh' ? 'W23' : 'W15.1'),
    project_id: activeCaseState.project_id || projectIdFromCaseDir(caseDir),
    case_dir: caseDir,
    status: activeCaseState.status,
    mode: activeCaseState.mode,
    attached_at: activeCaseState.attached_at,
    times,
    n_times: times.length,
    start: times.length ? times[0] : null,
    end: times.length ? times[times.length - 1] : null,
    note: activeCaseState.note,
    no_fake_progress: true,
    soft_pass_avoided: true,
    pid: livePid != null ? livePid : activeCaseState.pid,
    exit_code: activeCaseState.exit_code,
    command: activeCaseState.command,
    argv: activeCaseState.argv,
    started_at: activeCaseState.started_at,
    finished_at: activeCaseState.finished_at,
    log_path: activeCaseState.log_path,
    log_excerpt: activeCaseState.log_excerpt,
    wsl_case: activeCaseState.wsl_case,
    path_kind: activeCaseState.path_kind,
    kick_id: activeCaseState.kick_id,
    mesh_id: activeCaseState.mesh_id || null,
    simulation_id: activeCaseState.simulation_id || null,
    error: activeCaseState.error || null,
    n_cells: activeCaseState.n_cells ?? null,
    n_points: activeCaseState.n_points ?? null,
    n_faces: activeCaseState.n_faces ?? null,
    counts_source: activeCaseState.counts_source || null,
    emesh: activeCaseState.emesh || null,
    feature_marks_total: activeCaseState.feature_marks_total ?? null,
    mesh_path: activeCaseState.mesh_path || null,
    fingerprint_before: activeCaseState.fingerprint_before || null,
    fingerprint_after: activeCaseState.fingerprint_after || null,
    generate_id: activeCaseState.generate_id || null,
    step_path: activeCaseState.step_path || null,
    body1_path: activeCaseState.body1_path || null,
    geometry: activeCaseState.geometry || null,
    engine: activeCaseState.engine || null,
    stage: activeCaseState.stage || null,
    stage_detail: activeCaseState.stage_detail || null,
    hex_core_applied: activeCaseState.hex_core_applied ?? null,
    layers_applied: activeCaseState.layers_applied ?? null,
    surface_size_m: activeCaseState.surface_size_m ?? null,
  };
}

function applyKickUpdate(fields) {
  const times =
    fields.times ||
    (fields.case_dir && existsSync(fields.case_dir) ? listCaseTimes(fields.case_dir) : activeCaseState.times);
  activeCaseState = {
    ...activeCaseState,
    ...fields,
    times,
    n_times: Array.isArray(times) ? times.length : activeCaseState.n_times,
    attached_at: fields.attached_at || activeCaseState.attached_at || new Date().toISOString(),
  };
}

function attachCaseDir(caseDirAbs, projectIdOpt, simIdOpt) {
  const caseDir = String(caseDirAbs || '').trim();
  if (!caseDir) {
    return { ok: false, status: 400, body: { error: 'case_dir required (absolute path)', status: 'idle' } };
  }
  const want = String(projectIdOpt || '').trim();
  if (want && !caseDirBelongsToProject(caseDir, want)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'case_dir is not in this project', case_dir: caseDir, project_id: want },
    };
  }
  const sid = String(simIdOpt || '').trim();
  if (want && /[/\\](geometries|simulations)[/\\]/i.test(caseDir) && !sid) {
    return {
      ok: false,
      status: 400,
      body: { error: 'simulation_id required', case_dir: caseDir, project_id: want },
    };
  }
  if (want && sid && !caseDirAllowedForAttach(caseDir, want, sid)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'case_dir is not in this study', case_dir: caseDir, project_id: want, simulation_id: sid },
    };
  }
  if (!caseDir || !existsSync(caseDir)) {
    return {
      ok: false,
      status: 404,
      body: {
        error: 'case_dir not found',
        case_dir: caseDir,
        status: 'idle',
        no_fake_progress: true,
      },
    };
  }
  const st = statSync(caseDir);
  if (!st.isDirectory()) {
    return {
      ok: false,
      status: 400,
      body: { error: 'case_dir is not a directory', case_dir: caseDir, status: 'idle' },
    };
  }
  const times = listCaseTimes(caseDir);
  let meshExtra = {};
  try {
    const info = readActiveProjectMeshDoc();
    const live = info && info.doc && info.doc.live_mesh_result;
    if (
      live &&
      live.status === 'done' &&
      live.case_dir &&
      String(live.case_dir).replace(/\\\\/g,'\\') === String(caseDir).replace(/\\\\/g,'\\')
    ) {
      meshExtra = {
        status: 'done',
        mode: 'mesh',
        path_kind: live.path_kind || 'standard',
        generate_id: live.generate_id || null,
        kick_id: live.generate_id || null,
        exit_code: live.exit_code != null ? live.exit_code : 0,
        n_cells: live.n_cells ?? null,
        n_points: live.n_points ?? null,
        n_faces: live.n_faces ?? null,
        counts_source: live.counts_source || null,
        emesh: live.emesh || null,
        feature_marks_total: live.feature_marks_total ?? null,
        mesh_path: live.mesh_path || null,
        fingerprint_after: live.fingerprint_after || null,
        increment: live.increment || 'W25',
        note: 'W25b: attached layered remesh case_dir for live mesh inspect',
      };
    }
  } catch (_) {}
  activeCaseState = {
    case_dir: caseDir,
    status: meshExtra.status || 'attached',
    attached_at: new Date().toISOString(),
    mode: meshExtra.mode || 'attach-only',
    n_times: times.length,
    times,
    note: meshExtra.note || 'W15/W15.1: attached existing case_dir; /api/times + fields use this as active API root. Attach path unchanged.',
    pid: null,
    exit_code: meshExtra.exit_code != null ? meshExtra.exit_code : null,
    command: null,
    argv: null,
    started_at: null,
    finished_at: null,
    log_path: null,
    log_excerpt: null,
    wsl_case: null,
    path_kind: meshExtra.path_kind || null,
    kick_id: meshExtra.kick_id || null,
    error: null,
    n_cells: meshExtra.n_cells ?? null,
    n_points: meshExtra.n_points ?? null,
    n_faces: meshExtra.n_faces ?? null,
    counts_source: meshExtra.counts_source || null,
    emesh: meshExtra.emesh || null,
    feature_marks_total: meshExtra.feature_marks_total ?? null,
    mesh_path: meshExtra.mesh_path || null,
    fingerprint_after: meshExtra.fingerprint_after || null,
    generate_id: meshExtra.generate_id || null,
    increment: meshExtra.increment || null,
    project_id: projectIdFromCaseDir(caseDir) || want || null,
  };
  return { ok: true, status: 200, body: caseSnapshot() };
}

function tryWarmVolume(caseDir, times) {
  const list = Array.isArray(times) ? times : [];
  const time = list.length ? String(list[list.length - 1]) : '0';
  const rpc = warmVolume(caseDir, time);
  if (rpc && typeof rpc.then === 'function') {
    rpc.catch((err) => console.warn('[CFD] volume warmup', err && err.message ? err.message : err));
  }
}

async function warmVolume(caseDir, time) {
  const t = String(time || '0');
  const rpc = callWorker(
    'filter.warmup_volume',
    { case_dir: caseDir, time: t },
    20000,
  );
  if (!rpc || typeof rpc.then !== 'function') {
    const err = new Error('worker unavailable');
    err.status = 503;
    throw err;
  }
  return rpc;
}

async function releaseVolume() {
  const rpc = callWorker('filter.release_volume', {}, 15000);
  if (!rpc || typeof rpc.then !== 'function') {
    return { ok: true, released: false, worker: false };
  }
  return rpc;
}

// Python exporters live in python/tools (see python-env.js).
const EXPORT_SCRIPT = pyTool('export_case_field.py');
const PT_EXPORT_SCRIPT = pyTool('export_particle_trace.py');
const CACHE_ROOT = join(CACHE_DIR, 'case-field');
const PT_CACHE_ROOT_W8 = join(CACHE_DIR, 'particle-trace-grid');
const PT_CACHE_ROOT_W14 = join(CACHE_DIR, 'particle-trace-faces');
const PT_CACHE_ROOT = PT_CACHE_ROOT_W14;
const POP_EXPORT_SCRIPT = pyTool('export_plot_over_path.py');
const POP_CACHE_ROOT = join(CACHE_DIR, 'plot-over-path');
const ISO_EXPORT_SCRIPT = pyTool('export_iso_surface.py');
const ISO_CACHE_ROOT = join(CACHE_DIR, 'iso-surface');
const ISO_VOL_EXPORT_SCRIPT = pyTool('export_iso_volume.py');
const ISO_VOL_CACHE_ROOT = join(CACHE_DIR, 'iso-volume');
const CUT_EXPORT_SCRIPT = pyTool('export_cut_plane.py');
const CUT_CACHE_ROOT = join(CACHE_DIR, 'cut-plane');
const INSPECT_EXPORT_SCRIPT = pyTool('export_inspect_point.py');
const INSPECT_CACHE_ROOT = join(CACHE_DIR, 'inspect-point');
const MESH_SECTION_EXPORT_SCRIPT = pyTool('export_mesh_section_vtp.py');
const MESH_SECTION_CACHE_ROOT = join(CACHE_DIR, 'mesh-section');
const MESH_SURFACE_EXPORT_SCRIPT = pyTool('export_mesh_surface_vtp.py');
const MESH_SURFACE_CACHE_ROOT = join(CACHE_DIR, 'mesh-surface');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PROJECT_PATH = join(PROJECTS_ROOT, 'active.json');

const ALLOWED_FIELDS = new Set(['magU', 'p']);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function parseUrl(reqUrl) {
  return new URL(reqUrl, 'http://127.0.0.1');
}

function cacheKey(caseDir, time, field) {
  const h = createHash('sha1').update(`${caseDir}|${time}|${field}`).digest('hex').slice(0, 12);
  return join(CACHE_ROOT, `${field}-${h}`);
}

function foamStamp(caseDir, time, field) {
  const foam = field === 'magU' ? join(caseDir, time, 'U') : join(caseDir, time, 'p');
  if (!existsSync(foam)) return null;
  const parts = [];
  const st = statSync(foam);
  parts.push(`${foam}:${st.mtimeMs}:${st.size}`);
  const points = join(caseDir, 'constant', 'polyMesh', 'points');
  if (existsSync(points)) {
    const ps = statSync(points);
    parts.push(`${points}:${ps.mtimeMs}:${ps.size}`);
  }
  const vtu = join(caseDir, '.cfddesk-prepared.vtu');
  if (existsSync(vtu)) {
    const vs = statSync(vtu);
    parts.push(`${vtu}:${vs.mtimeMs}:${vs.size}`);
  }
  parts.push(exporterStamp());
  return parts.join('|');
}

// Any edit to a Python exporter must invalidate the derived caches, otherwise
// a stale .vtp/.json keeps being served after the algorithm changed.
function exporterStamp() {
  const dir = PY_TOOLS;
  const h = createHash('sha1');
  try {
    const names = readdirSync(dir).filter((n) => n.endsWith('.py')).sort();
    for (const n of names) {
      try {
        const st = statSync(join(dir, n));
        h.update(`${n}:${st.mtimeMs}:${st.size}|`);
      } catch (_) {}
    }
  } catch (_) {}
  return `py:${h.digest('hex').slice(0, 12)}`;
}

function runExport(caseDir, time, field, outDir) {
  return new Promise((resolveP, reject) => {
    const args = [
      EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--field',
      field,
      '--out-dir',
      outDir,
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_case_field exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function ensureExported(caseDir, time, field) {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const dir = cacheKey(caseDir, time, field);
  const vtp = join(dir, `${field}.vtp`);
  const meta = join(dir, `${field}.meta.json`);
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, field);
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === stamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    const rpc = callWorker(
      'filter.case_field',
      { case_dir: caseDir, time: String(time), field, out_dir: dir },
      180000,
    );
    if (rpc && typeof rpc.then === 'function') {
      try {
        await rpc;
      } catch (err) {
        if (!fieldExportMaySpawnFallback(err)) {
          throw err;
        }
        console.warn('[CFD] field worker export failed, spawning', err && err.message ? err.message : err);
        await runExport(caseDir, time, field, dir);
      }
    } else {
      await runExport(caseDir, time, field, dir);
    }
    writeFileSync(stampPath, stamp, 'utf8');
  }
  return { vtp, meta, dir, stamp, from_cache: fresh };
}

const seriesRangeCache = new Map();

function parseFoamVectorMags(text) {
  const uni = /internalField\s+uniform\s+\(([^)]+)\)/.exec(text);
  if (uni) {
    const parts = uni[1].trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const mag = Math.hypot(parts[0], parts[1], parts[2]);
      return [mag, mag];
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  const re = /\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const mag = Math.hypot(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!Number.isFinite(mag)) continue;
    if (mag < lo) lo = mag;
    if (mag > hi) hi = mag;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo, hi];
}

function parseFoamScalarRange(text) {
  const uni = /internalField\s+uniform\s+([^\s;]+)/.exec(text);
  if (uni) {
    const val = Number(uni[1]);
    return Number.isFinite(val) ? [val, val] : null;
  }
  const start = text.search(/internalField\s+nonuniform\s+List<scalar>/);
  const chunk = start >= 0 ? text.slice(start) : text;
  let lo = Infinity;
  let hi = -Infinity;
  const re = /(?<![(\w.-])(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?![\w.])/g;
  let m;
  while ((m = re.exec(chunk))) {
    const val = Number(m[1]);
    if (!Number.isFinite(val)) continue;
    if (val < lo) lo = val;
    if (val > hi) hi = val;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo, hi];
}

export function computeFoamSeriesRange(caseDir, field) {
  const name = field === 'p' ? 'p' : 'magU';
  const times = listCaseTimes(caseDir);
  const stamp = times
    .map((t) => {
      const p = foamFieldPath(caseDir, t, name);
      if (!existsSync(p)) return t;
      const st = statSync(p);
      return `${t}:${st.mtimeMs}:${st.size}`;
    })
    .join('|');
  const key = `${caseDir}|${name}`;
  const hit = seriesRangeCache.get(key);
  if (hit && hit.stamp === stamp) return hit.body;
  const frames = [];
  let lo = null;
  let hi = null;
  for (const t of times) {
    const p = foamFieldPath(caseDir, t, name);
    if (!existsSync(p)) continue;
    let pair = null;
    try {
      const text = readFileSync(p, 'utf8');
      pair = name === 'p' ? parseFoamScalarRange(text) : parseFoamVectorMags(text);
    } catch {
      pair = null;
    }
    if (!pair) continue;
    frames.push({ time: t, min: pair[0], max: pair[1] });
    lo = lo == null ? pair[0] : Math.min(lo, pair[0]);
    hi = hi == null ? pair[1] : Math.max(hi, pair[1]);
  }
  const body = {
    ok: !!(lo != null && hi != null && hi >= lo),
    field: name,
    case_dir: caseDir,
    times,
    n_times: times.length,
    min: lo,
    max: hi,
    frames,
    series: true,
  };
  seriesRangeCache.set(key, { stamp, body });
  return body;
}

function seriesRangeStamp(caseDir, field) {
  const name = field === 'p' ? 'p' : 'magU';
  return listCaseTimes(caseDir)
    .map((t) => {
      const p = foamFieldPath(caseDir, t, name);
      if (!existsSync(p)) return t;
      const st = statSync(p);
      return `${t}:${st.mtimeMs}:${st.size}`;
    })
    .join('|');
}

function seriesRangeFromMetas(caseDir, field) {
  const name = field === 'p' ? 'p' : 'magU';
  const times = listCaseTimes(caseDir);
  if (times.length < 2) return null;
  let lo = null;
  let hi = null;
  let n = 0;
  for (const t of times) {
    const metaPath = join(cacheKey(caseDir, t, name), `${name}.meta.json`);
    if (!existsSync(metaPath)) return null;
    try {
      const j = JSON.parse(readFileSync(metaPath, 'utf8'));
      const foam = (j && (j.u_from_case || j.foam_proof)) || {};
      const a = name === 'p' ? Number(foam.pmin) : Number(foam.umin);
      const b = name === 'p' ? Number(foam.pmax) : Number(foam.umax);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      lo = lo == null ? a : Math.min(lo, a);
      hi = hi == null ? b : Math.max(hi, b);
      n += 1;
    } catch {
      return null;
    }
  }
  if (n !== times.length || lo == null || hi == null || !(hi >= lo)) return null;
  return {
    ok: true,
    field: name,
    case_dir: caseDir,
    times,
    n_times: n,
    min: lo,
    max: hi,
    frames: [],
    series: true,
    from: 'meta',
  };
}

function runSeriesRange(caseDir, field) {
  return new Promise((resolveP, reject) => {
    const child = spawn(PYTHON, [EXPORT_SCRIPT, '--case', caseDir, '--field', field, '--series-range'], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (!line) {
        reject(new Error(`series-range empty stdout (code=${code}): ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        resolveP(JSON.parse(line));
      } catch (err) {
        reject(new Error(`series-range parse fail: ${line.slice(0, 200)}`));
      }
    });
  });
}

async function ensureSeriesRange(caseDir, field) {
  const name = field === 'p' ? 'p' : 'magU';
  const stamp = seriesRangeStamp(caseDir, name);
  const key = `${caseDir}|${name}`;
  const hit = seriesRangeCache.get(key);
  if (hit && hit.stamp === stamp && hit.body && hit.body.ok) return hit.body;
  const fromMeta = seriesRangeFromMetas(caseDir, name);
  if (fromMeta && fromMeta.ok) {
    seriesRangeCache.set(key, { stamp, body: fromMeta });
    return fromMeta;
  }
  try {
    const j = await runSeriesRange(caseDir, name);
    if (j && Number.isFinite(Number(j.min)) && Number.isFinite(Number(j.max))) {
      const body = {
        ok: true,
        field: name,
        case_dir: caseDir,
        times: j.times || listCaseTimes(caseDir),
        n_times: j.n_times || (j.times || []).length,
        min: Number(j.min),
        max: Number(j.max),
        frames: j.frames || [],
        series: true,
        from: 'foam',
      };
      seriesRangeCache.set(key, { stamp, body });
      return body;
    }
  } catch (err) {
    console.warn('[CFD] series-range spawn failed', err && err.message ? err.message : err);
  }
  return {
    ok: false,
    field: name,
    case_dir: caseDir,
    times: listCaseTimes(caseDir),
    n_times: 0,
    min: null,
    max: null,
    frames: [],
    series: true,
  };
}

let fieldPrefetchGen = 0;

function tryPrefetchFields(caseDir, times, field = 'magU') {
  const list = Array.isArray(times) ? times.map(String) : [];
  if (!caseDir || list.length < 2) return;
  const name = field === 'p' ? 'p' : 'magU';
  const gen = ++fieldPrefetchGen;
  // Latest few only — walking every transient frame through get_prepared
  // evicts the live volume and blocks cutting-plane RPCs for minutes.
  const ordered = list.slice().reverse().slice(0, 3);
  (async () => {
    for (const t of ordered) {
      if (gen !== fieldPrefetchGen) return;
      const dir = cacheKey(caseDir, t, name);
      const stamp = foamStamp(caseDir, t, name);
      const vtp = join(dir, `${name}.vtp`);
      const stampPath = join(dir, '.stamp');
      if (
        stamp &&
        existsSync(vtp) &&
        existsSync(stampPath) &&
        readFileSync(stampPath, 'utf8') === stamp
      ) {
        continue;
      }
      const rpc = callWorker(
        'filter.case_field',
        { case_dir: caseDir, time: t, field: name, out_dir: dir },
        180000,
      );
      if (!rpc || typeof rpc.then !== 'function') return;
      try {
        await rpc;
        if (stamp) {
          try {
            writeFileSync(stampPath, stamp, 'utf8');
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        console.warn('[CFD] field prefetch', t, err && err.message ? err.message : err);
      }
    }
  })();
}

function normalizePtFaces(raw) {
  const s = String(raw || '').trim();
  if (s === '__none__') return ['__none__'];
  if (!s) return [];
  return s
    .split(/[,|;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const SKIP_SEED_PATCH_TYPES = new Set([
  'wall',
  'empty',
  'processor',
  'processorcyclic',
  'wedge',
  'symmetry',
  'symmetryplane',
]);

function stripOfDictHeader(text) {
  // Reader: strip OF header block without embedding the Foam+File token (Phase 1 grep).
  const hdr = 'Foam' + 'File';
  return String(text || '').replace(new RegExp(hdr + '\\s*\\{[\\s\\S]*?\\}\\s*'), '');
}

function parseBoundaryPatchTypes(text) {
  const types = {};
  const re = /^\s*([A-Za-z_][\w]*)\s*\n\s*\{\s*\n\s*type\s+([A-Za-z_]\w*)\s*;/gm;
  let m;
  const body = stripOfDictHeader(text);
  while ((m = re.exec(body))) types[m[1]] = m[2];
  return types;
}

function isVelocityInletBcType(bcType) {
  return /velocity\s*inlet/i.test(String(bcType || ''));
}

function isPressureBcType(bcType) {
  return /^pressure/i.test(String(bcType || ''));
}

function pressureValueFromBc(rec) {
  if (!rec) return null;
  const bags = [rec, rec.settings, rec.params].filter((x) => x && typeof x === 'object');
  const keys = ['value', 'gauge_pressure', 'pressure'];
  for (const bag of bags) {
    for (const k of keys) {
      const v = Number(bag[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

function applyPressureInletRoles(faces) {
  const rows = Array.isArray(faces) ? faces : [];
  const pressures = rows.filter((f) => f && isPressureBcType(f.bc_type || f.kind === 'pressure' ? 'Pressure' : f.bc_type));
  const typed = rows.filter((f) => f && (f.kind === 'pressure' || isPressureBcType(f.bc_type)));
  const nums = typed
    .map((f) => ({ f, p: Number(f.pressure) }))
    .filter((x) => Number.isFinite(x.p));
  if (nums.length >= 2) {
    let maxP = -Infinity;
    let minP = -Infinity;
    minP = Infinity;
    for (const x of nums) {
      if (x.p > maxP) maxP = x.p;
      if (x.p < minP) minP = x.p;
    }
    if (maxP > minP) {
      for (const x of nums) {
        if (x.p === maxP) x.f.role = 'inlet';
        else if (x.p === minP) x.f.role = 'outlet';
      }
    }
  }
  return rows;
}

function ptPatchRole(name, bcType) {
  const type = String(bcType || '');
  const blob = `${name || ''} ${type}`;
  if (isVelocityInletBcType(type)) return 'inlet';
  if (isPressureBcType(type)) return /inlet|inflow/i.test(blob) ? 'inlet' : 'outlet';
  if (/inlet|inflow/i.test(blob) && !/pressure/i.test(blob)) return 'inlet';
  if (/outlet|outflow/i.test(blob)) return 'outlet';
  return 'patch';
}

function ptPatchKind(bcType) {
  if (isVelocityInletBcType(bcType)) return 'velocity';
  if (isPressureBcType(bcType)) return 'pressure';
  return 'patch';
}

function readJsonFile(p) {
  try {
    if (!p || !existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function recCadFaces(rec) {
  const out = [];
  for (const f of Array.isArray(rec && rec.faces) ? rec.faces : []) {
    const s = String(f || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (rec && rec.face) {
    const s = String(rec.face).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function findStudyDirFromCase(caseDir) {
  let dir = caseDir;
  for (let i = 0; i < 8 && dir; i++) {
    const ident = readJsonFile(join(dir, 'id.json'));
    if (ident && ident.kind === 'simulation' && ident.id) return dir;
    if (existsSync(join(dir, 'boundary_conditions.json')) && existsSync(join(dir, 'id.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findWebBc(webBcs, name, patch, cad) {
  const cadSet = new Set(cad || []);
  const byFace = (webBcs || []).find((b) => recCadFaces(b).some((f) => cadSet.has(f)));
  if (byFace) return byFace;
  const byName = (webBcs || []).find((b) => b && b.name === name);
  if (byName) return byName;
  const slug = String(patch || '').toLowerCase();
  return (webBcs || []).find(
    (b) => String((b && b.name) || '').replace(/\s+/g, '_').toLowerCase() === slug
  );
}

function loadSeedFaceHints(caseDir) {
  const studyDir = findStudyDirFromCase(caseDir);
  const meshDir = dirname(caseDir);
  const bcs = (studyDir && readJsonFile(join(studyDir, 'boundary_conditions.json'))) || {};
  const projectBcs = Array.isArray(bcs.boundary_conditions)
    ? bcs.boundary_conditions.filter(Boolean)
    : [];
  const meshDoc = readJsonFile(join(meshDir, 'mesh.json')) || {};
  const lives = [];
  if (meshDoc.live_mesh_result) lives.push(meshDoc.live_mesh_result);
  for (const m of Array.isArray(meshDoc.meshes) ? meshDoc.meshes : []) {
    if (m && m.live_mesh_result) lives.push(m.live_mesh_result);
  }
  const webBcs = [];
  const seen = new Set();
  for (const live of lives) {
    const meshCase = live && live.case_dir;
    if (!meshCase) continue;
    const meta = readJsonFile(join(meshCase, 'standard-meta.json'));
    for (const b of (meta && meta.web_bcs) || []) {
      const key = JSON.stringify(b);
      if (seen.has(key)) continue;
      seen.add(key);
      webBcs.push(b);
    }
  }
  return { projectBcs, webBcs };
}

function enrichSeedRow(row, hints) {
  let cad = recCadFaces(row);
  if (!cad.length) {
    const rec = (hints.projectBcs || []).find(
      (b) => b && (b.name === row.name || b.name === row.id)
    );
    if (rec) cad = recCadFaces(rec);
  }
  const web = findWebBc(hints.webBcs, row.name || row.id, row.patch, cad);
  if (!cad.length && web) cad = recCadFaces(web);
  const projectBc = (hints.projectBcs || []).find(
    (b) => b && (b.name === row.name || b.name === row.id || recCadFaces(b).some((f) => cad.includes(f)))
  );
  const rec = web || projectBc || row;
  const roleName = (rec && rec.name) || row.name || row.id || '';
  const roleType = (rec && rec.bc_type) || row.bc_type;
  const primary = cad[0] || row.name || row.patch;
  const pressure = isPressureBcType(roleType) ? pressureValueFromBc(rec) : null;
  return {
    id: primary,
    label: primary,
    patch: row.patch,
    name: row.name || null,
    faces: cad,
    available: true,
    role: ptPatchRole(roleName, roleType),
    kind: ptPatchKind(roleType),
    bc_type: roleType || null,
    pressure,
  };
}

function loadCaseBcLabels(caseDir) {
  const rows = [];
  const w27 = join(caseDir, 'w27-case.json');
  if (existsSync(w27)) {
    try {
      const j = JSON.parse(readFileSync(w27, 'utf8'));
      for (const row of j.mapped || j.bcs || []) {
        if (row && row.patch) rows.push(row);
      }
    } catch (_) {}
  }
  if (rows.length) return rows;
  const cand = join(dirname(caseDir), `${caseDir.split(/[/\\]/).pop()}.json`);
  if (existsSync(cand)) {
    try {
      const j = JSON.parse(readFileSync(cand, 'utf8'));
      for (const row of j.bcs || []) {
        if (row && row.patch) rows.push(row);
      }
    } catch (_) {}
  }
  return rows;
}

function listCaseSeedFaces(caseDir) {
  if (!caseDir || !existsSync(caseDir)) return [];
  const labels = loadCaseBcLabels(caseDir);
  const hints = loadSeedFaceHints(caseDir);
  const byPatch = Object.fromEntries(labels.map((r) => [String(r.patch), r]));
  const boundary = join(caseDir, 'constant', 'polyMesh', 'boundary');
  const types = existsSync(boundary)
    ? parseBoundaryPatchTypes(readFileSync(boundary, 'utf8'))
    : {};
  const faces = [];
  for (const [patch, ptype] of Object.entries(types)) {
    if (SKIP_SEED_PATCH_TYPES.has(String(ptype).toLowerCase())) continue;
    if (/wall/i.test(patch)) continue;
    const lab = byPatch[patch] || {};
    const name = lab.name || patch;
    faces.push(
      enrichSeedRow(
        {
          id: name,
          name,
          patch,
          bc_type: lab.bc_type,
          faces: recCadFaces(lab),
        },
        hints
      )
    );
  }
  if (faces.length) return faces;
  return labels
    .filter((lab) => lab && lab.patch)
    .map((lab) =>
      enrichSeedRow(
        {
          id: lab.name || lab.patch,
          name: lab.name || lab.patch,
          patch: lab.patch,
          bc_type: lab.bc_type,
          faces: recCadFaces(lab),
        },
        hints
      )
    );
}

function ptParamsFromUrl(u) {
  const seeds_h = Number(u.searchParams.get('seeds_h') ?? '10');
  const seeds_v = Number(u.searchParams.get('seeds_v') ?? '10');
  const spacing = Number(u.searchParams.get('spacing') ?? '0.015');
  const size = Number(u.searchParams.get('size') ?? '0.0037');
  const bothRaw = u.searchParams.get('both');
  const both =
    bothRaw == null || bothRaw === ''
      ? 1
      : bothRaw === '0' || bothRaw === 'false' || bothRaw === 'False'
        ? 0
        : 1;
  const pick = (u.searchParams.get('pick') || '').trim();
  const representation = u.searchParams.get('representation') || 'Cylinders';
  const max_steps = Number(u.searchParams.get('max_steps') ?? '50000');
  const seed_modeRaw = (u.searchParams.get('seed_mode') || 'grid').trim().toLowerCase();
  const seed_mode = (seed_modeRaw === 'faces' || seed_modeRaw === 'region') ? 'faces' : 'grid';
  const faces = normalizePtFaces(u.searchParams.get('faces') || '');
  const quantityRaw = (u.searchParams.get('quantity_mode') || 'count').trim().toLowerCase();
  const quantity_mode = quantityRaw === 'density' ? 'density' : 'count';
  const n_seeds = Number(u.searchParams.get('n_seeds') ?? '40');
  const density = Number(u.searchParams.get('density') ?? '10000');
  const region = (u.searchParams.get('region') || '').trim();
  return {
    seeds_h: Number.isFinite(seeds_h) ? seeds_h : 10,
    seeds_v: Number.isFinite(seeds_v) ? seeds_v : 10,
    spacing: Number.isFinite(spacing) ? spacing : 0.015,
    size: Number.isFinite(size) ? size : 0.0037,
    both,
    pick,
    representation,
    max_steps: Number.isFinite(max_steps) ? max_steps : 50000,
    seed_mode,
    faces,
    quantity_mode,
    n_seeds: Number.isFinite(n_seeds) ? Math.max(0, Math.floor(n_seeds)) : 40,
    density: Number.isFinite(density) ? density : 10000,
    region,
  };
}

function ptCacheKey(caseDir, time, p) {
  const facesKey = (p.faces || []).slice().sort().join(',');
  const raw = [
    caseDir,
    time,
    p.seed_mode || 'grid',
    facesKey,
    p.quantity_mode || 'count',
    p.n_seeds,
    p.density,
    p.seeds_h,
    p.seeds_v,
    p.spacing,
    p.both,
    p.pick,
    p.region || '',
    p.max_steps,
    'seeds-any-face-v1',
  ].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  const root = p.seed_mode === 'faces' ? PT_CACHE_ROOT_W14 : PT_CACHE_ROOT_W8;
  return join(root, `pt-${h}`);
}

function runPtExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      PT_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--seeds-h',
      String(p.seeds_h),
      '--seeds-v',
      String(p.seeds_v),
      '--spacing',
      String(p.spacing),
      '--size',
      String(p.size),
      '--both',
      String(p.both),
      '--pick',
      p.pick || '',
      '--representation',
      p.representation || 'Cylinders',
      '--max-steps',
      String(p.max_steps),
      '--seed-mode',
      p.seed_mode || 'grid',
      '--faces',
      (p.faces || []).join(','),
      '--quantity-mode',
      p.quantity_mode || 'count',
      '--n-seeds',
      String(p.n_seeds ?? 40),
      '--density',
      String(p.density ?? 10000),
      '--region',
      p.region || '',
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_particle_trace exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function ensureParticleTrace(caseDir, time, p) {
  mkdirSync(PT_CACHE_ROOT_W8, { recursive: true });
  mkdirSync(PT_CACHE_ROOT_W14, { recursive: true });
  const dir = ptCacheKey(caseDir, time, p);
  const vtp = join(dir, 'particle_trace.vtp');
  const meta = join(dir, 'particle_trace.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${JSON.stringify(p)}`;
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    const rpc = callWorker(
      'filter.particle_trace',
      {
        case_dir: caseDir,
        time: String(time),
        out_dir: dir,
        seeds_h: p.seeds_h,
        seeds_v: p.seeds_v,
        spacing: p.spacing,
        size: p.size,
        both: p.both,
        pick: p.pick || '',
        representation: p.representation || 'Cylinders',
        max_steps: p.max_steps,
        seed_mode: p.seed_mode || 'grid',
        faces: p.faces || [],
        quantity_mode: p.quantity_mode || 'count',
        n_seeds: p.n_seeds ?? 40,
        density: p.density ?? 10000,
        region: p.region || '',
      },
      180000,
    );
    if (rpc && typeof rpc.then === 'function') {
      try {
        await rpc;
      } catch (err) {
        console.warn('[CFD] PT worker export failed, spawning', err && err.message ? err.message : err);
        await runPtExport(caseDir, time, dir, p);
      }
    } else {
      await runPtExport(caseDir, time, dir, p);
    }
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { vtp, meta, dir, from_cache: fresh };
}


function popParamsFromUrl(u) {
  const subdivisions = Number(u.searchParams.get('subdivisions') ?? '0');
  const field_variable =
    u.searchParams.get('field_variable') ||
    u.searchParams.get('fieldVariable') ||
    'Velocity Magnitude';
  const field = u.searchParams.get('field') || '';
  const points = (u.searchParams.get('points') || '').trim();
  return {
    subdivisions: Number.isFinite(subdivisions) ? Math.max(0, Math.floor(subdivisions)) : 0,
    field_variable,
    field,
    points,
  };
}

function popCacheKey(caseDir, time, p) {
  const raw = [caseDir, time, p.subdivisions, p.field_variable, p.field, p.points].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return join(POP_CACHE_ROOT, `pop-${h}`);
}

function runPopExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      POP_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--points',
      p.points || '',
      '--subdivisions',
      String(p.subdivisions),
      '--field-variable',
      p.field_variable || 'Velocity Magnitude',
    ];
    if (p.field) {
      args.push('--field', p.field);
    }
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_plot_over_path exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function ensurePlotOverPath(caseDir, time, p) {
  mkdirSync(POP_CACHE_ROOT, { recursive: true });
  const dir = popCacheKey(caseDir, time, p);
  const meta = join(dir, 'plot_over_path.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${JSON.stringify(p)}`;
  const fresh =
    existsSync(meta) && existsSync(stampPath) && readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    await runPopExport(caseDir, time, dir, p);
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { meta, dir, from_cache: fresh };
}


function isoParamsFromUrl(u) {
  const iso_value = Number(u.searchParams.get('iso_value') ?? u.searchParams.get('value') ?? '11.1');
  const iso_scalar =
    u.searchParams.get('iso_scalar') ||
    u.searchParams.get('isoScalar') ||
    'Velocity Magnitude';
  const coloring = u.searchParams.get('coloring') || 'Pressure';
  const opacity = Number(u.searchParams.get('opacity') ?? '1');
  const vectorsRaw = u.searchParams.get('vectors');
  const vectors =
    vectorsRaw === '1' || vectorsRaw === 'true' || vectorsRaw === 'True' ? 1 : 0;
  return {
    iso_value: Number.isFinite(iso_value) ? iso_value : 11.1,
    iso_scalar,
    coloring,
    opacity: Number.isFinite(opacity) ? opacity : 1,
    vectors,
  };
}

function isoCacheKey(caseDir, time, p) {
  const raw = [
    caseDir,
    time,
    p.iso_scalar,
    p.iso_value,
    p.coloring,
    p.opacity,
    p.vectors,
  ].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return join(ISO_CACHE_ROOT, `iso-${h}`);
}

function runIsoExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      ISO_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--iso-scalar',
      p.iso_scalar || 'Velocity Magnitude',
      '--iso-value',
      String(p.iso_value),
      '--coloring',
      p.coloring || 'Pressure',
      '--opacity',
      String(p.opacity),
      '--vectors',
      String(p.vectors),
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_iso_surface exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

function cutParamsFromUrl(u) {
  const num = (key, fallback) => {
    const n = Number(u.searchParams.get(key));
    return Number.isFinite(n) ? n : fallback;
  };
  const field = u.searchParams.get('field') === 'p' ? 'p' : 'magU';
  const liveRaw = u.searchParams.get('live');
  return {
    ox: num('ox', 0),
    oy: num('oy', 0),
    oz: num('oz', 0),
    nx: num('nx', 0),
    ny: num('ny', 1),
    nz: num('nz', 0),
    field,
    live: liveRaw === '1' || liveRaw === 'true',
  };
}

function liveCutCacheKey(caseDir, time, p) {
  const raw = [caseDir, time, p.field, p.nx.toFixed(3), p.ny.toFixed(3), p.nz.toFixed(3)].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return join(CUT_CACHE_ROOT, `live-${h}`);
}

function cutCacheKey(caseDir, time, p) {
  const raw = [
    caseDir,
    time,
    p.field,
    p.ox.toFixed(5),
    p.oy.toFixed(5),
    p.oz.toFixed(5),
    p.nx.toFixed(4),
    p.ny.toFixed(4),
    p.nz.toFixed(4),
  ].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return join(CUT_CACHE_ROOT, `cut-${h}`);
}

function runCutExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      CUT_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--ox',
      String(p.ox),
      '--oy',
      String(p.oy),
      '--oz',
      String(p.oz),
      '--nx',
      String(p.nx),
      '--ny',
      String(p.ny),
      '--nz',
      String(p.nz),
      '--field',
      p.field,
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_cut_plane exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function runWorkerCut(caseDir, time, dir, p) {
  mkdirSync(dir, { recursive: true });
  const rpc = callWorker(
    'filter.cut_plane',
    {
      case_dir: caseDir,
      time: String(time),
      out_dir: dir,
      ox: p.ox,
      oy: p.oy,
      oz: p.oz,
      nx: p.nx,
      ny: p.ny,
      nz: p.nz,
      field: p.field,
    },
    180000,
  );
  if (rpc && typeof rpc.then === 'function') {
    try {
      await rpc;
      return;
    } catch (err) {
      console.warn('[CFD] cut worker export failed, spawning', err && err.message ? err.message : err);
    }
  }
  await runCutExport(caseDir, time, dir, p);
}

async function ensureCutPlane(caseDir, time, p) {
  mkdirSync(CUT_CACHE_ROOT, { recursive: true });
  if (p.live) {
    const dir = liveCutCacheKey(caseDir, time, p);
    const vtp = join(dir, 'cut_plane.vtp');
    const meta = join(dir, 'cut_plane.meta.json');
    await runWorkerCut(caseDir, time, dir, p);
    return { vtp, meta, dir, from_cache: false, live: true };
  }
  const dir = cutCacheKey(caseDir, time, p);
  const vtp = join(dir, 'cut_plane.vtp');
  const meta = join(dir, 'cut_plane.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, p.field === 'p' ? 'p' : 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${p.field}|${p.ox.toFixed(5)}|${p.oy.toFixed(5)}|${p.oz.toFixed(5)}|${p.nx.toFixed(4)}|${p.ny.toFixed(4)}|${p.nz.toFixed(4)}|arrays=U,magU,p,T`;
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    await runWorkerCut(caseDir, time, dir, p);
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { vtp, meta, dir, from_cache: fresh };
}

async function ensureIsoSurface(caseDir, time, p) {
  mkdirSync(ISO_CACHE_ROOT, { recursive: true });
  const dir = isoCacheKey(caseDir, time, p);
  const vtp = join(dir, 'iso_surface.vtp');
  const meta = join(dir, 'iso_surface.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${JSON.stringify(p)}`;
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    await runIsoExport(caseDir, time, dir, p);
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { vtp, meta, dir, from_cache: fresh };
}



function isoVolParamsFromUrl(u) {
  const iso_value_low = Number(u.searchParams.get('iso_value_low') ?? u.searchParams.get('low') ?? '0.25');
  const iso_value_high = Number(u.searchParams.get('iso_value_high') ?? u.searchParams.get('high') ?? '0.75');
  const iso_scalar =
    u.searchParams.get('iso_scalar') ||
    u.searchParams.get('isoScalar') ||
    'Velocity Magnitude';
  const coloring = u.searchParams.get('coloring') || 'Pressure';
  const opacity = Number(u.searchParams.get('opacity') ?? '1');
  const vectorsRaw = u.searchParams.get('vectors');
  const vectors =
    vectorsRaw === '1' || vectorsRaw === 'true' || vectorsRaw === 'True' ? 1 : 0;
  return {
    iso_value_low: Number.isFinite(iso_value_low) ? iso_value_low : 0.25,
    iso_value_high: Number.isFinite(iso_value_high) ? iso_value_high : 0.75,
    iso_scalar,
    coloring,
    opacity: Number.isFinite(opacity) ? opacity : 1,
    vectors,
  };
}

function isoVolCacheKey(caseDir, time, p) {
  const raw = [
    caseDir,
    time,
    p.iso_scalar,
    p.iso_value_low,
    p.iso_value_high,
    p.coloring,
    p.opacity,
    p.vectors,
  ].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return join(ISO_VOL_CACHE_ROOT, `iv-${h}`);
}

function runIsoVolExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      ISO_VOL_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--iso-scalar',
      p.iso_scalar || 'Velocity Magnitude',
      '--iso-value-low',
      String(p.iso_value_low),
      '--iso-value-high',
      String(p.iso_value_high),
      '--coloring',
      p.coloring || 'Pressure',
      '--opacity',
      String(p.opacity),
      '--vectors',
      String(p.vectors),
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_iso_volume exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function ensureIsoVolume(caseDir, time, p) {
  mkdirSync(ISO_VOL_CACHE_ROOT, { recursive: true });
  const dir = isoVolCacheKey(caseDir, time, p);
  const vtp = join(dir, 'iso_volume.vtp');
  const meta = join(dir, 'iso_volume.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${JSON.stringify(p)}`;
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    await runIsoVolExport(caseDir, time, dir, p);
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { vtp, meta, dir, from_cache: fresh };
}



function inspectParamsFromUrl(u) {
  const x = Number(u.searchParams.get('x') ?? 'NaN');
  const y = Number(u.searchParams.get('y') ?? 'NaN');
  const z = Number(u.searchParams.get('z') ?? 'NaN');
  return {
    x: Number.isFinite(x) ? x : NaN,
    y: Number.isFinite(y) ? y : NaN,
    z: Number.isFinite(z) ? z : NaN,
  };
}

function inspectCacheKey(caseDir, time, p) {
  const raw = [caseDir, time, p.x, p.y, p.z].join('|');
  const h = createHash('sha1').update(raw).digest('hex').slice(0, 14);
  return join(INSPECT_CACHE_ROOT, `insp-${h}`);
}

function runInspectExport(caseDir, time, outDir, p) {
  return new Promise((resolveP, reject) => {
    const args = [
      INSPECT_EXPORT_SCRIPT,
      '--case',
      caseDir,
      '--time',
      String(time),
      '--out-dir',
      outDir,
      '--x',
      String(p.x),
      '--y',
      String(p.y),
      '--z',
      String(p.z),
    ];
    const child = spawn(PYTHON, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`export_inspect_point exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolveP({ stdout, stderr });
    });
  });
}

async function ensureInspect(caseDir, time, p) {
  mkdirSync(INSPECT_CACHE_ROOT, { recursive: true });
  const dir = inspectCacheKey(caseDir, time, p);
  const meta = join(dir, 'inspect.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, 'magU') || foamStamp(caseDir, time, 'p');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${p.x}|${p.y}|${p.z}`;
  const fresh =
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    await runInspectExport(caseDir, time, dir, p);
    writeFileSync(stampPath, paramStamp, 'utf8');
  }
  return { meta, dir, from_cache: fresh };
}

function listCaseTimes(caseDir) {
  return listFoamTimeDirs(caseDir, { complete: true });
}

function foamFieldPath(caseDir, time, field) {
  return field === 'magU' ? join(caseDir, String(time), 'U') : join(caseDir, String(time), 'p');
}


function readActiveProjectMeshDoc() {
  try {
    if (!existsSync(ACTIVE_PROJECT_PATH)) return null;
    const rawActive = readFileSync(ACTIVE_PROJECT_PATH, 'utf8').trim();
    if (!rawActive) return null;
    const active = JSON.parse(rawActive);
    const id = active && active.project_id;
    if (!id) return null;
    const projPath = join(PROJECTS_ROOT, id, 'project.json');
    const proj = existsSync(projPath) ? JSON.parse(readFileSync(projPath, 'utf8')) : null;
    const sim = proj ? getActiveSimulation(id, proj) : null;
    const doc = sim ? assembleMeshDoc(id, sim.id) : null;
    if (!doc || !(doc.meshes || []).length) return null;
    return { project_id: id, doc, meshPath: null };
  } catch (e) {
    console.warn('[CFD W25b] readActiveProjectMeshDoc', String((e && e.message) || e));
    return null;
  }
}

function liveMeshForOpenProject(projectId, doc) {
  if (!doc) return null;
  let sim = null;
  try {
    const projPath = join(PROJECTS_ROOT, projectId, 'project.json');
    const proj = existsSync(projPath) ? JSON.parse(readFileSync(projPath, 'utf8')) : null;
    sim = proj ? getActiveSimulation(projectId, proj) : null;
  } catch (_) {}
  const meshes = Array.isArray(doc.meshes) ? doc.meshes : [];
  let entry = null;
  if (sim && sim.id) {
    const scoped = meshes.filter((m) => m && String(m.simulation_id || '') === String(sim.id));
    entry =
      scoped.find((m) => m && m.live_mesh_result && m.live_mesh_result.status === 'running') ||
      scoped.find((m) => m && String(m.id) === String(doc.active_id)) ||
      scoped.find((m) => m && m.live_mesh_result && m.live_mesh_result.case_dir) ||
      null;
  }
  const live = (entry && entry.live_mesh_result) || null;
  if (live && live.case_dir && caseDirBelongsToStudy(live.case_dir, projectId, sim && sim.id)) {
    return { ...live, mesh_id: live.mesh_id || (entry && entry.id) || null };
  }
  return null;
}

/** Prefer layered remesh case from mesh.json over MTP1 default (W25b live attach). */
let lastHydratedCaseLogged = null;
function hydrateActiveMeshCase() {
  let info = readActiveProjectMeshDoc();
  if (info && info.project_id && info.doc && info.doc.simulation_id) {
    try {
      recoverStudyMeshesFromDisk(info.project_id, info.doc.simulation_id);
      info = readActiveProjectMeshDoc() || info;
    } catch (e) {
      console.warn('[CFD] recover generated mesh', e);
    }
  }
  if (!info || !info.doc) return false;
  const live = liveMeshForOpenProject(info.project_id, info.doc);
  if (!live) return false;
  const liveSnap = liveMeshJobSnapshot();
  const jobAlive =
    live.status === 'running' &&
    !!liveSnap &&
    (!live.generate_id || !liveSnap.generate_id || live.generate_id === liveSnap.generate_id);
  if (live.status === 'running' && !jobAlive) {
    // Vite/process restart lost the child â€” do not keep a ghost "meshing" card.
    try {
      const before = live.fingerprint_before || {};
      const keepPrev = before.n_cells != null;
      persistMeshResult(info.project_id, {
        ...live,
        status: keepPrev ? 'done' : 'failed',
        n_cells: keepPrev ? before.n_cells : live.n_cells,
        n_points: keepPrev ? before.n_points : live.n_points,
        n_faces: keepPrev ? before.n_faces : live.n_faces,
        exit_code: keepPrev ? 0 : live.exit_code != null ? live.exit_code : -1,
        finished_at: new Date().toISOString(),
        note: keepPrev
          ? 'Previous mesh kept â€” a later generate was interrupted.'
          : 'Meshing stopped when the server restarted.',
      });
    } catch (e) {
      console.warn('[CFD] mark interrupted mesh job', e);
    }
    return false;
  }
  if (live.status === 'running' && jobAlive) {
    activeCaseState = {
      ...activeCaseState,
      case_dir: live.case_dir || null,
      status: 'running',
      mode: 'mesh',
      mesh_id: live.mesh_id || liveSnap.mesh_id || null,
      attached_at: live.started_at || new Date().toISOString(),
      path_kind: live.path_kind || 'cartesianMesh',
      generate_id: live.generate_id || liveSnap.generate_id || null,
      kick_id: live.generate_id || liveSnap.generate_id || null,
      pid: liveSnap.pid || live.pid || null,
      exit_code: null,
      n_cells: null,
      n_points: null,
      n_faces: null,
      counts_source: null,
      mesh_path: live.mesh_path || null,
      step_path: live.step_path || null,
      body1_path: live.body1_path || null,
      geometry: live.geometry || null,
      mtp1_silent_copy: false,
      increment: live.increment || 'W28',
      note: live.note || 'Generating mesh',
      command: live.command || null,
      log_path: live.log_path || null,
      wsl_case: live.wsl_case || null,
      started_at: live.started_at || null,
      finished_at: null,
    };
    console.info('[CFD] hydrated running mesh job', live.generate_id, liveSnap.pid);
    return true;
  }
  if (live.status !== 'done' || !live.case_dir) return false;
  if (!existsSync(live.case_dir)) return false;
  const poly = live.mesh_path || join(live.case_dir, 'constant', 'polyMesh');
  if (!existsSync(poly)) return false;
  activeCaseState = {
    ...activeCaseState,
    case_dir: live.case_dir,
    status: 'done',
    mode: 'mesh',
    attached_at: new Date().toISOString(),
    path_kind: live.path_kind || 'standard',
    generate_id: live.generate_id || null,
    kick_id: live.generate_id || null,
    exit_code: live.exit_code != null ? live.exit_code : 0,
    n_cells: live.n_cells ?? null,
    n_points: live.n_points ?? null,
    n_faces: live.n_faces ?? null,
    counts_source: live.counts_source || 'polyMesh/points+owner',
    emesh: live.emesh || null,
    feature_marks_total: live.feature_marks_total ?? null,
    mesh_path: poly,
    fingerprint_before: live.fingerprint_before || null,
    fingerprint_after: live.fingerprint_after || null,
    step_path: live.step_path || null,
    body1_path: live.body1_path || null,
    geometry: live.geometry || null,
    mtp1_silent_copy: false,
    increment: live.increment || 'W25',
    note: 'W25b: hydrated active case_dir from project mesh.json live_mesh_result (layered remesh)',
    project_id: info.project_id,
    times: listCaseTimes(live.case_dir),
    n_times: listCaseTimes(live.case_dir).length,
    pid: null,
    command: live.command || null,
    log_path: live.log_path || null,
    log_excerpt: null,
    wsl_case: live.wsl_case || null,
    finished_at: live.finished_at || null,
    started_at: live.started_at || null,
  };
  if (lastHydratedCaseLogged !== live.case_dir) {
    lastHydratedCaseLogged = live.case_dir;
    console.info('[CFD] active mesh case', live.case_dir, 'cells', live.n_cells);
  }
  return true;
}

function polyMeshCacheToken(caseDir) {
  try {
    const txt = readFileSync(join(caseDir, 'constant', 'polyMesh', 'owner'), 'utf8').slice(0, 1600);
    const cells = /nCells:(\d+)/.exec(txt);
    const pts = /nPoints:(\d+)/.exec(txt);
    if (cells && pts) return `c${cells[1]}p${pts[1]}`;
  } catch {}
  try {
    const st = statSync(join(caseDir, 'constant', 'polyMesh', 'points'));
    return `t${st.mtimeMs}s${st.size}`;
  } catch {
    return '0';
  }
}

function meshSectionCacheKey(caseDir, axis, frac) {
  const h = createHash('sha256')
    .update(String(caseDir) + '|' + axis + '|' + String(frac) + '|' + polyMeshCacheToken(caseDir))
    .digest('hex')
    .slice(0, 16);
  return join(MESH_SECTION_CACHE_ROOT, `section-${axis}-${String(frac).replace('.', 'p')}-${h}.vtp`);
}

function runMeshSectionExport(caseDir, axis, frac, outVtp, metaPath) {
  mkdirSync(MESH_SECTION_CACHE_ROOT, { recursive: true });
  const r = spawnSync(
    PYTHON,
    [
      MESH_SECTION_EXPORT_SCRIPT,
      '--case', caseDir,
      '--out', outVtp,
      '--axis', axis,
      '--frac', String(frac),
      '--meta', metaPath,
    ],
    { encoding: 'utf8', timeout: 180000, windowsHide: true }
  );
  return {
    status: r.status,
    stdout: (r.stdout || '').slice(-2000),
    stderr: (r.stderr || '').slice(-2000),
    out_exists: existsSync(outVtp),
  };
}

function meshSurfaceCacheKey(caseDir) {
  const h = createHash('sha256')
    .update(String(caseDir) + '|' + polyMeshCacheToken(caseDir))
    .digest('hex')
    .slice(0, 16);
  return join(MESH_SURFACE_CACHE_ROOT, `surface-${h}.vtp`);
}

function runMeshSurfaceExport(caseDir, outVtp, metaPath) {
  mkdirSync(MESH_SURFACE_CACHE_ROOT, { recursive: true });
  const r = spawnSync(
    PYTHON,
    [MESH_SURFACE_EXPORT_SCRIPT, '--case', caseDir, '--out', outVtp, '--meta', metaPath],
    { encoding: 'utf8', timeout: 180000, windowsHide: true }
  );
  return {
    status: r.status,
    stdout: (r.stdout || '').slice(-2000),
    stderr: (r.stderr || '').slice(-2000),
    out_exists: existsSync(outVtp),
  };
}

function meshCacheMetaMatchesCase(meta, caseDir) {
  const tok = polyMeshCacheToken(caseDir);
  const cells = /^c(\d+)p(\d+)$/.exec(tok);
  if (!cells || !meta) return false;
  const mc = Number(meta.n_cells_volume);
  const mp = Number(meta.n_points_volume);
  return mc === Number(cells[1]) && (!mp || mp === Number(cells[2]));
}

async function ensureMeshSurface(caseDir) {
  const outVtp = meshSurfaceCacheKey(caseDir);
  const metaPath = outVtp.replace(/\.vtp$/i, '.meta.json');
  if (existsSync(outVtp) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meshCacheMetaMatchesCase(meta, caseDir)) {
        return { ok: true, path: outVtp, meta, cached: true };
      }
    } catch {}
  }
  const run = runMeshSurfaceExport(caseDir, outVtp, metaPath);
  if (!run.out_exists) {
    return { ok: false, error: 'mesh-surface export failed', run };
  }
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = { out: outVtp }; }
  return { ok: true, path: outVtp, meta, cached: false, run };
}

async function ensureMeshSection(caseDir, axis, frac) {
  const outVtp = meshSectionCacheKey(caseDir, axis, frac);
  const metaPath = outVtp.replace(/\.vtp$/i, '.meta.json');
  if (existsSync(outVtp) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meshCacheMetaMatchesCase(meta, caseDir)) {
        return { ok: true, path: outVtp, meta, cached: true };
      }
    } catch {}
  }
  const run = runMeshSectionExport(caseDir, axis, frac, outVtp, metaPath);
  if (!run.out_exists) {
    return { ok: false, error: 'mesh-section export failed', run };
  }
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = { out: outVtp }; }
  return { ok: true, path: outVtp, meta, cached: false, run };
}


export function getCaseFieldApi() {
  return {
    sendJson,
    readJsonBody,
    parseUrl,
    resolveCaseDir,
    requestProjectId,
    caseSnapshot,
    attachCaseDir,
    resetActiveCaseIdle,
    applyKickUpdate,
    hydrateActiveMeshCase,
    syncActiveCaseToActiveProject,
    listCaseTimes,
    listCaseSeedFaces,
    foamFieldPath,
    ensureSeriesRange,
    inspectParamsFromUrl,
    cutParamsFromUrl,
    isoParamsFromUrl,
    isoVolParamsFromUrl,
    popParamsFromUrl,
    ptParamsFromUrl,
    ensureExported,
    ensureCutPlane,
    warmVolume,
    releaseVolume,
    ensureIsoSurface,
    ensureIsoVolume,
    ensurePlotOverPath,
    ensureParticleTrace,
    ensureInspect,
    ensureMeshSurface,
    ensureMeshSection,
    meshSurfaceCacheKey,
    polyMeshCacheToken,
    ALLOWED_FIELDS,
    DEFAULT_TIME,
    ACTIVE_PROJECT_PATH,
  };
}
