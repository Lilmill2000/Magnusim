/**
 * Following a turn's log from the page (phase 4 spec 5.1-5.3, 5.5).
 *
 * - **The turn channel.** A channel on the tab's one event stream (hub kind `assistant`, params
 *   {role:'turn', turn, since}): no new connection. Its `snapshot` brings the events after
 *   `since` (at most 500; `more` when `events` frames follow at once), then `events` frames as
 *   the log grows and `summary` frames when the turn changes. The server ends it once the `end`
 *   event went out.
 * - **Replay by seq.** The follower keeps the newest `seq` it handed on (`lastSeq`). When the
 *   tab's stream drops, the hub gives every channel `error` and would ask for it again with its
 *   original `since`: the follower closes that channel and opens a new one from `lastSeq`
 *   instead. Whatever still comes twice is dropped by seq (turnView.ts).
 * - **Refusals.** 404: the turn's record is gone (`gone`). 403: not for this page (remote access):
 *   the follower stops. 400 (an older server with no turn role) or three refusals in a row (a
 *   full tab, 429): the long-poll instead. Any other refusal is tried again after RETRY_MS.
 * - **The long-poll fallback.** GET /api/assistant/turns/:id?since=&wait_ms=: one request in flight
 *   for the whole tab (at most one connection more), waiting (POLL_WAIT_MS) only for the
 *   running turn shown (setShownTurn); any other turn gets one read that doesn't wait.
 * - **Pins.** The channel is pinned (the tab's stream kept while it is hidden) while the turn
 *   runs or someone holds a keep (a question card of it, a Stop waiting for its answer), and
 *   unpinned once it ended, so a hidden tab with only ended turns lets its stream go.
 * - **At most MAX_TURN_CHANNELS** turn channels are open at once (the server refuses the ninth
 *   of a tab); a follower waits for a free one in turn.
 * - **The end.** An `end` event, a snapshot or long-poll answer saying `ended`, or a 404 ends the
 *   follower: its channel closes and its slot is free. On a channel the `end` event is followed
 *   by the turn's last summary (its final counters and cost): the follower, unpinned, waits for
 *   it (at most END_GRACE_MS) unless a summary that said the end came already. A summary that
 *   says the turn ended while its `end` event hasn't come is followed, after END_GRACE_MS, by
 *   one read that doesn't wait (the server ends the channel without a frame the page hears).
 */
import { openChannel, type ChannelHandle } from '../../api/eventHub';
import { AssistantApiError, assistantGet } from '../api';
import type { SlimTurnSummary, TurnChannelFrameData, TurnEvent, TurnPollAnswer, TurnState, TurnSummary } from '../wire';

/** A failed subscribe is asked again after this long. */
export const RETRY_MS = 1000;
/** This many refusals in a row and the follower takes the long-poll. */
export const FAILS_BEFORE_POLL = 3;
/** The long-poll's wait (the route's maximum). */
export const POLL_WAIT_MS = 25_000;
/** A long-poll that failed is sent again after this long. */
export const POLL_RETRY_MS = 2000;
/**
 * On the long-poll, a running turn that isn't the one shown (another conversation's, one
 * "Elsewhere") is read again this often without waiting, so its end still comes (the pill, its
 * answer key and the link's hold go with it).
 */
export const POLL_BACKGROUND_MS = 10_000;
/** Turn channels open at once (the server's per-tab limit). */
export const MAX_TURN_CHANNELS = 8;
/** After a summary said the turn ended, its `end` event is waited for this long, then read. */
export const END_GRACE_MS = 2000;

const TERMINAL: ReadonlySet<TurnState> = new Set(['done', 'stopped', 'failed', 'capped']);

/** The channel's name for a turn's events after `since`. */
export function turnChannelUrl(turn: string, since: number): string {
  return `/api/assistant/events?role=turn&turn=${encodeURIComponent(turn)}&since=${Math.max(0, Math.floor(since))}`;
}

/** What a follower hands on: in order, each piece once it came (events may repeat: drop by seq). */
export interface FollowSink {
  /**
   * A snapshot, frame or long-poll answer: its events (may be empty) and the summary that came
   * with it (a snapshot's and a long-poll's are the full summary, with `prompt` and
   * `text_so_far`; a `summary` frame's is slim). A snapshot with more to come hands its
   * `text_so_far` on as `textSoFar` with the frame that reaches its `upto`, never before: the
   * text the log dropped is told from what came only once all the snapshot's events did.
   */
  data(d: { events: TurnEvent[]; summary?: SlimTurnSummary | TurnSummary; textSoFar?: string }): void;
  /** The follower stopped: 'ended' (the turn ended), 'gone' (404), 'refused' (403). */
  stopped(why: 'ended' | 'gone' | 'refused'): void;
}

