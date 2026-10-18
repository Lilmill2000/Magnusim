// The delete tool on the REAL kernel, through the page's tool handler (CAD tools spec §3.2.17,
// §7.8, §12.1). The person's question comes from the app before a call reaches the page (the
// tool is destructive with its confirm note: schemas.test.ts, the honest e2e).
//   - features delete newest first, in any order given, as one step: one undo entry (one Undo
//     brings them back, Redo takes them again), the bodies they made removed, the call in the
//     ledger (the undo tool can take it back);
//   - refused with nothing changed while a feature not in the list uses one in it (in_use), naming
//     every user of every one, with the body it uses them through; a listed user is no refusal;
//   - a name not in the Part, a name given twice, an empty name: refused, every problem at once;
//   - a feature that fails afterwards is kept (a delete is structural) and listed in broke, and
//     get_model marks it broken_by_you;
//   - the deleted features leave the person's selection, and a body that went with them does not
//     come back into it after the call;
//   - races forced at hold points: the person adds a user of a listed feature, or deletes a listed
//     feature, while the call plans (in_use / changed, nothing deleted, theirs kept); a Stop after
//     the removals reverts synchronously.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HINTS } from '../../src/assistant/errors';
import { runtimeOf } from '../../src/assistant/runtime';
import { selectItem } from '../../src/lib/selection';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { extrude, fillet, plate, regions, Shapes, sketchOn, stateOf, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);
const bodies = (x: AssistantHarness) => x.doc.state.get().rebuild.bodies.map((b) => b.name);

describe('delete', () => {
  it(
    'deletes features newest first, in any order given, as one step that one Undo brings back',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      await fillet(h, p, '1 mm');
      h.fake.emitTurn({ id: 't-1', title: 'Clear the plate' });
      // The plate's extrude first: its fillet, listed after it, goes before it.
      const r = await h.ok('delete', { features: ['Extrude 1', 'fillet 1'] }, { turn: 't-1' });
      expect(names(h)).toEqual(['Sketch 1']);
      expect(bodies(h)).toEqual([]);
      expect(r.data).toMatchObject({
        deleted: ['Extrude 1', 'Fillet 1'],
        feature: null,
        resolved: { features: 'Extrude 1 (extrude), Fillet 1 (fillet)' },
        bodies: { created: [], changed: [], removed: ['Body 1'] },
        broke: [],
        step: 1,
      });
      expect(r.text).toBe('Deleted Extrude 1 and Fillet 1 · Body 1 removed');
      // One undo entry, named after the request; the call is the request's own (the undo tool can take it back).
      expect(undoLabel(h)).toBe('Assistant: Clear the plate');
      expect((await h.ok('get_model', { detail: 'brief', feature: '' }, { turn: 't-1' })).data.undo).toEqual({ label: 'Assistant: Clear the plate', your_steps: 1 });
      expect(runtimeOf(h.services)!.ledger.entries('turn:t-1').map((e) => e.part)).toEqual(['Delete Extrude 1 and Fillet 1']);
      // The person's one Undo brings both back, built; Redo takes them again.
      h.fake.emitTurn({ id: 't-1', title: 'Clear the plate', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Fillet 1']);
      await h.settle();
      expect(bodies(h)).toEqual(['Body 1']);
      expect(stateOf(h, p.extrude)).toBe('ok');
      h.doc.redo();
      expect(names(h)).toEqual(['Sketch 1']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'takes back with the undo tool, and names three or more as "and N more"',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      await fillet(h, p, '1 mm');
      const start = h.doc.state.get().doc;
      const r = await h.ok('delete', { features: ['Sketch 1', 'Extrude 1', 'Fillet 1'] });
      expect(names(h)).toEqual([]);
      expect(r.text).toBe('Deleted Sketch 1, Extrude 1 and Fillet 1 · Body 1 removed');
      const u = await h.ok('undo', { steps: 1, previous_turn: false });
      expect(u.data).toMatchObject({ undone: ['Delete Sketch 1 and 2 more'], left: 0 });
      expect(h.doc.state.get().doc).toBe(start);
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses, changing nothing, while a feature not in the list uses one in it: every user named',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      await fillet(h, p, '1 mm');
      // A second extrude of the same sketch: Sketch 1 is used by Extrude 1 and Extrude 2.
      await h.add('extrude', { profiles: [p.profile], extent: { kind: 'blind', distance: '3 mm' }, op: 'new' });
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      const r = await h.call('delete', { features: ['Sketch 1'] });
      expect(r).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_input',
          message:
            'in_use: Nothing was deleted: Sketch 1 is used by Extrude 1 and Extrude 2. Add those features to the list to delete them too, or change what they use first.',
          hint: HINTS.in_use,
          detail: {
            reason: 'in_use',
            users: [
              { feature: 'Extrude 1', uses: 'Sketch 1', via: null },
              { feature: 'Extrude 2', uses: 'Sketch 1', via: null },
            ],
            users_more: 0,
          },
        },
      });
      // Extrude 1 is listed now (no refusal for it), but Fillet 1 uses its body.
      const both = await h.call('delete', { features: ['Sketch 1', 'Extrude 1'] });
      expect(both).toMatchObject({
        ok: false,
        error: {
          message:
            'in_use: Nothing was deleted: Sketch 1 is used by Extrude 2; Extrude 1 is used by Fillet 1 (through Body 1). Add those features to the list to delete them too, or change what they use first.',
          detail: {
            users: [
              { feature: 'Extrude 2', uses: 'Sketch 1', via: null },
              { feature: 'Fillet 1', uses: 'Extrude 1', via: 'Body 1' },
            ],
          },
        },
      });
      // Nothing changed: the model, the undo history, the ledger.
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
      expect(runtimeOf(h.services)!.ledger.entries('turn:t-test')).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses a name not in the Part, a name given twice and an empty one, every problem at once',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const before = h.doc.state.get().doc;
      const missing = await h.call('delete', { features: ['Extrude 1', 'Nope', 'extrude 1', ''] });
      expect(missing).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'not_found: features[1]: no feature is called "Nope"; features[2]: Extrude 1 is named twice; features[3]: enter a feature name. Features: Sketch 1, Extrude 1.',
          detail: { reason: 'not_found', field: 'features[1]', names: ['Sketch 1', 'Extrude 1'] },
        },
      });
      const twice = await h.call('delete', { features: ['Extrude 1', 'EXTRUDE 1'] });
      expect(twice).toMatchObject({ ok: false, error: { message: 'bad_input: features[1]: Extrude 1 is named twice.', detail: { reason: 'bad_input', field: 'features' } } });
      expect(h.doc.state.get().doc).toBe(before);
    },
    REAL_KERNEL_MS,
  );

  it(
    'keeps a feature that fails afterwards and lists it in broke; get_model marks it broken_by_you',
    async () => {
      h = await assistantHarness();
      await plate(h);
      // A cut into every body before it (no scope): it uses no body by name, so deleting the plate is allowed.
      const hole = await sketchOn(h, 'Hole sketch', 'origin:top',new Shapes().circle('c', [0, 0], 5));
      const cut = await extrude(h, 'Cut', regions(h, hole), { op: 'cut', distance: '10 mm' });
      expect(stateOf(h, cut)).toBe('ok');
      const r = await h.ok('delete', { features: ['Extrude 1'] });
      expect(names(h)).toEqual(['Sketch 1', 'Hole sketch', 'Cut']);
      expect(stateOf(h, cut)).toBe('error');
      expect(r.data.broke).toEqual([{ feature: 'Cut', message: expect.stringMatching(/^Nothing to cut/) }]);
      expect(r.text).toBe('Deleted Extrude 1 · Body 1 removed · 1 feature broke: Cut');
      const m = await h.ok('get_model', { detail: 'brief', feature: '' });
      expect((m.data.features as Record<string, unknown>[]).find((f) => f.name === 'Cut')).toMatchObject({ state: 'error', broken_by_you: true });
    },
    REAL_KERNEL_MS,
  );

  it(
    "drops the deleted features from the person's selection, and a body that went with them stays out of it",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const sel = h.services.selection;
      // The person selected the sketch's and the extrude's tree rows.
      selectItem(sel, { kind: 'feature', feature: p.sketch }, false);
      selectItem(sel, { kind: 'feature', feature: p.extrude }, true);
      await h.ok('delete', { features: ['Extrude 1'] });
      expect(sel.get().items).toEqual([{ kind: 'feature', feature: p.sketch }]);
      // Only the body selected: its feature deleted, the selection is empty after the call, not the body again.
      await h.ok('undo', { steps: 1, previous_turn: false });
      await h.settle();
      selectItem(sel, { kind: 'body', body: p.body }, false);
      await h.ok('delete', { features: ['Extrude 1'] });
      expect(sel.get().items).toEqual([]);
    },
    REAL_KERNEL_MS,
  );
});

