// The shape tools (v0.5.0, Daniel's parity rule both ways): the person's tools for the
// Assistant's sketch macros. Each one is clicked point by point with a live preview, takes
// typed values in the value boxes (Tab to the next, Enter places), snaps as the other drawing
// tools do (a click on a sketch point joins it; on the origin, an edge's midpoint or a curve it
// gets the relation), Escape steps back, and Construction (X) makes it construction.
// What it stores is the Assistant's macro (src/assistant/sketch/macros.ts) for the same numbers:
// the same points, entities and own relations, under "<name>__<part>" ids ("slot1__side1"), so a
// slot the person drew and one the Assistant drew read and edit the same way. A typed value is
// a driving dimension on the shape (as Circle's and Rectangle's are).
//   Midpoint line            the middle, then an end                  midpoint_line
//   3-point corner rectangle a side (two corners), then the height    rect_3pt
//   3-point center rectangle the centre, a side's middle, the height  center_rect_3pt
//   Parallelogram            three corners                            parallelogram
//   Perimeter circle         three points on it                       circle_3pt (a circle)
//   Centerpoint arc          the centre, the start, the end           arc
//   Center-to-center slot    both arc centres, then the width         slot
//   Overall slot             both ends, then the width                slot
//   Center-point slot        the middle, an arc centre, the width     slot
//   3-point arc slot         start, end, a point on the arc, width    arc_slot
//   Center-point arc slot    the arc's centre, start, end, width      arc_slot
//   Polygon                  the centre, then a corner (inscribed) or a side's middle
//                            (circumscribed); sides typed             polygon
//   Sector                   the centre, the start, the end; an inner radius as an option
//                            (0: a pie slice)                          sector
// Owner: v0.5.0 SHAPES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expandEntity, type EntityKind, type Macro } from '../../assistant/sketch/macros';
import type { SketchDimensionKind, SketchFeature, Vec2 } from '../../types/doc';
import type { SketchToolId } from '../../types/sketch';
import type { Quantity } from '../../types/units';
import { SketchBuilder, type SketchDraft } from '../edit';
import { add, angleOf, ccwSweep, cross, dist, norm, polar, scale, sub, TAU, wrapPi } from '../geom';
import type { Inference } from '../inference';
import { emptyPreview, type SketchMode, type SketchPointer, type SketchPreview, type SketchTool } from '../mode';
import { entityOf, ORIGIN } from '../model';
import { placeOnModel } from '../project/snap';
import { base, Boxes, glyphsOf } from '../tools';
import type { ToolOption } from './options';

const DEG = 180 / Math.PI;
const TOL = 1e-6;

/** How a click ties to the shape: it is the macro's point `pt`, the middle of its line `mid`, or on its curve `on`. */
export type Join = { pt: string } | { mid: string } | { on: string } | null;

/** The tool's settings that are not clicks: a polygon's sides and kind, a sector's inner radius, an arc's direction. */
export interface ShapeState {
  sides: number;
  circumscribed: boolean;
  inner: number;
  innerExpr: string;
  /** The arc runs counter-clockwise from the start click (false: clockwise, stored the other way round). */
  ccw: boolean;
}

export interface Shaped {
  /** The clicks as they count (typed values applied), the pointer's last. */
  pts: Vec2[];
  /** The macro's numbers once the shape is whole (the last step), else null. */
  at: number[] | null;
  joins: Join[];
  /** What to draw while it is not whole yet. */
  lines?: [Vec2, Vec2][];
  arcs?: SketchPreview['arcs'];
  guides?: [Vec2, Vec2][];
  now?: { [box: string]: number | undefined };
  boxAt?: { [box: string]: Vec2 | undefined };
  along?: { [box: string]: [Vec2, Vec2] | undefined };
  problem?: string | null;
}

type Typed = (id: string) => number | null;

export interface ShapeDim {
  kind: SketchDimensionKind;
  /** The macro's parts it measures ('' is the entity itself). */
  parts: string[];
  /** The box whose typed text it stores (stored only when typed). */
  box: string;
  /** Its expression in place of the box's (the overall slot's length). */
  expr?: (ex: (id: string) => string | null, at: number[]) => string;
}

export interface ShapeSpec {
  tool: SketchToolId;
  kind: EntityKind;
  label: string;
  /** Ids: "<base><n>" ("slot1"). */
  base: string;
  clicks: number;
  /** The hint for each step (clicks placed). */
  hints: string[];
  boxes: { id: string; label: string; quantity: Quantity; step: number }[];
  /** Straight-line inference (horizontal, vertical) from this click for the next one. */
  directionFrom?: number;
  /** The arc's direction follows the pointer's first turn at this step (centre-start-end tools). */
  turnAt?: number;
  shape(placed: Vec2[], ptr: Vec2, v: Typed, st: ShapeState): Shaped;
  dims: ShapeDim[];
}

// ------------------------------------------------------------ geometry helpers