export type FollowMode = 'queued' | 'channel' | 'poll' | 'done';

export interface TurnFollower {
  readonly id: string;
  readonly mode: FollowMode;
  /** The newest seq handed on. */
  readonly lastSeq: number;
  /** Whether its channel is pinned now. */
  readonly pinned: boolean;
  /** Keeps the channel pinned until the answer is called (a card of the turn, a Stop waiting). */
  keep(): () => void;
  /** Stops following (no `stopped` call). */
  close(): void;
}

export interface FollowOptions {
  /** The newest seq the page already has (0: the whole log). */
  since?: number;
  /** The page knows the turn ended already: no pin, and no long-poll that waits. */
  ended?: boolean;
}

// ---------------------------------------------------------------- the tab's slots and its long-poll

let openChannels = 0;
const queued: Follower[] = [];
const pollers = new Set<Follower>();
let shownTurn: string | null = null;
let inFlight: { f: Follower; waits: boolean; ctl: AbortController } | null = null;

function takeSlot(f: Follower): boolean {
  if (openChannels < MAX_TURN_CHANNELS) {
    openChannels += 1;
    return true;
  }
  if (!queued.includes(f)) queued.push(f);
  return false;
}

function freeSlot(): void {
  openChannels = Math.max(0, openChannels - 1);
  while (queued.length && openChannels < MAX_TURN_CHANNELS) {
    const next = queued.shift() as Follower;
    if (next.mode !== 'queued') continue;
    openChannels += 1;
    next.startChannel();
  }
}

/** The running turn the dock shows: the long-poll waits only for it. */
export function setShownTurn(id: string | null): void {
  if (shownTurn === id) return;
  shownTurn = id;
  // Those no longer shown are read now and then instead of waited for.
  for (const f of pollers) if (f.id !== id) f.readLater();
  kickPoll();
}

function pollJob(): { f: Follower; waits: boolean } | null {
  const now = Date.now();
  for (const f of pollers) if (f.needsRead && f.retryAt <= now) return { f, waits: false };
  for (const f of pollers) if (f.id === shownTurn && f.running && f.retryAt <= now) return { f, waits: true };
  return null;
}

/** Starts the next read when none is in flight; ends a waiting one that is no longer wanted. */
function kickPoll(): void {
  if (inFlight) {
    const want = pollJob();
    if (inFlight.waits && (!want || want.f !== inFlight.f || !want.waits)) inFlight.ctl.abort();
    return;
  }
  const job = pollJob();
  if (!job) return;
  const ctl = new AbortController();
  inFlight = { ...job, ctl };
  void job.f.read(job.waits, ctl.signal).finally(() => {
    inFlight = null;
    kickPoll();
  });
}

// ---------------------------------------------------------------- one turn

class Follower implements TurnFollower {
  mode: FollowMode = 'queued';
  lastSeq: number;
  running: boolean;
  /** A long-poll read that doesn't wait is due. */
  needsRead = false;
  /** No long-poll read before this (ms, Date.now()). */
  retryAt = 0;
  private ch: ChannelHandle | null = null;
  private fails = 0;
  private keeps = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedNow = false;
  /** A summary that says the turn ended came (its last one, or near it). */
  private endSummary = false;
  /** The `end` event came on the channel: its last summary is waited for. */
  private awaitingLast = false;
  /** A snapshot's text_so_far, held until the frames after it reach its upto. */
  private pendingText: { text: string; upto: number } | null = null;

  constructor(
    readonly id: string,
    private readonly sink: FollowSink,
    o: FollowOptions,
  ) {
    this.lastSeq = Math.max(0, Math.floor(o.since ?? 0));
    this.running = o.ended !== true;
    if (takeSlot(this)) this.startChannel();
  }

  get pinned(): boolean {
    return this.pinnedNow;
  }

