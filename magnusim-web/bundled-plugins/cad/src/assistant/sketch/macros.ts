// The sketch tool's entity kinds as the Part's own sketch geometry (CAD tools spec §6.3 Macros):
// each kind with its `at` numbers becomes points, lines, circles and arcs whose ids are the
// model's id and a part ("r" -> r__bl, r__bottom, ...; the model writes r.bl, r.bottom), with the
// relations that keep its shape (a rectangle's horizontals and verticals, a slot's tangents):
//   point        [u, v]                       P, its point P__p                          2 DOF
//   line         [u1, v1, u2, v2]             L__start, L__end, line L                  4
//   centerline   the same, construction (a revolve or mirror axis)
//   polyline     [u1, v1, u2, v2, ...]        points P__p0..., sides P__1...: side k runs from
//                (closed when it ends where it starts, within 0.05 mm)  p(k-1) to pk   2 x points
//   circle       [cu, cv, r]                  C__center, circle C                        3
//   arc          [cu, cv, r, start, end] deg  A__center, A__start, A__end, arc A (ccw)   5
//   rect         [u1, v1, u2, v2] corners     __bl __br __tr __tl, __bottom __right __top
//                                             __left, 2 horizontals + 2 verticals        4
//   center_rect  [cu, cv, width, height]      a rect, a construction point __center and
//                                             symmetric [__bl, __tr, __center]           4
//   slot         [u1, v1, u2, v2, r]          arc centres __a __b, arcs __arc_a __arc_b,
//                                             sides __side1 __side2 (tangent at __p1..__p4),
//                                             equal arcs, construction line __axis       5
//   polygon      [cu, cv, R, sides 3..24]     __center, construction circle __circle,
//                                             corners __p1... on it (__p1 on +u), sides
//                                             __s1... (sk from pk), all sides equal      4
//   sector       [cu, cv, r1, r2, start, end] __center, arcs __inner __outer, radial lines
//                deg, 0 < r1 < r2             __start __end through the centre, their ends
//                                             __inner_start ... __outer_end              6
//   spline       [u1, v1, u2, v2, ...]        a fit-point spline S through points S__p0...
//                (closed when it ends where   (the person's Spline tool: a cubic, chord-length
//                it starts)                   parameters); S.start, S.end; S.h0, S.h1 once a
//                                             tangent gave it end handles           2 x points
//   control_spline [u1, v1, ..., degree]      a control-point spline on poles S__p0... of
//                (closed as a spline; degree  degree 3 or 5 (degree + 1 poles or more)
//                3 or 5)                                                          2 x points
// Pure functions; compile.ts checks ids, joins points and resolves the constraints' refs.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { splineCurve } from '../../sketch/tools/bspline';
import type { SketchEntity, SketchRelation, Vec2 } from '../../types/doc';
import type { SKETCH_ENTITY_KINDS } from '../schemas';

/** The fewest points a spline takes (the person's Spline tools: fit 2 open, 3 closed; control degree + 1). */
export function splineMinPoints(form: 'fit' | 'control', degree: number, closed: boolean): number {
  if (form === 'control') return degree + 1;
  return closed ? 3 : 2;
}

export type EntityKind = (typeof SKETCH_ENTITY_KINDS)[number];

/** The `at` each kind takes, in words (bad_entity, help sketch). */
export const AT_WORDS: Readonly<Record<EntityKind, string>> = Object.freeze({
  point: '[u, v]',
  line: '[u1, v1, u2, v2]',
  centerline: '[u1, v1, u2, v2]',
  polyline: '[u1, v1, u2, v2, ...] (an even count, 4 or more; closed when the last point is the first)',
  circle: '[cu, cv, r]',
  arc: '[cu, cv, r, start deg, end deg] (counter-clockwise)',
  rect: '[u1, v1, u2, v2] (two opposite corners)',
  center_rect: '[cu, cv, width, height]',
  slot: '[u1, v1, u2, v2, r] (the two arc centres and the radius)',
  polygon: '[cu, cv, R, sides] (3 to 24 sides; R to the corners)',
  sector: '[cu, cv, r1, r2, start deg, end deg] (0 < r1 < r2, counter-clockwise)',
  spline: '[u1, v1, u2, v2, ...] (the fit points it passes through, 2 or more; closed when the last point is the first, 3 or more then)',
  control_spline: '[u1, v1, ..., un, vn, degree] (the poles, then the degree 3 or 5; degree + 1 poles or more; closed when the last pole is the first)',
});

