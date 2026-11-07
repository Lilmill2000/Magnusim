// @vitest-environment node
// The page's recognition client (src/kernel/recognition.ts): one per kernel adapter, answers
// cached per shape and query and dropped on a kernel restart, and every refusal in words (over
// a face limit, no solid, a kernel below API 8, a failure) - never an empty answer. Two face
// limits (kernel API 9): fillets (a search without holes) 5,000 and holes (any search with them)
// 2,600, both sent, and a body over one is refused in words naming both, the one the search ran
// into first, as the kernel says it. With the real kernel behind the real adapter: the proof's
// part A as `recognize` answers it, the lowered limits (window.__CAD__.recognition) give the
// kernel's own words, and D7's fillets.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecognitionClient, isFillet, limitWords, oldKernelWords, overLimit, recognitionOf, summaryOf, tooLargeWords } from '../../src/kernel/recognition';
import { hasWords } from '../../src/features/delete_faces/words';
import { RECOGNIZE_MAX_FILLET_FACES, RECOGNIZE_MAX_HOLE_FACES } from '../../src/kernel/timeouts';
import { createStateStore } from '../../src/lib/store';
import type { KernelAdapter, KernelStatus } from '../../src/types/kernel';
import type { RecognizeResult } from '../../src/types/kernel-protocol';
import { realKernelAdapter } from '../doc/inprocess-kernel';
import { FIXTURES } from './kernel-lib';

type R = Record<string, any>;

const ANSWER: RecognizeResult = {
  faces: 21,
  solids: 1,
  blends: [
    { face: 3, r: 5, r_min: 5, r_max: 5, convex: true, kind: 'ordinary', chain: 0 },
    { face: 4, r: 3, r_min: 3, r_max: 3, convex: true, kind: 'vertex', chain: 0 },
    { face: 7, r: 1.4, r_min: 1.4, r_max: 1.41, convex: null, kind: 'cliff', chain: null },
    { face: 9, r: 2, r_min: 2, r_max: 2, convex: null, kind: 'uncertain', chain: null },
  ],
  chains: [{ faces: [3, 4], r_min: 3, r_max: 5, length: 100 }],
  holes: [
    { faces: [10], d_min: 6, d_max: 6, through: true },
    { faces: [11, 12], d_min: 8, d_max: 11, through: false },
    { faces: [13], d_min: null, d_max: null, through: false },
  ],
  timings: { copy_ms: 0, aag_ms: 0, blends_ms: 0, holes_ms: 0 },
};

/** A KernelAdapter whose `recognize` answers from `reply` (which may throw a kernel error). */
function fakeKernel(reply: (params: R) => R, api = 8) {
  const status = createStateStore<KernelStatus>({ state: 'ready', info: { occt: '7.9.3', variant: 'wasm32', api, asi: api >= 8 ? '2026.1.1' : null, ready_ms: 1, init_ms: 1, heap_bytes: 1 }, message: null, respawns: 0, busy: null, heap_bytes: 1, memory_high: false });
  const respawn = new Set<(reason: string) => void>();
  const sent: R[] = [];
  const kernel = {
    status,
    start: async () => status.get().info!,
    async call(op: string, params: R) {
      sent.push({ op, ...params });
      return { result: reply(params), buffers: {}, ms: 1, wall_ms: 1, heap_bytes: 1 };
    },
    onRespawn(fn: (reason: string) => void) {
      respawn.add(fn);
      return () => respawn.delete(fn);
    },
    restart: async () => status.get().info!,
    recycleIfLarge: async () => false,
    dispose() {},
  } as unknown as KernelAdapter;
  return { kernel, sent, respawn: (why: string) => respawn.forEach((fn) => fn(why)) };
}
const kernelError = (message: string, kind = 'input') => Object.assign(new Error(message), { kind, op: 'recognize' });

