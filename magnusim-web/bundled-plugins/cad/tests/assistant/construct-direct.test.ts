// construct and direct on the REAL kernel, through the page's tool handler, on a 60 x 40 x 6 plate
// (Body 1, x -30..30, y -20..20, z 0..6) with a 4 mm hole at (-20, 0):
//   - construct makes every plane, axis and point method; each record is the one the person's
//     Construct panel makes from the same picks (refgeom/refs.ts refFromItem, then the panel's
//     fields), it builds, get_model full writes it back as construct input that replaces it in
//     place unchanged, edit_feature changes its choices (flip, method) and values, refusals change
//     nothing, and one request is one undo entry;
//   - direct press-pulls faces, deletes faces, splits by a plane, a face or a body, and encloses
//     bodies, each the record the person's panel makes; edits later; repair takes the person's Try
//     repair and retry refuses a feature that was not stopped;
//   - extrude of a face with no sketch and along a direction; pattern by extent, symmetric per
//     direction and skipped copies; measure's totals and a body's check list.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFace } from '../../src/features/p2/refs';
import { refFromItem, type Accept } from '../../src/features/refgeom/refs';
import type { EnclosureFeature, Feature, LinearPatternFeature, PressPullFeature, RefAxisFeature, RefPlaneFeature, RefPointFeature, SplitFeature } from '../../src/types/doc';
import type { BodyInfo } from '../../src/types/kernel';
import type { GeomRef } from '../../src/types/references';
import type { SelectionItem } from '../../src/types/selection';
import { EXTRUDE } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { bodyNamed, extrude, plate, regions, Shapes, sketchOn, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  h?.dispose();
  h = null;
});

type Row = Record<string, unknown>;
const CONSTRUCT = (o: Row): Row => ({ edit: '', name: '', method: 'offset', refs: [], value: '', xyz: [], flip: false, from_end: false, ...o });
const DIRECT = (o: Row): Row => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, shape: 'box', padding: 'zero', sides: [], ...o });
const EDIT = (feature: string, o: Row = {}): Row => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const PATTERN = (o: Row): Row => ({ edit: '', name: '', kind: 'linear', of: 'features', items: [], about: '', count: '', spacing: '', flip: false, about2: '', count2: '', spacing2: '', options: [], skip: [], op: 'source', bodies: [], ...o });

const named = <T = Feature>(x: AssistantHarness, name: string) => x.doc.state.get().doc.features.find((f) => f.name === name) as unknown as T;
const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);
const volumeOf = (x: AssistantHarness, name = 'Body 1') => bodyNamed(x, name).volume!;
const outputOf = (x: AssistantHarness, name: string) => x.doc.state.get().rebuild.outputs[named(x, name).id] as unknown as Row;
const stateOf = (x: AssistantHarness, name: string) => x.doc.state.get().rebuild.features[named(x, name).id]?.state;
/** A feature as stored, without what a new one gets of its own (id, name, a new body's id). */
const stored = (f: Feature) => {
  const { id: _i, name: _n, ...rest } = f as Feature & { creates?: unknown };
  if ((f as { type: string }).type === 'enclosure') delete (rest as { creates?: unknown }).creates;
  return rest;
};

/** The index of the face, edge or vertex of `body` nearest `at` (its centroid, midpoint or point). */
async function nearest(x: AssistantHarness, body: BodyInfo, kind: 'face' | 'edge' | 'vertex', at: number[]): Promise<number> {
  const t = (await x.services.kernel.call('topo', { id: body.shape, faces: kind === 'face' ? 'all' : 'none', edges: kind === 'edge' ? 'all' : 'none', vertices: kind === 'vertex' ? 'all' : 'none', face_bbox: 'fast', face_mass: true, edge_length: true, edge_ends: true })).result;
  const d = (p: readonly number[] | null | undefined) => (p ? Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) : Infinity);
  const list: { i: number; p: readonly number[] | null | undefined }[] = kind === 'face' ? t.faces.map((f) => ({ i: f.i, p: f.centroid })) : kind === 'edge' ? t.edges.map((e) => ({ i: e.i, p: e.mid })) : t.vertices.map((v) => ({ i: v.i, p: v.p }));
  list.sort((a, b) => d(a.p) - d(b.p));
  return list[0].i;
}

/** The reference the person's pick of `item` gives a Construct field that accepts `accept`. */
async function picked(x: AssistantHarness, item: SelectionItem, accept: Accept): Promise<GeomRef> {
  const r = await refFromItem(x.services, item, accept, null);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
}
const at = async (x: AssistantHarness, kind: 'face' | 'edge' | 'vertex', p: number[]): Promise<SelectionItem> => ({ kind, body: bodyNamed(x, 'Body 1').id, index: await nearest(x, bodyNamed(x, 'Body 1'), kind, p) });

/** The plate with the hole cut through it. */
async function holed(x: AssistantHarness): Promise<void> {
  await plate(x);
  const sk = await sketchOn(x, 'Hole sketch', 'origin:top', new Shapes().circle('c1', [-20, 0], 2));
  await extrude(x, 'Hole', regions(x, sk), { distance: '6 mm', op: 'cut' });
}

/** get_model full's inputs of `name` sent back with edit: the feature is stored as it was. */
async function roundTrip(x: AssistantHarness, name: string, tool: string): Promise<Row> {
  const row = (await x.ok('get_model', { detail: 'full', feature: name })).data.feature as Row;
  expect(row.inputs, `${name}: ${JSON.stringify(row)}`).not.toBeNull();
  const was = named(x, name);
  await x.ok(tool, row.inputs as Row);
  expect(named(x, name)).toEqual(was);
  return row.inputs as Row;
}

