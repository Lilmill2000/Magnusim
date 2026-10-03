import { safeProjectPath } from './safe-path.js';
import { projectIdOrActive } from './request-scope.js';
/**
 * Boundary conditions — filesystem persistence.
 * POST/GET /api/bcs → projects/<id>/boundary_conditions.json
 *
 * Types: the registered BC families (registry kind bc_family). A record's
 * bc_type is its family's record_type; its other fields are the family's
 * (fields schema, seeded from defaults[metric|imperial]) plus any field a
 * plugin saved that the core does not know, which is kept as saved.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  filterByGeometry,
  filterByStudy,
  matchesGeometry,
  matchesStudy,
  primaryGeometryId,
  studyScopedGeometryId,
} from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation, liveStudyRows, readCatalog, writeActiveMirror } from './w17-sim-catalog.js';
import {
  assembleAllBcs,
  deleteOneBc,
  persistBcDefaults,
  persistOneBc,
  readStudyJson,
  studyFilePath,
} from './study-io.js';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';
import { defaultUnits } from './prefs.js';
import { bcFamilyFor, bcRecordTypes, canonicalBcType } from './registry-defaults.js';
import { preferredUnit } from '../src/plugin-ui/units.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

/** Wall treatment: no-slip (U = 0 at the wall) or slip (no shear, zero normal velocity). */
export const WALL_TYPES = ['No-slip', 'Slip'];

function canonicalWallType(raw, fallback) {
  const t = String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (t === 'slip') return 'Slip';
  if (t === 'noslip') return 'No-slip';
  return fallback || 'No-slip';
}

/**
 * Project-wide defaults for faces no boundary condition claims. Today that is
 * one setting: how the leftover walls behave. Stored on the BC document as
 * `defaults: { wall_type }`.
 */
export function normalizeBcDefaults(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return { wall_type: canonicalWallType(d.wall_type, 'No-slip') };
}

