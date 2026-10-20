/**
 * What the dock shows (phase 4 spec 1.3, 2.2, 4.4, 5.2-5.5, 6.1): the questions shown in this
 * tab, the conversations, the turns watched, where the person is, and the drafts. One module
 * store read with useSyncExternalStore as the Assistant's status is (status.ts). A publish
 * replaces the snapshot.
 *
 * - **Open, pill or closed** belong to dockState.ts, the one owner; this store only asks it.
 *   A question shown in this tab opens the dock (without taking the keyboard: its card does,
 *   spec 4.4); closed while it waits, the pill asks it. Else the pill follows the newest
 *   running turn watched, with its Stop when one is set (setTurnStopper); else an end that
 *   came while the dock was closed shows `done` until dockState lets it go (120 s, or the
 *   dock opens). The pill's words are pill.ts's.
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
 *   try/catch): the conversation shown and each conversation's draft (sessionStorage). Open or
 *   closed is dockState's (localStorage).
 */
import { useSyncExternalStore } from 'react';
import { assistantGet, RemoteError } from '../api';
import type { ConversationRow, ConversationsAnswer, SlimTurnSummary, TurnEvent, TurnSummary } from '../wire';
import { LIVE_ITS_WORKSPACE, pillDone, pillQuestion, pillRunning } from './copy';
import { dockSnapshot, openDock, setDockPill, subscribeDock, type DockPill } from './dockState';
import { followTurn, type FollowSink, type TurnFollower } from './follow';
import { createAnnouncer, liveMessagesOf, type Announcer } from './live';
import { countersOf, footerWords } from './pill';
import { applyEvents, applySummary, emptyTurnView, fillDroppedText, isEnded, markGone, turnPhase, type EndState, type TurnView } from './turnView';

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

export interface DockStoreSnapshot {
  /** Questions shown as cards in this tab, oldest first (their gate ids). */
  questions: readonly string[];
  context: DockContext;
  conversations: ConversationsState;
  /** The conversation shown; null: a new one. */
  shown: string | null;
  /** The turns watched, by id. */
  turns: Readonly<Record<string, TurnView>>;
}

export const CONVERSATIONS_PATH = '/api/assistant/conversations';
export const STORAGE_KEYS = Object.freeze({
  conv: 'mg.assistant.dock.conv',
  draftPrefix: 'mg.assistant.dock.draft.',
});

