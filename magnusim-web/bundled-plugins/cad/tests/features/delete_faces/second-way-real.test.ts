// @vitest-environment node
// Delete faces' second way on the real kernel (kernel API 8, the Analysis Situs plan §6.2): the
// fillets taken off as fillets (suppress_blends), and the rules that keep a result only when it is
// right (src/features/p2/heal-check.ts checkFilletsOff): checkHeal, taken, the chain bound and the
// surface rule. Each rule on a wrong body made here and handed in place of suppress_blends' result
// (its history composed through the boolean that made it wrong), which it must refuse, and on
// right bodies, which every rule must pass:
//  - taken: a 4 x 4 x 1 notch cut into the restored T-block's top (Analysis Situs over-trimming);
//  - bound: a 1.5 x 1.5 groove along each restored concave edge (material taken past the fillets);
//    and the bound's convexity from the solid (decision D4): an opening's rim R1 round corners R8,
//    and a boss's foot R1 round corners R9.5, are right and pass (split by Analysis Situs' own
//    convex flag they were refused at 1.6 and 2.3 times the limit);
//  - surface: a void in the bar, a 1 x 1 bead in each restored concave corner, the right body with
//    two kept faces' histories swapped (wrong names): all pass checkHeal, taken and the bound;
//  - the kernel's words pass through as the reason: a comb of 100 single-face chains is refused
//    before it runs as too long here (decision D3, the kernel's budget).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { takeOffAsFillets } from '../../../src/features/delete_faces/feature';
import { limitOf, readPick } from '../../../src/features/delete_faces/plan';
import { checkFilletsOff, type FilletsCheck } from '../../../src/features/p2/heal-check';
import type { BuildContext, BuiltBody } from '../../../src/types/doc-service';
import type { OpHistory, RecognizeResult, ShapeId, TopoResult } from '../../../src/types/kernel-protocol';
import { poly } from '../../kernel/asi-lib';
import { forgetBreps } from '../../../src/features/import/feature';
import { openSolids } from '../solids/solids-real';
import type { RealDoc } from '../p2/real-doc';

type R = Record<string, any>;
type Edge = TopoResult['edges'][number];

let r: RealDoc;
beforeAll(async () => {
  r = await openSolids();
});
afterAll(() => {
  r?.dispose();
  forgetBreps();
});

const c = async (op: string, params: R): Promise<R> => (await r.kernel.call(op as never, params as never)).result as R;
const id = async (op: string, p: R): Promise<number> => {
  const x = await c(op, p);
  expect(x.valid, op).not.toBe(false);
  return x.id as number;
};
const box = (dx: number, dy: number, dz: number, origin = [0, 0, 0]) => id('box', { dx, dy, dz, origin });
const cut = (a: number, ...tools: number[]) => id('boolean', { op: 'cut', targets: [a], tools });
const fuse = (a: number, ...tools: number[]) => id('boolean', { op: 'fuse', targets: [a], tools });
const edges = async (s: number) => (await c('topo', { id: s, faces: 'none', vertices: 'none', edge_ends: true })).edges as Edge[];
const vol = async (s: number) => (await c('props', { id: s, volume: true, bbox: 'none' })).volume as number;
const fillet = async (s: number, es: number[], rad: number) => id('fillet', { id: s, edges: es, r: rad });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const symdiff = async (a: number, b: number) => {
  let s = 0;
  for (const [x, y] of [[a, b], [b, a]]) {
    const d = await c('boolean', { op: 'cut', targets: [x], tools: [y] });
    if (!d.empty) s += await vol(d.id);
    await c('release', { ids: [d.id] });
  }
  return s;
};
const ctx = (): BuildContext =>
  ({
    kernel: r.kernel,
    units: { units: () => ({ length: 'mm', angle: 'deg' }) },
    bodyName: () => 'Body 1',
    featureName: () => null,
    doc: { features: [] },
    faces: async (s: number) => (await c('props', { id: s, bbox: 'none' })).faces as number,
    release: async (ids: number[]) => void (await c('release', { ids })),
  }) as unknown as BuildContext;
const bodyOf = (shape: ShapeId): BuiltBody => ({ id: 'b_1', shape, valid: true, feature: 'f_1', names: null });

/** Every fillet of `s` up to R (recognition at R x 1.001), and that recognition. */
async function filletsUpTo(s: number, rad: number): Promise<{ picks: number[]; atR: RecognizeResult }> {
  const atR = (await c('recognize', { id: s, holes: false, max_r: limitOf(rad) })) as RecognizeResult;
  return { picks: atR.blends.map((b) => b.face), atR };
}

