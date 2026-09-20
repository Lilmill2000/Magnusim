/**
 * Mesh Generate (POST /api/mesh/generate).
 * Standard (default engine)      -> scripts/generate_standard.py: gmsh uniform surface +
 *                                   hex element core + tet shell, OpenFOAM boundary layers.
 * Standard, engine 'cfmesh'      -> scripts/generate_cfmesh_standard.py (legacy cartesianMesh,
 *                                   only with Hex element core on; see hexcore-cfmesh-backup rule).
 * Hex-dominant                   -> snappyHexMesh (isolated; not the Standard path).
 * Cell/point counts always come from the produced polyMesh.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBody1Stl } from './w16-project-geometry.js';
import { activeGeometryId } from './w16-geometry-scope.js';
import { PYTHON, pyTool } from './python-env.js';
import { wslCasePath, wslDistro } from './wsl-env.js';
import { createJobLogger } from './log.js';
import { envGet } from './env-compat.js';
import { writeJsonCli } from './py-json.js';
import { MESH_ENGINES, mesherKeys } from './registry-defaults.js';
import { slimLiveMeshResult, slimMeshDoc } from './mesh-live-slim.js';
import { assembleMeshDoc, persistMeshDoc, persistOneMesh, meshCasePath, meshFolderOf } from './study-io.js';
import { findGeometry, findStudy, walkGeometries } from './project-layout.js';
import { getActiveSimulation } from './w17-sim-catalog.js';
import { scheduleComputeQueueKick } from './server/compute-queue.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
/* Scratch for the Hex-dominant (snappyHexMesh) path: bash scripts, logs, WSL case copies. */
const REPORT_DIR = join(ROOT, '.cache', 'jobs', 'snappy');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const WSL_DISTRO = wslDistro();
/** Case layout template only — geometry surfaces overwritten from project Body1. */
const INCREMENT = 'W25';
const MESH_SURFACE_EXPORT_SCRIPT = pyTool('export_mesh_surface_vtp.py');
const MESH_SURFACE_CACHE_ROOT = join(ROOT, '.cache', 'mesh-surface');
const CFMESH_GENERATE_SCRIPT = pyTool('generate_cfmesh_standard.py');
/** SimScale-style Standard mesher (gmsh surface + hex core + tet shell + layers). */
const STANDARD_GENERATE_SCRIPT = pyTool('generate_standard.py');
const PATH_CFMESH = 'cartesianMesh';
const PATH_STANDARD = 'standard';
const PATH_SNAPPY = 'snappyHexMesh';
const SNAPPY_GENERATE_SCRIPT = pyTool('generate_snappy.py');

/**
 * @typedef {object} LiveMeshJob
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} generate_id
 * @property {string} [path_kind]
 * @property {string|null} [project_id]
 * @property {number} [started_at]
 * @property {string|null} [mesh_id]
 * @property {string|null} [wsl_dst]
 * @property {string|null} [wsl_case]
 * @property {Function} [onUpdate]
 * @property {boolean} [stop_requested]
 * @property {number} [stop_requested_at]
 * @property {boolean} [cancelled_notified]
 */
/** @type {null | LiveMeshJob} */
let liveJob = null;

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

function meshJsonPath(projectId) {
  return join(PROJECTS_ROOT, projectId, 'mesh.json');
}

function projectJsonPath(projectId) {
  return join(PROJECTS_ROOT, projectId, 'project.json');
}

function readMeshDoc(projectId, simId, meshId) {
  if (!projectId || !simId) return null;
  const doc = assembleMeshDoc(projectId, simId, meshId);
  return doc && doc.meshes && doc.meshes.length ? doc : null;
}

/** Settings for meshId only. Never fall back to catalog/first-mesh settings. */
export function settingsForMesh(meshDoc, meshId, posted) {
  const meshes = (meshDoc && meshDoc.meshes) || [];
  const rec = meshId ? meshes.find((m) => m && String(m.id) === String(meshId)) : null;
  const disk = rec && rec.settings ? rec.settings : null;
  if (posted && typeof posted === 'object' && !Array.isArray(posted)) {
    return { ...(disk || {}), ...posted };
  }
  return disk;
}

function writeMeshDoc(projectId, doc) {
  const simId = (doc && doc.simulation_id) || '';
  persistMeshDoc(projectId, simId, slimMeshDoc(doc) || doc);
  return meshJsonPath(projectId);
}

function winToWsl(winPath) {
  const posix = String(winPath).replace(/\\/g, '/');
  const m = posix.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : posix;
}

function existingFile(p) {
  return p && existsSync(p) ? p : null;
}

/**
 * Resolve the active geometry STEP under geometries/Geometry_*.
 * Body1.stl is optional (STEP import no longer tessellates on the way in).
 */
