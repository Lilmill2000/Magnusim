// When the Part can answer the Assistant (CAD tools spec §3.0, §8.4): not ready (still loading,
// unreadable, the kernel starting or stopped, a local model's context too small), and what the
// person is doing in the Part right now, in words ("editing Sketch 2; features after it show
// rolled back"). Reads never wait for the person; they wait up to 30 s for the Part to open and
// the kernel to start, with a sign of life every 5 s.
// Edits wait for the person instead of failing (§8.4): while the rollback bar is not at the end,
// a panel, a typed value, a menu, a rename, a dialog or a toolbar drag of the person's is open,
// or the Assistant is paused in this Part, an edit holds (the chip says why, progress says
// `waiting`, so the turn's minutes stop) and goes on the moment the person is done, checked again
// on every change of the stores behind those signals; after 10 minutes it answers busy. A pointer
// held in the frame, or input under 800 ms ago, is a soft wait: until 800 ms of quiet, at most 10 s.
// The pause (Pause on the chip, a take-over, the person's undo or redo of the Assistant's steps
// while a turn runs) ends with its turn, or at the next key on a host without the turn events
// (an outside client's session that went on only because the person changed the Part is the
// same key for it). A turn that has ended takes no pause. A step already running when the
// person pauses waits at its next pace point (waitWhilePaused) until they resume.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { pendingEditLabel, pendingEdits, subscribePendingEdits } from '../lib/pendingEdits';
import { openModal } from '../lib/modal';
import type { AppServices } from '../types/app';
import type { CallCtx, TurnFacts } from '../types/assistant';
import { uiFor } from '../ui/controller';
import { ToolError } from './errors';
import { ownRollbackBlock } from './own-rollback';
import { runtimeOf, type AssistantRuntime } from './runtime';
import { MIN_LOCAL_CONTEXT } from './turn-info';

/** The longest a read waits for the Part to open and the kernel to start. */
export const READ_WAIT_MS = 30_000;
/** A sign of life this often while a call waits. */
export const HEARTBEAT_MS = 5_000;

/** Why the Part cannot answer a read now (a ToolError), or null. `waitable`: it may still come (loading, starting). */
export function readBlock(services: AppServices, turn: TurnFacts | null): { error: ToolError; waitable: boolean } | null {
  if (turn?.local && turn.contextTokens !== null && turn.contextTokens < MIN_LOCAL_CONTEXT) {
    return {
      waitable: false,
      error: new ToolError('small_context', `The local model's context is ${turn.contextTokens} tokens; the CAD tools need at least ${MIN_LOCAL_CONTEXT}.`, {
        detail: { context_tokens: turn.contextTokens, needed: MIN_LOCAL_CONTEXT },
      }),
    };
  }
  const d = services.doc.state.get();
  if (d.status === 'loading') return { waitable: true, error: new ToolError('loading', 'The Part is still loading.') };
  if (d.status === 'error') return { waitable: false, error: new ToolError('not_editable', d.error || 'The Part could not be read.') };
  const k = services.kernel.status.get();
  if (k.state === 'idle' || k.state === 'starting' || k.state === 'restarting') return { waitable: true, error: new ToolError('kernel_starting', 'The geometry kernel is still starting.') };
  if (k.state === 'failed' || k.state === 'closed') return { waitable: false, error: new ToolError('kernel_failed', `The geometry kernel stopped${k.message ? `: ${k.message}` : '.'}`) };
  return null;
}

/**
 * Wait (≤ READ_WAIT_MS) until a read can run; throws its ToolError when it cannot. Driven by the
 * document's and the kernel's stores; the timers are only the cap and the sign of life.
 */
export async function waitForRead(ctx: CallCtx): Promise<void> {
  let block = readBlock(ctx.services, ctx.turn);
  if (!block) return;
  if (!block.waitable) throw block.error;
  const { doc, kernel } = ctx.services;
  await new Promise<void>((resolve, reject) => {
    const offs: (() => void)[] = [];
    const done = (err?: unknown) => {
      for (const off of offs.splice(0)) off();
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      block = readBlock(ctx.services, ctx.turn);
      if (!block) done();
      else if (!block.waitable) done(block.error);
    };
    offs.push(doc.state.subscribe(check), kernel.status.subscribe(check));
    const cap = setTimeout(() => done(block?.error), READ_WAIT_MS);
    const beat = setInterval(() => ctx.progress(null, 'Waiting for the Part to open'), HEARTBEAT_MS);
    const abort = () => done(ctx.signal.reason ?? new DOMException('The call was stopped', 'AbortError'));
    ctx.signal.addEventListener('abort', abort, { once: true });
    offs.push(
      () => clearTimeout(cap),
      () => clearInterval(beat),
      () => ctx.signal.removeEventListener('abort', abort),
    );
    check();
  });
}

