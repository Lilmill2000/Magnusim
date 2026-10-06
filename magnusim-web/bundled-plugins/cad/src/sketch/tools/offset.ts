// Sketch offset (P4b, O): point at a curve and the whole chain it belongs to
// (curves joined end to end, up to a branch) is offset to the pointer's side by
// the distance in the panel; a click places it (Both sides: one copy each side).
// Lines and arcs stay associative through the sketch's offset tie
// (src/sketch/tools/ties.ts): a line copy is parallel to its source at the
// distance, an arc copy shares its source's centre at the distance, a circle
// copy is concentric at the distance, the chain's corners are where the offset
// curves meet (lines extended, as SolidWorks does by default), and a free end
// is squared to its source. Splines are offset by sampling: a fit spline
// through offset points, joined to its neighbours, not re-fitted afterwards.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { SketchEntity, SketchTie, Vec2 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { angleOf, circleCircle, dist, lineCircle, lineLine, norm, perp, polar, sub } from '../geom';
import { arcGeom, closestOn, entityLabel, entityOf, pointAt } from '../model';
import { emptyPreview, storeExpr, type SketchMode, type SketchTool } from '../mode';
import { hitTest, samples } from '../pick';
import { closestOnSpline, derivs, splinePolyline, fitSpline } from './bspline';
import type { ToolOption } from './options';
import { splineOf } from './spline-entity';
import { evaluateTies } from './ties';

type Draft = SketchDraft & { ties?: SketchTie[] };
type Curve = Extract<SketchEntity, { kind: 'line' | 'arc' | 'circle' | 'spline' }>;

/** One curve of a chain, in the chain's travel direction (from `from` to `to`; a circle has neither). */
export interface ChainItem {
  e: Curve;
  from: string | null;
  to: string | null;
}

const endsOf = (e: SketchEntity): [string, string] | null => (e.kind === 'line' ? [e.p[0], e.p[1]] : e.kind === 'arc' ? (e.ccw !== false ? [e.a, e.b] : [e.b, e.a]) : e.kind === 'spline' && !e.closed ? [e.pts[0], e.pts[e.pts.length - 1]] : null);

/** The chain an entity belongs to: curves joined end to end where exactly two meet. */
export function chainOf(d: SketchDraft, id: string): { items: ChainItem[]; closed: boolean } | null {
  const start = entityOf(d, id);
  if (!start || start.kind === 'point') return null;
  if (start.kind === 'circle' || (start.kind === 'spline' && start.closed)) return { items: [{ e: start, from: null, to: null }], closed: true };
  const curves = d.entities.filter((e): e is Curve => e.kind !== 'point' && !!endsOf(e) && !e.construction);
  const users = (p: string) => curves.filter((e) => endsOf(e)!.includes(p));
  const startEnds = endsOf(start)!;
  // Walk back from the start to the chain's first curve, then forward.
  let first: Curve = start as Curve;
  let entry = startEnds[0];
  const seen = new Set<string>([first.id]);
  for (;;) {
    const u = users(entry);
    if (u.length !== 2) break;
    const prev = u.find((e) => e.id !== first.id)!;
    if (seen.has(prev.id)) break;
    seen.add(prev.id);
    const pe = endsOf(prev)!;
    entry = pe[0] === entry ? pe[1] : pe[0];
    first = prev;
  }
  const items: ChainItem[] = [];
  let cur: Curve = first;
  let from = entry;
  const done = new Set<string>();
  let closed = false;
  for (;;) {
    const ce = endsOf(cur)!;
    const to = ce[0] === from ? ce[1] : ce[0];
    items.push({ e: cur, from, to });
    done.add(cur.id);
    const u = users(to);
    if (u.length !== 2) break;
    const next = u.find((e) => e.id !== cur.id)!;
    if (done.has(next.id)) {
      closed = next.id === items[0].e.id;
      break;
    }
    cur = next;
    from = to;
  }
  return { items, closed };
}

