import { safeProjectPath } from './safe-path.js';
/**
 * W18 — Materials → Air + Body1 assign (filesystem persistence).
 * Persists projects/<id>/materials.json via POST/GET /api/materials.
 * Bank path: Materials + → Air (Newtonian) → assign Body1 → ✓ save.
 * NO BCs / mesh form / solves in this slice.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { activeGeometryId, matchesGeometry, matchesStudy, primaryGeometryId, studyScopedGeometryId } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, liveStudyRows, writeActiveMirror } from './w17-sim-catalog.js';
import { assembleAllMaterials, deleteOneMaterial, persistOneMaterial, readStudyJson, studyFilePath } from './study-io.js';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';
import { pyJson } from './py-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

/** Exact bank labels from walkthrough step 4 / FINDINGS */
export const W18_AIR = {
  name: 'Air',
  type: 'Newtonian',
  viscosity_model: 'Newtonian',
  kinematic_viscosity: 1.529e-5,
  kinematic_viscosity_unit: 'm2/s',
  density: 1.196,
  density_unit: 'kg/m3',
  library: 'DEFAULT',
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

function projectDir(id) {
  return safeProjectPath(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function materialsJsonPath(id, simId) {
  return studyFilePath(id, simId, 'materials');
}

function simulationJsonPath(id) {
  return join(projectDir(id), 'simulation.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeProject(proj) {
  // Phase 1 Step 9: materials stamps go through project_cli set-materials (Python).
  // Keep no-op so callers do not dual-write project.json from Node.
  return proj;
}

const MATERIALS_MAX_BYTES = 256 * 1024;

function stripMaterialNotes(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const next = { ...doc };
  delete next.note;
  if (next.air && typeof next.air === 'object') {
    next.air = { ...next.air };
    delete next.air.note;
  }
  if (Array.isArray(next.materials)) {
    next.materials = next.materials.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const row = { ...m };
      delete row.note;
      return row;
    });
  }
  return next;
}

function airFromProject(id) {
  const proj = readProject(id);
  const sim = getActiveSimulation(id, proj);
  const ref = proj && proj.materials && proj.materials.air;
  const air = {
    id: (ref && ref.id) || `mat-${String(id).slice(-8)}`,
    name: W18_AIR.name,
    type: W18_AIR.type,
    viscosity_model: W18_AIR.viscosity_model,
    kinematic_viscosity: W18_AIR.kinematic_viscosity,
    kinematic_viscosity_unit: W18_AIR.kinematic_viscosity_unit,
    density: W18_AIR.density,
    density_unit: W18_AIR.density_unit,
    library: W18_AIR.library,
    assigned_volumes: (ref && ref.assigned_volumes) || ['Body1'],
    assigned_volume: ((ref && ref.assigned_volumes) || ['Body1'])[0] || 'Body1',
    saved: true,
    checkmark_saved: true,
    persistence: 'filesystem',
    increment: 'W18',
    project_id: id,
    simulation_id: (sim && sim.id) || null,
    geometry_id: (sim && sim.geometry_id) || (proj && proj.active_geometry_id) || null,
  };
  return {
    project_id: id,
    simulation_id: air.simulation_id,
    materials: [air],
    air,
    updated_at: new Date().toISOString(),
    persistence: 'filesystem',
    increment: 'W18',
  };
}

function readMaterialsFile(id, simId) {
  if (!simId) return null;
  const fromStudy = readStudyJson(id, simId, 'materials');
  return fromStudy ? stripMaterialNotes(fromStudy) : null;
}

async function writeMaterialsFile(id, doc, simId, only) {
  const slim = stripMaterialNotes(doc);
  const recs = only
    ? (Array.isArray(only) ? only : [only]).filter(Boolean)
    : (slim && slim.materials) || [];
  for (const rec of recs) {
    if (rec && rec.id) persistOneMaterial(id, simId, rec);
  }
  try {
    await pyJson(
      'project_cli.py',
      ['set-materials', '--project-dir', projectDir(id), '--sim-id', String(simId || '')],
      { ...slim, materials: recs, air: recs[0] || slim.air, only_id: recs[0] && recs[0].id },
    );
  } catch {
    /* folders already written */
  }
  return materialsJsonPath(id, simId);
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

function newMaterialId() {
  return `mat-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function normalizeAssignedVolumes(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function buildAirMaterial(body, existing) {
  const name = String(body.name || body.material || W18_AIR.name).trim();
  if (name !== 'Air') {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'W18 supports Air only in this slice',
        got: name,
        soft_pass: false,
      },
    };
  }
  const assigned = normalizeAssignedVolumes(
    body.assigned_volumes || body.volumes || body.assign || body.body
  );
  if (!assigned.length && !existing) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Assign a body from the viewport before Apply',
        got: assigned,
        soft_pass: false,
      },
    };
  }
  const now = new Date().toISOString();
  const id = (existing && existing.id) || body.id || newMaterialId();
  const material = {
    id,
    name: W18_AIR.name,
    type: W18_AIR.type,
    viscosity_model: W18_AIR.viscosity_model,
    kinematic_viscosity: W18_AIR.kinematic_viscosity,
    kinematic_viscosity_unit: W18_AIR.kinematic_viscosity_unit,
    density: W18_AIR.density,
    density_unit: W18_AIR.density_unit,
    library: W18_AIR.library,
    assigned_volumes: assigned,
    assigned_volume: assigned[0],
    saved: true,
    checkmark_saved: true,
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    persistence: 'filesystem',
    materials_json: null,
    soft_pass_avoided: true,
    increment: 'W18',
  };
  return { ok: true, material };
}

async function upsertMaterials(body) {
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

  const existingDoc = readMaterialsFile(projectId, sim.id);
  const geomId = studyScopedGeometryId(proj, sim, body && body.geometry_id);
  const primaryId = primaryGeometryId(proj);
  const allMats = (existingDoc && Array.isArray(existingDoc.materials) && existingDoc.materials) || [];
  const legacyId = firstLegacySimId(projectId, proj);
  const existingAir =
    allMats.find(
      (m) =>
        m.name === 'Air' &&
        matchesGeometry(m, geomId, primaryId) &&
        matchesStudy(m, sim.id, legacyId)
    ) ||
    null;

  const built = buildAirMaterial(body || {}, existingAir || null);
  if (!built.ok) return built;

  const materialsPath = materialsJsonPath(projectId, sim.id);
  built.material.materials_json = materialsPath;
  built.material.project_id = projectId;
  built.material.simulation_id = sim.id;
  if (geomId) built.material.geometry_id = geomId;

  const mine = allMats.filter((m) => m && matchesStudy(m, sim.id, legacyId));
  const materials = mine.filter((m) => m && m.name !== 'Air').concat([built.material]);

  const doc = {
    project_id: projectId,
    simulation_id: sim.id,
    materials,
    air: built.material,
    updated_at: built.material.updated_at,
    persistence: 'filesystem',
    materials_json: materialsPath,
    soft_pass_avoided: true,
    increment: 'W18',
    out_of_scope: {
      boundary_conditions: false,
      mesh_form: false,
      solves: false,
    },
  };

  await writeMaterialsFile(projectId, doc, sim.id, [built.material]);
  // set_materials already stamps project.json.

  proj.materials = {
    air: {
      id: built.material.id,
      name: 'Air',
      viscosity_model: 'Newtonian',
      assigned_volumes: built.material.assigned_volumes,
      materials_json: materialsPath,
      updated_at: built.material.updated_at,
    },
    materials_json: materialsPath,
      count: materials.length,
  };
  proj.updated_at = built.material.updated_at;
  proj.increment = 'W18';
  writeProject(proj);

  // Also stamp simulation.json with materials ref (without inventing BCs/mesh)
  try {
    const simDoc = { ...sim };
    simDoc.materials = {
      air: {
        id: built.material.id,
        name: 'Air',
        assigned_volumes: built.material.assigned_volumes,
      },
      materials_json: materialsPath,
    };
    simDoc.updated_at = built.material.updated_at;
    simDoc.increment = 'W18';
    writeActiveMirror(projectId, simDoc);
  } catch {
    /* non-fatal */
  }

  return {
    ok: true,
    status: existingAir ? 200 : 201,
    body: {
      ok: true,
      material: built.material,
      materials: materials.filter(
        (m) => matchesGeometry(m, geomId, primaryId) && matchesStudy(m, sim.id, firstLegacySimId(projectId, proj))
      ),
      project_id: projectId,
      simulation_id: sim.id,
      materials_json: materialsPath,
      assigned_volumes: built.material.assigned_volumes,
      soft_pass_avoided: true,
      increment: 'W18',
    },
  };
}

async function deleteMaterials(projectIdOpt, geomIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'no active project', soft_pass: false },
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
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const p = materialsJsonPath(projectId, sim && sim.id);
  const geomId = studyScopedGeometryId(proj, sim, geomIdOpt);
  const primaryId = primaryGeometryId(proj);
  const doc = readMaterialsFile(projectId, sim && sim.id);
  const legacyId = firstLegacySimId(projectId, proj);
  const all = (doc && doc.materials) || [];
  const kept = all.filter(
    (m) => m && !(matchesGeometry(m, geomId, primaryId) && matchesStudy(m, sim && sim.id, legacyId))
  );
  const dropped = all.filter((m) => m && !kept.includes(m));
  for (const m of dropped) {
    if (m && m.id) deleteOneMaterial(projectId, sim && sim.id, m.id);
  }
  if (!kept.length) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch (e) {
        return { ok: false, status: 500, body: { error: String(e) } };
      }
    }
    if (proj.materials) delete proj.materials;
  } else {
    const next = { ...doc, materials: kept, air: kept.find((m) => m.name === 'Air') || kept[0], updated_at: new Date().toISOString() };
    await writeMaterialsFile(projectId, next, sim && sim.id, []);
    proj.materials = {
      air: next.air
        ? {
            id: next.air.id,
            name: next.air.name,
            assigned_volumes: next.air.assigned_volumes,
            materials_json: p,
            updated_at: next.updated_at,
          }
        : null,
      materials_json: p,
      count: kept.length,
    };
  }
  proj.updated_at = new Date().toISOString();
  writeProject(proj);
  try {
    const sim = readSimulationFile(projectId);
    if (sim && sim.materials) {
      delete sim.materials;
      sim.updated_at = proj.updated_at;
      writeActiveMirror(projectId, sim);
    }
  } catch {
    /* non-fatal */
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      deleted: true,
      project_id: projectId,
      materials: [],
      air: null,
      assigned_volumes: [],
    },
  };
}

export function getMaterials(projectIdOpt, geomIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        materials: [],
        air: null,
        note: 'No active project. POST /api/materials after simulation create.',
        increment: 'W18',
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
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const geomId = studyScopedGeometryId(proj, sim, geomIdOpt);
  const primaryId = primaryGeometryId(proj);
  const doc = readMaterialsFile(projectId, sim && sim.id);
  const all = (doc && doc.materials) || [];
  const legacyId = firstLegacySimId(projectId, proj);
  const materials = all.filter(
    (m) => matchesGeometry(m, geomId, primaryId) && matchesStudy(m, sim && sim.id, legacyId)
  );
  const air = materials.find((m) => m.name === 'Air') || null;
  const matPath = materialsJsonPath(projectId, sim && sim.id);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      materials,
      materials_all: assembleAllMaterials(projectId),
      air,
      simulation_id: (sim && sim.id) || null,
      materials_json_path: matPath,
      materials_json_exists: !!(matPath && existsSync(matPath)),
      assigned_volumes: air ? air.assigned_volumes || [] : [],
      body1_assigned: !!(air && (air.assigned_volumes || []).includes('Body1')),
      project_materials_ref: proj.materials || null,
      increment: 'W18',
    },
  };
}

/**
 * Vite middleware for /api/materials*
 * Returns true if handled.
 */
export async function handleW18Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  if (parts[0] === 'api' && parts[1] === 'materials') {
    if (req.method === 'POST' && !parts[2]) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      if (body && (body.delete === true || body.action === 'delete')) {
        const result = await deleteMaterials(body.project_id, body.geometry_id, body.simulation_id);
        res.setHeader('X-CFD-Source', 'materials-delete');
        res.setHeader('X-CFD-Increment', 'W18');
        return sendJson(res, result.status, result.body);
      }
      const result = await upsertMaterials(body);
      res.setHeader('X-CFD-Source', 'materials-upsert');
      res.setHeader('X-CFD-Increment', 'W18');
      if (result.ok && result.body.material) {
        res.setHeader('X-CFD-Material-Id', result.body.material.id);
        res.setHeader('X-CFD-Project-Id', result.body.project_id);
        res.setHeader('X-CFD-Material-Name', 'Air');
        res.setHeader('X-CFD-Assigned-Volume', String((result.body.assigned_volumes || [])[0] || ''));
      }
      return sendJson(res, result.status, result.body);
    }
    if (req.method === 'DELETE' && !parts[2]) {
      const pid = u.searchParams.get('project_id') || undefined;
      const result = await deleteMaterials(
        pid,
        u.searchParams.get('geometry_id') || undefined,
        u.searchParams.get('simulation_id') || undefined
      );
      res.setHeader('X-CFD-Source', 'materials-delete');
      res.setHeader('X-CFD-Increment', 'W18');
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      const pid = u.searchParams.get('project_id') || undefined;
      const result = getMaterials(
        pid,
        u.searchParams.get('geometry_id') || undefined,
        u.searchParams.get('simulation_id') || undefined
      );
      res.setHeader('X-CFD-Source', 'materials-get');
      res.setHeader('X-CFD-Increment', 'W18');
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/materials' });
  }

  return false;
}

export const W18_META = {
  increment: 'W18',
  projects_root: PROJECTS_ROOT,
  air: W18_AIR,
};
