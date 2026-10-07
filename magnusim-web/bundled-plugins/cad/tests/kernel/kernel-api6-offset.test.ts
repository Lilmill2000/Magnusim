// @vitest-environment node
// Kernel API 6 (press-pull on curved faces): offset_faces, a true offset of picked faces
// (BRepOffset_MakeOffset, d on the picked faces, 0 elsewhere, join Intersection) with
// fillets re-rounded at their new radius, and press_pull taking curved faces (a thickened
// face as the tool). Volumes against analytic values and the native OCCT 7.9.3 values in
// fixtures/kernel/reference.json (p5_offset); refusals in words with the largest distance
// that works; names kept; the inputs never change.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, fingerprint, HAVE_VORTEX, importStep, importVortex, itVortex, loadKernel, REF, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
let vortex: number;
beforeAll(async () => {
  k = await loadKernel();
  if (HAVE_VORTEX) vortex = importVortex(k).shapes[0].id;
});

const N: R = REF.p5_offset;
const faces = (id: number): R[] => call(k, 'topo', { id, edges: 'none', vertices: 'none' }).faces;
const faceWhere = (id: number, test: (f: R) => boolean): number => {
  const f = faces(id).filter(test);
  if (f.length !== 1) throw new Error(`expected one face, found ${f.length}`);
  return f[0].i;
};
const bool = (op: string, a: number, b: number) => call(k, 'boolean', { op, targets: [a], tools: [b] }).id as number;
const offset = (id: number, faceIdx: number[], d: number, extra: R = {}) => call(k, 'offset_faces', { id, faces: faceIdx, d, ...extra });
const XZ = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const poly = (pts: number[][], plane: R = XZ) => ({ plane, loops: [pts.map((a, i) => ({ id: `s${i}`, kind: 'line', a, b: pts[(i + 1) % pts.length] }))] });
const revolveZ = (profile: R) => call(k, 'revolve', { profile, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle_deg: 360 }).id as number;
/** Each result face's history sources. */
const sources = (r: R, out: number): R[] => r.history.faces.find((f: R) => f.out === out)?.from ?? [];

/** The 60 x 40 x 10 plate with a hole r 10 at (30, 20). */
function plateWithBore(): { id: number; bore: number; top: number } {
  const id = bool('cut', call(k, 'box', { dx: 60, dy: 40, dz: 10 }).id, call(k, 'cylinder', { r: 10, h: 12, origin: [30, 20, -1] }).id);
  return { id, bore: faceWhere(id, (f) => f.type === 'cylinder'), top: faceWhere(id, (f) => f.type === 'plane' && f.normal[2] > 0.9) };
}

/** The 40 x 30 x 20 box with a 5 mm fillet on its vertical edge at x 40, y 30. */
function filletBox(): { id: number; fillet: number } {
  const box = call(k, 'box', { dx: 40, dy: 30, dz: 20 }).id;
  const edges = call(k, 'topo', { id: box, faces: 'none', vertices: 'none', edge_ends: true }).edges;
  const e = edges.find((x: R) => Math.abs(x.first[0] - 40) < 1e-9 && Math.abs(x.last[0] - 40) < 1e-9 && Math.abs(x.first[1] - 30) < 1e-9 && Math.abs(x.last[1] - 30) < 1e-9).i;
  const id = call(k, 'fillet', { id: box, edges: [e], r: 5 }).id;
  return { id, fillet: faceWhere(id, (f) => f.type === 'cylinder') };
}