/** The person's own feature of `type` with `init` (one undo step), then taken back: its stored record. */
async function personRecord(x: AssistantHarness, type: Feature['type'], init: Row): Promise<Row> {
  const id = await x.add(type, init);
  const f = x.doc.state.get().doc.features.find((g) => g.id === id)!;
  const rec = stored(f) as Row;
  x.doc.undo();
  await x.settle();
  return rec;
}

describe('construct', () => {
  it(
    'makes every plane method as the person\'s panel does; each builds, comes back as construct input, and edit_feature changes it',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'Planes' });
      await holed(h);
      const label = undoLabel(h);
      const top = await picked(h, { kind: 'origin', ref: 'origin:top' }, 'plane');
      const xAxis = await picked(h, { kind: 'origin', ref: 'origin:x' }, 'axis');
      const topFace = await picked(h, await at(h, 'face', [0, 0, 6]), 'plane');
      const v1 = await picked(h, await at(h, 'vertex', [-30, -20, 6]), 'point');
      const v2 = await picked(h, await at(h, 'vertex', [30, -20, 6]), 'point');
      const v3 = await picked(h, await at(h, 'vertex', [30, 20, 0]), 'point');
      const edge = await picked(h, await at(h, 'edge', [0, -20, 6]), 'curve');

      const off = await h.ok('construct', CONSTRUCT({ name: 'Mid', method: 'offset', refs: ['Top'], value: '3' }));
      expect(off.data).toMatchObject({ feature: { name: 'Mid', type: 'ref_plane', state: 'ok' }, built: { origin_mm: [0, 0, 3], normal: [0, 0, 1] }, resolved: { method: 'offset', refs: 'Top plane' } });
      expect(off.text).toBe('Mid ok: construction plane by offset through (0, 0, 3), normal (0, 0, 1)');
      const ang = await h.ok('construct', CONSTRUCT({ method: 'angle', refs: ['Top', 'X axis'], value: '30 deg' }));
      expect(ang.data.built).toMatchObject({ normal: [0, -0.5, 0.866025] });
      await h.ok('construct', CONSTRUCT({ method: 'three_points', refs: ['Body 1 vertex at (-30, -20, 6)', 'Body 1 vertex at (30, -20, 6)', 'Body 1 vertex at (30, 20, 0)'] }));
      await h.ok('construct', CONSTRUCT({ method: 'midplane', refs: ['Top', 'Extrude 1.end'], flip: true }));
      const ntc = await h.ok('construct', CONSTRUCT({ method: 'normal_to_curve', refs: ['Body 1 edge at (0, -20, 6)'], value: '25 %' }));
      expect(ntc.data.built).toMatchObject({ origin_mm: [-15, -20, 6] });
      expect(names(h).slice(-5)).toEqual(['Mid', 'Plane 1', 'Plane 2', 'Plane 3', 'Plane 4']);
      for (const n of ['Mid', 'Plane 1', 'Plane 2', 'Plane 3', 'Plane 4']) expect(stateOf(h, n), n).toBe('ok');

      // The records the person's panel makes from the same picks.
      const mine = ['Mid', 'Plane 1', 'Plane 2', 'Plane 3', 'Plane 4'].map((n) => stored(named(h!, n)));
      const theirs = [
        await personRecord(h, 'ref_plane', { method: 'offset', plane: top, distance: '3 mm' }),
        await personRecord(h, 'ref_plane', { method: 'angle', plane: top, axis: xAxis, angle: '30 deg' }),
        await personRecord(h, 'ref_plane', { method: 'three_points', points: [v1, v2, v3] }),
        await personRecord(h, 'ref_plane', { method: 'midplane', plane: top, plane2: topFace, flip: true }),
        await personRecord(h, 'ref_plane', { method: 'normal_to_curve', edge, percent: '25' }),
      ];
      expect(mine).toEqual(theirs);

      // get_model full: construct input, sent back as it is.
      expect(await roundTrip(h, 'Mid', 'construct')).toEqual(CONSTRUCT({ edit: 'Mid', refs: ['Top'], value: '3 mm' }));
      expect(await roundTrip(h, 'Plane 1', 'construct')).toEqual(CONSTRUCT({ edit: 'Plane 1', method: 'angle', refs: ['Top', 'X axis'], value: '30 deg' }));
      await roundTrip(h, 'Plane 2', 'construct');
      expect(await roundTrip(h, 'Plane 3', 'construct')).toMatchObject({ method: 'midplane', refs: ['Top', 'Extrude 1.end'], flip: true });
      expect(await roundTrip(h, 'Plane 4', 'construct')).toMatchObject({ method: 'normal_to_curve', value: '25 %' });

      // edit_feature: a value, the Reverse switch, and a method that needs a pick it has not got.
      await h.ok('edit_feature', EDIT('Mid', { set: [{ field: 'distance', value: '4 mm' }, { field: 'flip', value: 'true' }] }));
      expect(named<RefPlaneFeature>(h, 'Mid')).toMatchObject({ distance: '4 mm', flip: true });
      expect(outputOf(h, 'Mid')).toMatchObject({ frame: { origin: [0, 0, -4] } });
      const bad = await h.call('edit_feature', EDIT('Mid', { set: [{ field: 'method', value: 'angle' }] }));
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input' } } });
      expect((bad as { error: { message: string } }).error.message).toContain('Mid would be incomplete: Pick an axis or a straight edge to turn about');
      const word = await h.call('edit_feature', EDIT('Mid', { set: [{ field: 'flip', value: 'maybe' }] }));
      expect((word as { error: { message: string } }).error.message).toContain('flip is on or off: "true" or "false"');
      // A sketch on the new plane, by its name.
      const sk = await h.ok('sketch', { edit: '', name: 'On mid', on: 'Mid', entities: [{ id: 'c', kind: 'circle', at: [0, 0, 5], construction: false }], constraints: [], infer: false });
      expect(sk.data).toMatchObject({ plane: { origin_mm: [0, 0, -4] } });

      // One request, one undo entry: the Part as before it.
      expect(undoLabel(h)).toBe('Assistant: Planes');
      h.fake.emitTurn({ id: 't-test', title: 'Planes', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(undoLabel(h)).toBe(label);
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'makes every axis and point method as the person\'s panel does, and their records come back',
    async () => {
      h = await assistantHarness();
      await holed(h);
      const origin = await picked(h, { kind: 'origin', ref: 'origin:point' }, 'point');
      const corner = await picked(h, await at(h, 'vertex', [30, 20, 6]), 'point');
      const bore = await picked(h, await at(h, 'face', [-20, 0, 3]), 'round');
      const straight = await picked(h, await at(h, 'edge', [0, -20, 6]), 'axis');
      const top = await picked(h, { kind: 'origin', ref: 'origin:top' }, 'plane');
      const right = await picked(h, { kind: 'origin', ref: 'origin:right' }, 'plane');
      const rim = await picked(h, await at(h, 'edge', [-20, 2, 6]), 'center');
      const front = await picked(h, await at(h, 'edge', [0, -20, 0]), 'curve');

      const two = await h.ok('construct', CONSTRUCT({ method: 'two_points', refs: ['origin', 'Body 1 vertex at (30, 20, 6)'] }));
      expect(two.data).toMatchObject({ feature: { name: 'Axis 1', type: 'ref_axis', state: 'ok' }, built: { origin_mm: [0, 0, 0] } });
      const cyl = await h.ok('construct', CONSTRUCT({ method: 'cylinder', refs: ['Body 1 face at (-20, 2, 3)'], flip: true }));
      expect(cyl.data.built).toMatchObject({ origin_mm: [-20, 0, expect.any(Number)], dir: [0, 0, -1] });
      await h.ok('construct', CONSTRUCT({ method: 'edge', refs: ['Body 1 edge at (0, -20, 6)'] }));
      const cross = await h.ok('construct', CONSTRUCT({ method: 'two_planes', refs: ['Top', 'Right'] }));
      expect(cross.data.built).toMatchObject({ origin_mm: [0, 0, 0] });
      const v = await h.ok('construct', CONSTRUCT({ method: 'vertex', refs: ['Body 1 vertex at (30, 20, 6)'] }));
      expect(v.data).toMatchObject({ feature: { name: 'Point 1', type: 'ref_point' }, built: { point_mm: [30, 20, 6] } });
      expect(v.text).toBe('Point 1 ok: construction point by vertex at (30, 20, 6)');
      const c = await h.ok('construct', CONSTRUCT({ method: 'center', refs: ['Body 1 edge at (-20, 2, 6)'] }));
      expect(c.data.built).toMatchObject({ point_mm: [-20, 0, 6] });
      const pct = await h.ok('construct', CONSTRUCT({ method: 'on_edge', refs: ['Body 1 edge at (0, -20, 0)'], value: '25 %', from_end: true }));
      const mm = await h.ok('construct', CONSTRUCT({ method: 'on_edge', refs: ['Body 1 edge at (0, -20, 0)'], value: '10' }));
      // Either end: a quarter from one end, and 10 mm from the start, both on the front bottom edge.
      expect(Math.abs((pct.data.built as { point_mm: number[] }).point_mm[0])).toBeCloseTo(15, 6);
      expect(Math.abs((mm.data.built as { point_mm: number[] }).point_mm[0])).toBeCloseTo(20, 6);
      const cross2 = await h.ok('construct', CONSTRUCT({ method: 'edge_plane', refs: ['Body 1 edge at (0, -20, 0)', 'Right'] }));
      expect(cross2.data.built).toMatchObject({ point_mm: [0, -20, 0] });
      const xyz = await h.ok('construct', CONSTRUCT({ method: 'coordinates', xyz: ['5', 'w/4', '-2 mm'] }));
      expect(xyz.data.built).toMatchObject({ point_mm: [5, 15, -2] });
      for (const n of ['Axis 1', 'Axis 2', 'Axis 3', 'Axis 4', 'Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Point 6']) expect(stateOf(h, n), n).toBe('ok');

      const mine = ['Axis 1', 'Axis 2', 'Axis 3', 'Axis 4', 'Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Point 6'].map((n) => stored(named(h!, n)));
      const theirs = [
        await personRecord(h, 'ref_axis', { method: 'two_points', points: [origin, corner] }),
        await personRecord(h, 'ref_axis', { method: 'cylinder', face: bore, flip: true }),
        await personRecord(h, 'ref_axis', { method: 'edge', edge: straight }),
        await personRecord(h, 'ref_axis', { method: 'two_planes', planes: [top, right] }),
        await personRecord(h, 'ref_point', { method: 'vertex', vertex: corner }),
        await personRecord(h, 'ref_point', { method: 'center', edge: rim, face: null }),
        await personRecord(h, 'ref_point', { method: 'on_edge', edge: front, along: 'percent', percent: '25', fromEnd: true }),
        await personRecord(h, 'ref_point', { method: 'on_edge', edge: front, along: 'distance', distance: '10 mm' }),
        await personRecord(h, 'ref_point', { method: 'edge_plane', edge: front, plane: right }),
        await personRecord(h, 'ref_point', { method: 'coordinates', xyz: ['5 mm', 'w/4', '-2 mm'] }),
      ];
      expect(mine).toEqual(theirs);
      for (const n of ['Axis 1', 'Axis 2', 'Axis 3', 'Axis 4', 'Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Point 6']) await roundTrip(h, n, 'construct');
      expect(await roundTrip(h, 'Point 3', 'construct')).toMatchObject({ method: 'on_edge', value: '25 %', from_end: true });
      expect(await roundTrip(h, 'Point 4', 'construct')).toMatchObject({ value: '10 mm', from_end: false });

      // edit_feature: from_end and along, as the panel's switch and choice.
      await h.ok('edit_feature', EDIT('Point 3', { set: [{ field: 'from_end', value: 'false' }] }));
      expect(named<RefPointFeature>(h, 'Point 3').fromEnd).toBe(false);
      await h.ok('edit_feature', EDIT('Point 4', { set: [{ field: 'along', value: 'percent' }, { field: 'percent', value: '50' }] }));
      expect(outputOf(h, 'Point 4')).toMatchObject({ p: [0, -20, 0] });
      // The axis reversed with edit_feature; a construction axis is a pattern direction.
      await h.ok('edit_feature', EDIT('Axis 3', { set: [{ field: 'flip', value: 'true' }] }));
      expect(named<RefAxisFeature>(h, 'Axis 3').flip).toBe(true);
      const row = await h.ok('pattern', PATTERN({ items: ['Hole'], about: 'Axis 4', count: '2', spacing: '5 mm' }));
      expect(row.data).toMatchObject({ feature: { state: 'ok' }, copies: { made: 1 } });
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses before anything changes: ref counts, values, flips, an offset plane, kinds, later features',
    async () => {
      h = await assistantHarness();
      await holed(h);
      const doc = h.doc.state.get().doc;
      const msg = async (input: Row) => {
        const r = await h!.call('construct', CONSTRUCT(input));
        expect(r.ok, JSON.stringify(input)).toBe(false);
        return (r as { error: { message: string } }).error.message;
      };
      expect(await msg({ method: 'angle', refs: ['Top'], value: '10 deg' })).toContain('refs: angle takes 2');
      expect(await msg({ method: 'offset', refs: ['Top'] })).toContain('value: the distance');
      expect(await msg({ method: 'midplane', refs: ['Top', 'Right'], value: '3 mm' })).toContain('value: "" with midplane');
      expect(await msg({ method: 'vertex', refs: ['origin'], flip: true })).toContain('flip: false for a point');
      expect(await msg({ method: 'offset', refs: ['Top offset 3 mm'], value: '1 mm' })).toContain('is a plane with an offset');
      expect(await msg({ method: 'cylinder', refs: ['Extrude 1.end'] })).toContain('is not a cylinder or a cone');
      expect(await msg({ method: 'edge', refs: ['Body 1 edge at (-20, 2, 6)'], from_end: true })).toContain('from_end: false except with on_edge');
      expect(await msg({ method: 'on_edge', refs: ['Body 1 edge at (0, -20, 0)'], value: '150 %' })).toContain('Position must be from 0 to 100');
      expect(await msg({ method: 'coordinates', xyz: ['1 mm', '2 mm'] })).toContain('xyz: three lengths');
      expect(await msg({ method: 'vertex', refs: ['Hole sketch.c9.center'] })).toContain('Hole sketch has no point "c9.center"');
      // A sketch point by its entity and part.
      const sp = await h.ok('construct', CONSTRUCT({ method: 'vertex', refs: ['Hole sketch.c1.center'] }));
      expect(sp.data).toMatchObject({ built: { point_mm: [-20, 0, 0] }, resolved: { refs: 'c1.center of Hole sketch' } });
      expect(named<RefPointFeature>(h, 'Point 1').vertex).toEqual({ kind: 'sketch-point', sketch: named(h, 'Hole sketch').id, point: (named(h, 'Hole sketch') as unknown as { entities: { id: string; c: string }[] }).entities[0].c });
      await roundTrip(h, 'Point 1', 'construct');
      // An edit takes its own kind, and nothing made after it.
      expect(await msg({ edit: 'Point 1', method: 'offset', refs: ['Top'], value: '1 mm' })).toContain('Point 1 is a point, not a construction plane');
      await h.ok('construct', CONSTRUCT({ method: 'vertex', refs: ['Body 1 vertex at (30, 20, 6)'] }));
      expect(await msg({ edit: 'Point 1', method: 'vertex', refs: ['Point 2'] })).toContain('Point 2 comes after Point 1');
      expect(h.doc.state.get().doc.features.length).toBe(doc.features.length + 2);
    },
    REAL_KERNEL_MS,
  );
});

describe('direct', () => {
  it(
    'press-pulls and deletes faces as the person\'s panels do; the inputs come back; edit_feature and undo',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'Direct' });
      await holed(h);
      const v0 = volumeOf(h);
      const pp = await h.ok('direct', DIRECT({ kind: 'press_pull', faces: ['Extrude 1.end'], distance: '2' }));
      expect(pp.data).toMatchObject({ feature: { name: 'Press-pull 1', type: 'press_pull', state: 'ok' }, resolved: { distance: '2 mm' } });
      expect(pp.text).toMatch(/^Press-pull 1 ok: moved 1 face of Body 1 by 2 mm · Body 1 /);
      expect(volumeOf(h)).toBeCloseTo(v0 + 60 * 40 * 2 - Math.PI * 4 * 2, 3);
      const b = bodyNamed(h, 'Body 1');
      const before = h.doc.state.get().doc.features.find((f) => f.name === 'Press-pull 1')!;
      // The person's Press-pull of that face: the same record.
      const prev = await h.services.doc.bodiesBefore(before.id);
      const face = await pickFace(h.services, prev.bodies.find((x) => x.id === b.id)! as unknown as BodyInfo, await nearest(h, prev.bodies.find((x) => x.id === b.id)! as unknown as BodyInfo, 'face', [0, 0, 6]), null);
      if (!face.ok) throw new Error(face.reason);
      expect(stored(before)).toEqual({ type: 'press_pull', body: b.id, faces: [face.ref], distance: '2 mm', version: 2 });
      expect(await roundTrip(h, 'Press-pull 1', 'direct')).toEqual(DIRECT({ edit: 'Press-pull 1', faces: ['Extrude 1.end'], distance: '2 mm' }));
      await h.ok('edit_feature', EDIT('Press-pull 1', { set: [{ field: 'distance', value: '-1 mm' }] }));
      expect(named<PressPullFeature>(h, 'Press-pull 1').distance).toBe('-1 mm');
      expect(volumeOf(h)).toBeCloseTo(v0 - 60 * 40 + Math.PI * 4, 3);
      // Delete the bore: the hole closes.
      const del = await h.ok('direct', DIRECT({ kind: 'delete_faces', faces: ['Body 1 face at (-20, 2, 3)'] }));
      expect(del.data).toMatchObject({ feature: { name: 'Delete faces 1', type: 'delete_faces', state: 'ok' } });
      expect(volumeOf(h)).toBeCloseTo(60 * 40 * 5, 3);
      await roundTrip(h, 'Delete faces 1', 'direct');
      // Refused before anything changes.
      const two = await h.call('direct', DIRECT({ kind: 'delete_faces', faces: ['Extrude 1.end'], distance: '1 mm' }));
      expect((two as { error: { message: string } }).error.message).toContain('distance: "" with delete_faces');
      const none = await h.call('direct', DIRECT({ kind: 'press_pull', faces: ['Extrude 1.end'], distance: '0 mm' }));
      expect((none as { error: { message: string } }).error.message).toContain('Distance must not be 0');
      expect(undoLabel(h)).toBe('Assistant: Direct');
      h.fake.emitTurn({ id: 't-test', title: 'Direct', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      await h.settle();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole']);
      expect(volumeOf(h)).toBeCloseTo(v0, 3);
    },
    REAL_KERNEL_MS,
  );

  it(
    'splits by an origin plane, by a face and by a body, as the person\'s panel does',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const body1 = bodyNamed(h, 'Body 1').id;
      const s = await h.ok('direct', DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Right', distance: '10 mm' }));
      expect(s.data).toMatchObject({ feature: { name: 'Split 1', type: 'split', state: 'ok' }, resolved: { bodies: 'Body 1', tool: 'Right offset 10 mm' } });
      expect(h.doc.state.get().rebuild.bodies.map((b) => [b.name, Math.round(b.volume!)])).toEqual([
        ['Body 1', 40 * 40 * 6],
        ['Body 1 (2)', 20 * 40 * 6],
      ]);
      expect(stored(named(h, 'Split 1'))).toEqual(await personRecord(h, 'split', { targets: [body1], tool: { kind: 'plane', plane: 'origin:right', offset: '10 mm' } }));
      expect(await roundTrip(h, 'Split 1', 'direct')).toEqual(DIRECT({ edit: 'Split 1', kind: 'split', bodies: ['Body 1'], tool: 'Right', distance: '10 mm' }));
      // The offset is an expression edit_feature changes; the plane a choice.
      await h.ok('edit_feature', EDIT('Split 1', { set: [{ field: 'tool.offset', value: '-10 mm' }, { field: 'plane', value: 'Front' }] }));
      expect(named<SplitFeature>(h, 'Split 1').tool).toEqual({ kind: 'plane', plane: 'origin:front', offset: '-10 mm' });
      // By the plane of a face of a second body, and by a body kept.
      const sk = await sketchOn(h, 'Block sketch', 'origin:top', new Shapes().rect('b', -5, -30, 5, 30));
      await extrude(h, 'Block', regions(h, sk), { distance: '20 mm' });
      const byFace = await h.ok('direct', DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Block.side(b2)' }));
      expect(byFace.data).toMatchObject({ feature: { state: 'ok' }, resolved: { tool: 'the plane of Block.side(b2)' } });
      const byBody = await h.ok('direct', DIRECT({ kind: 'split', bodies: ['Body 1 (2)'], tool: 'Body 2', keep_tool: true }));
      expect(byBody.data).toMatchObject({ feature: { name: 'Split 3', state: 'ok' }, resolved: { tool: 'Body 2' } });
      expect(named<SplitFeature>(h, 'Split 3').tool).toMatchObject({ kind: 'body', keepTool: true });
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toContain('Body 2');
      await roundTrip(h, 'Split 3', 'direct');
      await h.ok('edit_feature', EDIT('Split 3', { set: [{ field: 'keep_tool', value: 'false' }] }));
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).not.toContain('Body 2');
      // A body cannot split itself; keep_tool only by a body.
      const self = await h.call('direct', DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Body 1' }));
      expect((self as { error: { message: string } }).error.message).toContain('it cannot split itself');
      const keep = await h.call('direct', DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Top', keep_tool: true }));
      expect((keep as { error: { message: string } }).error.message).toContain('keep_tool: only a split by another body');
    },
    REAL_KERNEL_MS,
  );

  it(
    "deletes bodies as the person's Delete on a body in the tree does: one feature, the inputs come back, an edit changes which bodies, undo",
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'Delete bodies' });
      await plate(h);
      const sk = await sketchOn(h, 'Block sketch', 'origin:top', new Shapes().rect('b', 40, -5, 50, 5));
      await extrude(h, 'Block', regions(h, sk), { distance: '20 mm' });
      const sk2 = await sketchOn(h, 'Post sketch', 'origin:top', new Shapes().rect('p', 60, -5, 70, 5));
      await extrude(h, 'Post', regions(h, sk2), { distance: '20 mm' });
      const [b1, b2] = [bodyNamed(h, 'Body 1').id, bodyNamed(h, 'Body 2').id];
      const d = await h.ok('direct', DIRECT({ kind: 'delete_body', bodies: ['Body 1', 'Body 2'] }));
      expect(d.data).toMatchObject({ feature: { name: 'Delete body 1', type: 'delete_body', state: 'ok' }, resolved: { bodies: 'Body 1 and Body 2' } });
      expect(d.text).toMatch(/^Delete body 1 ok: deleted Body 1 and Body 2 from the model here on/);
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 3']);
      // The record the person's Delete of those two bodies in the tree makes.
      expect(stored(named(h, 'Delete body 1'))).toEqual(await personRecord(h, 'delete_body', { bodies: [b1, b2] }));
      expect(await roundTrip(h, 'Delete body 1', 'direct')).toEqual(DIRECT({ edit: 'Delete body 1', kind: 'delete_body', bodies: ['Body 1', 'Body 2'] }));
      // An edit names the bodies as they are just before it: Body 2 comes back.
      await h.ok('direct', DIRECT({ edit: 'Delete body 1', kind: 'delete_body', bodies: ['Body 1'] }));
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 2', 'Body 3']);
      // Refused before anything changes.
      const none = await h.call('direct', DIRECT({ kind: 'delete_body' }));
      expect((none as { error: { message: string } }).error.message).toContain('bodies: the bodies to delete');
      const far = await h.call('direct', DIRECT({ kind: 'delete_body', bodies: ['Body 3'], distance: '1 mm' }));
      expect((far as { error: { message: string } }).error.message).toContain('distance: "" with delete_body');
      expect(undoLabel(h)).toBe('Assistant: Delete bodies');
      h.fake.emitTurn({ id: 't-test', title: 'Delete bodies', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      await h.settle();
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3']);
      expect(names(h)).not.toContain('Delete body 1');
    },
    REAL_KERNEL_MS,
  );

  it(
    'encloses bodies in a box or a cylinder, with padding and sides; choices change with edit_feature',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const e = await h.ok('direct', DIRECT({ kind: 'enclosure', padding: 'fixed', distance: '10', sides: [{ side: '+z', value: '30 mm' }] }));
      expect(e.data).toMatchObject({ feature: { name: 'Enclosure 1', type: 'enclosure', state: 'ok' }, resolved: { bodies: 'every solid body before it', shape: 'box', padding: '10 mm out', sides: '+z 30 mm' } });
      const box = bodyNamed(h, 'Enclosure 1').bbox;
      expect(box.map((v) => Math.round(v))).toEqual([-40, -30, -10, 40, 30, 36]);
      expect(stored(named(h, 'Enclosure 1'))).toEqual(await personRecord(h, 'enclosure', { padding: 'fixed', distance: '10 mm', sides: { '+z': '30 mm' } }));
      expect(await roundTrip(h, 'Enclosure 1', 'direct')).toEqual(DIRECT({ edit: 'Enclosure 1', kind: 'enclosure', padding: 'fixed', distance: '10 mm', sides: [{ side: '+z', value: '30 mm' }] }));
      // A cylinder about Z, 50 percent, round Body 1 named.
      const c = await h.ok('direct', DIRECT({ kind: 'enclosure', bodies: ['Body 1'], shape: 'cylinder_z', padding: 'percent', distance: '50' }));
      expect(c.data).toMatchObject({ feature: { name: 'Enclosure 2', state: 'ok' }, resolved: { shape: 'cylinder about Z', padding: '50 % of the part\'s size' } });
      expect(named<EnclosureFeature>(h, 'Enclosure 2')).toMatchObject({ shape: 'cylinder', axis: 'origin:z', padding: 'percent', percent: '50', bodies: [bodyNamed(h, 'Body 1').id] });
      await roundTrip(h, 'Enclosure 2', 'direct');
      // edit_feature: shape, axis and padding as the panel's choices.
      await h.ok('edit_feature', EDIT('Enclosure 2', { set: [{ field: 'shape', value: 'box' }, { field: 'padding', value: 'zero' }] }));
      expect(named<EnclosureFeature>(h, 'Enclosure 2')).toMatchObject({ shape: 'box', padding: 'zero', percent: '50' });
      expect(bodyNamed(h, 'Enclosure 2').bbox.map((v) => Math.round(v))).toEqual([-30, -20, 0, 30, 20, 6]);
      await h.ok('edit_feature', EDIT('Enclosure 2', { set: [{ field: 'shape', value: 'cylinder' }, { field: 'axis', value: 'X' }] }));
      expect(named<EnclosureFeature>(h, 'Enclosure 2')).toMatchObject({ shape: 'cylinder', axis: 'origin:x' });
      // An enclosure's own body is not a part to enclose; a cylinder has no +x side.
      const own = await h.call('direct', DIRECT({ kind: 'enclosure', bodies: ['Enclosure 1'] }));
      expect((own as { error: { message: string } }).error.message).toContain('the body of another enclosure');
      const side = await h.call('direct', DIRECT({ kind: 'enclosure', shape: 'cylinder_y', sides: [{ side: '+x', value: '3 mm' }] }));
      expect((side as { error: { message: string } }).error.message).toContain('a cylinder has radius, top, bottom');
    },
    REAL_KERNEL_MS,
  );

  it(
    'repair takes the person\'s Try repair of a feature that offers it; retry refuses one that was not stopped',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const id = named(h, 'Extrude 1').id;
      const no = await h.call('direct', DIRECT({ kind: 'repair', edit: 'Extrude 1' }));
      expect((no as { error: { message: string } }).error.message).toBe('bad_input: edit: Extrude 1 offers no Try repair (it is ok).');
      const stop = await h.call('direct', DIRECT({ kind: 'retry', edit: 'Extrude 1' }));
      expect((stop as { error: { message: string } }).error.message).toContain('Extrude 1 was not stopped by the geometry kernel');
      // The rebuild says the extrude's result was not a valid solid and offers Try repair.
      const real = h.doc.state.get.bind(h.doc.state);
      vi.spyOn(h.doc.state, 'get').mockImplementation(() => {
        const s = real();
        const st = s.rebuild.features[id];
        if (!st) return s;
        return { ...s, rebuild: { ...s.rebuild, features: { ...s.rebuild.features, [id]: { ...st, state: 'error', message: 'Extrude 1 failed: invalid result', actions: ['repair'] } } } };
      });
      const r = await h.ok('direct', DIRECT({ kind: 'repair', edit: 'Extrude 1' }));
      expect(r.text).toMatch(/^Try repair Extrude 1: error; it still fails: Extrude 1 failed: invalid result \(it offers repair\)/);
      expect(named<Row>(h, 'Extrude 1').repair).toEqual({ fuzzy: 0.001 });
      expect(r.data).toMatchObject({ feature: { name: 'Extrude 1', state: 'error' }, actions: ['repair'] });
    },
    REAL_KERNEL_MS,
  );
});

