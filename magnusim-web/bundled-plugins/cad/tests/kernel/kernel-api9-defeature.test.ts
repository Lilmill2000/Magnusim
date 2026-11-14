// @vitest-environment node
// Kernel API 9, defeature's time budget (2026-11-02). OCCT's heal (BRepAlgoAPI_Defeaturing, on
// BOPAlgo_RemoveFeatures) grows every face next to a removed round by the round's box diagonal,
// then trims the grown faces back. On the app's T-block (R2 on the 16 edges not along y, then R1 on
// the 8 along y; Delete faces' "Fillets up to 1 mm" = the 8 R1 rounds) it grows the R2 fillets'
// 2 mm corner pieces, B-splines of degree 7 x 8, 36 mm: 22 times past their own patch. Every
// intersection against them then crawls: the heal returns after 568 s natively and fails anyway,
// so the app's 20 s watchdog stopped the worker. The kernel now takes a budget (budget_ms), a
// shorter one for such far-grown faces (far_budget_ms) or none at all (far_skip), and answers
// `stopped` in time with the body unchanged; occt-patches/0002 makes OCCT poll the budget while it
// trims each grown face. A heal that is ok without a budget is the same with one.
// Review 2026-11-02: a far-grown face is also curved (the growth turns it more than half a turn):
// flat B-spline faces (a rib's or a heat sink's fin ends, as exporters write planes) grown 6 times
// their size heal in 0.4-7 s, and far_skip skipped those ok heals.
// On a kernel before API 9 these heals run for minutes: each test first checks the API.
// Every part is built here with kernel ops. Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { call, loadKernel, tryCall, type R } from './kernel-lib';
import { api8Gate, partKit, proofA, type Edge } from './asi-lib';

const k = await loadKernel();
const { describe8 } = api8Gate(k);
const kit = partKit(k);
const api = Number(call(k, 'version').api);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** An edge along y (the T-block's extrusion). */
const alongY = (e: Edge) => e.type === 'line' && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]) && !near(e.first[1], e.last[1]);
const brepBytes = (id: number): string => Buffer.from(k.takeBuffers(k.call('brep_write', { ids: [id] })).brep as Uint8Array).toString('base64');
const shapesStored = (): number => Number(call(k, 'mem').shapes);

/**
 * The app's T-block: a 60 x 40 x 10 bar on a 20 x 40 x 10 stem, along y. 'R2 first' is the one the
 * app builds (Fillet 1 R2 on the 16 edges not along y, Fillet 2 R1 on the 8 along y; the other order
 * is refused at Fillet 2 R2), 'R1 first' the other order built in the kernel. `ref` is the T with
 * only its R2 fillets. The picks are its fillets up to 1 mm, as Delete faces adds them: its 8 R1 rounds.
 */
function tBlock(order: 'R2 first' | 'R1 first') {
  const sharp = kit.fuse(kit.box(60, 40, 10, [0, 0, 10]), kit.box(20, 40, 10, [20, 0, 0]));
  const lateral = kit.edges(sharp).filter(alongY).map((e) => e.i);
  const caps = kit.edges(sharp).filter((e) => !alongY(e)).map((e) => e.i);
  expect([lateral.length, caps.length]).toEqual([8, 16]);
  let body: number;
  let ref = 0;
  if (order === 'R2 first') {
    ref = kit.id('fillet', { id: sharp, edges: caps, r: 2 });
    body = kit.id('fillet', { id: ref, edges: kit.edges(ref).filter(alongY).map((e) => e.i), r: 1 });
  } else {
    const a = kit.id('fillet', { id: sharp, edges: lateral, r: 1 });
    body = kit.id('fillet', { id: a, edges: kit.edges(a).filter((e) => !alongY(e)).map((e) => e.i), r: 2 });
  }
  const picks: number[] = call(k, 'recognize', { id: body, holes: false, max_r: 1.001 }).blends.map((b: R) => b.face);
  return { body, ref, picks };
}

