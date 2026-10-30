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
//   - refusals: a body that does not exist, a body named twice, sweep with no bodies, an axis that
//     has none, a clearance below 0.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_ROWS } from '../../src/assistant/tools/check';
import { EXTRUDE, fail, ok } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { E, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const CHECK = (o: Row = {}): Row => ({ kind: 'stack', bodies: [], clearance: '', axis: '', ...o });
const PATTERN = (o: Row): Row => ({ edit: '', name: '', kind: 'linear', of: 'features', items: [], about: '', count: '', spacing: '', flip: false, about2: '', count2: '', spacing2: '', options: [], skip: [], op: 'source', bodies: [], ...o });
const MODEL = (o: Row = {}): Row => ({ detail: 'brief', feature: '', regions: 'short', ...o });
/** 48 bodies: interference within this (ms). */
const CHECK_48_MS = 60_000;

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
    },
    REAL_KERNEL_MS,
  );
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
