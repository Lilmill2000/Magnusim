// "Try repair" for P2 features, the same steps as the body operations
// (src/doc/features/body-op.ts): the operation again with a fuzzy tolerance
// (0.001 mm, then 0.01 mm: DocService.repair sets `repair.fuzzy` on the
// feature), and, if the result is still not valid, the kernel's ShapeFix
// repair, kept only when it is valid and keeps the volume (1e-3 relative).
// Never a silent pass: an invalid result is the feature's error with the
// kernel's reason and "Try repair" while a further step exists.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { REPAIR_FUZZY_STEPS } from '../../doc/features/body-op';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { Feature, FeatureAction } from '../../types/doc';
import type { BuildContext } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { ShapeId } from '../../types/kernel-protocol';

/** A ShapeFix repair is kept only if the volume moved less than this (relative). */
export const REPAIR_VOLUME_TOL = 1e-3;

/** The fuzzy tolerance "Try repair" set on a feature (mm), or undefined. */
export function repairFuzzy(f: Feature): number | undefined {
  const r = (f as Feature & { repair?: { fuzzy?: unknown } }).repair;
  return r && typeof r.fuzzy === 'number' && r.fuzzy > 0 ? r.fuzzy : undefined;
}

/** "Try repair" still has a step to offer after `fuzzy`. */
export function repairActions(fuzzy: number | undefined): FeatureAction[] | undefined {
  return REPAIR_FUZZY_STEPS.some((s) => s > (fuzzy ?? 0)) ? ['repair'] : undefined;
}

async function volumeOf(ctx: BuildContext, id: ShapeId): Promise<number> {
  const r = await ctx.kernel.call('props', { id, volume: true, bbox: 'none', bbox_mode: 'fast' });
  return typeof r.result.volume === 'number' ? r.result.volume : NaN;
}

/**
 * The kernel's ShapeFix repair of an invalid shape: a new valid shape whose
 * volume matches, or null. The input is never changed (work copies).
 */
export async function shapeFix(ctx: BuildContext, id: ShapeId): Promise<ShapeId | null> {
  let fixed: ShapeId | null = null;
  try {
    const timeoutMs = timeoutForFaces('repair', await ctx.faces(id));
    const r = await ctx.kernel.call('repair', { id }, timeoutMs ? { timeoutMs } : {});
    fixed = r.result.id;
    if (r.result.valid === false) return null;
    const [before, after] = [await volumeOf(ctx, id), await volumeOf(ctx, fixed)];
    if (!(before > 0) || !(after > 0) || Math.abs(after - before) > REPAIR_VOLUME_TOL * before) return null;
    const keep = fixed;
    fixed = null;
    return keep;
  } catch (e) {
    const k = (e as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw e;
  } finally {
    if (fixed != null) await ctx.release([fixed]);
  }
}

/** "the result is not a valid solid (repair with a 0.01 mm tolerance did not fix it): NotClosed x1". */
export function invalidWords(reason: string | undefined, fuzzy: number | undefined): string {
  const why = reason ? `: ${reason.replace(/^invalid result\s*/i, '').trim()}` : '';
  const tried = fuzzy ? ` (repair with a ${fuzzy} mm tolerance did not fix it)` : '';
  return `the result is not a valid solid${tried}${why}`;
}

/** OCCT's alert names in plain words (the ones its booleans and defeaturing report). */
const OCCT_ALERT_WORDS: Record<string, string> = {
  UnableToRemoveTheFeature: 'the faces around them cannot be extended to close the gap',
  RemoveFeaturesFailed: 'the kernel could not take them out',
  NoFacesToRemove: 'there were no faces to remove',
  SelfInterferingShape: 'a body touches or crosses itself',
  AcquiredSelfIntersection: 'the result would touch or cross itself',
  IntersectionOfPairOfShapesFailed: 'two faces could not be intersected',
  IntersectionFailed: 'the bodies could not be intersected',
  TooSmallEdge: 'an edge is too small for the kernel',
  NotSplittableEdge: 'an edge could not be split',
  BuildingPCurveFailed: 'an edge could not be laid on its face',
  SolidBuilderUnusedFaces: 'some faces could not be made part of a solid',
  EmptyShape: 'an input is empty',
  UnableToGlue: 'the bodies could not be glued',
  UnableToOrientTheShape: 'the faces could not be oriented',
};

/**
 * A kernel warning text (OCCT alert names such as
 * "BOPAlgo_AlertUnableToRemoveTheFeature", one per line) in plain words; any
 * other text as it is. Review P2/P3 round 1: the raw token showed in the panel.
 */
export function occtWords(text: string): string {
  const parts = text
    .split(/[\r\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /[A-Za-z]*_Alert([A-Za-z]+)/.exec(t);
      if (!m) return t;
      return OCCT_ALERT_WORDS[m[1]] ?? m[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    });
  return [...new Set(parts)].join('; ');
}

/** The kernel's own refusal, without a trailing "; the body is unchanged" (the feature is red: nothing changed). */
export function kernelWords(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/;\s*the body is unchanged\.?$/i, '').replace(/^Error:\s*/, '');
}
