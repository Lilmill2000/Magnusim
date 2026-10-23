/**
 * A window follows a turn on its tab's event stream (phase 4 spec 5.1, 9.2): the hub's channel
 * kind `assistant` with params {role:'turn', turn, since}, opened through the relay's open
 * (relay.ts dispatches the role). It rides the tab's one stream, so following a turn costs no
 * connection of the browser's 6 (event-hub.ts), and a turn outlives any request.
 *
 * For this PC only (assistantAccess on both the stream and the subscribe: 403). Refused: a turn
 * id that is not one (400), a since that is not a whole number from 0 (400), a turn this server
 * doesn't keep (404), and a ninth turn channel of one tab (429). Frames to the page:
 *   snapshot {turn, events, next, ended, more, upto}   first: the turn's summary (with its
 *                                  prompt and text_so_far) and its events after `since`, at most
 *                                  500; more:true when `events` frames with the rest follow at
 *                                  once; upto: the seq they reach together (text_so_far is the
 *                                  text up to there)
 *   events {events, next}          the events logged since, in frames of at most 500, at most
 *                                  every 100 ms (the log merges streamed text into an event no
 *                                  reader has had, so a wake waits flushMs before it reads)
 *   summary {turn}                 the turn's summary without text_so_far and prompt, when its
 *                                  tab's page would hear it changed (at most once a second), and
 *                                  once more after its `end` event went out; then the channel is
 *                                  done (`_closed`). An ended turn's channel closes at once.
 * `next` is the seq of the last event sent: a window that reconnects opens a new channel with
 * since=next and gets only what it hasn't had (it drops any seq it has seen anyway).
 *
 * It reads the log as the long-poll does (eventsSince, waitFor), never Turn.subscribe, whose
 * listeners mark each chunk delivered at once and would stop the text merging.
 */
import type { ChannelMeta, ChannelOpened, ChannelSend } from '../event-hub.ts';
import { assistantAccess, REMOTE_MESSAGE } from './access.ts';
import type { Turn, TurnEvent, TurnManager, TurnSummary } from './turns.ts';

export const TURN_CHANNEL = Object.freeze({
  /** How long a wake waits before it reads, so streamed text goes as one event. */
  flushMs: 100,
  /** Events per frame. */
  perFrame: 500,
  /** Turn channels one tab may hold open. */
  perTab: 8,
});

/** The longest wait for the next event before the loop looks again (as the long-poll's). */
const WAIT_MS = 25_000;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const NO_TURN_TEXT = 'No such turn: Magnusim keeps a request while its conversation lives.';

/** A turn's summary as `summary` frames carry it: without text_so_far and prompt. */
export type SlimSummary = Omit<TurnSummary, 'text_so_far' | 'prompt'>;

export function slimSummary(t: Turn): SlimSummary {
  const s: Partial<TurnSummary> = t.summary();
  delete s.text_so_far;
  delete s.prompt;
  return s as SlimSummary;
}

/**
 * Open turn channels per tab: on globalThis, as the hub's streams and channels are, so a Vite
 * restart (a new copy of this module, the old server's channels still open) counts them all.
 */
const PER_TAB_KEY = Symbol.for('magnusim.assistant.turnChannelsPerTab');
const openPerTab: Map<string, number> = ((globalThis as Record<symbol, unknown>)[PER_TAB_KEY] as Map<string, number> | undefined) ??
  ((globalThis as Record<symbol, unknown>)[PER_TAB_KEY] = new Map<string, number>());

/** How many turn channels each tab holds open now (tests). */
export function turnChannelsOpen(): Record<string, number> {
  return Object.fromEntries(openPerTab);
}

function sinceOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^[0-9]{1,15}$/.test(v)) return Number(v);
  return null;
}

