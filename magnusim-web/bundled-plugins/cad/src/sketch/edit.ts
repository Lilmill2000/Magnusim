// Sketch edits as pure functions on the sketch's geometry and constraints:
// add points, entities, relations and dimensions; delete with what depends on
// it; construction on and off; trim and extend with lineage (§4.5 point 1: the
// piece that keeps the entity's id is the one at its start, other pieces are
// `<id>.b`, `<id>.c`, ... with `parent`). Every edit returns a new draft; sketch
// mode solves it, then stores it (one session update = one sketch undo step).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../lib/ids';
import type { SketchConstraint, SketchDimension, SketchDimensionKind, SketchEntity, SketchFeature, SketchRelation, SketchRelationKind, Vec2 } from '../types/doc';
import { angleOf, arcParam, circleCircle, dist, lineCircle, lineLine, onArcAngle, polar, TAU, wrap } from './geom';
import { arcGeom, closestOn, entityOf, entityPoints, isDimension, lineEnds, ORIGIN, pointAt } from './model';
// P4b (SKETCH): splines in trim and extend.
import { meetCurves, meetRaySpline, onSplineRelation, splineDomainOf, splineParam, splinePiece, trimSplineAt } from './tools/spline-edit';

// P4b (SELECT): a draft may carry the sketch's links (linked geometry); edits that do not touch them keep them.
export type SketchDraft = Pick<SketchFeature, 'points' | 'entities' | 'constraints'> & Partial<Pick<SketchFeature, 'links'>>;

/** Builds one edit on a copy of a draft. `optional` constraints may be dropped when they over-define the sketch (inference). */
export class SketchBuilder {
  points: Record<string, Vec2>;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  /** Inferred / helper constraints sketch mode drops again when the solver finds them redundant or conflicting. */
  readonly optional = new Set<string>();

  /** P4b (SELECT): the sketch's links, when an edit adds one (a snap on the model). */
  links: SketchFeature['links'];

  constructor(d: SketchDraft) {
    this.points = { ...d.points };
    this.entities = [...d.entities];
    this.constraints = [...d.constraints];
    this.links = d.links;
  }

  result(): SketchDraft {
    return { points: this.points, entities: this.entities, constraints: this.constraints, ...(this.links ? { links: this.links } : {}) };
  }

  point(id: string): Vec2 | null {
    return pointAt(this, id);
  }

  addPoint(at: Vec2, id: string = newId('pt')): string {
    this.points[id] = [at[0], at[1]];
    return id;
  }

  movePoint(id: string, at: Vec2) {
    if (this.points[id]) this.points[id] = [at[0], at[1]];
  }

  addEntity<E extends SketchEntity>(e: E): string {
    this.entities.push(e);
    return e.id;
  }

  replaceEntity(e: SketchEntity) {
    this.entities = this.entities.map((x) => (x.id === e.id ? e : x));
  }

  addRelation(kind: SketchRelationKind, refs: string[], opts: { optional?: boolean; inferred?: boolean; value?: Vec2; id?: string } = {}): string {
    const id = opts.id ?? newId('c');
    const c: SketchRelation = { id, kind, refs, ...(opts.inferred ? { inferred: true } : {}), ...(opts.value ? { value: opts.value } : {}) };
    this.constraints.push(c);
    if (opts.optional) this.optional.add(id);
    return id;
  }

  addDimension(kind: SketchDimensionKind, refs: string[], expr: string, opts: { driving?: boolean; at?: Vec2; id?: string } = {}): string {
    const id = opts.id ?? newId('c');
    const d: SketchDimension = { id, kind, refs, expr, driving: opts.driving ?? true, ...(opts.at ? { at: [opts.at[0], opts.at[1]] as Vec2 } : {}) };
    this.constraints.push(d);
    return id;
  }

  removeConstraints(ids: Iterable<string>) {
    const set = new Set(ids);
    this.constraints = this.constraints.filter((c) => !set.has(c.id));
  }

  /** Whether any entity uses a point. */
  pointUsed(id: string): boolean {
    return this.entities.some((e) => entityPoints(e).includes(id));
  }

