/**
 * The dock's state (phase 4 spec 1.3, 2.2, 5.2-5.5, 6.1), one module store read with
 * useSyncExternalStore as the Assistant's status is (status.ts). A publish replaces the snapshot.
 *
 * - **Size.** `open` while the person has it open (or a question opened it); else `pill` while
 *   something is worth seeing (a question shown in this tab, a running turn it follows, or an
 *   end not yet seen: DONE_PILL_MS, or until the dock opens); else `closed`.
 * - **Conversations.** The list is the server's (GET /api/assistant/conversations), read again on
 *   request; the newest answer wins. The dock shows the conversation the person picked, else the
 *   one this tab showed last in this context (sessionStorage), else the context's newest, else
 *   a new one. A conversation belongs to its project (or Home): moving to another context
 *   chooses again.
 * - **Turns.** Each turn the dock watches has a follower (follow.ts) and a view (turnView.ts).
 *   Only events newer than the view's are applied and announced (live.ts); the first data of a
 *   watch (its snapshot, the turn's past) is announced only for a turn this dock just started.
 *   An unwatched turn's view is dropped.
 * - **What the page keeps** (per viewer, never needed for correctness; every read and write in
 *   try/catch): open or closed (localStorage), the conversation shown and each conversation's
 *   draft (sessionStorage).
 */
import { useSyncExternalStore } from 'react';
import { assistantGet, RemoteError } from '../api';
import type { ConversationRow, ConversationsAnswer, TurnEvent, TurnSummary } from '../wire';
import { LIVE_ITS_WORKSPACE } from './copy';
import { followTurn, type FollowSink, type TurnFollower } from './follow';
import { createAnnouncer, liveMessagesOf, type Announcer } from './live';
import { applyEvents, applySummary, emptyTurnView, fillDroppedText, isEnded, markGone, type EndState, type SummaryView, type TurnView } from './turnView';

export type DockSize = 'open' | 'pill' | 'closed';
export type PillKind = 'question' | 'running' | 'done';

/** Where the person is: a project (or Home, null) and the workspace open in this tab, by name. */
export interface DockContext {
  project_id: string | null;
  workspace: string | null;
}

export interface ConversationsState {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'remote';
  list: readonly ConversationRow[];
  error: string | null;
}

export interface DockSnapshot {
  size: DockSize;
  /** What the pill shows while `size` is 'pill' (null otherwise). */
  pill: PillKind | null;
  /** Questions shown as cards in this tab, oldest first (their gate ids). */
  questions: readonly string[];
  /** The newest end the person hasn't seen (the pill's "done"). */
  unseenEnd: { turn: string; state: EndState } | null;
  context: DockContext;
  conversations: ConversationsState;
  /** The conversation shown; null: a new one. */
  shown: string | null;
  /** The turns watched, by id. */
  turns: Readonly<Record<string, TurnView>>;
}

/** How long an end not yet seen keeps the pill. */
export const DONE_PILL_MS = 120_000;
export const CONVERSATIONS_PATH = '/api/assistant/conversations';
export const STORAGE_KEYS = Object.freeze({
  open: 'mg.assistant.dock.open',
  conv: 'mg.assistant.dock.conv',
  draftPrefix: 'mg.assistant.dock.draft.',
});

// ---------------------------------------------------------------- storage (a convenience only)

