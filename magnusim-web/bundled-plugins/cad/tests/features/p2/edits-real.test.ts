// @vitest-environment node
// The P2 edits on an imported STEP with the real kernel (docs/p2p3-plan.md
// §5.1 items 2, 4, 5): Delete faces of the flange's four holes (volume +
// 4·pi·5²·10, 6 faces, names kept), Split by the Right plane (two named
// halves, derived ids, the second renamed), Combine (join the halves back;
// cut and intersect with several tools; keep tools), and the Vortex fluid
// domain (an Enclosure with a fixed 100 mm padding minus Vortex, against the
// native values) when Daniel's file is at hand. Tool blocks are sketched and
// extruded (tests/doc/blocks.ts): there is no Box feature any more.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveBodyId } from '../../../src/doc/features/body-ids';
import { forgetBreps } from '../../../src/features/import/feature';
import { pickFace } from '../../../src/features/p2/refs';
import type { CombineFeature, DeleteFacesFeature, EnclosureFeature, PersistentRef, SplitFeature } from '../../../src/types/doc';
import { block, registerSolidFeatures } from '../../doc/blocks';
import { fixture, importFixture, openRealDoc, settle, type RealDoc } from './real-doc';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part() {
  const r = await openRealDoc();
  registerSolidFeatures(r.doc);
  open.push(r);
  return r;
}

const ref = JSON.parse(fixture('reference.json').toString('utf8'));

async function holeRefs(r: RealDoc): Promise<{ body: string; refs: PersistentRef[] }> {
  const b = r.doc.state.get().rebuild.bodies[0];
  const topo = await r.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
  const holes = topo.result.faces.filter((f) => f.type === 'cylinder').map((f) => f.i);
  expect(holes).toHaveLength(4);
  const refs: PersistentRef[] = [];
  for (const i of holes) {
    const p = await pickFace(r.services, b, i, null);
    if (!p.ok) throw new Error(p.reason);
    refs.push(p.ref);
  }
  return { body: b.id, refs };
}

