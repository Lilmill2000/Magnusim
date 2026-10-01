// @vitest-environment node
// Decision 3 (02 - P0 results): every modelling op reports `valid` from BRepCheck,
// with the reasons, and never passes an invalid result off as a success; `repair`
// can be offered on an invalid body. Booleans take a fuzzy value and OCCT's glue
// modes. The P0 known defect: Vortex fused with a 200 mm box on its top centre.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, circle, fingerprint, importStep, loadKernel, rect, REF, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
let vortex: number;
beforeAll(async () => {
  k = await loadKernel();
  vortex = importStep(k, 'vortex-cfd-test.step').shapes[0].id;
});

describe('every shape op reports valid', () => {
  it('primitives, extrude, revolve, booleans, split, fillet, chamfer, defeature, shell and repair', () => {
    const results: Record<string, R> = {};
    const box = (results.box = call(k, 'box', { dx: 20, dy: 20, dz: 20 }));
    results.cylinder = call(k, 'cylinder', { r: 5, h: 30, origin: [10, 10, -5] });
    results.sphere = call(k, 'sphere', { r: 4, center: [0, 0, 0] });
    results.extrude = call(k, 'extrude', { profile: rect(0, 0, 10, 5), extent: { kind: 'blind', d: 3 } });
    results.revolve = call(k, 'revolve', { profile: rect(5, 0, 8, 4, { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle_deg: 360 });
    results.boolean = call(k, 'boolean', { op: 'cut', targets: [box.id], tools: [results.cylinder.id] });
    results.split = call(k, 'split', { id: box.id, plane: { origin: [0, 0, 7], normal: [0, 0, 1] } });
    results.fillet = call(k, 'fillet', { id: box.id, edges: [0], r: 2 });
    results.chamfer = call(k, 'chamfer', { id: box.id, edges: [0, 1], d: 1 });
    const top = call(k, 'topo', { id: box.id, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.normal && f.normal[2] > 0.5).i;
    results.shell = call(k, 'shell', { id: box.id, faces: [top], t: 1 });
    results.defeature = call(k, 'defeature', { id: results.boolean.id, faces: [call(k, 'topo', { id: results.boolean.id, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'cylinder').i] });
    results.repair = call(k, 'repair', { id: box.id });
    for (const [op, r] of Object.entries(results)) {
      expect(r.valid, op).toBe(true);
      expect(typeof r.check_ms, op).toBe('number');
      expect(r.reason, op).toBeUndefined();
    }
    expect(results.split.pieces_valid).toEqual([true, true]);
    // Shell leaves a 1 mm wall: 20^3 - 18*18*19.
    expect(rel(volume(k, results.shell.id), 8000 - 18 * 18 * 19)).toBeLessThan(1e-9);
  });

  it('check:false skips the analysis and says so (the caller must check)', () => {
    const r = call(k, 'box', { dx: 1, dy: 1, dz: 1, check: false });
    expect(r.checked).toBe(false);
    expect(r.valid).toBeUndefined();
    expect(call(k, 'check', { id: r.id }).valid).toBe(true);
  });
});

describe('known defect (P0 verify): Vortex fused with a 200 mm box on its top centre', () => {
  const ref = REF.fuse_box200_topcentre;
  let box: number;
  let fuse: R;
  beforeAll(() => {
    box = call(k, 'box', { origin: ref.box.origin, dx: ref.box.dx, dy: ref.box.dy, dz: ref.box.dz }).id;
    fuse = call(k, 'boolean', { op: 'fuse', targets: [vortex], tools: [box] });
  });

  it('OCCT finishes the fuse, and the kernel reports it invalid with the reasons', () => {
    expect(fuse.valid).toBe(false);
    expect(fuse.reason).toMatch(/^invalid result \(BRepCheck\): .*UnorientableShape/);
    expect(fuse.problem_counts).toMatchObject({ UnorientableShape: 1 });
    const faces = call(k, 'props', { id: fuse.id }).faces;
    expect(faces).toBe(ref.faces);
    const bad = fuse.problems.find((p: R) => p.status === 'UnorientableShape');
    expect(bad.type).toBe('face');
    expect(bad.index).toBeGreaterThanOrEqual(0);
    expect(bad.index).toBeLessThan(faces);
    // The same invalid solid as natively (its volume is about 57,000 mm3 too small).
    expect(rel(volume(k, fuse.id), ref.volume)).toBeLessThan(1e-9);
    expect(call(k, 'check', { id: fuse.id })).toMatchObject({ valid: false, problem_counts: fuse.problem_counts });
  });

  it('repair makes it valid, and its volume agrees with the independent Monte Carlo estimate', () => {
    const rep = call(k, 'repair', { id: fuse.id });
    expect(rep.valid).toBe(true);
    expect(rep.fixed).toBe(true);
    const v = volume(k, rep.id);
    expect(rel(v, ref.shapefix_repaired.volume)).toBeLessThan(1e-9); // = native ShapeFix
    // V_vortex + V_box - V(common), with V(common) from 8 x 8192 Sobol points natively.
    const q = ref.qmc_common;
    const expected = REF.vortex.import.volume + 8e6 - q.mean;
    expect(Math.abs(v - expected)).toBeLessThan(3 * q.stderr);
    // The unrepaired result is ~10 standard errors off.
    expect(Math.abs(volume(k, fuse.id) - expected)).toBeGreaterThan(8 * q.stderr);
    // The history maps back onto the invalid body's faces (the input of repair).
    expect(rep.history.faces.length).toBeGreaterThan(0);
    expect(rep.history.faces.every((f: R) => f.from.every((s: R) => s.shape === fuse.id))).toBe(true);
  });

  it('a fuzzy value does not fix it (1e-5 .. 1e-2 mm)', () => {
    for (const fuzzy of [1e-5, 1e-4, 1e-3, 1e-2]) {
      const r = call(k, 'boolean', { op: 'fuse', targets: [vortex], tools: [box], fuzzy });
      expect(r.fuzzy).toBe(fuzzy);
      expect(r.valid, `fuzzy ${fuzzy}`).toBe(false);
    }
  });

  it('the inputs are unchanged by the fuse and the repair', () => {
    const before = fingerprint(k, vortex);
    call(k, 'repair', { id: call(k, 'boolean', { op: 'fuse', targets: [vortex], tools: [box] }).id });
    expect(fingerprint(k, vortex)).toEqual(before);
    expect(before.valid).toBe(true);
  });
});

describe('boolean options', () => {
  it('fuzzy joins bodies separated by a gap smaller than the fuzzy value', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const b = call(k, 'box', { origin: [10 + 1e-5, 0, 0], dx: 10, dy: 10, dz: 10 }).id;
    const plain = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [b] });
    expect(plain.solids).toBe(2);
    const fuzzy = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [b], fuzzy: 1e-4 });
    expect(fuzzy.valid).toBe(true);
    expect(fuzzy.solids).toBe(1);
    expect(call(k, 'props', { id: fuzzy.id }).faces).toBe(6); // one 20 x 10 x 10 box after unify
  });

  it('glue joins touching bodies (shift: partly shared faces, full: identical faces)', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const b = call(k, 'box', { origin: [10, 2, 2], dx: 5, dy: 5, dz: 5 }).id; // touches a's +X face, partly
    const c = call(k, 'box', { origin: [10, 0, 0], dx: 10, dy: 10, dz: 10 }).id; // shares a's whole +X face
    const shift = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [b], glue: 'shift' });
    expect(shift).toMatchObject({ valid: true, solids: 1, glue: 'shift' });
    expect(rel(volume(k, shift.id), 1000 + 125)).toBeLessThan(1e-12);
    const full = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [c], glue: 'full' });
    expect(full).toMatchObject({ valid: true, solids: 1, glue: 'full' });
    expect(call(k, 'props', { id: full.id }).faces).toBe(6);
    expect(rel(volume(k, full.id), 2000)).toBeLessThan(1e-12);
  });

  it('glue on bodies that really overlap gives a valid but wrong result (why it is off by default)', () => {
    const b = REF.fuse_box200_topcentre.box;
    const box = call(k, 'box', { origin: b.origin, dx: b.dx, dy: b.dy, dz: b.dz }).id;
    const glued = call(k, 'boolean', { op: 'fuse', targets: [vortex], tools: [box], glue: 'shift' });
    expect(glued.valid).toBe(true);
    // The overlap (about 3.6e6 mm3) is not removed: the volume is the plain sum.
    expect(rel(volume(k, glued.id), REF.vortex.import.volume + 8e6)).toBeLessThan(1e-5);
  });

  it('rejects unknown glue modes and negative fuzzy values', () => {
    const a = call(k, 'box', { dx: 1, dy: 1, dz: 1 }).id;
    expect(tryCall(k, 'boolean', { op: 'fuse', targets: [a], tools: [a], glue: 'yes' })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'boolean', { op: 'fuse', targets: [a], tools: [a], fuzzy: -1 })).toMatchObject({ ok: false, kind: 'input' });
  });

  it('several targets and several tools, with face history against every input', () => {
    const t1 = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const t2 = call(k, 'box', { origin: [20, 0, 0], dx: 10, dy: 10, dz: 10 }).id;
    const tool1 = call(k, 'cylinder', { r: 2, h: 20, origin: [5, 5, -5] }).id;
    const tool2 = call(k, 'cylinder', { r: 2, h: 20, origin: [25, 5, -5] }).id;
    const cut = call(k, 'boolean', { op: 'cut', targets: [t1, t2], tools: [tool1, tool2] });
    expect(cut).toMatchObject({ valid: true, solids: 2 });
    expect(rel(volume(k, cut.id), 2 * (1000 - Math.PI * 4 * 10))).toBeLessThan(1e-9);
    const sources = new Set(cut.history.faces.flatMap((f: R) => f.from.map((s: R) => s.shape)));
    expect([...sources].sort()).toEqual([t1, t2, tool1, tool2].sort());
  });
});

