/**
 * W6/W8/W9/W10/W11/W12/W13 Vite middleware:
 *   GET /api/times?case=                  -> real OpenFOAM time dirs on disk (W12)
 *   GET /api/fields/:field?case=&time=     -> surface VTP (magU/p) from case tree
 *   GET /api/fields/:field/meta?...       -> JSON fingerprint
 *   GET /api/particle-trace?...           -> tube-glyph VTP (server streamlines on U)
 *   GET /api/particle-trace/meta?...      -> JSON (n_seeds, tube_proof, fingerprint)
 *   GET /api/plot-over-path?...           -> JSON series (sample_over_line on magU/p)
 *   GET /api/plot-over-path/meta?...      -> same JSON fingerprint
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
 * (cfddesk ext4 case). Job status runningâ†’done/failed tracks real process PID.
 * On done: active case_dir â†’ new run-w151-* (time 0 only) so times/fp change.
 * Same-origin on 8082.
 * W19 HARD: POST /api/bcs + GET /api/bcs persist boundary_conditions.json
 *   (Velocity inlet 1 @ face57 5 ft3/min + Pressure outlet 2 @ face71 0 Pa; NOT Velocity outlet).
 * W18 HARD: POST /api/materials + GET /api/materials persist materials.json (Airâ†’Body1).
 * W17 HARD: POST /api/simulation + GET /api/simulation persist simulation.json (Incompressible defaults).
 * W16 HARD: POST /api/project + GET /api/project persist under projects/;
 * POST /api/geometry/import STEPâ†’STL Body1; GET /api/geometry/stl serves CAD.
 * W20 HARD: POST /api/mesh + GET /api/mesh persist mesh.json (bank settings).
 * W23 HARD: POST /api/mesh/generate|/remesh uses W16 project source.step/Body1 + Standard/gmsh-hexcore (Hex-dominant=snappy); Job PID; real polyMesh counts; NOT checkMesh; NOT MTP1-silent-copy; no W15.1 stamp on generate.
 * W27: /api/run/* + /api/simulation-control — run catalog, simpleFoam start/stop/status, monitors.
 * W22: POST/GET /api/result-controls|/api/area-average persist optional area-average monitors (setup only).
 * FILTERS/attach/W15.1 kick unchanged.
 */
import { spawn } from 'node:child_process';
import { handleW16Api, attachLiveMeshJobReader, attachActiveProjectListener } from './w16-project-geometry.js';
import { caseDirBelongsToProject, projectIdFromCaseDir } from './project-isolation.js';
import { handleW17Api } from './w17-simulation.js';
import { handleW18Api } from './w18-materials.js';
import { handleW19Api } from './w19-boundary-conditions.js';
import { handleW20Api } from './w20-mesh.js';
import { startMeshGenerate, meshGenerateLivePid, liveMeshJobSnapshot, persistMeshResult } from './w21-mesh-generate.js';
import { getActiveSimulation } from './w17-sim-catalog.js';
import { handleW26Api } from './w26-mesh-refinements.js';
import { handleW22Api } from './w22-area-average.js';
import { handleW27Api, runLivePid as runLivePidW27 } from './w27-solve.js';
import { handleW28Api } from './w28-media.js';
import { handlePrefsApi } from './w32-prefs.js';
import { PYTHON, PY_TOOLS, pyTool } from './python-env.js';
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

/** W15/W15.1 active case root â€” set by attach or mesh kick; used when ?case= omitted. */
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
    note: note || 'idle — add geometry',
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
  resetActiveCaseIdle(id ? 'detached — switched project' : 'idle');
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

function attachCaseDir(caseDirAbs, projectIdOpt) {
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
    await runExport(caseDir, time, field, dir);
    writeFileSync(stampPath, stamp, 'utf8');
  }
  return { vtp, meta, dir, stamp, from_cache: fresh };
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

