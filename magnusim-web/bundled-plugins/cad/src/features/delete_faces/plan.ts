// Delete faces at a red exit (kernel API 8; the Analysis Situs plan §3.4, §6.2): what the faces
// recognised as fillets and holes say about the pick, with no kernel call of its own (the build
// asks the page's recognition client, src/kernel/recognition.ts, and passes its answers in).
//  - The second way: a version 2 Delete faces whose pick is every fillet of the one solid up to its
//    largest picked radius R takes them off as fillets (suppress_blends). "Every fillet up to R" is
//    Analysis Situs' own set at R x 1.001 (recognize max_r), the set SuppressBlendsInc takes off,
//    so the kernel's own pick check agrees (decision D8). A picked face counts as a fillet when it
//    is a recognised blend that is not 'uncertain', as the kernel counts it: a round tangent on one
//    side only ('cliff') is never added by Find or Add by size (D7), but SuppressBlendsInc's set
//    holds the cliffs inside R, so a pick that leaves them out is told so and Add the rest adds
//    them only when the person presses it. At most LARGE_PART_FACES faces (where the full heal
//    check runs) and one solid.
//  - "The rest" (any version; words and a button, never the body): the faces that would make the
//    pick whole: every fillet up to R when the fillets picked are only part of that set (version 2:
//    with all of them it may be taken off as fillets), else the rest of the fillet chains and holes
//    the picked faces are part of. A mixed pick whose fillets alone would qualify is told so, and a
//    Delete faces saved before version 2 whose pick would qualify says a new one may do it.
//  - Rings: SuppressBlendsInc never takes off a fillet face that closes on itself (a seamed ring,
//    such as the round on a hole's rim or a boss's foot; the kernel says so in words). When every
//    fillet up to R holds rings, none of those three sentences is said and the set is never the
//    rest (adding it would only be refused): the words say the rings stop it instead.
//  - Face limits (kernel API 9): on a body over the holes' limit the rest is the fillet chains'
//    alone, and over the fillets' limit there is none; the words say what was not looked for and
//    name both limits, never a rest that silently leaves holes out.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { LARGE_PART_FACES } from '../../kernel/timeouts';
import { limitWords, withCommas, type FaceLimits, type LimitKind } from '../../kernel/recognition';
import type { RecognizeResult, RecognizedBlend } from '../../types/kernel-protocol';
import type { DocUnits } from '../../types/units';
import { toDisplay } from '../../ui/kit/format';

/** suppress_blends runs at the largest picked radius times this (asi_ops.cpp: out.max_r). */
export const R_SLACK = 1e-3;
/** The second way runs on bodies of at most this many faces (where the full heal check runs). */
export const SECOND_WAY_MAX_FACES = LARGE_PART_FACES;

/**
 * The time the second way allows (ms), as suppress_blends' own `budget_ms`, which may only lower
 * the kernel's 1.4 s (kSuppressBudgetMs); null: the kernel's. Tests lower it
 * (window.__CAD__.secondWay) to show the budget's words on a small body.
 */
export const secondWayBudget: { budgetMs: number | null } = { budgetMs: null };

/** Analysis Situs' radius limit for picked fillets of largest radius r (mm). */
export const limitOf = (r: number): number => r * (1 + R_SLACK);

/** A fillet as the second way counts it (the kernel's own pick rule): a recognised blend that is not 'uncertain'. */
export const takesOff = (b: Pick<RecognizedBlend, 'kind'>): boolean => b.kind !== 'uncertain';

/** A pick as recognition reads it. */
export interface PickRead {
  /** Picked faces that are fillets (recognised blends, not 'uncertain'), sorted. */
  fillets: number[];
  /** Picked faces that are not, sorted. */
  others: number[];
  /** The largest r_max of the picked fillets (mm), null with none. */
  r: number | null;
}

const sorted = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

