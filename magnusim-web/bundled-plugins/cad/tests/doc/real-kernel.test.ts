// @vitest-environment node
// The document service with the REAL kernel (mk32.wasm through the real
// KernelAdapter, in-process): box, cylinder, join / cut / intersect volumes
// against analytic values, validity, units, parameters and the rebuild cache,
// undo/redo, and a transparent rebuild after a respawn.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { BoxFeature, CylinderFeature } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
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

const V_CYL_IN_BOX = Math.PI * 5 * 5 * 20;

describe('document on the real kernel', () => {
  it('a box and a cylinder cut through it: exact volumes, faces, validity', async () => {
    const { doc } = await open();
    doc.beginNew('box').commit();
    let r = await settle(doc);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toMatchObject({ name: 'Body 1', faces: 6, edges: 12, valid: true });
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
    expect(r.bodies[0].area).toBeCloseTo(2400, 6);
    expect(r.bodies[0].bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0, 20, 20, 20]);
    expect(r.bodies[0].tess!.indices.length).toBeGreaterThan(0);
    expect(r.bodies[0].tess!.faceRanges.length).toBe(12);

    const s = doc.beginNew('cylinder', { op: 'cut', creates: null, origin: ['10', '10', '-5'], diameter: '10', height: '40' } as Partial<CylinderFeature>);
    s.commit();
    r = await settle(doc);
    const cylId = doc.state.get().doc.features[1].id;
    expect(r.features[cylId]).toMatchObject({ state: 'ok' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].feature).toBe(cylId);
    expect(r.bodies[0].valid).toBe(true);
    expect(r.bodies[0].volume).toBeCloseTo(8000 - V_CYL_IN_BOX, 6);
    expect(r.bodies[0].faces).toBe(7);
  });

  it('join and intersect, and a body cut away completely', async () => {
    const { doc } = await open();
    doc.beginNew('box').commit();
    doc.beginNew('box', { op: 'join', creates: null, origin: ['10', '0', '0'] } as Partial<BoxFeature>).commit();
    let r = await settle(doc);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(30 * 20 * 20, 6);
    // Same-domain faces merged (history-preserving unify): a plain 30x20x20 block.
    expect(r.bodies[0].faces).toBe(6);

    doc.beginNew('cylinder', { op: 'intersect', creates: null, origin: ['10', '10', '-5'], diameter: '10', height: '40' } as Partial<CylinderFeature>).commit();
    r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(V_CYL_IN_BOX, 6);
    expect(r.bodies[0].faces).toBe(3);

    const big = doc.beginNew('box', { op: 'cut', creates: null, origin: ['-50', '-50', '-50'], size: ['200', '200', '200'] } as Partial<BoxFeature>);
    big.commit();
    r = await settle(doc);
    expect(r.bodies).toEqual([]);
    expect(r.features[big.feature]).toMatchObject({ state: 'warning', message: 'Body 1 was removed completely' });
    doc.undo();
    r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(V_CYL_IN_BOX, 6);
  });

  it('a cut that touches nothing is a red no-op; later features still build', async () => {
    const { doc } = await open();
    doc.beginNew('box').commit();
    const miss = doc.beginNew('box', { op: 'cut', creates: null, origin: ['100', '0', '0'] } as Partial<BoxFeature>);
    miss.commit();
    doc.beginNew('cylinder', { origin: ['50', '0', '0'] } as Partial<CylinderFeature>).commit();
    const r = await settle(doc);
    expect(r.features[miss.feature]).toMatchObject({ state: 'error', message: 'Nothing to cut: Box 2 does not overlap any body made before it (touching is not enough)' });
    expect(r.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
  });

  it('a Cut or Intersect flush against a face cuts nothing and says touching is not enough (P1.5 review round 1)', async () => {
    const { doc } = await open();
    doc.beginNew('box').commit();
    // Box 2 shares Box 1's +X face (x = 20) over the whole face: no volume in common.
    const flushCut = doc.beginNew('box', { op: 'cut', creates: null, origin: ['20', '0', '0'] } as Partial<BoxFeature>);
    flushCut.commit();
    const flushIntersect = doc.beginNew('box', { op: 'intersect', creates: null, origin: ['0', '20', '0'] } as Partial<BoxFeature>);
    flushIntersect.commit();
    const r = await settle(doc);
    expect(r.features[flushCut.feature]).toMatchObject({ state: 'error', message: 'Nothing to cut: Box 2 does not overlap any body made before it (touching is not enough)' });
    expect(r.features[flushIntersect.feature]).toMatchObject({ state: 'error', message: 'Nothing to intersect: Box 3 does not overlap any body made before it (touching is not enough)' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(8000, 6);
  });

  it('Join takes a body the new box only touches (a shared face): one body of both; apart, it has nothing to join (review round 3)', async () => {
    const { doc } = await open();
    doc.beginNew('box').commit();
    const touching = doc.beginNew('box', { op: 'join', creates: null, origin: ['20', '0', '0'] } as Partial<BoxFeature>);
    touching.commit();
    let r = await settle(doc);
    expect(r.features[touching.feature]).toMatchObject({ state: 'ok', bodiesBefore: 1 });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
    // Same-domain faces merged: a plain 40 x 20 x 20 block.
    expect(r.bodies[0].faces).toBe(6);
    const apart = doc.beginNew('box', { op: 'join', creates: null, origin: ['100', '0', '0'] } as Partial<BoxFeature>);
    apart.commit();
    r = await settle(doc);
    expect(r.features[apart.feature]).toMatchObject({ state: 'error', message: 'Nothing to join: Box 3 shares no face with a body made before it' });
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
    // Only an edge (x = 40, y = 20) or only a corner in common: they touch, but share no face (P1.5 review round 1).
    const edge = doc.beginNew('box', { op: 'join', creates: null, origin: ['40', '20', '0'] } as Partial<BoxFeature>);
    edge.commit();
    const corner = doc.beginNew('box', { op: 'join', creates: null, origin: ['40', '20', '20'] } as Partial<BoxFeature>);
    corner.commit();
    r = await settle(doc);
    expect(r.features[edge.feature]).toMatchObject({ state: 'error', message: 'Nothing to join: Box 4 shares no face with a body made before it' });
    expect(r.features[corner.feature]).toMatchObject({ state: 'error', message: 'Nothing to join: Box 5 shares no face with a body made before it' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(16000, 6);
  });

  it('inch parts: a bare 1 is one inch; a cylinder along X', async () => {
    const { doc } = await open('imperial');
    expect(doc.state.get().doc.units.length).toBe('in');
    doc.beginNew('box', { size: ['1', '1', '1'] } as Partial<BoxFeature>).commit();
    doc.beginNew('cylinder', { axis: 'origin:x', origin: ['2', '0', '0'], diameter: '0.5', height: '3 cm' } as Partial<CylinderFeature>).commit();
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
    doc.beginNew('box').commit();
    doc.beginNew('box', { origin: ['100', '0', '0'], size: ['w', 'w / 2', '10'] } as Partial<BoxFeature>).commit();
    let r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(40 * 20 * 10, 6);
    const before = workers[0].ops.filter((o) => o === 'box').length;
    expect(doc.updateParam(w, { expr: '60' })).toEqual({ ok: true });
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(60 * 30 * 10, 6);
    // Box 1 did not use w: it came from the cache (one box op, for Box 2).
    expect(workers[0].ops.filter((o) => o === 'box').length - before).toBe(1);
    doc.undo();
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(40 * 20 * 10, 6);
    doc.redo();
    r = await settle(doc);
    expect(r.bodies[1].volume).toBeCloseTo(60 * 30 * 10, 6);
  });

  it('after a respawn every body is rebuilt in the new worker, transparently', async () => {
    const { doc, kernel, workers } = await open();
    doc.beginNew('box').commit();
    doc.beginNew('cylinder', { op: 'cut', creates: null, origin: ['10', '10', '-5'], diameter: '10', height: '40' } as Partial<CylinderFeature>).commit();
    const r1 = await settle(doc);
    const seq = r1.seq;
    await kernel.restart('test respawn');
    await vi.waitFor(() => expect(doc.state.get().rebuild.seq).toBeGreaterThan(seq), { timeout: 20_000 });
    const r2 = await settle(doc);
    expect(workers).toHaveLength(2);
    expect(r2.bodies[0].volume).toBeCloseTo(8000 - V_CYL_IN_BOX, 6);
    expect(r2.bodies[0].tessKey).toBe(r1.bodies[0].tessKey);
    // The shape id is alive in the new worker.
    const p = await kernel.call('props', { id: r2.bodies[0].shape, volume: true, bbox: 'none', bbox_mode: 'fast' });
    expect(p.result.faces).toBe(7);
    expect(workers[1].ops).toContain('boolean');
  });
});