type Area = 'local' | 'session';
function area(which: Area): Storage | null {
  try {
    return which === 'local' ? globalThis.localStorage ?? null : globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
function readKey(which: Area, key: string): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeKey(which: Area, key: string, value: string | null): void {
  try {
    const s = area(which);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* blocked or full: the dock works without it */
  }
}

// ---------------------------------------------------------------- the store

interface Watch {
  follower: TurnFollower;
  /** Its first data (the turn's past) is announced: a turn this dock just started. */
  announceFirst: boolean;
  primed: boolean;
  /** Watched as an ended turn: not running until a snapshot says otherwise. */
  knownEnded: boolean;
}

let personOpen = false;
let questions: string[] = [];
let unseenEnd: DockSnapshot['unseenEnd'] = null;
let unseenTimer: ReturnType<typeof setTimeout> | null = null;
let context: DockContext = { project_id: null, workspace: null };
let conversations: ConversationsState = { state: 'idle', list: [], error: null };
let shown: string | null = null;
/** The person picked the conversation shown (or a new one) in this context. */
let picked = false;
let turns: Record<string, TurnView> = {};
const watches = new Map<string, Watch>();
const drafts = new Map<string, string>();
let listSeq = 0;
let announcer: Announcer | null = null;
let started = false;

const listeners = new Set<() => void>();
let snap: DockSnapshot = build();

function running(id: string): boolean {
  const v = turns[id];
  const w = watches.get(id);
  if (!v || !w || isEnded(v)) return false;
  return !w.knownEnded || v.lastSeq > 0 || v.summary !== null;
}

function build(): DockSnapshot {
  const anyRunning = Object.keys(turns).some(running);
  const pill: PillKind | null = questions.length ? 'question' : anyRunning ? 'running' : unseenEnd ? 'done' : null;
  const size: DockSize = personOpen || questions.length ? 'open' : pill ? 'pill' : 'closed';
  return { size, pill: size === 'pill' ? pill : null, questions, unseenEnd, context, conversations, shown, turns };
}

function publish(): void {
  snap = build();
  for (const fn of [...listeners]) fn();
}

/** The open/closed choice remembered for this viewer, read once. */
function start(): void {
  if (started) return;
  started = true;
  personOpen = readKey('local', STORAGE_KEYS.open) === 'open';
  snap = build();
}

export function dockSnapshot(): DockSnapshot {
  start();
  return snap;
}

export function subscribeDock(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDock(): DockSnapshot {
  return useSyncExternalStore(subscribeDock, dockSnapshot, dockSnapshot);
}

// ---------------------------------------------------------------- open, pill, closed

function clearUnseen(): void {
  if (unseenTimer) clearTimeout(unseenTimer);
  unseenTimer = null;
  unseenEnd = null;
}

/** The person opens the dock: it stays open, and an end shown by the pill counts as seen. */
export function openDock(): void {
  start();
  personOpen = true;
  clearUnseen();
  writeKey('local', STORAGE_KEYS.open, 'open');
  publish();
}

/** The person closes the dock: the pill while something is worth seeing, else nothing. */
export function closeDock(): void {
  start();
  personOpen = false;
  writeKey('local', STORAGE_KEYS.open, 'closed');
  publish();
}

export function toggleDock(): void {
  if (dockSnapshot().size === 'open') closeDock();
  else openDock();
}

/** A question card shows in this tab: the dock opens for it. */
export function questionShown(gate: string): void {
  start();
  if (questions.includes(gate)) return;
  questions = [...questions, gate];
  publish();
}

/** A question card closed (answered, withdrawn, timed out). */
export function questionClosed(gate: string): void {
  if (!questions.includes(gate)) return;
  questions = questions.filter((g) => g !== gate);
  publish();
}

function endSeen(turn: string, state: EndState): void {
  if (snap.size === 'open') return;
  clearUnseen();
  unseenEnd = { turn, state };
  unseenTimer = setTimeout(() => {
    unseenTimer = null;
    unseenEnd = null;
    publish();
  }, DONE_PILL_MS);
}

// ---------------------------------------------------------------- context and conversations

const sameContext = (row: ConversationRow, ctx: DockContext) => (row.project_id ?? null) === (ctx.project_id ?? null);

/**
 * The conversation to show in `ctx`: the one remembered for this tab when it is of this
 * context, else the context's newest (the list is newest first), else none (a new one).
 */
export function chooseConversation(list: readonly ConversationRow[], ctx: DockContext, remembered: string | null): string | null {
  const here = list.filter((row) => sameContext(row, ctx));
  if (remembered && here.some((row) => row.id === remembered)) return remembered;
  let newest: ConversationRow | null = null;
  for (const row of here) if (!newest || Date.parse(row.last_used_at) > Date.parse(newest.last_used_at)) newest = row;
  return newest ? newest.id : null;
}

function choose(): void {
  if (picked) return;
  const next = chooseConversation(conversations.list, context, readKey('session', STORAGE_KEYS.conv));
  if (next !== shown) {
    shown = next;
    if (next) writeKey('session', STORAGE_KEYS.conv, next);
  }
}

/** Where the person is now; another project (or Home) chooses its conversation again. */
export function setDockContext(next: DockContext): void {
  start();
  const moved = (next.project_id ?? null) !== (context.project_id ?? null);
  if (!moved && next.workspace === context.workspace) return;
  context = { project_id: next.project_id ?? null, workspace: next.workspace ?? null };
  if (moved) {
    picked = false;
    shown = null;
    choose();
  }
  publish();
}

/** The person shows a conversation (null: a new one). */
export function showConversation(id: string | null): void {
  start();
  picked = true;
  shown = id;
  writeKey('session', STORAGE_KEYS.conv, id);
  publish();
}

function readRows(raw: unknown): ConversationRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Partial<ConversationsAnswer>).conversations;
  if (!Array.isArray(list)) return [];
  return list.filter((row): row is ConversationRow => !!row && typeof row === 'object' && typeof (row as ConversationRow).id === 'string' && !!(row as ConversationRow).id);
}

/** Reads the conversation list again; an older answer than the one shown is dropped. */
export async function refreshConversations(): Promise<void> {
  start();
  const seq = ++listSeq;
  conversations = { ...conversations, state: conversations.state === 'ready' ? 'ready' : 'loading' };
  publish();
  let next: ConversationsState;
  try {
    next = { state: 'ready', list: readRows(await assistantGet<ConversationsAnswer>(CONVERSATIONS_PATH)), error: null };
  } catch (err) {
    next =
      err instanceof RemoteError
        ? { state: 'remote', list: [], error: err.message }
        : { state: 'error', list: conversations.list, error: err instanceof Error ? err.message : String(err) };
  }
  if (seq !== listSeq) return;
  conversations = next;
  if (next.state === 'ready') choose();
  publish();
}

// ---------------------------------------------------------------- drafts

const draftKey = (conv: string | null) => STORAGE_KEYS.draftPrefix + (conv ?? 'new');

/** The text being written in a conversation (null: the new one). */
export function draftOf(conv: string | null): string {
  const k = draftKey(conv);
  const mem = drafts.get(k);
  if (mem !== undefined) return mem;
  return readKey('session', k) ?? '';
}

export function setDraft(conv: string | null, text: string): void {
  const k = draftKey(conv);
  if (text) drafts.set(k, text);
  else drafts.delete(k);
  writeKey('session', k, text || null);
}

// ---------------------------------------------------------------- turns

export interface WatchOptions {
  /** A turn this dock just started: its start is announced too. */
  announce?: boolean;
  /** Known ended (from the conversation list): its snapshot only, no pin. */
  ended?: boolean;
}

function setTurn(id: string, v: TurnView): void {
  if (turns[id] === v) return;
  turns = { ...turns, [id]: v };
}

function workspaceName(): string {
  return context.workspace || LIVE_ITS_WORKSPACE;
}

function onData(id: string, events: TurnEvent[], summary?: SummaryView | TurnSummary): void {
  const w = watches.get(id);
  const before = turns[id];
  if (!w || !before) return;
  const wasRunning = running(id);
  let v = applyEvents(before, events);
  if (summary) {
    v = applySummary(v, summary);
    if (typeof (summary as TurnSummary).text_so_far === 'string') v = fillDroppedText(v, (summary as TurnSummary).text_so_far);
  }
  if (w.primed || w.announceFirst) {
    const said = liveMessagesOf(before, v, events, workspaceName());
    if (said.length) {
      announcer ??= createAnnouncer();
      for (const m of said) announcer.say(m);
    }
  }
  w.primed = true;
  // A replay (events it has, a summary it had) changes nothing: no render.
  if (v === before) return;
  setTurn(id, v);
  if (wasRunning && isEnded(v) && v.end) endSeen(id, v.end.state);
  publish();
}

/** Follows a turn (once: watching it again changes nothing). */
export function watchTurn(id: string, o: WatchOptions = {}): void {
  start();
  if (watches.has(id)) return;
  setTurn(id, emptyTurnView(id));
  const sink: FollowSink = {
    data: (d) => onData(id, d.events, d.summary),
    stopped: (why) => {
      if (why === 'gone' && turns[id]) {
        setTurn(id, markGone(turns[id]));
        publish();
      }
    },
  };
  const w: Watch = { follower: null as unknown as TurnFollower, announceFirst: o.announce === true, primed: false, knownEnded: o.ended === true };
  watches.set(id, w);
  w.follower = followTurn(id, sink, { ended: o.ended === true });
  publish();
}

/** Stops following a turn and drops its view. */
export function unwatchTurn(id: string): void {
  const w = watches.get(id);
  if (!w) return;
  watches.delete(id);
  w.follower.close();
  const { [id]: _gone, ...rest } = turns;
  void _gone;
  turns = rest;
  publish();
}

/** Stops following every turn not in `ids` (the dock shows another conversation). */
export function retainTurns(ids: readonly string[]): void {
  const keep = new Set(ids);
  for (const id of [...watches.keys()]) if (!keep.has(id)) unwatchTurn(id);
}

/** Keeps a watched turn's channel pinned (a card of it, a Stop waiting); the answer releases it. */
export function keepTurn(id: string): () => void {
  const w = watches.get(id);
  return w ? w.follower.keep() : () => undefined;
}

/** Tests only: a fresh page. */
export function resetDockStoreForTests(): void {
  for (const w of watches.values()) w.follower.close();
  watches.clear();
  drafts.clear();
  clearUnseen();
  announcer?.dispose();
  announcer = null;
  personOpen = false;
  questions = [];
  context = { project_id: null, workspace: null };
  conversations = { state: 'idle', list: [], error: null };
  shown = null;
  picked = false;
  turns = {};
  listSeq = 0;
  started = false;
  snap = build();
}
