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
// Kernel API 8 (the Analysis Situs plan §3.4, §6.2): at those red exits only (a kernel refusal,
// faces not removed, a heal refused after two goes; never after an invalid result or Try repair),
// the faces are looked up among the fillets and holes recognised on the body (cached per shape),
// and:
//  - a version 2 Delete faces (every new one) whose pick is every fillet of the one solid up to its
//    largest radius takes them off as fillets (suppress_blends), kept only when checkHeal and the
//    taken, bound and surface rules pass (p2/heal-check.ts checkFilletsOff): ok, with the note
//    "Taken off as fillets up to R2 by Analysis Situs..."; else red with "; taking them off as
//    fillets did not work either: <why>; the body is unchanged";
//  - any red Delete faces says "the rest" (plan.ts) and publishes it for the panel's Add the rest
//    and get_model; one saved before version 2 whose pick would qualify says a new one may do it;
//    when every fillet up to R holds rings (faces closing on themselves, which never come off as
//    fillets), the words say so instead of offering that set.
// Every result that is ok today stays as it is: the second way never runs before OCCT's heal.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { recognitionOf } from '../../kernel/recognition';
import { kernelLookup, refOfFace } from '../../naming';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { DeleteFacesFeature, PersistentRef } from '../../types/doc';
import type { BuildContext, BuiltBody, DeleteFacesOutput, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { RecognizeResult, ShapeId, SuppressBlendsResult } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { checkFilletsOff, checkHeal, healRefused, healWords, retryHoldBack } from '../p2/heal-check';
import { P2_ICONS } from '../p2/icons';
import { makerOf, resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, occtWords, repairFuzzy, shapeFix } from '../p2/repair';
import { filletsNote, limitOf, planRed, readPick, SECOND_WAY_MAX_FACES, secondWayFailed } from './plan';

/** Where today's heal ended red: its words, and what follows them when the second way is not tried. */
interface Red {
  /** "Delete faces 1 failed: <why>". */
  head: string;
  /** After head when nothing more is tried ("; the body is unchanged. To take the whole fillet off, ..."), or "". */
  tail: string;
  /** The Fillet-N hint (". To take the whole fillet off, delete Fillet 1 instead"), or "". */
  hint: string;
}

/** Today's build (OCCT's heal, two goes, Try repair): a result, or where it ended red. */
type Today = { result: FeatureBuildResult } | { red: Red };

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
      version: 2,
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
    return deleteFacesOn(f, ctx, body, res.indices, res.warning);
  },
};

/** The build once its faces are found (`indices` on body.shape): today's heal, then its red exits. Tests run it on kernel-built bodies. */
export async function deleteFacesOn(f: DeleteFacesFeature, ctx: BuildContext, body: BuiltBody, indices: number[], refWarning: string | null = null): Promise<FeatureBuildResult> {
  const today = await healBuild(f, ctx, body, indices, refWarning);
  if ('result' in today) return today.result;
  return redExit(f, ctx, body, indices, refWarning, today.red);
}