/** The history of input -> b, given input -> a (h1) and a -> b (h2, a boolean on a). */
function composeHistory(input: ShapeId, h1: OpHistory, a: ShapeId, h2: OpHistory): OpHistory {
  const srcOfA = new Map(h1.faces.map((e) => [e.out, e.from]));
  const faces = h2.faces.map((e) => {
    const from: OpHistory['faces'][number]['from'] = [];
    for (const s of e.from) {
      if (s.shape !== a || s.face == null) continue;
      for (const x of srcOfA.get(s.face) ?? []) from.push({ ...x, how: x.how === 'generated' || s.how === 'generated' ? 'generated' : x.how === 'same' && s.how === 'same' ? 'same' : 'modified' });
    }
    return { out: e.out, from };
  });
  const deleted = [...h1.deleted];
  const goneA = new Set(h2.deleted.filter((d) => d.shape === a && d.face != null).map((d) => d.face as number));
  for (const e of h1.faces) {
    if (!goneA.has(e.out)) continue;
    for (const x of e.from) {
      if (x.shape !== input || x.face == null || x.how === 'generated') continue;
      const still = h1.faces.some((o) => o.out !== e.out && !goneA.has(o.out) && o.from.some((y) => y.shape === input && y.face === x.face));
      if (!still && !deleted.some((d) => d.face === x.face)) deleted.push({ shape: input, face: x.face });
    }
  }
  return { faces, edges: [], deleted };
}

/** The T-block (a bar 60 x 40 x 10 on a stem 20 x 40 x 10), every edge R2: the input, its 40 fillets, the sharp T. */
async function tBlock() {
  const sharp = await fuse(await box(60, 40, 10, [0, 0, 10]), await box(20, 40, 10, [20, 0, 0]));
  const input = await fillet(sharp, (await edges(sharp)).map((e) => e.i), 2);
  return { sharp, input, ...(await filletsUpTo(input, 2)) };
}

/** suppress_blends of every fillet up to R, made wrong by `spoil` (a boolean on its result), with the history composed. */
async function spoiled(input: number, picks: number[], spoil: (out: R) => Promise<R>): Promise<R> {
  const s = await c('suppress_blends', { id: input, faces: picks });
  const b = await spoil(s);
  return { ...s, id: b.id, valid: b.valid, faces: b.faces, history: composeHistory(input, s.history, s.id, b.history) };
}

const check = (input: number, picks: number[], out: R, atR: RecognizeResult): Promise<FilletsCheck> => checkFilletsOff(ctx(), bodyOf(input), picks, out as never, atR);

