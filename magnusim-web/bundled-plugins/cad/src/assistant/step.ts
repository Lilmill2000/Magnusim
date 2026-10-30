// One edit call, all or nothing (CAD tools spec §7.3): the call waits until the Part takes an edit
// (busy.ts: not ready, another turn, the person, the rollback bar, a pause), plans against the
// settled Part (selectors, names, a dry run: every refusal before anything changes), opens ONE
// Assistant step (doc.assistant.begin: the save hold, the person first), applies through the
// person's own paths, waits for the rebuild, and judges it (judge.ts; with the plan's scopedFrom,
// also the scoped cuts a value edit could move off their bodies, region-tools.ts). Kept, its undo steps are
// sealed into the key's undo group ("Assistant: <request>") and the call goes into the key's
// ledger; otherwise the step goes back to its mark exactly and the call answers why. A Stop, a
// stall or Back (the call's signal) reverts at once, synchronously, before anything else runs.
// A person who opens a panel while the call plans or opens is waited for again (the call plans
// anew), at most three times; so is a one-shot change of the Part while it plans (Enter in the
// Parameters panel, a Delete, an Undo: the plan and the judge's "before" would be of the older
// Part). A take-over (Escape, Ctrl+Z, a command, a draft change) answers busy taken_over and
// pauses the Assistant in this Part until the turn ends; the person's Ctrl+Z or Ctrl+Y between
// the step's panels takes all of the step back at once (doc.assistant.undoTakesOver).
// The person's selection comes back after the call, unless they changed it meanwhile.
// The person's Pause while a step runs: the step waits at its next pace point (and before it is
// judged), open and held, until Resume (busy.ts waitWhilePaused; review: it went on being drawn
// and was kept under a chip that said paused); after the wait cap it answers busy paused.
// Watch mode (§8): with "Ask each step" on, a judged step waits for the person's Keep or Discard
// before it is sealed (approval.ts; Discard and no answer revert it: busy step_declined); a kept
// step lets the view frame again (the camera latch, camera.ts); a call that ran at watch pace
// while the window was hidden or covered says so (`note`). The chip names the step it works on.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { storedBodyName } from '../doc/features/body-ids';
import { isPersonEditing } from '../doc/person-editing';
import { isPanelHighlight } from '../lib/selection';
import type { AppServices } from '../types/app';
import type { CallCtx, EditData, ToolReply } from '../types/assistant';
import type { AssistantStep, EditSession, TakeOverWhy } from '../types/doc-service';
import type { CadDoc, Feature } from '../types/doc';
import type { Selection, SelectionItem } from '../types/selection';
import { uiFor } from '../ui/controller';
import { waitForApproval } from './approval';
import { heartbeat, personBlock, waitedWords, waitForEdit, waitWhilePaused } from './busy';
import { asToolError, isToolError, ToolError } from './errors';
import { report, snapshotStates, verdict, type JudgedPlan } from './judge';
import { scopedActing, scopedLost, scopedLostError, type ScopedActing } from './region-tools';
import { groupLabel } from './ledger';
import { HIDDEN_NOTE, type CallPacer, type PacePoint } from './pace';
import { describeChanges } from './rev';
import { runtimeOf, type AssistantRuntime } from './runtime';

/** An edit tool's plan: what the judge needs, and the call's name in the undo label and the ledger. */
export interface EditPlan extends JudgedPlan {
  /** "Parameters", "Edit Boss", "Body Plate": the call's part in the undo label and the undo tool's answer. */
  part: string;
  /** The call goes into no ledger (the undo tool itself). */
  noLedger?: boolean;
  /**
   * The history index from which the call can move a scoped cut or intersect off its bodies (a
   * value edit: set_params, edit_feature), or undefined: those from there that act on their bodies
   * are checked before and after (region-tools.ts scopedActing); one that no longer does reverts a
   * value edit (broke_downstream) and warns after a structural one.
   */
  scopedFrom?: number;
}

export interface CheckpointOptions {
  /** A test hold point to stop at ('after-open', 'between-opens', 'before-commit', ...). */
  hold?: string;
  /** The pace point to wait at (watch pace only). */
  pace?: PacePoint;
  /** The progress line ("Edit Boss · distance"). */
  label?: string;
  fraction?: number | null;
}