const dir = (a: Vec2, b: Vec2): Vec2 => (dist(a, b) > TOL ? norm(sub(b, a)) : [1, 0]);
/** The pointer's distance to the left of a->b (negative: right). */
const leftOf = (p: Vec2, a: Vec2, b: Vec2) => (dist(a, b) > TOL ? cross(sub(b, a), sub(p, a)) / dist(a, b) : 0);
const deg = (rad: number) => rad * DEG;
/** A point at `L` from `a` toward `to` (typed), else `to`. */
const toward = (a: Vec2, to: Vec2, L: number | null): Vec2 => (L != null ? add(a, scale(dir(a, to), L)) : to);
const arcOf = (c: Vec2, r: number, a0: number, sweep: number) => ({ c, r, a0, sweep });

/** The sweep (rad) from the start angle `as` to the pointer, in the tool's direction, or the typed angle. */
function sweepTo(as: number, c: Vec2, ptr: Vec2, typedDeg: number | null, ccw: boolean): number {
  if (typedDeg != null) return Math.min(Math.max(typedDeg / DEG, 1e-6), TAU - 1e-6);
  const t = angleOf(c, ptr);
  return ccw ? ccwSweep(as, t) : ccwSweep(t, as);
}

/** The width (2 r) from the typed box or the pointer's distance to a straight axis. */
function slotRadius(v: Typed, ptr: Vec2, a: Vec2, b: Vec2): number {
  const W = v('width');
  return W != null ? W / 2 : Math.abs(leftOf(ptr, a, b));
}

/** A straight slot's outline (preview while its last step is drawn: the macro draws the whole). */
function straightSlot(A: Vec2, B: Vec2, r: number, joins: Join[], pts: Vec2[], v: Typed): Shaped {
  const n = norm(sub(B, A));
  const side: Vec2 = [-n[1], n[0]];
  const ok = r > TOL && dist(A, B) > TOL;
  return {
    pts,
    at: ok ? [A[0], A[1], B[0], B[1], r] : null,
    joins,
    guides: [[A, B]],
    now: { length: dist(A, B), width: 2 * r },
    boxAt: { width: add(B, scale(side, r)), length: add(A, scale(sub(B, A), 0.5)) },
    problem: v('width') != null && !(r > TOL) ? 'The width must be more than 0' : null,
  };
}

// ------------------------------------------------------------ the shapes

const LENGTH = (step: number, label = 'Length') => ({ id: 'length', label, quantity: 'length' as const, step });
const WIDTH = (step: number) => ({ id: 'width', label: 'Width', quantity: 'length' as const, step });