describe('the second way on a rounded T-block: right, and every rule on a wrong body', () => {
  it('suppress_blends of its 40 fillets is the sharp T-block, and every rule passes it', async () => {
    const t = await tBlock();
    expect(t.picks).toHaveLength(40);
    const sw = await takeOffAsFillets(ctx(), bodyOf(t.input), t.picks, t.atR);
    expect(sw.ok).toBe(true);
    if (!sw.ok) return;
    expect(await symdiff(sw.out.id, t.sharp)).toBeLessThan(1e-6 * 32000);
    expect(await vol(sw.out.id)).toBeCloseTo(32000, 6);
    const res = await check(t.input, t.picks, sw.out, t.atR);
    expect(res.refused).toBeNull();
    // The measured margins (gate G3: +460.24 / -64.81 against 756.8 / 128.0 with the flag split).
    expect(res.added!).toBeCloseTo(460.2413, 3);
    expect(res.taken!.volume!).toBeCloseTo(64.8145, 3);
    expect(res.added!).toBeLessThan(res.bound!.addLimit);
    expect(res.taken!.volume!).toBeLessThan(res.bound!.takeLimit);
    expect(res.taken!.taken).toEqual([]);
    expect(res.surface).toMatchObject({ noSource: [], offSurface: [] });
  }, 120_000);

  it('taken: Analysis Situs trimming a notch into the top it restored is refused, naming the face', async () => {
    const t = await tBlock();
    const out = await spoiled(t.input, t.picks, async (s) => c('boolean', { op: 'cut', targets: [s.id], tools: [await box(4, 4, 1, [28, 18, 19])] }));
    const res = await check(t.input, t.picks, out, t.atR);
    expect(res.refused?.rule).toBe('taken');
    expect(res.refused?.words).toMatch(/^it would take material away from faces you kept \(Face \d+ of Body 1\)$/);
    expect(res.taken!.taken).toHaveLength(1);
    // checkHeal alone (OCCT's rule) lets it through: nothing added, nothing lost.
    expect(res.heal).toMatchObject({ lost: [], covered: [] });
  }, 120_000);

  it('bound: a groove along each restored concave edge takes more than the fillets held, and is refused', async () => {
    const t = await tBlock();
    const out = await spoiled(t.input, t.picks, async (s) => {
      const a = await c('boolean', { op: 'cut', targets: [s.id], tools: [await box(1.5, 42, 1.5, [19.25, -1, 9.25])] });
      const b = await c('boolean', { op: 'cut', targets: [a.id], tools: [await box(1.5, 42, 1.5, [39.25, -1, 9.25])] });
      return { ...b, history: composeHistory(s.id, a.history, a.id, b.history) };
    });
    const res = await check(t.input, t.picks, out, t.atR);
    expect(res.refused?.rule).toBe('bound');
    expect(res.refused?.words).toMatch(/^the volume changed by [\d,.]+ mm³, more than the fillets hold \(about 63\.9469 mm³\)$/);
    expect(res.taken!.volume!).toBeGreaterThan(res.bound!.takeLimit);
  }, 120_000);

  it('surface: a void, a bead in each restored concave corner, two kept faces swapped: each passes heal, taken and bound, and is refused', async () => {
    const t = await tBlock();
    const wrongs: [string, (s: R) => Promise<R>, RegExp][] = [
      ['a void r1.5 in the bar', async (s) => c('boolean', { op: 'cut', targets: [s.id], tools: [await id('sphere', { center: [30, 20, 15], r: 1.5 })] }), /^the result had faces with no source$/],
      ['a 1 x 1 bead in each restored concave corner', async (s) => {
        const a = await c('boolean', { op: 'fuse', targets: [s.id], tools: [await box(1, 40, 1, [19, 0, 9])] });
        const b = await c('boolean', { op: 'fuse', targets: [a.id], tools: [await box(1, 40, 1, [40, 0, 9])] });
        return { ...b, history: composeHistory(s.id, a.history, a.id, b.history) };
      }, /^the result had faces with no source$/],
    ];
    for (const [name, spoil, words] of wrongs) {
      const out = await spoiled(t.input, t.picks, spoil);
      const res = await check(t.input, t.picks, out, t.atR);
      expect(res.refused?.rule, name).toBe('surface');
      expect(res.refused?.words, name).toMatch(words);
      expect(res.heal, name).toMatchObject({ lost: [], covered: [] });
      expect(res.taken!.taken, name).toEqual([]);
      expect(res.added!, name).toBeLessThanOrEqual(res.bound!.addLimit);
      expect(res.taken!.volume!, name).toBeLessThanOrEqual(res.bound!.takeLimit);
      expect(await symdiff(out.id, t.sharp), name).toBeGreaterThan(1);
    }
    // The right body with two kept faces' sources swapped: their names would be wrong.
    const s = await c('suppress_blends', { id: t.input, faces: t.picks });
    const fs = (s.history as OpHistory).faces.map((e) => ({ ...e, from: e.from.map((x) => ({ ...x })) }));
    [fs[0].from, fs[1].from] = [fs[1].from, fs[0].from];
    const res = await check(t.input, t.picks, { ...s, history: { ...s.history, faces: fs } }, t.atR);
    expect(res.refused).toMatchObject({ rule: 'surface' });
    expect(res.refused!.words).toMatch(/^2 faces moved off the surfaces they came from \(Face \d+ of Body 1 and Face \d+ of Body 1\)$/);
  }, 120_000);

  it("OCCT's fill handed in is refused by checkHeal, with its words", async () => {
    const t = await tBlock();
    const out = await c('defeature', { id: t.input, faces: t.picks });
    const res = await check(t.input, t.picks, out, t.atR);
    expect(res.refused?.rule).toBe('heal');
    expect(res.refused?.words).toMatch(/^healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d+ mm³ over faces you kept/);
  }, 120_000);
});