/** The left normal of a chain item's travel at a point near q. */
function leftNormalAt(d: SketchDraft, it: ChainItem, q: Vec2): Vec2 | null {
  const e = it.e;
  if (e.kind === 'line') {
    const a = pointAt(d, it.from!)!;
    const b = pointAt(d, it.to!)!;
    return perp(norm(sub(b, a)));
  }
  if (e.kind === 'arc' || e.kind === 'circle') {
    const c = pointAt(d, e.c)!;
    const r = norm(sub(q, c));
    // Travelling ccw, left is toward the centre.
    const ccw = e.kind === 'circle' ? true : (it.from === (e.ccw !== false ? e.a : e.b));
    return ccw ? [-r[0], -r[1]] : r;
  }
  const b = splineOf(d, e);
  if (!b) return null;
  const u = closestOnSpline(b, q).u;
  const [, D] = derivs(b, u, 1);
  const fwd = it.from === e.pts[0] || it.from === null;
  const t = norm(fwd ? D : [-D[0], -D[1]]);
  return perp(t);
}

/** The side of the chain the pointer is on: 1 left of its travel, -1 right. */
export function sideOf(d: SketchDraft, chain: { items: ChainItem[] }, at: Vec2): 1 | -1 {
  let best: { it: ChainItem; p: Vec2; dd: number } | null = null;
  for (const it of chain.items) {
    const p = closestOn(d, it.e, at);
    if (!p) continue;
    const dd = dist(p, at);
    if (!best || dd < best.dd) best = { it, p, dd };
  }
  if (!best) return 1;
  const n = leftNormalAt(d, best.it, best.p);
  if (!n) return 1;
  return (at[0] - best.p[0]) * n[0] + (at[1] - best.p[1]) * n[1] >= 0 ? 1 : -1;
}

/** Offset curves of a chain (geometry only): lines as two points, arcs/circles as a radius, splines as sample points. */
interface OffsetGeo {
  line?: [Vec2, Vec2];
  circle?: { c: Vec2; r: number };
  spline?: Vec2[];
}

function offsetGeo(d: SketchDraft, it: ChainItem, s: number): OffsetGeo | string {
  const e = it.e;
  if (e.kind === 'line') {
    const a = pointAt(d, it.from!)!;
    const b = pointAt(d, it.to!)!;
    const n = perp(norm(sub(b, a)));
    return { line: [[a[0] + n[0] * s, a[1] + n[1] * s], [b[0] + n[0] * s, b[1] + n[1] * s]] };
  }
  if (e.kind === 'arc' || e.kind === 'circle') {
    const c = pointAt(d, e.c)!;
    const r0 = e.kind === 'circle' ? e.r : arcGeom(d, e)!.r;
    const ccw = e.kind === 'circle' ? true : it.from === (e.ccw !== false ? e.a : e.b);
    const r = ccw ? r0 - s : r0 + s;
    if (!(r > 1e-9)) return `the offset is larger than the radius of ${entityLabel(d, e.id)}`;
    return { circle: { c, r } };
  }
  const b = splineOf(d, e);
  if (!b) return `${entityLabel(d, e.id)} has no shape`;
  const n = Math.max(8, Math.min(40, e.pts.length * 4));
  const fwd = it.from === e.pts[0] || it.from === null;
  const pts: Vec2[] = [];
  const [u0, u1] = [b.knots[0], b.knots[b.knots.length - 1]];
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const [C, D] = derivs(b, u, 1);
    const t = norm(fwd ? D : [-D[0], -D[1]]);
    const nn = perp(t);
    pts.push([C[0] + nn[0] * s, C[1] + nn[1] * s]);
  }
  if (!fwd) pts.reverse();
  if (e.closed) pts.pop();
  return { spline: pts };
}

/** Where two consecutive offset curves meet, nearest `near`. */
function meetOffsets(a: OffsetGeo, b: OffsetGeo, near: Vec2): Vec2 {
  const pick = (ps: Vec2[]) => (ps.length ? ps.reduce((x, y) => (dist(x, near) <= dist(y, near) ? x : y)) : near);
  if (a.line && b.line) {
    const x = lineLine(a.line[0], a.line[1], b.line[0], b.line[1]);
    return x ? x.p : near;
  }
  if (a.line && b.circle) return pick(lineCircle(a.line[0], a.line[1], b.circle.c, b.circle.r).map((x) => x.p));
  if (a.circle && b.line) return pick(lineCircle(b.line[0], b.line[1], a.circle.c, a.circle.r).map((x) => x.p));
  if (a.circle && b.circle) return pick(circleCircle(a.circle.c, a.circle.r, b.circle.c, b.circle.r));
  return near;
}

