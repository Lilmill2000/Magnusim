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
import { pyJsonSync } from './py-json.js';

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

/** @type {null | { child: import('node:child_process').ChildProcess, generate_id: string }} */
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

function readMeshDoc(projectId) {
  const p = meshJsonPath(projectId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeshDoc(projectId, doc) {
  // Phase 1 Step 9: mesh.json (+ project.mesh soft stamp) via project_cli.
  const simId = (doc && doc.simulation_id) || '';
  pyJsonSync(
    'project_cli.py',
    ['set-mesh-settings', '--project-dir', join(PROJECTS_ROOT, projectId), '--sim-id', String(simId || '')],
    doc,
  );
  return meshJsonPath(projectId);
}

function winToWsl(winPath) {
  const posix = String(winPath).replace(/\\/g, '/');
  const m = posix.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : posix;
}

/**
 * Resolve active W16 project geometry: source.step + Body1.stl.
 * HARD FAIL if missing — never silently fall back to MTP1 walls.stl.
 */
export function resolveProjectGeometry(projectId) {
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
  const step_path =
    geom.step_path || join(PROJECTS_ROOT, id, 'geometry', 'source.step');
  const body1_path =
    geom.stl_path || join(PROJECTS_ROOT, id, 'geometry', 'Body1.stl');
  if (!existsSync(step_path)) {
    return {
      ok: false,
      error: 'W16 source.step missing — import geometry first',
      project_id: id,
      step_path,
      body1_path,
    };
  }
  if (!existsSync(body1_path)) {
    return {
      ok: false,
      error: 'W16 Body1.stl missing — import geometry first',
      project_id: id,
      step_path,
      body1_path,
    };
  }
  const stepSt = statSync(step_path);
  const bodySt = statSync(body1_path);
  if (stepSt.size < 32 || bodySt.size < 100) {
    return {
      ok: false,
      error: 'geometry files too small / empty',
      project_id: id,
      step_path,
      body1_path,
      step_bytes: stepSt.size,
      body1_bytes: bodySt.size,
    };
  }
  const bodyBuf = readFileSync(body1_path);
  const body1_sha256 = createHash('sha256').update(bodyBuf).digest('hex');
  const stepBuf = readFileSync(step_path);
  const step_sha256 = createHash('sha256').update(stepBuf).digest('hex');
  return {
    ok: true,
    project_id: id,
    step_path,
    body1_path,
    step_bytes: stepSt.size,
    body1_bytes: bodySt.size,
    step_sha256,
    body1_sha256,
    geometry_name: geom.name || null,
    wsl_step: winToWsl(step_path),
    wsl_body1: winToWsl(body1_path),
    cad_faces_path: join(PROJECTS_ROOT, id, 'geometry', 'cad_faces.vtp'),
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

function meshSurfaceCacheKey(caseDir) {
  const h = createHash('sha256').update(String(caseDir)).digest('hex').slice(0, 16);
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


export function persistMeshResult(projectId, resultFields) {
  if (!projectId) return null;
  const existing = readMeshDoc(projectId) || {};
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
    log_excerpt: resultFields.log_excerpt || null,
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
        : 'Mesh running.';
  const generated = resultFields.status === 'done';
  const meshId = resultFields.mesh_id || null;
  let meshes = Array.isArray(existing.meshes) ? existing.meshes.slice() : null;
  if (meshes && meshes.length) {
    let idx = meshId ? meshes.findIndex((m) => m && m.id === meshId) : -1;
    if (idx < 0 && resultFields.generate_id) {
      idx = meshes.findIndex(
        (m) =>
          m &&
          m.live_mesh_result &&
          String(m.live_mesh_result.generate_id || '') === String(resultFields.generate_id)
      );
    }
    if (idx >= 0) {
      const prev = meshes[idx] || {};
      meshes[idx] = {
        ...prev,
        id: meshes[idx].id,
        name: meshes[idx].name || existing.name,
        settings: meshes[idx].settings || existing.settings || null,
        generated,
        live_mesh_result: live,
        geometry_id: prev.geometry_id || null,
        simulation_id: prev.simulation_id || null,
        updated_at: now,
      };
    } else {
      return existing;
    }
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
    writeMeshDoc(projectId, doc);
    return doc;
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
  writeMeshDoc(projectId, doc);
  return doc;
}

function wantsStandard(settings) {
  const algo = String((settings && settings.algorithm) || 'Standard')
    .trim()
    .toLowerCase();
  return algo === 'standard' || algo === '';
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
  const adv = (settings && settings.advanced) || {};
  const eng = String(adv.mesh_engine || settings?.mesh_engine || 'standard')
    .trim()
    .toLowerCase();
  return eng === 'cfmesh' && wantsHexCore(settings) ? 'cfmesh' : 'standard';
}

function wantsHexDominant(settings) {
  const algo = String((settings && settings.algorithm) || '')
    .trim()
    .toLowerCase();
  return algo.startsWith('hex-dominant') || algo === 'hexdominant';
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

function resolveProjectStep(projectId) {
  const full = resolveProjectGeometry(projectId);
  if (full.ok) return full;
  const id = projectId || readActiveId();
  if (!id) return full;
  const step_path = join(PROJECTS_ROOT, id, 'geometry', 'source.step');
  if (!existsSync(step_path)) return full;
  const st = statSync(step_path);
  if (st.size < 32) return full;
  const stepBuf = readFileSync(step_path);
  return {
    ok: true,
    project_id: id,
    step_path,
    body1_path: full.body1_path || join(PROJECTS_ROOT, id, 'geometry', 'Body1.stl'),
    step_bytes: st.size,
    body1_bytes: 0,
    step_sha256: createHash('sha256').update(stepBuf).digest('hex'),
    body1_sha256: null,
    geometry_name: null,
    wsl_step: winToWsl(step_path),
    wsl_body1: null,
    bounds: null,
  };
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
  const geometry = resolveProjectStep(projectId);
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
  const meshDoc = project_id ? readMeshDoc(project_id) : null;
  const settings_snapshot = settings || (meshDoc && meshDoc.settings) || null;
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
  const winOut = join(PROJECTS_ROOT, project_id, 'mesh', `run-${generateId}`);
  mkdirSync(winOut, { recursive: true });
  const winLog = join(winOut, 'generate.log');
  const projectDir = join(PROJECTS_ROOT, project_id);

  let fingerprint_before = null;
  try {
    const prev =
      meshDoc &&
      meshDoc.live_mesh_result &&
      meshDoc.live_mesh_result.mesh_path &&
      existsSync(meshDoc.live_mesh_result.mesh_path)
        ? meshDoc.live_mesh_result.mesh_path
        : null;
    if (prev) fingerprint_before = fingerprintPolyMesh(prev);
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
  liveJob = { child, generate_id: generateId, path_kind: pathKind, project_id, started_at, mesh_id: meshId || null };
  jobLog.info('spawn', { pid: child.pid || null, path_kind: pathKind, engine });

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
    mesh_id: liveJob.mesh_id,
  };
  persistMeshResult(project_id, baseRunning);

  let lastStage = null;
  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    for (const line of s.split(/\r?\n/)) {
      const parsed = parseCfmeshLine(line);
      if (!parsed) continue;
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
    }
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('error', (err) => {
    logBuf += `\nSPAWN_ERROR: ${err}\n`;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
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
  });

  child.on('exit', (code, signal) => {
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const finished_at = new Date().toISOString();
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    const polyDir = join(winOut, 'constant', 'polyMesh');
    let counts = { n_cells: null, n_points: null, n_faces: null, source: null };
    let fingerprint_after = null;
    try {
      const countsJson = join(winOut, 'w21-counts.json');
      if (existsSync(countsJson)) {
        const j = JSON.parse(readFileSync(countsJson, 'utf8'));
        counts = {
          n_cells: j.n_cells ?? null,
          n_points: j.n_points ?? null,
          n_faces: j.n_faces ?? null,
          source: j.source || 'w21-counts.json',
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
      try {
        if (existsSync(polyDir)) fingerprint_after = fingerprintPolyMesh(polyDir);
      } catch (fpErr) {
        fingerprint_after = { error: String(fpErr), ...counts };
      }
    } catch (e) {
      logBuf += `\nCOUNT_PARSE_ERROR: ${e}\n`;
    }
    try {
      if (existsSync(polyDir)) prewarmMeshSurface(winOut);
    } catch (_) {}

    const scriptOk = lastResult && lastResult.ok === true;
    const ok =
      exit_code === 0 &&
      scriptOk &&
      counts.n_cells != null &&
      counts.n_points != null &&
      existsSync(join(polyDir, 'points'));

    liveJob = null;
    const terminal = {
      ...baseRunning,
      status: ok ? 'done' : 'failed',
      exit_code: ok ? 0 : exit_code === 0 && !ok ? 45 : exit_code,
      finished_at,
      log_excerpt: logBuf.slice(-4000),
      case_dir: winOut,
      mesh_path: polyDir,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.source,
      fingerprint_after,
      script_result: lastResult,
      stage: ok ? 'done' : 'failed',
      stage_detail: null,
      error: ok ? null : (lastResult && lastResult.error) || `exit ${exit_code}`,
      hex_core_applied: lastResult && lastResult.hex_core != null ? !!lastResult.hex_core : hexCore,
      layers_applied: lastResult && lastResult.layers_applied != null ? !!lastResult.layers_applied : null,
      surface_size_m: (lastResult && lastResult.surface_size_m) || null,
      signal: signal || null,
      note: ok
        ? `${engineLabel} mesh done: ${counts.n_cells} cells, ${counts.n_points} points.`
        : `${engineLabel} mesh failed (exit ${exit_code}${lastResult && lastResult.error ? ': ' + lastResult.error : ''}).`,
    };
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function startMeshGenerate({ settings, projectId, onUpdate, meshId }) {
  if (liveJob && liveJob.child && !liveJob.child.killed && liveJob.child.exitCode === null) {
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

  const projectIdEarly = projectId || readActiveId();
  const meshDocEarly = projectIdEarly ? readMeshDoc(projectIdEarly) : null;
  const settingsEarly = settings || (meshDocEarly && meshDocEarly.settings) || null;
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

  const geometry = resolveProjectGeometry(projectId);
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
  const meshDoc = project_id ? readMeshDoc(project_id) : null;
  const settings_snapshot = settings || (meshDoc && meshDoc.settings) || null;
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
  const winOut = project_id
    ? join(PROJECTS_ROOT, project_id, 'mesh', `run-w25-${generateId}`)
    : join(REPORT_DIR, 'cases', `run-w25-${generateId}`);
  mkdirSync(winOut, { recursive: true });
  const winLog = join(REPORT_DIR, `generate-${generateId}.log`);
  const projectDir = join(PROJECTS_ROOT, project_id);

  let fingerprint_before = null;
  try {
    const prev =
      meshDoc &&
      meshDoc.live_mesh_result &&
      meshDoc.live_mesh_result.mesh_path &&
      existsSync(meshDoc.live_mesh_result.mesh_path)
        ? meshDoc.live_mesh_result.mesh_path
        : null;
    if (prev) fingerprint_before = fingerprintPolyMesh(prev);
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

  liveJob = { child, generate_id: generateId, path_kind: PATH_SNAPPY, project_id, started_at };
  jobLog.info('spawn', { pid: child.pid || null, path_kind: PATH_SNAPPY });

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
  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    for (const line of s.split(/\r?\n/)) {
      const parsed = parseCfmeshLine(line);
      if (!parsed) continue;
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
    }
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('close', (code) => {
    const exit_code = code == null ? 1 : code;
    const finished_at = new Date().toISOString();
    if (liveJob && liveJob.child === child) liveJob = null;
    const counts = lastResult
      ? {
          n_cells: lastResult.n_cells ?? null,
          n_points: lastResult.n_points ?? null,
          n_faces: lastResult.n_faces ?? null,
          counts_source: lastResult.counts_source || null,
        }
      : readPolyMeshCounts(join(winOut, 'constant', 'polyMesh'));
    let fingerprint_after = null;
    try {
      fingerprint_after = fingerprintPolyMesh(join(winOut, 'constant', 'polyMesh'));
    } catch {
      fingerprint_after = null;
    }
    const ok = exit_code === 0 && !(lastResult && lastResult.ok === false);
    const terminal = {
      ...baseRunning,
      status: ok ? 'done' : 'failed',
      exit_code,
      finished_at,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.counts_source || 'polyMesh/points+owner',
      feature_marks_total: lastResult && lastResult.feature_marks_total != null ? lastResult.feature_marks_total : null,
      fingerprint_after,
      snappy_geometry_rev: lastResult && lastResult.snappy_geometry_rev != null ? lastResult.snappy_geometry_rev : null,
      block_used: lastResult && lastResult.block != null ? lastResult.block : null,
      feature_level_used: lastResult && lastResult.feature_level != null ? lastResult.feature_level : null,
      walls_level_used: lastResult && lastResult.walls_level != null ? lastResult.walls_level : null,
      snap_used: lastResult && lastResult.snap != null ? lastResult.snap : null,
      stage: ok ? 'done' : 'failed',
      error: ok ? null : (lastResult && lastResult.error) || `generate_snappy exit ${exit_code}`,
      note: ok
        ? `Hex-dominant snappy done (exit ${exit_code}). cells=${counts.n_cells} points=${counts.n_points}.`
        : `Hex-dominant snappy failed (exit ${exit_code}).`,
      log_excerpt: logBuf.slice(-4000),
      mtp1_silent_copy: false,
    };
    try {
      prewarmMeshSurface(winOut);
    } catch (_) {}
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function meshGenerateLivePid() {
  if (liveJob && liveJob.child && liveJob.child.exitCode === null) {
    return liveJob.child.pid || null;
  }
  return null;
}

export function liveMeshJobSnapshot() {
  if (liveJob && liveJob.child && liveJob.child.exitCode === null) {
    return {
      pid: liveJob.child.pid || null,
      generate_id: liveJob.generate_id || null,
      path_kind: liveJob.path_kind || PATH_CFMESH,
      project_id: liveJob.project_id || null,
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
