// Edits on a sketch's data, each returning a new sketch (the old one is left as it was, for
// undo): new points and curves, rectangles with their relations, three-point arcs, splines,
// a fillet at a corner, construction, relations and dimensions, and deletion that takes
// whatever depended on what went. The solver then puts the geometry where its relations
// and dimensions say (src/sketch/solve.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { circleThrough, dist, newId, norm, sub, type SketchConstraint, type SketchDimensionKind, type SketchEntity, type SketchRelationKind, type Vec2 } from './cad';
import { exprOf, type SketchData } from './model';

export const clone = (s: SketchData): SketchData => ({
  points: { ...s.points },
  entities: s.entities.map((e) => ({ ...e }) as SketchEntity),
  constraints: s.constraints.map((c) => ({ ...c, refs: [...c.refs] }) as SketchConstraint),
});

/** A point where `p` is, or an existing one (its id) when `snap` names it. Returns its id. */
export function placePoint(s: SketchData, p: Vec2, snap: string | null): string {
  if (snap && snap !== 'origin' && snap in s.points) return snap;
  const id = newId('pt');
  s.points[id] = [p[0], p[1]];
  // On the origin: a new point held there (the origin is not a stored point).
  if (snap === 'origin') s.constraints.push({ id: newId('c'), kind: 'coincident', refs: [id, 'origin'] });
  return id;
}

export function addLine(s: SketchData, a: string, b: string, construction = false): string {
  const id = newId('e');
  s.entities.push({ id, kind: 'line', p: [a, b], ...(construction ? { construction: true } : {}) } as SketchEntity);
  return id;
}

/** A line, with a horizontal or vertical relation when it is drawn within 2° of one. */
export function addLineInferred(s: SketchData, a: string, b: string): string {
  const id = addLine(s, a, b);
  const d = sub(s.points[b], s.points[a]);
  const ang = Math.abs((Math.atan2(d[1], d[0]) * 180) / Math.PI) % 180;
  if (Math.min(ang, 180 - ang) < 2) s.constraints.push({ id: newId('c'), kind: 'horizontal', refs: [id], inferred: true });
  else if (Math.abs(ang - 90) < 2) s.constraints.push({ id: newId('c'), kind: 'vertical', refs: [id], inferred: true });
  return id;
}

/** A rectangle from two opposite corners: four lines, two horizontal, two vertical. */
export function addRectangle(s: SketchData, p0: Vec2, p1: Vec2, snap0: string | null): string[] {
  const a = placePoint(s, p0, snap0);
  const pa = s.points[a];
  const b = placePoint(s, [p1[0], pa[1]], null);
  const c = placePoint(s, p1, null);
  const d = placePoint(s, [pa[0], p1[1]], null);
  const lines = [addLine(s, a, b), addLine(s, b, c), addLine(s, c, d), addLine(s, d, a)];
  s.constraints.push(
    { id: newId('c'), kind: 'horizontal', refs: [lines[0]] },
    { id: newId('c'), kind: 'horizontal', refs: [lines[2]] },
    { id: newId('c'), kind: 'vertical', refs: [lines[1]] },
    { id: newId('c'), kind: 'vertical', refs: [lines[3]] },
  );
  return lines;
}

export function addCircle(s: SketchData, c: Vec2, r: number, snapC: string | null): string {
  const cid = placePoint(s, c, snapC);
  const id = newId('e');
  s.entities.push({ id, kind: 'circle', c: cid, r } as SketchEntity);
  return id;
}

/** An arc from a to b through m (null when the three points are in line). */
export function addArc3(s: SketchData, a: string, b: string, m: Vec2): string | null {
  const t = circleThrough(s.points[a], m, s.points[b]);
  if (!t) return null;
  const c = placePoint(s, t.c, null);
  const id = newId('e');
  // circleThrough's ccw: whether a -> m -> b turns counter-clockwise, which is the arc's sense from a.
  s.entities.push({ id, kind: 'arc', c, a, b, ...(t.ccw ? {} : { ccw: false }) } as SketchEntity);
  return id;
}

/** A spline fitted through points (two or more). */
export function addSpline(s: SketchData, pts: string[], closed = false): string {
  const id = newId('e');
  s.entities.push({ id, kind: 'spline', form: 'fit', pts, degree: 3, ...(closed ? { closed: true } : {}) } as SketchEntity);
  return id;
}

export function addPointEntity(s: SketchData, p: string): string {
  const id = newId('e');
  s.entities.push({ id, kind: 'point', p } as SketchEntity);
  return id;
}

export function addRelation(s: SketchData, kind: SketchRelationKind, refs: string[]): string {
  const id = newId('c');
  s.constraints.push({ id, kind, refs: [...refs] });
  return id;
}

export function addDimension(s: SketchData, kind: SketchDimensionKind, refs: string[], value: number, at: Vec2 | null): string {
  const id = newId('c');
  s.constraints.push({ id, kind, refs: [...refs], expr: exprOf(value, kind === 'angle' ? 'angle' : 'length'), driving: true, ...(at ? { at } : {}) });
  return id;
}

