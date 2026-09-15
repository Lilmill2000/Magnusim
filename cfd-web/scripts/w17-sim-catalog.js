/**
 * Multi-study catalog: projects/<id>/simulations.json
 * Active study is also mirrored to simulation.json for older readers.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeGeometryId, geometriesOf } from './w16-geometry-scope.js';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');

export function projectDir(id) {
  return join(PROJECTS_ROOT, id);
}

export function simulationsJsonPath(id) {
  return join(projectDir(id), 'simulations.json');
}

export function simulationJsonPath(id) {
  return join(projectDir(id), 'simulation.json');
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
  return p;
}

export function studyBaseName(sim) {
  const time = /transient/i.test(String((sim && sim.time_dependency) || ''))
    ? 'Transient'
    : 'Steady-state';
  return 'Incompressible ' + time;
}

export function assignStudyNames(list) {
  const out = (list || []).map((s) => ({ ...s }));
  const groups = new Map();
  for (const s of out) {
    const key = String(s.geometry_id || '') + '|' + studyBaseName(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const siblings of groups.values()) {
    siblings.forEach((s, i) => {
      const base = studyBaseName(s);
      s.name = siblings.length > 1 ? base + ' ' + (i + 1) : base;
    });
  }
  return out;
}

function stampMissing(projectId, simId, geomId) {
  if (!simId) return;
  const files = [
    join(projectDir(projectId), 'materials.json'),
    join(projectDir(projectId), 'boundary_conditions.json'),
    join(projectDir(projectId), 'mesh.json'),
    join(projectDir(projectId), 'mesh_refinements.json'),
    join(projectDir(projectId), 'runs', 'catalog.json'),
  ];
  const geom = String(geomId || '').trim();
  const stampList = (arr) => {
    let n = 0;
    const rows = arr || [];
    if (rows.some((rec) => rec && rec.simulation_id)) return 0;
    for (const rec of rows) {
      if (!rec || rec.simulation_id) continue;
      const gid = rec.geometry_id != null ? String(rec.geometry_id).trim() : '';
      if (gid && geom && gid !== geom) continue;
      rec.simulation_id = simId;
      n += 1;
    }
    return n;
  };
  for (const p of files) {
    const doc = readJson(p);
    if (!doc) continue;
    let changed = 0;
    if (Array.isArray(doc.materials)) changed += stampList(doc.materials);
    if (doc.air && !doc.air.simulation_id && !(doc.materials || []).some((m) => m && m.simulation_id)) {
      const gid = doc.air.geometry_id != null ? String(doc.air.geometry_id).trim() : '';
      if (!gid || !geom || gid === geom) {
        doc.air.simulation_id = simId;
        changed += 1;
      }
    }
    if (Array.isArray(doc.boundary_conditions)) changed += stampList(doc.boundary_conditions);
    if (Array.isArray(doc.meshes)) changed += stampList(doc.meshes);
    if (Array.isArray(doc.refinements)) changed += stampList(doc.refinements);
    if (Array.isArray(doc.runs)) changed += stampList(doc.runs);
    if (!doc.simulation_id) {
      doc.simulation_id = simId;
      changed += 1;
    }
    if (changed) writeJson(p, doc);
  }
}

export function writeActiveMirror(projectId, sim) {
  if (!sim) return null;
  const path = simulationJsonPath(projectId);
  writeJson(path, { ...sim, simulation_json: path });
  return path;
}

export function saveCatalog(projectId, catalog) {
  const simulations = assignStudyNames(catalog.simulations || []);
  const active_id =
    catalog.active_id && simulations.some((s) => s.id === catalog.active_id)
      ? catalog.active_id
      : simulations[0]
        ? simulations[0].id
        : null;
  const doc = {
    active_id,
    simulations,
    updated_at: new Date().toISOString(),
  };
  writeJson(simulationsJsonPath(projectId), doc);
  const active = simulations.find((s) => s.id === active_id) || null;
  if (active) writeActiveMirror(projectId, active);
  else {
    try {
      const p = simulationJsonPath(projectId);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* leftover mirror is non-fatal */
    }
  }
  return doc;
}

