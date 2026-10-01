// Geometry from the kernel's tessellation buffers (kernel `tessellate`, see
// TessPayload): one BufferGeometry per body that shares the kernel's arrays,
// plus the lookups picking and highlighting need (triangle -> face, the vertex
// span of each face, per-edge bounding spheres, the volume centroid). Edges the
// kernel flags as not model edges (EDGE_HIDDEN: seams, poles, internal and
// same-domain edges) are neither drawn nor picked.
// Owner: VIEWPORT. No three.js renderer here: this runs in unit tests.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import type { Vec3 } from '../types/doc';
import type { TessPayload } from '../types/kernel';
import { EDGE_HIDDEN } from '../types/kernel-protocol';

/** Per-vertex highlight state (attribute `hl`): what colour a face's vertices take. */
export const HL_NONE = 0;
export const HL_HOVER = 1;
export const HL_PICK = 2;

export interface BodyData {
  geometry: BufferGeometry;
  /** The `hl` attribute (one byte per vertex). */
  hl: BufferAttribute;
  faces: number;
  triangles: number;
  tess: TessPayload;
  /** Faces' triangle spans are in face order (the kernel writes them so); otherwise triFace is set. */
  sortedFaces: boolean;
  triFace: Uint32Array | null;
  /** faceVerts[2k], faceVerts[2k+1]: first vertex and vertex count of face k (the kernel writes each face's nodes together). */
  faceVerts: Uint32Array;
  edges: number;
  /** Per edge: centre xyz and radius of a sphere around its polyline (radius -1: not pickable, no points or hidden). */
  edgeSpheres: Float32Array;
  /** Segment pairs of the drawn edges (the kernel's array when no edge is hidden). */
  drawEdges: Float32Array;
  /** Edges the kernel flags as not model edges. */
  hiddenEdges: number;
  bounds: Box3;
  sphere: Sphere;
}

/**
 * Build a body's geometry and lookups. The geometry uses the kernel's arrays
 * directly (no copy); `hl` is new. Throws on buffers that do not fit together.
 */
