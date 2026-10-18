// Writing a solved sketch into the Part inside the call's Assistant step (CAD tools spec §6.2, §6.5),
// through the person's own paths, so the person sees the real Sketch panel and sketch mode:
//   - an offset plane first when the sketch needs one: the CONSTRUCT Plane panel opened for the
//     Assistant (read-only for the person), Done, the rebuild, its frame read back; or the edited
//     sketch's own plane moved to the new offset;
//   - the sketch: sketch mode's startSketch(support, {step}) for a new one, the Edit panel for an
//     edit; one apply of the headless solution (sketch mode solves it again, stores it and its
//     solved state: the stored block is always the solver's); then its honest Done.
// A checkpoint follows each open, each write and the rebuild (a stop, a take-over, a change of the
// person's: the step goes back). This is the fast path; the watch path draws each entity and pulls
// it into shape (lane T12).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { modeFor, type ApplyResult } from '../../sketch/mode';
import type { Feature, FeatureId, SketchFeature, SketchSupport } from '../../types/doc';
import type { EditSession } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';
import { uiFor } from '../../ui/controller';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { macrotask } from '../pace';
import { runtimeOf } from '../runtime';
import type { EditCtx } from '../step';
import type { SketchGeometry } from './compile';

export type PlaneWrite = { kind: 'create'; name: string; plane: PlaneRef; distance: string; flip: boolean } | { kind: 'update'; id: FeatureId; name: string; distance: string; flip: boolean };

export interface SketchWrite {
  target: { kind: 'new'; support: SketchSupport; name: string } | { kind: 'edit'; id: FeatureId; name: string; patch: Partial<SketchFeature> | null };
  geometry: SketchGeometry;
}

/** The feature `id`'s failure in the rebuild now (before its Done), as the call's. */
function failedNow(ctx: EditCtx, id: FeatureId, name: string): ToolError | null {
  const st = ctx.services.doc.state.get().rebuild.features[id];
  if (st?.state !== 'error') return null;
  return new ToolError('feature_failed', `${name} fails: ${st.message ?? 'it did not build'}`, { detail: { feature: name, message: st.message ?? null, actions: [...(st.actions ?? [])] } });
}

/** Make or move the offset plane a sketch goes on, inside the step: its id. */
export async function writePlane(ctx: EditCtx, p: PlaneWrite): Promise<FeatureId> {
  const { services } = ctx;
  const { doc } = services;
  const ui = uiFor(services);
  const label = `Plane ${p.name}`;
  let session: EditSession;
  if (p.kind === 'create') {
    const s = ui.openForAssistant(ctx.step, 'ref_plane', { name: p.name, method: 'offset', plane: p.plane, distance: p.distance, flip: p.flip } as Partial<Feature>);
    if (typeof s === 'string') throw new ToolError('bad_input', `on: the plane ${p.name} could not be made: ${s}.`, { detail: { field: 'on' } });
    session = s;
    await macrotask();
    await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
  } else {
    const s = ui.openEditForAssistant(ctx.step, p.id);
    if (typeof s === 'string') throw new ToolError('bad_input', `on: the plane ${p.name} could not be moved: ${s}.`, { detail: { field: 'on' } });
    session = s;
    await macrotask();
    await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
    s.update({ distance: p.distance, flip: p.flip } as Partial<Feature>);
    ctx.wrote(s);
  }
  const id = session.feature;
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  await ctx.checkpoint({ pace: 'commit', label });
  const failed = failedNow(ctx, id, p.name);
  if (failed) throw failed;
  const why = ui.doneForAssistant(ctx.step);
  if (why) throw new ToolError('incomplete', `${p.name}: ${why}.`);
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  if (doc.state.get().rebuild.outputs[id]?.type !== 'plane') throw new ToolError('feature_failed', `${p.name} did not build.`, { detail: { feature: p.name } });
  if (p.kind === 'create') runtimeOf(services)?.madeBy.add(id);
  // Between the plane and the sketch: a change of the person's here makes the step unclean.
  await ctx.checkpoint({ hold: 'between-opens' });
  return id;
}

/** Sketch mode's refusal of the step's apply as the call's error. */
export function applyRefused(r: Extract<ApplyResult, { ok: false }>, refOf: (id: string) => string): ToolError {
  if (r.over) {
    const ids = [...(r.conflicting ?? []), ...(r.redundant ?? [])].map(refOf);
    return new ToolError('sketch_conflict', `Sketch mode found the sketch over-defined: ${ids.join(', ') || 'by its constraints'}. Nothing changed.`, { detail: { conflicts: ids.map((id) => ({ id })) } });
  }
  if (/cannot be solved/.test(r.reason)) return new ToolError('sketch_unsolved', `Sketch mode found no solution: ${r.reason}. Nothing changed.`);
  if (/shrink/.test(r.reason)) return new ToolError('sketch_collapsed', `Sketch mode: ${r.reason}. Nothing changed.`);
  return new ToolError('feature_failed', `The sketch could not be written: ${r.reason || 'sketch mode refused it'}.`);
}

/** Write the solved sketch inside the step (§6.5, fast): its feature id. */
export async function writeSketch(ctx: EditCtx, w: SketchWrite, refOf: (id: string) => string = (id) => id): Promise<FeatureId> {
  const { services } = ctx;
  const { doc } = services;
  const mode = modeFor(services);
  if (!mode) throw new ToolError('internal', 'Sketch mode is not running in this Part.');
  const name = w.target.name;
  const label = `Sketch ${name}`;
  let session: EditSession;
  if (w.target.kind === 'new') {
    const r = await mode.startSketch(w.target.support, { step: ctx.step });
    if (r !== true) {
      if (/flat faces|curved/.test(r)) throw new ToolError('not_flat', `on: ${r}.`, { detail: { field: 'on' } });
      if (/no name/.test(r)) throw new ToolError('not_named', `on: ${r}.`, { detail: { field: 'on' } });
      throw new ToolError('bad_input', `on: the sketch could not start there: ${r}.`, { detail: { field: 'on' } });
    }
    const s = mode.session;
    if (!s || !s.open || s.owner !== ctx.owner) throw new ToolError('internal', 'The sketch did not open for the Assistant.');
    session = s;
    if (s.draft.name !== name) s.update({ name } as Partial<Feature>);
  } else {
    const s = uiFor(services).openEditForAssistant(ctx.step, w.target.id);
    if (typeof s === 'string') throw new ToolError('bad_input', `edit: ${name} cannot be edited here: ${s}.`, { detail: { field: 'edit' } });
    session = s;
    if (w.target.patch) s.update(w.target.patch as Partial<Feature>);
  }
  await macrotask();
  await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
  const g = w.geometry;
  const r = await mode.apply('Sketch', () => ({ points: g.points, entities: g.entities, constraints: g.constraints }), { by: ctx.step });
  await mode.idle();
  if (!r.ok) {
    // A take-over or a stop shows first.
    await ctx.checkpoint();
    throw applyRefused(r, refOf);
  }
  ctx.wrote(session);
  await ctx.checkpoint({ hold: 'sketch-step:1', label });
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label });
  const failed = failedNow(ctx, session.feature, name);
  if (failed) throw failed;
  const why = await mode.finish({ step: ctx.step });
  if (why) {
    await ctx.checkpoint();
    throw new ToolError('incomplete', `${name}: ${why}.`);
  }
  return session.feature;
}