export function pruneOrphanStudies(projectId, proj) {
  const existing = readJson(simulationsJsonPath(projectId));
  if (!existing || !Array.isArray(existing.simulations)) {
    return { catalog: existing || { active_id: null, simulations: [] }, dropped: [] };
  }
  if (!proj || !Array.isArray(proj.geometries)) {
    return { catalog: existing, dropped: [] };
  }
  const live = new Set(
    geometriesOf(proj)
      .map((g) => String((g && g.id) || '').trim())
      .filter(Boolean)
  );
  const kept = [];
  const dropped = [];
  for (const s of existing.simulations) {
    if (s && s.geometry_id && live.has(String(s.geometry_id))) kept.push(s);
    else if (s) dropped.push(s);
  }
  if (!dropped.length) {
    return { catalog: saveCatalog(projectId, existing), dropped: [] };
  }
  return {
    catalog: saveCatalog(projectId, { ...existing, simulations: kept }),
    dropped,
  };
}

export function ensureCatalog(projectId, proj) {
  const existing = readJson(simulationsJsonPath(projectId));
  if (existing && Array.isArray(existing.simulations)) {
    return pruneOrphanStudies(projectId, proj).catalog;
  }
  const legacy = readJson(simulationJsonPath(projectId));
  if (!legacy || !legacy.id) {
    return { active_id: null, simulations: [], updated_at: new Date().toISOString() };
  }
  const inferred = (() => {
    const bcs = readJson(join(projectDir(projectId), 'boundary_conditions.json'));
    const counts = {};
    for (const b of (bcs && bcs.boundary_conditions) || []) {
      const gid = b && b.geometry_id;
      if (!gid) continue;
      counts[gid] = (counts[gid] || 0) + 1;
    }
    let best = null;
    let n = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (v > n) {
        best = k;
        n = v;
      }
    }
    return best;
  })();
  const geomId = activeGeometryId(proj, legacy.geometry_id || inferred);
  const sim = {
    ...legacy,
    geometry_id: legacy.geometry_id || geomId || null,
  };
  const cat = saveCatalog(projectId, { active_id: sim.id, simulations: [sim] });
  stampMissing(projectId, sim.id, sim.geometry_id);
  return cat;
}

export function listSimulations(projectId, proj) {
  return ensureCatalog(projectId, proj).simulations || [];
}

export function getActiveSimulation(projectId, proj, explicitId) {
  const cat = ensureCatalog(projectId, proj);
  const want = String(explicitId || '').trim();
  if (want) return (cat.simulations || []).find((s) => s.id === want) || null;
  return (cat.simulations || []).find((s) => s.id === cat.active_id) || null;
}

export function setActiveSimulation(projectId, proj, simId) {
  const cat = ensureCatalog(projectId, proj);
  if (!(cat.simulations || []).some((s) => s.id === simId)) return cat;
  return saveCatalog(projectId, { ...cat, active_id: simId });
}

export function upsertSimulationInCatalog(projectId, proj, sim, makeActive = true) {
  const cat = ensureCatalog(projectId, proj);
  const list = (cat.simulations || []).slice();
  const i = list.findIndex((s) => s.id === sim.id);
  if (i >= 0) list[i] = { ...list[i], ...sim };
  else list.push(sim);
  return saveCatalog(projectId, {
    simulations: list,
    active_id: makeActive ? sim.id : cat.active_id,
  });
}

/** Untagged rows belong to a singleton catalog study only — never the first of many. Read-only. */
export function firstLegacySimId(projectId, _proj) {
  const existing = readJson(simulationsJsonPath(projectId));
  const list = (existing && existing.simulations) || [];
  if (list.length !== 1 || !list[0] || !list[0].id) return null;
  return list[0].id;
}

export function deleteSimulationFromCatalog(projectId, proj, simId) {
  const cat = ensureCatalog(projectId, proj);
  const want = String(simId || '').trim();
  const list = (cat.simulations || []).filter((s) => s && String(s.id) !== want);
  if (list.length === (cat.simulations || []).length) return cat;
  const nextActive =
    cat.active_id && String(cat.active_id) !== want
      ? cat.active_id
      : list[0]
        ? list[0].id
        : null;
  return saveCatalog(projectId, { simulations: list, active_id: nextActive });
}
