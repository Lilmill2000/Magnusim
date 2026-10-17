/**
 * The Assistant's questions to the person (Foundation spec 6.4), held on the server.
 *
 * Two kinds: `confirm` (a compute or destructive tool asks before it runs) and `privacy`
 * (a cloud turn asks before a project's data leaves this PC). A gate is a server object:
 *
 * - it is shown where its owner can be seen. A turn bound to an app tab is shown there
 *   through a presenter (the page relay; until a tab has a live link the presenter
 *   reaches nobody); a turn with no tab (the developer CLI) is read through the turn's
 *   long-poll and asked at the terminal. A later MCP server maps it to its own prompt;
 * - only whoever can show it to the person answers it: the app tab that shows it, through
 *   its live relay link (POST /api/assistant/relay/gate), or the program that started its
 *   turn, with the turn's answer key (POST /api/assistant/gates/:id; turns.ts checks the
 *   proof). A `link_only` question is answered only in the tab. The first answer wins, and
 *   a second one is told `already`;
 * - it is never allowed by itself: after 10 minutes it is denied (`timeout`), and the
 *   owner's Stop withdraws it (denied, `stop`). Nothing else answers it, and a tool
 *   result can't: only these routes reach answer();
 * - when a tab-bound gate can't be shown (no live link), or its link goes for 15 s, the
 *   owner is told once (a `note` the CLI shows); the gate is shown again when the tab's
 *   link returns, and stays answerable with the answer key meanwhile.
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

export type GateOwner = { kind: 'turn'; id: string; tab: string | null } | { kind: 'mcp'; session: string };

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

/** The app tab that shows an owner's questions (null: none). */
export const tabOf = (owner: GateOwner): string | null => (owner.kind === 'turn' ? owner.tab : null);

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
  private readonly clock: Clock;
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
   * Opens a gate and waits for its answer. Resolves 'deny' on a no, after the timeout,
   * or when `signal` aborts (Stop); never 'allow' by itself.
   */
  ask(g: GateRequest, owner: GateOwner, signal: AbortSignal): Promise<GateAnswer> {
    if (signal.aborted) return Promise.resolve('deny');
    this.sweep();
    const now = this.clock.now();
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
      expires_at: new Date(now + this.timeoutMs).toISOString(),
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
        unseenTimer: null,
        timer: this.clock.setTimeout(() => entry.settle('deny', 'timeout'), this.timeoutMs),
        settle: (answer, by) => {
          if (done) return;
          done = true;
          this.clock.clearTimeout(entry.timer);
          this.clock.clearTimeout(entry.unseenTimer);
          signal.removeEventListener('abort', onAbort);
          // Kept as answered (a second answer is told `already`), unless a test reset dropped the table.
          const map = table();
          if (map.get(id) === entry) map.set(id, { state: 'closed', view, owner, answer, by, at: this.clock.now() });
          try {
            this.presenter.withdraw(view, owner, { answer, by });
          } catch {
            /* the dialog goes with its page */
          }
          this.tell({ type: 'closed', view, owner, answer, by });
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
    } else if (tabOf(entry.owner) !== null) {
      this.startUnseen(entry);
    }
  }

  private startUnseen(entry: OpenEntry): void {
    if (entry.noted || entry.unseenTimer) return;
    entry.unseenTimer = this.clock.setTimeout(() => {
      entry.unseenTimer = null;
      if (table().get(entry.view.id) !== entry || entry.noted) return;
      entry.noted = true;
      this.tell({ type: 'unseen', view: entry.view, owner: entry.owner, text: GATE_UNSEEN_NOTE });
    }, this.unseenMs);
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
