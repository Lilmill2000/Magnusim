// Kernel API 8 (Analysis Situs asiAlgo 2026.1.1) in the Part's own worker: the ready message says
// {api: 9, asi: '2026.1.1'} (API 9: defeature's time budget, recognize's two face limits, the
// budget's words), `version` answers the same, and `recognize` on the proof's part A,
// built here with kernel ops (a 60 x 40 x 20 box, R5 on its 4 vertical edges, R3 round the top,
// a 6 mm through hole and an 8 mm hole 10 deep), finds its 12 fillet faces (4 R5, 8 R3) and its
// 2 holes (6 mm through, 8 mm blind). The page's recognition limit (window.__CAD__.recognition,
// what the Find e2e lowers) is RECOGNIZE_MAX_FACES. No UI uses these ops yet: this checks the
// kernel the page really loads (no file, no Vortex STEP), plus no CSP violation, no console error
// and no worker respawn. On the API 7 kernel it fails (api 7, unknown op 'recognize').
// API 9 in the browser worker: the app's T-block (R2 on the 16 edges not along y, then R1 on the 8
// along y) whose 8 R1 rounds OCCT's heal never finished in time (the watchdog stopped the worker
// after 20 s): with far_skip it is not started (16 corner pieces it would grow 10 times their size),
// a budget stops the other order's heal in about 2 s, and neither restarts the worker; a holes query
// over its face limit is refused naming both limits (fillets alone still answered); the budget's
// words. On the API 8 kernel it fails (api 8; the heal runs past the watchdog).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

