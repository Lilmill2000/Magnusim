/**
 * The Assistant's questions to the person (Foundation spec 6.4), held on the server.
 *
 * Two kinds: `confirm` (a compute or destructive tool asks before it runs) and `privacy`
 * (a cloud turn asks before a project's data leaves this PC). A gate is a server object:
 *
 * - it is shown where its owner can be seen. A turn bound to an app tab, or an MCP call
 *   (owner `mcp`: the tab its call ran in), is shown there through a presenter (the page
 *   relay; until a tab has a live link the presenter reaches nobody); a turn with no tab
 *   (the developer CLI) is read through the turn's long-poll and asked at the terminal. An
 *   MCP client never answers one: Magnusim asks only in its own window (phase 3 spec 3.5);
 * - only whoever can show it to the person answers it: the app tab that shows it, through
 *   its live relay link (POST /api/assistant/relay/gate), or the program that started its
 *   turn, with the turn's answer key (POST /api/assistant/gates/:id; turns.ts checks the
 *   proof). A `link_only` question is answered only in the tab. The first answer wins, and
 *   a second one is told `already`;
 * - it is never allowed by itself: after 10 minutes (or the gate's own time) it is denied
 *   (`timeout`), and the owner's Stop withdraws it (denied, `stop`). Nothing else answers
 *   it, and a tool result can't: only these routes reach answer();
 * - when a tab-bound gate can't be shown (no live link), or its link goes for 15 s, it
 *   counts as unseen (unseen(), until it is shown again) and the owner is told once (a
 *   `note` the CLI shows: "Answer here, or show the window", or for a `link_only` question,
 *   which the answer key never answers, "Show it to answer"); the gate is shown again when
 *   the tab's link returns, and stays answerable with the answer key meanwhile.
 *
 * A turn's questions show in the window that started it (its `showTab`, phase 4 spec 9.1),
 * else in its bound tab; retarget() moves a turn's open questions to another tab (a window
 * that reloaded shows them again: POST /api/assistant/turns/:id/show).
 *
 * Open and answered gates live in the Assistant's state on globalThis, so a server Vite
 * restarted in this process still answers a gate an older one opened.
 */
import { randomBytes } from 'node:crypto';
import { cleanText, TEXT_CAPS } from './sanitize.ts';
import { assistantState } from './state.ts';

/** Timers and the time, injected so tests can move them. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number): unknown {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref?.();
    return t;
  },
  clearTimeout(handle: unknown): void {
    if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export type GateKind = 'confirm' | 'privacy';
export type GateAnswer = 'allow' | 'deny';
export type GateClosedBy = 'user' | 'timeout' | 'stop';

export interface GateDetail {
  label: string;
  value: string;
}

export interface GateView {
  id: string;
  kind: GateKind;
  turn: string | null;
  /** Host-written; the untrusted parts in them are cleaned and quoted. */
  title: string;
  copy: string;
  yes: string;
  no: string;
  /** ≤ 6 rows, each part ≤ 80 characters, cleaned (e.g. Cells: 1.2 M; Time: about 4 min). */
  detail?: GateDetail[];
  risk?: 'compute' | 'destructive';
  tool?: string;
  source?: string;
  project?: { id: string; title: string };
  /** Answered only in the app tab that shows it (its relay link), never with the turn's answer key. */
  link_only?: boolean;
  opened_at: string;
  expires_at: string;
}

export type GateRequest = Omit<GateView, 'id' | 'opened_at' | 'expires_at'>;

/**
 * Whose question it is: a turn's (shown in its bound tab), or an external MCP session's
 * (phase 3 spec 3.5: shown in the app tab its call ran in, resolved at the call).
 */
export type GateOwner = { kind: 'turn'; id: string; tab: string | null } | { kind: 'mcp'; session: string; tab: string | null };

/** Shows a gate to the person (the page relay for a tab; MCP later). */
export interface GatePresenter {
  /** Shows `view`; false when it can't be shown now (its tab has no live link). */
  present(view: GateView, owner: GateOwner): boolean;
  /** The gate closed (answered, timed out or withdrawn): take it down. `closed` says how. */
  withdraw(view: GateView, owner: GateOwner, closed: { answer: GateAnswer; by: GateClosedBy }): void;
}

