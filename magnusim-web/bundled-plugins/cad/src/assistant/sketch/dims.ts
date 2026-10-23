// A sketch's dimension values changed by edit_feature (CAD tools spec §6.9): set rows name the
// sketch's driving dimensions by their ids. A headless check first (§6.4 with the new values, and
// the sketch's ties: pattern copies and offsets follow their sources there as in sketch mode, so
// the state, dof, free and moved it answers are the sketch's: conflicts, no solution, a collapse,
// and `moved`), before anything changes; then the person's
// Edit panel for the sketch, one sketch-mode edit of the values (sketch mode solves the stored
// geometry again with them and stores the solution: never trusted as it was) and its honest Done.
// A sketch pattern's or offset's values go the same way, as "<tie id>.<name>": count, spacing,
// angle, count2, spacing2, angle2 of a linear pattern, count and angle (the total; "full" for the
// whole circle) of a circular one, distance of an offset: the person's pattern row edit
// (updatePattern lays the copies out again: copies made or removed for a new count).
// A value edit: a working feature that fails after it reverts the call (broke_downstream).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { isDimension, quantityOf } from '../../sketch/model';
import { modeFor } from '../../sketch/mode';
import { updatePattern } from '../../sketch/tools/pattern';
import type { CallCtx } from '../../types/assistant';
import type { FeatureId, SketchConstraint, SketchDimension, SketchFeature, SketchTie } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { uiFor } from '../../ui/controller';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { macrotask } from '../pace';
import type { EditCtx } from '../step';
import { storeExpr, type SketchGeometry } from './compile';
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
  /** Its patterns' and offsets' new values, by tie id (updatePattern's patch). */
  ties: Record<string, TiePatch>;
  set: { field: string; value: string }[];
  solved: Solved;
  /** The sketches' outputs before (the flip check). */
  before: Map<FeatureId, SketchOutput>;
}

type TiePatch = Partial<Pick<SketchTie, 'count' | 'exprs' | 'full'>>;

/** The value fields of a tie (edit_feature's "<tie>.<name>"), with their values now. */
export function tieFields(t: SketchTie): { field: string; expr: string }[] {
  const f = (name: string, expr: string | number) => ({ field: `${t.id}.${name}`, expr: String(expr) });
  if (t.kind === 'offset') return [f('distance', t.exprs.distance ?? '')];
  if (t.kind === 'circular') return [f('count', t.count[0]), f('angle', t.full ? 'full' : (t.exprs.angle ?? ''))];
  return [f('count', t.count[0]), f('spacing', t.exprs.spacing1 ?? ''), f('angle', t.exprs.angle1 ?? ''), f('count2', t.count[1]), f('spacing2', t.exprs.spacing2 ?? ''), f('angle2', t.exprs.angle2 ?? '')];
}

/** Apply each tie's patch with the person's pattern edit, in order: the next geometry, or why not. */
function patchTies(d: SketchGeometry, patches: Record<string, TiePatch>, units: CallCtx['services']['doc']['units']): SketchGeometry | string {
  let g = d;
  for (const [id, patch] of Object.entries(patches)) {
    const r = updatePattern(g, id, patch, units);
    if (!r.ok) return r.reason;
    g = { ...g, ...r.draft } as SketchGeometry;
  }
  return g;
}

/** Check the new values headless; refuse before anything changes. */
export async function planDimensions(ctx: CallCtx, f: SketchFeature, rows: { field: string; value: string }[]): Promise<DimensionEdit> {
  const { services } = ctx;
  const s = services.doc.state.get();
  const dims = f.constraints.filter((c): c is SketchDimension => isDimension(c) && c.driving);
  const problems: string[] = [];
  const next = new Map<string, string>();
  const fields = new Map<string, number>();
  const ties: Record<string, TiePatch> = {};
  const tieNames = (f.ties ?? []).flatMap((t) => tieFields(t).map((x) => x.field));
  rows.forEach((r, i) => {
    const field = String(r?.field ?? '').trim();
    const value = String(r?.value ?? '').trim();
    const dot = field.lastIndexOf('.');
    const tie = dot > 0 ? (f.ties ?? []).find((t) => t.id === field.slice(0, dot)) : undefined;
    if (tie) {
      const name = field.slice(dot + 1);
      const names = tieFields(tie).map((x) => x.field.slice(tie.id.length + 1));
      if (!names.includes(name)) {
        problems.push(`set[${i}].field: ${tie.id} has no value "${name}" (its values: ${names.join(', ')})`);
        return;
      }
      if (fields.has(field)) problems.push(`set[${i}]: ${field} is set twice`);
      fields.set(field, i);
      const p = (ties[tie.id] ??= {});
      if (name === 'count' || name === 'count2') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          problems.push(`set[${i}].value: ${field} is a whole number, 1 or more, not "${value}"`);
          return;
        }
        const now = p.count ?? tie.count;
        p.count = name === 'count' ? [n, now[1]] : [now[0], n];
        return;
      }
      if (!value) {
        problems.push(`set[${i}].value: enter an expression ("12 mm", "w/4")`);
        return;
      }
      if (tie.kind === 'circular' && name === 'angle' && value.toLowerCase() === 'full') {
        p.full = true;
        return;
      }
      const key = tie.kind === 'linear' ? ({ spacing: 'spacing1', angle: 'angle1', spacing2: 'spacing2', angle2: 'angle2' } as Record<string, string>)[name] : name;
      const q = name.startsWith('angle') ? 'angle' : 'length';
      p.exprs = { ...(p.exprs ?? {}), [key]: storeExpr(value, q, services.doc.units) };
      if (tie.kind === 'circular') p.full = false;
      return;
    }
    const c = dims.find((d) => d.id === field);
    if (!c) {
      problems.push(`set[${i}].field: ${f.name} has no dimension "${field}" (its dimensions: ${dims.length ? dims.map((d) => d.id).slice(0, 40).join(', ') : 'none'}${tieNames.length ? `; its pattern and offset values: ${tieNames.slice(0, 24).join(', ')}` : ''})`);
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
  // The patterns' new values lay their copies out again, as the person's pattern row does.
  const laid = patchTies({ points: f.points, entities: f.entities, constraints, ...(f.ties ? { ties: f.ties } : {}), ...(f.links ? { links: f.links } : {}) }, ties, services.doc.units);
  if (typeof laid === 'string') throw new ToolError('bad_input', `set: ${laid}.`, { detail: { problems: [laid] } });
  const solved = await solveSketch(ctx, {
    geometry: laid,
    inferred: [],
    refOf: form.refOf,
    words,
    own: new Map(),
    rows: fields,
    rowField: 'set',
    guess: f.points,
  });
  return { id: f.id, name: f.name, constraints, ties, set: rows.map((r) => ({ field: String(r.field).trim(), value: String(r.value).trim() })), solved, before: sketchOutputs(s) };
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
  const units = services.doc.units;
  const r = await mode.apply(
    Object.keys(d.ties).length ? 'Pattern' : 'Dimension',
    (cur) => {
      const g = patchTies({ points: cur.points, entities: cur.entities, constraints: d.constraints, ...(cur.ties ? { ties: cur.ties } : {}), ...(cur.links ? { links: cur.links } : {}) }, d.ties, units);
      return typeof g === 'string' ? { ok: false, reason: g } : { ok: true, draft: g, optional: [], removed: [] };
    },
    { by: ctx.step },
  );
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
