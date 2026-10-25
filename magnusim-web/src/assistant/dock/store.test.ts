// The dock's conversation store (phase 4 spec 1.3, 2.2, 4.4, 5.2-5.4, 6.1), and how it opens the
// dock and sets its pill through dockState: a fake hub channel per turn, a fetch whose answers
// each test hands out, on fake timers.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow, SlimTurnSummary, TurnEvent, TurnSummary } from '../wire';
import { closeDock, dockSnapshot as dock, DONE_PILL_MS, openDock, resetDockForTests } from './dockState';
import { resetFollowForTests } from './follow';
import { STILL_STOPPING_MS } from './turnView';
import {
  addLocalTurn,
  answerKeyOf,
  chooseConversation,
  dockStoreSnapshot,
  draftOf,
  keepAnswerKey,
  keepTurn,
  keptTurns,
  clearStopSent,
  markStopSent,
  pickedProvider,
  questionClosed,
  questionShown,
  refreshConversations,
  resetDockStoreForTests,
  retainTurns,
  setDockContext,
  setDraft,
  setPickedProvider,
  setTurnStopper,
  showConversation,
  STORAGE_KEYS,
  subscribeDockStore,
  unwatchTurn,
  useDockStore,
  watchTurn,
} from './store';

const hoisted = vi.hoisted(() => {
  class FakeChannel {
    readonly CONNECTING = 0 as const;
    readonly OPEN = 1 as const;
    readonly CLOSED = 2 as const;
    readyState = 0;
    onmessage = null;
    onerror = null;
    onopen = null;
    pinned = false;
    closed = false;
    refusal: { status: number; error: string } | null = null;
    private readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
    constructor(readonly url: string) {}
    addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(fn);
    }
    removeEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    close(): void {
      this.closed = true;
      this.readyState = 2;
    }
    pin(on: boolean): void {
      this.pinned = on;
    }
    ready(): Promise<boolean> {
      return Promise.resolve(this.readyState === 1);
    }
    frame(type: string, data: unknown): void {
      if (this.closed) return;
      this.readyState = 1;
      for (const fn of [...(this.listeners.get(type) || [])]) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    drop(): void {
      this.readyState = 0;
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
    refuse(status: number): void {
      this.readyState = 2;
      this.refusal = { status, error: `refused ${status}` };
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
  }
  const channels: FakeChannel[] = [];
  return { channels, FakeChannel };
});
const { channels } = hoisted;

vi.mock('../../api/eventHub', () => ({
  openChannel: vi.fn((url: string) => {
    const ch = new hoisted.FakeChannel(url);
    hoisted.channels.push(ch);
    return ch;
  }),
}));

interface Sent {
  url: string;
  answer(status: number, body: unknown): Promise<void>;
}
let sent: Sent[] = [];
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let seq = 0;
const ev = (body: Record<string, unknown>): TurnEvent => ({ seq: ++seq, at: 0, ...body }) as TurnEvent;
/** A snapshot's turn, as the server sends it: the full summary. */
const summary = (id: string, state: TurnSummary['state']): TurnSummary => ({
  id,
  conversation: 'c1',
  state,
  step: 1,
  started_at: '2026-10-20T10:00:00.000Z',
  ended_at: null,
  usd: 0,
  estimated: false,
  end_reason: null,
  message: null,
  open_gates: [],
  text_so_far: '',
  tab: null,
  project_id: null,
  served_by: null,
});
/** A `summary` frame's turn, as the server sends it: without text_so_far and prompt. */
const slim = (id: string, state: TurnSummary['state']): SlimTurnSummary => {
  const s: Partial<TurnSummary> = summary(id, state);
  delete s.text_so_far;
  delete s.prompt;
  return s as SlimTurnSummary;
};
const row = (id: string, project: string | null, lastUsed: string): ConversationRow => ({
  id,
  provider: 'p',
  label: 'Provider',
  billing: 'usd',
  model: 'm',
  project_id: project,
  project_title: project ? `Project ${project}` : null,
  created_at: lastUsed,
  last_used_at: lastUsed,
  running: null,
  full: null,
  title: `Conversation ${id}`,
  turns: [],
  dropped_turns: 0,
});
/** The live region's words, as the store's announcer writes them. */
const live = () => document.getElementById('assistant-dock-live')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  resetDockStoreForTests();
  resetDockForTests();
  resetFollowForTests();
  channels.length = 0;
  sent = [];
  seq = 0;
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="assistant-dock-live"></div>';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          sent.push({
            url,
            answer: async (status, body) => {
              resolve(new Response(JSON.stringify(body), { status }));
              await flush();
            },
          });
        }),
    ),
  );
});
afterEach(() => {
  resetDockStoreForTests();
  resetDockForTests();
  resetFollowForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('open, pill and closed', () => {
  it('closed with nothing worth seeing; the pill follows a running turn; a question opens the dock; an end keeps the pill 120 s', () => {
    expect(dock()).toMatchObject({ size: 'closed', pill: null });
    watchTurn('t1');
    expect(dock()).toMatchObject({ size: 'pill', pill: { kind: 'running', text: 'Assistant · Starting…' }, badge: 'working' });
    expect(dock().pill?.onStop).toBeUndefined();
    const used = { steps: 3, steps_cap: 120, changes: 0, changes_cap: 0, usd: 0, usd_cap: 0, active_ms: 125_000, minutes_cap: 30 };
    channels[0].frame('snapshot', { turn: { ...summary('t1', 'model'), used }, events: [ev({ type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    expect(dock().pill).toMatchObject({ kind: 'running', text: 'Assistant · Thinking… · 3 of 120 steps · 2 of 30 min' });
    // With a way to stop it, the pill's Stop ends that turn.
    const stop = vi.fn();
    setTurnStopper(stop);
    dock().pill?.onStop?.();
    expect(stop).toHaveBeenCalledWith('t1');
    // A question opens the dock, without taking the keyboard or counting as the person's choice.
    questionShown('g1', 'Reset the counter to zero before the next step?');
    expect(dock()).toMatchObject({ size: 'open', focusSeq: 0, pill: { kind: 'question', text: 'Assistant asks: Reset the counter to zero before the nex…' }, badge: 'question' });
    expect(dockStoreSnapshot().questions).toEqual(['g1']);
    questionShown('g1', 'Reset the counter to zero before the next step?');
    expect(dockStoreSnapshot().questions).toEqual(['g1']);
    // Closed while it waits: the pill asks it.
    closeDock();
    expect(dock()).toMatchObject({ size: 'pill', pill: { kind: 'question' } });
    questionClosed('g1');
    expect(dock()).toMatchObject({ size: 'pill', pill: { kind: 'running' } });
    expect(dockStoreSnapshot().questions).toEqual([]);
    channels[0].frame('events', { events: [ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 2 });
    expect(dock()).toMatchObject({ size: 'pill', pill: { kind: 'done', text: 'Assistant: done' }, badge: 'done' });
    vi.advanceTimersByTime(DONE_PILL_MS - 1);
    expect(dock().pill?.kind).toBe('done');
    vi.advanceTimersByTime(1);
    expect(dock()).toMatchObject({ size: 'closed', pill: null, badge: null });
    // Nothing the store says later brings it back.
    showConversation('c1');
    expect(dock().pill).toBeNull();
  });

  it('opening counts the end as seen; an end while open shows no pill; an end behind a question shows after it', () => {
    watchTurn('t1');
    channels[0].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'stopped', reason: 'user', message: 'Stopped.' })], next: 2 });
    expect(dock().pill).toMatchObject({ kind: 'done', text: 'Assistant: stopped' });
    openDock();
    expect(dock()).toMatchObject({ size: 'open', pill: null });
    closeDock();
    expect(dock().size).toBe('closed');
    // An end that came while the dock was open was seen.
    openDock();
    watchTurn('t2');
    expect(dock()).toMatchObject({ size: 'open', pill: { kind: 'running' } });
    channels[1].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 4 });
    expect(dock().pill).toBeNull();
    closeDock();
    expect(dock().size).toBe('closed');
    // An end while a question waits: the question first, then the end.
    watchTurn('t3');
    questionShown('g1', 'Go on?');
    closeDock();
    channels[2].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'failed', reason: 'error', message: 'Boom.' })], next: 6 });
    expect(dock().pill).toMatchObject({ kind: 'question', text: 'Assistant asks: Go on?' });
    questionClosed('g1');
    expect(dock().pill).toMatchObject({ kind: 'done', text: "Assistant: didn't finish" });
    // ...unless the dock was opened meanwhile.
    watchTurn('t4');
    questionShown('g2', 'Again?');
    closeDock();
    channels[3].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 8 });
    openDock();
    closeDock();
    questionClosed('g2');
    expect(dock()).toMatchObject({ size: 'closed', pill: null });
  });

  it('a turn watched as ended is not running; its snapshot is not announced, nor is a running turn\'s past', () => {
    watchTurn('old', { ended: true });
    expect(dock().size).toBe('closed');
    channels[0].frame('snapshot', {
      turn: summary('old', 'done'),
      events: [ev({ type: 'state', state: 'starting' }), ev({ type: 'end', state: 'done', reason: 'done', message: null })],
      next: 2,
      ended: true,
      more: false,
    });
    expect(dock()).toMatchObject({ size: 'closed', pill: null });
    watchTurn('run');
    channels[1].frame('snapshot', {
      turn: summary('run', 'tools'),
      events: [ev({ type: 'state', state: 'starting' }), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'add', title: 'Add', risk: 'edit', source: 'Demo', input_preview: '{}' })],
      next: 4,
      ended: false,
      more: false,
    });
    expect(live()).toBe('');
    // What comes after the snapshot is news.
    channels[1].frame('events', { events: [ev({ type: 'tool_result', call: 'c1', ok: true, summary: 'Added', ms: 3 })], next: 5 });
    expect(live()).toBe('Add: done');
  });

  it('a turn this dock started announces its start; replays after a reconnect say and show nothing twice', () => {
    watchTurn('t1', { announce: true });
    const start = [ev({ type: 'state', state: 'starting' }), ev({ type: 'text', step: 1, text: 'Hi' })];
    channels[0].frame('snapshot', { turn: summary('t1', 'model'), events: start, next: 2, ended: false, more: false });
    expect(live()).toBe('The Assistant is working.');
    const before = dockStoreSnapshot().turns.t1;
    channels[0].drop();
    expect(channels[1].url).toBe('/api/assistant/events?role=turn&turn=t1&since=2');
    channels[1].frame('snapshot', { turn: summary('t1', 'model'), events: start, next: 2, ended: false, more: false });
    expect(dockStoreSnapshot().turns.t1.items).toBe(before.items);
    expect(dockStoreSnapshot().turns.t1.items).toHaveLength(1);
    // Nor does it render: the same snapshot object, no listener called.
    const heard = vi.fn();
    const off = subscribeDockStore(heard);
    channels[1].frame('events', { events: start, next: 2 });
    channels[1].frame('summary', { turn: slim('t1', 'model') });
    expect(heard).not.toHaveBeenCalled();
    expect(dockStoreSnapshot().turns.t1).toBe(before);
    off();
  });

  it("a snapshot's full summary brings the person's request and fills the text the log dropped; a slim one keeps them", () => {
    watchTurn('t1');
    channels[0].frame('snapshot', {
      turn: { ...summary('t1', 'model'), prompt: 'Make a box', text_so_far: 'Earlier step.\n\nHi' },
      events: [ev({ type: 'state', state: 'model' }), ev({ type: 'text', step: 2, text: 'Hi' })],
      next: 2,
      ended: false,
      more: false,
    });
    const v = dockStoreSnapshot().turns.t1;
    expect(v.prompt).toBe('Make a box');
    expect(v.summary).not.toHaveProperty('text_so_far');
    expect(v.items.map((it) => it.kind)).toEqual(['earlier_text', 'text']);
    channels[0].frame('summary', { turn: slim('t1', 'tools') });
    expect(dockStoreSnapshot().turns.t1.prompt).toBe('Make a box');
    expect(dockStoreSnapshot().turns.t1.items.map((it) => it.kind)).toEqual(['earlier_text', 'text']);
  });

  it("a snapshot with more to come: its text_so_far is read once the frames after it reach its upto, so text that comes in them shows once; text the log dropped still shows", () => {
    watchTurn('t1');
    const head = [ev({ type: 'state', state: 'tools' })];
    const later = ev({ type: 'text', step: 2, text: 'Hello there' });
    channels[0].frame('snapshot', { turn: { ...summary('t1', 'model'), text_so_far: 'Hello there' }, events: head, next: head[0].seq, ended: false, more: true, upto: later.seq });
    expect(dockStoreSnapshot().turns.t1.items.filter((it) => it.kind === 'earlier_text')).toEqual([]);
    channels[0].frame('events', { events: [later], next: later.seq });
    const kinds = dockStoreSnapshot().turns.t1.items.map((it) => it.kind);
    expect(kinds.filter((k) => k === 'text' || k === 'earlier_text')).toEqual(['text']);
    // The log dropped the first step's text: it shows before the text that came.
    watchTurn('t2');
    const h2 = [ev({ type: 'state', state: 'tools' })];
    const l2 = ev({ type: 'text', step: 3, text: 'Second' });
    channels[1].frame('snapshot', { turn: { ...summary('t2', 'model'), text_so_far: ['First', 'Second'].join(String.fromCharCode(10, 10)) }, events: h2, next: h2[0].seq, ended: false, more: true, upto: l2.seq });
    channels[1].frame('events', { events: [l2], next: l2.seq });
    const items = dockStoreSnapshot().turns.t2.items.filter((it) => it.kind === 'text' || it.kind === 'earlier_text');
    expect(items.map((it) => [it.kind, (it as { text: string }).text])).toEqual([
      ['earlier_text', 'First'],
      ['text', 'Second'],
    ]);
  });

  it('keepTurn pins the channel; unwatching drops the view and the channel; retainTurns keeps only those named', () => {
    watchTurn('a', { ended: true });
    watchTurn('b', { ended: true });
    watchTurn('c', { ended: true });
    const release = keepTurn('a');
    expect(channels[0].pinned).toBe(true);
    release();
    expect(channels[0].pinned).toBe(false);
    expect(keepTurn('nope')).toBeTypeOf('function');
    unwatchTurn('a');
    expect(channels[0].closed).toBe(true);
    expect(Object.keys(dockStoreSnapshot().turns)).toEqual(['b', 'c']);
    retainTurns(['c']);
    expect(channels[1].closed).toBe(true);
    expect(channels[2].closed).toBe(false);
    expect(Object.keys(dockStoreSnapshot().turns)).toEqual(['c']);
    // Watching twice is one follower.
    watchTurn('c');
    expect(channels).toHaveLength(3);
  });

  it('a record gone (404) marks the view', () => {
    watchTurn('t1');
    channels[0].refuse(404);
    expect(dockStoreSnapshot().turns.t1.gone).toBe(true);
    expect(dock()).toMatchObject({ size: 'closed', pill: null });
  });

  it('useDockStore re-renders on each publish', () => {
    const { result } = renderHook(() => useDockStore());
    expect(result.current.shown).toBeNull();
    act(() => showConversation('c1'));
    expect(result.current.shown).toBe('c1');
  });
});

