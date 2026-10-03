// @ts-check
/**
 * Build stamps and starts on a linked geometry (host API 1.5, LINK proposal 5.15).
 *
 * A geometry a link made keeps `link/state.json` with its rev. Two stamps follow it, each
 * with one writer:
 * - a mesh's `live_mesh_result.built_from_rev`: the rev its generate started from. The
 *   generate reads it in the same step as its spawn and writes it into the running result
 *   and into `<mesh>/.magnusim-build.json` (for a case found on disk after a crash); every
 *   other mesh write keeps the value on disk (study-io.js writeMeshFolder);
 * - a run's `built_from: {mesh_id, generate_id, geometry_rev}`: copied from its mesh at
 *   Start; every other run write keeps it (study-io.js persistRunAt).
 *
 * A generated mesh is out of date when its geometry has a rev and the mesh's stamp is
 * missing or older. Start refuses on it ("Generate <Mesh> again first"). Generate and
 * Start both refuse while the geometry has a commit journal ("<Geometry> is still
 * updating") and while a boundary condition of the study has a face claimed twice that no
 * boundary condition holds. A geometry no link made has no rev: nothing here applies.
 */
import { existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findMesh, findStudy, readJsonFile } from './project-layout.js';
import { readStudyJson } from './study-io.js';
import { projectDir } from './w17-sim-catalog.js';

/** The file a generate writes beside its case (the generators clear the case folder). */
export const BUILD_FILE = '.magnusim-build.json';

export const LINK_BUILD_TEXT = Object.freeze({
  updating: (/** @type {string} */ g) => `${g} is still updating. Try again in a moment.`,
  outOfDate: (/** @type {string} */ m, /** @type {string} */ g) => `Generate ${m} again first. It was made from an older version of ${g}.`,
  claimed: (/** @type {string} */ face, /** @type {string[]} */ items, /** @type {string} */ g) =>
    `Face '${face}' was in ${andList(items)} after ${g} changed. Pick which one keeps it.`,
});

/** "A", "A and B", "A, B and C". @param {string[]} items */
function andList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** @param {string} projectId */
function projectDirOf(projectId) {
  return projectDir(String(projectId || ''));
}

/**
 * A study's geometry when a link made it: its folder, rev, name and whether a commit
 * journal is left. Null for any other geometry (no rev).
 * @param {string} projectDirPath @param {string | null | undefined} simId
 * @returns {{ dir: string, geometryId: string, rev: number, name: string, journal: boolean } | null}
 */
export function studyGeometryRev(projectDirPath, simId) {
  if (!projectDirPath || !simId) return null;
  let s;
  try {
    s = findStudy(projectDirPath, String(simId));
  } catch {
    return null;
  }
  if (!s || !s.geometry_dir) return null;
  const dir = String(s.geometry_dir);
  const state = readJsonFile(join(dir, 'link', 'state.json'));
  const rev = state && Number(state.rev);
  if (!state || !Number.isSafeInteger(rev) || rev < 1) return null;
  return {
    dir,
    geometryId: String(s.geometry_id || ''),
    rev,
    name: String(state.name || s.geometry_id || 'The geometry'),
    journal: existsSync(join(dir, 'link', 'commit.json')),
  };
}

/** The study a mesh folder belongs to. @param {string} projectDirPath @param {string} meshId */
function meshFolder(projectDirPath, meshId) {
  if (!projectDirPath || !meshId) return null;
  try {
    return findMesh(projectDirPath, String(meshId));
  } catch {
    return null;
  }
}

/** A stamp as stored: a whole rev >= 1, else null. @param {unknown} v */
function revOf(v) {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Whether a generated mesh is out of date: its geometry has a rev (a link made it) and its
 * `built_from_rev` is missing or below that rev. A mesh that is not generated is not out
 * of date (it is "not generated", which says more).
 * @param {string} projectId @param {string} meshId
 * @returns {{ outOfDate: boolean, rev: number | null, builtFromRev: number | null, meshName: string, geometryName: string }}
 */
export function meshOutOfDate(projectId, meshId) {
  return meshOutOfDateAt(projectDirOf(projectId), meshId);
}

/** meshOutOfDate for a project folder. @param {string} projectDirPath @param {string} meshId */
export function meshOutOfDateAt(projectDirPath, meshId) {
  const folder = meshFolder(projectDirPath, meshId);
  const rec = folder ? readJsonFile(join(folder.dir, 'mesh.json')) || {} : {};
  const meshName = String(rec.name || (rec.settings && rec.settings.name) || 'the mesh');
  const geom = folder ? studyGeometryRev(projectDirPath, folder.simulation_id) : null;
  const live = rec.live_mesh_result && typeof rec.live_mesh_result === 'object' ? rec.live_mesh_result : null;
  const builtFromRev = live ? revOf(live.built_from_rev) : null;
  const generated = !!(live && live.status === 'done');
  return {
    outOfDate: !!(geom && generated && (builtFromRev === null || builtFromRev < geom.rev)),
    rev: geom ? geom.rev : null,
    builtFromRev,
    meshName,
    geometryName: geom ? geom.name : '',
  };
}

/** Every string a record holds at its top level or one bag down, but its lost list. @param {any} rec */
function heldLabels(rec) {
  const out = new Set();
  const take = (/** @type {any} */ v) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.add(x);
  };
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === 'lost_faces') continue;
    take(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const x of Object.values(v)) take(x);
  }
  return out;
}

/** A host face label's display label from the geometry's face table. @param {string} geomDir */
function faceTable(geomDir) {
  const meta = readJsonFile(join(geomDir, 'cad_preview.json'));
  /** @type {Map<string, string>} */
  const byId = new Map();
  for (const f of (meta && Array.isArray(meta.faces) && meta.faces) || []) {
    if (f && f.id !== null && f.id !== undefined && (f.label || f.name)) byId.set(String(f.id), String(f.label || f.name));
  }
  return byId;
}

