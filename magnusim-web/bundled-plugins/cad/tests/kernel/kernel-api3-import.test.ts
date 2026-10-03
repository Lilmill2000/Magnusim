// @vitest-environment node
// Kernel API 3 (docs/p2p3-plan.md §2.1-2.3, §2.5): `version` api 3, `faces` on every
// shape result, import_step diagnostics and unit, heal (ShapeFix + sewing = knit) on
// the surface-only fixtures, and the binary BREP round trip an import stores. The
// 113 MB part is opt-in (CAD_KERNEL_BIG_STEP) at the end of this file.
// Owner: KERNEL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, circle, fingerprint, fixture, importStep, importVortex, itVortex, loadKernel, PLUGIN, rect, REF, rel, tryCall, volume, vortexBytes, type R } from './kernel-lib';

const HEAL = REF.p2p3.heal;

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const read = (file: string, extra: R = {}) => call(k, 'import_step', { ...k.putBytes(fixture(file)), name: file, ...extra });
const readVortex = (extra: R = {}) => call(k, 'import_step', { ...k.putBytes(vortexBytes()), name: 'Vortex CFD Test.step', ...extra });

describe('version and face counts', () => {
  it('answers api 3', () => {
    expect(call(k, 'version')).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 3 });
  });

  it('every shape result says its face count (the naming layer needs no props call)', () => {
    const box = call(k, 'box', { dx: 20, dy: 20, dz: 20 });
    const out: Record<string, R> = { box };
    out.cylinder = call(k, 'cylinder', { r: 5, h: 30, origin: [10, 10, -5] });
    out.sphere = call(k, 'sphere', { r: 4 });
    out.extrude = call(k, 'extrude', { profile: rect(0, 0, 10, 5), extent: { kind: 'blind', d: 3 } });
    out.revolve = call(k, 'revolve', { profile: rect(5, 0, 8, 4, { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle_deg: 360 });
    out.boolean = call(k, 'boolean', { op: 'cut', targets: [box.id], tools: [out.cylinder.id] });
    out.fillet = call(k, 'fillet', { id: box.id, edges: [0], r: 2 });
    out.chamfer = call(k, 'chamfer', { id: box.id, edges: [0], d: 1 });
    out.defeature = call(k, 'defeature', { id: out.boolean.id, faces: [call(k, 'topo', { id: out.boolean.id, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'cylinder').i] });
    out.shell = call(k, 'shell', { id: box.id, faces: [0], t: 1 });
    out.repair = call(k, 'repair', { id: box.id });
    out.unchecked = call(k, 'box', { dx: 1, dy: 1, dz: 1, check: false });
    for (const [op, r] of Object.entries(out)) expect(r.faces, op).toBe(call(k, 'props', { id: r.id, bbox: 'none' }).faces);
    expect(out.box.faces).toBe(6);
    expect(out.unchecked.checked).toBe(false);
    const split = call(k, 'split', { id: box.id, plane: { origin: [0, 0, 7], normal: [0, 0, 1] } });
    expect(split.faces).toEqual(split.ids.map((id: number) => call(k, 'props', { id, bbox: 'none' }).faces));
    expect(split.faces).toEqual([6, 6]);
  });
});

describe('import_step diagnostics (API 3)', () => {
  itVortex('Vortex: 1 closed solid, 17 faces, inch, 0 problems, as read and healed', () => {
    for (const heal of [false, true]) {
      const imp = readVortex({ heal });
      expect(imp.unit).toBe('inch');
      expect(imp.shapes).toHaveLength(1);
      expect(imp.shapes[0]).toMatchObject({ name: REF.vortex.import.name, type: 'solid', faces: 17, valid: true });
      expect(imp.diagnostics).toEqual({ total: 0, shapes: [{ id: imp.shapes[0].id, valid: true, problems: [], problem_counts: {}, problem_total: 0, free_edges: 0, closed: true }] });
      if (heal) expect(typeof imp.fixed).toBe('number');
      else expect(imp.fixed).toBeUndefined();
    }
  });

  it('flange: millimetre, 10 faces, 0 problems; diagnose:false leaves the diagnostics out', () => {
    const imp = read('flange.step', { heal: true });
    expect(imp.unit).toBe('millimetre');
    expect(imp.shapes[0]).toMatchObject({ type: 'solid', faces: REF.flange.import.faces, valid: true });
    expect(imp.diagnostics.total).toBe(0);
    expect(imp.diagnostics.shapes[0]).toMatchObject({ closed: true, free_edges: 0, problem_total: 0 });
    const quiet = read('flange.step', { diagnose: false });
    expect(quiet.diagnostics).toBeUndefined();
    expect(quiet.shapes[0].valid).toBeUndefined();
    expect(quiet.shapes[0].faces).toBe(10);
  });

  it('a surface-only STEP is one surface body with every edge open', () => {
    const imp = read('box20-faces.step', { heal: false });
    const ref = HEAL.box20_faces;
    expect(imp.unit).toBe('millimetre');
    expect(imp.shapes).toHaveLength(1);
    expect(imp.shapes[0]).toMatchObject({ name: ref.body_name, type: 'shell', faces: ref.as_read.faces, valid: true });
    expect(imp.edges).toBe(ref.as_read.edges);
    expect(imp.diagnostics.shapes[0]).toMatchObject({ valid: true, free_edges: ref.as_read.free_edges, closed: false });
  });

  it('a solid with a loose sheet under one STEP product: the sheet is kept as a surface body, not dropped', () => {
    const imp = read('box10-sheet.step', { heal: false });
    const ref = HEAL.box10_sheet;
    expect(imp.faces).toBe(ref.as_read.faces);
    expect(imp.shapes.map((s: R) => [s.name, s.type, s.faces])).toEqual([
      [ref.body_name, 'solid', 6],
      [ref.body_name, 'shell', 1],
    ]);
    expect(imp.diagnostics.shapes[1]).toMatchObject({ free_edges: 4, closed: false });
  });

  it('a file that is not STEP is an input error, never a trap', () => {
    const bad = tryCall(k, 'import_step', { ...k.putBytes(new TextEncoder().encode('not a step file')), name: 'x.step' });
    expect(bad).toMatchObject({ ok: false, kind: 'input' });
    expect(k.dead).toBeNull();
  });
});

describe('heal (API 3): ShapeFix, then sewing and solids from closed shells', () => {
  it('knits box20-faces into one valid 8,000 mm³ solid (native value), keeping the STEP name', () => {
    const imp = read('box20-faces.step', { heal: false });
    const raw = imp.shapes[0].id;
    const before = fingerprint(k, raw);
    const h = call(k, 'heal', { ids: [raw], tol: 0.001 });
    const ref = HEAL.box20_faces['heal_0.001'];
    expect(h.sewn).toBe(ref.faces_sewn);
    expect(h.free_edges).toBe(ref.free_edges);
    expect(h.shapes).toHaveLength(ref.solids);
    const s = h.shapes[0];
    expect(s).toMatchObject({ from: raw, name: HEAL.box20_faces.body_name, color: null, type: 'solid', faces: ref.faces, valid: ref.valid });
    expect(volume(k, s.id)).toBe(ref.volume);
    // History: every output face comes from one input face; none is lost.
    expect(s.history.faces.map((f: R) => f.out).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(s.history.faces.map((f: R) => f.from[0].face)).size).toBe(6);
    expect(s.history.faces.every((f: R) => f.from[0].shape === raw)).toBe(true);
    expect(h.deleted).toEqual([]);
    expect(h.diagnostics).toMatchObject({ total: 0, shapes: [{ id: s.id, valid: true, free_edges: 0, closed: true }] });
    // Work copies: the raw shape did not change.
    expect(fingerprint(k, raw)).toEqual(before);
  });

  it('box20-gap: 0.01 mm closes the 0.005 mm gap, 0.001 mm leaves it open (native values)', () => {
    const raw = read('box20-gap.step', { heal: false }).shapes[0].id;
    const closed = call(k, 'heal', { ids: [raw], tol: 0.01 });
    const r1 = HEAL.box20_gap['heal_0.01'];
    expect(closed.shapes).toHaveLength(1);
    expect(closed.shapes[0]).toMatchObject({ type: 'solid', faces: r1.faces, valid: true });
    expect(closed.free_edges).toBe(r1.free_edges);
    expect(rel(volume(k, closed.shapes[0].id), r1.volume)).toBeLessThan(1e-12);
    const open = call(k, 'heal', { ids: [raw], tol: 0.001 });
    const r2 = HEAL.box20_gap['heal_0.001'];
    expect(r2.solids).toBe(0);
    expect(open.shapes).toHaveLength(1);
    expect(open.shapes[0]).toMatchObject({ type: 'shell', faces: 6, from: raw, name: HEAL.box20_gap.body_name });
    expect(open.free_edges).toBe(r2.free_edges);
    expect(open.diagnostics.shapes[0]).toMatchObject({ free_edges: r2.free_edges, closed: false });
    // sew_tol on its own: ShapeFix at 0.001, sewing at 0.01.
    const mixed = call(k, 'heal', { ids: [raw], tol: 0.001, sew_tol: 0.01 });
    expect(mixed.shapes[0].type).toBe('solid');
  });

  itVortex('sew:false only fixes; a valid solid is never sewn; outputs follow the input order', () => {
    const faces = read('box20-faces.step', { heal: false }).shapes[0].id;
    const vortex = readVortex({ heal: false }).shapes[0].id;
    const noSew = call(k, 'heal', { ids: [faces], sew: false });
    expect(noSew.sewn).toBe(0);
    expect(noSew.shapes).toHaveLength(1);
    expect(noSew.shapes[0]).toMatchObject({ type: 'shell', from: faces });
    const both = call(k, 'heal', { ids: [vortex, faces], sew: 'auto' });
    expect(both.sewn).toBe(6);
    expect(both.shapes.map((s: R) => [s.from, s.type, s.faces])).toEqual([
      [vortex, 'solid', 17],
      [faces, 'solid', 6],
    ]);
    expect(both.shapes[0].name).toBe(REF.vortex.import.name);
    expect(rel(volume(k, both.shapes[0].id), REF.vortex.import.volume)).toBeLessThan(1e-9);
    const solidOnly = call(k, 'heal', { ids: [vortex], sew: true });
    expect(solidOnly.sewn).toBe(0);
    expect(solidOnly.shapes[0].history.faces).toHaveLength(17);
  });

  it('bad parameters are input errors', () => {
    const id = call(k, 'box', { dx: 1, dy: 1, dz: 1 }).id;
    expect(tryCall(k, 'heal', { ids: [] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'heal', { ids: [id, id] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'heal', { ids: [id], tol: 0 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'heal', { ids: [id], sew: 'sometimes' })).toMatchObject({ ok: false, kind: 'input' });
  });
});

/** Topo signatures equal to 1e-12 relative (BinTools stores doubles exactly; gp_Dir is normalised again on read). */
function sameTopo(a: R, b: R) {
  const close = (x: unknown, y: unknown, path: string): void => {
    if (typeof x === 'number' && typeof y === 'number') {
      expect(Math.abs(x - y), path).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(x)));
    } else if (Array.isArray(x) && Array.isArray(y)) {
      expect(y.length, path).toBe(x.length);
      x.forEach((v, i) => close(v, y[i], `${path}[${i}]`));
    } else if (x && typeof x === 'object' && y && typeof y === 'object') {
      const xo = x as R;
      const yo = y as R;
      const keys = (o: R) => Object.keys(o).filter((key) => key !== 'timings').sort();
      expect(keys(yo), path).toEqual(keys(xo));
      for (const key of Object.keys(xo)) if (key !== 'timings') close(xo[key], yo[key], `${path}.${key}`);
    } else {
      expect(y, path).toEqual(x);
    }
  };
  close(a, b, 'topo');
}

describe('brep_write / brep_read (API 3)', () => {
  itVortex('round-trips Vortex and flange with the same volumes, counts and sub-shape indices', () => {
    const v = importVortex(k).shapes[0].id;
    const f = importStep(k, 'flange.step').shapes[0].id;
    const w = call(k, 'brep_write', { ids: [v, f] });
    expect(w.occt).toBe('7.9.3');
    const bytes = k.takeBuffers(w as never).brep as Uint8Array;
    expect(bytes.length).toBe(w.bytes);
    expect(bytes.length).toBeGreaterThan(1000);
    const r = call(k, 'brep_read', { ...k.putBytes(bytes), check: true });
    expect(r.occt).toBe('7.9.3');
    expect(r.shapes.map((s: R) => [s.type, s.faces, s.valid])).toEqual([
      ['solid', 17, true],
      ['solid', 10, true],
    ]);
    for (const [a, b] of [
      [v, r.shapes[0].id],
      [f, r.shapes[1].id],
    ]) {
      const pa = call(k, 'props', { id: a, volume: true, area: true, bbox: 'exact' });
      const pb = call(k, 'props', { id: b, volume: true, area: true, bbox: 'exact' });
      for (const key of ['faces', 'edges', 'vertices', 'solids', 'shells', 'volume', 'area']) expect(pb[key], key).toBe(pa[key]);
      expect(pb.bbox).toEqual(pa.bbox);
      sameTopo(call(k, 'topo', { id: a }), call(k, 'topo', { id: b }));
    }
    // Without check the shapes do not say valid (the import stored it).
    const again = call(k, 'brep_read', { ...k.putBytes(bytes) });
    expect(again.shapes[0].valid).toBeUndefined();
  });

  it('refuses bytes that are not a BREP, without a trap', () => {
    expect(tryCall(k, 'brep_read', { ...k.putBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) })).toMatchObject({ ok: false, kind: 'input' });
    const box = call(k, 'box', { dx: 1, dy: 1, dz: 1 }).id;
    const half = k.takeBuffers(call(k, 'brep_write', { ids: [box] }) as never).brep as Uint8Array;
    expect(tryCall(k, 'brep_read', { ...k.putBytes(half.subarray(0, half.length >> 1)) })).toMatchObject({ ok: false });
    expect(tryCall(k, 'brep_write', { ids: [] })).toMatchObject({ ok: false, kind: 'input' });
    expect(k.dead).toBeNull();
  });

  it('keeps several bodies apart and in order (a surface body included)', () => {
    const faces = importStep(k, 'box20-faces.step', { heal: false }).shapes[0].id;
    const c = call(k, 'extrude', { profile: circle(0, 0, 3), extent: { kind: 'blind', d: 2 } }).id;
    const bytes = k.takeBuffers(call(k, 'brep_write', { ids: [c, faces] }) as never).brep as Uint8Array;
    const r = call(k, 'brep_read', { ...k.putBytes(bytes) });
    expect(r.shapes.map((s: R) => [s.type, s.faces])).toEqual([
      ['solid', 3],
      ['shell', 6],
    ]);
  });
});

// The 113 MB STEP: size and time of the BREP an import stores (opt-in).
const BIG = process.env.CAD_KERNEL_BIG_STEP;
describe.skipIf(!BIG)('the 113 MB STEP: diagnostics and BREP size and time (opt-in: CAD_KERNEL_BIG_STEP)', () => {
  it('imports with diagnostics, writes and reads its BREP with the same body; a split that loses a half says so', async () => {
    const big = await loadKernel();
    const ref = REF.large_step;
    const out: R = { file: BIG };
    const timed = <T>(name: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      out[name] = Math.round(performance.now() - t0);
      console.log(`[api3-bigstep] ${name}: ${out[name]} ms`);
      return r;
    };
    const bytes = new Uint8Array(readFileSync(BIG!));
    expect(bytes.length).toBe(ref.bytes);
    const imp = timed('import_heal_diagnose_ms', () => call(big, 'import_step', { ...big.putBytes(bytes), name: 'large.step', heal: true, diagnose: true }));
    out.import_timings = imp.timings;
    expect(imp.unit).toBe('millimetre');
    expect(imp.shapes).toHaveLength(1);
    expect(imp.shapes[0]).toMatchObject({ type: 'solid', faces: ref.healed_counts.faces, valid: true });
    expect(imp.diagnostics.shapes[0]).toMatchObject({ valid: true, problem_total: 0, free_edges: 0, closed: true });
    const id = imp.shapes[0].id;
    const w = timed('brep_write_ms', () => call(big, 'brep_write', { ids: [id] }));
    const brep = big.takeBuffers(w as never).brep as Uint8Array;
    out.brep_bytes = brep.length;
    console.log(`[api3-bigstep] brep: ${(brep.length / 2 ** 20).toFixed(1)} MB`);
    const r = timed('brep_read_ms', () => call(big, 'brep_read', { ...big.putBytes(brep) }));
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0]).toMatchObject({ type: 'solid', faces: ref.healed_counts.faces });
    const p0 = call(big, 'props', { id, bbox: 'none' });
    const p1 = call(big, 'props', { id: r.shapes[0].id, bbox: 'none' });
    for (const key of ['faces', 'edges', 'vertices', 'solids', 'shells']) expect(p1[key], key).toBe(p0[key]);
    const v1 = timed('volume_read_ms', () => call(big, 'props', { id: r.shapes[0].id, volume: true, bbox: 'none' }).volume);
    out.volume_rel = rel(v1, ref.volume);
    expect(rel(v1, ref.volume)).toBeLessThan(1e-9);
    // Index by index: a sample of faces and edges has the same signatures.
    const sel = { faces: { start: 5000, count: 50 }, edges: { start: 12000, count: 50 }, vertices: { start: 7000, count: 50 } };
    sameTopo(call(big, 'topo', { id, ...sel }), call(big, 'topo', { id: r.shapes[0].id, ...sel }));
    // OCCT's splitter drops one half of this part at its middle X plane (natively too):
    // the split must say it lost faces, not pass one half off as the whole.
    const bb = imp.bbox;
    const split = timed('split_mid_x_ms', () => call(big, 'split', { id, plane: { origin: [(bb[0] + bb[3]) / 2, 0, 0], normal: [1, 0, 0] } }));
    out.split_mid_x = { pieces: split.ids.length, faces: split.faces, lost_faces: split.lost_faces, valid: split.valid };
    if (split.ids.length < 2) {
      expect(split.lost_faces).toBeGreaterThan(0);
      expect(split.valid).toBe(false);
      expect(split.reason).toMatch(/^split lost part of the body: [0-9]+ of its faces are in no piece/);
    } else {
      expect(split.lost_faces).toBe(0);
    }
    out.heap_mb = Math.round(big.heapBytes() / 2 ** 20);
    mkdirSync(join(PLUGIN, '.cache'), { recursive: true });
    writeFileSync(join(PLUGIN, '.cache', 'kernel-api3-bigstep.json'), JSON.stringify(out, null, 1));
    console.log(`[api3-bigstep] ${JSON.stringify(out)}`);
  }, 1_200_000);
});

