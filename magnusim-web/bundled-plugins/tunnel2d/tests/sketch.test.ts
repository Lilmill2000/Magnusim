// Sketch bodies: the CAD imports build and run, a sketch's loops (rings, holes, islands,
// open ends, branches), the dimension values it accepts, and the edits (rectangle, fillet,
// three-point arc, delete).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { newId, planDimension, polygonArea, toSolverSketch, type SketchEntity, type Vec2 } from '../src/sketch/cad';
import { addArc3, addDimension, addLine, addRectangle, clone, deleteItems, fillet, placePoint } from '../src/sketch/edit';
import { emptySketch, evalValue, sketchProfile, type SketchData } from '../src/sketch/model';
import { outlineRings, referenceLength } from '../src/geometry/shapes';
import { containsRings } from '../src/geometry/polygon';

/** A closed polygon of lines through the given points (shared point ids). */
function poly(s: SketchData, pts: Vec2[]): string[] {
  const ids = pts.map((p) => {
    const id = newId('pt');
    s.points[id] = p;
    return id;
  });
  ids.forEach((id, i) => s.entities.push({ id: newId('e'), kind: 'line', p: [id, ids[(i + 1) % ids.length]] } as SketchEntity));
  return ids;
}

describe("the CAD sketcher's pieces", () => {
  it('build into the tunnel and run (a CAD refactor that breaks them fails here)', () => {
    const s = emptySketch();
    poly(s, [[0, 0], [40, 0], [40, 10], [0, 10]]);
    const solver = toSolverSketch(s);
    expect(solver.entities).toHaveLength(4);
    const line = s.entities[0];
    const plan = planDimension(s, [line.id], null);
    expect('value' in plan && plan.value).toBeCloseTo(40, 9);
  });
});

describe('sketch loops', () => {
  it('a rectangle is one ring, in metres', () => {
    const s = emptySketch();
    poly(s, [[0, 0], [40, 0], [40, 10], [0, 10]]);
    const p = sketchProfile(s);
    expect(p.rings).toHaveLength(1);
    expect(p.open).toEqual([]);
    const rings = outlineRings({ kind: 'sketch', name: 'R', sketch: s });
    expect(containsRings(rings, 0.02, 0.005)).toBe(true);
    expect(referenceLength({ kind: 'sketch', name: 'R', sketch: s })).toBeCloseTo(0.04, 9);
  });
  it('a ring inside another is a hole; two apart are two islands', () => {
    const s = emptySketch();
    poly(s, [[0, 0], [100, 0], [100, 100], [0, 100]]);
    poly(s, [[40, 40], [60, 40], [60, 60], [40, 60]]);
    poly(s, [[200, 0], [220, 0], [220, 20]]);
    const rings = outlineRings({ kind: 'sketch', name: 'H', sketch: s });
    expect(rings).toHaveLength(3);
    expect(containsRings(rings, 0.01, 0.01)).toBe(true); // in the big square
    expect(containsRings(rings, 0.05, 0.05)).toBe(false); // in its hole
    expect(containsRings(rings, 0.215, 0.005)).toBe(true); // the island
  });
  it('arcs and circles close loops; a coincident relation joins points', () => {
    const s = emptySketch();
    // A slot: two lines and two half circles (the arcs' ends share the lines' points).
    const [a, b, c, d] = poly(s, [[0, 0], [50, 0], [50, 20], [0, 20]]);
    s.entities = s.entities.filter((e) => !(e.kind === 'line' && ((e.p[0] === b && e.p[1] === c) || (e.p[0] === d && e.p[1] === a))));
    const c1 = newId('pt');
    const c2 = newId('pt');
    s.points[c1] = [50, 10];
    s.points[c2] = [0, 10];
    s.entities.push({ id: newId('e'), kind: 'arc', c: c1, a: b, b: c } as SketchEntity);
    // The left arc ends on its own point, joined to d by a coincident relation.
    const d2 = newId('pt');
    s.points[d2] = [0, 20];
    s.entities.push({ id: newId('e'), kind: 'arc', c: c2, a: d2, b: a } as SketchEntity);
    s.constraints.push({ id: newId('c'), kind: 'coincident', refs: [d, d2] });
    const circle = newId('pt');
    s.points[circle] = [100, 0];
    s.entities.push({ id: newId('e'), kind: 'circle', c: circle, r: 5 } as SketchEntity);
    const p = sketchProfile(s);
    expect(p.open).toEqual([]);
    expect(p.rings).toHaveLength(2);
    const rings = outlineRings({ kind: 'sketch', name: 'S', sketch: s });
    expect(containsRings(rings, 0.055, 0.01)).toBe(true); // in the right half circle
    expect(containsRings(rings, -0.005, 0.01)).toBe(true); // in the left one
  });
  it('an open chain is refused at its ends, a branch at its point; construction does not count', () => {
    const s = emptySketch();
    const ids = poly(s, [[0, 0], [40, 0], [40, 10], [0, 10]]);
    s.entities.pop(); // open the rectangle
    let p = sketchProfile(s);
    expect(p.rings).toHaveLength(0);
    expect(p.open).toHaveLength(2);
    // Close it again with a construction line: still open.
    s.entities.push({ id: newId('e'), kind: 'line', p: [ids[3], ids[0]], construction: true } as SketchEntity);
    expect(sketchProfile(s).rings).toHaveLength(0);
    // Close it for real and add a spur: a branch.
    s.entities.push({ id: newId('e'), kind: 'line', p: [ids[3], ids[0]] } as SketchEntity);
    const tip = newId('pt');
    s.points[tip] = [60, 0];
    s.entities.push({ id: newId('e'), kind: 'line', p: [ids[1], tip] } as SketchEntity);
    p = sketchProfile(s);
    expect(p.branch).toHaveLength(1);
    expect(p.open).toHaveLength(1);
  });
});

