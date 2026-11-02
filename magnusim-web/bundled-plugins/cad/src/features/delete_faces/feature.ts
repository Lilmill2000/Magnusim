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
// Kernel API 9 (round 2): OCCT's heal runs with a time budget, the call's whole watchdog limit
// (20 s, 120 s on a large part: a heal that ends within it today is never stopped), and its call
// gets HEAL_STOP_MARGIN_MS more, so a heal that never ends is red in words once the kernel stops it
// at its next progress poll (kernel-build/occt-patches/0002): "OCCT's heal did not finish in 20.0 s"
// instead of the watchdog stopping the worker. Where the heal would grow a kept curved face (not a
// plane, cylinder, cone, sphere or torus, and turned more than half a turn by the growth) more than
// 4 times its size (the kernel's far_grown), a version 2 Delete faces runs the fillet ways first and
// OCCT's heal after them (FAR_HEAL_LAST), with the same budget: on a T-block rounded R2 and then R1
// along it, the heal of the R1 rounds grows the 16 small corner pieces at their ends 10 times their
// size and ran 568 s natively before it failed, and one of its steps ran 13 s without a progress
// poll. At the red exits, after the second way, the third way (corners.ts) takes each round off
// with the corner faces of other fillets at its ends, one group at a time: ok with the note "Taken
// off one round at a time, with the 16 corner faces where they meet other fillets: ..." (output
// how 'corners'), else its words follow.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { recognitionOf } from '../../kernel/recognition';
import { kernelLookup, refOfFace } from '../../naming';
import { namesFromResult } from '../../naming/result';
import { DEFAULT_TIMEOUT_MS, timeoutForFaces } from '../../kernel/timeouts';
import type { DeleteFacesFeature, PersistentRef } from '../../types/doc';
import type { BuildContext, BuiltBody, DeleteFacesOutput, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { DefeatureStopped, RecognizeResult, ShapeId, SuppressBlendsResult } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { checkFilletsOff, checkHeal, healRefused, healWords, retryHoldBack } from '../p2/heal-check';
import { P2_ICONS } from '../p2/icons';
import { makerOf, resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, occtWords, repairFuzzy, shapeFix } from '../p2/repair';
import { cornersOff } from './corners';
import { cornersFailed, cornersNote, filletsNote, limitOf, planRed, readPick, SECOND_WAY_MAX_FACES, secondWayBudget, secondWayClause, stoppedWords } from './plan';

/** Where today's heal ended red: its words, and what follows them when the second way is not tried. */
interface Red {
  /** "Delete faces 1 failed: <why>". */
  head: string;
  /** After head when nothing more is tried ("; the body is unchanged. To take the whole fillet off, ..."), or "". */
  tail: string;
  /** The Fillet-N hint (". To take the whole fillet off, delete Fillet 1 instead"), or "". */
  hint: string;
  /** The heal was not started (far_skip, FAR_HEAL_LAST): the kernel's answer. It runs after the fillet ways. */
  skipped?: DefeatureStopped;
}

/** Today's build (OCCT's heal, two goes, Try repair): a result, or where it ended red. */
type Today = { result: FeatureBuildResult } | { red: Red };

/**
 * OCCT's heal's call gets this much more than its budget (kernel API 9 budget_ms, the call's whole
 * watchdog limit), so that the kernel's stop, at the heal's next progress poll, answers in words:
 * between two polls a heal ran up to 17 s past a 20 s budget (a T-block rounded twice).
 */
export const HEAL_STOP_MARGIN_MS = 20_000;
/**
 * Where the heal would grow a kept curved face far past its size (the kernel's far_grown), a version
 * 2 Delete faces that is not repaired runs the fillet ways first and OCCT's heal (with its whole
 * budget, as any) only when both refuse (far_skip). This is the one place OCCT's heal does not run
 * first, so a body whose heal would be ok there could come out of a fillet way instead (right by
 * every heal check, but not OCCT's result). Measured 2026-11-02: no body of the heal corpus (127
 * cases, 82 ok today) or of the Delete faces tests has such a face; of the 28 measured that have
 * (T, L, U, plus, box, I and Z blocks rounded twice, either order; B-spline copies of rounded
 * blocks and combs with some of their rounds picked), 20 heals ran past 20 s and 8 failed in
 * 1.2-7.6 s ("unable to remove the feature"); none was ok. Flat B-spline faces (heat-sink fin ends)
 * are not far_grown: those heals finish (0.4-7 s). Daniel has not confirmed this departure yet.
 * false keeps OCCT's heal first there too: the app's T-block (R2, then R1 along it) then waits for
 * the heal's 20 s budget (and a 13 s step it does not poll) before the third way takes the rounds off.
 */
export const FAR_HEAL_LAST = true;

/** The Fillet-N hint: when every face comes from one fillet or chamfer, deleting it instead. */
function makerHint(ctx: BuildContext, body: BuiltBody, indices: readonly number[]): string {
  const makers = [...new Set(indices.map((i) => makerOf(ctx.doc.features, body.names?.faces[i] ?? '')))];
  const maker = makers.length === 1 && makers[0] && (makers[0].type === 'fillet' || makers[0].type === 'chamfer') ? makers[0] : null;
  return maker ? `. To take the whole ${maker.type} off, delete ${maker.name} instead` : '';
}

/** The fillet ways may run on this Delete faces (version 2, not repaired): then a far-grown heal runs after them. */
const filletWays = (f: DeleteFacesFeature) => f.version === 2 && !f.repair;

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
  const today = await healBuild(f, ctx, body, indices, refWarning, FAR_HEAL_LAST && filletWays(f));
  if ('result' in today) return today.result;
  return redExit(f, ctx, body, indices, refWarning, today.red);
}