/** OCCT's defeature, the completeness check, checkHeal and the two goes, Try repair: the build before kernel API 8, unchanged. */
async function healBuild(f: DeleteFacesFeature, ctx: BuildContext, body: BuiltBody, indices: number[], refWarning: string | null): Promise<Today> {
  const timeoutMs = timeoutForFaces('defeature', await ctx.faces(body.shape));
  let r;
  const t0 = performance.now();
  try {
    r = await ctx.kernel.call('defeature', { id: body.shape, faces: indices }, timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { red: { head: `${f.name} failed: ${kernelWords(err)}`, tail: '', hint: '' } };
    throw err;
  }
  let out = r.result;
  // Every face asked for must be gone: OCCT leaves a face it cannot remove in place with only a warning.
  if (out.history) {
    const gone = new Set(out.history.deleted.filter((d) => d.shape === body.shape && d.face != null).map((d) => d.face as number));
    const kept = indices.filter((i) => !gone.has(i));
    if (kept.length) {
      await ctx.release([out.id]);
      const why = out.warning_text ? ` (${occtWords(out.warning_text)})` : '';
      return { red: { head: `${f.name} failed: ${kept.length === indices.length ? 'the faces' : `${kept.length} of the ${indices.length} faces`} could not be removed and healed${why}`, tail: '', hint: '' } };
    }
  } else if (out.warnings) {
    await ctx.release([out.id]);
    return { red: { head: `${f.name} failed: the kernel could not remove every face${out.warning_text ? ` (${occtWords(out.warning_text)})` : ''}`, tail: '', hint: '' } };
  }
  const notes: string[] = [];
  // The heal must stay in the gap: no face that was not asked for goes, no material lands on one.
  const defeatureMs = performance.now() - t0;
  const heal = await checkHeal(ctx, body.shape, indices, out, undefined, { defeatureMs });
  const costMs = performance.now() - t0;
  let names: FaceNames | null = null;
  let healed = !healRefused(heal);
  if (healed) {
    names = namesFromResult(f.id, out, new Map([[body.shape, body.names]]), { role: 'heal' });
  } else {
    await ctx.release([out.id]);
    // In two goes the heal may stay in the gap (the L-block, a pocket, a slot: the right body),
    // when the added material can be compared at all.
    const again = heal.unchecked ? null : await retryHoldBack(ctx, body.shape, indices, [...heal.lost, ...heal.covered], { costMs });
    if (again) {
      const mid = namesFromResult(f.id, again.first, new Map([[body.shape, body.names]]), { role: 'heal' });
      names = namesFromResult(f.id, again.second, new Map([[again.first.id, mid]]), { role: 'heal' });
      await ctx.release([again.first.id]);
      out = again.second as typeof out;
      healed = true;
    }
  }
  if (!healed) {
    const makers = [...new Set(indices.map((i) => makerOf(ctx.doc.features, body.names?.faces[i] ?? '')))];
    const maker = makers.length === 1 && makers[0] && (makers[0].type === 'fillet' || makers[0].type === 'chamfer') ? makers[0] : null;
    const hint = maker ? `. To take the whole ${maker.type} off, delete ${maker.name} instead` : '';
    return { red: { head: `${f.name} failed: ${healWords(heal, body, ctx)}`, tail: `; the body is unchanged${hint}`, hint } };
  }
  if (heal.unchecked && !healRefused(heal)) notes.push(`${heal.unchecked}: check the result`);
  let shape = out.id;
  if (refWarning) notes.push(refWarning);
  if (out.valid === false) {
    const fuzzy = repairFuzzy(f);
    const fixed = fuzzy ? await shapeFix(ctx, out.id) : null;
    if (fixed == null) {
      await ctx.release([out.id]);
      return { result: { ok: false, message: `${f.name} failed: ${invalidWords(out.reason, undefined)}${fuzzy ? ' (repair did not fix it)' : ''}`, actions: fuzzy ? undefined : ['repair'] } };
    }
    await ctx.release([out.id]);
    shape = fixed;
    // ShapeFix rebuilt the faces: no names until repair reports history to follow.
    names = null;
    notes.push(`${ctx.bodyName(f.body)} was repaired: check the result`);
  }
  return { result: { ok: true, bodies: [{ id: f.body, shape, valid: true, names }], removed: [], ...(notes.length ? { warning: notes.join('; ') } : {}) } };
}

/**
 * At today's red exits: recognition (cached per shape), then for a version 2 Delete faces whose pick
 * qualifies the second way; the rest, mixed and legacy words for any. Recognition that cannot run
 * (a body over its face limit, no solid, a kernel below API 8, its own failure) leaves today's words.
 */
async function redExit(f: DeleteFacesFeature, ctx: BuildContext, body: BuiltBody, picks: number[], refWarning: string | null, red: Red): Promise<FeatureBuildResult> {
  const faces = await ctx.faces(body.shape);
  const recog = recognitionOf(ctx.kernel);
  const full = await recog.features(body.shape, {}, { faces });
  const rec = full.ok ? full.result : null;
  const r = rec ? readPick(rec, picks).r : null;
  let atR: RecognizeResult | null = null;
  if (rec && r !== null) {
    const at = await recog.features(body.shape, { holes: false, max_r: limitOf(r) }, { faces });
    atR = at.ok ? at.result : null;
  }
  // Rings among every fillet up to R (only where a sentence about that set may be said).
  const rings = atR?.blends.length && faces <= SECOND_WAY_MAX_FACES ? await ringFaces(ctx, body.shape) : null;
  const plan = planRed({ version: f.version, repair: !!f.repair, picks, faces, rec, atR, rings, bodyName: ctx.bodyName(body.id), units: ctx.units.units() });
  let message = `${red.head}${red.tail}`;
  if (plan.takeOff && atR && plan.r !== null) {
    const sw = await takeOffAsFillets(ctx, body, picks, atR);
    if (sw.ok) {
      const names = namesFromResult(f.id, sw.out, new Map([[body.shape, body.names]]), { role: 'heal' });
      const output: DeleteFacesOutput = { type: 'delete-faces', how: 'fillets', rest: [], restRefs: [] };
      return { ok: true, bodies: [{ id: f.body, shape: sw.out.id, valid: true, names }], removed: [], note: filletsNote(plan.r, ctx.units.units()), output, ...(refWarning ? { warning: refWarning } : {}) };
    }
    message = `${red.head}${secondWayFailed(sw.reason)}${red.hint}`;
  }
  if (plan.sentences.length) message += `. ${plan.sentences.join('. ')}`;
  if (!plan.rest.length) return { ok: false, message };
  const output: DeleteFacesOutput = { type: 'delete-faces', how: null, rest: plan.rest, restRefs: await refsOf(ctx, body, plan.rest) };
  return { ok: false, message, output };
}

/**
 * The faces of a solid that close on themselves (a seamed ring, such as the round on a hole's rim or
 * a boss's foot): those with an edge no other face has (the seam), as the kernel's own words tell a
 * ring (asi_ops.cpp whyLeft: BRep_Tool::IsClosed). A pole (degenerate edge) is not a seam. Null when
 * the kernel cannot say: then nothing is said about rings.
 */
export async function ringFaces(ctx: BuildContext, shape: ShapeId): Promise<Set<number> | null> {
  try {
    const t = (await ctx.kernel.call('topo', { id: shape, faces: 'none', edges: 'all', vertices: 'none', edge_length: false })).result;
    const out = new Set<number>();
    for (const e of t.edges) if (e.type !== 'degenerate' && e.faces.length === 1) out.add(e.faces[0]);
    return out;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw err;
  }
}

/**
 * The references of faces of the body (as a click on each makes them), or none when one cannot be
 * made (a face with no name): the rest is then said, with nothing for Add the rest to add.
 */
async function refsOf(ctx: BuildContext, body: BuiltBody, faces: readonly number[]): Promise<PersistentRef[]> {
  if (!body.names) return [];
  const look = kernelLookup(ctx.kernel);
  const out: PersistentRef[] = [];
  for (const i of faces) {
    try {
      out.push(await refOfFace(look, body, i));
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k && k !== 'occt' && k !== 'input' && k !== 'internal') throw err;
      return [];
    }
  }
  return out;
}

/**
 * The second way: `picks` (every fillet of the body up to R, as recognition at R `atR` reads them)
 * taken off as fillets by the kernel's suppress_blends, then every check on its result
 * (checkFilletsOff). The result, or why not in words (the kernel's own, or the check's); a refused
 * result is released. A kernel that stops or runs out of memory is thrown, as defeature's is.
 */
export async function takeOffAsFillets(ctx: BuildContext, body: BuiltBody, picks: readonly number[], atR: RecognizeResult): Promise<{ ok: true; out: SuppressBlendsResult } | { ok: false; reason: string }> {
  let out: SuppressBlendsResult;
  const t0 = performance.now();
  try {
    out = (await ctx.kernel.call('suppress_blends', { id: body.shape, faces: [...picks] })).result;
  } catch (err) {
    const e = err as KernelCallError;
    if ((e.kind === 'occt' || e.kind === 'input' || e.kind === 'internal') && !e.oom) return { ok: false, reason: kernelWords(err) };
    throw err;
  }
  const check = await checkFilletsOff(ctx, body, picks, out, atR, { suppressMs: performance.now() - t0 });
  if (check.refused) {
    await ctx.release([out.id]);
    return { ok: false, reason: check.refused.words };
  }
  return { ok: true, out };
}
