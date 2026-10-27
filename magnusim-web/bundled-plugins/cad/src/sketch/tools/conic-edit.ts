// Trim with ellipses, partial ellipses, parabolas and conics (src/sketch/tools/conic.ts): a curve's
// parameter for a point, its crossings with any other curve, and the trim of one itself with
// lineage (the piece at its start keeps the id, a split's other piece is `<id>.b` with `parent`).
//  - An ellipse cut at two crossings becomes the partial ellipse that stays (same id, same centre
//    and axis points).
//  - A partial ellipse or a parabola piece keeps its curve exactly: its pieces share its centre and
//    axis points (focus and vertex), so they stay one ellipse (one parabola) and new ends lie on it.
//  - A conic piece is the same curve on a sub-range: a new top point and rho (rational de Casteljau),
//    so the kept part does not move.
// Cut ends lie on the curves that cut them (On curve; a conic takes no On curve relation).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchConicEntity, SketchConstraint, SketchEntity, Vec2 } from '../../types/doc';
import { SketchBuilder, lineageId, type EditOutcome, type SketchDraft } from '../edit';
import { entityOf, entityPoints, pointAt } from '../model';
import { crossCurves, segmentParamCurve } from './bspline';
import { conicCurve, conicParamCurve, conicParamOf, conicPolyline, subConic, weightRho, type ConicCurve } from './conic';

/** A point's parameter along a conic entity (0..1 from its start; a closed ellipse from its major end). */
export function conicParam(d: SketchDraft, e: SketchConicEntity, p: Vec2): number | null {
  const c = conicCurve(d, e);
  return c ? conicParamOf(c, p) : null;
}

/** Where a ray from `from` along `dir` meets a conic entity (any distance; the caller keeps those ahead). */
export function meetRayConic(d: SketchDraft, from: Vec2, dir: Vec2, o: SketchConicEntity): Vec2[] {
  const c = conicCurve(d, o);
  const l = Math.hypot(dir[0], dir[1]);
  if (!c || !l) return [];
  const pts = conicPolyline(c, 32);
  const reach = (1e4 * Math.max(1, ...pts.map((q) => Math.abs(q[0]) + Math.abs(q[1])), Math.abs(from[0]) + Math.abs(from[1]))) / l;
  const ray = segmentParamCurve(from, [from[0] + dir[0], from[1] + dir[1]], reach);
  ray.samples = 1;
  return crossCurves(ray, conicParamCurve(c)).map((x) => x.p);
}

/** The polyline between two parameters (the red preview of a trim); wraps round a closed ellipse when lo > hi. */
export function conicPiece(d: SketchDraft, e: SketchConicEntity, lo: number, hi: number): Vec2[] {
  const c = conicCurve(d, e);
  if (!c) return [];
  const span = lo <= hi ? hi - lo : 1 - lo + hi;
  const n = Math.max(8, Math.ceil(96 * span));
  return Array.from({ length: n + 1 }, (_, i) => {
    let s = lo + (span * i) / n;
    if (s > 1) s -= 1;
    return c.at(s)[0];
  });
}

/** The piece Trim would remove at parameter t0, between the nearest crossings. */
export function conicTrimPiece(d: SketchDraft, e: SketchConicEntity, t0: number, xs: readonly { t: number }[]): Vec2[] | null {
  if (e.kind === 'ellipse') {
    if (xs.length < 2) return xs.length ? null : conicPiece(d, e, 0, 1);
    const after = xs.find((x) => x.t > t0) ?? xs[0];
    const before = [...xs].reverse().find((x) => x.t < t0) ?? xs[xs.length - 1];
    return conicPiece(d, e, before.t, after.t);
  }
  const inner = xs.filter((x) => x.t > 1e-9 && x.t < 1 - 1e-9);
  const lo = [...inner].reverse().find((x) => x.t < t0)?.t ?? 0;
  const hi = inner.find((x) => x.t > t0)?.t ?? 1;
  return conicPiece(d, e, lo, hi);
}

interface Cut {
  t: number;
  p: Vec2;
  by: string;
}

/** The entity for the piece of `e` from s0 (at point `sId`) to s1 (at `eId`), in the curve's own direction. */
function pieceOf(b: SketchBuilder, e: SketchConicEntity, c: ConicCurve, s0: number, s1: number, sId: string, eId: string): SketchConicEntity {
  switch (e.kind) {
    case 'ellipse':
      // Only reached for a closed ellipse cut twice: the partial ellipse counter-clockwise from sId to eId.
      return { id: e.id, kind: 'ellipse_arc', c: e.c, major: e.major, minor: e.minor, a: sId, b: eId, ...(e.construction ? { construction: true } : {}), ...(e.parent ? { parent: e.parent } : {}) };
    case 'ellipse_arc':
      return e.ccw !== false ? { ...e, a: sId, b: eId } : { ...e, a: eId, b: sId };
    case 'parabola':
      return { ...e, a: sId, b: eId };
    case 'conic': {
      const z = c.bez!;
      const sub = subConic(z.P0, z.P1, z.P2, z.w, s0, s1);
      const t = b.addPoint(sub.P1);
      return { ...e, a: sId, b: eId, t, rho: weightRho(sub.w) };
    }
  }
}

