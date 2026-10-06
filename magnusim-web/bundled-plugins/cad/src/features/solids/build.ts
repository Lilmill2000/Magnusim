// Build steps the P4a sketch-based solids share (Revolve, Sweep, Loft, as Extrude
// does them): find each kept profile in its sketch's regions now (the same key, or
// "Profile repaired · check", or "Profile lost"), turn a kernel refusal into the
// feature's words, honour the result's `valid` flag, name the faces from the
// history, and hand the shape to the Operation (New body / Join / Cut / Intersect).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { applyBodyOp } from '../../doc/features/body-op';
import { plainKernelMessage } from '../../doc/rebuild';
import type { BodyMaking, FeatureId, RegionRef, SketchFeature } from '../../types/doc';
import type { BuildContext, FeatureBuildResult } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { SketchOutput } from '../../types/sketch';
import { extrudeNames } from '../extrude/names';
import { entityParents, PROFILE_REPAIRED, resolveRegionRef } from '../extrude/profiles';

export type Step<T> = { ok: true; value: T } | { ok: false; message: string };

/** The regions of one sketch a feature keeps, found now: the sketch's output and the region keys. */
export function profileKeys(name: string, profiles: readonly RegionRef[], ctx: Pick<BuildContext, 'outputs' | 'doc' | 'featureName'>): Step<{ out: SketchOutput; keys: string[]; repaired: boolean }> {
  if (!profiles.length) return { ok: false, message: `${name} failed: Pick a profile` };
  const sketchId = profiles[0].sketch;
  if (profiles.some((p) => p.sketch !== sketchId)) return { ok: false, message: `${name} failed: Pick profiles from one sketch` };
  const sketchName = ctx.featureName(sketchId);
  const out = ctx.outputs.get(sketchId);
  if (!out || out.type !== 'sketch') return { ok: false, message: `${name} failed: ${sketchName} did not build` };
  const sketch = ctx.doc.features.find((g) => g.id === sketchId) as SketchFeature | undefined;
  const parents = entityParents(sketch?.entities);
  const keys: string[] = [];
  let repaired = false;
  for (const ref of profiles) {
    const r = resolveRegionRef(ref, out.regions, parents);
    if (!r.ok) return { ok: false, message: `${name} failed: Profile lost: the region of ${sketchName} it used is gone` };
    if (r.how === 'repaired') repaired = true;
    if (!keys.includes(r.key)) keys.push(r.key);
  }
  return { ok: true, value: { out, keys, repaired } };
}

/** A kernel call that makes the feature's shape; its refusals become the feature's error. */
export async function kernelStep<T>(name: string, run: () => Promise<T>, words: (message: string) => string = plainKernelMessage): Promise<Step<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const e = err as KernelCallError;
    if (e.kind === 'input' && /region not found/i.test(e.message)) return { ok: false, message: `${name} failed: Profile lost: a region it used is gone` };
    if (e.kind === 'input' && /unknown op/i.test(e.message)) return { ok: false, message: `${name} failed: this kernel is too old for it (it needs kernel API 4)` };
    if (e.kind === 'input' || e.kind === 'occt' || e.kind === 'internal') return { ok: false, message: `${name} failed: ${words(e.message)}` };
    throw err;
  }
}

/**
 * The swept shape made (its `valid` flag honoured; named from the history as Extrude's
 * faces are), then the Operation. Owns `result.id`: released unless it becomes a body.
 */
export async function finishSwept(
  f: BodyMaking & { id: FeatureId; name: string },
  result: { id: ShapeId; valid?: boolean; reason?: string; faces?: number; history?: OpHistory },
  keys: readonly string[],
  ctx: BuildContext,
  notes: string[] = [],
): Promise<FeatureBuildResult> {
  if (result.valid === false) {
    await ctx.release([result.id]).catch(() => {});
    const why = result.reason ? `: ${result.reason.replace(/^invalid result\s*/i, '').trim()}` : '';
    return { ok: false, message: `${f.name} failed: the result is not a valid solid${why}` };
  }
  const names: FaceNames | null = extrudeNames(f.id, result, keys);
  const r = await applyBodyOp(f, f.name, { shape: result.id, valid: true, names }, ctx);
  if (r.ok && notes.length) return { ...r, warning: [r.warning, ...notes].filter(Boolean).join('; ') };
  return r;
}

export { PROFILE_REPAIRED };
