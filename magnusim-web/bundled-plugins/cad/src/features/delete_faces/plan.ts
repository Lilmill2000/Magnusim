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
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { LARGE_PART_FACES } from '../../kernel/timeouts';
import { withCommas } from '../../kernel/recognition';
import type { RecognizeResult, RecognizedBlend } from '../../types/kernel-protocol';
import type { DocUnits } from '../../types/units';
import { toDisplay } from '../../ui/kit/format';

/** suppress_blends runs at the largest picked radius times this (asi_ops.cpp: out.max_r). */
export const R_SLACK = 1e-3;
/** The second way runs on bodies of at most this many faces (where the full heal check runs). */
export const SECOND_WAY_MAX_FACES = LARGE_PART_FACES;

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
  if (!rec || !input.picks.length) return none;
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
  return plan;
}

// ---------------------------------------------------------------- words

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "R2" on a Part in mm, "R0.0787 in" on one in inches (4 significant digits, as the kernel's words). */
export function radiusWords(r: number, units: DocUnits): string {
  const n = +toDisplay(r, 'length', units).toPrecision(4);
  return units.length === 'mm' ? `R${n}` : `R${n} ${units.length}`;
}

/** The note of a Delete faces whose faces came off as fillets. */
export function filletsNote(r: number, units: DocUnits): string {
  return `Taken off as fillets up to ${radiusWords(r, units)} by Analysis Situs: OCCT's heal could not do it cleanly`;
}

/** After today's red words when the second way was tried and refused (`reason`: the kernel's or a rule's words). */
export function secondWayFailed(reason: string): string {
  return `; taking them off as fillets did not work either: ${reason}; the body is unchanged`;
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

export function groupWords(picked: number, more: number, fillets: boolean, holes: boolean): string {
  const what = fillets && holes ? 'fillets and holes' : fillets ? 'fillets' : 'holes';
  return `${plural(picked, 'The picked face is', 'The picked faces are')} part of ${what} with ${withCommas(more)} more ${plural(more, 'face', 'faces')}`;
}
