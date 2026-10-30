// Delete faces and heal (proposal §2.8, docs/p2p3-plan.md §1.3): the kernel's
// defeature (BRepAlgoAPI_Defeaturing, with history, on a work copy) removes the
// faces and grows the neighbours to close the gap. The body keeps its id and
// its faces keep their names (faces the heal makes are F:<feature>:heal...).
// A face OCCT could not remove is an error, never a quiet partial result; an
// invalid result is red with "Try repair" (ShapeFix, kept only when valid and
// the volume holds). A heal that fills more than the gap (OCCT closing a cavity
// next to the faces: every edge of an L-block rounded and every blend removed
// gave the full box) is tried again in two goes (all but one face next to the
// fill, then that one) and refused with what it would have done when that is not
// right either (p2/heal-check.ts).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { DeleteFacesFeature } from '../../types/doc';
import type { FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { FaceNames } from '../../types/naming';
import { checkHeal, healRefused, healWords, retryHoldBack } from '../p2/heal-check';
import { P2_ICONS } from '../p2/icons';
import { makerOf, resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, occtWords, repairFuzzy, shapeFix } from '../p2/repair';

export const deleteFacesDef: FeatureTypeDef<DeleteFacesFeature, Record<string, never>> = {
  type: 'delete_faces',
  label: 'Delete faces',
  icon: P2_ICONS.deleteFaces,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'delete_faces',
      name: nextName('Delete faces', doc.features.map((f) => f.name)),
      body: '',
      faces: [],
      ...init,
    } as DeleteFacesFeature;
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete(f) {
    if (!f.body || !f.faces?.length) return 'Select the faces to delete';
    return null;
  },
  parents: () => [],
  uses: (f) => (f.body ? [f.body] : []),
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx): Promise<FeatureBuildResult> {
    const body = ctx.bodies.get(f.body);
    if (!body) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(f.body)} is not there at this point` };
    const res = await resolveRefs(ctx, body, f.faces);
    if (!res.ok) return { ok: false, message: `${f.name} failed: ${res.message}` };
    const timeoutMs = timeoutForFaces('defeature', await ctx.faces(body.shape));
    let r;
    const t0 = performance.now();
    try {
      r = await ctx.kernel.call('defeature', { id: body.shape, faces: res.indices }, timeoutMs ? { timeoutMs } : {});
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
      throw err;
    }
    let out = r.result;
    // Every face asked for must be gone: OCCT leaves a face it cannot remove in place with only a warning.
    if (out.history) {
      const gone = new Set(out.history.deleted.filter((d) => d.shape === body.shape && d.face != null).map((d) => d.face as number));
      const kept = res.indices.filter((i) => !gone.has(i));
      if (kept.length) {
        await ctx.release([out.id]);
        const why = out.warning_text ? ` (${occtWords(out.warning_text)})` : '';
        return { ok: false, message: `${f.name} failed: ${kept.length === res.indices.length ? 'the faces' : `${kept.length} of the ${res.indices.length} faces`} could not be removed and healed${why}` };
      }
    } else if (out.warnings) {
      await ctx.release([out.id]);
      return { ok: false, message: `${f.name} failed: the kernel could not remove every face${out.warning_text ? ` (${occtWords(out.warning_text)})` : ''}` };
    }
    const notes: string[] = [];
    // The heal must stay in the gap: no face that was not asked for goes, no material lands on one.
    const defeatureMs = performance.now() - t0;
    const heal = await checkHeal(ctx, body.shape, res.indices, out, undefined, { defeatureMs });
    const costMs = performance.now() - t0;
    let names: FaceNames | null = null;
    let healed = !healRefused(heal);
    if (healed) {
      names = namesFromResult(f.id, out, new Map([[body.shape, body.names]]), { role: 'heal' });
    } else {
      await ctx.release([out.id]);
      // In two goes the heal may stay in the gap (the L-block, a pocket, a slot: the right body),
      // when the added material can be compared at all.
      const again = heal.unchecked ? null : await retryHoldBack(ctx, body.shape, res.indices, [...heal.lost, ...heal.covered], { costMs });
      if (again) {
        const mid = namesFromResult(f.id, again.first, new Map([[body.shape, body.names]]), { role: 'heal' });
        names = namesFromResult(f.id, again.second, new Map([[again.first.id, mid]]), { role: 'heal' });
        await ctx.release([again.first.id]);
        out = again.second as typeof out;
        healed = true;
      }
    }
    if (!healed) {
      const makers = [...new Set(res.indices.map((i) => makerOf(ctx.doc.features, body.names?.faces[i] ?? '')))];
      const maker = makers.length === 1 && makers[0] && (makers[0].type === 'fillet' || makers[0].type === 'chamfer') ? makers[0] : null;
      const hint = maker ? `. To take the whole ${maker.type} off, delete ${maker.name} instead` : '';
      return { ok: false, message: `${f.name} failed: ${healWords(heal, body, ctx)}; the body is unchanged${hint}` };
    }
    if (heal.unchecked && !healRefused(heal)) notes.push(`${heal.unchecked}: check the result`);
    let shape = out.id;
    if (res.warning) notes.push(res.warning);
    if (out.valid === false) {
      const fuzzy = repairFuzzy(f);
      const fixed = fuzzy ? await shapeFix(ctx, out.id) : null;
      if (fixed == null) {
        await ctx.release([out.id]);
        return { ok: false, message: `${f.name} failed: ${invalidWords(out.reason, undefined)}${fuzzy ? ' (repair did not fix it)' : ''}`, actions: fuzzy ? undefined : ['repair'] };
      }
      await ctx.release([out.id]);
      shape = fixed;
      // ShapeFix rebuilt the faces: no names until repair reports history to follow.
      names = null;
      notes.push(`${ctx.bodyName(f.body)} was repaired: check the result`);
    }
    return { ok: true, bodies: [{ id: f.body, shape, valid: true, names }], removed: [], ...(notes.length ? { warning: notes.join('; ') } : {}) };
  },
};
