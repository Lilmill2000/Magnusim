// Watch mode's controls in the page (CAD tools spec §7.3, §8.2, §8.3, §8.6), over the toy block
// kernel, through the page's tool handler and the chip's actions (services.apis.assistant.actions):
//   - Ask each step: a judged edit waits for Keep (kept, one undo step) or Discard (reverted, busy
//     step_declined), the chip saying "Assistant: Parameters · keep it?" with progress waiting; no
//     answer in the wait counts as Discard; a change of the person's while it waits answers busy
//     changed;
//   - Stop: the running call goes back at once (synchronously, before stop() returns), the host is
//     asked to end the turn, and any later call of that turn answers busy stopped;
//   - Pause and Resume from the chip: edits wait, the chip says paused, Resume lets them go;
//   - a call at the watch pace while the window is hidden runs without waits and says so (note);
//   - set_params at the watch pace with no panel open shows the Assistant's own Parameters panel,
//     which closes with the step;
//   - Undo of an ended turn: one Ctrl+Z of its group, refused while another step is newest.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STOPPED_WORDS } from '../../src/assistant/call';
import { HIDDEN_NOTE } from '../../src/assistant/pace';
import { runtimeOf } from '../../src/assistant/runtime';
import type { AssistantActions } from '../../src/types/assistant';
import { uiFor } from '../../src/ui/controller';
import { block, BlockKernel } from '../doc/blocks';
import { assistantHarness, type AssistantHarness, type HarnessOptions } from './harness';

let h: AssistantHarness | null = null;
const restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
  h?.dispose();
  h = null;
});

const start = async (o: HarnessOptions = {}) => {
  const x = await assistantHarness({ kernel: new BlockKernel(), solver: false, ...o });
  block(x.doc);
  await x.settle();
  return x;
};
const PARAM = (name: string, expr: string) => ({ set: [{ name, kind: 'length', expr, comment: '', rename_to: '' }], remove: [] });
const params = (x: AssistantHarness) => x.doc.state.get().doc.params.map((p) => p.name);
const actionsOf = (x: AssistantHarness): AssistantActions => x.services.apis.get().assistant!.actions!;

describe('Ask each step', () => {
  it('waits after the rebuild for Keep (kept, one undo step) or Discard (reverted, busy step_declined)', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    h.fake.emitTurn({ id: 't1', title: 'Two parameters' });
    rt.askEach.force(true);
    expect(rt.store.get().askEach).toBe(true);
    const undoBefore = h.doc.state.get().history.undoLabel;
    const kept = h.call('set_params', PARAM('a', '3 mm'), { turn: 't1' });
    await vi.waitFor(() => expect(rt.approvals.pending()).toMatchObject({ part: 'Parameters' }), { timeout: 30_000 });
    // The change is in the Part while the person looks; the chip asks; the minutes stop.
    expect(params(h)).toEqual(['a']);
    expect(rt.store.get()).toMatchObject({ phase: 'approve', call: { label: 'Parameters' } });
    expect(h.fake.progress.some((p) => p.waiting && p.label === 'Waiting for the person: keep Parameters?')).toBe(true);
    actionsOf(h).keep();
    expect(await kept).toMatchObject({ ok: true });
    expect(h.doc.state.get().history.undoLabel).toBe('Assistant: Two parameters');
    expect(rt.store.get().phase).not.toBe('approve');
    // Discard: back to before the call, and the model hears why.
    const declined = h.call('set_params', PARAM('b', '4 mm'), { turn: 't1' });
    await vi.waitFor(() => expect(rt.approvals.pending()).toMatchObject({ part: 'Parameters' }), { timeout: 30_000 });
    expect(params(h)).toEqual(['a', 'b']);
    actionsOf(h).discard();
    expect(await declined).toMatchObject({
      ok: false,
      error: { code: 'busy', message: 'step_declined: The person declined this step: Parameters was not kept.', hint: 'The person declined this step: ask what to change.', detail: { reason: 'step_declined', why: 'discard' } },
    });
    expect(params(h)).toEqual(['a']);
    expect(rt.ledger.entries('turn:t1')).toHaveLength(1);
    expect(undoBefore).not.toBe(h.doc.state.get().history.undoLabel);
  });

  it('no answer in the wait counts as Discard; a change of the person\'s while it waits answers busy changed', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    rt.askEach.force(true);
    rt.waitCapMs = 60;
    expect(await h.call('set_params', PARAM('a', '3 mm'))).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'step_declined', why: 'no_answer' } } });
    expect(params(h)).toEqual([]);
    rt.waitCapMs = 60_000;
    const r = h.call('set_params', PARAM('b', '3 mm'));
    await vi.waitFor(() => expect(rt.approvals.pending()).not.toBeNull(), { timeout: 30_000 });
    // The person renames the block meanwhile: the step is no longer only the Assistant's.
    const body = h.doc.state.get().rebuild.bodies[0].id;
    h.doc.renameBody(body, 'Mine');
    const out = await r;
    expect(out).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed' } } });
    expect(rt.approvals.pending()).toBeNull();
  });
});

