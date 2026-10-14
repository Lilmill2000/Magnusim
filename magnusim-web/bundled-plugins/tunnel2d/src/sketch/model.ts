// A sketch body's data and what the flow sees of it. The data is the CAD plugin's sketch
// JSON (points in mm, entities by point id, relations and dimensions; src/sketch/cad.ts),
// with the sketch's origin at the body's pivot. Its outline is every closed loop of its
// non-construction curves: lines, arcs, circles and splines joined end to end by shared
// point ids or coincident relations. The loops fill even-odd (a loop inside another is a
// hole); an open end or a branch keeps the sketch out of the flow, and says where.
// SPDX-License-Identifier: GPL-3.0-or-later
import { arcGeom, isDimension, splineSamples, type SketchConstraint, type SketchEntity, type Vec2 } from './cad';

/** A tunnel sketch: CAD's sketch data (mm). */
export interface SketchData {
  points: Record<string, Vec2>;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export const emptySketch = (): SketchData => ({ points: {}, entities: [], constraints: [] });

const isConstruction = (e: SketchEntity) => !!e.construction || (e.kind === 'line' && !!e.centerline);

/** Angle step (radians) of arcs and circles as polylines: at most 4°, and at least 8 segments a circle. */
const ARC_STEP = (4 * Math.PI) / 180;

/** The sketch's outline: rings (mm, closed polylines, the first point not repeated) and what stops it. */
export interface Profile {
  rings: Vec2[][];
  /** Ends of open chains, and points where more than two curves meet (mm). */
  open: Vec2[];
  branch: Vec2[];
  /** Every curve but construction, as a polyline (mm): what is drawn of a sketch that is not closed. */
  curves: Vec2[][];
}

function arcPolyline(c: Vec2, r: number, a0: number, sweep: number): Vec2[] {
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** The closed loops of a sketch, and where it is open or branched. */
export function sketchProfile(s: SketchData): Profile {
  // Points joined by coincident relations are one node.
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let r = id;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let x = id;
    while (parent.has(x) && parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  for (const c of s.constraints) {
    if (isDimension(c) || c.kind !== 'coincident' || c.refs.length !== 2) continue;
    const [a, b] = c.refs;
    if (!(a in s.points) || !(b in s.points)) continue;
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const rings: Vec2[][] = [];
  // An edge: a curve between two nodes, with its polyline from its start to its end.
  interface Edge {
    a: string;
    b: string;
    poly: Vec2[];
  }
  const edges: Edge[] = [];
  const curves: Vec2[][] = [];
  for (const e of s.entities) {
    if (isConstruction(e)) continue;
    if (e.kind === 'circle') {
      const c = s.points[e.c];
      if (c && e.r > 0) rings.push(arcPolyline(c, e.r, 0, 2 * Math.PI).slice(0, -1));
      if (c && e.r > 0) curves.push(arcPolyline(c, e.r, 0, 2 * Math.PI));
    } else if (e.kind === 'line') {
      const p = s.points[e.p[0]];
      const q = s.points[e.p[1]];
      if (p && q) edges.push({ a: root(e.p[0]), b: root(e.p[1]), poly: [p, q] });
    } else if (e.kind === 'arc') {
      const g = arcGeom(s, e);
      if (!g) continue;
      // arcGeom runs counter-clockwise from its start: from a when ccw, else from b.
      const poly = arcPolyline(g.c, g.r, g.a0, g.sweep);
      const ccw = e.ccw !== false;
      edges.push(ccw ? { a: root(e.a), b: root(e.b), poly } : { a: root(e.b), b: root(e.a), poly });
    } else if (e.kind === 'spline') {
      const poly = splineSamples(s, e, 96);
      if (poly.length < 2) continue;
      if (e.closed) rings.push(poly.slice(0, -1));
      else edges.push({ a: root(e.pts[0]), b: root(e.pts[e.pts.length - 1]), poly });
      curves.push(poly);
    }
  }
  for (const ed of edges) if (!curves.includes(ed.poly)) curves.push(ed.poly);

  // Chain the edges: a node with two edges continues a loop; one is an open end; more, a branch.
  const at = new Map<string, number[]>();
  edges.forEach((ed, i) => {
    if (ed.a === ed.b) return; // a curve that closes on itself (degenerate here)
    for (const n of [ed.a, ed.b]) {
      if (!at.has(n)) at.set(n, []);
      at.get(n)!.push(i);
    }
  });
  const posOf = (node: string): Vec2 => {
    for (const [id, p] of Object.entries(s.points)) if (root(id) === node) return p;
    return [0, 0];
  };
  const open: Vec2[] = [];
  const branch: Vec2[] = [];
  const bad = new Set<string>();
  for (const [n, list] of at) {
    if (list.length === 1) open.push(posOf(n));
    if (list.length > 2) branch.push(posOf(n));
    if (list.length !== 2) bad.add(n);
  }
  // A loop is made only of good nodes: walk each unused edge round its component.
  const used = new Set<number>();
  edges.forEach((ed, start) => {
    if (used.has(start) || ed.a === ed.b) return;
    const loop: Vec2[] = [];
    let node = ed.a;
    let i = start;
    let ok = true;
    for (let guard = 0; guard <= edges.length; guard++) {
      if (bad.has(node)) ok = false;
      used.add(i);
      const e = edges[i];
      const forward = e.a === node;
      const poly = forward ? e.poly : [...e.poly].reverse();
      loop.push(...poly.slice(0, -1));
      node = forward ? e.b : e.a;
      if (node === ed.a) break;
      const next = (at.get(node) ?? []).find((j) => j !== i && !used.has(j));
      if (next === undefined) {
        ok = false;
        break;
      }
      i = next;
    }
    if (ok && node === ed.a && loop.length >= 3) rings.push(loop);
  });
  return { rings, open, branch, curves };
}

const UNITS: Record<string, { q: 'length' | 'angle'; k: number }> = {
  mm: { q: 'length', k: 1 },
  cm: { q: 'length', k: 10 },
  m: { q: 'length', k: 1000 },
  in: { q: 'length', k: 25.4 },
  '"': { q: 'length', k: 25.4 },
  ft: { q: 'length', k: 304.8 },
  deg: { q: 'angle', k: 1 },
  '°': { q: 'angle', k: 1 },
  rad: { q: 'angle', k: 180 / Math.PI },
};

/**
 * A dimension's value from what was typed: a number, a unit or none (mm for lengths, degrees
 * for angles): "40", "40 mm", "4 cm", "1.5 in", "30", "30°", "0.5 rad". In mm or degrees.
 */
export function evalValue(text: string, quantity: 'length' | 'angle'): { value: number } | { error: string } {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z°"]*)\s*$/i.exec(text);
  if (!m) return { error: `Enter a number${quantity === 'length' ? ', with mm, cm, m, in or ft' : ', with deg or rad'} if you like.` };
  const v = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!unit) return v > 0 || quantity === 'angle' ? { value: v } : { error: 'A length must be more than 0.' };
  const u = UNITS[unit];
  if (!u || u.q !== quantity) return { error: `“${m[2]}” is not a unit of ${quantity === 'length' ? 'length' : 'angle'} here.` };
  const value = v * u.k;
  if (quantity === 'length' && !(value > 0)) return { error: 'A length must be more than 0.' };
  return { value };
}

/** How a dimension stores a value it was given (CAD's expression form). */
export function exprOf(value: number, quantity: 'length' | 'angle'): string {
  const r = Math.round(value * 1e4) / 1e4;
  return quantity === 'length' ? `${r} mm` : `${r} deg`;
}

/** Each driving dimension's value (mm or degrees) from its expression; bad ones listed. */
export function dimensionValues(s: SketchData): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const c of s.constraints) {
    if (!isDimension(c) || !c.driving) continue;
    const q = c.kind === 'angle' ? 'angle' : 'length';
    const r = evalValue(String(c.expr ?? ''), q);
    if ('value' in r) values[c.id] = r.value;
    else errors[c.id] = r.error;
  }
  return { values, errors };
}
