// Trim, extend and crossings with splines (P4b): any two sketch curves as
// parametric curves (crossCurves), a spline's parameter for a point, and the
// trim of a spline itself with lineage (the piece at its start keeps the id, a
// split's other piece is `<id>.b` with `parent`).
//  - A control-point spline is cut exactly: the piece is the same curve on a
//    sub-range (new poles, its own clamped knots).
//  - A fit-point spline keeps its fit points inside the piece; the cut becomes
//    a new end fit point with a tangent handle that keeps the curve's direction
//    there, so the kept part barely moves.
// A curve cut by a fit spline ends on it for good: the cut point becomes one of
// the spline's fit points (so the spline always passes through it). A control
// spline has no "on curve" relation (P4b): the new end stays where it was cut.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchSplineEntity, Vec2 } from '../../types/doc';
import { SketchBuilder, lineageId, type EditOutcome, type SketchDraft } from '../edit';
import { arcGeom, entityPoints, lineEnds, pointAt } from '../model';
import { arcParamCurve, chordParams, closestOnSpline, compressKnots, crossCurves, derivs, domain, flatKnots, pointAtParam, segmentParamCurve, splineParamCurve, splinePolyline, subSpline, type BSpline, type ParamCurve } from './bspline';
import { splineEndIds, splineOf } from './spline-entity';

/** A sketch curve as a parametric curve (line: 0..1; circle and arc: 0..1 over their sweep; spline: its own parameter). */
export function curveOfEntity(d: SketchDraft, e: SketchEntity): ParamCurve | null {
  switch (e.kind) {
    case 'line': {
      const ends = lineEnds(d, e.id);
      return ends ? segmentParamCurve(ends[0], ends[1]) : null;
    }
    case 'circle': {
      const c = pointAt(d, e.c);
      return c ? { ...arcParamCurve(c, e.r, 0, 2 * Math.PI), closed: true } : null;
    }
    case 'arc': {
      const g = arcGeom(d, e);
      return g ? arcParamCurve(g.c, g.r, g.a0, g.sweep) : null;
    }
    case 'spline': {
      const b = splineOf(d, e);
      return b ? splineParamCurve(b) : null;
    }
    default:
      return null;
  }
}

/** Where two curves meet when one of them is a spline (each within its extent). */
export function meetCurves(d: SketchDraft, a: SketchEntity, b: SketchEntity): Vec2[] {
  const A = curveOfEntity(d, a);
  const B = curveOfEntity(d, b);
  if (!A || !B) return [];
  return crossCurves(A, B).map((x) => x.p);
}

/** A spline's parameter range now, or null. */
export function splineDomainOf(d: SketchDraft, e: SketchSplineEntity): [number, number] | null {
  const b = splineOf(d, e);
  return b ? domain(b) : null;
}

/** A point's parameter on a spline (the closest point's). */
export function splineParam(d: SketchDraft, e: SketchSplineEntity, p: Vec2): number | null {
  const b = splineOf(d, e);
  return b ? closestOnSpline(b, p).u : null;
}

/** Where a ray from `from` along `dir` meets a spline (any distance; the caller keeps those ahead). */
export function meetRaySpline(d: SketchDraft, from: Vec2, dir: Vec2, o: SketchSplineEntity): Vec2[] {
  const b = splineOf(d, o);
  if (!b) return [];
  const l = Math.hypot(dir[0], dir[1]);
  if (!l) return [];
  // A long segment both ways (1e4 x the sketch's size is past anything in it).
  const reach = 1e4 * Math.max(1, ...b.poles.map((q) => Math.abs(q[0]) + Math.abs(q[1])), Math.abs(from[0]) + Math.abs(from[1])) / l;
  const ray = segmentParamCurve(from, [from[0] + dir[0], from[1] + dir[1]], reach);
  ray.samples = 1;
  return crossCurves(ray, splineParamCurve(b)).map((x) => x.p);
}

/**
 * A point cut on (or snapped to) a spline: on a fit spline it becomes a fit point
 * at its place along the curve (the spline then always passes through it); a
 * control spline gets nothing.
 */
export function onSplineRelation(b: SketchBuilder, pointId: string, spline: SketchSplineEntity): void {
  // fix1 B2: an On curve relation (the point slides along the spline; the spline keeps its shape).
  // P4b first inserted the point as a fit point, which re-shaped a fit spline by up to 2 mm.
  if (spline.pts.includes(pointId) || !!spline.handles?.includes(pointId)) return;
  const has = b.constraints.some((c) => (c.kind === 'point_on_circle' || c.kind === 'coincident') && c.refs[0] === pointId && c.refs[1] === spline.id);
  if (!has) b.addRelation('point_on_circle', [pointId, spline.id], { optional: true });
}