describe('the chip: Stop', () => {
  it('reverts the running call at once, asks the host to end the turn, and later calls of it answer busy stopped', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    h.fake.emitTurn({ id: 't1', title: 'Stop me' });
    expect(rt.store.get().canStop).toBe(true);
    const before = h.doc.state.get().doc;
    rt.holds.hold('before-commit');
    const r = h.call('set_params', PARAM('a', '3 mm'), { turn: 't1' });
    await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 30_000 });
    expect(params(h)).toEqual(['a']);
    actionsOf(h).stop();
    // Synchronous: the Part is the mark again before stop() returned.
    expect(h.doc.state.get().doc).toBe(before);
    expect(h.doc.assistant.current()).toBeNull();
    expect(h.fake.stops).toEqual(['t1']);
    expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'stopped' } } });
    rt.holds.release('before-commit');
    // A call of that turn that still comes: busy stopped, and nothing changes.
    expect(await h.call('set_params', PARAM('b', '3 mm'), { turn: 't1' })).toMatchObject({ ok: false, error: { code: 'busy', message: `stopped: ${STOPPED_WORDS}`, detail: { reason: 'stopped' } } });
    expect(params(h)).toEqual([]);
    // The host ends it; the next turn is not stopped.
    h.fake.emitTurn({ id: 't1', title: 'Stop me', state: 'ended', end: { state: 'stopped', reason: 'stopped' } });
    expect(rt.store.get()).toMatchObject({ phase: 'ended', turn: { id: 't1', end: 'stopped' } });
    h.fake.emitTurn({ id: 't2', title: 'Next' });
    expect(await h.call('set_params', PARAM('c', '3 mm'), { turn: 't2' })).toMatchObject({ ok: true });
  });

  it("is not offered on a host without the turn events", async () => {
    h = await start({ assistant: { turns: false } });
    expect(runtimeOf(h.services)!.store.get().canStop).toBe(false);
    actionsOf(h).stop();
    expect(h.fake.stops).toEqual([]);
  });
});

describe('the chip: Pause and Resume', () => {
  it('Pause makes the turn\'s edits wait (the chip says paused); Resume lets them go', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    h.fake.emitTurn({ id: 't1', title: 'Pause me' });
    actionsOf(h).pause();
    expect(rt.pause.get()).toEqual({ why: 'person', key: 'turn:t1', turn: 't1' });
    expect(rt.store.get().phase).toBe('paused');
    const r = h.call('set_params', PARAM('a', '3 mm'), { turn: 't1' });
    await vi.waitFor(() => expect(h!.fake.progress.some((p) => p.waiting && p.label === 'Paused by the person')).toBe(true), { timeout: 30_000 });
    expect(params(h)).toEqual([]);
    actionsOf(h).resume();
    expect(await r).toMatchObject({ ok: true });
    expect(rt.pause.get()).toBeNull();
  });

  it("without the turn events, Pause holds the newest call's key", async () => {
    h = await start({ assistant: { turns: false } });
    const rt = runtimeOf(h.services)!;
    expect((await h.call('set_params', PARAM('a', '3 mm'), { turn: 'x1' })).ok).toBe(true);
    actionsOf(h).pause();
    expect(rt.pause.get()).toEqual({ why: 'person', key: 'turn:x1', turn: null });
  });
});