describe('the conversation per context', () => {
  const list = [row('h-old', null, '2026-10-20T08:00:00Z'), row('p1-new', 'p1', '2026-10-20T09:30:00Z'), row('h-new', null, '2026-10-20T09:00:00Z'), row('p1-old', 'p1', '2026-10-20T07:00:00Z')];

  it('the remembered one of this context, else the newest of it, else a new one', () => {
    expect(chooseConversation(list, { project_id: null, workspace: null }, null)).toBe('h-new');
    expect(chooseConversation(list, { project_id: 'p1', workspace: null }, null)).toBe('p1-new');
    expect(chooseConversation(list, { project_id: 'p1', workspace: null }, 'p1-old')).toBe('p1-old');
    // Remembered from another context: not here.
    expect(chooseConversation(list, { project_id: 'p1', workspace: null }, 'h-old')).toBe('p1-new');
    expect(chooseConversation(list, { project_id: 'p2', workspace: null }, null)).toBeNull();
    // A request this tab started, still at work: its conversation, wherever the window is now.
    const moved = [...list, { ...row('c-moved', 'p1', '2026-10-20T06:00:00Z'), running: 't-mine' }];
    expect(chooseConversation(moved, { project_id: 'p1', workspace: null }, 'p1-old', new Set(['t-mine']))).toBe('c-moved');
    expect(chooseConversation(moved, { project_id: 'p1', workspace: null }, 'p1-old', new Set(['t-other']))).toBe('p1-old');
  });

  it('reads the list, shows the context\'s conversation, and chooses again in another project unless the person picked one', async () => {
    sessionStorage.setItem(STORAGE_KEYS.conv, 'h-old');
    const reading = refreshConversations();
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/conversations']);
    expect(dockStoreSnapshot().conversations.state).toBe('loading');
    await sent[0].answer(200, { ok: true, conversations: [...list, { nope: true }] });
    await reading;
    expect(dockStoreSnapshot().conversations).toMatchObject({ state: 'ready', error: null });
    expect(dockStoreSnapshot().conversations.list.map((r) => r.id)).toEqual(['h-old', 'p1-new', 'h-new', 'p1-old']);
    expect(dockStoreSnapshot().shown).toBe('h-old');
    setDockContext({ project_id: 'p1', workspace: 'CAD' });
    expect(dockStoreSnapshot()).toMatchObject({ shown: 'p1-new', context: { project_id: 'p1', workspace: 'CAD' } });
    expect(sessionStorage.getItem(STORAGE_KEYS.conv)).toBe('p1-new');
    showConversation(null);
    expect(dockStoreSnapshot().shown).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEYS.conv)).toBeNull();
    // A new list keeps the person's pick in this context.
    const again = refreshConversations();
    await sent[1].answer(200, { ok: true, conversations: list });
    await again;
    expect(dockStoreSnapshot().shown).toBeNull();
    // Another context chooses again.
    setDockContext({ project_id: null, workspace: null });
    expect(dockStoreSnapshot().shown).toBe('h-new');
  });

  it('a request this tab started that moves the window to another project keeps its conversation shown; once it ended, the place chooses again', async () => {
    const reading = refreshConversations();
    await sent[0].answer(200, { ok: true, conversations: list });
    await reading;
    // Home: a new conversation, its request started here (not heard of yet: at work).
    showConversation('c-new');
    addLocalTurn('c-new', 't-run');
    setDockContext({ project_id: 'p1', workspace: null });
    expect(dockStoreSnapshot().shown).toBe('c-new');
    // The list is read again, so the conversation's row says where it is now.
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/conversations', '/api/assistant/conversations']);
    await sent[1].answer(200, { ok: true, conversations: [...list, row('c-new', 'p1', '2026-10-20T10:00:00Z')] });
    expect(dockStoreSnapshot().shown).toBe('c-new');
    // Nothing of this tab at work in the shown one: another project chooses its own.
    showConversation('p1-new');
    setDockContext({ project_id: null, workspace: null });
    expect(dockStoreSnapshot().shown).toBe('h-new');
  });

  it('the newest answer wins; a failure keeps the list; remote access says so', async () => {
    const first = refreshConversations();
    const second = refreshConversations();
    await sent[1].answer(200, { ok: true, conversations: [list[1]] });
    await sent[0].answer(200, { ok: true, conversations: list });
    await Promise.all([first, second]);
    expect(dockStoreSnapshot().conversations.list.map((r) => r.id)).toEqual(['p1-new']);
    const failing = refreshConversations();
    await sent[2].answer(500, { ok: false, error: 'boom' });
    await failing;
    expect(dockStoreSnapshot().conversations).toMatchObject({ state: 'error', error: 'boom' });
    expect(dockStoreSnapshot().conversations.list).toHaveLength(1);
    const remote = refreshConversations();
    await sent[3].answer(403, { ok: false, reason: 'remote' });
    await remote;
    expect(dockStoreSnapshot().conversations).toMatchObject({ state: 'remote', list: [] });
  });
});

