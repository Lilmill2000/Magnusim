// The honest outcome of an edit call (CAD tools spec §7.4, §7.5, §12.1 judge.test.ts):
//   - on the REAL kernel: a set_params that turns a working fillet red changes nothing
//     (broke_downstream naming it, the model and the undo history as before, no ledger entry); an
//     edit_feature value that makes the feature itself fail is feature_failed with its own message
//     and actions, and its panel is gone; a structural edit (suppressing the plate) that turns the
//     fillet red is kept and lists it in broke, get_model marks it broken_by_you, and the next edit
//     that fixes it says so;
//   - verdict() and report() on states made by hand: a failed rebuild and a kernel stop are
//     kernel_failed; warnings for the own feature, a repaired reference and more solids; bodies
//     created, changed (only the bounding-box sides that moved) and removed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { report, verdict, type FeatureSnap, type StateSnap } from '../../src/assistant/judge';
import { runtimeOf } from '../../src/assistant/runtime';
import type { CadDoc } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { fillet, plate, stateOf, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const EDIT = (feature: string, o: Record<string, unknown> = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

describe('on the real kernel', () => {
  it(
    'a set_params that turns a working fillet red changes nothing and names it',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      h.doc.addParam({ name: 'r', expr: '2 mm', quantity: 'length' });
      const fl = await fillet(h, p, 'r');
      expect(stateOf(h, fl)).toBe('ok');
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const r = await h.call('set_params', { set: [{ name: 'r', kind: 'length', expr: '10 mm', comment: '', rename_to: '' }], remove: [] });
      expect(r).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'broke_downstream', broke: [{ feature: 'Fillet 1', message: expect.stringContaining('Fillet 1') }] } } });
      expect((r as { error: { message: string } }).error.message).toMatch(/^broke_downstream: Nothing changed: after it Fillet 1 would fail \(/);
      // Back exactly: the model, the history, the fillet working; nothing in the ledger.
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
      await h.settle();
      expect(stateOf(h, fl)).toBe('ok');
      expect(runtimeOf(h.services)!.ledger.entries('turn:t-test')).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    "an edit_feature value that makes the feature fail is feature_failed with its own words; its panel is gone",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const fl = await fillet(h, p, '2 mm');
      const before = h.doc.state.get().doc;
      const r = await h.call('edit_feature', EDIT('Fillet 1', { set: [{ field: 'radius', value: '10 mm' }] }));
      expect(r).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Fillet 1', message: expect.stringContaining('Fillet 1 failed'), actions: expect.any(Array) } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.session()).toBeNull();
      await h.settle();
      expect(stateOf(h, fl)).toBe('ok');
    },
    REAL_KERNEL_MS,
  );

  it(
    'a structural edit that turns the fillet red is kept, lists it in broke, and get_model marks it; fixing it says fixed',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const fl = await fillet(h, p, '2 mm');
      const r = await h.ok('edit_feature', EDIT('Extrude 1', { suppress: 'suppress' }));
      expect(r.data).toMatchObject({ broke: [{ feature: 'Fillet 1', message: expect.any(String) }], fixed: [], bodies: { created: [], changed: [], removed: ['Body 1'] } });
      expect(r.text).toBe('Edit Extrude 1 suppressed: suppressed · Body 1 removed · 1 feature broke');
      expect(stateOf(h, fl)).toBe('error');
      const model = await h.ok('get_model', { detail: 'brief', feature: '' });
      const row = (model.data.features as Record<string, unknown>[]).find((f) => f.name === 'Fillet 1');
      expect(row).toMatchObject({ state: 'error', broken_by_you: true });
      const back = await h.ok('edit_feature', EDIT('Extrude 1', { suppress: 'unsuppress' }));
      expect(back.data).toMatchObject({ broke: [], fixed: ['Fillet 1'] });
      const again = await h.ok('get_model', { detail: 'brief', feature: '' });
      expect((again.data.features as Record<string, unknown>[]).find((f) => f.name === 'Fillet 1')).not.toHaveProperty('broken_by_you');
    },
    REAL_KERNEL_MS,
  );
});

const feature = (name: string, state: string, o: Partial<FeatureSnap> = {}): FeatureSnap => ({ name, type: 'extrude', state, message: null, actions: [], ...o });
const snap = (features: [string, FeatureSnap][], bodies: [string, { name: string; volume: number | null; bbox: number[]; solids: number | null }][] = [], message: string | null = null): StateSnap => ({
  doc: {} as CadDoc,
  features: new Map(features),
  bodies: new Map(bodies),
  message,
});

