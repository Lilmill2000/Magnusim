// Smart Dimension (the kind follows the pick and where the label goes) and
// dimension placement math (extension lines, the dimension line through the
// label, arrows, radius / diameter / angle), and the label's words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { aligned, axisAligned, defaultLabelAt, dimensionLabel, LABEL_GAP_PX, LABEL_OFFSET_PX, withDisplayUnit, layoutDimension, linearKindFor, planDimension } from '../../src/sketch/dimensions';
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

  // ci2: on Linux (DejaVu Sans, wider than Segoe UI) the right edge's "20 mm" pill started on the
  // edge, so a click meant for the edge picked the label. The pill's near side keeps a gap now.
  describe('the pill clear of what it measures, however wide its words', () => {
    const px = 0.5; // mm per screen px
    /** A view looking straight down at the sketch (u right, v up): a w x h px pill's reach along dir, in mm. */
    const reachOf = (w: number, h: number) => (_at: Vec2, dir: Vec2) => ((Math.abs(dir[0]) * w) / 2 + (Math.abs(dir[1]) * h) / 2) * px;
    /** The pill's corners (mm) around its centre. */
    const corners = (c: Vec2, w: number, h: number): Vec2[] => [
      [c[0] - (w / 2) * px, c[1] - (h / 2) * px],
      [c[0] + (w / 2) * px, c[1] - (h / 2) * px],
      [c[0] + (w / 2) * px, c[1] + (h / 2) * px],
      [c[0] - (w / 2) * px, c[1] + (h / 2) * px],
    ];
    /** The least distance (screen px) from the pill to the infinite line through a, b; all its corners on one side. */
    const gapPx = (c: Vec2, w: number, h: number, a: Vec2, b: Vec2) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const d = corners(c, w, h).map((p) => ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / L);
      expect(Math.min(...d) * Math.max(...d)).toBeGreaterThan(0);
      return Math.min(...d.map(Math.abs)) / px;
    };
    const r = rectangle(0, 0, 30, 20);

    it.each([
      ['a short label (Segoe UI)', 44],
      ['a DejaVu Sans label', 56],
      ['a very wide label', 160],
    ])('a vertical line, %s: the near side LABEL_GAP_PX from the line', (_w, w) => {
      const at = defaultLabelAt(r, { kind: 'distance', refs: ['e2'] }, px, reachOf(w, 18))!;
      expect(at[1]).toBeCloseTo(10);
      expect(gapPx(at, w, 18, [30, 0], [30, 20])).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-9);
      // Never nearer than it always was (a short label's place is unchanged), and no farther than it needs.
      expect(at[0] - 30).toBeCloseTo(Math.max(LABEL_OFFSET_PX, LABEL_GAP_PX + w / 2) * px);
    });

    it('a horizontal line: a low pill keeps the usual offset, a tall one moves out', () => {
      const low = defaultLabelAt(r, { kind: 'distance', refs: ['e1'] }, px, reachOf(200, 18))!;
      expect(low[1]).toBeCloseTo(-LABEL_OFFSET_PX * px);
      expect(gapPx(low, 200, 18, [0, 0], [30, 0])).toBeGreaterThanOrEqual(LABEL_GAP_PX);
      const tall = defaultLabelAt(r, { kind: 'distance', refs: ['e1'] }, px, reachOf(40, 60))!;
      expect(gapPx(tall, 40, 60, [0, 0], [30, 0])).toBeCloseTo(LABEL_GAP_PX);
    });

    it('a slanted line: the pill corner nearest the line is LABEL_GAP_PX from it', () => {
      const at = defaultLabelAt(f, { kind: 'distance', refs: ['sl'] }, px, reachOf(90, 18))!;
      expect(gapPx(at, 90, 18, [0, 50], [10, 60])).toBeCloseTo(LABEL_GAP_PX);
    });

    it('horizontal and vertical distances, and a radius', () => {
      const x = defaultLabelAt(r, { kind: 'distance_x', refs: ['p1', 'p3'] }, px, reachOf(60, 40))!;
      expect(x[1] - 20 - 20 * px).toBeCloseTo(LABEL_GAP_PX * px);
      const y = defaultLabelAt(r, { kind: 'distance_y', refs: ['p1', 'p3'] }, px, reachOf(120, 18))!;
      expect(y[0] - 30 - 60 * px).toBeCloseTo(LABEL_GAP_PX * px);
      // c1's radius label (centre 100,0, r 10) out at 45 degrees: every corner clear of the rim.
      const w = 140;
      const h = 18;
      const rad = defaultLabelAt(f, { kind: 'radius', refs: ['c1'] }, px, reachOf(w, h))!;
      const nearest = Math.min(...corners(rad, w, h).map((p) => Math.hypot(p[0] - 100, p[1]) - 10));
      expect(nearest / px).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-9);
    });

    it('with no size known: the usual offset', () => {
      const at = defaultLabelAt(r, { kind: 'distance', refs: ['e2'] }, px)!;
      expect(at[0] - 30).toBeCloseTo(LABEL_OFFSET_PX * px);
      expect(defaultLabelAt(r, { kind: 'distance', refs: ['e2'] }, px, () => null)).toEqual(at);
    });

    it('layoutDimension passes the size on: the dimension line runs out to the moved label', () => {
      const lay = layoutDimension(r, { kind: 'distance', refs: ['e2'] }, px, reachOf(160, 18))!;
      expect(lay.text[0] - 30).toBeCloseTo((LABEL_GAP_PX + 80) * px);
      expect(Math.max(...lay.lines.flat().map((p) => p[0]))).toBeGreaterThan(lay.text[0]);
    });
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
  it('numbers in the display unit with the unit next to them (Daniel 2026-10-06), two decimals at most; R, ⌀ and ° marks; driven in parentheses; expressions as fx', () => {
    expect(dimensionLabel({ kind: 'distance', expr: '40 mm', driving: true }, 40, units())).toBe('40 mm');
    expect(dimensionLabel({ kind: 'distance', expr: '44.72 mm', driving: false }, Math.hypot(40, 20), units())).toBe('(44.72 mm)');
    expect(dimensionLabel({ kind: 'radius', expr: '10 mm', driving: true }, 10, units())).toBe('R10 mm');
    expect(dimensionLabel({ kind: 'diameter', expr: '125', driving: true }, 125, units())).toBe('⌀125 mm');
    expect(dimensionLabel({ kind: 'angle', expr: '30 deg', driving: true }, 30, units())).toBe('30°');
    expect(dimensionLabel({ kind: 'distance', expr: 'width / 2', driving: true }, 20, units())).toBe('fx: 20 mm');
    expect(dimensionLabel({ kind: 'diameter', expr: '12 in', driving: true }, 304.8, units('in'))).toBe('⌀12 in');
    // A value typed in another unit reads in the document's: 5 in in a mm document.
    expect(dimensionLabel({ kind: 'distance', expr: '5 in', driving: true }, 127, units())).toBe('127 mm');
    expect(withDisplayUnit(40, 'length', units('in'))).toBe('1.57 in');
    expect(withDisplayUnit(30, 'angle', units())).toBe('30°');
  });
});
