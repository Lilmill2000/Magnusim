// @vitest-environment node
// Press-pull and Measure on the real kernel (they need kernel API 3; until the
// shipped kernel has it these tests say so in their names and are skipped):
// a block's face +5 / -5 (10,000 / 6,000 mm³), the flange's top +10 with its
// holes (2 x 96,858.41) and without them (200,000), the moved face keeping its
// name and the sides named by their edges; Measure's distance between two
// parallel faces, a cylinder's radius, two corners. The block and the cylinder
// are sketched and extruded (tests/doc/blocks.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { pickFace } from '../../../src/features/p2/refs';
import type { DeleteFacesFeature, PersistentRef, PressPullFeature } from '../../../src/types/doc';
import { block, cylinder, registerSolidFeatures } from '../../doc/blocks';
import { importFixture, openRealDoc, settle, type RealDoc } from './real-doc';
import { realKernelAnywhere } from './kernel-anywhere';

// Asked before the tests are collected: a kernel without API 3 skips them, by name.
const api = await (async () => {
  const k = realKernelAnywhere();
  await k.start();
  const v = (await k.call('version', {} as never)).result.api ?? 0;
  k.dispose();
  return v;
})();
const open: RealDoc[] = [];
afterAll(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});
async function part() {
  const r = await openRealDoc();
  registerSolidFeatures(r.doc);
  open.push(r);
  return r;
}

/** The face of body 0 whose outward normal is `n` (a flat face), as a stored reference. */
async function faceByNormal(r: RealDoc, n: [number, number, number], bodyIndex = 0): Promise<{ body: string; ref: PersistentRef; index: number }> {
  const b = r.doc.state.get().rebuild.bodies[bodyIndex];
  const t = await r.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
  const f = t.result.faces.filter((x) => x.type === 'plane' && x.normal && Math.abs(x.normal[0] - n[0]) + Math.abs(x.normal[1] - n[1]) + Math.abs(x.normal[2] - n[2]) < 1e-6).sort((a, c) => (c.area ?? 0) - (a.area ?? 0))[0];
  expect(f, `a flat face with normal ${n}`).toBeTruthy();
  const p = await pickFace(r.services, b, f.i, null);
  if (!p.ok) throw new Error(p.reason);
  return { body: b.id, ref: p.ref, index: f.i };
}

const needs = () => api < 3;

