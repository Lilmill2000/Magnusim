// undo: take back the Assistant's own calls (CAD tools spec §3.2.16, §7.9), never the person's.
//   steps n          the newest n calls of this request (this key): the Part goes back exactly to
//                    the point before the oldest of them (doc.assistant.restore of its mark: the
//                    model, the bar and both undo lists, so the request's undo group is as it was
//                    then, with nothing to redo). Only while the Part is as the newest call left it,
//                    the newest undo step is this request's, and no change of the person's lies
//                    between those calls; otherwise not_own_step names the call after which the
//                    person changed the Part.
//   previous_turn    the whole previous request, when its undo group is still the newest step:
//                    one Undo (doc.assistant.undoGroup), so the person's Redo brings it back.
//   action undo|redo the person's own Undo (Ctrl+Z) or Redo (Ctrl+Y), `steps` times, whoever made
//                    those steps (the person, or an Assistant request's group): each goes through
//                    doc.undo / doc.redo inside the call's step, so one Redo (or Undo) of the
//                    person's brings it back. The answer names every step and whose it was.
// The undo itself goes into no ledger.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { CadDoc } from '../../types/doc';
import type { DocMark } from '../../types/doc-service';
import type { UndoEntry } from '../../types/undo';
import { ToolError } from '../errors';
import { runtimeOf } from '../runtime';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

interface Plan extends EditPlan {
  /** steps: the mark to go back to and the parts taken back (newest first). */
  mark: DocMark | null;
  steps: number;
  parts: string[];
  /** previous_turn: the group's tag and label. */
  group: { tag: string; label: string } | null;
}

const undoTool: EditTool<Plan> = {
  async plan(ctx) {
    const { doc } = ctx.services;
    const rt = runtimeOf(ctx.services)!;
    const steps = typeof ctx.input.steps === 'number' && Number.isInteger(ctx.input.steps) ? ctx.input.steps : 0;
    const previous = ctx.input.previous_turn === true;
    if (previous) {
      if (steps !== 0) throw new ToolError('bad_input', 'previous_turn takes steps 0: it undoes the whole previous request.', { detail: { field: 'steps' } });
      const top = doc.assistant.topGroup();
      if (!top || top.after !== doc.committed()) throw new ToolError('nothing_to_undo', "The newest change in the Part is not an Assistant request's: nothing was undone.");
      if (top.tag === ctx.key) throw new ToolError('bad_input', 'The newest Assistant steps are this request\'s own: use steps instead of previous_turn.', { detail: { field: 'previous_turn' } });
      return { part: `Undo ${top.label}`, value: false, noLedger: true, mark: null, steps: 0, parts: [top.label], group: { tag: top.tag, label: top.label }, resolved: { undo: top.label } };
    }
    if (steps < 1) throw new ToolError('bad_input', 'steps: how many of your calls in this request to take back (1 or more), or previous_turn true.', { detail: { field: 'steps' } });
    const list = rt.ledger.entries(ctx.key);
    if (!list.length) throw new ToolError('nothing_to_undo', 'None of your calls in this request changed the Part, so there is nothing to undo.');
    const last = list[list.length - 1];
    if (doc.committed() !== last.after || doc.assistant.topGroup()?.tag !== ctx.key) {
      throw new ToolError('not_own_step', `The person changed the Part after your step '${last.part}': nothing was undone.`, { detail: { undoable: 0 } });
    }
    if (steps > list.length) {
      throw new ToolError('bad_input', `steps: ${list.length} of your calls in this request can be undone, not ${steps}.`, { detail: { field: 'steps', range: [1, list.length] } });
    }
    for (let k = list.length - 1; k > list.length - steps; k--) {
      if (list[k].mark.doc !== list[k - 1].after) {
        throw new ToolError('not_own_step', `The person changed the Part after your step '${list[k - 1].part}': only your ${list.length - k} newest call${list.length - k === 1 ? '' : 's'} can be undone.`, {
          detail: { undoable: list.length - k },
        });
      }
    }
    const taken = list.slice(list.length - steps).reverse();
    return { part: 'Undo', value: false, noLedger: true, mark: taken[taken.length - 1].mark, steps, parts: taken.map((e) => e.part), group: null, resolved: { undo: taken.map((e) => e.part).join(', ') } };
  },

  async apply(plan, ctx: EditCtx) {
    const { doc } = ctx.services;
    await ctx.checkpoint({ label: plan.group ? `Undo ${plan.group.label}` : `Undo ${plan.steps} step${plan.steps === 1 ? '' : 's'}` });
    if (plan.group) {
      const r = ctx.step.run(() => doc.assistant.undoGroup(plan.group!.tag));
      if (!r.ok) throw new ToolError('not_own_step', `${r.reason}: nothing was undone.`);
    } else {
      const r = ctx.step.run(() => doc.assistant.restore(plan.mark!));
      if (!r.ok) throw new ToolError('changed', `${r.reason}: nothing was undone.`);
    }
    await ctx.checkpoint({ pace: 'commit' });
  },

  sealed(plan, ctx) {
    const rt = runtimeOf(ctx.services)!;
    if (plan.group) rt.ledger.clear(plan.group.tag);
    else rt.ledger.trim(ctx.key, plan.steps);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const rt = runtimeOf(ctx.services)!;
    const left = rt.ledger.entries(ctx.key).length;
    const text = plan.group ? `Undid the previous request: ${plan.group.label}` : `Undid ${plan.parts.length} of your call${plan.parts.length === 1 ? '' : 's'}: ${plan.parts.join(', ')}`;
    return { text, data: { ...data, undone: plan.parts, left }, summary: text };
  },
};

