/**
 * W20 — Mesh form settings only (filesystem persistence).
 * Persists projects/<id>/mesh.json via POST/GET /api/mesh.
 * Exact bank labels from mesh-form-labels.txt / FINDINGS.
 * NO Generate / remesh kick / Area average / solves in this slice.
 * Finished cell counts are NOT invented as live mesh results.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  activeGeometryId,
  filterByGeometry,
  filterByStudy,
  geometriesOf,
  matchesGeometry,
  primaryGeometryId,
} from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, listSimulations, writeActiveMirror } from './w17-sim-catalog.js';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';
import { pyJsonSync, writeProjectCli } from './py-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

/** Exact bank labels — HARD, no invent */
export const W20_DEFAULTS = {
  name: 'Mesh 1',
  algorithm: 'Standard',
  sizing: 'Automatic',
  fineness: 5,
  fineness_labels: { coarse: 'COARSE', fine: 'FINE' },
  curvature: 'Automatic',
  automatic_boundary_layers: true,
  physics_based_meshing: true,
  hex_element_core: true,
  automatic_extrusion_meshing: false,
  preferred_cpus: 'Automatic (max 16)',
  preferred_cpus_label: 'Preferred number of CPUs',
  requires_upgrade: true,
  maximum_meshing_runtime: '1.8e+4',
  maximum_meshing_runtime_unit: 's',
  advanced: {
    /* '' = automatic (derived from the geometry size at generate time) */
    small_feature_suppression: '',
    small_feature_suppression_unit: 'm',
    gap_refinement_factor: 0.05,
    global_gradation_rate: 1.22,
    /* 'standard' (gmsh surface + hex core + layers) or 'cfmesh' (legacy cartesianMesh) */
    mesh_engine: 'standard',
  },
};

const MESH_ENGINES = new Set(['standard', 'cfmesh']);
/* Old projects stored the fixed SimScale example value; treat it as automatic. */
const LEGACY_SFS_DEFAULT = '4.227e-6';

function asSfs(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (s === '' || s === LEGACY_SFS_DEFAULT || s.toLowerCase() === 'auto') return '';
  return Number.isFinite(Number(s)) && Number(s) > 0 ? s : fallback;
}

function asEngine(v, fallback) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return MESH_ENGINES.has(s) ? s : fallback;
}

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return j.project_id || null;
  } catch {
    return null;
  }
}

