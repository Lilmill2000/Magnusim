// @vitest-environment node
// Delete faces must never pass off a heal that filled more than the gap (2026-10-30): on an
// L-block with every edge rounded R2, removing the 30 blends gave a valid 60 x 40 x 20 box
// (48,000 mm³ instead of 36,000) and Delete faces 1 was "ok". Through the document as the
// person does it (Sketch + Extrude, a cut, Fillet of every face, Delete faces of the blends): the
// L-block's heal is tried again in two goes and gives the sharp L-block; a T-block's cannot be
// made right that way, and Delete faces 1 is red, says what the heal would have done and that
// the body is unchanged. Then the rule (src/features/p2/heal-check.ts) on the real kernel: every
// wrong fill of the repro corpus refused (and five of the six bodies right in two goes), and none
// of its right removals (holes, bosses, pockets, slots, fillets, chamfers, ring fillets, wedge
// tips, a 50-hole plate, BREP round trips).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { checkHeal, healRefused, retryHoldBack, type HealCheck } from '../../../src/features/p2/heal-check';
import { PATTERN_DEFS } from '../../../src/features/pattern/defs';
import type { DeleteFacesFeature } from '../../../src/types/doc';
import type { BuildContext, FeatureTypeDef } from '../../../src/types/doc-service';
import type { OpHistory, TopoResult } from '../../../src/types/kernel-protocol';
import { extentFor } from '../../doc/blocks';
import type { RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, close, faceRef, onPlane, openSolids, regionsOf, SketchBuilder, topo, volume } from '../solids/solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part() {
  const r = await openSolids();
  for (const d of PATTERN_DEFS) if (!r.doc.features.get(d.type)) r.doc.features.register(d as unknown as FeatureTypeDef);
  open.push(r);
  return r;
}

const bodies = (r: RealDoc) => r.doc.state.get().rebuild.bodies;

/** A W x D x H block from a Top sketch, corner (x, y, z0): a new body, or a cut / join into the bodies there. */
async function block(r: RealDoc, [x, y, z0]: number[], [w, d, h]: number[], op: 'new' | 'cut' | 'join' = 'new') {
  const sk = new SketchBuilder();
  sk.rect(x, y, x + w, y + d);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: extentFor(z0, h), ...(op === 'new' ? {} : { op, creates: null, scope: [] }) });
  expect(ex.status.state).toBe('ok');
  return ex.id;
}

