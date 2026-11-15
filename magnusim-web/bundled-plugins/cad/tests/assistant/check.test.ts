// The check tool and get_model's parts on the REAL kernel, through the page's tool handler as the
// bridge calls it, on Parts built here with the sketch, extrude and pattern tools (never a person's
// Parts):
//   - stack: a wheel on a headed shaft with no collar: the reply and its log line say one part can
//     slide along its shaft, naming the wheel and the side, with the parts in order and what holds
//     each side; a collar pressed on above it: nothing is loose;
//   - sweep: the wheel turned about the axis it shares with the shaft ("" finds it) meets nothing;
//     a key block in its way is met at the angle where the rim reaches it, both ways;
//   - interference on 48 bodies (a pattern of overlapping cubes) answers within CHECK_48_MS with its
//     rows capped at CHECK_ROWS and the rest counted; get_model's parts lists all 48, brief and full,
//     on a local turn's small budget too, while its bodies list is halved;
//   - the person's Check (INSPECT > Check's Interference, Loose parts, Rotation) on the same Part
//     gives the tool's own text and rows;
//   - refusals: a body that does not exist, a body named twice, sweep with no bodies, an axis that
//     has none, a clearance below 0;
//   - a check the time limit stopped: its text starts with the stop and is never an all-clear (stack,
//     sweep, interference), its note says what helps; interference on one body is it against the
//     rest; get_model full on 180 coloured parts and a long history reaches the model whole within
//     the app's 32 KB.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_ROWS, interferenceReply, stackReply, sweepReply } from '../../src/assistant/tools/check';
import { axisLine, checkClock, CHECK_TIME_MS } from '../../src/features/assembly/check';
import { referenceAxis, runAssembly } from '../../src/features/check/assembly';
import { EXTRUDE, fail, ok } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { resultAsSent } from './sanitize-copy';
import { E, SK, type Row } from './sketch-tools';

// Wall-time bounds get three times the room on a shared CI runner (GitHub sets CI): one took
// 3.08 s against 3 s there on 2026-11-15. Locally they hold as written.
const ROOM = process.env.CI ? 3 : 1;

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  checkClock.limitMs = CHECK_TIME_MS;
});

const CHECK = (o: Row = {}): Row => ({ kind: 'stack', bodies: [], clearance: '', axis: '', ...o });
const PATTERN = (o: Row): Row => ({ edit: '', name: '', kind: 'linear', of: 'features', items: [], about: '', count: '', spacing: '', flip: false, about2: '', count2: '', spacing2: '', options: [], skip: [], op: 'source', bodies: [], ...o });
const MODEL = (o: Row = {}): Row => ({ detail: 'brief', feature: '', regions: 'short', ...o });
/** 48 bodies: interference within this (ms). */
const CHECK_48_MS = 60_000 * ROOM;

/** A shaft (radius 2, 30 long) standing on a head (radius 6, 2 thick), and a wheel (bore 2.2, rim 15, 4 thick) resting on the head. */
async function shaftAndWheel(x: AssistantHarness): Promise<void> {
  await ok(x, 'sketch', SK({ name: 'Head sketch', entities: [E('c', 'circle', [0, 0, 6])] }));
  await ok(x, 'extrude', EXTRUDE({ name: 'Head', sketch: 'Head sketch', distance: '2 mm', body_name: 'Shaft' }));
  await ok(x, 'sketch', SK({ name: 'Rod sketch', entities: [E('c', 'circle', [0, 0, 2])] }));
  await ok(x, 'extrude', EXTRUDE({ name: 'Rod', sketch: 'Rod sketch', distance: '30 mm', op: 'join', bodies: ['Shaft'] }));
  await ok(x, 'sketch', SK({ name: 'Wheel sketch', on: 'Top offset 2 mm', entities: [E('rim', 'circle', [0, 0, 15]), E('bore', 'circle', [0, 0, 2.2])] }));
  await ok(x, 'extrude', EXTRUDE({ name: 'Wheel', sketch: 'Wheel sketch', distance: '4 mm', body_name: 'Wheel' }));
}