/**
 * Trim a conic entity: the piece around parameter t0 between its nearest crossings goes (the whole
 * entity when nothing crosses it). `xs` are the crossings along it, sorted.
 */
export function trimConicAt(d: SketchDraft, e: SketchConicEntity, t0: number, xs: readonly Cut[], onCut: (b: SketchBuilder, pointId: string, by: string) => void): EditOutcome {
  const c = conicCurve(d, e);
  if (!c) return { ok: false, reason: 'That curve has no shape: its points coincide' };
  const b = new SketchBuilder(d);
  const done = (removed: string[] = []): EditOutcome => ({ ok: true, draft: b.result(), optional: [...b.optional], removed });
  const uniq = xs.filter((x, i) => i === 0 || Math.abs(x.t - xs[i - 1].t) > 1e-9);
  if (e.kind === 'ellipse') {
    if (!uniq.length) {
      b.remove([e.id]);
      return done([e.id]);
    }
    if (uniq.length < 2) return { ok: false, reason: 'An ellipse is trimmed between two crossings: this one is crossed once' };
    const after = uniq.find((x) => x.t > t0) ?? uniq[0];
    const before = [...uniq].reverse().find((x) => x.t < t0) ?? uniq[uniq.length - 1];
    if (after === before) return { ok: false, reason: 'An ellipse is trimmed between two crossings: this one is crossed once' };
    // What stays runs counter-clockwise from `after` round to `before`.
    const pa = b.addPoint(after.p);
    const pb = b.addPoint(before.p);
    b.replaceEntity(pieceOf(b, e, c, after.t, before.t, pa, pb));
    onCut(b, pa, after.by);
    onCut(b, pb, before.by);
    return done();
  }
  const inner = uniq.filter((x) => x.t > 1e-9 && x.t < 1 - 1e-9);
  const lower = [...inner].reverse().find((x) => x.t < t0) ?? null;
  const upper = inner.find((x) => x.t > t0) ?? null;
  if (!lower && !upper) {
    b.remove([e.id]);
    return done([e.id]);
  }
  // Extent dimensions (none measure these curves' length) stay; the old top point of a conic goes when unused.
  const startId = c.startId;
  const endId = c.endId;
  const dropIfUnused = (pid: string) => {
    if (!b.pointUsed(pid)) b.remove([pid]);
  };
  if (lower && upper) {
    const x1 = b.addPoint(lower.p);
    const x2 = b.addPoint(upper.p);
    const pieceId = lineageId(b.entities, e.id);
    b.replaceEntity(pieceOf(b, e, c, 0, lower.t, startId, x1));
    const second = pieceOf(b, e, c, upper.t, 1, x2, endId);
    b.addEntity({ ...second, id: pieceId, parent: e.id } as SketchEntity);
    onCut(b, x1, lower.by);
    onCut(b, x2, upper.by);
    // Relations of the old entity that sit on the new piece follow it: a point on the curve beyond
    // the cut, and a tangency at the old end.
    b.constraints = b.constraints.map((k): SketchConstraint => {
      if ((k.kind === 'point_on_circle' || k.kind === 'coincident') && k.refs[1] === e.id) {
        const p = pointAt(d, k.refs[0]);
        if (p && conicParamOf(c, p) > upper.t) return { ...k, refs: [k.refs[0], pieceId] } as SketchConstraint;
      }
      if (k.kind === 'tangent' && k.refs.includes(e.id)) {
        const other = k.refs.find((r) => r !== e.id);
        const o = other ? entityOf(d, other) : null;
        const ends = o ? entityPoints(o) : [];
        if (ends.includes(endId) && !ends.includes(startId)) return { ...k, refs: k.refs.map((r) => (r === e.id ? pieceId : r)) } as SketchConstraint;
      }
      return k;
    });
    if (e.kind === 'conic') dropIfUnused(e.t);
    return done();
  }
  if (upper) {
    const x = b.addPoint(upper.p);
    b.replaceEntity(pieceOf(b, e, c, upper.t, 1, x, endId));
    onCut(b, x, upper.by);
    dropIfUnused(startId);
  } else {
    const x = b.addPoint(lower!.p);
    b.replaceEntity(pieceOf(b, e, c, 0, lower!.t, startId, x));
    onCut(b, x, lower!.by);
    dropIfUnused(endId);
  }
  if (e.kind === 'conic') dropIfUnused(e.t);
  return done();
}
