// The dock's store (phase 4 spec 1.3, 2.2, 5.2-5.4, 6.1): a fake hub channel per turn, a fetch
// whose answers each test hands out, on fake timers.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow, TurnEvent, TurnSummary } from '../wire';
import { resetFollowForTests } from './follow';
import {
  chooseConversation,
  closeDock,
  DONE_PILL_MS,
  dockSnapshot,
  draftOf,
  keepTurn,
  openDock,
  questionClosed,
  questionShown,
  refreshConversations,
  resetDockStoreForTests,
  retainTurns,
  setDockContext,
  setDraft,
  showConversation,
  STORAGE_KEYS,
  subscribeDock,
  toggleDock,
  unwatchTurn,
  useDock,
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
const summary = (id: string, state: TurnSummary['state']): Omit<TurnSummary, 'text_so_far'> => ({
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
  tab: null,
  project_id: null,
  served_by: null,
});
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
  resetFollowForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('open, pill and closed', () => {
  it('closed with nothing worth seeing; the pill while a turn runs; a question opens it; an end keeps the pill 120 s', () => {
    expect(dockSnapshot()).toMatchObject({ size: 'closed', pill: null });
    watchTurn('t1');
    expect(dockSnapshot()).toMatchObject({ size: 'pill', pill: 'running' });
    channels[0].frame('snapshot', { turn: summary('t1', 'model'), events: [ev({ type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    questionShown('g1');
    expect(dockSnapshot()).toMatchObject({ size: 'open', pill: null, questions: ['g1'] });
    questionShown('g1');
    expect(dockSnapshot().questions).toEqual(['g1']);
    questionClosed('g1');
    expect(dockSnapshot()).toMatchObject({ size: 'pill', pill: 'running', questions: [] });
    channels[0].frame('events', { events: [ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 2 });
    expect(dockSnapshot()).toMatchObject({ size: 'pill', pill: 'done', unseenEnd: { turn: 't1', state: 'done' } });
    vi.advanceTimersByTime(DONE_PILL_MS - 1);
    expect(dockSnapshot().pill).toBe('done');
    vi.advanceTimersByTime(1);
    expect(dockSnapshot()).toMatchObject({ size: 'closed', pill: null, unseenEnd: null });
  });

  it('opening counts the end as seen; an end while open shows no pill; open or closed is remembered', () => {
    watchTurn('t1');
    channels[0].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'stopped', reason: 'user', message: 'Stopped.' })], next: 2 });
    expect(dockSnapshot().pill).toBe('done');
    openDock();
    expect(dockSnapshot()).toMatchObject({ size: 'open', unseenEnd: null });
    expect(localStorage.getItem(STORAGE_KEYS.open)).toBe('open');
    closeDock();
    expect(dockSnapshot()).toMatchObject({ size: 'closed' });
    expect(localStorage.getItem(STORAGE_KEYS.open)).toBe('closed');
    // An end that came while the dock was open was seen.
    openDock();
    watchTurn('t2');
    channels[1].frame('events', { events: [ev({ type: 'state', state: 'model' }), ev({ type: 'end', state: 'done', reason: 'done', message: null })], next: 4 });
    closeDock();
    expect(dockSnapshot().size).toBe('closed');
    // A fresh page reads the choice.
    toggleDock();
    resetDockStoreForTests();
    localStorage.setItem(STORAGE_KEYS.open, 'open');
    expect(dockSnapshot().size).toBe('open');
  });

  it('a turn watched as ended is not running; its snapshot is not announced, nor is a running turn\'s past', () => {
    watchTurn('old', { ended: true });
    expect(dockSnapshot().size).toBe('closed');
    channels[0].frame('snapshot', {
      turn: summary('old', 'done'),
      events: [ev({ type: 'state', state: 'starting' }), ev({ type: 'end', state: 'done', reason: 'done', message: null })],
      next: 2,
      ended: true,
      more: false,
    });
    expect(dockSnapshot()).toMatchObject({ size: 'closed', unseenEnd: null });
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
    const before = dockSnapshot().turns.t1;
    channels[0].drop();
    expect(channels[1].url).toBe('/api/assistant/events?role=turn&turn=t1&since=2');
    channels[1].frame('snapshot', { turn: summary('t1', 'model'), events: start, next: 2, ended: false, more: false });
    expect(dockSnapshot().turns.t1.items).toBe(before.items);
    expect(dockSnapshot().turns.t1.items).toHaveLength(1);
    // Nor does it render: the same snapshot object, no listener called.
    const heard = vi.fn();
    const off = subscribeDock(heard);
    channels[1].frame('events', { events: start, next: 2 });
    channels[1].frame('summary', { turn: summary('t1', 'model') });
    expect(heard).not.toHaveBeenCalled();
    expect(dockSnapshot().turns.t1).toBe(before);
    off();
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
    expect(Object.keys(dockSnapshot().turns)).toEqual(['b', 'c']);
    retainTurns(['c']);
    expect(channels[1].closed).toBe(true);
    expect(channels[2].closed).toBe(false);
    expect(Object.keys(dockSnapshot().turns)).toEqual(['c']);
    // Watching twice is one follower.
    watchTurn('c');
    expect(channels).toHaveLength(3);
  });

  it('a record gone (404) marks the view', () => {
    watchTurn('t1');
    channels[0].refuse(404);
    expect(dockSnapshot().turns.t1.gone).toBe(true);
    expect(dockSnapshot().size).toBe('closed');
  });

  it('useDock re-renders on each publish', () => {
    const { result } = renderHook(() => useDock());
    expect(result.current.size).toBe('closed');
    act(() => openDock());
    expect(result.current.size).toBe('open');
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
  });

  it('reads the list, shows the context\'s conversation, and chooses again in another project unless the person picked one', async () => {
    sessionStorage.setItem(STORAGE_KEYS.conv, 'h-old');
    const reading = refreshConversations();
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/conversations']);
    expect(dockSnapshot().conversations.state).toBe('loading');
    await sent[0].answer(200, { ok: true, conversations: [...list, { nope: true }] });
    await reading;
    expect(dockSnapshot().conversations).toMatchObject({ state: 'ready', error: null });
    expect(dockSnapshot().conversations.list.map((r) => r.id)).toEqual(['h-old', 'p1-new', 'h-new', 'p1-old']);
    expect(dockSnapshot().shown).toBe('h-old');
    setDockContext({ project_id: 'p1', workspace: 'CAD' });
    expect(dockSnapshot()).toMatchObject({ shown: 'p1-new', context: { project_id: 'p1', workspace: 'CAD' } });
    expect(sessionStorage.getItem(STORAGE_KEYS.conv)).toBe('p1-new');
    showConversation(null);
    expect(dockSnapshot().shown).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEYS.conv)).toBeNull();
    // A new list keeps the person's pick in this context.
    const again = refreshConversations();
    await sent[1].answer(200, { ok: true, conversations: list });
    await again;
    expect(dockSnapshot().shown).toBeNull();
    // Another context chooses again.
    setDockContext({ project_id: null, workspace: null });
    expect(dockSnapshot().shown).toBe('h-new');
  });

  it('the newest answer wins; a failure keeps the list; remote access says so', async () => {
    const first = refreshConversations();
    const second = refreshConversations();
    await sent[1].answer(200, { ok: true, conversations: [list[1]] });
    await sent[0].answer(200, { ok: true, conversations: list });
    await Promise.all([first, second]);
    expect(dockSnapshot().conversations.list.map((r) => r.id)).toEqual(['p1-new']);
    const failing = refreshConversations();
    await sent[2].answer(500, { ok: false, error: 'boom' });
    await failing;
    expect(dockSnapshot().conversations).toMatchObject({ state: 'error', error: 'boom' });
    expect(dockSnapshot().conversations.list).toHaveLength(1);
    const remote = refreshConversations();
    await sent[3].answer(403, { ok: false, reason: 'remote' });
    await remote;
    expect(dockSnapshot().conversations).toMatchObject({ state: 'remote', list: [] });
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
    expect(dockSnapshot().size).toBe('closed');
    openDock();
    closeDock();
    expect(dockSnapshot().size).toBe('closed');
    setDraft('c1', 'kept in memory');
    expect(draftOf('c1')).toBe('kept in memory');
    expect(draftOf('c2')).toBe('');
    showConversation('c1');
    expect(dockSnapshot().shown).toBe('c1');
    setDockContext({ project_id: 'p9', workspace: null });
    expect(dockSnapshot().shown).toBeNull();
  });

  it('even when the storage objects themselves are out of reach', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    openDock();
    expect(dockSnapshot().size).toBe('open');
    setDraft(null, 'x');
    expect(draftOf(null)).toBe('x');
  });
});
