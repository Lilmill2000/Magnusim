// Edits wait for the person (CAD tools spec §3.0, §8.4, §12.1 busy.test.ts), over the toy block
// kernel (tests/doc/blocks.ts), driven through the page's tool handler:
//   - each thing the person does that an edit waits for, in words and in the chip's note;
//   - the hold: the chip says `waiting` with its note, progress says waiting (every 5 s), a store
//     change lets the call go on, and after 10 minutes (fake clock) it answers busy person_editing
//     with the person's panel still open and nothing changed; setHoldS shortens it;
//   - the rollback bar not at the end: the call waits until it is, else busy rolled_back;
//   - soft input: a key or a held pointer in the frame makes the call wait for 800 ms of quiet, at
//     most 10 s;
//   - Pause: edits wait, Resume lets them go, 10 minutes is busy paused; the pause ends with its
//     turn (the host's turn events) or at the next key without them; the person's undo of the
//     Assistant's steps while its turn runs pauses it ("you undid its steps"), their redo too
//     ("you redid its steps"); a turn that has ended takes no pause; an outside client's next
//     key that came only from the person's own change of the Part does not end its pause;
//   - another turn's call is busy other_turn; a Part being opened on a project geometry answers
//     not_ready; reads never wait.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPause, EDIT_WAIT_MS, personBlock, SOFT_MAX_MS } from '../../src/assistant/busy';
import { assistantTestHandle } from '../../src/assistant/install';
import { runtimeOf } from '../../src/assistant/runtime';
import { registerPendingEdit } from '../../src/lib/pendingEdits';
import { uiFor } from '../../src/ui/controller';
import { block, BlockKernel } from '../doc/blocks';
import { assistantHarness, type AssistantHarness, type HarnessOptions } from './harness';

let h: AssistantHarness | null = null;
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) c();
  h?.dispose();
  h = null;
});

const start = async (o: HarnessOptions = {}) => {
  const x = await assistantHarness({ kernel: new BlockKernel(), solver: false, ...o });
  const made = block(x.doc);
  await x.settle();
  return { x, made };
};
const PARAM = (name: string, expr: string) => ({ set: [{ name, kind: 'length', expr, comment: '', rename_to: '' }], remove: [] });
const params = (x: AssistantHarness) => x.doc.state.get().doc.params.map((p) => p.name);
const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] };

/** A value typed in a field and not applied (the field registers it as NumberUnitInput does). */
function typed(label: string): () => void {
  let on = true;
  const off = registerPendingEdit({ label, pending: () => on, error: () => null, commit() {} });
  const done = () => {
    on = false;
    off();
  };
  cleanups.push(done);
  return done;
}

describe('what the person does, in words', () => {
  it('names each thing an edit waits for, and what the chip asks', async () => {
    const { x, made } = await start();
    const ui = uiFor(x.services);
    const words = () => personBlock(x.services);
    expect(words()).toBeNull();
    x.doc.setRollback(1);
    expect(words()).toEqual({ reason: 'rolled_back', words: 'the rollback bar is after Sketch 1, not at the end', note: 'move the rollback bar to the end' });
    x.doc.setRollback(null);
    ui.openEdit(made.extrude);
    expect(words()).toEqual({ reason: 'person_editing', words: 'editing Extrude 1', note: 'close the Extrude 1 panel' });
    ui.closePanel();
    // An idle Parameters panel does not count; a value typed in it does.
    ui.openParams();
    expect(words()).toBeNull();
    const untype = typed('Expression of w');
    expect(words()).toEqual({ reason: 'person_editing', words: 'typing a value in Parameters', note: 'finish the value you are typing in Parameters' });
    ui.closePanel();
    expect(words()).toEqual({ reason: 'person_editing', words: 'typing a value (Expression of w)', note: 'finish the value you are typing (Expression of w)' });
    untype();
    ui.startRename('feature', made.extrude);
    expect(words()?.words).toBe('renaming a row of the tree');
    ui.endRename();
    ui.showMenu(10, 10, [{ id: 'x', label: 'X', run() {} }]);
    expect(words()?.words).toBe('a menu is open');
    ui.closeMenu();
    const d = document.createElement('dialog');
    d.setAttribute('open', '');
    d.setAttribute('aria-modal', 'true');
    document.body.append(d);
    expect(words()).toEqual({ reason: 'person_editing', words: 'a dialog is open', note: 'close the dialog' });
    d.remove();
    const drag = document.createElement('div');
    drag.className = 'cad-tb-drag';
    document.body.append(drag);
    expect(words()?.words).toBe('moving a toolbar button');
    drag.remove();
    expect(words()).toBeNull();
  });
});

