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
// The undo itself goes into no ledger.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { DocMark } from '../../types/doc-service';
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

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, undoTool),
};
