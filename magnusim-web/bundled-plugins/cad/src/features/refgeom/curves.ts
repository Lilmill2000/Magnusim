// A curve at a rebuild, whatever it is: an edge of a body (the kernel's
// edge_eval) or a line, arc or circle of a sketch (analytic, in its plane: a
// Sweep path's curve). What the CONSTRUCT features ask of it: its length, the
// point and tangent at a fraction of it or a distance from either end, and the
// point of it nearest a given point (Plane normal to a curve at a point).
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, Vec2, Vec3 } from '../../types/doc';
import type { BuildContext } from '../../types/doc-service';
import type { CurveRef } from '../../types/references';
import type { SketchOutput } from '../../types/sketch';
import type { EntityGeom } from '../sketch/geometry';
import { toSketch } from '../sketch/plane';
import { geometryOf, sketchCurveFrame } from '../solids/geom';
import { edgeNearest, edgePoint, type EdgeAt } from './brep';
import { dist } from './geom';
import { resolveEdgeRef, type Resolved } from './resolve';

export interface CurveNow {
  length: number;
  /** Where along it: a fraction (0..1) or a distance (mm) from its start, or from its end. */
  at(where: EdgeAt): Promise<{ point: Vec3; tangent: Vec3 }>;
  /** The point of it nearest `p`, the tangent there, and how far `p` is from it. */
  nearest(p: Vec3): Promise<{ point: Vec3; tangent: Vec3; distance: number } | null>;
  /** A body edge: its kernel shape and index (crossings with a plane); a sketch curve: null. */
  edge: { shape: number; index: number } | null;
}

const DEG = Math.PI / 180;

/** A sketch curve's length (mm). */
function sketchLength(g: EntityGeom): number {
  if (g.kind === 'line') return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
  if (g.kind === 'circle') return 2 * Math.PI * g.r;
  if (g.kind === 'arc') {
    const d = (((g.a1 - g.a0) % 360) + 360) % 360;
    const sweep = g.ccw ? d || 360 : (360 - d) % 360 || 360;
    return g.r * sweep * DEG;
  }
  return 0;
}

/** The fraction (0..1) of a sketch curve nearest a point of its plane (u/v), as sketchCurveFrame counts it. */
function sketchFraction(g: EntityGeom, uv: Vec2): number {
  if (g.kind === 'line') {
    const dx = g.b[0] - g.a[0];
    const dy = g.b[1] - g.a[1];
    const l2 = dx * dx + dy * dy || 1;
    return Math.max(0, Math.min(1, ((uv[0] - g.a[0]) * dx + (uv[1] - g.a[1]) * dy) / l2));
  }
  if (g.kind !== 'circle' && g.kind !== 'arc') return 0;
  const ang = Math.atan2(uv[1] - g.c[1], uv[0] - g.c[0]) / DEG;
  if (g.kind === 'circle') return (((ang % 360) + 360) % 360) / 360;
  const d = (((g.a1 - g.a0) % 360) + 360) % 360;
  const sweep = g.ccw ? d || 360 : (360 - d) % 360 || 360;
  const from = (((g.ccw ? ang - g.a0 : g.a0 - ang) % 360) + 360) % 360;
  if (from <= sweep) return from / sweep;
  // Past the arc: the nearer end.
  const toEnd = from - sweep;
  const toStart = 360 - from;
  return toEnd < toStart ? 1 : 0;
}

function sketchCurve(g: EntityGeom, out: Pick<SketchOutput, 'plane'>): CurveNow | null {
  const length = sketchLength(g);
  if (!(length > 0)) return null;
  const frameAt = (f: number) => {
    const r = sketchCurveFrame(g, out, f);
    if (!r) throw Object.assign(new Error('the curve has no direction there'), { kind: 'input' });
    return { point: r.p, tangent: r.tangent };
  };
  return {
    length,
    edge: null,
    async at(where) {
      if ('fraction' in where) return frameAt(where.fraction);
      const d = where.fromEnd ? length - where.distance : where.distance;
      return frameAt(d / length);
    },
    async nearest(p) {
      const f = sketchFraction(g, toSketch(out.plane, p));
      const r = frameAt(f);
      return { ...r, distance: dist(r.point, p) };
    },
  };
}

/** A curve reference at this rebuild (an edge resolved by its name, or a sketch curve from its sketch's output). */
export async function resolveCurve(ref: CurveRef, ctx: BuildContext, words: (r: CurveRef) => string): Promise<Resolved<CurveNow>> {
  if (ref.kind === 'sketch-curve') {
    const out = ctx.outputs.get(ref.sketch);
    const f = ctx.doc.features.find((g) => g.id === ref.sketch) as SketchFeature | undefined;
    if (!f) return { ok: false, message: 'it uses a sketch that was deleted' };
    if (!out || out.type !== 'sketch') return { ok: false, message: f.suppressed ? `${f.name} is suppressed` : `${f.name} did not build` };
    const g = geometryOf(f, out).find((x) => x.id === ref.entity);
    if (!g || g.kind === 'point') return { ok: false, message: `${words(ref)} is gone (deleted)` };
    const c = sketchCurve(g, out);
    return c ? { ok: true, value: c } : { ok: false, message: `${words(ref)} has no length` };
  }
  const e = await resolveEdgeRef(ref, ctx);
  if (!e.ok) return e;
  const info = e.value;
  const value: CurveNow = {
    length: info.length,
    edge: { shape: info.shape, index: info.index },
    at: (where) => edgePoint(ctx.kernel, info.shape, info.index, where),
    nearest: (p) => edgeNearest(ctx.kernel, info.shape, info.index, p),
  };
  return { ok: true, value, ...(e.warning ? { warning: e.warning } : {}) };
}