/**
 * `work` with a sign of life every HEARTBEAT_MS while it runs (the host's stall window counts from
 * the last progress, and a hidden tab's timers still fire at least once a minute; the tools'
 * windows are 30 s or more).
 */
export async function heartbeat<T>(ctx: Pick<CallCtx, 'progress'>, work: Promise<T>, label?: string): Promise<T> {
  const beat = setInterval(() => ctx.progress(null, label), HEARTBEAT_MS);
  try {
    return await work;
  } finally {
    clearInterval(beat);
  }
}

const featureName = (services: AppServices, id: string) => services.doc.state.get().doc.features.find((f) => f.id === id)?.name ?? 'a feature';

/** What the person does that an edit waits for: the reason it would answer after the wait, the words, and the chip's note. */
export interface PersonBlock {
  reason: 'rolled_back' | 'person_editing';
  /** "editing Fillet 2", "the rollback bar is after Sketch 1, not at the end". */
  words: string;
  /** What the chip asks of the person: "close the Fillet 2 panel", "move the rollback bar to the end". */
  note: string;
}

/** The toolbar's class while the person drags a button to another place (ui/Toolbar.tsx). */
const TOOLBAR_DRAG = '.cad-tb-drag';

/**
 * What the person is doing in the Part that an edit would have to wait for, or null. In order: the
 * rollback bar above the end; a panel of theirs (an idle Parameters panel does not count); a value
 * typed and not applied; a rename; a menu; a dialog; a toolbar button being dragged.
 */
export function personBlock(services: AppServices): PersonBlock | null {
  const s = services.doc.state.get();
  const { rollback } = s.view;
  if (rollback !== null && rollback < s.doc.features.length) {
    const last = rollback > 0 ? s.doc.features[rollback - 1]?.name : null;
    return { reason: 'rolled_back', words: `the rollback bar is ${last ? `after ${last}` : 'at the top'}, not at the end`, note: 'move the rollback bar to the end' };
  }
  const busy = (words: string, note: string): PersonBlock => ({ reason: 'person_editing', words, note });
  const ui = uiFor(services).state.get();
  const p = ui.panel;
  if (p && p.owner === 'person') {
    if (p.kind === 'feature') {
      const name = featureName(services, p.feature);
      return busy(p.type === 'sketch' ? `editing ${name}; features after it show rolled back` : `editing ${name}`, `close the ${name} panel`);
    }
    if (p.kind === 'tool') {
      const label = services.modules?.tool(p.tool)?.label ?? 'tool';
      return busy(`using the ${label} panel`, `close the ${label} panel`);
    }
    if (p.kind === 'params' && pendingEdits().pending) return busy('typing a value in Parameters', 'finish the value you are typing in Parameters');
  }
  // A session of the person's with no panel (opened by another area): the same words.
  const open = services.doc.session();
  if (open && open.open && !open.owner && !(p?.kind === 'feature')) {
    const name = featureName(services, open.feature);
    return busy(open.draft.type === 'sketch' ? `editing ${name}; features after it show rolled back` : `editing ${name}`, `finish editing ${name}`);
  }
  if (pendingEdits().pending) {
    const label = pendingEditLabel() ?? 'a field';
    return busy(`typing a value (${label})`, `finish the value you are typing (${label})`);
  }
  if (ui.renaming) return busy('renaming a row of the tree', 'finish the rename');
  if (ui.menu) return busy('a menu is open', 'close the menu');
  if (typeof document !== 'undefined' && openModal(document)) return busy('a dialog is open', 'close the dialog');
  if (typeof document !== 'undefined' && document.querySelector(TOOLBAR_DRAG)) return busy('moving a toolbar button', 'finish moving the toolbar button');
  return null;
}

/** What the person is doing that an edit would wait for, in words, or null (get_model's `person`). */
export function personBusy(services: AppServices): string | null {
  return personBlock(services)?.words ?? null;
}

// ------------------------------------------------------------------ edits: not ready, the waits