export function buildBodyData(tess: TessPayload): BodyData {
  const { positions, normals, indices, faceRanges, edgePositions, edgeRanges } = tess;
  const nVerts = positions.length / 3;
  if (positions.length % 3 || normals.length !== positions.length) throw new Error('tessellation: positions and normals differ in length');
  if (indices.length % 3) throw new Error('tessellation: indices are not triangles');
  if (faceRanges.length % 2) throw new Error('tessellation: face ranges are not pairs');
  const faces = faceRanges.length / 2;
  const triangles = indices.length / 3;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  const hl = new BufferAttribute(new Uint8Array(nVerts), 1);
  geometry.setAttribute('hl', hl);
  geometry.setIndex(new BufferAttribute(indices, 1));

  // Face spans: sorted by start (the kernel's order), each a whole number of triangles.
  let sortedFaces = true;
  let prevEnd = 0;
  for (let k = 0; k < faces; k++) {
    const s = faceRanges[2 * k];
    const c = faceRanges[2 * k + 1];
    if (s % 3 || c % 3 || s + c > indices.length) throw new Error(`tessellation: face ${k} range is not whole triangles`);
    if (s < prevEnd && c > 0) sortedFaces = false;
    if (c > 0) prevEnd = s + c;
  }
  let triFace: Uint32Array | null = null;
  if (!sortedFaces) {
    triFace = new Uint32Array(triangles);
    for (let k = 0; k < faces; k++) triFace.fill(k, faceRanges[2 * k] / 3, (faceRanges[2 * k] + faceRanges[2 * k + 1]) / 3);
  }

  // The vertex span of each face (min..max index it uses).
  const faceVerts = new Uint32Array(2 * faces);
  for (let k = 0; k < faces; k++) {
    const s = faceRanges[2 * k];
    const c = faceRanges[2 * k + 1];
    if (!c) continue;
    let lo = 0xffffffff;
    let hi = 0;
    for (let i = s; i < s + c; i++) {
      const v = indices[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi >= nVerts) throw new Error(`tessellation: face ${k} uses vertex ${hi} of ${nVerts}`);
    faceVerts[2 * k] = lo;
    faceVerts[2 * k + 1] = hi - lo + 1;
  }

  // Edge bounding spheres (centre of the edge's box, radius to its farthest point).
  const edges = edgeRanges.length / 2;
  const flags = tess.edgeFlags && tess.edgeFlags.length === edges ? tess.edgeFlags : null;
  const hidden = (e: number) => !!flags && (flags[e] & EDGE_HIDDEN) !== 0;
  const edgeSpheres = new Float32Array(4 * edges);
  let hiddenEdges = 0;
  for (let e = 0; e < edges; e++) {
    const s = edgeRanges[2 * e];
    const n = edgeRanges[2 * e + 1];
    if (hidden(e)) hiddenEdges++;
    if (!n || hidden(e)) {
      edgeSpheres[4 * e + 3] = -1;
      continue;
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let p = s; p < s + n; p++) {
      const x = edgePositions[3 * p], y = edgePositions[3 * p + 1], z = edgePositions[3 * p + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r2 = 0;
    for (let p = s; p < s + n; p++) {
      const dx = edgePositions[3 * p] - cx, dy = edgePositions[3 * p + 1] - cy, dz = edgePositions[3 * p + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) r2 = d2;
    }
    edgeSpheres.set([cx, cy, cz, Math.sqrt(r2)], 4 * e);
  }

  let drawEdges = edgePositions;
  if (hiddenEdges) {
    let total = 0;
    for (let e = 0; e < edges; e++) if (!hidden(e)) total += edgeRanges[2 * e + 1];
    drawEdges = new Float32Array(3 * total);
    let o = 0;
    for (let e = 0; e < edges; e++) {
      if (hidden(e)) continue;
      const s = edgeRanges[2 * e];
      const n = edgeRanges[2 * e + 1];
      drawEdges.set(edgePositions.subarray(3 * s, 3 * (s + n)), o);
      o += 3 * n;
    }
  }

  const bounds = new Box3();
  if (nVerts) bounds.setFromArray(positions);
  if (edgePositions.length) bounds.union(new Box3().setFromArray(edgePositions));
  const sphere = new Sphere();
  if (!bounds.isEmpty()) bounds.getBoundingSphere(sphere);
  geometry.boundingBox = bounds.clone();
  geometry.boundingSphere = sphere.clone();

  return { geometry, hl, faces, triangles, tess, sortedFaces, triFace, faceVerts, edges, edgeSpheres, drawEdges, hiddenEdges, bounds, sphere };
}

/** The B-rep face a triangle belongs to (triangle index in `indices` / 3), or -1. */
export function faceOfTriangle(data: Pick<BodyData, 'tess' | 'sortedFaces' | 'triFace' | 'faces'>, tri: number): number {
  if (data.triFace) return tri >= 0 && tri < data.triFace.length ? data.triFace[tri] : -1;
  const r = data.tess.faceRanges;
  const at = 3 * tri;
  // The last face whose start is <= at (zero-length faces share their successor's start).
  let lo = 0;
  let hi = data.faces - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r[2 * mid] <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  return at < r[2 * found] + r[2 * found + 1] ? found : -1;
}

/** Segment-pair positions of one edge (a view into the kernel's buffer). */
export function edgeSegments(data: Pick<BodyData, 'tess'>, edge: number): Float32Array {
  const { edgePositions, edgeRanges } = data.tess;
  const s = edgeRanges[2 * edge];
  const n = edgeRanges[2 * edge + 1];
  return edgePositions.subarray(3 * s, 3 * (s + n));
}

/**
 * The normal of a face when all its vertex normals agree (a planar face), in
 * the face's outward orientation; null for a curved face or one without triangles.
 */
export function planarFaceNormal(data: Pick<BodyData, 'tess' | 'faceVerts' | 'faces'>, face: number, tolDeg = 0.5): Vec3 | null {
  if (face < 0 || face >= data.faces) return null;
  const first = data.faceVerts[2 * face];
  const count = data.faceVerts[2 * face + 1];
  if (!count) return null;
  const n = data.tess.normals;
  let x = 0, y = 0, z = 0;
  for (let v = first; v < first + count; v++) {
    x += n[3 * v];
    y += n[3 * v + 1];
    z += n[3 * v + 2];
  }
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return null;
  x /= len;
  y /= len;
  z /= len;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  for (let v = first; v < first + count; v++) {
    const d = n[3 * v] * x + n[3 * v + 1] * y + n[3 * v + 2] * z;
    const l = Math.hypot(n[3 * v], n[3 * v + 1], n[3 * v + 2]) || 1;
    if (d / l < cosTol) return null;
  }
  return [x, y, z];
}

/**
 * Volume centroid of closed triangle meshes (divergence theorem), falling back
 * to the area-weighted surface centroid for open shells; null when empty.
 * The core pivots its orbit about this point (runtime.js:9214-9265).
 */
export function meshCentroid(bodies: { positions: Float32Array; indices: Uint32Array }[]): Vec3 | null {
  let vol = 0;
  let cvx = 0, cvy = 0, cvz = 0;
  let area = 0;
  let cax = 0, cay = 0, caz = 0;
  let n = 0;
  for (const { positions: p, indices: ix } of bodies) {
    for (let t = 0; t < ix.length; t += 3) {
      const a = 3 * ix[t], b = 3 * ix[t + 1], c = 3 * ix[t + 2];
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      vol += v;
      cvx += (v * (ax + bx + cx)) / 4;
      cvy += (v * (ay + by + cy)) / 4;
      cvz += (v * (az + bz + cz)) / 4;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const wx = cx - ax, wy = cy - ay, wz = cz - az;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      area += ar;
      cax += (ar * (ax + bx + cx)) / 3;
      cay += (ar * (ay + by + cy)) / 3;
      caz += (ar * (az + bz + cz)) / 3;
      n++;
    }
  }
  if (!n) return null;
  if (area > 0 && Math.abs(vol) > 1e-6 * Math.pow(area, 1.5)) return [cvx / vol, cvy / vol, cvz / vol];
  if (area > 0) return [cax / area, cay / area, caz / area];
  return null;
}

/** Set the `hl` state of one face's vertices; returns false when nothing changed. */
export function setFaceHl(data: BodyData, face: number, value: number): boolean {
  if (face < 0 || face >= data.faces) return false;
  const first = data.faceVerts[2 * face];
  const count = data.faceVerts[2 * face + 1];
  if (!count) return false;
  const arr = data.hl.array as Uint8Array;
  if (arr[first] === value && arr[first + count - 1] === value) return false;
  arr.fill(value, first, first + count);
  data.hl.addUpdateRange(first, count);
  data.hl.needsUpdate = true;
  return true;
}

/** A plain Vector3 from a buffer triple. */
export function vecAt(a: Float32Array, i: number, out = new Vector3()): Vector3 {
  return out.set(a[3 * i], a[3 * i + 1], a[3 * i + 2]);
}