describe('the bound takes convexity from the solid, not from Analysis Situs (decision D4)', () => {
  /** A 60 x 40 x 20 block with a 30 x 20 opening through it, its corners round `rc`, its top rim round `rr`; and the block before the rim. */
  async function opening(rc: number, rr: number) {
    const win = await cut(await box(60, 40, 20), await box(30, 20, 22, [15, 10, -1]));
    const inner = (e: Edge) => !!e.first && e.first[0] > 10 && e.first[0] < 50 && e.first[1] > 5 && e.first[1] < 35;
    const w = await fillet(win, (await edges(win)).filter((e) => e.type === 'line' && e.dir && near(Math.abs(e.dir[2]), 1) && inner(e)).map((e) => e.i), rc);
    return { ref: w, input: await fillet(w, (await edges(w)).filter((e) => near(e.first![2], 20) && near(e.last![2], 20) && inner(e)).map((e) => e.i), rr) };
  }
  /** A 30 x 20 x 10 boss, corners round `rc`, on a 60 x 40 x 10 plate, its foot round `rr` (concave); and the part before the foot. */
  async function bossFoot(rc: number, rr: number) {
    const boss = await box(30, 20, 10, [15, 10, 10]);
    const bc = await fillet(boss, (await edges(boss)).filter((e) => e.type === 'line' && e.dir && near(Math.abs(e.dir[2]), 1)).map((e) => e.i), rc);
    const plate = await fuse(await box(60, 40, 10), bc);
    const foot = (await edges(plate)).filter((e) => near(e.first![2], 10) && near(e.last![2], 10) && e.first![0] > 10 && e.first![0] < 50 && e.first![1] > 5 && e.first![1] < 35).map((e) => e.i);
    return { ref: plate, input: await fillet(plate, foot, rr) };
  }

  it("a rim round an opening's rounded corners, and a foot round a boss's: right, and passed (Analysis Situs reads their saddle pieces the other way)", async () => {
    for (const [name, made, rad] of [
      ['opening corners R8, rim R1', await opening(8, 1), 1],
      ['opening corners R9.5, rim R1', await opening(9.5, 1), 1],
      ['opening corners R9, rim R3', await opening(9, 3), 3],
      ['boss corners R9.5, foot R1', await bossFoot(9.5, 1), 1],
    ] as [string, { ref: number; input: number }, number][]) {
      const { picks, atR } = await filletsUpTo(made.input, rad);
      expect(picks.length, name).toBe(8);
      // Analysis Situs' own flags on the corner tori are the opposite of their chain's.
      expect(new Set(atR.blends.map((b) => b.convex)).size, name).toBe(2);
      const sw = await takeOffAsFillets(ctx(), bodyOf(made.input), picks, atR);
      expect(sw.ok ? 'kept' : sw.reason, name).toBe('kept');
      if (!sw.ok) continue;
      expect(await symdiff(sw.out.id, made.ref), name).toBeLessThan(1e-6 * (await vol(made.ref)));
      const res = await check(made.input, picks, sw.out, atR);
      const used = Math.max(res.added! / res.bound!.addLimit, res.taken!.volume! / res.bound!.takeLimit);
      expect(used, name).toBeLessThan(0.75);
    }
  }, 120_000);
});

describe("the kernel's words are the reason", () => {
  it('a comb of 100 single-face chains: refused before it runs, as too long here (the kernel budget, D3)', async () => {
    const m = 50;
    const xz: number[][] = [[0, 0], [4 * m + 2, 0], [4 * m + 2, 10]];
    for (let i = m - 1; i >= 0; i--) xz.push([4 * i + 4, 10], [4 * i + 4, 16], [4 * i + 2, 16], [4 * i + 2, 10]);
    xz.push([0, 10]);
    const sharp = await id('extrude', { profile: poly(xz.reverse()), extent: { kind: 'blind', d: 8 } });
    const lateral = (await edges(sharp)).filter((e) => e.type === 'line' && e.first && e.last && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2])).map((e) => e.i);
    const input = await fillet(sharp, lateral, 0.4);
    const rec = (await c('recognize', { id: input, holes: false })) as RecognizeResult;
    const read = readPick(rec, rec.blends.map((b) => b.face));
    const { picks, atR } = await filletsUpTo(input, read.r!);
    const t0 = performance.now();
    const sw = await takeOffAsFillets(ctx(), bodyOf(input), picks, atR);
    expect(sw).toMatchObject({ ok: false });
    if (sw.ok) return;
    expect(sw.reason).toMatch(new RegExp(`^taking ${picks.length} fillet faces off as fillets on a body of 410 faces would take too long here \\(about \\d+ s\\)$`));
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 120_000);
});
