// pattern and combine on the REAL kernel, through the page's tool handler (CAD tools spec §3.2.12,
// §3.2.13, §5.2 body selectors, §7.4, §7.7, §12.1 "resolve and real-kernel cases"), on a
// 60 x 40 x 6 plate (Body 1) with a 4 mm hole cut through it (Hole):
//   - a linear pattern of the hole (each feature's own operation) in one and two directions, its
//     copies' faces as labels, its inputs as this tool's input (sent back with edit, a count
//     changed), edit_feature on count; a circular pattern all round (360 deg: evenly);
//   - a mirror of the body about "Right offset 40 mm": the construction plane made in the same
//     step (one undo entry for both), a second mirror there uses it again;
//   - combine takes "bodies of <pattern>" and joins pieces that do not touch with a note (the
//     feature's note, as the tree's info mark; warnings still say the body has more solids),
//     cuts a tool away (it goes, the overlap leaves the target), keeps it when asked (an edit), and
//     refuses tools that are only the targets ("all bodies" less the targets);
//   - refused before anything changes: a pitch below 0 (the hint says flip), a count of 1, an
//     unknown parameter, a sketch as a feature to repeat, a mirror with a count, faces with op cut,
//     bodies with op new; a copy that misses its body fails with CAD's words and changes nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { CircularPatternFeature, LinearPatternFeature, MirrorFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { extrude, plate, regions, Shapes, sketchOn, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const PATTERN = (o: Record<string, unknown>) => ({
  edit: '',
  name: '',
  kind: 'linear',
  of: 'features',
  items: [],
  about: '',
  count: '',
  spacing: '',
  symmetric: false,
  flip: false,
  about2: '',
  count2: '',
  spacing2: '',
  flip2: false,
  op: 'source',
  bodies: [],
  ...o,
});
const COMBINE = (o: Record<string, unknown>) => ({ edit: '', name: '', op: 'join', targets: [], tools: [], keep_tools: false, ...o });
const EDIT = (feature: string, o: Record<string, unknown> = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const HOLE = Math.PI * 2 * 2 * 6;
const bodies = (x: AssistantHarness) => x.doc.state.get().rebuild.bodies.map((b) => ({ name: b.name, volume: b.volume, solids: b.solids }));
const volumeOf = (x: AssistantHarness, name = 'Body 1') => x.doc.state.get().rebuild.bodies.find((b) => b.name === name)!.volume!;
const featureNamed = <T>(x: AssistantHarness, name: string) => x.doc.state.get().doc.features.find((f) => f.name === name) as unknown as T;
const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);

/** The plate with a hole of radius 2 cut through it at (x, 0). */
async function holedPlate(x: AssistantHarness, at = -20): Promise<void> {
  await plate(x);
  const sk = await sketchOn(x, 'Hole sketch', 'origin:top', new Shapes().circle('c1', [at, 0], 2));
  await extrude(x, 'Hole', regions(x, sk), { distance: '6 mm', op: 'cut' });
  expect(volumeOf(x)).toBeCloseTo(14400 - HOLE, 3);
}