describe('what this tab started', () => {
  it("a started turn shows in its conversation until the list names it; its answer key goes at its end", async () => {
    addLocalTurn('c1', 't1');
    addLocalTurn('c1', 't1');
    expect(dockStoreSnapshot().local).toEqual({ c1: ['t1'] });
    keepAnswerKey('t1', 'k1');
    keepAnswerKey('t2', 'k2');
    expect(keptTurns()).toEqual(['t1', 't2']);
    expect(answerKeyOf('t1')).toBe('k1');
    const listed = refreshConversations();
    await sent[0].answer(200, { ok: true, conversations: [{ ...row('c1', null, '2026-10-20T10:00:00Z'), turns: [{ id: 't1', title: 'x', state: 'model', started_at: 'a', ended_at: null, started_by: 'window' }] }] });
    await listed;
    expect(dockStoreSnapshot().local).toEqual({});
    watchTurn('t1');
    channels[0].frame('snapshot', { turn: summary('t1', 'model'), events: [ev({ type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    expect(answerKeyOf('t1')).toBe('k1');
    channels[0].frame('events', { events: [ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 2 });
    expect(answerKeyOf('t1')).toBeNull();
    expect(keptTurns()).toEqual(['t2']);
    // A record the server no longer keeps lets its key go too.
    watchTurn('t2');
    channels[1].refuse(404);
    expect(keptTurns()).toEqual([]);
  });

  it('a Stop sent says Stopping… on the pill too; the provider pick is kept per context', () => {
    watchTurn('t1');
    channels[0].frame('snapshot', { turn: summary('t1', 'model'), events: [ev({ type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    act(() => markStopSent('t1'));
    expect(typeof dockStoreSnapshot().stops.t1).toBe('number');
    expect(dock().pill?.text).toBe('Assistant · Stopping…');
    // No frame comes: the pill still turns "Still stopping…" after 5 s.
    act(() => vi.advanceTimersByTime(STILL_STOPPING_MS + 50));
    expect(dock().pill?.text).toBe('Assistant · Still stopping…');
    // A Stop that didn't reach the server: the request isn't stopping.
    act(() => clearStopSent('t1'));
    expect(dockStoreSnapshot().stops.t1).toBeUndefined();
    expect(dock().pill?.text).toBe('Assistant · Thinking…');
    setPickedProvider('home', 'first');
    setPickedProvider('p1', 'agent:helper');
    expect([pickedProvider('home'), pickedProvider('p1'), pickedProvider('p2')]).toEqual(['first', 'agent:helper', null]);
  });
});

describe('drafts', () => {
  it('one per conversation, kept in sessionStorage, read back by a fresh page', () => {
    setDraft('c1', 'Make a box');
    setDraft(null, 'Something new');
    expect(draftOf('c1')).toBe('Make a box');
    expect(draftOf(null)).toBe('Something new');
    expect(draftOf('c2')).toBe('');
    expect(sessionStorage.getItem(`${STORAGE_KEYS.draftPrefix}c1`)).toBe('Make a box');
    expect(sessionStorage.getItem(`${STORAGE_KEYS.draftPrefix}new`)).toBe('Something new');
    resetDockStoreForTests();
    expect(draftOf('c1')).toBe('Make a box');
    setDraft('c1', '');
    expect(draftOf('c1')).toBe('');
    expect(sessionStorage.getItem(`${STORAGE_KEYS.draftPrefix}c1`)).toBeNull();
  });
});

describe('storage that throws', () => {
  it('the dock works without it: open, close, drafts in memory, the conversation shown', () => {
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    expect(dock().size).toBe('closed');
    openDock();
    closeDock();
    expect(dock().size).toBe('closed');
    setDraft('c1', 'kept in memory');
    expect(draftOf('c1')).toBe('kept in memory');
    expect(draftOf('c2')).toBe('');
    showConversation('c1');
    expect(dockStoreSnapshot().shown).toBe('c1');
    setDockContext({ project_id: 'p9', workspace: null });
    expect(dockStoreSnapshot().shown).toBeNull();
  });

  it('even when the storage objects themselves are out of reach', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    openDock();
    expect(dock().size).toBe('open');
    setDraft(null, 'x');
    expect(draftOf(null)).toBe('x');
  });
});
