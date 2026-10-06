// @vitest-environment node
// Kernel API 4 (P4a solids): revolve_regions, sweep_regions, loft_regions, extrude_face,
// the extents to_vertex / to_point, fillet contours and diagnosis, chamfer with two
// distances, shell outside, edge_eval and topo's edge_ends / vertex_faces. Volumes are
// checked against analytic values; every result reports `valid`, and the inputs never
// change (work copies).
// Owner: KERNEL (P4a SOLIDS).
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, fingerprint, loadKernel, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
/** u -> +X, v -> +Z (normal -Y). */
const FRONT = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
type Curve = R;
const L = (id: string, a: number[], b: number[], pa?: string, pb?: string): Curve => ({ id, kind: 'line', a, b, ...(pa ? { pa } : {}), ...(pb ? { pb } : {}) });
const C = (id: string, c: number[], r: number, pc?: string): Curve => ({ id, kind: 'circle', c, r, ...(pc ? { pc } : {}) });
const A = (id: string, c: number[], r: number, a0: number, a1: number, ccw = true): Curve => ({ id, kind: 'arc', c, r, a0, a1, ccw });
/** A w x h rectangle from (x0, y0): e_1..e_4 through pt_1..pt_4 (ids prefixed). */
const rect = (w: number, h: number, x0 = 0, y0 = 0, p = ''): Curve[] => [
  L(`${p}e_1`, [x0, y0], [x0 + w, y0], `${p}pt_1`, `${p}pt_2`),
  L(`${p}e_2`, [x0 + w, y0], [x0 + w, y0 + h], `${p}pt_2`, `${p}pt_3`),
  L(`${p}e_3`, [x0 + w, y0 + h], [x0, y0 + h], `${p}pt_3`, `${p}pt_4`),
  L(`${p}e_4`, [x0, y0 + h], [x0, y0], `${p}pt_4`, `${p}pt_1`),
];
/** The one region of a sketch (its key). */
function onlyKey(curves: Curve[], plane: R): string {
  const r = call(k, 'sketch_regions', { plane, curves, tess: false });
  expect(r.regions).toHaveLength(1);
  return r.regions[0].key;
}
const props = (id: number): R => call(k, 'props', { id, volume: true, bbox: 'exact' });
const release = (...ids: number[]) => call(k, 'release', { ids });

/** A w x d x h block from a sketch on Top (corner at the origin), as Extrude makes it. */
function block(w: number, d: number, h: number): number {
  const curves = rect(w, d);
  return call(k, 'extrude_regions', { plane: TOP, curves, regions: [onlyKey(curves, TOP)], extent: { kind: 'blind', d: h } }).id;
}

