// @vitest-environment node
// The Enclosure on the REAL kernel (mk32.wasm, the real KernelAdapter and
// DocService): exactly the exact bounding box of the bodies with Zero padding,
// Percent and Fixed, a side set on its own, a cylinder about Z and about X,
// face names by side (OCCT's face order checked by the faces' normals), the
// parametric follow when the enclosed body changes (keeping the user's sides),
// the bodies it takes by default (solid bodies, not other enclosures), and the
// fluid as a separate Combine Cut with Keep tools (enclosure minus part).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../../src/doc';
import { combineDef } from '../../../src/features/combine/feature';
import { BOX_FACE_SIDES } from '../../../src/features/enclosure/def';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import type { CombineFeature, EnclosureFeature, Feature } from '../../../src/types/doc';
import type { DocService, EnclosureOutput, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import { block, cylinder, registerSolidFeatures } from '../../doc/blocks';
import { realKernelAdapter } from '../../doc/inprocess-kernel';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function open() {
  const ws = createFakeWorkspace({ units: 'metric' });
  const { kernel } = realKernelAdapter();
  await kernel.start();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  doc.features.register(combineDef as unknown as FeatureTypeDef);
  disposers.push(() => {
    doc.dispose();
    kernel.dispose();
  });
  await doc.load();
  return { doc, kernel };
}

async function settle(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state ?? 'pending', f.name).not.toBe('pending');
    },
    { timeout: 30_000, interval: 10 },
  );
  return doc.state.get().rebuild;
}

const enclosure = (doc: DocService, patch: Partial<EnclosureFeature> = {}) => {
  const s = doc.beginNew('enclosure', patch as Partial<Feature>);
  s.commit();
  return s.feature;
};
const out = (doc: DocService, id: string) => doc.state.get().rebuild.outputs[id] as EnclosureOutput;
const round = (v: number[]) => v.map((x) => Math.round(x * 1e9) / 1e9);