describe('a hidden window at the watch pace', () => {
  it('runs without waits and says so in the answer', async () => {
    h = await start({ pace: 'watch', paceScale: 1 });
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    restore.push(() => {
      delete (document as unknown as Record<string, unknown>).hidden;
      if (d) Object.defineProperty(Document.prototype, 'hidden', d);
    });
    const t0 = Date.now();
    const r = await h.call('set_params', PARAM('a', '3 mm'));
    expect(r).toMatchObject({ ok: true, result: { data: { note: HIDDEN_NOTE } } });
    expect(Date.now() - t0).toBeLessThan(5_000);
    // No Parameters panel was shown for it either (nobody watches).
    expect(uiFor(h.services).state.get().panel).toBeNull();
  });
});

describe("the Assistant's Parameters panel at the watch pace", () => {
  it('shows while set_params runs with no panel open, read-only, and closes with the step', async () => {
    h = await start({ pace: 'watch' });
    const rt = runtimeOf(h.services)!;
    const ui = uiFor(h.services);
    rt.holds.hold('after-open');
    const r = h.call('set_params', PARAM('a', '3 mm'));
    await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-open']), { timeout: 30_000 });
    expect(ui.state.get().panel).toMatchObject({ kind: 'params', owner: 'assistant' });
    rt.holds.release('after-open');
    expect(await r).toMatchObject({ ok: true });
    expect(ui.state.get().panel).toBeNull();
    // At the fast pace: no panel.
    rt.pace.force('fast');
    rt.holds.hold('before-commit');
    const r2 = h.call('set_params', PARAM('b', '3 mm'));
    await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 30_000 });
    expect(ui.state.get().panel).toBeNull();
    rt.holds.release('before-commit');
    expect((await r2).ok).toBe(true);
  });
});

describe("the chip: Undo of an ended turn", () => {
  it('is one Ctrl+Z of its group, and refused while another step is newest', async () => {
    h = await start();
    h.fake.emitTurn({ id: 't1', title: 'Add a and b' });
    await h.ok('set_params', PARAM('a', '3 mm'), { turn: 't1' });
    await h.ok('set_params', PARAM('b', '4 mm'), { turn: 't1' });
    h.fake.emitTurn({ id: 't1', title: 'Add a and b', state: 'ended', end: { state: 'done', reason: 'done' } });
    expect(runtimeOf(h.services)!.store.get()).toMatchObject({ phase: 'ended', turn: { id: 't1' } });
    actionsOf(h).undo();
    expect(params(h)).toEqual([]);
    // Redo brings it all back; a step of the person's on top: Undo is refused, with a toast.
    h.doc.redo();
    expect(params(h)).toEqual(['a', 'b']);
    h.fake.emitTurn({ id: 't3', title: 'Another', state: 'ended', end: { state: 'done', reason: 'done' } });
    h.doc.addParam({ name: 'mine', expr: '1 mm', quantity: 'length' });
    h.fake.emitTurn({ id: 't1', title: 'Add a and b', state: 'ended', end: { state: 'done', reason: 'done' } });
    actionsOf(h).undo();
    expect(params(h)).toEqual(['a', 'b', 'mine']);
    expect(h.ws.log.toasts.at(-1)?.message).toMatch(/^Undo: /);
  });
});
