// Picking: what is under the pointer. Faces by BVH raycast (triangle -> B-rep
// face through the kernel's face ranges); edges and vertices in screen space
// within PICK_TOL_PX, hidden ones rejected by a ray test; origin planes by
// ray/square intersection. Priority: vertex, edge, face (or its body), plane.
// Pure over three's math: the renderer is not needed (unit-tested).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DoubleSide, Matrix4, Ray, Vector3, Vector4, type Camera, type Plane } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { BodyId, OriginPlaneRef, Vec3 } from '../types/doc';
import type { PickResult, SelectKind } from '../types/selection';
import { PICK_TOL_PX, VERTEX_BONUS_PX } from './colors';
import { faceOfTriangle, type BodyData } from './tess';

export interface PickBody {
  id: BodyId;
  data: BodyData;
  bvh: MeshBVH | null;
  /** B-rep vertex positions (kernel order), or null when unknown. */
  vertices: Float32Array | null;
  /** Drawn see-through (ViewportBody.seeThrough): it hides nothing, and a face behind it wins. */
  seeThrough?: boolean;
}

export interface PickPlane {
  ref: OriginPlaneRef;
  /** The drawn square's centre (on the plane, which passes through the origin). */
  origin: Vector3;
  normal: Vector3;
  u: Vector3;
  v: Vector3;
  half: number;
}

/** The camera and viewport a pick runs against (CSS px, origin top-left of the viewport). */
export interface PickView {
  camera: Camera;
  width: number;
  height: number;
  /** World units per CSS px at a point. */
  worldPerPixel(p: Vector3): number;
  /** The section plane (kept side: plane.distanceToPoint >= 0), or null. */
  clip: Plane | null;
  /** Surfaces hide what is behind them (false in wireframe). */
  occlude: boolean;
  /** Faces can be hit (false in wireframe: no surfaces are drawn). */
  faces: boolean;
}

export type PickKinds = ReadonlySet<SelectKind>;

/** The kinds a click may pick for a selection filter (empty = faces, edges, vertices, planes). */
export function kindsForFilter(filter: readonly SelectKind[]): PickKinds {
  return new Set<SelectKind>(filter.length ? filter : ['face', 'edge', 'vertex', 'origin']);
}

export interface FaceHit {
  body: PickBody;
  tri: number;
  face: number;
  point: Vector3;
  distance: number;
  /**
   * The ray met the section cap first (it entered material at the cut): the
   * cap hides what is behind it and is not a B-rep face (not selectable).
   */
  cap: boolean;
}

const _ray = new Ray();
const _v = new Vector3();
const _v2 = new Vector3();
const _v4 = new Vector4();
const _vp = new Matrix4();

/** The pick ray through viewport pixel (x, y). */
export function rayAt(view: PickView, x: number, y: number, out = new Ray()): Ray {
  const cam = view.camera;
  const nx = (x / view.width) * 2 - 1;
  const ny = 1 - (y / view.height) * 2;
  const isOrtho = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera;
  if (isOrtho) {
    out.origin.set(nx, ny, -1).unproject(cam);
    out.direction.set(0, 0, -1).transformDirection(cam.matrixWorld);
  } else {
    out.origin.setFromMatrixPosition(cam.matrixWorld);
    out.direction.set(nx, ny, 0.5).unproject(cam).sub(out.origin).normalize();
  }
  return out;
}

/** Screen projector for one pick (caches the view-projection matrix). */
export function makeProjector(view: PickView) {
  _vp.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse);
  const e = _vp.elements.slice();
  const w = view.width;
  const h = view.height;
  /** World point to viewport px; null behind the camera. */
  return (x: number, y: number, z: number, out: [number, number]): boolean => {
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-9) return false;
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    out[0] = ((cx + 1) / 2) * w;
    out[1] = ((1 - cy) / 2) * h;
    return true;
  };
}

function kept(view: PickView, p: Vector3, eps = 0): boolean {
  return !view.clip || view.clip.distanceToPoint(p) >= -eps;
}

/**
 * Nearest face hit along a ray over all bodies (respecting the section plane), or null. A face of
 * an opaque body wins over a see-through body's nearer face (it is seen through it); a see-through
 * body's face is hit where nothing opaque is behind it.
 */