test('cad:kernel-api8 the Part worker answers API 9 with Analysis Situs, finds part A\'s fillets and holes and stops a heal within its budget', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  await partOpened(page);
  const frame = workspaceFrame(page);

  const out = await frame.evaluate(async () => {
    type R = Record<string, any>;
    type Kernel = { call(op: string, p: R): Promise<R>; start(): Promise<R>; status: { get(): R } };
    const cad = (window as unknown as { __CAD__: { services: { kernel: Kernel }; recognition: { maxFaces: number } } }).__CAD__;
    const kernel = cad.services.kernel;
    const ready = await kernel.start();
    const call = async (op: string, p: R) => (await kernel.call(op, p)).result as R;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const edges = async (id: number) => (await call('topo', { id, faces: 'none', vertices: 'none', edge_ends: true })).edges as R[];
    const r: R = { ready: { api: ready.api, asi: ready.asi }, info: kernel.status.get().info, version: await call('version', {}), limit: cad.recognition.maxFaces };

    const box = (await call('box', { dx: 60, dy: 40, dz: 20, origin: [0, 0, 0] })).id;
    const vertical = (await edges(box)).filter((e) => near(e.first[0], e.last[0]) && near(e.first[1], e.last[1])).map((e) => e.i);
    const r5 = (await call('fillet', { id: box, edges: vertical, r: 5 })).id;
    const top = (await edges(r5)).filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
    const r3 = (await call('fillet', { id: r5, edges: top, r: 3 })).id;
    const through = (await call('cylinder', { r: 3, h: 22, origin: [15, 20, -1], axis: [0, 0, 1] })).id;
    const blind = (await call('cylinder', { r: 4, h: 11, origin: [45, 20, 10], axis: [0, 0, 1] })).id;
    const a = await call('boolean', { op: 'cut', targets: [r3], tools: [through, blind] });
    r.part = { valid: a.valid, faces: a.faces };
    const rec = await call('recognize', { id: a.id });
    r.rec = {
      faces: rec.faces,
      solids: rec.solids,
      radii: (rec.blends as R[]).map((b) => Math.round(b.r_max * 1e6) / 1e6).sort((x, y) => x - y),
      kinds: (rec.blends as R[]).reduce((o: R, b) => ({ ...o, [b.kind]: (o[b.kind] ?? 0) + 1 }), {}),
      chains: rec.chains.length,
      holes: (rec.holes as R[]).map((h) => ({ n: h.faces.length, d_min: h.d_min, d_max: h.d_max, through: h.through })),
    };

    // API 9: the T-block's heal, not started (far_skip) and stopped within a budget.
    const alongY = (e: R) => e.type === 'line' && near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]) && !near(e.first[1], e.last[1]);
    const tBlock = async (r2First: boolean) => {
      const bar = (await call('box', { dx: 60, dy: 40, dz: 10, origin: [0, 0, 10] })).id;
      const stem = (await call('box', { dx: 20, dy: 40, dz: 10, origin: [20, 0, 0] })).id;
      const sharp = (await call('boolean', { op: 'fuse', targets: [bar], tools: [stem] })).id;
      const es = await edges(sharp);
      const first = (await call('fillet', { id: sharp, edges: es.filter((e) => alongY(e) !== r2First).map((e) => e.i), r: r2First ? 2 : 1 })).id;
      const es2 = await edges(first);
      const body = (await call('fillet', { id: first, edges: es2.filter((e) => alongY(e) === r2First).map((e) => e.i), r: r2First ? 1 : 2 })).id;
      const picks = ((await call('recognize', { id: body, holes: false, max_r: 1.001 })).blends as R[]).map((b) => b.face);
      return { body, picks };
    };
    const t2 = await tBlock(true);
    let t0 = performance.now();
    const skipped = (await call('defeature', { id: t2.body, faces: t2.picks, far_budget_ms: 2500, far_skip: true })).stopped as R;
    r.skip = { picks: t2.picks.length, ms: performance.now() - t0, skipped: skipped.skipped, budget_ms: skipped.budget_ms, far: skipped.far_grown.length, ratio: skipped.far_ratio };
    const t1 = await tBlock(false);
    t0 = performance.now();
    const stopped = (await call('defeature', { id: t1.body, faces: t1.picks, budget_ms: 2000 })).stopped as R;
    r.stop = { picks: t1.picks.length, ms: performance.now() - t0, budget_ms: stopped.budget_ms, after_ms: stopped.after_ms };
    const words = async (p: R) => {
      try {
        await call('recognize', p);
        return 'answered';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    r.limits = { holes: await words({ id: a.id, max_hole_faces: 20 }), fillets: await words({ id: a.id, holes: false, max_hole_faces: 20 }) };
    r.budget = (await call('debug_budget_words', { picks: 404, faces: 810, predicted_ms: 1450 })).words;
    r.status = kernel.status.get();
    return r;
  });

  // The ready message (the worker's first answer) and `version`.
  expect(out.ready).toEqual({ api: 9, asi: '2026.1.1' });
  expect(out.info).toMatchObject({ api: 9, asi: '2026.1.1', occt: '7.9.3' });
  expect(out.version).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 9, asi: '2026.1.1' });
  expect(out.limit).toBe(2000);
  // Part A, as built, and what recognize finds on it.
  expect(out.part).toEqual({ valid: true, faces: 21 });
  expect(out.rec).toMatchObject({ faces: 21, solids: 1 });
  expect(out.rec.radii).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5]);
  expect(out.rec.kinds).toEqual({ ordinary: 8, vertex: 4 });
  expect(out.rec.holes).toEqual([
    { n: 1, d_min: 6, d_max: 6, through: true },
    { n: 2, d_min: 8, d_max: 8, through: false },
  ]);
  // API 9: the T-block's heal not started, the other order's stopped within its budget (the worker
  // kept: the watchdog is 20 s), the limits named, the budget's words.
  expect(out.skip).toMatchObject({ picks: 8, skipped: true, budget_ms: 0, far: 16 });
  expect(out.skip.ratio).toBeGreaterThan(10);
  expect(out.skip.ms).toBeLessThan(3000);
  expect(out.stop).toMatchObject({ picks: 8, budget_ms: 2000 });
  expect(out.stop.after_ms).toBeGreaterThan(2000);
  expect(out.stop.after_ms).toBeLessThan(6000);
  expect(out.limits).toEqual({ holes: 'this body has 21 faces: holes are found on bodies of up to 20 faces and fillets on bodies of up to 5,000', fillets: 'answered' });
  expect(out.budget).toBe('taking 404 fillet faces off as fillets on a body of 810 faces would take about 1.5 s; Delete faces allows 1.4 s for taking fillets off as fillets');
  // One worker the whole time: nothing crashed or timed out.
  expect(out.status).toMatchObject({ state: 'ready', respawns: 0 });
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
