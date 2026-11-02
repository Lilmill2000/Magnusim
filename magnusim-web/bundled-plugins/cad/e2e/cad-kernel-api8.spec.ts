// Kernel API 8 (Analysis Situs asiAlgo 2026.1.1) in the Part's own worker: the ready message says
// {api: 8, asi: '2026.1.1'}, `version` answers the same, and `recognize` on the proof's part A,
// built here with kernel ops (a 60 x 40 x 20 box, R5 on its 4 vertical edges, R3 round the top,
// a 6 mm through hole and an 8 mm hole 10 deep), finds its 12 fillet faces (4 R5, 8 R3) and its
// 2 holes (6 mm through, 8 mm blind). The page's recognition limit (window.__CAD__.recognition,
// what the Find e2e lowers) is RECOGNIZE_MAX_FACES. No UI uses these ops yet: this checks the
// kernel the page really loads (no file, no Vortex STEP), plus no CSP violation, no console error
// and no worker respawn. On the API 7 kernel it fails (api 7, unknown op 'recognize').
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

test('cad:kernel-api8 the Part worker answers API 8 with Analysis Situs and finds part A\'s fillets and holes', async ({ page, request }) => {
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
    r.status = kernel.status.get();
    return r;
  });

  // The ready message (the worker's first answer) and `version`.
  expect(out.ready).toEqual({ api: 8, asi: '2026.1.1' });
  expect(out.info).toMatchObject({ api: 8, asi: '2026.1.1', occt: '7.9.3' });
  expect(out.version).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 8, asi: '2026.1.1' });
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
  // One worker the whole time: nothing crashed or timed out.
  expect(out.status).toMatchObject({ state: 'ready', respawns: 0 });
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