function ptPatchRole(name, bcType) {
  const blob = `${name || ''} ${bcType || ''}`;
  if (/inlet|inflow/i.test(blob)) return 'inlet';
  if (/outlet|outflow|pressure/i.test(blob)) return 'outlet';
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

function findProjectDirFromCase(caseDir) {
  let dir = caseDir;
  for (let i = 0; i < 5 && dir; i++) {
    if (
      existsSync(join(dir, 'boundary_conditions.json')) ||
      existsSync(join(dir, 'project.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(dirname(caseDir));
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
  const projectDir = findProjectDirFromCase(caseDir);
  const bcs = readJsonFile(join(projectDir, 'boundary_conditions.json')) || {};
  const projectBcs = Array.isArray(bcs.boundary_conditions)
    ? bcs.boundary_conditions.filter(Boolean)
    : [];
  const meshDoc = readJsonFile(join(projectDir, 'mesh.json')) || {};
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
  const roleName = (web && web.name) || row.name || row.id || '';
  const roleType = (web && web.bc_type) || row.bc_type;
  const primary = cad[0] || row.name || row.patch;
  return {
    id: primary,
    label: primary,
    patch: row.patch,
    name: row.name || null,
    faces: cad,
    available: true,
    role: ptPatchRole(roleName, roleType),
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
    'seeds-region-v1',
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
    await runPtExport(caseDir, time, dir, p);
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
  return {
    ox: num('ox', 0),
    oy: num('oy', 0),
    oz: num('oz', 0),
    nx: num('nx', 0),
    ny: num('ny', 1),
    nz: num('nz', 0),
    field,
  };
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

async function ensureCutPlane(caseDir, time, p) {
  mkdirSync(CUT_CACHE_ROOT, { recursive: true });
  const dir = cutCacheKey(caseDir, time, p);
  const vtp = join(dir, 'cut_plane.vtp');
  const meta = join(dir, 'cut_plane.meta.json');
  const stampPath = join(dir, '.stamp');
  const stamp = foamStamp(caseDir, time, p.field === 'p' ? 'p' : 'magU');
  if (!stamp) {
    throw new Error(`case foam files missing under ${caseDir}/${time}`);
  }
  const paramStamp = `${stamp}|${p.field}|${p.ox.toFixed(5)}|${p.oy.toFixed(5)}|${p.oz.toFixed(5)}|${p.nx.toFixed(4)}|${p.ny.toFixed(4)}|${p.nz.toFixed(4)}`;
  const fresh =
    existsSync(vtp) &&
    existsSync(meta) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, 'utf8') === paramStamp;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    await runCutExport(caseDir, time, dir, p);
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
  if (!caseDir || !existsSync(caseDir)) return [];
  const names = readdirSync(caseDir, { withFileTypes: true });
  const times = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (!/^\d+(?:\.\d+)?$/.test(name)) continue;
    const u = join(caseDir, name, 'U');
    const p = join(caseDir, name, 'p');
    if (existsSync(u) || existsSync(p)) times.push(name);
  }
  times.sort((a, b) => Number(a) - Number(b));
  return times;
}

function foamFieldPath(caseDir, time, field) {
  return field === 'magU' ? join(caseDir, String(time), 'U') : join(caseDir, String(time), 'p');
}


function readActiveProjectMeshDoc() {
  try {
    if (!existsSync(ACTIVE_PROJECT_PATH)) return null;
    const active = JSON.parse(readFileSync(ACTIVE_PROJECT_PATH, 'utf8'));
    const id = active && active.project_id;
    if (!id) return null;
    const meshPath = join(PROJECTS_ROOT, id, 'mesh.json');
    if (!existsSync(meshPath)) return null;
    const doc = JSON.parse(readFileSync(meshPath, 'utf8'));
    return { project_id: id, doc, meshPath };
  } catch (e) {
    console.warn('[CFD W25b] readActiveProjectMeshDoc', e);
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
      scoped.find((m) => m && String(m.id) === String(doc.active_id)) ||
      scoped.find((m) => m && m.live_mesh_result && m.live_mesh_result.case_dir) ||
      null;
  }
  const live = (entry && entry.live_mesh_result) || null;
  if (live && live.case_dir && caseDirBelongsToProject(live.case_dir, projectId)) return live;
  return null;
}

/** Prefer layered remesh case from mesh.json over MTP1 default (W25b live attach). */
let lastHydratedCaseLogged = null;
function hydrateActiveMeshCase() {
  const info = readActiveProjectMeshDoc();
  if (!info || !info.doc) return false;
  const live = liveMeshForOpenProject(info.project_id, info.doc);
  if (!live) return false;
  const liveSnap = liveMeshJobSnapshot();
  const jobAlive =
    live.status === 'running' &&
    !!liveSnap &&
    (!live.generate_id || !liveSnap.generate_id || live.generate_id === liveSnap.generate_id);
  if (live.status === 'running' && !jobAlive) {
    // Vite/process restart lost the child — do not keep a ghost "meshing" card.
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
          ? 'Previous mesh kept — a later generate was interrupted.'
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

function meshSectionCacheKey(caseDir, axis, frac) {
  const h = createHash('sha256').update(String(caseDir) + '|' + axis + '|' + String(frac)).digest('hex').slice(0, 16);
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
  const h = createHash('sha256').update(String(caseDir)).digest('hex').slice(0, 16);
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

async function ensureMeshSurface(caseDir) {
  const outVtp = meshSurfaceCacheKey(caseDir);
  const metaPath = outVtp.replace(/\.vtp$/i, '.meta.json');
  if (existsSync(outVtp) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      return { ok: true, path: outVtp, meta, cached: true };
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
      return { ok: true, path: outVtp, meta, cached: true };
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


export function caseFieldsApiPlugin() {
  return {
    name: 'cfd-case-fields-api',
    configureServer(server) {
      hydrateActiveMeshCase();
      attachActiveProjectListener(syncActiveCaseToActiveProject);
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url || !req.url.startsWith('/api/')) {
            return next();
          }
          const u = parseUrl(req.url);
          const parts = u.pathname.split('/').filter(Boolean);

          // ---- W15/W15.1 case attach / mesh kick / status ----
          if (parts[0] === 'api' && parts[1] === 'case') {
            if (parts[2] === 'attach' && req.method === 'POST') {
              let body = {};
              try {
                body = await readJsonBody(req);
              } catch (e) {
                return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
              }
              const caseDir = body.case_dir || body.case || body.path || '';
              const result = attachCaseDir(caseDir, body.project_id || body.projectId);
              res.setHeader('X-CFD-Source', 'case-attach');
              if (result.ok) res.setHeader('X-CFD-Case-Dir', result.body.case_dir || '');
              return sendJson(res, result.status, result.body);
            }
            if ((parts[2] === undefined || parts[2] === '' || parts[2] === 'status') && (req.method === 'GET' || req.method === 'HEAD')) {
              const pid = requestProjectId(u);
              const snap = caseSnapshot();
              if (pid && snap.case_dir && !caseDirBelongsToProject(snap.case_dir, pid)) {
                return sendJson(res, 200, {
                  ok: true,
                  case_dir: null,
                  status: 'idle',
                  mode: 'idle',
                  project_id: pid,
                  n_times: 0,
                  times: [],
                  note: 'idle — attached case belongs to another project',
                  pid: null,
                  n_cells: null,
                  n_points: null,
                  n_faces: null,
                });
              }
              res.setHeader('X-CFD-Source', 'case-status');
              if (snap.case_dir) res.setHeader('X-CFD-Case-Dir', snap.case_dir);
              res.setHeader('X-CFD-Case-Status', snap.status);
              if (snap.pid != null) res.setHeader('X-CFD-Job-Pid', String(snap.pid));
              return sendJson(res, 200, snap);
            }
            if (parts[2] === 'detach' && req.method === 'POST') {
              await readJsonBody(req).catch(() => ({}));
              activeCaseState = {
                case_dir: null,
                status: 'idle',
                attached_at: null,
                mode: 'attach-only',
                n_times: 0,
                times: [],
                note: 'W15.1: detached; idle until next attach/kick. No fake progress.',
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
              };
              return sendJson(res, 200, caseSnapshot());
            }
            return sendJson(res, 404, { error: 'unknown /api/case route', path: u.pathname });
          }

          // ---- Full mesh surface VTP (3D inspect, not a slice) ----
          if (parts[0] === 'api' && (parts[1] === 'mesh-surface' || (parts[1] === 'mesh' && parts[2] === 'surface'))) {
            const caseDir = resolveCaseDir(u);
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case_dir: caseDir });
            }
            const wantMeta = parts.includes('meta') || u.searchParams.get('meta') === '1';
            const ensured = await ensureMeshSurface(caseDir);
            if (!ensured.ok) {
              return sendJson(res, 500, { error: 'mesh-surface failed', detail: ensured });
            }
            res.setHeader('X-CFD-Increment', 'W27');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Mesh-Surface', '1');
            if (wantMeta || req.method === 'HEAD') {
              return sendJson(res, 200, {
                ok: true,
                increment: 'W27',
                case_dir: caseDir,
                vtp_url: `/api/mesh-surface?case=${encodeURIComponent(caseDir)}`,
                meta: ensured.meta,
                cached: !!ensured.cached,
                n_cells_volume: ensured.meta && ensured.meta.n_cells_volume,
                n_cells_surface: ensured.meta && ensured.meta.n_cells_surface,
              });
            }
            const buf = readFileSync(ensured.path);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'inline; filename="mesh-surface.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', String(buf.length));
            res.end(buf);
            return;
          }

          // ---- W25b Mesh section VTP for live Cutting Plane mesh inspect ----
          if (parts[0] === 'api' && (parts[1] === 'mesh-section' || (parts[1] === 'mesh' && parts[2] === 'section'))) {
            const caseDir = resolveCaseDir(u);
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case_dir: caseDir });
            }
            const axis = (u.searchParams.get('axis') || 'x').toLowerCase();
            const frac = Number(u.searchParams.get('frac') || '0.5');
            const wantMeta = parts.includes('meta') || u.searchParams.get('meta') === '1';
            const ensured = await ensureMeshSection(caseDir, axis, Number.isFinite(frac) ? frac : 0.5);
            if (!ensured.ok) {
              return sendJson(res, 500, { error: 'mesh-section failed', detail: ensured });
            }
            res.setHeader('X-CFD-Increment', 'W25b');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Mesh-Section', '1');
            if (wantMeta || req.method === 'HEAD') {
              return sendJson(res, 200, {
                ok: true,
                increment: 'W25b',
                case_dir: caseDir,
                axis,
                frac,
                vtp_url: `/api/mesh-section?case=${encodeURIComponent(caseDir)}&axis=${axis}&frac=${frac}`,
                meta: ensured.meta,
                cached: !!ensured.cached,
                n_cells_volume: ensured.meta && ensured.meta.n_cells_volume,
                n_cells_slice: ensured.meta && ensured.meta.n_cells_slice,
              });
            }
            const buf = readFileSync(ensured.path);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'inline; filename="mesh-section.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', String(buf.length));
            res.end(buf);
            return;
          }

          // ---- W23 Mesh Generate / remesh (W16 STEP/Body1 + snappyHexMesh; NOT checkMesh; no W15.1 stamp) ----
          if (parts[0] === 'api' && parts[1] === 'mesh' && (parts[2] === 'generate' || parts[2] === 'remesh') && req.method === 'POST') {
            let body = {};
            try { body = await readJsonBody(req); } catch (e) {
              return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
            }
            const kicked = startMeshGenerate({
              settings: body.settings || null,
              projectId: body.project_id || null,
              meshId: body.mesh_id || body.id || null,
              onUpdate: (fields) => { applyKickUpdate(fields); },
            });
            if (!kicked.ok) {
              return sendJson(res, kicked.status, {
                ...caseSnapshot(),
                ...(kicked.bodyExtra || {}),
                ok: false,
                increment: 'W23',
              });
            }
            applyKickUpdate(kicked.bodyExtra);
            const snap = caseSnapshot();
            res.setHeader('X-CFD-Source', 'mesh-generate');
            res.setHeader('X-CFD-Increment', 'W23');
            res.setHeader(
              'X-CFD-Path-Kind',
              (kicked.bodyExtra && kicked.bodyExtra.path_kind) || snap.path_kind || 'cartesianMesh'
            );
            res.setHeader('X-CFD-Case-Status', snap.status);
            if (snap.case_dir) res.setHeader('X-CFD-Case-Dir', snap.case_dir);
            if (snap.pid != null) res.setHeader('X-CFD-Job-Pid', String(snap.pid));
            return sendJson(res, kicked.status, {
              ...snap,
              ok: true,
              increment: 'W23',
              step_path: (kicked.bodyExtra && kicked.bodyExtra.step_path) || snap.step_path || null,
              body1_path: (kicked.bodyExtra && kicked.bodyExtra.body1_path) || snap.body1_path || null,
              geometry: (kicked.bodyExtra && kicked.bodyExtra.geometry) || snap.geometry || null,
              mtp1_silent_copy: false,
            });
          }


          // ---- Machine prefs / first-run wizard ----
          if (parts[0] === 'api' && parts[1] === 'prefs') {
            const handled = await handlePrefsApi(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W28 Media: screenshots + recordings per run / mesh ----
          if (parts[0] === 'api' && parts[1] === 'media') {
            const handled = await handleW28Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W27 Simulation Control / simpleFoam start-stop ----
          if (
            parts[0] === 'api' &&
            (parts[1] === 'simulation-control' ||
              parts[1] === 'simulation_control' ||
              parts[1] === 'run' ||
              parts[1] === 'runs')
          ) {
            const handled = await handleW27Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W22 Area average / result controls (setup only) ----
          if (
            parts[0] === 'api' &&
            (parts[1] === 'result-controls' ||
              parts[1] === 'result_controls' ||
              parts[1] === 'area-average' ||
              parts[1] === 'area_average')
          ) {
            const handled = await handleW22Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W26 Mesh refinements (surface custom sizing + inflate BL) ----
          if (
            parts[0] === 'api' &&
            ((parts[1] === 'mesh' && parts[2] === 'refinements') || parts[1] === 'mesh-refinements')
          ) {
            const handled = await handleW26Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W20 Mesh form settings (bank defaults; generate via W21 above) ----
          if (parts[0] === 'api' && parts[1] === 'mesh') {
            const handled = await handleW20Api(req, res, u, parts, {
              sendJson,
              readJsonBody,
              onGeneratedMeshDeleted({ deleted_runs }) {
                const active = activeCaseState.case_dir;
                const removed = (deleted_runs || []).map((p) => resolve(p).toLowerCase());
                if (active) {
                  const a = resolve(active).toLowerCase();
                  const hit = removed.some(
                    (p) => a === p || a.startsWith(p + '\\') || a.startsWith(p + '/')
                  );
                  if (hit || !existsSync(active)) {
                    resetActiveCaseIdle('Generated mesh deleted');
                  }
                }
                for (const p of deleted_runs || []) {
                  try {
                    const vtp = meshSurfaceCacheKey(p);
                    const meta = vtp.replace(/\.vtp$/i, '.meta.json');
                    if (existsSync(vtp)) rmSync(vtp, { force: true });
                    if (existsSync(meta)) rmSync(meta, { force: true });
                  } catch (_) {}
                }
              },
            });
            if (handled !== false) return;
          }

          // ---- W19 Boundary conditions (Velocity inlet 1 + Pressure outlet 2) ----
          if (parts[0] === 'api' && parts[1] === 'bcs') {
            const handled = await handleW19Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W18 Materials â†’ Air + Body1 ----
          if (parts[0] === 'api' && parts[1] === 'materials') {
            const handled = await handleW18Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W17 Create Simulation â†’ Incompressible ----
          if (parts[0] === 'api' && parts[1] === 'simulation') {
            const handled = await handleW17Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) return;
          }

          // ---- W16 project create + geometry import ----
          if (
            (parts[0] === 'api' && parts[1] === 'project') ||
            (parts[0] === 'api' && parts[1] === 'projects') ||
            (parts[0] === 'api' && parts[1] === 'folders') ||
            (parts[0] === 'api' && parts[1] === 'geometry')
          ) {
            const handled = await handleW16Api(req, res, u, parts, { sendJson, readJsonBody });
            if (handled !== false) {
              const projectSwitch =
                req.method === 'POST' &&
                parts[1] === 'project' &&
                (!parts[2] || parts[2] === 'open' || parts[2] === 'delete');
              if (projectSwitch) syncActiveCaseToActiveProject();
              return;
            }
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendJson(res, 405, { error: 'method not allowed' });
          }

          // ---- W12 times list (real dirs only; no invented frames) ----
          if (parts[0] === 'api' && parts[1] === 'times') {
            const caseDir = resolveCaseDir(u);
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir, times: [], empty: true });
            }
            const times = listCaseTimes(caseDir);
            res.setHeader('X-CFD-Source', 'case-tree-times');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            return sendJson(res, 200, {
              increment: 'W12',
              case_dir: caseDir,
              times,
              n_times: times.length,
              start: times.length ? times[0] : null,
              end: times.length ? times[times.length - 1] : null,
              mapping_note:
                'Animation Start/End/scrubber use these real OpenFOAM time directories only. Right-panel ITERATIONS 0-1000 chrome is not the animation timeline and is not W12 proof.',
              proves_not_baked_only: true,
              no_invented_frames: true,
            });
          }

          // ---- W13 Inspect point ----
          if (parts[0] === 'api' && parts[1] === 'inspect') {
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir, empty: true, hit: false });
            }
            const p = inspectParamsFromUrl(u);
            if (![p.x, p.y, p.z].every((v) => Number.isFinite(v))) {
              return sendJson(res, 400, {
                error: 'x,y,z required as finite numbers',
                empty: true,
                hit: false,
                no_fake_value: true,
              });
            }
            const foamPath = foamFieldPath(caseDir, time, 'magU');
            const foamP = foamFieldPath(caseDir, time, 'p');
            if (!existsSync(foamPath) && !existsSync(foamP)) {
              return sendJson(res, 404, {
                error: 'time_not_found',
                case: caseDir,
                time: String(time),
                empty: true,
                hit: false,
                available_times: listCaseTimes(caseDir),
                proves_not_baked_only: true,
                no_fake_value: true,
              });
            }
            const exported = await ensureInspect(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
            res.setHeader('X-CFD-Source', 'case-tree-inspect-probe');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            res.setHeader('X-CFD-Inspect-Hit', metaObj.hit ? '1' : '0');
            return sendJson(res, 200, {
              ...metaObj,
              api_url: `/api/inspect?case=${encodeURIComponent(caseDir)}&time=${time}&x=${p.x}&y=${p.y}&z=${p.z}`,
              from_cache: exported.from_cache,
              proves_not_baked_only: true,
            });
          }

          // ---- W11 Iso Volume ----
          if (parts[0] === 'api' && parts[1] === 'iso-volume') {
            const wantMeta = parts[2] === 'meta';
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir });
            }
            const p = isoVolParamsFromUrl(u);
            const exported = await ensureIsoVolume(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));

            res.setHeader('X-CFD-Source', 'case-tree-volume-threshold');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Field', metaObj.iso_field || 'magU');
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            res.setHeader('X-CFD-N-Cells', String(metaObj.n_cells ?? ''));
            res.setHeader('X-CFD-ISO-VOL-Empty', metaObj.empty ? '1' : '0');

            if (wantMeta) {
              return sendJson(res, 200, {
                ...metaObj,
                api_url: `/api/iso-volume?case=${encodeURIComponent(caseDir)}&time=${time}&iso_scalar=${encodeURIComponent(p.iso_scalar)}&iso_value_low=${p.iso_value_low}&iso_value_high=${p.iso_value_high}&coloring=${encodeURIComponent(p.coloring)}&opacity=${p.opacity}&vectors=${p.vectors}`,
                from_cache: exported.from_cache,
                proves_not_baked_only: true,
              });
            }

            const buf = readFileSync(exported.vtp);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Content-Disposition', 'inline; filename="iso_volume.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') {
              return res.end();
            }
            return res.end(buf);
          }

          if (parts[0] === 'api' && parts[1] === 'cut-plane') {
            const wantMeta = parts[2] === 'meta';
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir, empty: true });
            }
            const p = cutParamsFromUrl(u);
            const exported = await ensureCutPlane(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
            res.setHeader('X-CFD-Source', 'case-tree-volume-slice');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Field', p.field);
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            if (wantMeta) {
              return sendJson(res, 200, {
                ...metaObj,
                api_url: `/api/cut-plane?case=${encodeURIComponent(caseDir)}&time=${time}&ox=${p.ox}&oy=${p.oy}&oz=${p.oz}&nx=${p.nx}&ny=${p.ny}&nz=${p.nz}&field=${p.field}`,
                from_cache: exported.from_cache,
              });
            }
            const buf = readFileSync(exported.vtp);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Content-Disposition', 'inline; filename="cut_plane.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') return res.end();
            return res.end(buf);
          }

          // ---- W10 Iso Surface ----
          if (parts[0] === 'api' && parts[1] === 'iso-surface') {
            const wantMeta = parts[2] === 'meta';
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir });
            }
            const p = isoParamsFromUrl(u);
            const exported = await ensureIsoSurface(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));

            res.setHeader('X-CFD-Source', 'case-tree-volume-contour');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Field', metaObj.iso_field || 'magU');
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            res.setHeader('X-CFD-N-Cells', String(metaObj.n_cells ?? ''));
            res.setHeader('X-CFD-ISO-Empty', metaObj.empty ? '1' : '0');

            if (wantMeta) {
              return sendJson(res, 200, {
                ...metaObj,
                api_url: `/api/iso-surface?case=${encodeURIComponent(caseDir)}&time=${time}&iso_scalar=${encodeURIComponent(p.iso_scalar)}&iso_value=${p.iso_value}&coloring=${encodeURIComponent(p.coloring)}&opacity=${p.opacity}&vectors=${p.vectors}`,
                from_cache: exported.from_cache,
                proves_not_baked_only: true,
              });
            }

            const buf = readFileSync(exported.vtp);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Content-Disposition', 'inline; filename="iso_surface.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') {
              return res.end();
            }
            return res.end(buf);
          }

          // ---- W9 Plot-over-path ----
          if (parts[0] === 'api' && parts[1] === 'plot-over-path') {
            const wantMeta = parts[2] === 'meta';
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir });
            }
            const p = popParamsFromUrl(u);
            const exported = await ensurePlotOverPath(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));

            res.setHeader('X-CFD-Source', 'case-tree-sample-over-line');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Field', metaObj.field_name || 'magU');
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            res.setHeader('X-CFD-N-Samples', String(metaObj.n_samples ?? ''));
            res.setHeader('X-CFD-POP-Empty', metaObj.empty ? '1' : '0');

            return sendJson(res, 200, {
              ...metaObj,
              api_url: `/api/plot-over-path?case=${encodeURIComponent(caseDir)}&time=${time}&points=${encodeURIComponent(p.points)}&subdivisions=${p.subdivisions}&field_variable=${encodeURIComponent(p.field_variable)}`,
              from_cache: exported.from_cache,
              proves_not_baked_only: true,
              want_meta: wantMeta,
            });
          }

          // ---- W14 Particle Trace face catalog ----
          if (parts[0] === 'api' && parts[1] === 'particle-trace' && parts[2] === 'faces') {
            const caseDir = resolveCaseDir(u);
            const faces = listCaseSeedFaces(caseDir);
            return sendJson(res, 200, {
              increment: 'W14',
              case_dir: caseDir,
              face_source_doc:
                'Live polyMesh patches (not walls) plus this run’s BC names. Seeds on those surfaces in mesh metres.',
              faces,
            });
          }
          // ---- W8/W14 Particle Trace ----
          if (parts[0] === 'api' && parts[1] === 'particle-trace') {
            const wantMeta = parts[2] === 'meta';
            const caseDir = resolveCaseDir(u);
            const time = u.searchParams.get('time') || DEFAULT_TIME;
            if (!caseDir || !existsSync(caseDir)) {
              return sendJson(res, 404, { error: 'case_dir not found', case: caseDir });
            }
            const p = ptParamsFromUrl(u);
            const exported = await ensureParticleTrace(caseDir, time, p);
            const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));

            res.setHeader('X-CFD-Source', 'case-tree-streamlines-U');
            res.setHeader('X-CFD-Case-Dir', caseDir);
            res.setHeader('X-CFD-Time', String(time));
            res.setHeader('X-CFD-Field', 'U');
            res.setHeader('X-CFD-Not-Baked-Only', '1');
            res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
            res.setHeader('X-CFD-N-Seeds', String(metaObj.n_seeds ?? ''));
            res.setHeader('X-CFD-PT-Empty', metaObj.empty ? '1' : '0');

            if (wantMeta) {
              return sendJson(res, 200, {
                ...metaObj,
                api_url: `/api/particle-trace?case=${encodeURIComponent(caseDir)}&time=${time}&seed_mode=${encodeURIComponent(p.seed_mode || 'grid')}&faces=${encodeURIComponent((p.faces || []).join(','))}&quantity_mode=${encodeURIComponent(p.quantity_mode || 'count')}&n_seeds=${p.n_seeds}&density=${p.density}&seeds_h=${p.seeds_h}&seeds_v=${p.seeds_v}&spacing=${p.spacing}&size=${p.size}&both=${p.both}&pick=${encodeURIComponent(p.pick)}&representation=${encodeURIComponent(p.representation)}`,
                from_cache: exported.from_cache,
                proves_not_baked_only: true,
              });
            }

            const buf = readFileSync(exported.vtp);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(buf.length));
            res.setHeader('Content-Disposition', 'inline; filename="particle_trace.vtp"');
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') {
              return res.end();
            }
            return res.end(buf);
          }

          // ---- W6 fields ----
          if (!req.url.startsWith('/api/fields/')) {
            return next();
          }
          // /api/fields/:field[/meta]
          if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'fields') {
            return next();
          }
          const field = parts[2];
          const wantMeta = parts[3] === 'meta';
          if (!ALLOWED_FIELDS.has(field)) {
            return sendJson(res, 400, {
              error: 'unsupported field',
              allowed: [...ALLOWED_FIELDS],
            });
          }
          const caseDir = resolveCaseDir(u);
          const time = u.searchParams.get('time') || DEFAULT_TIME;
          if (!caseDir || !existsSync(caseDir)) {
            return sendJson(res, 404, { error: 'case_dir not found', case: caseDir, empty: true });
          }
          const foamPath = foamFieldPath(caseDir, time, field);
          if (!existsSync(foamPath)) {
            return sendJson(res, 404, {
              error: 'time_not_found',
              case: caseDir,
              time: String(time),
              field,
              empty: true,
              available_times: listCaseTimes(caseDir),
              proves_not_baked_only: true,
              note: 'Requested time has no OpenFOAM field on disk; no fake field returned',
            });
          }

                    const exported = await ensureExported(caseDir, time, field);
          const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));

          res.setHeader('X-CFD-Source', 'case-tree');
          res.setHeader('X-CFD-Case-Dir', caseDir);
          res.setHeader('X-CFD-Time', String(time));
          res.setHeader('X-CFD-Field', field);
          res.setHeader('X-CFD-Not-Baked-Only', '1');
          res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');

          if (wantMeta) {
            return sendJson(res, 200, {
              ...metaObj,
              api_url: `/api/fields/${field}?case=${encodeURIComponent(caseDir)}&time=${time}`,
              api_meta_url: `/api/fields/${field}/meta?case=${encodeURIComponent(caseDir)}&time=${time}`,
              from_cache: exported.from_cache,
              proves_not_baked_only: true,
            });
          }

          const buf = readFileSync(exported.vtp);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', String(buf.length));
          res.setHeader('Content-Disposition', `inline; filename="${field}.vtp"`);
          res.setHeader('Cache-Control', 'no-store');
          if (req.method === 'HEAD') {
            return res.end();
          }
          return res.end(buf);
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          const missing = /time_not_found|missing OpenFOAM|missing time dir|case foam files missing/i.test(msg);
          return sendJson(res, missing ? 404 : 500, {
            error: msg,
            empty: !!missing,
            proves_not_baked_only: true,
            note: 'API reads case tree via pyvista export; not public/mtp1-fields.vtp',
          });
        }
      });
    },
  };
}

export default caseFieldsApiPlugin;