/** Reaches nobody: every tab-bound gate counts as unseen (the server's page relay, assistant/relay.ts, replaces it). */
export const NO_PRESENTER: GatePresenter = Object.freeze({
  present: () => false,
  withdraw: () => {},
});

export type GateEvent =
  | { type: 'open'; view: GateView; owner: GateOwner }
  | { type: 'closed'; view: GateView; owner: GateOwner; answer: GateAnswer; by: GateClosedBy }
  | { type: 'unseen'; view: GateView; owner: GateOwner; text: string };

export const GATE_TIMEOUT_MS = 10 * 60_000;
export const GATE_UNSEEN_MS = 15_000;
export const GATE_UNSEEN_NOTE =
  'The app tab that should show this question is in the background or closed. Answer here, or show the Magnusim window.';
/** The same for a question only the window answers (`link_only`): nothing can answer it where the note is read. */
export const GATE_UNSEEN_WINDOW_NOTE = 'The Magnusim window that should show this question is in the background or closed. Show it to answer.';
const DETAIL_ROWS = 6;
const DETAIL_TEXT = 80;
/** Answered gates are remembered this long (a second answer is told `already`, not `unknown`). */
const CLOSED_KEEP_MS = 60 * 60_000;
const CLOSED_KEEP_MAX = 500;

interface OpenEntry {
  state: 'open';
  view: GateView;
  owner: GateOwner;
  broker: GateBroker;
  settle(answer: GateAnswer, by: GateClosedBy): void;
  timer: unknown;
  unseenTimer: unknown;
  noted: boolean;
  /** Its tab has had no live link for the unseen wait, and it was not shown since (unseen()). */
  hidden: boolean;
}

/** A gate's own options. */
export interface AskOptions {
  /** How long it waits before it is denied (`timeout`); the broker's own when left out. */
  timeoutMs?: number;
}

interface ClosedEntry {
  state: 'closed';
  view: GateView;
  /** Kept so a late answer is checked against the same proof as an open one. */
  owner: GateOwner;
  answer: GateAnswer;
  by: GateClosedBy;
  at: number;
}

type Entry = OpenEntry | ClosedEntry;

function table(): Map<string, Entry> {
  return assistantState().gates as Map<string, Entry>;
}

/** The app tab that shows an owner's questions, a turn's or an MCP session's (null: none). */
export const tabOf = (owner: GateOwner): string | null => (typeof owner.tab === 'string' && owner.tab ? owner.tab : null);

function cleanDetail(rows: GateDetail[] | undefined): GateDetail[] | undefined {
  if (!Array.isArray(rows) || !rows.length) return undefined;
  const out = rows
    .slice(0, DETAIL_ROWS)
    .map((r) => ({ label: cleanText(r?.label, DETAIL_TEXT), value: cleanText(r?.value, DETAIL_TEXT) }))
    .filter((r) => r.label || r.value);
  return out.length ? out : undefined;
}

export interface GateBrokerOptions {
  presenter?: GatePresenter;
  clock?: Clock;
  timeoutMs?: number;
  unseenMs?: number;
}

export class GateBroker {
  private presenter: GatePresenter;
  readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly unseenMs: number;
  private readonly listeners = new Set<(e: GateEvent) => void>();

  constructor(o: GateBrokerOptions = {}) {
    this.presenter = o.presenter ?? NO_PRESENTER;
    this.clock = o.clock ?? realClock;
    this.timeoutMs = o.timeoutMs ?? GATE_TIMEOUT_MS;
    this.unseenMs = o.unseenMs ?? GATE_UNSEEN_MS;
  }

  /** The page relay (or MCP) takes over showing gates. */
  setPresenter(p: GatePresenter | null): void {
    this.presenter = p ?? NO_PRESENTER;
  }

  subscribe(fn: (e: GateEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private tell(e: GateEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        /* one listener's failure never blocks a gate */
      }
    }
  }

