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
 * - **Continue in a new chat** (continueInNewChat): a new conversation is shown, the earlier
 *   one's draft moves into its box, and `carry` names the earlier one until the new one's first
 *   message goes (its start sends carry_from), the person picks a conversation (or New), or the
 *   context moves.
 * - **A saved chat** (History, GET /api/assistant/history/:id): shown read only in place of a
 *   conversation, a page at a time (`saved`), until the person picks a conversation, New or
 *   Continue in a new chat (which carries it as a live one does), or the context moves.
 * - **What the page keeps** (per viewer, never needed for correctness; every read and write in
 *   try/catch): the conversation shown and each conversation's draft (sessionStorage). Open or
 *   closed is dockState's (localStorage).
 */
import { useSyncExternalStore } from 'react';
import { assistantGet, RemoteError } from '../api';
import type { ConversationRow, ConversationsAnswer, HistoryChat, HistoryPageAnswer, HistoryRequest, SlimTurnSummary, TurnEvent, TurnSummary } from '../wire';
import { LIVE_ITS_WORKSPACE, pillDone, pillQuestion, pillRunning } from './copy';
import { dockSnapshot, openDock, setDockPill, subscribeDock, type DockPill } from './dockState';
import { followTurn, type FollowSink, type TurnFollower } from './follow';
import { createAnnouncer, liveMessagesOf, type Announcer } from './live';
import { countersOf, footerWords } from './pill';
import { applyEvents, applySummary, emptyTurnView, fillDroppedText, isEnded, markGone, STILL_STOPPING_MS, turnPhase, type EndState, type TurnView } from './turnView';

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

/** The earlier conversation a new one continues (Continue in a new chat): its id, provider (the new one's too) and label. */
export interface DockCarry {
  from: string;
  provider: string;
  label: string;
}

/** A saved chat shown read only (History): its project (null: Home), what came of it, and where its next page starts. */
export interface DockSaved {
  project: string | null;
  id: string;
  state: 'loading' | 'ready' | 'error';
  chat: HistoryChat | null;
  requests: readonly HistoryRequest[];
  total: number;
  next: number | null;
  error: string | null;
}

export const HISTORY_PATH = '/api/assistant/history';
/** The History routes' project: an id, or home. */
export const historyProject = (project: string | null): string => encodeURIComponent(project ?? 'home');

export interface DockStoreSnapshot {
  /** Questions shown as cards in this tab, oldest first (their gate ids). */
  questions: readonly string[];
  context: DockContext;
  conversations: ConversationsState;
  /** The conversation shown; null: a new one. */
  shown: string | null;
  /** The new conversation shown continues this one (only while `shown` is null). */
  carry: DockCarry | null;
  /** A saved chat shown read only in place of a conversation (History), or null. */
  saved: DockSaved | null;
  /** The turns watched, by id. */
  turns: Readonly<Record<string, TurnView>>;
  /** Turns this tab started, by conversation, until the server's list names them. */
  local: Readonly<Record<string, readonly string[]>>;
  /** When this tab sent Stop for a turn (performance.now()). */
  stops: Readonly<Record<string, number>>;
}

