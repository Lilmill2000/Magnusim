import { safeProjectPath } from './safe-path.js';
// @ts-check
/**
 * Multi-study catalog: projects/<id>/simulations.json
 * Active study is also mirrored to simulation.json for older readers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geometriesOf } from './w16-geometry-scope.js';
import { envGet } from './env-compat.js';
import {
  catalogFromWalk,
  findStudy,
  renameFolderTo,
  writeIdFile,
  writeJsonAtomic,
} from './project-layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');

export function projectDir(id) {
  return safeProjectPath(PROJECTS_ROOT, id);
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

export function studyBaseName(sim) {
  const time = /transient/i.test(String((sim && sim.time_dependency) || ''))
    ? 'Transient'
    : 'Steady-state';
  return 'Incompressible ' + time;
}

const DEFAULT_STUDY_NAME = /^Incompressible (Steady-state|Transient)(?:\s+\d+)?$/i;

export function isDefaultStudyName(name) {
  return !String(name || '').trim() || DEFAULT_STUDY_NAME.test(String(name).trim());
}

export function sortStudies(list) {
  return (list || []).slice().sort((a, b) => {
    const ai = Number(a && a.sort_index);
    const bi = Number(b && b.sort_index);
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
    if (Number.isFinite(ai) && !Number.isFinite(bi)) return -1;
    if (!Number.isFinite(ai) && Number.isFinite(bi)) return 1;
    const ac = String((a && a.created_at) || '');
    const bc = String((b && b.created_at) || '');
    if (ac && bc && ac !== bc) return ac.localeCompare(bc);
    return 0;
  });
}

export function stampStudyOrder(list, reindex = false) {
  const rows = (list || []).map((s) => ({ ...s }));
  if (reindex || !rows.some((s) => Number.isFinite(Number(s && s.sort_index)))) {
    return rows.map((s, i) => ({ ...s, sort_index: i }));
  }
  return sortStudies(rows).map((s, i) => ({ ...s, sort_index: Number.isFinite(Number(s.sort_index)) ? Number(s.sort_index) : i }));
}

/** Keep catalog / creation order. Folder walks are alphabetical and must not win. */
export function mergeStudyOrder(walked, preferred) {
  const byId = new Map();
  for (const s of walked || []) {
    if (s && s.id) byId.set(String(s.id), s);
  }
  const out = [];
  const seen = new Set();
  for (const s of preferred || []) {
    const id = s && s.id != null ? String(s.id) : '';
    if (!id || seen.has(id) || !byId.has(id)) continue;
    const w = byId.get(id);
    const preferredSort = Number(s.sort_index);
    const walkedSort = Number(w.sort_index);
    out.push({
      ...s,
      ...w,
      dir: w.dir,
      folder: w.folder,
      sort_index: Number.isFinite(preferredSort)
        ? preferredSort
        : Number.isFinite(walkedSort)
          ? walkedSort
          : undefined,
    });
    seen.add(id);
  }
  for (const w of walked || []) {
    const id = w && w.id != null ? String(w.id) : '';
    if (!id || seen.has(id)) continue;
    out.push(w);
    seen.add(id);
  }
  return out;
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
    const auto = siblings.filter((s) => isDefaultStudyName(s.name));
    if (!auto.length) continue;
    const base = studyBaseName(auto[0]);
    if (siblings.length === 1) {
      siblings[0].name = base;
      continue;
    }
    const taken = new Set(
      siblings.filter((s) => !isDefaultStudyName(s.name)).map((s) => String(s.name).trim())
    );
    let n = 1;
    for (const s of auto) {
      let candidate = base + ' ' + n;
      while (taken.has(candidate)) {
        n += 1;
        candidate = base + ' ' + n;
      }
      s.name = candidate;
      taken.add(candidate);
      n += 1;
    }
  }
  return out;
}

/** Shared-JSON claiming is gone; each study folder is created with its own files. */
export function claimUntaggedRecords(_projectId, _simId, _geomId) {}

export function writeActiveMirror(projectId, sim) {
  if (!sim) return null;
  const walked = findStudy(projectDir(projectId), sim.id);
  if (walked && walked.dir) {
    writeIdFile(walked.dir, {
      id: sim.id,
      name: sim.name,
      geometry_id: sim.geometry_id,
      kind: 'simulation',
      analysis: sim.analysis,
      analysis_type: sim.analysis_type,
      turbulence_model: sim.turbulence_model,
      time_dependency: sim.time_dependency,
      algorithm: sim.algorithm,
      created_at: sim.created_at,
      updated_at: sim.updated_at || new Date().toISOString(),
      sort_index: Number.isFinite(Number(sim.sort_index)) ? Number(sim.sort_index) : undefined,
    });
    if (sim.name && walked.folder !== undefined) {
      const parent = join(walked.geometry_dir, 'simulations');
      try {
        const nextDir = renameFolderTo(walked.dir, parent, sim.name);
        writeIdFile(nextDir, {
          id: sim.id,
          name: sim.name,
          geometry_id: sim.geometry_id,
          kind: 'simulation',
          analysis: sim.analysis,
          time_dependency: sim.time_dependency,
          algorithm: sim.algorithm,
          sort_index: Number.isFinite(Number(sim.sort_index)) ? Number(sim.sort_index) : undefined,
        });
      } catch (_) {}
    }
  }
  const path = simulationJsonPath(projectId);
  writeJsonAtomic(path, { ...sim, simulation_json: path });
  return path;
}