describe('the hold', () => {
  it("waits while the person's panel is open (the chip says why, progress says waiting), and goes on when it closes", async () => {
    const { x, made } = await start();
    const rt = runtimeOf(x.services)!;
    const ui = uiFor(x.services);
    ui.openEdit(made.extrude);
    vi.useFakeTimers(FAKE);
    let done = false;
    const r = x.call('set_params', PARAM('q', '3 mm')).finally(() => void (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'close the Extrude 1 panel' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    const waiting = x.fake.progress.filter((p) => p.waiting);
    // The first at once, then one every 5 s.
    expect(waiting.map((p) => p.label)).toEqual(['Waiting for the person: editing Extrude 1', 'Waiting for the person: editing Extrude 1', 'Waiting for the person: editing Extrude 1']);
    ui.closePanel();
    await vi.advanceTimersByTimeAsync(10);
    expect(await r).toMatchObject({ ok: true });
    expect(params(x)).toEqual(['q']);
    // Not waiting any more: a progress without waiting followed, and the chip is back.
    expect(x.fake.progress.filter((p) => !p.waiting).map((p) => p.label)).toContain('The person is done: going on');
    expect(rt.store.get().phase).not.toBe('waiting');
  });

  it("answers busy person_editing after 10 minutes, the person's panel still open and nothing changed", async () => {
    const { x, made } = await start();
    const ui = uiFor(x.services);
    ui.openEdit(made.extrude);
    const session = x.doc.session();
    vi.useFakeTimers(FAKE);
    const r = x.call('set_params', PARAM('q', '3 mm'));
    await vi.advanceTimersByTimeAsync(EDIT_WAIT_MS - 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await r).toMatchObject({
      ok: false,
      error: { code: 'busy', message: 'person_editing: The call waited 10 minutes for the person: editing Extrude 1.', detail: { reason: 'person_editing', person: 'editing Extrude 1' } },
    });
    expect(x.doc.session()).toBe(session);
    expect(session?.open).toBe(true);
    expect(params(x)).toEqual([]);
    expect(runtimeOf(x.services)!.store.get().phase).not.toBe('waiting');
  });

  it('setHoldS shortens the hold (e2e tests use it)', async () => {
    const { x } = await start();
    const untype = typed('Expression of w');
    assistantTestHandle(x.services)!.setHoldS(0.05);
    expect(await x.call('set_params', PARAM('q', '3 mm'))).toMatchObject({ ok: false, error: { detail: { reason: 'person_editing', person: 'typing a value (Expression of w)' } } });
    untype();
    assistantTestHandle(x.services)!.setHoldS(null);
    expect(runtimeOf(x.services)!.waitCapMs).toBe(EDIT_WAIT_MS);
  });

  it('waits for the rollback bar to come to the end, else busy rolled_back', async () => {
    const { x } = await start();
    const rt = runtimeOf(x.services)!;
    x.doc.setRollback(1);
    rt.waitCapMs = 60_000;
    const r = x.call('set_params', PARAM('q', '3 mm'));
    await vi.waitFor(() => expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'move the rollback bar to the end' }), { timeout: 30_000 });
    // Reads answer meanwhile, with the bar in their data.
    const read = await x.ok('get_model', { detail: 'brief', feature: '' });
    expect(read.data).toMatchObject({ rolled_back: { after: 'Sketch 1', count: 1 }, person: 'the rollback bar is after Sketch 1, not at the end' });
    x.doc.setRollback(null);
    expect(await r).toMatchObject({ ok: true });
    x.doc.setRollback(1);
    rt.waitCapMs = 50;
    expect(await x.call('set_params', PARAM('q2', '3 mm'))).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'rolled_back' } } });
  });
});