export const CONVERSATIONS_PATH = '/api/assistant/conversations';
export const STORAGE_KEYS = Object.freeze({
  conv: 'mg.assistant.dock.conv',
  draftPrefix: 'mg.assistant.dock.draft.',
  /** {<turn>: <answer key>} of the running turns this tab started (spec 3.1, 5.4). */
  keys: 'mg.assistant.dock.keys',
  /** {<context>: <provider>}: the last pick per context (spec 2.3). */
  provider: 'mg.assistant.dock.provider',
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
let carry: DockCarry | null = null;
let saved: DockSaved | null = null;
/** Each saved chat read: an older answer than the one shown is dropped. */
let savedSeq = 0;
/** The person picked the conversation shown (or a new one) in this context. */
let picked = false;
let turns: Record<string, TurnView> = {};
let local: Record<string, string[]> = {};
let stops: Record<string, number> = {};
/** When "Stopping…" turns "Still stopping…" (the pill reads it only when the store publishes). */
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** This tab's own copies of the person's pictures (blob: URLs), by turn. */
const localPictures = new Map<string, string[]>();
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
  return { questions, context, conversations, shown, carry, saved, turns, local, stops };
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
    const sent = stops[id];
    const text = pillRunning(footerWords(turnPhase(v, sent === undefined ? null : { sentAt: sent, now: performance.now() }), workspaceName()), countersOf(v));
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
  if (!dockSnapshot().open) openDock({ focus: false });
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
export function chooseConversation(list: readonly ConversationRow[], ctx: DockContext, remembered: string | null, mine: ReadonlySet<string> = new Set()): string | null {
  // A request this tab started, still at work, wins: its conversation followed the window here
  // (after a reload too, as opening a project from Home is; its key is kept for the session).
  const working = list.find((row) => !!row.running && mine.has(row.running));
  if (working) return working.id;
  const here = list.filter((row) => sameContext(row, ctx));
  if (remembered && here.some((row) => row.id === remembered)) return remembered;
  let newest: ConversationRow | null = null;
  for (const row of here) if (!newest || Date.parse(row.last_used_at) > Date.parse(newest.last_used_at)) newest = row;
  return newest ? newest.id : null;
}

function choose(): void {
  if (picked) return;
  const next = chooseConversation(conversations.list, context, readKey(STORAGE_KEYS.conv), new Set([...keptTurns(), ...Object.values(local).flat()]));
  if (next !== shown) {
    shown = next;
    if (next) writeKey(STORAGE_KEYS.conv, next);
  }
}

/** Whether a request this tab started is still at work in conversation `conv` (or not heard of yet). */
function runningHere(conv: string | null): boolean {
  if (!conv) return false;
  return (local[conv] ?? []).some((id) => !turns[id] || !isEnded(turns[id]));
}

/**
 * Where the person is now; another project (or Home) chooses its conversation again, except
 * while a request this tab started is at work in the one shown: that request and its
 * conversation move with the window (the server moves them with the tab, core host tools spec
 * 9.4), so the dock stays on it, and reads the list again so its row says where it is now.
 * Seen live: the Assistant opened a project from Home, and the dock showed that project's
 * empty conversation, with its own request under "Elsewhere".
 */
export function setDockContext(next: DockContext): void {
  start();
  const moved = (next.project_id ?? null) !== (context.project_id ?? null);
  if (!moved && next.workspace === context.workspace) return;
  context = { project_id: next.project_id ?? null, workspace: next.workspace ?? null };
  if (moved) {
    // A conversation continues one of its own context only; a saved chat is read in its own.
    carry = null;
    saved = null;
    if (runningHere(shown)) {
      picked = true;
      void refreshConversations();
    } else {
      picked = false;
      shown = null;
      choose();
    }
  }
  publish();
}

/** The person shows a conversation (null: a new one, which carries nothing). */
export function showConversation(id: string | null): void {
  start();
  picked = true;
  shown = id;
  carry = null;
  saved = null;
  writeKey(STORAGE_KEYS.conv, id);
  publish();
}

/**
 * Continue in a new chat: a new conversation is shown that continues `from` (its first message
 * sends carry_from), with `from`'s draft moved into its box (a new conversation's draft stays
 * when `from` has none).
 */
export function continueInNewChat(from: DockCarry): void {
  start();
  const text = draftOf(from.from);
  if (text) {
    setDraft(null, text);
    setDraft(from.from, '');
  }
  picked = true;
  shown = null;
  carry = { ...from };
  saved = null;
  writeKey(STORAGE_KEYS.conv, null);
  publish();
}

/** Reads a page of the saved chat shown (from `from`); an answer for a chat no longer shown is dropped. */
async function readSaved(project: string | null, id: string, from: number): Promise<void> {
  const seq = ++savedSeq;
  let next: DockSaved;
  const had = saved && saved.id === id && saved.project === project ? saved : null;
  try {
    const page = await assistantGet<HistoryPageAnswer>(`${HISTORY_PATH}/${encodeURIComponent(id)}?project=${historyProject(project)}&from=${from}`);
    const requests = Array.isArray(page.requests) ? page.requests : [];
    next = {
      project,
      id,
      state: 'ready',
      chat: page.chat ?? had?.chat ?? null,
      requests: from > 0 && had ? [...had.requests, ...requests] : requests,
      total: typeof page.total === 'number' ? page.total : requests.length,
      next: typeof page.next === 'number' ? page.next : null,
      error: null,
    };
  } catch (err) {
    next = { project, id, state: 'error', chat: had?.chat ?? null, requests: had?.requests ?? [], total: had?.total ?? 0, next: had?.next ?? null, error: err instanceof Error ? err.message : String(err) };
  }
  if (seq !== savedSeq || !saved || saved.id !== id || saved.project !== project) return;
  saved = next;
  publish();
}

/** History: a saved chat of `project` (null: Home) is shown read only, in place of a conversation. */
export function showSavedChat(project: string | null, id: string): Promise<void> {
  start();
  picked = true;
  shown = null;
  carry = null;
  saved = { project, id, state: 'loading', chat: null, requests: [], total: 0, next: null, error: null };
  writeKey(STORAGE_KEYS.conv, null);
  publish();
  return readSaved(project, id, 0);
}

/** The saved chat shown: its next page. */
export function moreSavedChat(): Promise<void> {
  if (!saved || saved.next === null || saved.state === 'loading') return Promise.resolve();
  const { project, id, next } = saved;
  saved = { ...saved, state: 'loading' };
  publish();
  return readSaved(project, id, next);
}

/** Clear history of `project` went through: a saved chat of it shown is gone (a new conversation shows). */
export function historyCleared(project: string | null): void {
  if (!saved || saved.project !== project) return;
  saved = null;
  shown = null;
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
  if (next.state === 'ready') {
    // A turn of this tab's the list names now is the list's.
    for (const row of next.list) {
      const mine = local[row.id];
      if (!mine) continue;
      const left = mine.filter((t) => !row.turns.some((x) => x.id === t));
      local = { ...local };
      if (left.length) local[row.id] = left;
      else delete local[row.id];
    }
    choose();
  }
  publish();
}

// ---------------------------------------------------------------- what this tab started

/** A turn this tab started: shown in its conversation until the list names it. */
export function addLocalTurn(conv: string, turn: string): void {
  start();
  const have = local[conv] ?? [];
  if (have.includes(turn)) return;
  local = { ...local, [conv]: [...have, turn] };
  publish();
}

/** This tab sent Stop for a turn (the footer reads "Stopping…" until its end). */
export function markStopSent(turn: string): void {
  stops = { ...stops, [turn]: performance.now() };
  const had = stopTimers.get(turn);
  if (had) clearTimeout(had);
  stopTimers.set(
    turn,
    setTimeout(() => {
      stopTimers.delete(turn);
      if (stops[turn] !== undefined) publish();
    }, STILL_STOPPING_MS + 20),
  );
  publish();
}

/** The Stop didn't reach the server: the request isn't stopping (the footer and pill say what it does). */
export function clearStopSent(turn: string): void {
  const t = stopTimers.get(turn);
  if (t) clearTimeout(t);
  stopTimers.delete(turn);
  if (stops[turn] === undefined) return;
  const next = { ...stops };
  delete next[turn];
  stops = next;
  publish();
}

/** Keeps this tab's own copies of a turn's pictures (blob: URLs) for its transcript. */
export function setLocalPictures(turn: string, urls: string[]): void {
  if (urls.length) localPictures.set(turn, urls);
}

export function localPicturesOf(turn: string): readonly string[] | undefined {
  return localPictures.get(turn);
}

function dropLocalPictures(turn: string): void {
  const urls = localPictures.get(turn);
  if (!urls) return;
  localPictures.delete(turn);
  for (const u of urls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* already gone */
    }
  }
}

function readKeys(): Record<string, string> {
  try {
    const raw = readKey(STORAGE_KEYS.keys);
    const j = raw ? (JSON.parse(raw) as unknown) : null;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** The answer key of a turn this tab started (only to show its questions here again after a reload). */
export function keepAnswerKey(turn: string, key: string): void {
  writeKey(STORAGE_KEYS.keys, JSON.stringify({ ...readKeys(), [turn]: key }));
}

export function answerKeyOf(turn: string): string | null {
  return readKeys()[turn] ?? null;
}

/** The turn ended: its key is of no more use. */
export function dropAnswerKey(turn: string): void {
  const keys = readKeys();
  if (!(turn in keys)) return;
  delete keys[turn];
  writeKey(STORAGE_KEYS.keys, Object.keys(keys).length ? JSON.stringify(keys) : null);
}

/** The turns this tab started that it may still show (their keys), for a reload. */
export function keptTurns(): string[] {
  return Object.keys(readKeys());
}

/**
 * Whether a request this tab started may be working in its workspace now: running and bound to a
 * tab, or just started and not heard of yet (its relay `turn` frame may still be on its way).
 * Undo of an earlier request waits for it.
 */
export function startedHereRunning(): boolean {
  const ids = new Set([...keptTurns(), ...Object.values(local).flat()]);
  for (const id of ids) {
    const v = turns[id];
    if (!v) continue;
    if (!v.summary ? !isEnded(v) : running(id) && v.summary.tab !== null) return true;
  }
  return false;
}

/** The provider picked last in a context (null: none kept). */
export function pickedProvider(ctx: string): string | null {
  try {
    const raw = readKey(STORAGE_KEYS.provider);
    const j = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const v = j && typeof j === 'object' ? j[ctx] : null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function setPickedProvider(ctx: string, id: string): void {
  let j: Record<string, unknown> = {};
  try {
    const raw = readKey(STORAGE_KEYS.provider);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
  } catch {
    j = {};
  }
  writeKey(STORAGE_KEYS.provider, JSON.stringify({ ...j, [ctx]: id }));
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

function onData(id: string, events: TurnEvent[], summary?: SlimTurnSummary | TurnSummary, textSoFar?: string): void {
  const w = watches.get(id);
  const before = turns[id];
  if (!w || !before) return;
  const wasRunning = running(id);
  let v = applyEvents(before, events);
  if (summary) {
    v = applySummary(v, summary);
    if (typeof (summary as TurnSummary).text_so_far === 'string') v = fillDroppedText(v, (summary as TurnSummary).text_so_far);
  }
  // A snapshot's, once the events it covers all came (follow.ts holds it until then).
  if (typeof textSoFar === 'string') v = fillDroppedText(v, textSoFar);
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
  if (isEnded(v)) dropAnswerKey(id);
  publish();
}

/** Follows a turn (once: watching it again changes nothing). */
export function watchTurn(id: string, o: WatchOptions = {}): void {
  start();
  if (watches.has(id)) return;
  setTurn(id, emptyTurnView(id));
  const sink: FollowSink = {
    data: (d) => onData(id, d.events, d.summary, d.textSoFar),
    stopped: (why) => {
      // A record the server no longer keeps: its key is of no more use.
      if (why === 'gone') dropAnswerKey(id);
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
  dropLocalPictures(id);
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
  carry = null;
  saved = null;
  savedSeq = 0;
  picked = false;
  turns = {};
  local = {};
  stops = {};
  for (const t of stopTimers.values()) clearTimeout(t);
  stopTimers.clear();
  for (const id of [...localPictures.keys()]) dropLocalPictures(id);
  listSeq = 0;
  started = false;
  snap = build();
}
