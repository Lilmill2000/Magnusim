// Smart Dimension (the kind follows the pick and where the label goes) and
// dimension placement math (extension lines, the dimension line through the
// label, arrows, radius / diameter / angle), and the label's words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { aligned, axisAligned, defaultLabelAt, dimensionLabel, layoutDimension, linearKindFor, planDimension } from '../../src/sketch/dimensions';
import type { SketchDimension, Vec2 } from '../../src/types/doc';
import { circle, merge, rectangle } from './fixtures';

const units = (length: 'mm' | 'in' = 'mm', angle: 'deg' | 'rad' = 'deg') => ({ units: () => ({ length, angle }) });
const near = (a: Vec2, b: Vec2, tol = 1e-9) => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(tol));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(tol));
};

const arc = { points: { ac: [50, 50] as Vec2, aa: [60, 50] as Vec2, ab: [50, 60] as Vec2 }, entities: [{ id: 'a1', kind: 'arc' as const, c: 'ac', a: 'aa', b: 'ab' }], constraints: [] };
const f = merge(rectangle(0, 0, 40, 20), circle('c1', [100, 0], 10), arc, {
  points: { s1: [0, 50], s2: [10, 60] },
  entities: [{ id: 'sl', kind: 'line', p: ['s1', 's2'] }],
  constraints: [],
});

describe('Smart Dimension: the kind follows the pick', () => {
  it('a line is its length, a circle its diameter, an arc its radius', () => {
    expect(planDimension(f, ['e1'], null)).toEqual({ kind: 'distance', refs: ['e1'], value: 40 });
    expect(planDimension(f, ['c1'], null)).toEqual({ kind: 'diameter', refs: ['c1'], value: 20 });
    expect(planDimension(f, ['a1'], null)).toEqual({ kind: 'radius', refs: ['a1'], value: 10 });
  });

  it('two points: above or below them horizontal, beside them vertical, elsewhere aligned', () => {
    // p1 (0,0) and p3 (40,20): the diagonal.
    expect(linearKindFor([0, 0], [40, 20], [20, 30])).toBe('distance_x');
    expect(linearKindFor([0, 0], [40, 20], [50, 10])).toBe('distance_y');
    expect(linearKindFor([0, 0], [40, 20], [60, 40])).toBe('distance');
    expect(planDimension(f, ['p1', 'p3'], [60, 40])).toEqual({ kind: 'distance', refs: ['p1', 'p3'], value: Math.hypot(40, 20) });
    expect(planDimension(f, ['p3', 'p1'], [20, -10])).toEqual({ kind: 'distance_x', refs: ['p1', 'p3'], value: 40 });
    expect(planDimension(f, ['p1', 'p3'], [-10, 10])).toEqual({ kind: 'distance_y', refs: ['p1', 'p3'], value: 20 });
    // Points on one horizontal: "above" them is still their (aligned) distance, never a 0 vertical one.
    expect(planDimension(f, ['p1', 'p2'], [-5, 5])).toMatchObject({ kind: 'distance' });
  });

  it('a point and a line, two lines, curves by their centres', () => {
    expect(planDimension(f, ['p3', 'e1'], null)).toEqual({ kind: 'distance', refs: ['p3', 'e1'], value: 20 });
    expect(planDimension(f, ['e1', 'e3'], null)).toEqual({ kind: 'distance', refs: ['e1', 'e3'], value: 20 });
    const ang = planDimension(f, ['e1', 'sl'], null);
    expect(ang).toMatchObject({ kind: 'angle' });
    expect((ang as { value: number }).value).toBeCloseTo(45);
    // Reversed picks give the same positive angle (the references are ordered for it).
    expect((planDimension(f, ['sl', 'e1'], null) as { value: number }).value).toBeCloseTo(45);
    expect(planDimension(f, ['c1', 'a1'], [110, 60])).toMatchObject({ kind: 'distance', refs: ['c1c', 'ac'] });
    expect(planDimension(f, ['p1', 'c1'], [50, -20])).toMatchObject({ kind: 'distance', refs: ['p1', 'c1c'], value: 100 });
  });

  it('says why when the picks make no dimension', () => {
    expect(planDimension(f, [], null)).toEqual({ reason: 'Pick a line, a circle, an arc or two points' });
    expect(planDimension(f, ['p1'], null)).toEqual({ reason: 'Pick a second point, a line or a circle' });
    expect(planDimension(f, ['p1', 'e1'], null)).toEqual({ reason: 'That point lies on the line: dimension it some other way' });
  });
});

describe('where a typed dimension puts its label', () => {
  // Review P2/P3 round 1: a rectangle from the origin got its width across its own region.
  it('outside the drawing: a rectangle from the origin has its width below it and its height to its right', () => {
    const r = rectangle(0, 0, 60, 20);
    const w = defaultLabelAt(r, { kind: 'distance', refs: ['e1'] }, 1)!;
    expect(w[0]).toBeCloseTo(30);
    expect(w[1]).toBeLessThan(0);
    const h = defaultLabelAt(r, { kind: 'distance', refs: ['e2'] }, 1)!;
    expect(h[0]).toBeGreaterThan(60);
    expect(h[1]).toBeCloseTo(10);
  });
});