describe('revolve_regions (API 4)', () => {
  const ring = rect(10, 30, 10, 0); // x 10..20, z 0..30 on Front
  const zAxis = { origin: [0, 0, 0], dir: [0, 0, 1] };

  it('a full turn of a rectangle beside the Z axis is a tube: pi (R^2 - r^2) h, no caps, one side per segment', () => {
    const r = call(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [onlyKey(ring, FRONT)], axis: zAxis, extent: { kind: 'one', angle: 360 } });
    expect(r.valid).toBe(true);
    expect(r.full).toBe(true);
    expect(rel(volume(k, r.id), Math.PI * (400 - 100) * 30)).toBeLessThan(1e-6);
    expect(r.history.start).toBeNull();
    expect(r.history.end).toBeNull();
    expect(Object.keys(r.history.sides).sort()).toHaveLength(4);
    expect(r.faces).toBe(4);
    release(r.id);
  });

  it('one side, symmetric and two sides turn the angles asked for; caps are named', () => {
    const key = onlyKey(ring, FRONT);
    const full = Math.PI * 300 * 30;
    const one = call(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [key], axis: zAxis, extent: { kind: 'one', angle: 90 } });
    expect(one.valid).toBe(true);
    expect(rel(volume(k, one.id), full / 4)).toBeLessThan(1e-6);
    expect(one.history.start).not.toBeNull();
    expect(one.history.end).not.toBeNull();
    expect([one.from_deg, one.to_deg]).toEqual([0, 90]);
    // Turning about +Z from +X (the sketch) goes towards +Y: the quarter lies in x >= 0, y >= 0.
    const b1 = props(one.id).bbox;
    expect(b1[1]).toBeGreaterThan(-1e-6);
    const sym = call(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [key], axis: zAxis, extent: { kind: 'symmetric', angle: 90 } });
    expect(rel(volume(k, sym.id), full / 4)).toBeLessThan(1e-6);
    const bs = props(sym.id).bbox;
    expect(Math.abs(bs[1] + bs[4])).toBeLessThan(1e-6); // symmetric about the sketch plane
    const two = call(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [key], axis: zAxis, extent: { kind: 'two', angle: 30, angle2: 60 } });
    expect(rel(volume(k, two.id), full / 4)).toBeLessThan(1e-6);
    expect([two.from_deg, two.to_deg]).toEqual([-60, 30]);
    const flip = call(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [key], axis: zAxis, extent: { kind: 'one', angle: 90 }, flip: true });
    expect(props(flip.id).bbox[4]).toBeLessThan(1e-6); // the other way: y <= 0
    release(one.id, sym.id, two.id, flip.id);
  });

  it('a segment on the axis sweeps no face (on_axis); a cylinder of pi r^2 h', () => {
    const solid = rect(10, 30, 0, 0);
    const r = call(k, 'revolve_regions', { plane: FRONT, curves: solid, regions: [onlyKey(solid, FRONT)], axis: zAxis, extent: { kind: 'one', angle: 360 } });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), Math.PI * 100 * 30)).toBeLessThan(1e-6);
    expect(r.history.on_axis).toEqual(['e_4[p:pt_4>p:pt_1]']);
    release(r.id);
  });

  it('refuses a profile across the axis, an axis normal to the sketch, and angles past 360', () => {
    const across = rect(20, 30, -10, 0);
    const key = onlyKey(across, FRONT);
    const e1 = tryCall(k, 'revolve_regions', { plane: FRONT, curves: across, regions: [key], axis: zAxis, extent: { kind: 'one', angle: 90 } });
    expect(e1).toMatchObject({ ok: false, kind: 'input' });
    expect(e1.error).toMatch(/crosses the axis/);
    const e2 = tryCall(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [onlyKey(ring, FRONT)], axis: { origin: [0, 0, 0], dir: [0, 1, 0] }, extent: { kind: 'one', angle: 90 } });
    expect(e2.error).toMatch(/perpendicular to the sketch plane/);
    const e3 = tryCall(k, 'revolve_regions', { plane: FRONT, curves: ring, regions: [onlyKey(ring, FRONT)], axis: zAxis, extent: { kind: 'two', angle: 200, angle2: 200 } });
    expect(e3.error).toMatch(/more than 360/);
  });

  it('an axis beside the plane (not in it) still revolves (a valid solid)', () => {
    const r = call(k, 'revolve_regions', { plane: TOP, curves: rect(10, 10, 20, 0), regions: [onlyKey(rect(10, 10, 20, 0), TOP)], axis: { origin: [0, 0, -5], dir: [0, 1, 0] }, extent: { kind: 'one', angle: 90 } });
    expect(r.valid).toBe(true);
    expect(volume(k, r.id)).toBeGreaterThan(0);
    release(r.id);
  });
});

