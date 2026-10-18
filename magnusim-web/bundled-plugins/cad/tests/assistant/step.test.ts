// One edit call as one Assistant step, on the REAL kernel (CAD tools spec §7.3, §7.9, §12.1
// step.test.ts, §12.4), each race forced at a hold point (never slept for):
//   - a Stop while the Assistant's panel is open reverts synchronously (the model is the mark and
//     the panel gone when abort() returns), then the call answers busy stopped;
//   - a person's panel opened at after-plan, or at between-opens, is waited for (the chip says
//     why), untouched and uncommitted; once the person closes it the call plans anew and
//     finishes as one undo group;
//   - a person's one-shot change at between-opens makes the step unclean: busy changed, and the
//     revert is refused with what stayed (detail.kept);
//   - Escape or Ctrl+Z on the Assistant's panel is a take-over: busy taken_over with its why,
//     nothing kept, and the Assistant pauses in this Part until the turn ends;
//   - the calls of a turn seal into one undo group; a person's edit between two calls starts a new
//     group with the same label and is never absorbed;
//   - the person's selection comes back after the call.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import { selectItem } from '../../src/lib/selection';
import { uiFor } from '../../src/ui/controller';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { fillet, plate, stateOf, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const EDIT = (feature: string, o: Record<string, unknown> = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const PARAM = (name: string, expr: string) => ({ set: [{ name, kind: 'length', expr, comment: '', rename_to: '' }], remove: [] });
const distanceOf = (x: AssistantHarness, id: string) => (x.doc.state.get().doc.features.find((f) => f.id === id) as unknown as { extent: { distance: string } }).extent.distance;

describe('a Stop', () => {
  it(
    'reverts synchronously while the Assistant panel is open, then answers busy stopped',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      const before = h.doc.state.get().doc;
      rt.holds.hold('before-commit');
      const ctl = new AbortController();
      const r = h.call('edit_feature', EDIT('Extrude 1', { set: [{ field: 'extent.distance', value: '10 mm' }] }), { signal: ctl.signal });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 60_000 });
      // The Assistant's panel is open with its draft applied live.
      expect(uiFor(h.services).state.get().panel).toMatchObject({ kind: 'feature', owner: 'assistant', feature: p.extrude });
      expect(distanceOf(h, p.extrude)).toBe('10 mm');
      ctl.abort();
      // Synchronous: back to the mark, the panel and the step gone, before anything else runs.
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.session()).toBeNull();
      expect(h.doc.assistant.current()).toBeNull();
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'stopped' } } });
      expect(rt.holds.waiting()).toEqual([]);
      expect(h.doc.state.get().doc).toBe(before);
      expect(runtimeOf(h.services)!.ledger.entries('turn:t-test')).toEqual([]);
    },
    REAL_KERNEL_MS,
  );
});

describe("the person's panel during a call", () => {
  it(
    'opened at after-plan: the call waits, the panel stays theirs and uncommitted; closing it lets the call finish',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      const ui = uiFor(h.services);
      rt.holds.hold('after-plan');
      const r = h.call('set_params', PARAM('q', '3 mm'));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-plan']), { timeout: 60_000 });
      // The person opens Extrude 1 and types a new distance (live), right then.
      ui.openEdit(p.extrude);
      const session = h.doc.session()!;
      session.update({ extent: { kind: 'blind', distance: '8 mm' } } as never);
      const committed = h.doc.committed();
      rt.holds.release('after-plan');
      // The call waits for the person: the chip says why, progress says waiting.
      await vi.waitFor(() => expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'close the Extrude 1 panel' }), { timeout: 60_000 });
      expect(h.fake.progress.some((x) => x.waiting && x.label === 'Waiting for the person: editing Extrude 1')).toBe(true);
      // Untouched: still open, still the person's, not committed.
      expect(h.doc.session()).toBe(session);
      expect(session.open).toBe(true);
      expect(session.owner).toBeUndefined();
      expect(h.doc.committed()).toBe(committed);
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toEqual(['w', 'd', 't']);
      // The person's Done: the call plans again and finishes.
      ui.closePanel();
      const out = await r;
      expect(out).toMatchObject({ ok: true });
      expect(distanceOf(h, p.extrude)).toBe('8 mm');
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toEqual(['w', 'd', 't', 'q']);
      expect(rt.store.get().phase).not.toBe('waiting');
      // Two undo entries: the Assistant's step, then the person's edit below it.
      expect(undoLabel(h)).toBe('Assistant: Parameters');
      h.doc.undo();
      expect(undoLabel(h)).toBe('Edit Extrude 1');
    },
    REAL_KERNEL_MS,
  );

  it(
    'opened at between-opens: the step goes back under it, waits, and finishes as one undo group once it closes',
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const fl = await fillet(h, p, '1 mm');
      const rt = runtimeOf(h.services)!;
      const ui = uiFor(h.services);
      const label = undoLabel(h);
      rt.holds.hold('between-opens');
      const r = h.call('edit_feature', EDIT('Fillet 1', { set: [{ field: 'radius', value: '2 mm' }], rename_to: 'Round' }));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      // The Assistant's panel is done; the person opens Extrude 1 (another feature) before the rename.
      ui.openEdit(p.extrude);
      const session = h.doc.session()!;
      // Only the first round stops here: the second goes through.
      rt.holds.release('between-opens');
      await vi.waitFor(() => expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'close the Extrude 1 panel' }), { timeout: 60_000 });
      // The step went back under the person's panel: the fillet as before, the panel open and theirs.
      expect(h.doc.session()).toBe(session);
      expect(session.open).toBe(true);
      const f = () => h!.doc.state.get().doc.features.find((x) => x.id === fl) as unknown as { name: string; radius: string };
      expect(f()).toMatchObject({ name: 'Fillet 1', radius: '1 mm' });
      ui.closePanel();
      expect(await r).toMatchObject({ ok: true });
      expect(f()).toMatchObject({ name: 'Round', radius: '2 mm' });
      // One undo group for the call.
      h.doc.undo();
      expect(f()).toMatchObject({ name: 'Fillet 1', radius: '1 mm' });
      expect(undoLabel(h)).toBe(label);
    },
    REAL_KERNEL_MS,
  );

  it(
    "a person's one-shot change at between-opens: busy changed, and what stayed is listed",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      await fillet(h, p, '1 mm');
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('between-opens');
      const r = h.call('edit_feature', EDIT('Fillet 1', { set: [{ field: 'radius', value: '2 mm' }], rename_to: 'Round' }));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      h.doc.addParam({ name: 'q', expr: '1 mm', quantity: 'length' });
      rt.holds.release('between-opens');
      const out = await r;
      expect(out).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed', kept: ['changed Fillet 1', 'added parameter q = 1 mm'] } } });
      // The person's change stays, and so does what the step did before it (the revert would undo theirs).
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toContain('q');
    },
    REAL_KERNEL_MS,
  );
});