  keep(): () => void {
    if (this.mode === 'done') return () => undefined;
    this.keeps += 1;
    this.updatePin();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.keeps -= 1;
      this.updatePin();
    };
  }

  close(): void {
    this.finish(null);
  }

  // ------------------------------------------------------------ the channel

  startChannel(): void {
    if (this.mode === 'done') return;
    this.mode = 'channel';
    const ch = openChannel(turnChannelUrl(this.id, this.lastSeq));
    this.ch = ch;
    this.pinnedNow = false;
    const on = <K extends keyof TurnChannelFrameData>(type: K, fn: (d: TurnChannelFrameData[K]) => void) =>
      ch.addEventListener(type, (ev) => {
        if (this.ch !== ch) return;
        let d: TurnChannelFrameData[K] | null = null;
        try {
          d = JSON.parse(String(ev.data)) as TurnChannelFrameData[K];
        } catch {
          d = null;
        }
        if (!d || typeof d !== 'object') return;
        this.fails = 0;
        fn(d);
      });
    on('snapshot', (d) => {
      this.pendingText = null;
      if (d.more && d.turn && typeof d.turn === 'object') {
        // The rest of its events follow: its text_so_far is read against them all, not this head.
        const { text_so_far: text, ...rest } = d.turn;
        if (typeof text === 'string' && typeof d.upto === 'number') this.pendingText = { text, upto: d.upto };
        this.hand(d.events, rest as SlimTurnSummary);
      } else this.hand(d.events, d.turn);
      // Ended with more to come: its end is in the `events` frames that follow (its summary
      // says it ended, so it is read after a moment if they never come).
      if (d.ended && !d.more) this.ended();
    });
    on('events', (d) => this.hand(d.events));
    on('summary', (d) => this.hand([], d.turn));
    ch.addEventListener('error', () => {
      if (this.ch !== ch) return;
      this.channelError(ch);
    });
    this.updatePin();
  }

  private channelError(ch: ChannelHandle): void {
    if (ch.readyState !== ch.CLOSED) {
      // The tab's stream dropped: a new channel from what came, not the hub's re-ask from the start.
      this.dropChannel();
      this.startChannel();
      return;
    }
    const status = ch.refusal?.status ?? 0;
    this.ch = null;
    this.pinnedNow = false;
    if (status === 404) return this.finish('gone');
    if (status === 403) return this.finish('refused');
    this.fails += 1;
    if (status === 400 || this.fails >= FAILS_BEFORE_POLL) return this.toPoll();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.mode === 'channel' && !this.ch) this.startChannel();
    }, RETRY_MS);
  }

  private dropChannel(): void {
    const ch = this.ch;
    this.ch = null;
    this.pinnedNow = false;
    if (ch) {
      ch.pin(false);
      ch.close();
    }
  }

  private updatePin(): void {
    const want = this.mode !== 'done' && (this.running || this.keeps > 0);
    if (!this.ch || this.ch.readyState === this.ch.CLOSED || want === this.pinnedNow) return;
    this.pinnedNow = want;
    this.ch.pin(want);
  }

  // ------------------------------------------------------------ the long-poll

  private toPoll(): void {
    this.dropChannel();
    const idx = queued.indexOf(this);
    if (idx >= 0) queued.splice(idx, 1);
    if (this.mode === 'channel') freeSlot();
    this.mode = 'poll';
    this.needsRead = true;
    pollers.add(this);
    kickPoll();
  }

  /** One read of the log (`waits`: the long-poll of the running turn shown). Never throws. */
  async read(waits: boolean, signal: AbortSignal): Promise<void> {
    this.needsRead = false;
    let answer: TurnPollAnswer;
    try {
      answer = await assistantGet<TurnPollAnswer>(
        `/api/assistant/turns/${encodeURIComponent(this.id)}`,
        { since: String(this.lastSeq), wait_ms: String(waits ? POLL_WAIT_MS : 0) },
        signal,
      );
    } catch (err) {
      if (this.mode === 'done') return;
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Ended here (another read is wanted first, or another turn is shown): no wait.
        return;
      }
      if (err instanceof AssistantApiError && err.status === 404) return this.finish('gone');
      if (err instanceof AssistantApiError && err.status === 403) return this.finish('refused');
      this.needsRead = !waits;
      this.retryAt = Date.now() + POLL_RETRY_MS;
      setTimeout(kickPoll, POLL_RETRY_MS);
      return;
    }
    if (this.mode === 'done') return;
    this.retryAt = 0;
    this.hand(Array.isArray(answer.events) ? answer.events : [], answer.turn);
    // The server logs a turn's end in the step that ends it: a read that says it ended has it all.
    if (answer.ended || (answer.turn && TERMINAL.has(answer.turn.state))) this.ended();
    else if (!waits) this.readLater();
  }

  /** A running turn not shown: read again after POLL_BACKGROUND_MS (the shown one's wait reads it as it comes). */
  readLater(): void {
    if (this.backgroundTimer || (this.mode as FollowMode) !== 'poll' || !this.running) return;
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (this.mode !== 'poll' || !this.running) return;
      if (this.id !== shownTurn) this.needsRead = true;
      kickPoll();
    }, POLL_BACKGROUND_MS);
  }

  // ------------------------------------------------------------ what came

  private hand(events: TurnEvent[] | undefined, summary?: SlimTurnSummary | TurnSummary): void {
    if (this.mode === 'done') return;
    const list = Array.isArray(events) ? events : [];
    for (const e of list) if (e && typeof e.seq === 'number' && e.seq > this.lastSeq) this.lastSeq = e.seq;
    const held = this.pendingText;
    const textSoFar = held && this.lastSeq >= held.upto ? held.text : undefined;
    if (textSoFar !== undefined) this.pendingText = null;
    this.sink.data({ events: list, ...(summary && typeof summary === 'object' ? { summary } : {}), ...(textSoFar !== undefined ? { textSoFar } : {}) });
    // The sink may have stopped following it.
    if ((this.mode as FollowMode) === 'done') return;
    const terminal = !!summary && TERMINAL.has(summary.state);
    if (terminal) this.endSummary = true;
    if (this.awaitingLast && summary) {
      this.ended();
      return;
    }
    if (list.some((e) => e && e.type === 'end')) {
      // On a channel the turn's last summary follows its end: wait for it (not when one came).
      if (this.mode === 'channel' && !this.endSummary) this.awaitLastSummary();
      else this.ended();
      return;
    }
    if (terminal) this.endingWithoutEnd();
    else if (summary && !this.running) {
      this.running = true;
      this.updatePin();
    }
  }

  /** The `end` event came: unpinned, the turn's last summary is waited for, at most END_GRACE_MS. */
  private awaitLastSummary(): void {
    this.running = false;
    this.awaitingLast = true;
    this.updatePin();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.ended();
    }, END_GRACE_MS);
  }

  /** A summary said the turn ended before its `end` event came: read what is left in a moment. */
  private endingWithoutEnd(): void {
    this.running = false;
    this.updatePin();
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.mode === 'done') return;
      if (this.mode === 'poll') {
        this.needsRead = true;
        kickPoll();
        return;
      }
      // The channel may have been ended without a frame the page hears: one read, as the
      // long-poll's (one request in flight for the tab).
      this.toPoll();
    }, END_GRACE_MS);
  }

  private ended(): void {
    this.running = false;
    this.finish('ended');
  }

  private finish(why: 'ended' | 'gone' | 'refused' | null): void {
    if (this.mode === 'done') return;
    const hadSlot = this.mode === 'channel';
    const idx = queued.indexOf(this);
    if (idx >= 0) queued.splice(idx, 1);
    this.mode = 'done';
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.retryTimer = null;
    this.graceTimer = null;
    this.backgroundTimer = null;
    this.dropChannel();
    if (hadSlot) freeSlot();
    if (pollers.delete(this)) {
      if (inFlight?.f === this) inFlight.ctl.abort();
      kickPoll();
    }
    if (why) this.sink.stopped(why);
  }
}

/** Follows turn `id` from `o.since`, handing what comes to `sink`. */
export function followTurn(id: string, sink: FollowSink, o: FollowOptions = {}): TurnFollower {
  return new Follower(id, sink, o);
}

/** Tests only: no channels, no long-poll, nothing shown. */
export function resetFollowForTests(): void {
  openChannels = 0;
  queued.length = 0;
  pollers.clear();
  shownTurn = null;
  inFlight?.ctl.abort();
  inFlight = null;
}

/** Tests and diagnostics: the tab's turn channels open, followers waiting, and long-poll followers. */
export function followState(): { channels: number; queued: number; pollers: number; polling: string | null } {
  return { channels: openChannels, queued: queued.length, pollers: pollers.size, polling: inFlight ? inFlight.f.id : null };
}