describe('sweep_regions (API 4)', () => {
  const disc = [C('c_1', [0, 0], 5, 'pt_c')];

  it('a circle along a straight line is a cylinder; sides by token@path curve, caps start/end', () => {
    const path = { plane: FRONT, curves: [L('p_1', [0, 0], [0, 50])] };
    const r = call(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], path });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), Math.PI * 25 * 50)).toBeLessThan(1e-6);
    expect(Object.keys(r.history.sides)).toEqual(['c_1[]@p_1']);
    expect(r.history.start).not.toBeNull();
    expect(r.history.end).not.toBeNull();
    release(r.id);
  });

  it('a circle along a line, a quarter arc and a line: pi r^2 times the path length (Pappus)', () => {
    // On Front (u = x, v = z): up 50, a quarter turn of radius 20 towards +x, then 30 along +x.
    const curves = [L('p_1', [0, 0], [0, 50]), A('p_2', [20, 50], 20, 180, 90, false), L('p_3', [20, 70], [50, 70])];
    const r = call(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], path: { plane: FRONT, curves } });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), Math.PI * 25 * (50 + 10 * Math.PI + 30))).toBeLessThan(1e-4);
    expect(Object.keys(r.history.sides).sort()).toEqual(['c_1[]@p_1', 'c_1[]@p_2', 'c_1[]@p_3']);
    release(r.id);
  });

  it('the path curves may come in any order; a branching path or a gap is refused with the reason', () => {
    const curves = [L('p_3', [20, 70], [50, 70]), L('p_1', [0, 0], [0, 50]), A('p_2', [20, 50], 20, 180, 90, false)];
    const r = call(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], path: { plane: FRONT, curves } });
    expect(r.valid).toBe(true);
    release(r.id);
    const gap = tryCall(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], path: { plane: FRONT, curves: [L('p_1', [0, 0], [0, 50]), L('p_2', [0, 60], [0, 80])] } });
    expect(gap.error).toMatch(/gap/);
    const branch = tryCall(k, 'sweep_regions', {
      plane: TOP,
      curves: disc,
      regions: [onlyKey(disc, TOP)],
      path: { plane: FRONT, curves: [L('p_1', [0, 0], [0, 50]), L('p_2', [0, 50], [10, 60]), L('p_3', [0, 50], [-10, 60])] },
    });
    expect(branch.error).toMatch(/branches/);
    const none = tryCall(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], path: { plane: FRONT, curves: [] } });
    expect(none.error).toMatch(/no curves/);
  });

  it('Keep orientation (fixed) moves the profile without turning it: pi r^2 times the rise (native OCP: 5497.787 mm3, z to 70), unlike Follow path', () => {
    // P4a review: GeomFill_IsFixed in MakePipe behaved as Frenet. Native OCP 7.9.3 MakePipeShell
    // with a fixed trihedron: 5497.787143782017 mm3, box x -5..55, z 0..70 (Follow: 8750.586, z to 75).
    const curves = [L('p_1', [0, 0], [0, 50]), A('p_2', [20, 50], 20, 180, 90, false), L('p_3', [20, 70], [50, 70])];
    const key = onlyKey(disc, TOP);
    const fixed = call(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [key], path: { plane: FRONT, curves }, orientation: 'fixed' });
    expect(fixed.valid).toBe(true);
    expect(rel(volume(k, fixed.id), Math.PI * 25 * 70)).toBeLessThan(1e-6);
    const bf = props(fixed.id).bbox;
    expect(bf[5]).toBeCloseTo(70, 6);
    expect(bf[3]).toBeCloseTo(55, 6);
    // Every side face is named by its path curve, and both caps exist.
    expect(Object.keys(fixed.history.sides).sort()).toEqual(['c_1[]@p_1', 'c_1[]@p_2', 'c_1[]@p_3']);
    expect(new Set(Object.values(fixed.history.sides)).size).toBe(3);
    expect(fixed.history.start).not.toBeNull();
    expect(fixed.history.end).not.toBeNull();
    const follow = call(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [key], path: { plane: FRONT, curves }, orientation: 'follow' });
    expect(props(follow.id).bbox[5]).toBeCloseTo(75, 6);
    // A profile with a hole keeps its hole.
    const ring = [C('c_1', [0, 0], 5, 'pt_c'), C('c_2', [0, 0], 2, 'pt_c')];
    const rr = call(k, 'sketch_regions', { plane: TOP, curves: ring, tess: false });
    const annulus = rr.regions.find((x: R) => Math.abs(x.area - Math.PI * 21) < 1e-6).key;
    // (Along a path that rises all the way: a stretch in the profile's own plane sweeps no volume.)
    const rising = [L('p_1', [0, 0], [0, 30]), L('p_2', [0, 30], [20, 50])];
    const holed = call(k, 'sweep_regions', { plane: TOP, curves: ring, regions: [annulus], path: { plane: FRONT, curves: rising }, orientation: 'fixed' });
    expect(holed.reason ?? 'valid').toBe('valid');
    expect(rel(volume(k, holed.id), Math.PI * 21 * 50)).toBeLessThan(1e-6);
    expect(Object.keys(holed.history.sides).sort()).toEqual(['c_1[]@p_1', 'c_1[]@p_2', 'c_2[]@p_1', 'c_2[]@p_2']);
    expect(tryCall(k, 'sweep_regions', { plane: TOP, curves: disc, regions: [key], path: { plane: FRONT, curves }, orientation: 'sideways' }).error).toMatch(/follow or fixed/);
    release(fixed.id, follow.id, holed.id);
  });

  it('a square around a closed circular path is a torus-like ring: no caps', () => {
    // Profile: a 4 x 4 square on Front centred at x = 30, swept about the Top circle r = 30.
    const sq = rect(4, 4, 28, -2);
    const r = call(k, 'sweep_regions', { plane: FRONT, curves: sq, regions: [onlyKey(sq, FRONT)], path: { plane: TOP, curves: [C('p_1', [0, 0], 30)] } });
    expect(r.closed_path).toBe(true);
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), 16 * 2 * Math.PI * 30)).toBeLessThan(1e-4);
    expect(r.history.start).toBeNull();
    release(r.id);
  });
});

