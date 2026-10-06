// @vitest-environment node
// Kernel API 5 (P4b): B-spline sketch curves in regions and profile ops (SKETCH's R1),
// copies under rigid transforms and mirrors (patterns), and the sketch's links to the
// model: project, section and silhouette, in the plane's own coordinates. Volumes and
// areas are checked against analytic values; the inputs never change.
// Owner: KERNEL (P4b PATTERN).
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, loadKernel, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
/** u -> +X, v -> +Z (normal -Y). */
const FRONT = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
type Curve = R;
const L = (id: string, a: number[], b: number[], pa?: string, pb?: string): Curve => ({ id, kind: 'line', a, b, ...(pa ? { pa } : {}), ...(pb ? { pb } : {}) });
const rect = (w: number, h: number, x0 = 0, y0 = 0, p = ''): Curve[] => [
  L(`${p}e_1`, [x0, y0], [x0 + w, y0], `${p}pt_1`, `${p}pt_2`),
  L(`${p}e_2`, [x0 + w, y0], [x0 + w, y0 + h], `${p}pt_2`, `${p}pt_3`),
  L(`${p}e_3`, [x0 + w, y0 + h], [x0, y0 + h], `${p}pt_3`, `${p}pt_4`),
  L(`${p}e_4`, [x0, y0 + h], [x0, y0], `${p}pt_4`, `${p}pt_1`),
];
const release = (...ids: number[]) => call(k, 'release', { ids });
const regions = (curves: Curve[], plane: R = TOP): R => call(k, 'sketch_regions', { plane, curves, tess: false });

/** SKETCH's R1 example: an open cubic Bezier (one span) from (40,0) over to (0,0). */
const BEZ: Curve = { id: 'e_s1', kind: 'bspline', degree: 3, poles: [[40, 0], [40, 30], [0, 30], [0, 0]], knots: [0, 1], mults: [4, 4], pa: 'pt_a', pb: 'pt_b' };
/** Closed: poles[0] == poles[last], pa == pb. */
const CLOSED: Curve = { id: 'e_s2', kind: 'bspline', degree: 3, poles: [[0, 0], [10, -5], [20, 0], [20, 10], [10, 15], [0, 10], [0, 0]], knots: [0, 0.25, 0.5, 0.75, 1], mults: [4, 1, 1, 1, 4], pa: 'pt_0', pb: 'pt_0' };

/** A w x d x h block from a sketch on Top (corner at x0, y0), as Extrude makes it. */
function block(w: number, d: number, h: number, x0 = 0, y0 = 0): number {
  const curves = rect(w, d, x0, y0);
  const key = regions(curves).regions[0].key;
  return call(k, 'extrude_regions', { plane: TOP, curves, regions: [key], extent: { kind: 'blind', d: h } }).id;
}