export function readPick(rec: RecognizeResult, picks: readonly number[]): PickRead {
  const blend = new Map(rec.blends.map((b) => [b.face, b]));
  const fillets: number[] = [];
  const others: number[] = [];
  let r: number | null = null;
  for (const i of sorted(picks)) {
    const b = blend.get(i);
    if (b && takesOff(b)) {
      fillets.push(i);
      r = Math.max(r ?? 0, b.r_max);
    } else others.push(i);
  }
  return { fillets, others, r };
}

/** Analysis Situs' own set at R (recognize max_r = limitOf(r)) against the fillets picked. */
export interface SetMatch {
  /** The set's faces. */
  size: number;
  /** The fillets picked are exactly the set. */
  same: boolean;
  /** In the set, not picked (sorted). */
  missing: number[];
  /** Picked, not in the set (read as larger fillets by Analysis Situs' single sample). */
  extra: number[];
  /** Of `missing`, the rounds tangent on one side only (kind 'cliff'). */
  cliffs: number;
  /** Faces of the set the kernel will not take (kind 'uncertain'): no pick can match it then. */
  uncertain: number;
}

export function matchSet(atR: RecognizeResult, fillets: readonly number[]): SetMatch {
  const set = new Map(atR.blends.map((b) => [b.face, b]));
  const picked = new Set(fillets);
  const missing = sorted([...set.keys()].filter((i) => !picked.has(i)));
  const extra = sorted(fillets.filter((i) => !set.has(i)));
  return {
    size: set.size,
    same: !missing.length && !extra.length && set.size === picked.size,
    missing,
    extra,
    cliffs: missing.filter((i) => set.get(i)!.kind === 'cliff').length,
    uncertain: atR.blends.filter((b) => !takesOff(b)).length,
  };
}

/** The faces of the fillet chains and drilled holes the picked faces are part of, not picked (sorted). */
export function groupRest(rec: RecognizeResult, picks: readonly number[]): { faces: number[]; fillets: boolean; holes: boolean } {
  const picked = new Set(picks);
  const out = new Set<number>();
  let fillets = false;
  let holes = false;
  for (const c of rec.chains) {
    if (!c.faces.some((i) => picked.has(i))) continue;
    for (const i of c.faces) {
      if (picked.has(i)) continue;
      out.add(i);
      fillets = true;
    }
  }
  for (const h of rec.holes) {
    if (!h.faces.some((i) => picked.has(i))) continue;
    for (const i of h.faces) {
      if (picked.has(i)) continue;
      out.add(i);
      holes = true;
    }
  }
  return { faces: sorted(out), fillets, holes };
}

export interface RedPlanInput {
  /** The feature's build version (undefined: saved before version 2). */
  version: 2 | undefined;
  /** Try repair was used on it (the second way is not tried then). */
  repair: boolean;
  /** The picked faces on the body just before it. */
  picks: readonly number[];
  /** The body's face count. */
  faces: number;
  /**
   * Fillets of the body (searched without holes) and its drilled holes (none when they could not be
   * found, such as on a body over the holes' face limit), or null when the fillets could not be found.
   */
  rec: RecognizeResult | null;
  /** Fillets of the body at limitOf(readPick(rec, picks).r), or null (none picked, or not found). */
  atR: RecognizeResult | null;
  /** Faces of the body that close on themselves (a seamed ring), at least those of `atR`; null when not looked up. */
  rings: ReadonlySet<number> | null;
  /**
   * The search a face limit refused for this body (`over`: 'fillets' when the body is over the
   * fillets' limit, so nothing was looked for; 'holes' when only its holes were not), with both
   * limits; null or absent when both searches ran (or failed for another reason).
   */
  unsearched?: { over: LimitKind; limits: FaceLimits } | null;
  bodyName: string;
  units: DocUnits;
}

export interface RedPlan {
  /** Take the picked faces off as fillets (suppress_blends): version 2, and the pick qualifies. */
  takeOff: boolean;
  /** The largest picked fillet radius (mm), null with none. */
  r: number | null;
  /** The faces Add the rest adds (indices on the body just before it), sorted. */
  rest: number[];
  /** What is said after the red text (each a sentence without its full stop). */
  sentences: string[];
}

