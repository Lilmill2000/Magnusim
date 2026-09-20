/**
 * W17 — Create Simulation -> Incompressible studies.
 * Catalog: projects/<id>/simulations.json (active mirrored to simulation.json).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeGeometryId, geometriesOf, matchesGeometry, matchesStudy, primaryGeometryId } from './w16-geometry-scope.js';
import {
  deleteSimulationFromCatalog,
  ensureCatalog,
  getActiveSimulation,
  projectDir,
  readCatalog,
  setActiveSimulation,
  simulationJsonPath,
  studyBaseName,
  upsertSimulationInCatalog,
  assignStudyNames,
  reorderSimulationsInCatalog,
} from './w17-sim-catalog.js';
import { envGet } from './env-compat.js';
import {
  collectChildRecs,
  copyStudyTree,
  createRunFolder,
  createStudyFolder,
  findStudy,
  meshRefsDir,
  readJsonFile,
  replaceChildItems,
  removeStudyFolder,
  runRcsDir,
  studyBcsDir,
  studyBcsPath,
  studyControlPath,
  studyMaterialsDir,
  studyMaterialsPath,
  studyRcsDir,
  studyResultControlsPath,
  walkRuns,
  walkStudies,
  writeIdFile,
  writeJsonAtomic,
} from './project-layout.js';
import {
  analysisByKey,
  analysisKeys,
  algorithmFromSolver,
  buildW17DefaultsFromRegistry,
  DEFAULT_ANALYSIS_KEY,
} from './registry-defaults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

/** Dump-backed defaults (scripts/generated/registry.json). */
export const W17_DEFAULTS = buildW17DefaultsFromRegistry();

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return j.project_id || null;
  } catch {
    return null;
  }
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeProject(proj) {
  writeJsonAtomic(projectJsonPath(proj.id), proj);
  return proj;
}