/** The longest an edit waits for the person, the rollback bar or a pause (the test handle's setHoldS shortens it). */
export const EDIT_WAIT_MS = 10 * 60_000;
/** Soft input: an edit waits until the person's input has been quiet this long... */
export const SOFT_QUIET_MS = 800;
/** ... but no longer than this. */
export const SOFT_MAX_MS = 10_000;

/** Why the Part takes no edit now (not_ready: not editable, or being opened on a project geometry), or null. */
export function editBlockError(services: AppServices): ToolError | null {
  const ok = services.doc.editable();
  if (ok !== true) return new ToolError('not_editable', ok);
  const why = uiFor(services).editBlock();
  return why ? new ToolError('opening_geometry', why) : null;
}

/** Who paused the Assistant in this Part: the person (the chip's Pause), a take-over, or the person's undo or redo of its steps. */
export type PauseWhy = 'person' | 'take_over' | 'undo' | 'redo';

export interface Pause {
  why: PauseWhy;
  /** The key the pause began under. */
  key: string;
  /** The turn it ends with (the host told of it), or null: it ends at the next key. */
  turn: string | null;
  /** A take-over whose step could not go back (the person changed the Part): what of it stayed ("Plane 1"). */
  stayed?: string;
}

export interface PauseState {
  get(): Pause | null;
  /** Pause the Assistant's edits in this Part (a pause already on keeps its why, unless this one is a take-over). */
  set(why: PauseWhy, key: string, turn: string | null): void;
  /** Resume (the chip's Resume). */
  resume(): void;
  /** The take-over pause on now: what of the step stayed (the chip names it). */
  stayed(words: string): void;
  /** A call of `key` starts: a pause with no turn of another key ends (the next key). */
  enterKey(key: string): void;
  /** The host says a turn ended: its pause ends with it. */
  turnEnded(id: string): void;
  subscribe(fn: (p: Pause | null) => void): () => void;
}

export interface PauseOptions {
  /** A turn the host said has ended: a pause of it is not taken (it would outlive its turn). */
  isOver?: (turn: string) => boolean;
  /** Two keys of one session (an outside client's that went on because the person changed the Part): no next key for a pause. */
  sameSession?: (a: string, b: string) => boolean;
}

