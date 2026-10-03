// @vitest-environment node
// Kernel API 3 (docs/p2p3-plan.md §2.8-2.9): sketch_regions (closed regions, their
// canonical keys, areas, samples, triangles, open ends, dangling entities) and
// extrude_regions (merged regions swept with one side face per sub-segment and caps
// per region), against analytic values. Keys must survive a dimension change and
// follow trim lineage (e_1 -> e_1 + e_1.b).
// Owner: KERNEL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { EDGE_FLAG, EDGE_HIDDEN } from '../../src/types/kernel-protocol';
import { call, loadKernel, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FRONT = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
type Curve = R;
const L = (id: string, a: number[], b: number[], pa?: string, pb?: string): Curve => ({ id, kind: 'line', a, b, ...(pa ? { pa } : {}), ...(pb ? { pb } : {}) });
const C = (id: string, c: number[], r: number, pc?: string): Curve => ({ id, kind: 'circle', c, r, ...(pc ? { pc } : {}) });
/** A w x h rectangle from (x0, y0), drawn counter-clockwise: e_1..e_4 through pt_1..pt_4. */
const rect = (w: number, h: number, x0 = 0, y0 = 0): Curve[] => [
  L('e_1', [x0, y0], [x0 + w, y0], 'pt_1', 'pt_2'),
  L('e_2', [x0 + w, y0], [x0 + w, y0 + h], 'pt_2', 'pt_3'),
  L('e_3', [x0 + w, y0 + h], [x0, y0 + h], 'pt_3', 'pt_4'),
  L('e_4', [x0, y0 + h], [x0, y0], 'pt_4', 'pt_1'),
];
const circles = (r1: number, r2: number): Curve[] => [C('c_1', [0, 0], r1, 'pt_c1'), C('c_2', [30, 0], r2, 'pt_c2')];
const LENS = '+c_1[x:c_1|c_2#1>x:c_1|c_2#0] +c_2[x:c_1|c_2#0>x:c_1|c_2#1]';

/** sketch_regions with its buffers unpacked per region. */
function regions(curves: Curve[], plane: R = TOP, extra: R = {}) {
  const r = call(k, 'sketch_regions', { plane, curves, ...extra });
  const b = k.takeBuffers(r as never) as Record<string, Float32Array | Uint32Array>;
  return { ...r, bufs: b } as R;
}
const keysOf = (r: R): string[] => r.regions.map((x: R) => x.key);

/** Area of two circles' overlap (d between centres). */
function lensArea(r1: number, r2: number, d: number): number {
  return r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) + r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2)) - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
}

/** Region i's triangles: all counter-clockwise, their area, and whether p lies in one. */
function triangles(r: R, i: number) {
  const uv = r.bufs.tri_uv as Float32Array;
  const idx = r.bufs.tri_idx as Uint32Array;
  const ranges = r.bufs.tri_ranges as Uint32Array;
  const [start, count] = [ranges[2 * i], ranges[2 * i + 1]];
  let area = 0;
  let ccw = true;
  const tris: number[][][] = [];
  for (let t = start; t < start + count; t += 3) {
    const p = [0, 1, 2].map((j) => [uv[2 * idx[t + j]], uv[2 * idx[t + j] + 1]]);
    const a = 0.5 * ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]));
    if (a < 0) ccw = false;
    area += a;
    tris.push(p);
  }
  const contains = (q: number[]) =>
    tris.some(([a, b, c]) => {
      const s = (p1: number[], p2: number[], p3: number[]) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
      const d1 = s(q, a, b);
      const d2 = s(q, b, c);
      const d3 = s(q, c, a);
      return !((d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9) && (d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9));
    });
  return { count, area, ccw, contains };
}