describe('placement math', () => {
  it('aligned: extension lines from the points to the label side, the dimension line through the label', () => {
    const lay = aligned([0, 0], [40, 0], [20, 10], 1, 2);
    // Extension lines start 1 (gap) off the points and end 2 (overshoot) beyond the dimension line.
    expect(lay.lines[0]).toEqual([
      [0, 1],
      [0, 12],
    ]);
    expect(lay.lines[1]).toEqual([
      [40, 1],
      [40, 12],
    ]);
    expect(lay.lines[2]).toEqual([
      [0, 10],
      [40, 10],
    ]);
    near(lay.text, [20, 10]);
    near(lay.arrows[0].dir, [-1, 0]);
    near(lay.arrows[1].dir, [1, 0]);
    // A label outside the span stretches the dimension line to it.
    const out = aligned([0, 0], [40, 0], [55, -10], 1, 2);
    expect(out.lines[2]).toEqual([
      [0, -10],
      [55, -10],
    ]);
    near(out.text, [55, -10]);
  });

  it('horizontal and vertical: the dimension line at the label, extension lines square to it', () => {
    const h = axisAligned([0, 0], [40, 20], [20, 30], 0, 1, 2);
    expect(h.lines).toEqual([
      [
        [0, 1],
        [0, 32],
      ],
      [
        [40, 21],
        [40, 32],
      ],
      [
        [0, 30],
        [40, 30],
      ],
    ]);
    near(h.text, [20, 30]);
    const v = axisAligned([0, 0], [40, 20], [50, 10], 1, 1, 2);
    expect(v.lines.at(-1)).toEqual([
      [50, 0],
      [50, 20],
    ]);
  });

  it('radius from the centre to the edge, diameter across, arrow on the edge', () => {
    const r = layoutDimension(f, { kind: 'radius', refs: ['a1'], at: [70, 50] }, 0.1)!;
    expect(r.lines[0]).toEqual([
      [50, 50],
      [70, 50],
    ]);
    near(r.arrows[0].at, [60, 50]);
    const d = layoutDimension(f, { kind: 'diameter', refs: ['c1'], at: [100, 5] }, 0.1)!;
    // Inside the circle: across it, arrows on both edges pointing out.
    near(d.lines[0][0], [100, -10]);
    near(d.lines[0][1], [100, 10]);
    expect(d.arrows).toHaveLength(2);
    near(d.arrows[0].dir, [0, 1]);
    near(d.arrows[1].dir, [0, -1]);
  });

  it('angle: an arc about the lines meeting point, through the label radius', () => {
    const a = layoutDimension(f, { kind: 'angle', refs: ['e1', 'sl'], at: [10, 10] }, 0.1)!;
    // e1 is y = 0, sl is y = x + 50: they meet at (-50, 0).
    const o: Vec2 = [-50, 0];
    const R = Math.hypot(60, 10);
    for (const [p, q] of a.lines.slice(0, 4)) {
      expect(Math.hypot(p[0] - o[0], p[1] - o[1])).toBeCloseTo(R);
      expect(Math.hypot(q[0] - o[0], q[1] - o[1])).toBeCloseTo(R);
    }
    near(a.arrows[0].at, [-50 + R, 0]);
  });

  it('places a new dimension beside what it measures when it has no place yet', () => {
    const lay = layoutDimension(f, { kind: 'distance_x', refs: ['p1', 'p3'] } as SketchDimension, 0.5)!;
    // 28 px above the higher point.
    near(lay.text, [20, 20 + 14]);
  });
});

describe('label words', () => {
  it('numbers in the display unit, two decimals at most; R, ⌀ and ° marks; driven in parentheses; expressions as fx', () => {
    expect(dimensionLabel({ kind: 'distance', expr: '40 mm', driving: true }, 40, units())).toBe('40');
    expect(dimensionLabel({ kind: 'distance', expr: '44.72 mm', driving: false }, Math.hypot(40, 20), units())).toBe('(44.72)');
    expect(dimensionLabel({ kind: 'radius', expr: '10 mm', driving: true }, 10, units())).toBe('R10');
    expect(dimensionLabel({ kind: 'diameter', expr: '20 mm', driving: true }, 20, units())).toBe('⌀20');
    expect(dimensionLabel({ kind: 'angle', expr: '30 deg', driving: true }, 30, units())).toBe('30°');
    expect(dimensionLabel({ kind: 'distance', expr: 'width / 2', driving: true }, 20, units())).toBe('fx: 20');
    expect(dimensionLabel({ kind: 'diameter', expr: '12 in', driving: true }, 304.8, units('in'))).toBe('⌀12');
  });
});