describe('the reasons', () => {
  it('name the BRepCheck statuses and where they are', () => {
    const b = REF.fuse_box200_topcentre.box;
    const box = call(k, 'box', { origin: b.origin, dx: b.dx, dy: b.dy, dz: b.dz }).id;
    const common = call(k, 'boolean', { op: 'common', targets: [vortex], tools: [box] });
    expect(common.valid).toBe(false);
    expect(common.problem_total).toBeGreaterThan(0);
    for (const p of common.problems as R[]) {
      expect(typeof p.status).toBe('string');
      expect(p.status).not.toMatch(/^BRepCheck_/);
      expect(['vertex', 'edge', 'wire', 'face', 'shell', 'solid', 'compsolid', 'compound']).toContain(p.type);
      expect(Number.isInteger(p.index)).toBe(true);
    }
    // Native: invalid 3,657,029 mm3; ShapeFix gives 3,599,695 (Monte Carlo 3,599,609 +- 5,573).
    expect(rel(volume(k, common.id), REF.fuse_box200_topcentre.common_volume_invalid)).toBeLessThan(1e-9);
    const rep = call(k, 'repair', { id: common.id });
    expect(rep.valid).toBe(true);
    expect(rel(volume(k, rep.id), REF.fuse_box200_topcentre.common_volume_after_shapefix)).toBeLessThan(1e-9);
  });

  it('an extrude of a circle on a tilted plane is valid (sanity for non-axis planes)', () => {
    const plane = { origin: [1, 2, 3], normal: [0.3, -0.2, 0.9], xdir: [1, 0, 0] };
    const r = call(k, 'extrude', { profile: circle(0, 0, 4, plane), extent: { kind: 'blind', d: 5 } });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), Math.PI * 16 * 5)).toBeLessThan(1e-9);
  });
});
