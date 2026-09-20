import { safeProjectPath } from './safe-path.js';
/**
 * Mesh refinements — filesystem persistence.
 * GET/POST /api/mesh/refinements → projects/<id>/mesh_refinements.json
 *
 * Types:
 *   Surface custom sizing — max (and optional min) edge length on selected faces
 *   Inflate boundary layer — prism layers on selected faces
 *
 * Volume custom sizing and extrusion need geometry primitives / sweepable
 * bodies; those stay out until we add primitives.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesStudy } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, writeActiveMirror } from './w17-sim-catalog.js';
import { envGet } from './env-compat.js';
import { pyJson, writeProjectCli } from './py-json.js';
import {
  assembleMeshDoc,
  assembleRefinements,
  deleteOneRefinement,
  meshFolderOf,
  persistOneRefinement,
  writeMeshRefinements,
} from './study-io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

export const REF_TYPES = ['Surface custom sizing', 'Inflate boundary layer'];

const TYPE_ALIASES = {
  surface: 'Surface custom sizing',
  surface_custom_sizing: 'Surface custom sizing',
  'surface custom sizing': 'Surface custom sizing',
  inflate: 'Inflate boundary layer',
  inflate_boundary_layer: 'Inflate boundary layer',
  'inflate boundary layer': 'Inflate boundary layer',
};

const SIZE_UNITS = ['mm', 'm', 'in'];

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

function refinementsJsonPath(id) {
  return join(projectDir(id), 'mesh_refinements.json');
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
  // Phase 1 Step 9/land9: shared writeProjectCli helper.
  return writeProjectCli(projectDir(proj.id), proj, String((proj.simulation && proj.simulation.id) || proj.active_simulation_id || ''));
}

function readRefinementsFile(id, simId, meshId) {
  if (!id || !simId) return null;
  return assembleRefinements(id, simId, meshId);
}

async function writeRefinementsFile(id, doc) {
  const simId = doc && doc.simulation_id;
  const meshId = doc && doc.mesh_id;
  if (simId && meshId) {
    return writeMeshRefinements(id, meshId, simId, doc);
  }
  await pyJson(
    'project_cli.py',
    ['set-refinements', '--project-dir', projectDir(id), '--sim-id', String(simId || '')],
    doc,
  );
  return refinementsJsonPath(id);
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

function newRefId() {
  return `ref-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function normalizeFace(raw) {
  if (!raw) return '';
  let s = String(raw).trim().replace(/\s+/g, ' ');
  const m = s.match(/^face\s*(\d+)\s*@\s*Body(\d+)$/i);
  if (m) return `face ${m[1]}@Body${m[2]}`;
  return s;
}

function normalizeFaces(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(normalizeFace).filter(Boolean);
}

/** Empty faces on a sizing/fineness save must not wipe an assigned face. */
export function resolveRefinementFaces(body, existing) {
  const incoming = normalizeFaces(
    body && (body.faces || body.face || body.assigned_faces)
  );
  const kept = normalizeFaces((existing && existing.faces) || (existing && existing.face) || []);
  if (body && body.faces_explicit) return incoming;
  return incoming.length ? incoming : kept;
}

function canonicalType(raw) {
  const t = String(raw || '').trim();
  if (REF_TYPES.includes(t)) return t;
  const alias = TYPE_ALIASES[t.toLowerCase()];
  return alias || t;
}

function nextName(list, type, meshId) {
  let n = 1;
  const names = new Set(
    (list || [])
      .filter((r) => !meshId || !r.mesh_id || String(r.mesh_id) === String(meshId))
      .map((r) => r.name)
  );
  while (names.has(`${type} ${n}`)) n += 1;
  return `${type} ${n}`;
}

function meshJsonPath(id) {
  return join(projectDir(id), 'mesh.json');
}

function fallbackMeshId(projectId, simId) {
  const doc = assembleMeshDoc(projectId, simId);
  return (doc && doc.active_id) || null;
}