export function raycastBodies(bodies: readonly PickBody[], ray: Ray, view: PickView): FaceHit | null {
  if (!bodies.some((b) => b.seeThrough)) return nearestFace(bodies, ray, view);
  return nearestFace(bodies.filter((b) => !b.seeThrough), ray, view) ?? nearestFace(bodies.filter((b) => b.seeThrough), ray, view);
}

function nearestFace(bodies: readonly PickBody[], ray: Ray, view: PickView): FaceHit | null {
  let best: FaceHit | null = null;
  for (const b of bodies) {
    if (!b.bvh) continue;
    let hit: { point: Vector3; distance: number; faceIndex?: number | null } | null = null;
    if (view.clip) {
      const hits = b.bvh.raycast(ray, DoubleSide);
      hits.sort((a, c) => a.distance - c.distance);
      hit = hits.find((h) => kept(view, h.point)) ?? null;
    } else {
      hit = b.bvh.raycastFirst(ray, DoubleSide);
    }
    if (!hit || hit.faceIndex == null) continue;
    const face = faceOfTriangle(b.data, hit.faceIndex);
    if (face < 0) continue;
    let cap = false;
    let point = hit.point.clone();
    let distance = hit.distance;
    if (view.clip) {
      // Seeing the inside of a face means the ray crossed the cut inside material: the cap is there.
      const n = triangleNormal(b.data, hit.faceIndex, point);
      if (n[0] * ray.direction.x + n[1] * ray.direction.y + n[2] * ray.direction.z > 0) {
        const t = ray.distanceToPlane(view.clip);
        if (t !== null && t <= distance) {
          cap = true;
          distance = t;
          point = ray.at(t, new Vector3());
        }
      }
    }
    if (best && distance >= best.distance) continue;
    best = { body: b, tri: hit.faceIndex, face, point, distance, cap };
  }
  return best;
}

/** Whether a model point is visible from the camera (not behind a surface, not cut away). */
export function pointVisible(bodies: readonly PickBody[], view: PickView, p: Vector3, slack: number): boolean {
  if (!kept(view, p, slack)) return false;
  if (!view.occlude) return true;
  const cam = view.camera;
  const isOrtho = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera;
  if (isOrtho) {
    _ray.direction.set(0, 0, -1).transformDirection(cam.matrixWorld);
    _ray.origin.copy(p).addScaledVector(_ray.direction, -1e6);
  } else {
    _ray.origin.setFromMatrixPosition(cam.matrixWorld);
    _ray.direction.subVectors(p, _ray.origin).normalize();
  }
  const tP = _v2.subVectors(p, _ray.origin).dot(_ray.direction);
  // A see-through body hides nothing.
  const hit = nearestFace(bodies.some((b) => b.seeThrough) ? bodies.filter((b) => !b.seeThrough) : bodies, _ray, view);
  return !hit || tP <= hit.distance + slack;
}

/** Closest point on segment ab to a ray (for an edge pick's model point). */
export function closestOnSegmentToRay(ray: Ray, a: Vector3, b: Vector3, out = new Vector3()): Vector3 {
  const d1 = _v.subVectors(b, a);
  const d2 = ray.direction;
  const r = _v2.subVectors(a, ray.origin);
  const aa = d1.dot(d1);
  const bb = d1.dot(d2);
  const cc = d2.dot(d2);
  const dd = d1.dot(r);
  const ee = d2.dot(r);
  const den = aa * cc - bb * bb;
  let s = den > 1e-12 ? (bb * ee - cc * dd) / den : 0;
  s = Math.max(0, Math.min(1, s));
  return out.copy(a).addScaledVector(d1, s);
}

/** Squared distance from p to segment ab in 2D, and the segment parameter. */
export function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d2: number; u: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let u = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  u = Math.max(0, Math.min(1, u));
  const qx = ax + u * dx - px;
  const qy = ay + u * dy - py;
  return { d2: qx * qx + qy * qy, u };
}

interface Candidate {
  body: PickBody;
  index: number;
  d: number;
  point: Vector3;
}

