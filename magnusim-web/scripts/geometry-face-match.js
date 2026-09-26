// @ts-check
/**
 * Faces that are the same surface on two geometries of one project.
 *
 * A study copied onto another geometry keeps the boundary conditions, monitors and
 * refinements whose faces exist there too: same place, facing the same way, same
 * size and kind of surface. Face numbers differ between geometries, so a face is
 * never carried over by its number. Faces with no exact counterpart are left off.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Faces of a geometry folder from its cad_preview.json, or null. */
export function readPreviewFaces(geometryDir) {
  const path = join(String(geometryDir || ''), 'cad_preview.json');
  if (!geometryDir || !existsSync(path)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const faces = Array.isArray(meta && meta.faces) ? meta.faces : [];
  const b = (meta && meta.bounds) || {};
  const span = [b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin].map((v) => (Number.isFinite(v) ? v : 0));
  return {
    faces: faces.filter((f) => f && Number.isFinite(Number(f.id)) && Array.isArray(f.centroid)),
    solids: Number(meta && meta.n_solids) || 1,
    diag: Math.hypot(span[0], span[1], span[2]),
  };
}

function sameFace(a, b, tol) {
  const d = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1], a.centroid[2] - b.centroid[2]);
  if (!(d <= tol)) return false;
  const aa = Number(a.area);
  const ba = Number(b.area);
  if (!(Math.abs(aa - ba) <= 1e-3 * Math.max(aa, ba, 1e-12))) return false;
  if (a.surface_type && b.surface_type && a.surface_type !== b.surface_type) return false;
  if (Array.isArray(a.normal) && Array.isArray(b.normal)) {
    const dot = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
    if (!(dot >= 0.9999)) return false;
  }
  return true;
}

/**
 * Source face id -> destination face id, for faces with exactly one counterpart.
 * Only single-body geometries: a face label names its body, and bodies are not
 * matched between geometries.
 */
export function matchFaces(src, dest) {
  /** @type {Map<number, number>} */
  const map = new Map();
  if (!src || !dest || src.solids > 1 || dest.solids > 1) return map;
  const tol = Math.max(1e-4 * Math.max(src.diag, dest.diag), 1e-6);
  for (const a of src.faces) {
    const hits = dest.faces.filter((b) => sameFace(a, b, tol));
    if (hits.length === 1) map.set(Number(a.id), Number(hits[0].id));
  }
  return map;
}

const FACE_LABEL = /^face\s*(\d+)(@Body\d+)?$/i;

/**
 * Carry a record's faces to the other geometry. Returns the record with only the
 * faces that have a counterpart, plus the labels that were left off.
 */
export function remapRecordFaces(rec, map) {
  if (!rec || !Array.isArray(rec.faces) || !rec.faces.length) {
    return { rec: rec ? { ...rec, face: null } : rec, lost: [] };
  }
  const faces = [];
  const lost = [];
  for (const label of rec.faces) {
    const m = FACE_LABEL.exec(String(label || '').trim());
    const to = m ? map.get(Number(m[1])) : undefined;
    if (to == null) lost.push(String(label));
    else faces.push(`face ${to}${m && m[2] ? m[2] : '@Body1'}`);
  }
  return { rec: { ...rec, faces, face: null }, lost };
}