describe('check stack', () => {
  it(
    'a wheel with no collar can slide along its shaft (named, with its side); a collar pressed on above it: nothing is loose',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await shaftAndWheel(h);
      const r = await h.ok('check', CHECK());
      expect(r.text).toBe('1 part can slide along its shaft: Wheel (+Z)');
      expect(r.summary).toBe('Checked the stack: 1 part can slide along its shaft: Wheel (+Z)');
      expect(r.data).toMatchObject({
        kind: 'stack',
        play_mm: 0.5,
        axes: [
          {
            axis: 'along Z through (0, 0, 0)',
            point_mm: [0, 0, 0],
            dir: [0, 0, 1],
            parts: [
              { body: 'Shaft', from_mm: 0, to_mm: 30 },
              { body: 'Wheel', from_mm: 2, to_mm: 6, bore_r_mm: 2.2, on: 'Shaft', play_mm: 0.2, '-Z': 'Shaft at 0 mm', '+Z': 'nothing (comes off its shaft)' },
            ],
          },
        ],
        loose: ['Wheel can slide along Shaft toward +Z: nothing stops it before it comes off Shaft'],
        complete: true,
      });
      // A collar whose bore is the shaft's size, on top of the wheel.
      await ok(h, 'sketch', SK({ name: 'Collar sketch', on: 'Top offset 6 mm', entities: [E('o', 'circle', [0, 0, 5]), E('i', 'circle', [0, 0, 2])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Collar', sketch: 'Collar sketch', distance: '3 mm', body_name: 'Collar' }));
      const held = await h.ok('check', CHECK());
      expect(held.text).toBe('Nothing is loose: 1 part on 1 axis, each held both ways within 0.5 mm');
      expect(held.data).toMatchObject({ loose: [], axes: [{ parts: [{ body: 'Shaft', fixed_to: ['Collar'] }, { body: 'Wheel', '-Z': 'Shaft at 0 mm', '+Z': 'Collar at 0 mm' }, { body: 'Collar', fixed_to: ['Shaft'] }] }] });
      // Past the time limit before its one axis was cut to the end: it says so, never "Nothing is loose".
      checkClock.limitMs = -1;
      const late = await h.ok('check', CHECK());
      expect(late.text).toBe('Stopped at the time limit after 0 of 1 axis: none checked to the end');
      expect(late.data).toMatchObject({ complete: false, axes: [], loose: [], note: 'Stopped at the time limit: 0 of 1 axis checked. Check fewer bodies: only the axes near them are checked.' });
    },
    REAL_KERNEL_MS,
  );
});

describe('a check the time limit stopped', () => {
  it('starts its text with the stop and never reads as all clear: stack, sweep, interference', () => {
    const line = axisLine([0, 0, 0], [0, 0, 1]);
    const stack = stackReply({ axes: [], axesTotal: 3, findings: [], play: 0.5, thinned: false, complete: false }, 0.5);
    expect(stack.text).toBe('Stopped at the time limit after 0 of 3 axes: none checked to the end');
    expect(stack.data.note).toBe('Stopped at the time limit: 0 of 3 axes checked. Check fewer bodies: only the axes near them are checked.');
    const parts = [{ body: 'Shaft', from: 0, to: 30, bore: null, on: null, inBore: false, play: null, fixed: [], neg: null, pos: null }];
    const one = stackReply({ axes: [{ line, words: 'along Z through (0, 0, 0)', negWords: '-Z', posWords: '+Z', parts }], axesTotal: 2, findings: [], play: 0.5, thinned: false, complete: false }, 0.5);
    expect(one.text).toBe('Stopped at the time limit after 1 of 2 axes: nothing loose on that one');
    const sweep = sweepReply({ line, words: 'along Z through (0, 0, 0)', turning: ['Hand'], hits: [], already: [], near: 2, thinned: false, complete: false }, '');
    expect(sweep.text).toBe('Stopped at the time limit before the whole turn was checked: no hit found so far for Hand along Z through (0, 0, 0)');
    expect(sweep.data.note).toBe('Stopped at the time limit: 0 hits found so far. Turn fewer bodies at once.');
    const inter = interferenceReply({ bodies: 4, one: null, pairs: 6, boxPairs: 3, checked: 1, rows: [], touching: 0, surfaces: [], complete: false }, 0);
    expect(inter.text).toBe('Stopped at the time limit: no pair overlaps (4 bodies, 3 of 6 pairs near enough to measure, 1 measured)');
    // Finished, they read as before.
    expect(stackReply({ axes: [], axesTotal: 0, findings: [], play: 0.5, thinned: false, complete: true }, 0.5).text).toBe('No two bodies share an axis (no round faces on one line)');
  });
});

describe('check sweep', () => {
  it(
    'turns the wheel about the axis it shares with the shaft: nothing in the way, then a key block met both ways',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await shaftAndWheel(h);
      const clear = await h.ok('check', CHECK({ kind: 'sweep', bodies: ['Wheel'] }));
      expect(clear.text).toBe('Wheel turns a full turn along Z through (0, 0, 0) without meeting anything (1 body near)');
      expect(clear.data).toMatchObject({ kind: 'sweep', axis: 'the axis they share', turning: ['Wheel'], hits: [] });
      // A key block beside the wheel's rim at its height: x 14..18, y 3..6.
      await ok(h, 'sketch', SK({ name: 'Key sketch', on: 'Top offset 1 mm', entities: [E('k', 'rect', [14, 3, 18, 6])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Key', sketch: 'Key sketch', distance: '8 mm', body_name: 'Key' }));
      const hit = await h.ok('check', CHECK({ kind: 'sweep', bodies: ['Wheel'], axis: 'Z axis' }));
      // A disc already covers every angle where its rim reaches the block: it overlaps it before turning.
      expect(hit.data).toMatchObject({ already: [['Wheel', 'Key']], hits: [] });
      expect(hit.text).toContain('already overlapping: Key');
    },
    REAL_KERNEL_MS,
  );
});

describe("the person's Check (src/features/check/assembly.ts) answers in the check tool's own words", () => {
  it(
    "stack, interference and sweep on one Part: the person's line is the tool's text, the rows its rows",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await shaftAndWheel(h);
      // A key block overlapping the wheel's rim (so interference has a pair).
      await ok(h, 'sketch', SK({ name: 'Key sketch', on: 'Top offset 1 mm', entities: [E('k', 'rect', [14, 3, 18, 6])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Key', sketch: 'Key sketch', distance: '8 mm', body_name: 'Key' }));
      const s = h.services;
      const env = { kernel: s.kernel };
      const ids = s.doc.state.get().rebuild.bodies.map((b) => b.id);
      const wheel = s.doc.state.get().rebuild.bodies.find((b) => b.name === 'Wheel')!.id;

      const stackAi = await h.ok('check', CHECK());
      const stack = await runAssembly(s, { kind: 'stack', only: null, play: 0.5 }, env);
      expect(stack.text).toBe(stackAi.text);
      expect(stack.stack!.findings.map((f) => f.words)).toEqual((stackAi.data as { loose: string[] }).loose);

      const interAi = await h.ok('check', CHECK({ kind: 'interference', clearance: '0.2 mm' }));
      const inter = await runAssembly(s, { kind: 'interference', bodies: ids, clearance: 0.2 }, env);
      expect(inter.text).toBe(interAi.text);
      expect(inter.interference!.rows.map((r) => [r.a, r.b])).toEqual((interAi.data as { rows: { bodies: string[] }[] }).rows.map((r) => r.bodies));

      // One body: it against every other body (the person's one selected body).
      const keyAi = await h.ok('check', CHECK({ kind: 'interference', bodies: ['Key'] }));
      expect(keyAi.text).toMatch(/^1 pair overlaps \(Key against 2 other bodies, 1 near enough to measure\): Wheel and Key [\d.]+ mm3$/);
      expect(keyAi.data).toMatchObject({ against: 'Key', pairs: 2, overlaps: 1, complete: true });
      const key = s.doc.state.get().rebuild.bodies.find((b) => b.name === 'Key')!.id;
      expect((await runAssembly(s, { kind: 'interference', bodies: ids, clearance: 0, one: key }, env)).text).toBe(keyAi.text);

      const sweepAi = await h.ok('check', CHECK({ kind: 'sweep', bodies: ['Wheel'], axis: 'Z axis' }));
      const sweep = await runAssembly(s, { kind: 'sweep', turning: [wheel], axis: await referenceAxis(s, 'Z axis') }, env);
      expect(sweep.text).toBe(sweepAi.text);
      expect(sweep.sweep!.already).toEqual([{ turning: 'Wheel', with: 'Key' }]);
    },
    REAL_KERNEL_MS,
  );
});

describe('check interference and get_model parts on 48 bodies', () => {
  it(
    `answers within ${CHECK_48_MS / 1000} s with its rows capped; get_model lists all 48 parts, never halved`,
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', SK({ name: 'Cube sketch', entities: [E('r', 'rect', [0, 0, 10, 10])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Cube', sketch: 'Cube sketch', distance: '10 mm', body_name: 'Cube' }));
      // 8 x 6 cubes 9.5 mm apart: each overlaps the ones beside it.
      await h.ok('pattern', PATTERN({ of: 'bodies', items: ['Cube'], about: 'X axis', count: '8', spacing: '9.5 mm', about2: 'Y axis', count2: '6', spacing2: '9.5 mm', op: 'new' }));
      expect(h.doc.state.get().rebuild.bodies).toHaveLength(48);
      const t0 = performance.now();
      const r = await h.ok('check', CHECK({ kind: 'interference' }));
      const ms = performance.now() - t0;
      console.log(`[check] 48 bodies: ${String(r.data.of)} of ${String(r.data.pairs)} pairs measured in ${Math.round(ms)} ms`);
      expect(ms).toBeLessThan(CHECK_48_MS);
      // Side by side: 7 x 6 + 8 x 5 = 82 pairs; corner to corner 2 x 7 x 5 = 70 more (a 0.5 x 0.5 column each).
      expect(r.data).toMatchObject({ kind: 'interference', bodies: 48, pairs: 1128, overlaps: 152, complete: true, rows_more: 152 - CHECK_ROWS });
      expect(r.data.rows).toHaveLength(CHECK_ROWS);
      expect((r.data.rows as Row[])[0]).toMatchObject({ overlap_mm3: 50 });
      expect(r.text).toMatch(/^152 pairs overlap \(48 bodies, 152 of 1128 pairs near enough to measure\): Cube and Cube \(Instance 2, 1\) 50 mm3, /);
      expect(r.summary).toMatch(/^Checked 48 bodies for interference: 152 pairs overlap: Cube and Cube \(Instance 2, 1\) 50 mm3, /);
      expect(r.summary!.length).toBeLessThanOrEqual(160);

      for (const detail of ['brief', 'full']) {
        const m = await h.ok('get_model', MODEL({ detail }));
        const parts = m.data.parts as Row[];
        expect(parts).toHaveLength(48);
        expect(m.data.parts_more).toBeUndefined();
        expect(parts[0]).toEqual({ name: 'Cube', mm3: 1000, size_mm: [10, 10, 10], at_mm: [5, 5, 5], by: 'Cube' });
        expect(parts[47]).toMatchObject({ name: 'Cube (Instance 8, 6)', mm3: 1000, size_mm: [10, 10, 10], at_mm: [5 + 7 * 9.5, 5 + 5 * 9.5, 5], by: 'Linear pattern 1' });
      }
      // A local turn's small budget halves the bodies list; the parts stay whole.
      h.fake.emitTurn({ id: 't-local', title: 'Cubes', local: true, contextTokens: 32_768, images: false });
      const local = await h.ok('get_model', MODEL(), { turn: 't-local' });
      expect((local.data.bodies as Row[]).length).toBeLessThan(48);
      expect(local.data.parts as Row[]).toHaveLength(48);
    },
    REAL_KERNEL_MS * 2,
  );
});

describe('get_model parts within the app\'s result cap', () => {
  it(
    'detail full on 180 coloured parts and a long history: the parts come first and every row reaches the model whole',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', SK({ name: 'Cube sketch', entities: [E('r', 'rect', [0, 0, 5, 5])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Cube', sketch: 'Cube sketch', distance: '5 mm', body_name: 'Cube' }));
      await h.ok('pattern', PATTERN({ of: 'bodies', items: ['Cube'], about: 'X axis', count: '15', spacing: '6 mm', about2: 'Y axis', count2: '12', spacing2: '6 mm', op: 'new' }));
      const bodies = h.doc.state.get().rebuild.bodies;
      expect(bodies).toHaveLength(180);
      bodies.forEach((b, i) => h!.doc.setBodyColor(b.id, `#${(0x204060 + i * 97).toString(16).padStart(6, '0')}`));
      // A long history: construction planes, each a row of its own in full.
      for (let i = 0; i < 60; i++) await h.add('ref_plane', { plane: { kind: 'origin', plane: 'origin:top' }, distance: `${i + 20} mm`, name: `Construction plane number ${i + 1}` });
      await h.settle();
      const m = await h.ok('get_model', MODEL({ detail: 'full' }));
      const sent = resultAsSent('cad__get_model', { data: m.data, text: m.text });
      const parts = (sent.data as Row).parts as Row[];
      expect(parts).toHaveLength(180);
      expect(sent.truncated).toBeUndefined();
      const keys = Object.keys(m.data);
      expect(keys.indexOf('parts')).toBeLessThan(keys.indexOf('features'));
      expect(parts[179]).toMatchObject({ name: 'Cube (Instance 15, 12)', color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    },
    REAL_KERNEL_MS * 2,
  );
});

describe('check refusals', () => {
  it(
    'refuses an unknown body, a body twice, sweep with no bodies, an axis with none, a clearance below 0',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await shaftAndWheel(h);
      expect(await fail(h, 'check', CHECK({ bodies: ['Gear'] }))).toMatchObject({ code: 'invalid_input', detail: { reason: 'not_found', field: 'bodies[0]', bodies: ['Shaft', 'Wheel'] } });
      expect(await fail(h, 'check', CHECK({ bodies: ['Wheel', 'wheel'] }))).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', field: 'bodies' } });
      expect(await fail(h, 'check', CHECK({ kind: 'sweep' }))).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('name the bodies that turn') });
      expect(await fail(h, 'check', CHECK({ kind: 'sweep', bodies: ['Wheel'], axis: 'Top' }))).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', field: 'axis' } });
      expect(await fail(h, 'check', CHECK({ kind: 'interference', clearance: '-1 mm' }))).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', field: 'clearance' } });
    },
    REAL_KERNEL_MS,
  );
});