/** The polyline of a spline between two parameters (the red preview of a trim); wraps for a closed spline when lo > hi. */
export function splinePiece(d: SketchDraft, e: SketchSplineEntity, lo: number, hi: number): Vec2[] {
  const b = splineOf(d, e);
  if (!b) return [];
  const [u0, u1] = domain(b);
  if (lo <= hi) return splinePolyline(subSpline(b, lo, hi), 16);
  return [...splinePolyline(subSpline(b, lo, u1), 16), ...splinePolyline(subSpline(b, u0, hi), 16).slice(1)];
}

/** Two clamped splines that meet end to start, as one (C0 at the join; the same curve). */
export function joinSplines(a: BSpline, z: BSpline): BSpline {
  const p = a.degree;
  const fa = flatKnots(a);
  const fz = flatKnots(z);
  const za = fa[fa.length - 1];
  const shift = za - fz[0];
  const U = [...fa.slice(0, fa.length - 1), ...fz.slice(p + 1).map((k) => k + shift)];
  return { degree: p, poles: [...a.poles, ...z.poles.slice(1)], ...compressKnots(U) };
}

interface Cut {
  t: number;
  p: Vec2;
  by: string;
  /** A fit point or pole of the spline itself that another curve ends on (a T joint): the cut is there, at that point. */
  point?: string;
}

/**
 * Trim a spline: the piece around parameter t0 between its nearest crossings goes
 * (the whole spline when nothing crosses it). `xs` are the crossings along it.
 */
export function trimSplineAt(d: SketchDraft, e: SketchSplineEntity, t0: number, xs: Cut[], onCut: (b: SketchBuilder, pointId: string, by: string) => void): EditOutcome {
  const bs = splineOf(d, e);
  if (!bs) return { ok: false, reason: 'That spline has no curve' };
  const [u0, u1] = domain(bs);
  const tol = 1e-9 * (u1 - u0);
  const b = new SketchBuilder(d);
  // A curve ending on one of the spline's own inner points (a T joint) cuts it there too.
  const joints: Cut[] = [];
  const innerPts = e.form !== 'fit' ? [] : e.closed ? e.pts : e.pts.slice(1, -1);
  for (const pid of innerPts) {
    const other = d.entities.find((o) => o.id !== e.id && o.kind !== 'point' && entityPoints(o).includes(pid));
    const at = b.point(pid);
    if (!other || !at) continue;
    joints.push({ t: closestOnSpline(bs, at).u, p: at, by: other.id, point: pid });
  }
  // A cutting curve that ends right at the crossing (a line trimmed to the spline before): the cut is
  // at that end point, so the piece and the curve share it.
  let scale = 1;
  for (const q of Object.values(d.points)) scale = Math.max(scale, Math.abs(q[0]), Math.abs(q[1]));
  for (const x of xs) {
    const o = d.entities.find((y) => y.id === x.by);
    const ends = !o ? [] : o.kind === 'line' ? o.p : o.kind === 'arc' ? [o.a, o.b] : o.kind === 'spline' && !o.closed ? [o.pts[0], o.pts[o.pts.length - 1]] : [];
    const hit = ends.find((pid) => {
      const q = pointAt(d, pid);
      return !!q && Math.hypot(q[0] - x.p[0], q[1] - x.p[1]) < 1e-7 * scale;
    });
    if (hit && hit !== 'origin') (x as Cut).point = hit;
  }
  const all = [...xs, ...joints].sort((x, y) => x.t - y.t);
  const uniq = all.filter((x, i) => i === 0 || Math.abs(x.t - all[i - 1].t) > tol);
  if (e.closed) {
    const inner = uniq;
    if (!inner.length) {
      b.remove([e.id]);
      return { ok: true, draft: b.result(), optional: [...b.optional], removed: [e.id] };
    }
    if (inner.length < 2) return { ok: false, reason: 'A closed spline is trimmed between two crossings: this one is crossed once' };
    const after = inner.find((x) => x.t > t0) ?? inner[0];
    const before = [...inner].reverse().find((x) => x.t < t0) ?? inner[inner.length - 1];
    if (after === before) return { ok: false, reason: 'A closed spline is trimmed between two crossings: this one is crossed once' };
    // What stays runs from `after` round to `before` (through the seam when after > before).
    const piece = buildPiece(b, e, bs, after, before);
    b.replaceEntity({ ...piece, id: e.id, ...(e.parent ? { parent: e.parent } : {}) });
    if (!after.point) onCut(b, piece.pts[0], after.by);
    if (!before.point) onCut(b, piece.pts[piece.pts.length - 1], before.by);
    return finish(b, d, e, [e.id]);
  }
  const inner = uniq.filter((x) => x.t > u0 + tol && x.t < u1 - tol);
  const lower = [...inner].reverse().find((x) => x.t < t0) ?? null;
  const upper = inner.find((x) => x.t > t0) ?? null;
  if (!lower && !upper) {
    b.remove([e.id]);
    return { ok: true, draft: b.result(), optional: [...b.optional], removed: [e.id] };
  }
  const keep: string[] = [];
  if (lower) {
    const first = buildPiece(b, e, bs, 'start', lower);
    b.replaceEntity({ ...first, id: e.id, ...(e.parent ? { parent: e.parent } : {}) });
    if (!lower.point) onCut(b, first.pts[first.pts.length - 1], lower.by);
    keep.push(e.id);
  }
  if (upper) {
    const second = buildPiece(b, e, bs, upper, 'end');
    if (lower) {
      const pieceId = lineageId(b.entities, e.id);
      b.addEntity({ ...second, id: pieceId, parent: e.id });
      keep.push(pieceId);
    } else {
      b.replaceEntity({ ...second, id: e.id, ...(e.parent ? { parent: e.parent } : {}) });
      keep.push(e.id);
    }
    if (!upper.point) onCut(b, second.pts[0], upper.by);
  }
  return finish(b, d, e, keep);
}

