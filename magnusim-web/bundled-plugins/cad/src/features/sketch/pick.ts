// Which profile region is under the pointer: the pointer's ray meets each drawn
// sketch's plane, the region containing that point wins (the nearest sketch
// first), unless a body face, edge or point is in front of it. A region on a
// face (a sketch on that face) is not "behind" it: the two are coplanar.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { FeatureId, Vec2, Vec3 } from '../../types/doc';
import type { SketchRegion } from '../../types/sketch';
import { rayPlane } from './plane';
import { regionAt } from './regions';
import { drawnSketches, profilesView } from './view';

export interface RegionHit {
  feature: FeatureId;
  key: string;
  region: SketchRegion;
  uv: Vec2;
  point: Vec3;
  /** Distance along the ray (mm). */
  t: number;
}

function along(p: Vec3, ray: { origin: Vec3; dir: Vec3 }): number {
  const l = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]) || 1;
  return ((p[0] - ray.origin[0]) * ray.dir[0] + (p[1] - ray.origin[1]) * ray.dir[1] + (p[2] - ray.origin[2]) * ray.dir[2]) / l;
}

/** The region under frame client coordinates (with the pointer's model ray), or null. */
export function regionUnder(services: AppServices, at: { clientX: number; clientY: number; ray: { origin: Vec3; dir: Vec3 } }, opts: { only?: FeatureId } = {}): RegionHit | null {
  const s = services.doc.state.get();
  const drawn = drawnSketches(s, services.mode.get().mode, profilesView(services).get(), services.doc.features);
  let best: RegionHit | null = null;
  for (const { feature, output } of drawn) {
    if (opts.only && feature.id !== opts.only) continue;
    const hit = rayPlane(output.plane, at.ray);
    if (!hit) continue;
    const r = regionAt(output.regions, hit.uv);
    if (!r) continue;
    if (!best || hit.t < best.t) best = { feature: feature.id, key: r.key, region: r, uv: hit.uv, point: hit.p, t: hit.t };
  }
  if (!best) return null;
  const handle = services.viewport.get().handle;
  if (!handle) return best;
  const pick = handle.pick(at.clientX, at.clientY);
  if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
    const tol = 3 * handle.pixelSize(best.point) + 1e-9;
    if (along(pick.point, at.ray) < best.t - tol) return null;
  }
  return best;
}
