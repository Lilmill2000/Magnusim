// @vitest-environment node
// Kernel API 8, recognize (Analysis Situs asiAlgo 2026.1.1): fillets and drilled holes found by
// their shape, on parts built here with kernel ops (and one STEP fixture, a variable fillet no
// kernel op makes). Gate G1 of the integration plan: on the parts as built and after a BREP round
// trip every true fillet and hole is found, nothing else outside the documented classes, with the
// fillet radius (a torus's tube radius), the widest bore and "through" right. The STEP round trip,
// B-spline, split-closed and loose-tolerance variants (debug_reshape) are recorded as they are.
// Also: every index is the face it names, refusals in words, the input unchanged, and the same
// answer from a fresh kernel and from one that has run 200 ops (gate G5).
// Until the shipped kernel is API 8 this runs on a dev kernel (CAD_KERNEL_DIR; tests/kernel/asi-lib.ts).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { call, importStep, loadKernel, tryCall, type R } from './kernel-lib';
import { api8Gate, FAMILY, familyPart, noTimings, partKit, poly, proofA, ringBoss, XY, type Kit } from './asi-lib';

const k = await loadKernel();
const { describe8 } = api8Gate(k);
const kit = partKit(k);

const recognize = (id: number, extra: R = {}): R => call(k, 'recognize', { id, ...extra });
const facesOf = (rec: R): number[] => rec.blends.map((b: R) => b.face);
const kinds = (rec: R): R => {
  const o: R = {};
  for (const b of rec.blends) o[b.kind] = (o[b.kind] ?? 0) + 1;
  return o;
};
/** Each hole as {types of its faces in order, d_min, d_max, through}. */
const holeRows = (kt: Kit, id: number, rec: R) => {
  const fs = kt.faces(id);
  return rec.holes.map((h: R) => ({ faces: h.faces.map((i: number) => fs[i].type), d_min: h.d_min, d_max: h.d_max, through: h.through }));
};
const brepBytes = (id: number): string => Buffer.from(k.takeBuffers(k.call('brep_write', { ids: [id] })).brep as Uint8Array).toString('base64');