describe('recognition client (fake kernel)', () => {
  it('caches per shape and query, passes both limits, and forgets everything on a kernel restart', async () => {
    const f = fakeKernel(() => ANSWER);
    const c = createRecognitionClient(f.kernel);
    expect(c.limits).toEqual({ maxFilletFaces: RECOGNIZE_MAX_FILLET_FACES, maxHoleFaces: RECOGNIZE_MAX_HOLE_FACES });
    expect([RECOGNIZE_MAX_FILLET_FACES, RECOGNIZE_MAX_HOLE_FACES]).toEqual([5000, 2600]);
    const a = await c.features(5);
    expect(a).toEqual({ ok: true, result: ANSWER });
    await c.features(5);
    await c.features(5, {});
    expect(c.calls).toBe(1);
    // Holes in the app's one mode (HOLES_MODE, decision D6: hard).
    expect(f.sent).toEqual([{ op: 'recognize', id: 5, max_fillet_faces: 5000, max_hole_faces: 2600, holes_mode: 'hard' }]);
    await c.features(5, { holes: false, max_r: 2.002 });
    await c.features(5, { holes_mode: 'hard', blends: false });
    expect(f.sent.slice(1)).toEqual([
      { op: 'recognize', id: 5, max_fillet_faces: 5000, max_hole_faces: 2600, holes: false, max_r: 2.002 },
      { op: 'recognize', id: 5, max_fillet_faces: 5000, max_hole_faces: 2600, blends: false, holes_mode: 'hard' },
    ]);
    f.respawn('watchdog');
    await c.features(5);
    expect(c.calls).toBe(4);
    // A lowered limit is part of the key and reaches the kernel.
    c.limits.maxFilletFaces = 10;
    await c.features(5);
    expect(f.sent.at(-1)).toMatchObject({ max_fillet_faces: 10, max_hole_faces: 2600 });
    c.limits.maxHoleFaces = 9;
    await c.features(5);
    expect(f.sent.at(-1)).toMatchObject({ max_fillet_faces: 10, max_hole_faces: 9 });
    expect(c.calls).toBe(6);
  });

  it('each search meets its own limit: fillets alone the fillets\' (5,000), any search with holes the holes\' (2,600) too', async () => {
    const f = fakeKernel(() => ANSWER);
    const c = createRecognitionClient(f.kernel);
    // 4,000 faces: fillets alone are found; holes, alone or with fillets, are refused before any kernel call.
    expect(await c.features(1, { holes: false }, { faces: 4000 })).toEqual({ ok: true, result: ANSWER });
    const holeWords = 'this body has 4,000 faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000';
    const holes = { ok: false, reason: 'too_large', faces: 4000, over: 'holes', limit: 2600, limits: { fillets: 5000, holes: 2600 }, words: holeWords };
    expect(await c.features(1, { blends: false }, { faces: 4000 })).toEqual(holes);
    expect(await c.features(1, {}, { faces: 4000 })).toEqual(holes);
    // Over both: the fillets' limit first, unless the search has no fillets.
    const filletWords = 'this body has 5,001 faces: fillets are found on bodies of up to 5,000 faces and holes on bodies of up to 2,600';
    expect(await c.features(1, {}, { faces: 5001 })).toEqual({ ok: false, reason: 'too_large', faces: 5001, over: 'fillets', limit: 5000, limits: { fillets: 5000, holes: 2600 }, words: filletWords });
    expect(await c.features(1, { holes: false }, { faces: 5001 })).toMatchObject({ over: 'fillets', words: filletWords });
    expect(await c.features(1, { blends: false }, { faces: 5001 })).toMatchObject({ over: 'holes', words: 'this body has 5,001 faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000' });
    // At the limits: searched.
    expect(await c.features(2, { holes: false }, { faces: 5000 })).toMatchObject({ ok: true });
    expect(await c.features(2, { blends: false }, { faces: 2600 })).toMatchObject({ ok: true });
    expect(c.calls).toBe(3);
    expect(overLimit(2601, {}, { fillets: 5000, holes: 2600 })).toBe('holes');
    expect(overLimit(2601, { holes: false }, { fillets: 5000, holes: 2600 })).toBeNull();
    expect(limitWords('fillets', { fillets: 10, holes: 10 })).toBe('fillets and holes are found on bodies of up to 10');
  });

  it('keeps the newest 32 shapes', async () => {
    const f = fakeKernel(() => ANSWER);
    const c = createRecognitionClient(f.kernel);
    for (let s = 1; s <= 33; s++) await c.features(s);
    await c.features(33);
    expect(c.calls).toBe(33);
    await c.features(1);
    expect(c.calls).toBe(34);
  });

  it("refuses in words: over the limit without a kernel call (the kernel's own words), no solid, a kernel below API 8, and an unknown op", async () => {
    const f = fakeKernel(() => ANSWER);
    const c = createRecognitionClient(f.kernel);
    expect(await c.features(1, {}, { faces: 2612 })).toEqual({ ok: false, reason: 'too_large', faces: 2612, over: 'holes', limit: 2600, limits: { fillets: 5000, holes: 2600 }, words: 'this body has 2,612 faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000' });
    expect(c.calls).toBe(0);
    expect(tooLargeWords(14212, 'fillets', { fillets: 5000, holes: 2600 })).toBe('this body has 14,212 faces: fillets are found on bodies of up to 5,000 faces and holes on bodies of up to 2,600');
    expect(tooLargeWords(14212, 'holes', { fillets: 2000, holes: 2000 })).toBe('this body has 14,212 faces: fillets and holes are found on bodies of up to 2,000');

    // The kernel's words (a call with no face count): API 8's one limit, and API 9's two, the one the query ran into named first.
    const big = fakeKernel(() => {
      throw kernelError('this body has 2,002 faces: fillets and holes are found on bodies of up to 2,000');
    });
    expect(await createRecognitionClient(big.kernel).features(1)).toEqual({ ok: false, reason: 'too_large', faces: 2002, over: 'fillets', limit: 2000, limits: { fillets: 2000, holes: 2000 }, words: 'this body has 2,002 faces: fillets and holes are found on bodies of up to 2,000' });
    expect(await createRecognitionClient(big.kernel).features(1, { blends: false })).toMatchObject({ over: 'holes', limit: 2000 });
    for (const [words, faces, over, limit, limits] of [
      ['this body has 3,000 faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000', 3000, 'holes', 2600, { fillets: 5000, holes: 2600 }],
      ['this body has 5,400 faces: fillets are found on bodies of up to 5,000 faces and holes on bodies of up to 2,600', 5400, 'fillets', 5000, { fillets: 5000, holes: 2600 }],
    ] as const) {
      const two = fakeKernel(() => {
        throw kernelError(words);
      });
      expect(await createRecognitionClient(two.kernel).features(1)).toEqual({ ok: false, reason: 'too_large', faces, over, limit, limits, words });
    }

    const shell = fakeKernel(() => {
      throw kernelError('no solid in this body (fillets and holes are found on solids only)');
    });
    expect(await createRecognitionClient(shell.kernel).features(1)).toEqual({ ok: false, reason: 'not_solid', words: 'no solid in this body (fillets and holes are found on solids only)' });

    const old = fakeKernel(() => ANSWER, 7);
    const oc = createRecognitionClient(old.kernel);
    expect(await oc.features(1)).toEqual({ ok: false, reason: 'old_kernel', api: 7, words: 'This kernel cannot find fillets or holes (it answers API 7; they need API 8).' });
    expect(oc.calls).toBe(0);
    expect(oldKernelWords(7)).toBe('This kernel cannot find fillets or holes (it answers API 7; they need API 8).');

    const unknown = fakeKernel(() => {
      throw kernelError("unknown op 'recognize'");
    }, 0);
    expect(await createRecognitionClient(unknown.kernel).features(1)).toMatchObject({ ok: false, reason: 'old_kernel', words: oldKernelWords(7) });
  });

  it('a failure is words, and not kept: the next call asks again', async () => {
    let n = 0;
    const f = fakeKernel(() => {
      if (n++ === 0) throw kernelError('fillet recognition failed (Standard_Failure)', 'occt');
      return ANSWER;
    });
    const c = createRecognitionClient(f.kernel);
    expect(await c.features(1)).toEqual({ ok: false, reason: 'failed', words: 'fillet recognition failed (Standard_Failure)' });
    expect(await c.features(1)).toEqual({ ok: true, result: ANSWER });
    expect(c.calls).toBe(2);
  });

  it('a stopped search rejects with an AbortError (before the call, and after it: the answer is still kept)', async () => {
    const f = fakeKernel(() => ANSWER);
    const c = createRecognitionClient(f.kernel);
    const stop = new AbortController();
    stop.abort();
    await expect(c.features(1, {}, { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.calls).toBe(0);
    const later = new AbortController();
    const p = c.features(1, {}, { signal: later.signal });
    later.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(await c.features(1)).toEqual({ ok: true, result: ANSWER });
    expect(c.calls).toBe(1);
  });

  it("D7: 'cliff' and 'uncertain' are not fillets; the summary counts fillets and holes with their sizes, a hole with no cylinder apart (not a drilled hole)", () => {
    expect(ANSWER.blends.map(isFillet)).toEqual([true, true, false, false]);
    expect(summaryOf(ANSWER)).toEqual({ fillets: { faces: 2, r_min: 3, r_max: 5 }, holes: { count: 2, d_min: 6, d_max: 11, unsized: 1 } });
    expect(summaryOf({ ...ANSWER, blends: [], holes: [] })).toEqual({ fillets: { faces: 0, r_min: null, r_max: null }, holes: { count: 0, d_min: null, d_max: null, unsized: 0 } });
  });

  it('one client per kernel adapter', () => {
    const a = fakeKernel(() => ANSWER).kernel;
    const b = fakeKernel(() => ANSWER).kernel;
    expect(recognitionOf(a)).toBe(recognitionOf(a));
    expect(recognitionOf(a)).not.toBe(recognitionOf(b));
  });
});

describe('recognition client (the real kernel)', () => {
  it("part A (60 x 40 x 20, R5 verticals, R3 round the top, a 6 mm through hole and an 8 mm hole 10 deep): what recognize answers; the lowered limit says the kernel's words; a restart forgets", async () => {
    const { kernel } = realKernelAdapter();
    const info = await kernel.start();
    expect(info).toMatchObject({ api: 10, asi: '2026.1.1' });
    const call = async (op: string, p: R): Promise<R> => (await kernel.call(op as never, p as never)).result as R;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const box = (await call('box', { dx: 60, dy: 40, dz: 20, origin: [0, 0, 0] })).id;
    const edges = async (id: number) => (await call('topo', { id, faces: 'none', vertices: 'none', edge_ends: true })).edges as R[];
    const vertical = (await edges(box)).filter((e) => near(e.first[0], e.last[0]) && near(e.first[1], e.last[1])).map((e) => e.i);
    const r5 = (await call('fillet', { id: box, edges: vertical, r: 5 })).id;
    const top = (await edges(r5)).filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
    const r3 = (await call('fillet', { id: r5, edges: top, r: 3 })).id;
    const t1 = (await call('cylinder', { r: 3, h: 22, origin: [15, 20, -1], axis: [0, 0, 1] })).id;
    const t2 = (await call('cylinder', { r: 4, h: 11, origin: [45, 20, 10], axis: [0, 0, 1] })).id;
    const a = (await call('boolean', { op: 'cut', targets: [r3], tools: [t1, t2] })).id;

    const c = recognitionOf(kernel);
    const got = await c.features(a, {}, { faces: 21 });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const radii = got.result.blends.map((b) => b.r_max).sort((x, y) => x - y);
    expect(radii.map((r) => Math.round(r))).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5]);
    expect(got.result.holes.map((h) => ({ d: h.d_max, through: h.through }))).toEqual([
      { d: 6, through: true },
      { d: 8, through: false },
    ]);
    expect(summaryOf(got.result)).toEqual({ fillets: { faces: 12, r_min: 3, r_max: 5 }, holes: { count: 2, d_min: 6, d_max: 8, unsized: 0 } });
    // max_r: Analysis Situs' own set at R3 (what suppress_blends takes at R3) is the 8 R3 faces.
    const atR = await c.features(a, { holes: false, max_r: 3.003 });
    expect(atR.ok && atR.result.blends.length).toBe(8);
    expect(c.calls).toBe(2);

    // The limits lowered as an e2e lowers them: without a face count the kernel refuses, with the same words.
    c.limits.maxHoleFaces = 20;
    const holes = { ok: false, reason: 'too_large', faces: 21, over: 'holes', limit: 20, limits: { fillets: 5000, holes: 20 }, words: 'this body has 21 faces: holes are found on bodies of up to 20 faces and fillets on bodies of up to 5,000' };
    expect(await c.features(a)).toEqual(holes);
    expect(await c.features(a, {}, { faces: 21 })).toEqual(holes);
    // Fillets alone are still found.
    expect(await c.features(a, { holes: false })).toMatchObject({ ok: true, result: { faces: 21 } });
    c.limits.maxFilletFaces = 19;
    const fillets = { ok: false, reason: 'too_large', faces: 21, over: 'fillets', limit: 19, limits: { fillets: 19, holes: 20 }, words: 'this body has 21 faces: fillets are found on bodies of up to 19 faces and holes on bodies of up to 20' };
    expect(await c.features(a)).toEqual(fillets);
    expect(await c.features(a, {}, { faces: 21 })).toEqual(fillets);
    c.limits.maxFilletFaces = RECOGNIZE_MAX_FILLET_FACES;
    c.limits.maxHoleFaces = RECOGNIZE_MAX_HOLE_FACES;

    // A surface body (six faces, not sewn).
    const bytes = readFileSync(join(FIXTURES, 'box20-faces.step'));
    const shell = (await kernel.call('import_step', { name: 'box20-faces.step', heal: false }, { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })).result.shapes[0];
    expect(shell.type).toBe('shell');
    expect(await c.features(shell.id)).toEqual({ ok: false, reason: 'not_solid', words: 'no solid in this body (fillets and holes are found on solids only)' });

    const before = c.calls;
    await kernel.restart('test');
    const box2 = (await call('box', { dx: 10, dy: 10, dz: 10, origin: [0, 0, 0] })).id;
    expect(await c.features(box2)).toMatchObject({ ok: true, result: { faces: 6, blends: [], holes: [] } });
    expect(c.calls).toBe(before + 1);
    kernel.dispose();
  }, 60_000);

  it('a box with a 6 mm hole and three round voids inside: one drilled hole, the voids apart (recognition reads each void as a hole with no cylinder; review 2026-11-02)', async () => {
    const { kernel } = realKernelAdapter();
    await kernel.start();
    const call = async (op: string, p: R): Promise<R> => (await kernel.call(op as never, p as never)).result as R;
    const box = (await call('box', { dx: 60, dy: 40, dz: 20, origin: [0, 0, 0] })).id;
    const tools = [(await call('cylinder', { r: 3, h: 22, origin: [20, 35, -1], axis: [0, 0, 1] })).id];
    for (const x of [10, 30, 50]) tools.push((await call('sphere', { r: 4, center: [x, 20, 10] })).id);
    const part = (await call('boolean', { op: 'cut', targets: [box], tools })).id;
    const got = await recognitionOf(kernel).features(part);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.result.holes.map((h) => [h.d_min, h.through])).toEqual([
      [6, true],
      [null, false],
      [null, false],
      [null, false],
    ]);
    // It said "Body 1 has 4 drilled holes, Ø6".
    const s = summaryOf(got.result);
    expect(s.holes).toEqual({ count: 1, d_min: 6, d_max: 6, unsized: 3 });
    expect(hasWords('Body 1', 'holes', s, { length: 'mm', angle: 'deg' })).toBe('Body 1 has 1 drilled hole, Ø6, and 3 round hollows with no cylinder, which no size matches');
    kernel.dispose();
  }, 60_000);
});
