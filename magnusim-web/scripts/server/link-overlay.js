// @ts-check
/**
 * project.json is a cache for linked geometries (host API 1.5, proposal 5.10).
 *
 * Any async writer of project.json writes a snapshot it read earlier, so nothing may
 * depend on the cache holding the link's fields. On every read, linkOverlay copies
 * `source` from the geometry's id.json and the fields of its link/state.json into the
 * project's record of it (in memory), and adds back a linked geometry the cache lost
 * (the repair: the caller persists it through project.upsert_geometry). A folder counts
 * when its id.json has a plugin study source, its link/state.json has rev >= 1, its
 * shape file exists, and it is not marked removed or pending. Reads no cad_preview.json;
 * each state file is read again only when its mtime or size changed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { walkGeometries } from '../project-layout.js';

/** @type {Map<string, { mtimeMs: number, size: number, state: any }>} */
const stateCache = new Map();

/** @param {string} dir */
function cachedState(dir) {
  const path = join(dir, 'link', 'state.json');
  let st;
  try {
    st = statSync(path);
  } catch {
    stateCache.delete(path);
    return null;
  }
  const hit = stateCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.state;
  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8').replace(/^\ufeff/, ''));
  } catch {
    state = null;
  }
  stateCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, state });
  return state;
}

/**
 * The project's linked (and once linked) geometry folders, with their state.
 * @param {string} projectDirPath
 */
export function linkedFolders(projectDirPath) {
  const out = [];
  for (const g of walkGeometries(projectDirPath)) {
    const src = g.source;
    if (!src || typeof src !== 'object' || src.type !== 'plugin_study' || !src.plugin || !src.study_id) continue;
    const dir = String(g.dir);
    if (existsSync(join(dir, 'link', 'removed.json')) || existsSync(join(dir, 'link', 'pending.json'))) continue;
    if (!existsSync(join(dir, 'source.bbrep')) && !existsSync(join(dir, 'source.step'))) continue;
    const state = cachedState(dir);
    if (!state || !(Number(state.rev) >= 1)) continue;
    out.push({ id: String(g.id), dir, source: src, state });
  }
  return out;
}

/** @param {{ id: string, dir: string, source: any, state: any }} f */
function fieldsOf(f) {
  const st = f.state;
  return {
    name: String(st.name || ''),
    source: f.source,
    link: {
      rev: Number(st.rev) || 0,
      names8: String(st.names_sha256 || '').slice(0, 8),
      source_version: Number(st.source_version) || 0,
      synced_at: st.synced_at || null,
    },
    n_solids: Number(st.n_solids) || 1,
    n_faces: st.n_faces === null || st.n_faces === undefined ? null : Number(st.n_faces),
  };
}

/**
 * Overlay the link's fields onto proj.geometries (in memory) and add back lost records.
 * Returns the records it added (the caller persists them).
 * @param {any} proj
 * @param {string} projectDirPath
 */
export function linkOverlay(proj, projectDirPath) {
  if (!proj || typeof proj !== 'object') return [];
  const folders = linkedFolders(projectDirPath);
  if (!folders.length) return [];
  if (!Array.isArray(proj.geometries)) proj.geometries = [];
  const added = [];
  for (const f of folders) {
    const fields = fieldsOf(f);
    const row = proj.geometries.find((/** @type {any} */ g) => g && String(g.id) === f.id);
    if (row) {
      Object.assign(row, { ...fields, name: fields.name || row.name });
      continue;
    }
    const rec = {
      id: f.id,
      name: fields.name || f.id,
      original_filename: null,
      original_path: null,
      source_kind: 'plugin',
      length_unit: null,
      representation: 'step',
      tessellated: false,
      watertight: true,
      step_path: join(f.dir, 'source.step'),
      n_solids: fields.n_solids,
      n_faces: fields.n_faces,
      body_offset: 0,
      imported_at: (f.source && f.source.linked_at) || f.state.synced_at || null,
      note: 'Linked from a plugin study.',
      source: f.source,
      link: fields.link,
    };
    proj.geometries.push(rec);
    added.push(rec);
  }
  if (proj.geometry && typeof proj.geometry === 'object') {
    const f = folders.find((x) => x.id === String(proj.geometry.id));
    if (f) Object.assign(proj.geometry, fieldsOf(f), { name: fieldsOf(f).name || proj.geometry.name });
  }
  return added;
}