/** The offset copy of a chain on side `side` (1 left, -1 right) at distance `dist`, made in the builder. */
function buildOffset(b: SketchBuilder, d: SketchDraft, chain: { items: ChainItem[]; closed: boolean }, side: 1 | -1, distance: number): { entities: Record<string, string>; points: Record<string, string> } | string {
  const s = side * distance;
  const geo: OffsetGeo[] = [];
  for (const it of chain.items) {
    const g = offsetGeo(d, it, s);
    if (typeof g === 'string') return g;
    geo.push(g);
  }
  const points: Record<string, string> = {};
  const entities: Record<string, string> = {};
  const n = chain.items.length;
  // The joint points: between item i-1 and i (closed: also between the last and the first).
  const joint = (i: number): string => {
    const it = chain.items[i];
    const src = it.from!;
    if (points[src]) return points[src];
    const prev = i > 0 ? i - 1 : chain.closed ? n - 1 : -1;
    const p = pointAt(d, src)!;
    let at: Vec2;
    if (prev < 0) at = startOf(geo[i], p);
    else at = meetOffsets(geo[prev], geo[i], shifted(geo[i], p));
    points[src] = b.addPoint(at);
    return points[src];
  };
  const last = (i: number): string => {
    const it = chain.items[i];
    const src = it.to!;
    if (points[src]) return points[src];
    const p = pointAt(d, src)!;
    points[src] = b.addPoint(endOf(geo[i], p));
    return points[src];
  };
  chain.items.forEach((it, i) => {
    const e = it.e;
    const id = newId('e');
    entities[e.id] = id;
    const keep = e.construction ? { construction: true } : {};
    if (e.kind === 'circle') {
      b.addEntity({ id, kind: 'circle', c: e.c, r: geo[i].circle!.r, ...keep });
      return;
    }
    if (e.kind === 'spline' && e.closed) {
      b.addEntity({ id, kind: 'spline', form: 'fit', degree: 3, closed: true, pts: geo[i].spline!.map((q) => b.addPoint(q)), ...keep });
      return;
    }
    const f = joint(i);
    const t = i < n - 1 ? joint(i + 1) : chain.closed ? joint(0) : last(i);
    if (e.kind === 'line') b.addEntity({ id, kind: 'line', p: e.p[0] === it.from ? [f, t] : [t, f], ...keep });
    else if (e.kind === 'arc') {
      // Same centre, same turn; a, b in the source's own order.
      const [a, z] = e.a === it.from ? [f, t] : [t, f];
      b.addEntity({ id, kind: 'arc', c: e.c, a, b: z, ...(e.ccw === false ? { ccw: false } : {}), ...keep });
    } else if (e.kind === 'spline') {
      const inner = geo[i].spline!.slice(1, -1).map((q) => b.addPoint(q));
      const fwd = e.pts[0] === it.from;
      const pts = fwd ? [f, ...inner, t] : [t, ...inner.reverse(), f];
      b.addEntity({ id, kind: 'spline', form: 'fit', degree: 3, pts, ...keep });
    }
  });
  return { entities, points };
}

const shifted = (g: OffsetGeo, p: Vec2): Vec2 => startOf(g, p);
function startOf(g: OffsetGeo, p: Vec2): Vec2 {
  if (g.line) {
    // The foot of p on the offset line.
    const [a, z] = g.line;
    const dd = sub(z, a);
    const l2 = dd[0] * dd[0] + dd[1] * dd[1];
    const t = ((p[0] - a[0]) * dd[0] + (p[1] - a[1]) * dd[1]) / l2;
    return [a[0] + dd[0] * t, a[1] + dd[1] * t];
  }
  if (g.circle) return polar(g.circle.c, g.circle.r, angleOf(g.circle.c, p));
  if (g.spline) return g.spline.reduce((x, y) => (dist(x, p) <= dist(y, p) ? x : y));
  return p;
}
const endOf = startOf;