/**
 * OCCT's defeature, the completeness check, checkHeal and the two goes, Try repair: the build before
 * kernel API 8, with API 9's time budget (`farLast`: a heal that would grow a kept curved face far
 * past its size is not started, and red with `skipped`).
 */
async function healBuild(f: DeleteFacesFeature, ctx: BuildContext, body: BuiltBody, indices: number[], refWarning: string | null, farLast: boolean): Promise<Today> {
  const timeoutMs = timeoutForFaces('defeature', await ctx.faces(body.shape));
  let r;
  const t0 = performance.now();
  try {
    // The budget is the whole limit the watchdog gave the call before API 9: a heal that ends in it
    // (its call ended within the limit) is never stopped; the call gets the margin for the stop.
    const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const budget = { budget_ms: limit, ...(farLast ? { far_skip: true } : {}) };
    r = await ctx.kernel.call('defeature', { id: body.shape, faces: indices, ...budget }, { timeoutMs: limit + HEAL_STOP_MARGIN_MS });
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { red: { head: `${f.name} failed: ${kernelWords(err)}`, tail: '', hint: '' } };
    throw err;
  }
  // Stopped by its budget, or not started (far_skip): nothing was made, the body is unchanged.
  const stopped = r.result.stopped;
  if (stopped) {
    const hint = makerHint(ctx, body, indices);
    return { red: { head: `${f.name} failed: ${stoppedWords(stopped)}`, tail: `; the body is unchanged${hint}`, hint, ...(stopped.skipped ? { skipped: stopped } : {}) } };
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
    const hint = makerHint(ctx, body, indices);
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
 * qualifies the second way; the rest, mixed and legacy words for any. Fillets are searched without
 * holes (their own, larger face limit), holes alone, for the rest only: fillet recognition that
 * cannot run (a body over its face limit, no solid, a kernel below API 8, its own failure) leaves
 * today's words, and on a body over the holes' limit the rest is the fillet chains' alone; a face
 * limit that kept a search from running is said, naming both limits (plan.ts unsearchedWords). Then the
 * third way (corners.ts) for a version 2 Delete faces whose picks are all fillets; and a heal not
 * started (far_skip) runs now, after both, as today's build (its result, or its red words). The
 * words say each way tried and why it refused, and once that the body is unchanged.
 */
async function redExit(f: DeleteFacesFeature, ctx: BuildContext, body: BuiltBody, picks: number[], refWarning: string | null, first: Red): Promise<FeatureBuildResult> {
  let red = first;
  const skipped = red.skipped ?? null;
  const faces = await ctx.faces(body.shape);
  const recog = recognitionOf(ctx.kernel);
  const fillets = await recog.features(body.shape, { holes: false }, { faces });
  const holes = fillets.ok ? await recog.features(body.shape, { blends: false }, { faces }) : null;
  const rec = fillets.ok ? { ...fillets.result, holes: holes?.ok ? holes.result.holes : [] } : null;
  // A face limit that kept a search from running is said, with both limits (never a silent rest).
  const refusedBy = !fillets.ok ? fillets : holes && !holes.ok ? holes : null;
  const unsearched = refusedBy?.reason === 'too_large' && refusedBy.over && refusedBy.limits ? { over: refusedBy.over, limits: refusedBy.limits } : null;
  const r = rec ? readPick(rec, picks).r : null;
  let atR: RecognizeResult | null = null;
  if (rec && r !== null) {
    const at = await recog.features(body.shape, { holes: false, max_r: limitOf(r) }, { faces });
    atR = at.ok ? at.result : null;
  }
  // Rings among every fillet up to R (only where a sentence about that set may be said).
  const rings = atR?.blends.length && faces <= SECOND_WAY_MAX_FACES ? await ringFaces(ctx, body.shape) : null;
  const plan = planRed({ version: f.version, repair: !!f.repair, picks, faces, rec, atR, rings, unsearched, bodyName: ctx.bodyName(body.id), units: ctx.units.units() });
  // What was tried after OCCT's heal and refused, each "; taking them off ... : <why>".
  const tried: string[] = [];
  if (plan.takeOff && atR && plan.r !== null) {
    const sw = await takeOffAsFillets(ctx, body, picks, atR);
    if (sw.ok) {
      const names = namesFromResult(f.id, sw.out, new Map([[body.shape, body.names]]), { role: 'heal' });
      const output: DeleteFacesOutput = { type: 'delete-faces', how: 'fillets', rest: [], restRefs: [] };
      return { ok: true, bodies: [{ id: f.body, shape: sw.out.id, valid: true, names }], removed: [], note: filletsNote(plan.r, ctx.units.units(), skipped), output, ...(refWarning ? { warning: refWarning } : {}) };
    }
    tried.push(secondWayClause(sw.reason));
  }
  // The third way: rounds with the corner faces of other fillets at their ends.
  if (filletWays(f) && rec && rec.solids === 1 && faces <= SECOND_WAY_MAX_FACES && picks.length && !readPick(rec, picks).others.length) {
    const cw = await cornersOff(ctx, body, picks, rec);
    if (cw.ok) {
      // Named step by step, as the two goes are (the faces each heal makes are F:<feature>:heal...).
      let names = body.names;
      for (const s of cw.steps) names = namesFromResult(f.id, s.result, new Map([[s.from, names]]), { role: 'heal' });
      const output: DeleteFacesOutput = { type: 'delete-faces', how: 'corners', rest: [], restRefs: [] };
      return { ok: true, bodies: [{ id: f.body, shape: cw.out.id, valid: true, names }], removed: [], note: cornersNote(picks.length, cw.groups, cw.riders.length, skipped), output, ...(refWarning ? { warning: refWarning } : {}) };
    }
    if (cw.tried) tried.push(cornersFailed(cw.riders.length, cw.reason));
  }
  // Not started (far_skip): OCCT's heal runs now, as today's build, with its whole budget.
  if (red.skipped) {
    const again = await healBuild(f, ctx, body, picks, refWarning, false);
    if ('result' in again) return again.result;
    red = again.red;
  }
  let message = tried.length ? `${red.head}${tried.join('')}; the body is unchanged${red.hint}` : `${red.head}${red.tail}`;
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
    const budget = secondWayBudget.budgetMs;
    out = (await ctx.kernel.call('suppress_blends', { id: body.shape, faces: [...picks], ...(budget !== null ? { budget_ms: budget } : {}) })).result;
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