describe8('recognize (API 8)', () => {
  it('version answers api 8 with Analysis Situs 2026.1.1', () => {
    expect(call(k, 'version')).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 8, asi: '2026.1.1' });
  });

  it('the Step 0 family rounded R1 and R2 on every edge: every fillet face found and nothing else, radius exact, one chain', () => {
    // [edge fillets, vertex blends] per part.
    const expected: Record<string, number[]> = { T: [24, 16], I: [36, 24], plus: [36, 24], comb: [60, 40], Z: [24, 16], L: [18, 12] };
    for (const name of Object.keys(FAMILY)) {
      for (const r of name === 'L' ? [2] : [1, 2]) {
        const p = familyPart(kit, name, r);
        const rec = recognize(p.id);
        const what = `${name} R${r}`;
        expect(facesOf(rec), what).toEqual(p.truth);
        expect(kinds(rec), what).toEqual({ ordinary: expected[name][0], vertex: expected[name][1] });
        for (const b of rec.blends) {
          expect(b.r_min, what).toBeCloseTo(r, 9);
          expect(b.r_max, what).toBeCloseTo(r, 9);
          expect(b.chain, what).toBe(0);
        }
        expect(rec.chains, what).toHaveLength(1);
        expect(rec.chains[0].faces, what).toEqual(p.truth);
        expect(rec.holes, what).toEqual([]);
        expect(rec, what).toMatchObject({ faces: p.truth.length + p.sharpFaces, solids: 1 });
        // Every index is the face it names: a fillet face of the part (topo agrees: not a plane).
        const fs = kit.faces(p.id);
        for (const b of rec.blends) expect(fs[b.face].type, what).not.toBe('plane');
        kit.release(p.id, p.sharp);
      }
    }
  });

  it('only the edges along the extrusion rounded: one chain per round, convex and concave told apart', () => {
    for (const [name, r, n, concave] of [
      ['T', 2, 8, 2],
      ['comb', 1, 20, 8],
      ['I', 2, 12, 4],
      ['Z', 2, 8, 2],
    ] as [string, number, number, number][]) {
      const p = familyPart(kit, name, r, 'lat');
      const rec = recognize(p.id);
      expect(facesOf(rec), name).toEqual(p.truth);
      expect(p.truth, name).toHaveLength(n);
      expect(rec.chains, name).toHaveLength(n);
      expect(rec.chains.every((c: R) => c.faces.length === 1 && Math.abs(c.r_min - r) < 1e-9 && Math.abs(c.length - FAMILY[name].depth) < 1e-6), name).toBe(true);
      expect(rec.blends.filter((b: R) => b.convex === false), name).toHaveLength(concave);
      expect(rec.blends.filter((b: R) => b.convex === true), name).toHaveLength(n - concave);
      expect(kinds(rec), name).toEqual({ ordinary: n });
    }
  });

  it("max_r: Analysis Situs' own limit, the set suppress_blends would take (the T rounded R2, then its end faces' edges R1)", () => {
    const lat = familyPart(kit, 'T', 2, 'lat');
    const caps = kit.edges(lat.id).filter((e) => [e.first, e.last].every((q) => Math.abs(q[1]) < 1e-9) || [e.first, e.last].every((q) => Math.abs(Math.abs(q[1]) - 40) < 1e-9)).map((e) => e.i);
    const two = kit.fillet(lat.id, caps, 1);
    const all = recognize(two.id);
    expect(all.blends).toHaveLength(40);
    const small = recognize(two.id, { max_r: 1.001, holes: false });
    expect(facesOf(small)).toEqual(two.made);
    expect(facesOf(small)).toEqual(all.blends.filter((b: R) => b.r_max < 1.5).map((b: R) => b.face));
    expect(facesOf(recognize(two.id, { max_r: 2.002 }))).toEqual(facesOf(all));
    expect(recognize(two.id, { max_r: 0.5 }).blends).toEqual([]);
    expect(tryCall(k, 'recognize', { id: two.id, max_r: 0 })).toMatchObject({ ok: false, kind: 'input', error: 'max_r must be > 0' });
  });

  it("the proof's part A: 4 R5 and 8 R3 fillet faces, a 6 mm through hole and an 8 mm hole 10 deep", () => {
    const a = proofA(kit);
    const rec = recognize(a.id);
    expect(a.r5).toHaveLength(4);
    expect(a.rTop).toHaveLength(8);
    expect(facesOf(rec)).toEqual([...a.r5, ...a.rTop].sort((x, y) => x - y));
    for (const b of rec.blends) {
      const want = a.r5.includes(b.face) ? 5 : 3;
      expect(b.r_min).toBeCloseTo(want, 9);
      expect(b.r_max).toBeCloseTo(want, 9);
    }
    expect(kinds(rec)).toEqual({ ordinary: 8, vertex: 4 });
    expect(holeRows(kit, a.id, rec)).toEqual([
      { faces: ['cylinder'], d_min: 6, d_max: 6, through: true },
      { faces: ['cylinder', 'plane'], d_min: 8, d_max: 8, through: false },
    ]);
    // Hard mode finds the same holes here.
    expect(recognize(a.id, { blends: false, holes_mode: 'hard' }).holes).toEqual(rec.holes);
    expect(recognize(a.id, { blends: false }).blends).toEqual([]);
    expect(recognize(a.id, { holes: false }).holes).toEqual([]);
  });

  it('a box with every edge R4: 12 edge fillets and 8 vertex blends; a chamfered box has no fillets', () => {
    const b = kit.box(60, 40, 20);
    const f = kit.filletAll(b, 4);
    const rec = recognize(f.id);
    expect(facesOf(rec)).toEqual(f.made);
    expect(kinds(rec)).toEqual({ ordinary: 12, vertex: 8 });
    expect(rec.blends.every((x: R) => Math.abs(x.r_min - 4) < 1e-9 && Math.abs(x.r_max - 4) < 1e-9 && x.convex === true)).toBe(true);
    const ch = kit.ok('chamfer', { id: b, edges: kit.edges(b).map((e) => e.i), d: 3 });
    expect(recognize(ch.id)).toMatchObject({ faces: 26, blends: [], chains: [], holes: [] });
  });

  it("ring fillets: the tube radius (R3 concave foot, R2 convex rim), not the ring's", () => {
    const p = ringBoss(kit);
    const rec = recognize(p.id);
    expect(facesOf(rec)).toEqual([...p.foot, ...p.rim].sort((a, b) => a - b));
    const fs = kit.faces(p.id);
    const foot = rec.blends.find((b: R) => b.face === p.foot[0]);
    const rim = rec.blends.find((b: R) => b.face === p.rim[0]);
    expect(foot).toMatchObject({ r: 3, r_min: 3, r_max: 3, convex: false, kind: 'ordinary' });
    expect(rim).toMatchObject({ r: 2, r_min: 2, r_max: 2, convex: true, kind: 'ordinary' });
    expect(fs[p.foot[0]]).toMatchObject({ type: 'torus', radius: 13, minor_radius: 3 });
    expect(fs[p.rim[0]]).toMatchObject({ type: 'torus', radius: 8, minor_radius: 2 });
  });

  it('a variable fillet 2 -> 6 (fixtures/kernel/variable-fillet.step): r_min 2 and r_max 6, where Analysis Situs alone reads one sample', () => {
    const imp = importStep(k, 'variable-fillet.step');
    const id = imp.shapes[0].id;
    const fs = kit.faces(id);
    expect(fs.map((f) => f.type)).toEqual(['plane', 'plane', 'bspline', 'plane', 'plane', 'plane', 'plane']);
    const rec = recognize(id);
    expect(rec.blends).toHaveLength(1);
    const b = rec.blends[0];
    expect(b).toMatchObject({ face: 2, kind: 'ordinary', chain: 0 });
    expect(Math.abs(b.r_min - 2) / 2).toBeLessThan(2e-3);
    expect(Math.abs(b.r_max - 6) / 6).toBeLessThan(2e-3);
    expect(b.r).toBeGreaterThan(3.9);
    expect(b.r).toBeLessThan(4.0);
  });

  it('holes: the widest bore and "through" computed by the kernel (Analysis Situs gives the faces only)', () => {
    const tip = 3 / Math.tan((59 * Math.PI) / 180);
    const at = (cx: number, cy: number) => ({ origin: [cx, cy, 0], normal: [0, -1, 0], xdir: [1, 0, 0] });
    const revolveAt = (cx: number, cy: number, xz: number[][]) => kit.id('revolve', { profile: poly(xz, at(cx, cy)), axis: { origin: [cx, cy, 0], dir: [0, 0, 1] }, angle_deg: 360 });
    const base = () => kit.box(40, 40, 10);
    const cases: [string, () => number, R[]][] = [
      ['through 6', () => kit.cut(base(), kit.cyl(3, 12, [20, 20, -1])), [{ faces: ['cylinder'], d_min: 6, d_max: 6, through: true }]],
      ['blind 8, flat bottom', () => kit.cut(base(), kit.cyl(4, 6, [20, 20, 5])), [{ faces: ['cylinder', 'plane'], d_min: 8, d_max: 8, through: false }]],
      ['blind 6, 118 degree drill point', () => kit.cut(base(), revolveAt(20, 20, [[0, 3], [3, 3 + tip], [3, 11], [0, 11]])), [{ faces: ['cylinder', 'cone'], d_min: 6, d_max: 6, through: false }]],
      ['through 6, 11 counterbore', () => kit.cut(base(), kit.cyl(3, 12, [20, 20, -1]), kit.cyl(5.5, 5, [20, 20, 6])), [{ faces: ['cylinder', 'cylinder', 'plane'], d_min: 6, d_max: 11, through: true }]],
      ['blind 6, 11 counterbore', () => kit.cut(base(), kit.cyl(3, 8, [20, 20, 3]), kit.cyl(5.5, 5, [20, 20, 6])), [{ faces: ['cylinder', 'plane', 'cylinder', 'plane'], d_min: 6, d_max: 11, through: false }]],
      ['through 6, 90 degree countersink', () => kit.cut(base(), kit.cyl(3, 12, [20, 20, -1]), revolveAt(20, 20, [[0, 4.5], [5.5, 10], [5.5, 11], [0, 11]])), [{ faces: ['cone', 'cylinder'], d_min: 6, d_max: 6, through: true }]],
      ['blind 6, countersink and drill point', () => kit.cut(base(), revolveAt(20, 20, [[0, 2], [3, 2 + tip], [3, 7], [5.5, 10.5], [5.5, 11], [0, 11]])), [{ faces: ['cone', 'cylinder', 'cone'], d_min: 6, d_max: 6, through: false }]],
      [
        'four on a plate',
        () => kit.cut(kit.box(60, 40, 10), kit.cyl(3, 12, [10, 10, -1]), kit.cyl(3, 12, [50, 10, -1]), kit.cyl(4, 6, [10, 30, 5]), kit.cyl(5, 12, [50, 30, -1])),
        [
          { faces: ['cylinder'], d_min: 6, d_max: 6, through: true },
          { faces: ['cylinder'], d_min: 6, d_max: 6, through: true },
          { faces: ['cylinder', 'plane'], d_min: 8, d_max: 8, through: false },
          { faces: ['cylinder'], d_min: 10, d_max: 10, through: true },
        ],
      ],
    ];
    for (const [what, make, rows] of cases) {
      const id = make();
      const rec = recognize(id);
      expect(rec.blends, what).toEqual([]);
      expect(holeRows(kit, id, rec), what).toEqual(rows);
      // Hard mode agrees on holes that meet nothing else.
      expect(recognize(id, { blends: false, holes_mode: 'hard' }).holes, what).toEqual(rec.holes);
    }
  });

  it('a hole whose rim is rounded: the rim is a fillet and part of the hole', () => {
    const h = kit.cut(kit.box(40, 40, 10), kit.cyl(3, 12, [20, 20, -1]));
    const rim = kit.edges(h).filter((e) => e.type === 'circle' && Math.abs(e.first[2] - 10) < 1e-9).map((e) => e.i);
    const f = kit.fillet(h, rim, 1);
    const rec = recognize(f.id);
    expect(rec.blends).toEqual([{ face: f.made[0], r: 1, r_min: 1, r_max: 1, convex: true, kind: 'ordinary', chain: 0 }]);
    expect(holeRows(kit, f.id, rec)).toEqual([{ faces: ['torus', 'cylinder'], d_min: 6, d_max: 6, through: true }]);
    expect(rec.holes[0].faces).toContain(f.made[0]);
  });

  it('a documented miss, as it is: cross-drilled holes (soft mode finds the narrower only; hard mode joins both)', () => {
    const cross = kit.cut(kit.box(40, 40, 40), kit.cyl(3, 42, [20, 20, -1]), kit.cyl(2, 42, [-1, 20, 20], [1, 0, 0]));
    expect(holeRows(kit, cross, recognize(cross))).toEqual([{ faces: ['cylinder'], d_min: 4, d_max: 4, through: true }]);
    const hard = recognize(cross, { blends: false, holes_mode: 'hard' });
    expect(holeRows(kit, cross, hard)).toEqual([{ faces: ['cylinder', 'cylinder', 'cylinder'], d_min: 4, d_max: 6, through: true }]);
  });

  it("holes drilled into a fillet along its normal are found exactly: blind 4 mm, and 4 mm through the bottom", () => {
    // A 60 x 40 x 20 box rounded R6 on its top front edge: the fillet's axis is at y 6, z 14, its
    // 45 degree point at (y, z) = (6 - 6/sqrt2, 14 + 6/sqrt2), its inward normal there (0, 1, -1).
    const rounded = () => {
      const b = kit.box(60, 40, 20);
      const edge = kit.edges(b).filter((e) => [e.first, e.last].every((p) => Math.abs(p[2] - 20) < 1e-9 && Math.abs(p[1]) < 1e-9)).map((e) => e.i);
      return kit.fillet(b, edge, 6).id;
    };
    const mid = [6 - 6 / Math.SQRT2, 14 + 6 / Math.SQRT2];
    // Each drill starts 3 mm (along y and z) outside that point: 15 long stops inside, 40 long leaves through the bottom.
    const start = [30, mid[0] - 3, mid[1] + 3];
    for (const [what, h, rows] of [
      ['blind', 15, [{ faces: ['cylinder', 'plane'], d_min: 4, d_max: 4, through: false }]],
      ['through', 40, [{ faces: ['cylinder'], d_min: 4, d_max: 4, through: true }]],
    ] as [string, number, R[]][]) {
      const body = rounded();
      const drilled = kit.cut(body, kit.cyl(2, h, start, [0, 1, -1]));
      // The drill really meets the body (S2's version of this test cut nothing).
      expect(kit.vol(body) - kit.vol(drilled), what).toBeGreaterThan(100);
      const rec = recognize(drilled);
      expect(rec.blends, what).toHaveLength(1);
      expect(rec.blends[0], what).toMatchObject({ r_min: 6, r_max: 6, kind: 'ordinary' });
      expect(holeRows(kit, drilled, rec), what).toEqual(rows);
      expect(recognize(drilled, { blends: false, holes_mode: 'hard' }).holes, what).toEqual(rec.holes);
    }
  });

  it('a body of two solids: each searched, indices in the body\'s own face map', () => {
    const one = (x: number) => kit.filletAll(kit.box(20, 20, 20, [x, 0, 0]), 2).id;
    const both = kit.fuse(one(0), one(50));
    const rec = recognize(both);
    expect(rec).toMatchObject({ faces: 52, solids: 2 });
    expect(rec.blends).toHaveLength(40);
    expect(kinds(rec)).toEqual({ ordinary: 24, vertex: 16 });
    const fs = kit.faces(both);
    expect(facesOf(rec)).toEqual(fs.filter((f) => f.type !== 'plane').map((f) => f.i));
    expect(rec.chains).toHaveLength(2);
    expect(rec.chains[0].faces.every((i: number) => (fs[i].centroid as number[])[0] < 25)).toBe(true);
    expect(rec.chains[1].faces.every((i: number) => (fs[i].centroid as number[])[0] > 25)).toBe(true);
  });

  it('refusals in words: a surface body, over the face limit (2,000 unless the call says), a bad mode', () => {
    const shell = importStep(k, 'box20-faces.step', { heal: false });
    expect(shell.shapes[0]).toMatchObject({ type: 'shell', faces: 6 });
    expect(tryCall(k, 'recognize', { id: shell.shapes[0].id })).toMatchObject({ ok: false, kind: 'input', error: 'no solid in this body (fillets and holes are found on solids only)' });
    const b = kit.box(10, 10, 10);
    expect(tryCall(k, 'recognize', { id: b, max_faces: 5 })).toMatchObject({ ok: false, kind: 'input', error: 'this body has 6 faces: fillets and holes are found on bodies of up to 5' });
    // A prism of 2,002 faces with no max_faces: refused before any work.
    const n = 2000;
    const pts = Array.from({ length: n }, (_, i) => [100 * Math.cos((2 * Math.PI * i) / n), 100 * Math.sin((2 * Math.PI * i) / n)]);
    const big = kit.id('extrude', { profile: poly(pts, XY), extent: { kind: 'blind', d: 10 }, check: false });
    expect(tryCall(k, 'recognize', { id: big })).toMatchObject({ ok: false, kind: 'input', error: 'this body has 2,002 faces: fillets and holes are found on bodies of up to 2,000' });
    expect(recognize(big, { max_faces: 2002 })).toMatchObject({ faces: 2002, blends: [], holes: [] });
    expect(tryCall(k, 'recognize', { id: b, holes_mode: 'firm' })).toMatchObject({ ok: false, kind: 'input', error: 'holes_mode must be soft or hard' });
    expect(tryCall(k, 'recognize', { id: 987654 })).toMatchObject({ ok: false, kind: 'input', error: 'unknown shape id 987654' });
    kit.release(big);
  });

  it('the input is unchanged: the same BREP bytes before and after', () => {
    for (const id of [proofA(kit).id, familyPart(kit, 'T', 2).id, ringBoss(kit).id]) {
      const before = brepBytes(id);
      recognize(id);
      recognize(id, { holes_mode: 'hard' });
      expect(brepBytes(id)).toBe(before);
    }
  });

  it('messy variants, recorded: BREP and STEP round trips, B-splines, closed faces split, tolerances x100', () => {
    const variants = (id: number): Record<string, number> => {
      const brep = k.takeBuffers(k.call('brep_write', { ids: [id] })).brep as Uint8Array;
      const step = k.takeBuffers(k.call('export_step', { shapes: [{ id, name: 'X' }], schema: 'AP214' })).step as Uint8Array;
      return {
        built: id,
        brep: call(k, 'brep_read', { ...k.putBytes(brep) }).shapes[0].id,
        step: call(k, 'import_step', { ...k.putBytes(step), name: 'x.step', heal: true, tol: 1e-3 }).shapes[0].id,
        bspline: call(k, 'debug_reshape', { id, bspline: true }).id,
        split: call(k, 'debug_reshape', { id, split_closed: true }).id,
        tol100: call(k, 'debug_reshape', { id, tolerance_scale: 100 }).id,
      };
    };
    // Fillets: all 40 of the rounded T-block found with radius 2 in every variant.
    const t = familyPart(kit, 'T', 2);
    for (const [name, id] of Object.entries(variants(t.id))) {
      const rec = recognize(id);
      expect(rec.blends, name).toHaveLength(40);
      expect(rec.blends.every((b: R) => Math.abs(b.r_min - 2) < 1e-6 && Math.abs(b.r_max - 2) < 1e-6), name).toBe(true);
      if (name !== 'split') expect(facesOf(rec), name).toEqual(t.truth);
    }
    // Holes: the four-hole plate. B-splines lose the sizes (no cylinder: d null, never "through");
    // split cylinders keep them with two faces each.
    const plate = kit.cut(kit.box(60, 40, 10), kit.cyl(3, 12, [10, 10, -1]), kit.cyl(3, 12, [50, 10, -1]), kit.cyl(4, 6, [10, 30, 5]), kit.cyl(5, 12, [50, 30, -1]));
    const asBuilt = recognize(plate).holes;
    for (const [name, id] of Object.entries(variants(plate))) {
      const h = recognize(id).holes.map((x: R) => [x.faces.length, x.d_min, x.d_max, x.through]);
      if (name === 'bspline')
        expect(h, name).toEqual([
          [1, null, null, false],
          [1, null, null, false],
          [2, null, null, false],
          [1, null, null, false],
        ]);
      else if (name === 'split')
        expect(h, name).toEqual([
          [2, 6, 6, true],
          [2, 6, 6, true],
          [3, 8, 8, false],
          [2, 10, 10, true],
        ]);
      else expect(recognize(id).holes, name).toEqual(asBuilt);
    }
  });

  it('the same answer from a fresh kernel and from one that has run 200 ops (gate G5)', async () => {
    const used = await loadKernel();
    const ukit = partKit(used);
    for (let i = 0; i < 50; i++) {
      const b = ukit.box(10 + i, 20, 30);
      const f = ukit.filletAll(b, 1 + (i % 3));
      ukit.release(b, f.id);
    }
    expect(Number(call(used, 'mem').shapes)).toBe(0);
    const build = (kt: Kit) => [proofA(kt).id, familyPart(kt, 'comb', 1).id, familyPart(kt, 'T', 2, 'lat').id, ringBoss(kt).id];
    const fresh = build(kit);
    const old = build(ukit);
    for (let i = 0; i < fresh.length; i++) {
      expect(noTimings(call(used, 'recognize', { id: old[i] }))).toEqual(noTimings(recognize(fresh[i])));
    }
  });
});
