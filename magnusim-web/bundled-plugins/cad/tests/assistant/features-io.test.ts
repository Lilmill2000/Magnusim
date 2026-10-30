// Extrudes and revolves as the tools' input (CAD tools spec §4 "Full", §7.7, §12.1 features-io), on
// the REAL kernel: what get_model full writes for a feature the person made with the panels
// (every extent, an Up to face or vertex, a cut on given bodies, a revolve about an origin axis, a
// sketch line and an edge), resent with edit as it is, leaves the feature exactly as it was; so do a
// face extrude (no sketch) and one along a chosen direction. The panel the tool opens is never handed an id, a type or
// a body id; names are checked (taken, too long, any case), and an edit keeps its own.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFace } from '../../src/features/p2/refs';
import { kernelLookup } from '../../src/naming';
import { refOfVertex } from '../../src/naming/edges';
import type { BodyRef, ExtrudeFeature, Feature, RevolveFeature } from '../../src/types/doc';
import type { BodyInfo } from '../../src/types/kernel';
import { uiFor } from '../../src/ui/controller';
import { EXTRUDE, fail, ok, REVOLVE } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { bodyNamed, extrude, faceNamed, regions, Shapes, sketchOn } from './parts';
import type { Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const featureNamed = <T = Feature>(x: AssistantHarness, name: string) => x.doc.state.get().doc.features.find((f) => f.name === name) as unknown as T;
/** A feature as stored, without its id (a resend keeps everything else). */
const stored = (f: Feature) => {
  const { id: _id, ...rest } = f;
  return rest;
};
const inputsOf = async (x: AssistantHarness, name: string) => (await ok(x, 'get_model', { detail: 'full', feature: name })).data.feature as Row;

/** get_model full's inputs of `name`, resent with edit: the feature is stored as it was. */
async function roundTrip(x: AssistantHarness, name: string, tool: 'extrude' | 'revolve'): Promise<Row> {
  const row = await inputsOf(x, name);
  expect(row.inputs, `${name}: ${JSON.stringify(row)}`).not.toBeNull();
  const was = stored(featureNamed(x, name));
  await ok(x, tool, row.inputs as Row);
  expect(stored(featureNamed(x, name))).toEqual(was);
  return row.inputs as Row;
}

/** A plate (Body 1, x -30..30, y -20..20, z 0..6) made with the person's panels. */
async function personPlate(x: AssistantHarness): Promise<{ body: BodyInfo; sketch: string; extrude: string }> {
  const sketch = await sketchOn(x, 'Plate sketch', 'origin:top', new Shapes().rect('e', -30, -20, 30, 20));
  const id = await extrude(x, 'Plate', regions(x, sketch), { distance: '6 mm' });
  return { body: bodyNamed(x, 'Body 1'), sketch, extrude: id };
}

async function faceRef(x: AssistantHarness, body: BodyInfo, name: string): Promise<BodyRef> {
  const r = await pickFace(x.services, body, faceNamed(body, name), null);
  if (!r.ok) throw new Error(r.reason);
  return { body: r.body, ref: r.ref };
}

async function vertexRef(x: AssistantHarness, body: BodyInfo, at: [number, number, number]): Promise<BodyRef> {
  const t = await x.services.kernel.call('topo', { id: body.shape, faces: 'none', edges: 'none', vertices: 'all' });
  const v = t.result.vertices.find((p) => Math.hypot(p.p[0] - at[0], p.p[1] - at[1], p.p[2] - at[2]) < 1e-6);
  if (!v) throw new Error('no vertex there');
  return { body: body.id, ref: await refOfVertex(kernelLookup(x.services.kernel), body, v.i) };
}

describe('extrudes the person made, as extrude input', () => {
  it(
    'every extent, up to a face and a vertex, and a cut on given bodies come back as they were',
    async () => {
      h = await assistantHarness();
      const p = await personPlate(h);
      expect(await roundTrip(h, 'Plate', 'extrude')).toEqual(EXTRUDE({ edit: 'Plate', sketch: 'Plate sketch', regions: [expect.stringMatching(/^at\(/)], distance: '6 mm' }));
      // Above the plate: symmetric, two sides, through one side and both ways, a cut on given bodies.
      const above = await sketchOn(h, 'Above', 'origin:top', new Shapes().circle('c', [-20, 0], 3));
      await extrude(h, 'Sym', regions(h, above), { extent: { kind: 'symmetric', distance: '20 mm' } });
      expect(await roundTrip(h, 'Sym', 'extrude')).toMatchObject({ extent: 'symmetric', distance: '20 mm', distance2: '', to: '', op: 'new', bodies: [] });
      await extrude(h, 'Two', regions(h, above), { extent: { kind: 'two', distance: '3 mm', distance2: '1 mm' }, flip: true });
      expect(await roundTrip(h, 'Two', 'extrude')).toMatchObject({ extent: 'two', distance: '3 mm', distance2: '1 mm', flip: true });
      const thru = await sketchOn(h, 'Thru sketch', 'origin:top', new Shapes().circle('d', [20, 0], 2));
      await extrude(h, 'Thru', regions(h, thru), { op: 'cut', scope: [p.body.id], extent: { kind: 'through_all', both: true, distance: '7 mm' } });
      expect(await roundTrip(h, 'Thru', 'extrude')).toMatchObject({ extent: 'through_both', distance: '', op: 'cut', bodies: ['Body 1'] });
      // Through one side keeps the last blind distance it was given (7 mm), which the tool never shows.
      expect(featureNamed<ExtrudeFeature>(h, 'Thru').extent).toEqual({ kind: 'through_all', both: true, distance: '7 mm' });
      // Up to the plate's top face, and up to a vertex 1 mm further, from two discs on Top.
      const high = await sketchOn(h, 'High', 'origin:top', new Shapes().circle('h', [0, 10], 2).circle('k', [0, -10], 2));
      const top = await faceRef(h, bodyNamed(h, 'Body 1'), `F:${p.extrude}:end`);
      const hi = regions(h, high);
      await extrude(h, 'To face', [hi[0]], { op: 'join', flip: false, extent: { kind: 'to', target: top, offset: '0 mm', distance: '10 mm' } });
      expect(await roundTrip(h, 'To face', 'extrude')).toMatchObject({ extent: 'to', to: 'Plate.end', distance: '0 mm', op: 'join', bodies: [] });
      const corner = await vertexRef(h, bodyNamed(h, 'Body 1'), [30, 20, 6]);
      await extrude(h, 'To vertex', [hi[1]], { op: 'join', extent: { kind: 'to', target: corner, offset: '1 mm', distance: '10 mm' } });
      expect(await roundTrip(h, 'To vertex', 'extrude')).toMatchObject({ extent: 'to', to: 'Body 1 vertex at (30, 20, 6)', distance: '1 mm' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a face extrude, and one along a chosen direction, come back as extrude input and are replaced in place',
    async () => {
      h = await assistantHarness();
      const p = await personPlate(h);
      const top = await faceRef(h, p.body, `F:${p.extrude}:end`);
      await h.add('extrude', { name: 'Raised', face: top, profiles: [], op: 'join', scope: [], creates: null, extent: { kind: 'blind', distance: '2 mm' }, flip: false });
      expect(await roundTrip(h, 'Raised', 'extrude')).toEqual(EXTRUDE({ edit: 'Raised', sketch: '', regions: [], face: 'Plate.end', distance: '2 mm', op: 'join' }));
      expect(h.doc.state.get().rebuild.bodies[0].bbox[5]).toBeCloseTo(8, 6);
      const sk = await sketchOn(h, 'Slanted sketch', 'origin:top', new Shapes().circle('s', [0, 0], 2));
      await extrude(h, 'Slanted', regions(h, sk), { distance: '5 mm' });
      const slanted = featureNamed<ExtrudeFeature>(h, 'Slanted');
      const s = h.doc.beginEdit(slanted.id);
      s.update({ direction: { kind: 'origin', axis: 'origin:x' } } as Partial<Feature>);
      s.commit();
      await h.settle();
      expect(await roundTrip(h, 'Slanted', 'extrude')).toMatchObject({ sketch: 'Slanted sketch', face: '', direction: 'X axis', distance: '5 mm' });
      // Sent again without the direction: the extrude goes along the sketch normal again.
      const row = (await inputsOf(h, 'Slanted')).inputs as Row;
      await ok(h, 'extrude', { ...row, direction: '' });
      expect(featureNamed<ExtrudeFeature>(h, 'Slanted').direction).toBeNull();
    },
    REAL_KERNEL_MS,
  );
});

describe('revolves the person made, as revolve input', () => {
  it(
    'about an origin axis, a sketch line and a straight edge, each extent, come back as they were',
    async () => {
      h = await assistantHarness();
      const p = await personPlate(h);
      // On Front: a ring section x 10..20, z 10..14, and its own centerline along v (the Z axis).
      const ring = await sketchOn(h, 'Ring sketch', 'origin:front', new Shapes().rect('q', 10, 10, 20, 14).line('ax', [0, 0], [0, 30]));
      const sk = h.doc.state.get().doc.features.find((f) => f.id === ring)!;
      // The centerline is construction (the revolve's axis, no region of its own).
      const s = h.doc.beginEdit(sk.id);
      s.update({ entities: (sk as unknown as { entities: { id: string }[] }).entities.map((e) => (e.id === 'ax' ? { ...e, construction: true } : e)) } as unknown as Partial<Feature>);
      s.commit();
      await h.settle();
      const reg = regions(h, ring);
      await h.add('revolve', { name: 'Full', profiles: reg, axis: { kind: 'origin', axis: 'origin:z' }, extent: { kind: 'one', angle: '360 deg' }, flip: false, op: 'new', creates: null, scope: [] });
      expect(await roundTrip(h, 'Full', 'revolve')).toEqual(REVOLVE({ edit: 'Full', sketch: 'Ring sketch', regions: [expect.stringMatching(/^at\(/)], axis: 'Z axis', extent: 'full' }));
      await h.add('revolve', { name: 'Half', profiles: reg, axis: { kind: 'sketch-line', sketch: ring, entity: 'ax' }, extent: { kind: 'two', angle: '30 deg', angle2: '60 deg' }, flip: true, op: 'new', creates: null, scope: [] });
      expect(await roundTrip(h, 'Half', 'revolve')).toMatchObject({ axis: 'Ring sketch.ax', extent: 'two', angle: '30 deg', angle2: '60 deg', flip: true });
      // About the plate's edge along X at y = -20, z = 6 (the end face and the side at y = -20), a cut on the plate.
      const edgeSketch = await sketchOn(h, 'Edge sketch', 'origin:right', new Shapes().rect('w', -18, 7, -16, 9));
      const b = bodyNamed(h, 'Body 1');
      const t = await h.services.kernel.call('topo', { id: b.shape, faces: 'none', edges: 'all', vertices: 'none', edge_length: true, edge_ends: true });
      const end = faceNamed(b, `F:${p.extrude}:end`);
      const side = b.names!.faces.findIndex((n) => n.startsWith(`F:${p.extrude}:side:e1`));
      const e = t.result.edges.find((x) => new Set(x.faces).size === 2 && x.faces.includes(end) && x.faces.includes(side))!;
      const { refOfEdge } = await import('../../src/naming/edges');
      const ref = await refOfEdge(kernelLookup(h.services.kernel), b, e.i);
      await h.add('revolve', { name: 'Edge cut', profiles: regions(h, edgeSketch), axis: { kind: 'edge', body: b.id, ref }, extent: { kind: 'symmetric', angle: '20 deg' }, flip: false, op: 'join', creates: null, scope: [b.id] });
      expect(await roundTrip(h, 'Edge cut', 'revolve')).toMatchObject({ axis: 'Plate.end & Plate.side(e1)', extent: 'symmetric', angle: '20 deg', op: 'join', bodies: ['Body 1'] });
      expect(featureNamed<RevolveFeature>(h, 'Edge cut').axis).toMatchObject({ kind: 'edge' });
    },
    REAL_KERNEL_MS,
  );
});

describe('the panel the tools fill, and names', () => {
  it(
    'is never handed an id, a type or a body id; names are checked, and an edit keeps its own',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await sketchOn(h, 'Plate sketch', 'origin:top', new Shapes().rect('e', -30, -20, 30, 20));
      const ui = uiFor(h.services);
      const open = vi.spyOn(ui, 'openForAssistant');
      await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6 mm', body_name: 'Base' }));
      await sketchOn(h, 'Arm sketch', 'origin:top', new Shapes().rect('a', 40, -5, 50, 5));
      await ok(h, 'revolve', REVOLVE({ sketch: 'Arm sketch', axis: 'Y axis', extent: 'one', angle: '10 deg' }));
      expect(open).toHaveBeenCalledTimes(2);
      for (const [, type, init] of open.mock.calls) {
        expect(['extrude', 'revolve']).toContain(type);
        for (const k of ['id', 'type', 'creates']) expect(Object.keys(init ?? {}), `${type} init`).not.toContain(k);
      }
      expect(open.mock.calls.map((c) => (c[2] as Row).name)).toEqual(['Plate', undefined]);
      expect(await fail(h, 'extrude', EXTRUDE({ name: 'plate', sketch: 'Plate sketch', distance: '6 mm' }))).toMatchObject({ detail: { reason: 'name_taken', field: 'name' } });
      expect(await fail(h, 'extrude', EXTRUDE({ name: 'x'.repeat(41), sketch: 'Plate sketch', distance: '6 mm' }))).toMatchObject({ detail: { reason: 'bad_input', field: 'name' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', distance: '6 mm', body_name: 'y'.repeat(41) }))).toMatchObject({ detail: { reason: 'bad_input' } });
      // An edit may send its own name.
      const again = await ok(h, 'extrude', EXTRUDE({ edit: 'Plate', name: 'Plate', sketch: 'Plate sketch', distance: '7 mm', body_name: 'Base' }));
      expect(again.data).toMatchObject({ feature: { name: 'Plate' }, resolved: { edit: 'Plate' } });
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Base', 'Body 1']);
    },
    REAL_KERNEL_MS,
  );
});