describe('B-spline sketch curves (R1)', () => {
  const profile = [L('e_l', [0, 0], [40, 0], 'pt_b', 'pt_a'), BEZ];

  it('a line and a Bezier close one region of 720 mm2 (Green); its extrude is 7200 mm3 with each side named by its token', () => {
    const r = regions(profile);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].area).toBeCloseTo(720, 6);
    expect(r.regions[0].entities).toEqual(['e_l', 'e_s1']);
    expect(r.regions[0].key).toContain('e_s1[p:pt_a>p:pt_b]');
    expect(r.regions[0].bbox[3]).toBeGreaterThan(22.4); // the curve's top (22.5) is inside the box, not just its ends
    const x = call(k, 'extrude_regions', { plane: TOP, curves: profile, regions: [r.regions[0].key], extent: { kind: 'blind', d: 10 } });
    expect(x.valid).toBe(true);
    expect(rel(volume(k, x.id), 7200)).toBeLessThan(1e-7);
    expect(Object.keys(x.history.sides).sort()).toEqual(['e_l[p:pt_b>p:pt_a]', 'e_s1[p:pt_a>p:pt_b]']);
    release(x.id);
  });

  it('a dragged pole keeps the key (names survive an edit)', () => {
    const moved = { ...BEZ, poles: [[40, 0], [45, 35], [-5, 35], [0, 0]] };
    expect(regions([profile[0], moved]).regions[0].key).toBe(regions(profile).regions[0].key);
  });

  it('a closed spline alone is one region with one named vertex; revolve and sweep take splines', () => {
    const r = regions([CLOSED]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].key).toBe('+e_s2[p:pt_0>p:pt_0]');
    expect(r.regions[0].area).toBeGreaterThan(150);
    // Revolved a quarter turn about a line beside it: valid, a solid.
    const shifted = { ...CLOSED, poles: CLOSED.poles.map((p: number[]) => [p[0] + 30, p[1] + 10]) };
    const key = regions([shifted], FRONT).regions[0].key;
    const rv = call(k, 'revolve_regions', { plane: FRONT, curves: [shifted], regions: [key], axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, extent: { kind: 'one', angle: 90 } });
    expect(rv.valid).toBe(true);
    expect(volume(k, rv.id)).toBeGreaterThan(0);
    release(rv.id);
    // A rectangle swept along an open spline path.
    const sq = rect(4, 4, -2, -2, 's');
    const path = { plane: FRONT, curves: [{ id: 'p_1', kind: 'bspline', degree: 3, poles: [[0, 0], [0, 20], [20, 40], [40, 40]], knots: [0, 1], mults: [4, 4] }] };
    const sw = call(k, 'sweep_regions', { plane: TOP, curves: sq, regions: [regions(sq).regions[0].key], path });
    expect(sw.valid).toBe(true);
    expect(volume(k, sw.id)).toBeGreaterThan(16 * 40);
    release(sw.id);
  });

  it('a line across a spline splits it at two crossings numbered along the spline', () => {
    const r = regions([...profile, L('e_x', [-5, 10], [45, 10])]);
    expect(r.regions).toHaveLength(2);
    const all = r.regions.map((g: R) => g.key).join(' ');
    expect(all).toContain('x:e_s1|e_x#0');
    expect(all).toContain('x:e_s1|e_x#1');
    expect(r.regions.reduce((s: number, g: R) => s + g.area, 0)).toBeCloseTo(720, 5);
  });

  it('bad knots, mults or poles are refused in words', () => {
    const bad = (patch: R) => tryCall(k, 'sketch_regions', { plane: TOP, curves: [{ ...BEZ, ...patch }] });
    expect(bad({ mults: [4, 3] }).error).toMatch(/^bspline e_s1: the multiplicities must add up/);
    expect(bad({ knots: [1, 0] }).error).toMatch(/^bspline e_s1: the knots must increase/);
    expect(bad({ degree: 9 }).error).toMatch(/^bspline e_s1: the degree must be/);
    expect(bad({ poles: [[0, 0], [1, 1]] }).error).toMatch(/^bspline e_s1: a degree 3 spline needs at least 4 poles/);
    expect(bad({ poles: [[0, 0], [0, 0], [0, 0], [0, 0]] }).error).toMatch(/^bspline e_s1: the curve is shorter than the tolerance/);
    expect(bad({}).kind).toBeUndefined();
  });

  it('R5: a closed spline extruded together with another region keeps its exact volume; its region area is exact (Green)', () => {
    const closed = { id: 'e_a', kind: 'bspline', degree: 3, poles: [[36.666666666666664, 3.333333333333333], [40, 6.666666666666673], [40, 19.999999999999996], [20.000000000000004, 20], [19.999999999999996, 1.96e-15], [33.33333333333333, -2.42e-15], [36.666666666666664, 3.333333333333333]], knots: [0, 0.25, 0.5, 0.75, 1], mults: [4, 1, 1, 1, 4], pa: 'p0', pb: 'p0' };
    const box = [L('e_l0', [-40, 0], [-10, 0]), L('e_l1', [-10, 0], [-10, 20]), L('e_l2', [-10, 20], [-40, 20]), L('e_l3', [-40, 20], [-40, 0])];
    // Green's theorem with Gauss-Legendre over each knot span (in the test's own Python check): 271.1111...
    const exact = 271.1111111111111;
    const r = regions([closed, ...box]);
    expect(r.regions.map((g: R) => g.area).sort((a: number, b: number) => a - b)).toEqual([expect.closeTo(exact, 9), expect.closeTo(600, 9)]);
    const x = call(k, 'extrude_regions', { plane: TOP, curves: [closed, ...box], regions: r.regions.map((g: R) => g.key), extent: { kind: 'blind', d: 10 } });
    expect(x.solids).toBe(2);
    const p = call(k, 'props', { id: x.id, volume: true, bbox: 'none' });
    expect(p.integration).toBe('spans');
    expect(rel(p.volume, 10 * exact + 6000)).toBeLessThan(1e-10);
    const alone = call(k, 'extrude_regions', { plane: TOP, curves: [closed], regions: [regions([closed]).regions[0].key], extent: { kind: 'blind', d: 10 } });
    expect(rel(volume(k, alone.id), 10 * exact)).toBeLessThan(1e-10);
    // A part without sketch splines keeps the default integration (the native reference values).
    const b = block(10, 10, 10);
    expect(call(k, 'props', { id: b, volume: true, bbox: 'none' }).integration).toBeUndefined();
    release(x.id, alone.id, b);
  });

  it('a rational spline (weights) is a circle arc exactly', () => {
    const w = Math.SQRT1_2;
    // A quarter circle of radius 10 from (10,0) to (0,10), closed by two lines through the origin.
    const q = { id: 'e_q', kind: 'bspline', degree: 2, poles: [[10, 0], [10, 10], [0, 10]], knots: [0, 1], mults: [3, 3], weights: [1, w, 1] };
    const r = regions([q, L('e_a', [0, 10], [0, 0]), L('e_b', [0, 0], [10, 0])]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].area).toBeCloseTo((Math.PI * 100) / 4, 6);
  });
});