export function resolveProjectGeometry(projectId, opts) {
  const id = projectId || readActiveId();
  if (!id) {
    return { ok: false, error: 'no active project; create W16 project + import STEP first' };
  }
  const projPath = projectJsonPath(id);
  if (!existsSync(projPath)) {
    return { ok: false, error: 'project.json missing', project_id: id };
  }
  let proj;
  try {
    proj = JSON.parse(readFileSync(projPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'project.json unreadable: ' + e, project_id: id };
  }
  const geom = proj.geometry || {};
  const root = join(PROJECTS_ROOT, id);
  const walked = walkGeometries(root);
  const meshId = opts && opts.meshId;
  let preferId = (opts && (opts.geometryId || opts.geomId)) || null;
  if (!preferId && meshId) {
    const simId = studyIdForMesh(id, meshId);
    const study = simId ? findStudy(root, simId) : null;
    if (study && study.geometry_id) preferId = String(study.geometry_id);
  }
  const part =
    (proj.geometries || []).find((g) => g && g.id === (preferId || proj.active_geometry_id || (geom && geom.id))) ||
    (proj.geometries || [])[0] ||
    walked[0] ||
    null;
  const found = part && part.id ? findGeometry(root, part.id) : walked[0] || null;
  const partDir = (found && found.dir) || null;
  const step_path =
    existingFile(partDir && join(partDir, 'source.step')) ||
    existingFile(part && part.step_path) ||
    existingFile(geom.step_path);
  const body1_path =
    existingFile(partDir && join(partDir, 'Body1.stl')) ||
    existingFile(part && part.stl_path) ||
    existingFile(geom.stl_path);
  if (!step_path) {
    return {
      ok: false,
      error: 'W16 source.step missing — import geometry first',
      project_id: id,
      step_path: (part && part.step_path) || (partDir && join(partDir, 'source.step')) || geom.step_path || null,
      body1_path,
    };
  }
  const stepSt = statSync(step_path);
  if (stepSt.size < 32) {
    return {
      ok: false,
      error: 'geometry files too small / empty',
      project_id: id,
      step_path,
      body1_path,
      step_bytes: stepSt.size,
    };
  }
  const stepBuf = readFileSync(step_path);
  const step_sha256 = createHash('sha256').update(stepBuf).digest('hex');
  let body1_bytes = 0;
  let body1_sha256 = null;
  if (body1_path) {
    const bodySt = statSync(body1_path);
    body1_bytes = bodySt.size;
    if (bodySt.size >= 100) {
      body1_sha256 = createHash('sha256').update(readFileSync(body1_path)).digest('hex');
    }
  }
  return {
    ok: true,
    project_id: id,
    step_path,
    body1_path,
    step_bytes: stepSt.size,
    body1_bytes,
    step_sha256,
    body1_sha256,
    geometry_name: (part && part.name) || geom.name || null,
    wsl_step: winToWsl(step_path),
    wsl_body1: body1_path ? winToWsl(body1_path) : null,
    cad_faces_path: partDir ? join(partDir, 'cad_faces.vtp') : null,
    bounds:
      (geom.fingerprint && geom.fingerprint.bounds) ||
      (geom.fingerprint &&
        geom.fingerprint.convert_meta &&
        geom.fingerprint.convert_meta.bounds) ||
      null,
  };
}

function clampFineness(fineness) {
  const f = Math.round(Number(fineness));
  if (!Number.isFinite(f)) return 5;
  return Math.max(1, Math.min(10, f));
}

export function readPolyMeshCounts(polyMeshDir) {
  const pointsPath = join(polyMeshDir, 'points');
  const ownerPath = join(polyMeshDir, 'owner');
  if (!existsSync(pointsPath) || !existsSync(ownerPath)) {
    return {
      n_points: null,
      n_cells: null,
      n_faces: null,
      points_path: pointsPath,
      owner_path: ownerPath,
    };
  }
  const pointsTxt = readFileSync(pointsPath, 'utf8');
  const ownerTxt = readFileSync(ownerPath, 'utf8');

  function firstIntAfterHeader(txt) {
    const lines = txt.split(/\r?\n/);
    let past = false;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!past) {
        if (s === '}' || s.startsWith('// *****')) past = true;
        continue;
      }
      if (/^\d+$/.test(s) && i > 5) return parseInt(s, 10);
    }
    return null;
  }

  const n_points = firstIntAfterHeader(pointsTxt);
  const ownerLines = ownerTxt.split(/\r?\n/);
  let mode = 'seek';
  const vals = [];
  let n_faces = null;
  for (let i = 0; i < ownerLines.length; i++) {
    const s = ownerLines[i].trim();
    if (mode === 'seek') {
      if (/^\d+$/.test(s) && i > 10) {
        n_faces = parseInt(s, 10);
        mode = 'paren';
      }
      continue;
    }
    if (mode === 'paren') {
      if (s === '(') mode = 'vals';
      continue;
    }
    if (mode === 'vals') {
      if (s === ')') break;
      if (/^-?\d+$/.test(s)) vals.push(parseInt(s, 10));
    }
  }
  let maxOwner = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > maxOwner) maxOwner = vals[i];
  }
  const n_cells = vals.length ? maxOwner + 1 : null;
  return {
    n_points,
    n_cells,
    n_faces: n_faces != null ? n_faces : vals.length,
    points_path: pointsPath,
    owner_path: ownerPath,
    source: 'polyMesh/points+owner',
  };
}

function readEmeshStats(emeshPath) {
  if (!existsSync(emeshPath)) return { present: false, n_points: null, n_edges: null, bytes: 0 };
  const st = statSync(emeshPath);
  const lines = readFileSync(emeshPath, 'utf8').split(/\r?\n/);
  const ints = [];
  let past = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!past) {
      if (s === '}' || s.startsWith('// *****')) past = true;
      continue;
    }
    if (/^\d+$/.test(s)) ints.push(parseInt(s, 10));
    if (ints.length >= 2) break;
  }
  return {
    present: true,
    n_points: ints[0] ?? null,
    n_edges: ints[1] ?? null,
    bytes: st.size,
    path: emeshPath,
  };
}

function fingerprintPolyMesh(polyMeshDir) {
  const pointsPath = join(polyMeshDir, 'points');
  const ownerPath = join(polyMeshDir, 'owner');
  const h = createHash('sha256');
  if (existsSync(pointsPath)) {
    const st = statSync(pointsPath);
    h.update(`points:${st.size}:${st.mtimeMs}`);
    const buf = readFileSync(pointsPath);
    h.update(buf.subarray(0, Math.min(2048, buf.length)));
    if (buf.length > 2048) h.update(buf.subarray(buf.length - 2048));
  }
  if (existsSync(ownerPath)) {
    const st = statSync(ownerPath);
    h.update(`owner:${st.size}:${st.mtimeMs}`);
    const buf = readFileSync(ownerPath);
    h.update(buf.subarray(0, Math.min(2048, buf.length)));
    if (buf.length > 2048) h.update(buf.subarray(buf.length - 2048));
  }
  const counts = readPolyMeshCounts(polyMeshDir);
  h.update(`cells:${counts.n_cells}:pts:${counts.n_points}`);
  return { sha256: h.digest('hex'), ...counts };
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

function meshSurfaceCacheKey(caseDir) {
  const h = createHash('sha256')
    .update(String(caseDir) + '|' + polyMeshCacheToken(caseDir))
    .digest('hex')
    .slice(0, 16);
  return join(MESH_SURFACE_CACHE_ROOT, `surface-${h}.vtp`);
}

function prewarmMeshSurface(winOut) {
  if (!existsSync(MESH_SURFACE_EXPORT_SCRIPT) || !existsSync(PYTHON)) {
    return { ok: false, skipped: 'missing_tool' };
  }
  mkdirSync(MESH_SURFACE_CACHE_ROOT, { recursive: true });
  const outVtp = meshSurfaceCacheKey(winOut);
  const metaPath = outVtp.replace(/\.vtp$/i, '.meta.json');
  const r = spawnSync(
    PYTHON,
    [MESH_SURFACE_EXPORT_SCRIPT, '--case', winOut, '--out', outVtp, '--meta', metaPath],
    { encoding: 'utf8', timeout: 180000, windowsHide: true }
  );
  return { ok: r.status === 0 && existsSync(outVtp), path: outVtp, status: r.status };
}

export function pidIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return true;
    return false;
  }
}

export function liveChildIsRunning(child) {
  if (!child || child.killed) return false;
  if (child.exitCode != null || child.signalCode) return false;
  if (!child.pid) return false;
  return pidIsAlive(child.pid);
}

function dropDeadLiveJob() {
  if (!liveJob) return;
  if (!liveChildIsRunning(liveJob.child)) liveJob = null;
}

export function isLiveMeshJobHeld() {
  dropDeadLiveJob();
  return !!(liveJob && liveChildIsRunning(liveJob.child));
}

/**
 * @param {LiveMeshJob | null | undefined} live
 * @param {{ meshId?: string, projectId?: string }} [ids]
 */
export function meshStopMatchesLive(live, { meshId, projectId } = {}) {
  if (!live) return { match: false, reason: 'idle' };
  if (meshId && live.mesh_id && String(live.mesh_id) !== String(meshId)) {
    return { match: false, reason: 'other_mesh' };
  }
  if (projectId && live.project_id && String(live.project_id) !== String(projectId)) {
    return { match: false, reason: 'other_project' };
  }
  return { match: true, reason: 'ok' };
}