describe('verdict and report', () => {
  it('a failed rebuild, and a kernel stop of a feature, are kernel_failed', () => {
    const before = snap([['a', feature('A', 'ok')]]);
    expect(verdict(before, snap([['a', feature('A', 'ok')]], [], 'The geometry kernel stopped'), { value: false }).error).toMatchObject({ reason: 'kernel_failed', code: 'failed' });
    const stopped = snap([['a', feature('A', 'error', { message: 'Stopped after 20 s', actions: ['retry'] })]]);
    expect(verdict(before, stopped, { value: false }).error).toMatchObject({ reason: 'kernel_failed' });
    expect(verdict(before, stopped, { value: true, own: 'a' }).error).toMatchObject({ reason: 'kernel_failed' });
  });

  it("the own feature's failure, a value edit's broken features, and a structural edit's kept list", () => {
    const before = snap([
      ['a', feature('A', 'ok')],
      ['b', feature('B', 'warning', { message: 'Reference repaired' })],
      ['c', feature('C', 'error', { message: 'old' })],
    ]);
    const after = snap([
      ['a', feature('A', 'error', { message: 'A failed: too big', actions: ['repair'] })],
      ['b', feature('B', 'error', { message: 'B failed' })],
      ['c', feature('C', 'ok')],
    ]);
    expect(verdict(before, after, { value: true, own: 'a' }).error).toMatchObject({ reason: 'feature_failed', detail: { feature: 'A', message: 'A failed: too big', actions: ['repair'] } });
    const value = verdict(before, after, { value: true });
    expect(value.error).toMatchObject({ reason: 'broke_downstream', message: 'broke_downstream: Nothing changed: after it A and B would fail (A failed: too big).', detail: { broke: [{ feature: 'A', message: 'A failed: too big' }, { feature: 'B', message: 'B failed' }] } });
    const kept = verdict(before, after, { value: false });
    expect(kept).toEqual({ error: null, broke: [{ feature: 'A', message: 'A failed: too big' }, { feature: 'B', message: 'B failed' }], fixed: ['C'], warnings: [] });
  });

  it('warns of the own feature, a feature newly warning, and a body with more solids', () => {
    const box = [0, 0, 0, 10, 10, 10];
    const before = snap([['a', feature('A', 'ok')], ['b', feature('B', 'ok')]], [['b1', { name: 'Body 1', volume: 1000, bbox: box, solids: 1 }]]);
    const after = snap(
      [
        ['a', feature('A', 'warning', { message: 'Check the result' })],
        ['b', feature('B', 'warning', { message: 'Reference repaired · check' })],
      ],
      [['b1', { name: 'Body 1', volume: 1200, bbox: [0, 0, 0, 10, 10, 12], solids: 2 }]],
    );
    const v = verdict(before, after, { value: false, own: 'a' });
    expect(v).toEqual({
      error: null,
      broke: [],
      fixed: [],
      warnings: ['A: Check the result', 'B: Reference repaired · check', 'Body 1 now has 2 solids (it had 1): pieces that do not touch stay separate'],
    });
  });

  it('reports bodies created, changed (the sides that moved) and removed, and the feature', () => {
    const before = snap(
      [['a', feature('A', 'ok')]],
      [
        ['b1', { name: 'Plate', volume: 14400, bbox: [-30, -20, 0, 30, 20, 6], solids: 1 }],
        ['b2', { name: 'Gone', volume: 10, bbox: [0, 0, 0, 1, 1, 10], solids: 1 }],
        ['b3', { name: 'Same', volume: 5, bbox: [0, 0, 0, 1, 1, 5], solids: 1 }],
      ],
    );
    const after = snap(
      [['a', feature('A', 'ok', { name: 'Boss' })]],
      [
        ['b1', { name: 'Plate', volume: 16812.7385, bbox: [-30, -20, 0, 30, 20, 18], solids: 1 }],
        ['b3', { name: 'Same', volume: 5, bbox: [0, 0, 0, 1, 1, 5], solids: 1 }],
        ['b4', { name: 'Body 2', volume: 8000, bbox: [0, 0, 0, 20, 20, 20], solids: 1 }],
      ],
    );
    const v = verdict(before, after, { value: false });
    const data = report({ before, after, plan: { value: false, feature: 'a', resolved: { regions: 'all → r1' } }, verdict: v, step: 4, rev: 9 });
    expect(data).toEqual({
      rev: 9,
      step: 4,
      feature: { name: 'Boss', type: 'extrude', state: 'ok', message: null },
      resolved: { regions: 'all → r1' },
      bodies: {
        created: [{ body: 'Body 2', volume_mm3: 8000, bbox_mm: [[0, 0, 0], [20, 20, 20]], solids: 1 }],
        changed: [{ body: 'Plate', volume_mm3: [14400, 16812.7], bbox_max_z: [6, 18], solids: [1, 1] }],
        removed: ['Gone'],
      },
      created: [],
      warnings: [],
      broke: [],
      fixed: [],
    });
  });
});
