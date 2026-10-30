// body: rename a body, set its colour, or say whether it goes into the project's simulation
// geometry, in one step (CAD tools spec §3.2.14). "" (or keep) leaves a field as it is. The body
// is named by its name (any case), its id, or a body handle of this request (#b2, from find or
// view). Each change is the Part's own one-shot edit
// (renameBody, setBodyColor, setBodyInSimulation), with its refusal words as the message; all of
// them are one step, so a refused second change takes the first back too. `visibility` show or
// hide is the tree's eye (uiFor.setBodyVisible): view state, saved, not an undo step, so it is
// set after the step (or alone, with no step, when nothing else changes) and the reply says so.
// Its replies say see_through when the body is drawn see-through (workspace see_through sets it).
// Magnusim CAD (bridge.projectLinks() false: no projects, no simulation) offers the tool without
// `simulation` (schemas.ts cadToolsFor); an input that still asks to include or exclude a body is
// refused in plain words, and the reply says nothing of the simulation.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId } from '../../types/doc';
import type { EditResult } from '../../types/doc-service';
import type { BodyInfo } from '../../types/kernel';
import { ToolError } from '../errors';
import { waitForRead } from '../busy';
import { currentHandles } from '../selectors/handles';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { uiFor } from '../../ui/controller';
import { seeThroughOf } from '../../viewport/bind';

