// The first edit tools on the REAL kernel, through the page's tool handler (CAD tools spec §3.2.6,
// §3.2.14-16, §7.6-7.9):
//   - set_params: rows in any order in one step (one undo entry), renames rewrite every use, each
//     value evaluated in the answer (added or changed, and what a changed one was); a value change
//     keeps the parameter's comment ("-" removes it); a bad name, a bad expression (with the parameters there are),
//     a removal still used and an unknown name answer before anything changes, naming the row;
//   - body: rename, colour and simulation in one step; a clash, a bad colour and nothing to change
//     refused; a name in quotes (as get_model writes one with parentheses) names the body;
//   - edit_feature: a value by its path, rename, suppress and move (before, after, end) with the
//     Part's own words when refused; a field it does not have, and a sketch dimension the sketch
//     does not have, refused;
//   - undo: the newest calls of the request back to exactly where they began, never past a change
//     of the person's (not_own_step); the previous request as one Undo, with Redo; nothing_to_undo;
//     get_model's undo.your_steps counts what it can take back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { fillet, plate, stateOf, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

type Row = Record<string, unknown>;
const row = (name: string, expr: string, kind = 'length', extra: Partial<Row> = {}) => ({ name, kind, expr, comment: '', rename_to: '', ...extra });
const params = (x: AssistantHarness) => x.doc.state.get().doc.params.map((p) => `${p.name}=${p.expr}`);
const EDIT = (feature: string, o: Partial<Row> = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

describe('set_params', () => {
  it(
    'applies rows in any order as one step, renames every use, and answers each value evaluated',
    async () => {
      h = await assistantHarness({ title: 'Chip' });
      h.fake.emitTurn({ id: 't-1', title: 'A poker chip' });
      // floor_t uses chip_t, which comes after it: all apply together.
      const r = await h.ok('set_params', { set: [row('floor_t', '(chip_t - disc_t) / 2'), row('chip_t', '3.3 mm'), row('disc_t', '1 mm')], remove: [] }, { turn: 't-1' });
      expect(params(h)).toEqual(['floor_t=(chip_t - disc_t) / 2', 'chip_t=3.3 mm', 'disc_t=1 mm']);
      expect(r.data).toMatchObject({
        params: [
          { name: 'floor_t', kind: 'length', expr: '(chip_t - disc_t) / 2', value: 1.15, unit: 'mm' },
          { name: 'chip_t', kind: 'length', expr: '3.3 mm', value: 3.3, unit: 'mm' },
          { name: 'disc_t', kind: 'length', expr: '1 mm', value: 1, unit: 'mm' },
        ],
        removed: [],
        rebuilt: { ok: 0, warning: 0, error: 0 },
        step: 1,
        feature: null,
        broke: [],
      });
      expect(r.text).toBe('Parameters set: floor_t = 1.15 mm, chip_t = 3.3 mm, disc_t = 1 mm');
      // One undo entry, named after the request.
      expect(undoLabel(h)).toBe('Assistant: A poker chip');
      // A rename with a use in the same call, and a swap of who uses whom (chip_t now uses disc).
      await h.ok('set_params', { set: [row('disc_t', '1 mm', 'length', { rename_to: 'disc' }), row('chip_t', 'disc * 3.3')], remove: [] }, { turn: 't-1' });
      expect(params(h)).toEqual(['floor_t=(chip_t - disc) / 2', 'chip_t=disc * 3.3', 'disc=1 mm']);
      // Still one entry for the whole request: after the turn, one Undo empties it, one Redo brings it all back.
      h.fake.emitTurn({ id: 't-1', title: 'A poker chip', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(params(h)).toEqual([]);
      h.doc.redo();
      expect(params(h)).toEqual(['floor_t=(chip_t - disc) / 2', 'chip_t=disc * 3.3', 'disc=1 mm']);
    },
    REAL_KERNEL_MS,
  );

  it(
    "a value change keeps the parameter's comment (\"\" keeps it, \"-\" removes it), and each row says whether it added or changed one",
    async () => {
      h = await assistantHarness();
      await h.ok('set_params', { set: [row('t', '6 mm', 'length', { comment: 'sheet stock, do not change' }), row('w', '40 mm')], remove: [] });
      const comments = () => Object.fromEntries(h!.doc.state.get().doc.params.map((p) => [p.name, p.comment ?? null]));
      const r = await h.ok('set_params', { set: [row('t', '8 mm'), row('n', '4', 'number')], remove: [] });
      expect(comments()).toEqual({ t: 'sheet stock, do not change', w: null, n: null });
      expect(r.data.params).toEqual([
        { name: 't', row: 'changed', kind: 'length', expr: '8 mm', was: '6 mm', value: 8, unit: 'mm' },
        { name: 'n', row: 'added', kind: 'number', expr: '4', value: 4, unit: '' },
      ]);
      expect(r.text).toBe('Parameters set: t = 8 mm (was 6 mm), n = 4');
      // A new comment replaces it; "-" removes it.
      await h.ok('set_params', { set: [row('t', '8 mm', 'length', { comment: 'from the drawing' })], remove: [] });
      expect(comments().t).toBe('from the drawing');
      const same = await h.ok('set_params', { set: [row('t', '8 mm', 'length', { comment: '-' })], remove: [] });
      expect(comments().t).toBeNull();
      expect((same.data.params as Row[])[0]).toEqual({ name: 't', row: 'changed', kind: 'length', expr: '8 mm', value: 8, unit: 'mm' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses a bad name, a bad expression, a removal still used and an unknown name, changing nothing',
    async () => {
      h = await assistantHarness();
      await h.ok('set_params', { set: [row('w', '40 mm'), row('h', 'w / 2')], remove: [] });
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const bad = await h.call('set_params', { set: [row('ok1', '1 mm'), row('2x', '3 mm')], remove: [] });
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_name', field: 'set[1].name' } } });
      const expr = await h.call('set_params', { set: [row('h', 'thk / 2')], remove: [] });
      expect(expr).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'expr_error: set[0].expr: Unknown parameter "thk". Parameters: w, h.', detail: { reason: 'expr_error', field: 'set[0].expr' } } });
      const used = await h.call('set_params', { set: [], remove: ['w'] });
      expect(used).toMatchObject({ ok: false, error: { code: 'invalid_input', message: "in_use: remove[0]: w can't be deleted: h uses it.", detail: { reason: 'in_use' } } });
      const unknown = await h.call('set_params', { set: [], remove: ['nope'] });
      expect(unknown).toMatchObject({ ok: false, error: { detail: { reason: 'not_found', field: 'remove[0]', names: ['w', 'h'] } } });
      const twice = await h.call('set_params', { set: [row('w', '1 mm'), row('w', '2 mm')], remove: [] });
      expect(twice).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((twice as { error: { message: string } }).error.message).toContain('set[1]: w is set twice');
      const empty = await h.call('set_params', { set: [], remove: [] });
      expect(empty).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      // Nothing changed: the model, the undo history.
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
    },
    REAL_KERNEL_MS,
  );
});

describe('body', () => {
  it(
    'renames, recolours and leaves a body out of the simulation in one step; refuses a clash, a bad colour and nothing to change',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const r = await h.ok('body', { body: 'body 1', rename_to: 'Plate', color: '#AA3300', simulation: 'exclude' });
      const def = h.doc.state.get().doc.bodies[p.body];
      expect(def).toMatchObject({ name: 'Plate', color: '#aa3300', simulation: false });
      expect(r.data).toMatchObject({ body: { name: 'Plate', color: '#aa3300', simulation: false }, resolved: { body: 'Body 1' } });
      expect(r.text).toBe('Body Body 1: renamed Plate, colour #aa3300, left out of the simulation');
      // One undo entry takes all three back.
      h.doc.undo();
      expect(h.doc.state.get().doc.bodies[p.body]).toMatchObject({ name: 'Body 1' });
      expect(h.doc.state.get().doc.bodies[p.body].simulation).toBeUndefined();
      h.doc.redo();
      expect(await h.call('body', { body: 'Plate', rename_to: '', color: 'red', simulation: 'keep' })).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect(await h.call('body', { body: 'Plate', rename_to: 'Plate', color: '#aa3300', simulation: 'exclude' })).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect(await h.call('body', { body: 'Nope', rename_to: '', color: '', simulation: 'include' })).toMatchObject({ ok: false, error: { detail: { reason: 'not_found', names: ['Plate'] } } });
      // A second body: its name is taken (any case).
      await h.add('extrude', { profiles: [p.profile], extent: { kind: 'blind', distance: '3 mm' }, op: 'new' });
      const second = h.doc.state.get().rebuild.bodies.find((b) => b.id !== p.body)!.name;
      expect(await h.call('body', { body: second, rename_to: 'PLATE', color: '', simulation: 'keep' })).toMatchObject({ ok: false, error: { detail: { reason: 'name_taken', field: 'rename_to' } } });
      // A name with the selectors' own characters, in quotes as get_model writes it, names the body too.
      await h.ok('body', { body: second, rename_to: 'Plate (copy)', color: '', simulation: 'keep' });
      const quoted = await h.ok('body', { body: '"Plate (copy)"', rename_to: 'Copy', color: '', simulation: 'keep' });
      expect(quoted.data).toMatchObject({ body: { name: 'Copy' }, resolved: { body: 'Plate (copy)' } });
    },
    REAL_KERNEL_MS,
  );
});

describe('edit_feature', () => {
  it(
    'sets a value by its path through the Edit panel, renames, suppresses and moves; refuses what the Part refuses',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const r = await h.ok('edit_feature', EDIT('Extrude 1', { set: [{ field: 'extent.distance', value: '10 mm' }] }));
      const ex = () => h!.doc.state.get().doc.features.find((f) => f.id === p.extrude) as { name: string; extent: { distance: string }; suppressed?: boolean };
      expect(ex().extent.distance).toBe('10 mm');
      expect(r.data).toMatchObject({ feature: { name: 'Extrude 1', type: 'extrude', state: 'ok' }, resolved: { 'extent.distance': '10 mm' } });
      expect((r.data.bodies as { changed: Row[] }).changed).toEqual([expect.objectContaining({ body: 'Body 1', volume_mm3: [14400, 24000], bbox_max_z: [6, 10], solids: [1, 1] })]);
      expect(r.text).toBe('Edit Extrude 1 ok: extent.distance 10 mm · Body 1 14400 → 24000 mm³');
      // No panel is left open, and the step is one undo entry.
      expect(h.doc.session()).toBeNull();
      await h.ok('edit_feature', EDIT('extrude 1', { rename_to: 'Base' }));
      expect(ex().name).toBe('Base');
      const clash = await h.call('edit_feature', EDIT('Base', { rename_to: 'sketch 1' }));
      expect(clash).toMatchObject({ ok: false, error: { detail: { reason: 'name_taken', field: 'rename_to' } } });
      // A move the history refuses (Base uses Sketch 1), in the Part's own words.
      const move = await h.call('edit_feature', EDIT('Base', { move: 'before Sketch 1' }));
      expect(move).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'bad_input: move: Base uses Sketch 1: it cannot move above it.' } });
      const field = await h.call('edit_feature', EDIT('Base', { set: [{ field: 'height', value: '3 mm' }] }));
      expect(field).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((field as { error: { message: string } }).error.message).toContain('Base has no field "height" (its fields: distance, flip, op)');
      const sketch = await h.call('edit_feature', EDIT('Sketch 1', { set: [{ field: 'd1', value: '3 mm' }] }));
      // A sketch's fields are its dimension ids (sketch-tool.test.ts changes them); this one has none.
      expect(sketch).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'bad_input: set[0].field: Sketch 1 has no dimension "d1" (its dimensions: none).', detail: { reason: 'bad_input' } } });
      await h.ok('edit_feature', EDIT('Base', { suppress: 'suppress' }));
      expect(ex().suppressed).toBe(true);
      expect(stateOf(h, p.extrude)).toBe('suppressed');
      await h.ok('edit_feature', EDIT('Base', { suppress: 'unsuppress' }));
      expect(stateOf(h, p.extrude)).toBe('ok');
      // Moves: a fillet after the plate, then the plate's sketch to the end is refused, and "after" works.
      await fillet(h, p, '1 mm');
      expect(await h.call('edit_feature', EDIT('Sketch 1', { move: 'end' }))).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect(await h.call('edit_feature', EDIT('Fillet 1', { move: 'after fillet 1' }))).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect(await h.call('edit_feature', EDIT('Fillet 1', { move: 'before Nope' }))).toMatchObject({ ok: false, error: { detail: { reason: 'not_found', field: 'move' } } });
      expect(await h.call('edit_feature', EDIT('Base'))).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
    },
    REAL_KERNEL_MS,
  );
});