/** Drop the old spline's points nothing uses now; move or drop tangents at ends that went. */
function finish(b: SketchBuilder, d: SketchDraft, e: SketchSplineEntity, pieces: string[]): EditOutcome {
  const unused = entityPoints(e).filter((p) => !b.pointUsed(p));
  if (unused.length) b.remove(unused);
  // On-curve relations to the old spline: a point that is now a piece's end needs none (it would be
  // redundant); one on a later piece moves to it.
  const pieceEnts = pieces.map((id) => b.entities.find((x) => x.id === id)).filter((x): x is SketchSplineEntity => x?.kind === 'spline');
  b.constraints = b.constraints.flatMap((c) => {
    if ((c.kind !== 'point_on_circle' && c.kind !== 'coincident') || c.refs[1] !== e.id) return [c];
    const p = c.refs[0];
    if (pieceEnts.some((pe) => splineEndIds(pe).includes(p))) return [];
    const at = b.point(p);
    if (!at || pieceEnts.length < 2) return [c];
    let best = pieceEnts[0];
    let bd = Infinity;
    for (const pe of pieceEnts) {
      const cur = splineOf(b, pe);
      const dd = cur ? closestOnSpline(cur, at).d : Infinity;
      if (dd < bd) {
        bd = dd;
        best = pe;
      }
    }
    return [{ ...c, refs: [p, best.id] }];
  });
  b.constraints = b.constraints.flatMap((c) => {
    if (c.kind !== 'tangent' || !c.refs.includes(e.id)) return [c];
    const other = c.refs.find((r) => r !== e.id);
    const o = other ? b.entities.find((x) => x.id === other) : null;
    const shared = o ? entityPoints(o) : [];
    for (const id of pieces) {
      const pe = b.entities.find((x) => x.id === id);
      if (pe?.kind === 'spline' && splineEndIds(pe).some((p) => shared.includes(p))) return [{ ...c, refs: c.refs.map((r) => (r === e.id ? id : r)) }];
    }
    return [];
  });
  void d;
  return { ok: true, draft: b.result(), optional: [...b.optional], removed: [] };
}

type PieceFields = Omit<SketchSplineEntity, 'id' | 'parent'>;