/** The lines that end at a point (by id). */
function linesAt(s: SketchData, p: string) {
  return s.entities.filter((e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line' && (e.p[0] === p || e.p[1] === p));
}

/**
 * Round the corner at point `p` where exactly two lines meet with an arc of radius `r`
 * (mm): the lines are cut back to where the arc meets them, tangent to it, and the radius
 * is dimensioned. The reason when it cannot be done.
 */
export function fillet(s: SketchData, p: string, r: number): { ok: true; arc: string } | { ok: false; reason: string } {
  const lines = linesAt(s, p);
  if (lines.length !== 2) return { ok: false, reason: 'A fillet goes at a corner where two lines meet.' };
  const P = s.points[p];
  const other = (e: (typeof lines)[number]) => (e.p[0] === p ? e.p[1] : e.p[0]);
  const A = s.points[other(lines[0])];
  const B = s.points[other(lines[1])];
  const u1 = norm(sub(A, P));
  const u2 = norm(sub(B, P));
  const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const half = Math.acos(cos) / 2;
  if (half < 1e-3 || Math.PI / 2 - half < 1e-3) return { ok: false, reason: 'The two lines are in line: there is no corner to round.' };
  const d = r / Math.tan(half);
  if (d >= dist(P, A) || d >= dist(P, B)) return { ok: false, reason: 'That radius is too large for these lines.' };
  const T1: Vec2 = [P[0] + u1[0] * d, P[1] + u1[1] * d];
  const T2: Vec2 = [P[0] + u2[0] * d, P[1] + u2[1] * d];
  const bis = norm([u1[0] + u2[0], u1[1] + u2[1]]);
  const C: Vec2 = [P[0] + (bis[0] * r) / Math.sin(half), P[1] + (bis[1] * r) / Math.sin(half)];
  const t1 = placePoint(s, T1, null);
  const t2 = placePoint(s, T2, null);
  const c = placePoint(s, C, null);
  for (const [e, t] of [
    [lines[0], t1],
    [lines[1], t2],
  ] as const) {
    const k = e.p[0] === p ? 0 : 1;
    const l = s.entities.find((x) => x.id === e.id) as typeof e;
    l.p = (k === 0 ? [t, l.p[1]] : [l.p[0], t]) as [string, string];
  }
  // The short way round from T1 to T2.
  const cr = (T1[0] - C[0]) * (T2[1] - C[1]) - (T1[1] - C[1]) * (T2[0] - C[0]);
  const arc = newId('e');
  s.entities.push({ id: arc, kind: 'arc', c, a: t1, b: t2, ...(cr > 0 ? {} : { ccw: false }) } as SketchEntity);
  // What held the corner point now holds nothing: relations and dimensions on it go.
  s.constraints = s.constraints.filter((x) => !x.refs.includes(p));
  delete s.points[p];
  s.constraints.push({ id: newId('c'), kind: 'tangent', refs: [lines[0].id, arc] }, { id: newId('c'), kind: 'tangent', refs: [lines[1].id, arc] });
  addDimension(s, 'radius', [arc], r, null);
  return { ok: true, arc };
}

/** Points an entity uses. */
export function usedPoints(e: SketchEntity): string[] {
  switch (e.kind) {
    case 'point':
      return [e.p];
    case 'line':
      return [...e.p];
    case 'circle':
      return [e.c];
    case 'arc':
      return [e.c, e.a, e.b];
    case 'spline':
      return [...e.pts, ...((e.handles ?? []).filter(Boolean) as string[])];
  }
}

/**
 * Delete entities, constraints and points by id, with everything that depended on them:
 * constraints on a deleted entity or point, and points no entity uses any more.
 */
export function deleteItems(s0: SketchData, ids: readonly string[]): SketchData {
  const s = clone(s0);
  const gone = new Set(ids);
  // A deleted point takes the entities on it.
  s.entities = s.entities.filter((e) => !gone.has(e.id) && !usedPoints(e).some((p) => gone.has(p)));
  const used = new Set(s.entities.flatMap(usedPoints));
  for (const id of Object.keys(s.points)) if (!used.has(id)) delete s.points[id];
  const live = (r: string) => r === 'origin' || r in s.points || s.entities.some((e) => e.id === r);
  s.constraints = s.constraints.filter((c) => !gone.has(c.id) && c.refs.every(live));
  return s;
}

export function toggleConstruction(s0: SketchData, ids: readonly string[]): SketchData {
  const s = clone(s0);
  const want = !s.entities.filter((e) => ids.includes(e.id)).every((e) => e.construction);
  s.entities = s.entities.map((e) => (ids.includes(e.id) && e.kind !== 'point' ? ({ ...e, construction: want || undefined } as SketchEntity) : e));
  return s;
}
