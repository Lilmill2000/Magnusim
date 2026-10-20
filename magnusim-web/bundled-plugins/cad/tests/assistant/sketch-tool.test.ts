// The sketch tool as one Assistant step on the REAL kernel and solver, through sketch mode (CAD
// tools spec §3.2.7, §4, §6.5-6.9, §7.7):
//   - a new sketch: one undo entry named after the request, get_model's by: "assistant", no panel
//     or sketch mode left open, the stored solved block the solver's;
//   - a replace (edit): kept ids keep their points, so the region key stays; a removed entity goes;
//     "" for on keeps where it lies; name renames; a sketch made later, an extrude, a missing name
//     and a taken name are refused before anything changes;
//   - get_model feature <sketch> gives the tool's input form: resent as it is, the sketch comes back
//     the same (macros, joins, infer, a sketch the person drew with the UI's ids); a sketch the person
//     drew with a fixed point resends too, one too big to resend is too_big (and refused);
//   - edit_feature on a sketch's dimension ids: checked headless first (no solution, a bad field),
//     written through sketch mode; a value that breaks a feature after it changes nothing; on a
//     person's sketch with a sketch pattern the check keeps the pattern's ties, so its state, dof,
//     free and moved are the sketch's (get_model's), the copies moving with their source.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import { freeRows } from '../../src/assistant/sketch/solve';
import { createUnitsService } from '../../src/doc/units';
import { refOfRegion } from '../../src/features/extrude/profiles';
import { createPattern } from '../../src/sketch/tools/pattern';
import type { SketchFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { fillet } from './parts';
import { block, C, E, featureNamed, outputOf, partNow, rectInput, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const ok = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
};
const fail = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} did not fail: ${JSON.stringify(r.result).slice(0, 300)}`);
  return r.error as { code: string; message: string; hint: string; detail: Row };
};
const inputsOf = async (x: AssistantHarness, name: string) => {
  const r = await ok(x, 'get_model', { detail: 'brief', feature: name });
  return (r.data.feature as Row).inputs as Row | null;
};
/** A sketch as stored, without what a resend may renumber (nothing should). */
const stored = (f: SketchFeature) => ({ support: f.support, points: f.points, entities: f.entities, constraints: f.constraints });
const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

describe('a new sketch, and its replace', () => {
  it(
    'is one step with one undo entry; a replace keeps its points and region key, and removes what is left out',
    async () => {
      h = await assistantHarness({ sketchMode: true, title: 'Plate' });
      h.fake.emitTurn({ id: 't-test', title: 'A plate with a hole' });
      const r = await ok(h, 'sketch', rectInput('Plate sketch', 60, 40));
      expect(r.data).toMatchObject({ step: 1, feature: { name: 'Plate sketch', type: 'sketch', state: 'ok' }, resolved: { on: 'Top plane' } });
      expect(partNow(h)).toEqual({ features: ['Plate sketch'], undo: 'Assistant: A plate with a hole', session: false, panel: false, mode: 'model' });
      const id = featureNamed(h, 'Plate sketch').id;
      expect(runtimeOf(h.services)!.madeBy.has(id)).toBe(true);
      expect(featureNamed(h, 'Plate sketch').solved).toEqual({ values: { dw: 60, dh: 40 }, dof: 0, state: 'fully' });
      const key = outputOf(h, 'Plate sketch').regions[0].key;
      const points = featureNamed(h, 'Plate sketch').points;
      // Add a hole, keep the rest: the rect's points and its region's outer loop stay.
      const again = await ok(h, 'sketch', {
        ...rectInput('', 60, 40),
        edit: 'Plate sketch',
        on: '',
        entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('h', 'circle', [10, 0, 3])],
      });
      expect(again.data.step).toBe(2);
      expect(featureNamed(h, 'Plate sketch').points).toMatchObject(points);
      const rows = again.data.regions as Row[];
      expect(rows.map((x) => [x.id, x.holes, x.depth])).toEqual([
        ['r1', 1, 0],
        ['r2', 0, 1],
      ]);
      const plate = [...outputOf(h, 'Plate sketch').regions].sort((a, b) => b.area - a.area)[0];
      expect(plate.loops[0].join(' ')).toBe(key);
      // Left out: the hole goes again. A new name renames it.
      await ok(h, 'sketch', { ...rectInput('Base sketch', 60, 40), edit: 'Plate sketch', on: '' });
      expect(featureNamed(h, 'Base sketch').entities.map((e) => e.id)).toEqual(['r__bottom', 'r__right', 'r__top', 'r__left', 'r__center']);
      expect(outputOf(h, 'Base sketch').regions.map((x) => x.key)).toEqual([key]);
      // Still one undo entry for the request.
      expect(h.doc.state.get().history.undoLabel).toBe('Assistant: A plate with a hole');
      h.fake.emitTurn({ id: 't-test', title: 'A plate with a hole', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(h.doc.state.get().doc.features).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses an edit of another type, a missing or taken name, and a support made after the sketch, changing nothing',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      const before = partNow(h);
      expect((await fail(h, 'sketch', { ...rectInput('', 10, 10), edit: 'Base' })).detail).toMatchObject({ reason: 'wrong_feature_type', field: 'edit', type: 'extrude' });
      expect((await fail(h, 'sketch', { ...rectInput('', 10, 10), edit: 'Nope' })).detail).toMatchObject({ reason: 'not_found', field: 'edit' });
      expect((await fail(h, 'sketch', rectInput('base', 10, 10))).detail).toMatchObject({ reason: 'name_taken', field: 'name' });
      // The block's sketch cannot move onto the block it makes (the face comes later in the history).
      const later = await fail(h, 'sketch', { ...rectInput('', 60, 40), edit: 'Base sketch', on: 'Base.end' });
      expect(later).toMatchObject({ message: 'nothing_selected: No face made by Base is on the bodies before Base sketch.', detail: { reason: 'nothing_selected' } });
      expect(partNow(h)).toEqual(before);
      // A new sketch with an empty `on` is refused; with edit, "" keeps where it lies.
      expect((await fail(h, 'sketch', SK({ on: '', entities: [E('c', 'circle', [0, 0, 2])] }))).detail).toMatchObject({ reason: 'bad_input', field: 'on' });
    },
    REAL_KERNEL_MS,
  );
});

describe('where a sketch lies', () => {
  it(
    "a sketch on a face says its face by the label the tools read back (brief, one feature, the sketch's reply), and that label makes the next sketch",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      const made = await ok(h, 'sketch', SK({ name: 'Pads', on: 'Base.end', entities: [E('c', 'circle', [0, 0, 3])] }));
      expect((made.data.plane as Row).on).toBe('Base.end');
      const brief = await ok(h, 'get_model', { detail: 'brief', feature: '' });
      const row = (brief.data.features as Row[]).find((f) => f.name === 'Pads')!;
      expect(row.on).toBe('Base.end');
      const one = await ok(h, 'get_model', { detail: 'brief', feature: 'Pads' });
      expect(((one.data.feature as Row).plane as Row).on).toBe('Base.end');
      // Copied as it is into the next sketch's on.
      await ok(h, 'sketch', SK({ name: 'More pads', on: String(row.on), entities: [E('c', 'circle', [10, 0, 3])] }));
      expect(featureNamed<SketchFeature>(h, 'More pads').support).toMatchObject({ kind: 'face' });
    },
    REAL_KERNEL_MS,
  );
});

describe('free parameters', () => {
  it('freeRows keeps a point\'s or an entity\'s, by the model\'s names, each once; a constraint\'s own helpers are left out', () => {
    const owns = (id: string) => ['k', 'p__1', 'pt'].includes(id);
    const refOf = (id: string) => (id === 'p__1' ? 'p.1' : id);
    expect(freeRows(['k.a1', 'k.a0', 'k.r', 'k.r', 'pat.hx', 'pat.hy', 'on.u', 'p__1.x', 'pt.u', 'pt.u', '#3', 'nodot'], owns, refOf)).toEqual([
      { of: 'k', moves: ['end_angle', 'start_angle', 'r'] },
      { of: 'p.1', moves: ['x'] },
      { of: 'pt', moves: ['u'] },
    ]);
  });

  it(
    "get_model names a sketch's freedoms as the sketch tool's reply does: an arc's angles, each once",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const r = await ok(h, 'sketch', SK({ name: 'Arc sk', entities: [E('k', 'arc', [0, 0, 10, 20, 160])] }));
      const fromTool = (r.data.solver as { free: { of: string; moves: string[] }[] }).free;
      const read = await ok(h, 'get_model', { detail: 'brief', feature: 'Arc sk' });
      const fromModel = ((read.data.feature as Row).solver as { free: { of: string; moves: string[] }[] }).free;
      const sorted = (rows: { of: string; moves: string[] }[]) => rows.map((x) => ({ of: x.of, moves: [...x.moves].sort() })).sort((a, b) => a.of.localeCompare(b.of));
      expect(sorted(fromModel)).toEqual(sorted(fromTool));
      const arc = fromModel.find((x) => x.of === 'k');
      expect(arc?.moves).toEqual(expect.arrayContaining(['start_angle', 'end_angle']));
      for (const x of fromModel) {
        expect(x.moves.some((m) => m === 'a0' || m === 'a1'), x.of).toBe(false);
        expect(new Set(x.moves).size, x.of).toBe(x.moves.length);
      }
    },
    REAL_KERNEL_MS,
  );
});

describe("get_model's input form", () => {
  it(
    'resent as it is, gives the same sketch: macros, joins, infer, an arc and a centerline',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const input = SK({
        name: 'Mix',
        entities: [
          E('l', 'line', [30, 20, 50, 40]),
          E('r', 'rect', [-30, -20, 30, 20]),
          E('s', 'slot', [-20, 50, 0, 50, 4]),
          E('g', 'polygon', [40, -40, 8, 6]),
          E('t', 'sector', [-50, -50, 5, 9, 10, 80]),
          E('p', 'polyline', [60, 0, 80, 0, 80, 10, 60, 0]),
          E('a', 'arc', [0, -60, 6, 20, 160]),
          E('ax', 'centerline', [0, -100, 0, 100]),
          E('q', 'point', [5, 5]),
        ],
        constraints: [C('o', 'coincident', ['r.bl', 'origin']), C('dw', 'distance', ['r.bottom'], '60 mm'), C('dl', 'distance', ['l'], '28 mm'), C('pq', 'point_on', ['q', 'r.top'])],
        infer: true,
      });
      const first = await ok(h, 'sketch', input);
      expect(first.data.joined).toEqual(['l.start = r.tr']);
      const before = stored(featureNamed(h, 'Mix'));
      const form = await inputsOf(h, 'Mix');
      expect(form).toMatchObject({ edit: 'Mix', name: 'Mix', on: 'Top', infer: true });
      expect((form!.entities as Row[]).map((e) => `${e.id}:${e.kind}`)).toEqual(['l:line', 'r:rect', 's:slot', 'g:polygon', 't:sector', 'p:polyline', 'a:arc', 'ax:centerline', 'q:point']);
      expect((form!.constraints as Row[]).map((c) => c.id)).toEqual(['o', 'dw', 'dl', 'pq']);
      expect((form!.constraints as Row[])[3]).toEqual({ id: 'pq', kind: 'point_on', refs: ['q', 'r.top'], value: '' });
      await ok(h, 'sketch', form!);
      const after = stored(featureNamed(h, 'Mix'));
      expect(after.entities).toEqual(before.entities);
      expect(after.constraints).toEqual(before.constraints);
      expect(Object.keys(after.points)).toEqual(Object.keys(before.points));
      for (const [id, p] of Object.entries(before.points)) {
        expect(after.points[id][0], id).toBeCloseTo(p[0], 5);
        expect(after.points[id][1], id).toBeCloseTo(p[1], 5);
      }
    },
    REAL_KERNEL_MS,
  );

  it(
    "resends a sketch the person drew, by its own ids (a fixed point too); too many entities too_big",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await h.add('sketch', {
        name: 'Drawn',
        points: { pt_1: [0, 0], pt_2: [20, 0], pt_3: [20, 10] },
        entities: [
          { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
          { id: 'e_2', kind: 'line', p: ['pt_2', 'pt_3'] },
        ],
        constraints: [
          { id: 'c_1', kind: 'horizontal', refs: ['e_1'], inferred: true },
          { id: 'c_2', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true },
          { id: 'c_3', kind: 'coincident', refs: ['pt_1', 'origin'] },
        ],
        solved: { values: { c_2: 20 }, dof: 3, state: 'under' },
      });
      const before = stored(featureNamed(h, 'Drawn'));
      const form = await inputsOf(h, 'Drawn');
      expect(form).toMatchObject({
        on: 'Top',
        infer: false,
        entities: [
          { id: 'e_1', kind: 'line', at: [0, 0, 20, 0] },
          { id: 'e_2', kind: 'line', at: [20, 0, 20, 10] },
        ],
        constraints: [
          { id: 'c_1', kind: 'horizontal', refs: ['e_1'], value: '' },
          { id: 'c_2', kind: 'distance', refs: ['e_1'], value: '20 mm' },
          { id: 'c_3', kind: 'coincident', refs: ['e_1.start', 'origin'], value: '' },
        ],
      });
      await ok(h, 'sketch', form!);
      const after = stored(featureNamed(h, 'Drawn'));
      expect(after.entities).toEqual(before.entities);
      expect(after.constraints.map((c) => ({ ...c, inferred: undefined }))).toEqual(before.constraints.map((c) => ({ ...c, inferred: undefined })));
      // A fixed point: its form has the fix row; resent, the sketch comes back the same; its dimensions change.
      await h.add('sketch', {
        name: 'Fixed',
        points: { pt_1: [0, 0], pt_2: [20, 0] },
        entities: [{ id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] }],
        constraints: [
          { id: 'c_1', kind: 'fix', refs: ['pt_1'], value: [0, 0] },
          { id: 'c_2', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true },
        ],
        solved: { values: { c_2: 20 }, dof: 1, state: 'under' },
      });
      const fixedForm = await inputsOf(h, 'Fixed');
      expect(fixedForm).toMatchObject({ constraints: [{ id: 'c_1', kind: 'fix', refs: ['e_1.start'], value: '' }, { id: 'c_2', kind: 'distance', refs: ['e_1'], value: '20 mm' }] });
      const fixedBefore = stored(featureNamed(h, 'Fixed'));
      await ok(h, 'sketch', fixedForm!);
      expect(stored(featureNamed(h, 'Fixed'))).toEqual(fixedBefore);
      await ok(h, 'edit_feature', EDIT('Fixed', { set: [{ field: 'c_2', value: '25 mm' }] }));
      expect(featureNamed(h, 'Fixed').points.pt_2[0]).toBeCloseTo(25, 6);
      // 151 points: too big to resend.
      const pts: Record<string, [number, number]> = {};
      const ents = Array.from({ length: 151 }, (_, k) => {
        pts[`pt_${k}`] = [k * 2, 50];
        return { id: `e_${k}`, kind: 'point', p: `pt_${k}` };
      });
      await h.add('sketch', { name: 'Many', points: pts, entities: ents, constraints: [], solved: { values: {}, dof: 302, state: 'under' } });
      const many = await ok(h, 'get_model', { detail: 'brief', feature: 'Many' });
      expect(many.data.feature).toMatchObject({ inputs: null, too_big: 'too big to resend; use edit_feature for its dimensions' });
      expect((await fail(h, 'sketch', SK({ edit: 'Many', on: '', entities: [E('e_0', 'point', [0, 50])] }))).detail.reason).toBe('too_big');
    },
    REAL_KERNEL_MS,
  );
});

describe("edit_feature on a sketch's dimensions", () => {
  it(
    'changes them through sketch mode; refuses a bad field, no solution, and a value that breaks a later feature',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const b = await block(h, { w: 60, d: 40, t: 10 });
      const r = await ok(h, 'edit_feature', EDIT('Base sketch', { set: [{ field: 'dw', value: '80 mm' }] }));
      expect(r.text).toBe('Edit Base sketch ok: dw 80 mm · Body 1 24000 → 32000 mm³');
      expect(r.data).toMatchObject({ feature: { name: 'Base sketch', state: 'ok' }, values: [{ field: 'dw', expr: '80 mm' }, { field: 'dh', expr: '40 mm' }], flipped: [] });
      expect(featureNamed(h, 'Base sketch').solved.values).toEqual({ dw: 80, dh: 40 });
      expect(h.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(80 * 40 * 10, 3);
      expect(partNow(h)).toMatchObject({ session: false, panel: false, mode: 'model' });
      const before = partNow(h);
      const bad = await fail(h, 'edit_feature', EDIT('Base sketch', { set: [{ field: 'width', value: '3 mm' }] }));
      expect(bad).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input' } });
      expect(bad.message).toContain('set[0].field: Base sketch has no dimension "width" (its dimensions: dw, dh)');
      // A fillet of the top face's edges, 4 mm: 6 mm deep would make it fail; nothing changes.
      await fillet(h, { sketch: b.sketch, extrude: b.extrude, body: h.doc.state.get().rebuild.bodies[0].id, profile: refOfRegion(b.sketch, outputOf(h, 'Base sketch').regions[0]) }, '4 mm');
      const broke = await fail(h, 'edit_feature', EDIT('Base sketch', { set: [{ field: 'dh', value: '6 mm' }] }));
      expect(broke.detail).toMatchObject({ reason: 'broke_downstream', broke: [{ feature: 'Fillet 1' }] });
      expect(featureNamed(h, 'Base sketch').solved.values).toEqual({ dw: 80, dh: 40 });
      expect(partNow(h).features).toEqual([...before.features, 'Fillet 1']);
      // Three lines that cannot close: no solution, found before anything changes.
      await ok(h, 'sketch', SK({ name: 'Tri', entities: [E('p', 'polyline', [0, 0, 10, 0, 5, 8, 0, 0])], constraints: [C('a', 'distance', ['p.1'], '10 mm'), C('b', 'distance', ['p.2'], '10 mm'), C('c', 'distance', ['p.3'], '10 mm')] }));
      const none = await fail(h, 'edit_feature', EDIT('Tri', { set: [{ field: 'c', value: '30 mm' }] }));
      expect(none).toMatchObject({ code: 'failed', message: 'sketch_unsolved: The solver found no shape that holds every constraint and dimension. Nothing changed.', detail: { reason: 'sketch_unsolved' } });
      expect((featureNamed(h, 'Tri').constraints.find((x) => x.id === 'c') as { expr: string }).expr).toBe('10 mm');
    },
    REAL_KERNEL_MS,
  );

  it(
    "keeps a person's sketch pattern in the check: the state, dof and free are get_model's, and the copies move with their source",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // The person's row of three holes, 20 mm apart: the first placed from the origin, fully defined.
      const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
      const made = createPattern(
        {
          points: { pt_c: [10, 0] },
          entities: [{ id: 'e_c', kind: 'circle', c: 'pt_c', r: 5 }],
          constraints: [
            { id: 'c_x', kind: 'distance_x', refs: ['origin', 'pt_c'], expr: '10 mm', driving: true },
            { id: 'c_h', kind: 'horizontal', refs: ['origin', 'pt_c'] },
            { id: 'c_d', kind: 'diameter', refs: ['e_c'], expr: '10 mm', driving: true },
          ],
        } as never,
        { kind: 'linear', sources: ['e_c'], count: [3, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } } as never,
        units,
      );
      if (!made.ok) throw new Error(made.reason);
      await h.add('sketch', { name: 'Holes sk', ...made.draft });
      const centres = () => {
        const f = featureNamed(h!, 'Holes sk');
        return f.entities.filter((e) => e.kind === 'circle').map((e) => f.points[(e as { c: string }).c][0]).sort((a, b) => a - b);
      };
      expect(centres()).toEqual([10, 30, 50].map((x) => expect.closeTo(x, 6)));
      const model = async () => ((await ok(h!, 'get_model', { detail: 'brief', feature: 'Holes sk' })).data.feature as Row).solver as Row;
      expect(await model()).toMatchObject({ state: 'fully', dof: 0, free: [] });
      const r = await ok(h, 'edit_feature', EDIT('Holes sk', { set: [{ field: 'c_x', value: '15 mm' }] }));
      expect(r.data.solver).toEqual({ state: 'fully', dof: 0, free: [] });
      expect(r.data.solver).toEqual({ state: (await model()).state, dof: (await model()).dof, free: (await model()).free });
      // All three centres moved 5 mm, the copies with their source.
      expect(centres()).toEqual([15, 35, 55].map((x) => expect.closeTo(x, 6)));
      const moved = r.data.moved as { by_mm: number }[];
      expect(moved).toHaveLength(3);
      for (const m of moved) expect(m.by_mm).toBeCloseTo(5, 6);
    },
    REAL_KERNEL_MS,
  );
});