  /**
   * Delete entities, points and constraints. An entity takes its constraints
   * with it, and its points when nothing else uses them; a point takes the
   * entities that use it (a line without its end is not a line).
   */
  remove(ids: Iterable<string>) {
    const gone = new Set(ids);
    // Points take the entities built on them.
    for (const id of [...gone]) {
      if (this.points[id]) for (const e of this.entities) if (entityPoints(e).includes(id)) gone.add(e.id);
    }
    const goneEntities = this.entities.filter((e) => gone.has(e.id));
    this.entities = this.entities.filter((e) => !gone.has(e.id));
    for (const e of goneEntities) for (const p of entityPoints(e)) if (!this.pointUsed(p)) gone.add(p);
    for (const id of [...gone]) if (this.points[id] && !this.pointUsed(id)) delete this.points[id];
    // Points no entity uses any more and that were picked go too; constraints on anything gone.
    this.constraints = this.constraints.filter((c) => !gone.has(c.id) && !c.refs.some((r) => gone.has(r)));
    // A collinear pair or a symmetric axis that lost a line also lost its meaning (handled above by refs).
  }
}

/** The next free lineage id for a piece of `id`: `<id>.b`, `<id>.c`, ... */
export function lineageId(entities: readonly SketchEntity[], id: string): string {
  const used = new Set(entities.map((e) => e.id));
  for (let i = 1; i < 26; i++) {
    const cand = `${id}.${String.fromCharCode(97 + i)}`;
    if (!used.has(cand)) return cand;
  }
  return `${id}.${newId('e').slice(2, 8)}`;
}

/** Construction on for every picked entity, or off when they all are already. */
export function toggleConstruction(d: SketchDraft, ids: readonly string[]): SketchDraft | null {
  const picked = d.entities.filter((e) => ids.includes(e.id) && e.kind !== 'point');
  if (!picked.length) return null;
  const allOn = picked.every((e) => e.construction);
  const entities = d.entities.map((e) => {
    if (!picked.includes(e)) return e;
    if (allOn) {
      const { construction: _c, ...rest } = e as SketchEntity & { construction?: boolean; centerline?: boolean };
      if (rest.kind === 'line') delete (rest as { centerline?: boolean }).centerline;
      return rest as SketchEntity;
    }
    return { ...e, construction: true } as SketchEntity;
  });
  return { ...d, entities };
}

// ---- ux010 (DRAW): construction drawing
/** The tools whose shapes construction drawing makes construction (points stay points; a centerline is construction always). */
const CONSTRUCTION_TOOLS = new Set(['line', 'rectangle-corner', 'rectangle-center', 'circle', 'arc-3pt', 'arc-tangent', 'spline-fit', 'spline-control']);
export function drawsConstruction(tool: string | null | undefined): boolean {
  return !!tool && CONSTRUCTION_TOOLS.has(tool);
}

/** The curves an edit added (not in `before`; not points, not linked references) made construction. */
export function asConstruction<T extends SketchDraft>(before: SketchDraft, after: T): T {
  const had = new Set(before.entities.map((e) => e.id));
  let changed = false;
  const entities = after.entities.map((e) => {
    if (had.has(e.id) || e.kind === 'point' || e.construction || (e as { link?: string }).link) return e;
    changed = true;
    return { ...e, construction: true } as SketchEntity;
  });
  return changed ? { ...after, entities } : after;
}

// ------------------------------------------------------------ trim and extend

/** Where a curve crosses another one, as positions along it (line: t in [0,1]; arc: 0..1 from its ccw start; circle: angle). */
interface Crossing {
  t: number;
  p: Vec2;
  /** The entity it crosses. */
  by: string;
}