describe('a take-over', () => {
  it(
    "Escape on the Assistant's panel: taken_over, nothing kept, and the Assistant pauses until the turn ends",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      h.fake.emitTurn({ id: 't-1', title: 'Taller' });
      const before = h.doc.state.get().doc;
      rt.holds.hold('before-commit');
      const r = h.call('edit_feature', EDIT('Extrude 1', { set: [{ field: 'extent.distance', value: '10 mm' }] }), { turn: 't-1' });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 60_000 });
      uiFor(h.services).closePanel();
      rt.holds.release('before-commit');
      const out = await r;
      expect(out).toEqual({
        ok: false,
        error: { code: 'busy', message: 'taken_over: You took over (Escape): Edit Extrude 1 was not kept.', hint: expect.any(String), detail: { reason: 'taken_over', why: 'escape' } },
      });
      expect(h.doc.state.get().doc).toBe(before);
      expect(distanceOf(h, p.extrude)).toBe('t');
      // Paused in this Part: the chip says so, and the next edit of the turn waits.
      expect(rt.pause.get()).toEqual({ why: 'take_over', key: 'turn:t-1', turn: 't-1' });
      expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you took over' });
      const next = h.call('set_params', PARAM('q', '2 mm'), { turn: 't-1' });
      await vi.waitFor(() => expect(h!.fake.progress.some((x) => x.waiting && x.label === 'Paused by the person')).toBe(true), { timeout: 60_000 });
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toEqual(['w', 'd', 't']);
      // The turn ends: the pause with it, and the waiting edit goes on.
      h.fake.emitTurn({ id: 't-1', title: 'Taller', state: 'ended', end: { state: 'done', reason: 'done' } });
      expect(rt.pause.get()).toBeNull();
      expect(await next).toMatchObject({ ok: true });
      // The next turn starts unpaused.
      h.fake.emitTurn({ id: 't-2', title: 'Again' });
      expect(await h.call('set_params', PARAM('q2', '2 mm'), { turn: 't-2' })).toMatchObject({ ok: true });
    },
    REAL_KERNEL_MS,
  );

  it(
    "Ctrl+Z on the Assistant's panel is a take-over (undo) that undoes nothing of the person's",
    async () => {
      h = await assistantHarness();
      await plate(h);
      const rt = runtimeOf(h.services)!;
      const label = undoLabel(h);
      const before = h.doc.state.get().doc;
      rt.holds.hold('before-commit');
      const r = h.call('edit_feature', EDIT('Extrude 1', { set: [{ field: 'extent.distance', value: '10 mm' }] }));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 60_000 });
      h.doc.undo();
      rt.holds.release('before-commit');
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'undo' } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(undoLabel(h)).toBe(label);
    },
    REAL_KERNEL_MS,
  );
});

describe('undo groups and the selection', () => {
  it(
    "a turn's calls are one group; a person's edit between two calls is its own entry and a new group follows",
    async () => {
      h = await assistantHarness();
      h.fake.emitTurn({ id: 't-1', title: 'Three parameters' });
      const t = { turn: 't-1' };
      await h.ok('set_params', PARAM('a', '1 mm'), t);
      await h.ok('set_params', PARAM('b', '2 mm'), t);
      h.doc.addParam({ name: 'mine', expr: '9 mm', quantity: 'length' });
      await h.ok('set_params', PARAM('c', '3 mm'), t);
      h.fake.emitTurn({ id: 't-1', title: 'Three parameters', state: 'ended', end: { state: 'done', reason: 'done' } });
      const names = () => h!.doc.state.get().doc.params.map((p) => p.name);
      expect(undoLabel(h)).toBe('Assistant: Three parameters');
      h.doc.undo();
      expect(names()).toEqual(['a', 'b', 'mine']);
      expect(undoLabel(h)).toBe('Add parameter mine');
      h.doc.undo();
      expect(names()).toEqual(['a', 'b']);
      expect(undoLabel(h)).toBe('Assistant: Three parameters');
      h.doc.undo();
      expect(names()).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    "the person's selection comes back after a call that showed its own panel",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      selectItem(h.services.selection, { kind: 'body', body: p.body }, false);
      const sel = h.services.selection.get();
      await h.ok('edit_feature', EDIT('Extrude 1', { set: [{ field: 'extent.distance', value: '8 mm' }] }));
      expect(h.services.selection.get().items).toEqual(sel.items);
      expect(stateOf(h, p.extrude)).toBe('ok');
    },
    REAL_KERNEL_MS,
  );
});