interface Plan extends EditPlan {
  body: BodyId;
  name: string;
  renameTo: string | null;
  color: string | null;
  simulation: boolean | null;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Magnusim CAD's refusal of a simulation choice (its tool has no such field). */
export const NO_SIMULATION = 'simulation: Magnusim CAD has no simulation, so a body has no simulation setting here: leave the field out';

/** A refusal of the Part's own edit as the tool's error. */
function refused(field: string, r: EditResult): ToolError {
  const reason = r.ok ? '' : r.reason;
  if (/already called/.test(reason)) return new ToolError('name_taken', `${field}: ${reason}.`, { detail: { field } });
  return new ToolError('bad_input', `${field}: ${reason}.`, { detail: { field } });
}

/** The body a handle of this request names (find's or view's #b2), or its selector_stale / bad_selector. */
function byHandle(ctx: CallCtx, handle: string): BodyInfo {
  const e = currentHandles(ctx.services, ctx.key)?.get(handle) ?? null;
  if (!e) throw new ToolError('selector_stale', `body: ${handle} is not a handle of this request: call find, then use the handles it gives.`, { detail: { field: 'body', handle } });
  if (e.kind !== 'body') throw new ToolError('bad_selector', `body: ${handle} is a ${e.kind}, not a body.`, { detail: { field: 'body', handle } });
  const b = ctx.services.doc.state.get().rebuild.bodies.find((x) => x.id === e.body);
  if (!b) throw new ToolError('selector_stale', `body: ${handle} is gone: ${e.bodyName} is not there now; call find again.`, { detail: { field: 'body', handle, was: e.bodyName } });
  return b;
}

/** `"Body 1 (Mirror copy)"` → `Body 1 (Mirror copy)`: a whole name in quotes, its escaped quotes and backslashes read back (labels.ts quoteName). */
export function unquoted(text: string): string {
  const t = text.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return t;
  return t.slice(1, -1).replace(/\\(["\\])/g, '$1').trim();
}

/** The body the call names (by name in any case, its id, or a handle), or not_found with the names. */
function findBody(ctx: CallCtx): BodyInfo {
  const s = ctx.services.doc.state.get();
  // A name in quotes, as get_model writes one with the selectors' own characters ("Body 1 (Mirror copy)").
  const want = unquoted(str(ctx.input.body));
  const bodies = s.rebuild.bodies;
  const b = want.startsWith('#') ? byHandle(ctx, want) : (bodies.find((x) => x.name.toLowerCase() === want.toLowerCase()) ?? bodies.find((x) => x.id === want));
  if (!b) {
    const names = bodies.map((x) => x.name);
    throw new ToolError('not_found', `No body is called "${want}". Bodies: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'body', names: names.slice(0, 30) } });
  }
  return b;
}

const bodyTool: EditTool<Plan> = {
  async plan(ctx) {
    const s = ctx.services.doc.state.get();
    const bodies = s.rebuild.bodies;
    const b = findBody(ctx);
    const renameTo = str(ctx.input.rename_to);
    const color = str(ctx.input.color).toLowerCase();
    const links = ctx.services.bridge.projectLinks();
    const sim = links && ctx.input.simulation === 'include' ? true : links && ctx.input.simulation === 'exclude' ? false : null;
    const problems: string[] = [];
    if (color && !COLOR.test(color)) problems.push(`color: "${color}" is not #rrggbb`);
    if (!links && ctx.input.simulation !== undefined && ctx.input.simulation !== '' && ctx.input.simulation !== 'keep') problems.push(NO_SIMULATION);
    else if (ctx.input.simulation !== undefined && !['keep', 'include', 'exclude'].includes(String(ctx.input.simulation))) problems.push('simulation: keep, include or exclude');
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
      throw new ToolError('bad_input', `Nothing to change: ${b.name} already has that name${links ? ', colour and simulation setting' : ' and colour'}.`);
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
    // Magnusim CAD: no simulation to speak of.
    const links = ctx.services.bridge.projectLinks();
    const body = { name: info?.name ?? def?.name ?? plan.name, color: info?.color ?? def?.color ?? null, ...(links ? { simulation: def?.simulation !== false } : {}), ...(seeThroughOf(s, ctx.services, plan.body) ? { see_through: true } : {}) };
    const bits: string[] = [];
    if (plan.renameTo !== null) bits.push(`renamed ${body.name}`);
    if (plan.color !== null) bits.push(`colour ${plan.color}`);
    if (plan.simulation !== null) bits.push(plan.simulation ? 'in the simulation' : 'left out of the simulation');
    const text = `Body ${plan.name}: ${bits.join(', ')}`;
    return { text, data: { ...data, body }, summary: text };
  },
};

/** Show or hide the body in the person's view (the tree's eye); the words for the reply. */
function setShown(ctx: CallCtx, b: BodyInfo, shown: boolean): string {
  const hidden = ctx.services.doc.state.get().view.hiddenBodies.includes(b.id);
  if (hidden === !shown) return shown ? 'already shown' : 'already hidden';
  uiFor(ctx.services).setBodyVisible(b.id, shown);
  return shown ? 'shown in the view' : 'hidden in the view';
}

const VISIBILITY = ['keep', 'show', 'hide'];

export const tool: ToolImpl = {
  kind: 'edit',
  async run(ctx) {
    const v = ctx.input.visibility ?? 'keep';
    if (!VISIBILITY.includes(String(v))) throw new ToolError('bad_input', 'visibility: keep, show or hide.', { detail: { field: 'visibility' } });
    if (v === 'keep') return runEdit(ctx, bodyTool);
    const shown = v === 'show';
    const other = !!str(ctx.input.rename_to) || !!str(ctx.input.color) || ctx.input.simulation === 'include' || ctx.input.simulation === 'exclude';
    if (!other) {
      // The eye alone: view state, no step (the person's own eye is no undo step either).
      await waitForRead(ctx);
      const b = findBody(ctx);
      const words = setShown(ctx, b, shown);
      const text = `Body ${b.name}: ${words} (view state, not an undo step)`;
      const see = seeThroughOf(ctx.services.doc.state.get(), ctx.services, b.id) ? { see_through: true } : {};
      return { text, data: { body: { name: b.name, ...see }, visibility: shown ? 'shown' : 'hidden', undo_step: false }, summary: text };
    }
    const b = findBody(ctx);
    const reply = await runEdit(ctx, bodyTool);
    const now = ctx.services.doc.state.get().rebuild.bodies.find((x) => x.id === b.id) ?? b;
    const words = setShown(ctx, now, shown);
    return { ...reply, text: `${reply.text}; ${words}`, data: { ...reply.data, visibility: shown ? 'shown' : 'hidden' }, summary: `${reply.summary ?? reply.text}; ${words}` };
  },
};
