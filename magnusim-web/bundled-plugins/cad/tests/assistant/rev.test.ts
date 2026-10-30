// @vitest-environment node
// What the person changed between the Assistant's calls, in words (rev.ts describeChanges): added,
// deleted, renamed, suppressed, changed and reordered features; parameters added, renamed, set and
// deleted; bodies renamed, recoloured, left out of the simulation. The tracker's baselines
// (createRevTracker): per conversation when the host names one, so a request's first call tells
// what the person did between two messages (and their undo of an earlier request's steps), else
// per request. And a sketch's regions as the
// tools name them (sketch/regions.ts): r1... by area, then by their inside point; a region in a
// hole of another is one deeper.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createRevTracker, describeChanges } from '../../src/assistant/rev';
import { regionRows } from '../../src/assistant/sketch/regions';
import { createBus } from '../../src/lib/bus';
import type { CadDoc, Feature } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import type { KernelRegion } from '../../src/types/kernel-protocol';

const f = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, type: 'extrude', name, distance: '5 mm', ...over }) as unknown as Feature;
const docOf = (features: Feature[], params: CadDoc['params'] = [], bodies: CadDoc['bodies'] = {}): CadDoc =>
  ({ schema: 2, units: { length: 'mm', angle: 'deg' }, params, bodies, features, meta: { created_at: '', written_by: '' } }) as CadDoc;

describe('describeChanges', () => {
  it('names each change once, in words', () => {
    const a = docOf([f('f_1', 'Extrude 1'), f('f_2', 'Extrude 2'), f('f_3', 'Extrude 3')], [{ id: 'p_1', name: 'w', expr: '40 mm', quantity: 'length' }, { id: 'p_2', name: 't', expr: '5 mm', quantity: 'length' }], {
      b_1: { name: 'Body 1', color: '#9aa4b2' },
    });
    const b = docOf(
      [f('f_3', 'Boss', { suppressed: true }), f('f_1', 'Extrude 1', { distance: '8 mm' }), f('f_4', 'Pocket', { type: 'sketch' })],
      [{ id: 'p_1', name: 'width', expr: '50 mm', quantity: 'length' }, { id: 'p_3', name: 'n', expr: '6', quantity: 'scalar' }],
      { b_1: { name: 'Plate', color: '#ff0000', simulation: false } },
    );
    expect(describeChanges(a, b)).toEqual([
      'renamed Extrude 3 to Boss',
      'suppressed Boss',
      'changed Extrude 1',
      'added Pocket (sketch)',
      'deleted Extrude 2',
      'reordered the history (Boss, Extrude 1)',
      'renamed parameter w to width',
      'set parameter width to 50 mm (was 40 mm)',
      'added parameter n = 6',
      'deleted parameter t',
      'renamed body Body 1 to Plate',
      'set the colour of Plate to #ff0000',
      'left Plate out of the simulation',
    ]);
    expect(describeChanges(a, a)).toEqual([]);
    // Magnusim CAD (projectLinks false: no simulation): nothing of a body's simulation setting.
    expect(describeChanges(a, b, false)).not.toContain('left Plate out of the simulation');
    expect(describeChanges(a, b, false).at(-1)).toBe('set the colour of Plate to #ff0000');
    expect(describeChanges(a, b, true)).toEqual(describeChanges(a, b));
  });
});

describe('createRevTracker', () => {
  /** A tracker on a committed model the test sets (as the person's commits do). */
  function tracker() {
    let committed = docOf([f('f_1', 'Extrude 1')]);
    const subs = new Set<() => void>();
    const doc = { committed: () => committed, state: { subscribe: (fn: () => void) => (subs.add(fn), () => void subs.delete(fn)) } } as unknown as DocService;
    const bus = createBus<CadEvents>();
    const t = createRevTracker({ doc, bus });
    const commit = (features: Feature[]) => {
      committed = docOf(features);
      for (const fn of subs) fn();
    };
    /** One call under `key`, start to answer to end, as call.ts runs it: its user_changes. */
    const call = (key: string, conversation?: string) => {
      t.begin(key, conversation);
      const out = t.changesFor(key);
      t.seen(key);
      return out;
    };
    return { t, bus, commit, call };
  }
  const E1 = f('f_1', 'Extrude 1');
  const S = f('f_2', 'Sample "S" Sketch', { type: 'sketch' });

  it("one baseline per conversation: a new request's first call tells what the person did since the chat's last call, and their undo of its steps", () => {
    const { bus, commit, call } = tracker();
    expect(call('turn:r1', 'c-1')).toEqual([]);
    // The person draws a sketch between two messages.
    commit([E1, S]);
    expect(call('turn:r2', 'c-1')).toEqual(['added Sample "S" Sketch (sketch)']);
    expect(call('turn:r2', 'c-1')).toEqual([]);
    // Between two messages the person undoes request 2's steps: request 3 is told.
    bus.emit('assistant:person-undo', { tag: 'turn:r2', label: 'Assistant: Draw an S', redo: false });
    commit([E1]);
    expect(call('turn:r3', 'c-1')).toEqual(['the person undid your steps (Assistant: Draw an S); do not redo them unless asked', 'deleted Sample "S" Sketch']);
    // Another chat starts at its own first call; the first chat still has its own baseline.
    commit([E1, S]);
    expect(call('turn:r4', 'c-2')).toEqual([]);
    expect(call('turn:r5', 'c-1')).toEqual(['added Sample "S" Sketch (sketch)']);
  });

  it('a host that names no conversation: each request starts at its own first call (what the person did between messages is not told)', () => {
    const { commit, call } = tracker();
    expect(call('turn:r1')).toEqual([]);
    commit([E1, S]);
    expect(call('turn:r2')).toEqual([]);
    // Within a request it is told as before.
    commit([E1]);
    expect(call('turn:r2')).toEqual(['deleted Sample "S" Sketch']);
  });
});

const region = (key: string, area: number, sample: [number, number], loops: string[][]): KernelRegion => ({ key, loops, entities: ['e_1'], area, sample, bbox: [0, 0, 1, 1] });

describe('regionRows', () => {
  it('numbers by area then by the inside point, and finds what lies in a hole', () => {
    // A plate (outer loop A, a hole loop B), the disc filling the hole (outer loop B), and a separate square.
    const plate = region('k-plate', 5000, [5, 5], [['+a1', '+a2'], ['-b1', '-b2']]);
    const disc = region('k-disc', 300, [50, 30], [['+b2', '+b1']]);
    const square = region('k-sq', 300, [10, 90], [['+c1']]);
    const rows = regionRows({ regions: [disc, square, plate] as never });
    expect(rows.map((r) => [r.id, r.key, r.depth, r.holes])).toEqual([
      ['r1', 'k-plate', 0, 1],
      ['r2', 'k-sq', 0, 0],
      ['r3', 'k-disc', 1, 0],
    ]);
    expect(rows[0]).toMatchObject({ area_mm2: 5000, at: [5, 5], bbox_uv: [[0, 0], [1, 1]] });
  });
});