function crossingsOn(d: SketchDraft, e: SketchEntity): Crossing[] {
  const out: Crossing[] = [];
  const self = e.id;
  const ownPoints = new Set(entityPoints(e));
  for (const o of d.entities) {
    if (o.id === self || o.kind === 'point') continue;
    for (const p of meet(d, e, o)) {
      // A crossing at a point the two share is a joint, not a cut.
      if ([...ownPoints].some((q) => {
        const qp = pointAt(d, q);
        return qp && dist(qp, p) < 1e-9 * Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
      })) continue;
      const t = paramOn(d, e, p);
      if (t != null) out.push({ t, p, by: o.id });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Position along an entity of a point on it (see Crossing.t). */
export function paramOn(d: SketchDraft, e: SketchEntity, p: Vec2): number | null {
  if (e.kind === 'line') {
    const ends = lineEnds(d, e.id);
    if (!ends) return null;
    const ab: Vec2 = [ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1];
    return l2 ? ((p[0] - ends[0][0]) * ab[0] + (p[1] - ends[0][1]) * ab[1]) / l2 : null;
  }
  if (e.kind === 'circle') {
    const c = pointAt(d, e.c);
    return c ? wrap(angleOf(c, p)) : null;
  }
  if (e.kind === 'arc') {
    const g = arcGeom(d, e);
    return g ? arcParam(g, angleOf(g.c, p)) : null;
  }
  // P4b (SKETCH): a spline's own parameter.
  if (e.kind === 'spline') return splineParam(d, e, p);
  return null;
}

/** Where two curves meet (each within its own extent). */
function meet(d: SketchDraft, a: SketchEntity, b: SketchEntity): Vec2[] {
  // P4b (SKETCH): any pair with a spline is crossed as parametric curves.
  if (a.kind === 'spline' || b.kind === 'spline') return meetCurves(d, a, b);
  const circ = (e: SketchEntity) => {
    if (e.kind === 'circle') {
      const c = pointAt(d, e.c);
      return c ? { c, r: e.r, arc: null as ReturnType<typeof arcGeom> } : null;
    }
    if (e.kind === 'arc') {
      const g = arcGeom(d, e);
      return g ? { c: g.c, r: g.r, arc: g } : null;
    }
    return null;
  };
  const onArc = (k: ReturnType<typeof circ>, p: Vec2) => !k?.arc || onArcAngle(k.arc, angleOf(k.c, p), 1e-9);
  const sa = a.kind === 'line' ? lineEnds(d, a.id) : null;
  const sb = b.kind === 'line' ? lineEnds(d, b.id) : null;
  const ca = circ(a);
  const cb = circ(b);
  const eps = 1e-9;
  if (sa && sb) {
    const x = lineLine(sa[0], sa[1], sb[0], sb[1]);
    return x && x.t >= -eps && x.t <= 1 + eps && x.s >= -eps && x.s <= 1 + eps ? [x.p] : [];
  }
  if (sa && cb) return lineCircle(sa[0], sa[1], cb.c, cb.r).filter((x) => x.t >= -eps && x.t <= 1 + eps && onArc(cb, x.p)).map((x) => x.p);
  if (ca && sb) return lineCircle(sb[0], sb[1], ca.c, ca.r).filter((x) => x.t >= -eps && x.t <= 1 + eps && onArc(ca, x.p)).map((x) => x.p);
  if (ca && cb) return circleCircle(ca.c, ca.r, cb.c, cb.r).filter((p) => onArc(ca, p) && onArc(cb, p));
  return [];
}

function onCurveRelation(b: SketchBuilder, pointId: string, by: string) {
  const o = entityOf(b, by);
  if (!o) return;
  // P4b (SKETCH): a fit spline takes the point as a fit point; a control spline has no on-curve relation.
  if (o.kind === 'spline') return onSplineRelation(b, pointId, o);
  b.addRelation(o.kind === 'line' ? 'point_on_line' : 'point_on_circle', [pointId, by], { optional: true });
}

/** Constraints that hold the extent of an entity (its length or span), which a trim or extend changes. */
function extentDimensions(d: SketchDraft, id: string): string[] {
  return d.constraints.filter((c) => isDimension(c) && c.kind === 'distance' && c.refs.length === 1 && c.refs[0] === id).map((c) => c.id);
}

export type EditOutcome = { ok: true; draft: SketchDraft; optional: string[]; removed: string[] } | { ok: false; reason: string };

function done(b: SketchBuilder, removed: string[] = []): EditOutcome {
  return { ok: true, draft: b.result(), optional: [...b.optional], removed };
}

/**
 * Trim the piece of entity `id` around `at` up to the nearest crossings with
 * other curves (or delete the entity when nothing crosses it). The piece at the
 * entity's start keeps its id; a piece after the cut is `<id>.b` with `parent`.
 * New ends lie on the curves that cut them (on-line / on-curve).
 */
export function trimAt(d: SketchDraft, id: string, at: Vec2): EditOutcome {
  const e = entityOf(d, id);
  if (!e || e.kind === 'point') return { ok: false, reason: 'Trim works on lines, arcs and circles' };
  const near = closestOn(d, e, at);
  if (!near) return { ok: false, reason: 'That entity is not in the sketch' };
  const t0 = paramOn(d, e, near);
  if (t0 == null) return { ok: false, reason: 'That entity is not in the sketch' };
  const xs = crossingsOn(d, e);
  // P4b (SKETCH): a spline is cut in its own parameter (src/sketch/tools/spline-edit.ts).
  if (e.kind === 'spline') return trimSplineAt(d, e, t0, xs, onCurveRelation);
  const b = new SketchBuilder(d);

  if (e.kind === 'circle') {
    const inner = xs.filter((x, i) => i === 0 || Math.abs(x.t - xs[i - 1].t) > 1e-9);
    if (!inner.length) {
      b.remove([id]);
      return done(b, [id]);
    }
    if (inner.length < 2) return { ok: false, reason: 'A circle is trimmed between two crossings: this one is crossed once' };
    // The crossings just before and after the picked angle (cyclic): the circle keeps the rest as an arc.
    const after = inner.find((x) => x.t > t0) ?? inner[0];
    const before = [...inner].reverse().find((x) => x.t < t0) ?? inner[inner.length - 1];
    if (after === before) return { ok: false, reason: 'A circle is trimmed between two crossings: this one is crossed once' };
    const pa = b.addPoint(after.p);
    const pb = b.addPoint(before.p);
    // ccw from `after` round to `before` is what stays.
    b.replaceEntity({ id, kind: 'arc', c: e.c, a: pa, b: pb, ...(e.construction ? { construction: true } : {}), ...(e.parent ? { parent: e.parent } : {}) });
    onCurveRelation(b, pa, after.by);
    onCurveRelation(b, pb, before.by);
    return done(b);
  }

  const inner = xs.filter((x) => x.t > 1e-9 && x.t < 1 - 1e-9);
  const lower = [...inner].reverse().find((x) => x.t < t0) ?? null;
  const upper = inner.find((x) => x.t > t0) ?? null;
  if (!lower && !upper) {
    b.remove([id]);
    return done(b, [id]);
  }
  b.removeConstraints(extentDimensions(d, id));
  const startId = e.kind === 'line' ? e.p[0] : e.ccw !== false ? e.a : e.b;
  const endId = e.kind === 'line' ? e.p[1] : e.ccw !== false ? e.b : e.a;
  const setEnds = (ent: SketchEntity, s: string, en: string): SketchEntity => {
    if (ent.kind === 'line') return { ...ent, p: [s, en] };
    if (ent.kind === 'arc') return ent.ccw !== false ? { ...ent, a: s, b: en } : { ...ent, a: en, b: s };
    return ent;
  };
  const dropIfUnused = (pid: string) => {
    if (!b.pointUsed(pid)) b.remove([pid]);
  };
  if (lower && upper) {
    // Split: the start piece keeps the id, the end piece is new (lineage).
    const x1 = b.addPoint(lower.p);
    const x2 = b.addPoint(upper.p);
    const pieceId = lineageId(b.entities, id);
    b.replaceEntity(setEnds(e, startId, x1));
    const piece = setEnds({ ...e, id: pieceId, parent: id } as SketchEntity, x2, endId);
    b.addEntity(piece);
    onCurveRelation(b, x1, lower.by);
    onCurveRelation(b, x2, upper.by);
    // The two pieces stay one line (collinear) or one circle (same centre, equal radius).
    if (e.kind === 'line') b.addRelation('collinear', [id, pieceId], { optional: true });
    else b.addRelation('equal', [id, pieceId], { optional: true });
    // Relations of the old entity that sit on the new piece follow it: a point on the curve beyond the
    // cut, and a tangency at the old end point (review P2/P3 round 1: "On line: ..., Line 1" for a
    // point on Line 4).
    b.constraints = b.constraints.map((c) => {
      if ((c.kind === 'point_on_line' || c.kind === 'point_on_circle') && c.refs[1] === id) {
        const p = pointAt(d, c.refs[0]);
        const t = p ? paramOn(d, e, p) : null;
        if (t != null && t > upper.t) return { ...c, refs: [c.refs[0], pieceId] } as SketchConstraint;
      }
      if (c.kind === 'tangent' && c.refs.includes(id)) {
        const other = c.refs.find((r) => r !== id);
        const o = other ? entityOf(d, other) : null;
        const ends = o ? entityPoints(o) : [];
        if (ends.includes(endId) && !ends.includes(startId)) return { ...c, refs: c.refs.map((r) => (r === id ? pieceId : r)) } as SketchConstraint;
      }
      return c;
    });
    return done(b);
  }
  if (upper) {
    // Cut away the start up to the first crossing.
    const x = b.addPoint(upper.p);
    b.replaceEntity(setEnds(e, x, endId));
    onCurveRelation(b, x, upper.by);
    dropIfUnused(startId);
    return done(b);
  }
  // Cut away the end from the last crossing.
  const x = b.addPoint(lower!.p);
  b.replaceEntity(setEnds(e, startId, x));
  onCurveRelation(b, x, lower!.by);
  dropIfUnused(endId);
  return done(b);
}

/**
 * Extend the end of a line or an arc nearest `at` to the first curve it meets
 * beyond that end. The end must be free (no other entity uses its point).
 */
export function extendAt(d: SketchDraft, id: string, at: Vec2): EditOutcome {
  const e = entityOf(d, id);
  if (!e || (e.kind !== 'line' && e.kind !== 'arc')) return { ok: false, reason: 'Extend works on lines and arcs' };
  const b = new SketchBuilder(d);
  let endId: string;
  let target: { p: Vec2; by: string } | null = null;
  if (e.kind === 'line') {
    const ends = lineEnds(d, id)!;
    const atEnd = dist(at, ends[1]) <= dist(at, ends[0]) ? 1 : 0;
    endId = e.p[atEnd];
    const from = ends[atEnd];
    const other = ends[1 - atEnd];
    const dir: Vec2 = [from[0] - other[0], from[1] - other[1]];
    const l = Math.hypot(dir[0], dir[1]);
    if (!l) return { ok: false, reason: 'That line has no length' };
    let best = Infinity;
    for (const o of d.entities) {
      if (o.id === id || o.kind === 'point') continue;
      for (const p of meetRay(d, from, dir, o)) {
        const s = ((p[0] - from[0]) * dir[0] + (p[1] - from[1]) * dir[1]) / (l * l);
        if (s > 1e-9 && s < best) {
          best = s;
          target = { p, by: o.id };
        }
      }
    }
  } else {
    const g = arcGeom(d, e)!;
    const s = polar(g.c, g.r, g.a0);
    const en = polar(g.c, g.r, g.a0 + g.sweep);
    const atEndOfSweep = dist(at, en) <= dist(at, s);
    endId = atEndOfSweep ? (e.ccw !== false ? e.b : e.a) : e.ccw !== false ? e.a : e.b;
    // Continue the circle beyond that end: the nearest crossing in angle, outside the arc.
    let best = Infinity;
    for (const o of d.entities) {
      if (o.id === id || o.kind === 'point') continue;
      const full = { kind: 'circle', id: '#full', c: e.c, r: g.r } as SketchEntity;
      for (const p of meet({ ...d, entities: [...d.entities, full] }, full, o)) {
        const a = angleOf(g.c, p);
        const beyond = atEndOfSweep ? wrap(a - (g.a0 + g.sweep)) : wrap(g.a0 - a);
        if (beyond > 1e-9 && beyond < TAU - g.sweep && beyond < best) {
          best = beyond;
          target = { p, by: o.id };
        }
      }
    }
  }
  const users = d.entities.filter((x) => x.id !== id && entityPoints(x).includes(endId));
  if (users.length) return { ok: false, reason: 'Extend works on a free end: this end joins other geometry' };
  if (!target) return { ok: false, reason: 'Nothing to extend to: no curve lies beyond that end' };
  b.removeConstraints(extentDimensions(d, id));
  // What held the end where it was would pull it back.
  b.removeConstraints(d.constraints.filter((c) => c.refs.includes(endId)).map((c) => c.id));
  b.movePoint(endId, target.p);
  onCurveRelation(b, endId, target.by);
  return done(b);
}

/** Where a ray from `from` along `dir` meets a curve (any parameter; the caller keeps those ahead). */
function meetRay(d: SketchDraft, from: Vec2, dir: Vec2, o: SketchEntity): Vec2[] {
  const to: Vec2 = [from[0] + dir[0], from[1] + dir[1]];
  if (o.kind === 'line') {
    const ends = lineEnds(d, o.id);
    if (!ends) return [];
    const x = lineLine(from, to, ends[0], ends[1]);
    return x && x.s >= -1e-9 && x.s <= 1 + 1e-9 ? [x.p] : [];
  }
  if (o.kind === 'circle') {
    const c = pointAt(d, o.c);
    return c ? lineCircle(from, to, c, o.r).map((x) => x.p) : [];
  }
  if (o.kind === 'arc') {
    const g = arcGeom(d, o);
    return g ? lineCircle(from, to, g.c, g.r).filter((x) => onArcAngle(g, angleOf(g.c, x.p), 1e-9)).map((x) => x.p) : [];
  }
  // P4b (SKETCH)
  if (o.kind === 'spline') return meetRaySpline(d, from, dir, o);
  return [];
}

/** The piece Trim would remove at `at` (a polyline, for the red preview), or null. */
export function trimPiece(d: SketchDraft, id: string, at: Vec2): Vec2[] | null {
  const e = entityOf(d, id);
  if (!e || e.kind === 'point') return null;
  const near = closestOn(d, e, at);
  const t0 = near ? paramOn(d, e, near) : null;
  if (t0 == null) return null;
  const xs = crossingsOn(d, e);
  // P4b (SKETCH): the spline piece between its nearest crossings (wrapping on a closed spline).
  if (e.kind === 'spline') {
    const ends = splineDomainOf(d, e);
    if (!ends) return null;
    const tol = 1e-9 * (ends[1] - ends[0]);
    if (e.closed) {
      if (xs.length < 2) return xs.length ? null : splinePiece(d, e, ends[0], ends[1]);
      const after = xs.find((x) => x.t > t0) ?? xs[0];
      const before = [...xs].reverse().find((x) => x.t < t0) ?? xs[xs.length - 1];
      return splinePiece(d, e, before.t, after.t);
    }
    const inner = xs.filter((x) => x.t > ends[0] + tol && x.t < ends[1] - tol);
    const lo = [...inner].reverse().find((x) => x.t < t0)?.t ?? ends[0];
    const hi = inner.find((x) => x.t > t0)?.t ?? ends[1];
    return splinePiece(d, e, lo, hi);
  }
  const sampleArc = (c: Vec2, r: number, a0: number, sweep: number) => {
    const n = Math.max(4, Math.ceil((sweep / TAU) * 64));
    return Array.from({ length: n + 1 }, (_, i) => polar(c, r, a0 + (sweep * i) / n));
  };
  if (e.kind === 'circle') {
    const c = pointAt(d, e.c)!;
    if (xs.length < 2) return xs.length ? null : sampleArc(c, e.r, 0, TAU);
    const after = xs.find((x) => x.t > t0) ?? xs[0];
    const before = [...xs].reverse().find((x) => x.t < t0) ?? xs[xs.length - 1];
    return sampleArc(c, e.r, before.t, wrap(after.t - before.t) || TAU);
  }
  const inner = xs.filter((x) => x.t > 1e-9 && x.t < 1 - 1e-9);
  const lo = [...inner].reverse().find((x) => x.t < t0)?.t ?? 0;
  const hi = inner.find((x) => x.t > t0)?.t ?? 1;
  if (e.kind === 'line') {
    const ends = lineEnds(d, id)!;
    const at2 = (t: number): Vec2 => [ends[0][0] + (ends[1][0] - ends[0][0]) * t, ends[0][1] + (ends[1][1] - ends[0][1]) * t];
    return [at2(lo), at2(hi)];
  }
  const g = arcGeom(d, e)!;
  return sampleArc(g.c, g.r, g.a0 + g.sweep * lo, g.sweep * (hi - lo));
}

/** Where Extend would take the end nearest `at` (for the preview), or null. */
export function extendPreview(d: SketchDraft, id: string, at: Vec2): [Vec2, Vec2] | null {
  const r = extendAt(d, id, at);
  if (!r.ok) return null;
  const e = entityOf(d, id);
  const after = entityOf(r.draft, id);
  if (!e || !after) return null;
  const ends = (x: SketchEntity, dd: SketchDraft) => (x.kind === 'line' ? [x.p[0], x.p[1]] : x.kind === 'arc' ? [x.a, x.b] : []).map((p) => pointAt(dd, p)!);
  const a = ends(e, d);
  const b = ends(after, r.draft);
  for (let i = 0; i < a.length; i++) if (dist(a[i], b[i]) > 1e-12) return [a[i], b[i]];
  return null;
}

/** Ids the edit's constraints reference that are gone (a guard for tests). */
export function danglingRefs(d: SketchDraft): string[] {
  const ok = new Set<string>([ORIGIN, ...Object.keys(d.points), ...d.entities.map((e) => e.id)]);
  const out: string[] = [];
  for (const c of d.constraints) for (const r of c.refs) if (!ok.has(r)) out.push(`${c.id}:${r}`);
  for (const e of d.entities) for (const p of entityPoints(e)) if (!ok.has(p)) out.push(`${e.id}:${p}`);
  return out;
}
