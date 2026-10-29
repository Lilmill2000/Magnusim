// combine: join, cut or intersect bodies in one step (CAD tools spec §3.2.13). edit "" makes one;
// edit "<name>" replaces that Combine's inputs. targets keep the result; tools are used, and go
// unless keep_tools. Each entry is a body selector: a body's name, "bodies of <feature>" (a
// pattern's new-body copies, for example), "all bodies" or a #b handle, read on the bodies built
// now (an edit: just before the Combine). The lists are expanded and deduplicated, the targets
// are taken out of the tools ("all bodies" then means every other body), and what is left must
// not be empty. Bodies that do not touch join as separate solids: the result notes it (its
// feature's note, as the tree's info mark; warnings still say the body has more solids). The
// person's own Combine panel opens read-only, filled, and its Done keeps the feature.
// get_model full shows a Combine as this tool's input (registerFeatureIo).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, CombineFeature, Feature, FeatureId } from '../../types/doc';
import { ToolError } from '../errors';
import { andList, bodyText, editTarget, fillFeature, nameFor, partOf, strings } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { runtimeOf } from '../runtime';
import { echo, selectSet, withScene } from '../selectors/resolve';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

type Op = CombineFeature['op'];
const OPS: readonly Op[] = ['join', 'cut', 'intersect'];
const TARGETS_MAX = 16;
const TOOLS_MAX = 40;

interface Plan extends EditPlan {
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<CombineFeature>;
  targets: string[];
  tools: string[];
}

const combine: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const op = ctx.input.op as Op;
    const targetsIn = strings(ctx.input.targets);
    const toolsIn = strings(ctx.input.tools);
    const problems: string[] = [];
    if (!OPS.includes(op)) problems.push('op: join, cut or intersect');
    if (!targetsIn.length) problems.push('targets: at least one body');
    if (!toolsIn.length) problems.push('tools: at least one body');
    if (targetsIn.length > TARGETS_MAX) problems.push(`targets: at most ${TARGETS_MAX}`);
    if (toolsIn.length > TOOLS_MAX) problems.push(`tools: at most ${TOOLS_MAX}`);
    targetsIn.forEach((t, i) => {
      if (!t) problems.push(`targets[${i}]: a body, not ""`);
    });
    toolsIn.forEach((t, i) => {
      if (!t) problems.push(`tools[${i}]: a body, not ""`);
    });
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const editing = editTarget(services, ctx.input.edit, ['combine'], 'combine');
    const name = nameFor(services, ctx.input.name, editing);
    const self = editing?.id ?? null;
    const r = await withScene(ctx, { before: self, self }, async (sc) => {
      const read = async (list: string[], field: string) => {
        const ids: BodyId[] = [];
        const echoes: string[] = [];
        for (const [i, t] of list.entries()) {
          const sel = await selectSet(sc, t, 'body', `${field}[${i}]`);
          for (const h of sel.hits) if (h.kind === 'body' && !ids.includes(h.body.id)) ids.push(h.body.id);
          echoes.push(echo(sc, sel));
        }
        return { ids, echoes };
      };
      const t = await read(targetsIn, 'targets');
      const u = await read(toolsIn, 'tools');
      const tools = u.ids.filter((id) => !t.ids.includes(id));
      const nameOf = (id: BodyId) => sc.bodies.find((b) => b.id === id)?.name ?? id;
      if (!tools.length) {
        throw new ToolError('bad_input', `tools: nothing is left once the targets (${andList(t.ids.map(nameOf))}) are taken out: name another body.`, { detail: { field: 'tools', bodies: sc.bodies.map((b) => b.name).slice(0, 30) } });
      }
      return { targets: t.ids, tools, targetNames: t.ids.map(nameOf), toolNames: tools.map(nameOf), echoes: { targets: t.echoes.join('; '), tools: u.echoes.join('; ') } };
    });
    const fields: Partial<CombineFeature> = { op, targets: r.targets, tools: r.tools, keepTools: ctx.input.keep_tools === true };
    const label = services.doc.features.get('combine')?.label ?? 'Combine';
    const resolved: Record<string, string> = { op, targets: r.echoes.targets, tools: `${r.echoes.tools}${r.toolNames.length ? ` (used: ${andList(r.toolNames)})` : ''}`, keep_tools: fields.keepTools ? 'kept' : 'consumed' };
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, 'combine', name ?? editing?.name ?? label, !!editing),
      // A combine is a structural edit: what it breaks downstream is kept and listed.
      value: false,
      own: self,
      feature: self,
      resolved,
      edit: self,
      name,
      fields,
      targets: r.targetNames,
      tools: r.toolNames,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const editName = plan.edit ? services.doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? 'Combine';
    const fields = (plan.name ? { ...plan.fields, name: plan.name } : plan.fields) as Partial<Feature>;
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: 'combine', fields, label });
    const made = services.doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, 'combine', made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    if (!plan.edit && plan.own) runtimeOf(ctx.services)?.madeBy.add(plan.own);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const f = ctx.services.doc.state.get().doc.features.find((g) => g.id === plan.own);
    const body = bodyWords(data);
    const op = plan.fields.op;
    const verb = op === 'join' ? `joined ${andList(plan.tools)} to ${andList(plan.targets)}` : op === 'cut' ? `cut ${andList(plan.tools)} from ${andList(plan.targets)}` : `kept what ${andList(plan.targets)} shares with ${andList(plan.tools)}`;
    const text = `${f?.name ?? plan.name ?? 'Combine'} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${verb}${body ? ` · ${body}` : ''}`;
    return { text, summary: text, data: { ...data, targets: plan.targets, tools: plan.tools, keep_tools: !!plan.fields.keepTools } };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, combine),
};

registerFeatureIo('combine', {
  tool: 'combine',
  inputsOf(f, services) {
    const g = f as CombineFeature;
    const s = services.doc.state.get();
    if (g.targets.length > TARGETS_MAX || g.tools.length > TOOLS_MAX) return null;
    return { edit: g.name, name: '', op: g.op, targets: g.targets.map((id) => bodyText(s, id)), tools: g.tools.map((id) => bodyText(s, id)), keep_tools: !!g.keepTools };
  },
  values: () => [],
  pathOf: () => null,
});