  /**
   * Opens a gate and waits for its answer. Resolves 'deny' on a no, after the timeout (the
   * gate's own, `o.timeoutMs`, else the broker's; its expires_at says when), or when
   * `signal` aborts (Stop); never 'allow' by itself.
   */
  ask(g: GateRequest, owner: GateOwner, signal: AbortSignal, o: AskOptions = {}): Promise<GateAnswer> {
    if (signal.aborted) return Promise.resolve('deny');
    this.sweep();
    const now = this.clock.now();
    const own = o.timeoutMs;
    const timeoutMs = typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : this.timeoutMs;
    const id = `g-${randomBytes(8).toString('hex')}`;
    const detail = cleanDetail(g.detail);
    const view: GateView = {
      id,
      kind: g.kind,
      turn: g.turn ?? null,
      title: cleanText(g.title, TEXT_CAPS.name),
      copy: cleanText(g.copy, TEXT_CAPS.other),
      yes: cleanText(g.yes, 40) || 'Allow',
      no: cleanText(g.no, 40) || "Don't",
      ...(detail ? { detail } : {}),
      ...(g.risk ? { risk: g.risk } : {}),
      ...(g.tool ? { tool: cleanText(g.tool, 64) } : {}),
      ...(g.source ? { source: cleanText(g.source, TEXT_CAPS.name) } : {}),
      ...(g.project ? { project: { id: cleanText(g.project.id, 128), title: cleanText(g.project.title, 80) } } : {}),
      ...(g.link_only === true ? { link_only: true } : {}),
      opened_at: new Date(now).toISOString(),
      expires_at: new Date(now + timeoutMs).toISOString(),
    };
    return new Promise<GateAnswer>((resolve) => {
      let done = false;
      const onAbort = () => entry.settle('deny', 'stop');
      const entry: OpenEntry = {
        state: 'open',
        view,
        owner,
        broker: this,
        noted: false,
        hidden: false,
        unseenTimer: null,
        timer: this.clock.setTimeout(() => entry.settle('deny', 'timeout'), timeoutMs),
        settle: (answer, by) => {
          if (done) return;
          done = true;
          this.clock.clearTimeout(entry.timer);
          this.clock.clearTimeout(entry.unseenTimer);
          signal.removeEventListener('abort', onAbort);
          // Its owner now: retarget() may have moved it to another tab since it opened.
          const now = entry.owner;
          // Kept as answered (a second answer is told `already`), unless a test reset dropped the table.
          const map = table();
          if (map.get(id) === entry) map.set(id, { state: 'closed', view, owner: now, answer, by, at: this.clock.now() });
          try {
            this.presenter.withdraw(view, now, { answer, by });
          } catch {
            /* the dialog goes with its page */
          }
          this.tell({ type: 'closed', view, owner: now, answer, by });
          resolve(answer);
        },
      };
      table().set(id, entry);
      signal.addEventListener('abort', onAbort, { once: true });
      this.tell({ type: 'open', view, owner });
      this.show(entry);
    });
  }

  /** Shows the gate; a tab-bound one nobody can see starts its unseen wait. */
  private show(entry: OpenEntry): void {
    let shown = false;
    try {
      shown = this.presenter.present(entry.view, entry.owner);
    } catch {
      shown = false;
    }
    if (shown) {
      this.clock.clearTimeout(entry.unseenTimer);
      entry.unseenTimer = null;
      entry.hidden = false;
    } else if (tabOf(entry.owner) !== null) {
      this.startUnseen(entry);
    }
  }

  /** The unseen wait: then the gate counts as hidden (until shown again), and its owner is told once. */
  private startUnseen(entry: OpenEntry): void {
    if (entry.unseenTimer) return;
    entry.unseenTimer = this.clock.setTimeout(() => {
      entry.unseenTimer = null;
      if (table().get(entry.view.id) !== entry) return;
      entry.hidden = true;
      if (entry.noted) return;
      entry.noted = true;
      const text = entry.view.link_only === true ? GATE_UNSEEN_WINDOW_NOTE : GATE_UNSEEN_NOTE;
      this.tell({ type: 'unseen', view: entry.view, owner: entry.owner, text });
    }, this.unseenMs);
  }

