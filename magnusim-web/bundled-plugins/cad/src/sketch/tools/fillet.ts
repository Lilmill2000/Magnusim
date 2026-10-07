// Sketch fillet and chamfer (P4b). Pick a corner (the point two curves share)
// or the two curves, with the radius (or the distances) in the panel.
//  - Fillet: two lines, or a line and an arc, meeting at a corner. Both are
//    trimmed back and a tangent arc joins them (Tangent at both ends, a driving
//    Radius dimension).
//  - Chamfer: two lines. Both are trimmed back and a line joins them, with its
//    two distances from the corner as driving dimensions (Same distance: the one
//    value typed goes to both).
// The corner stays as a construction point (SolidWorks' "virtual sharp") held
// on both curves, so dimensions to the corner keep holding: a length dimension
// of a trimmed line becomes the distance from the corner to its far end.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { SketchConstraint, SketchEntity, Vec2 } from '../../types/doc';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { angleOf, ccwSweep, dist, lineCircle, norm, onArcAngle, sub } from '../geom';
import { arcGeom, entityLabel, entityOf, entityPoints, isDimension, pointAt } from '../model';
import { emptyPreview, storeExpr, type SketchMode, type SketchTool } from '../mode';
import { hitTest } from '../pick';
import type { ToolOption } from './options';

/** The two curves (lines or arcs) that meet at a point and nothing else does, or why not. */
export function cornerAt(d: SketchDraft, point: string): { a: SketchEntity; b: SketchEntity } | string {
  const users = d.entities.filter((e) => e.kind !== 'point' && entityPoints(e).includes(point));
  const ends = users.filter((e) => (e.kind === 'line' && e.p.includes(point)) || (e.kind === 'arc' && (e.a === point || e.b === point)));
  if (ends.length !== 2 || users.length !== 2) return 'Pick a corner where two lines (or a line and an arc) meet';
  // P4b SELECT's linked geometry follows its source: it cannot be trimmed back.
  const linked = ends.find((e) => (e as { link?: string }).link);
  if (linked) return 'Break the link first: a projected or intersected curve follows its source';
  return { a: ends[0], b: ends[1] };
}

/** The corner two picked curves share, or why not. */
export function sharedCorner(d: SketchDraft, a: string, b: string): string | null {
  const ea = entityOf(d, a);
  const eb = entityOf(d, b);
  if (!ea || !eb) return null;
  const endsOf = (e: SketchEntity) => (e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : []);
  return endsOf(ea).find((p) => endsOf(eb).includes(p)) ?? null;
}

/** Keep the corner as a construction point on both curves, and move length dimensions of the trimmed lines onto it. */
function keepCorner(b: SketchBuilder, d: SketchDraft, corner: string, curves: SketchEntity[], labelGap?: number) {
  if (!b.pointUsed(corner)) b.addEntity({ id: newId('e'), kind: 'point', p: corner, construction: true });
  for (const e of curves) {
    if (e.kind === 'line') b.addRelation('point_on_line', [corner, e.id]);
    else if (e.kind === 'arc') b.addRelation('point_on_circle', [corner, e.id]);
  }
  const P = pointAt(d, corner);
  b.constraints = b.constraints.map((c): SketchConstraint => {
    if (!isDimension(c) || c.refs.length !== 1) return c;
    const e = curves.find((x) => x.id === c.refs[0]);
    if (e?.kind !== 'line') return c;
    if (c.kind !== 'distance' && c.kind !== 'distance_x' && c.kind !== 'distance_y') return c;
    // The line's own length (or its x / y extent) as the corner to its far end, in the line's order.
    const refs = e.p[0] === corner ? [corner, e.p[1]] : [e.p[0], corner];
    if (c.at || !P) return { ...c, refs };
    // fix1 P4: its label stays beside the line, outside the corner, clear of the relation glyphs (the
    // point-to-point default placed "40" inside the part and "30" under a Tangent glyph).
    const A = pointAt(d, farEnd(e, corner));
    const other = curves.find((x) => x.id !== e.id);
    const B = other ? pointAt(d, other.kind === 'line' ? farEnd(other, corner) : other.kind === 'arc' ? (other.a === corner ? other.b : other.a) : corner) : null;
    if (!A || !B) return { ...c, refs };
    const n: Vec2 = [-(A[1] - P[1]), A[0] - P[0]];
    const l = Math.hypot(n[0], n[1]) || 1;
    const side = (B[0] - P[0]) * n[0] + (B[1] - P[1]) * n[1] > 0 ? -1 : 1;
    const gap = labelGap ?? Math.max(6, 0.2 * l);
    return { ...c, refs, at: [(P[0] + A[0]) / 2 + (side * gap * n[0]) / l, (P[1] + A[1]) / 2 + (side * gap * n[1]) / l] as Vec2 };
  });
}

