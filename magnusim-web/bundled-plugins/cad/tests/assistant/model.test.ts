// get_model on the REAL kernel (CAD tools spec §4, §12.1 model.test.ts), through the page's tool
// handler as the bridge calls it:
//   - brief: the Part's title, units, editable, rolled_back, person, parameters evaluated, every
//     feature with its state (a sketch's support, definition and regions; an extrude's bodies and
//     faces by role), bodies (valid, solids, shells, voids, volume, bounding box, maker), the
//     guide pointer once per key;
//   - the budgets: a 20-feature Part within 8 KB, within 3 KB on a local turn with the older
//     features collapsed (errors named), 85 features collapse above 80;
//   - full: inputs null with a summary while no tool writes the type, expression fields;
//   - one sketch: its plane in numbers and words, the solver's state now (free parameters),
//     every region with its depth and model point; a name not found lists the names;
//   - rev unchanged across a live draft, +1 per commit; what the person changed told once, the
//     person's undo of the Assistant's steps with it; the person's open panel in words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { GUIDE_NOTE } from '../../src/assistant/model';
import type { Feature, RegionRef } from '../../src/types/doc';
import type { SketchOutput } from '../../src/types/sketch';
import { assistantHarness, REAL_KERNEL_MS, rectangle, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

type Row = Record<string, unknown>;
const BRIEF = { detail: 'brief', feature: '' };
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** A plate: w x d parameters, a centred rectangle sketch on Top, extruded t (new body). */
async function plate(x: AssistantHarness) {
  x.doc.addParam({ name: 'w', expr: '60 mm', quantity: 'length' });
  x.doc.addParam({ name: 'd', expr: '40 mm', quantity: 'length' });
  x.doc.addParam({ name: 't', expr: '6 mm', quantity: 'length' });
  const rect = rectangle(60, 40, -30, -20);
  const sketch = await x.add('sketch', { points: rect.points, entities: rect.entities });
  const out = x.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const r = out.regions[0];
  const profile: RegionRef = { sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  const extrude = await x.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: 't' }, op: 'new' });
  return { sketch, extrude };
}