  /** Whether an open gate's tab has had no live link for the unseen wait (and has not shown it since). */
  unseen(id: string): boolean {
    const e = table().get(String(id));
    return !!e && e.state === 'open' && e.hidden;
  }

  /** A gate, open or still remembered as answered, with its owner (to check who may answer it); null when unknown. */
  lookup(id: string): { open: boolean; view: GateView; owner: GateOwner } | null {
    const e = table().get(String(id));
    return e ? { open: e.state === 'open', view: e.view, owner: e.owner } : null;
  }

  /** The person's answer, once its proof was checked (TurnManager.answerGate). The first answer wins. */
  answer(id: string, allow: boolean): 'ok' | 'already' | 'unknown' {
    const e = table().get(String(id));
    if (!e) return 'unknown';
    if (e.state === 'closed') return 'already';
    e.settle(allow === true ? 'allow' : 'deny', 'user');
    return 'ok';
  }

  /** A tab's link came back: its open gates are shown again. */
  tabLinked(tab: string): void {
    for (const e of this.openEntries()) if (tabOf(e.owner) === tab) e.broker.show(e);
  }

  /**
   * A turn's open questions move to `tab` (the window that shows them now) and are shown there:
   * answered on that tab's live link from then on, never on the tab they were on. How many moved.
   */
  retarget(turn: string, tab: string): number {
    let n = 0;
    for (const e of this.openEntries()) {
      if (e.owner.kind !== 'turn' || e.owner.id !== turn) continue;
      const before = e.owner;
      // The tab it was on (a window gone quiet may still show it) takes it down: it can't answer it now.
      if (tabOf(before) !== null && tabOf(before) !== tab) {
        try {
          e.broker.presenter.withdraw(e.view, before, { answer: 'deny', by: 'stop' });
        } catch {
          /* the dialog goes with its page */
        }
      }
      e.owner = { ...e.owner, tab };
      // Unseen again only if this tab can't show it either.
      e.broker.clock.clearTimeout(e.unseenTimer);
      e.unseenTimer = null;
      e.broker.show(e);
      n += 1;
    }
    return n;
  }

  /** A tab's link went: its open gates count as unseen after the wait. */
  tabUnlinked(tab: string): void {
    for (const e of this.openEntries()) if (tabOf(e.owner) === tab) e.broker.startUnseen(e);
  }

  private openEntries(): OpenEntry[] {
    return [...table().values()].filter((e): e is OpenEntry => e.state === 'open');
  }

  /** The open gates of a tab (to show them again). */
  pendingForTab(tab: string): GateView[] {
    return this.openEntries()
      .filter((e) => tabOf(e.owner) === tab)
      .map((e) => e.view);
  }

  /** The open gates of a turn. */
  forTurn(turn: string): GateView[] {
    return this.openEntries()
      .filter((e) => e.owner.kind === 'turn' && e.owner.id === turn)
      .map((e) => e.view);
  }

  openCount(): number {
    return this.openEntries().length;
  }

  /** How a gate was closed, while it is remembered. */
  closedAs(id: string): { answer: GateAnswer; by: GateClosedBy } | null {
    const e = table().get(id);
    return e && e.state === 'closed' ? { answer: e.answer, by: e.by } : null;
  }

  /** Forgets answered gates past their keep time (and the oldest past the cap). */
  private sweep(): void {
    const map = table();
    const now = this.clock.now();
    const closed: Array<[string, ClosedEntry]> = [];
    for (const [id, e] of map) {
      if (e.state !== 'closed') continue;
      if (now - e.at > CLOSED_KEEP_MS) map.delete(id);
      else closed.push([id, e]);
    }
    if (closed.length > CLOSED_KEEP_MAX) {
      closed.sort((a, b) => a[1].at - b[1].at);
      for (const [id] of closed.slice(0, closed.length - CLOSED_KEEP_MAX)) map.delete(id);
    }
  }
}