/** Vertices within `tol` px of (x, y), nearest first. */
export function vertexCandidates(bodies: readonly PickBody[], view: PickView, x: number, y: number, tol: number): Candidate[] {
  const proj = makeProjector(view);
  const s: [number, number] = [0, 0];
  const out: Candidate[] = [];
  const tol2 = tol * tol;
  for (const b of bodies) {
    const vs = b.vertices;
    if (!vs) continue;
    for (let i = 0; i < vs.length / 3; i++) {
      if (!proj(vs[3 * i], vs[3 * i + 1], vs[3 * i + 2], s)) continue;
      const dx = s[0] - x;
      const dy = s[1] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= tol2) out.push({ body: b, index: i, d: Math.sqrt(d2), point: new Vector3(vs[3 * i], vs[3 * i + 1], vs[3 * i + 2]) });
    }
  }
  return out.sort((a, c) => a.d - c.d);
}

/** Edges within `tol` px of (x, y) (their nearest point), nearest first. */
export function edgeCandidates(bodies: readonly PickBody[], view: PickView, x: number, y: number, tol: number, ray: Ray): Candidate[] {
  const proj = makeProjector(view);
  const a: [number, number] = [0, 0];
  const c: [number, number] = [0, 0];
  const tol2 = tol * tol;
  const out: Candidate[] = [];
  const pa = new Vector3();
  const pb = new Vector3();
  for (const b of bodies) {
    const { edgeSpheres, edges, tess } = b.data;
    const ep = tess.edgePositions;
    const er = tess.edgeRanges;
    for (let e = 0; e < edges; e++) {
      const r = edgeSpheres[4 * e + 3];
      if (r < 0) continue;
      // Cheap reject: the pointer is farther than the edge's sphere on screen.
      _v.set(edgeSpheres[4 * e], edgeSpheres[4 * e + 1], edgeSpheres[4 * e + 2]);
      if (proj(_v.x, _v.y, _v.z, c)) {
        const rs = r / Math.max(view.worldPerPixel(_v), 1e-12);
        const dx = c[0] - x;
        const dy = c[1] - y;
        if (dx * dx + dy * dy > (rs + tol) * (rs + tol)) continue;
      }
      const s = er[2 * e];
      const n = er[2 * e + 1];
      let best = Infinity;
      let bestSeg = -1;
      for (let p = s; p + 1 < s + n; p += 2) {
        const okA = proj(ep[3 * p], ep[3 * p + 1], ep[3 * p + 2], a);
        const okB = proj(ep[3 * p + 3], ep[3 * p + 4], ep[3 * p + 5], c);
        if (!okA || !okB) continue;
        const { d2 } = distToSegment2(x, y, a[0], a[1], c[0], c[1]);
        if (d2 < best) {
          best = d2;
          bestSeg = p;
        }
      }
      if (bestSeg < 0 || best > tol2) continue;
      pa.set(ep[3 * bestSeg], ep[3 * bestSeg + 1], ep[3 * bestSeg + 2]);
      pb.set(ep[3 * bestSeg + 3], ep[3 * bestSeg + 4], ep[3 * bestSeg + 5]);
      out.push({ body: b, index: e, d: Math.sqrt(best), point: closestOnSegmentToRay(ray, pa, pb) });
    }
  }
  return out.sort((p, q) => p.d - q.d);
}

/** The nearest origin plane square the ray passes through, or null. */
export function pickPlanes(planes: readonly PickPlane[], ray: Ray): { plane: PickPlane; point: Vector3; distance: number } | null {
  let best: { plane: PickPlane; point: Vector3; distance: number } | null = null;
  for (const pl of planes) {
    const denom = pl.normal.dot(ray.direction);
    if (Math.abs(denom) < 1e-9) continue;
    const t = _v.subVectors(pl.origin, ray.origin).dot(pl.normal) / denom;
    if (t < 0) continue;
    const p = ray.at(t, new Vector3());
    const rel = _v2.subVectors(p, pl.origin);
    if (Math.abs(rel.dot(pl.u)) > pl.half || Math.abs(rel.dot(pl.v)) > pl.half) continue;
    if (!best || t < best.distance) best = { plane: pl, point: p, distance: t };
  }
  return best;
}

function slackFor(view: PickView, b: PickBody, p: Vector3): number {
  return 4 * view.worldPerPixel(p) + 2.5e-3 * b.data.sphere.radius;
}

function vec(p: Vector3): Vec3 {
  return [p.x, p.y, p.z];
}

/**
 * What a click at viewport pixel (x, y) picks, or null. `kinds` from the
 * selection filter (kindsForFilter). Bodies with no BVH yet are not hit.
 */