export const SHAPES: readonly ShapeSpec[] = [
  {
    tool: 'line-midpoint',
    kind: 'midpoint_line',
    label: 'Midpoint line',
    base: 'midline',
    clicks: 2,
    hints: ['Click the middle of the line.', 'Click an end, or type the length and the angle and Enter.'],
    boxes: [LENGTH(1), { id: 'angle', label: 'Angle', quantity: 'angle', step: 1 }],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const c = placed[0];
      const L = v('length');
      const A = v('angle');
      const a = A != null ? A / DEG : angleOf(c, ptr);
      const half = L != null ? L / 2 : dist(c, ptr);
      const e = polar(c, half, a);
      const s = polar(c, -half, a);
      return {
        pts: [c, e],
        at: half > TOL ? [c[0], c[1], e[0], e[1]] : null,
        joins: [{ pt: 'center' }, { pt: 'end' }],
        now: { length: 2 * half, angle: deg(a) },
        boxAt: { length: e, angle: c },
        along: { length: [s, e] },
      };
    },
    dims: [
      { kind: 'distance', parts: ['line'], box: 'length' },
      { kind: 'angle', parts: ['line'], box: 'angle' },
    ],
  },
  {
    tool: 'rectangle-3pt',
    kind: 'rect_3pt',
    label: '3-point corner rectangle',
    base: 'rect',
    clicks: 3,
    hints: ['Click the first corner.', 'Click the second corner (one side), or type its width and Enter.', 'Click to set the height, or type it and Enter.'],
    boxes: [WIDTH(1), { id: 'height', label: 'Height', quantity: 'length', step: 2 }],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const p1 = placed[0];
      const p2 = placed.length > 1 ? placed[1] : toward(p1, ptr, v('width'));
      if (placed.length === 1) return { pts: [p1, p2], at: null, joins: [], lines: [[p1, p2]], now: { width: dist(p1, p2) }, boxAt: { width: p2 }, along: { width: [p1, p2] } };
      const H = v('height');
      const side = leftOf(ptr, p1, p2);
      const h = H != null ? H * (side < 0 ? -1 : 1) : side;
      const n = scale([-dir(p1, p2)[1], dir(p1, p2)[0]], h);
      return {
        pts: [p1, p2, ptr],
        at: Math.abs(h) > TOL ? [p1[0], p1[1], p2[0], p2[1], h] : null,
        joins: [{ pt: 'p1' }, { pt: 'p2' }, null],
        now: { width: dist(p1, p2), height: Math.abs(h) },
        boxAt: { height: add(p2, scale(n, 0.5)) },
        along: { height: [p2, add(p2, n)] },
      };
    },
    dims: [
      { kind: 'distance', parts: ['s1'], box: 'width' },
      { kind: 'distance', parts: ['s2'], box: 'height' },
    ],
  },
  {
    tool: 'rectangle-center-3pt',
    kind: 'center_rect_3pt',
    label: '3-point center rectangle',
    base: 'crect',
    clicks: 3,
    hints: ['Click the centre of the rectangle.', 'Click the middle of a side (it sets the angle and the width), or type the width and Enter.', 'Click to set the height, or type it and Enter.'],
    boxes: [WIDTH(1), { id: 'height', label: 'Height', quantity: 'length', step: 2 }],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const c = placed[0];
      const m = placed.length > 1 ? placed[1] : toward(c, ptr, v('width') != null ? v('width')! / 2 : null);
      const d = dir(c, m);
      const hw = dist(c, m);
      const a = add(c, scale(d, -hw));
      if (placed.length === 1) return { pts: [c, m], at: null, joins: [], lines: [[a, m]], now: { width: 2 * hw }, boxAt: { width: m }, along: { width: [a, m] } };
      const H = v('height');
      const h = H != null ? H : 2 * Math.abs(leftOf(ptr, c, m));
      return {
        pts: [c, m, ptr],
        at: h > TOL && hw > TOL ? [c[0], c[1], 2 * hw, h, deg(Math.atan2(d[1], d[0]))] : null,
        joins: [{ pt: 'center' }, null, null],
        now: { width: 2 * hw, height: h },
        boxAt: { height: add(m, scale([-d[1], d[0]], h / 2)) },
      };
    },
    dims: [
      { kind: 'distance', parts: ['s1'], box: 'width' },
      { kind: 'distance', parts: ['s2'], box: 'height' },
    ],
  },
  {
    tool: 'parallelogram',
    kind: 'parallelogram',
    label: 'Parallelogram',
    base: 'pgram',
    clicks: 3,
    hints: ['Click the first corner.', 'Click the second corner, or type the length and Enter.', 'Click the third corner (the fourth follows).'],
    boxes: [LENGTH(1)],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const p1 = placed[0];
      const p2 = placed.length > 1 ? placed[1] : toward(p1, ptr, v('length'));
      if (placed.length === 1) return { pts: [p1, p2], at: null, joins: [], lines: [[p1, p2]], now: { length: dist(p1, p2) }, boxAt: { length: p2 }, along: { length: [p1, p2] } };
      const p3 = ptr;
      const flat = Math.abs(leftOf(p3, p1, p2)) <= TOL || dist(p2, p3) <= TOL;
      return { pts: [p1, p2, p3], at: flat ? null : [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]], joins: [{ pt: 'p1' }, { pt: 'p2' }, { pt: 'p3' }] };
    },
    dims: [{ kind: 'distance', parts: ['s1'], box: 'length' }],
  },
  {
    tool: 'circle-3pt',
    kind: 'circle_3pt',
    label: 'Perimeter circle',
    base: 'circle',
    clicks: 3,
    hints: ['Click a point on the circle.', 'Click a second point on it.', 'Click a third point on it.'],
    boxes: [],
    shape(placed, ptr) {
      const pts = [...placed, ptr];
      if (pts.length < 3) return { pts, at: null, joins: [], lines: pts.length === 2 ? [[pts[0], pts[1]]] : [] };
      return { pts, at: [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1]], joins: [{ on: '' }, { on: '' }, { on: '' }] };
    },
    dims: [],
  },
  {
    tool: 'arc-center',
    kind: 'arc',
    label: 'Centerpoint arc',
    base: 'arc',
    clicks: 3,
    hints: ['Click the centre of the arc.', 'Click its start (the radius), or type the radius and Enter.', 'Click its end (it runs the way the pointer turns), or type the angle and Enter.'],
    boxes: [{ id: 'radius', label: 'Radius', quantity: 'length', step: 1 }, { id: 'angle', label: 'Angle', quantity: 'angle', step: 2 }],
    turnAt: 2,
    shape(placed, ptr, v, st) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const c = placed[0];
      const s = placed.length > 1 ? placed[1] : toward(c, ptr, v('radius'));
      const r = dist(c, s);
      if (placed.length === 1) return { pts: [c, s], at: null, joins: [], guides: [[c, s]], arcs: r > TOL ? [arcOf(c, r, 0, TAU)] : [], now: { radius: r }, boxAt: { radius: s } };
      const as = angleOf(c, s);
      const sw = sweepTo(as, c, ptr, v('angle'), st.ccw);
      const [a0, a1] = st.ccw ? [as, as + sw] : [as - sw, as];
      return {
        pts: [c, s, polar(c, r, st.ccw ? a1 : a0)],
        at: r > TOL ? [c[0], c[1], r, deg(a0), deg(a1)] : null,
        joins: [{ pt: 'center' }, { pt: st.ccw ? 'start' : 'end' }, null],
        now: { radius: r, angle: deg(sw) },
        boxAt: { angle: polar(c, r * 0.6, a0 + sw / 2) },
      };
    },
    dims: [{ kind: 'radius', parts: [''], box: 'radius' }],
  },
  {
    tool: 'slot-center',
    kind: 'slot',
    label: 'Center-to-center slot',
    base: 'slot',
    clicks: 3,
    hints: ['Click the centre of the first arc.', 'Click the centre of the second arc, or type the length and Enter.', 'Click to set the width, or type it and Enter.'],
    boxes: [LENGTH(1), WIDTH(2)],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const A = placed[0];
      if (placed.length === 1) {
        const B = toward(A, ptr, v('length'));
        return { pts: [A, B], at: null, joins: [], lines: [[A, B]], now: { length: dist(A, B) }, boxAt: { length: B }, along: { length: [A, B] } };
      }
      const B = placed[1];
      return straightSlot(A, B, slotRadius(v, ptr, A, B), [{ pt: 'a' }, { pt: 'b' }, null], [A, B, ptr], v);
    },
    dims: [
      { kind: 'distance', parts: ['axis'], box: 'length' },
      { kind: 'diameter', parts: ['arc_a'], box: 'width' },
    ],
  },
  {
    tool: 'slot-overall',
    kind: 'slot',
    label: 'Overall slot',
    base: 'slot',
    clicks: 3,
    hints: ['Click one end of the slot.', 'Click the other end, or type the overall length and Enter.', 'Click to set the width, or type it and Enter.'],
    boxes: [LENGTH(1, 'Overall length'), WIDTH(2)],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const E1 = placed[0];
      if (placed.length === 1) {
        const E2 = toward(E1, ptr, v('length'));
        return { pts: [E1, E2], at: null, joins: [], lines: [[E1, E2]], now: { length: dist(E1, E2) }, boxAt: { length: E2 }, along: { length: [E1, E2] } };
      }
      const E2 = placed[1];
      const r = slotRadius(v, ptr, E1, E2);
      const d = dir(E1, E2);
      const L = dist(E1, E2);
      if (2 * r >= L - TOL) return { pts: [E1, E2, ptr], at: null, joins: [], lines: [[E1, E2]], now: { length: L, width: 2 * r }, boxAt: { width: ptr }, problem: 'The width must be less than the overall length' };
      const s = straightSlot(add(E1, scale(d, r)), add(E2, scale(d, -r)), r, [null, null, null], [E1, E2, ptr], v);
      return { ...s, now: { length: L, width: 2 * r } };
    },
    dims: [
      // The overall length is the centres' distance and the width: stored as such, the typed text kept.
      { kind: 'distance', parts: ['axis'], box: 'length', expr: (ex, at) => `(${ex('length')}) - (${ex('width') ?? `${+(2 * at[4]).toFixed(6)} mm`})` },
      { kind: 'diameter', parts: ['arc_a'], box: 'width' },
    ],
  },
  {
    tool: 'slot-center-point',
    kind: 'slot',
    label: 'Center-point slot',
    base: 'slot',
    clicks: 3,
    hints: ['Click the middle of the slot.', 'Click the centre of one arc, or type the length (centre to centre) and Enter.', 'Click to set the width, or type it and Enter.'],
    boxes: [LENGTH(1), WIDTH(2)],
    directionFrom: 0,
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const M = placed[0];
      const L = v('length');
      const B = placed.length > 1 ? placed[1] : toward(M, ptr, L != null ? L / 2 : null);
      const A = sub(scale(M, 2), B);
      if (placed.length === 1) return { pts: [M, B], at: null, joins: [], lines: [[A, B]], now: { length: dist(A, B) }, boxAt: { length: B }, along: { length: [A, B] } };
      return straightSlot(A, B, slotRadius(v, ptr, A, B), [{ mid: 'axis' }, { pt: 'b' }, null], [M, B, ptr], v);
    },
    dims: [
      { kind: 'distance', parts: ['axis'], box: 'length' },
      { kind: 'diameter', parts: ['arc_a'], box: 'width' },
    ],
  },
  {
    tool: 'slot-arc-3pt',
    kind: 'arc_slot',
    label: '3-point arc slot',
    base: 'arcslot',
    clicks: 4,
    hints: ['Click the start of the slot (an arc centre).', 'Click its end (the other arc centre).', 'Click a point on the arc between them.', 'Click to set the width, or type it and Enter.'],
    boxes: [WIDTH(3)],
    shape(placed, ptr, v) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      if (placed.length === 1) return { pts: [placed[0], ptr], at: null, joins: [], guides: [[placed[0], ptr]] };
      const [S, E] = placed;
      const P = placed.length > 2 ? placed[2] : ptr;
      const circle = circle3(S, E, P);
      if (!circle) return { pts: [...placed, ptr], at: null, joins: [], guides: [[S, E]] };
      const { c, r: R } = circle;
      const as = angleOf(c, S);
      const ae = angleOf(c, E);
      const ccw = ccwSweep(as, angleOf(c, P)) < ccwSweep(as, ae);
      const [a0, a1] = ccw ? [as, ae] : [ae, as];
      const sweep = ccwSweep(a0, a1);
      if (placed.length === 2) return { pts: [S, E, P], at: null, joins: [], arcs: [arcOf(c, R, a0, sweep)] };
      const W = v('width');
      const r = W != null ? W / 2 : Math.abs(dist(c, ptr) - R);
      const ok = r > TOL && r < R - TOL;
      return {
        pts: [S, E, P, ptr],
        at: ok ? [c[0], c[1], R, r, deg(a0), deg(a1)] : null,
        joins: ccw ? [{ pt: 'a' }, { pt: 'b' }, null, null] : [{ pt: 'b' }, { pt: 'a' }, null, null],
        arcs: ok ? [] : [arcOf(c, R, a0, sweep)],
        now: { width: 2 * r },
        boxAt: { width: polar(c, R + r, a1) },
        problem: !ok && r > TOL ? 'The width must be less than twice the arc radius' : null,
      };
    },
    dims: [{ kind: 'diameter', parts: ['cap_a'], box: 'width' }],
  },
  {
    tool: 'slot-arc-center',
    kind: 'arc_slot',
    label: 'Center-point arc slot',
    base: 'arcslot',
    clicks: 4,
    hints: ['Click the centre of the arc.', 'Click the start of the slot (the radius), or type the radius and Enter.', 'Click its end (it runs the way the pointer turns), or type the angle and Enter.', 'Click to set the width, or type it and Enter.'],
    boxes: [{ id: 'radius', label: 'Radius', quantity: 'length', step: 1 }, { id: 'angle', label: 'Angle', quantity: 'angle', step: 2 }, WIDTH(3)],
    turnAt: 2,
    shape(placed, ptr, v, st) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const c = placed[0];
      const s = placed.length > 1 ? placed[1] : toward(c, ptr, v('radius'));
      const R = dist(c, s);
      if (placed.length === 1) return { pts: [c, s], at: null, joins: [], guides: [[c, s]], arcs: R > TOL ? [arcOf(c, R, 0, TAU)] : [], now: { radius: R }, boxAt: { radius: s } };
      const as = angleOf(c, s);
      const sw = placed.length > 2 ? sweepTo(as, c, placed[2], v('angle'), st.ccw) : sweepTo(as, c, ptr, v('angle'), st.ccw);
      const [a0, a1] = st.ccw ? [as, as + sw] : [as - sw, as];
      const e = polar(c, R, st.ccw ? a1 : a0);
      if (placed.length === 2) return { pts: [c, s, e], at: null, joins: [], arcs: [arcOf(c, R, a0, sw)], guides: [[c, s], [c, e]], now: { angle: deg(sw) }, boxAt: { angle: polar(c, R * 0.6, a0 + sw / 2) } };
      const W = v('width');
      const r = W != null ? W / 2 : Math.abs(dist(c, ptr) - R);
      const ok = r > TOL && r < R - TOL;
      return {
        pts: [c, s, e, ptr],
        at: ok ? [c[0], c[1], R, r, deg(a0), deg(a1)] : null,
        joins: [{ pt: 'center' }, { pt: st.ccw ? 'a' : 'b' }, null, null],
        arcs: ok ? [] : [arcOf(c, R, a0, sw)],
        now: { width: 2 * r },
        boxAt: { width: polar(c, R + r, a1) },
        problem: !ok && r > TOL ? 'The width must be less than twice the radius' : null,
      };
    },
    dims: [
      // The path radius: the centre to a cap centre.
      { kind: 'distance', parts: ['center', 'a'], box: 'radius' },
      { kind: 'diameter', parts: ['cap_a'], box: 'width' },
    ],
  },
  {
    tool: 'polygon',
    kind: 'polygon',
    label: 'Polygon',
    base: 'polygon',
    clicks: 2,
    hints: ['Click the centre of the polygon (type the number of sides first if you like).', 'Click a corner (inscribed) or the middle of a side (circumscribed), or type the radius and Enter.'],
    boxes: [{ id: 'sides', label: 'Sides', quantity: 'scalar', step: 0 }, { id: 'radius', label: 'Radius', quantity: 'length', step: 1 }],
    shape(placed, ptr, v, st) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [], now: { sides: sidesOf(v, st) }, boxAt: { sides: ptr } };
      const c = placed[0];
      const n = sidesOf(v, st);
      const R = v('radius');
      const rho = R != null ? R : dist(c, ptr);
      const a = angleOf(c, ptr);
      const p = polar(c, rho, a);
      const Rc = st.circumscribed ? rho / Math.cos(Math.PI / n) : rho;
      const turn = st.circumscribed ? deg(a) - 180 / n : deg(a);
      return {
        pts: [c, p],
        at: rho > TOL ? [c[0], c[1], Rc, n, turn] : null,
        joins: [{ pt: 'center' }, st.circumscribed ? null : { pt: 'p1' }],
        guides: [[c, p]],
        now: { sides: n, radius: rho },
        boxAt: { radius: p, sides: c },
      };
    },
    dims: [],
  },
  {
    tool: 'sector',
    kind: 'sector',
    label: 'Sector',
    base: 'sector',
    clicks: 3,
    hints: ['Click the centre of the sector.', 'Click its start (the radius), or type the radius and Enter.', 'Click its end (it runs the way the pointer turns), or type the angle and Enter.'],
    boxes: [{ id: 'radius', label: 'Radius', quantity: 'length', step: 1 }, { id: 'angle', label: 'Angle', quantity: 'angle', step: 2 }],
    turnAt: 2,
    shape(placed, ptr, v, st) {
      if (!placed.length) return { pts: [ptr], at: null, joins: [] };
      const c = placed[0];
      const s = placed.length > 1 ? placed[1] : toward(c, ptr, v('radius'));
      const R = dist(c, s);
      if (placed.length === 1) return { pts: [c, s], at: null, joins: [], lines: [[c, s]], arcs: R > TOL ? [arcOf(c, R, 0, TAU)] : [], now: { radius: R }, boxAt: { radius: s } };
      const as = angleOf(c, s);
      const sw = sweepTo(as, c, ptr, v('angle'), st.ccw);
      const [a0, a1] = st.ccw ? [as, as + sw] : [as - sw, as];
      const ok = R > st.inner + TOL;
      return {
        pts: [c, s, polar(c, R, st.ccw ? a1 : a0)],
        at: ok ? [c[0], c[1], st.inner, R, deg(a0), deg(a1)] : null,
        joins: [{ pt: 'center' }, { pt: st.ccw ? 'outer_start' : 'outer_end' }, null],
        now: { radius: R, angle: deg(sw) },
        boxAt: { angle: polar(c, R * 0.6, a0 + sw / 2) },
        problem: ok ? null : 'The radius must be more than the inner radius',
      };
    },
    dims: [
      { kind: 'radius', parts: ['outer'], box: 'radius' },
      { kind: 'angle', parts: ['start', 'end'], box: 'angle' },
    ],
  },
];

