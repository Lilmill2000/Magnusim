// Kernel API 3 (docs/p2p3-plan.md §2) inside the Part's sandboxed frame, through the
// page's own KernelAdapter and worker: version api 3, import diagnostics, heal (knit)
// of a surface-only STEP, the BREP an import stores (bytes out of the worker and back
// in), press-pull, combine (the Vortex fluid domain), measure, sketch regions with
// their triangle buffers and extrude by region keys. No UI uses these ops in this
// file, so it checks the kernel's answers (window.__CAD__, state only), plus no CSP
// violations, no console errors and no worker respawn.
// Owner: KERNEL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const FIX = fileURLToPath(new URL('../fixtures/kernel/', import.meta.url));
// Daniel's Vortex part is read where it is, never copied into the plugin (review P2/P3 round 3),
// and only when CAD_E2E_VORTEX_STEP names it: without it this test is skipped and says why.
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
const REF = JSON.parse(readFileSync(join(FIX, 'reference.json'), 'utf8'));

test('cad:p2-kernel-ops API 3 in the Part frame: import, heal, BREP, press-pull, combine, measure, regions', async ({ page, request }) => {
  const missing = "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step";
  if (!VORTEX) console.warn(`[cad:p2-kernel-ops] skipped: ${missing}`);
  test.skip(!VORTEX, missing);
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  await partOpened(page);
  const frame = workspaceFrame(page);

  const input = {
    vortex: readFileSync(VORTEX).toString('base64'),
    faces: readFileSync(join(FIX, 'box20-faces.step')).toString('base64'),
    fluidBox: REF.fluid_box,
  };
  const out = await frame.evaluate(async ({ vortex, faces, fluidBox }) => {
    type R = Record<string, any>;
    const kernel = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R, o?: R): Promise<R>; status: { get(): R } } } } }).__CAD__.services.kernel;
    const call = async (op: string, p: R, o?: R) => (await kernel.call(op, p, o)).result as R;
    const vol = async (id: number) => (await call('props', { id, volume: true, bbox: 'none' })).volume as number;
    const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const r: R = {};
    r.version = await call('version', {});

    // Import with diagnostics; heal (knit) the surface-only cube.
    const imp = await call('import_step', { name: 'vortex.step', heal: true, diagnose: true }, { bytes: bytesOf(vortex) });
    const v = imp.shapes[0].id;
    r.import = { unit: imp.unit, faces: imp.shapes[0].faces, valid: imp.shapes[0].valid, problems: imp.diagnostics.total, closed: imp.diagnostics.shapes[0].closed };
    const raw = await call('import_step', { name: 'box20-faces.step', heal: false, diagnose: true }, { bytes: bytesOf(faces) });
    const healed = await call('heal', { ids: [raw.shapes[0].id], tol: 0.001 });
    r.heal = { before: raw.shapes[0].type, freeBefore: raw.diagnostics.shapes[0].free_edges, shapes: healed.shapes.length, type: healed.shapes[0].type, valid: healed.shapes[0].valid, sewn: healed.sewn, volume: await vol(healed.shapes[0].id) };

    // The BREP an import stores: out of the worker as an ArrayBuffer, back in as bytes.
    const w = await kernel.call('brep_write', { ids: [v] });
    const brep = w.buffers.brep as ArrayBuffer;
    r.brepWrite = { isBuffer: brep instanceof ArrayBuffer, bytes: brep.byteLength, said: w.result.bytes, occt: w.result.occt };
    const back = await call('brep_read', { check: true }, { bytes: brep.slice(0) });
    r.brepRead = { faces: back.shapes[0].faces, valid: back.shapes[0].valid, same: (await vol(back.shapes[0].id)) === (await vol(v)) };

    // Press-pull: a box face +5; the Vortex inlet cap +50.8 (kept valid).
    const box = await call('box', { dx: 20, dy: 20, dz: 20 });
    const topo = await call('topo', { id: box.id, edges: 'none', vertices: 'none' });
    const top = topo.faces.find((f: R) => f.normal[2] > 0.5).i;
    const pp = await call('press_pull', { id: box.id, faces: [top], d: 5 });
    r.pressBox = { valid: pp.valid, volume: await vol(pp.id), moved: pp.moved.length, faces: pp.faces };
    const vt = await call('topo', { id: v, edges: 'none', vertices: 'none' });
    const cap = vt.faces.find((f: R) => f.type === 'plane' && f.normal[0] > 0.9).i;
    const inlet = await call('press_pull', { id: v, faces: [cap], d: 50.8 });
    r.pressInlet = { valid: inlet.valid, unified: inlet.unified, dv: (await vol(inlet.id)) - (await vol(v)) };

    // Combine: the Vortex fluid domain (box with a 100 mm margin minus Vortex).
    const fb = await call('box', { origin: fluidBox.origin, dx: fluidBox.dx, dy: fluidBox.dy, dz: fluidBox.dz });
    const cut = await call('combine', { op: 'cut', targets: [fb.id], tools: [v] });
    r.combine = { results: cut.results.length, valid: cut.results[0].valid, faces: cut.results[0].faces, volume: await vol(cut.results[0].id) };

    // Measure: two parallel faces of the 20 mm box.
    const bottom = topo.faces.find((f: R) => f.normal[2] < -0.5).i;
    r.measure = await call('measure', { a: { id: box.id, face: bottom }, b: { id: box.id, face: top } });

    // Sketch regions (buffers out of the worker) and extrude by key.
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const curves = [
      { id: 'c_1', kind: 'circle', c: [0, 0], r: 20, pc: 'pt_c1' },
      { id: 'c_2', kind: 'circle', c: [30, 0], r: 20, pc: 'pt_c2' },
    ];
    const sr = await kernel.call('sketch_regions', { plane, curves });
    const ranges = new Uint32Array(sr.buffers.tri_ranges);
    const idx = new Uint32Array(sr.buffers.tri_idx);
    const uv = new Float32Array(sr.buffers.tri_uv);
    r.regions = { keys: sr.result.regions.map((g: R) => g.key), areas: sr.result.regions.map((g: R) => g.area), ranges: Array.from(ranges), idx: idx.length, uv: uv.length, maxIndex: Math.max(...idx) };
    const lens = sr.result.regions[1].key;
    const ex = await call('extrude_regions', { plane, curves, regions: [lens], extent: { kind: 'blind', d: 10 } });
    r.extrude = { valid: ex.valid, faces: ex.faces, volume: await vol(ex.id), sides: Object.keys(ex.history.sides).length, caps: Object.keys(ex.history.caps) };
    r.status = kernel.status.get();
    return r;
  }, input);

  expect(out.version).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 6 });
  expect(out.import).toEqual({ unit: 'inch', faces: 17, valid: true, problems: 0, closed: true });
  expect(out.heal).toMatchObject({ before: 'shell', freeBefore: 24, shapes: 1, type: 'solid', valid: true, sewn: 6 });
  expect(out.heal.volume).toBe(REF.p2p3.heal.box20_faces['heal_0.001'].volume);
  expect(out.brepWrite.isBuffer).toBe(true);
  expect(out.brepWrite.bytes).toBe(out.brepWrite.said);
  expect(out.brepWrite.occt).toBe('7.9.3');
  expect(out.brepRead).toEqual({ faces: 17, valid: true, same: true });
  expect(out.pressBox).toMatchObject({ valid: true, moved: 1, faces: 6 });
  expect(Math.abs(out.pressBox.volume - 10000)).toBeLessThan(1e-8);
  expect(out.pressInlet).toMatchObject({ valid: true, unified: false });
  expect(Math.abs(out.pressInlet.dv - Math.PI * 25.4 ** 2 * 50.8)).toBeLessThan(2e-8 * REF.vortex.import.volume);
  expect(out.combine).toMatchObject({ results: 1, valid: true, faces: REF.cut_fluid.faces });
  expect(Math.abs(out.combine.volume - REF.cut_fluid.volume) / REF.cut_fluid.volume).toBeLessThan(1e-6);
  expect(out.measure.distance).toBeCloseTo(20, 12);
  expect(out.measure.parallel).toBe(true);
  expect(out.regions.keys).toHaveLength(3);
  expect(out.regions.keys[1]).toBe('+c_1[x:c_1|c_2#1>x:c_1|c_2#0] +c_2[x:c_1|c_2#0>x:c_1|c_2#1]');
  expect(out.regions.ranges).toHaveLength(6);
  expect(out.regions.ranges[4] + out.regions.ranges[5]).toBe(out.regions.idx);
  expect(out.regions.maxIndex).toBeLessThan(out.regions.uv / 2);
  const lensArea = 2 * 400 * Math.acos(0.75) - 15 * Math.sqrt(700);
  expect(Math.abs(out.regions.areas[1] - lensArea) / lensArea).toBeLessThan(1e-9);
  expect(out.extrude).toMatchObject({ valid: true, faces: 4, sides: 2, caps: [out.regions.keys[1]] });
  expect(Math.abs(out.extrude.volume - lensArea * 10) / (lensArea * 10)).toBeLessThan(1e-9);
  // One worker the whole time: nothing crashed or timed out.
  expect(out.status).toMatchObject({ state: 'ready', respawns: 0 });
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