export function createPause(o: PauseOptions = {}): PauseState {
  let now: Pause | null = null;
  const listeners = new Set<(p: Pause | null) => void>();
  const tell = (next: Pause | null) => {
    now = next;
    for (const fn of [...listeners]) fn(now);
  };
  return {
    get: () => now,
    set(why, key, turn) {
      if (turn && o.isOver?.(turn)) return;
      if (now && why !== 'take_over') return;
      if (now && now.why === why && now.key === key && now.turn === turn) return;
      tell({ why, key, turn });
    },
    resume() {
      if (now) tell(null);
    },
    stayed(words) {
      if (now && now.why === 'take_over' && words && now.stayed !== words) tell({ ...now, stayed: words });
    },
    enterKey(key) {
      if (now && !now.turn && now.key !== key && !o.sameSession?.(now.key, key)) tell(null);
    },
    turnEnded(id) {
      if (now && now.turn === id) tell(null);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The chip's words for a pause. */
export function pauseNote(p: Pause): string | null {
  if (p.why === 'take_over') return p.stayed ? `you took over · ${p.stayed} stayed` : 'you took over';
  return p.why === 'undo' ? 'you undid its steps' : p.why === 'redo' ? 'you redid its steps' : null;
}

/** A pause in words, for the model ("the person took over a step"). */
function pauseWords(p: Pause): string {
  if (p.why === 'take_over') return 'the person took over a step';
  if (p.why === 'undo') return "the person undid the Assistant's steps";
  if (p.why === 'redo') return "the person redid the Assistant's steps";
  return 'the person paused the Assistant';
}

/** Progress while an edit waits for a pause to end. */
export const PAUSED_LABEL = 'Paused by the person';

/**
 * The person's input in the frame, for the soft wait: a pointer held (pointerdown to pointerup) and
 * the time of the last pointerdown, wheel or key (all heard in the capture phase).
 */
export interface SoftInput {
  /** How long an edit should still wait for quiet (ms), 0 when quiet. */
  quietIn(): number;
  /** A pointer is held down in the frame now (the camera latch: no automatic turn under the person's hand). */
  held(): boolean;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

export function createSoftInput(doc: Document | null, now: () => number = () => Date.now()): SoftInput {
  let held = false;
  let last = -Infinity;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const fn of [...listeners]) fn();
  };
  const down = () => {
    held = true;
    last = now();
    tell();
  };
  const up = () => {
    held = false;
    last = now();
    tell();
  };
  const input = () => {
    last = now();
    tell();
  };
  const on: [string, () => void][] = [
    ['pointerdown', down],
    ['pointerup', up],
    ['pointercancel', up],
    ['wheel', input],
    ['keydown', input],
  ];
  for (const [type, fn] of on) doc?.addEventListener(type, fn, { capture: true, passive: true });
  return {
    quietIn() {
      if (held) return SOFT_QUIET_MS;
      return Math.max(0, SOFT_QUIET_MS - (now() - last));
    },
    held: () => held,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      for (const [type, fn] of on) doc?.removeEventListener(type, fn, { capture: true });
      listeners.clear();
    },
  };
}

/** What an edit waits for now (hard), or null. */
interface EditWait {
  reason: 'paused' | 'rolled_back' | 'person_editing';
  words: string;
  note: string | null;
  why?: PauseWhy;
}

function hardWait(services: AppServices): EditWait | null {
  const p = runtimeOf(services)?.pause.get() ?? null;
  if (p) return { reason: 'paused', words: pauseWords(p), note: pauseNote(p), why: p.why };
  return personBlock(services);
}

/** A wait in words ("10 minutes", "1.5 s"). */
export const waitedWords = (ms: number) => {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${Math.round(ms / 100) / 10} s`;
};

/** The answer once an edit waited as long as it may. */
function gaveUp(w: EditWait, waited: number): ToolError {
  const after = `The call waited ${waitedWords(waited)}`;
  if (w.reason === 'paused') return new ToolError('paused', `${after}: ${w.words} in this Part.`, { detail: { why: w.why } });
  if (w.reason === 'rolled_back') return new ToolError('rolled_back', `${after}: ${w.words}.`, { detail: { person: w.words } });
  return new ToolError('person_editing', `${after} for the person: ${w.words}.`, { detail: { person: w.words } });
}

/**
 * An edit's gate (§3.0, §8.4): not_ready while the Part cannot take edits (after a read's wait
 * for it to open), busy other_turn for a call of a turn that is not the one running here, then the
 * wait for the person, the rollback bar and a pause (at most the runtime's waitCapMs, 10 minutes),
 * then the soft wait. While it holds, the chip says why (`waiting`, or `paused`) and progress
 * carries `waiting: true` every 5 s, so the turn's minutes stop.
 */
export async function waitForEdit(ctx: CallCtx): Promise<void> {
  const rt = runtimeOf(ctx.services);
  if (!rt) throw new ToolError('internal', 'The Assistant is not installed in this Part.');
  await waitForRead(ctx);
  const block = editBlockError(ctx.services);
  if (block) throw block;
  // A bar this key's own workspace call rolled back: no wait for the person.
  const own = ownRollbackBlock(ctx.services, ctx.key);
  if (own) throw own;
  if (ctx.key.startsWith('turn:')) {
    const id = ctx.key.slice('turn:'.length);
    const running = rt.turns.running();
    if (running.length && !running.some((t) => t.id === id)) {
      throw new ToolError('other_turn', `Another request is working in this Part (${running[0].title || 'untitled'}).`);
    }
  }
  rt.pause.enterKey(ctx.key);
  // A pause whose turn is no longer running (its end was never heard, a reload): it ended with it.
  const p = rt.pause.get();
  if (p?.turn && rt.turns.get(p.turn)?.state !== 'running') rt.pause.resume();
  await waitUntilFree(ctx);
}

/** The wait itself: resolves once nothing holds the edit; rejects with the busy answer or the call's stop. */
export function waitUntilFree(ctx: CallCtx): Promise<void> {
  const rt = runtimeOf(ctx.services);
  if (!rt) return Promise.resolve();
  const { services } = ctx;
  if (!hardWait(services) && rt.soft.quietIn() === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const offs: (() => void)[] = [];
    let shown: EditWait | null = null;
    let softSince: number | null = null;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const label = (w: EditWait) => (w.reason === 'paused' ? PAUSED_LABEL : `Waiting for the person: ${w.words}`);
    const unshow = () => {
      if (rt.store.get().phase === 'waiting') rt.store.set({ phase: 'working', note: null });
    };
    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      for (const off of offs.splice(0)) off();
      if (softTimer) clearTimeout(softTimer);
      // The chip goes back to what the facts say (a pause keeps its own state).
      unshow();
      // Not waiting any more: the turn's minutes run again.
      if (shown && !err) ctx.progress(null, 'The person is done: going on');
      if (err) reject(err);
      else resolve();
    };
    const show = (w: EditWait) => {
      if (w.reason !== 'paused') rt.store.set({ phase: 'waiting', note: w.note });
      else unshow();
      if (!shown || shown.words !== w.words) ctx.progress(null, label(w), { waiting: true });
      shown = w;
    };
    const check = () => {
      if (finished) return;
      const w = hardWait(services);
      if (w) {
        softSince = null;
        show(w);
        return;
      }
      unshow();
      const quiet = rt.soft.quietIn();
      if (quiet > 0) {
        softSince ??= Date.now();
        const left = SOFT_MAX_MS - (Date.now() - softSince);
        if (left > 0) {
          if (softTimer) clearTimeout(softTimer);
          softTimer = setTimeout(check, Math.min(quiet, left) + 5);
          return;
        }
      }
      finish();
    };
    // Every store behind the person's signals; the timers are only the cap, the sign of life and the soft quiet.
    offs.push(
      services.doc.state.subscribe(check),
      uiFor(services).state.subscribe(check),
      subscribePendingEdits(check),
      rt.pause.subscribe(check),
      rt.soft.subscribe(check),
    );
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
      // Dialogs opening and closing, and the toolbar's drag class.
      const mo = new MutationObserver(check);
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'class'] });
      offs.push(() => mo.disconnect());
    }
    const cap = setTimeout(() => {
      const w = hardWait(services);
      if (w) finish(gaveUp(w, Date.now() - t0));
      else finish();
    }, rt.waitCapMs);
    const beat = setInterval(() => {
      if (shown && hardWait(services)) ctx.progress(null, label(shown), { waiting: true });
      else ctx.progress(null);
    }, HEARTBEAT_MS);
    const abort = () => finish(ctx.signal.reason ?? new DOMException('The call was stopped', 'AbortError'));
    ctx.signal.addEventListener('abort', abort, { once: true });
    offs.push(
      () => clearTimeout(cap),
      () => clearInterval(beat),
      () => ctx.signal.removeEventListener('abort', abort),
    );
    check();
  });
}

/**
 * A step already running when the person pauses (CAD tools spec §8.3; review: the chip said
 * paused while the step went on being drawn and was kept): it waits at its next pace point, its
 * step open and held (the stored Part stays the mark), until the pause ends, `ended()` (a
 * take-over, a change of the Part: the step's checkpoint answers why) or the call stops (rejects
 * with the stop). The chip says paused meanwhile, and progress carries `waiting: true`, so the
 * turn's minutes stop. After the wait cap (10 minutes) it rejects with busy paused: `part` was
 * not kept.
 */
export function waitWhilePaused(ctx: CallCtx, rt: AssistantRuntime, ended: () => boolean, part: string): Promise<void> {
  if (!rt.pause.get() || ended()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const offs: (() => void)[] = [];
    let finished = false;
    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      for (const off of offs.splice(0)) off();
      if (err) {
        reject(err);
        return;
      }
      // Not waiting any more: the turn's minutes run again.
      ctx.progress(null, 'The person resumed: going on');
      resolve();
    };
    const check = () => {
      if (!finished && (!rt.pause.get() || ended())) finish();
    };
    offs.push(rt.pause.subscribe(check), ctx.services.doc.state.subscribe(check), ctx.services.bus.on('assistant:taken-over', check));
    const cap = setTimeout(() => {
      const p = rt.pause.get();
      if (!p) finish();
      else finish(new ToolError('paused', `The call waited ${waitedWords(Date.now() - t0)}: ${pauseWords(p)} in this Part; ${part} was not kept.`, { detail: { why: p.why } }));
    }, rt.waitCapMs);
    const beat = setInterval(() => ctx.progress(null, PAUSED_LABEL, { waiting: true }), HEARTBEAT_MS);
    const abort = () => finish(ctx.signal.reason ?? new DOMException('The call was stopped', 'AbortError'));
    ctx.signal.addEventListener('abort', abort, { once: true });
    offs.push(
      () => clearTimeout(cap),
      () => clearInterval(beat),
      () => ctx.signal.removeEventListener('abort', abort),
    );
    ctx.progress(null, PAUSED_LABEL, { waiting: true });
    if (ctx.signal.aborted) abort();
    else check();
  });
}