/** An edit call's context inside its step. */
export interface EditCtx extends CallCtx {
  /** 'assistant:<call id>': the step's owner. */
  readonly owner: string;
  readonly step: AssistantStep;
  readonly pacer: CallPacer;
  /**
   * Throws on a stop, a take-over (busy taken_over; the Assistant pauses), a change of the Part by
   * someone else (busy changed) or a draft the Assistant did not write (taken over: draft); then waits
   * at the pace point and the hold point and sends progress.
   */
  checkpoint(o?: CheckpointOptions): Promise<void>;
  /** The draft the call just wrote into `session` (a checkpoint finds any other one a take-over). */
  wrote(session: EditSession): void;
  /** Run fn: a change of the selection inside it is the call's own (the person's selection still comes back after the call). */
  quietly<T>(fn: () => T): T;
  /**
   * Judge what the call changed so far as a value edit, once the rebuild settled (edit_feature's
   * values, before its rename, suppression or move): a feature that worked and fails now, or a
   * scoped cut that no longer cuts, throws the call's error (it reverts).
   */
  judgeValues(): Promise<void>;
}

export interface EditTool<P extends EditPlan> {
  /** Resolve and check the input against the settled Part; refuse (ToolError) before anything changes. Never edits. */
  plan(ctx: CallCtx): Promise<P>;
  /** Make the change inside the step, through the person's paths; checkpoint at every pace point. */
  apply(plan: P, ctx: EditCtx): Promise<void>;
  /** After the step is sealed: the tool's own bookkeeping (the undo tool trims the ledger). */
  sealed?(plan: P, ctx: EditCtx): void;
  /** The answer: one line and the data (EditData plus the tool's own). */
  reply(plan: P, data: EditData, ctx: EditCtx): ToolReply;
}

/** A person who keeps opening panels while the call plans: at most this many tries. */
export const MAX_ATTEMPTS = 3;

const WHY_WORDS: Record<TakeOverWhy, string> = {
  escape: 'Escape',
  enter: 'Enter',
  undo: 'Undo',
  command: 'a command',
  edit: 'an edit of the Part',
  draft: 'a change in its panel',
};

/** What a plan was made on: the committed model, the rollback bar and the rebuild (a change of any is a change of the Part). */
interface PlannedOn {
  doc: CadDoc;
  rollback: number | null;
  seq: number;
}

function plannedOn(services: AppServices): PlannedOn {
  const s = services.doc.state.get();
  return { doc: services.doc.committed(), rollback: s.view.rollback ?? null, seq: s.rebuild.seq };
}

const samePart = (a: PlannedOn, b: PlannedOn) => a.doc === b.doc && a.rollback === b.rollback && a.seq === b.seq;

/** The turn a pause ends with: the call's turn when the host told of it, else none (the next key ends it). */
function turnOfKey(rt: AssistantRuntime, key: string): string | null {
  return rt.turns.forKey(key)?.id ?? null;
}

/**
 * `sel` without what is gone (a feature the call deleted, a body it removed: neither in the model
 * nor built), or `sel` itself.
 */
function stillThere(services: AppServices, sel: Selection): Selection {
  const { doc, rebuild } = services.doc.state.get();
  const has = (it: SelectionItem) => {
    if ('feature' in it) return doc.features.some((f) => f.id === it.feature);
    if ('body' in it) return storedBodyName(doc, it.body) !== null || rebuild.bodies.some((b) => b.id === it.body);
    return true;
  };
  return sel.items.every(has) ? sel : { ...sel, items: sel.items.filter(has) };
}

/** The person's selection now, to put back after the call unless they changed it meanwhile. */
function rememberSelection(services: AppServices): { restore(): void; quietly<T>(fn: () => T): T } {
  const store = services.selection;
  const start: Selection = store.get();
  let theirs = false;
  let mine = 0;
  // A change that is not a panel's highlight (the Assistant's panel shows its feature that way) is the person's.
  const off = store.subscribe((s) => {
    if (!mine && !isPanelHighlight(s) && s.items.length) theirs = true;
  });
  return {
    quietly(fn) {
      mine += 1;
      try {
        return fn();
      } finally {
        mine -= 1;
      }
    },
    restore() {
      off();
      if (theirs) return;
      const now = store.get();
      if (now !== start && (isPanelHighlight(now) || !now.items.length)) store.set(() => stillThere(services, start));
    },
  };
}

/** What stayed after a refused revert, in words (detail.kept). */
function keptWords(step: AssistantStep, services: AppServices): string[] {
  return describeChanges(step.mark.doc, services.doc.committed(), services.bridge.projectLinks()).slice(0, 20);
}

/** The answer of a call the person took over (it pauses the Assistant in this Part). */
function takenOver(rt: AssistantRuntime, ctx: CallCtx, why: TakeOverWhy, part: string): ToolError {
  rt.pause.set('take_over', ctx.key, turnOfKey(rt, ctx.key));
  return new ToolError('taken_over', `You took over (${WHY_WORDS[why]}): ${part} was not kept.`, { detail: { why } });
}

/**
 * Run one edit call as one Assistant step (§7.3). Waits for the person (busy.ts), plans, applies,
 * judges, seals or reverts; answers the tool's reply, or throws the honest error.
 */
