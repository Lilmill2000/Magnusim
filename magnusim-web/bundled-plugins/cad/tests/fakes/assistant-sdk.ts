// A scriptable fake of ws.assistant (unreleased host API 1.9) for unit tests, the way the host's
// bridge and SDK behave (src/plugin-sdk/workspace.ts): register answers a verdict (scripted, else
// every tool accepted) and keeps the handler only when available; invoke(tool, input, {turn})
// runs the kept handler as the bridge would (no handler or a tool not accepted: no_tool), with a
// signal and progress recorded (waiting too); emitTurn tells this tab's turn listeners; stop is
// recorded and answered. `turns: false` is a host without turn events (no onTurn, no stop);
// `refuse: 'not_allowed'` a host whose bridge refuses the call. Undo from the app's panel: `docked`
// says the host has it; setUndo's offers are recorded (`undoOffers`, the latest per turn in
// `offered`), and askUndo(turn) runs the page's onUndo handler as the panel's ask would.
// `undo: false` is a host without setUndo and onUndo.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantHandler, AssistantRegistration, AssistantStopAnswer, AssistantTool, AssistantTurn, AssistantUndoAnswer, AssistantUndoOffer } from '@magnusim/workspace';

export interface FakeAssistantOptions {
  /** A host with turn events (onTurn, stop): true by default. */
  turns?: boolean;
  /** register() rejects with this code (an older host: 'not_allowed'). */
  refuse?: string;
  /** The host has its own Assistant panel (ws.assistant.docked); false by default. */
  docked?: boolean;
  /** A host with setUndo and onUndo: true by default (with the turn events). */
  undo?: boolean;
}

export interface FakeProgress {
  call: string;
  fraction: number | null;
  label?: string;
  waiting: boolean;
}

/** What a call answered: its result, or its error as the SDK sends it ({code, message, hint?, detail?}). */
export type FakeOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; hint?: string; detail?: unknown } };

export interface FakeAssistant {
  register(tools: AssistantTool[], handler: AssistantHandler | null, opts?: { guide?: string }): Promise<AssistantRegistration>;
  onTurn?(fn: (turn: AssistantTurn) => void): () => void;
  stop?(turn: string): Promise<AssistantStopAnswer>;
  /** Every register call: its tools, guide and the verdict it got. */
  readonly registrations: { tools: AssistantTool[]; guide: string | undefined; verdict: AssistantRegistration }[];
  /** Verdicts for the next register calls, oldest first (else available, every tool accepted). */
  readonly verdicts: AssistantRegistration[];
  /** The tools and handler the last available register kept. */
  readonly accepted: string[];
  /** Run a call as the bridge would; `abort` aborts its signal. */
  invoke(tool: string, input: Record<string, unknown>, o?: { turn?: string; signal?: AbortSignal; call?: string }): Promise<FakeOutcome>;
  /** Tell this tab's listeners a turn (a full AssistantTurn; missing fields get defaults). */
  emitTurn(t: Partial<AssistantTurn> & { id: string }): void;
  readonly progress: FakeProgress[];
  readonly stops: string[];
  /** stop()'s next answer. */
  stopAnswer: AssistantStopAnswer;
  readonly docked: boolean;
  setUndo?(turn: string, label: string | null): Promise<AssistantUndoOffer>;
  onUndo?(fn: ((turn: string) => AssistantUndoAnswer | Promise<AssistantUndoAnswer>) | null): () => void;
  /** Every setUndo, in order. */
  readonly undoOffers: { turn: string; label: string | null }[];
  /** The label each turn is offered with now (a withdrawal removes it). */
  readonly offered: Map<string, string>;
  /** The app's panel asks to undo that turn: the page's onUndo answer (no_handler without one). */
  askUndo(turn: string): Promise<AssistantUndoAnswer>;
}

const verdictFor = (tools: AssistantTool[]): AssistantRegistration => ({ available: true, accepted: tools.map((t) => t.name), refused: [] });