/** The part of spline `e` from `s` to `z` (a cut, or its own start / end), with new points where needed. */
function buildPiece(b: SketchBuilder, e: SketchSplineEntity, bs: BSpline, s: Cut | 'start', z: Cut | 'end'): PieceFields {
  const [u0, u1] = domain(bs);
  const sa = s === 'start' ? u0 : s.t;
  const zb = z === 'end' ? u1 : z.t;
  const wraps = !!e.closed && sa >= zb;
  const base: PieceFields = { kind: 'spline', form: e.form, degree: e.degree, pts: [], ...(e.construction ? { construction: true } : {}) };
  if (e.form === 'control') {
    const curve = wraps ? joinSplines(subSpline(bs, sa, u1), subSpline(bs, u0, zb)) : subSpline(bs, sa, zb);
    const ids = curve.poles.map((q, i) => {
      if (i === 0) {
        if (s === 'start') return e.pts[0];
        if (s.point) return s.point;
      }
      if (i === curve.poles.length - 1) {
        if (z === 'end') return e.pts[e.pts.length - 1];
        if (z.point) return z.point;
      }
      return b.addPoint(q);
    });
    return { ...base, pts: ids, knots: [...curve.knots], mults: [...curve.mults] };
  }
  // fit: the fit points inside the piece, in order, between its two ends. fix1 B4: the piece is
  // EXACTLY the curve it was. A C2 cubic through the same points with the same end derivatives and
  // knots in the same proportions is the same curve, so: the cut ends get tangent handles from the
  // curve's derivative there, and the end spans keep their place in the parameter (`spans`).
  const pos = e.pts.map((id) => b.point(id)!);
  const closed = !!e.closed;
  const params = chordParams(pos, closed, closed ? undefined : e.spans);
  // The original parameter's scale: the total of its (factored) chord lengths.
  const all = closed ? [...pos, pos[0]] : pos;
  let R = 0;
  for (let i = 1; i < all.length; i++) {
    let l = Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
    if (!closed && e.spans) {
      if (i === 1) l *= e.spans[0];
      if (i === all.length - 1 && all.length > 2) l *= e.spans[1];
    }
    R += l;
  }
  const tol = 1e-9 * (u1 - u0);
  const za = wraps ? zb + 1 : zb;
  const kept: { id: string; u: number }[] = [];
  if (wraps) {
    e.pts.forEach((id, i) => {
      if (params[i] > sa + tol) kept.push({ id, u: params[i] });
    });
    e.pts.forEach((id, i) => {
      if (params[i] < zb - tol) kept.push({ id, u: params[i] + 1 });
    });
  } else {
    e.pts.forEach((id, i) => {
      if (params[i] > sa + tol && params[i] < zb - tol) kept.push({ id, u: params[i] });
    });
  }
  const startId = s === 'start' ? e.pts[0] : (s.point ?? b.addPoint(s.p));
  const endId = z === 'end' ? e.pts[e.pts.length - 1] : (z.point ?? b.addPoint(z.p));
  const seq = [{ id: startId, u: s === 'start' ? 0 : sa }, ...kept.filter((x) => x.id !== startId && x.id !== endId), { id: endId, u: z === 'end' ? 1 : za }];
  const ids = seq.map((x) => x.id);
  const chord = (i: number, j: number) => {
    const a = b.point(ids[i])!;
    const c = b.point(ids[j])!;
    return Math.hypot(c[0] - a[0], c[1] - a[1]);
  };
  const last = seq.length - 1;
  // Each end span's factor: its share of the original parameter over its chord (1 for a lone span).
  const factor = (i: number, j: number) => {
    const c = chord(i, j);
    return c > 0 ? ((seq[j].u - seq[i].u) * R) / c : 1;
  };
  const spans: [number, number] =
    last === 1 ? [1, 1] : [s === 'start' ? (e.spans?.[0] ?? 1) : factor(0, 1), z === 'end' ? (e.spans?.[1] ?? 1) : factor(last - 1, last)];
  const handleAt = (t: number, from: string, sign: 1 | -1, du: number): string => {
    const [, D] = derivs(bs, t, 1);
    const p = b.point(from)!;
    return b.addPoint([p[0] + (sign * D[0] * du) / 3, p[1] + (sign * D[1] * du) / 3]);
  };
  const h0 = s === 'start' ? (e.handles?.[0] ?? null) : handleAt(sa, startId, 1, seq[1].u - seq[0].u);
  const h1 = z === 'end' ? (e.handles?.[1] ?? null) : handleAt(zb, endId, -1, seq[last].u - seq[last - 1].u);
  return {
    ...base,
    pts: ids,
    ...(h0 || h1 ? { handles: [h0, h1] as [string | null, string | null] } : {}),
    ...(spans[0] !== 1 || spans[1] !== 1 ? { spans } : {}),
  };
}

/** A point at parameter t on a spline entity now (tests, previews). */
export function splinePointAt(d: SketchDraft, e: SketchSplineEntity, t: number): Vec2 | null {
  const b = splineOf(d, e);
  return b ? pointAtParam(b, t) : null;
}
