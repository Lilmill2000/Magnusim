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
  readJsonFile,
  renameFolderTo,
  writeIdFile,
  writeJsonAtomic,
} from './project-layout.js';
import { analysisKeyFor } from './registry-defaults.js';

/**
 * The AnalysisType a study solves as: its analysis family resolved against its
 * time dependency (incompressible_transient for a Transient study). Every write
 * of a study record stores this, so the key and the time dependency never disagree.
 */
export function studyAnalysisKey(sim) {
  return analysisKeyFor(sim && sim.analysis_type, sim && sim.time_dependency);
}

function withStudyAnalysisKey(sim) {
  if (!sim || !sim.time_dependency) return sim;
  const key = studyAnalysisKey(sim);
  return key === sim.analysis_type ? sim : { ...sim, analysis_type: key };
}

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

/** The study's analysis name: what its contract's study_defaults call it ("Incompressible"). */
function studyAnalysisName(sim) {
  return String((sim && sim.analysis) || '').trim() || 'Simulation';
}

/** A study's default name: its analysis's name and time dependency ("Incompressible Transient"). */
export function studyBaseName(sim) {
  const time = /transient/i.test(String((sim && sim.time_dependency) || ''))
    ? 'Transient'
    : 'Steady-state';
  return studyAnalysisName(sim) + ' ' + time;
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Still the default name of this study's analysis (numbered or not), so it may be renumbered. */
export function isDefaultStudyName(name, sim) {
  const text = String(name || '').trim();
  if (!text) return true;
  const base = escapeRe(studyAnalysisName(sim));
  return new RegExp('^' + base + ' (Steady-state|Transient)(?:\\s+\\d+)?$', 'i').test(text);
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
    const walkedRow = byId.get(id);
    // A field the study folder does not record (undefined) must not blank the index value.
    const w = Object.fromEntries(Object.entries(walkedRow).filter(([, v]) => v !== undefined));
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
    const auto = siblings.filter((s) => isDefaultStudyName(s.name, s));
    if (!auto.length) continue;
    const base = studyBaseName(auto[0]);
    if (siblings.length === 1) {
      siblings[0].name = base;
      continue;
    }
    const taken = new Set(
      siblings.filter((s) => !isDefaultStudyName(s.name, s)).map((s) => String(s.name).trim())
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

/**
 * The study folder's id.json: its identity only (the walked catalog reads these back).
 * Its settings live in its simulations.json row.
 */
function studyIdRecord(sim) {
  return {
    id: sim.id,
    name: sim.name,
    geometry_id: sim.geometry_id,
    kind: 'simulation',
    analysis: sim.analysis,
    analysis_type: sim.time_dependency ? studyAnalysisKey(sim) : sim.analysis_type,
    time_dependency: sim.time_dependency,
    algorithm: sim.algorithm,
    created_at: sim.created_at,
    updated_at: sim.updated_at || new Date().toISOString(),
    sort_index: Number.isFinite(Number(sim.sort_index)) ? Number(sim.sort_index) : undefined,
  };
}

export function writeActiveMirror(projectId, sim) {
  if (!sim) return null;
  const walked = findStudy(projectDir(projectId), sim.id);
  if (walked && walked.dir) {
    writeIdFile(walked.dir, studyIdRecord(sim));
    if (sim.name && walked.folder !== undefined) {
      const parent = join(walked.geometry_dir, 'simulations');
      try {
        // Same record after a rename; a shorter copy here used to drop analysis_type
        // and turbulence_model, which then blanked them in the merged catalog.
        const nextDir = renameFolderTo(walked.dir, parent, sim.name);
        writeIdFile(nextDir, studyIdRecord(sim));
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

export function saveCatalog(projectId, catalog, opts) {
  const simulations = stampStudyOrder(persistStudyNames(catalog.simulations || [])).map(withStudyAnalysisKey);
  const active_id =
    catalog.active_id && simulations.some((s) => s.id === catalog.active_id)
      ? catalog.active_id
      : simulations[0]
        ? simulations[0].id
        : null;
  for (const s of simulations) {
    writeActiveMirror(projectId, s);
  }
  // A study being deleted (opts.drop) keeps its folder until the caller removes it after
  // this save. The walk still finds it; it must not be listed again (the index kept it,
  // and hydrate and activate then brought the deleted study back).
  const drop = new Set(((opts && opts.drop) || []).map((id) => String(id)));
  const walked = catalogFromWalk(projectDir(projectId), active_id);
  const live = walked.simulations.filter((s) => !drop.has(String(s.id)));
  const merged = stampStudyOrder(mergeStudyOrder(live, simulations));
  const doc = {
    active_id: drop.has(String(walked.active_id)) ? (merged[0] && merged[0].id) || null : walked.active_id,
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
/**
 * Studies saved before the key followed the time dependency stored
 * incompressible_steady for Transient studies. Fix each study folder's id.json
 * once (atomic write) when the project is read; later reads find it consistent.
 */
function normalizeWalkedAnalysisKeys(walked) {
  for (const s of walked.simulations || []) {
    const fixed = withStudyAnalysisKey(s);
    if (fixed === s || !s.dir) continue;
    try {
      const idPath = join(s.dir, 'id.json');
      const doc = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : null;
      if (doc && typeof doc === 'object') writeIdFile(s.dir, { ...doc, analysis_type: fixed.analysis_type });
    } catch (e) {
      console.warn('[CFD W17] study analysis key', e);
    }
    s.analysis_type = fixed.analysis_type;
  }
  return walked;
}

/** The keys a study's id.json holds (studyIdRecord); anything else there is a setting. */
const STUDY_ID_KEYS = new Set([
  'id',
  'name',
  'geometry_id',
  'kind',
  'analysis',
  'analysis_type',
  'time_dependency',
  'algorithm',
  'created_at',
  'updated_at',
  'sort_index',
]);

/** Keys catalogFromWalk adds to a walked study (not in its id.json). */
const WALKED_KEYS = new Set(['folder', 'dir', 'geometry_dir', 'geometry_folder']);

/** The settings (non-identity scalars) an older version wrote into a study's id.json. */
function idFileSettings(doc) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(doc || {})) {
    if (STUDY_ID_KEYS.has(key) || WALKED_KEYS.has(key)) continue;
    if (value !== null && typeof value === 'object') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Older versions also kept study settings (the turbulence model) in the study
 * folder's id.json, and that copy won over the index. Move them, once, into the
 * study's simulations.json row (id.json still wins where the two differ), then
 * leave id.json with the identity only. The index is written first, so a stop
 * between the two writes loses nothing and the next read finishes the move.
 * A study with no index row keeps its id.json as it is (the walk still reads it).
 * Returns the index as it now is.
 */
function foldLegacyIdSettings(projectId, walked, index) {
  const rows = index && Array.isArray(index.simulations) ? index.simulations : null;
  if (!rows) return index;
  /** @type {any[] | null} */
  let next = null;
  const trim = [];
  for (const s of walked.simulations || []) {
    if (!s || !s.dir) continue;
    // The walked row carries every scalar of its id.json (catalogFromWalk): most
    // studies have none to move and their id.json is not read again.
    if (!Object.keys(idFileSettings(s)).length) continue;
    const doc = readJsonFile(join(s.dir, 'id.json'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const settings = idFileSettings(doc);
    const keys = Object.keys(settings);
    if (!keys.length) continue;
    const i = rows.findIndex((r) => r && String(r.id) === String(s.id));
    if (i < 0) continue;
    const row = (next || rows)[i];
    if (keys.some((k) => row[k] !== settings[k])) {
      next = next || rows.slice();
      next[i] = { ...row, ...settings };
    }
    trim.push({ dir: s.dir, doc, keys });
  }
  if (!trim.length) return index;
  let out = index;
  try {
    if (next) {
      out = { ...index, simulations: next };
      writeJsonAtomic(simulationsJsonPath(projectId), out);
    }
    for (const t of trim) {
      const ident = { ...t.doc };
      for (const k of t.keys) delete ident[k];
      writeIdFile(t.dir, ident);
    }
  } catch (e) {
    // The walk still reads id.json first; the next read tries again.
    console.warn('[CFD W17] fold study id.json settings', e);
  }
  return out;
}

export function readCatalog(projectId) {
  const walked = normalizeWalkedAnalysisKeys(catalogFromWalk(projectDir(projectId), null));
  if (walked.simulations.length) {
    const index = foldLegacyIdSettings(projectId, walked, readJson(simulationsJsonPath(projectId)));
    const active_id =
      (index && index.active_id && walked.simulations.some((s) => s.id === index.active_id)
        ? index.active_id
        : walked.active_id) || null;
    const merged = stampStudyOrder(mergeStudyOrder(walked.simulations, (index && index.simulations) || []));
    return { active_id, simulations: merged, updated_at: walked.updated_at };
  }
  return { active_id: null, simulations: [], updated_at: null };
}

/**
 * The index without rows whose study folder is gone. A project saved before a study
 * delete dropped the study from the index (the delete saved it while the folder was
 * still there) can list the deleted study, even as active_id: activating it wrote it
 * back. The folders are the studies, so such a row goes, and an active_id on it moves
 * to the first study left. The fixed index is written back once (atomic replace).
 * Node writes this file, synchronously, and makes a study's folder before its row, so
 * a walk right after the read finds every folder the index may name. The worker only
 * filters (paths.drop_missing_studies): it runs beside these writes.
 */
function dropMissingStudies(projectId, index, onDisk) {
  const rows = index.simulations;
  const kept = rows.filter((s) => s && s.id != null && onDisk.has(String(s.id)));
  const active = index.active_id != null ? String(index.active_id) : '';
  const activeGone = !!active && !onDisk.has(active);
  if (kept.length === rows.length && !activeGone) return { catalog: index, dropped: [] };
  const fixed = {
    ...index,
    active_id: activeGone ? (kept[0] && kept[0].id) || null : index.active_id,
    simulations: kept,
    updated_at: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(simulationsJsonPath(projectId), fixed);
    // Activating the missing study also made simulation.json a copy of it.
    const mirror = readJson(simulationJsonPath(projectId));
    const next = kept.find((s) => String(s.id) === String(fixed.active_id));
    if (mirror && mirror.id != null && !onDisk.has(String(mirror.id)) && next) {
      writeJsonAtomic(simulationJsonPath(projectId), { ...next, simulation_json: simulationJsonPath(projectId) });
    }
  } catch (e) {
    // This answer is fixed all the same; the next read writes it.
    console.warn('[CFD W17] drop missing studies', e);
  }
  return { catalog: fixed, dropped: rows.filter((s) => s && !kept.includes(s)) };
}

export function pruneOrphanStudies(projectId, proj) {
  const walked = catalogFromWalk(projectDir(projectId), null);
  // Settings still in an id.json move into the index first: the save below writes
  // id.json identity-only from these rows.
  const existing = foldLegacyIdSettings(projectId, walked, readJson(simulationsJsonPath(projectId)));
  if (!existing || !Array.isArray(existing.simulations)) {
    return { catalog: existing || { active_id: null, simulations: [] }, dropped: [] };
  }
  const onDisk = new Set(walked.simulations.map((s) => String(s.id)));
  if (!proj || !Array.isArray(proj.geometries)) {
    return dropMissingStudies(projectId, existing, onDisk);
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
    return dropMissingStudies(projectId, existing, onDisk);
  }
  // The save lists only studies the walk finds; the active one comes from those left.
  return {
    catalog: saveCatalog(projectId, { ...existing, simulations: kept.filter((s) => onDisk.has(String(s.id))) }),
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
  return saveCatalog(projectId, { simulations: list, active_id: nextActive }, { drop: [want] });
}