export const SHAPE_SPEC: Readonly<Record<string, ShapeSpec>> = Object.fromEntries(SHAPES.map((s) => [s.tool, s]));

function sidesOf(v: Typed, st: ShapeState): number {
  const n = v('sides');
  return n != null && Number.isInteger(n) && n >= 3 && n <= 24 ? n : st.sides;
}

function circle3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9 || dist(a, b) < TOL || dist(b, c) < TOL || dist(a, c) < TOL) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

// ------------------------------------------------------------ storing a macro

/** The first free "<base><n>" of a sketch (no id is it or starts with it and "__"). */
export function shapeId(d: Pick<SketchDraft, 'points' | 'entities' | 'constraints'>, baseName: string): string {
  const used = [...Object.keys(d.points), ...d.entities.map((e) => e.id), ...d.constraints.map((c) => c.id)];
  for (let n = 1; ; n++) {
    const id = `${baseName}${n}`;
    if (!used.some((u) => u === id || u.startsWith(`${id}__`))) return id;
  }
}

/**
 * The macro into the builder, as the Assistant's sketch tool stores it: its points (a click that
 * snapped onto a sketch point is that point, as the Assistant's joins make it), its entities and
 * its own relations with their ids; then each click's snap relation (inferred, droppable): on
 * the origin coincident, on an edge's middle midpoint, on a curve point-on; a click that is the
 * middle of a line (`mid`) or on a curve (`on`) ties the point it snapped to.
 */
