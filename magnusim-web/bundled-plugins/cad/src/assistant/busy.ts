// When the Part can answer the Assistant (CAD tools spec §3.0, §8.4): not ready (still loading,
// unreadable, the kernel starting or stopped, a local model's context too small), and what the
// person is doing in the Part right now, in words ("editing Sketch 2; features after it show
// rolled back"). Reads never wait for the person; they wait up to 30 s for the Part to open and
// the kernel to start, with a sign of life every 5 s.
// The edits' waits (the person, the rollback bar, Pause) come with the edit tools.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { pendingEditLabel, pendingEdits } from '../lib/pendingEdits';
import { openModal } from '../lib/modal';
import type { AppServices } from '../types/app';
import type { CallCtx, TurnFacts } from '../types/assistant';
import { uiFor } from '../ui/controller';
import { ToolError } from './errors';
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

/**
 * What the person is doing in the Part that an edit would have to wait for, in words, or null.
 * In order: the rollback bar above the end; a panel of theirs (an idle Parameters panel does not
 * count); a value typed and not applied; a menu or a rename; a dialog.
 */
export function personBusy(services: AppServices): string | null {
  const s = services.doc.state.get();
  const { rollback } = s.view;
  if (rollback !== null && rollback < s.doc.features.length) {
    const last = rollback > 0 ? s.doc.features[rollback - 1]?.name : null;
    return `the rollback bar is ${last ? `after ${last}` : 'at the top'}, not at the end`;
  }
  const ui = uiFor(services).state.get();
  const p = ui.panel;
  if (p && p.owner === 'person') {
    if (p.kind === 'feature') {
      const name = featureName(services, p.feature);
      return p.type === 'sketch' ? `editing ${name}; features after it show rolled back` : `editing ${name}`;
    }
    if (p.kind === 'tool') return `using the ${services.modules?.tool(p.tool)?.label ?? 'tool'} panel`;
    if (p.kind === 'params' && pendingEdits().pending) return 'typing a value in Parameters';
  }
  // A session of the person's with no panel (opened by another area): the same words.
  const open = services.doc.session();
  if (open && open.open && !open.owner && !(p?.kind === 'feature')) {
    const name = featureName(services, open.feature);
    return open.draft.type === 'sketch' ? `editing ${name}; features after it show rolled back` : `editing ${name}`;
  }
  if (pendingEdits().pending) return `typing a value (${pendingEditLabel() ?? 'a field'})`;
  if (ui.renaming) return 'renaming a row of the tree';
  if (ui.menu) return 'a menu is open';
  if (typeof document !== 'undefined' && openModal(document)) return 'a dialog is open';
  return null;
}
