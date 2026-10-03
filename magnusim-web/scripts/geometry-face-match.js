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

// ---- a linked geometry's update (host API 1.5) ----------------------------------------------

/** A face table as the link map reads it, from a cad_preview.json's contents. */
export function linkFaceTable(meta) {
  const faces = (Array.isArray(meta && meta.faces) ? meta.faces : []).filter((f) => f && Number.isFinite(Number(f.id)));
  const n = Number(meta && meta.n_solids) || 1;
  const info = Array.isArray(meta && meta.body_info) && meta.body_info.length ? meta.body_info : [];
  const bodies = info.length ? info.map((b) => ({ ref: String(b.ref), id: b.id || null, name: b.name || null })) : Array.from({ length: n }, (_, i) => ({ ref: `Body${i + 1}`, id: null, name: null }));
  const b = (meta && meta.bounds) || {};
  const span = [b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin].map((v) => (Number.isFinite(v) ? v : 0));
  return { faces, bodies, diag: Math.hypot(span[0], span[1], span[2]) };
}

const bodyRefOf = (f) => `Body${Number(f.body) || 1}`;
const faceRef = (f) => `face ${Number(f.id)}@${bodyRefOf(f)}`;

/**
 * Bodies paired across an update (proposal 5.12 step 1): by id when both have one, then
 * by name, then the rest by index when both sides have as many bodies. Old body label
 * ("Body2") -> new body label, or null when it has no pair.
 */
export function pairLinkBodies(oldBodies, newBodies) {
  /** @type {Record<string, string | null>} */
  const out = {};
  const taken = new Set();
  const pair = (test) => {
    for (const o of oldBodies) {
      if (out[o.ref] !== undefined) continue;
      const hit = newBodies.find((n) => !taken.has(n.ref) && test(o, n));
      if (hit) {
        out[o.ref] = hit.ref;
        taken.add(hit.ref);
      }
    }
  };
  pair((o, n) => !!o.id && !!n.id && String(o.id) === String(n.id));
  pair((o, n) => !!o.name && !!n.name && String(o.name) === String(n.name));
  if (oldBodies.length === newBodies.length) pair((o, n) => o.ref === n.ref);
  for (const o of oldBodies) if (out[o.ref] === undefined) out[o.ref] = null;
  return out;
}

/**
 * The map of a linked geometry's update (proposal 5.12), from the live face table to the
 * new one, both read from cad_preview.json (faces with `body`, `name`, centroid, area,
 * normal, surface type; `body_info` with each body's id and name):
 *
 * 1. bodies pair by id, then name, then index;
 * 2. a face name on one old face maps to every new face of that name (a split); a name on
 *    several old faces pairs them by shape first, then the leftovers: one leftover maps to
 *    every leftover new face, several map to one leftover new face (a merge), and several
 *    to several are ambiguous (`groups`: the plan maps them only for a record that held
 *    every face of the group);
 * 3. an old face still unmapped is matched by shape within its paired body (exactly one hit);
 * 4. otherwise it is lost (no entry in `faces`).
 *
 * New labels take their body from the new face table. Returns `{faces: {oldIndex:
 * [newLabel]}, groups: {oldIndex: groupId}, body_map, report: {match, merged, moved_far}}`.
 */
export function linkFaceMap(oldMeta, newMeta) {
  const oldT = linkFaceTable(oldMeta);
  const newT = linkFaceTable(newMeta);
  const bodyMap = pairLinkBodies(oldT.bodies, newT.bodies);
  const diag = Math.max(oldT.diag, newT.diag);
  const tol = Math.max(1e-4 * diag, 1e-6);
  /** @type {Record<string, string[]>} */
  const faces = {};
  /** @type {Record<string, string>} */
  const groups = {};
  const match = { byName: 0, byShape: 0, split: 0, merged: 0, movedFar: 0 };
  const movedFar = [];
  const inBody = (f, ref) => (ref ? bodyRefOf(f) === ref : true);
  const newByName = new Map();
  for (const f of newT.faces) {
    if (!f.name) continue;
    if (!newByName.has(f.name)) newByName.set(f.name, []);
    newByName.get(f.name).push(f);
  }
  const oldByName = new Map();
  for (const f of oldT.faces) {
    if (!f.name) continue;
    if (!oldByName.has(f.name)) oldByName.set(f.name, []);
    oldByName.get(f.name).push(f);
  }
  const far = (a, b) => {
    if (!Array.isArray(a.centroid) || !Array.isArray(b.centroid)) return false;
    const d = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1], a.centroid[2] - b.centroid[2]);
    const aa = Number(a.area);
    const ba = Number(b.area);
    return d > 0.1 * diag || (aa > 0 && Math.abs(ba - aa) > 0.5 * aa);
  };
  const keep = (o, targets, how) => {
    faces[String(o.id)] = targets.map(faceRef);
    if (how === 'name') match.byName += 1;
    else match.byShape += 1;
    if (targets.length > 1) match.split += 1;
  };
  let g = 0;
  for (const [name, olds] of oldByName) {
    const all = newByName.get(name) || [];
    if (!all.length) continue;
    // The new faces of that name in each old face's paired body (any body when none of them is there).
    const pool = (o) => {
      const own = all.filter((n) => inBody(n, bodyMap[bodyRefOf(o)]));
      return own.length ? own : all;
    };
    if (olds.length === 1) {
      const o = olds[0];
      const targets = pool(o);
      keep(o, targets, 'name');
      if (targets.length === 1 && far(o, targets[0])) {
        match.movedFar += 1;
        movedFar.push({ old: faceRef(o), name, label: targets[0].label || o.label || null });
      }
      continue;
    }
    const usedNew = new Set();
    const left = [];
    for (const o of olds) {
      const hits = pool(o).filter((n) => !usedNew.has(n.id) && sameFace(o, n, tol));
      if (hits.length === 1) {
        usedNew.add(hits[0].id);
        keep(o, hits, 'name');
      } else left.push(o);
    }
    const rest = all.filter((n) => !usedNew.has(n.id));
    if (!left.length || !rest.length) continue;
    if (left.length === 1) {
      keep(left[0], rest, 'name');
    } else if (rest.length === 1) {
      for (const o of left) keep(o, rest, 'name');
      match.merged += 1;
    } else {
      const gid = `g${++g}`;
      for (const o of left) {
        faces[String(o.id)] = rest.map(faceRef);
        groups[String(o.id)] = gid;
        match.byName += 1;
      }
    }
  }
  for (const o of oldT.faces) {
    if (faces[String(o.id)] || !Array.isArray(o.centroid)) continue;
    const ref = bodyMap[bodyRefOf(o)];
    if (!ref) continue;
    const hits = newT.faces.filter((n) => bodyRefOf(n) === ref && Array.isArray(n.centroid) && sameFace(o, n, tol));
    if (hits.length === 1) keep(o, hits, 'shape');
  }
  // Merges by shape or name: several old faces on one new face.
  const into = new Map();
  for (const targets of Object.values(faces)) {
    if (targets.length !== 1) continue;
    into.set(targets[0], (into.get(targets[0]) || 0) + 1);
  }
  const merged = [...into.entries()].filter(([, n]) => n > 1).map(([label, n]) => ({ target: label, faces: n }));
  return { faces, groups, body_map: bodyMap, report: { match, merged, moved_far: movedFar } };
}