export function placeMacro(b: SketchBuilder, m: Macro, clicks: { join: Join; inf: Inference | null }[]): void {
  const rename = new Map<string, string>();
  const pointOf = (part: string) => m.points.find((p) => p.part === part)?.id ?? null;
  for (const { join, inf } of clicks) {
    if (!join || !('pt' in join) || !inf?.snap) continue;
    const pid = pointOf(join.pt);
    if (!pid) continue;
    const s = inf.snap;
    if (s.kind === 'point' && s.id !== ORIGIN && b.points[s.id]) rename.set(pid, s.id);
    else if (s.kind === 'model') placeOnModel(b, s.model, pid);
  }
  const R = (id: string) => rename.get(id) ?? id;
  for (const p of m.points) if (!rename.has(p.id) && !b.points[p.id]) b.addPoint(p.at, p.id);
  for (const e of m.entities) {
    const x = { ...e };
    if (x.kind === 'point') x.p = R(x.p);
    else if (x.kind === 'line') x.p = [R(x.p[0]), R(x.p[1])];
    else if (x.kind === 'circle') x.c = R(x.c);
    else if (x.kind === 'arc') {
      x.c = R(x.c);
      x.a = R(x.a);
      x.b = R(x.b);
    } else if (x.kind === 'spline') x.pts = x.pts.map(R);
    b.addEntity(x);
  }
  for (const r of m.relations) b.addRelation(r.kind, r.refs.map(R), { id: r.id });
  // A line drawn level or plumb gets the horizontal or vertical the Assistant's `infer` gives it.
  for (const lineId of m.inferLines) {
    const e = b.entities.find((x) => x.id === lineId);
    if (e?.kind !== 'line') continue;
    const a = b.point(e.p[0]);
    const c = b.point(e.p[1]);
    if (!a || !c) continue;
    const du = Math.abs(c[0] - a[0]);
    const dv = Math.abs(c[1] - a[1]);
    const kind = dv <= 1e-9 && du > TOL ? 'horizontal' : du <= 1e-9 && dv > TOL ? 'vertical' : null;
    if (kind) b.addRelation(kind, [lineId], { id: `${lineId}__${kind === 'horizontal' ? 'h' : 'v'}`, inferred: true, optional: true });
  }
  const onCurve = (p: string, entity: string) => {
    const e = entityOf(b, entity);
    if (e) b.addRelation(e.kind === 'line' ? 'point_on_line' : 'point_on_circle', [p, entity], { inferred: true, optional: true });
  };
  for (const { join, inf } of clicks) {
    const s = inf?.snap;
    if (!join || !s) continue;
    if ('pt' in join) {
      const pid = pointOf(join.pt);
      if (!pid || rename.has(pid) || s.kind === 'model') continue;
      if (s.kind === 'point' && s.id === ORIGIN) b.addRelation('coincident', [pid, ORIGIN], { inferred: true, optional: true });
      else if (s.kind === 'midpoint') b.addRelation('midpoint', [pid, s.line], { inferred: true, optional: true });
      else if (s.kind === 'curve') onCurve(pid, s.entity);
      else if (s.kind === 'intersection') {
        onCurve(pid, s.entities[0]);
        onCurve(pid, s.entities[1]);
      }
    } else if (s.kind === 'point' && (s.id === ORIGIN || b.points[s.id])) {
      const target = m.parts['mid' in join ? join.mid : join.on];
      if (!target) continue;
      if ('mid' in join) b.addRelation('midpoint', [s.id, target], { inferred: true, optional: true });
      else onCurve(s.id, target);
    }
  }
}