describe('Press-pull on the real kernel (needs kernel API 3)', () => {
  it.skipIf(needs())('a block face +5 mm adds 2,000 mm³; -5 mm removes 2,000; the moved face keeps its name, the sides are named by their edges', async () => {
    const r = await part();
    block(r.doc);
    await settle(r.doc);
    const top = await faceByNormal(r, [0, 0, 1]);
    const s = r.doc.beginNew('press_pull', { body: top.body, faces: [top.ref], distance: '5 mm' } as Partial<PressPullFeature>);
    s.commit();
    let rb = await settle(r.doc);
    const pp = r.doc.state.get().doc.features[2];
    expect(rb.features[pp.id]).toMatchObject({ state: 'ok' });
    expect(rb.bodies[0].volume).toBeCloseTo(10000, 6);
    expect(rb.bodies[0].bbox[5]).toBeCloseTo(25, 6);
    expect(rb.bodies[0].faces).toBe(6);
    // The moved top keeps its name (the side walls merge with the block's own: same planes).
    expect(rb.bodies[0].names?.faces).toContain(top.ref.name);
    const e = r.doc.beginEdit(pp.id);
    e.update({ distance: '-5 mm' } as Partial<PressPullFeature>);
    e.commit();
    rb = await settle(r.doc);
    expect(rb.bodies[0].volume).toBeCloseTo(6000, 6);
    expect(rb.bodies[0].names?.faces).toContain(top.ref.name);
  });

  it.skipIf(needs())('the flange top +10 mm keeps the holes (2 x 96,858.41); without the holes it is 200,000 mm³', async () => {
    const r = await part();
    await importFixture(r, 'flange.step');
    const top = await faceByNormal(r, [0, 0, 1]);
    r.doc.beginNew('press_pull', { body: top.body, faces: [top.ref], distance: '10 mm' } as Partial<PressPullFeature>).commit();
    let rb = await settle(r.doc);
    expect(rb.bodies[0].volume).toBeCloseTo(2 * 96858.40734641012, 2);
    expect(rb.bodies[0].valid).toBe(true);
    // Delete the holes first (move the press-pull after it): 200,000.
    const b = rb.bodies[0];
    r.doc.undo();
    rb = await settle(r.doc);
    const t = await r.kernel.call('topo', { id: rb.bodies[0].shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
    const holes: PersistentRef[] = [];
    for (const f of t.result.faces.filter((x) => x.type === 'cylinder')) {
      const p = await pickFace(r.services, rb.bodies[0], f.i, null);
      if (p.ok) holes.push(p.ref);
    }
    expect(holes).toHaveLength(4);
    r.doc.beginNew('delete_faces', { body: b.id, faces: holes } as Partial<DeleteFacesFeature>).commit();
    await settle(r.doc);
    const top2 = await faceByNormal(r, [0, 0, 1]);
    r.doc.beginNew('press_pull', { body: top2.body, faces: [top2.ref], distance: '10 mm' } as Partial<PressPullFeature>).commit();
    rb = await settle(r.doc);
    expect(rb.bodies[0].volume).toBeCloseTo(200000, 2);
    expect(rb.bodies[0].faces).toBe(6);
    expect(rb.bodies[0].bbox[5]).toBeCloseTo(20, 6);
  });

  it.skipIf(needs())('a curved face is refused by the kernel, said in the feature', async () => {
    const r = await part();
    cylinder(r.doc);
    let rb = await settle(r.doc);
    const b = rb.bodies[0];
    const t = await r.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
    const side = t.result.faces.find((x) => x.type === 'cylinder')!;
    const p = await pickFace(r.services, b, side.i, null);
    if (!p.ok) throw new Error(p.reason);
    r.doc.beginNew('press_pull', { body: b.id, faces: [p.ref], distance: '5 mm' } as Partial<PressPullFeature>).commit();
    rb = await settle(r.doc);
    const pp = r.doc.state.get().doc.features[2];
    expect(rb.features[pp.id].state).toBe('error');
    expect(rb.features[pp.id].message).toMatch(/^Press-pull 1 failed: press_pull needs planar faces: face \d+ is /);
  });
});

describe('Measure on the real kernel (needs kernel API 3)', () => {
  it.skipIf(needs())('two parallel block faces are 20 mm apart; two opposite corners sqrt(3)·20; a cylinder radius 10', async () => {
    const r = await part();
    block(r.doc);
    cylinder(r.doc, { at: [50, 0, 0], size: [20, 20] });
    const rb = await settle(r.doc);
    const box = rb.bodies[0];
    const top = await faceByNormal(r, [0, 0, 1]);
    const bottom = await faceByNormal(r, [0, 0, -1]);
    let m = (await r.kernel.call('measure', { a: { id: box.shape, face: top.index }, b: { id: box.shape, face: bottom.index } })).result;
    expect(m.distance).toBeCloseTo(20, 9);
    expect(m.angle_deg).toBeCloseTo(0, 9);
    const t = await r.kernel.call('topo', { id: box.shape, faces: 'none', edges: 'none', vertices: 'all' });
    const v0 = t.result.vertices.find((v) => v.p.every((x) => Math.abs(x) < 1e-9))!;
    const v1 = t.result.vertices.find((v) => v.p.every((x) => Math.abs(x - 20) < 1e-9))!;
    m = (await r.kernel.call('measure', { a: { id: box.shape, vertex: v0.i }, b: { id: box.shape, vertex: v1.i } })).result;
    expect(m.distance).toBeCloseTo(Math.sqrt(3) * 20, 9);
    const cyl = rb.bodies[1];
    const ct = await r.kernel.call('topo', { id: cyl.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true });
    const side = ct.result.faces.find((x) => x.type === 'cylinder')!;
    m = (await r.kernel.call('measure', { a: { id: cyl.shape, face: side.i } })).result;
    expect(m.a.radius).toBeCloseTo(10, 9);
  });
});