export function persistStudyNames(list) {
  return (list || []).map((s) => ({
    ...s,
    name: String((s && s.name) || '').trim() || studyBaseName(s),
  }));
}

export function saveCatalog(projectId, catalog) {
  const simulations = stampStudyOrder(persistStudyNames(catalog.simulations || []));
  const active_id =
    catalog.active_id && simulations.some((s) => s.id === catalog.active_id)
      ? catalog.active_id
      : simulations[0]
        ? simulations[0].id
        : null;
  for (const s of simulations) {
    writeActiveMirror(projectId, s);
  }
  const walked = catalogFromWalk(projectDir(projectId), active_id);
  const merged = stampStudyOrder(mergeStudyOrder(walked.simulations, simulations));
  const doc = {
    active_id: walked.active_id,
    simulations: merged,
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(simulationsJsonPath(projectId), {
    active_id: doc.active_id,
    simulations: doc.simulations.map((s) => {
      const { dir, ...rest } = s;
      return rest;
    }),
    updated_at: doc.updated_at,
  });
  return doc;
}

/** Disk catalog only. GET paths must not spawn project_cli. */
export function readCatalog(projectId) {
  const walked = catalogFromWalk(projectDir(projectId), null);
  if (walked.simulations.length) {
    const index = readJson(simulationsJsonPath(projectId));
    const active_id =
      (index && index.active_id && walked.simulations.some((s) => s.id === index.active_id)
        ? index.active_id
        : walked.active_id) || null;
    const merged = stampStudyOrder(mergeStudyOrder(walked.simulations, (index && index.simulations) || []));
    return { active_id, simulations: merged, updated_at: walked.updated_at };
  }
  return { active_id: null, simulations: [], updated_at: null };
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
    return { catalog: existing, dropped: [] };
  }
  return {
    catalog: saveCatalog(projectId, { ...existing, simulations: kept }),
    dropped,
  };
}

export function ensureCatalog(projectId, proj) {
  const walked = readCatalog(projectId);
  if (!walked.simulations.length) {
    return { active_id: null, simulations: [], updated_at: new Date().toISOString() };
  }
  const index = readJson(simulationsJsonPath(projectId));
  if (!index || !Array.isArray(index.simulations)) {
    return walked;
  }
  return pruneOrphanStudies(projectId, proj).catalog;
}

export function listSimulations(projectId, proj) {
  return ensureCatalog(projectId, proj).simulations || [];
}

/** Rows tagged to a live catalog study. */
export function liveStudyRows(projectId, proj, rows) {
  const liveIds = new Set((listSimulations(projectId, proj) || []).map((s) => String(s.id)));
  return (rows || []).filter((r) => {
    if (!r) return false;
    const sid = r.simulation_id != null ? String(r.simulation_id).trim() : '';
    if (sid) return liveIds.has(sid);
    return false;
  });
}

export function getActiveSimulation(projectId, proj, explicitId) {
  const cat = readCatalog(projectId);
  const want = String(explicitId || '').trim();
  if (want) return (cat.simulations || []).find((s) => s.id === want) || null;
  return (
    (cat.simulations || []).find((s) => s.id === cat.active_id) ||
    (cat.simulations || [])[0] ||
    null
  );
}

export function setActiveSimulation(projectId, proj, simId) {
  const cat = ensureCatalog(projectId, proj);
  const list = stampStudyOrder(cat.simulations || []);
  if (!list.some((s) => s.id === simId)) return { ...cat, simulations: list };
  const doc = {
    active_id: simId,
    simulations: list.map((s) => {
      const { dir, ...rest } = s;
      return rest;
    }),
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(simulationsJsonPath(projectId), doc);
  const active = list.find((s) => s.id === simId);
  if (active) writeActiveMirror(projectId, active);
  return { active_id: simId, simulations: list, updated_at: doc.updated_at };
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

/** No shared-file untagged rows. New layout always stamps simulation_id. */
export function firstLegacySimId(_projectId, _proj) {
  return null;
}

export function reorderSimulationsInCatalog(projectId, proj, ids, geometryId) {
  const cat = ensureCatalog(projectId, proj);
  const list = (cat.simulations || []).slice();
  const want = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  const byId = new Map(list.map((s) => [String(s.id), s]));
  const mentioned = want.filter((id) => byId.has(id));
  if (mentioned.length < 2) {
    return saveCatalog(projectId, { simulations: stampStudyOrder(list, true), active_id: cat.active_id });
  }
  const seen = new Set();
  const ordered = [];
  for (const id of mentioned) {
    if (seen.has(id)) continue;
    ordered.push(byId.get(id));
    seen.add(id);
  }
  const gid = geometryId != null && String(geometryId).trim() ? String(geometryId) : String(ordered[0].geometry_id || '');
  const next = [];
  let inserted = false;
  for (const s of list) {
    const sameGroup = gid
      ? String(s.geometry_id || '') === gid || seen.has(String(s.id))
      : seen.has(String(s.id));
    if (sameGroup) {
      if (!inserted) {
        next.push(...ordered);
        inserted = true;
      }
      if (!seen.has(String(s.id))) next.push(s);
      continue;
    }
    next.push(s);
  }
  if (!inserted) next.push(...ordered);
  return saveCatalog(projectId, { simulations: stampStudyOrder(next, true), active_id: cat.active_id });
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
