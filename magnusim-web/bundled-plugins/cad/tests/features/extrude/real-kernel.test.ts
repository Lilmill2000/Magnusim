// @vitest-environment node
// Sketches and extrudes on the REAL kernel (mk32.wasm in-process, the real
// KernelAdapter and DocService): profile regions, extrude volumes against
// analytic values, region keys that survive a dimension change, "Profile lost"
// after a trim, a sketch on a face cutting into a block (and following that
// face, or keeping its plane when it is gone), and an inch Part
// (docs/p2p3-plan.md §5.2 items 6-8 and 10, §5.3 flows).
// The kernel is workspace/kernel, or CAD_KERNEL_DIR (tests/kernel/kernel-lib.ts).
// Needs the kernel's API 3 profile ops (sketch_regions, extrude_regions, plan
// §2.8-2.9). With a kernel that has not got them yet, these tests are skipped
// and one skipped test says so by name.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../../src/doc';
import { extrudeDef } from '../../../src/features/extrude/def';
import { sketchDef } from '../../../src/features/sketch/def';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import type { ExtrudeFeature, Feature, PersistentRef, RegionRef, SketchEntity, SketchFeature } from '../../../src/types/doc';
import { block } from '../../doc/blocks';
import type { DocService, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { SketchRegion } from '../../../src/types/sketch';
import { realKernelAdapter } from './kernel-adapter';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { loadKernel } from '../../kernel/kernel-lib';

// Does the kernel under test have the profile ops?
const probe = (await loadKernel()).tryCall('sketch_regions', { plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }, curves: [] }) as { ok: boolean; error?: string };
const HAS_PROFILE_OPS = !(probe.ok === false && /unknown op/i.test(probe.error ?? ''));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function open(units: 'metric' | 'imperial' = 'metric') {
  const ws = createFakeWorkspace({ units });
  const { kernel } = realKernelAdapter();
  await kernel.start();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
  doc.features.register(sketchDef as unknown as FeatureTypeDef);
  doc.features.register(extrudeDef as unknown as FeatureTypeDef);
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

const regionsOf = (doc: DocService, id: string): SketchRegion[] => {
  const out = doc.state.get().rebuild.outputs[id];
  return out?.type === 'sketch' ? out.regions : [];
};
const refOf = (sketch: string, r: SketchRegion): RegionRef => ({ sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** Area of the lens of two circles of radii r1, r2 whose centres are d apart. */
function lensArea(r1: number, r2: number, d: number): number {
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

function rectangle(w: number, h: number, x0 = 0, y0 = 0): { points: SketchFeature['points']; entities: SketchEntity[] } {
  return {
    points: { pt_a: [x0, y0], pt_b: [x0 + w, y0], pt_c: [x0 + w, y0 + h], pt_d: [x0, y0 + h] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
      { id: 'e_4', kind: 'line', p: ['pt_d', 'pt_a'] },
    ],
  };
}

if (!HAS_PROFILE_OPS) it.skip('the kernel in workspace/kernel has no sketch_regions / extrude_regions yet (KERNEL builder, docs/p2p3-plan.md §2.8-2.9)', () => {});

describe.skipIf(!HAS_PROFILE_OPS)('sketches and extrudes on the real kernel', () => {
  it('two overlapping circles make 3 regions; the lens extrudes to its analytic volume and keeps its key through a radius change; a trim loses it', async () => {
    const { doc } = await open();
    const circles = (r2: number): Partial<SketchFeature> => ({
      id: 'f_sk',
      points: { pt_1: [0, 0], pt_2: [30, 0] },
      entities: [
        { id: 'c_1', kind: 'circle', c: 'pt_1', r: 20 },
        { id: 'c_2', kind: 'circle', c: 'pt_2', r: r2 },
      ] as SketchEntity[],
    });
    doc.beginNew('sketch', circles(20) as Partial<Feature>).commit();
    await settle(doc);
    const regions = regionsOf(doc, 'f_sk');
    expect(regions).toHaveLength(3);
    expect(new Set(regions.map((r) => r.key)).size).toBe(3);
    const lens = regions.find((r) => r.sample[0] > 10 && r.sample[0] < 20)!;
    expect(rel(lens.area, lensArea(20, 20, 30))).toBeLessThan(1e-6);
    doc.beginNew('extrude', { id: 'f_ex', profiles: [refOf('f_sk', lens)] } as Partial<Feature>).commit();
    let r = await settle(doc);
    expect(r.features.f_ex.state).toBe('ok');
    expect(rel(r.bodies[0].volume!, lensArea(20, 20, 30) * 10)).toBeLessThan(1e-6);
    expect(r.bodies[0].valid).toBe(true);
    // Radius 20 -> 25: the same key, the volume follows the new lens.
    const s = doc.beginEdit('f_sk');
    s.update(circles(25) as Partial<Feature>);
    s.commit();
    r = await settle(doc);
    expect(regionsOf(doc, 'f_sk').map((x) => x.key).sort()).toEqual(regions.map((x) => x.key).sort());
    expect(r.features.f_ex.state).toBe('ok');
    expect(rel(r.bodies[0].volume!, lensArea(20, 25, 30) * 10)).toBeLessThan(1e-6);
    // Trim: c_2 keeps only its arc outside c_1 (the lens's left boundary is gone): Profile lost.
    const t = doc.beginEdit('f_sk');
    const ang = (deg: number): [number, number] => [30 + 25 * Math.cos((deg * Math.PI) / 180), 25 * Math.sin((deg * Math.PI) / 180)];
    const x = (20 * 20 - 25 * 25 + 30 * 30) / (2 * 30);
    const y = Math.sqrt(20 * 20 - x * x);
    const a0 = (Math.atan2(-y, x - 30) * 180) / Math.PI;
    const a1 = (Math.atan2(y, x - 30) * 180) / Math.PI;
    t.update({
      points: { pt_1: [0, 0], pt_2: [30, 0], pt_3: ang(a0), pt_4: ang(a1) },
      entities: [
        { id: 'c_1', kind: 'circle', c: 'pt_1', r: 20 },
        { id: 'c_2', kind: 'arc', c: 'pt_2', a: 'pt_3', b: 'pt_4' },
      ],
    } as Partial<Feature>);
    t.commit();
    r = await settle(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'error', message: 'Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone' });
  });

  it('the plate flow: a 100 x 60 rectangle with a d 20 hole extrudes to (6000 - 100 pi) x 10; a d 10 circle on its top face cuts 250 pi', async () => {
    const { doc } = await open();
    const rect = rectangle(100, 60);
    doc.beginNew('sketch', { id: 'f_sk', points: { ...rect.points, pt_o: [50, 30] }, entities: [...rect.entities, { id: 'e_5', kind: 'circle', c: 'pt_o', r: 10 }] } as Partial<Feature>).commit();
    await settle(doc);
    const regions = regionsOf(doc, 'f_sk');
    expect(regions).toHaveLength(2);
    const plate = regions.reduce((a, b) => (a.area > b.area ? a : b));
    expect(rel(plate.area, 6000 - 100 * Math.PI)).toBeLessThan(1e-6);
    doc.beginNew('extrude', { id: 'f_ex', profiles: [refOf('f_sk', plate)] } as Partial<Feature>).commit();
    let r = await settle(doc);
    expect(rel(r.bodies[0].volume!, (6000 - 100 * Math.PI) * 10)).toBeLessThan(1e-6);
    const names = r.bodies[0].names!.faces;
    expect(names).toContain('F:f_ex:start');
    expect(names).toContain('F:f_ex:end');
    expect(names.filter((n) => n.startsWith('F:f_ex:side:'))).toHaveLength(5);
    // The end cap (z = 10), by its name, as a sketch support.
    const end = names.indexOf('F:f_ex:end');
    const face: PersistentRef = { name: 'F:f_ex:end', semantic: { feature: 'f_ex', role: 'end' }, signature: { kind: 'face', type: 'plane', at: [50, 30, 10], dir: [0, 0, 1] } };
    expect(end).toBeGreaterThanOrEqual(0);
    doc.beginNew('sketch', { id: 'f_sk2', support: { kind: 'face', body: r.bodies[0].id, face }, points: { pt_h: [20, 20] }, entities: [{ id: 'e_h', kind: 'circle', c: 'pt_h', r: 5 }] } as Partial<Feature>).commit();
    r = await settle(doc);
    expect(r.outputs.f_sk2).toMatchObject({ plane: { origin: [0, 0, 10], normal: [0, 0, 1] } });
    const hole = regionsOf(doc, 'f_sk2')[0];
    doc.beginNew('extrude', { id: 'f_cut', profiles: [refOf('f_sk2', hole)], op: 'cut', creates: null, flip: true } as Partial<Feature>).commit();
    r = await settle(doc);
    expect(r.features.f_cut.state).toBe('ok');
    expect(rel(r.bodies[0].volume!, (6000 - 100 * Math.PI) * 10 - 250 * Math.PI)).toBeLessThan(1e-6);
  });

  it('a sketch on the top face of a 40 x 40 x 20 block (sketched and extruded): a d 10 circle cut 20 mm flipped into it leaves 32,000 - 500 pi', async () => {
    const { doc } = await open();
    const base = block(doc, { size: [40, 40, 20] }).extrude;
    let r = await settle(doc);
    // The block's top is its extrude's end cap.
    expect(r.bodies[0].names!.faces).toContain(`F:${base}:end`);
    const face: PersistentRef = { name: `F:${base}:end`, semantic: { feature: base, role: 'end' }, signature: { kind: 'face', type: 'plane', at: [20, 20, 20], dir: [0, 0, 1] } };
    doc.beginNew('sketch', { id: 'f_sk', support: { kind: 'face', body: r.bodies[0].id, face }, points: { pt_c: [20, 20] }, entities: [{ id: 'e_c', kind: 'circle', c: 'pt_c', r: 5 }] } as Partial<Feature>).commit();
    r = await settle(doc);
    expect(r.features.f_sk.state).toBe('ok');
    const circle = regionsOf(doc, 'f_sk')[0];
    doc.beginNew('extrude', { id: 'f_ex', profiles: [refOf('f_sk', circle)], op: 'cut', creates: null, flip: true, extent: { kind: 'blind', distance: '20 mm' } } as Partial<ExtrudeFeature>).commit();
    r = await settle(doc);
    expect(r.features.f_ex.state).toBe('ok');
    expect(rel(r.bodies[0].volume!, 32_000 - Math.PI * 25 * 20)).toBeLessThan(1e-6);
  });

  it('lies on a face of a body found by its stored reference, follows it, and keeps its plane with a warning when the face is gone', async () => {
    const { doc } = await open();
    const base = block(doc, { size: [40, 40, 20] }).extrude;
    let r = await settle(doc);
    const body = r.bodies[0];
    const top: PersistentRef = { name: `F:${base}:end`, semantic: { feature: base, role: 'end' }, signature: { kind: 'face', type: 'plane', at: [20, 20, 20], dir: [0, 0, 1], size: 1600 } };
    doc.beginNew('sketch', { id: 'f_sk', support: { kind: 'face', body: body.id, face: top } } as Partial<Feature>).commit();
    r = await settle(doc);
    expect(r.features.f_sk.state).toBe('ok');
    expect(r.outputs.f_sk).toMatchObject({ plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } });
    expect(r.outputs.f_sk).not.toHaveProperty('supportLost');
    // The block gets taller: the sketch follows its face.
    const s = doc.beginEdit(base);
    s.update({ extent: { kind: 'blind', distance: '30 mm' } } as Partial<Feature>);
    s.commit();
    r = await settle(doc);
    expect(r.outputs.f_sk).toMatchObject({ plane: { origin: [0, 0, 30] } });
    expect(r.features.f_sk.state).toBe('ok');
    // Its body suppressed: the face is lost, the sketch stays where it was and says so.
    doc.setSuppressed(base, true);
    r = await settle(doc);
    expect(r.features.f_sk).toMatchObject({ state: 'warning', message: 'Sketch 2 lost its face: it stays where it was' });
    expect(r.outputs.f_sk).toMatchObject({ supportLost: true });
  });

  it('the Vortex bin in an inch Part: a d 12 in circle extruded -20 in is pi 6^2 20 in^3', async () => {
    const { doc } = await open('imperial');
    expect(doc.state.get().doc.units.length).toBe('in');
    const id = doc.addParam({ name: 'D_bin', expr: '12 in', quantity: 'length' });
    expect(typeof id).toBe('string');
    doc.beginNew('sketch', { id: 'f_sk', points: { pt_c: [0, 0] }, entities: [{ id: 'e_c', kind: 'circle', c: 'origin', r: 152.4 }] } as Partial<Feature>).commit();
    await settle(doc);
    const disc = regionsOf(doc, 'f_sk')[0];
    doc.beginNew('extrude', { id: 'f_ex', profiles: [refOf('f_sk', disc)], extent: { kind: 'blind', distance: '-20 in' } } as Partial<ExtrudeFeature>).commit();
    const r = await settle(doc);
    expect(rel(r.bodies[0].volume!, Math.PI * 36 * 20 * 25.4 ** 3)).toBeLessThan(1e-6);
    expect(r.bodies[0].bbox[2]).toBeCloseTo(-508, 3);
  });
});