describe('loft_regions (API 4)', () => {
  it('a 20 mm square to a 10 mm square 30 mm above: the frustum h/3 (A1 + A2 + sqrt(A1 A2))', () => {
    const s0 = rect(20, 20, -10, -10);
    const s1 = rect(10, 10, -5, -5, 'b');
    const up = { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] };
    for (const ruled of [true, false]) {
      const r = call(k, 'loft_regions', {
        ruled,
        sections: [
          { plane: TOP, curves: s0, regions: [onlyKey(s0, TOP)] },
          { plane: up, curves: s1, regions: [onlyKey(s1, up)] },
        ],
      });
      expect(r.valid).toBe(true);
      expect(rel(volume(k, r.id), (30 / 3) * (400 + 100 + 200))).toBeLessThan(1e-6);
      expect(r.history.start).not.toBeNull();
      expect(r.history.end).not.toBeNull();
      expect(Object.keys(r.history.sides)).toHaveLength(4);
      release(r.id);
    }
  });

  it('circle to circle is a cone frustum; a profile with a hole or a single profile is refused', () => {
    const up = { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const c0 = [C('c_1', [0, 0], 10)];
    const c1 = [C('c_2', [0, 0], 5)];
    const r = call(k, 'loft_regions', { sections: [{ plane: TOP, curves: c0, regions: [onlyKey(c0, TOP)] }, { plane: up, curves: c1, regions: [onlyKey(c1, up)] }] });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), (Math.PI * 30 / 3) * (100 + 25 + 50))).toBeLessThan(1e-4);
    release(r.id);
    const ring = [C('c_1', [0, 0], 10), C('c_9', [0, 0], 3)];
    const ringKey = call(k, 'sketch_regions', { plane: TOP, curves: ring, tess: false }).regions.find((g: R) => g.loops.length === 2).key;
    const hole = tryCall(k, 'loft_regions', { sections: [{ plane: TOP, curves: ring, regions: [ringKey] }, { plane: up, curves: c1, regions: [onlyKey(c1, up)] }] });
    expect(hole.error).toMatch(/has a hole/);
    const one = tryCall(k, 'loft_regions', { sections: [{ plane: TOP, curves: c0, regions: [onlyKey(c0, TOP)] }] });
    expect(one.error).toMatch(/at least two/);
  });
});