export function pickAt(bodies: readonly PickBody[], planes: readonly PickPlane[], view: PickView, x: number, y: number, kinds: PickKinds, tolPx = PICK_TOL_PX): PickResult | null {
  const ray = rayAt(view, x, y, new Ray());
  const proj = makeProjector(view);
  const screen = (p: Vector3): [number, number] => {
    const s: [number, number] = [x, y];
    proj(p.x, p.y, p.z, s);
    return s;
  };
  const depthOf = (p: Vector3) => _v.subVectors(p, ray.origin).dot(ray.direction);

  let vtx: Candidate | null = null;
  if (kinds.has('vertex')) {
    for (const c of vertexCandidates(bodies, view, x, y, tolPx)) {
      if (pointVisible(bodies, view, c.point, slackFor(view, c.body, c.point))) {
        vtx = c;
        break;
      }
    }
  }
  let edge: Candidate | null = null;
  if (kinds.has('edge')) {
    for (const c of edgeCandidates(bodies, view, x, y, tolPx, ray)) {
      if (vtx && c.d > vtx.d + VERTEX_BONUS_PX) break;
      if (pointVisible(bodies, view, c.point, slackFor(view, c.body, c.point))) {
        edge = c;
        break;
      }
    }
  }
  if (vtx && (!edge || vtx.d - VERTEX_BONUS_PX <= edge.d)) {
    return { item: { kind: 'vertex', body: vtx.body.id, index: vtx.index }, point: vec(vtx.point), normal: null, depth: depthOf(vtx.point), screen: screen(vtx.point) };
  }
  if (edge) {
    return { item: { kind: 'edge', body: edge.body.id, index: edge.index }, point: vec(edge.point), normal: null, depth: depthOf(edge.point), screen: screen(edge.point) };
  }

  const surfaces = view.faces && (kinds.has('face') || kinds.has('body'));
  const hit = surfaces ? raycastBodies(bodies, ray, view) : null;
  if (hit && hit.cap) return null;
  if (hit) {
    const n = triangleNormal(hit.body.data, hit.tri, hit.point);
    const item = kinds.has('face') ? ({ kind: 'face', body: hit.body.id, index: hit.face } as const) : ({ kind: 'body', body: hit.body.id } as const);
    return { item, point: vec(hit.point), normal: n, depth: hit.distance, screen: screen(hit.point) };
  }
  if (kinds.has('origin')) {
    const pl = pickPlanes(planes, ray);
    if (pl) return { item: { kind: 'origin', ref: pl.plane.ref }, point: vec(pl.point), normal: vec(pl.plane.normal), depth: pl.distance, screen: screen(pl.point) };
  }
  return null;
}

/** The interpolated (outward) vertex normal of a triangle at a point on it. */
export function triangleNormal(data: BodyData, tri: number, p: Vector3): Vec3 {
  const ix = data.tess.indices;
  const pos = data.tess.positions;
  const nr = data.tess.normals;
  const ia = ix[3 * tri], ib = ix[3 * tri + 1], ic = ix[3 * tri + 2];
  const a = new Vector3(pos[3 * ia], pos[3 * ia + 1], pos[3 * ia + 2]);
  const b = new Vector3(pos[3 * ib], pos[3 * ib + 1], pos[3 * ib + 2]);
  const c = new Vector3(pos[3 * ic], pos[3 * ic + 1], pos[3 * ic + 2]);
  // Barycentric weights of p.
  const v0 = b.clone().sub(a);
  const v1 = c.clone().sub(a);
  const v2 = p.clone().sub(a);
  const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1), d20 = v2.dot(v0), d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01;
  let wb = 1 / 3, wc = 1 / 3;
  if (Math.abs(den) > 1e-20) {
    wb = (d11 * d20 - d01 * d21) / den;
    wc = (d00 * d21 - d01 * d20) / den;
  }
  const wa = 1 - wb - wc;
  _v4.set(
    wa * nr[3 * ia] + wb * nr[3 * ib] + wc * nr[3 * ic],
    wa * nr[3 * ia + 1] + wb * nr[3 * ib + 1] + wc * nr[3 * ic + 1],
    wa * nr[3 * ia + 2] + wb * nr[3 * ib + 2] + wc * nr[3 * ic + 2],
    0,
  );
  const len = Math.hypot(_v4.x, _v4.y, _v4.z) || 1;
  return [_v4.x / len, _v4.y / len, _v4.z / len];
}