/** The SDK's error of a throw: a page code kept, else failed; hint (500) and detail as JSON makes them. */
function errorOf(e: unknown): { code: string; message: string; hint?: string; detail?: unknown } {
  const f = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; hint?: unknown; detail?: unknown };
  const code = typeof f.code === 'string' && ['invalid_input', 'busy', 'not_ready', 'failed'].includes(f.code) ? f.code : 'failed';
  const out: { code: string; message: string; hint?: string; detail?: unknown } = { code, message: typeof f.message === 'string' && f.message ? f.message : 'The tool failed.' };
  if (typeof f.hint === 'string' && f.hint) out.hint = f.hint.slice(0, 500);
  if (f.detail !== undefined && f.detail !== null) out.detail = JSON.parse(JSON.stringify(f.detail));
  return out;
}

export function createFakeAssistant(o: FakeAssistantOptions = {}): FakeAssistant {
  let handler: AssistantHandler | null = null;
  let accepted = new Set<string>();
  const listeners = new Set<(t: AssistantTurn) => void>();
  let n = 0;
  let undoHandler: ((turn: string) => AssistantUndoAnswer | Promise<AssistantUndoAnswer>) | null = null;
  const fake: FakeAssistant = {
    docked: o.docked === true,
    undoOffers: [],
    offered: new Map(),
    async askUndo(turn) {
      if (!undoHandler) return { undone: false, reason: 'no_handler' };
      return undoHandler(turn);
    },
    registrations: [],
    verdicts: [],
    get accepted() {
      return [...accepted];
    },
    progress: [],
    stops: [],
    stopAnswer: { stopped: true },
    async register(tools, h, opts) {
      if (o.refuse) throw Object.assign(new Error('This version of Magnusim has no such call'), { code: o.refuse });
      const verdict = fake.verdicts.shift() ?? verdictFor(tools);
      fake.registrations.push({ tools: [...tools], guide: opts?.guide, verdict });
      if (verdict.available) {
        handler = tools.length ? h : null;
        accepted = new Set(tools.length ? verdict.accepted : []);
      }
      return verdict;
    },
    async invoke(tool, input, io = {}) {
      const id = io.call ?? `c-${++n}`;
      if (!handler || !accepted.has(tool)) return { ok: false, error: { code: 'no_tool', message: `No tool ${tool}.` } };
      const signal = io.signal ?? new AbortController().signal;
      try {
        const out = await handler({
          call: id,
          turn: io.turn ?? '',
          tool,
          input: JSON.parse(JSON.stringify(input)),
          signal,
          progress: (fraction, label, opts) => void fake.progress.push({ call: id, fraction, ...(label ? { label } : {}), waiting: opts?.waiting === true }),
        });
        const result = (out && typeof out === 'object' ? out : typeof out === 'string' ? { text: out } : {}) as Record<string, unknown>;
        return { ok: true, result: JSON.parse(JSON.stringify(result)) };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },
    emitTurn(t) {
      const turn: AssistantTurn = {
        state: 'running',
        title: '',
        local: false,
        contextTokens: null,
        images: true,
        used: { steps: 0, stepsCap: 120, changes: 0, changesCap: 0, usd: 0, usdCap: 8 },
        ...t,
      } as AssistantTurn;
      for (const fn of [...listeners]) fn(turn);
    },
  };
  if (o.turns !== false) {
    fake.onTurn = (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    };
    fake.stop = async (turn) => {
      fake.stops.push(turn);
      return fake.stopAnswer;
    };
    if (o.undo !== false) {
      fake.setUndo = async (turn, label) => {
        fake.undoOffers.push({ turn, label });
        if (label === null) {
          fake.offered.delete(turn);
          return { offered: false };
        }
        fake.offered.set(turn, label);
        return { offered: true };
      };
      fake.onUndo = (fn) => {
        undoHandler = fn;
        return () => {
          if (undoHandler === fn) undoHandler = null;
        };
      };
    }
  }
  return fake;
}
