// @vitest-environment node
// The document service with the REAL kernel (mk32.wasm through the real
// KernelAdapter, in-process): solids made from sketches (a rectangle or a
// circle on an origin plane, then Extrude: tests/doc/blocks.ts), join / cut /
// intersect volumes against analytic values, validity, units, parameters and
// the rebuild cache, undo/redo, and a transparent rebuild after a respawn.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, cylinder, registerSolidFeatures } from './blocks';
import { realKernelAdapter } from './inprocess-kernel';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function open(units: 'metric' | 'imperial' = 'metric') {
  const ws = createFakeWorkspace({ units });
  const { kernel, workers } = realKernelAdapter();
  await kernel.start();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  disposers.push(() => {
    doc.dispose();
    kernel.dispose();
  });
  await doc.load();
  return { ws, kernel, workers, doc };
}

async function settle(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state ?? 'pending', f.name).not.toBe('pending');
    },
    { timeout: 20_000, interval: 10 },
  );
  return doc.state.get().rebuild;
}

const V_CYL_IN_BLOCK = Math.PI * 5 * 5 * 20;

describe('document on the real kernel', () => {
  it('a block and a cylinder cut through it, both from sketches: exact volumes, faces, validity', async () => {
    const { doc } = await open();
    block(doc);
    let r = await settle(doc);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toMatchObject({ name: 'Body 1', faces: 6, edges: 12, valid: true });
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
    expect(r.bodies[0].area).toBeCloseTo(2400, 6);
    expect(r.bodies[0].bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0, 20, 20, 20]);
    expect(r.bodies[0].tess!.indices.length).toBeGreaterThan(0);
    expect(r.bodies[0].tess!.faceRanges.length).toBe(12);

    // A circle d 10 at (10, 10), extruded from z = -5 to 35 (Two sides), cutting through it.
    const cut = cylinder(doc, { op: 'cut', at: [10, 10, -5], size: [10, 40] }).extrude;
    r = await settle(doc);
    expect(r.features[cut]).toMatchObject({ state: 'ok' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].feature).toBe(cut);
    expect(r.bodies[0].valid).toBe(true);
    expect(r.bodies[0].volume).toBeCloseTo(8000 - V_CYL_IN_BLOCK, 6);
    expect(r.bodies[0].faces).toBe(7);
  });

  it('join and intersect, and a body cut away completely', async () => {
    const { doc } = await open();
    block(doc);
    block(doc, { op: 'join', at: [10, 0, 0] });
    let r = await settle(doc);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(30 * 20 * 20, 6);
    // Same-domain faces merged (history-preserving unify): a plain 30x20x20 block.
    expect(r.bodies[0].faces).toBe(6);

    cylinder(doc, { op: 'intersect', at: [10, 10, -5], size: [10, 40] });
    r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(V_CYL_IN_BLOCK, 6);
    expect(r.bodies[0].faces).toBe(3);

    const big = block(doc, { op: 'cut', at: [-50, -50, -50], size: [200, 200, 200] }).extrude;
    r = await settle(doc);
    expect(r.bodies).toEqual([]);
    expect(r.features[big]).toMatchObject({ state: 'warning', message: 'Body 1 was removed completely' });
    doc.undo();
    r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(V_CYL_IN_BLOCK, 6);
  });

  it('a cut that touches nothing is a red no-op; later features still build', async () => {
    const { doc } = await open();
    block(doc);
    const miss = block(doc, { op: 'cut', at: [100, 0, 0] }).extrude;
    cylinder(doc, { at: [50, 0, 0] });
    const r = await settle(doc);
    expect(r.features[miss]).toMatchObject({ state: 'error', message: 'Nothing to cut: Extrude 2 does not overlap any body made before it (touching is not enough)' });
    expect(r.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
  });

  it('a Cut or Intersect flush against a face cuts nothing and says touching is not enough (P1.5 review round 1)', async () => {
    const { doc } = await open();
    block(doc);
    // Extrude 2 shares Extrude 1's +X face (x = 20) over the whole face: no volume in common.
    const flushCut = block(doc, { op: 'cut', at: [20, 0, 0] }).extrude;
    const flushIntersect = block(doc, { op: 'intersect', at: [0, 20, 0] }).extrude;
    const r = await settle(doc);
    expect(r.features[flushCut]).toMatchObject({ state: 'error', message: 'Nothing to cut: Extrude 2 does not overlap any body made before it (touching is not enough)' });
    expect(r.features[flushIntersect]).toMatchObject({ state: 'error', message: 'Nothing to intersect: Extrude 3 does not overlap any body made before it (touching is not enough)' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
  });

  it('Join takes a body the new extrude only touches (a shared face): one body of both; apart, it has nothing to join (review round 3)', async () => {
    const { doc } = await open();
    block(doc);
    const touching = block(doc, { op: 'join', at: [20, 0, 0] }).extrude;
    let r = await settle(doc);
    expect(r.features[touching]).toMatchObject({ state: 'ok', bodiesBefore: 1 });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
    // Same-domain faces merged: a plain 40 x 20 x 20 block.
    expect(r.bodies[0].faces).toBe(6);
    const apart = block(doc, { op: 'join', at: [100, 0, 0] }).extrude;
    r = await settle(doc);
    expect(r.features[apart]).toMatchObject({ state: 'error', message: 'Nothing to join: Extrude 3 shares no face with a body made before it' });
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
    // Only an edge (x = 40, y = 20) or only a corner in common: they touch, but share no face (P1.5 review round 1).
    // The corner block starts at z = 20: Two sides from the Top plane (40 mm along +Z, -20 mm against it).
    const edge = block(doc, { op: 'join', at: [40, 20, 0] }).extrude;
    const corner = block(doc, { op: 'join', at: [40, 20, 20] }).extrude;
    r = await settle(doc);
    expect(r.features[edge]).toMatchObject({ state: 'error', message: 'Nothing to join: Extrude 4 shares no face with a body made before it' });
    expect(r.features[corner]).toMatchObject({ state: 'error', message: 'Nothing to join: Extrude 5 shares no face with a body made before it' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
  });

  it('a block whose z range starts above the Top plane (Two sides with a negative second distance) is exactly there', async () => {
    const { doc } = await open();
    block(doc, { at: [5, 6, 20], size: [10, 20, 30] });
    const r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(6000, 6);
    expect(r.bodies[0].bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 6, 20, 15, 26, 50]);
  });

  it('inch parts: a bare 1 is one inch; a cylinder along X (a circle on the Right plane)', async () => {
    const { doc } = await open('imperial');
    expect(doc.state.get().doc.units.length).toBe('in');
    block(doc, { size: [25.4, 25.4, 25.4], extrude: { extent: { kind: 'blind', distance: '1' } } });
    // d 0.5 in, from x = 2 in, 3 cm long: Two sides along +X from the Right plane.
    cylinder(doc, { axis: 'x', at: [50.8, 0, 0], size: [12.7, 30], extrude: { extent: { kind: 'two', distance: '2 + 3 cm', distance2: '-2' } } });
    const r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(25.4 ** 3, 6);
    const c = r.bodies[1];
    expect(c.volume).toBeCloseTo(Math.PI * 6.35 * 6.35 * 30, 6);
    expect(c.bbox[0]).toBeCloseTo(50.8, 6);
    expect(c.bbox[3]).toBeCloseTo(80.8, 6);
  });

  it('parameters drive the model; an edit rebuilds only from the changed feature; undo/redo', async () => {
    const { doc, workers } = await open();
    const w = doc.addParam({ name: 'w', expr: '40', quantity: 'length' }) as string;
    block(doc);
    // A 10 x 20 profile, w along +Z and w / 2 against it: 10 x 20 x 1.5 w.
    block(doc, { at: [100, 0, 0], size: [10, 20, 1], extrude: { extent: { kind: 'two', distance: 'w', distance2: 'w / 2' } } });
    let r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(10 * 20 * 60, 6);
    const ops = (op: string) => workers[0].ops.filter((o) => o === op).length;
    const [extrudes, sketches] = [ops('extrude_regions'), ops('sketch_regions')];
    expect(doc.updateParam(w, { expr: '60' })).toEqual({ ok: true });
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(10 * 20 * 90, 6);
    // Extrude 1 and both sketches did not use w: they came from the cache (one extrude, for Extrude 2).
    expect(ops('extrude_regions') - extrudes).toBe(1);
    expect(ops('sketch_regions') - sketches).toBe(0);
    doc.undo();
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(10 * 20 * 60, 6);
    doc.redo();
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(10 * 20 * 90, 6);
  });

  it('after a respawn every body is rebuilt in the new worker, transparently', async () => {
    const { doc, kernel, workers } = await open();
    block(doc);
    cylinder(doc, { op: 'cut', at: [10, 10, -5], size: [10, 40] });
    const r1 = await settle(doc);
    const seq = r1.seq;
    await kernel.restart('test respawn');
    await vi.waitFor(() => expect(doc.state.get().rebuild.seq).toBeGreaterThan(seq), { timeout: 20_000 });
    const r2 = await settle(doc);
    expect(workers).toHaveLength(2);
    expect(r2.bodies[0].volume).toBeCloseTo(8000 - V_CYL_IN_BLOCK, 6);
    expect(r2.bodies[0].tessKey).toBe(r1.bodies[0].tessKey);
    // The shape id is alive in the new worker.
    const p = await kernel.call('props', { id: r2.bodies[0].shape, volume: true, bbox: 'none', bbox_mode: 'fast' });
    expect(p.result.faces).toBe(7);
    expect(workers[1].ops).toContain('boolean');
  });
});