function assignMissingMeshIds(projectId, list, simId) {
  const fallback = fallbackMeshId(projectId, simId);
  if (!fallback) return { list, changed: false };
  const proj = readProject(projectId);
  const legacy = firstLegacySimId(projectId, proj);
  let changed = false;
  const next = (list || []).map((r) => {
    if (!r || r.mesh_id) return r;
    if (!matchesStudy(r, simId, legacy)) return r;
    changed = true;
    return { ...r, mesh_id: fallback };
  });
  return { list: next, changed };
}

function asNumber(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asUnit(v, fallback) {
  const u = String(v || '').trim();
  return SIZE_UNITS.includes(u) ? u : fallback;
}

function isSurface(type) {
  return type === 'Surface custom sizing';
}

function buildRefinement(body, list) {
  const existing =
    (list || []).find((r) => {
      if (body.id && r.id === body.id) return true;
      if (body.id) return false;
      if (!body.name || r.name !== body.name) return false;
      const wantMesh = String(body.mesh_id || body.meshId || '');
      if (wantMesh) return String(r.mesh_id || '') === wantMesh;
      return true;
    }) || null;
  const type = canonicalType(
    body.type || body.ref_type || body.kind || (existing && existing.type) || ''
  );
  if (!REF_TYPES.includes(type)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Unsupported refinement type', got: type, allowed: REF_TYPES },
    };
  }
  const meshId = String(
    body.mesh_id || body.meshId || (existing && existing.mesh_id) || ''
  ).trim() || null;
  const name = String(body.name || (existing && existing.name) || nextName(list, type, meshId)).trim();
  const faces = resolveRefinementFaces(body, existing);
  const now = new Date().toISOString();
  const rec = {
    id: (existing && existing.id) || body.id || newRefId(),
    name,
    type,
    mesh_id: meshId || (existing && existing.mesh_id) || null,
    faces,
    face: faces[0] || null,
    saved: true,
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    persistence: 'filesystem',
  };

  if (isSurface(type)) {
    const sizingRaw = String(
      body.sizing || (existing && existing.sizing) || 'Custom'
    ).trim();
    rec.sizing = sizingRaw === 'Automatic' ? 'Automatic' : 'Custom';
    rec.fineness = asNumber(
      body.fineness !== undefined ? body.fineness : existing && existing.fineness,
      7
    );
    rec.default_size = asNumber(
      body.default_size !== undefined ? body.default_size : existing && existing.default_size,
      2
    );
    rec.default_size_unit = asUnit(
      body.default_size_unit || (existing && existing.default_size_unit),
      'mm'
    );
    rec.min_size = asNumber(
      body.min_size !== undefined ? body.min_size : existing && existing.min_size,
      0
    );
    rec.min_size_unit = asUnit(
      body.min_size_unit || (existing && existing.min_size_unit),
      rec.default_size_unit
    );
  } else {
    rec.n_layers = Math.max(
      1,
      Math.round(
        asNumber(body.n_layers !== undefined ? body.n_layers : existing && existing.n_layers, 3)
      )
    );
    rec.total_thickness = asNumber(
      body.total_thickness !== undefined ? body.total_thickness : existing && existing.total_thickness,
      1
    );
    rec.total_thickness_unit = asUnit(
      body.total_thickness_unit || (existing && existing.total_thickness_unit),
      'mm'
    );
    rec.gradation = 'total';
  }

  return { ok: true, refinement: rec };
}

function mergeIntoList(list, rec) {
  const next = Array.isArray(list) ? list.slice() : [];
  const idx = next.findIndex((r) => {
    if (rec.id && r.id === rec.id) return true;
    if (rec.id) return false;
    return (
      r.name === rec.name &&
      String(r.mesh_id || '') === String(rec.mesh_id || '')
    );
  });
  if (idx >= 0) next[idx] = rec;
  else next.push(rec);
  next.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return next;
}

function visibleRefs(projectId, proj, sim, refinements) {
  return (refinements || []).filter((r) =>
    matchesStudy(r, sim && sim.id, firstLegacySimId(projectId, proj))
  );
}