describe('undo', () => {
  it(
    "takes back the request's newest calls exactly, never past the person's change; get_model counts them",
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-1', title: 'Parameters' });
      const t = { turn: 't-1' };
      const start = h.doc.state.get().doc;
      await h.ok('set_params', { set: [row('a', '1 mm')], remove: [] }, t);
      const afterA = h.doc.state.get().doc;
      await h.ok('set_params', { set: [row('b', '2 mm')], remove: [] }, t);
      await h.ok('set_params', { set: [row('c', '3 mm')], remove: [] }, t);
      expect((await h.ok('get_model', { detail: 'brief', feature: '' }, t)).data.undo).toEqual({ label: 'Assistant: Parameters', your_steps: 3 });
      expect(await h.call('undo', { steps: 4, previous_turn: false }, t)).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input', range: [1, 3] } } });
      const r = await h.ok('undo', { steps: 2, previous_turn: false }, t);
      expect(r.data).toMatchObject({ undone: ['Parameters', 'Parameters'], left: 1 });
      expect(h.doc.state.get().doc).toBe(afterA);
      // The request's group is as it was after its first call: one Undo goes back to the start, nothing to redo.
      expect(h.doc.state.get().history).toMatchObject({ undoLabel: 'Assistant: Parameters', canRedo: false });
      // The person's own change, then another call: the undo stops at the person's change.
      h.doc.addParam({ name: 'mine', expr: '9 mm', quantity: 'length' });
      await h.ok('set_params', { set: [row('e', '5 mm')], remove: [] }, t);
      expect((await h.ok('get_model', { detail: 'brief', feature: '' }, t)).data.undo).toMatchObject({ your_steps: 1 });
      const past = await h.call('undo', { steps: 2, previous_turn: false }, t);
      expect(past).toMatchObject({ ok: false, error: { code: 'invalid_input', message: "not_own_step: The person changed the Part after your step 'Parameters': only your 1 newest call can be undone.", detail: { undoable: 1 } } });
      await h.ok('undo', { steps: 1, previous_turn: false }, t);
      expect(h.doc.state.get().doc.params.map((p) => p.name)).toEqual(['a', 'mine']);
      // The person changed it after the newest call: nothing to take back.
      h.doc.addParam({ name: 'mine2', expr: '9 mm', quantity: 'length' });
      expect(await h.call('undo', { steps: 1, previous_turn: false }, t)).toMatchObject({ ok: false, error: { detail: { reason: 'not_own_step' } } });
      expect(h.doc.state.get().doc).not.toBe(start);
    },
    REAL_KERNEL_MS,
  );

  it(
    'undoes the previous request as one Undo (Redo brings it back); nothing_to_undo with nothing of its own',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-1', title: 'First' });
      await h.ok('set_params', { set: [row('a', '1 mm')], remove: [] }, { turn: 't-1' });
      await h.ok('set_params', { set: [row('b', '2 mm')], remove: [] }, { turn: 't-1' });
      h.fake.emitTurn({ id: 't-1', title: 'First', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.fake.emitTurn({ id: 't-2', title: 'Second' });
      expect(await h.call('undo', { steps: 1, previous_turn: false }, { turn: 't-2' })).toMatchObject({ ok: false, error: { detail: { reason: 'nothing_to_undo' } } });
      const r = await h.ok('undo', { steps: 0, previous_turn: true }, { turn: 't-2' });
      expect(r.data).toMatchObject({ undone: ['Assistant: First'], left: 0 });
      expect(h.doc.state.get().doc.params).toEqual([]);
      expect(h.doc.state.get().history).toMatchObject({ canRedo: true, redoLabel: 'Assistant: First' });
      h.doc.redo();
      expect(h.doc.state.get().doc.params.map((p) => p.name)).toEqual(['a', 'b']);
      // The person's own step on top: not the previous request's any more.
      h.doc.addParam({ name: 'mine', expr: '9 mm', quantity: 'length' });
      expect(await h.call('undo', { steps: 0, previous_turn: true }, { turn: 't-2' })).toMatchObject({ ok: false, error: { detail: { reason: 'nothing_to_undo' } } });
    },
    REAL_KERNEL_MS,
  );
});
