// @vitest-environment node
// Delete faces' third way on the real kernel (kernel API 9, src/features/delete_faces/corners.ts),
// through the whole build (deleteFacesOn, version 2) as the person's "Fillets up to 1 mm" picks:
//  - the app's T-block (a bar 60 x 40 x 10 on a stem 20 x 40 x 10, its 16 edges across y R2, then
//    its 8 edges along y R1): OCCT's heal of the 8 R1 rounds would grow the 16 corner pieces at
//    their ends 10 times their size (568 s natively, then a failure; the app's watchdog stopped
//    it at 20 s), so it is not started, taking them off as fillets refuses at once, and each round
//    comes off with its 2 corner pieces: ok, the note, the body equal to the T with only its R2
//    fillets (built here: volume to 1e-9, symmetric difference 0, 26 faces), every face named from
//    the body before, well within the watchdog;
//  - the other order (R1 first, then R2: a torus at each concave round's ends): the same body;
//  - the same T with R1 along y first and R3 across: every way refused, each said once, then that
//    the body is unchanged once (OCCT's heal, run after the other ways with its whole budget, the
//    20 s its call had before API 9, stopped by it).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteFacesOn } from '../../../src/features/delete_faces/feature';
import { limitOf } from '../../../src/features/delete_faces/plan';
import type { DeleteFacesFeature } from '../../../src/types/doc';
import type { BuildContext, BuiltBody, DeleteFacesOutput } from '../../../src/types/doc-service';
import type { RecognizeResult, TopoResult } from '../../../src/types/kernel-protocol';
import { forgetBreps } from '../../../src/features/import/feature';
import { openSolids } from '../solids/solids-real';
import type { RealDoc } from '../p2/real-doc';

// Wall-time bounds get three times the room on a shared CI runner (GitHub sets CI): one took
// 3.08 s against 3 s there on 2026-11-15. Locally they hold as written.
const ROOM = process.env.CI ? 3 : 1;

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
const fuse = (a: number, ...tools: number[]) => id('boolean', { op: 'fuse', targets: [a], tools });
const edges = async (s: number) => (await c('topo', { id: s, faces: 'none', vertices: 'none', edge_ends: true })).edges as Edge[];
const vol = async (s: number) => (await c('props', { id: s, volume: true, bbox: 'none' })).volume as number;
const nfaces = async (s: number) => (await c('props', { id: s, bbox: 'none' })).faces as number;
const fillet = async (s: number, es: number[], rad: number) => id('fillet', { id: s, edges: es, r: rad });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const alongY = (e: Edge) => e.type === 'line' && !!e.first && !!e.last && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]) && !near(e.first[1], e.last[1]);
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
    faces: async (s: number) => nfaces(s),
    release: async (ids: number[]) => void (await c('release', { ids })),
  }) as unknown as BuildContext;
const feature = { id: 'f_df', type: 'delete_faces', name: 'Delete faces 1', body: 'b_1', faces: [], version: 2 } as unknown as DeleteFacesFeature;

/** The T-block rounded rAcross on its 16 edges across y and rAlong on its 8 along y, in that order or the other; and the T with only rAcross. */
async function tBlock(rAlong: number, rAcross: number, alongFirst = false) {
  const sharp = await fuse(await box(60, 40, 10, [0, 0, 10]), await box(20, 40, 10, [20, 0, 0]));
  const ref = await fillet(sharp, (await edges(sharp)).filter((e) => !alongY(e)).map((e) => e.i), rAcross);
  let body: number;
  if (alongFirst) {
    const a = await fillet(sharp, (await edges(sharp)).filter(alongY).map((e) => e.i), rAlong);
    body = await fillet(a, (await edges(a)).filter((e) => !alongY(e)).map((e) => e.i), rAcross);
  } else body = await fillet(ref, (await edges(ref)).filter(alongY).map((e) => e.i), rAlong);
  return { ref, body };
}