async function persistDoc(projectId, sim, refinements, opts) {
  const now = new Date().toISOString();
  const only = opts && opts.only;
  const drop = opts && opts.drop;
  for (const rec of drop || []) {
    if (rec && rec.id) deleteOneRefinement(projectId, rec.mesh_id, sim.id, rec.id);
  }
  let path = null;
  const toWrite = only || [];
  for (const rec of toWrite) {
    if (!rec || !rec.id || !rec.mesh_id) continue;
    rec.project_id = projectId;
    rec.simulation_id = sim.id;
    persistOneRefinement(projectId, rec.mesh_id, sim.id, rec);
    path = rec.mesh_id;
  }
  const assembled = assembleRefinements(projectId, sim.id);
  const doc = {
    project_id: projectId,
    simulation_id: sim.id,
    refinements: assembled.refinements || refinements || [],
    updated_at: now,
    persistence: 'filesystem',
    mesh_refinements_json: path,
    increment: 'W26',
  };

  try {
    const simDoc = { ...sim };
    simDoc.mesh_refinements = {
      names: refinements.map((r) => r.name),
      mesh_refinements_json: path,
    };
    simDoc.updated_at = now;
    writeActiveMirror(projectId, simDoc);
  } catch {
    /* non-fatal */
  }

  return { doc, path };
}

function requireProject(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project; create project first' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const sim = getActiveSimulation(projectId, proj, body && body.simulation_id);
  if (!sim) {
    return {
      ok: false,
      status: 400,
      body: { error: 'no simulation; Create Simulation first' },
    };
  }
  return { ok: true, projectId, proj, sim };
}

function currentList(projectId, simId) {
  const existingDoc = readRefinementsFile(projectId, simId);
  const raw =
    (existingDoc && Array.isArray(existingDoc.refinements) && existingDoc.refinements.slice()) ||
    [];
  return assignMissingMeshIds(projectId, raw, simId).list;
}

function readMeshEntry(projectId, meshId) {
  return meshFolderOf(projectId, meshId);
}

function cloneRefinement(rec, meshId, dest) {
  const now = new Date().toISOString();
  const out = {
    ...rec,
    id: newRefId(),
    mesh_id: meshId,
    faces: [],
    face: null,
    created_at: now,
    updated_at: now,
  };
  if (dest && dest.simulation_id) out.simulation_id = dest.simulation_id;
  if (dest && dest.geometry_id) out.geometry_id = dest.geometry_id;
  return out;
}

async function copyRefinementsToMesh(body) {
  const gate = requireProject(body);
  if (!gate.ok) return gate;
  const { projectId, sim } = gate;
  const destId = String(body.mesh_id || body.dest_mesh_id || '').trim();
  const srcId = String(body.copy_from_mesh || body.copy_from || '').trim();
  if (!destId || !srcId) {
    return { ok: false, status: 400, body: { error: 'copy_from_mesh and mesh_id required' } };
  }
  if (srcId === destId) {
    const list = currentList(projectId, sim.id);
    const { doc, path } = await persistDoc(projectId, sim, list);
    return {
      ok: true,
      status: 200,
      body: { ok: true, copied: false, refinements: visibleRefs(projectId, gate.proj, sim, doc.refinements), mesh_refinements_json: path },
    };
  }
  const destMesh = readMeshEntry(projectId, destId);
  const destMeta = {
    simulation_id: (destMesh && destMesh.simulation_id) || sim.id,
    geometry_id: (destMesh && destMesh.geometry_id) || sim.geometry_id || null,
  };
  const list = currentList(projectId, sim.id);
  const src = list.filter((r) => r && String(r.mesh_id) === srcId);
  const destOld = list.filter((r) => r && String(r.mesh_id) === destId);
  const clones = src.map((r) => cloneRefinement(r, destId, destMeta));
  const { doc, path } = await persistDoc(projectId, sim, list.filter((r) => r && String(r.mesh_id) !== destId).concat(clones), {
    only: clones,
    drop: destOld,
  });
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      copied: true,
      copy_from_mesh: srcId,
      mesh_id: destId,
      refinements: visibleRefs(projectId, gate.proj, sim, doc.refinements),
      project_id: projectId,
      mesh_refinements_json: path,
    },
  };
}