describe('sketch_regions (API 3)', () => {
  it('a rectangle: one region, its key as the plan writes it, area, sample, box, triangles', () => {
    const r = regions(rect(40, 20));
    expect(r.regions).toHaveLength(1);
    const g = r.regions[0];
    expect(g.key).toBe('+e_1[p:pt_1>p:pt_2] +e_2[p:pt_2>p:pt_3] +e_3[p:pt_3>p:pt_4] +e_4[p:pt_4>p:pt_1]');
    expect(g.loops).toEqual([g.key.split(' ')]);
    expect(g.entities).toEqual(['e_1', 'e_2', 'e_3', 'e_4']);
    expect(g.area).toBeCloseTo(800, 9);
    expect(g.bbox).toEqual([0, 0, 40, 20]);
    const t = triangles(r, 0);
    expect(t.ccw).toBe(true);
    expect(t.area).toBeCloseTo(800, 3);
    expect(t.contains(g.sample)).toBe(true);
    expect(r.open).toEqual([]);
    expect(r.dangling).toEqual([]);
    // Drawn the other way round, the region is the same (its loop keeps the region on the left).
    const cw = regions([L('e_1', [0, 0], [0, 20], 'pt_1', 'pt_4'), L('e_2', [0, 20], [40, 20], 'pt_4', 'pt_3'), L('e_3', [40, 20], [40, 0], 'pt_3', 'pt_2'), L('e_4', [40, 0], [0, 0], 'pt_2', 'pt_1')]);
    expect(cw.regions[0].key).toBe('-e_1[p:pt_1>p:pt_4] -e_4[p:pt_2>p:pt_1] -e_3[p:pt_3>p:pt_2] -e_2[p:pt_4>p:pt_3]');
  });

  it('two overlapping circles: exactly 3 regions with 3 distinct keys, the same after r 20 -> 25; analytic areas', () => {
    const d = 30;
    for (const [r1, r2] of [
      [20, 20],
      [25, 20],
    ]) {
      const r = regions(circles(r1, r2));
      expect(r.regions).toHaveLength(3);
      expect(new Set(keysOf(r)).size).toBe(3);
      expect(keysOf(r)).toEqual([
        '+c_1[x:c_1|c_2#0>x:c_1|c_2#1] -c_2[x:c_1|c_2#0>x:c_1|c_2#1]',
        LENS,
        '+c_2[x:c_1|c_2#1>x:c_1|c_2#0] -c_1[x:c_1|c_2#1>x:c_1|c_2#0]',
      ]);
      const lens = lensArea(r1, r2, d);
      const byKey = Object.fromEntries(r.regions.map((g: R) => [g.key, g]));
      expect(rel(byKey[LENS].area, lens)).toBeLessThan(1e-9);
      expect(rel(r.regions[0].area, Math.PI * r1 * r1 - lens)).toBeLessThan(1e-9);
      expect(rel(r.regions[2].area, Math.PI * r2 * r2 - lens)).toBeLessThan(1e-9);
      // c_1's own seam (at 0 degrees) lies on the lens: still one sub-segment per side.
      expect(byKey[LENS].loops).toEqual([LENS.split(' ')]);
      r.regions.forEach((g: R, i: number) => {
        const t = triangles(r, i);
        expect(t.ccw).toBe(true);
        expect(t.contains(g.sample)).toBe(true);
        expect(rel(t.area, g.area)).toBeLessThan(5e-3);
      });
    }
  });

  it('a slot with an inner circle: the slot region has the circle as a hole; the disc is a region too', () => {
    const slot = [
      L('e_1', [0, -5], [20, -5], 'pt_1', 'pt_2'),
      { id: 'a_1', kind: 'arc', c: [20, 0], r: 5, a0: -90, a1: 90, ccw: true, pa: 'pt_2', pb: 'pt_3', pc: 'pt_c1' },
      L('e_2', [20, 5], [0, 5], 'pt_3', 'pt_4'),
      { id: 'a_2', kind: 'arc', c: [0, 0], r: 5, a0: 90, a1: 270, ccw: true, pa: 'pt_4', pb: 'pt_1', pc: 'pt_c2' },
      C('c_1', [10, 0], 2, 'pt_c3'),
    ];
    const r = regions(slot);
    expect(keysOf(r)).toEqual(['+a_1[p:pt_2>p:pt_3] +e_2[p:pt_3>p:pt_4] +a_2[p:pt_4>p:pt_1] +e_1[p:pt_1>p:pt_2] / -c_1[]', '+c_1[]']);
    const [ring, disc] = r.regions;
    expect(ring.loops).toHaveLength(2);
    expect(ring.loops[1]).toEqual(['-c_1[]']);
    expect(rel(ring.area, 20 * 10 + Math.PI * 25 - Math.PI * 4)).toBeLessThan(1e-9);
    expect(rel(disc.area, Math.PI * 4)).toBeLessThan(1e-9);
    expect(ring.bbox.map((v: number) => Math.round(v * 1e9) / 1e9)).toEqual([-5, -5, 25, 5]);
    // The sample of the ring is in the ring, not in its hole.
    expect(Math.hypot(ring.sample[0] - 10, ring.sample[1])).toBeGreaterThan(2);
    // Clockwise arcs give the same region.
    const cw = regions([
      L('e_1', [0, -5], [20, -5], 'pt_1', 'pt_2'),
      { id: 'a_1', kind: 'arc', c: [20, 0], r: 5, a0: 90, a1: -90, ccw: false, pa: 'pt_3', pb: 'pt_2' },
      L('e_2', [20, 5], [0, 5], 'pt_3', 'pt_4'),
      { id: 'a_2', kind: 'arc', c: [0, 0], r: 5, a0: -90, a1: 90, ccw: false, pa: 'pt_1', pb: 'pt_4' },
    ]);
    expect(keysOf(cw)).toEqual(['+e_1[p:pt_1>p:pt_2] -a_1[p:pt_3>p:pt_2] +e_2[p:pt_3>p:pt_4] -a_2[p:pt_1>p:pt_4]']);
    expect(rel(cw.regions[0].area, 200 + Math.PI * 25)).toBeLessThan(1e-9);
  });

  it('a rectangle with a line across: 2 regions; the T-junctions are named by their points', () => {
    const r = regions([...rect(40, 20), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')]);
    expect(keysOf(r)).toEqual([
      '+e_1[p:pt_1>p:pt_5] +e_5[p:pt_5>p:pt_6] +e_3[p:pt_6>p:pt_4] +e_4[p:pt_4>p:pt_1]',
      '+e_1[p:pt_5>p:pt_2] +e_2[p:pt_2>p:pt_3] +e_3[p:pt_3>p:pt_6] -e_5[p:pt_5>p:pt_6]',
    ]);
    expect(r.regions.map((g: R) => Math.round(g.area * 1e9) / 1e9)).toEqual([300, 500]);
    // Without point ids the junctions are named by the curves crossing there.
    const bare = regions([L('e_1', [0, 0], [10, 0]), L('e_2', [10, 0], [10, 10]), L('e_3', [10, 10], [0, 10]), L('e_4', [0, 10], [0, 0]), L('e_5', [5, 0], [5, 10])]);
    expect(keysOf(bare)).toEqual([
      '+e_1[x:e_1|e_4#0>x:e_1|e_5#0] +e_5[x:e_1|e_5#0>x:e_3|e_5#0] +e_3[x:e_3|e_5#0>x:e_3|e_4#0] +e_4[x:e_3|e_4#0>x:e_1|e_4#0]',
      '+e_1[x:e_1|e_5#0>x:e_1|e_2#0] +e_2[x:e_1|e_2#0>x:e_2|e_3#0] +e_3[x:e_2|e_3#0>x:e_3|e_5#0] -e_5[x:e_1|e_5#0>x:e_3|e_5#0]',
    ]);
  });

  it('an open chain: no region, 2 open ends, both entities dangling', () => {
    const r = regions([L('e_1', [0, 0], [10, 0], 'pt_1', 'pt_2'), L('e_2', [10, 0], [10, 10], 'pt_2', 'pt_3')]);
    expect(r.regions).toEqual([]);
    expect(r.open).toEqual([
      { at: [0, 0], entity: 'e_1', point: 'pt_1' },
      { at: [10, 10], entity: 'e_2', point: 'pt_3' },
    ]);
    expect(r.dangling).toEqual(['e_1', 'e_2']);
    // A line sticking out of a closed region dangles; the region is still found.
    const tail = regions([...rect(10, 10), L('e_5', [10, 5], [20, 5], 'pt_5', 'pt_6')]);
    expect(tail.regions).toHaveLength(1);
    expect(tail.dangling).toEqual(['e_5']);
    expect(tail.open).toEqual([{ at: [20, 5], entity: 'e_5', point: 'pt_6' }]);
    expect(tail.regions[0].key).toContain('p:pt_5');
  });

  it('keys survive dimension changes; crossings are named by the pair and a side, not by position', () => {
    const withLine = (w: number) => [...rect(w, 20), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')];
    expect(keysOf(regions(withLine(50)))).toEqual(keysOf(regions(withLine(40))));
    // A solver's corners are equal only to ~1e-12: ends that miss by that still meet.
    const noisy = rect(40, 20).map((c, i) => ({ ...c, b: [c.b[0] + (i % 2 ? 3e-12 : -2e-12), c.b[1] + 1e-12] }));
    const nr = regions(noisy);
    expect(keysOf(nr)).toEqual(keysOf(regions(rect(40, 20))));
    expect(nr.regions[0].area).toBeCloseTo(800, 6);
    // A line crossing a circle: #0 before the foot of the centre on the line, #1 after,
    // whether the segment reaches the second crossing or not.
    const short = regions([C('c_1', [0, 0], 10), L('e_1', [-20, 3], [5, 3])]);
    expect(keysOf(short)).toEqual(['+c_1[x:c_1|e_1#0>x:c_1|e_1#0]']);
    const long = regions([C('c_1', [0, 0], 10), L('e_1', [-20, 3], [20, 3])]);
    expect(keysOf(long)).toEqual(['+c_1[x:c_1|e_1#0>x:c_1|e_1#1] -e_1[x:c_1|e_1#0>x:c_1|e_1#1]', '+c_1[x:c_1|e_1#1>x:c_1|e_1#0] +e_1[x:c_1|e_1#0>x:c_1|e_1#1]']);
    // A tangent touch is #0; the circle touched once is c_1[X>X].
    const tangent = regions([C('c_1', [0, 0], 10), L('e_1', [-20, 10], [20, 10])]);
    expect(keysOf(tangent)).toEqual(['+c_1[x:c_1|e_1#0>x:c_1|e_1#0]']);
    expect(keysOf(regions([C('c_1', [0, 0], 5), C('c_2', [0, 0], 10)]))).toEqual(['+c_1[]', '+c_2[] / -c_1[]']);
  });

  it('trim lineage: splitting e_1 into e_1 + e_1.b changes only the key of the region on e_1.b', () => {
    const before = keysOf(regions([...rect(40, 20), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')]));
    const after = keysOf(
      regions([
        L('e_1', [0, 0], [15, 0], 'pt_1', 'pt_5'),
        L('e_1.b', [15, 0], [40, 0], 'pt_5', 'pt_2'),
        ...rect(40, 20).slice(1),
        L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6'),
      ]),
    );
    expect(after).toContain(before[0]);
    expect(after).not.toContain(before[1]);
    expect(after).toContain(before[1].replace('+e_1[p:pt_5>p:pt_2]', '+e_1.b[p:pt_5>p:pt_2]'));
    // Trimming e_1's right part away opens the right region: only the left one stays,
    // and e_2 hangs from the top corner.
    const trimmed = regions([L('e_1', [0, 0], [15, 0], 'pt_1', 'pt_5'), ...rect(40, 20).slice(1), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')]);
    expect(keysOf(trimmed)).toEqual([before[0]]);
    expect(trimmed.dangling).toEqual(['e_2']);
    expect(trimmed.open).toEqual([{ at: [40, 0], entity: 'e_2', point: 'pt_2' }]);
  });

  it('works on any sketch plane (Front: normal -Y, u = X, v = normal x u = Z)', () => {
    const r = regions(rect(40, 20), FRONT);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].area).toBeCloseTo(800, 9);
    expect(r.regions[0].bbox).toEqual([0, 0, 40, 20]);
    const e = call(k, 'extrude_regions', { plane: FRONT, curves: rect(40, 20), regions: [r.regions[0].key], extent: { kind: 'blind', d: 5 } });
    expect(e.direction).toEqual([0, -1, 0]);
    expect(call(k, 'props', { id: e.id, bbox: 'exact' }).bbox.map((v: number) => Math.round(v * 1e9) / 1e9)).toEqual([0, -5, 0, 40, 0, 20]);
  });

  it('refuses degenerate curves by name; points alone make no region', () => {
    expect(tryCall(k, 'sketch_regions', { plane: TOP, curves: [L('e_3', [1, 1], [1, 1])] })).toMatchObject({ ok: false, kind: 'input', error: 'line e_3 has no length' });
    expect(tryCall(k, 'sketch_regions', { plane: TOP, curves: [C('c_1', [0, 0], 0)] })).toMatchObject({ ok: false, kind: 'input', error: 'circle c_1 needs a radius > 0' });
    expect(tryCall(k, 'sketch_regions', { plane: TOP, curves: [{ id: 'a_1', kind: 'arc', c: [0, 0], r: 5, a0: 30, a1: 30, ccw: true }] })).toMatchObject({ ok: false, kind: 'input', error: 'arc a_1 has no length' });
    expect(tryCall(k, 'sketch_regions', { plane: TOP, curves: [L('e_1', [0, 0], [1, 0]), L('e_1', [0, 0], [0, 1])] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'sketch_regions', { plane: TOP, curves: [{ id: 's_1', kind: 'spline' }] })).toMatchObject({ ok: false, kind: 'input' });
    const pts = regions([{ id: 'p_1', kind: 'point', p: [0, 0], pid: 'pt_1' }]);
    expect(pts.regions).toEqual([]);
    expect(pts.open).toEqual([]);
    expect(pts.dangling).toEqual([]);
  });
});

describe('extrude_regions (API 3)', () => {
  it('the lens extruded 10 mm: volume = lens area x 10, one side face per sub-segment, caps by key', () => {
    for (const [r1, r2] of [
      [20, 20],
      [25, 20],
    ]) {
      const e = call(k, 'extrude_regions', { plane: TOP, curves: circles(r1, r2), regions: [LENS], extent: { kind: 'blind', d: 10 } });
      expect(e).toMatchObject({ valid: true, faces: 4, solids: 1, from: 0, to: 10, direction: [0, 0, 1] });
      expect(rel(volume(k, e.id), lensArea(r1, r2, 30) * 10)).toBeLessThan(1e-9);
      const h = e.history;
      expect(Object.keys(h.sides).sort()).toEqual(['c_1[x:c_1|c_2#1>x:c_1|c_2#0]', 'c_2[x:c_1|c_2#0>x:c_1|c_2#1]']);
      expect(h.caps).toEqual({ [LENS]: { start: h.start, end: h.end } });
      expect(h.faces).toContainEqual({ out: h.sides['c_1[x:c_1|c_2#1>x:c_1|c_2#0]'], from: [{ seg: 'c_1[x:c_1|c_2#1>x:c_1|c_2#0]', how: 'generated' }] });
      expect(h.faces).toContainEqual({ out: h.start, from: [{ cap: 'start', how: 'generated' }] });
      expect(h.faces).toContainEqual({ out: h.end, from: [{ cap: 'end', how: 'generated' }] });
    }
  });

  it('both halves of a rectangle split by a line: one solid, no internal face, the split sides stay coplanar pairs (hidden edges)', () => {
    const curves = [...rect(40, 20), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')];
    const keys = keysOf(regions(curves));
    const e = call(k, 'extrude_regions', { plane: TOP, curves, regions: keys, extent: { kind: 'blind', d: 10 } });
    expect(e).toMatchObject({ valid: true, solids: 1, faces: 8 });
    expect(rel(volume(k, e.id), 8000)).toBeLessThan(1e-12);
    expect(Object.keys(e.history.sides).sort()).toEqual(['e_1[p:pt_1>p:pt_5]', 'e_1[p:pt_5>p:pt_2]', 'e_2[p:pt_2>p:pt_3]', 'e_3[p:pt_3>p:pt_6]', 'e_3[p:pt_6>p:pt_4]', 'e_4[p:pt_4>p:pt_1]']);
    // Merged regions share their caps.
    expect(e.history.caps[keys[0]]).toEqual(e.history.caps[keys[1]]);
    const t = call(k, 'tessellate', { id: e.id });
    const flags = k.takeBuffers(t as never).edge_flags as Uint8Array;
    const sameDomain = Array.from(flags).filter((f) => f & EDGE_FLAG.same_domain);
    expect(sameDomain).toHaveLength(2);
    expect(sameDomain.every((f) => f & EDGE_HIDDEN)).toBe(true);
  });

  it('flip, symmetric, two-sided and to a face', () => {
    const curves = [...rect(40, 20), L('e_5', [15, 0], [15, 20], 'pt_5', 'pt_6')];
    const [left, right] = keysOf(regions(curves));
    const flip = call(k, 'extrude_regions', { plane: TOP, curves, regions: [left], extent: { kind: 'blind', d: 10 }, flip: true });
    expect(flip).toMatchObject({ valid: true, direction: [0, 0, -1] });
    expect(rel(volume(k, flip.id), 3000)).toBeLessThan(1e-12);
    const fb = call(k, 'props', { id: flip.id, bbox: 'exact' }).bbox;
    expect(fb[2]).toBeCloseTo(-10, 9);
    expect(fb[5]).toBeCloseTo(0, 9);
    const sym = call(k, 'extrude_regions', { plane: TOP, curves, regions: [right], extent: { kind: 'symmetric', d: 10 } });
    expect(sym).toMatchObject({ from: -5, to: 5 });
    expect(call(k, 'props', { id: sym.id, bbox: 'exact' }).bbox.map((v: number) => Math.round(v * 1e9) / 1e9)).toEqual([15, 0, -5, 40, 20, 5]);
    const two = call(k, 'extrude_regions', { plane: TOP, curves, regions: [right], extent: { kind: 'two', d1: 10, d2: 4 } });
    expect(rel(volume(k, two.id), 25 * 20 * 14)).toBeLessThan(1e-12);
    const roof = call(k, 'box', { origin: [-10, -10, 30], dx: 60, dy: 40, dz: 5 });
    const under = call(k, 'topo', { id: roof.id, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.normal[2] < -0.5).i;
    const toFace = call(k, 'extrude_regions', { plane: TOP, curves, regions: [right], extent: { kind: 'to_face', target: roof.id, face: under } });
    expect(rel(volume(k, toFace.id), 25 * 20 * 30)).toBeLessThan(1e-12);
    const taper = call(k, 'extrude_regions', { plane: TOP, curves, regions: [right], extent: { kind: 'blind', d: 10 }, taper_deg: 5 });
    expect(taper.valid).toBe(true);
    expect(volume(k, taper.id)).toBeLessThan(25 * 20 * 10);
  });

  it('separate regions give separate solids with caps per region; a circle crossed by a line keeps one side face per sub-segment', () => {
    const two = [C('c_1', [0, 0], 5), C('c_2', [20, 0], 5)];
    const e = call(k, 'extrude_regions', { plane: TOP, curves: two, regions: ['+c_1[]', '+c_2[]'], extent: { kind: 'blind', d: 5 } });
    expect(e).toMatchObject({ valid: true, solids: 2, faces: 6 });
    expect(rel(volume(k, e.id), 2 * Math.PI * 25 * 5)).toBeLessThan(1e-12);
    expect(Object.keys(e.history.caps).sort()).toEqual(['+c_1[]', '+c_2[]']);
    expect(e.history.caps['+c_1[]']).not.toEqual(e.history.caps['+c_2[]']);
    expect(e.history.caps['+c_1[]']).toEqual({ start: e.history.start, end: e.history.end });
    // c_1 is split at the two crossings and at its own seam: still 2 side faces.
    const cl = [C('c_1', [0, 0], 10), L('e_1', [-20, 3], [20, 3])];
    const both = call(k, 'extrude_regions', { plane: TOP, curves: cl, regions: keysOf(regions(cl)), extent: { kind: 'blind', d: 5 } });
    expect(both).toMatchObject({ valid: true, faces: 4 });
    expect(Object.keys(both.history.sides).sort()).toEqual(['c_1[x:c_1|e_1#0>x:c_1|e_1#1]', 'c_1[x:c_1|e_1#1>x:c_1|e_1#0]']);
    expect(rel(volume(k, both.id), Math.PI * 100 * 5)).toBeLessThan(1e-12);
  });

  it('refuses a key that is not there', () => {
    expect(tryCall(k, 'extrude_regions', { plane: TOP, curves: rect(10, 10), regions: ['+e_9[]'], extent: { kind: 'blind', d: 1 } })).toMatchObject({ ok: false, kind: 'input', error: 'region not found: +e_9[]' });
    expect(tryCall(k, 'extrude_regions', { plane: TOP, curves: rect(10, 10), regions: [], extent: { kind: 'blind', d: 1 } })).toMatchObject({ ok: false, kind: 'input' });
  });
});

describe("Daniel's flows at the kernel level (plan §5.2 item 10, §5.3)", () => {
  it('a circle d 10 on the top face of a 40 x 40 x 20 box, cut 20 mm flipped into it: 32,000 - 500 pi', () => {
    const box = call(k, 'box', { dx: 40, dy: 40, dz: 20 });
    const top = { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const hole = call(k, 'extrude_regions', { plane: top, curves: [C('c_1', [20, 20], 5, 'pt_c')], regions: ['+c_1[]'], extent: { kind: 'blind', d: 20 }, flip: true });
    const cut = call(k, 'combine', { op: 'cut', targets: [box.id], tools: [hole.id] }).results[0];
    expect(cut.valid).toBe(true);
    expect(rel(volume(k, cut.id), 32000 - Math.PI * 25 * 20)).toBeLessThan(1e-12);
  });

  it('rectangle + circle plate 10 mm = (6000 - 100 pi) 10; a d 10 hole cut 10 mm from its top = - 250 pi', () => {
    const curves = [...rect(100, 60, -50, -30), C('c_1', [0, 0], 10, 'pt_c')];
    const plate = keysOf(regions(curves)).find((key) => key.includes(' / '))!;
    expect(plate).toBe('+e_1[p:pt_1>p:pt_2] +e_2[p:pt_2>p:pt_3] +e_3[p:pt_3>p:pt_4] +e_4[p:pt_4>p:pt_1] / -c_1[]');
    const e = call(k, 'extrude_regions', { plane: TOP, curves, regions: [plate], extent: { kind: 'blind', d: 10 } });
    expect(rel(volume(k, e.id), (6000 - 100 * Math.PI) * 10)).toBeLessThan(1e-12);
    const top = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const tool = call(k, 'extrude_regions', { plane: top, curves: [C('c_2', [30, 0], 5)], regions: ['+c_2[]'], extent: { kind: 'blind', d: 10 }, flip: true });
    const cut = call(k, 'combine', { op: 'cut', targets: [e.id], tools: [tool.id] }).results[0];
    expect(cut.valid).toBe(true);
    expect(rel(volume(k, cut.id), (6000 - 100 * Math.PI) * 10 - 250 * Math.PI)).toBeLessThan(1e-12);
  });

  it('Vortex bin by extrude: a circle d 12 in on Top extruded 20 in down = pi 6^2 20 in³', () => {
    const inch = 25.4;
    const e = call(k, 'extrude_regions', { plane: TOP, curves: [C('c_1', [0, 0], 6 * inch, 'pt_c')], regions: ['+c_1[]'], extent: { kind: 'blind', d: 20 * inch }, flip: true });
    expect(e.valid).toBe(true);
    expect(rel(volume(k, e.id), Math.PI * 36 * 20 * inch ** 3)).toBeLessThan(1e-12);
    expect(Math.round(volume(k, e.id) * 10) / 10).toBe(37066665.5);
  });
});