describe('extrude_face (API 4)', () => {
  it('extrudes a flat face along its outward normal (or into the body), with sides per input edge', () => {
    const b = block(20, 20, 10);
    const before = fingerprint(k, b);
    const t = call(k, 'topo', { id: b, edges: 'none', vertices: 'none' });
    const top = t.faces.find((f: R) => f.type === 'plane' && f.normal[2] > 0.99).i;
    const out = call(k, 'extrude_face', { id: b, face: top, extent: { kind: 'blind', d: 5 } });
    expect(out.valid).toBe(true);
    expect(rel(volume(k, out.id), 20 * 20 * 5)).toBeLessThan(1e-9);
    const bb = props(out.id).bbox;
    expect(bb[2]).toBeCloseTo(10, 6);
    expect(bb[5]).toBeCloseTo(15, 6);
    expect(Object.keys(out.history.sides).every((s) => /^e\d+$/.test(s))).toBe(true);
    expect(Object.keys(out.history.sides)).toHaveLength(4);
    expect(out.history.start).not.toBeNull();
    const into = call(k, 'extrude_face', { id: b, face: top, extent: { kind: 'blind', d: 4 }, flip: true });
    expect(into.valid).toBe(true);
    expect(volume(k, into.id)).toBeCloseTo(1600, 6);
    expect(props(into.id).bbox[2]).toBeCloseTo(6, 6);
    // Through all both ways and up to a point.
    const all = call(k, 'extrude_face', { id: b, face: top, extent: { kind: 'through_all', targets: [b], both: true } });
    expect(props(all.id).bbox[2]).toBeLessThan(0);
    const toPoint = call(k, 'extrude_face', { id: b, face: top, extent: { kind: 'to_point', point: [100, 100, 32] } });
    expect(props(toPoint.id).bbox[5]).toBeCloseTo(32, 6);
    expect(fingerprint(k, b)).toEqual(before); // the body is never changed
    const side = t.faces.find((f: R) => f.type === 'plane' && Math.abs(f.normal[0]) > 0.99).i;
    expect(call(k, 'extrude_face', { id: b, face: side, extent: { kind: 'blind', d: 3 } }).valid).toBe(true);
    release(b, out.id, into.id, all.id, toPoint.id);
  });

  it('refuses a curved face, and a taper', () => {
    const disc = [C('c_1', [0, 0], 5)];
    const cyl = call(k, 'extrude_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], extent: { kind: 'blind', d: 10 } }).id;
    const t = call(k, 'topo', { id: cyl, edges: 'none', vertices: 'none' });
    const curved = t.faces.find((f: R) => f.type === 'cylinder').i;
    expect(tryCall(k, 'extrude_face', { id: cyl, face: curved, extent: { kind: 'blind', d: 5 } }).error).toMatch(/needs a flat face: face \d+ is a cylinder/);
    const flat = t.faces.find((f: R) => f.type === 'plane').i;
    expect(tryCall(k, 'extrude_face', { id: cyl, face: flat, extent: { kind: 'blind', d: 5 }, taper_deg: 5 }).error).toMatch(/taper/);
    release(cyl);
  });
});

describe('extents to_vertex / to_point (API 4)', () => {
  it('up to a vertex ends on the plane through it parallel to the sketch; behind or in the plane is refused', () => {
    const b = block(20, 20, 10);
    const v = call(k, 'topo', { id: b, faces: 'none', edges: 'none' }).vertices.find((x: R) => x.p[2] > 9.99).i;
    const sq = rect(5, 5, 40, 0);
    const key = onlyKey(sq, TOP);
    const r = call(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'to_vertex', target: b, vertex: v } });
    expect(rel(volume(k, r.id), 25 * 10)).toBeLessThan(1e-9);
    expect(r.to).toBeCloseTo(10, 9);
    const off = call(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'to_vertex', target: b, vertex: v, offset: 2 } });
    expect(off.to).toBeCloseTo(12, 9);
    expect(tryCall(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'to_vertex', target: b, vertex: v }, flip: true }).error).toMatch(/behind the profile/);
    const v0 = call(k, 'topo', { id: b, faces: 'none', edges: 'none' }).vertices.find((x: R) => x.p[2] < 0.01).i;
    expect(tryCall(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'to_vertex', target: b, vertex: v0 } }).error).toMatch(/lies in the profile's plane/);
    release(b, r.id, off.id);
  });

  it('through all with fit (New body, Join) ends exactly at the far side of the targets; a profile that misses them is refused', () => {
    // P4a review: New body / Join built a margin of made-up length (1 % of the diagonal + 1 mm).
    const b = block(20, 20, 10);
    const sq = rect(4, 4, 8, 8);
    const plane = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const key = onlyKey(sq, plane);
    const one = call(k, 'extrude_regions', { plane, curves: sq, regions: [key], extent: { kind: 'through_all', targets: [b], fit: true } });
    expect(props(one.id).bbox[5]).toBeCloseTo(10, 9);
    expect(rel(volume(k, one.id), 16 * 5)).toBeLessThan(1e-9);
    const both = call(k, 'extrude_regions', { plane, curves: sq, regions: [key], extent: { kind: 'through_all', targets: [b], both: true, fit: true } });
    expect(props(both.id).bbox[2]).toBeCloseTo(0, 9);
    expect(props(both.id).bbox[5]).toBeCloseTo(10, 9);
    // Above the block (z = 30), Both sides: from the block's bottom up to the profile.
    const above = { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const up = call(k, 'extrude_regions', { plane: above, curves: sq, regions: [onlyKey(sq, above)], extent: { kind: 'through_all', targets: [b], both: true, fit: true } });
    expect(rel(volume(k, up.id), 16 * 30)).toBeLessThan(1e-9);
    // Beside the block: the profile misses it.
    const beside = rect(4, 4, 40, 0);
    const miss = tryCall(k, 'extrude_regions', { plane, curves: beside, regions: [onlyKey(beside, plane)], extent: { kind: 'through_all', targets: [b], both: true, fit: true } });
    expect(miss.error).toMatch(/misses every body/);
    release(b, one.id, both.id, up.id);
  });

  it('through all one side and both sides reach past the targets', () => {
    const b = block(20, 20, 10);
    const sq = rect(4, 4, 8, 8);
    const plane = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const key = onlyKey(sq, plane);
    const one = call(k, 'extrude_regions', { plane, curves: sq, regions: [key], extent: { kind: 'through_all', targets: [b] } });
    expect(props(one.id).bbox[5]).toBeGreaterThan(10);
    expect(props(one.id).bbox[2]).toBeCloseTo(5, 6);
    const both = call(k, 'extrude_regions', { plane, curves: sq, regions: [key], extent: { kind: 'through_all', targets: [b], both: true } });
    expect(props(both.id).bbox[2]).toBeLessThan(0);
    expect(props(both.id).bbox[5]).toBeGreaterThan(10);
    release(b, one.id, both.id);
  });
});

