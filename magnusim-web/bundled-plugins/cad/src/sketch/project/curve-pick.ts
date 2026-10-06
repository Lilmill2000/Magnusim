// Picking a shown sketch by its curves in model mode (P4b fix round 1, polish 6): a sketch with no
// closed profile has no region to click, so it could not be selected in the view, and its right-click
// offered no "Normal to". A click within 8 px of one of its curves (lines, arcs, circles, splines,
// points) selects the sketch, as its tree row does; a right-click selects it and opens the view's menu
// with "Normal to Sketch N". A body in front of the curve hides it. Profiles keep their own tool (a
// click inside a region picks the region), which runs first.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { selectItem } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import type { FeatureId, Vec2, Vec3 } from '../../types/doc';
import type { ViewportTool } from '../../types/viewport';
import { entityGeometry, type EntityGeom } from '../../features/sketch/geometry';
import { regionUnder } from '../../features/sketch/pick';
import { rayPlane } from '../../features/sketch/plane';
import { drawnSketches, profilesView } from '../../features/sketch/view';

export const CURVE_PICK_PX = 8;

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function angleIn(a: number, a0: number, a1: number, ccw: boolean): boolean {
  const norm = (x: number) => ((x % 360) + 360) % 360;
  const s = ccw ? norm(a0) : norm(a1);
  const e = ccw ? norm(a1) : norm(a0);
  const x = norm(a);
  return s <= e ? x >= s && x <= e : x >= s || x <= e;
}

/** Distance (sketch mm) from a point to an entity's curve. */
export function curveDistance(g: EntityGeom, p: Vec2): number {
  switch (g.kind) {
    case 'point':
      return Math.hypot(p[0] - g.p[0], p[1] - g.p[1]);
    case 'line':
      return segDist(p, g.a, g.b);
    case 'circle':
      return Math.abs(Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r);
    case 'arc': {
      const ang = (Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) * 180) / Math.PI;
      if (angleIn(ang, g.a0, g.a1, g.ccw)) return Math.abs(Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) - g.r);
      return Math.min(Math.hypot(p[0] - g.a[0], p[1] - g.a[1]), Math.hypot(p[0] - g.b[0], p[1] - g.b[1]));
    }
    case 'spline': {
      let d = Infinity;
      for (let i = 1; i < g.poly.length; i++) d = Math.min(d, segDist(p, g.poly[i - 1], g.poly[i]));
      return d;
    }
  }
}

/** The shown sketch whose curve is under the pointer (model mode), or null. */
export function sketchCurveUnder(services: AppServices, at: { clientX: number; clientY: number; ray: { origin: Vec3; dir: Vec3 } }): { feature: FeatureId; t: number } | null {
  if (services.mode.get().mode !== 'model') return null;
  const handle = services.viewport.get().handle;
  if (!handle) return null;
  const s = services.doc.state.get();
  let best: { feature: FeatureId; t: number } | null = null;
  for (const { feature, output } of drawnSketches(s, 'model', profilesView(services).get(), services.doc.features)) {
    const hit = rayPlane(output.plane, at.ray);
    if (!hit) continue;
    const tol = CURVE_PICK_PX * handle.pixelSize(hit.p);
    let geom: EntityGeom[];
    try {
      geom = entityGeometry(output.entities ? { entities: output.entities } : feature, output.points, output.radii);
    } catch {
      continue;
    }
    if (!geom.some((g) => curveDistance(g, hit.uv) <= tol)) continue;
    if (!best || hit.t < best.t) best = { feature: feature.id, t: hit.t };
  }
  if (!best) return null;
  // A body in front hides the sketch there.
  const pick = handle.pick(at.clientX, at.clientY);
  if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex') && pick.depth < best.t - 1e-6 * Math.max(1, best.t)) return null;
  return best;
}

export function sketchCurveTool(services: AppServices): ViewportTool {
  return {
    id: 'sketch.curve-pick',
    onPointer(e) {
      if (e.type !== 'click' && e.type !== 'contextmenu') return false;
      if (e.type === 'click' && e.button !== 0) return false;
      // A profile under the pointer is the region tool's (it picks the region).
      if (regionUnder(services, e)) return false;
      const hit = sketchCurveUnder(services, e);
      if (!hit) return false;
      const item = { kind: 'feature' as const, feature: hit.feature };
      if (e.type === 'click') {
        selectItem(services.selection, item, e.ctrl);
        return true;
      }
      selectItem(services.selection, item, false);
      services.bus.emit('viewport:contextmenu', { pick: null, clientX: e.clientX, clientY: e.clientY });
      return true;
    },
  };
}