describe('honest outcomes', () => {
  it(
    'a construction feature or a direct edit that does not build changes nothing and says why',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'Fail' });
      await holed(h);
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);
      const par = await h.call('construct', CONSTRUCT({ method: 'two_planes', refs: ['Top', 'Extrude 1.end'] }));
      expect(par).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Axis 1' } } });
      const gone = await h.call('direct', DIRECT({ kind: 'press_pull', faces: ['Extrude 1.end'], distance: '-6 mm' }));
      expect(gone).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Press-pull 1' } } });
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole']);
    },
    REAL_KERNEL_MS,
  );
});

describe('the widened tools', () => {
  it(
    'extrude takes a flat face with no sketch, and goes along a chosen direction',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const f = await h.ok('extrude', EXTRUDE({ name: 'Boss', sketch: '', regions: [], face: 'Extrude 1.end', distance: '3 mm', op: 'join' }));
      expect(f.data).toMatchObject({ feature: { name: 'Boss', state: 'ok' }, resolved: { face: 'Extrude 1.end', extent: 'blind 3 mm along +Z', op: 'join every body it meets' } });
      expect(volumeOf(h)).toBeCloseTo(60 * 40 * 9, 3);
      await sketchOn(h, 'Peg sketch', 'origin:top', new Shapes().circle('p', [0, 0], 2));
      // Along a construction axis that leaves the sketch's plane.
      await h.ok('construct', CONSTRUCT({ name: 'Slant', method: 'two_points', refs: ['origin', 'Body 1 vertex at (30, 20, 9)'] }));
      const d = await h.ok('extrude', EXTRUDE({ name: 'Peg', sketch: 'Peg sketch', direction: 'Slant', distance: '10 mm', op: 'new' }));
      expect(d.data).toMatchObject({ feature: { name: 'Peg', state: 'ok' }, resolved: { direction: expect.stringContaining('Slant') } });
      expect(named<Row>(h, 'Peg').direction).toEqual({ kind: 'feature', feature: named(h, 'Slant').id });
      expect(await roundTrip(h, 'Peg', 'extrude')).toMatchObject({ direction: 'Slant', face: '' });
      const both = await h.call('extrude', EXTRUDE({ sketch: 'Peg sketch', face: 'Extrude 1.end', distance: '1 mm' }));
      expect((both as { error: { message: string } }).error.message).toContain('sketch: "" with face');
      const curved = await h.call('extrude', EXTRUDE({ sketch: '', regions: [], face: 'Peg.side(p)', distance: '1 mm' }));
      expect(curved).toMatchObject({ ok: false, error: { detail: { reason: 'not_flat' } } });
    },
    REAL_KERNEL_MS,
  );

  it(
    'pattern takes extent per direction, symmetric per direction and skipped copies; they come back',
    async () => {
      h = await assistantHarness();
      await holed(h);
      const r = await h.ok('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: '3', spacing: '20 mm', options: ['extent', 'symmetric2'], about2: 'Y axis', count2: '2', spacing2: '8 mm', skip: ['2.2'] }));
      const copies = r.data.copies as { made: number; skipped: string[]; keys: string[] };
      expect(copies.keys).toContain('2.2 (Instance 2, 2)');
      expect(copies.skipped).toEqual(['Instance 2, 2']);
      // 3 along x over 20 mm in all (10 mm apart), 2 per side along y: 3 x 3 = 9 places less the original and one skipped.
      expect(copies.made).toBe(7);
      const f = named<LinearPatternFeature>(h, 'Linear pattern 1');
      expect(f.dir1).toMatchObject({ mode: 'extent', distance: '20 mm', symmetric: false });
      expect(f.dir2).toMatchObject({ mode: 'spacing', symmetric: true, count: '2' });
      expect(f.skip).toEqual(['2.2']);
      expect(await roundTrip(h, 'Linear pattern 1', 'pattern')).toMatchObject({ options: ['symmetric2', 'extent'], skip: ['2.2'], spacing: '20 mm' });
      await h.ok('edit_feature', EDIT('Linear pattern 1', { set: [{ field: 'mode', value: 'spacing' }] }));
      expect(named<LinearPatternFeature>(h, 'Linear pattern 1').dir1.mode).toBe('spacing');
      const unknown = await h.call('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: '3', spacing: '5 mm', skip: ['7'] }));
      expect((unknown as { error: { message: string } }).error.message).toContain('skip: no copy has the key 7');
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole', 'Linear pattern 1']);
      const circ = await h.ok('pattern', PATTERN({ kind: 'circular', items: ['Hole'], about: 'Z axis', count: '4', spacing: '360 deg', skip: ['3'] }));
      expect(circ.data).toMatchObject({ copies: { made: 2, skipped: ['Instance 3'] } });
      const mirror = await h.call('pattern', PATTERN({ kind: 'mirror', items: ['Hole'], about: 'Right', options: ['symmetric'] }));
      expect((mirror as { error: { message: string } }).error.message).toContain('options and skip: [] for a mirror');
    },
    REAL_KERNEL_MS,
  );

  it(
    'measure adds up bodies, and lists a body\'s problems with where each is',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const sk = await sketchOn(h, 'Cube sketch', 'origin:top', new Shapes().rect('k', 40, -5, 50, 5));
      await extrude(h, 'Cube', regions(h, sk), { distance: '10 mm' });
      const sk2 = await sketchOn(h, 'Cube2 sketch', 'origin:top', new Shapes().rect('q', -50, -5, -40, 5));
      await extrude(h, 'Cube2', regions(h, sk2), { distance: '10 mm' });
      const two = await h.ok('measure', { targets: ['Body 1', 'Body 2'], section: '' });
      expect(two.data).toMatchObject({ total: { bodies: 2, volume_mm3: 14400 + 1000, bbox_mm: [[-30, -20, 0], [50, 20, 10]] } });
      const three = await h.ok('measure', { targets: ['Body 1', 'Body 2', 'Body 3'], section: '' });
      expect(three.data).toMatchObject({ kind: 'total', total: { bodies: 3, volume_mm3: 16400, area_mm2: 2 * (60 * 40 + 60 * 6 + 40 * 6) + 2 * 6 * 100, centroid_mm: [0, 0, expect.any(Number)] }, bodies: [{ body: 'Body 1', valid: true }, { body: 'Body 2' }, { body: 'Body 3' }] });
      expect(three.text).toBe('3 bodies: volume 16400 mm3, area 7200 mm2');
      const face = await h.call('measure', { targets: ['Body 1', 'Body 2', 'Extrude 1.end'], section: '' });
      expect((face as { error: { message: string } }).error.message).toContain('is not a body');
      // A body the rebuild says is not valid: the kernel's check list, with a point on each problem.
      const id = bodyNamed(h, 'Body 1').id;
      const real = h.doc.state.get.bind(h.doc.state);
      vi.spyOn(h.doc.state, 'get').mockImplementation(() => {
        const s = real();
        return { ...s, rebuild: { ...s.rebuild, bodies: s.rebuild.bodies.map((b) => (b.id === id ? { ...b, valid: false } : b)) } };
      });
      const call = h.services.kernel.call.bind(h.services.kernel);
      vi.spyOn(h.services.kernel, 'call').mockImplementation((async (op: string, params: unknown, o?: unknown) => {
        if (op === 'check') return { result: { valid: false, check_ms: 1, problems: [{ status: 'NotClosed', type: 'edge', index: 0, in: { type: 'face', index: 0 } }], problem_total: 1, problem_counts: { NotClosed: 1 } } };
        return call(op as never, params as never, o as never);
      }) as never);
      const bad = await h.ok('measure', { targets: ['Body 1'], section: '' });
      expect(bad.data).toMatchObject({ valid: false, problem_total: 1, problem_counts: { NotClosed: 1 }, problems: [{ status: 'NotClosed', on: 'edge 1 of face 1', at_mm: expect.any(Array) }] });
    },
    REAL_KERNEL_MS,
  );
});