/** The DOF each kind keeps after its own relations (help sketch; polyline: 2 per point). */
export const KIND_DOF: Readonly<Record<EntityKind, number | null>> = Object.freeze({ point: 2, line: 4, centerline: 4, polyline: null, circle: 3, arc: 5, rect: 4, center_rect: 4, slot: 5, polygon: 4, sector: 6, spline: null, control_spline: null });

/** Ends this close are one point (mm): joins, closed polylines, infer. */
export const JOIN_TOL = 0.05;

export interface MacroPoint {
  /** The stored id (<id>__<part>). */
  id: string;
  /** Its part as the model writes it after "<id>." ('' for a point entity: the model writes the id alone). */
  part: string;
  at: Vec2;
}

export interface Macro {
  id: string;
  kind: EntityKind;
  points: MacroPoint[];
  entities: SketchEntity[];
  /** The relations that keep its shape (stored ids and refs). */
  relations: SketchRelation[];
  /** The model's parts: part -> stored id ('' is the entity itself, for the one-entity kinds). */
  parts: Record<string, string>;
  /** Lines `infer` may make horizontal or vertical (lines, centerlines, polyline sides). */
  inferLines: string[];
  /** Each own relation in words ("r's own horizontal on r.top"). */
  words: Record<string, string>;
}

export type MacroResult = { ok: true; macro: Macro } | { ok: false; problem: string };

const DEG = Math.PI / 180;
const S = (id: string, part: string) => `${id}__${part}`;
const polar = (c: Vec2, r: number, deg: number): Vec2 => [c[0] + r * Math.cos(deg * DEG), c[1] + r * Math.sin(deg * DEG)];
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** The counter-clockwise sweep from `s` to `e` degrees, in [0, 360). */
export const sweepOf = (s: number, e: number) => (((e - s) % 360) + 360) % 360;

class Builder {
  readonly m: Macro;
  constructor(
    id: string,
    kind: EntityKind,
    private readonly construction: boolean,
  ) {
    this.m = { id, kind, points: [], entities: [], relations: [], parts: {}, inferLines: [], words: {} };
  }
  point(part: string, at: Vec2, as = part): string {
    const id = as ? S(this.m.id, as) : S(this.m.id, 'p');
    this.m.points.push({ id, part, at: [at[0], at[1]] });
    if (part) this.m.parts[part] = id;
    return id;
  }
  private flags(extra?: { construction?: boolean }) {
    return this.construction || extra?.construction ? { construction: true } : {};
  }
  line(part: string, a: string, b: string, extra?: { construction?: boolean; centerline?: boolean }): string {
    const id = part ? S(this.m.id, part) : this.m.id;
    this.m.entities.push({ id, kind: 'line', p: [a, b], ...this.flags(extra), ...(extra?.centerline ? { centerline: true } : {}) });
    this.m.parts[part] = id;
    return id;
  }
  circle(part: string, c: string, r: number, extra?: { construction?: boolean }): string {
    const id = part ? S(this.m.id, part) : this.m.id;
    this.m.entities.push({ id, kind: 'circle', c, r, ...this.flags(extra) });
    this.m.parts[part] = id;
    return id;
  }
  arc(part: string, c: string, a: string, b: string): string {
    const id = part ? S(this.m.id, part) : this.m.id;
    this.m.entities.push({ id, kind: 'arc', c, a, b, ...this.flags() });
    this.m.parts[part] = id;
    return id;
  }
  /** A spline as the person's Spline tools store it (src/sketch/tools/spline.ts). */
  spline(form: 'fit' | 'control', pts: string[], degree: number, closed: boolean): string {
    const id = this.m.id;
    this.m.entities.push({ id, kind: 'spline', form, pts, degree, ...(closed ? { closed: true } : {}), ...this.flags() });
    this.m.parts[''] = id;
    return id;
  }
  pointEntity(part: string, p: string, extra?: { construction?: boolean }): string {
    const id = part ? S(this.m.id, part) : this.m.id;
    this.m.entities.push({ id, kind: 'point', p, ...this.flags(extra) });
    this.m.parts[part] = id;
    return id;
  }
  rel(name: string, kind: SketchRelation['kind'], refs: string[], words: string) {
    const id = S(this.m.id, name);
    this.m.relations.push({ id, kind, refs });
    this.m.words[id] = `${this.m.id}'s own ${words}`;
  }
}