function projectDir(id) {
  return join(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function simulationJsonPath(id) {
  return join(projectDir(id), 'simulation.json');
}

function meshJsonPath(id) {
  return join(projectDir(id), 'mesh.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeProject(proj) {
  // Phase 1 Step 9/land9: shared writeProjectCli helper.
  return writeProjectCli(projectDir(proj.id), proj, String((proj.simulation && proj.simulation.id) || proj.active_simulation_id || ''));
}

function readSimulationFile(id) {
  const p = simulationJsonPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readMeshFile(id) {
  const p = meshJsonPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeshFile(id, doc) {
  const simId = doc && doc.simulation_id;
  pyJsonSync(
    'project_cli.py',
    ['set-mesh-settings', '--project-dir', projectDir(id), '--sim-id', String(simId || '')],
    doc,
  );
  return meshJsonPath(id);
}

function pathInside(parent, child) {
  const root = resolve(parent).replace(/[\\/]+$/, '').toLowerCase();
  const target = resolve(child).replace(/[\\/]+$/, '').toLowerCase();
  return target === root || target.startsWith(root + '\\') || target.startsWith(root + '/');
}

function removeGeneratedMeshRuns(projectId, caseDir) {
  const meshRoot = join(projectDir(projectId), 'mesh');
  const removed = [];
  if (!existsSync(meshRoot)) return removed;
  const tryRm = (p) => {
    if (!p || !existsSync(p) || !pathInside(meshRoot, p)) return;
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  };
  // Only the one mesh's case — never wipe every run-* (other meshes live there).
  if (caseDir) tryRm(caseDir);
  return removed;
}

function cloneDefaultSettings(name) {
  return {
    ...W20_DEFAULTS,
    name: name || W20_DEFAULTS.name,
    advanced: { ...W20_DEFAULTS.advanced },
  };
}

function cloneSettings(src, name) {
  const s = src || {};
  return {
    ...cloneDefaultSettings(name),
    ...s,
    name: name || s.name || W20_DEFAULTS.name,
    advanced: { ...W20_DEFAULTS.advanced, ...(s.advanced || {}) },
  };
}

function makeMeshEntry(raw) {
  const src = raw || {};
  const settings = src.settings || cloneDefaultSettings(src.name);
  const name = String(src.name || settings.name || W20_DEFAULTS.name);
  if (settings.name !== name) settings.name = name;
  return {
    id: src.id || newMeshId(),
    name,
    settings,
    generated: isGeneratedDoc(src),
    live_mesh_result: src.live_mesh_result || null,
    geometry_id: src.geometry_id || null,
    simulation_id: src.simulation_id || null,
    created_at: src.created_at || new Date().toISOString(),
    updated_at: src.updated_at || src.created_at || new Date().toISOString(),
  };
}

function geomNames(proj) {
  const o = {};
  for (const g of geometriesOf(proj)) {
    if (g && g.id) o[g.id] = g.name || g.original_filename || g.id;
  }
  return o;
}

function meshesFromDoc(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.meshes) && doc.meshes.length) {
    return doc.meshes.map((m) => makeMeshEntry(m));
  }
  return [makeMeshEntry(doc)];
}

function nextMeshName(meshes) {
  if (!meshes || !meshes.length) return 'Mesh 1';
  let max = 0;
  for (const m of meshes) {
    const hit = /^Mesh\s+(\d+)$/i.exec(String((m && m.name) || ''));
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return `Mesh ${Math.max(max, meshes.length) + 1}`;
}

function findMeshById(meshes, id) {
  if (!id || !meshes || !meshes.length) return null;
  const want = String(id);
  return meshes.find((m) => m && String(m.id) === want) || null;
}

function liveStudyMeshes(projectId, proj, meshes) {
  const liveIds = new Set((listSimulations(projectId, proj) || []).map((s) => String(s.id)));
  const legacy = firstLegacySimId(projectId, proj);
  return (meshes || []).filter((m) => {
    if (!m) return false;
    const sid = m.simulation_id != null ? String(m.simulation_id).trim() : '';
    if (sid) return liveIds.has(sid);
    return liveIds.size === 1 && !!legacy;
  });
}

function isRunningMesh(entry) {
  const live = entry && entry.live_mesh_result;
  return !!(live && live.status === 'running');
}

function listPayload(meshes, activeId, nameByGeom) {
  return (meshes || []).map((m) => ({
    id: m.id,
    name: m.name,
    generated: isGeneratedDoc(m),
    status: (m.live_mesh_result && m.live_mesh_result.status) || (isGeneratedDoc(m) ? 'done' : null),
    n_cells: (m.live_mesh_result && m.live_mesh_result.n_cells) || null,
    n_points: (m.live_mesh_result && m.live_mesh_result.n_points) || null,
    case_dir: (m.live_mesh_result && m.live_mesh_result.case_dir) || m.case_dir || null,
    live_mesh_result: m.live_mesh_result || null,
    geometry_id: m.geometry_id || null,
    geometry_name: (m.geometry_id && nameByGeom && nameByGeom[m.geometry_id]) || null,
    simulation_id: m.simulation_id || null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }));
}

function isGeneratedDoc(doc) {
  if (!doc) return false;
  const live = doc.live_mesh_result;
  return !!(doc.generated || (live && live.status === 'done'));
}

function writeProjectMeshRef(proj, sim, doc, now) {
  if (proj) {
    proj.mesh = {
      id: doc.id,
      name: doc.name,
      algorithm: doc.settings && doc.settings.algorithm,
      sizing: doc.settings && doc.settings.sizing,
      fineness: doc.settings && doc.settings.fineness,
      bank_exact: doc.bank_exact,
      mesh_json: doc.mesh_json,
      active_id: doc.active_id,
      mesh_count: Array.isArray(doc.meshes) ? doc.meshes.length : 1,
      updated_at: now,
    };
    proj.updated_at = now;
    writeProject(proj);
  }
  if (sim) {
    try {
      const simDoc = { ...sim };
      simDoc.mesh = {
        id: doc.id,
        name: doc.name,
        mesh_json: doc.mesh_json,
        bank_exact: doc.bank_exact,
        active_id: doc.active_id,
      };
      simDoc.updated_at = now;
      simDoc.increment = 'W20';
      writeActiveMirror(doc.project_id, simDoc);
    } catch {
      /* non-fatal */
    }
  }
}

function composeMeshDoc(projectId, sim, existing, meshes, active, now) {
  const settings = active.settings || cloneDefaultSettings(active.name);
  const meshPath = meshJsonPath(projectId);
  const generated = isGeneratedDoc(active);
  const doc = {
    ...(existing || {}),
    id: active.id,
    project_id: projectId,
    simulation_id: sim && sim.id,
    name: active.name,
    settings,
    defaults: { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } },
    bank_exact: bankExact(settings),
    generated,
    generate_available: !!(existing && existing.generate_available) || generated,
    live_mesh_result: active.live_mesh_result || null,
    active_id: active.id,
    meshes,
    note:
      'W20 Mesh form settings. Multiple meshes in meshes[]. Top-level fields are the active mesh.',
    persistence: 'filesystem',
    mesh_json: meshPath,
    created_at: (existing && existing.created_at) || active.created_at || now,
    updated_at: now,
    soft_pass_avoided: true,
    increment: 'W20',
  };
  delete doc.last_generate;
  delete doc.n_cells;
  delete doc.n_points;
  delete doc.n_faces;
  delete doc.out_of_scope;
  return doc;
}

function meshApiBody(doc, projectId, extra, proj) {
  const all = (doc && doc.meshes) || [];
  const sim = proj
    ? getActiveSimulation(projectId, proj, extra && extra.simulation_id)
    : null;
  const simId = (sim && sim.id) || (extra && extra.simulation_id) || null;
  const geomId =
    (sim && sim.geometry_id) ||
    activeGeometryId(proj, extra && extra.geometry_id);
  const names = geomNames(proj);
  const legacyId = proj ? firstLegacySimId(projectId, proj) : simId;
  const scoped = proj
    ? filterByStudy(filterByGeometry(all, geomId, primaryGeometryId(proj)), simId, legacyId)
    : all;
  return {
    ok: true,
    mesh: doc,
    settings: doc.settings,
    defaults: doc.defaults,
    bank_exact: doc.bank_exact,
    project_id: projectId,
    simulation_id: doc.simulation_id,
    mesh_json: doc.mesh_json,
    generated: !!doc.generated,
    live_mesh_result: doc.live_mesh_result || null,
    active_id: doc.active_id,
    meshes: listPayload(scoped, doc.active_id, names),
    meshes_all: listPayload(proj ? liveStudyMeshes(projectId, proj, all) : all, doc.active_id, names),
    geometry_id: geomId,
    soft_pass_avoided: true,
    increment: 'W20',
    ...(extra || {}),
  };
}

function deleteGeneratedMesh(body) {
  const gate = requireProjectSim(body);
  if (!gate.ok) return gate;
  const { projectId, proj, sim } = gate;
  const existing = readMeshFile(projectId);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      body: { error: 'no mesh settings to delete from', project_id: projectId },
    };
  }
  const meshes = meshesFromDoc(existing);
  const geomId = sim.geometry_id || activeGeometryId(proj, body && body.geometry_id);
  const scoped = filterByStudy(
    filterByGeometry(meshes, geomId, primaryGeometryId(proj)),
    sim.id,
    firstLegacySimId(projectId, proj)
  );
  const requested = body && (body.mesh_id || body.id);
  const fileActiveInScoped =
    existing.active_id && scoped.some((m) => m && String(m.id) === String(existing.active_id));
  const targetId = requested || (fileActiveInScoped ? existing.active_id : null);
  const target = findMeshById(scoped, targetId);
  if (!target) {
    return {
      ok: false,
      status: 404,
      body: { error: 'mesh not found in this study', project_id: projectId },
    };
  }
  const live = target.live_mesh_result || {};
  const removed = removeGeneratedMeshRuns(projectId, live.case_dir || null);
  const now = new Date().toISOString();
  target.generated = false;
  target.live_mesh_result = null;
  target.updated_at = now;
  const active = target;
  const doc = composeMeshDoc(projectId, sim, existing, meshes, active, now);
  doc.note = 'Generated mesh deleted. Settings and other meshes kept.';
  writeMeshFile(projectId, doc);
  try {
    writeProjectMeshRef(proj, sim, doc, now);
  } catch {
    /* non-fatal */
  }
  return {
    ok: true,
    status: 200,
    body: meshApiBody(doc, projectId, {
      deleted: true,
      deleted_runs: removed,
      generated: false,
      live_mesh_result: null,
    }, proj),
  };
}

function newMeshId() {
  return `mesh-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function asBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'ON' || v === 'on' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 'OFF' || v === 'off' || v === 0 || v === '0') return false;
  return fallback;
}

function asNumber(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asSciString(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v);
}

function bankExact(settings) {
  if (!settings) return false;
  const adv = settings.advanced || {};
  return (
    settings.algorithm === W20_DEFAULTS.algorithm &&
    settings.sizing === W20_DEFAULTS.sizing &&
    Number(settings.fineness) === W20_DEFAULTS.fineness &&
    settings.curvature === W20_DEFAULTS.curvature &&
    settings.automatic_boundary_layers === true &&
    settings.physics_based_meshing === true &&
    settings.hex_element_core === true &&
    settings.automatic_extrusion_meshing === false &&
    settings.preferred_cpus === W20_DEFAULTS.preferred_cpus &&
    String(settings.maximum_meshing_runtime) === W20_DEFAULTS.maximum_meshing_runtime &&
    settings.maximum_meshing_runtime_unit === W20_DEFAULTS.maximum_meshing_runtime_unit &&
    asSfs(adv.small_feature_suppression, '') === W20_DEFAULTS.advanced.small_feature_suppression &&
    adv.small_feature_suppression_unit === W20_DEFAULTS.advanced.small_feature_suppression_unit &&
    asEngine(adv.mesh_engine, 'standard') === W20_DEFAULTS.advanced.mesh_engine &&
    Number(adv.gap_refinement_factor) === W20_DEFAULTS.advanced.gap_refinement_factor &&
    Number(adv.global_gradation_rate) === W20_DEFAULTS.advanced.global_gradation_rate
  );
}

function buildSettings(body, existing) {
  const src = body || {};
  const advIn = src.advanced || {};
  const existingSettings = (existing && existing.settings) || {};
  const existingAdv = existingSettings.advanced || {};
  const useBank = src.use_bank_defaults === true || src.bank === true || Object.keys(src).length === 0 || src.reset_defaults === true;

  const settings = {
    name: String(src.name || existingSettings.name || W20_DEFAULTS.name),
    algorithm: useBank
      ? W20_DEFAULTS.algorithm
      : String(src.algorithm || existingSettings.algorithm || W20_DEFAULTS.algorithm),
    sizing: useBank
      ? W20_DEFAULTS.sizing
      : String(src.sizing || existingSettings.sizing || W20_DEFAULTS.sizing),
    fineness: useBank
      ? W20_DEFAULTS.fineness
      : asNumber(src.fineness !== undefined ? src.fineness : existingSettings.fineness, W20_DEFAULTS.fineness),
    fineness_labels: { ...W20_DEFAULTS.fineness_labels },
    curvature: useBank
      ? W20_DEFAULTS.curvature
      : String(src.curvature || existingSettings.curvature || W20_DEFAULTS.curvature),
    automatic_boundary_layers: useBank
      ? true
      : asBool(
          src.automatic_boundary_layers !== undefined
            ? src.automatic_boundary_layers
            : existingSettings.automatic_boundary_layers,
          true
        ),
    physics_based_meshing: useBank
      ? true
      : asBool(
          src.physics_based_meshing !== undefined
            ? src.physics_based_meshing
            : existingSettings.physics_based_meshing,
          true
        ),
    hex_element_core: useBank
      ? true
      : asBool(
          src.hex_element_core !== undefined ? src.hex_element_core : existingSettings.hex_element_core,
          true
        ),
    automatic_extrusion_meshing: useBank
      ? false
      : asBool(
          src.automatic_extrusion_meshing !== undefined
            ? src.automatic_extrusion_meshing
            : existingSettings.automatic_extrusion_meshing,
          false
        ),
    preferred_cpus: useBank
      ? W20_DEFAULTS.preferred_cpus
      : String(src.preferred_cpus || existingSettings.preferred_cpus || W20_DEFAULTS.preferred_cpus),
    preferred_cpus_label: W20_DEFAULTS.preferred_cpus_label,
    requires_upgrade: true,
    maximum_meshing_runtime: useBank
      ? W20_DEFAULTS.maximum_meshing_runtime
      : asSciString(
          src.maximum_meshing_runtime !== undefined
            ? src.maximum_meshing_runtime
            : existingSettings.maximum_meshing_runtime,
          W20_DEFAULTS.maximum_meshing_runtime
        ),
    maximum_meshing_runtime_unit: useBank
      ? W20_DEFAULTS.maximum_meshing_runtime_unit
      : String(
          src.maximum_meshing_runtime_unit ||
            existingSettings.maximum_meshing_runtime_unit ||
            W20_DEFAULTS.maximum_meshing_runtime_unit
        ),
    advanced: {
      small_feature_suppression: useBank
        ? W20_DEFAULTS.advanced.small_feature_suppression
        : asSfs(
            advIn.small_feature_suppression !== undefined
              ? advIn.small_feature_suppression
              : existingAdv.small_feature_suppression,
            W20_DEFAULTS.advanced.small_feature_suppression
          ),
      small_feature_suppression_unit: W20_DEFAULTS.advanced.small_feature_suppression_unit,
      mesh_engine: useBank
        ? W20_DEFAULTS.advanced.mesh_engine
        : asEngine(
            advIn.mesh_engine !== undefined ? advIn.mesh_engine : existingAdv.mesh_engine,
            W20_DEFAULTS.advanced.mesh_engine
          ),
      gap_refinement_factor: useBank
        ? W20_DEFAULTS.advanced.gap_refinement_factor
        : asNumber(
            advIn.gap_refinement_factor !== undefined
              ? advIn.gap_refinement_factor
              : existingAdv.gap_refinement_factor,
            W20_DEFAULTS.advanced.gap_refinement_factor
          ),
      global_gradation_rate: useBank
        ? W20_DEFAULTS.advanced.global_gradation_rate
        : asNumber(
            advIn.global_gradation_rate !== undefined
              ? advIn.global_gradation_rate
              : existingAdv.global_gradation_rate,
            W20_DEFAULTS.advanced.global_gradation_rate
          ),
    },
  };

  // Force bank-exact when caller asks for bank defaults (W20 hard bar)
  if (useBank || src.force_bank === true) {
    Object.assign(settings, {
      algorithm: W20_DEFAULTS.algorithm,
      sizing: W20_DEFAULTS.sizing,
      fineness: W20_DEFAULTS.fineness,
      curvature: W20_DEFAULTS.curvature,
      automatic_boundary_layers: true,
      physics_based_meshing: true,
      hex_element_core: true,
      automatic_extrusion_meshing: false,
      preferred_cpus: W20_DEFAULTS.preferred_cpus,
      maximum_meshing_runtime: W20_DEFAULTS.maximum_meshing_runtime,
      maximum_meshing_runtime_unit: W20_DEFAULTS.maximum_meshing_runtime_unit,
      advanced: { ...W20_DEFAULTS.advanced },
    });
  }

  return settings;
}

function requireProjectSim(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'no active project; create project first', soft_pass: false },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return {
      ok: false,
      status: 404,
      body: { error: 'project not found', project_id: projectId },
    };
  }
  const sim = getActiveSimulation(projectId, proj, body && body.simulation_id);
  if (!sim) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'no simulation; Create Simulation → Incompressible first (W17)',
        soft_pass: false,
      },
    };
  }
  return { ok: true, projectId, proj, sim };
}

function saveComposed(projectId, proj, sim, existing, meshes, active, now, extra) {
  const doc = composeMeshDoc(projectId, sim, existing, meshes, active, now);
  writeMeshFile(projectId, doc);
  writeProjectMeshRef(proj, sim, doc, now);
  return {
    ok: true,
    status: existing ? 200 : 201,
    body: meshApiBody(doc, projectId, extra, proj),
  };
}

function createMesh(body) {
  const gate = requireProjectSim(body);
  if (!gate.ok) return gate;
  const { projectId, proj, sim } = gate;
  const existing = readMeshFile(projectId);
  const meshes = meshesFromDoc(existing);
  const now = new Date().toISOString();
  const geomId = sim.geometry_id || activeGeometryId(proj, body && body.geometry_id);
  const scoped = filterByStudy(
    filterByGeometry(meshes, geomId, primaryGeometryId(proj)),
    sim.id,
    firstLegacySimId(projectId, proj)
  );
  const requested = String((body && (body.name || body.mesh_name)) || '').trim();
  const name = requested || nextMeshName(scoped);
  const srcId = body && (body.copy_from || body.copy_from_id);
  const src = srcId ? findMeshById(meshes, srcId) : null;
  const settings = src ? cloneSettings(src.settings, name) : cloneDefaultSettings(name);
  const entry = makeMeshEntry({
    name,
    settings,
    geometry_id: geomId,
    simulation_id: sim.id,
    created_at: now,
    updated_at: now,
  });
  meshes.push(entry);
  return saveComposed(projectId, proj, sim, existing, meshes, entry, now, {
    created: true,
    copied_from: src ? src.id : null,
  });
}

function activateMesh(body) {
  const gate = requireProjectSim(body);
  if (!gate.ok) return gate;
  const { projectId, proj, sim } = gate;
  const existing = readMeshFile(projectId);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      body: { error: 'no mesh settings to activate', project_id: projectId },
    };
  }
  const meshes = meshesFromDoc(existing);
  const geomId = sim.geometry_id || activeGeometryId(proj, body && body.geometry_id);
  const scoped = filterByStudy(
    filterByGeometry(meshes, geomId, primaryGeometryId(proj)),
    sim.id,
    firstLegacySimId(projectId, proj)
  );
  const target = findMeshById(scoped, body && (body.activate || body.mesh_id || body.id));
  if (!target) {
    return {
      ok: false,
      status: 404,
      body: { error: 'mesh not found in this study', project_id: projectId },
    };
  }
  const now = new Date().toISOString();
  return saveComposed(projectId, proj, sim, existing, meshes, target, now, {
    activated: true,
    simulation_id: sim.id,
    geometry_id: geomId,
  });
}

function upsertMesh(body) {
  if (body && body.create === true) return createMesh(body);
  if (body && (body.activate || body.activate_id)) {
    return activateMesh({ ...body, activate: body.activate || body.activate_id });
  }
  const gate = requireProjectSim(body);
  if (!gate.ok) return gate;
  const { projectId, proj, sim } = gate;
  const existing = readMeshFile(projectId);
  const meshes = meshesFromDoc(existing);
  const now = new Date().toISOString();
  const geomId = sim.geometry_id || activeGeometryId(proj, body && body.geometry_id);
  const primaryId = primaryGeometryId(proj);
  const scoped = filterByStudy(
    filterByGeometry(meshes, geomId, primaryId),
    sim.id,
    firstLegacySimId(projectId, proj)
  );
  const requested = body && (body.mesh_id || body.id);
  let active = requested
    ? findMeshById(scoped, requested)
    : findMeshById(scoped, existing && existing.active_id) || null;
  if (active && !requested && !matchesGeometry(active, geomId, primaryId)) {
    active = null;
  }
  if (requested && !active) {
    return {
      ok: false,
      status: 404,
      body: { error: 'mesh not found in this study', project_id: projectId },
    };
  }
  if (!active) {
    const name = nextMeshName(scoped);
    active = makeMeshEntry({
      name,
      settings: cloneDefaultSettings(name),
      geometry_id: geomId,
      simulation_id: sim.id,
      created_at: now,
      updated_at: now,
    });
    meshes.push(active);
  } else if (geomId && !active.geometry_id) {
    active.geometry_id = geomId;
  }
  const copyFrom = body && (body.copy_from || body.copy_from_id);
  if (copyFrom) {
    const src = findMeshById(meshes, copyFrom);
    if (src && src.id !== active.id) {
      active.settings = cloneSettings(src.settings, active.name);
      active.updated_at = now;
      return saveComposed(projectId, proj, sim, existing, meshes, active, now, {
        copied: true,
        copied_from: src.id,
      });
    }
  }
  const settings = buildSettings(body || {}, { settings: active.settings });
  if (body && (body.reset_defaults === true || body.use_bank_defaults === true)) {
    settings.name = String(body.name || active.name || settings.name);
  }
  active.settings = settings;
  active.name = settings.name;
  active.updated_at = now;
  return saveComposed(projectId, proj, sim, existing, meshes, active, now, {
    saved: true,
  });
}

function getMesh(projectIdOpt, geomIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        mesh: null,
        settings: null,
        defaults: { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } },
        bank_exact: false,
        meshes: [],
        active_id: null,
        note: 'No active project. POST /api/mesh after simulation create.',
        increment: 'W20',
      },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return {
      ok: false,
      status: 404,
      body: { error: 'project not found', project_id: projectId },
    };
  }
  const raw = readMeshFile(projectId);
  const all = meshesFromDoc(raw);
  const primaryId = primaryGeometryId(proj);
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const geomId = (sim && sim.geometry_id) || activeGeometryId(proj, geomIdOpt);
  const scoped = filterByStudy(
    filterByGeometry(all, geomId, primaryId),
    sim && sim.id,
    firstLegacySimId(projectId, proj)
  );
  const names = geomNames(proj);
  const active = findMeshById(scoped, raw && raw.active_id);
  const doc = raw && active ? { ...raw, ...active, active_id: active.id, meshes: scoped } : null;
  const settings = doc ? doc.settings : null;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      mesh: doc,
      settings,
      defaults: { ...W20_DEFAULTS, advanced: { ...W20_DEFAULTS.advanced } },
      bank_exact: !!(doc && bankExact(settings)),
      mesh_json_path: meshJsonPath(projectId),
      mesh_json_exists: existsSync(meshJsonPath(projectId)),
      project_mesh_ref: proj.mesh || null,
      generated: isGeneratedDoc(active || doc),
      live_mesh_result: (active && active.live_mesh_result) || null,
      active_id: (active && active.id) || null,
      meshes: listPayload(scoped, active && active.id, names),
      meshes_all: listPayload(liveStudyMeshes(projectId, proj, all), raw && raw.active_id, names),
      geometry_id: geomId,
      increment: 'W20',
    },
  };
}

/**
 * Vite middleware for /api/mesh*
 * Returns true if handled.
 */
export async function handleW20Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  if (parts[0] === 'api' && parts[1] === 'mesh') {
    // W21 handles generate/remesh upstream; if reached here, defer
    if (parts[2] === 'generate' || parts[2] === 'remesh') {
      return false;
    }
    if (parts[2] === 'kick') {
      return sendJson(res, 404, {
        error: 'Use POST /api/mesh/generate for W21 remesh (not W15.1 checkMesh kick)',
        soft_pass: false,
        increment: 'W21',
      });
    }
    if (req.method === 'POST' && (parts[2] === 'delete' || !parts[2])) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      if (
        parts[2] === 'delete' ||
        (body && (body.delete_generated === true || body.delete === true))
      ) {
        const result = deleteGeneratedMesh(body);
        if (result.ok && typeof helpers.onGeneratedMeshDeleted === 'function') {
          try {
            helpers.onGeneratedMeshDeleted({
              project_id: result.body && result.body.project_id,
              deleted_runs: (result.body && result.body.deleted_runs) || [],
            });
          } catch (e) {
            console.warn('[CFD W20] onGeneratedMeshDeleted', e);
          }
        }
        res.setHeader('X-CFD-Source', 'mesh-delete');
        res.setHeader('X-CFD-Increment', 'W20');
        return sendJson(res, result.status, result.body);
      }
      // Reject generate flags in POST body
      if (body && (body.generate === true || body.remesh === true || body.kick === true)) {
        return sendJson(res, 400, {
          error: 'W20 settings-only: generate/remesh flags rejected',
          soft_pass: false,
          increment: 'W20',
        });
      }
      const result = upsertMesh(body);
      res.setHeader('X-CFD-Source', 'mesh-upsert');
      res.setHeader('X-CFD-Increment', 'W20');
      if (result.ok && result.body.mesh) {
        res.setHeader('X-CFD-Mesh-Id', result.body.mesh.id);
        res.setHeader('X-CFD-Project-Id', result.body.project_id);
        res.setHeader('X-CFD-Mesh-Algorithm', result.body.settings.algorithm);
        res.setHeader('X-CFD-Mesh-Fineness', String(result.body.settings.fineness));
        res.setHeader('X-CFD-Mesh-Bank-Exact', result.body.bank_exact ? '1' : '0');
      }
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      const pid = u.searchParams.get('project_id') || undefined;
      const result = getMesh(
        pid,
        u.searchParams.get('geometry_id') || undefined,
        u.searchParams.get('simulation_id') || undefined
      );
      res.setHeader('X-CFD-Source', 'mesh-get');
      res.setHeader('X-CFD-Increment', 'W20');
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/mesh' });
  }

  return false;
}

export const W20_META = {
  increment: 'W20',
  projects_root: PROJECTS_ROOT,
  defaults: W20_DEFAULTS,
};