describe('pattern', () => {
  it(
    'repeats a hole in a row and in two directions; its inputs come back as pattern input; edit_feature sets count',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-test', title: 'More holes' });
      await holedPlate(h);
      const row = await h.ok('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: '3', spacing: '15 mm' }));
      expect(row.data).toMatchObject({
        feature: { name: 'Linear pattern 1', type: 'pattern_linear', state: 'ok' },
        copies: { made: 2, skipped: [], failed: [] },
        created: ['Linear pattern 1.copy(2)', 'Linear pattern 1.copy(3)'],
        resolved: { about: 'X axis', of: 'features: Hole', op: 'source', count: '3', spacing: '15 mm' },
        step: 1,
      });
      expect(row.text).toMatch(/^Linear pattern 1 ok: 2 copies of Hole · Body 1 14325 → 14174 mm³$/);
      expect(volumeOf(h)).toBeCloseTo(14400 - 3 * HOLE, 3);
      expect(featureNamed<LinearPatternFeature>(h, 'Linear pattern 1')).toMatchObject({ of: 'features', op: 'source', dir1: { axis: { kind: 'origin', axis: 'origin:x' }, count: '3', mode: 'spacing', distance: '15 mm', flip: false, symmetric: false }, dir2: null });
      // get_model full: the pattern as this tool's input, ready to send back.
      const full = await h.ok('get_model', { detail: 'full', feature: 'Linear pattern 1' });
      const f = full.data.feature as Record<string, unknown>;
      expect(f).toMatchObject({
        by: 'assistant',
        inputs: { edit: 'Linear pattern 1', name: '', kind: 'linear', of: 'features', items: ['Hole'], about: 'X axis', count: '3', spacing: '15 mm', about2: '', count2: '', spacing2: '', op: 'source', bodies: [] },
        values: [
          { field: 'count', expr: '3' },
          { field: 'spacing', expr: '15 mm' },
        ],
      });
      // Sent back with a second direction: replaced in place, 3 x 2 holes.
      const two = await h.ok('pattern', { ...(f.inputs as Record<string, unknown>), about2: 'Y axis', count2: '2', spacing2: '8 mm' });
      expect(two.data).toMatchObject({ copies: { made: 5 }, resolved: { about2: 'Y axis', edit: 'Linear pattern 1' } });
      expect(volumeOf(h)).toBeCloseTo(14400 - 6 * HOLE, 3);
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole', 'Linear pattern 1']);
      await h.ok('edit_feature', EDIT('Linear pattern 1', { set: [{ field: 'count2', value: '1 + 2' }] }));
      expect(featureNamed<LinearPatternFeature>(h, 'Linear pattern 1').dir2).toMatchObject({ count: '1 + 2', distance: '8 mm' });
      expect(volumeOf(h)).toBeCloseTo(14400 - 9 * HOLE, 3);
      // One request, one undo entry.
      expect(undoLabel(h)).toBe('Assistant: More holes');
      h.fake.emitTurn({ id: 't-test', title: 'More holes', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Hole sketch', 'Hole']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'spreads copies evenly all round with 360 deg',
    async () => {
      h = await assistantHarness();
      await holedPlate(h, -10);
      const r = await h.ok('pattern', PATTERN({ kind: 'circular', items: ['Hole'], about: 'Z axis', count: '4', spacing: '360 deg' }));
      expect(r.data).toMatchObject({ feature: { name: 'Circular pattern 1', state: 'ok' }, copies: { made: 3 }, resolved: { about: 'Z axis', spacing: '360 deg (evenly all round)' } });
      expect(featureNamed<CircularPatternFeature>(h, 'Circular pattern 1')).toMatchObject({ mode: 'full', count: '4', axis: { kind: 'origin', axis: 'origin:z' } });
      expect(volumeOf(h)).toBeCloseTo(14400 - 4 * HOLE, 3);
      const full = await h.ok('get_model', { detail: 'full', feature: 'Circular pattern 1' });
      const f = full.data.feature as Record<string, unknown>;
      // A full turn has no angle to change on its own.
      expect(f).toMatchObject({ inputs: { kind: 'circular', about: 'Z axis', count: '4', spacing: '360 deg' }, values: [{ field: 'count', expr: '4' }] });
      const angle = await h.call('edit_feature', EDIT('Circular pattern 1', { set: [{ field: 'spacing', value: '90 deg' }] }));
      expect(angle).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((angle as { error: { message: string } }).error.message).toContain('its fields: count');
    },
    REAL_KERNEL_MS,
  );

  it(
    'mirrors a body about an offset plane made in the same step, and uses that plane again',
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-1', title: 'Mirror it' });
      await plate(h);
      const label = undoLabel(h);
      const m = await h.ok('pattern', PATTERN({ kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Right offset 40 mm', op: 'new' }), { turn: 't-1' });
      expect(m.data).toMatchObject({ feature: { name: 'Mirror 1', type: 'mirror', state: 'ok' }, plane: 'Plane 1', bodies: { created: [{ volume_mm3: 14400 }] } });
      expect(m.text).toMatch(/^Mirror 1 ok: mirrored Body 1 about Plane 1 · /);
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Plane 1', 'Mirror 1']);
      const mirror = featureNamed<MirrorFeature>(h, 'Mirror 1');
      expect(mirror.plane).toEqual({ kind: 'feature', feature: h.doc.state.get().doc.features[2].id });
      const copy = h.doc.state.get().rebuild.bodies.find((b) => b.name !== 'Body 1')!;
      expect(copy.bbox.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([50, -20, 0, 110, 20, 6]);
      // The plane and the mirror are one step: one Undo after the request takes both away.
      h.fake.emitTurn({ id: 't-1', title: 'Mirror it', state: 'ended', end: { state: 'done', reason: 'done' } });
      expect(undoLabel(h)).toBe('Assistant: Mirror it');
      h.doc.undo();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1']);
      expect(undoLabel(h)).toBe(label);
      h.doc.redo();
      // A second mirror about the same offset plane uses the plane the Part has.
      const again = await h.ok('pattern', PATTERN({ kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Right offset 40 mm', op: 'new' }), { turn: 't-2' });
      expect(again.data.plane).toBeUndefined();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Plane 1', 'Mirror 1', 'Mirror 2']);
      const full = await h.ok('get_model', { detail: 'full', feature: 'Mirror 2' }, { turn: 't-2' });
      expect(full.data.feature).toMatchObject({ inputs: { kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Plane 1', count: '', spacing: '', op: 'new' } });
      // An edit about a new offset: the plane is made in the step and goes above the mirror it serves.
      const moved = await h.ok('pattern', PATTERN({ edit: 'Mirror 2', kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Right offset 50 mm', op: 'new' }), { turn: 't-2' });
      expect(moved.data).toMatchObject({ plane: 'Plane 2', feature: { name: 'Mirror 2', state: 'ok' } });
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Plane 1', 'Mirror 1', 'Plane 2', 'Mirror 2']);
      const far = h.doc.state.get().rebuild.bodies.map((b) => b.bbox.map((v) => Math.round(v * 1e4) / 1e4)).sort((a, b) => a[0] - b[0]);
      expect(far).toEqual([
        [-30, -20, 0, 30, 20, 6],
        [50, -20, 0, 110, 20, 6],
        [70, -20, 0, 130, 20, 6],
      ]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses a bad pitch, count or field before anything changes; a copy that misses its body fails with CAD\'s words',
    async () => {
      h = await assistantHarness();
      await holedPlate(h);
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const neg = await h.call('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: '3', spacing: '-15 mm' }));
      expect(neg).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'bad_input: spacing: Spacing must be more than 0.', hint: 'Spacing is a pitch above 0: set flip true to go the other way.', detail: { reason: 'bad_input', field: 'spacing' } } });
      const one = await h.call('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: '1', spacing: '15 mm' }));
      expect(one).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input', field: 'count' } } });
      const expr = await h.call('pattern', PATTERN({ items: ['Hole'], about: 'X axis', count: 'nn', spacing: '15 mm' }));
      expect(expr).toMatchObject({ ok: false, error: { detail: { reason: 'expr_error', field: 'count' } } });
      const sketch = await h.call('pattern', PATTERN({ items: ['Hole sketch'], about: 'X axis', count: '2', spacing: '15 mm' }));
      expect(sketch).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input', field: 'items[0]' } } });
      expect((sketch as { error: { message: string } }).error.message).toContain('makes no body of its own to repeat');
      const unknown = await h.call('pattern', PATTERN({ items: ['Nope'], about: 'X axis', count: '2', spacing: '15 mm' }));
      expect(unknown).toMatchObject({ ok: false, error: { detail: { reason: 'not_found', field: 'items[0]', names: ['Extrude 1', 'Hole'] } } });
      const fields = await h.call('pattern', PATTERN({ kind: 'mirror', of: 'faces', items: ['Hole.side'], about: 'Right', count: '3', op: 'cut', bodies: ['Body 1'], about2: 'Y axis' }));
      expect(fields).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((fields as { error: { message: string } }).error.message).toBe(
        'bad_input: count and spacing: "" for a mirror; about2, count2 and spacing2: only a linear pattern has a second direction; send ""; op: copies of faces go onto their own body (a boss joins, a pocket cuts): send op source.',
      );
      const newBodies = await h.call('pattern', PATTERN({ of: 'bodies', items: ['Body 1'], about: 'X axis', count: '2', spacing: '100 mm', op: 'new', bodies: ['Body 1'] }));
      expect(newBodies).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      const axis = await h.call('pattern', PATTERN({ items: ['Hole'], about: 'Top', count: '2', spacing: '15 mm' }));
      expect(axis).toMatchObject({ ok: false, error: { detail: { reason: 'bad_selector', field: 'about' } } });
      expect(h.doc.state.get().doc).toBe(before);
      // A copy joined to the body it came from but 100 mm away: CAD's own words, nothing kept.
      const miss = await h.call('pattern', PATTERN({ of: 'bodies', items: ['Body 1'], about: 'X axis', count: '2', spacing: '100 mm', op: 'join' }));
      expect(miss).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Linear pattern 1', message: expect.stringContaining('Linear pattern 1') } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
    },
    REAL_KERNEL_MS,
  );
});

describe('combine', () => {
  it(
    'joins the copies of a pattern by "bodies of", noting the separate pieces (not a warning) and saying the body has more solids',
    async () => {
      h = await assistantHarness();
      await plate(h);
      await h.ok('pattern', PATTERN({ of: 'bodies', items: ['Body 1'], about: 'X axis', count: '3', spacing: '70 mm', op: 'new' }));
      expect(bodies(h).map((b) => b.name)).toEqual(['Body 1', 'Body 1 (Instance 2)', 'Body 1 (Instance 3)']);
      const r = await h.ok('combine', COMBINE({ targets: ['Body 1'], tools: ['bodies of Linear pattern 1'] }));
      expect(r.data).toMatchObject({
        feature: { name: 'Combine 1', type: 'combine', state: 'ok', message: null, note: "Body 1 holds 3 separate pieces: they don't touch, so they stay apart in one body (fine for a group like an inlay; to fuse pieces, they must overlap)" },
        targets: ['Body 1'],
        tools: ['Body 1 (Instance 2)', 'Body 1 (Instance 3)'],
        bodies: { removed: ['Body 1 (Instance 2)', 'Body 1 (Instance 3)'], changed: [{ body: 'Body 1', volume_mm3: [14400, 43200], solids: [1, 3] }] },
        warnings: expect.arrayContaining([expect.stringContaining('Body 1 now has 3 solids (it had 1)')]),
        resolved: { tools: expect.stringContaining('bodies of Linear pattern 1 -> 2 bodies') },
      });
      expect(r.text).toBe('Combine 1 ok: joined Body 1 (Instance 2) and Body 1 (Instance 3) to Body 1 · Body 1 14400 → 43200 mm³');
      expect(bodies(h)).toEqual([{ name: 'Body 1', volume: expect.any(Number), solids: 3 }]);
      // get_model says the note as the tree's info mark does.
      const read = await h.ok('get_model', { detail: 'brief', feature: 'Combine 1' });
      expect(read.data.feature).toMatchObject({ state: 'ok', note: expect.stringMatching(/^Body 1 holds 3 separate pieces: /) });
      expect(read.data.feature).not.toHaveProperty('message');
      expect(read.text).toMatch(/^Combine 1 \(combine\): ok · note: Body 1 holds 3 separate pieces: /);
    },
    REAL_KERNEL_MS,
  );

  it(
    'cuts a tool away, keeps it when an edit asks, and refuses tools that are only the targets',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const sk = await sketchOn(h, 'Block sketch', 'origin:top', new Shapes().rect('k', 20, -5, 40, 5));
      await extrude(h, 'Block', regions(h, sk), { distance: '3 mm' });
      const before = h.doc.state.get().doc;
      const none = await h.call('combine', COMBINE({ op: 'cut', targets: ['Body 1', 'Body 2'], tools: ['all bodies'] }));
      expect(none).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input', field: 'tools' } } });
      expect((none as { error: { message: string } }).error.message).toBe('bad_input: tools: nothing is left once the targets (Body 1 and Body 2) are taken out: name another body.');
      const unknown = await h.call('combine', COMBINE({ op: 'cut', targets: ['Body 9'], tools: ['Body 2'] }));
      expect(unknown).toMatchObject({ ok: false, error: { detail: { reason: 'bad_selector', field: 'targets[0]' } } });
      expect(h.doc.state.get().doc).toBe(before);
      // "all bodies" less the target: Body 2, which goes; the overlap (10 x 10 x 3) leaves Body 1.
      const cut = await h.ok('combine', COMBINE({ op: 'cut', targets: ['Body 1'], tools: ['all bodies'] }));
      expect(cut.data).toMatchObject({ tools: ['Body 2'], bodies: { removed: ['Body 2'] }, keep_tools: false });
      expect(volumeOf(h)).toBeCloseTo(14400 - 300, 3);
      // Its inputs sent back with keep_tools: Body 2 stays.
      const full = await h.ok('get_model', { detail: 'full', feature: 'Combine 1' });
      const f = full.data.feature as Record<string, unknown>;
      expect(f).toMatchObject({ by: 'assistant', inputs: { edit: 'Combine 1', name: '', op: 'cut', targets: ['Body 1'], tools: ['Body 2'], keep_tools: false } });
      const kept = await h.ok('combine', { ...(f.inputs as Record<string, unknown>), keep_tools: true });
      expect(kept.text).toMatch(/^Combine 1 ok \(replaced\): cut Body 2 from Body 1/);
      expect(bodies(h).map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
      expect(volumeOf(h)).toBeCloseTo(14400 - 300, 3);
      expect(volumeOf(h, 'Body 2')).toBeCloseTo(600, 3);
      // Bodies by the handles find gave in this request.
      const rows = (await h.ok('find', { query: 'bodies', limit: 10 })).data.rows as { handle: string; body: string }[];
      const handle = (name: string) => rows.find((r) => r.body === name)!.handle;
      const joined = await h.ok('combine', COMBINE({ targets: [handle('Body 1')], tools: [handle('Body 2')] }));
      expect(joined.data).toMatchObject({ feature: { name: 'Combine 2', state: 'ok' }, targets: ['Body 1'], tools: ['Body 2'], bodies: { removed: ['Body 2'] } });
      expect(bodies(h).map((b) => b.name)).toEqual(['Body 1']);
    },
    REAL_KERNEL_MS,
  );
});