/** A round hole of radius rad at (x, y) through the bodies from z = 0 up h. */
async function hole(r: RealDoc, x: number, y: number, rad: number, h: number) {
  const sk = new SketchBuilder();
  sk.circle([x, y], rad);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` }, op: 'cut', creates: null, scope: [] });
  expect(ex.status.state).toBe('ok');
}

/** Fillet every edge of the one body (all its faces picked) by `radius`. */
async function roundAll(r: RealDoc, radius: number) {
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const faces = await Promise.all(t.faces.map((f) => faceRef(r, b, f.i)));
  const fl = await addFeature(r, 'fillet', { body: b.id, edges: [], faces, radius: `${radius} mm` });
  expect(fl.status.state).toBe('ok');
  return fl.id;
}

/** Delete faces `pick` (indices on the body now) of the one body. */
async function deleteFaces(r: RealDoc, pick: (f: TopoResult['faces'][number]) => boolean) {
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const idx = t.faces.filter(pick).map((f) => f.i);
  const refs = await Promise.all(idx.map((i) => faceRef(r, b, i)));
  const d = await addFeature(r, 'delete_faces', { body: b.id, faces: refs } as Partial<DeleteFacesFeature> as Record<string, unknown>);
  return { ...d, count: idx.length };
}

describe('Delete faces through the document: a heal past the gap is tried again, else refused with the body unchanged', () => {
  it('L-block (Extrude, Extrude Cut), Fillet of every face R2, Delete faces of the 30 blends: ok, the sharp L-block (36,000 mm³, 8 faces, named)', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await block(r, [30, 0, 10], [30, 40, 10], 'cut');
    expect(close(await volume(r, bodies(r)[0].id), 36000)).toBe(true);
    await roundAll(r, 2);
    expect(await volume(r, bodies(r)[0].id)).toBeCloseTo(35601.626, 2);
    const del = await deleteFaces(r, (f) => f.type !== 'plane');
    expect(del.count).toBe(30);
    // One go gave the 48,000 mm³ box; two goes (all but the fillet on the riser's top, then it) the right body.
    expect(del.status).toMatchObject({ state: 'ok' });
    expect(del.status.message).toBeUndefined();
    const after = bodies(r)[0];
    expect(after.faces).toBe(8);
    expect(close(await volume(r, after.id), 36000)).toBe(true);
    const names = after.names?.faces ?? [];
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  }, 120_000);

  it('T-block (a bar on a stem), Fillet of every face R2, Delete faces of every blend: red, words, volume and faces as before', async () => {
    const r = await part();
    const bar = await block(r, [0, 0, 10], [60, 40, 10]);
    await block(r, [20, 0, 0], [20, 40, 10], 'join');
    expect(close(await volume(r, bodies(r)[0].id), 32000)).toBe(true);
    const fillet = await roundAll(r, 2);
    const before = bodies(r)[0];
    const v0 = await volume(r, before.id);
    const del = await deleteFaces(r, (f) => f.type !== 'plane');
    const st = del.status;
    expect(st.state).toBe('error');
    const fname = r.doc.state.get().doc.features.find((f) => f.id === fillet)!.name;
    const barName = r.doc.state.get().doc.features.find((f) => f.id === bar)!.name;
    // What the heal would have done (fill both sides of the stem: 16,395 mm³ more, on faces the bar and the stem made), that nothing changed, and the way that works.
    expect(st.message).toMatch(/^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d* mm³ over faces you kept \(/);
    expect(st.message).toContain(barName);
    expect(st.message).toContain(`; the body is unchanged. To take the whole fillet off, delete ${fname} instead`);
    const after = bodies(r)[0];
    expect(after.shape).toBe(before.shape);
    expect(after.faces).toBe(before.faces);
    expect(await volume(r, after.id)).toBeCloseTo(v0, 6);
  }, 120_000);

  it('a box with a through hole, every edge R1, Delete faces of every blend: ok, the holed box (no false refusal)', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await hole(r, 30, 20, 5, 20);
    await roundAll(r, 1);
    const del = await deleteFaces(r, (f) => f.type !== 'plane' && !(f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 5) < 1e-6));
    expect(del.status.state).toBe('ok');
    expect(close(await volume(r, bodies(r)[0].id), 48000 - Math.PI * 25 * 20)).toBe(true);
  }, 120_000);

  it('a pattern of faces whose heal fills the step is refused with the same words', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await block(r, [30, 0, 10], [30, 40, 10], 'cut');
    await roundAll(r, 2);
    const b = bodies(r)[0];
    const t = await topo(r, b);
    const refs = await Promise.all(t.faces.filter((f) => f.type !== 'plane').map((f) => faceRef(r, b, f.i)));
    const lp = await addFeature(r, 'pattern_linear', { of: 'faces', faceBody: b.id, faces: refs, op: 'join', dir1: { axis: { kind: 'origin', axis: 'origin:x' }, flip: false, count: '2', mode: 'spacing', distance: '70 mm', symmetric: false } });
    expect(lp.status.state).toBe('error');
    expect(lp.status.message).toMatch(/OCCT could not take those faces off Body 1 cleanly \(healing filled more than the gap the deleted faces leave: it would add .* over faces you kept/);
  }, 120_000);
});

// ---------------------------------------------------------------- the rule on the kernel corpus

type K = RealDoc['kernel'];
type Edge = TopoResult['edges'][number];
type Face = TopoResult['faces'][number];

function kit(r: RealDoc) {
  const k: K = r.kernel;
  const c = async (op: string, params: Record<string, unknown>) => (await k.call(op as never, params as never)).result as Record<string, any>;
  const id = async (op: string, params: Record<string, unknown>) => {
    const res = await c(op, params);
    expect(res.valid, `${op} valid`).not.toBe(false);
    return res.id as number;
  };
  const box = (dx: number, dy: number, dz: number, origin = [0, 0, 0]) => id('box', { dx, dy, dz, origin });
  const cyl = (rad: number, h: number, origin: number[]) => id('cylinder', { r: rad, h, origin, axis: [0, 0, 1] });
  const cut = (a: number, tools: number[]) => id('boolean', { op: 'cut', targets: [a], tools });
  const fuse = (a: number, tools: number[]) => id('boolean', { op: 'fuse', targets: [a], tools });
  const edges = async (s: number) => (await c('topo', { id: s, faces: 'none', vertices: 'none', edge_ends: true })).edges as Edge[];
  const faces = async (s: number) => (await c('topo', { id: s, edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true })).faces as Face[];
  const vol = async (s: number) => (await c('props', { id: s, volume: true, bbox: 'none' })).volume as number;
  /** A fillet / chamfer: the result and its blend faces (generated from an edge or a vertex). */
  const blend = async (op: 'fillet' | 'chamfer', s: number, es: number[], size: number) => {
    const res = await c(op, { id: s, edges: es, ...(op === 'fillet' ? { r: size } : { d: size }) });
    expect(res.valid).toBe(true);
    const made = (res.history as OpHistory).faces.filter((e) => e.from.some((x) => x.how === 'generated')).map((e) => e.out);
    return { id: res.id as number, blends: made.sort((a, b) => a - b) };
  };
  const ctx = {
    kernel: k,
    faces: async (s: number) => (await c('props', { id: s, bbox: 'none' })).faces as number,
    release: async (ids: number[]) => void (await c('release', { ids })),
  } as unknown as BuildContext;
  /** Defeature `rm` of `s` (as Delete faces calls it) and the heal check; the result's volume. */
  const run = async (s: number, rm: number[], name = ""): Promise<{ check: HealCheck; v: number }> => {
    const d = await c('defeature', { id: s, faces: rm });
    expect(d.warnings, `${name}: OCCT removed every face`).toBe(false);
    const check = await checkHeal(ctx, s, rm, d as { id: number; history: OpHistory });
    const v = await vol(d.id);
    await ctx.release([d.id]);
    return { check, v };
  };
  return { c, ctx, box, cyl, cut, fuse, edges, faces, vol, blend, run, extrude: (profile: unknown, d: number) => id('extrude', { profile, extent: { kind: 'blind', d } }) };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const along = (e: Edge, axis: number) => e.type === 'line' && !!e.dir && near(Math.abs(e.dir[axis]), 1);

describe('the heal check on the real kernel: every wrong fill refused', () => {
  it('bodies with every edge rounded around a cavity heal into their box: all refused (lost and covered faces)', async () => {
    const r = await part();
    const K = kit(r);
    const cases: [string, () => Promise<number>, number][] = [
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 2],
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 1],
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 4],
      ['U-channel', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 42, 11, [20, -1, 10])]), 2],
      ['T-block', async () => K.fuse(await K.box(60, 40, 10, [0, 0, 10]), [await K.box(20, 40, 10, [20, 0, 0])]), 2],
      ['pocket', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 10, 9, [20, 15, 12])]), 1],
      ['pocket', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 10, 9, [20, 15, 12])]), 3],
      ['slot', async () => K.cut(await K.box(60, 40, 20), [await K.box(62, 10, 5, [-1, 15, 15])]), 1],
      ['side step', async () => K.cut(await K.box(60, 40, 20), [await K.box(11, 42, 6, [50, -1, 15])]), 1],
    ];
    for (const [name, make, rad] of cases) {
      const s = await make();
      const sharp = await K.vol(s);
      const f = await K.blend('fillet', s, (await K.edges(s)).map((e) => e.i), rad);
      const { check, v } = await K.run(f.id, f.blends, name);
      // The repro: OCCT's result is the full 60 x 40 x 20 box, valid and without a warning.
      expect(v, name).toBeCloseTo(48000, 3);
      expect(v - sharp, name).toBeGreaterThan(1000);
      expect(healRefused(check), `${name} R${rad} refused`).toBe(true);
      expect(check.lost.length, name).toBeGreaterThan(0);
      expect(check.covered.length, name).toBeGreaterThan(0);
      // Two goes: the sharp body, except the T-block (a cavity each side of its stem).
      const again = await retryHoldBack(K.ctx, f.id, f.blends, [...check.lost, ...check.covered]);
      if (name === 'T-block') {
        expect(again, name).toBeNull();
      } else {
        expect(again, `${name} R${rad} in two goes`).not.toBeNull();
        expect(await K.vol(again!.second.id), `${name} R${rad} in two goes`).toBeCloseTo(sharp, 3);
        await K.ctx.release([again!.first.id, again!.second.id]);
      }
    }
  }, 120_000);

  it('the L-block\'s blends but one: refused unless the kept blend borders the step; kept tori grown into the step corner refused too', async () => {
    const r = await part();
    const K = kit(r);
    const L = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const f = await K.blend('fillet', L, (await K.edges(L)).map((e) => e.i), 2);
    const fs = await K.faces(f.id);
    const tori = f.blends.filter((i) => fs[i].type === 'torus');
    expect(tori).toHaveLength(2);
    // Keeping one mixed-corner torus: the riser and the floor survive as slivers (no face lost), the step still filled.
    const t = await K.run(f.id, f.blends.filter((i) => i !== tori[0]));
    expect(t.v).toBeGreaterThan(47000);
    expect(t.check.lost).toEqual([]);
    expect(healRefused(t.check)).toBe(true);
    // Keeping both tori: OCCT grows them into the step's corner (+258.7 mm³ over the sharp L with no fill).
    const both = await K.run(f.id, f.blends.filter((i) => !tori.includes(i)));
    expect(both.v).toBeGreaterThan(36100);
    expect(both.check.lost).toEqual([]);
    expect(healRefused(both.check)).toBe(true);
    // Keeping a convex fillet on the riser's top edge: the right body (the sharp L with that edge round), accepted.
    const riserTop = fs.find((x) => x.type === 'cylinder' && near(x.bbox![0], 28) && near(x.bbox![3], 30) && near(x.bbox![5], 20))!;
    const ok = await K.run(f.id, f.blends.filter((i) => i !== riserTop.i));
    expect(ok.v).toBeLessThan(36000);
    expect(ok.v).toBeGreaterThan(35960);
    expect(healRefused(ok.check)).toBe(false);
  }, 120_000);
});

describe('the heal check on the real kernel: no right removal refused', () => {
  it('holes, bosses, a pocket, a slot (each healed exactly)', async () => {
    const r = await part();
    const K = kit(r);
    const B = () => K.box(60, 40, 20);
    const inBox = (f: Face, b: number[]) => f.bbox![0] >= b[0] - 1e-6 && f.bbox![1] >= b[1] - 1e-6 && f.bbox![2] >= b[2] - 1e-6 && f.bbox![3] <= b[3] + 1e-6 && f.bbox![4] <= b[4] + 1e-6 && f.bbox![5] <= b[5] + 1e-6;
    const cases: [string, () => Promise<number>, (f: Face) => boolean, number][] = [
      ['through hole r4', async () => K.cut(await B(), [await K.cyl(4, 22, [20, 20, -1])]), (f) => f.type === 'cylinder', 48000],
      ['blind hole r4', async () => K.cut(await B(), [await K.cyl(4, 11, [20, 20, 10])]), (f) => f.type === 'cylinder' || (f.type === 'plane' && near(f.centroid![2], 10) && near(f.centroid![0], 20) && near(f.centroid![1], 20)), 48000],
      ['through hole r15', async () => K.cut(await B(), [await K.cyl(15, 22, [30, 20, -1])]), (f) => f.type === 'cylinder', 48000],
      ['round boss', async () => K.fuse(await K.box(60, 40, 10), [await K.cyl(8, 10, [30, 20, 10])]), (f) => f.type === 'cylinder' || (f.type === 'plane' && near(f.centroid![2], 20)), 24000],
      ['rect boss', async () => K.fuse(await K.box(60, 40, 10), [await K.box(20, 10, 6, [20, 15, 10])]), (f) => f.centroid![2] > 10 + 1e-6, 24000],
      ['big rect boss', async () => K.fuse(await K.box(60, 40, 10), [await K.box(40, 30, 10, [10, 5, 10])]), (f) => f.centroid![2] > 10 + 1e-6, 24000],
      ['pocket', async () => K.cut(await B(), [await K.box(20, 10, 9, [20, 15, 12])]), (f) => inBox(f, [20, 15, 12, 40, 25, 20]), 48000],
      ['slot', async () => K.cut(await B(), [await K.box(62, 10, 5, [-1, 15, 15])]), (f) => inBox(f, [-1, 15, 15, 61, 25, 20]) && f.bbox![3] - f.bbox![0] > 59, 48000],
    ];
    for (const [name, make, pick, want] of cases) {
      const s = await make();
      const rm = (await K.faces(s)).filter(pick).map((f) => f.i);
      const { check, v } = await K.run(s, rm, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('fillets and chamfers: one edge, a concave edge, every edge of a box, ring fillets round a boss, rounded holed boxes and plates', async () => {
    const r = await part();
    const K = kit(r);
    const box = await K.box(60, 40, 20);
    const lblock = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const topX = (await K.edges(box)).find((e) => along(e, 0) && near(e.mid![1], 0) && near(e.mid![2], 20))!.i;
    const concave = (await K.edges(lblock)).find((e) => along(e, 1) && near(e.mid![0], 30) && near(e.mid![2], 10))!.i;
    const boss = await K.fuse(await K.box(60, 40, 10), [await K.cyl(10, 10, [30, 20, 10])]);
    const ring = async (s: number, z: number) => (await K.edges(s)).find((e) => e.type === 'circle' && near(e.center![2], z))!.i;
    const ringRef = 24000 + Math.PI * 100 * 10;
    const foot = await K.blend('fillet', boss, [await ring(boss, 10)], 3);
    const both = await K.blend('fillet', foot.id, [await ring(foot.id, 20)], 2);
    const bothTori = (await K.faces(both.id)).filter((f) => f.type === 'torus').map((f) => f.i);
    const cases: [string, Promise<{ id: number; blends: number[] }>, number][] = [
      ['convex fillet R4', K.blend('fillet', box, [topX], 4), 48000],
      ['concave fillet R4', K.blend('fillet', lblock, [concave], 4), 36000],
      ['concave fillet R2', K.blend('fillet', lblock, [concave], 2), 36000],
      ['chamfer 4', K.blend('chamfer', box, [topX], 4), 48000],
      ['concave chamfer 4', K.blend('chamfer', lblock, [concave], 4), 36000],
      ['box every edge R4', K.blend('fillet', box, (await K.edges(box)).map((e) => e.i), 4), 48000],
      ['ring fillet R3 at a boss foot', Promise.resolve(foot), ringRef],
      ['ring fillets at a boss foot and rim', Promise.resolve({ id: both.id, blends: bothTori }), ringRef],
      ['ring fillet R2 at a boss rim', K.blend('fillet', boss, [await ring(boss, 20)], 2), ringRef],
    ];
    for (const base of [
      ['box with a through hole r5, every edge R1', await K.cut(await K.box(60, 40, 20), [await K.cyl(5, 22, [30, 20, -1])])],
      ['plate with a round boss, every edge R1', await K.fuse(await K.box(60, 40, 10), [await K.cyl(8, 10, [30, 20, 10])])],
      ['plate with a rect boss, every edge R1', await K.fuse(await K.box(60, 40, 10), [await K.box(20, 10, 6, [20, 15, 10])])],
    ] as [string, number][]) {
      cases.push([base[0], K.blend('fillet', base[1], (await K.edges(base[1])).map((e) => e.i), 1), await K.vol(base[1])]);
    }
    for (const [name, made, want] of cases) {
      const f = await made;
      const { check, v } = await K.run(f.id, f.blends, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('a wedge\'s tip chamfer or round (the heal brings the tip back far from the small face), and a rounded holed box read back from BREP', async () => {
    const r = await part();
    const K = kit(r);
    for (const deg of [20, 10]) {
      const t = Math.tan((deg * Math.PI) / 180);
      const profile = {
        plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
        loops: [[
          { id: 'a', kind: 'line', a: [0, 0], b: [60, 0] },
          { id: 'b', kind: 'line', a: [60, 0], b: [0, 60 * t] },
          { id: 'c', kind: 'line', a: [0, 60 * t], b: [0, 0] },
        ]],
      };
      const w = await K.extrude(profile, 40);
      const want = await K.vol(w);
      const tip = (await K.edges(w)).find((e) => along(e, 1) && near(e.mid![0], 60))!.i;
      for (const [name, made] of [
        [`${deg} deg wedge, tip chamfer 1`, K.blend('chamfer', w, [tip], 1)],
        [`${deg} deg wedge, tip round 0.5`, K.blend('fillet', w, [tip], 0.5)],
      ] as const) {
        const f = await made;
        const { check, v } = await K.run(f.id, f.blends, name);
        expect(v, name).toBeCloseTo(want, 3);
        expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
      }
    }
    // A box with R5 vertical edges, its top chain R3 and two holes, written and read back as BREP: blends, then holes.
    const b = await K.box(60, 40, 20);
    const f1 = await K.blend('fillet', b, (await K.edges(b)).filter((e) => along(e, 2)).map((e) => e.i), 5);
    const top = (await K.faces(f1.id)).find((f) => f.type === 'plane' && f.normal![2] > 0.5 && near(f.centroid![2], 20))!.i;
    const f2 = await K.blend('fillet', f1.id, (await K.edges(f1.id)).filter((e) => e.faces.includes(top)).map((e) => e.i), 3);
    const made = await K.cut(await K.cut(f2.id, [await K.cyl(3, 22, [15, 20, -1])]), [await K.cyl(4, 11, [45, 20, 10])]);
    const bytes = (await r.kernel.call('brep_write', { ids: [made] })).buffers.brep;
    const A = (await r.kernel.call('brep_read', { check: true }, { bytes })).result.shapes[0].id;
    const fsA = await K.faces(A);
    const isHole = (f: Face) => f.type === 'cylinder' && ((near(f.radius!, 3) && Math.abs(f.axis!.dir[2]) > 0.5) || near(f.radius!, 4));
    const blends = fsA.filter((f) => (f.type === 'cylinder' && !isHole(f)) || f.type === 'torus').map((f) => f.i);
    const holes = fsA.filter((f) => isHole(f) || (f.type === 'plane' && near(f.centroid![2], 10) && near(f.centroid![0], 45))).map((f) => f.i);
    const holed = await K.cut(await K.cut(await K.box(60, 40, 20), [await K.cyl(3, 22, [15, 20, -1])]), [await K.cyl(4, 11, [45, 20, 10])]);
    for (const [name, rm, want] of [
      ['blends of the rounded holed box', blends, await K.vol(holed)],
      ['holes of the rounded holed box', holes, await K.vol(f2.id)],
    ] as [string, number[], number][]) {
      const { check, v } = await K.run(A, rm, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('a 200 x 100 plate with every edge R2 and 50 holes: the 20 blends, then the 50 holes', async () => {
    const r = await part();
    const K = kit(r);
    const plate = await K.box(200, 100, 10);
    const f = await K.blend('fillet', plate, (await K.edges(plate)).map((e) => e.i), 2);
    const tools: number[] = [];
    for (let i = 0; i < 10; ++i) for (let j = 0; j < 5; ++j) tools.push(await K.cyl(3, 12, [19 + 18 * i, 14 + 18 * j, -1]));
    const H = await K.cut(f.id, tools);
    const fs = await K.faces(H);
    const holeF = fs.filter((x) => x.type === 'cylinder' && near(x.radius!, 3) && Math.abs(x.axis!.dir[2]) > 0.5).map((x) => x.i);
    const blendF = fs.filter((x) => x.type !== 'plane' && !holeF.includes(x.i)).map((x) => x.i);
    expect(holeF).toHaveLength(50);
    expect(blendF).toHaveLength(20);
    const plain = await K.cut(await K.box(200, 100, 10), tools);
    for (const [name, rm, want] of [
      ['20 blends', blendF, await K.vol(plain)],
      ['50 holes', holeF, await K.vol(f.id)],
    ] as [string, number[], number][]) {
      const { check, v } = await K.run(H, rm, name);
      expect(v, name).toBeCloseTo(want, 2);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);
});