/** The offset edit: copies of the chain through `id` on `side` (or both sides) at `distance`, tied to it. */
export function offsetChain(d: Draft, id: string, side: 1 | -1, both: boolean, expr: string, units: UnitsService): EditOutcome {
  const chain = chainOf(d, id);
  if (!chain) return { ok: false, reason: 'Offset takes lines, arcs, circles and splines' };
  const tie: SketchTie = { id: `t${newId('c').slice(1)}`, kind: 'offset', sources: chain.items.map((x) => x.e.id), copies: [], count: [1, 1], exprs: { distance: expr } };
  const ev = evaluateTies({ ties: [tie] }, units);
  const bad = Object.values(ev.errors)[0];
  if (bad) return { ok: false, reason: bad };
  const distance = ev.values[`${tie.id}:distance`];
  const b = new SketchBuilder(d);
  for (const sd of both ? ([1, -1] as const) : [side]) {
    const m = buildOffset(b, d, chain, sd, distance);
    if (typeof m === 'string') return { ok: false, reason: m };
    tie.copies.push({ at: [sd, 0], ...m });
  }
  const draft: Draft = { ...b.result(), ties: [...(d.ties ?? []), tie] };
  return { ok: true, draft, optional: [], removed: [] };
}

/** The offset preview: polylines of the copies. */
export function offsetPreview(d: SketchDraft, id: string, side: 1 | -1, both: boolean, distance: number): [Vec2, Vec2][] {
  const chain = chainOf(d, id);
  if (!chain) return [];
  const b = new SketchBuilder(d);
  const out: [Vec2, Vec2][] = [];
  for (const sd of both ? ([1, -1] as const) : [side]) {
    const m = buildOffset(b, d, chain, sd, distance);
    if (typeof m === 'string') continue;
    const r = b.result();
    for (const cid of Object.values(m.entities)) {
      const e = r.entities.find((x) => x.id === cid);
      if (!e) continue;
      const pts = e.kind === 'spline' ? (() => {
        const pp = e.pts.map((p) => r.points[p]);
        try {
          return splinePolyline(fitSpline(pp, { closed: e.closed }), 12);
        } catch {
          return pp;
        }
      })() : samples(r, e, 48);
      for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
    }
  }
  return out;
}

export function offsetTool(mode: SketchMode): SketchTool {
  const units = mode.services.doc.units;
  let expr = storeExpr(String(+(5 / ({ mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length])).toPrecision(6)), 'length', units);
  let both = false;
  const value = () => {
    const r = units.evaluate(expr, 'length');
    return r.ok && r.value > 0 ? r.value : null;
  };
  return {
    id: 'offset',
    hint: () => 'Point at a curve: its chain is offset to the pointer\'s side. Click to place it.',
    cancel: () => {
      mode.setPreview(null);
      return false;
    },
    options(): ToolOption[] {
      return [
        { kind: 'number', id: 'distance', label: 'Distance', expr, quantity: 'length', validate: (v) => (v > 0 ? null : 'Must be more than 0'), set: (e) => void (expr = e) },
        { kind: 'check', id: 'both', label: 'Both sides', value: both, set: (v) => ((both = v), mode.refreshHint()) },
      ];
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      const h = hitTest(d, e.uv, e.px * 3, { points: false });
      const ent = h ? entityOf(d, h.id) : null;
      const ok = !!ent && ent.kind !== 'point';
      if (e.type === 'move') {
        mode.setHover(ok ? h : null);
        const p = emptyPreview();
        const v = value();
        if (ok && v) {
          const chain = chainOf(d, ent!.id);
          if (chain) p.lines = offsetPreview(d, ent!.id, sideOf(d, chain, e.uv), both, v);
        }
        mode.setPreview(p);
        return;
      }
      if (e.type !== 'click') return;
      if (!ok) {
        mode.note('Point at a line, an arc, a circle or a spline to offset');
        return;
      }
      const chain = chainOf(d, ent!.id);
      if (!chain) return;
      const side = sideOf(d, chain, e.uv);
      const id = ent!.id;
      const ex = expr;
      void mode.apply('Offset', (cur) => offsetChain(cur, id, side, both, ex, units)).then(() => mode.setPreview(null));
    },
  };
}