describe('fillet and chamfer (API 4)', () => {
  /** A 40 x 20 slot (rectangle with round ends) extruded 10: its top edges are one tangent chain. */
  function slot(): number {
    const curves = [L('e_1', [0, -10], [20, -10]), A('e_2', [20, 0], 10, -90, 90), L('e_3', [20, 10], [0, 10]), A('e_4', [0, 0], 10, 90, 270)];
    return call(k, 'extrude_regions', { plane: TOP, curves, regions: [onlyKey(curves, TOP)], extent: { kind: 'blind', d: 10 } }).id;
  }

  it('one picked edge of a tangent chain fillets the whole chain (contours)', () => {
    const s = slot();
    const t = call(k, 'topo', { id: s, faces: 'none', vertices: 'none' });
    const topLine = t.edges.find((e: R) => e.type === 'line' && e.mid[2] > 9.99).i;
    const r = call(k, 'fillet', { id: s, edges: [topLine], r: 2 });
    expect(r.valid).toBe(true);
    expect(r.contours).toHaveLength(1);
    expect(r.contours[0]).toHaveLength(4);
    expect(r.contours[0]).toContain(topLine);
    release(s, r.id);
  });

  it('diagnose: a radius too large names the faulty edges and the largest radius that works', () => {
    const b = block(20, 20, 10);
    const t = call(k, 'topo', { id: b, faces: 'none', vertices: 'none' });
    const top = t.edges.filter((e: R) => e.type === 'line' && e.mid[2] > 9.99).map((e: R) => e.i);
    expect(top).toHaveLength(4);
    const big = tryCall(k, 'fillet', { id: b, edges: top, r: 20 });
    const bigValid = big.ok === false ? false : big.valid;
    expect(bigValid).toBe(false);
    if (big.ok !== false) release(big.id);
    const d = call(k, 'fillet', { id: b, edges: top, r: 20, diagnose: true });
    expect(d.done).toBe(false);
    expect(d.max_ok).toBeGreaterThan(0);
    expect(d.max_ok).toBeLessThan(10);
    // The suggestion works.
    const ok = call(k, 'fillet', { id: b, edges: top, r: d.max_ok });
    expect(ok.valid).toBe(true);
    const fine = call(k, 'fillet', { id: b, edges: top, r: 2, diagnose: true });
    expect(fine).toMatchObject({ done: true, max_ok: 2, faulty: [] });
    release(b, ok.id);
  });

  it('chamfer with two distances removes 0.5 d1 d2 L per edge; flip swaps the sides', () => {
    const b = block(20, 20, 20);
    const t = call(k, 'topo', { id: b, faces: 'none', vertices: 'none' });
    const e = t.edges.find((x: R) => x.type === 'line' && x.mid[2] > 19.99).i;
    const r = call(k, 'chamfer', { id: b, edges: [e], d: 2, d2: 4 });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), 8000 - 0.5 * 2 * 4 * 20)).toBeLessThan(1e-9);
    const f = call(k, 'chamfer', { id: b, edges: [e], d: 2, d2: 4, flip: true });
    expect(rel(volume(k, f.id), 8000 - 80)).toBeLessThan(1e-9);
    // The other face got d1: the volume is the same, the centroid is not.
    const [c1, c2] = [props(r.id).centroid, props(f.id).centroid];
    expect(Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2])).toBeGreaterThan(1e-3);
    const sym = call(k, 'chamfer', { id: b, edges: [e], d: 2 });
    expect(rel(volume(k, sym.id), 8000 - 0.5 * 2 * 2 * 20)).toBeLessThan(1e-9);
    expect(sym.contours).toEqual([[e]]);
    expect(tryCall(k, 'chamfer', { id: b, edges: [e], d: 2, d2: 0 }).error).toMatch(/second chamfer distance/);
    release(b, r.id, f.id, sym.id);
  });
});