describe8('defeature time budget (API 9)', () => {
  it("the app's T-block, its 8 R1 rounds: far_skip does not start OCCT's heal, which would grow 16 corner pieces of the R2 fillets 10 times their size", () => {
    expect(api, 'a kernel before API 9 runs this heal for minutes').toBeGreaterThanOrEqual(9);
    const t = tBlock('R2 first');
    expect(kit.nFaces(t.body)).toBe(50);
    expect(t.picks).toHaveLength(8);
    const faces = kit.faces(t.body);
    expect(t.picks.every((p) => faces[p].type === 'cylinder' && near(faces[p].radius!, 1))).toBe(true);
    const stored = shapesStored();
    const t0 = performance.now();
    const r = call(k, 'defeature', { id: t.body, faces: t.picks, far_budget_ms: 2500, far_skip: true });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.id).toBeUndefined();
    expect(r.stopped).toMatchObject({ budget_ms: 0, skipped: true });
    // The corner pieces where each R1 round meets the R2 fillets: B-splines next to the picks, grown
    // by the round's box diagonal (36 mm) about 10.4 times their own (3.5 mm).
    expect(r.stopped.far_grown).toHaveLength(16);
    expect(r.stopped.far_grown.every((f: number) => faces[f].type === 'bspline')).toBe(true);
    expect(r.stopped.far_ratio).toBeGreaterThan(10);
    expect(r.stopped.far_ratio).toBeLessThan(11);
    // far_skip alone finds them too.
    expect(call(k, 'defeature', { id: t.body, faces: t.picks, far_skip: true }).stopped).toMatchObject({ budget_ms: 0, skipped: true, far_grown: r.stopped.far_grown });
    expect(shapesStored()).toBe(stored);
    // The reference the app's result is held to: the T with only its R2 fillets.
    expect(kit.nFaces(t.ref)).toBe(26);
    expect(kit.vol(t.ref)).toBeCloseTo(31731.445350199, 5);
    kit.release(t.body, t.ref);
  }, 60_000);

  it('a budget stops the heal at its first progress poll after it (occt-patches/0002: OCCT polls while it trims each grown face); the body is unchanged and nothing is kept', () => {
    expect(api, 'a kernel before API 9 runs this heal for minutes').toBeGreaterThanOrEqual(9);
    const t = tBlock('R1 first');
    expect(t.picks).toHaveLength(8);
    const before = brepBytes(t.body);
    const stored = shapesStored();
    const r = call(k, 'defeature', { id: t.body, faces: t.picks, budget_ms: 2000 });
    expect(r.id).toBeUndefined();
    // A stop names the faces the heal grows far past their size (looked up for any budget): the 12
    // corner pieces, curved, so that the words can say so.
    expect(r.stopped).toMatchObject({ budget_ms: 2000 });
    expect(r.stopped.far_grown).toHaveLength(12);
    expect(r.stopped.skipped).toBeUndefined();
    expect(r.stopped.after_ms).toBeGreaterThan(2000);
    // Measured: 2.01 s. Without 0002 OCCT did not poll for 8-11 s while it trimmed one grown face.
    expect(r.stopped.after_ms).toBeLessThan(5000);
    // far_budget_ms is the budget instead when the heal would grow a kept curved face far past its
    // size (12 corner pieces here), and the smaller of the two when both are given.
    const far = call(k, 'defeature', { id: t.body, faces: t.picks, budget_ms: 16000, far_budget_ms: 1000 });
    expect(far.stopped).toMatchObject({ budget_ms: 1000 });
    expect(far.stopped.far_grown).toHaveLength(12);
    expect(far.stopped.after_ms).toBeGreaterThan(1000);
    expect(far.stopped.after_ms).toBeLessThan(4000);
    expect(brepBytes(t.body)).toBe(before);
    expect(shapesStored()).toBe(stored);
    // The kernel goes on.
    expect(call(k, 'props', { id: t.body, bbox: 'none' }).faces).toBe(50);
    kit.release(t.body);
  }, 60_000);

  it('a heal that is ok without a budget gives the same result with one: the same BREP bytes, history, validity and warnings', () => {
    // Part A's two holes, and its R3 round of the top face.
    const a = proofA(kit);
    const holes: number[] = call(k, 'recognize', { id: a.id }).holes.flatMap((h: R) => h.faces);
    for (const faces of [holes, a.rTop]) {
      const plain = call(k, 'defeature', { id: a.id, faces });
      const timed = call(k, 'defeature', { id: a.id, faces, budget_ms: 16000, far_budget_ms: 2500, far_skip: true });
      expect(plain.valid).toBe(true);
      expect(timed.stopped).toBeUndefined();
      expect(timed.far_grown).toBeUndefined();
      expect(brepBytes(timed.id)).toBe(brepBytes(plain.id));
      expect(timed.history).toEqual(plain.history);
      for (const key of ['valid', 'faces', 'warnings', 'warning_text']) expect(timed[key], key).toEqual(plain[key]);
      kit.release(plain.id, timed.id);
    }
    kit.release(a.id);
  }, 60_000);

  it('flat B-spline faces grown far are not far-grown (their heal finishes): far_skip starts it, the result is the plain heal; B-spline corner pieces still are', () => {
    expect(api).toBeGreaterThanOrEqual(9);
    const topLong = (s: number, z: number) => kit.edges(s).filter((e) => e.type === 'line' && near(e.first[2], z) && near(e.last[2], z) && !near(e.first[0], e.last[0]));
    const bspline = (id: number) => call(k, 'debug_reshape', { id, bspline: true }).id as number;
    const blends = (id: number, maxR?: number): number[] => call(k, 'recognize', { id, holes: false, ...(maxR ? { max_r: maxR * 1.001 } : {}) }).blends.map((b: R) => b.face);
    // A 60 x 2 x 10 rib, its two long top edges R0.5, every surface a B-spline: its 2 mm wide ends
    // (flat) are grown 5.9 times their size.
    const bar = kit.box(60, 2, 10);
    const rib = bspline(kit.fillet(bar, topLong(bar, 10).map((e) => e.i), 0.5).id);
    // A heat sink: a 70 x 30 x 4 base with 5 fins 60 x 1 x 10 set 5 mm in, fin tops R0.4, B-spline:
    // its 10 fin ends (flat, 1 x 10 mm) are grown 6 times their size.
    let sink = kit.box(70, 30, 4);
    for (let i = 0; i < 5; i++) sink = kit.fuse(sink, kit.box(60, 1, 10, [5, 3 + 6 * i, 4]));
    sink = bspline(kit.fillet(sink, topLong(sink, 14).map((e) => e.i), 0.4).id);
    for (const [body, faces] of [[rib, blends(rib)], [sink, blends(sink, 0.4)]] as const) {
      const plain = call(k, 'defeature', { id: body, faces });
      expect(plain.valid).toBe(true);
      expect(plain.warnings).toBe(false);
      // The budget is only room for the heal to finish: a shared CI runner (GitHub sets CI)
      // took over 20 s on 2026-11-14.
      const timed = call(k, 'defeature', { id: body, faces, budget_ms: process.env.CI ? 100000 : 20000, far_skip: true });
      expect(timed.stopped, 'not skipped').toBeUndefined();
      expect(timed.far_grown).toBeUndefined();
      expect(brepBytes(timed.id)).toBe(brepBytes(plain.id));
      expect(timed.history).toEqual(plain.history);
      kit.release(plain.id, timed.id, body);
    }
    // A box rounded R2 on every edge as B-splines: one edge round's corner pieces (curved, 2.8 mm
    // across, grown 4.7 times) are far-grown; that heal fails ("unable to remove the feature").
    const box = bspline(kit.filletAll(kit.box(40, 30, 20), 2).id);
    const one = blends(box)[0];
    const skip = call(k, 'defeature', { id: box, faces: [one], far_skip: true });
    expect(skip.stopped).toMatchObject({ skipped: true, far_grown: [expect.any(Number), expect.any(Number)] });
    const heal = call(k, 'defeature', { id: box, faces: [one], budget_ms: 20000 });
    expect(heal).toMatchObject({ warnings: true, warning_text: 'BOPAlgo_AlertUnableToRemoveTheFeature' });
    kit.release(heal.id, box);
  }, process.env.CI ? 400_000 : 120_000);

  it('refusals in words: a budget must be > 0', () => {
    const b = kit.box(10, 10, 10);
    const face = kit.faces(b)[0].i;
    expect(tryCall(k, 'defeature', { id: b, faces: [face], budget_ms: 0 })).toMatchObject({ ok: false, kind: 'input', error: 'budget_ms must be > 0' });
    expect(tryCall(k, 'defeature', { id: b, faces: [face], far_budget_ms: -1 })).toMatchObject({ ok: false, kind: 'input', error: 'far_budget_ms must be > 0' });
    kit.release(b);
  });
});