describe('copies (patterns)', () => {
  it('translated copies keep the volume, the face numbering and the source', () => {
    const b = block(10, 10, 10);
    const r = call(k, 'copies', {
      id: b,
      transforms: [
        { matrix: [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0] },
        { matrix: [1, 0, 0, 40, 0, 1, 0, 0, 0, 0, 1, 0] },
      ],
    });
    expect(r.ids).toHaveLength(2);
    expect(r.all_valid).toBe(true);
    expect(r.maps).toEqual([null, null]);
    expect(r.faces).toEqual([6, 6]);
    for (const id of r.ids) expect(rel(volume(k, id), 1000)).toBeLessThan(1e-9);
    const bb = call(k, 'props', { id: r.ids[1], bbox: 'exact' }).bbox;
    expect(bb[0]).toBeCloseTo(40, 6);
    expect(bb[3]).toBeCloseTo(50, 6);
    expect(call(k, 'props', { id: b, bbox: 'exact' }).bbox[0]).toBeCloseTo(0, 9);
    release(b, ...r.ids);
  });

  it('a mirrored copy is a valid solid of the same volume, reflected; a rotation turns it', () => {
    const b = block(10, 4, 2, 5, 0);
    const r = call(k, 'copies', {
      id: b,
      transforms: [
        { matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }, // mirror in the YZ plane
        { matrix: [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] }, // 90 deg about Z
      ],
    });
    expect(r.all_valid).toBe(true);
    expect(rel(volume(k, r.ids[0]), 80)).toBeLessThan(1e-9);
    const m = call(k, 'props', { id: r.ids[0], bbox: 'exact' }).bbox;
    expect([m[0], m[3]].map((x: number) => Math.round(x * 1e6) / 1e6)).toEqual([-15, -5]);
    const t = call(k, 'props', { id: r.ids[1], bbox: 'exact' }).bbox;
    expect([t[0], t[1], t[3], t[4]].map((x: number) => Math.round(x * 1e6) / 1e6)).toEqual([-4, 5, 0, 15]);
    // Every face of the source has a place in the copy.
    for (const map of r.maps) if (map) expect([...map].sort((a: number, b2: number) => a - b2)).toEqual([0, 1, 2, 3, 4, 5]);
    release(b, ...r.ids);
  });

  it('a scaled matrix is refused', () => {
    const b = block(1, 1, 1);
    expect(tryCall(k, 'copies', { id: b, transforms: [{ matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0] }] }).error).toMatch(/rotation or a mirror/);
    release(b);
  });
});