describe('Enclosure on the real kernel', () => {
  it('Zero padding is exactly the exact bounding box of the body; its body is "Enclosure 1", its faces named by side', async () => {
    const { doc, kernel } = await open();
    // A 40 x 30 x 20 block from (5, -10, 2), and a d 10 cylinder beside it from z = 0 to 25.
    block(doc, { at: [5, -10, 2], size: [40, 30, 20] });
    cylinder(doc, { at: [60, 0, 0], size: [10, 25] });
    const id = enclosure(doc);
    const r = await settle(doc);
    expect(r.features[id]).toMatchObject({ state: 'ok' });
    const o = out(doc, id);
    expect(round(o.bbox)).toEqual([5, -10, 0, 65, 20, 25]);
    expect(round([...o.box!.min, ...o.box!.max])).toEqual([5, -10, 0, 65, 20, 25]);
    const body = r.bodies.find((b) => b.feature === id)!;
    expect(body).toMatchObject({ name: 'Enclosure 1', color: '#d3e1f2', faces: 6, valid: true });
    expect(body.volume).toBeCloseTo(60 * 30 * 25, 6);
    expect(round(body.bbox)).toEqual([5, -10, 0, 65, 20, 25]);
    // Names by side, and the real faces agree: each named face's normal points that way.
    expect(body.names!.faces).toEqual(BOX_FACE_SIDES.map((s) => `F:${id}:enclosure:${s}`));
    const t = await kernel.call('topo', { id: body.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' });
    const dir: Record<string, number[]> = { '-x': [-1, 0, 0], '+x': [1, 0, 0], '-y': [0, -1, 0], '+y': [0, 1, 0], '-z': [0, 0, -1], '+z': [0, 0, 1] };
    for (const f of t.result.faces) expect(round(f.normal!), body.names!.faces[f.i]).toEqual(dir[BOX_FACE_SIDES[f.i]]);
    // The enclosed bodies are as they were: it only adds a body.
    expect(r.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Enclosure 1']);
  });

  it('Percent and Fixed padding, a side set on its own, and a side dragged in to a symmetry plane', async () => {
    const { doc } = await open();
    block(doc, { size: [100, 60, 20] });
    const id = enclosure(doc, { padding: 'percent', percent: '50' });
    let r = await settle(doc);
    let body = r.bodies.find((b) => b.feature === id)!;
    expect(round(body.bbox)).toEqual([-50, -30, -10, 150, 90, 30]);
    const s = doc.beginEdit(id);
    s.update({ padding: 'fixed', distance: '10 mm', sides: { '+x': '200 mm', '-y': '0 mm' } } as Partial<Feature>);
    s.commit();
    r = await settle(doc);
    body = r.bodies.find((b) => b.feature === id)!;
    expect(round(body.bbox)).toEqual([-10, 0, -10, 300, 70, 30]);
    expect(body.volume).toBeCloseTo(310 * 70 * 40, 6);
    expect(out(doc, id).pad).toEqual({ '+x': 200, '-x': 10, '+y': 10, '-y': 0, '+z': 10, '-z': 10 });
  });

  it('follows the body when it changes, keeping the sides the user set', async () => {
    const { doc } = await open();
    const part = block(doc, { size: [40, 40, 20] });
    const id = enclosure(doc, { padding: 'fixed', distance: '10 mm', sides: { '+x': '50 mm' } });
    let r = await settle(doc);
    expect(round(r.bodies.find((b) => b.feature === id)!.bbox)).toEqual([-10, -10, -10, 90, 50, 30]);
    // The part gets 30 mm taller: the enclosure grows with it; +X keeps its 50 mm.
    const e = doc.beginEdit(part.extrude);
    e.update({ extent: { kind: 'blind', distance: '50 mm' } } as Partial<Feature>);
    e.commit();
    r = await settle(doc);
    expect(r.features[id]).toMatchObject({ state: 'ok' });
    expect(round(r.bodies.find((b) => b.feature === id)!.bbox)).toEqual([-10, -10, -10, 90, 50, 60]);
    // The part's sketch gets wider (60 instead of 40 in X): the enclosure follows the new box.
    const sk = doc.beginEdit(part.sketch);
    sk.update({ points: { pt_1: [0, 0], pt_2: [60, 0], pt_3: [60, 40], pt_4: [0, 40] } } as Partial<Feature>);
    sk.commit();
    r = await settle(doc);
    expect(round(r.bodies.find((b) => b.feature === id)!.bbox)).toEqual([-10, -10, -10, 110, 50, 60]);
  });

  it('a cylinder about Z and about X: the radius through the box corners, Top and Bottom along the axis; names side, top, bottom (about X: +x-end, -x-end)', async () => {
    const { doc, kernel } = await open();
    block(doc, { at: [-20, -15, 0], size: [40, 30, 10] });
    const z = enclosure(doc, { shape: 'cylinder', axis: 'origin:z', padding: 'fixed', distance: '5 mm' });
    let r = await settle(doc);
    let body = r.bodies.find((b) => b.feature === z)!;
    const r0 = Math.hypot(40, 30) / 2;
    expect(body.volume).toBeCloseTo(Math.PI * (r0 + 5) ** 2 * 20, 5);
    expect(round(body.bbox)).toEqual(round([-(r0 + 5), -(r0 + 5), -5, r0 + 5, r0 + 5, 15]));
    expect(body.names!.faces).toEqual([`F:${z}:enclosure:side`, `F:${z}:enclosure:top`, `F:${z}:enclosure:bottom`]);
    const t = await kernel.call('topo', { id: body.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' });
    expect(t.result.faces.map((f) => f.type)).toEqual(['cylinder', 'plane', 'plane']);
    expect(round(t.result.faces[1].normal!)).toEqual([0, 0, 1]);
    expect(round(t.result.faces[2].normal!)).toEqual([0, 0, -1]);
    // About X (the axis through the middle of Y and Z).
    const s = doc.beginEdit(z);
    s.update({ axis: 'origin:x', padding: 'zero' } as Partial<Feature>);
    s.commit();
    r = await settle(doc);
    body = r.bodies.find((b) => b.feature === z)!;
    const rx = Math.hypot(30, 10) / 2;
    expect(body.volume).toBeCloseTo(Math.PI * rx * rx * 40, 5);
    expect(round(body.bbox)).toEqual(round([-20, -rx, 5 - rx, 20, rx, 5 + rx]));
    // Its ends are named by the axis (SD review round 1: "Top" on a cylinder lying along X).
    expect(body.names!.faces).toEqual([`F:${z}:enclosure:side`, `F:${z}:enclosure:+x-end`, `F:${z}:enclosure:-x-end`]);
    const tx = await kernel.call('topo', { id: body.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' });
    expect(round(tx.result.faces[1].normal!)).toEqual([1, 0, 0]);
    expect(round(tx.result.faces[2].normal!)).toEqual([-1, 0, 0]);
  });

  it('by default it wraps every solid body before it, but not another enclosure; picked bodies only when picked', async () => {
    const { doc } = await open();
    const a = block(doc, { size: [10, 10, 10] });
    block(doc, { at: [100, 0, 0], size: [10, 10, 10] });
    const e1 = enclosure(doc, { padding: 'fixed', distance: '5 mm' });
    const e2 = enclosure(doc);
    let r = await settle(doc);
    expect(out(doc, e2).bodies).toEqual(out(doc, e1).bodies);
    expect(round(out(doc, e2).bbox)).toEqual([0, 0, 0, 110, 10, 10]);
    // Only the first block, picked.
    const s = doc.beginEdit(e2);
    s.update({ bodies: [a.body!] } as Partial<Feature>);
    s.commit();
    r = await settle(doc);
    expect(round(r.bodies.find((b) => b.feature === e2)!.bbox)).toEqual([0, 0, 0, 10, 10, 10]);
    // A picked body that is gone says so.
    doc.setSuppressed(a.extrude, true);
    r = await settle(doc);
    expect(r.features[e2]).toMatchObject({ state: 'error', message: 'Enclosure 2 failed: Body 1 is not there at this point' });
  });

  it('never cuts: the fluid is a separate Combine, Cut with Keep tools (enclosure minus part); its faces keep their side names', async () => {
    const { doc } = await open();
    const part = block(doc, { size: [20, 20, 20] });
    const enc = enclosure(doc, { padding: 'fixed', distance: '10 mm' });
    let r = await settle(doc);
    const encBody = r.bodies.find((b) => b.feature === enc)!;
    expect(r.bodies).toHaveLength(2);
    const c = doc.beginNew('combine', { op: 'cut', targets: [encBody.id], tools: [part.body!], keepTools: true } as Partial<CombineFeature>);
    c.commit();
    r = await settle(doc);
    expect(r.features[c.feature]).toMatchObject({ state: 'ok' });
    // The part stays (kept tool); the enclosure's body is now the fluid: 40³ - 20³.
    expect(r.bodies.map((b) => b.id).sort()).toEqual([part.body!, encBody.id].sort());
    const fluid = r.bodies.find((b) => b.id === encBody.id)!;
    expect(fluid.volume).toBeCloseTo(40 ** 3 - 20 ** 3, 6);
    expect(fluid.valid).toBe(true);
    for (const s of BOX_FACE_SIDES) expect(fluid.names?.faces).toContain(`F:${enc}:enclosure:${s}`);
    // The part grows: the enclosure follows, and so does the fluid.
    const e = doc.beginEdit(part.extrude);
    e.update({ extent: { kind: 'blind', distance: '30 mm' } } as Partial<Feature>);
    e.commit();
    r = await settle(doc);
    expect(r.bodies.find((b) => b.id === encBody.id)!.volume).toBeCloseTo(40 * 40 * 50 - 20 * 20 * 30, 6);
  });
});