/** One step of the history as the answer names it: its label and whose it is. */
interface StepWords {
  label: string;
  by: 'person' | 'assistant';
}

interface AnyPlan extends EditPlan {
  redo: boolean;
  taken: StepWords[];
}

const wordsOf = (e: UndoEntry<CadDoc>): StepWords => ({ label: e.label, by: e.tag ? 'assistant' : 'person' });
const whose = (w: StepWords) => `${w.label} (${w.by === 'person' ? "the person's" : 'an Assistant request'})`;

/** The person's Undo or Redo, n times, of anyone's steps. */
const anyTool: EditTool<AnyPlan> = {
  async plan(ctx) {
    const { doc } = ctx.services;
    const redo = ctx.input.action === 'redo';
    if (ctx.input.previous_turn === true) throw new ToolError('bad_input', 'previous_turn goes with action own.', { detail: { field: 'previous_turn' } });
    const steps = typeof ctx.input.steps === 'number' && Number.isInteger(ctx.input.steps) ? ctx.input.steps : 0;
    if (steps < 1) throw new ToolError('bad_input', `steps: how many steps to ${redo ? 'redo' : 'undo'} (1 or more).`, { detail: { field: 'steps' } });
    const h = doc.assistant.mark().history;
    const list = redo ? [...h.undone].reverse() : [...h.done].reverse();
    if (!list.length) throw new ToolError('nothing_to_undo', redo ? 'Nothing to redo.' : 'Nothing to undo.');
    if (steps > list.length) throw new ToolError('bad_input', `steps: ${list.length} step${list.length === 1 ? '' : 's'} can be ${redo ? 'redone' : 'undone'}, not ${steps}.`, { detail: { field: 'steps', range: [1, list.length] } });
    const taken = list.slice(0, steps).map(wordsOf);
    const verb = redo ? 'Redo' : 'Undo';
    return { part: `${verb} ${taken[0].label}`, value: false, noLedger: true, redo, taken, resolved: { [redo ? 'redo' : 'undo']: taken.map(whose).join(', ') } };
  },

  async apply(plan, ctx: EditCtx) {
    const { doc } = ctx.services;
    await ctx.checkpoint({ label: `${plan.redo ? 'Redo' : 'Undo'} ${plan.taken.length} step${plan.taken.length === 1 ? '' : 's'}` });
    for (const w of plan.taken) {
      const before = doc.assistant.mark().history.version;
      ctx.step.run(() => (plan.redo ? doc.redo() : doc.undo()));
      if (doc.assistant.mark().history.version === before) throw new ToolError('changed', `${w.label} could not be ${plan.redo ? 'redone' : 'undone'} now: nothing was changed.`);
    }
    await ctx.checkpoint({ pace: 'commit' });
  },

  reply(plan, data: EditData): ToolReply {
    const verb = plan.redo ? 'Redid' : 'Undid';
    const text = `${verb} ${plan.taken.map(whose).join(', ')}`;
    return { text, data: { ...data, [plan.redo ? 'redone' : 'undone']: plan.taken }, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run(ctx) {
    const action = ctx.input.action ?? 'own';
    if (action === 'undo' || action === 'redo') return runEdit(ctx, anyTool);
    if (action !== 'own') throw new ToolError('bad_input', 'action: own, undo or redo.', { detail: { field: 'action' } });
    return runEdit(ctx, undoTool);
  },
};