describe('get_model brief', () => {
  it(
    'reads the Part: parameters, features with their states, bodies with their sizes; the guide pointer once per key',
    async () => {
      h = await assistantHarness({ title: 'Plate test' });
      await plate(h);
      const r = await h.ok('get_model', BRIEF);
      const d = r.data as Row;
      expect(d).toMatchObject({
        part: 'Plate test',
        units: { length: 'mm', angle: 'deg' },
        editable: true,
        rolled_back: null,
        person: null,
        undo: { label: expect.any(String), your_steps: 0 },
        params: [
          { name: 'w', kind: 'length', expr: '60 mm', value: 60 },
          { name: 'd', kind: 'length', expr: '40 mm', value: 40 },
          { name: 't', kind: 'length', expr: '6 mm', value: 6 },
        ],
        selection: [],
        notes: GUIDE_NOTE,
      });
      expect(typeof d.rev).toBe('number');
      const [sk, ex] = d.features as Row[];
      expect(sk).toMatchObject({ name: 'Sketch 1', type: 'sketch', state: 'ok', on: 'Top', regions: [{ id: 'r1', area_mm2: 2400, holes: 0 }] });
      expect(['under', 'fully', 'over', 'unsolved']).toContain(sk.sketch);
      expect(ex).toEqual({ name: 'Extrude 1', type: 'extrude', state: 'ok', op: 'new', made: ['Body 1'], faces: { start: 1, end: 1, side: 4 } });
      expect(d.bodies).toEqual([
        {
          name: 'Body 1',
          color: expect.stringMatching(/^#[0-9a-f]{6}$/),
          valid: true,
          solids: 1,
          shells: 1,
          voids: 0,
          volume_mm3: 14400,
          bbox_mm: [
            [-30, -20, 0],
            [30, 20, 6],
          ],
          faces: 6,
          visible: true,
          simulation: true,
          made_by: 'Extrude 1',
          last_changed_by: 'Extrude 1',
        },
      ]);
      expect(r.text).toBe('Part "Plate test": 2 features, 1 body');
      expect(r.summary).toBe('Read the Part: 2 features, 1 body');
      // The pointer to help guide goes once per key: not again in this turn, again in the next.
      expect((await h.ok('get_model', BRIEF)).data.notes).toBeUndefined();
      expect((await h.ok('get_model', BRIEF, { turn: 't-next' })).data.notes).toBe(GUIDE_NOTE);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a 20-feature Part fits 8 KB; on a local turn 3 KB, the older features collapsed with their errors named; 85 collapse above 80',
    async () => {
      h = await assistantHarness();
      await plate(h);
      // A plane on a plane that is not in the Part: red, early in the history.
      await h.add('ref_plane', { plane: { kind: 'feature', feature: 'f_gone' }, name: 'Broken plane' });
      for (let i = 0; i < 17; i++) {
        const rect = rectangle(10, 10, i * 20, 0);
        await h.add('sketch', { points: rect.points, entities: rect.entities });
      }
      expect(h.doc.state.get().doc.features).toHaveLength(20);
      const cloud = (await h.ok('get_model', BRIEF)).data;
      expect(bytes(cloud)).toBeLessThanOrEqual(8 * 1024);
      expect((cloud.features as Row[]).length).toBe(20);
      expect((cloud.features as Row[])[2]).toMatchObject({ name: 'Broken plane', type: 'ref_plane', state: 'error', message: expect.any(String) });
      h.fake.emitTurn({ id: 't-local', title: 'Plate', local: true, contextTokens: 32_768, images: false });
      const local = (await h.ok('get_model', BRIEF, { turn: 't-local' })).data;
      expect(bytes(local)).toBeLessThanOrEqual(3 * 1024);
      const rows = local.features as Row[];
      expect(rows[0]).toMatchObject({ earlier: expect.any(Number), states: expect.objectContaining({ error: 1 }), errors: ['Broken plane'] });
      expect(rows[rows.length - 1].name).toBe('Sketch 18');
      expect((rows[0].earlier as number) + rows.length - 1).toBe(20);
      // Above 80 features (cloud) the older ones collapse whatever their size.
      for (let i = 0; i < 65; i++) await h.add('ref_plane', { plane: { kind: 'origin', plane: 'origin:top' }, distance: `${i + 20} mm` });
      const many = (await h.ok('get_model', BRIEF)).data.features as Row[];
      expect(many[0]).toMatchObject({ earlier: 5 });
      expect(many).toHaveLength(81);
    },
    REAL_KERNEL_MS * 2,
  );
});

describe('get_model within its budget', () => {
  it(
    'long lists of parameters are halved, the rest counted, so the features keep their room',
    async () => {
      h = await assistantHarness();
      await plate(h);
      for (let i = 0; i < 120; i++) h.doc.addParam({ name: `p${i}`, expr: `${i + 1} mm`, quantity: 'length' });
      await h.settle();
      const d = (await h.ok('get_model', BRIEF)).data;
      expect(bytes(d)).toBeLessThanOrEqual(8 * 1024);
      const params = d.params as Row[];
      expect(params.length + (d.params_more as number)).toBe(123);
      expect(params[0]).toEqual({ name: 'w', kind: 'length', expr: '60 mm', value: 60 });
      expect((d.features as Row[]).map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1']);
    },
    REAL_KERNEL_MS,
  );
});

describe('get_model full and one feature', () => {
  it(
    'full: inputs null with a summary while no tool writes the type, and the expression fields',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const d = (await h.ok('get_model', { detail: 'full', feature: '' })).data;
      expect(bytes(d)).toBeLessThanOrEqual(24 * 1024);
      const ex = (d.features as Row[])[1];
      expect(ex).toMatchObject({ name: 'Extrude 1', inputs: null, summary: 'Extrude · op new' });
      expect(ex.values).toContainEqual({ field: 'extent.distance', expr: 't' });
    },
    REAL_KERNEL_MS,
  );

  it(
    "one sketch: its plane, the solver's state now, its regions; a name not found lists the names",
    async () => {
      h = await assistantHarness();
      await plate(h);
      const r = await h.ok('get_model', { detail: 'brief', feature: 'sketch 1' });
      const f = r.data.feature as Row;
      expect(f.plane).toEqual({ on: 'Top', origin_mm: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], words: 'u runs +X, v runs +Y, origin (0, 0, 0)' });
      // A rectangle of four lines with no relation: 4 points free in u and v.
      expect(f.solver).toMatchObject({ state: 'under', dof: 8, source: 'solver', conflicting: [], redundant: [] });
      expect((f.solver as { free: { of: string; moves: string[] }[] }).free.map((x) => x.of).sort()).toEqual(['pt_a', 'pt_b', 'pt_c', 'pt_d']);
      expect(f.regions).toEqual([{ id: 'r1', area_mm2: 2400, at: expect.any(Array), at_mm: expect.any(Array), holes: 0, depth: 0, bbox_uv: [[-30, -20], [30, 20]], bounded_by: ['e_1', 'e_2', 'e_3', 'e_4'] }]);
      expect(f).toMatchObject({ inputs: null, entities: 4, constraints: 0, open: [], dangling: [] });
      expect(r.text).toBe('Sketch 1 (sketch): ok');
      // One feature's reply keeps the Part's short facts, not its lists.
      expect(r.data).toMatchObject({ part: 'Part 1', editable: true, person: null });
      expect(r.data.bodies).toBeUndefined();
      expect(r.data.params).toBeUndefined();
      const miss = await h.call('get_model', { detail: 'brief', feature: 'Boss' });
      expect(miss).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', message: 'not_found: No feature is called "Boss". Features: Sketch 1, Extrude 1.', detail: { reason: 'not_found', names: ['Sketch 1', 'Extrude 1'], more: 0 } },
      });
    },
    REAL_KERNEL_MS,
  );
});