function canonicalizeBcRecord(bc) {
  if (!bc) return bc;
  return { ...bc, bc_type: canonicalBcType(bc.bc_type) };
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
  return safeProjectPath(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function bcsJsonPath(id, simId) {
  return studyFilePath(id, simId, 'bcs');
}

function simulationJsonPath(id) {
  return join(projectDir(id), 'simulation.json');
}

function materialsJsonPath(id, simId) {
  return studyFilePath(id, simId, 'materials');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readBcsFile(id, simId) {
  if (!simId) return null;
  return readStudyJson(id, simId, 'bcs');
}

function writeBcsFile(id, doc, opts) {
  const simId = doc && doc.simulation_id;
  if (!simId) throw new Error('simulation_id required to write BCs');
  const only = opts && opts.only;
  const dropIds = (opts && opts.dropIds) || doc._drop_ids || [];
  for (const rid of dropIds) {
    if (rid) deleteOneBc(id, simId, rid);
  }
  const recs = only
    ? (Array.isArray(only) ? only : [only]).filter(Boolean)
    : [];
  for (const rec of recs) {
    if (rec && rec.id) persistOneBc(id, simId, rec);
  }
  persistBcDefaults(id, simId, doc.defaults, doc.defaults_by_simulation);
  return studyBcsDirPath(id, simId);
}

function studyBcsDirPath(id, simId) {
  return studyFilePath(id, simId, 'bcs');
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

function newBcId() {
  return `bc-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
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

function nextName(list, bcType, simId, geomId) {
  let n = 1;
  const names = new Set(
    (list || [])
      .filter((b) => sameSimRec(b, simId) && sameGeomRec(b, geomId))
      .map((b) => b.name)
  );
  while (names.has(`${bcType} ${n}`)) n += 1;
  return `${bcType} ${n}`;
}

function sameGeomRec(rec, geomId) {
  if (!geomId) return true;
  return String((rec && rec.geometry_id) || '') === String(geomId);
}

function sameSimRec(rec, simId) {
  const want = String(simId || '').trim();
  const sid = String((rec && rec.simulation_id) || '').trim();
  if (!want) return !sid;
  if (!sid) return false;
  return sid === want;
}

function dedupeStudyBcs(list) {
  const out = [];
  const seen = new Map();
  for (const b of list || []) {
    if (!b) continue;
    const key = `${String(b.name || '')}|${String(b.geometry_id || '')}`;
    const prev = seen.get(key);
    if (prev == null) {
      seen.set(key, out.length);
      out.push(b);
      continue;
    }
    const cur = out[prev];
    const curN = (cur.faces || []).length;
    const nextN = (b.faces || []).length;
    if (nextN > curN || (nextN === curN && String(b.updated_at || '') >= String(cur.updated_at || ''))) {
      out[prev] = b;
    }
  }
  return out;
}

/**
 * Keys the core owns on a BC record (set by buildBc / persistBcsDoc) or that
 * only travel on a request or a folder read. Every other key of a record is a
 * field of its BC and is kept as saved.
 */
const CORE_BC_KEYS = new Set([
  'id',
  'name',
  'bc_type',
  'type',
  'faces',
  'face',
  'assigned_faces',
  'saved',
  'created_at',
  'updated_at',
  'persistence',
  'geometry_id',
  'simulation_id',
  'project_id',
  'boundary_conditions_json',
  'defaults',
  'defaults_by_simulation',
  'bcs',
  'boundary_conditions',
  'boundary_conditions_all',
  'delete',
  'action',
  'dir',
  'folder',
  'kind',
]);

function bcFieldsOf(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (!CORE_BC_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function copyValue(v) {
  return Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? { ...v } : v;
}

/** The fields schema properties of a BC family ({} when it declares none). */
function familyProps(family) {
  const props = family && family.fields && family.fields.properties;
  return props && typeof props === 'object' ? props : {};
}

/** The keys a family owns: its schema fields and its seed keys. */
function familyKeys(family) {
  const d = (family && family.defaults) || {};
  return new Set([...Object.keys(familyProps(family)), ...Object.keys(d.metric || {}), ...Object.keys(d.imperial || {})]);
}

/** A choice as one of its choices: exact, else ignoring case, spaces, '_' and '-', else the field default. */
function normalizeChoice(prop, v) {
  const choices = prop.enum;
  const s = typeof v === 'string' ? v.trim() : v;
  if (choices.includes(s)) return s;
  const key = (x) => String(x).toLowerCase().replace(/[\s_-]+/g, '');
  const hit = choices.find((c) => key(c) === key(s));
  if (hit !== undefined) return hit;
  return 'default' in prop ? copyValue(prop.default) : choices[0];
}

/** A value made to its schema field's type (fields the schema does not type are left as saved). */
function normalizeField(prop, v) {
  if (!prop || typeof prop !== 'object') return v;
  if (Array.isArray(prop.enum) && prop.enum.length) return normalizeChoice(prop, v);
  if (prop.type === 'number' || prop.type === 'integer') return Number(v);
  if (prop.type === 'string') return String(v).trim();
  if (prop.type === 'boolean') return v === true || v === 'true';
  if (prop.type === 'array') {
    if (!Array.isArray(v)) return copyValue(prop.default);
    const numeric = prop.items && (prop.items.type === 'number' || prop.items.type === 'integer');
    const n = Number.isInteger(prop.minItems) && prop.minItems === prop.maxItems ? prop.minItems : v.length;
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(numeric ? Number(v[i]) || 0 : v[i]);
    return out;
  }
  return v;
}

/** True when every key of a family values row's `when` has that value on the record. */
function valuesRowMatches(row, rec) {
  const when = (row && row.when) || {};
  return Object.entries(when).every(([k, want]) => rec[k] === want);
}

/**
 * The unit a BC value field starts in: the project's unit system's unit for
 * the quantity of the family values row the record matches (a volumetric flow
 * in ft³/min on an Imperial project), else the family's seed.
 */
function seedUnit(family, rec, unitField, imperial, seed) {
  for (const row of Array.isArray(family.values) ? family.values : []) {
    if (!row || row.unit_field !== unitField || !valuesRowMatches(row, rec)) continue;
    const unit = row.quantity ? preferredUnit(row.quantity, imperial) : '';
    if (unit) return unit;
    break;
  }
  if (!isBlank(seed[unitField])) return seed[unitField];
  const prop = familyProps(family)[unitField];
  return prop && 'default' in prop ? prop.default : undefined;
}

/**
 * A BC's fields, from its family (registry bc_family row): every field the
 * record carries (the saved record's, then the body's) is kept; a new BC
 * starts from the family's seed for the project's unit system
 * (defaults[metric|imperial]); a field a saved record lacks reads as its
 * schema default; schema fields are normalized to their type (a choice not
 * among its choices becomes the field default).
 */
function familyFields(family, existing, body, units) {
  const imperial = /imperial/i.test(String(units || defaultUnits()));
  const d = (family && family.defaults) || {};
  const seed = (imperial ? d.imperial || d.metric : d.metric || d.imperial) || {};
  const props = familyProps(family);
  const carried = bcFieldsOf(existing);
  const prevFamily = existing ? bcFamilyFor(existing.bc_type) : null;
  if (prevFamily && family && prevFamily.key !== family.key) {
    // A BC whose type changed drops the fields of its old family the new one lacks.
    const mine = familyKeys(family);
    for (const k of familyKeys(prevFamily)) if (!mine.has(k)) delete carried[k];
  }
  const out = { ...carried, ...bcFieldsOf(body) };
  const unitFields = new Set(
    (Array.isArray(family && family.values) ? family.values : []).map((r) => r && r.unit_field).filter(Boolean)
  );
  for (const [k, v] of Object.entries(seed)) {
    if (unitFields.has(k) || !isBlank(out[k])) continue;
    if (existing && k in props) continue;
    out[k] = copyValue(v);
  }
  for (const [k, prop] of Object.entries(props)) {
    if (unitFields.has(k) || !isBlank(out[k])) continue;
    if (prop && typeof prop === 'object' && 'default' in prop) out[k] = copyValue(prop.default);
  }
  for (const [k, prop] of Object.entries(props)) {
    if (!unitFields.has(k) && k in out) out[k] = normalizeField(prop, out[k]);
  }
  for (const k of unitFields) {
    if (isBlank(out[k])) {
      const unit = seedUnit(family, out, k, imperial, seed);
      if (unit !== undefined) out[k] = unit;
    } else {
      out[k] = String(out[k]).trim();
    }
  }
  return out;
}

function buildBc(body, list, units) {
  const geomId = body.geometry_id || null;
  const simId = body.simulation_id || null;
  const existing =
    (list || []).find((b) => {
      if (body.id && b.id === body.id) {
        const tagged = String((b && b.simulation_id) || '').trim();
        if (!simId || !tagged || tagged === String(simId)) return true;
        return false;
      }
      if (body.name && b.name === body.name && sameGeomRec(b, geomId) && sameSimRec(b, simId)) return true;
      return false;
    }) || null;
  const bcType = canonicalBcType(body.bc_type || body.type || (existing && existing.bc_type) || '');
  const family = bcFamilyFor(bcType);
  if (!family) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Unsupported boundary condition type', got: bcType, allowed: bcRecordTypes() },
    };
  }
  const name = String(body.name || (existing && existing.name) || nextName(list, bcType, simId, geomId)).trim();
  const faces = Object.prototype.hasOwnProperty.call(body || {}, 'faces') ||
    Object.prototype.hasOwnProperty.call(body || {}, 'face')
    ? normalizeFaces(body.faces || body.face || body.assigned_faces)
    : normalizeFaces((existing && existing.faces) || []);
  const now = new Date().toISOString();
  const rec = {
    id: (existing && existing.id) || body.id || newBcId(),
    name,
    bc_type: bcType,
    faces,
    face: faces[0] || null,
    saved: true,
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    persistence: 'filesystem',
    geometry_id: body.geometry_id || (existing && existing.geometry_id) || null,
    simulation_id: simId || (existing && existing.simulation_id) || null,
    ...familyFields(family, existing, body, units),
  };
  return { ok: true, bc: rec };
}

function mergeBcIntoList(list, bc) {
  const next = Array.isArray(list) ? list.slice() : [];
  const idx = next.findIndex((b) => {
    if (bc.id && b.id === bc.id) {
      const tagged = String((b && b.simulation_id) || '').trim();
      const want = String((bc && bc.simulation_id) || '').trim();
      if (!want || !tagged || tagged === want) return true;
      return false;
    }
    return !!(
      bc.name &&
      b.name === bc.name &&
      sameGeomRec(b, bc.geometry_id) &&
      sameSimRec(b, bc.simulation_id)
    );
  });
  if (idx >= 0) next[idx] = bc;
  else next.push(bc);
  next.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return next;
}

async function persistBcsDoc(projectId, sim, bcsList, defaults, dropIds, only) {
  const materialsOk = existsSync(materialsJsonPath(projectId, sim.id));
  const bcsPath = bcsJsonPath(projectId, sim.id);
  const now = new Date().toISOString();
  const proj = readProject(projectId);
  const legacyId = firstLegacySimId(projectId, proj);
  const mine = dedupeStudyBcs(
    (bcsList || []).filter((b) => matchesStudy(b, sim.id, legacyId))
  );
  const prev = readBcsFile(projectId, sim.id);
  const prevBySim = (prev && prev.defaults_by_simulation) || {};
  const defs = normalizeBcDefaults(
    defaults !== undefined ? defaults : (prevBySim[sim.id] || (prev && prev.defaults))
  );
  const live = new Set(
    ((readCatalog(projectId) || {}).simulations || []).map((s) => s && String(s.id || '').trim()).filter(Boolean)
  );
  const defaults_by_simulation = {};
  for (const [k, v] of Object.entries(prevBySim)) {
    if (live.has(String(k))) defaults_by_simulation[k] = v;
  }
  defaults_by_simulation[sim.id] = defs;

  for (const bc of mine) {
    bc.boundary_conditions_json = bcsPath;
    bc.project_id = projectId;
    bc.simulation_id = sim.id;
  }

  const doc = {
    project_id: projectId,
    simulation_id: sim.id,
    boundary_conditions: mine,
    defaults: defs,
    defaults_by_simulation,
    updated_at: now,
    persistence: 'filesystem',
    boundary_conditions_json: bcsPath,
    materials_prerequisite: materialsOk,
    increment: 'W19',
  };
  if (dropIds && dropIds.length) doc._drop_ids = dropIds;

  await writeBcsFile(projectId, doc, { only, dropIds });
  const written = readBcsFile(projectId, sim.id) || doc;

  try {
    const simDoc = { ...sim };
    simDoc.boundary_conditions = {
      names: mine.map((b) => b.name),
      boundary_conditions_json: bcsPath,
    };
    simDoc.updated_at = now;
    writeActiveMirror(projectId, simDoc);
  } catch {
    /* non-fatal */
  }

  return { doc: written, bcsPath };
}

async function deleteBcs(body) {
  const projectId = (body && body.project_id) || projectIdOrActive('', readActiveId);
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  const proj = readProject(projectId);
  const sim = getActiveSimulation(projectId, proj, body && body.simulation_id);
  if (!proj || !sim) {
    return { ok: false, status: 404, body: { error: 'project or simulation missing' } };
  }
  const existingDoc = readBcsFile(projectId, sim.id);
  let list =
    (existingDoc && Array.isArray(existingDoc.boundary_conditions) && existingDoc.boundary_conditions.slice()) ||
    [];
  const geomId = studyScopedGeometryId(proj, sim, body && body.geometry_id);
  const primaryId = primaryGeometryId(proj);
  const which = String(body.delete || body.id || body.name || '').trim();
  const legacyId = firstLegacySimId(projectId, proj);
  const before = list.slice();
  if (which === 'all' || which === 'true') {
    list = list.filter(
      (b) => !(matchesGeometry(b, geomId, primaryId) && matchesStudy(b, sim.id, legacyId))
    );
  } else {
    list = list.filter((b) => {
      if (!matchesStudy(b, sim.id, legacyId)) return true;
      if (b.id === which) return false;
      if (b.name === which) return false;
      return true;
    });
  }
  const dropIds = before.filter((b) => b && !list.includes(b)).map((b) => b.id).filter(Boolean);
  const { doc, bcsPath } = await persistBcsDoc(projectId, sim, list, undefined, dropIds, []);
  const visible = filterByStudy(
    filterByGeometry(doc.boundary_conditions, geomId, primaryId),
    sim.id,
    legacyId
  );
  const studyDefaults =
    (doc.defaults_by_simulation && doc.defaults_by_simulation[sim.id]) || normalizeBcDefaults(null);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      deleted: true,
      boundary_conditions: visible,
      boundary_conditions_all: liveStudyRows(projectId, proj, doc.boundary_conditions || []),
      defaults: studyDefaults,
      defaults_by_simulation: doc.defaults_by_simulation || {},
      simulation_id: sim.id,
      project_id: projectId,
      boundary_conditions_json: bcsPath,
    },
  };
}

async function upsertBcs(body) {
  const projectId = (body && body.project_id) || projectIdOrActive('', readActiveId);
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'no active project; create project first' },
    };
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

  const existingDoc = readBcsFile(projectId, sim.id);
  let list =
    (existingDoc && Array.isArray(existingDoc.boundary_conditions) && existingDoc.boundary_conditions.slice()) ||
    [];
  const geomId = studyScopedGeometryId(proj, sim, body && body.geometry_id);
  if (geomId && body) body.geometry_id = geomId;

  const batch = (body && (body.bcs || body.boundary_conditions)) || null;
  const hasDefaults = !!(body && body.defaults && typeof body.defaults === 'object');
  const hasBcFields = !!(body && (body.bc_type || body.type || body.id || body.name));
  let lastBuilt = null;
  const changed = [];
  if (Array.isArray(batch) && batch.length) {
    for (const item of batch) {
      const built = buildBc(item, list, proj && proj.units);
      if (!built.ok) return built;
      lastBuilt = built.bc;
      if (geomId) lastBuilt.geometry_id = lastBuilt.geometry_id || geomId;
      lastBuilt.simulation_id = sim.id;
      list = mergeBcIntoList(list, lastBuilt);
      changed.push(lastBuilt);
    }
  } else if (hasDefaults && !hasBcFields) {
    // Defaults-only save: { defaults: { wall_type } } — no BC record touched.
  } else {
    const built = buildBc(body || {}, list, proj && proj.units);
    if (!built.ok) return built;
    lastBuilt = built.bc;
    if (geomId) lastBuilt.geometry_id = lastBuilt.geometry_id || geomId;
    lastBuilt.simulation_id = sim.id;
    list = mergeBcIntoList(list, lastBuilt);
    changed.push(lastBuilt);
  }

  const nextDefaults = hasDefaults
    ? normalizeBcDefaults({ ...((existingDoc && existingDoc.defaults) || {}), ...body.defaults })
    : undefined;
  const { doc, bcsPath } = await persistBcsDoc(projectId, sim, list, nextDefaults, undefined, changed);
  const visible = filterByStudy(
    filterByGeometry(doc.boundary_conditions, geomId, primaryGeometryId(proj)),
    sim.id,
    firstLegacySimId(projectId, proj)
  );
  const studyDefaults =
    (doc.defaults_by_simulation && doc.defaults_by_simulation[sim.id]) || normalizeBcDefaults(null);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      bc: lastBuilt || visible.find((b) => b.name === (body && body.name)) || null,
      boundary_conditions: visible,
      boundary_conditions_all: liveStudyRows(projectId, proj, doc.boundary_conditions || []),
      defaults: studyDefaults,
      defaults_by_simulation: doc.defaults_by_simulation || {},
      project_id: projectId,
      simulation_id: sim.id,
      boundary_conditions_json: bcsPath,
    },
  };
}

export function getBcs(projectIdOpt, geomIdOpt, simIdOpt) {
  const projectId = projectIdOpt || projectIdOrActive('', readActiveId);
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        boundary_conditions: [],
        defaults: normalizeBcDefaults(null),
        increment: 'W19',
      },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found', project_id: projectId } };
  }
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const doc = readBcsFile(projectId, sim && sim.id);
  const all = ((doc && doc.boundary_conditions) || []).map(canonicalizeBcRecord);
  const geomId = studyScopedGeometryId(proj, sim, geomIdOpt);
  const list = dedupeStudyBcs(
    filterByStudy(
      filterByGeometry(all, geomId, primaryGeometryId(proj)),
      sim && sim.id,
      firstLegacySimId(projectId, proj)
    )
  );
  const studyDefaults =
    (sim && doc && doc.defaults_by_simulation && doc.defaults_by_simulation[sim.id]) ||
    (list.length ? normalizeBcDefaults(doc && doc.defaults) : normalizeBcDefaults(null));
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      boundary_conditions: list,
      boundary_conditions_all: assembleAllBcs(projectId),
      simulation_id: (sim && sim.id) || null,
      defaults: studyDefaults,
      defaults_by_simulation: (doc && doc.defaults_by_simulation) || {},
      boundary_conditions_json_path: bcsJsonPath(projectId, sim && sim.id),
      boundary_conditions_json_exists: existsSync(bcsJsonPath(projectId, sim && sim.id)),
      increment: 'W19',
    },
  };
}

export async function handleW19Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  if (parts[0] === 'api' && parts[1] === 'bcs') {
    if (req.method === 'POST' && !parts[2]) {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
      }
      if (body && (body.delete === true || body.action === 'delete' || body.delete)) {
        const result = await deleteBcs(body);
        res.setHeader('X-CFD-Source', 'bcs-delete');
        return sendJson(res, result.status, result.body);
      }
      const result = await upsertBcs(body);
      res.setHeader('X-CFD-Source', 'bcs-upsert');
      return sendJson(res, result.status, result.body);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
      const pid = u.searchParams.get('project_id') || undefined;
      const result = getBcs(
        pid,
        u.searchParams.get('geometry_id') || undefined,
        u.searchParams.get('simulation_id') || undefined
      );
      res.setHeader('X-CFD-Source', 'bcs-get');
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 405, { error: 'method not allowed for /api/bcs' });
  }

  return false;
}

export const W19_META = {
  increment: 'W19',
  projects_root: PROJECTS_ROOT,
  /** The registered BC record types (live registry). */
  get types() {
    return bcRecordTypes();
  },
};
