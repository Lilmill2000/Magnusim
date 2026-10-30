// The person's assembly checks (INSPECT > Check: Interference, Loose parts, Rotation): the engine the
// Assistant's check tool runs (src/features/assembly/check.ts) on the bodies built now, once the
// rebuild has caught up, and the tool's own reply words (interferenceReply, stackReply,
// sweepReply) and notes (a check the time limit stopped, levels left out), so the person reads what
// the Assistant reads. Rotation's axes: every line round
// faces lie on (roundAxes: shared with other bodies, or a body's own), X, Y, Z and the construction
// axes, the last ones resolved by the tool's axisOf (its words: "Z axis", "axis Pivot").
// Owner: ASSISTANT (the person's side of check).
// SPDX-License-Identifier: GPL-3.0-or-later
import { CheckKernelError, checkInterference, checkStack, checkSweep, roundAxes, type AxisLine, type CheckEnv, type InterferenceResult, type SharedAxis, type StackResult, type SweepResult } from '../assembly/check';
import { asBody, axisOf, interferenceReply, stackReply, sweepReply } from '../../assistant/tools/check';
import { personCall } from '../../assistant/person-call';
import type { AppServices } from '../../types/app';
import type { BodyId } from '../../types/doc';
import type { DocUnits } from '../../types/units';
import type { BodyInfo } from '../../types/kernel';
import { exprToStore } from '../../ui/kit/format';

export type AssemblyKind = 'interference' | 'stack' | 'sweep';

/** An axis to turn about: its line and its words (the reply's "axis"). */
export interface AxisPick {
  line: AxisLine;
  words: string;
}

export type AssemblyRequest =
  /** one: a body checked against every other of `bodies` (null: every pair of them). */
  | { kind: 'interference'; bodies: readonly BodyId[]; clearance: number; one?: BodyId | null }
  /** only: the bodies whose findings are listed (null: every body). */
  | { kind: 'stack'; only: readonly BodyId[] | null; play: number }
  | { kind: 'sweep'; turning: readonly BodyId[]; axis: AxisPick };

export interface AssemblyOutcome {
  kind: AssemblyKind;
  /** The reply's text: the words the Assistant's check gets. */
  text: string;
  /** The reply's notes (data.note: stopped at the time limit and what helps; data.thinned_note). */
  notes: string[];
  /** The rebuild it checked. */
  seq: number;
  interference?: InterferenceResult;
  stack?: StackResult;
  sweep?: SweepResult;
}

/** A length typed in a Check field ("" for `none`; a bare number is in the document's unit), in mm. */
export function lengthIn(services: AppServices, text: string, units: DocUnits, none: number): { value: number } | { error: string } {
  if (!text.trim()) return { value: none };
  const r = services.doc.units.evaluate(exprToStore(text, 'length', units), 'length');
  if (!r.ok) return { error: r.error };
  if (r.value < 0) return { error: 'It cannot be below 0' };
  return { value: r.value };
}

/** Bodies by id, in the rebuild's order; a body gone since is left out. */
const byIds = (bodies: readonly BodyInfo[], ids: readonly BodyId[]) => bodies.filter((b) => ids.includes(b.id));

/** A reply's notes, as the Assistant gets them in its data. */
const notesOf = (data: Record<string, unknown>): string[] => [data.note, data.thinned_note].filter((x): x is string => typeof x === 'string');

/** Runs one check on the Part as built once the rebuild has caught up. Throws the signal's stop, or an Error with the kernel's words. */
export async function runAssembly(services: AppServices, req: AssemblyRequest, env: CheckEnv): Promise<AssemblyOutcome> {
  await services.doc.settled(env.signal);
  const s = services.doc.state.get();
  const all = s.rebuild.bodies;
  const seq = s.rebuild.seq;
  try {
    if (req.kind === 'interference') {
      const list = byIds(all, req.bodies);
      const one = req.one ? list.findIndex((b) => b.id === req.one) : -1;
      if (req.one && one < 0) throw new Error('The selected body is gone: select it again.');
      const r = await checkInterference(env, list.map(asBody), { clearance: req.clearance, ...(one >= 0 ? { one } : {}) });
      const reply = interferenceReply(r, req.clearance);
      return { kind: 'interference', text: reply.text, notes: notesOf(reply.data), seq, interference: r };
    }
    const every = all.map(asBody);
    const index = (ids: readonly BodyId[]) => byIds(all, ids).map((b) => all.indexOf(b));
    if (req.kind === 'stack') {
      const r = await checkStack(env, every, { play: req.play, ...(req.only ? { only: index(req.only) } : {}) });
      const reply = stackReply(r, req.play);
      return { kind: 'stack', text: reply.text, notes: notesOf(reply.data), seq, stack: r };
    }
    const turning = index(req.turning);
    if (!turning.length) throw new Error('The body to turn is gone: pick another.');
    const r = await checkSweep(env, every, turning, req.axis.line);
    const reply = sweepReply(r, req.axis.words);
    return { kind: 'sweep', text: reply.text, notes: notesOf(reply.data), seq, sweep: r };
  } catch (e) {
    if (env.signal?.aborted) throw env.signal.reason ?? e;
    if (e instanceof CheckKernelError) throw new Error(`The geometry kernel could not ${e.op === 'boolean' ? 'intersect two bodies' : `run ${e.op}`}: ${e.message}`);
    throw e;
  }
}

/** Every line round faces of the bodies built now lie on, each with its bodies (indices into rebuild.bodies). */
export async function axesNow(services: AppServices, env: CheckEnv): Promise<{ seq: number; axes: SharedAxis[] }> {
  await services.doc.settled(env.signal);
  const s = services.doc.state.get();
  return { seq: s.rebuild.seq, axes: await roundAxes(env, s.rebuild.bodies.map(asBody)) };
}

/** The reference axes Rotation offers: X, Y, Z and each construction axis, by the words the check tool takes. */
export function referenceAxes(services: AppServices): string[] {
  const s = services.doc.state.get();
  const built = s.doc.features.filter((f) => f.type === 'ref_axis' && !f.suppressed && s.rebuild.outputs[f.id]?.type === 'axis').map((f) => f.name);
  return ['X axis', 'Y axis', 'Z axis', ...built];
}

/** A reference axis's line and words, as the check tool reads its axis field. */
export async function referenceAxis(services: AppServices, text: string): Promise<AxisPick> {
  const ctx = personCall(services, 'check', { kind: 'sweep', bodies: [], clearance: '', axis: text });
  const r = await axisOf(ctx, services.doc.state.get(), text);
  if (!r) throw new Error('Pick an axis.');
  return r;
}