function newSimId() {
  return `sim-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function _algorithmForAnalysisKey(key, fallback) {
  const row = analysisByKey(key);
  if (row && row.default_solver) return algorithmFromSolver(row.default_solver);
  return fallback;
}

export const TIME_DEPENDENCIES = Object.freeze({
  'Steady-state': _algorithmForAnalysisKey(DEFAULT_ANALYSIS_KEY, 'SIMPLE'),
  Transient: _algorithmForAnalysisKey('incompressible_transient', 'PIMPLE'),
});

function acceptsW17Analysis(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (s === W17_DEFAULTS.analysis || s === W17_DEFAULTS.analysis_type) return true;
  if (s === 'incompressible' || s === DEFAULT_ANALYSIS_KEY) return true;
  if (s === 'incompressible_transient') return true;
  const keys = analysisKeys();
  if (keys.includes(s)) return s.startsWith('incompressible_');
  return false;
}

function normalizeTimeDependency(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return fallback || W17_DEFAULTS.time_dependency;
  if (/transient/i.test(s)) return 'Transient';
  if (/steady/i.test(s)) return 'Steady-state';
  return fallback || W17_DEFAULTS.time_dependency;
}

export function timeDependenciesMatch(a, b) {
  return normalizeTimeDependency(a, 'Steady-state') === normalizeTimeDependency(b, 'Steady-state');
}

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function catalogPayload(projectId, proj, cat) {
  const active = (cat.simulations || []).find((s) => s.id === cat.active_id) || null;
  return {
    ok: true,
    simulation: active,
    simulations: cat.simulations || [],
    active_id: cat.active_id || null,
    project_id: projectId,
    project: proj,
    simulation_json: simulationJsonPath(projectId),
    defaults: active
      ? {
          turbulence_model: active.turbulence_model,
          time_dependency: active.time_dependency,
          algorithm: active.algorithm,
        }
      : null,
    increment: 'W17',
  };
}

function touchProjectSimRef(proj, sim) {
  if (!sim) return;
  proj.simulation = {
    id: sim.id,
    name: sim.name,
    analysis: sim.analysis,
    analysis_type: sim.analysis_type,
    turbulence_model: sim.turbulence_model,
    time_dependency: sim.time_dependency,
    algorithm: sim.algorithm,
    geometry_id: sim.geometry_id || null,
    simulation_json: simulationJsonPath(proj.id),
    created_at: sim.created_at,
  };
  proj.active_simulation_id = sim.id;
  proj.updated_at = sim.updated_at || new Date().toISOString();
}

function buildSimulation(body, project) {
  const analysis = String(body.analysis || body.analysis_type || body.type || W17_DEFAULTS.analysis).trim();
  if (!acceptsW17Analysis(analysis)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'W17 supports Incompressible only in this slice', got: analysis, soft_pass: false },
    };
  }
  const now = new Date().toISOString();
  const id = body.id || newSimId();
  const geomId = activeGeometryId(project, body.geometry_id);
  const timeDependency = normalizeTimeDependency(body.time_dependency, W17_DEFAULTS.time_dependency);
  const algorithm = TIME_DEPENDENCIES[timeDependency] || W17_DEFAULTS.algorithm;
  const geom = (project.geometries || []).find((g) => g && g.id === geomId) || project.geometry || null;
  const sim = {
    id,
    project_id: project.id,
    name: studyBaseName({ time_dependency: timeDependency }),
    analysis: W17_DEFAULTS.analysis,
    analysis_type: W17_DEFAULTS.analysis_type,
    analysis_title: W17_DEFAULTS.analysis_title,
    turbulence_model_key: W17_DEFAULTS.turbulence_model_key,
    category: W17_DEFAULTS.category,
    flow_group: W17_DEFAULTS.flow_group,
    turbulence_model: W17_DEFAULTS.turbulence_model,
    time_dependency: timeDependency,
    algorithm,
    passive_species: W17_DEFAULTS.passive_species,
    defaults: {
      turbulence_model: W17_DEFAULTS.turbulence_model,
      time_dependency: timeDependency,
      algorithm,
    },
    geometry_id: geomId || null,
    geometry_name: (geom && (geom.name || geom.original_filename)) || body.geometry_name || null,
    geometry_body: (geom && geom.volume) || (project.geometry && project.geometry.volume) || 'Body1',
    created_at: now,
    updated_at: now,
    persistence: 'filesystem',
    increment: 'W17',
  };
  return { ok: true, sim };
}

function seedStudyDefaults(projectId, sim) {
  const study = findStudy(projectDir(projectId), sim.id);
  if (!study) return;
  const now = new Date().toISOString();
  writeJsonAtomic(studyMaterialsPath(study.dir), {
    simulation_id: sim.id,
    materials: [],
    air: null,
    updated_at: now,
  });
  writeJsonAtomic(studyBcsPath(study.dir), {
    simulation_id: sim.id,
    boundary_conditions: [],
    defaults_by_simulation: { [sim.id]: { wall_type: 'No-slip' } },
    updated_at: now,
  });
  writeJsonAtomic(studyResultControlsPath(study.dir), {
    simulation_id: sim.id,
    result_controls: [],
    area_average_1: null,
    updated_at: now,
  });
  writeJsonAtomic(studyControlPath(study.dir), {
    simulation_id: sim.id,
    endTime: 500,
    writeInterval: 50,
    updated_at: now,
  });
}

function listChildDirs(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function cloneJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function lookupDestMeshName(destDir, meshId) {
  const want = String(meshId || '').trim();
  if (!want) return null;
  const meshRoot = join(destDir, 'meshes');
  for (const name of listChildDirs(meshRoot)) {
    const dir = join(meshRoot, name);
    const mid = readJsonFile(join(dir, 'id.json')) || {};
    const mesh = readJsonFile(join(dir, 'mesh.json')) || {};
    const id = mid.id || mesh.id;
    if (String(id) === want) return mesh.name || mid.name || name;
  }
  return null;
}

function mappedMeshId(meshIdMap, oldId) {
  if (oldId == null || oldId === '') return null;
  const key = String(oldId);
  return meshIdMap && meshIdMap.has(key) ? meshIdMap.get(key) : null;
}

function clearRunFolders(runRoot) {
  if (!existsSync(runRoot)) {
    mkdirSync(runRoot, { recursive: true });
    return;
  }
  for (const name of listChildDirs(runRoot)) {
    try {
      rmSync(join(runRoot, name), { recursive: true, force: true });
    } catch (_) {}
  }
}

function rematerializeRunResultControls(destDir, toId, stamp, dropFaces) {
  const runRoot = join(destDir, 'simulation_runs');
  let n = 0;
  for (const name of listChildDirs(runRoot)) {
    const dir = join(runRoot, name);
    const rid = readJsonFile(join(dir, 'id.json')) || {};
    const run = readJsonFile(join(dir, 'run.json')) || {};
    const runId = rid.id || run.id || run.run_id;
    const mapped = collectChildRecs(runRcsDir(dir), 'result_control.json', run.result_controls).map((r) => {
      n += 1;
      return {
        ...dropFaces(r),
        id: r && r.id ? `rc-run-copy-${stamp}-${n}` : r && r.id,
        run_id: runId,
        simulation_id: toId,
      };
    });
    replaceChildItems(runRcsDir(dir), 'rc', mapped);
    if (run.id || run.run_id) {
      delete run.result_controls;
      writeJsonAtomic(join(dir, 'run.json'), run);
    }
  }
}

function remapClonedRuns(destDir, toId, stamp, meshIdMap, destTimeDep) {
  const runRoot = join(destDir, 'simulation_runs');
  for (const name of listChildDirs(runRoot)) {
    const dir = join(runRoot, name);
    const rid = readJsonFile(join(dir, 'id.json')) || {};
    const run = readJsonFile(join(dir, 'run.json')) || {};
    const newId = `run-copy-${stamp}-${name}`;
    const newMesh = mappedMeshId(meshIdMap, run.mesh_id || rid.mesh_id);
    const meshName = newMesh ? lookupDestMeshName(destDir, newMesh) : null;
    writeIdFile(dir, {
      ...rid,
      id: newId,
      simulation_id: toId,
      mesh_id: newMesh,
      kind: 'run',
    });
    writeJsonAtomic(join(dir, 'run.json'), {
      ...run,
      id: newId,
      run_id: newId,
      simulation_id: toId,
      mesh_id: newMesh,
      mesh_name: meshName || run.mesh_name || null,
      time_dependency: destTimeDep || run.time_dependency || null,
      case_dir: join(dir, 'case'),
    });
  }
}

function seedDraftRunsFromSource(projectDirPath, fromId, toId, destTimeDep, meshIdMap) {
  const destStudy = findStudy(projectDirPath, toId);
  if (!destStudy) return;
  const srcRuns = walkRuns(projectDirPath, fromId);
  const stamp = Date.now().toString(36);
  let n = 0;
  for (const src of srcRuns) {
    if (src.time_dependency && !timeDependenciesMatch(src.time_dependency, destTimeDep)) continue;
    n += 1;
    const newMesh = mappedMeshId(meshIdMap, src.mesh_id);
    const newId = `run-copy-${stamp}-${n}`;
    const name = src.name || `Run ${n}`;
    const rec = {
      id: newId,
      run_id: newId,
      name,
      simulation_id: toId,
      mesh_id: newMesh,
      mesh_name: newMesh ? lookupDestMeshName(destStudy.dir, newMesh) : src.mesh_name || null,
      status: 'draft',
      created_at: new Date().toISOString(),
      endTime: src.endTime,
      writeInterval: src.writeInterval,
      time_dependency: destTimeDep,
      result_controls: cloneJson(src.result_controls, []),
      views: cloneJson(src.views, []),
      current_view: null,
      case_dir: null,
    };
    if (timeDependenciesMatch(destTimeDep, 'Transient') && src.transient) {
      rec.transient = cloneJson(src.transient, null);
    }
    const folder = createRunFolder(projectDirPath, toId, { id: newId, name, mesh_id: newMesh });
    writeJsonAtomic(join(folder.dir, 'run.json'), rec);
  }
}

export function rewriteCopiedStudy(destDir, fromId, toId, toGeom, opts) {
  const options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : { cloneCases: !!opts };
  const cloneCases = !!options.cloneCases;
  const copyRuns = options.copyRuns != null ? !!options.copyRuns : typeof opts === 'boolean' ? !!opts : false;
  const destTimeDep = options.destTimeDependency
    ? normalizeTimeDependency(options.destTimeDependency, null)
    : null;
  const destAlgorithm = options.destAlgorithm || (destTimeDep && TIME_DEPENDENCIES[destTimeDep]) || null;
  const projectDirPath = options.projectDirPath || null;
  const srcGeom = String(options.sourceGeometryId || '').trim();
  const destGeom = String(toGeom || '').trim();
  const sameCad = !srcGeom || !destGeom || srcGeom === destGeom;
  const dropFaces = (rec) => (sameCad || !rec ? rec : { ...rec, faces: [], face: null });
  const stamp = Date.now().toString(36);
  const ident = readJsonFile(join(destDir, 'id.json')) || {};
  writeIdFile(destDir, {
    ...ident,
    id: toId,
    geometry_id: toGeom,
    kind: 'simulation',
    ...(destTimeDep ? { time_dependency: destTimeDep } : {}),
    ...(destAlgorithm ? { algorithm: destAlgorithm } : {}),
  });
  const rekey = (p, extra) => {
    const doc = readJsonFile(p);
    if (!doc) return;
    if (doc.simulation_id) doc.simulation_id = toId;
    if (doc.geometry_id && toGeom) doc.geometry_id = toGeom;
    if (extra) extra(doc);
    writeJsonAtomic(p, doc);
  };
  const matLegacy = readJsonFile(studyMaterialsPath(destDir));
  const mappedMats = collectChildRecs(
    studyMaterialsDir(destDir),
    'material.json',
    matLegacy && matLegacy.materials
  ).map((m, i) => ({
    ...m,
    id: `mat-copy-${stamp}-${i}`,
    simulation_id: toId,
    geometry_id: toGeom || m.geometry_id,
  }));
  replaceChildItems(studyMaterialsDir(destDir), 'material', mappedMats);
  rekey(studyMaterialsPath(destDir), (doc) => {
    doc.materials = mappedMats;
    if (doc.air) doc.air = { ...doc.air, id: `mat-copy-${stamp}-air`, simulation_id: toId };
    if (doc.defaults_by_simulation && doc.defaults_by_simulation[fromId]) {
      doc.defaults_by_simulation = { [toId]: doc.defaults_by_simulation[fromId] };
    }
  });
  const bcLegacy = readJsonFile(studyBcsPath(destDir));
  const mappedBcs = collectChildRecs(
    studyBcsDir(destDir),
    'bc.json',
    bcLegacy && bcLegacy.boundary_conditions
  ).map((b, i) => ({
    ...dropFaces(b),
    id: `bc-copy-${stamp}-${i}`,
    simulation_id: toId,
    geometry_id: toGeom || b.geometry_id,
  }));
  replaceChildItems(studyBcsDir(destDir), 'bc', mappedBcs);
  rekey(studyBcsPath(destDir), (doc) => {
    doc.boundary_conditions = mappedBcs;
    if (doc.defaults_by_simulation && doc.defaults_by_simulation[fromId]) {
      doc.defaults_by_simulation = { [toId]: JSON.parse(JSON.stringify(doc.defaults_by_simulation[fromId])) };
    }
  });
  const rcLegacy = readJsonFile(studyResultControlsPath(destDir));
  const mappedRcs = collectChildRecs(
    studyRcsDir(destDir),
    'result_control.json',
    rcLegacy && rcLegacy.result_controls
  ).map((r, i) => ({
    ...dropFaces(r),
    id: `rc-copy-${stamp}-${i}`,
    simulation_id: toId,
  }));
  replaceChildItems(studyRcsDir(destDir), 'rc', mappedRcs);
  rekey(studyResultControlsPath(destDir), (doc) => {
    doc.result_controls = mappedRcs;
    if (doc.area_average_1) {
      doc.area_average_1 = { ...doc.area_average_1, id: `aa-copy-${stamp}`, simulation_id: toId };
    }
  });
  rekey(studyControlPath(destDir), null);
  const meshIdMap = new Map();
  const meshRoot = join(destDir, 'meshes');
  if (existsSync(meshRoot)) {
    for (const name of listChildDirs(meshRoot)) {
      const dir = join(meshRoot, name);
      const mid = readJsonFile(join(dir, 'id.json')) || {};
      const mesh = readJsonFile(join(dir, 'mesh.json'));
      const oldId = (mid && mid.id) || (mesh && mesh.id) || null;
      const newId = `mesh-copy-${stamp}-${name}`;
      if (oldId) meshIdMap.set(String(oldId), newId);
      writeIdFile(dir, { ...mid, id: newId, simulation_id: toId, kind: 'mesh' });
      if (mesh) {
        mesh.id = newId;
        mesh.simulation_id = toId;
        mesh.geometry_id = toGeom || mesh.geometry_id;
        if (!cloneCases) {
          mesh.generated = false;
          mesh.live_mesh_result = null;
          mesh.case_dir = null;
        } else if (mesh.live_mesh_result) {
          mesh.live_mesh_result = {
            ...mesh.live_mesh_result,
            case_dir: join(dir, 'case'),
            mesh_path: join(dir, 'case', 'constant', 'polyMesh'),
          };
          mesh.case_dir = join(dir, 'case');
          mesh.cloned_from_mesh = oldId || mid.id;
        }
        writeJsonAtomic(join(dir, 'mesh.json'), mesh);
      }
      const refs = readJsonFile(join(dir, 'refinements.json'));
      const mappedRefs = collectChildRecs(
        meshRefsDir(dir),
        'refinement.json',
        refs && refs.refinements
      ).map((r, i) => ({
        ...dropFaces(r),
        id: r && r.id ? `ref-copy-${stamp}-${name}-${i}` : r && r.id,
        mesh_id: newId,
        simulation_id: toId,
        geometry_id: toGeom || (r && r.geometry_id),
      }));
      replaceChildItems(meshRefsDir(dir), 'refinement', mappedRefs);
      if (refs && Array.isArray(refs.refinements)) {
        refs.refinements = mappedRefs;
        refs.mesh_id = newId;
        refs.simulation_id = toId;
        writeJsonAtomic(join(dir, 'refinements.json'), refs);
      }
    }
  }
  rekey(join(destDir, 'mesh_refinements.json'), (doc) => {
    doc.refinements = (doc.refinements || []).map((r, i) => ({
      ...dropFaces(r),
      id: r && r.id ? `ref-copy-${stamp}-${i}` : r && r.id,
      simulation_id: toId,
      geometry_id: toGeom || (r && r.geometry_id),
      mesh_id: mappedMeshId(meshIdMap, r && r.mesh_id) || r.mesh_id,
    }));
  });
  const runRoot = join(destDir, 'simulation_runs');
  if (!copyRuns) {
    clearRunFolders(runRoot);
    return { meshIdMap };
  }
  if (cloneCases) {
    remapClonedRuns(destDir, toId, stamp, meshIdMap, destTimeDep);
    rematerializeRunResultControls(destDir, toId, stamp, dropFaces);
    return { meshIdMap };
  }
  clearRunFolders(runRoot);
  if (projectDirPath) {
    seedDraftRunsFromSource(projectDirPath, fromId, toId, destTimeDep, meshIdMap);
    rematerializeRunResultControls(destDir, toId, stamp, dropFaces);
  }
  return { meshIdMap };
}

function createSimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first', soft_pass: false } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const built = buildSimulation(body || {}, proj);
  if (!built.ok) return built;
  const root = projectDir(projectId);
  const named = assignStudyNames([...(ensureCatalog(projectId, proj).simulations || []), built.sim]);
  const sim = named.find((s) => s.id === built.sim.id) || built.sim;
  try {
    createStudyFolder(root, sim.geometry_id, sim);
  } catch (e) {
    return { ok: false, status: 400, body: { error: String((e && e.message) || e) } };
  }
  try {
    if (body && body.copy_from) {
      copySimulationSettings(
        projectId,
        proj,
        body.copy_from,
        sim.id,
        body.include,
        body.copy_mode || body.mode,
        sim.time_dependency
      );
    } else {
      seedStudyDefaults(projectId, sim);
    }
  } catch (e) {
    console.error('[CFD] seed study defaults', e);
  }
  let cat;
  try {
    cat = upsertSimulationInCatalog(projectId, proj, sim, true);
  } catch (e) {
    console.error('[CFD] catalog upsert', e);
    cat = readCatalog(projectId);
  }
  if (!(cat.simulations || []).some((s) => s.id === sim.id)) {
    cat = {
      ...cat,
      simulations: [...(cat.simulations || []), sim],
      active_id: sim.id,
    };
  }
  const saved = (cat.simulations || []).find((s) => s.id === sim.id) || sim;
  touchProjectSimRef(proj, saved);
  try {
    writeProject(proj);
  } catch (e) {
    console.error('[CFD] write project after create', e);
  }
  return {
    ok: true,
    status: 201,
    body: { ...catalogPayload(projectId, proj, cat), simulation: saved, soft_pass_avoided: true },
  };
}

function updateSimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) return { ok: false, status: 400, body: { error: 'no active project' } };
  const proj = readProject(projectId);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  const sim = getActiveSimulation(projectId, proj, body && (body.simulation_id || body.id));
  if (!sim) return { ok: false, status: 404, body: { error: 'no simulation yet; create one first', project_id: projectId } };
  const now = new Date().toISOString();
  if (body.time_dependency != null) {
    sim.time_dependency = normalizeTimeDependency(body.time_dependency, sim.time_dependency);
    sim.algorithm = TIME_DEPENDENCIES[sim.time_dependency] || sim.algorithm;
  }
  if (body.name != null) {
    const next = String(body.name).trim().slice(0, 64);
    if (next) sim.name = next;
  }
  if (body.geometry_id != null) sim.geometry_id = String(body.geometry_id);
  sim.updated_at = now;
  const cat = upsertSimulationInCatalog(projectId, proj, sim, true);
  const next = (cat.simulations || []).find((s) => s.id === sim.id) || sim;
  touchProjectSimRef(proj, next);
  writeProject(proj);
  return { ok: true, status: 200, body: { ...catalogPayload(projectId, proj, cat), increment: 'W30' } };
}

function reorderSimulations(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) return { ok: false, status: 400, body: { error: 'no active project' } };
  const proj = readProject(projectId);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  const ids = Array.isArray(body && body.ids) ? body.ids : [];
  if (!ids.length) return { ok: false, status: 400, body: { error: 'ids required' } };
  const cat = reorderSimulationsInCatalog(projectId, proj, ids, body && body.geometry_id);
  const sim = (cat.simulations || []).find((s) => s.id === cat.active_id) || (cat.simulations || [])[0] || null;
  if (sim) {
    touchProjectSimRef(proj, sim);
    writeProject(proj);
  }
  return { ok: true, status: 200, body: catalogPayload(projectId, proj, cat) };
}

function activateSimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) return { ok: false, status: 400, body: { error: 'no active project' } };
  const proj = readProject(projectId);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found' } };
  const simId = body && (body.simulation_id || body.id || body.activate);
  const cat = setActiveSimulation(projectId, proj, simId);
  const sim = (cat.simulations || []).find((s) => s.id === cat.active_id) || null;
  if (sim) {
    touchProjectSimRef(proj, sim);
    if (sim.geometry_id) proj.active_geometry_id = sim.geometry_id;
    writeProject(proj);
  }
  return { ok: true, status: 200, body: catalogPayload(projectId, proj, cat) };
}

function cloneRec(rec, simId, newId) {
  return {
    ...JSON.parse(JSON.stringify(rec)),
    id: newId,
    simulation_id: simId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function resolveCopyMode(mode) {
  const s = String(mode || '').trim().toLowerCase();
  if (s === 'clone' || s === 'duplicate' || s === 'full') return 'clone';
  return 'settings';
}

function copySimulationSettings(projectId, proj, fromId, toId, include, copyMode, destTimeDep) {
  const mode = resolveCopyMode(copyMode);
  const from = String(fromId);
  const to = String(toId);
  if (!from || !to || from === to) return;
  const root = projectDir(projectId);
  const fromStudy = findStudy(root, from);
  const toStudy = findStudy(root, to);
  if (!fromStudy || !toStudy) return;
  const destTd = normalizeTimeDependency(
    destTimeDep || toStudy.time_dependency,
    toStudy.time_dependency || 'Steady-state'
  );
  const srcTd = normalizeTimeDependency(fromStudy.time_dependency, 'Steady-state');
  const copyRuns = timeDependenciesMatch(srcTd, destTd);
  const cloneCases = mode === 'clone';
  const destParent = join(toStudy.geometry_dir, 'simulations');
  const destName = toStudy.folder || toStudy.name;
  try {
    rmSync(toStudy.dir, { recursive: true, force: true });
  } catch (_) {}
  const copied = copyStudyTree(fromStudy.dir, destParent, destName, { cloneCases });
  rewriteCopiedStudy(copied, from, to, toStudy.geometry_id || fromStudy.geometry_id, {
    cloneCases,
    copyRuns,
    destTimeDependency: destTd,
    destAlgorithm: TIME_DEPENDENCIES[destTd] || toStudy.algorithm,
    projectDirPath: root,
    sourceGeometryId: fromStudy.geometry_id,
  });
}

export function purgeStudyRecords(projectId, simId, _geomId) {
  const want = String(simId || '').trim();
  if (!want) return;
  removeStudyFolder(projectDir(projectId), want);
}

export function purgeOrphanSetupRecords(projectId, proj, liveSimIds) {
  if (!projectId) return;
  const liveSims = new Set((liveSimIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const root = projectDir(projectId);
  for (const s of walkStudies(root)) {
    if (s && s.id && !liveSims.has(String(s.id))) {
      try {
        rmSync(s.dir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

function deleteSimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) return { ok: false, status: 400, body: { error: 'no active project' } };
  const proj = readProject(projectId);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  const simId = String((body && (body.simulation_id || body.id || body.delete)) || '').trim();
  if (!simId) return { ok: false, status: 400, body: { error: 'simulation_id required' } };
  const cat = ensureCatalog(projectId, proj);
  const doomed = (cat.simulations || []).find((s) => s && String(s.id) === simId);
  if (!doomed) {
    return { ok: false, status: 404, body: { error: 'simulation not found', simulation_id: simId } };
  }
  const next = deleteSimulationFromCatalog(projectId, proj, simId);
  const active = (next.simulations || []).find((s) => s.id === next.active_id) || next.simulations[0] || null;
  if (active) touchProjectSimRef(proj, active);
  else {
    proj.simulation = null;
    proj.active_simulation_id = null;
  }
  proj.updated_at = new Date().toISOString();
  writeProject(proj);
  purgeStudyRecords(projectId, simId, doomed.geometry_id);
  purgeOrphanSetupRecords(
    projectId,
    proj,
    (next.simulations || []).map((s) => s && s.id).filter(Boolean)
  );
  return {
    ok: true,
    status: 200,
    body: {
      ...catalogPayload(projectId, proj, next),
      deleted: simId,
      simulation: active,
    },
  };
}

function copySimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) return { ok: false, status: 400, body: { error: 'no active project' } };
  const proj = readProject(projectId);
  if (!proj) return { ok: false, status: 404, body: { error: 'project not found' } };
  const from = body && (body.from || body.copy_from);
  const to = body && (body.to || body.simulation_id);
  if (!from || !to) return { ok: false, status: 400, body: { error: 'from and to study ids required' } };
  const dest = findStudy(projectDir(projectId), to);
  copySimulationSettings(
    projectId,
    proj,
    from,
    to,
    body.include,
    body.copy_mode || body.mode,
    (body && body.time_dependency) || (dest && dest.time_dependency)
  );
  const cat = ensureCatalog(projectId, proj);
  return { ok: true, status: 200, body: { ...catalogPayload(projectId, proj, cat), copied: true } };
}

export function getSimulation(projectIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        simulation: null,
        simulations: [],
        note: 'No active project. POST /api/simulation after project create.',
        increment: 'W17',
      },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  let cat = readCatalog(projectId);
  const want = String(simIdOpt || '').trim();
  if (want && (cat.simulations || []).some((s) => s && s.id === want)) {
    cat = { ...cat, active_id: want };
  }
  return {
    ok: true,
    status: 200,
    body: { ...catalogPayload(projectId, proj, cat), active: true },
  };
}

export async function handleW17Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  if (parts[0] === 'api' && parts[1] === 'simulation') {
    if (req.method === 'POST' && parts[2] === 'update') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = updateSimulation(body || {});
      res.setHeader('X-CFD-Source', 'simulation-update');
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'reorder') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = reorderSimulations(body || {});
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'activate') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = activateSimulation(body || {});
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && (parts[2] === 'delete' || parts[2] === 'remove')) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = deleteSimulation(body || {});
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && parts[2] === 'copy') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      const result = copySimulation(body || {});
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'POST' && !parts[2]) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      let result;
      try {
        result = createSimulation(body);
      } catch (e) {
        console.error('[CFD] create simulation', e);
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      res.setHeader('X-CFD-Source', 'simulation-create');
      res.setHeader('X-CFD-Increment', 'W17');
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      const pid = u.searchParams.get('project_id') || undefined;
      const sid = u.searchParams.get('simulation_id') || undefined;
      const result = getSimulation(pid, sid);
      res.setHeader('X-CFD-Source', 'simulation-get');
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/simulation' });
  }

  return false;
}

export { getActiveSimulation };

export const W17_META = {
  increment: 'W17',
  projects_root: PROJECTS_ROOT,
  defaults: W17_DEFAULTS,
};