/** @param {{ stopRequested?: boolean, ok?: boolean }} [close] */
export function meshCloseStatus({ stopRequested, ok } = {}) {
  if (stopRequested) return 'stopped';
  return ok ? 'done' : 'failed';
}

function bindLiveMeshJob({
  child,
  generate_id,
  path_kind,
  project_id,
  started_at,
  mesh_id,
  wsl_dst,
  onUpdate,
}) {
  const job = {
    child,
    generate_id,
    path_kind,
    project_id,
    started_at,
    mesh_id: mesh_id || null,
    wsl_dst: wsl_dst || null,
    wsl_case: wsl_dst ? wslCasePath(wsl_dst) : null,
    onUpdate: typeof onUpdate === 'function' ? onUpdate : () => {},
    stop_requested: false,
    cancelled_notified: false,
  };
  liveJob = job;
  return job;
}

function killWindowsPidTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 8000,
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

/** Kill leftover generate_* processes still pointed at this mesh case folder. */
function reapStaleMeshGenerators(caseDir) {
  if (!caseDir) return;
  const lockPath = join(caseDir, '.generate.lock');
  try {
    if (existsSync(lockPath)) {
      const prev = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (prev && prev.pid) killWindowsPidTree(prev.pid);
    }
  } catch {
    /* ignore */
  }
  if (process.platform !== 'win32') return;
  const like = '*' + String(caseDir).replace(/'/g, "''") + '*';
  try {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*generate_standard.py*' -or $_.CommandLine -like '*generate_snappy.py*' -or $_.CommandLine -like '*generate_cfmesh_standard.py*') -and $_.CommandLine -like '" +
          like +
          "' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    for (const tok of String(r.stdout || '').split(/\s+/)) {
      const pid = Number(tok);
      if (Number.isInteger(pid) && pid > 0) killWindowsPidTree(pid);
    }
  } catch {
    /* ignore */
  }
}

function killWslMeshCase(job) {
  const needles = [];
  if (job && job.wsl_dst) needles.push(String(job.wsl_dst));
  if (job && job.generate_id) {
    needles.push(`cfddesk-cfdweb-${job.generate_id}`);
    needles.push(`cfddesk-w25-${job.generate_id}`);
  }
  if (job && job.wsl_case) {
    const last = String(job.wsl_case)
      .split('/')
      .filter(Boolean)
      .pop();
    if (last) needles.push(last);
  }
  const cleaned = [
    ...new Set(
      needles
        .map((s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, ''))
        .filter(Boolean)
    ),
  ];
  if (!cleaned.length) return;
  try {
    spawn(
      'wsl',
      ['-d', wslDistro(), '--', 'bash', '-lc', `pkill -f ${JSON.stringify(cleaned.join('|'))} || true`],
      { windowsHide: true, stdio: 'ignore' }
    );
  } catch {
    /* ignore */
  }
}

function notifyMeshStopped(job) {
  if (!job || job.cancelled_notified) return;
  job.cancelled_notified = true;
  const terminal = {
    status: 'stopped',
    mode: 'mesh',
    path_kind: job.path_kind || PATH_CFMESH,
    generate_id: job.generate_id,
    kick_id: job.generate_id,
    pid: null,
    exit_code: null,
    finished_at: new Date().toISOString(),
    project_id: job.project_id,
    mesh_id: job.mesh_id,
    wsl_case: job.wsl_case,
    stage: 'stopped',
    error: 'cancelled',
    note: 'Mesh generate cancelled.',
    increment: INCREMENT,
  };
  try {
    persistMeshResult(job.project_id, terminal);
  } catch {
    /* ignore */
  }
  try {
    job.onUpdate(terminal);
  } catch {
    /* ignore */
  }
  scheduleComputeQueueKick(250);
}

/** Kill the live generate for this mesh so the next queued job can start. */
/** @param {{ meshId?: string, projectId?: string }} [ids] */
export function stopMeshGenerate({ meshId, projectId } = {}) {
  dropDeadLiveJob();
  const job = liveJob;
  const match = meshStopMatchesLive(job, { meshId, projectId });
  const id = projectId || (job && job.project_id) || readActiveId();
  const mid = meshId || (job && job.mesh_id);
  let caseDir = null;
  if (id && mid) {
    try {
      caseDir = meshCasePath(id, mid, studyIdForMesh(id, mid));
    } catch {
      caseDir = null;
    }
  }
  if (!match.match) {
    reapStaleMeshGenerators(caseDir);
    return {
      ok: true,
      status: 200,
      bodyExtra: { ok: true, stopped: !!caseDir, reason: match.reason, increment: INCREMENT },
    };
  }
  job.stop_requested = true;
  job.stop_requested_at = Date.now();
  const pid = job.child && job.child.pid;
  try {
    job.child.kill();
  } catch {
    /* ignore */
  }
  killWindowsPidTree(pid);
  killWslMeshCase(job);
  reapStaleMeshGenerators(caseDir);
  notifyMeshStopped(job);
  if (liveJob === job) liveJob = null;
  return {
    ok: true,
    status: 200,
    bodyExtra: {
      ok: true,
      stopped: true,
      mesh_id: job.mesh_id || meshId || null,
      generate_id: job.generate_id || null,
      increment: INCREMENT,
    },
  };
}