describe('dimension values', () => {
  it('reads numbers with or without units, in mm and degrees', () => {
    expect(evalValue('40', 'length')).toEqual({ value: 40 });
    expect(evalValue('4 cm', 'length')).toEqual({ value: 40 });
    expect(evalValue('0.04 m', 'length')).toEqual({ value: 40 });
    expect('value' in evalValue('1.5 in', 'length') && (evalValue('1.5 in', 'length') as { value: number }).value).toBeCloseTo(38.1, 9);
    expect(evalValue('30°', 'angle')).toEqual({ value: 30 });
    expect('value' in evalValue('0.5 rad', 'angle')).toBe(true);
    expect('error' in evalValue('-3', 'length')).toBe(true);
    expect('error' in evalValue('4 deg', 'length')).toBe(true);
    expect('error' in evalValue('wide', 'length')).toBe(true);
  });
});

describe('sketch edits', () => {
  it('a rectangle is four lines, two horizontal and two vertical, and one ring', () => {
    const s = emptySketch();
    const lines = addRectangle(s, [-20, -10], [20, 10], null);
    expect(lines).toHaveLength(4);
    expect(s.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(2);
    expect(s.constraints.filter((c) => c.kind === 'vertical')).toHaveLength(2);
    expect(sketchProfile(s).rings).toHaveLength(1);
  });

  it('a fillet cuts both lines back to an arc tangent to them, of that radius, still one closed ring', () => {
    const s = emptySketch();
    addRectangle(s, [0, 0], [40, 20], null);
    const corner = Object.entries(s.points).find(([, p]) => p[0] === 40 && p[1] === 20)![0];
    const out = fillet(s, corner, 5);
    expect(out.ok).toBe(true);
    const arc = s.entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(s.points[corner]).toBeUndefined();
    // Centre 5 in from both sides; the ends where the sides were cut.
    expect(s.points[arc.c][0]).toBeCloseTo(35, 9);
    expect(s.points[arc.c][1]).toBeCloseTo(15, 9);
    const ends = [s.points[arc.a], s.points[arc.b]].sort((p, q) => p[0] - q[0]);
    expect(ends[0][0]).toBeCloseTo(35, 9);
    expect(ends[0][1]).toBeCloseTo(20, 9);
    expect(ends[1][0]).toBeCloseTo(40, 9);
    expect(ends[1][1]).toBeCloseTo(15, 9);
    expect(s.constraints.filter((c) => c.kind === 'tangent')).toHaveLength(2);
    expect(s.constraints.find((c) => c.kind === 'radius')).toMatchObject({ refs: [arc.id], expr: '5 mm', driving: true });
    // The short way round: the ring's area is the rectangle's less the corner the arc cut off.
    const p = sketchProfile(s);
    expect(p.rings).toHaveLength(1);
    expect(p.open).toHaveLength(0);
    expect(Math.abs(polygonArea(p.rings[0]))).toBeCloseTo(800 - (25 - (Math.PI * 25) / 4), 0);
  });

  it('a fillet that does not fit, or not at a corner of two lines, is refused with the reason', () => {
    const s = emptySketch();
    addRectangle(s, [0, 0], [40, 20], null);
    const corner = Object.entries(s.points).find(([, p]) => p[0] === 40 && p[1] === 20)![0];
    expect(fillet(clone(s), corner, 25)).toEqual({ ok: false, reason: 'That radius is too large for these lines.' });
    const t = emptySketch();
    const a = placePoint(t, [0, 0], null);
    const b = placePoint(t, [10, 0], null);
    addLine(t, a, b);
    expect(fillet(t, b, 1).ok).toBe(false);
  });

  it('a three-point arc goes through its middle point, the short or the long way round as clicked', () => {
    const s = emptySketch();
    const a = placePoint(s, [10, 0], null);
    const b = placePoint(s, [-10, 0], null);
    const over = addArc3(s, a, b, [0, 10])!;
    const under = addArc3(s, a, b, [0, -10])!;
    expect(addArc3(s, a, b, [0, 0])).toBeNull();
    const e1 = s.entities.find((e) => e.id === over) as Extract<SketchEntity, { kind: 'arc' }>;
    const e2 = s.entities.find((e) => e.id === under) as Extract<SketchEntity, { kind: 'arc' }>;
    expect(s.points[e1.c][0]).toBeCloseTo(0, 9);
    expect(s.points[e1.c][1]).toBeCloseTo(0, 9);
    // Together the two halves close a circle of radius 10.
    const p = sketchProfile(s);
    expect(p.rings).toHaveLength(1);
    expect(Math.abs(polygonArea(p.rings[0]))).toBeCloseTo(Math.PI * 100, -1);
    expect(e1.ccw ?? true).not.toBe(e2.ccw ?? true);
  });

  it('deleting a point takes its curves and their relations; points nothing uses go too', () => {
    const s = emptySketch();
    const lines = addRectangle(s, [0, 0], [40, 20], null);
    addDimension(s, 'distance', [lines[0]], 40, null);
    const corner = Object.entries(s.points).find(([, p]) => p[0] === 40 && p[1] === 0)![0];
    const t = deleteItems(s, [corner]);
    expect(t.entities).toHaveLength(2);
    expect(Object.keys(t.points)).toHaveLength(3);
    // The bottom line's horizontal relation and dimension went with it; the top's stays.
    expect(t.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1);
    expect(t.constraints.some((c) => c.kind === 'distance')).toBe(false);
    expect(sketchProfile(t).open).toHaveLength(2);
    // The sketch it came from is as it was (for undo).
    expect(s.entities).toHaveLength(4);
  });
});