/** Replace a curve's end point `from` with `to` (a trimmed line or arc). */
function withEnd(e: SketchEntity, from: string, to: string): SketchEntity {
  if (e.kind === 'line') return { ...e, p: [e.p[0] === from ? to : e.p[0], e.p[1] === from ? to : e.p[1]] };
  if (e.kind === 'arc') return { ...e, a: e.a === from ? to : e.a, b: e.b === from ? to : e.b };
  return e;
}

/** The far end of a line from a corner. */
const farEnd = (e: Extract<SketchEntity, { kind: 'line' }>, corner: string) => (e.p[0] === corner ? e.p[1] : e.p[0]);

/** A fillet of radius r at the corner two curves share. */
export function filletCorner(d: SketchDraft, corner: string, r: number, rExpr: string, opts: { labelGap?: number } = {}): EditOutcome {
  const c = cornerAt(d, corner);
  if (typeof c === 'string') return { ok: false, reason: c };
  const P = pointAt(d, corner);
  if (!P || !(r > 0)) return { ok: false, reason: 'the radius must be more than 0' };
  const lines = [c.a, c.b].filter((e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line');
  const arcs = [c.a, c.b].filter((e): e is Extract<SketchEntity, { kind: 'arc' }> => e.kind === 'arc');
  if (lines.length === 2) return filletLines(d, corner, P, lines[0], lines[1], r, rExpr, opts.labelGap);
  if (lines.length === 1 && arcs.length === 1) return filletLineArc(d, corner, P, lines[0], arcs[0], r, rExpr, opts.labelGap);
  return { ok: false, reason: 'a sketch fillet joins two lines, or a line and an arc' };
}

function filletLines(d: SketchDraft, corner: string, P: Vec2, l1: Extract<SketchEntity, { kind: 'line' }>, l2: Extract<SketchEntity, { kind: 'line' }>, r: number, rExpr: string, labelGap?: number): EditOutcome {
  const A = pointAt(d, farEnd(l1, corner))!;
  const B = pointAt(d, farEnd(l2, corner))!;
  const u1 = norm(sub(A, P));
  const u2 = norm(sub(B, P));
  const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const half = Math.acos(cos) / 2;
  if (half < 1e-6 || Math.PI / 2 - half < 1e-6) return { ok: false, reason: 'the two lines are in line: there is no corner to round' };
  const t = r / Math.tan(half);
  if (t >= dist(P, A) - 1e-9 || t >= dist(P, B) - 1e-9) return { ok: false, reason: `the radius is too large for these lines (at most ${(Math.min(dist(P, A), dist(P, B)) * Math.tan(half)).toFixed(2)} mm)` };
  const T1: Vec2 = [P[0] + u1[0] * t, P[1] + u1[1] * t];
  const T2: Vec2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];
  const bis = norm([u1[0] + u2[0], u1[1] + u2[1]]);
  const h = r / Math.sin(half);
  const C: Vec2 = [P[0] + bis[0] * h, P[1] + bis[1] * h];
  return joinWithArc(d, corner, [l1, l2], [T1, T2], C, r, rExpr, labelGap);
}

function filletLineArc(d: SketchDraft, corner: string, P: Vec2, l: Extract<SketchEntity, { kind: 'line' }>, k: Extract<SketchEntity, { kind: 'arc' }>, r: number, rExpr: string, labelGap?: number): EditOutcome {
  const g = arcGeom(d, k);
  const A = pointAt(d, farEnd(l, corner));
  if (!g || !A) return { ok: false, reason: 'that arc has no shape' };
  const u = norm(sub(A, P));
  const n: Vec2 = [-u[1], u[0]];
  let best: { C: Vec2; T1: Vec2; T2: Vec2; d: number } | null = null;
  for (const side of [1, -1]) {
    const off: [Vec2, Vec2] = [
      [P[0] + n[0] * r * side, P[1] + n[1] * r * side],
      [A[0] + n[0] * r * side, A[1] + n[1] * r * side],
    ];
    for (const R of [g.r + r, g.r - r]) {
      if (!(R > 0)) continue;
      for (const x of lineCircle(off[0], off[1], g.c, R)) {
        const C = x.p;
        // Tangent points: the foot on the line, and on the arc's circle along the centre line.
        const T1: Vec2 = [C[0] - n[0] * r * side, C[1] - n[1] * r * side];
        const s = (T1[0] - P[0]) * u[0] + (T1[1] - P[1]) * u[1];
        if (s <= 1e-9 || s >= dist(P, A) - 1e-9) continue;
        const dc = norm(sub(C, g.c));
        const T2: Vec2 = [g.c[0] + dc[0] * g.r, g.c[1] + dc[1] * g.r];
        if (!onArcAngle(g, angleOf(g.c, T2), 1e-9)) continue;
        const score = dist(T1, P) + dist(T2, P);
        if (!best || score < best.d) best = { C, T1, T2, d: score };
      }
    }
  }
  if (!best) return { ok: false, reason: 'no fillet of that radius fits this corner (try a smaller radius)' };
  return joinWithArc(d, corner, [l, k], [best.T1, best.T2], best.C, r, rExpr, labelGap);
}

/** Trim both curves back to T1 / T2 and join them with a tangent arc about C. */
function joinWithArc(d: SketchDraft, corner: string, curves: [SketchEntity, SketchEntity], T: [Vec2, Vec2], C: Vec2, r: number, rExpr: string, labelGap?: number): EditOutcome {
  void r;
  const b = new SketchBuilder(d);
  const t1 = b.addPoint(T[0]);
  const t2 = b.addPoint(T[1]);
  const c = b.addPoint(C);
  b.replaceEntity(withEnd(curves[0], corner, t1));
  b.replaceEntity(withEnd(curves[1], corner, t2));
  const ccw = ccwSweep(angleOf(C, T[0]), angleOf(C, T[1])) <= Math.PI;
  const arc = b.addEntity({ id: newId('e'), kind: 'arc', c, a: t1, b: t2, ...(ccw ? {} : { ccw: false }) });
  b.addRelation('tangent', [curves[0].id, arc]);
  b.addRelation('tangent', [curves[1].id, arc]);
  const mid = norm([(T[0][0] + T[1][0]) / 2 - C[0], (T[0][1] + T[1][1]) / 2 - C[1]]);
  b.addDimension('radius', [arc], rExpr, { at: [C[0] + mid[0] * r * 1.8, C[1] + mid[1] * r * 1.8] });
  keepCorner(b, d, corner, curves, labelGap);
  return { ok: true, draft: b.result(), optional: [...b.optional], removed: [] };
}

/** A chamfer of distances d1 (along the first line) and d2 at the corner two lines share. */
export function chamferCorner(d: SketchDraft, corner: string, d1: number, d2: number, exprs: [string, string], equal: boolean, opts: { labelGap?: number } = {}): EditOutcome {
  const c = cornerAt(d, corner);
  if (typeof c === 'string') return { ok: false, reason: c };
  if (c.a.kind !== 'line' || c.b.kind !== 'line') return { ok: false, reason: 'a sketch chamfer joins two lines' };
  const l1 = c.a;
  const l2 = c.b;
  const P = pointAt(d, corner)!;
  const A = pointAt(d, farEnd(l1, corner))!;
  const B = pointAt(d, farEnd(l2, corner))!;
  if (!(d1 > 0 && d2 > 0)) return { ok: false, reason: 'the distances must be more than 0' };
  if (d1 >= dist(P, A) - 1e-9 || d2 >= dist(P, B) - 1e-9) return { ok: false, reason: 'the chamfer is longer than a line it cuts' };
  const u1 = norm(sub(A, P));
  const u2 = norm(sub(B, P));
  if (Math.abs(u1[0] * u2[1] - u1[1] * u2[0]) < 1e-9) return { ok: false, reason: 'the two lines are in line: there is no corner to cut' };
  const b = new SketchBuilder(d);
  const t1 = b.addPoint([P[0] + u1[0] * d1, P[1] + u1[1] * d1]);
  const t2 = b.addPoint([P[0] + u2[0] * d2, P[1] + u2[1] * d2]);
  b.replaceEntity(withEnd(l1, corner, t1));
  b.replaceEntity(withEnd(l2, corner, t2));
  b.addEntity({ id: newId('e'), kind: 'line', p: [t1, t2] });
  keepCorner(b, d, corner, [l1, l2], opts.labelGap);
  // fix1 P7: the chamfer's labels sit outside the corner, clear of the corner's On line glyphs.
  const beside = (to: Vec2, away: Vec2): Vec2 => {
    const n: Vec2 = [-(to[1] - P[1]), to[0] - P[0]];
    const l = Math.hypot(n[0], n[1]) || 1;
    const side = (away[0] - P[0]) * n[0] + (away[1] - P[1]) * n[1] > 0 ? -1 : 1;
    const gap = opts.labelGap ?? 6;
    return [(P[0] + to[0]) / 2 + (side * gap * n[0]) / l, (P[1] + to[1]) / 2 + (side * gap * n[1]) / l];
  };
  const T1: Vec2 = [P[0] + u1[0] * d1, P[1] + u1[1] * d1];
  const T2: Vec2 = [P[0] + u2[0] * d2, P[1] + u2[1] * d2];
  b.addDimension('distance', [corner, t1], exprs[0], { at: beside(T1, B) });
  if (equal) {
    // fix1 P7: "Same distance" stays one value: two construction legs from the corner, Equal, and one
    // dimension (it was two independent dimensions holding the same number).
    const legA = b.addEntity({ id: newId('e'), kind: 'line', p: [corner, t1], construction: true });
    const legB = b.addEntity({ id: newId('e'), kind: 'line', p: [corner, t2], construction: true });
    b.addRelation('equal', [legA, legB]);
  } else b.addDimension('distance', [corner, t2], exprs[1], { at: beside(T2, A) });
  return { ok: true, draft: b.result(), optional: [...b.optional], removed: [] };
}

export function filletTool(mode: SketchMode, kind: 'fillet' | 'chamfer'): SketchTool {
  const units = mode.services.doc.units;
  const lenExpr = (mm: number) => storeExpr(String(+(mm / ({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length])).toPrecision(6)), 'length', units);
  let radius = lenExpr(5);
  let dist1 = lenExpr(5);
  let dist2 = lenExpr(5);
  let equal = true;
  let first: string | null = null;
  const value = (e: string) => {
    const r = units.evaluate(e, 'length');
    return r.ok ? r.value : NaN;
  };

  function run(corner: string) {
    const r = value(radius);
    const a = value(dist1);
    const z = equal ? a : value(dist2);
    // Labels moved to the corner sit 72 px out (past the relation glyphs beside the line).
    const plane = mode.plane();
    const h = mode.services.viewport.get().handle;
    const labelGap = plane && h ? 72 * h.pixelSize([plane.origin[0], plane.origin[1], plane.origin[2]]) : undefined;
    const opts = labelGap && Number.isFinite(labelGap) && labelGap > 0 ? { labelGap } : {};
    void mode.apply(kind === 'fillet' ? 'Sketch fillet' : 'Sketch chamfer', (d) => (kind === 'fillet' ? filletCorner(d, corner, r, radius, opts) : chamferCorner(d, corner, a, z, [dist1, dist2], equal, opts))).then(() => {
      first = null;
      mode.select([], false);
      mode.refreshHint();
    });
  }

  /** The corner a pointer is at: a corner point within the pick distance. */
  function cornerNear(uv: Vec2, px: number): string | null {
    const d = mode.draft();
    if (!d) return null;
    const h = hitTest(d, uv, px, { entities: false });
    if (h?.what === 'point' && typeof cornerAt(d, h.id) !== 'string') return h.id;
    return null;
  }

  return {
    id: kind,
    hint: () => (first ? 'Click the second curve (it must meet the first at a corner).' : 'Pick a corner or two curves.'),
    // ci2: a label or glyph clicked keeps the first pick (src/sketch/mode.ts refusesPick).
    refusesPick: (what) => `${what === 'dimension' ? 'Dimensions' : 'Relations'} can't be ${kind === 'fillet' ? 'filleted' : 'chamfered'}: ${first ? 'click the second curve' : 'pick a corner or two curves'}`,
    cancel() {
      const had = !!first;
      first = null;
      mode.select([], false);
      mode.refreshHint();
      return had;
    },
    options(): ToolOption[] {
      if (kind === 'fillet') return [{ kind: 'number', id: 'radius', label: 'Radius', expr: radius, quantity: 'length', validate: (v) => (v > 0 ? null : 'Must be more than 0'), set: (e) => void (radius = e) }];
      const out: ToolOption[] = [
        { kind: 'check', id: 'equal', label: 'Same distance on both lines', value: equal, set: (v) => ((equal = v), mode.refreshHint()) },
        { kind: 'number', id: 'distance1', label: equal ? 'Distance' : 'Distance 1', expr: dist1, quantity: 'length', validate: (v) => (v > 0 ? null : 'Must be more than 0'), set: (e) => void (dist1 = e) },
      ];
      if (!equal) out.push({ kind: 'number', id: 'distance2', label: 'Distance 2', expr: dist2, quantity: 'length', validate: (v) => (v > 0 ? null : 'Must be more than 0'), set: (e) => void (dist2 = e) });
      return out;
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      if (e.type === 'move') {
        const corner = cornerNear(e.uv, e.px);
        mode.setHover(corner ? { what: 'point', id: corner } : hitTest(d, e.uv, e.px, { points: false }));
        const p = emptyPreview();
        if (corner) p.points.push(pointAt(d, corner)!);
        mode.setPreview(p);
        return;
      }
      if (e.type !== 'click') return;
      const corner = cornerNear(e.uv, e.px);
      if (corner && !first) {
        run(corner);
        return;
      }
      const h = hitTest(d, e.uv, e.px, { points: false });
      const ent = h ? entityOf(d, h.id) : null;
      if (!ent || (ent.kind !== 'line' && ent.kind !== 'arc')) {
        mode.note(kind === 'fillet' ? 'Pick a corner, or a line or an arc' : 'Pick a corner, or a line');
        return;
      }
      if (!first) {
        first = ent.id;
        mode.select([{ what: 'entity', id: ent.id }], false);
        mode.note(null);
        mode.refreshHint();
        return;
      }
      if (first === ent.id) return;
      const shared = sharedCorner(d, first, ent.id);
      if (!shared) {
        mode.note(`Not applied: ${entityLabel(d, first)} and ${entityLabel(d, ent.id)} do not meet at a corner`);
        first = null;
        mode.select([], false);
        mode.refreshHint();
        return;
      }
      run(shared);
    },
  };
}