export async function runEdit<P extends EditPlan>(ctx: CallCtx, tool: EditTool<P>): Promise<ToolReply> {
  const { services } = ctx;
  const { doc } = services;
  const rt = runtimeOf(services);
  if (!rt) throw new ToolError('internal', 'The Assistant is not installed in this Part.');
  const ui = uiFor(services);
  const owner = `assistant:${ctx.call.call}`;
  for (let attempt = 1; ; attempt++) {
    await waitForEdit(ctx);
    await heartbeat(ctx, doc.settled(ctx.signal), 'Waiting for the rebuild');
    const on = plannedOn(services);
    const before = snapshotStates(doc.state.get());
    const plan = await tool.plan(ctx);
    // A value edit can move a scoped cut off its body (it still builds): what acts now, to compare after.
    const acting: ScopedActing | null = plan.scopedFrom === undefined ? null : await heartbeat(ctx, scopedActing(ctx, plan.scopedFrom), 'Checking the cuts');
    await ctx.hold('after-plan');
    ctx.checkAbort();
    // The person opened something while the call planned: wait for them again, then plan anew.
    const person = personBlock(services);
    if (person || rt.pause.get()) {
      if (attempt < MAX_ATTEMPTS) continue;
      throw new ToolError(person?.reason ?? 'paused', `The person kept the Part busy: ${person?.words ?? 'paused'}.`, { detail: person ? { person: person.words } : { why: rt.pause.get()?.why } });
    }
    // The Part changed while the call planned (a one-shot change of the person's): the plan and
    // `before` are of the older Part, so it plans anew on the settled Part (review: the judge put
    // the person's breakage on the call, or reverted a right change as broke_downstream).
    if (!samePart(on, plannedOn(services))) {
      if (attempt < MAX_ATTEMPTS) continue;
      throw new ToolError('changed', `The Part changed each time the call planned (${MAX_ATTEMPTS} times); nothing of it was made.`);
    }
    // Another call of the Assistant's is changing the Part right now (an outside client's beside a turn's).
    if (doc.assistant.current()) throw new ToolError('other_turn', 'Another call of the Assistant is changing this Part right now.');
    let step: AssistantStep;
    try {
      step = doc.assistant.begin(owner);
    } catch (e) {
      if (isPersonEditing(e) && attempt < MAX_ATTEMPTS) continue;
      if (isPersonEditing(e)) throw new ToolError('person_editing', `${e.message}.`, { detail: { person: e.message } });
      throw asToolError(e);
    }
    const st = step;
    const pacer = rt.pace.forCall(ctx.signal);
    // The chip names the step ("Assistant · Sketch Plate sketch · 3 of 120 steps").
    if (rt.store.get().call) rt.store.set({ call: { tool: ctx.tool, label: plan.part } });
    // Watch pace with the window hidden or covered: the call runs without its animation, and says so.
    const watchedHidden = () => rt.pace.get() === 'watch' && rt.pace.hidden();
    let ranHidden = watchedHidden();
    const sel = rememberSelection(services);
    // A Stop, a stall or Back: back to the mark at once, before the rest of the call runs.
    const onAbort = () => {
      ui.dropForAssistant(st);
      st.revert();
      st.end();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const drafts = new Map<EditSession, Feature>();
    const check = () => {
      if (ctx.signal.aborted) throw new ToolError('stopped', 'The call was stopped; nothing of it was kept.');
      if (st.takenOver) throw takenOver(rt, ctx, st.takenOver, plan.part);
      for (const [s, draft] of drafts) {
        if (s.open && s.draft !== draft) {
          doc.assistant.takeOver('draft');
          throw takenOver(rt, ctx, 'draft', plan.part);
        }
      }
      if (!st.clean) throw new ToolError('changed', `The Part changed while the call ran: ${keptWords(st, services).join('; ') || 'by someone else'}.`);
    };
    // A pause pressed while the step runs: it waits here until Resume (a take-over or a change ends the wait; check says why).
    const untilResumed = () => waitWhilePaused(ctx, rt, () => !!st.takenOver || !st.clean, plan.part);
    /** The scoped cuts that acted before the call and no longer do, once the rebuild settled. */
    const lostNow = async () => {
      if (!acting?.length) return [];
      const lost = await heartbeat(ctx, scopedLost(ctx, acting), 'Checking the cuts');
      check();
      return lost;
    };
    const ectx: EditCtx = {
      ...ctx,
      owner,
      step: st,
      pacer,
      wrote(s) {
        drafts.set(s, s.draft);
      },
      quietly: (fn) => sel.quietly(fn),
      async judgeValues() {
        await heartbeat(ctx, doc.settled(ctx.signal), 'Waiting for the rebuild');
        check();
        const v = verdict(before, snapshotStates(doc.state.get()), { ...plan, value: true });
        if (v.error) throw v.error;
        const lost = await lostNow();
        if (lost.length) throw await scopedLostError(services, lost);
      },
      async checkpoint(o = {}) {
        if (watchedHidden()) ranHidden = true;
        check();
        if (o.pace) await pacer.wait(o.pace);
        if (o.hold) await ctx.hold(o.hold);
        await untilResumed();
        check();
        ctx.progress(o.fraction ?? null, o.label);
      },
    };
    try {
      await tool.apply(plan, ectx);
      await heartbeat(ctx, doc.settled(ctx.signal), 'Waiting for the rebuild');
      check();
      // Paused after its last pace point: judged and kept only once the person resumes.
      await untilResumed();
      check();
      const after = snapshotStates(doc.state.get());
      const v = verdict(before, after, plan);
      if (v.error) throw v.error;
      // A scoped cut the change moved off its body still builds: a value edit reverts, a structural one warns.
      const lost = await lostNow();
      if (lost.length && plan.value) throw await scopedLostError(services, lost);
      for (const l of lost) v.warnings.push(l.words);
      // "Ask each step": the person keeps or discards the judged step before it is sealed.
      if (rt.askEach.get()) {
        const answer = await waitForApproval(ctx, rt, st, plan.part);
        check();
        if (answer !== 'keep') {
          const message = answer === 'timeout' ? `The person did not answer in ${waitedWords(rt.waitCapMs)}: ${plan.part} was not kept.` : `The person declined this step: ${plan.part} was not kept.`;
          throw new ToolError('step_declined', message, { detail: { why: answer === 'timeout' ? 'no_answer' : 'discard' } });
        }
      }
      check();
      const parts = [...rt.ledger.entries(ctx.key).map((e) => e.part), plan.part];
      st.seal(ctx.key, groupLabel(ctx.key, ctx.turn, parts));
      const committed = doc.committed();
      // The call's own change: never told back to it as the person's (user_changes).
      rt.rev.own(ctx.key, st.mark.doc, committed);
      const n = plan.noLedger || committed === st.mark.doc ? 0 : rt.ledger.add(ctx.key, { call: ctx.call.call, part: plan.part, mark: st.mark, after: committed });
      // get_model marks what this kept edit turned red, while it fails.
      for (const [id, f] of after.features) {
        if (f.state === 'error' && v.broke.some((b) => b.feature === f.name)) rt.brokenBy.add(id);
        else if (v.fixed.includes(f.name)) rt.brokenBy.delete(id);
      }
      tool.sealed?.(plan, ectx);
      // The view frames again when the bodies left it (automatic, under the camera latch).
      rt.camera.afterCall(ctx.key);
      const reply = tool.reply(plan, report({ before, after, plan, verdict: v, step: n, rev: rt.rev.current() }), ectx);
      if (ranHidden || watchedHidden()) {
        const had = typeof reply.data.note === 'string' && reply.data.note ? `${reply.data.note}; ` : '';
        reply.data = { ...reply.data, note: `${had}${HIDDEN_NOTE}` };
      }
      return reply;
    } catch (e) {
      ui.dropForAssistant(st);
      const rv = st.revert();
      if (isPersonEditing(e) && rv.ok && attempt < MAX_ATTEMPTS && !ctx.signal.aborted && !st.takenOver) continue;
      throw failure(e, rv, st, rt, ctx, plan.part, services);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      st.end();
      sel.restore();
      rt.paced.set(ctx.call.call, (rt.paced.get(ctx.call.call) ?? 0) + pacer.spent());
    }
  }
}

/** The error a failed call answers: a stop, a take-over, the person, or the tool's own; with what stayed when the revert was refused. */
function failure(e: unknown, rv: { ok: true } | { ok: false; reason: string }, step: AssistantStep, rt: AssistantRuntime, ctx: CallCtx, part: string, services: AppServices): ToolError {
  let err: ToolError;
  if (ctx.signal.aborted) err = isToolError(e) && e.reason === 'stopped' ? e : new ToolError('stopped', 'The call was stopped; nothing of it was kept.');
  else if (step.takenOver && !(isToolError(e) && e.reason === 'taken_over')) err = takenOver(rt, ctx, step.takenOver, part);
  else if (isPersonEditing(e)) err = new ToolError('person_editing', `${e.message}.`, { detail: { person: e.message } });
  else err = asToolError(e);
  if (!rv.ok) {
    const kept = keptWords(step, services);
    err.detail.kept = kept.length ? kept : [rv.reason];
    // A take-over the person's own change made: the chip names what of the step stayed (review: it said only "you took over").
    const left = step.left();
    if (err.reason === 'taken_over' && left.length) rt.pause.stayed(left.length === 1 ? left[0] : `${left[0]} and ${left.length - 1} more`);
    // What stayed is told in detail.kept, not again as the person's changes.
    rt.rev.own(ctx.key, step.mark.doc, services.doc.committed());
  }
  return err;
}