// ---------------------------------------------------------------- storage (a convenience only)

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
function readKey(key: string): string | null {
  try {
    return session()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeKey(key: string, value: string | null): void {
  try {
    const s = session();
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

let questions: string[] = [];
/** Each question's title, for the pill. */
const questionTitles = new Map<string, string>();
/** An end that came while the dock was closed, waiting for a question or a running turn to go. */
let unseenEnd: { turn: string; state: EndState } | null = null;
/** Ends a running turn (the pill's Stop); none: the pill has no Stop. */
let stopper: ((turn: string) => void) | null = null;
/** The pill this store last gave dockState, and what it said (so an unchanged one isn't sent again). */
let lastPill: { key: string; pill: DockPill } | null = null;
let offDock: (() => void) | null = null;
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
let snap: DockStoreSnapshot = build();

function running(id: string): boolean {
  const v = turns[id];
  const w = watches.get(id);
  if (!v || !w || isEnded(v)) return false;
  return !w.knownEnded || v.lastSeq > 0 || v.summary !== null;
}

function build(): DockStoreSnapshot {
  return { questions, context, conversations, shown, turns };
}

function publish(): void {
  snap = build();
  syncPill();
  for (const fn of [...listeners]) fn();
}

/** Starts listening to dockState: an opened dock has seen the end it would have shown. */
function start(): void {
  if (started) return;
  started = true;
  offDock = subscribeDock(() => {
    if (dockSnapshot().open) unseenEnd = null;
  });
  snap = build();
}

export function dockStoreSnapshot(): DockStoreSnapshot {
  start();
  return snap;
}

export function subscribeDockStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDockStore(): DockStoreSnapshot {
  return useSyncExternalStore(subscribeDockStore, dockStoreSnapshot, dockStoreSnapshot);
}

// ---------------------------------------------------------------- the pill (dockState shows it)

/** The newest running turn watched, if any. */
function newestRunning(): string | null {
  const ids = Object.keys(turns);
  for (let i = ids.length - 1; i >= 0; i -= 1) if (running(ids[i])) return ids[i];
  return null;
}

/**
 * What the pill should say now: the oldest question, else the newest running turn, else an
 * end not yet shown; undefined: leave dockState's pill as it is (a `done` it times out itself).
 */
function wantedPill(): { key: string; pill: DockPill } | null | undefined {
  if (questions.length) {
    const title = questionTitles.get(questions[0]) ?? '';
    return { key: `question\n${questions[0]}\n${title}`, pill: { kind: 'question', text: pillQuestion(title) } };
  }
  const id = newestRunning();
  if (id) {
    const v = turns[id];
    const text = pillRunning(footerWords(turnPhase(v), workspaceName()), countersOf(v));
    const stop = stopper;
    return {
      key: `running\n${id}\n${text}\n${stop ? 'stop' : ''}`,
      pill: stop ? { kind: 'running', text, onStop: () => stop(id) } : { kind: 'running', text },
    };
  }
  if (unseenEnd) {
    const end = unseenEnd;
    unseenEnd = null;
    return { key: `done\n${end.turn}\n${end.state}`, pill: { kind: 'done', text: pillDone(end.state) } };
  }
  return dockSnapshot().pill?.kind === 'done' ? undefined : null;
}

function syncPill(): void {
  const want = wantedPill();
  if (want === undefined) return;
  const current = dockSnapshot().pill;
  if (want === null) {
    lastPill = null;
    if (current) setDockPill(null);
    return;
  }
  if (lastPill && lastPill.key === want.key && current === lastPill.pill) return;
  lastPill = want;
  setDockPill(want.pill);
}

/**
 * How the pill's Stop ends a running turn (the composer's Stop, the same request); null: the
 * pill shows no Stop.
 */
export function setTurnStopper(fn: ((turn: string) => void) | null): void {
  start();
  stopper = fn;
  publish();
}

// ---------------------------------------------------------------- questions

/**
 * A question card shows in this tab (`title`: its GateView title, for the pill): the dock
 * opens for it, without taking the keyboard (the card does) or counting as the person's choice.
 */
export function questionShown(gate: string, title: string): void {
  start();
  if (questions.includes(gate)) return;
  questions = [...questions, gate];
  questionTitles.set(gate, title);
  if (!dockSnapshot().open) openDock({ focus: false, remember: false });
  publish();
}

/** A question card closed (answered, withdrawn, timed out). */
export function questionClosed(gate: string): void {
  if (!questions.includes(gate)) return;
  questions = questions.filter((g) => g !== gate);
  questionTitles.delete(gate);
  publish();
}

/** A watched turn ended: seen when the dock is open, else the pill says so. */
function endCame(turn: string, state: EndState): void {
  unseenEnd = dockSnapshot().open ? null : { turn, state };
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
  const next = chooseConversation(conversations.list, context, readKey(STORAGE_KEYS.conv));
  if (next !== shown) {
    shown = next;
    if (next) writeKey(STORAGE_KEYS.conv, next);
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
  writeKey(STORAGE_KEYS.conv, id);
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
  return readKey(k) ?? '';
}

export function setDraft(conv: string | null, text: string): void {
  const k = draftKey(conv);
  if (text) drafts.set(k, text);
  else drafts.delete(k);
  writeKey(k, text || null);
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

function onData(id: string, events: TurnEvent[], summary?: SlimTurnSummary | TurnSummary): void {
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
  if (wasRunning && isEnded(v) && v.end) endCame(id, v.end.state);
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

/** Tests only: a fresh page (dockState has its own, resetDockForTests). */
export function resetDockStoreForTests(): void {
  for (const w of watches.values()) w.follower.close();
  watches.clear();
  drafts.clear();
  offDock?.();
  offDock = null;
  unseenEnd = null;
  stopper = null;
  lastPill = null;
  announcer?.dispose();
  announcer = null;
  questions = [];
  questionTitles.clear();
  context = { project_id: null, workspace: null };
  conversations = { state: 'idle', list: [], error: null };
  shown = null;
  picked = false;
  turns = {};
  listSeq = 0;
  started = false;
  snap = build();
}