/** Opens a turn channel (relay.open for role 'turn'). */
export function openTurnChannel(manager: TurnManager, params: Record<string, unknown>, send: ChannelSend, done: () => void, meta: ChannelMeta): ChannelOpened {
  if (!assistantAccess(meta.streamReq) || !assistantAccess(meta.req)) return { ok: false, status: 403, error: REMOTE_MESSAGE };
  const id = params.turn;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, status: 400, error: 'turn is a turn id.' };
  const since = sinceOf(params.since);
  if (since === null) return { ok: false, status: 400, error: 'since is a whole number from 0.' };
  const t = manager.get(id);
  if (!t) return { ok: false, status: 404, error: NO_TURN_TEXT };
  const held = openPerTab.get(meta.tab) ?? 0;
  if (held >= TURN_CHANNEL.perTab) return { ok: false, status: 429, error: `A window follows at most ${TURN_CHANNEL.perTab} requests at once.` };
  openPerTab.set(meta.tab, held + 1);

  const clock = manager.clock;
  const abort = new AbortController();
  let closed = false;
  let flushTimer: unknown = null;
  let flushWake: (() => void) | null = null;
  let offChange: (() => void) | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    clock.clearTimeout(flushTimer);
    flushTimer = null;
    flushWake?.();
    offChange?.();
    const n = (openPerTab.get(meta.tab) ?? 1) - 1;
    if (n > 0) openPerTab.set(meta.tab, n);
    else openPerTab.delete(meta.tab);
  };

  /** Sends `events` in frames of perFrame; false once a frame can never arrive. */
  const sendEvents = (events: TurnEvent[]): boolean => {
    for (let i = 0; i < events.length; i += TURN_CHANNEL.perFrame) {
      const chunk = events.slice(i, i + TURN_CHANNEL.perFrame);
      if (!send('events', { events: chunk, next: chunk[chunk.length - 1].seq })) return false;
    }
    return true;
  };

  /**
   * Where reading goes on from after `events`, read in the same step: nothing read means nothing
   * is left up to the last seq (a dropped log, or a full log's dropped events).
   */
  const cursorAfter = (events: TurnEvent[], from: number): number => (events.length ? events[events.length - 1].seq : Math.max(from, t.lastSeq()));

  /** The turn ended and its end went out: a last summary, then the channel is done. */
  const finished = (cursor: number): boolean => {
    if (!t.ended || cursor < t.lastSeq()) return false;
    send('summary', { turn: slimSummary(t) });
    done();
    return true;
  };

  // The snapshot, before the subscribe answers.
  const first = t.eventsSince(since);
  let cursor = cursorAfter(first, since);
  const head = first.slice(0, TURN_CHANNEL.perFrame);
  const rest = first.slice(TURN_CHANNEL.perFrame);
  const ended = t.ended && cursor >= t.lastSeq();
  if (!send('snapshot', { turn: t.summary(), events: head, next: head.length ? head[head.length - 1].seq : cursor, ended, more: rest.length > 0, upto: cursor })) {
    cleanup();
    return { ok: true, cleanup };
  }
  if (rest.length && !sendEvents(rest)) {
    cleanup();
    return { ok: true, cleanup };
  }
  if (finished(cursor)) return { ok: true, cleanup };

  // What its tab's page would hear changed (at most once a second); its end's summary comes after its events.
  offChange = manager.onTurnChange((changed, change) => {
    if (changed === t && change === 'updated' && !closed) send('summary', { turn: slimSummary(t) });
  });

  /** The flush's wait: flushMs, or less once the turn ended (nothing merges after its end). */
  const flushWait = async (): Promise<void> => {
    const timer = new Promise<void>((resolve) => {
      flushWake = () => {
        flushWake = null;
        resolve();
      };
      flushTimer = clock.setTimeout(() => {
        flushTimer = null;
        flushWake?.();
      }, TURN_CHANNEL.flushMs);
    });
    let due = false;
    void timer.then(() => {
      due = true;
    });
    while (!due && !closed && !t.ended) await Promise.race([timer, t.waitFor(t.lastSeq(), WAIT_MS, abort.signal)]);
    clock.clearTimeout(flushTimer);
    flushTimer = null;
    flushWake = null;
  };

  void (async () => {
    while (!closed) {
      await t.waitFor(cursor, WAIT_MS, abort.signal);
      if (closed) return;
      if (t.lastSeq() <= cursor && !t.ended) continue;
      // Streamed text keeps merging into the newest event until someone reads it: read a little later.
      if (!t.ended) await flushWait();
      if (closed) return;
      const events = t.eventsSince(cursor);
      if (!sendEvents(events)) {
        cleanup();
        return;
      }
      cursor = cursorAfter(events, cursor);
      if (finished(cursor)) return;
    }
  })().catch(() => cleanup());

  return { ok: true, cleanup };
}