async function deleteRefinements(body) {
  const gate = requireProject(body);
  if (!gate.ok) return gate;
  const { projectId, sim } = gate;
  const before = currentList(projectId, sim.id);
  let list = before.slice();
  const which = String(body.delete || body.id || body.name || '').trim();
  if (which === 'all' || which === 'true') {
    const meshId = String((body && (body.mesh_id || body.meshId)) || '').trim();
    const legacyId = firstLegacySimId(projectId, gate.proj);
    list = list.filter((r) => {
      if (!r) return false;
      if (meshId) return String(r.mesh_id || '') !== meshId;
      return !matchesStudy(r, sim.id, legacyId);
    });
  } else list = list.filter((r) => r.id !== which && r.name !== which);
  const drop = before.filter((r) => r && !list.some((x) => x && x.id === r.id));
  const { doc, path } = await persistDoc(projectId, sim, list, { drop });
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      deleted: true,
      refinements: visibleRefs(projectId, gate.proj, sim, doc.refinements),
      project_id: projectId,
      mesh_refinements_json: path,
    },
  };
}

async function upsertRefinements(body) {
  if (body && (body.copy_from_mesh || (body.copy_from && body.mesh_id && !body.type))) {
    return copyRefinementsToMesh(body);
  }
  const gate = requireProject(body);
  if (!gate.ok) return gate;
  const { projectId, sim } = gate;
  let list = currentList(projectId, sim.id);
  const batch = (body && (body.refinements || body.items)) || null;
  let last = null;
  const changed = [];
  if (Array.isArray(batch) && batch.length) {
    for (const item of batch) {
      const built = buildRefinement(item, list);
      if (!built.ok) return built;
      last = built.refinement;
      last.simulation_id = sim.id;
      list = mergeIntoList(list, built.refinement);
      changed.push(last);
    }
  } else {
    const built = buildRefinement(body || {}, list);
    if (!built.ok) return built;
    last = built.refinement;
    last.simulation_id = sim.id;
    list = mergeIntoList(list, built.refinement);
    changed.push(last);
  }
  const { doc, path } = await persistDoc(projectId, sim, list, { only: changed });
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      refinement: last || visibleRefs(projectId, gate.proj, sim, list).slice(-1)[0] || null,
      refinements: visibleRefs(projectId, gate.proj, sim, doc.refinements),
      project_id: projectId,
      simulation_id: sim.id,
      mesh_refinements_json: path,
    },
  };
}

export function getRefinements(projectIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, active: false, refinements: [], increment: 'W26' },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const doc = readRefinementsFile(projectId, sim && sim.id);
  const list = ((doc && doc.refinements) || []).filter((r) =>
    matchesStudy(r, sim && sim.id, firstLegacySimId(projectId, proj))
  );
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      refinements: list,
      mesh_refinements_json_path: refinementsJsonPath(projectId),
      mesh_refinements_json_exists: existsSync(refinementsJsonPath(projectId)),
      increment: 'W26',
    },
  };
}

export async function handleW26Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;
  const isRefs =
    parts[0] === 'api' &&
    ((parts[1] === 'mesh' && parts[2] === 'refinements') || parts[1] === 'mesh-refinements');
  if (!isRefs) return false;

  if (req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
    }
    if (body && (body.delete === true || body.action === 'delete' || body.delete)) {
      const result = await deleteRefinements(body);
      res.setHeader('X-CFD-Source', 'refinements-delete');
      return sendJson(res, result.status, result.body);
    }
    const result = await upsertRefinements(body);
    res.setHeader('X-CFD-Source', 'refinements-upsert');
    return sendJson(res, result.status, result.body);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const pid = u.searchParams.get('project_id') || undefined;
    const result = getRefinements(pid, u.searchParams.get('simulation_id') || undefined);
    res.setHeader('X-CFD-Source', 'refinements-get');
    return sendJson(res, result.status, result.body);
  }
  return sendJson(res, 405, { error: 'method not allowed for /api/mesh/refinements' });
}

export const W26_META = {
  increment: 'W26',
  projects_root: PROJECTS_ROOT,
  types: REF_TYPES,
};