/** What a red Delete faces does next and says, from what recognition found. */
export function planRed(input: RedPlanInput): RedPlan {
  const none: RedPlan = { takeOff: false, r: null, rest: [], sentences: [] };
  const { rec, atR } = input;
  // Over the fillets' limit: nothing was looked for, and the words say so (no rest).
  if (!rec) return input.unsearched?.over === 'fillets' && input.picks.length ? { ...none, sentences: [unsearchedWords(input.bodyName, input.picks.length, input.faces, input.unsearched)] } : none;
  if (!input.picks.length) return none;
  const read = readPick(rec, input.picks);
  const set = atR && read.fillets.length ? matchSet(atR, read.fillets) : null;
  const fits = rec.solids === 1 && input.faces <= SECOND_WAY_MAX_FACES;
  const qualifies = !!set && set.same && set.uncertain === 0 && fits;
  // Rings in the set: taking every fillet up to R off as fillets is refused, so it is never offered.
  const rings = atR && set && input.rings ? atR.blends.filter((b) => input.rings!.has(b.face)).length : 0;
  const plan: RedPlan = { ...none, r: read.r };
  const ringSaid = () => plan.sentences.push(ringWords(input.bodyName, read.r!, input.units, set!.size, rings));
  if (read.fillets.length && !read.others.length) {
    if (qualifies) {
      // Version 2 still asks the kernel, whose refusal names the rings ("a ring round a boss or a hole ...").
      if (input.version !== 2) {
        if (rings) ringSaid();
        else plan.sentences.push(LEGACY_WORDS);
      } else if (!input.repair) plan.takeOff = true;
      return plan;
    }
    // Only part of every fillet up to R: with the rest, version 2 may take them off as fillets (never with rings in it).
    if (input.version === 2 && set && fits && !set.extra.length && set.missing.length && set.uncertain === 0 && read.r !== null) {
      if (rings) ringSaid();
      else {
        plan.rest = set.missing;
        plan.sentences.push(setWords(input.bodyName, read.r, input.units, set.size, read.fillets.length, set.cliffs));
        return plan;
      }
    }
  }
  if (read.fillets.length && read.others.length && qualifies && read.r !== null) {
    if (rings) ringSaid();
    else plan.sentences.push(mixedWords(read.fillets.length, read.r, input.units));
  }
  const g = groupRest(rec, input.picks);
  if (g.faces.length) {
    plan.rest = g.faces;
    plan.sentences.push(groupWords(input.picks.length, g.faces.length, g.fillets, g.holes));
  }
  // Over the holes' limit: the rest above is the fillet chains' alone.
  if (input.unsearched?.over === 'holes') plan.sentences.push(unsearchedWords(input.bodyName, input.picks.length, input.faces, input.unsearched));
  return plan;
}