describe('offset_faces (API 6)', () => {
  it('version answers api 6', () => {
    expect(call(k, 'version')).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 6 });
  });

  it('a pipe bore grown and shrunk: +2 mm -> r 8, -2 mm -> r 12 (native volumes); the bore keeps its name, the input is unchanged', () => {
    const { id, bore } = plateWithBore();
    const before = fingerprint(k, id);
    for (const [d, r, ref] of [
      [2, 8, N.bore.plus_2],
      [-2, 12, N.bore.minus_2],
    ] as [number, number, R][]) {
      const o = offset(id, [bore], d);
      expect(o).toMatchObject({ valid: true, solids: 1, method: 'offset', faces: ref.faces, tangent: [] });
      expect(o.refused).toBeUndefined();
      expect(o.about).toEqual([{ face: bore, type: 'cylinder', role: 'bore', convex: false, radius: 10, new_radius: r, tangent: [] }]);
      const v = volume(k, o.id);
      expect(rel(v, ref.volume)).toBeLessThan(1e-12);
      expect(rel(v, 60 * 40 * 10 - Math.PI * r * r * 10)).toBeLessThan(1e-12);
      // The moved face is the bore at its new radius, modified from the picked one.
      const moved = faces(o.id)[o.moved[0]];
      expect(moved).toMatchObject({ type: 'cylinder' });
      expect(moved.radius).toBeCloseTo(r, 9);
      expect(sources(o, o.moved[0])).toEqual([{ shape: id, face: bore, how: 'modified' }]);
    }
    expect(fingerprint(k, id)).toEqual(before);
  });

  it('a boss radius: +2 -> r 10, -3 -> r 5 (native and analytic)', () => {
    const boss = bool('fuse', call(k, 'box', { dx: 60, dy: 40, dz: 10 }).id, call(k, 'cylinder', { r: 8, h: 15, origin: [30, 20, 10] }).id);
    const side = faceWhere(boss, (f) => f.type === 'cylinder');
    for (const [d, r, ref] of [
      [2, 10, N.boss.plus_2],
      [-3, 5, N.boss.minus_3],
    ] as [number, number, R][]) {
      const o = offset(boss, [side], d);
      expect(o.about[0]).toMatchObject({ role: 'cylinder', convex: true, radius: 8, new_radius: r });
      expect(rel(volume(k, o.id), ref.volume)).toBeLessThan(1e-12);
      expect(rel(volume(k, o.id), 24000 + Math.PI * r * r * 15)).toBeLessThan(1e-12);
    }
  });

  it("a fillet face changes its radius and stays tangent: +1 -> r 4, -1 -> r 6; the new fillet keeps the old one's name", () => {
    const { id, fillet } = filletBox();
    for (const [d, r, ref] of [
      [1, 4, N.fillet.plus_1],
      [-1, 6, N.fillet.minus_1],
    ] as [number, number, R][]) {
      const o = offset(id, [fillet], d);
      expect(o).toMatchObject({ valid: true, method: 'refillet', faces: 7 });
      expect(o.about[0]).toMatchObject({ role: 'fillet', convex: true, radius: 5, new_radius: r });
      const v = volume(k, o.id);
      expect(rel(v, ref.volume)).toBeLessThan(1e-12);
      // A box with an r fillet on one 20 mm edge: 24000 - (1 - pi/4) r^2 20.
      expect(rel(v, 24000 - (1 - Math.PI / 4) * r * r * 20)).toBeLessThan(1e-12);
      const nf = faces(o.id)[o.moved[0]];
      expect(nf.type).toBe('cylinder');
      expect(nf.radius).toBeCloseTo(r, 9);
      expect(sources(o, o.moved[0])).toContainEqual({ shape: id, face: fillet, how: 'modified' });
      // No face is lost (the old fillet's edges are, with it).
      expect(o.history.deleted.filter((x: R) => x.face !== undefined)).toEqual([]);
    }
  });

  it('a flat face with a draft-angled neighbour: the slope is extended to meet it, no step (press_pull leaves one)', () => {
    // x 0..40 at z 0, 0..30 at z 20 (the slope runs 10 in 20), 30 deep.
    const trap = call(k, 'extrude', { profile: poly([[0, 0], [40, 0], [30, 20], [0, 20]]), extent: { kind: 'blind', d: 30 } }).id;
    const top = faceWhere(trap, (f) => f.type === 'plane' && f.normal[2] > 0.9);
    for (const [d, ref, prism, analytic] of [
      [5, N.trap.offset_plus_5, N.trap.prism_plus_5, (40 * 25 - 0.25 * 625) * 30],
      [-5, N.trap.offset_minus_5, N.trap.prism_minus_5, (40 * 15 - 0.25 * 225) * 30],
    ] as [number, R, R, number][]) {
      const o = offset(trap, [top], d);
      expect(o).toMatchObject({ valid: true, faces: 6, method: 'offset' });
      expect(rel(volume(k, o.id), ref.volume)).toBeLessThan(1e-12);
      expect(rel(volume(k, o.id), analytic)).toBeLessThan(1e-12);
      // The old prism-and-fuse leaves a step: a side face of its own and another volume.
      const p = call(k, 'press_pull', { id: trap, faces: [top], d });
      expect(Object.keys(p.sides)).toHaveLength(1);
      expect(p.faces).toBe(prism.faces);
      expect(rel(volume(k, p.id), prism.volume)).toBeLessThan(1e-12);
      // The slope keeps its name, the top too.
      const slope = faceWhere(trap, (f) => f.type === 'plane' && f.normal[0] > 0.5);
      expect(o.history.faces.filter((f: R) => f.from.some((s: R) => s.face === slope))).toHaveLength(1);
      expect(sources(o, o.moved[0])).toEqual([{ shape: trap, face: top, how: 'modified' }]);
    }
  });

  it('a cone: +1 / -1 move it along its normal (native); -6 would pass its tip: refused, 4.4 mm or less works', () => {
    const cb = bool('fuse', call(k, 'box', { dx: 60, dy: 40, dz: 10, origin: [-30, -20, 0] }).id, revolveZ(poly([[0, 10], [10, 10], [5, 20], [0, 20]])));
    const cone = faceWhere(cb, (f) => f.type === 'cone');
    expect(rel(volume(k, cb), N.cone.in.volume)).toBeLessThan(1e-12);
    const ca = Math.cos(Math.atan(5 / 10));
    for (const [d, ref] of [
      [1, N.cone.plus_1],
      [-1, N.cone.minus_1],
    ] as [number, R][]) {
      const o = offset(cb, [cone], d);
      // No radius for a cone (fix round 1, B3): which end keeps its radius depends on its neighbours.
      expect(o.about[0]).toMatchObject({ role: 'cone', convex: true });
      expect(o.about[0].radius).toBeUndefined();
      const v = volume(k, o.id);
      expect(rel(v, ref.volume)).toBeLessThan(1e-12);
      // The frustum's radii at z 10 and 20 each change by d / cos(a).
      const r1 = 10 + d / ca;
      const r2 = 5 + d / ca;
      expect(rel(v, 24000 + (Math.PI * 10 / 3) * (r1 * r1 + r1 * r2 + r2 * r2))).toBeLessThan(1e-12);
    }
    const no = offset(cb, [cone], -6, { diagnose: true });
    expect(no.id).toBeUndefined();
    expect(no.refused).toEqual({ code: 'radius', words: 'the cone would pass its tip', face: cone, d: -6 });
    // The narrow end's radius 5 times cos(a) = 4.47: the largest that works is just under it.
    expect(no.max_ok).toBeGreaterThan(4.4);
    expect(no.max_ok).toBeLessThan(5 * ca);
  });

  it('a sphere cap: +2 / -2 make it r 12 / r 8 (native, analytic); on a dome the tangent cylinder moves with it', () => {
    const cap = bool(
      'fuse',
      call(k, 'box', { dx: 60, dy: 40, dz: 10 }).id,
      bool('common', call(k, 'sphere', { r: 10, center: [30, 20, 4] }).id, call(k, 'box', { dx: 60, dy: 40, dz: 20, origin: [0, 0, 10] }).id),
    );
    const s = faceWhere(cap, (f) => f.type === 'sphere');
    const capVol = (R: number, h: number) => (Math.PI * h * h * (3 * R - h)) / 3;
    for (const [d, R, ref] of [
      [2, 12, N.cap.plus_2],
      [-2, 8, N.cap.minus_2],
    ] as [number, number, R][]) {
      const o = offset(cap, [s], d);
      expect(o.about[0]).toMatchObject({ role: 'sphere', convex: true, radius: 10, new_radius: R, tangent: [] });
      expect(rel(volume(k, o.id), ref.volume)).toBeLessThan(1e-12);
      // The centre stays 6 below the top, so the cap is R - 6 high.
      expect(rel(volume(k, o.id), 24000 + capVol(R, R - 6))).toBeLessThan(1e-12);
    }
    // A dome (a cylinder r 10 under a half sphere): the cylinder is tangent to the sphere, so
    // OCCT moves it too, and says so (tangent).
    const dome = call(k, 'revolve', {
      profile: { plane: XZ, loops: [[{ id: 'a', kind: 'line', a: [0, 0], b: [10, 0] }, { id: 'b', kind: 'line', a: [10, 0], b: [10, 10] }, { id: 'c', kind: 'arc', c: [0, 10], r: 10, a0: 0, a1: 90, ccw: true }, { id: 'd', kind: 'line', a: [0, 20], b: [0, 0] }]] },
      axis: { origin: [0, 0, 0], dir: [0, 0, 1] },
      angle_deg: 360,
    }).id;
    const sph = faceWhere(dome, (f) => f.type === 'sphere');
    const cyl = faceWhere(dome, (f) => f.type === 'cylinder');
    const o = offset(dome, [sph], 2);
    expect(o.tangent).toEqual([cyl]);
    expect(rel(volume(k, o.id), N.dome.plus_2.volume)).toBeLessThan(1e-12);
    expect(rel(volume(k, o.id), Math.PI * 144 * 10 + (2 / 3) * Math.PI * 12 ** 3)).toBeLessThan(1e-12);
  });

  it('a closing hole is refused in words, with the largest distance that works (bisection on work copies)', () => {
    const { id, bore } = plateWithBore();
    const before = fingerprint(k, id);
    for (const d of [10, 11]) {
      const no = offset(id, [bore], d, { diagnose: true });
      expect(no.refused).toEqual({ code: 'radius', words: 'the hole would close', face: bore, d });
      expect(no.about[0]).toMatchObject({ role: 'bore', radius: 10, new_radius: 10 - d });
      expect(no.max_ok).toBeGreaterThan(9.9);
      expect(no.max_ok).toBeLessThan(10);
      expect(no.diagnose_runs).toBeLessThanOrEqual(10);
    }
    // Without diagnose there is no suggestion (and no extra runs).
    expect(offset(id, [bore], 11).max_ok).toBeUndefined();
    // A 4.9 mm hole in the other direction never closes: -20 opens it to r 30, wider than the plate.
    const wide = offset(id, [bore], -20, { diagnose: true });
    expect(wide.refused?.code).toBeDefined();
    expect(wide.max_ok).toBeGreaterThan(0);
    expect(wide.max_ok).toBeLessThan(10.0001);
    expect(fingerprint(k, id)).toEqual(before);
  });

  it('names: every face of the body keeps its name 1:1 (modified), nothing is deleted', () => {
    const { id, bore, top } = plateWithBore();
    const o = offset(id, [bore, top], 2);
    expect(o.faces).toBe(7);
    const outs = new Set<number>();
    const ins = new Set<number>();
    for (const f of o.history.faces) {
      expect(f.from).toHaveLength(1);
      expect(f.from[0]).toMatchObject({ shape: id, how: 'modified' });
      outs.add(f.out);
      ins.add(f.from[0].face);
    }
    expect(outs.size).toBe(7);
    expect(ins.size).toBe(7);
    expect(o.history.deleted).toEqual([]);
    // Mixed kinds at once: the hole is r 8 and the plate 12 high (native).
    expect(rel(volume(k, o.id), N.bore.mixed_bore_top_plus_2.volume)).toBeLessThan(1e-12);
    expect(rel(volume(k, o.id), 60 * 40 * 12 - Math.PI * 64 * 12)).toBeLessThan(1e-12);
    expect(o.moved).toHaveLength(2);
    expect(faces(o.id)[o.moved[1]].centroid[2]).toBeCloseTo(12, 9);
  });

  it('a pocket floor pushed through the bottom cuts through itself: refused, 4.9 mm or less works; up to the top a wall vanishes', () => {
    const pk = bool('cut', call(k, 'box', { dx: 40, dy: 30, dz: 10 }).id, call(k, 'box', { dx: 20, dy: 10, dz: 10, origin: [10, 10, 5] }).id);
    const floor = faceWhere(pk, (f) => f.type === 'plane' && f.normal[2] > 0.9 && Math.abs(f.centroid[2] - 5) < 1e-9);
    // Natively BRepCheck passes this result and only the self-interference check sees it.
    expect(N.pocket.minus_12).toMatchObject({ valid: true, self_ok: false });
    const self = offset(pk, [floor], -12, { diagnose: true });
    expect(self.refused).toEqual({ code: 'self', d: -12 });
    expect(self.max_ok).toBeGreaterThan(4.9);
    expect(self.max_ok).toBeLessThan(5);
    const ok = offset(pk, [floor], -3);
    expect(rel(volume(k, ok.id), N.pocket.minus_3.volume)).toBeLessThan(1e-12);
    expect(offset(pk, [floor], 5).refused).toMatchObject({ code: 'vanish' });
  });

  it('a B-spline face: a lofted side offsets (native); an extruded spline side is refused with the reason', () => {
    const section = (z: number, r: number, p: string) => {
      const plane = { ...TOP, origin: [0, 0, z] };
      const curves = [{ id: `${p}c`, kind: 'circle', c: [0, 0], r }];
      return { plane, curves, regions: [call(k, 'sketch_regions', { plane, curves, tess: false }).regions[0].key] };
    };
    const loft = call(k, 'loft_regions', { sections: [section(0, 10, 'a'), section(10, 12, 'b'), section(20, 8, 'c')] }).id;
    // loft_regions builds its sections from sketch regions: its surface is within 1.4e-6 of
    // native ThruSections through the same circles, not bit for bit.
    expect(rel(volume(k, loft), N.loft.in.volume)).toBeLessThan(1e-5);
    const side = faceWhere(loft, (f) => f.type === 'bspline');
    for (const [d, ref] of [
      [1, N.loft.plus_1],
      [-1, N.loft.minus_1],
    ] as [number, R][]) {
      const o = offset(loft, [side], d);
      expect(o.about[0]).toMatchObject({ type: 'bspline', role: 'surface' });
      expect(rel(volume(k, o.id), ref.volume)).toBeLessThan(1e-5);
      // The volume changes by about the side's area times d.
      expect(Math.sign(volume(k, o.id) - volume(k, loft))).toBe(Math.sign(d));
    }
    const curves = [
      { id: 'e_l', kind: 'line', a: [0, 0], b: [40, 0], pa: 'p1', pb: 'p2' },
      { id: 'e_s', kind: 'bspline', degree: 3, poles: [[40, 0], [40, 30], [0, 30], [0, 0]], knots: [0, 1], mults: [4, 4], pa: 'p2', pb: 'p1' },
    ];
    const ex = call(k, 'extrude_regions', { plane: TOP, curves, regions: [call(k, 'sketch_regions', { plane: TOP, curves, tess: false }).regions[0].key], extent: { kind: 'blind', d: 10 } }).id;
    const curved = faceWhere(ex, (f) => f.type !== 'plane');
    const no = offset(ex, [curved], 1, { diagnose: true });
    expect(no.refused).toMatchObject({ code: 'occt' });
    expect(no.refused.detail).toBeTruthy();
    expect(no.max_ok).toBeNull();
  });

  it('refuses bad input: no faces, a zero distance, a face twice, a face not on the body', () => {
    const { id, bore } = plateWithBore();
    expect(tryCall(k, 'offset_faces', { id, faces: [], d: 1 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'offset_faces', { id, faces: [bore], d: 0 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'offset_faces', { id, faces: [bore, bore], d: 1 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'offset_faces', { id, faces: [99], d: 1 })).toMatchObject({ ok: false, kind: 'input' });
  });
});

const F1: R = REF.p5_fix1;
const chainOf = (id: number, faceIdx: number[], d: number, extra: R = {}) => call(k, 'offset_faces', { id, faces: faceIdx, d, chain: true, ...extra });
const edgesWhere = (id: number, test: (e: R) => boolean): number[] => call(k, 'topo', { id, faces: 'none', vertices: 'none', edge_ends: true }).edges.filter(test).map((e: R) => e.i);
const at = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const bboxOf = (id: number) => call(k, 'props', { id, bbox: 'exact' }).bbox as number[];

describe('offset_faces fix round 1: fillets and chamfers kept, the method chain, the accept rule', () => {
  it('B2: a box top with its two top edges rounded r 3, +5 / -5: the walls stay, the fillets stay r 3 (40 x 30 x 25), named as before', () => {
    const box = call(k, 'box', { dx: 40, dy: 30, dz: 20 }).id;
    const tops = edgesWhere(box, (e) => at(e.first[2], 20) && at(e.last[2], 20) && at(e.first[0], e.last[0]));
    expect(tops).toHaveLength(2);
    const fb = call(k, 'fillet', { id: box, edges: tops, r: 3 }).id;
    const top = faceWhere(fb, (f) => f.type === 'plane' && f.normal[2] > 0.9);
    const fillets = faces(fb).filter((f) => f.type === 'cylinder').map((f) => f.i);
    const corner = (1 - Math.PI / 4) * 9 * 30;
    for (const [d, h] of [
      [5, 25],
      [-5, 15],
    ]) {
      const o = chainOf(fb, [top], d);
      expect(o).toMatchObject({ valid: true, method: 'offset', tangent: [] });
      expect(o.carried.sort()).toEqual(fillets.sort());
      expect(rel(volume(k, o.id), 40 * 30 * h - 2 * corner)).toBeLessThan(1e-12);
      expect(bboxOf(o.id).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([0, 0, 0, 40, 30, h]);
      const after = faces(o.id).filter((f) => f.type === 'cylinder');
      expect(after.map((f) => f.radius)).toEqual([3, 3].map(() => expect.closeTo(3, 9)));
      // Each new fillet face is `modified` from its old one (its name stays).
      for (const f of fillets) expect(o.history.faces.some((e: R) => e.from.some((s: R) => s.face === f && s.how === 'modified'))).toBe(true);
    }
  });

  it('B2: a box top beside a 4 mm chamfer, +5: with the chamfer carried it keeps its size (29,760); left out, the offset extends it (28,785)', () => {
    const box = call(k, 'box', { dx: 40, dy: 30, dz: 20 }).id;
    const edge = edgesWhere(box, (e) => at(e.first[2], 20) && at(e.last[2], 20) && at(e.first[0], 40) && at(e.last[0], 40));
    const cb = call(k, 'chamfer', { id: box, edges: edge, d: 4 }).id;
    const top = faceWhere(cb, (f) => f.type === 'plane' && f.normal[2] > 0.99);
    const ch = faceWhere(cb, (f) => f.type === 'plane' && f.normal[0] > 0.1 && f.normal[2] > 0.1);
    const kept = chainOf(cb, [top], 5, { carry: [ch] });
    expect(kept).toMatchObject({ valid: true, method: 'offset', carried: [ch] });
    expect(rel(volume(k, kept.id), 40 * 30 * 25 - 0.5 * 4 * 4 * 30)).toBeLessThan(1e-12);
    expect(kept.history.faces.some((e: R) => e.from.some((s: R) => s.face === ch && s.how === 'modified'))).toBe(true);
    const extended = chainOf(cb, [top], 5);
    expect(extended.carried).toEqual([]);
    expect(rel(volume(k, extended.id), 28785)).toBeLessThan(1e-12);
  });

  it('B1: a fillet face at -40 is refused in words (the fillet would not fit), never a split body; 24.9 mm or so works', () => {
    const box = call(k, 'box', { dx: 40, dy: 30, dz: 20 }).id;
    const edge = edgesWhere(box, (e) => at(e.first[0], 40) && at(e.last[0], 40) && at(e.first[1], 30) && at(e.last[1], 30));
    const fb = call(k, 'fillet', { id: box, edges: edge, r: 5 }).id;
    const fillet = faceWhere(fb, (f) => f.type === 'cylinder');
    const no = chainOf(fb, [fillet], -40, { diagnose: true });
    expect(no.id).toBeUndefined();
    expect(no.refused).toMatchObject({ code: 'fillet', face: fillet });
    expect(no.max_ok).toBeGreaterThan(24.9);
    expect(no.max_ok).toBeLessThan(25);
    const yes = chainOf(fb, [fillet], -24);
    expect(rel(volume(k, yes.id), 24000 - (1 - Math.PI / 4) * 29 * 29 * 20)).toBeLessThan(1e-12);
  });

  it('B1: the bore at -12 breaks the plate in two (the cylinder method, a genuine split, analytic); at -40 nothing would be left: refused, the search finds what works', () => {
    const { id, bore } = plateWithBore();
    const split = chainOf(id, [bore], -12);
    expect(split).toMatchObject({ valid: true, method: 'cylinder', solids: 2 });
    // The ring r 22 clipped by the 40 mm wide plate: what is left of each half.
    const half = (x: number) => 2 * (x * Math.sqrt(22 * 22 - x * x) / 2 + (22 * 22 / 2) * Math.asin(x / 22));
    const removed = (2 * half(20) - 0) * 10;
    expect(rel(volume(k, split.id), 24000 - removed)).toBeLessThan(1e-9);
    const no = chainOf(id, [bore], -40, { diagnose: true });
    expect(no.refused).toMatchObject({ code: 'empty', d: -40 });
    expect(no.max_ok).toBeGreaterThan(12);
    // What the search found works with the same rule.
    expect(chainOf(id, [bore], -no.max_ok).valid).toBe(true);
  });

  it('B3: a cone over a cylinder of its radius, +1: the cylinder is extended up to the offset cone (analytic); -8 would leave a step: refused, about -4.4 works', () => {
    const XZp = (pts: number[][]) => ({ plane: XZ, loops: [pts.map((a, i) => ({ id: `s${i}`, kind: 'line', a, b: pts[(i + 1) % pts.length] }))] });
    const cc = revolveZ(XZp([[0, 0], [20, 0], [20, 10], [10, 30], [0, 30]]));
    const cone = faceWhere(cc, (f) => f.type === 'cone');
    const o = chainOf(cc, [cone], 1);
    expect(o).toMatchObject({ valid: true, method: 'offset' });
    // The offset cone meets r 20 at z = 10 + 2 / cos(a), a = atan(1/2); its top is r 10 + 1 / cos(a).
    const k1 = 1 / Math.cos(Math.atan(0.5));
    const z = 10 + 2 * k1;
    const rTop = 10 + k1;
    const expected = Math.PI * 400 * z + (Math.PI * (30 - z) / 3) * (400 + 20 * rTop + rTop * rTop);
    expect(rel(volume(k, o.id), expected)).toBeLessThan(1e-9);
    const cyl = faces(o.id).find((f) => f.type === 'cylinder')!;
    expect(cyl.radius).toBeCloseTo(20, 9);
    const no = chainOf(cc, [cone], -8, { diagnose: true });
    expect(no.refused).toMatchObject({ code: 'step' });
    expect(no.max_ok).toBeGreaterThan(4.4);
    expect(no.max_ok).toBeLessThan(4.5);
  });

  it('a sloped top pushed down its whole height is refused (no wedge sliver); +100 would leave a step: refused', () => {
    const trap = call(k, 'extrude', { profile: poly([[0, 0], [40, 0], [30, 20], [0, 20]]), extent: { kind: 'blind', d: 30 } }).id;
    const top = faceWhere(trap, (f) => f.type === 'plane' && f.normal[2] > 0.9);
    const down = chainOf(trap, [top], -20, { diagnose: true });
    expect(down.id).toBeUndefined();
    expect(down.max_ok).toBeGreaterThan(19.9);
    expect(down.max_ok).toBeLessThan(20);
    const up = chainOf(trap, [top], 100);
    expect(up.refused).toMatchObject({ code: 'step' });
  });

  it('a boss pushed out 15 past the plate edge: the cylinder method, exact', () => {
    const boss = bool('fuse', call(k, 'box', { dx: 60, dy: 40, dz: 10 }).id, call(k, 'cylinder', { r: 10, h: 15, origin: [30, 20, 10] }).id);
    const side = faceWhere(boss, (f) => f.type === 'cylinder');
    const o = chainOf(boss, [side], 15);
    expect(o).toMatchObject({ valid: true, method: 'cylinder' });
    expect(rel(volume(k, o.id), 24000 + Math.PI * 625 * 15)).toBeLessThan(1e-12);
    expect(o.history.faces.find((e: R) => e.out === o.moved[0]).from).toContainEqual({ shape: boss, face: side, how: 'modified' });
  });

  it('B4: the stepped-bore STEP: the bore r 10 at -2 (offset), the counterbore r 15 at -2 opens into its thin side (OCCT gives no shape: the cylinder method) and at +1 (native)', () => {
    const sb = importStep(k, 'stepped-bore.step').shapes[0].id;
    expect(rel(volume(k, sb), F1.stepped.in.volume)).toBeLessThan(1e-9);
    const b10 = faceWhere(sb, (f) => f.type === 'cylinder' && Math.abs(f.radius - 10) < 1e-6);
    const b15 = faceWhere(sb, (f) => f.type === 'cylinder' && Math.abs(f.radius - 15) < 1e-6);
    const a = chainOf(sb, [b10], -2);
    expect(a).toMatchObject({ valid: true, method: 'offset' });
    expect(rel(volume(k, a.id), F1.stepped.bore10_offset_minus_2.volume)).toBeLessThan(1e-9);
    expect(F1.stepped.bore15_offset_minus_2).toBeNull();
    const b = chainOf(sb, [b15], -2);
    expect(b).toMatchObject({ valid: true, method: 'cylinder', faces: F1.stepped.bore15_ring_minus_2.faces });
    expect(rel(volume(k, b.id), F1.stepped.bore15_ring_minus_2.volume)).toBeLessThan(1e-9);
    expect(b.history.faces.find((e: R) => e.out === b.moved[0]).from).toContainEqual({ shape: sb, face: b15, how: 'modified' });
    const c = chainOf(sb, [b15], 1);
    expect(rel(volume(k, c.id), F1.stepped.bore15_offset_plus_1.volume)).toBeLessThan(1e-9);
  });

  itVortex('B4: the Vortex outlet cylinders (UI Faces 12 and 17) at -1, -2 and +1, and the main cylinder at -1: the cylinder method at the native volumes', () => {
    const fs = faces(vortex);
    const o25 = fs.filter((f) => f.type === 'cylinder' && Math.abs(f.radius - 25.4) < 1e-6).sort((x, y) => x.area - y.area)[0];
    const o30 = fs.find((f) => f.type === 'cylinder' && Math.abs(f.radius - 30.1752) < 1e-6)!;
    const main = fs.find((f) => f.type === 'cylinder' && Math.abs(f.radius - 152.4) < 1e-6)!;
    expect(o25.area).toBeCloseTo(F1.vortex.outlet_25_area, 6);
    expect(o30.area).toBeCloseTo(F1.vortex.outlet_30_area, 6);
    const before = fingerprint(k, vortex);
    for (const [face, name] of [
      [o25, 'outlet_25'],
      [o30, 'outlet_30'],
    ] as [R, string][])
      for (const [d, key] of [
        [-1, 'minus_1'],
        [-2, 'minus_2'],
        [1, 'plus_1'],
      ] as [number, string][]) {
        const o = chainOf(vortex, [face.i], d);
        expect(o, `${name} ${d}`).toMatchObject({ valid: true, method: 'cylinder' });
        expect(rel(volume(k, o.id), F1.vortex[`${name}_ring_${key}`].volume)).toBeLessThan(1e-12);
        call(k, 'release', { ids: [o.id] });
      }
    const m = chainOf(vortex, [main.i], -1);
    expect(rel(volume(k, m.id), F1.vortex.main_ring_minus_1.volume)).toBeLessThan(1e-12);
    expect(fingerprint(k, vortex)).toEqual(before);
  }, 300_000);

  itVortex('B1: the Vortex inlet pipe and a B-spline face meet tangent faces: refused (a step), never a near-zero volume change', () => {
    const fs = faces(vortex);
    const inlet = fs.filter((f) => f.type === 'cylinder' && Math.abs(f.radius - 25.4) < 1e-6).sort((x, y) => y.area - x.area)[0];
    const spline = fs.filter((f) => f.type === 'bspline').sort((x, y) => x.area - y.area)[0];
    for (const f of [inlet, spline]) {
      const no = chainOf(vortex, [f.i], -1);
      expect(no.id).toBeUndefined();
      expect(no.refused.code).toBe('step');
    }
  }, 120_000);
});

describe('press_pull on curved faces (API 6: a thickened face as the tool)', () => {
  it('the plate bore +2 / -2 by press_pull equals the offset (its neighbours are square to it)', () => {
    const { id, bore } = plateWithBore();
    for (const [d, ref] of [
      [2, N.bore.thick_plus_2],
      [-2, N.bore.thick_minus_2],
    ] as [number, R][]) {
      const p = call(k, 'press_pull', { id, faces: [bore], d });
      expect(p).toMatchObject({ valid: true, op: d > 0 ? 'fuse' : 'cut', sides: {}, faces: ref.faces });
      expect(rel(volume(k, p.id), ref.volume)).toBeLessThan(1e-12);
      expect(sources(p, p.moved[0])).toContainEqual({ shape: id, face: bore, how: 'modified' });
    }
  });

  itVortex("Vortex: OCCT's offset refuses the inlet pipe; press_pull's thickened face gives the native volume", () => {
    const fs = faces(vortex);
    const inlet = fs.filter((f) => f.type === 'cylinder' && Math.abs(f.radius - 25.4) < 1e-6).sort((a, b) => b.area - a.area)[0];
    expect(inlet.area).toBeCloseTo(N.vortex.inlet_area, 6);
    const before = fingerprint(k, vortex);
    const no = offset(vortex.valueOf(), [inlet.i], 1);
    expect(N.vortex.inlet_offset_plus_1_fails).toBe(true);
    expect(no.refused.code).toBe('occt');
    expect(no.about[0]).toMatchObject({ role: 'cylinder', convex: true, radius: 25.4, new_radius: 26.4 });
    for (const [d, ref] of [
      [1, N.vortex.inlet_thick_plus_1],
      [-1, N.vortex.inlet_thick_minus_1],
    ] as [number, R][]) {
      const p = call(k, 'press_pull', { id: vortex, faces: [inlet.i], d });
      expect(p).toMatchObject({ valid: true, faces: ref.faces, solids: 1 });
      expect(rel(volume(k, p.id), ref.volume)).toBeLessThan(1e-12);
      // To first order the volume changes by the face's area times d.
      expect(Math.abs(volume(k, p.id) - N.vortex.in.volume - d * inlet.area)).toBeLessThan(0.05 * inlet.area);
    }
    expect(fingerprint(k, vortex)).toEqual(before);
  }, 120_000);

  itVortex('Vortex: the torus fillet is re-rounded at 13.7 mm, tangent to its cone and plane (native)', () => {
    const tor = faces(vortex).find((f) => f.type === 'torus')!;
    const o = offset(vortex, [tor.i], 1);
    expect(o).toMatchObject({ valid: true, method: 'refillet', faces: N.vortex.torus_refillet_plus_1.faces });
    expect(o.about[0]).toMatchObject({ role: 'fillet', convex: false, radius: N.vortex.torus_minor, new_radius: N.vortex.torus_minor + 1 });
    expect(rel(volume(k, o.id), N.vortex.torus_refillet_plus_1.volume)).toBeLessThan(1e-12);
    expect(sources(o, o.moved[0])).toContainEqual({ shape: vortex, face: tor.i, how: 'modified' });
  }, 120_000);
});