/** "Fillets up to r" (every fillet up to r, as Add by size picks them) taken off by the whole build, with the body's faces named in:<i>. */
async function deleteUpTo(body: number, rad: number) {
  const atR = (await c('recognize', { id: body, holes: false, max_r: limitOf(rad) })) as RecognizeResult;
  const picks = atR.blends.map((b) => b.face);
  const n = await nfaces(body);
  const built: BuiltBody = { id: 'b_1', shape: body, valid: true, feature: 'f_x', names: { faces: Array.from({ length: n }, (_, i) => `F:f_x:in${i}`) } } as BuiltBody;
  const t0 = performance.now();
  const res = await deleteFacesOn(feature, ctx(), built, picks);
  return { picks, res, ms: performance.now() - t0 };
}

const NOT_RUN = "OCCT's heal was not run: it would grow 16 small curved faces up to 10 times their size, which failed or ran past 20 s on every part measured";

describe('the third way: rounds whose ends carry corner pieces of other fillets', () => {
  it("the app's T-block (R2 across, then R1 along): the 8 R1 rounds come off with their 16 corner pieces, the T with only its R2 fillets", async () => {
    const t = await tBlock(1, 2);
    const { picks, res, ms } = await deleteUpTo(t.body, 1);
    expect(picks).toHaveLength(8);
    expect(res.ok ? 'ok' : res.message).toBe('ok');
    if (!res.ok) return;
    expect(res.note).toBe(`Taken off one round at a time, with the 16 corner faces where they meet other fillets: ${NOT_RUN}`);
    expect(res.output).toEqual({ type: 'delete-faces', how: 'corners', rest: [], restRefs: [] } satisfies DeleteFacesOutput);
    expect(res.warning).toBeUndefined();
    const out = res.bodies[0];
    expect(Math.abs((await vol(out.shape)) / (await vol(t.ref)) - 1)).toBeLessThan(1e-9);
    expect(await symdiff(out.shape, t.ref)).toBeLessThan(1e-6);
    expect(await nfaces(out.shape)).toBe(26);
    expect((await c('check', { id: out.shape })).valid).toBe(true);
    // Every face keeps the name of the face it came from (none is new).
    expect(out.names?.faces).toHaveLength(26);
    expect(out.names!.faces.every((x) => /^F:f_x:in\d+(#\d+)?$/.test(x))).toBe(true);
    // Measured 4.4 s in Node; the kernel's watchdog is 20 s per call.
    expect(ms).toBeLessThan(15_000 * ROOM);
  }, 120_000);

  it('the other order (R1 along first, then R2 across: tori at the concave rounds): the same body', async () => {
    const t = await tBlock(1, 2, true);
    const { res } = await deleteUpTo(t.body, 1);
    expect(res.ok ? 'ok' : res.message).toBe('ok');
    if (!res.ok) return;
    expect(res.note).toBe("Taken off one round at a time, with the 16 corner faces where they meet other fillets: OCCT's heal was not run: it would grow 12 small curved faces up to 10 times their size, which failed or ran past 20 s on every part measured");
    expect(await symdiff(res.bodies[0].shape, t.ref)).toBeLessThan(1e-6);
    expect(await nfaces(res.bodies[0].shape)).toBe(26);
  }, 120_000);

  it("R1 along first, then R3 across: every way refused, each said once, then that the body is unchanged once; OCCT's heal runs after the other ways with its whole budget (never a shorter one: a heal that ends in it is never cut) and its budget stops it", async () => {
    const t = await tBlock(1, 3, true);
    const { res } = await deleteUpTo(t.body, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(
      /^Delete faces 1 failed: OCCT's heal did not finish in 20\.0 s: it grows 12 small curved faces far past their size; taking them off as fillets did not work either: [^;]+; taking them off with the 16 corner faces where they meet other fillets did not work either: [^;]+; the body is unchanged$/,
    );
  }, 180_000);
});