/**
 * The faces an update merged out of two or more boundary conditions that none of the
 * study's boundary conditions holds again yet (D25): one entry per face, with its label
 * and the boundary conditions that claimed it.
 * @param {string} projectId @param {string} simId @param {string} geomDir
 */
export function facesClaimedTwice(projectId, simId, geomDir) {
  /** @type {any[]} */
  let bcs;
  try {
    const doc = readStudyJson(projectId, simId, 'bcs');
    bcs = (doc && Array.isArray(doc.boundary_conditions) && doc.boundary_conditions) || [];
  } catch {
    bcs = [];
  }
  /** @type {Map<string, { target: string, label: string, items: Set<string> }>} */
  const claims = new Map();
  const held = new Set();
  for (const bc of bcs) {
    if (!bc || typeof bc !== 'object') continue;
    for (const l of heldLabels(bc)) held.add(l);
    for (const e of Array.isArray(bc.lost_faces) ? bc.lost_faces : []) {
      if (!e || e.reason !== 'claimed_twice') continue;
      for (const t of Array.isArray(e.targets) ? e.targets : []) {
        const key = String(t);
        const hit = claims.get(key) || { target: key, label: String(e.label || e.name || key), items: new Set() };
        hit.items.add(String(bc.name || bc.id || 'Boundary condition'));
        claims.set(key, hit);
      }
    }
  }
  const labels = claims.size ? faceTable(geomDir) : new Map();
  const out = [];
  for (const c of claims.values()) {
    if (held.has(c.target)) continue;
    const id = /^face\s+(\d+)@/i.exec(c.target);
    const label = (id && labels.get(id[1])) || c.label;
    out.push({ target: c.target, label, items: [...c.items].sort((a, b) => a.localeCompare(b)) });
  }
  return out;
}

/**
 * Why a Generate or a Start of this study must not begin now, or null: the geometry has a
 * commit journal, or a face is claimed twice. The answer leaves a queued row at once
 * (`final`), with its reason in the notice.
 * @param {string} projectId @param {string | null | undefined} simId
 * @returns {null | { ok: false, status: number, bodyExtra: Record<string, any> }}
 */
export function linkStartRefusal(projectId, simId) {
  const dir = projectDirOf(projectId);
  const geom = studyGeometryRev(dir, simId);
  if (!geom) return null;
  if (geom.journal) {
    return refusal('geometry_updating', LINK_BUILD_TEXT.updating(geom.name), { geometry_id: geom.geometryId });
  }
  const claimed = facesClaimedTwice(projectId, String(simId), geom.dir);
  if (claimed.length) {
    const c = claimed[0];
    return refusal('face_claimed_twice', LINK_BUILD_TEXT.claimed(c.label, c.items, geom.name), { claimed_twice: claimed });
  }
  return null;
}

/** @param {string} code @param {string} error @param {Record<string, any>} [extra] */
function refusal(code, error, extra = {}) {
  return { ok: /** @type {const} */ (false), status: 409, bodyExtra: { ok: false, error, code, final: true, ...extra } };
}

/**
 * The rev a generate of this mesh starts from (read in the same step as its spawn), or
 * null when no link made its geometry.
 * @param {string} projectId @param {string | null | undefined} simId
 */
export function generateRev(projectId, simId) {
  const geom = studyGeometryRev(projectDirOf(projectId), simId);
  return geom ? geom.rev : null;
}

/**
 * Write `<mesh>/.magnusim-build.json` for a generate that starts: a case found on disk
 * after a crash carries the stamp only when the file names its generate.
 * @param {string} projectId @param {string} meshId @param {string} generateId @param {number | null} rev
 */
export function writeBuildStamp(projectId, meshId, generateId, rev) {
  const folder = meshFolder(projectDirOf(projectId), meshId);
  if (!folder) return;
  const file = join(folder.dir, BUILD_FILE);
  if (rev === null || rev === undefined) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* a stale file names another generate: never used */
    }
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ generate_id: String(generateId), built_from_rev: rev }) + '\n', 'utf8');
  renameSync(tmp, file);
}

/**
 * The stamp a generate wrote at its start, when the file names that generate; else null
 * (unknown: the mesh counts as out of date).
 * @param {string} projectId @param {string} meshId @param {string | null | undefined} generateId
 */
export function buildStampOf(projectId, meshId, generateId) {
  if (!generateId) return null;
  const folder = meshFolder(projectDirOf(projectId), meshId);
  const doc = folder ? readJsonFile(join(folder.dir, BUILD_FILE)) : null;
  if (!doc || String(doc.generate_id || '') !== String(generateId)) return null;
  return revOf(doc.built_from_rev);
}

/**
 * A run's `built_from` at Start, from its mesh's record: null when no link made the
 * geometry.
 * @param {string} projectId @param {string | null | undefined} simId @param {string | null | undefined} meshId
 */
export function runBuiltFrom(projectId, simId, meshId) {
  const dir = projectDirOf(projectId);
  const geom = studyGeometryRev(dir, simId);
  if (!geom || !meshId) return null;
  const folder = meshFolder(dir, String(meshId));
  const rec = folder ? readJsonFile(join(folder.dir, 'mesh.json')) || {} : {};
  const live = rec.live_mesh_result && typeof rec.live_mesh_result === 'object' ? rec.live_mesh_result : {};
  return {
    mesh_id: String(meshId),
    generate_id: live.generate_id !== null && live.generate_id !== undefined ? String(live.generate_id) : null,
    geometry_rev: revOf(live.built_from_rev),
  };
}
