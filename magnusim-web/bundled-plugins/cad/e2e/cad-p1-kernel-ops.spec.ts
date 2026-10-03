// The shipped kernel (workspace/kernel: worker + mk32.wasm) inside the Part's
// sandboxed frame, driven through the page's own KernelAdapter: every modelling op
// reports `valid` with reasons, the P0 top-centre fuse comes back invalid and
// repair fixes it, a failed fillet leaves its body untouched (the P0 Vortex
// finding), props are cheap by default, tessellate sends edge flags. No kernel UI
// exists yet, so this checks the kernel's answers (window.__CAD__, state only),
// plus no CSP violations, no console errors and no worker respawn.
// Owner: KERNEL-HARDENING.
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
const CALLS = JSON.parse(readFileSync(join(FIX, 'vortex-recipe.calls.json'), 'utf8')).calls;

test('cad:p1-kernel-ops the kernel in the Part frame checks, copies and repairs', async ({ page, request }) => {
  const missing = "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step";
  if (!VORTEX) console.warn(`[cad:p1-kernel-ops] skipped: ${missing}`);
  test.skip(!VORTEX, missing);
  expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  await partOpened(page);
  const frame = workspaceFrame(page);

  const input = {
    step: readFileSync(VORTEX).toString('base64'),
    topBox: REF.fuse_box200_topcentre.box,
    calls: CALLS,
  };
  const out = await frame.evaluate(async ({ step, topBox, calls }) => {
    type R = Record<string, any>;
    const kernel = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R, o?: R): Promise<R>; status: { get(): R } } } } }).__CAD__.services.kernel;
    const call = async (op: string, p: R, o?: R) => (await kernel.call(op, p, o)).result as R;
    const fail = async (op: string, p: R) => {
      try {
        await kernel.call(op, p);
        return null;
      } catch (e) {
        return { kind: (e as R).kind, message: String((e as Error).message) };
      }
    };
    const vol = async (id: number) => (await call('props', { id, volume: true, bbox: 'none' })).volume as number;
    const r: R = {};
    r.version = await call('version', {});
    const bytes = Uint8Array.from(atob(step), (c) => c.charCodeAt(0)).buffer;
    const imp = await call('import_step', { name: 'vortex.step' }, { bytes });
    const vortex = imp.shapes[0].id;
    r.props = await call('props', { id: vortex });
    const box = await call('box', { origin: topBox.origin, dx: topBox.dx, dy: topBox.dy, dz: topBox.dz });
    r.box = { valid: box.valid };
    const fuse = await call('boolean', { op: 'fuse', targets: [vortex], tools: [box.id] });
    r.fuse = { valid: fuse.valid, reason: fuse.reason, counts: fuse.problem_counts, volume: await vol(fuse.id) };
    const rep = await call('repair', { id: fuse.id });
    r.repair = { valid: rep.valid, fixed: rep.fixed, volume: await vol(rep.id) };
    const t = await kernel.call('tessellate', { id: vortex });
    const flags = new Uint8Array(t.buffers.edge_flags);
    r.tess = { edges: t.buffers.edge_ranges.byteLength / 8, flags: flags.length, hidden: t.result.hidden_edges, counted: flags.filter((f) => f & 15).length };
    const flipped = await call('extrude', { profile: { plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }, loops: [[{ id: 'c', kind: 'circle', c: [0, 0], r: 5 }]] }, extent: { kind: 'blind', d: 10 }, flip: true });
    r.flip = (await call('props', { id: flipped.id, bbox: 'exact' })).bbox;

    // The P0 finding: the Vortex recipe up to the inlet, the inlet blend (OCCT cannot
    // build it), then the vortex-finder cut must still remove the ring.
    const between = async (id: number, names: Map<number, Set<string>>, a: string, b: string) => {
      const topo = await call('topo', { id, faces: 'none', vertices: 'none' });
      const has = (fi: number, n: string) => !!names.get(fi)?.has(n);
      return topo.edges.filter((e: R) => e.faces.length === 2 && ((has(e.faces[0], a) && has(e.faces[1], b)) || (has(e.faces[0], b) && has(e.faces[1], a)))).map((e: R) => e.i);
    };
    const named = new Map<number, Map<number, Set<string>>>();
    const set = (id: number, fi: number, n: string) => {
      if (!named.has(id)) named.set(id, new Map());
      const m = named.get(id)!;
      if (!m.has(fi)) m.set(fi, new Set());
      m.get(fi)!.add(n);
    };
    const sweep = (res: R, feat: string) => {
      for (const [seg, fi] of Object.entries(res.history.sides as Record<string, number>)) set(res.id, fi, `F:${feat}:side:${seg}`);
      if (res.history.start != null) set(res.id, res.history.start, `F:${feat}:start`);
    };
    const inherit = (res: R) => {
      for (const f of res.history.faces) for (const s of f.from) for (const n of named.get(s.shape)?.get(s.face) ?? []) set(res.id, f.out, n);
    };
    const bin = await call('extrude', calls[0].params);
    sweep(bin, 'f_bin');
    const cone = await call('revolve', calls[1].params);
    sweep(cone, 'f_cone');
    const j1 = await call('boolean', { op: 'fuse', targets: [bin.id], tools: [cone.id] });
    inherit(j1);
    const neck = await call('fillet', { id: j1.id, edges: await between(j1.id, named.get(j1.id)!, 'F:f_cone:side:e_slant', 'F:f_bin:start'), r: calls[3].params.r });
    inherit(neck);
    const inlet = await call('extrude', calls[4].params);
    sweep(inlet, 'f_in');
    const body = await call('boolean', { op: 'fuse', targets: [neck.id], tools: [inlet.id] });
    inherit(body);
    const v0 = await vol(body.id);
    const blendEdges = await between(body.id, named.get(body.id)!, 'F:f_in:side:e_in', 'F:f_cone:side:e_slant');
    const blend = await call('fillet', { id: body.id, edges: blendEdges, r: 3.175 });
    // Its longest edge alone (170.8 mm) is refused outright ('1 faulty vertex'), natively too.
    const lens = (await call('topo', { id: body.id, faces: 'none', vertices: 'none', edges: blendEdges })).edges as R[];
    const longest = lens.reduce((x, y) => (y.length > x.length ? y : x)).i;
    const refused = await fail('fillet', { id: body.id, edges: [longest], r: 3.175 });
    const ring = await call('extrude', calls[7].params);
    const cut = await call('boolean', { op: 'cut', targets: [body.id], tools: [ring.id] });
    r.poison = { blendEdges: blendEdges.length, blendValid: blend.valid, blendReason: blend.reason, refused, bodyAfter: await vol(body.id), v0, removed: v0 - (await vol(cut.id)), cutValid: cut.valid };
    r.status = kernel.status.get();
    return r;
  }, input);

  // API 3 since P2/P3 (docs/p2p3-plan.md §2; the API 3 ops: cad-p2-kernel-ops.spec.ts).
  expect(out.version).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 3 });
  // props: cheap by default.
  expect(out.props).toMatchObject({ faces: 17, edges: 34, bbox_mode: 'fast' });
  expect(out.props.volume).toBeUndefined();
  expect(out.box.valid).toBe(true);
  // The known defect: reported, with the reason; repair makes it valid at the native repaired volume.
  expect(out.fuse.valid).toBe(false);
  expect(out.fuse.reason).toMatch(/UnorientableShape/);
  expect(Math.abs(out.fuse.volume - REF.fuse_box200_topcentre.volume) / REF.fuse_box200_topcentre.volume).toBeLessThan(1e-9);
  expect(out.repair).toMatchObject({ valid: true, fixed: true });
  expect(Math.abs(out.repair.volume - REF.fuse_box200_topcentre.shapefix_repaired.volume) / out.repair.volume).toBeLessThan(1e-9);
  // Edge flags: one per edge; the hidden count matches the bits.
  expect(out.tess.flags).toBe(34);
  expect(out.tess.edges).toBe(34);
  expect(out.tess.hidden).toBe(out.tess.counted);
  // Flip goes against the plane normal.
  expect(out.flip[2]).toBeCloseTo(-10, 6);
  expect(out.flip[5]).toBeCloseTo(0, 6);
  // The failed blend is reported, the body is untouched, and the cut removes the ring.
  expect(out.poison.blendEdges).toBe(3);
  expect(out.poison.blendValid).toBe(false);
  expect(out.poison.refused).toMatchObject({ kind: 'occt' });
  expect(out.poison.bodyAfter).toBe(out.poison.v0);
  expect(out.poison.cutValid).toBe(true);
  expect(Math.abs(out.poison.removed - 42353.5118) / 42353.5118).toBeLessThan(1e-6);
  // One worker the whole time: nothing crashed or timed out.
  expect(out.status).toMatchObject({ state: 'ready', respawns: 0 });
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
