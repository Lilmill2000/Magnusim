// body: rename a body, set its colour, or say whether it goes into the project's simulation
// geometry, in one step (CAD tools spec §3.2.14). "" (or keep) leaves a field as it is. The body
// is named by its name (any case) or its id. Each change is the Part's own one-shot edit
// (renameBody, setBodyColor, setBodyInSimulation), with its refusal words as the message; all of
// them are one step, so a refused second change takes the first back too.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId } from '../../types/doc';
import type { EditResult } from '../../types/doc-service';
import { ToolError } from '../errors';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

interface Plan extends EditPlan {
  body: BodyId;
  name: string;
  renameTo: string | null;
  color: string | null;
  simulation: boolean | null;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A refusal of the Part's own edit as the tool's error. */
function refused(field: string, r: EditResult): ToolError {
  const reason = r.ok ? '' : r.reason;
  if (/already called/.test(reason)) return new ToolError('name_taken', `${field}: ${reason}.`, { detail: { field } });
  return new ToolError('bad_input', `${field}: ${reason}.`, { detail: { field } });
}

const bodyTool: EditTool<Plan> = {
  async plan(ctx) {
    const s = ctx.services.doc.state.get();
    const want = str(ctx.input.body);
    const bodies = s.rebuild.bodies;
    const b = bodies.find((x) => x.name.toLowerCase() === want.toLowerCase()) ?? bodies.find((x) => x.id === want);
    if (!b) {
      const names = bodies.map((x) => x.name);
      throw new ToolError('not_found', `No body is called "${want}". Bodies: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'body', names: names.slice(0, 30) } });
    }
    const renameTo = str(ctx.input.rename_to);
    const color = str(ctx.input.color).toLowerCase();
    const sim = ctx.input.simulation === 'include' ? true : ctx.input.simulation === 'exclude' ? false : null;
    const problems: string[] = [];
    if (color && !COLOR.test(color)) problems.push(`color: "${color}" is not #rrggbb`);
    if (ctx.input.simulation !== undefined && !['keep', 'include', 'exclude'].includes(String(ctx.input.simulation))) problems.push('simulation: keep, include or exclude');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    if (renameTo && renameTo.toLowerCase() !== b.name.toLowerCase()) {
      const clash = bodies.find((x) => x.id !== b.id && x.name.toLowerCase() === renameTo.toLowerCase()) ?? Object.entries(s.doc.bodies).find(([id, d]) => id !== b.id && d.name.toLowerCase() === renameTo.toLowerCase());
      if (clash) throw new ToolError('name_taken', `rename_to: another body is already called ${renameTo}.`, { detail: { field: 'rename_to' } });
    }
    const inSim = s.doc.bodies[b.id]?.simulation !== false;
    const plan: Plan = {
      part: `Body ${renameTo || b.name}`,
      value: false,
      body: b.id,
      name: b.name,
      renameTo: renameTo && renameTo !== b.name ? renameTo : null,
      color: color && color !== b.color.toLowerCase() ? color : null,
      simulation: sim !== null && sim !== inSim ? sim : null,
      resolved: { body: b.name },
    };
    if (plan.renameTo === null && plan.color === null && plan.simulation === null) {
      throw new ToolError('bad_input', `Nothing to change: ${b.name} already has that name, colour and simulation setting.`);
    }
    return plan;
  },

  async apply(plan, ctx: EditCtx) {
    const { doc } = ctx.services;
    await ctx.checkpoint({ label: `Body ${plan.name}` });
    if (plan.renameTo !== null) {
      const r = ctx.step.run(() => doc.renameBody(plan.body, plan.renameTo!));
      if (!r.ok) throw refused('rename_to', r);
    }
    if (plan.color !== null) {
      const r = ctx.step.run(() => doc.setBodyColor(plan.body, plan.color!));
      if (!r.ok) throw refused('color', r);
    }
    if (plan.simulation !== null) {
      const r = ctx.step.run(() => doc.setBodyInSimulation(plan.body, plan.simulation!));
      if (!r.ok) throw refused('simulation', r);
    }
    await ctx.checkpoint({ pace: 'commit' });
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const def = s.doc.bodies[plan.body];
    const info = s.rebuild.bodies.find((b) => b.id === plan.body);
    const body = { name: info?.name ?? def?.name ?? plan.name, color: info?.color ?? def?.color ?? null, simulation: def?.simulation !== false };
    const bits: string[] = [];
    if (plan.renameTo !== null) bits.push(`renamed ${body.name}`);
    if (plan.color !== null) bits.push(`colour ${plan.color}`);
    if (plan.simulation !== null) bits.push(plan.simulation ? 'in the simulation' : 'left out of the simulation');
    const text = `Body ${plan.name}: ${bits.join(', ')}`;
    return { text, data: { ...data, body }, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, bodyTool),
};