const finite = (at: readonly number[]) => at.every((v) => typeof v === 'number' && Number.isFinite(v));

/** A rectangle's points, sides and own relations, corners counter-clockwise from the lower left (as the Rectangle tool). */
function rectInto(b: Builder, lo: Vec2, hi: Vec2) {
  const id = b.m.id;
  const bl = b.point('bl', lo);
  const br = b.point('br', [hi[0], lo[1]]);
  const tr = b.point('tr', hi);
  const tl = b.point('tl', [lo[0], hi[1]]);
  const bottom = b.line('bottom', bl, br);
  const right = b.line('right', br, tr);
  const top = b.line('top', tr, tl);
  const left = b.line('left', tl, bl);
  b.rel('h_bottom', 'horizontal', [bottom], `horizontal on ${id}.bottom`);
  b.rel('v_right', 'vertical', [right], `vertical on ${id}.right`);
  b.rel('h_top', 'horizontal', [top], `horizontal on ${id}.top`);
  b.rel('v_left', 'vertical', [left], `vertical on ${id}.left`);
  return { bl, tr };
}

/** One entity of the tool's input as sketch geometry, or why its numbers do not make one. */
export function expandEntity(id: string, kind: EntityKind, at: readonly number[], construction: boolean): MacroResult {
  const bad = (problem: string): MacroResult => ({ ok: false, problem });
  const want = (n: number): MacroResult | null => (at.length === n ? null : bad(`a ${kind} takes ${n} numbers ${AT_WORDS[kind]}, not ${at.length}`));
  if (!finite(at)) return bad('every number must be finite');
  const b = new Builder(id, kind, construction);
  switch (kind) {
    case 'point': {
      const w = want(2);
      if (w) return w;
      const p = b.point('', [at[0], at[1]]);
      b.pointEntity('', p);
      break;
    }
    case 'line':
    case 'centerline': {
      const w = want(4);
      if (w) return w;
      const a: Vec2 = [at[0], at[1]];
      const c: Vec2 = [at[2], at[3]];
      if (dist(a, c) <= JOIN_TOL) return bad(`its ends are ${dist(a, c).toFixed(3)} mm apart: a ${kind} needs a length`);
      const s = b.point('start', a);
      const e = b.point('end', c);
      b.line('', s, e, kind === 'centerline' ? { construction: true, centerline: true } : undefined);
      b.m.inferLines.push(id);
      break;
    }
    case 'polyline': {
      if (at.length < 4 || at.length % 2) return bad(`a polyline takes an even count of numbers, 4 or more ${AT_WORDS.polyline}, not ${at.length}`);
      const pts: Vec2[] = [];
      for (let i = 0; i < at.length; i += 2) pts.push([at[i], at[i + 1]]);
      const closed = pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) <= JOIN_TOL;
      const corners = closed ? pts.slice(0, -1) : pts;
      if (closed && corners.length < 3) return bad('a closed polyline needs 3 corners or more');
      const ids = corners.map((p, i) => b.point(`p${i}`, p));
      const sides = closed ? corners.length : corners.length - 1;
      for (let k = 1; k <= sides; k++) {
        const from = corners[k - 1];
        const to = corners[k % corners.length];
        if (dist(from, to) <= JOIN_TOL) return bad(`side ${k} (p${k - 1} to p${k % corners.length}) has no length`);
        b.m.inferLines.push(b.line(String(k), ids[k - 1], ids[k % corners.length]));
      }
      break;
    }
    case 'circle': {
      const w = want(3);
      if (w) return w;
      if (!(at[2] > 0)) return bad('its radius must be more than 0');
      b.circle('', b.point('center', [at[0], at[1]]), at[2]);
      break;
    }
    case 'arc': {
      const w = want(5);
      if (w) return w;
      const [cu, cv, r, s, e] = at;
      if (!(r > 0)) return bad('its radius must be more than 0');
      const sweep = sweepOf(s, e);
      if (sweep < 1e-6 || 360 - sweep < 1e-6) return bad('its start and end angles are the same: use a circle for a whole one');
      const c: Vec2 = [cu, cv];
      b.arc('', b.point('center', c), b.point('start', polar(c, r, s)), b.point('end', polar(c, r, e)));
      break;
    }
    case 'rect': {
      const w = want(4);
      if (w) return w;
      const lo: Vec2 = [Math.min(at[0], at[2]), Math.min(at[1], at[3])];
      const hi: Vec2 = [Math.max(at[0], at[2]), Math.max(at[1], at[3])];
      if (hi[0] - lo[0] <= JOIN_TOL || hi[1] - lo[1] <= JOIN_TOL) return bad('a rect needs a width and a height');
      rectInto(b, lo, hi);
      break;
    }
    case 'center_rect': {
      const w = want(4);
      if (w) return w;
      const [cu, cv, wd, ht] = at;
      if (!(wd > JOIN_TOL) || !(ht > JOIN_TOL)) return bad('its width and height must be more than 0');
      const { bl, tr } = rectInto(b, [cu - wd / 2, cv - ht / 2], [cu + wd / 2, cv + ht / 2]);
      const cp = b.point('center', [cu, cv], 'center__p');
      const centre = b.pointEntity('center', cp, { construction: true });
      b.rel('sym', 'symmetric', [bl, tr, centre], `centre between ${id}.bl and ${id}.tr`);
      break;
    }
    case 'slot': {
      const w = want(5);
      if (w) return w;
      const A: Vec2 = [at[0], at[1]];
      const B: Vec2 = [at[2], at[3]];
      const r = at[4];
      const L = dist(A, B);
      if (L <= JOIN_TOL) return bad('its two arc centres are the same point');
      if (!(r > 0)) return bad('its radius must be more than 0');
      const d: Vec2 = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
      const n: Vec2 = [-d[1], d[0]];
      const off = (p: Vec2, s: number): Vec2 => [p[0] + s * r * n[0], p[1] + s * r * n[1]];
      const a = b.point('a', A);
      const bb = b.point('b', B);
      const p1 = b.point('p1', off(A, 1));
      const p2 = b.point('p2', off(B, 1));
      const p3 = b.point('p3', off(B, -1));
      const p4 = b.point('p4', off(A, -1));
      const side1 = b.line('side1', p1, p2);
      const arcB = b.arc('arc_b', bb, p3, p2);
      const side2 = b.line('side2', p3, p4);
      const arcA = b.arc('arc_a', a, p1, p4);
      b.line('axis', a, bb, { construction: true });
      b.rel('t1', 'tangent', [side1, arcA], `tangent of ${id}.side1 and ${id}.arc_a`);
      b.rel('t2', 'tangent', [side1, arcB], `tangent of ${id}.side1 and ${id}.arc_b`);
      b.rel('t3', 'tangent', [side2, arcB], `tangent of ${id}.side2 and ${id}.arc_b`);
      b.rel('t4', 'tangent', [side2, arcA], `tangent of ${id}.side2 and ${id}.arc_a`);
      b.rel('eq', 'equal', [arcA, arcB], `equal radii of ${id}.arc_a and ${id}.arc_b`);
      break;
    }
    case 'polygon': {
      const w = want(4);
      if (w) return w;
      const [cu, cv, R, n] = at;
      if (!(R > 0)) return bad('its radius must be more than 0');
      if (!Number.isInteger(n) || n < 3 || n > 24) return bad(`its last number is the side count, a whole number from 3 to 24, not ${n}`);
      const c: Vec2 = [cu, cv];
      const centre = b.point('center', c);
      const circle = b.circle('circle', centre, R, { construction: true });
      const corners: string[] = [];
      for (let k = 1; k <= n; k++) corners.push(b.point(`p${k}`, polar(c, R, (360 * (k - 1)) / n)));
      const sides: string[] = [];
      for (let k = 1; k <= n; k++) sides.push(b.line(`s${k}`, corners[k - 1], corners[k % n]));
      for (let k = 1; k <= n; k++) b.rel(`on${k}`, 'point_on_circle', [corners[k - 1], circle], `corner ${id}.p${k} on ${id}.circle`);
      for (let k = 2; k <= n; k++) b.rel(`eq${k}`, 'equal', [sides[0], sides[k - 1]], `equal sides ${id}.s1 and ${id}.s${k}`);
      break;
    }
    case 'sector': {
      const w = want(6);
      if (w) return w;
      const [cu, cv, r1, r2, s, e] = at;
      if (!(r1 > 0) || !(r2 > r1 + JOIN_TOL)) return bad('its radii must be 0 < r1 < r2');
      const sweep = sweepOf(s, e);
      if (sweep < 1e-6 || 360 - sweep < 1e-6) return bad('its start and end angles are the same: a sector is less than a whole turn');
      const c: Vec2 = [cu, cv];
      const centre = b.point('center', c);
      const is = b.point('inner_start', polar(c, r1, s));
      const ie = b.point('inner_end', polar(c, r1, e));
      const os = b.point('outer_start', polar(c, r2, s));
      const oe = b.point('outer_end', polar(c, r2, e));
      b.arc('inner', centre, is, ie);
      b.arc('outer', centre, os, oe);
      const start = b.line('start', is, os);
      const end = b.line('end', ie, oe);
      b.rel('on_start', 'point_on_line', [centre, start], `centre on ${id}.start`);
      b.rel('on_end', 'point_on_line', [centre, end], `centre on ${id}.end`);
      break;
    }
    case 'spline':
    case 'control_spline': {
      const form = kind === 'spline' ? 'fit' : 'control';
      const nums = form === 'fit' ? at : at.slice(0, -1);
      const degree = form === 'fit' ? 3 : at[at.length - 1];
      if (form === 'control' && degree !== 3 && degree !== 5) return bad(`its last number is the degree, 3 or 5, not ${degree}`);
      if (nums.length < 4 || nums.length % 2) return bad(`a ${kind} takes ${AT_WORDS[kind]}, not ${at.length} numbers`);
      const pts: Vec2[] = [];
      for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      const closed = pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= JOIN_TOL;
      const own = closed ? pts.slice(0, -1) : pts;
      const need = splineMinPoints(form, degree, closed);
      if (own.length < need) return bad(`a ${closed ? 'closed ' : ''}${kind}${form === 'control' ? ` of degree ${degree}` : ''} needs ${need} ${form === 'fit' ? 'points' : 'poles'} or more, not ${own.length}`);
      for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) if (dist(own[i], own[j]) <= JOIN_TOL) return bad(`its points ${i} and ${j} are in one place: a spline passes through a point once`);
      try {
        splineCurve({ form, degree, pts: own, closed });
      } catch (e) {
        return bad(`its points make no curve: ${e instanceof Error ? e.message : String(e)}`);
      }
      const ids = own.map((p, i) => b.point(`p${i}`, p));
      if (!closed) {
        b.m.parts.start = ids[0];
        b.m.parts.end = ids[ids.length - 1];
      }
      b.spline(form, ids, degree, closed);
      break;
    }
    default:
      return bad(`"${String(kind)}" is not an entity kind`);
  }
  return { ok: true, macro: b.m };
}