// ---------------------------------------------------------------- words

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "R2" on a Part in mm, "R0.0787 in" on one in inches (4 significant digits, as the kernel's words). */
export function radiusWords(r: number, units: DocUnits): string {
  const n = +toDisplay(r, 'length', units).toPrecision(4);
  return units.length === 'mm' ? `R${n}` : `R${n} ${units.length}`;
}

/**
 * Kernel API 9: the kept curved faces next to the picked ones that OCCT's heal grows far past their
 * size (the kernel's far_grown: faces that are not a plane, cylinder, cone, sphere or torus, grown
 * more than 4 times their own size and turned more than half a turn by it), the class whose heal
 * ran for minutes or failed: "16 small curved faces far past their size".
 */
export function farWords(n: number): string {
  return `${withCommas(n)} small curved ${plural(n, 'face', 'faces')} far past ${plural(n, 'its', 'their')} size`;
}

/** A heal the kernel did not start (far_skip): its far_grown faces and the largest ratio of growth to size. */
export interface FarSkipped {
  far_grown: readonly number[];
  far_ratio?: number;
}

/**
 * Why OCCT's heal was not run (far_skip), as measured, not as a forecast: "OCCT's heal was not run:
 * it would grow 16 small curved faces up to 10 times their size, which failed or ran past 20 s on
 * every part measured" (28 bodies, 2026-11-02: FAR_HEAL_LAST in feature.ts).
 */
export function notRunWords(s: FarSkipped): string {
  const n = s.far_grown.length;
  if (!n) return "OCCT's heal was not run";
  const their = plural(n, 'its', 'their');
  const how = s.far_ratio && s.far_ratio > 0 ? `up to ${withCommas(s.far_ratio)} times ${their} size` : `far past ${their} size`;
  return `OCCT's heal was not run: it would grow ${withCommas(n)} small curved ${plural(n, 'face', 'faces')} ${how}, which failed or ran past 20 s on every part measured`;
}

/**
 * Why another way did it, at the end of its note: OCCT's heal ran and could not, or (`skipped`: the
 * kernel's answer when the heal was not started) it was not run (notRunWords).
 */
function healCouldNot(skipped: FarSkipped | null | undefined, cleanly: boolean): string {
  if (skipped?.far_grown.length) return notRunWords(skipped);
  return `OCCT's heal could not do it${cleanly ? ' cleanly' : ''}`;
}

/** The note of a Delete faces whose faces came off as fillets (`skipped`: see healCouldNot). */
export function filletsNote(r: number, units: DocUnits, skipped?: FarSkipped | null): string {
  return `Taken off as fillets up to ${radiusWords(r, units)} by Analysis Situs: ${healCouldNot(skipped, true)}`;
}

/**
 * The note of a Delete faces whose rounds came off with the corner faces of other fillets at their
 * ends (corners.ts): `rounds` picked, taken off in `groups` goes, with `corners` corner faces
 * (`skipped`: see healCouldNot). "Taken off one round at a time, with the 16 corner faces where they
 * meet other fillets: OCCT's heal could not do it".
 */
export function cornersNote(rounds: number, groups: number, corners: number, skipped?: FarSkipped | null): string {
  const how = groups === 1 ? 'Taken off' : groups === rounds ? 'Taken off one round at a time,' : `Taken off in ${withCommas(groups)} goes,`;
  return `${how} with the ${withCommas(corners)} corner ${plural(corners, 'face', 'faces')} where ${plural(rounds, 'it meets', 'they meet')} other fillets: ${healCouldNot(skipped, false)}`;
}

/**
 * Kernel API 9: a heal its budget stopped (after "Delete faces 1 failed: "): "OCCT's heal did not
 * finish in 20.0 s", with the kept curved faces it grows far past their size when there are any
 * (": it grows 16 small curved faces far past their size"). One not started (far_skip) is never the
 * last word (the build runs the heal after the other ways), but reads honestly if it is.
 */
export function stoppedWords(s: { budget_ms: number; far_grown: readonly number[]; far_ratio?: number; skipped?: boolean }): string {
  const n = s.far_grown.length;
  if (s.skipped) return notRunWords(s);
  return `OCCT's heal did not finish in ${(s.budget_ms / 1000).toFixed(1)} s${n ? `: it grows ${farWords(n)}` : ''}`;
}

/**
 * After today's red words when the third way (corners.ts) was tried and refused: "; taking them off
 * with the 16 corner faces where they meet other fillets did not work either: <reason>".
 */
export function cornersFailed(corners: number, reason: string): string {
  return `; taking them off with the ${withCommas(corners)} corner ${plural(corners, 'face', 'faces')} where they meet other fillets did not work either: ${reason}`;
}

/**
 * suppress_blends' refusal of a run its cost model predicts over the kernel's budget, before it
 * starts (asi_ops.cpp budgetWords): "taking 100 fillet faces off as fillets on a body of 410 faces
 * would take about 6.5 s; Delete faces allows 1.4 s for taking fillets off as fillets".
 */
const BUDGET_WORDS = /^taking ([\d,]+ fillet faces?) off as fillets on a body of ([\d,]+ faces) would take (about [^;]+); (Delete faces allows [^;]+ for taking fillets off as fillets)$/;

/**
 * After today's red words when the second way was tried and refused (`reason`: the kernel's or a
 * rule's words): "; taking them off as fillets did not work either: <reason>; the body is
 * unchanged". A run refused for its time was never started, so its words say how long it would
 * take and what Delete faces allows, as the kernel says them: "; taking them off as fillets would
 * take about 6.5 s (100 fillet faces on a body of 410 faces), and Delete faces allows 1.4 s for
 * taking fillets off as fillets; the body is unchanged".
 */
export function secondWayFailed(reason: string): string {
  return `${secondWayClause(reason)}; the body is unchanged`;
}

/** secondWayFailed without its "; the body is unchanged" (the build says that once, after every way tried). */
export function secondWayClause(reason: string): string {
  const t = BUDGET_WORDS.exec(reason);
  if (t) return `; taking them off as fillets would take ${t[3]} (${t[1]} on a body of ${t[2]}), and ${t[4]}`;
  return `; taking them off as fillets did not work either: ${reason}`;
}

export const LEGACY_WORDS = 'This Delete faces was made before Delete faces could take fillets off as fillets: a new Delete faces of these faces may do it';

export function setWords(bodyName: string, r: number, units: DocUnits, size: number, picked: number, cliffs: number): string {
  const one = cliffs ? `, including ${withCommas(cliffs)} ${plural(cliffs, 'round that is', 'rounds that are')} tangent on one side only,` : '';
  return `Every fillet up to ${radiusWords(r, units)} on ${bodyName} is ${withCommas(size)} faces${one} and ${withCommas(picked)} ${plural(picked, 'is', 'are')} picked: with all ${withCommas(size)}, Delete faces can take them off as fillets`;
}

export function mixedWords(fillets: number, r: number, units: DocUnits): string {
  return `The fillets alone (${withCommas(fillets)} ${plural(fillets, 'face', 'faces')}, every fillet up to ${radiusWords(r, units)}) can be taken off as fillets in a Delete faces of their own`;
}

/** Every fillet up to R holds rings, which SuppressBlendsInc never takes off: the second way cannot do it. */
export function ringWords(bodyName: string, r: number, units: DocUnits, size: number, rings: number): string {
  const which = rings === size ? (size === 1 ? 'it is a ring' : `all ${withCommas(size)} are rings`) : `${withCommas(rings)} of the ${withCommas(size)} ${plural(rings, 'is a ring', 'are rings')}`;
  return `Delete faces cannot take the fillets up to ${radiusWords(r, units)} on ${bodyName} off as fillets: ${which} round a boss or a hole`;
}

/**
 * What the rest leaves out on a body over a face limit, naming both limits (the one it is over
 * first): "The holes the picked faces are part of are not looked for on Body 1: it has 3,000 faces,
 * and holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000"; over the
 * fillets' limit, "The fillets and holes the picked faces are part of ...".
 */
export function unsearchedWords(bodyName: string, picked: number, faces: number, u: { over: LimitKind; limits: FaceLimits }): string {
  const what = u.over === 'fillets' ? 'fillets and holes' : 'holes';
  return `The ${what} ${plural(picked, 'the picked face is', 'the picked faces are')} part of are not looked for on ${bodyName}: it has ${withCommas(faces)} faces, and ${limitWords(u.over, u.limits)}`;
}

export function groupWords(picked: number, more: number, fillets: boolean, holes: boolean): string {
  const what = fillets && holes ? 'fillets and holes' : fillets ? 'fillets' : 'holes';
  return `${plural(picked, 'The picked face is', 'The picked faces are')} part of ${what} with ${withCommas(more)} more ${plural(more, 'face', 'faces')}`;
}
