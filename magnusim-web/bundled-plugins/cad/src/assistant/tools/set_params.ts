// set_params: add, change, rename or remove parameters in one step (CAD tools spec §3.2.6, §7.6).
// The rows become one DocService.editParams inside the step: the final set is checked once, so
// any row order works (a parameter may use one set after it, two may swap which uses which), a
// rename rewrites every use, and a removal still used in the final Part refuses the call. The
// same check runs first as a dry run, so a bad name, expression or removal answers before
// anything changes, naming its row (set[2].expr, remove[0]). A value edit: a feature that built
// and fails after the change, or a scoped cut (a hole) it moves off its body, reverts the call
// (broke_downstream). The answer gives each row's
// value evaluated (whether the row added or changed it, and what a changed one was), what was
// removed, how the features rebuilt, and the sketches the change turned over (`flipped`: a
// dimension driven through zero mirrors its sketch; sketch/flip.ts).
// A row that changes a parameter the Part has keeps its comment when comment is "" (a value
// change never loses the person's note); "-" removes it.
// At the watch pace with no panel open, the Assistant's own Parameters panel (read-only) shows the
// rows change, a moment per row, and closes with the step; a Parameters panel the person has open
// stays open and flashes the rows that changed.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { listOfNames, planParams } from '../../doc/params-bulk';
import { paramNameProblem } from '../../doc/params';
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { Param, ParamId } from '../../types/doc';
import type { ParamRows, ParamsResult } from '../../types/doc-service';
import type { Quantity } from '../../types/units';
import { ToolError } from '../errors';
import { uiFor } from '../../ui/controller';
import { len, sig6 } from '../numbers';
import { macrotask } from '../pace';
import { runtimeOf } from '../runtime';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { flippedSketches, sketchOutputs } from '../sketch/flip';

interface SetRow {
  name: string;
  kind: string;
  expr: string;
  comment: string;
  rename_to: string;
}

interface Plan extends EditPlan {
  rows: ParamRows;
  /** editParams' row names → the tool's ("add[0]" → "set[2]"). */
  where: Record<string, { at: string; renames: boolean }>;
  /** The parameters the set rows leave, by their final names, in row order. */
  names: string[];
  /** Each set row's parameter as it was (its expression), or null for one it adds; in row order. */
  was: (string | null)[];
  removed: string[];
  /** The sketches' outputs before (the flip check). */
  sketches: ReturnType<typeof sketchOutputs>;
}

const KIND_OF: Record<string, Quantity> = { length: 'length', angle: 'angle', number: 'scalar' };
const KIND_WORD: Record<Quantity, string> = { length: 'length', angle: 'angle', scalar: 'number' };
const UNIT_OF: Record<Quantity, string> = { length: 'mm', angle: 'deg', scalar: '' };

const NAME_WORDS = /^(Enter a name|A name can have at most|A name starts with|"[^"]*" is a unit or function name|There is already a parameter called)/;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** The comment that removes a changed parameter's comment ("" keeps it). */
export const CLEAR_COMMENT = '-';