describe("rev and the person's changes", () => {
  it(
    "rev stays across a live draft and goes up by one per commit; the person's changes are told once, with their undo of the Assistant's steps",
    async () => {
      h = await assistantHarness();
      const { extrude } = await plate(h);
      const first = await h.ok('get_model', BRIEF);
      const rev0 = first.data.rev as number;
      expect(first.data.user_changes).toBeUndefined();
      // The person edits the extrude: a live draft, not committed.
      const s = h.doc.beginEdit(extrude);
      s.update({ extent: { kind: 'blind', distance: '8 mm' } } as Partial<Feature>);
      await h.settle();
      const live = await h.ok('get_model', BRIEF);
      expect(live.data.rev).toBe(rev0);
      expect(live.data.person).toBe('editing Extrude 1');
      expect(live.data.user_changes).toBeUndefined();
      s.commit();
      await h.settle();
      const after = await h.ok('get_model', BRIEF);
      expect(after.data.rev).toBe(rev0 + 1);
      expect(after.data.person).toBeNull();
      expect(after.data.user_changes).toEqual(['changed Extrude 1']);
      // Told once.
      expect((await h.ok('get_model', BRIEF)).data.user_changes).toBeUndefined();
      // The person renames it and undoes the Assistant's steps (the doc's event, as Ctrl+Z sends it).
      h.doc.rename(extrude, 'Base');
      h.services.bus.emit('assistant:person-undo', { tag: 'turn:t-test', label: 'Assistant: Plate', redo: false });
      const told = await h.ok('get_model', BRIEF);
      expect(told.data.user_changes).toEqual(['the person undid your steps (Assistant: Plate); do not redo them unless asked', 'renamed Extrude 1 to Base']);
      expect(told.data.rev).toBe(rev0 + 2);
      // Another key's baseline starts at its own first call.
      expect((await h.ok('get_model', BRIEF, { turn: 't-other' })).data.user_changes).toBeUndefined();
    },
    REAL_KERNEL_MS,
  );

  it(
    'an inch Part evaluates in mm; the rollback bar above the end is said',
    async () => {
      h = await assistantHarness({ units: 'imperial' });
      h.doc.addParam({ name: 'a', expr: '2', quantity: 'length' });
      const sketch = await h.add('sketch', rectangle(25.4, 25.4));
      await h.add('ref_plane', { plane: { kind: 'origin', plane: 'origin:top' }, distance: '1 in' });
      h.doc.setRollback(1);
      await h.settle();
      const d = (await h.ok('get_model', BRIEF)).data;
      expect(d.units).toEqual({ length: 'in', angle: 'deg' });
      expect(d.params).toEqual([{ name: 'a', kind: 'length', expr: '2', value: 50.8 }]);
      expect(d.rolled_back).toEqual({ after: 'Sketch 1', count: 1 });
      expect(d.person).toBe('the rollback bar is after Sketch 1, not at the end');
      expect((d.features as Row[])[1]).toMatchObject({ name: 'Plane 1', state: 'rolled_back' });
      void sketch;
    },
    REAL_KERNEL_MS,
  );
});
