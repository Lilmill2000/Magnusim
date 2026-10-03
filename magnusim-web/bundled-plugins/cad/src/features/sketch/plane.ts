// Where a sketch lies: an origin plane, or a planar face found again at every
// rebuild through its stored reference (proposal §4.5 point 5: when the face
// is lost the sketch keeps its stored plane and says so). Also the plane <->
// model conversions the overlays use.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { ORIGIN_PLANES, type PlaneFrame, type SketchFeature, type Vec2, type Vec3 } from '../../types/doc';
import type { BuildContext } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import { kernelLookup } from '../../naming/refs';
import { resolveFace } from '../../naming/resolve';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/**
 * The frame of a sketch on a planar face (docs/p2p3-plan.md §1.7): origin =
 * the global origin projected onto the face's plane; normal = the face's
 * outward normal; xdir = global X projected onto the plane, or global Y when X
 * is within 1 degree of the normal. Sketch mode uses the same frame for a new
 * sketch on a face.
 */
export function faceFrame(normal: Vec3, pointOnPlane: Vec3): PlaneFrame {
  const n = unit(normal);
  const origin = sub([0, 0, 0], scale(n, dot(sub([0, 0, 0], pointOnPlane), n)));
  const cos1 = Math.cos((1 * Math.PI) / 180);
  const seed: Vec3 = Math.abs(n[0]) > cos1 ? [0, 1, 0] : [1, 0, 0];
  const x = unit(sub(seed, scale(n, dot(seed, n))));
  return { origin: origin.map((v) => (Object.is(v, -0) ? 0 : v)) as Vec3, normal: n, xdir: x };
}

/** The plane's own y direction (normal x xdir). */
export function ydirOf(plane: PlaneFrame): Vec3 {
  return cross(unit(plane.normal), unit(plane.xdir));
}

/** A sketch point (mm, u/v) in model coordinates. */
export function toModel(plane: PlaneFrame, uv: Vec2): Vec3 {
  const x = unit(plane.xdir);
  const y = ydirOf(plane);
  return [plane.origin[0] + x[0] * uv[0] + y[0] * uv[1], plane.origin[1] + x[1] * uv[0] + y[1] * uv[1], plane.origin[2] + x[2] * uv[0] + y[2] * uv[1]];
}

/** A model point projected into the plane's u/v. */
export function toSketch(plane: PlaneFrame, p: Vec3): Vec2 {
  const d = sub(p, plane.origin);
  return [dot(d, unit(plane.xdir)), dot(d, ydirOf(plane))];
}

/** Where a ray meets the plane: the distance along the (unit) ray and the u/v there, or null when it runs parallel or behind. */
export function rayPlane(plane: PlaneFrame, ray: { origin: Vec3; dir: Vec3 }): { t: number; uv: Vec2; p: Vec3 } | null {
  const n = unit(plane.normal);
  const d = unit(ray.dir);
  const denom = dot(d, n);
  if (Math.abs(denom) < 1e-12) return null;
  const t = dot(sub(plane.origin, ray.origin), n) / denom;
  if (!(t >= 0)) return null;
  const p: Vec3 = [ray.origin[0] + d[0] * t, ray.origin[1] + d[1] * t, ray.origin[2] + d[2] * t];
  return { t, uv: toSketch(plane, p), p };
}

export interface ResolvedPlane {
  plane: PlaneFrame;
  /** The face support was not found (or is no longer flat): the stored plane is used. */
  lost: boolean;
  /** Amber words for the feature (a repaired face reference, a lost face). */
  warning?: string;
}

/**
 * The sketch's plane at this rebuild. An origin plane is fixed. A face is
 * resolved by its stored reference on the support body; when that fails the
 * stored plane is kept and the sketch warns ("Sketch 2 lost its face: it stays
 * where it was"). Kernel stops (watchdog, crash) propagate to the rebuild.
 */
export async function resolveSupport(f: Pick<SketchFeature, 'name' | 'support' | 'plane'>, ctx: Pick<BuildContext, 'bodies' | 'kernel'>): Promise<ResolvedPlane> {
  const s = f.support;
  if (s.kind === 'plane') {
    const p = ORIGIN_PLANES[s.plane];
    if (!p) return { plane: f.plane, lost: true, warning: `${f.name} lost its plane: it stays where it was` };
    return { plane: { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 }, lost: false };
  }
  // The plan's words (docs/p2p3-plan.md §1.7); why it was lost does not change what the user can do.
  const lost = (_why: string): ResolvedPlane => ({ plane: f.plane, lost: true, warning: `${f.name} lost its face: it stays where it was` });
  const body = ctx.bodies.get(s.body);
  if (!body) return lost('its body is not there at this point');
  if (!body.names) return lost('its body has no face names');
  const lookup = kernelLookup(ctx.kernel);
  try {
    const r = await resolveFace({ ref: s.face, shape: body.shape, names: body.names, lookup });
    if (!r.ok) return lost(r.message);
    const [face] = await lookup.faces(body.shape, [r.index]);
    if (!face || face.type !== 'plane' || !face.normal || !face.centroid) return lost('the face is no longer flat');
    return { plane: faceFrame(face.normal as Vec3, face.centroid as Vec3), lost: false, ...(r.how !== 'name' ? { warning: `${f.name}: ${r.warning ?? 'Reference repaired · check'}` } : {}) };
  } catch (err) {
    const e = err as KernelCallError;
    if (e.kind === 'occt' || e.kind === 'input' || e.kind === 'internal') return lost(e.message);
    throw err;
  }
}
