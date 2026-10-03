// 2D geometry and inference while drawing (src/sketch/geom.ts, inference.ts):
// intersections, arcs through points, tangent arcs, and which snap and
// relation each pointer position gives (8 px), with Ctrl suppressing them.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { circleCircle, circleThrough, lineCircle, lineLine, tangentArc } from '../../src/sketch/geom';
import { infer, tangentAtEnd } from '../../src/sketch/inference';
import { circle, merge, rectangle } from './fixtures';

const close = (a: number[], b: number[], tol = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(tol)));

describe('geometry', () => {
  it('intersects lines and circles', () => {
    const x = lineLine([0, 0], [10, 0], [5, -5], [5, 5])!;
    close(x.p, [5, 0]);
    expect(x.t).toBeCloseTo(0.5);
    expect(lineLine([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
    const lc = lineCircle([-10, 0], [10, 0], [0, 0], 5);
    expect(lc.map((h) => h.p[0])).toEqual([-5, 5]);
    const cc = circleCircle([0, 0], 20, [30, 0], 20);
    expect(cc).toHaveLength(2);
    close([cc[0][0], Math.abs(cc[0][1])], [15, Math.sqrt(400 - 225)]);
    expect(circleCircle([0, 0], 5, [30, 0], 5)).toEqual([]);
  });

  it('finds the arc through three points and its turn', () => {
    const a = circleThrough([10, 0], [0, 10], [-10, 0])!;
    close(a.c, [0, 0]);
    expect(a.r).toBeCloseTo(10);
    expect(a.ccw).toBe(true);
    expect(circleThrough([10, 0], [0, -10], [-10, 0])!.ccw).toBe(false);
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
  });

  it('makes a tangent arc from a direction to an end point', () => {
    // Leaving (10, 0) heading +x, ending at (10, 20): a half circle of radius 10 about (10, 10), counter-clockwise.
    const t = tangentArc([10, 0], [1, 0], [10, 20])!;
    close(t.c, [10, 10]);
    expect(t.r).toBeCloseTo(10);
    expect(t.ccw).toBe(true);
    expect(tangentArc([0, 0], [1, 0], [5, 0])).toBeNull();
  });
});

describe('inference while drawing', () => {
  const px = 0.1; // 8 px = 0.8 mm
  const f = merge(rectangle(0, 0, 40, 20), circle('c1', [100, 0], 10));

  it('snaps to a point within 8 px (coincident), the origin first when nearest', () => {
    const r = infer({ f, at: [40.5, 20.3], px });
    expect(r.snap).toEqual({ kind: 'point', id: 'p3' });
    expect(r.at).toEqual([40, 20]);
    expect(r.glyphs).toEqual(['coincident']);
    expect(infer({ f, at: [0.3, -0.2], px }).snap).toEqual({ kind: 'point', id: 'origin' });
    // 9 px away: no point snap.
    expect(infer({ f, at: [40.9, 25], px }).snap?.kind).not.toBe('point');
  });

  it('snaps to a midpoint, an intersection and a curve', () => {
    expect(infer({ f, at: [20.4, 0.3], px }).snap).toEqual({ kind: 'midpoint', line: 'e1' });
    const on = infer({ f, at: [100, 10.5], px });
    expect(on.snap).toEqual({ kind: 'curve', entity: 'c1' });
    close(on.at, [100, 10]);
    const g = merge(f, { points: { q1: [30, -10], q2: [30, 40] }, entities: [{ id: 'cut', kind: 'line', p: ['q1', 'q2'] }], constraints: [] });
    const x = infer({ f: g, at: [30.3, 20.2], px });
    expect(x.snap).toEqual({ kind: 'intersection', entities: ['e3', 'cut'] });
    close(x.at, [30, 20]);
  });

  it('infers horizontal and vertical from the start of a segment, and perpendicular to the line it continues', () => {
    const empty = { points: {}, entities: [] };
    const h = infer({ f: empty, at: [30, 0.5], px, anchor: { at: [0, 0], point: null }, directions: true });
    expect(h.direction).toEqual({ kind: 'horizontal' });
    close(h.at, [30, 0]);
    const v = infer({ f: empty, at: [-0.5, 30], px, anchor: { at: [0, 0], point: null }, directions: true });
    expect(v.direction).toEqual({ kind: 'vertical' });
    // A slanted line ending at (10, 10); continuing perpendicular from its end.
    const slant = { points: { a: [0, 0] as [number, number], b: [10, 10] as [number, number] }, entities: [{ id: 's', kind: 'line' as const, p: ['a', 'b'] as [string, string] }] };
    const p = infer({ f: slant, at: [20.3, 0.2], px, anchor: { at: [10, 10], point: 'b' }, from: ['s'], directions: true, exclude: new Set(['b']) });
    expect(p.direction).toEqual({ kind: 'perpendicular', line: 's' });
    close(p.at, [20.05, -0.05], 1e-6);
  });

  it('infers tangent to the arc a segment starts on', () => {
    const arc = { points: { c: [0, 0] as [number, number], a: [10, 0] as [number, number], b: [0, 10] as [number, number] }, entities: [{ id: 'arc', kind: 'arc' as const, c: 'c', a: 'a', b: 'b' }] };
    const t = tangentAtEnd(arc, arc.entities[0], 'b')!;
    close(t, [-1, 0]);
    const r = infer({ f: arc, at: [-20, 10.4], px, anchor: { at: [0, 10], point: 'b' }, from: ['arc'], directions: true, exclude: new Set(['b']) });
    // Tangent here is also horizontal: the closer one wins, both put the end on y = 10.
    expect(['tangent', 'horizontal']).toContain(r.direction?.kind);
    close(r.at, [-20, 10]);
  });

  it('a direction snap that ends on a curve takes both', () => {
    const r = infer({ f, at: [40.2, 12.1], px, anchor: { at: [20, 12], point: null }, directions: true });
    expect(r.direction).toEqual({ kind: 'horizontal' });
    expect(r.snap).toEqual({ kind: 'curve', entity: 'e2' });
    close(r.at, [40, 12]);
  });

  it('Ctrl suppresses every inference', () => {
    const r = infer({ f, at: [40.5, 20.3], px, suppress: true });
    expect(r).toEqual({ at: [40.5, 20.3], snap: null, direction: null, glyphs: [], guides: [] });
  });

  it('aligns with another point without a relation (a dashed guide)', () => {
    const r = infer({ f, at: [70, 20.5], px });
    expect(r.snap).toBeNull();
    expect(r.direction).toBeNull();
    expect(r.at[1]).toBe(20);
    expect(r.guides.length).toBe(1);
  });
});