describe('soft input', () => {
  it('a key in the frame: the call waits for 800 ms of quiet', async () => {
    const { x } = await start();
    vi.useFakeTimers(FAKE);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    let done = false;
    const r = x.call('set_params', PARAM('q', '3 mm')).finally(() => void (done = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    expect(params(x)).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(await r).toMatchObject({ ok: true });
    // A soft wait is not a wait for the person: no waiting progress, no chip.
    expect(x.fake.progress.filter((p) => p.waiting)).toEqual([]);
  });

  it('a pointer held in the frame: the call goes ahead after 10 s', async () => {
    const { x } = await start();
    vi.useFakeTimers(FAKE);
    document.dispatchEvent(new Event('pointerdown'));
    let done = false;
    const r = x.call('set_params', PARAM('q', '3 mm')).finally(() => void (done = true));
    await vi.advanceTimersByTimeAsync(SOFT_MAX_MS - 500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await r).toMatchObject({ ok: true });
    document.dispatchEvent(new Event('pointerup'));
  });
});

describe('the pause', () => {
  it('edits wait while paused and go on at Resume; 10 minutes is busy paused; reads still answer', async () => {
    const { x } = await start();
    const rt = runtimeOf(x.services)!;
    x.fake.emitTurn({ id: 't-1', title: 'Paused' });
    rt.pause.set('person', 'turn:t-1', 't-1');
    expect(rt.store.get()).toMatchObject({ phase: 'paused', note: null });
    const r = x.call('set_params', PARAM('q', '3 mm'), { turn: 't-1' });
    await vi.waitFor(() => expect(x.fake.progress.some((p) => p.waiting && p.label === 'Paused by the person')).toBe(true), { timeout: 30_000 });
    expect((await x.call('get_model', { detail: 'brief', feature: '' }, { turn: 't-1' })).ok).toBe(true);
    rt.pause.resume();
    expect(await r).toMatchObject({ ok: true });
    expect(rt.store.get().phase).not.toBe('paused');
    rt.pause.set('person', 'turn:t-1', 't-1');
    vi.useFakeTimers(FAKE);
    const late = x.call('set_params', PARAM('q2', '3 mm'), { turn: 't-1' });
    await vi.advanceTimersByTimeAsync(EDIT_WAIT_MS + 1000);
    expect(await late).toMatchObject({ ok: false, error: { code: 'busy', message: 'paused: The call waited 10 minutes: the person paused the Assistant in this Part.', detail: { reason: 'paused', why: 'person' } } });
  });

  it('ends with its turn; without the turn events, at the next key', async () => {
    const { x } = await start();
    const rt = runtimeOf(x.services)!;
    x.fake.emitTurn({ id: 't-1', title: 'One' });
    rt.pause.set('take_over', 'turn:t-1', 't-1');
    expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you took over' });
    x.fake.emitTurn({ id: 't-1', title: 'One', state: 'ended', end: { state: 'done', reason: 'done' } });
    expect(rt.pause.get()).toBeNull();
    expect(rt.store.get().phase).toBe('ended');
    x.dispose();
    h = (await start({ assistant: { turns: false } })).x;
    const rt2 = runtimeOf(h.services)!;
    rt2.waitCapMs = 50;
    rt2.pause.set('take_over', 'turn:t-1', null);
    // (A host without the turn events keeps only the message: the hint goes into it.)
    expect(await h.call('set_params', PARAM('q', '1 mm'), { turn: 't-1' })).toMatchObject({ ok: false, error: { code: 'busy', message: expect.stringMatching(/^paused: The call waited [\d.]+ s: the person took over a step in this Part\. Try: /) } });
    // The next key (a new request) starts unpaused.
    expect(await h.call('set_params', PARAM('q', '1 mm'), { turn: 't-2' })).toMatchObject({ ok: true });
    expect(rt2.pause.get()).toBeNull();
  });

  it("the person's undo of the Assistant's steps while its turn runs pauses it; not after the turn, not of their own steps", async () => {
    const { x } = await start();
    const rt = runtimeOf(x.services)!;
    x.fake.emitTurn({ id: 't-1', title: 'Params' });
    await x.ok('set_params', PARAM('q', '3 mm'), { turn: 't-1' });
    x.doc.addParam({ name: 'mine', expr: '1 mm', quantity: 'length' });
    // Undo of the person's own step: no pause.
    x.doc.undo();
    expect(rt.pause.get()).toBeNull();
    // Undo of the Assistant's: paused, and the chip says so.
    x.doc.undo();
    expect(rt.pause.get()).toEqual({ why: 'undo', key: 'turn:t-1', turn: 't-1' });
    expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you undid its steps' });
    rt.waitCapMs = 50;
    const r = await x.call('set_params', PARAM('q', '3 mm'), { turn: 't-1' });
    // The answer tells the model what the person did.
    expect(r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'paused', why: 'undo', user_changes: expect.arrayContaining(['the person undid your steps (Assistant: Params); do not redo them unless asked']) } } });
    x.fake.emitTurn({ id: 't-1', title: 'Params', state: 'ended', end: { state: 'done', reason: 'done' } });
    expect(rt.pause.get()).toBeNull();
    // Redo after the turn: no pause.
    x.doc.redo();
    expect(rt.pause.get()).toBeNull();
  });

  it("the person's redo of the Assistant's steps while its turn runs pauses it as a redo: the chip and the model hear \"redid\"", async () => {
    const { x } = await start();
    const rt = runtimeOf(x.services)!;
    x.fake.emitTurn({ id: 't-1', title: 'Params' });
    await x.ok('set_params', PARAM('q', '3 mm'), { turn: 't-1' });
    x.doc.undo();
    expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you undid its steps' });
    // Resume, then the person changes their mind: Ctrl+Y brings the step back.
    x.services.apis.get().assistant!.actions!.resume();
    expect(rt.pause.get()).toBeNull();
    x.doc.redo();
    expect(params(x)).toEqual(['q']);
    expect(rt.pause.get()).toEqual({ why: 'redo', key: 'turn:t-1', turn: 't-1' });
    expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you redid its steps' });
    rt.waitCapMs = 50;
    expect(await x.call('set_params', PARAM('r', '3 mm'), { turn: 't-1' })).toMatchObject({
      ok: false,
      error: { code: 'busy', message: expect.stringMatching(/^paused: The call waited [\d.]+ s: the person redid the Assistant's steps in this Part\.$/), detail: { reason: 'paused', why: 'redo' } },
    });
  });

  it('a turn that has ended takes no pause; an outside session that went on because of the person keeps its pause', () => {
    const over = new Set(['t-old']);
    const same = (a: string, b: string) => a.startsWith('ext:') && b.startsWith('ext:') && a !== 'ext:9' && b !== 'ext:9';
    const p = createPause({ isOver: (t) => over.has(t), sameSession: same });
    p.set('person', 'turn:t-old', 't-old');
    p.set('take_over', 'turn:t-old', 't-old');
    expect(p.get()).toBeNull();
    p.set('person', 'ext:1', null);
    p.enterKey('ext:2');
    expect(p.get()).toEqual({ why: 'person', key: 'ext:1', turn: null });
    // Another session (5 idle minutes), or a turn's key: the next key, so the pause ends.
    p.enterKey('ext:9');
    expect(p.get()).toBeNull();
    p.set('take_over', 'ext:1', null);
    p.enterKey('turn:t-2');
    expect(p.get()).toBeNull();
  });
});

describe('the gate', () => {
  it("another turn's edit is busy other_turn; a Part being opened answers not_ready; reads never wait for the person", async () => {
    const { x, made } = await start();
    x.fake.emitTurn({ id: 't-1', title: 'Running' });
    expect(await x.call('set_params', PARAM('q', '3 mm'), { turn: 't-2' })).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'other_turn' } } });
    const off = uiFor(x.services).addEditBlock(() => 'Opening Vortex from the project');
    expect(await x.call('set_params', PARAM('q', '3 mm'), { turn: 't-1' })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'opening_geometry: Opening Vortex from the project' } });
    off();
    uiFor(x.services).openEdit(made.extrude);
    const read = await x.ok('get_model', { detail: 'brief', feature: '' }, { turn: 't-1' });
    expect(read.data).toMatchObject({ person: 'editing Extrude 1' });
  });
});