describe('project, section, silhouette (SELECT)', () => {
  it('project: a line along the normal is a point, a circle in a parallel plane a circle, seen edge-on a line; a face its outer edges', () => {
    const cyl = call(k, 'cylinder', { r: 5, h: 10, origin: [20, 0, 0] }).id;
    const topo = call(k, 'topo', { id: cyl, faces: 'all', edges: 'all', vertices: 'none' });
    const circ = topo.edges.find((e: R) => e.type === 'circle' && e.mid[2] > 9).i;
    const seam = topo.edges.find((e: R) => e.type === 'line').i;
    const r = call(k, 'project', {
      plane: TOP,
      items: [
        { id: cyl, edge: circ },
        { id: cyl, edge: seam },
      ],
    });
    expect(r.items[0].curves).toHaveLength(1);
    expect(r.items[0].curves[0].kind).toBe('circle');
    expect(r.items[0].curves[0].c[0]).toBeCloseTo(20, 6);
    expect(r.items[0].curves[0].r).toBeCloseTo(5, 6);
    expect(r.items[0].curves[0].src).toEqual({ edge: circ });
    expect(r.items[1].curves[0].kind).toBe('point');
    const side = call(k, 'project', { plane: FRONT, items: [{ id: cyl, edge: circ }] });
    const ln = side.items[0].curves[0];
    expect(ln.kind).toBe('line');
    expect(Math.min(ln.a[0], ln.b[0])).toBeCloseTo(15, 5);
    expect(Math.max(ln.a[0], ln.b[0])).toBeCloseTo(25, 5);
    expect(ln.a[1]).toBeCloseTo(10, 6);
    // A face of a block: its 4 edges, head to tail.
    const b = block(10, 6, 3);
    const bt = call(k, 'topo', { id: b, faces: 'all', edges: 'none', vertices: 'none' });
    const top = bt.faces.find((f: R) => f.normal && f.normal[2] > 0.5).i;
    const f = call(k, 'project', { plane: TOP, items: [{ id: b, face: top }] }).items[0].curves;
    expect(f.map((c: R) => c.kind)).toEqual(['line', 'line', 'line', 'line']);
    for (let i = 0; i < 4; i++) {
      const next = f[(i + 1) % 4];
      expect(Math.hypot(f[i].b[0] - next.a[0], f[i].b[1] - next.a[1])).toBeLessThan(1e-9);
    }
    // A tilted plane: a circle comes out as a rational B-spline (an ellipse).
    const tilt = { origin: [0, 0, 0], normal: [0, -Math.SQRT1_2, Math.SQRT1_2], xdir: [1, 0, 0] };
    const el = call(k, 'project', { plane: tilt, items: [{ id: cyl, edge: circ }] }).items[0].curves[0];
    expect(el.kind).toBe('bspline');
    expect(el.weights).toBeTruthy();
    // cubic: true (the sketch's splines have no weights): a non-rational cubic within the tolerance.
    const cu = call(k, 'project', { plane: tilt, items: [{ id: cyl, edge: circ }], cubic: true }).items[0].curves[0];
    expect(cu.kind).toBe('bspline');
    expect(cu.weights).toBeUndefined();
    expect(cu.degree).toBe(3);
    // Its poles span the ellipse: u from 15 to 25, v about 0.7071 * (+-5) around 0.7071 * 10 (z = 10, y = 0).
    const us = cu.poles.map((p: number[]) => p[0]);
    expect(Math.min(...us)).toBeLessThan(15.01);
    expect(Math.max(...us)).toBeGreaterThan(24.99);
    release(cyl, b);
  });

  it('section: a block cut at mid height is one closed loop of 4 lines, each with its face; a miss is empty', () => {
    const b = block(10, 6, 4);
    const mid = { origin: [0, 0, 2], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const r = call(k, 'section', { plane: mid, ids: [b] });
    expect(r.bodies[0].loops).toHaveLength(1);
    const lp = r.bodies[0].loops[0];
    expect(lp.closed).toBe(true);
    expect(lp.curves.map((c: R) => c.kind)).toEqual(['line', 'line', 'line', 'line']);
    const len = lp.curves.reduce((s: number, c: R) => s + Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]), 0);
    expect(len).toBeCloseTo(32, 6);
    for (const c of lp.curves) expect(typeof c.src.face).toBe('number');
    const miss = call(k, 'section', { plane: { ...mid, origin: [0, 0, 50] }, ids: [b] });
    expect(miss.bodies[0].loops).toEqual([]);
    // A cylinder cut through its axis: a closed rectangle; across: a circle.
    const cyl = call(k, 'cylinder', { r: 5, h: 10 }).id;
    const across = call(k, 'section', { plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] }, ids: [cyl] });
    expect(across.bodies[0].loops[0].curves.map((c: R) => c.kind)).toEqual(['circle']);
    release(b, cyl);
  });

  it('silhouette: a block from above is its outline; a plate with a through hole has an outer loop and a hole; a cylinder from the side a rectangle', () => {
    const b = block(10, 6, 4, 3, 2);
    const s = call(k, 'silhouette', { plane: TOP, ids: [b] });
    expect(s.empty).toBe(false);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].hole).toBe(false);
    const pts = s.loops[0].curves.flatMap((c: R) => [c.a, c.b]);
    const us = pts.map((p: number[]) => p[0]);
    const vs = pts.map((p: number[]) => p[1]);
    expect(Math.min(...us)).toBeCloseTo(3, 5);
    expect(Math.max(...us)).toBeCloseTo(13, 5);
    expect(Math.min(...vs)).toBeCloseTo(2, 5);
    expect(Math.max(...vs)).toBeCloseTo(8, 5);
    // A plate with a hole through it, from above.
    const plate = block(40, 40, 5);
    const hole = call(k, 'cylinder', { r: 5, h: 20, origin: [20, 20, -5] }).id;
    const cut = call(k, 'boolean', { op: 'cut', targets: [plate], tools: [hole] }).id;
    const hs = call(k, 'silhouette', { plane: TOP, ids: [cut] });
    expect(hs.loops.filter((l: R) => !l.hole)).toHaveLength(1);
    const holes = hs.loops.filter((l: R) => l.hole);
    expect(holes).toHaveLength(1);
    expect(holes[0].curves.every((c: R) => c.kind === 'circle' || c.kind === 'arc' || c.kind === 'bspline')).toBe(true);
    // A cylinder lying along X, seen from above: a 20 x 10 rectangle.
    const cx = call(k, 'cylinder', { r: 5, h: 20, origin: [0, 0, 0], axis: [1, 0, 0] }).id;
    const cs = call(k, 'silhouette', { plane: TOP, ids: [cx] });
    expect(cs.loops).toHaveLength(1);
    expect(cs.loops[0].curves.map((c: R) => c.kind)).toEqual(['line', 'line', 'line', 'line']); // the seam splits are merged
    const cp = cs.loops[0].curves.flatMap((c: R) => (c.a ? [c.a, c.b] : []));
    expect(Math.min(...cp.map((p: number[]) => p[1]))).toBeCloseTo(-5, 4);
    expect(Math.max(...cp.map((p: number[]) => p[1]))).toBeCloseTo(5, 4);
    expect(Math.max(...cp.map((p: number[]) => p[0]))).toBeCloseTo(20, 4);
    release(b, plate, hole, cut, cx);
  });

  it('silhouette of two overlapping blocks is one L-shaped outline of 6 lines; above nothing it is empty', () => {
    const a = block(20, 10, 5);
    const b = block(10, 20, 8, 0, 0);
    const s = call(k, 'silhouette', { plane: TOP, ids: [a, b] });
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].curves).toHaveLength(6);
    const len = s.loops[0].curves.reduce((t: number, c: R) => t + Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]), 0);
    expect(len).toBeCloseTo(80, 6);
    release(a, b);
  });

  it('silhouette on a plane that is not at the origin: coordinates are the plane frame', () => {
    const b = block(10, 6, 4);
    const plane = { origin: [100, 50, 7], normal: [0, 0, 1], xdir: [0, 1, 0] };
    const s = call(k, 'silhouette', { plane, ids: [b] });
    const pts = s.loops[0].curves.flatMap((c: R) => [c.a, c.b]);
    // u along +Y from y = 50: y 0..6 -> u -50..-44; v along normal x xdir = -X from x = 100: x 0..10 -> v 90..100.
    expect(Math.min(...pts.map((p: number[]) => p[0]))).toBeCloseTo(-50, 5);
    expect(Math.max(...pts.map((p: number[]) => p[0]))).toBeCloseTo(-44, 5);
    expect(Math.min(...pts.map((p: number[]) => p[1]))).toBeCloseTo(90, 5);
    expect(Math.max(...pts.map((p: number[]) => p[1]))).toBeCloseTo(100, 5);
    release(b);
  });
});
