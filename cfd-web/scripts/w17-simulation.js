/**
 * W17 — Create Simulation -> Incompressible studies.
 * Catalog: projects/<id>/simulations.json (active mirrored to simulation.json).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeGeometryId, geometriesOf, matchesGeometry, matchesStudy, primaryGeometryId } from './w16-geometry-scope.js';
import {
  deleteSimulationFromCatalog,
  ensureCatalog,
  getActiveSimulation,
  projectDir,
  pruneOrphanStudies,
  saveCatalog,
  setActiveSimulation,
  simulationJsonPath,
  studyBaseName,
  firstLegacySimId,
  upsertSimulationInCatalog,
} from './w17-sim-catalog.js';
import { envGet } from './env-compat.js';
import { pyJsonSync } from './py-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

export const W17_DEFAULTS = {
  analysis: 'Incompressible',
  analysis_title: 'Incompressible Fluid Flow',
  category: 'FLUID DYNAMICS',
  flow_group: 'FLOW',
  turbulence_model: 'k-omega SST',
  time_dependency: 'Steady-state',
  algorithm: 'SIMPLE',
  passive_species: '0',
};

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
  // Phase 1 Step 9: project.json writes go through project_cli (Python).
  return pyJsonSync(
    'project_cli.py',
    ['write-project', '--project-dir', projectDir(proj.id), '--sim-id', String(proj.active_simulation_id || '')],
    proj,
  );
}

function newSimId() {
  return `sim-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export const TIME_DEPENDENCIES = Object.freeze({
  'Steady-state': 'SIMPLE',
  Transient: 'PIMPLE',
});

function normalizeTimeDependency(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return fallback || W17_DEFAULTS.time_dependency;
  if (/transient/i.test(s)) return 'Transient';
  if (/steady/i.test(s)) return 'Steady-state';
  return fallback || W17_DEFAULTS.time_dependency;
}

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, doc) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
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
  const analysis = String(body.analysis || body.type || W17_DEFAULTS.analysis).trim();
  if (analysis !== 'Incompressible') {
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
    analysis_title: W17_DEFAULTS.analysis_title,
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

function createSimulation(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first', soft_pass: false } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const existingCat = ensureCatalog(projectId, proj);
  purgeOrphanSetupRecords(
    projectId,
    proj,
    (existingCat.simulations || []).map((s) => s && s.id).filter(Boolean)
  );
  const built = buildSimulation(body || {}, proj);
  if (!built.ok) return built;
  const cat = upsertSimulationInCatalog(projectId, proj, built.sim, true);
  const sim = (cat.simulations || []).find((s) => s.id === built.sim.id) || built.sim;
  touchProjectSimRef(proj, sim);
  writeProject(proj);
  if (body && body.copy_from) {
    copySimulationSettings(projectId, proj, body.copy_from, sim.id, body.include);
  }
  return {
    ok: true,
    status: 201,
    body: { ...catalogPayload(projectId, proj, cat), simulation: sim, soft_pass_avoided: true },
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
  if (body.geometry_id != null) sim.geometry_id = String(body.geometry_id);
  sim.updated_at = now;
  const cat = upsertSimulationInCatalog(projectId, proj, sim, true);
  const next = (cat.simulations || []).find((s) => s.id === sim.id) || sim;
  touchProjectSimRef(proj, next);
  writeProject(proj);
  return { ok: true, status: 200, body: { ...catalogPayload(projectId, proj, cat), increment: 'W30' } };
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

function copySimulationSettings(projectId, proj, fromId, toId, include) {
  const want = Array.isArray(include) && include.length ? include : ['materials', 'bcs', 'mesh'];
  const from = String(fromId);
  const to = String(toId);
  const cat = ensureCatalog(projectId, proj);
  const fromSim = (cat.simulations || []).find((s) => s.id === from);
  const toSim = (cat.simulations || []).find((s) => s.id === to);
  const fromGeom = (fromSim && fromSim.geometry_id) || activeGeometryId(proj);
  const toGeom = (toSim && toSim.geometry_id) || fromGeom;
  const primary = primaryGeometryId(proj);
  const legacy = firstLegacySimId(projectId, proj);

  const copyList = (p, key, mapFn) => {
    const doc = readJson(p);
    if (!doc || !Array.isArray(doc[key])) return;
    const src = doc[key].filter(
      (r) => matchesStudy(r, from, legacy) && matchesGeometry(r, fromGeom, primary)
    );
    const kept = doc[key].filter((r) => !(matchesStudy(r, to, legacy) && matchesGeometry(r, toGeom, primary)));
    const copies = src.map((r, i) => {
      const c = mapFn(r, i);
      if (toGeom) c.geometry_id = toGeom;
      return c;
    });
    doc[key] = kept.concat(copies);
    doc.simulation_id = to;
    doc.updated_at = new Date().toISOString();
    writeJson(p, doc);
  };

  if (want.includes('materials')) {
    const p = join(projectDir(projectId), 'materials.json');
    copyList(p, 'materials', (r, i) => cloneRec(r, to, `mat-copy-${Date.now().toString(36)}-${i}`));
    const doc = readJson(p);
    if (doc) {
      doc.air = (doc.materials || []).find((m) => m.name === 'Air' && matchesStudy(m, to, to)) || null;
      writeJson(p, doc);
    }
  }
  if (want.includes('bcs')) {
    copyList(join(projectDir(projectId), 'boundary_conditions.json'), 'boundary_conditions', (r, i) =>
      cloneRec(r, to, `bc-copy-${Date.now().toString(36)}-${i}`)
    );
  }
  if (want.includes('mesh')) {
    const p = join(projectDir(projectId), 'mesh.json');
    copyList(p, 'meshes', (r, i) => {
      const c = cloneRec(r, to, `mesh-copy-${Date.now().toString(36)}-${i}`);
      c.generated = false;
      c.live_mesh_result = null;
      return c;
    });
    copyList(join(projectDir(projectId), 'mesh_refinements.json'), 'refinements', (r, i) =>
      cloneRec(r, to, `ref-copy-${Date.now().toString(36)}-${i}`)
    );
  }
}

export function purgeStudyRecords(projectId, simId, geomId) {
  const want = String(simId || '').trim();
  if (!want) return;
  const gid = String(geomId || '').trim();
  const drop = (arr) =>
    (arr || []).filter((r) => {
      if (!r) return false;
      if (String(r.simulation_id || '') === want) return false;
      if (!r.simulation_id && gid && String(r.geometry_id || '') === gid) return false;
      return true;
    });
  const meshPath = join(projectDir(projectId), 'mesh.json');
  const meshDoc = readJson(meshPath);
  if (meshDoc && Array.isArray(meshDoc.meshes)) {
    meshDoc.meshes = drop(meshDoc.meshes);
    if (
      String(meshDoc.simulation_id || '') === want ||
      !meshDoc.meshes.some((m) => m && m.id === meshDoc.active_id)
    ) {
      const next = meshDoc.meshes.find((m) => m && m.id === meshDoc.active_id) || null;
      meshDoc.active_id = next ? next.id : null;
      meshDoc.id = next ? next.id : null;
      meshDoc.simulation_id = next ? next.simulation_id : null;
      meshDoc.generated = !!(next && next.generated);
      meshDoc.live_mesh_result = (next && next.live_mesh_result) || null;
      meshDoc.settings = (next && next.settings) || meshDoc.settings;
    }
    meshDoc.updated_at = new Date().toISOString();
    writeJson(meshPath, meshDoc);
  }
  const files = [
    [join(projectDir(projectId), 'materials.json'), 'materials'],
    [join(projectDir(projectId), 'boundary_conditions.json'), 'boundary_conditions'],
    [join(projectDir(projectId), 'mesh_refinements.json'), 'refinements'],
    [join(projectDir(projectId), 'runs', 'catalog.json'), 'runs'],
  ];
  for (const [p, key] of files) {
    const doc = readJson(p);
    if (!doc || !Array.isArray(doc[key])) continue;
    doc[key] = drop(doc[key]);
    if (String(doc.simulation_id || '') === want) {
      const keep = doc[key][0];
      doc.simulation_id = keep && keep.simulation_id ? keep.simulation_id : null;
    }
    if (key === 'materials' && doc.air && String(doc.air.simulation_id || '') === want) {
      doc.air = (doc.materials || []).find((m) => m && m.name === 'Air' && String(m.simulation_id || '') !== want) || null;
    }
    doc.updated_at = new Date().toISOString();
    writeJson(p, doc);
  }
}

function keepLiveSetupRec(rec, liveSims, liveGeoms, remainingStudyGeoms) {
  if (!rec) return false;
  if (!liveSims.size) return false;
  const sid = rec.simulation_id != null ? String(rec.simulation_id).trim() : '';
  const gid = rec.geometry_id != null ? String(rec.geometry_id).trim() : '';
  if (sid && !liveSims.has(sid)) return false;
  if (gid && liveGeoms.size && !liveGeoms.has(gid)) return false;
  if (!sid) {
    if (liveSims.size !== 1) return false;
    if (remainingStudyGeoms && remainingStudyGeoms.size && gid && !remainingStudyGeoms.has(gid)) {
      return false;
    }
    if (!gid && liveGeoms.size > 1) return false;
    return true;
  }
  return true;
}

export function purgeOrphanSetupRecords(projectId, proj, liveSimIds) {
  if (!projectId) return;
  const liveSims = new Set((liveSimIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const liveGeoms = new Set(
    geometriesOf(proj)
      .map((g) => String((g && g.id) || '').trim())
      .filter(Boolean)
  );
  const remainingStudyGeoms = new Set();
  try {
    const cat = ensureCatalog(projectId, proj);
    for (const s of cat.simulations || []) {
      if (s && liveSims.has(String(s.id || '')) && s.geometry_id) {
        remainingStudyGeoms.add(String(s.geometry_id));
      }
    }
  } catch (_) {}
  const keep = (arr) => (arr || []).filter((r) => keepLiveSetupRec(r, liveSims, liveGeoms, remainingStudyGeoms));
  const now = new Date().toISOString();

  const meshPath = join(projectDir(projectId), 'mesh.json');
  const meshDoc = readJson(meshPath);
  if (meshDoc) {
    if (Array.isArray(meshDoc.meshes)) meshDoc.meshes = keep(meshDoc.meshes);
    const next = (meshDoc.meshes || []).find((m) => m && m.id === meshDoc.active_id) || null;
    meshDoc.active_id = next ? next.id : null;
    meshDoc.id = next ? next.id : null;
    meshDoc.simulation_id = next ? next.simulation_id : null;
    meshDoc.generated = !!(next && next.generated);
    meshDoc.live_mesh_result = (next && next.live_mesh_result) || null;
    if (next && next.settings) meshDoc.settings = next.settings;
    meshDoc.updated_at = now;
    writeJson(meshPath, meshDoc);
  }

  const files = [
    [join(projectDir(projectId), 'materials.json'), 'materials'],
    [join(projectDir(projectId), 'boundary_conditions.json'), 'boundary_conditions'],
    [join(projectDir(projectId), 'mesh_refinements.json'), 'refinements'],
    [join(projectDir(projectId), 'result_controls.json'), 'result_controls'],
    [join(projectDir(projectId), 'area_average.json'), 'result_controls'],
    [join(projectDir(projectId), 'runs', 'catalog.json'), 'runs'],
  ];
  for (const [p, key] of files) {
    const doc = readJson(p);
    if (!doc || !Array.isArray(doc[key])) continue;
    doc[key] = keep(doc[key]);
    if (doc.simulation_id && !liveSims.has(String(doc.simulation_id))) {
      const keepRec = doc[key][0];
      doc.simulation_id = keepRec && keepRec.simulation_id ? keepRec.simulation_id : null;
    }
    if (key === 'materials') {
      const airOk = doc.air && keepLiveSetupRec(doc.air, liveSims, liveGeoms, remainingStudyGeoms);
      doc.air = airOk
        ? doc.air
        : (doc.materials || []).find(
            (m) => m && m.name === 'Air' && keepLiveSetupRec(m, liveSims, liveGeoms, remainingStudyGeoms)
          ) || null;
    }
    if (key === 'result_controls') {
      const aaOk = doc.area_average_1 && keepLiveSetupRec(doc.area_average_1, liveSims, liveGeoms, remainingStudyGeoms);
      doc.area_average_1 = aaOk ? doc.area_average_1 : null;
    }
    doc.updated_at = now;
    writeJson(p, doc);
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
  purgeStudyRecords(projectId, simId, doomed.geometry_id);
  const next = deleteSimulationFromCatalog(projectId, proj, simId);
  const active = (next.simulations || []).find((s) => s.id === next.active_id) || next.simulations[0] || null;
  if (active) touchProjectSimRef(proj, active);
  else {
    proj.simulation = null;
    proj.active_simulation_id = null;
  }
  proj.updated_at = new Date().toISOString();
  writeProject(proj);
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
  copySimulationSettings(projectId, proj, from, to, body.include);
  const cat = ensureCatalog(projectId, proj);
  return { ok: true, status: 200, body: { ...catalogPayload(projectId, proj, cat), copied: true } };
}

function getSimulation(projectIdOpt, simIdOpt) {
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
  const pruned = pruneOrphanStudies(projectId, proj);
  for (const s of pruned.dropped || []) {
    try {
      purgeStudyRecords(projectId, s.id, s.geometry_id);
    } catch (_) {}
  }
  const cat = ensureCatalog(projectId, proj);
  purgeOrphanSetupRecords(
    projectId,
    proj,
    (cat.simulations || []).map((s) => s && s.id).filter(Boolean)
  );
  if (simIdOpt) setActiveSimulation(projectId, proj, simIdOpt);
  const next = ensureCatalog(projectId, proj);
  return {
    ok: true,
    status: 200,
    body: { ...catalogPayload(projectId, proj, next), active: true },
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
      const result = createSimulation(body);
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