/** Case on disk is a finished generate even if mesh.json never flipped. */
export function inspectGeneratedCase(caseDir) {
  if (!caseDir) return null;
  const polyDir = join(caseDir, 'constant', 'polyMesh');
  const points = join(polyDir, 'points');
  if (!existsSync(points)) return null;
  let n_cells = null;
  let n_points = null;
  let n_faces = null;
  let source = null;
  let generate_id = null;
  const countsJson = join(caseDir, 'w21-counts.json');
  if (existsSync(countsJson)) {
    try {
      const j = JSON.parse(readFileSync(countsJson, 'utf8'));
      n_cells = j.n_cells ?? null;
      n_points = j.n_points ?? null;
      n_faces = j.n_faces ?? null;
      generate_id = j.generate_id != null ? String(j.generate_id) : null;
      source = j.source || 'w21-counts.json';
    } catch {
      /* ignore */
    }
  }
  let script_ok = false;
  for (const name of ['log.standard_generate.txt', 'log.cartesianMesh', 'log.snappyHexMesh']) {
    const p = join(caseDir, name);
    if (!existsSync(p)) continue;
    try {
      const t = readFileSync(p, 'utf8');
      if (t.includes('MESH_SCRIPT_OK') || /mesh OK/i.test(t) || /End\b/.test(t)) {
        script_ok = true;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  return {
    ok: true,
    case_dir: caseDir,
    mesh_path: polyDir,
    n_cells,
    n_points,
    n_faces,
    counts_source: source || 'polyMesh/points',
    generate_id,
    script_ok,
  };
}

export function recoverStudyMeshesFromDisk(projectId, simId) {
  if (!projectId || !simId) return 0;
  dropDeadLiveJob();
  const doc = assembleMeshDoc(projectId, simId);
  let n = 0;
  for (const m of doc.meshes || []) {
    if (!m || !m.id) continue;
    if (isLiveMeshJobHeld() && liveJob.mesh_id && String(liveJob.mesh_id) === String(m.id)) continue;
    const live = m.live_mesh_result;
    if (live && (live.status === 'stopped' || live.status === 'cancelled')) continue;
    if (m.generated && live && live.status === 'done') continue;
    const caseDir = (live && live.case_dir) || m.case_dir || meshCasePath(projectId, m.id, simId);
    const found = inspectGeneratedCase(caseDir);
    if (!found) continue;
    persistMeshResult(projectId, {
      status: 'done',
      mesh_id: m.id,
      simulation_id: simId,
      path_kind: (live && live.path_kind) || PATH_STANDARD,
      generate_id: found.generate_id || (live && live.generate_id) || null,
      case_dir: found.case_dir,
      mesh_path: found.mesh_path,
      n_cells: found.n_cells,
      n_points: found.n_points,
      n_faces: found.n_faces,
      counts_source: found.counts_source,
      finished_at: new Date().toISOString(),
      note:
        found.n_cells != null
          ? `Recovered generated mesh from case (${found.n_cells} cells).`
          : 'Recovered generated mesh from polyMesh on disk.',
    });
    n += 1;
  }
  return n;
}


function studyIdForMesh(projectId, meshId) {
  const folder = meshId ? meshFolderOf(projectId, meshId) : null;
  return folder && folder.simulation_id ? String(folder.simulation_id) : '';
}

export function persistMeshResult(projectId, resultFields) {
  if (!projectId) return null;
  const simId =
    (resultFields && resultFields.simulation_id) ||
    studyIdForMesh(projectId, resultFields && resultFields.mesh_id);
  /** @type {{ meshes?: any[], active_id?: string, id?: string, out_of_scope?: unknown, [k: string]: any }} */
  const existing = readMeshDoc(projectId, simId) || {};
  const now = new Date().toISOString();
  const pathKind = resultFields.path_kind || PATH_SNAPPY;
  const increment = resultFields.increment || INCREMENT;
  const live = {
    status: resultFields.status,
    path_kind: pathKind,
    generate_id: resultFields.generate_id,
    pid: resultFields.pid,
    exit_code: resultFields.exit_code,
    command: resultFields.command,
    log_path: resultFields.log_path,
    log_excerpt: slimLiveMeshResult({ log_excerpt: resultFields.log_excerpt || null }).log_excerpt,
    wsl_case: resultFields.wsl_case,
    case_dir: resultFields.case_dir,
    mesh_path:
      resultFields.mesh_path ||
      (resultFields.case_dir ? join(resultFields.case_dir, 'constant', 'polyMesh') : null),
    n_cells: resultFields.n_cells ?? null,
    n_points: resultFields.n_points ?? null,
    n_faces: resultFields.n_faces ?? null,
    counts_source: resultFields.counts_source || null,
    emesh: resultFields.emesh || null,
    feature_marks_total: resultFields.feature_marks_total ?? null,
    fingerprint_before: resultFields.fingerprint_before || null,
    fingerprint_after: resultFields.fingerprint_after || null,
    started_at: resultFields.started_at,
    finished_at: resultFields.finished_at || null,
    settings_snapshot: resultFields.settings_snapshot || null,
    geometry: resultFields.geometry || null,
    step_path: resultFields.step_path || null,
    body1_path: resultFields.body1_path || null,
    engine: resultFields.engine || null,
    stage: resultFields.stage || null,
    stage_detail: resultFields.stage_detail || null,
    error: resultFields.error || null,
    hex_core_applied: resultFields.hex_core_applied ?? null,
    layers_applied: resultFields.layers_applied ?? null,
    surface_size_m: resultFields.surface_size_m ?? null,
    note: resultFields.note,
    increment,
  };
  const fallbackNote =
    resultFields.status === 'done'
      ? `Mesh done: ${live.n_cells} cells, ${live.n_points} points.`
      : resultFields.status === 'failed'
        ? `Mesh failed (exit ${resultFields.exit_code}).`
        : resultFields.status === 'stopped'
          ? 'Mesh generate cancelled.'
          : 'Mesh running.';
  const generated = resultFields.status === 'done';
  const meshId = resultFields.mesh_id || null;
  const ownedCase = meshId ? meshCasePath(projectId, meshId, simId) : null;
  if (ownedCase) {
    live.case_dir = ownedCase;
    live.mesh_path = join(ownedCase, 'constant', 'polyMesh');
  }
  let meshes = Array.isArray(existing.meshes) ? existing.meshes.slice() : null;
  if (meshes && meshes.length) {
    if (!meshId) return existing;
    const matchesLive = (m) => !!(m && String(m.id) === String(meshId));
    let hit = 0;
    meshes = meshes.map((m) => {
      if (!matchesLive(m)) return m;
      hit += 1;
      return {
        ...m,
        generated,
        live_mesh_result: live,
        updated_at: now,
      };
    });
    if (!hit) return existing;
    const nextActive =
      (existing.active_id && meshes.some((m) => m && m.id === existing.active_id)
        ? existing.active_id
        : null) ||
      (meshId && meshes.some((m) => m && m.id === meshId) ? meshId : null);
    const activeEntry = meshes.find((m) => m && m.id === nextActive) || null;
    const doc = {
      ...existing,
      generated: !!(activeEntry && activeEntry.generated),
      generate_available: true,
      live_mesh_result: (activeEntry && activeEntry.live_mesh_result) || null,
      note: resultFields.note || fallbackNote,
      updated_at: now,
      increment,
      active_id: nextActive,
      meshes,
    };
    delete doc.out_of_scope;
    const updated = meshes.find((m) => m && String(m.id) === String(meshId));
    if (updated) persistOneMesh(projectId, simId, { ...updated, simulation_id: simId });
    return assembleMeshDoc(projectId, simId, meshId);
  }
  const doc = {
    ...existing,
    generated,
    generate_available: true,
    live_mesh_result: live,
    note: resultFields.note || fallbackNote,
    updated_at: now,
    increment,
    active_id: existing.active_id || existing.id || meshId || null,
  };
  delete doc.out_of_scope;
  writeMeshDoc(projectId, slimMeshDoc(doc));
  return doc;
}

/**
 * Resolve MeshBackend dump key from mesh.json settings.
 * Explicit settings.mesh_backend / advanced.mesh_backend wins when registered.
 * Else: Hex-dominant → snappy_hexdominant; Standard + cfmesh hex-core → cfmesh;
 * otherwise standard. Migration for existing mesh.json (algorithm + mesh_engine).
 */
function resolveMeshBackend(settings) {
  const keys = new Set(mesherKeys());
  const adv = (settings && settings.advanced) || {};
  const explicit = String(
    (settings && settings.mesh_backend) || adv.mesh_backend || ''
  ).trim();
  if (explicit && keys.has(explicit)) return explicit;

  const algo = String((settings && settings.algorithm) || 'Standard')
    .trim()
    .toLowerCase();
  if (algo.startsWith('hex-dominant') || algo === 'hexdominant') {
    return keys.has('snappy_hexdominant') ? 'snappy_hexdominant' : 'snappy_hexdominant';
  }
  const eng = String(adv.mesh_engine || (settings && settings.mesh_engine) || 'standard')
    .trim()
    .toLowerCase();
  if (eng === 'cfmesh' && wantsHexCore(settings) && keys.has('cfmesh') && MESH_ENGINES.has('cfmesh')) {
    return 'cfmesh';
  }
  if (keys.has('standard')) return 'standard';
  return MESH_ENGINES.values().next().value || 'standard';
}

function wantsStandard(settings) {
  const backend = resolveMeshBackend(settings);
  return backend === 'standard' || backend === 'cfmesh';
}

function wantsHexCore(settings) {
  return !settings || settings.hex_element_core === undefined
    ? true
    : !!settings.hex_element_core;
}

/**
 * Standard engine: 'standard' (SimScale-style gmsh surface + hex core, default)
 * or 'cfmesh' (legacy cartesianMesh, hex core only). Chosen in Advanced settings.
 */
function standardEngine(settings) {
  const backend = resolveMeshBackend(settings);
  return backend === 'cfmesh' ? 'cfmesh' : 'standard';
}

function wantsHexDominant(settings) {
  return resolveMeshBackend(settings) === 'snappy_hexdominant';
}

function parseCfmeshLine(line) {
  const s = String(line || '').trim();
  if (s.startsWith('CFMESH_PROGRESS ')) {
    try {
      return { kind: 'progress', data: JSON.parse(s.slice('CFMESH_PROGRESS '.length)) };
    } catch {
      return null;
    }
  }
  if (s.startsWith('CFMESH_RESULT ')) {
    try {
      return { kind: 'result', data: JSON.parse(s.slice('CFMESH_RESULT '.length)) };
    } catch {
      return null;
    }
  }
  // Phase 1 Step 7: MAGNUSIM_EVENT / CFDDESK_EVENT progress|result (same stage names).
  for (const prefix of ['MAGNUSIM_EVENT ', 'CFDDESK_EVENT ']) {
    if (!s.startsWith(prefix)) continue;
    try {
      const data = JSON.parse(s.slice(prefix.length));
      if (!data || typeof data !== 'object') return null;
      if (data.event === 'progress') return { kind: 'progress', data };
      if (data.event === 'result') return { kind: 'result', data };
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveProjectStep(projectId, meshId) {
  return resolveProjectGeometry(projectId, meshId ? { meshId } : undefined);
}

/**
 * Standard mesh generate (python host script + WSL OpenFOAM tools).
 * engine 'standard' → generate_standard.py (gmsh surface, hex core, layers)
 * engine 'cfmesh'   → generate_cfmesh_standard.py (legacy cartesianMesh)
 */
function startStandardGenerate({ settings, projectId, onUpdate, engine, meshId }) {
  const pathKind = engine === 'cfmesh' ? PATH_CFMESH : PATH_STANDARD;
  if (!meshId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh_id required', path_kind: pathKind },
    };
  }
  const geometry = resolveProjectStep(projectId, meshId);
  if (!geometry.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: geometry.error,
        step_path: geometry.step_path || null,
        project_id: geometry.project_id || projectId || readActiveId(),
        path_kind: pathKind,
      },
    };
  }

  const generateId = stampId();
  const project_id = geometry.project_id;
  const simIdEarly = studyIdForMesh(project_id, meshId);
  const meshDoc = project_id && simIdEarly ? readMeshDoc(project_id, simIdEarly, meshId) : null;
  const settings_snapshot = settingsForMesh(meshDoc, meshId, settings) || settings || null;
  const fineness =
    settings_snapshot && settings_snapshot.fineness != null
      ? settings_snapshot.fineness
      : 5;
  const addLayers =
    !settings_snapshot || settings_snapshot.automatic_boundary_layers === undefined
      ? true
      : !!settings_snapshot.automatic_boundary_layers;
  const physicsBased =
    !settings_snapshot || settings_snapshot.physics_based_meshing === undefined
      ? true
      : !!settings_snapshot.physics_based_meshing;
  const hexCore = wantsHexCore(settings_snapshot);
  const adv = (settings_snapshot && settings_snapshot.advanced) || {};
  const smallFeature =
    adv.small_feature_suppression == null || String(adv.small_feature_suppression).trim() === ''
      ? 'auto'
      : String(adv.small_feature_suppression).trim();
  const gapFactor = Number.isFinite(Number(adv.gap_refinement_factor))
    ? Number(adv.gap_refinement_factor)
    : 0.05;
  const gradation = Number.isFinite(Number(adv.global_gradation_rate))
    ? Number(adv.global_gradation_rate)
    : 1.22;

  const wslDst = `cfddesk-cfdweb-${generateId}`;
  const winOut = meshCasePath(project_id, meshId, simIdEarly);
  if (!winOut) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh folder missing — create Mesh first', mesh_id: meshId, path_kind: pathKind },
    };
  }
  mkdirSync(winOut, { recursive: true });
  reapStaleMeshGenerators(winOut);
  // Phase 1 land10: job logs live under .cache (not projects/); job-runner/log.js owns JSONL.
  mkdirSync(REPORT_DIR, { recursive: true });
  const winLog = join(REPORT_DIR, `generate-${generateId}.log`);
  const projectDir = join(PROJECTS_ROOT, project_id);

  let fingerprint_before = null;
  try {
    const prev = join(winOut, 'constant', 'polyMesh');
    if (existsSync(join(prev, 'owner')) && existsSync(join(prev, 'points'))) {
      fingerprint_before = fingerprintPolyMesh(prev);
    }
  } catch {
    fingerprint_before = null;
  }

  const argv = [
    PYTHON,
    engine === 'cfmesh' ? CFMESH_GENERATE_SCRIPT : STANDARD_GENERATE_SCRIPT,
    '--project-dir',
    projectDir,
    '--case-dir',
    winOut,
    '--wsl-case',
    wslDst,
    '--generate-id',
    generateId,
    '--fineness',
    String(clampFineness(fineness)),
    '--add-layers',
    addLayers ? '1' : '0',
    '--physics-based',
    physicsBased ? '1' : '0',
  ];
  if (engine !== 'cfmesh') {
    argv.push(
      '--hex-core',
      hexCore ? '1' : '0',
      '--small-feature',
      smallFeature,
      '--gap-factor',
      String(gapFactor),
      '--gradation',
      String(gradation),
    );
  }
  const scopedMeshId = meshId || '';
  if (scopedMeshId) {
    argv.push('--mesh-id', String(scopedMeshId));
  }
  const meshRec = ((meshDoc && meshDoc.meshes) || []).find((m) => m && String(m.id) === String(meshId));
  const simId = (meshRec && meshRec.simulation_id) || (meshDoc && meshDoc.simulation_id) || '';
  if (simId) argv.push('--simulation-id', String(simId));
  const command = argv.join(' ');
  const started_at = new Date().toISOString();
  const engineLabel = engine === 'cfmesh' ? 'cfMesh cartesianMesh' : 'Standard';

  let logBuf = '';
  let lastResult = null;
  const jobLog = createJobLogger('mesh', generateId);
  const child = spawn(argv[0], argv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const job = bindLiveMeshJob({
    child,
    generate_id: generateId,
    path_kind: pathKind,
    project_id,
    started_at,
    mesh_id: meshId || null,
    wsl_dst: wslDst,
    onUpdate,
  });
  jobLog.info('spawn', { pid: child.pid || null, path_kind: pathKind, engine });
  try {
    writeFileSync(winLog, '', 'utf8');
  } catch {}

  const baseRunning = {
    status: 'running',
    mode: 'mesh',
    path_kind: pathKind,
    engine,
    generate_id: generateId,
    kick_id: generateId,
    pid: child.pid || null,
    exit_code: null,
    command,
    argv,
    started_at,
    finished_at: null,
    log_path: winLog,
    log_jsonl_path: jobLog.path,
    log_excerpt: '',
    wsl_case: wslCasePath(wslDst),
    case_dir: winOut,
    mesh_path: join(winOut, 'constant', 'polyMesh'),
    n_cells: null,
    n_points: null,
    n_faces: null,
    counts_source: null,
    emesh: null,
    feature_marks_total: null,
    fingerprint_before,
    fingerprint_after: null,
    project_id,
    settings_snapshot,
    fineness_used: fineness,
    add_layers_used: addLayers,
    geometry: {
      step_path: geometry.step_path,
      body1_path: geometry.body1_path,
      step_sha256: geometry.step_sha256,
      body1_sha256: geometry.body1_sha256,
      geometry_name: geometry.geometry_name,
      source: 'W16_project_STEP',
    },
    step_path: geometry.step_path,
    body1_path: geometry.body1_path,
    stage: 'starting',
    stage_detail: null,
    note: `${engineLabel} mesh on project STEP (fineness ${fineness}, hex core ${hexCore ? 'on' : 'off'}, layers ${addLayers ? 'on' : 'off'}).`,
    mesh_id: job.mesh_id,
  };
  persistMeshResult(project_id, baseRunning);

  let lastStage = null;
  let lineCarry = '';
  const flushParsedLine = (line) => {
    const parsed = parseCfmeshLine(line);
    if (!parsed) return;
    if (parsed.kind === 'result') lastResult = parsed.data;
    if (parsed.kind === 'progress' && parsed.data && parsed.data.stage) {
      const stage = String(parsed.data.stage);
      const detail = parsed.data.msg ? String(parsed.data.msg) : null;
      if (stage !== lastStage || detail) {
        lastStage = stage;
        if (liveJob && liveJob.child === child) {
          const running = { ...baseRunning, stage, stage_detail: detail };
          try {
            persistMeshResult(project_id, running);
            onUpdate(running);
          } catch (_) {}
        }
      }
    }
  };
  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    // Carry incomplete trailing fragment across chunks so JSON result lines
    // split mid-chunk still set lastResult (avoids exit_code 45 false-fail).
    lineCarry += s;
    const parts = lineCarry.split(/\r?\n/);
    lineCarry = parts.pop() ?? '';
    for (const line of parts) flushParsedLine(line);
  };
  const flushLineCarry = () => {
    if (!lineCarry) return;
    const rem = lineCarry;
    lineCarry = '';
    flushParsedLine(rem);
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('error', (err) => {
    logBuf += `\nSPAWN_ERROR: ${err}\n`;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    if (job.stop_requested) {
      if (liveJob && liveJob.child === child) liveJob = null;
      notifyMeshStopped(job);
      scheduleComputeQueueKick(250);
      return;
    }
    liveJob = null;
    const failed = {
      ...baseRunning,
      status: 'failed',
      exit_code: -1,
      finished_at: new Date().toISOString(),
      log_excerpt: logBuf.slice(-2000),
      error: String(err),
      note: `${engineLabel} mesher failed to start: ${err}`,
    };
    persistMeshResult(project_id, failed);
    onUpdate(failed);
    scheduleComputeQueueKick(250);
  });

  // Decide on 'close' (not 'exit'): exit can fire while the final JSON result
  // chunk is still in the pipe; close waits until stdout/stderr are fully drained.
  child.on('close', (code, signal) => {
    flushLineCarry();
    if (liveJob && liveJob.child === child) liveJob = null;
    if (job.stop_requested) {
      notifyMeshStopped(job);
      return;
    }
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const finished_at = new Date().toISOString();
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    const polyDir = join(winOut, 'constant', 'polyMesh');
    let counts = { n_cells: null, n_points: null, n_faces: null, source: null };
    const inspected = inspectGeneratedCase(winOut);
    try {
      if (inspected) {
        counts = {
          n_cells: inspected.n_cells,
          n_points: inspected.n_points,
          n_faces: inspected.n_faces,
          source: inspected.counts_source,
        };
      } else if (existsSync(polyDir)) {
        const c = readPolyMeshCounts(polyDir);
        counts = {
          n_cells: c.n_cells,
          n_points: c.n_points,
          n_faces: c.n_faces,
          source: c.source,
        };
      }
      if (lastResult) {
        if (counts.n_cells == null) counts.n_cells = lastResult.n_cells ?? null;
        if (counts.n_points == null) counts.n_points = lastResult.n_points ?? null;
        if (counts.n_faces == null) counts.n_faces = lastResult.n_faces ?? null;
      }
    } catch (e) {
      logBuf += `\nCOUNT_PARSE_ERROR: ${e}\n`;
    }

    const scriptOk = (lastResult && lastResult.ok === true) || !!(inspected && inspected.script_ok);
    const hasMesh = existsSync(join(polyDir, 'points')) && (counts.n_cells != null || !!(inspected && inspected.ok));
    const ok = exit_code === 0 && scriptOk && hasMesh;
    const status = meshCloseStatus({ stopRequested: job.stop_requested, ok });

    const terminal = {
      ...baseRunning,
      status,
      exit_code: ok ? 0 : exit_code === 0 && !ok ? 45 : exit_code,
      finished_at,
      log_excerpt: logBuf.slice(-4000),
      case_dir: winOut,
      mesh_path: polyDir,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.source,
      fingerprint_after: null,
      script_result: lastResult,
      stage: status,
      stage_detail: null,
      error:
        status === 'done'
          ? null
          : status === 'stopped'
            ? 'cancelled'
            : exit_code === 75
              ? 'Volume fill timed out. Reduce inflate thickness or fineness and generate again.'
              : (lastResult && lastResult.error) || `exit ${exit_code}`,
      hex_core_applied: lastResult && lastResult.hex_core != null ? !!lastResult.hex_core : hexCore,
      layers_applied: lastResult && lastResult.layers_applied != null ? !!lastResult.layers_applied : null,
      surface_size_m: (lastResult && lastResult.surface_size_m) || null,
      signal: signal || null,
      note:
        status === 'done'
          ? `${engineLabel} mesh done: ${counts.n_cells} cells, ${counts.n_points} points.`
          : status === 'stopped'
            ? 'Mesh generate cancelled.'
            : exit_code === 75
              ? 'Volume fill timed out. Reduce inflate thickness or fineness and generate again.'
              : `${engineLabel} mesh failed (exit ${exit_code}${lastResult && lastResult.error ? ': ' + lastResult.error : ''}).`,
    };
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
    scheduleComputeQueueKick(250);
    setImmediate(() => {
      if (job.stop_requested) return;
      let fingerprint_after = null;
      try {
        if (existsSync(polyDir)) fingerprint_after = fingerprintPolyMesh(polyDir);
      } catch (fpErr) {
        fingerprint_after = { error: String(fpErr), ...counts };
      }
      try {
        if (existsSync(polyDir)) prewarmMeshSurface(winOut);
      } catch (_) {}
      if (fingerprint_after) {
        try {
          persistMeshResult(project_id, { ...terminal, fingerprint_after });
        } catch (_) {}
      }
    });
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function startMeshGenerate({ settings, projectId, onUpdate, meshId }) {
  if (isLiveMeshJobHeld()) {
    return {
      ok: false,
      status: 409,
      bodyExtra: {
        error: 'mesh generate already running',
        pid: liveJob.child.pid || null,
        generate_id: liveJob.generate_id,
        path_kind: liveJob.path_kind || PATH_CFMESH,
        increment: INCREMENT,
      },
    };
  }
  liveJob = null;

  const projectIdEarly = projectId || readActiveId();
  const meshDocEarly =
    projectIdEarly && meshId
      ? readMeshDoc(projectIdEarly, studyIdForMesh(projectIdEarly, meshId), meshId)
      : null;
  const settingsEarly = settingsForMesh(meshDocEarly, meshId, settings) || settings || null;
  const backend = resolveMeshBackend(settingsEarly);
  const knownBackends = new Set(mesherKeys());
  if (!knownBackends.has(backend)) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: `Unknown mesh backend "${backend}" (algorithm "${settingsEarly && settingsEarly.algorithm}").`,
        path_kind: null,
      },
    };
  }
  if (wantsStandard(settingsEarly)) {
    return startStandardGenerate({
      settings: settingsEarly,
      projectId: projectIdEarly,
      onUpdate,
      engine: standardEngine(settingsEarly),
      meshId: meshId || null,
    });
  }
  if (!wantsHexDominant(settingsEarly)) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: `Unknown mesh algorithm "${settingsEarly && settingsEarly.algorithm}".`,
        path_kind: null,
      },
    };
  }
  if (!meshId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh_id required', path_kind: 'snappyHexMesh' },
    };
  }

  const stlReady = ensureBody1Stl(projectId);
  if (!stlReady.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: stlReady.error || 'could not tessellate STEP for mesh generate',
        detail: stlReady.detail || null,
        step_path: stlReady.step_path || null,
        project_id: stlReady.project_id || projectId || readActiveId(),
        path_kind: 'snappyHexMesh',
        mtp1_silent_copy: false,
        soft_pass_avoided: true,
        increment: INCREMENT,
      },
    };
  }

  const geometry = resolveProjectGeometry(projectId, { meshId });
  if (!geometry.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: geometry.error,
        step_path: geometry.step_path || null,
        body1_path: geometry.body1_path || null,
        project_id: geometry.project_id || projectId || readActiveId(),
        path_kind: 'snappyHexMesh',
        mtp1_silent_copy: false,
        soft_pass_avoided: true,
        increment: INCREMENT,
      },
    };
  }

  const generateId = stampId();
  const project_id = geometry.project_id;
  const simIdSnappy = studyIdForMesh(project_id, meshId);
  const meshDoc = project_id && simIdSnappy ? readMeshDoc(project_id, simIdSnappy, meshId) : null;
  const settings_snapshot = settingsForMesh(meshDoc, meshId, settings) || settings || null;
  const fineness =
    settings_snapshot && settings_snapshot.fineness != null ? settings_snapshot.fineness : 5;
  const addLayers =
    !settings_snapshot || settings_snapshot.automatic_boundary_layers === undefined
      ? true
      : !!settings_snapshot.automatic_boundary_layers;
  // Geometry bounds may be mm from W16 fingerprint; generate scales Body1 mm->m.
  const physicsBased =
    settings_snapshot.physics_based_meshing === undefined
      ? true
      : !!settings_snapshot.physics_based_meshing;
  const wslDst = `cfddesk-w25-${generateId}`;
  mkdirSync(REPORT_DIR, { recursive: true });
  const winOut = meshCasePath(project_id, meshId, simIdSnappy);
  if (!winOut) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh folder missing — create Mesh first', mesh_id: meshId, path_kind: 'snappyHexMesh' },
    };
  }
  mkdirSync(winOut, { recursive: true });
  reapStaleMeshGenerators(winOut);
  const winLog = join(REPORT_DIR, `generate-${generateId}.log`);
  const projectDir = join(PROJECTS_ROOT, project_id);

  let fingerprint_before = null;
  try {
    const prev = join(winOut, 'constant', 'polyMesh');
    if (existsSync(join(prev, 'owner')) && existsSync(join(prev, 'points'))) {
      fingerprint_before = fingerprintPolyMesh(prev);
    }
  } catch {
    fingerprint_before = null;
  }

  const argv = [
    PYTHON,
    SNAPPY_GENERATE_SCRIPT,
    '--project-dir',
    projectDir,
    '--case-dir',
    winOut,
    '--wsl-case',
    wslDst,
    '--generate-id',
    generateId,
    '--fineness',
    String(clampFineness(fineness)),
    '--add-layers',
    addLayers ? '1' : '0',
    '--physics-based',
    physicsBased ? '1' : '0',
    '--legacy-markers',
  ];
  if (simIdSnappy) argv.push('--simulation-id', String(simIdSnappy));
  const command = argv.join(' ');
  const started_at = new Date().toISOString();

  let logBuf = '';
  let lastResult = null;
  const jobLog = createJobLogger('mesh', generateId);
  const child = spawn(argv[0], argv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  const job = bindLiveMeshJob({
    child,
    generate_id: generateId,
    path_kind: PATH_SNAPPY,
    project_id,
    started_at,
    mesh_id: meshId || null,
    wsl_dst: wslDst,
    onUpdate,
  });
  jobLog.info('spawn', { pid: child.pid || null, path_kind: PATH_SNAPPY });
  try {
    writeFileSync(winLog, '', 'utf8');
  } catch {}

  const baseRunning = {
    status: 'running',
    mode: 'mesh',
    path_kind: 'snappyHexMesh',
    generate_id: generateId,
    kick_id: generateId,
    pid: child.pid || null,
    exit_code: null,
    command,
    argv,
    started_at,
    finished_at: null,
    log_path: winLog,
    log_jsonl_path: jobLog.path,
    log_excerpt: '',
    wsl_case: wslCasePath(wslDst),
    case_dir: winOut,
    mesh_path: join(winOut, 'constant', 'polyMesh'),
    n_cells: null,
    n_points: null,
    n_faces: null,
    counts_source: null,
    emesh: null,
    feature_marks_total: null,
    fingerprint_before,
    fingerprint_after: null,
    project_id,
    mesh_id: meshId || null,
    settings_snapshot,
    fineness_used: fineness,
    add_layers_used: addLayers,
    snappy_geometry_rev: null,
    lift: {
      from: [
        'cfddesk/mesh/snappy_hexdominant.py',
        'cfddesk/mesh/snappy_policy.py',
        'cfddesk/wsl/templates/snappy_hexdominant.sh',
        'tools/generate_snappy.py',
      ],
      automatic_boundary_layers: addLayers,
    },
    geometry: {
      step_path: geometry.step_path,
      body1_path: geometry.body1_path,
      step_sha256: geometry.step_sha256,
      body1_sha256: geometry.body1_sha256,
      geometry_name: geometry.geometry_name,
      source: 'W16_project_STEP_Body1',
    },
    step_path: geometry.step_path,
    body1_path: geometry.body1_path,
    stage: 'starting',
    stage_detail: null,
    note: `Hex-dominant snappy via generate_snappy.py (fineness ${fineness}, layers ${addLayers ? 'on' : 'off'}).`,
    mtp1_silent_copy: false,
  };
  persistMeshResult(project_id, baseRunning);

  let lastStage = null;
  let lineCarry = '';
  const flushParsedLine = (line) => {
    const parsed = parseCfmeshLine(line);
    if (!parsed) return;
    if (parsed.kind === 'result') lastResult = parsed.data;
    if (parsed.kind === 'progress' && parsed.data && parsed.data.stage) {
      const stage = String(parsed.data.stage);
      const detail = parsed.data.msg ? String(parsed.data.msg) : null;
      if (stage !== lastStage || detail) {
        lastStage = stage;
        if (liveJob && liveJob.child === child) {
          const running = { ...baseRunning, stage, stage_detail: detail };
          try {
            persistMeshResult(project_id, running);
            onUpdate(running);
          } catch (_) {}
        }
      }
    }
  };
  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    lineCarry += s;
    const parts = lineCarry.split(/\r?\n/);
    lineCarry = parts.pop() ?? '';
    for (const line of parts) flushParsedLine(line);
  };
  const flushLineCarry = () => {
    if (!lineCarry) return;
    const rem = lineCarry;
    lineCarry = '';
    flushParsedLine(rem);
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('close', (code) => {
    flushLineCarry();
    if (liveJob && liveJob.child === child) liveJob = null;
    if (job.stop_requested) {
      notifyMeshStopped(job);
      return;
    }
    const exit_code = code == null ? 1 : code;
    const finished_at = new Date().toISOString();
    const inspected = inspectGeneratedCase(winOut);
    const counts = lastResult
      ? {
          n_cells: lastResult.n_cells ?? null,
          n_points: lastResult.n_points ?? null,
          n_faces: lastResult.n_faces ?? null,
          counts_source: lastResult.counts_source || null,
        }
      : inspected
        ? {
            n_cells: inspected.n_cells,
            n_points: inspected.n_points,
            n_faces: inspected.n_faces,
            counts_source: inspected.counts_source,
          }
        : readPolyMeshCounts(join(winOut, 'constant', 'polyMesh'));
    const ok =
      exit_code === 0 &&
      !(lastResult && lastResult.ok === false) &&
      (!!inspected || counts.n_cells != null);
    const status = meshCloseStatus({ stopRequested: job.stop_requested, ok });
    const terminal = {
      ...baseRunning,
      status,
      exit_code,
      finished_at,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.counts_source || 'polyMesh/points+owner',
      feature_marks_total: lastResult && lastResult.feature_marks_total != null ? lastResult.feature_marks_total : null,
      fingerprint_after: null,
      snappy_geometry_rev: lastResult && lastResult.snappy_geometry_rev != null ? lastResult.snappy_geometry_rev : null,
      block_used: lastResult && lastResult.block != null ? lastResult.block : null,
      feature_level_used: lastResult && lastResult.feature_level != null ? lastResult.feature_level : null,
      walls_level_used: lastResult && lastResult.walls_level != null ? lastResult.walls_level : null,
      snap_used: lastResult && lastResult.snap != null ? lastResult.snap : null,
      stage: status,
      error:
        status === 'done'
          ? null
          : status === 'stopped'
            ? 'cancelled'
            : (lastResult && lastResult.error) || `generate_snappy exit ${exit_code}`,
      note:
        status === 'done'
          ? `Hex-dominant snappy done (exit ${exit_code}). cells=${counts.n_cells} points=${counts.n_points}.`
          : status === 'stopped'
            ? 'Mesh generate cancelled.'
            : `Hex-dominant snappy failed (exit ${exit_code}).`,
      log_excerpt: logBuf.slice(-4000),
      mtp1_silent_copy: false,
    };
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
    scheduleComputeQueueKick(250);
    setImmediate(() => {
      if (job.stop_requested) return;
      let fingerprint_after = null;
      try {
        fingerprint_after = fingerprintPolyMesh(join(winOut, 'constant', 'polyMesh'));
      } catch {
        fingerprint_after = null;
      }
      try {
        prewarmMeshSurface(winOut);
      } catch (_) {}
      if (fingerprint_after) {
        try {
          persistMeshResult(project_id, { ...terminal, fingerprint_after });
        } catch (_) {}
      }
    });
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function meshGenerateLivePid() {
  if (isLiveMeshJobHeld()) return liveJob.child.pid || null;
  return null;
}

export function reapOrphanMeshGeneratorsOnBoot() {
  try {
    spawnSync(PYTHON, [pyTool('reap_mesh_jobs.py')], {
      windowsHide: true,
      timeout: 20000,
      stdio: 'ignore',
    });
  } catch {
    /* ignore */
  }
}

export function liveMeshJobSnapshot() {
  if (isLiveMeshJobHeld()) {
    return {
      pid: liveJob.child.pid || null,
      generate_id: liveJob.generate_id || null,
      path_kind: liveJob.path_kind || PATH_CFMESH,
      project_id: liveJob.project_id || null,
      mesh_id: liveJob.mesh_id || null,
      started_at: liveJob.started_at || null,
    };
  }
  return null;
}

export const W21_META = {
  increment: INCREMENT,
  path_kind: 'snappyHexMesh',
  report_dir: REPORT_DIR,
  forbidden_path_kind: 'checkMesh',
  generate_script: 'generate_snappy.py',
  geometry_source: 'W16_project_STEP_Body1',
  mtp1_silent_copy: false,
};

export const W23_META = W21_META;