describe('shell outside (API 4)', () => {
  it('inside keeps the outer size; outside keeps the cavity', () => {
    const b = block(20, 20, 20);
    const top = call(k, 'topo', { id: b, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'plane' && f.normal[2] > 0.99).i;
    const inside = call(k, 'shell', { id: b, faces: [top], t: 2 });
    expect(inside.valid).toBe(true);
    expect(rel(volume(k, inside.id), 8000 - 16 * 16 * 18)).toBeLessThan(1e-6);
    const outside = call(k, 'shell', { id: b, faces: [top], t: 2, outside: true });
    expect(outside.valid).toBe(true);
    expect(rel(volume(k, outside.id), 24 * 24 * 22 - 8000)).toBeLessThan(1e-6);
    release(b, inside.id, outside.id);
  });
});

describe('edge_eval and topo edge_ends / vertex_faces (API 4, REFERENCE R1 R2)', () => {
  it('points by distance and fraction, plane crossings, the nearest point', () => {
    const b = block(20, 10, 5);
    const t = call(k, 'topo', { id: b, faces: 'none', vertices: 'none', edge_ends: true });
    const e = t.edges.find((x: R) => x.type === 'line' && Math.abs(x.length - 20) < 1e-9 && x.mid[2] < 0.01 && x.mid[1] < 0.01);
    expect(e.dir.map(Math.abs)).toEqual([1, 0, 0]);
    expect(e.vertices).toHaveLength(2);
    const r = call(k, 'edge_eval', { id: b, edge: e.i, at: [{ distance: 5 }, { fraction: 0.5 }], plane: { origin: [12, 0, 0], normal: [1, 0, 0] }, near: [3, 4, 0] });
    expect(r.type).toBe('line');
    expect(r.length).toBeCloseTo(20, 9);
    expect(r.first).toEqual(e.first);
    const d5 = r.points[0].p;
    expect(Math.abs(d5[0] - e.first[0])).toBeCloseTo(5, 9);
    expect(r.points[1].p[0]).toBeCloseTo(10, 9);
    expect(r.crossings).toHaveLength(1);
    expect(r.crossings[0].p[0]).toBeCloseTo(12, 6);
    expect(r.nearest.p[0]).toBeCloseTo(3, 6);
    expect(r.nearest.distance).toBeCloseTo(4, 6);
    expect(tryCall(k, 'edge_eval', { id: b, edge: e.i, at: [{ distance: 25 }] }).error).toMatch(/past the end of the edge \(length 20 mm\)/);
    // A line lying in the plane crosses it nowhere.
    expect(call(k, 'edge_eval', { id: b, edge: e.i, plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }).crossings).toEqual([]);
    const v = call(k, 'topo', { id: b, faces: 'none', edges: 'none', vertex_faces: true }).vertices;
    expect(v.every((x: R) => x.faces.length === 3)).toBe(true);
    release(b);
  });

  it('a circle: its tangent, two crossings with a plane through its centre', () => {
    const disc = [C('c_1', [0, 0], 10)];
    const cyl = call(k, 'extrude_regions', { plane: TOP, curves: disc, regions: [onlyKey(disc, TOP)], extent: { kind: 'blind', d: 5 } }).id;
    const t = call(k, 'topo', { id: cyl, faces: 'none', vertices: 'none', edge_ends: true });
    const circ = t.edges.find((x: R) => x.type === 'circle' && x.mid[2] < 0.01);
    const r = call(k, 'edge_eval', { id: cyl, edge: circ.i, at: [{ fraction: 0.25 }], plane: { origin: [0, 0, 0], normal: [1, 0, 0] } });
    expect(r.closed).toBe(true);
    expect(r.length).toBeCloseTo(20 * Math.PI, 6);
    expect(r.crossings).toHaveLength(2);
    expect(Math.hypot(...(r.points[0].tangent as number[]))).toBeCloseTo(1, 9);
    release(cyl);
  });
});

describe('extrude along a direction (API 4)', () => {
  it('a slanted direction keeps the volume (area x height along the normal); flip and symmetric start behind; a direction in the plane is refused', () => {
    const sq = rect(10, 10);
    const key = onlyKey(sq, TOP);
    const d = [1, 0, 1].map((v) => v / Math.SQRT2);
    const r = call(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'blind', d: 20 }, direction: d });
    expect(r.valid).toBe(true);
    // 20 mm along the slant is 20 / sqrt 2 up: a parallelepiped of 100 x 14.14.
    expect(rel(volume(k, r.id), (100 * 20) / Math.SQRT2)).toBeLessThan(1e-9);
    const bb = props(r.id).bbox;
    expect(bb[3]).toBeCloseTo(10 + 20 / Math.SQRT2, 6);
    expect(bb[5]).toBeCloseTo(20 / Math.SQRT2, 6);
    const sym = call(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'symmetric', d: 20 }, direction: d });
    const bs = props(sym.id).bbox;
    expect(bs[2]).toBeCloseTo(-10 / Math.SQRT2, 6);
    expect(bs[5]).toBeCloseTo(10 / Math.SQRT2, 6);
    const down = call(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'blind', d: 10 }, direction: [0, 0, -1] });
    expect(props(down.id).bbox[2]).toBeCloseTo(-10, 6);
    expect(tryCall(k, 'extrude_regions', { plane: TOP, curves: sq, regions: [key], extent: { kind: 'blind', d: 10 }, direction: [1, 0, 0] }).error).toMatch(/lies in the profile's plane/);
    release(r.id, sym.id, down.id);
  });
});