/** editParams' refusal as the tool's error, naming the tool's row. */
function rowError(r: { reason: string; row?: string }, plan: Pick<Plan, 'where'>, names: readonly string[]): ToolError {
  const w = r.row ? plan.where[r.row] : undefined;
  const at = w?.at ?? r.row ?? 'set';
  const reason = r.reason;
  if (/can't be deleted/.test(reason)) return new ToolError('in_use', `${at}: ${reason}.`, { detail: { field: at } });
  if (/renames or removes/.test(reason)) return new ToolError('bad_input', `${at}.rename_to: ${reason}.`, { hint: 'Rename that parameter in its own call, then the other.', detail: { field: `${at}.rename_to` } });
  if (/twice|both changed and removed|not in the part/.test(reason)) return new ToolError('bad_input', `${at}: ${reason}.`, { detail: { field: at } });
  if (NAME_WORDS.test(reason)) {
    const field = `${at}.${w?.renames ? 'rename_to' : 'name'}`;
    return new ToolError('bad_name', `${field}: ${reason}.`, { detail: { field } });
  }
  if (/Pick length, angle or number/.test(reason)) return new ToolError('bad_input', `${at}.kind: length, angle or number.`, { detail: { field: `${at}.kind` } });
  const field = r.row ? `${at}.expr` : 'set';
  const known = /Unknown parameter/.test(reason) ? ` Parameters: ${names.length ? names.join(', ') : 'none yet'}.` : '';
  return new ToolError('expr_error', `${field}: ${reason}.${known}`, { detail: { field } });
}

const setParams: EditTool<Plan> = {
  async plan(ctx) {
    const { doc } = ctx.services;
    const set = (Array.isArray(ctx.input.set) ? ctx.input.set : []) as SetRow[];
    const remove = (Array.isArray(ctx.input.remove) ? ctx.input.remove : []).map((n) => str(n).trim());
    if (!set.length && !remove.length) throw new ToolError('bad_input', 'Nothing to do: give set rows or names to remove.');
    const params = doc.state.get().doc.params;
    const byName = new Map(params.map((p) => [p.name, p] as const));
    const rows: ParamRows = { add: [], change: [], remove: [] };
    const where: Plan['where'] = {};
    const names: string[] = [];
    const was: (string | null)[] = [];
    const seen = new Map<string, number>();
    const problems: string[] = [];
    set.forEach((row, i) => {
      const at = `set[${i}]`;
      const name = str(row?.name).trim();
      const renameTo = str(row?.rename_to).trim();
      const quantity = KIND_OF[str(row?.kind)];
      const expr = str(row?.expr).trim();
      if (seen.has(name)) problems.push(`${at}: ${name} is set twice (set[${seen.get(name)}] too)`);
      seen.set(name, i);
      if (!quantity) problems.push(`${at}.kind: length, angle or number`);
      if (!expr) problems.push(`${at}.expr: enter a value with units ("40 mm", "w/2", "15 deg")`);
      const old = byName.get(name);
      const comment = str(row?.comment).trim();
      if (old) {
        // "" keeps the comment the parameter has; "-" removes it.
        const patch: Partial<Omit<Param, 'id'>> = { expr, ...(quantity ? { quantity } : {}), ...(comment === CLEAR_COMMENT ? { comment: '' } : comment ? { comment } : {}) };
        if (renameTo && renameTo !== name) {
          const problem = paramNameProblem(renameTo, [], old.id);
          if (problem) throw new ToolError('bad_name', `${at}.rename_to: ${problem}.`, { detail: { field: `${at}.rename_to` } });
          patch.name = renameTo;
        }
        where[`change[${rows.change.length}]`] = { at, renames: !!patch.name };
        rows.change.push({ id: old.id, patch });
        names.push(patch.name ?? name);
        was.push(old.expr);
      } else {
        const problem = paramNameProblem(name, [], undefined);
        if (problem) throw new ToolError('bad_name', `${at}.name: ${problem}.`, { detail: { field: `${at}.name` } });
        if (renameTo && renameTo !== name) {
          problems.push(`${at}.rename_to: the Part has no parameter ${name} to rename; give a new one its name in name and "" here`);
        }
        where[`add[${rows.add.length}]`] = { at, renames: false };
        rows.add.push({ name, expr, quantity: quantity ?? 'length', ...(comment && comment !== CLEAR_COMMENT ? { comment } : {}) });
        names.push(name);
        was.push(null);
      }
    });
    const removedNames: string[] = [];
    remove.forEach((name, i) => {
      const p = byName.get(name);
      if (!p) {
        const list = params.map((q) => q.name);
        throw new ToolError('not_found', `remove[${i}]: the Part has no parameter called "${name}". Parameters: ${list.length ? list.join(', ') : 'none yet'}.`, {
          detail: { field: `remove[${i}]`, names: list.slice(0, 30) },
        });
      }
      if (seen.has(name)) problems.push(`remove[${i}]: ${name} is also in set[${seen.get(name)}]`);
      where[`remove[${rows.remove.length}]`] = { at: `remove[${i}]`, renames: false };
      rows.remove.push(p.id as ParamId);
      removedNames.push(name);
    });
    if (problems.length) throw new ToolError('bad_input', `${problems.slice(0, 12).join('; ')}.`, { detail: { problems: problems.slice(0, 12) } });
    // The dry run: editParams' own check of the final set, before anything changes.
    const dry = planParams(doc.state.get().doc, rows, doc.features);
    if (!dry.ok) throw rowError(dry, { where }, params.map((p) => p.name));
    return {
      part: 'Parameters',
      value: true,
      // A parameter can drive any feature: every scoped cut is checked.
      scopedFrom: 0,
      rows,
      where,
      names,
      was,
      removed: removedNames,
      sketches: sketchOutputs(doc.state.get()),
      resolved: { ...(names.length ? { set: listOfNames(names) } : {}), ...(removedNames.length ? { remove: listOfNames(removedNames) } : {}) },
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { doc } = ctx.services;
    const rows = plan.names.length + plan.removed.length;
    const words = `Parameters · ${rows} row${rows === 1 ? '' : 's'}`;
    const ui = uiFor(ctx.services);
    // Watched, with no panel open: the Assistant's own Parameters panel shows the rows change (it closes with the step).
    if (runtimeOf(ctx.services)?.pace.watching() && !ui.state.get().panel) {
      const why = ui.openParamsForAssistant(ctx.step);
      if (!why) {
        await macrotask();
        await ctx.checkpoint({ hold: 'after-open', pace: 'open', label: words });
      }
    }
    await ctx.checkpoint({ pace: 'param', label: words });
    const label = `Parameters: ${plan.rows.add.length + plan.rows.change.length + plan.rows.remove.length} changed`;
    const r: ParamsResult = ctx.step.run(() => doc.editParams(plan.rows, label));
    if (!r.ok) throw rowError(r, plan, doc.state.get().doc.params.map((p) => p.name));
    // A moment per row more, while the panel shows the new values.
    for (let i = 1; i < rows; i++) await ctx.checkpoint({ pace: 'param', label: words, fraction: (i + 1) / rows });
    await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label: words });
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const params = new Map(s.doc.params.map((p) => [p.name, p] as const));
    const rows = plan.names.map((name, i) => {
      const p = params.get(name);
      const before = plan.was[i];
      const row = before === null ? 'added' : 'changed';
      if (!p) return { name, row, kind: null, expr: null, value: null, unit: null };
      const r = ctx.services.doc.units.evaluate(p.expr, p.quantity);
      return {
        name,
        row,
        kind: KIND_WORD[p.quantity],
        expr: p.expr,
        ...(before !== null && before !== p.expr ? { was: before } : {}),
        value: r.ok ? (p.quantity === 'scalar' ? sig6(r.value) : len(r.value)) : null,
        unit: UNIT_OF[p.quantity],
        ...(r.ok ? {} : { error: r.error }),
      };
    });
    const rebuilt: Record<string, number> = { ok: 0, warning: 0, error: 0 };
    for (const f of s.doc.features) {
      const st = s.rebuild.features[f.id]?.state;
      if (st === 'ok' || st === 'warning' || st === 'error') rebuilt[st] += 1;
    }
    const shown = rows.slice(0, 3).map((r) => `${r.name} = ${r.value ?? '?'}${r.unit ? ` ${r.unit}` : ''}${'was' in r ? ` (was ${r.was})` : ''}`);
    const more = rows.length > 3 ? ` (+${rows.length - 3} more)` : '';
    const gone = plan.removed.length ? `${shown.length ? '; ' : ''}removed ${listOfNames(plan.removed)}` : '';
    const text = `Parameters set: ${shown.join(', ')}${more}${gone}${data.broke.length ? ` · ${data.broke.length} feature${data.broke.length === 1 ? '' : 's'} broke` : ''}`;
    // A dimension driven through zero turns its sketch over: warned, not refused.
    const flipped = flippedSketches(plan.sketches, s);
    if (flipped.length) data.warnings.push(`${flipped.join(', ')} turned over: a dimension went through zero; check it with get_model or view`);
    return { text, data: { ...data, params: rows, removed: plan.removed, rebuilt, flipped }, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, setParams),
};