describe('delete races (forced at hold points)', () => {
  it(
    'the person adds a user of a listed feature while the call plans: in_use naming it, nothing deleted, theirs kept',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('after-plan');
      const r = h.call('delete', { features: ['Extrude 1'] });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-plan']), { timeout: 60_000 });
      // The person's fillet of the plate, right then (its own undo step).
      const mine = await fillet(h, p, '1 mm');
      const after = h.doc.state.get().doc;
      const label = undoLabel(h);
      rt.holds.release('after-plan');
      expect(await r).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', detail: { reason: 'in_use', users: [{ feature: 'Fillet 1', uses: 'Extrude 1', via: 'Body 1' }] } },
      });
      expect(h.doc.state.get().doc).toBe(after);
      expect(undoLabel(h)).toBe(label);
      expect(stateOf(h, mine)).toBe('ok');
    },
    REAL_KERNEL_MS,
  );

  it(
    'the person deletes a listed feature while the call plans: busy changed, nothing else deleted',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const f = await fillet(h, p, '1 mm');
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('after-plan');
      const r = h.call('delete', { features: ['Fillet 1', 'Extrude 1'] });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-plan']), { timeout: 60_000 });
      expect(h.doc.remove(f)).toEqual({ ok: true });
      rt.holds.release('after-plan');
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', message: 'changed: The Part changed while the call ran: Fillet 1 is not in it any more. Nothing was deleted.', detail: { reason: 'changed' } } });
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1']);
      expect(undoLabel(h)).toBe('Delete Fillet 1');
    },
    REAL_KERNEL_MS,
  );

  it(
    'a Stop after the removals goes back to the mark synchronously, then answers busy stopped',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      await fillet(h, p, '1 mm');
      const rt = runtimeOf(h.services)!;
      const before = h.doc.state.get().doc;
      const label = undoLabel(h);
      rt.holds.hold('before-commit');
      const ctl = new AbortController();
      const r = h.call('delete', { features: ['Extrude 1', 'Fillet 1'] }, { signal: ctl.signal });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 60_000 });
      // Both are out of the model already, not yet sealed.
      expect(names(h)).toEqual(['Sketch 1']);
      ctl.abort();
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.assistant.current()).toBeNull();
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'stopped' } } });
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Fillet 1']);
      expect(undoLabel(h)).toBe(label);
      expect(rt.ledger.entries('turn:t-test')).toEqual([]);
    },
    REAL_KERNEL_MS,
  );
});