/** The macro's outline for the preview: its curves; construction lines as guides. */
function drawMacro(m: Macro, p: SketchPreview) {
  const at = new Map(m.points.map((q) => [q.id, q.at] as const));
  const P = (id: string): Vec2 => at.get(id) ?? [0, 0];
  for (const e of m.entities) {
    if (e.kind === 'line') (e.construction ? p.guides : p.lines).push([P(e.p[0]), P(e.p[1])]);
    else if (e.kind === 'circle' && !e.construction) p.arcs.push(arcOf(P(e.c), e.r, 0, TAU));
    else if (e.kind === 'arc' && !e.construction) {
      const c = P(e.c);
      const a0 = angleOf(c, P(e.a));
      p.arcs.push(arcOf(c, dist(c, P(e.a)), a0, ccwSweep(a0, angleOf(c, P(e.b)))));
    }
  }
}

// ------------------------------------------------------------ the tool

export function shapeTool(mode: SketchMode, spec: ShapeSpec): SketchTool {
  const t = base(mode, spec.tool);
  const boxes = new Boxes(mode, spec.boxes);
  const st: ShapeState = { sides: 6, circumscribed: false, inner: 0, innerExpr: '0 mm', ccw: true };
  /** The clicks placed: where they count, and their snap (null when a typed value moved them). */
  let placed: { at: Vec2; inf: Inference | null }[] = [];
  let last: SketchPointer | null = null;
  let turnFrom: number | null = null;
  const v: Typed = (id) => boxes.value(id);

  function inferAt(e: SketchPointer): Inference {
    const from = spec.directionFrom;
    if (from != null && placed.length === from + 1) return t.infer(e, { anchor: { at: placed[from].at, point: null }, directions: true });
    return t.infer(e);
  }

  /** The arc's way round follows the pointer's first turn away from the start click (centre-start-end tools). */
  function track(ptr: Vec2) {
    if (spec.turnAt == null || placed.length !== spec.turnAt) {
      turnFrom = null;
      return;
    }
    const c = placed[0].at;
    const s = placed[1].at;
    const turn = wrapPi(angleOf(c, ptr) - angleOf(c, s));
    if (turnFrom == null || Math.abs(turn) < Math.PI / 4) {
      if (Math.abs(turn) > 1e-3) st.ccw = turn > 0;
      turnFrom = turn;
    }
  }

  function shaped(ptr: Vec2): Shaped {
    return spec.shape(
      placed.map((p) => p.at),
      ptr,
      v,
      st,
    );
  }

  function show(e: SketchPointer) {
    last = e;
    const inf = inferAt(e);
    track(inf.at);
    const s = shaped(inf.at);
    const p = emptyPreview();
    p.glyphs = glyphsOf(inf);
    p.guides = [...inf.guides, ...(s.guides ?? [])];
    p.points = s.pts;
    if (s.at) {
      const r = expandEntity('preview', spec.kind, s.at, false);
      if (r.ok) drawMacro(r.macro, p);
    }
    if (!s.at || !p.lines.length) {
      p.lines.push(...(s.lines ?? []));
      p.arcs.push(...(s.arcs ?? []));
    }
    const step = placed.length;
    const shown = spec.boxes.filter((b) => b.step === step || (b.id === 'sides' && step <= 1)).map((b) => b.id);
    if (shown.length) {
      const all = boxes.render((s.now ?? {}) as Record<string, number>, (s.boxAt ?? {}) as Record<string, Vec2>, s.problem ? Object.fromEntries(shown.filter((id) => v(id) != null).map((id) => [id, s.problem!])) : {}, (s.along ?? {}) as Record<string, [Vec2, Vec2]>);
      p.boxes = all.filter((b) => shown.includes(b.id)).map((b) => (b.id === 'sides' ? { ...b, text: boxes.typedText('sides') ?? String(sidesOf(v, st)) } : b));
    } else if (s.problem && placed.length === spec.clicks - 1) mode.note(s.problem);
    mode.setPreview(p);
  }

  /** The click at `inf` (or the pointer's place with typed values): the next step, or the shape placed. */
  function step(inf: Inference) {
    track(inf.at);
    const s = shaped(inf.at);
    const at = s.pts[placed.length] ?? inf.at;
    const snapped = dist(at, inf.at) < 1e-9 ? inf : null;
    if (placed.length + 1 < spec.clicks) {
      const prev = placed[placed.length - 1];
      if (prev && dist(prev.at, at) < TOL) return false;
      placed.push({ at, inf: snapped });
      mode.note(null);
      mode.refreshHint();
      if (last) show(last);
      return true;
    }
    return commit(s, snapped);
  }

  function commit(s: Shaped, lastInf: Inference | null): boolean {
    if (!s.at) {
      mode.note(`Not applied: ${s.problem ?? `that makes no ${spec.label.toLowerCase()}`}`);
      return false;
    }
    const at = s.at;
    const infs = [...placed.map((p) => p.inf), lastInf];
    const clicks = s.joins.map((join, i) => ({ join, inf: infs[i] ?? null }));
    const exprs = Object.fromEntries(spec.boxes.map((b) => [b.id, boxes.expr(b.id)] as const));
    const ex = (id: string) => exprs[id] ?? null;
    void mode.apply(spec.label, (d: SketchFeature) => {
      const id = shapeId(d, spec.base);
      const r = expandEntity(id, spec.kind, at, false);
      if (!r.ok) return { ok: false, reason: r.problem };
      const b = new SketchBuilder(d);
      placeMacro(b, r.macro, clicks);
      for (const dim of spec.dims) {
        const e = ex(dim.box);
        if (!e) continue;
        const refs = dim.parts.map((part) => r.macro.parts[part]);
        if (refs.some((x) => !x)) continue;
        b.addDimension(dim.kind, refs, dim.expr ? dim.expr(ex, at) : e);
      }
      return { ok: true, draft: b.result(), optional: [...b.optional], removed: [] };
    });
    placed = [];
    turnFrom = null;
    boxes.reset();
    mode.setPreview(null);
    mode.refreshHint();
    return true;
  }

  const options = (): ToolOption[] => {
    const redraw = () => {
      if (last) show(last);
      mode.refreshHint();
    };
    if (spec.tool === 'polygon')
      return [
        {
          kind: 'choice',
          id: 'polygon-kind',
          label: 'Polygon',
          value: st.circumscribed ? 'circumscribed' : 'inscribed',
          choices: [
            { value: 'inscribed', label: 'Inscribed (click a corner)' },
            { value: 'circumscribed', label: 'Circumscribed (click the middle of a side)' },
          ],
          set: (x) => {
            st.circumscribed = x === 'circumscribed';
            redraw();
          },
        },
        {
          kind: 'number',
          id: 'sides',
          label: 'Sides',
          expr: String(st.sides),
          quantity: 'scalar',
          validate: (n) => (Number.isInteger(n) && n >= 3 && n <= 24 ? null : 'A whole number from 3 to 24'),
          set: (_e, n) => {
            st.sides = n;
            boxes.set('sides', '');
            redraw();
          },
        },
      ];
    if (spec.tool === 'sector')
      return [
        {
          kind: 'number',
          id: 'inner',
          label: 'Inner radius (0: a pie slice)',
          expr: st.innerExpr,
          quantity: 'length',
          validate: (n) => (n >= 0 ? null : 'Must be 0 or more'),
          set: (e, n) => {
            st.inner = n;
            st.innerExpr = e;
            redraw();
          },
        },
      ];
    return [];
  };

  return {
    id: spec.tool,
    hint: () => spec.hints[Math.min(placed.length, spec.hints.length - 1)],
    cancel() {
      if (!placed.length) {
        const had = boxes.any();
        boxes.reset();
        mode.setPreview(null);
        return had;
      }
      // Escape steps back one click.
      placed.pop();
      turnFrom = null;
      mode.refreshHint();
      if (last) show(last);
      else mode.setPreview(null);
      return true;
    },
    box(id, action, text) {
      boxes.set(id, text);
      if (action === 'enter' && last && (placed.length || spec.boxes.find((b) => b.id === id)?.step === 0)) {
        if (!placed.length) {
          show(last);
          return false;
        }
        const placedNow = step(inferAt(last));
        mode.refreshHint();
        return placedNow && placed.length === 0;
      }
      if (last) show(last);
      return false;
    },
    commit() {
      if (!placed.length || placed.length + 1 < spec.clicks || !last) return false;
      return step(inferAt(last));
    },
    options,
    // A press that moves still clicks where it was pressed (as the other drawing tools).
    dragDraw: () => false,
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'leave') {
        if (!placed.length) mode.setPreview(null);
        return;
      }
      if (e.type !== 'click') return;
      last = e;
      step(inferAt(e));
    },
  };
}