describe('P2 edits on the real kernel', () => {
  it('Delete faces removes the four holes: 6 faces, volume 100,000 mm³, names kept', async () => {
    const r = await part();
    const imp = await importFixture(r, 'flange.step');
    const { body, refs } = await holeRefs(r);
    const s = r.doc.beginNew('delete_faces', { body, faces: refs } as Partial<DeleteFacesFeature>);
    s.commit();
    const rb = await settle(r.doc);
    const f = r.doc.state.get().doc.features[1];
    expect(f.name).toBe('Delete faces 1');
    expect(rb.features[f.id]).toMatchObject({ state: 'ok' });
    expect(rb.bodies).toHaveLength(1);
    expect(rb.bodies[0].id).toBe(body);
    expect(rb.bodies[0].faces).toBe(6);
    const growth = 4 * Math.PI * 25 * 10;
    expect(Math.abs(rb.bodies[0].volume! - (ref.flange.import.volume + growth)) / 100000).toBeLessThan(1e-3);
    expect(rb.bodies[0].volume).toBeCloseTo(ref.flange.defeature.volume, 2);
    // The six faces left are the import's own (modified or the same): their names stay.
    const names = rb.bodies[0].names?.faces ?? [];
    expect(names).toHaveLength(6);
    for (const n of names) expect(n.startsWith(`F:${imp.feature}:import:0:`)).toBe(true);
    // Undo removes it; redo brings it back.
    r.doc.undo();
    expect((await settle(r.doc)).bodies[0].faces).toBe(10);
    r.doc.redo();
    expect((await settle(r.doc)).bodies[0].faces).toBe(6);
  });

  it('Delete faces with a face that is gone fails with the reference error (no partial delete)', async () => {
    const r = await part();
    await importFixture(r, 'flange.step');
    const { body, refs } = await holeRefs(r);
    const lost: PersistentRef = { name: 'F:f_gone:import:0:99', signature: { ...refs[0].signature, at: [500, 500, 500], radius: 77 } };
    r.doc.beginNew('delete_faces', { body, faces: [refs[0], lost] } as Partial<DeleteFacesFeature>).commit();
    const rb = await settle(r.doc);
    const f = r.doc.state.get().doc.features[1];
    // Which face, in the panels' words (review P2/P3 round 2: the message named none).
    expect(rb.features[f.id]).toMatchObject({ state: 'error', message: 'Delete faces 1 failed: Face 100 of a deleted feature not found on flange after rebuild' });
    // The body is the import's, untouched.
    expect(rb.bodies[0].faces).toBe(10);
  });

  it('Split by the Right plane: two halves, the first keeps the id, the second is named after it', async () => {
    const r = await part();
    await importFixture(r, 'flange.step');
    const { body, refs } = await holeRefs(r);
    r.doc.beginNew('delete_faces', { body, faces: refs } as Partial<DeleteFacesFeature>).commit();
    await settle(r.doc);
    const s = r.doc.beginNew('split', { targets: [body] } as Partial<SplitFeature>);
    s.commit();
    const rb = await settle(r.doc);
    const split = r.doc.state.get().doc.features[2] as SplitFeature;
    expect(split.tool).toMatchObject({ kind: 'plane', plane: 'origin:right' });
    expect(rb.features[split.id]).toMatchObject({ state: 'ok' });
    expect(rb.bodies.map((b) => b.id)).toEqual([body, deriveBodyId(split.id, body, 1)]);
    const stepName = r.doc.state.get().doc.bodies[body].name;
    expect(rb.bodies.map((b) => b.name)).toEqual([stepName, `${stepName} (2)`]);
    for (const b of rb.bodies) {
      expect(b.valid).toBe(true);
      expect(b.volume).toBeCloseTo(50000, 3);
      expect(b.faces).toBe(6);
      // One cut face per piece, named by the split.
      expect(b.names?.faces.filter((n) => n === `F:${split.id}:cut`)).toHaveLength(1);
    }
    // Renaming the second piece stores its name (and it survives a rebuild).
    expect(r.doc.renameBody(rb.bodies[1].id, 'Right half')).toEqual({ ok: true });
    const after = await settle(r.doc);
    expect(after.bodies[1].name).toBe('Right half');
    expect(r.doc.state.get().doc.bodies[rb.bodies[1].id]).toMatchObject({ name: 'Right half' });
    // An offset that misses the body is said in red, with the offset (UX review).
    const e = r.doc.beginEdit(split.id);
    e.update({ tool: { kind: 'plane', plane: 'origin:right', offset: '80 mm' } } as Partial<SplitFeature>);
    e.commit();
    const miss = await settle(r.doc);
    expect(miss.features[split.id]).toMatchObject({ state: 'error', message: `Split 1 failed: the Right plane offset by 80 mm does not cut ${stepName}` });
  });

  it('Combine: join the halves back, cut and intersect with several tools, keep tools', async () => {
    const r = await part();
    await importFixture(r, 'flange.step');
    const { body, refs } = await holeRefs(r);
    r.doc.beginNew('delete_faces', { body, faces: refs } as Partial<DeleteFacesFeature>).commit();
    r.doc.beginNew('split', { targets: [body] } as Partial<SplitFeature>).commit();
    let rb = await settle(r.doc);
    const [a, b] = rb.bodies.map((x) => x.id);
    r.doc.beginNew('combine', { op: 'join', targets: [a], tools: [b] } as Partial<CombineFeature>).commit();
    rb = await settle(r.doc);
    const join = r.doc.state.get().doc.features[3];
    expect(rb.features[join.id]).toMatchObject({ state: 'ok' });
    expect(rb.bodies.map((x) => x.id)).toEqual([a]);
    expect(rb.bodies[0].volume).toBeCloseTo(100000, 2);
    // Two 10 x 10 x 20 blocks (sketched, extruded from z = -1), overlapping each other by 5 x 5, as
    // tools: cut out of the plate (their union, 175 mm² through the 10 mm plate), kept.
    block(r.doc, { at: [-50, -50, -1], size: [10, 10, 20] });
    block(r.doc, { at: [-45, -45, -1], size: [10, 10, 20] });
    rb = await settle(r.doc);
    const [, t1, t2] = rb.bodies.map((x) => x.id);
    const cut = r.doc.beginNew('combine', { op: 'cut', targets: [a], tools: [t1, t2], keepTools: true } as Partial<CombineFeature>);
    cut.commit();
    rb = await settle(r.doc);
    expect(rb.features[cut.feature]).toMatchObject({ state: 'ok' });
    expect(rb.bodies.map((x) => x.id)).toEqual([a, t1, t2]);
    expect(rb.bodies[0].volume).toBeCloseTo(100000 - 175 * 10, 2);
    // Intersect instead, tools not kept: what the plate shares with all the blocks (SOLIDWORKS'
    // Common; review P2/P3 round 4): the 5 x 5 they share, through the plate.
    const e = r.doc.beginEdit(cut.feature);
    e.update({ op: 'intersect', keepTools: false } as Partial<CombineFeature>);
    e.commit();
    rb = await settle(r.doc);
    expect(rb.bodies.map((x) => x.id)).toEqual([a]);
    expect(rb.bodies[0].volume).toBeCloseTo(5 * 5 * 10, 2);
  });

  it('Combine refuses a body that is a target and a tool', async () => {
    const r = await part();
    block(r.doc);
    await settle(r.doc);
    const b = r.doc.state.get().rebuild.bodies[0].id;
    const s = r.doc.beginNew('combine', { op: 'cut', targets: [b], tools: [b] } as Partial<CombineFeature>);
    expect(s.incomplete()).toBe('A body cannot be a target and a tool');
    s.discard();
  });

  // Daniel's Vortex part, only when CAD_E2E_VORTEX_STEP names it (never copied into the plugin).
  const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
  it.skipIf(!VORTEX)(`Vortex fluid domain: an Enclosure box with a fixed 100 mm padding minus Vortex (${VORTEX ? `reads ${VORTEX}` : 'skipped: set CAD_E2E_VORTEX_STEP'})`, async () => {
    expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP is set but there is no file at ${VORTEX}`).toBe(true);
    const r = await part();
    const bytes = new Uint8Array(readFileSync(VORTEX));
    await importFixture(r, 'Vortex CFD Test.step', { bytes });
    let rb = r.doc.state.get().rebuild;
    expect(rb.bodies[0].faces).toBe(17);
    expect(rb.bodies[0].volume! / ref.vortex.import.volume - 1).toBeLessThan(1e-9);
    const vortex = rb.bodies[0].id;
    // The Enclosure around the Vortex's exact bounding box, 100 mm out on every side: the
    // reference fluid box (corner -252.4, -252.4, -608; 504.8 x 504.8 x 1012.8000123617928).
    const fb = ref.fluid_box;
    const enc = r.doc.beginNew('enclosure', { padding: 'fixed', distance: '100 mm' } as Partial<EnclosureFeature>);
    enc.commit();
    rb = await settle(r.doc);
    const box = rb.bodies[1].id;
    expect(rb.bodies[1].name).toBe('Enclosure 1');
    const out = rb.outputs[enc.feature];
    expect(out?.type).toBe('enclosure');
    if (out?.type !== 'enclosure') throw new Error('no enclosure output');
    expect(out.box!.min.map((v, i) => Math.abs(v - fb.origin[i]) < 1e-9)).toEqual([true, true, true]);
    expect(Math.abs(out.box!.max[2] - out.box!.min[2] - fb.dz)).toBeLessThan(1e-9);
    expect(Math.abs(rb.bodies[1].volume! / fb.V_box_native - 1)).toBeLessThan(1e-9);
    // Its faces are named by side, and the fluid's outer faces keep those names through the Cut.
    const sides = (rb.bodies[1].names?.faces ?? []).map((n) => n.split(':').pop());
    expect(sides).toEqual(['-x', '+x', '-y', '+y', '-z', '+z']);
    const encNames = rb.bodies[1].names!.faces;
    const s = r.doc.beginNew('combine', { op: 'cut', targets: [box], tools: [vortex], keepTools: false } as Partial<CombineFeature>);
    s.commit();
    rb = await settle(r.doc, 120_000);
    expect(rb.features[s.feature]).toMatchObject({ state: 'ok' });
    expect(rb.bodies.map((x) => x.id)).toEqual([box]);
    expect(rb.bodies[0].valid).toBe(true);
    expect(rb.bodies[0].faces).toBe(ref.cut_fluid.faces);
    expect(Math.abs(rb.bodies[0].volume! / ref.cut_fluid.volume - 1)).toBeLessThan(1e-6);
    for (const n of encNames) expect(rb.bodies[0].names?.faces).toContain(n);
    // Keep tools: the Vortex body stays.
    let e = r.doc.beginEdit(s.feature);
    e.update({ keepTools: true } as Partial<CombineFeature>);
    e.commit();
    rb = await settle(r.doc, 120_000);
    expect(rb.bodies.map((x) => x.id)).toEqual([vortex, box]);
    // Intersect: the Vortex volume (native common).
    e = r.doc.beginEdit(s.feature);
    e.update({ op: 'intersect' } as Partial<CombineFeature>);
    e.commit();
    rb = await settle(r.doc, 120_000);
    expect(Math.abs(rb.bodies.find((x) => x.id === box)!.volume! / ref.common_fluid.volume - 1)).toBeLessThan(1e-6);
  }, 240_000);
});
