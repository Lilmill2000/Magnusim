// A sketch's dimension values changed by edit_feature (CAD tools spec §6.9): set rows name the
// sketch's driving dimensions by their ids. A headless check first (§6.4 with the new values:
// conflicts, no solution, a collapse, and `moved`), before anything changes; then the person's
// Edit panel for the sketch, one sketch-mode edit of the values (sketch mode solves the stored
// geometry again with them and stores the solution: never trusted as it was) and its honest Done.
// A value edit: a working feature that fails after it reverts the call (broke_downstream).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { isDimension, quantityOf } from '../../sketch/model';
import { modeFor } from '../../sketch/mode';
import type { CallCtx } from '../../types/assistant';
import type { FeatureId, SketchConstraint, SketchDimension, SketchFeature } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { uiFor } from '../../ui/controller';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { macrotask } from '../pace';
import type { EditCtx } from '../step';
import { storeExpr } from './compile';
import { describeSketch } from './describe';
import { sketchOutputs } from './flip';
import { toolKindOf } from './signatures';
import { solveSketch, type Solved } from './solve';
import { applyRefused } from './write';

export interface DimensionEdit {
  id: FeatureId;
  name: string;
  /** The sketch's constraints with the new values. */
  constraints: SketchConstraint[];
  set: { field: string; value: string }[];
  solved: Solved;
  /** The sketches' outputs before (the flip check). */
  before: Map<FeatureId, SketchOutput>;
}

/** Check the new values headless; refuse before anything changes. */
export async function planDimensions(ctx: CallCtx, f: SketchFeature, rows: { field: string; value: string }[]): Promise<DimensionEdit> {
  const { services } = ctx;
  const s = services.doc.state.get();
  const dims = f.constraints.filter((c): c is SketchDimension => isDimension(c) && c.driving);
  const problems: string[] = [];
  const next = new Map<string, string>();
  const fields = new Map<string, number>();
  rows.forEach((r, i) => {
    const field = String(r?.field ?? '').trim();
    const value = String(r?.value ?? '').trim();
    const c = dims.find((d) => d.id === field);
    if (!c) {
      problems.push(`set[${i}].field: ${f.name} has no dimension "${field}" (its dimensions: ${dims.length ? dims.map((d) => d.id).slice(0, 40).join(', ') : 'none'})`);
      return;
    }
    if (!value) problems.push(`set[${i}].value: enter an expression ("12 mm", "w/2")`);
    if (next.has(field)) problems.push(`set[${i}]: ${field} is set twice`);
    next.set(field, storeExpr(value, quantityOf(c.kind), services.doc.units));
    fields.set(field, i);
  });
  if (problems.length) throw new ToolError('bad_input', `${problems.slice(0, 12).join('; ')}.`, { detail: { problems: problems.slice(0, 12) } });
  const constraints = f.constraints.map((c) => (isDimension(c) && next.has(c.id) ? { ...c, expr: next.get(c.id)! } : c));
  const form = describeSketch(f, s);
  const words = (c: SketchConstraint) => `${toolKindOf(c.kind) ?? c.kind} ${c.refs.map(form.refOf).join(', ')}${'expr' in c ? ` = ${c.expr}` : ''}`;
  const solved = await solveSketch(ctx, {
    geometry: { points: f.points, entities: f.entities, constraints },
    inferred: [],
    refOf: form.refOf,
    words,
    own: new Map(),
    rows: fields,
    rowField: 'set',
    guess: f.points,
  });
  return { id: f.id, name: f.name, constraints, set: rows.map((r) => ({ field: String(r.field).trim(), value: String(r.value).trim() })), solved, before: sketchOutputs(s) };
}

/** The new values through the sketch's Edit panel and sketch mode, inside the step. */
export async function applyDimensions(ctx: EditCtx, d: DimensionEdit): Promise<void> {
  const { services } = ctx;
  const mode = modeFor(services);
  if (!mode) throw new ToolError('internal', 'Sketch mode is not running in this Part.');
  const label = `Edit ${d.name}`;
  const session = uiFor(services).openEditForAssistant(ctx.step, d.id);
  if (typeof session === 'string') throw new ToolError('bad_input', `${d.name} cannot be edited here: ${session}.`);
  await macrotask();
  await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
  const r = await mode.apply('Dimension', (cur) => ({ points: cur.points, entities: cur.entities, constraints: d.constraints }), { by: ctx.step });
  await mode.idle();
  if (!r.ok) {
    await ctx.checkpoint();
    throw applyRefused(r, (id) => id);
  }
  ctx.wrote(session);
  await ctx.checkpoint({ hold: 'sketch-step:1', pace: 'dimension', label });
  await heartbeat(ctx, services.doc.settled(ctx.signal), label);
  await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label });
  const st = services.doc.state.get().rebuild.features[d.id];
  if (st?.state === 'error') throw new ToolError('feature_failed', `${d.name} fails: ${st.message ?? 'it did not build'}`, { detail: { feature: d.name, message: st.message ?? null, actions: [...(st.actions ?? [])] } });
  const why = await mode.finish({ step: ctx.step });
  if (why) {
    await ctx.checkpoint();
    throw new ToolError('incomplete', `${d.name}: ${why}.`);
  }
}
