// Did the kernel's defeature (BRepAlgoAPI_Defeaturing) heal only the gap the removed faces
// leave? On an L-block with every edge rounded, removing every blend gave a valid 60 x 40 x 20
// box with no warning (+12,000 mm³ over the sharp L): OCCT orients the grown neighbour faces only
// by the faces and edges that survive, and with every face round the step either removed or
// grown, the step's empty cell was closed and merged in. Two rules, from the result's history
// and one boolean:
//  - lost: every face not asked for keeps a face in the result (the step's riser and floor went);
//  - covered: the material the heal added (result minus body) touches the body only through the
//    faces asked for. Material lying on a face that stays (the filled step on the riser and the
//    floor; a kept blend grown into the step's corner) is not the gap's.
// Measured on 30 legitimate removals (holes, bosses, pockets, slots, fillets, chamfers, ring
// fillets, a variable fillet from STEP, a 50-hole plate, wedge tips) and 41 wrong or subset runs:
// no refusal of a right body, every fill caught. A rule "the change stays near the faces" refused
// a wedge's tip chamfer, whose heal brings back a tip far from the small face, so it is not used.
// When the check refuses, retryHoldBack tries the faces in two goes: all but one face next to a
// face the heal took or covered, then that one; the first result that passes the same check
// against the body before is taken. Measured on the six refused bodies: the right body at the
// first to third try (0.16-0.36 s) on the L-block, U-channel, pocket, slot and side step; none
// on the T-block (two cavities: 1.5 s), which stays refused. Removing the faces in smaller groups
// (one by one, or blends at corners first) was never right on them.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { LARGE_PART_FACES } from '../../kernel/timeouts';
import { describeFace } from '../../naming/names';
import { formatVolume } from '../../ui/kit/format';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { OpHistory, ShapeId } from '../../types/kernel-protocol';

/** Added material on kept faces below this share of the added material's own area is a touch along an edge, not a face. */
const COVER_SHARE = 1e-4;

export interface HealCheck {
  /** Faces not asked for that the result has no face for. */
  lost: number[];
  /** Faces not asked for that the added material lies on. */
  covered: number[];
  /** The added material's volume (mm³); null when the boolean could not run. */
  added: number | null;
  /** Why the added material could not be checked (only `lost` was), or null. */
  unchecked: string | null;
}

/** Faces of `input` not in `picked` that the history deleted (no face of the result comes from them). */
export function lostFaces(history: OpHistory, input: ShapeId, picked: readonly number[]): number[] {
  const asked = new Set(picked);
  const out = new Set<number>();
  for (const d of history.deleted) if (d.shape === input && d.face != null && !asked.has(d.face)) out.add(d.face);
  return [...out].sort((a, b) => a - b);
}

/**
 * Faces of `input` not in `picked` that the material `added` (result minus input, with the
 * boolean's history) lies on, by area.
 */
export function coveredFaces(added: { history?: OpHistory }, areas: readonly number[], input: ShapeId, picked: readonly number[]): number[] {
  const asked = new Set(picked);
  const on = new Map<number, number>();
  for (const h of added.history?.faces ?? []) {
    for (const s of h.from) {
      if (s.shape !== input || s.face == null || asked.has(s.face) || s.how === 'generated') continue;
      on.set(s.face, (on.get(s.face) ?? 0) + (areas[h.out] ?? 0));
    }
  }
  const total = areas.reduce((a, b) => a + b, 0);
  return [...on].filter(([, a]) => a > COVER_SHARE * total && a > 1e-9).map(([f]) => f).sort((a, b) => a - b);
}

/**
 * Both rules on a defeature result `out` of `input` with faces `picked` removed (`lostKnown`: the
 * lost faces when `out` came in more than one step). Shapes it makes are released.
 */
export async function checkHeal(ctx: BuildContext, input: ShapeId, picked: readonly number[], out: { id: ShapeId; history?: OpHistory }, lostKnown?: number[]): Promise<HealCheck> {
  const lost = lostKnown ?? (out.history ? lostFaces(out.history, input, picked) : []);
  // A large part (a 100 MB STEP import: one Cut of it took 21.6 s, and a boolean of two nearly
  // identical bodies is OCCT's slowest case) gets the history rule only (on its own it caught every
  // whole fill of the corpus and 24 of the 26 fills of partial picks).
  if ((await ctx.faces(input)) > LARGE_PART_FACES) return { lost, covered: [], added: null, unchecked: null };
  let added: { id: ShapeId; empty: boolean; history?: OpHistory };
  try {
    added = (await ctx.kernel.call('boolean', { op: 'cut', targets: [out.id], tools: [input] })).result;
  } catch (err) {
    const k = (err as { kind?: string }).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { lost, covered: [], added: null, unchecked: 'the kernel could not compare the result with the body before it' };
    throw err;
  }
  try {
    if (added.empty) return { lost, covered: [], added: 0, unchecked: null };
    const topo = (await ctx.kernel.call('topo', { id: added.id, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result;
    const areas: number[] = [];
    for (const f of topo.faces) areas[f.i] = Math.abs(f.area ?? 0);
    const covered = coveredFaces(added, areas, input, picked);
    const volume = covered.length || lost.length ? ((await ctx.kernel.call('props', { id: added.id, volume: true, bbox: 'none' })).result.volume ?? null) : null;
    return { lost, covered, added: volume, unchecked: null };
  } finally {
    await ctx.release([added.id]);
  }
}

/** Is the heal refused? */
export const healRefused = (c: HealCheck) => c.lost.length > 0 || c.covered.length > 0;

/** At most this many faces are held back in turn. */
const RETRY_TRIES = 8;

type Defeatured = { id: ShapeId; valid?: boolean; warnings?: boolean; faces?: number; history?: OpHistory };

/** The result faces that come from input face `i` (modified or the same). */
function imagesOf(h: OpHistory, input: ShapeId, i: number): number[] {
  return h.faces.filter((e) => e.from.some((x) => x.shape === input && x.face === i && x.how !== 'generated')).map((e) => e.out);
}

/**
 * A refused heal tried again in two goes (see the top): each of up to RETRY_TRIES asked-for faces next
 * to a `bad` face (lost or covered), those touching fewest first, is held back while the others are
 * removed, then removed from that result. Returns both steps of the first try whose final body passes
 * checkHeal against `input`, or null (small parts only: on a large one every try is a full defeature).
 * The caller releases `first` once it has named the result.
 */
export async function retryHoldBack(ctx: BuildContext, input: ShapeId, picked: readonly number[], bad: readonly number[]): Promise<{ first: Defeatured; second: Defeatured } | null> {
  const nFaces = await ctx.faces(input);
  if (nFaces > LARGE_PART_FACES || picked.length < 2 || !bad.length) return null;
  const edges = (await ctx.kernel.call('topo', { id: input, faces: 'none', edges: 'all', vertices: 'none' })).result.edges;
  const next = new Map<number, Set<number>>();
  for (const e of edges) {
    if (e.faces.length !== 2) continue;
    for (const [a, b] of [e.faces, [e.faces[1], e.faces[0]]]) {
      if (!next.has(a)) next.set(a, new Set());
      next.get(a)!.add(b);
    }
  }
  const badSet = new Set(bad);
  const touching = (h: number) => [...(next.get(h) ?? [])].filter((x) => badSet.has(x)).length;
  const tries = picked.filter((h) => touching(h) > 0).sort((a, b) => touching(a) - touching(b) || a - b).slice(0, RETRY_TRIES);
  const asked = new Set(picked);
  const defeature = async (id: ShapeId, faces: number[]): Promise<Defeatured | null> => {
    try {
      return (await ctx.kernel.call('defeature', { id, faces })).result;
    } catch (err) {
      const k = (err as { kind?: string }).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return null;
      throw err;
    }
  };
  for (const h of tries) {
    const rest = picked.filter((x) => x !== h);
    const first = await defeature(input, rest);
    if (!first) continue;
    const h1 = first.history;
    const gone1 = new Set((h1?.deleted ?? []).filter((d) => d.shape === input && d.face != null).map((d) => d.face as number));
    const img = h1 ? imagesOf(h1, input, h) : [];
    if (!h1 || first.warnings || first.valid === false || rest.some((i) => !gone1.has(i)) || img.length !== 1) {
      await ctx.release([first.id]);
      continue;
    }
    const second = await defeature(first.id, img);
    const h2 = second?.history;
    if (!second || !h2 || second.warnings || second.valid === false || !h2.deleted.some((d) => d.shape === first.id && d.face === img[0])) {
      await ctx.release([first.id, ...(second ? [second.id] : [])]);
      continue;
    }
    const gone2 = new Set(h2.deleted.filter((d) => d.shape === first.id && d.face != null).map((d) => d.face as number));
    const lost: number[] = [];
    for (let i = 0; i < nFaces; i++) {
      if (asked.has(i)) continue;
      const im = imagesOf(h1, input, i);
      if (!im.length || im.every((o) => gone2.has(o))) lost.push(i);
    }
    const c = await checkHeal(ctx, input, picked, second, lost);
    if (!healRefused(c) && !c.unchecked) return { first, second };
    await ctx.release([first.id, second.id]);
  }
  return null;
}

/** A face of the body in the panels' words ("Side face of Extrude 2"). */
function faceWords(body: BuiltBody, i: number, ctx: BuildContext): string {
  const name = body.names?.faces[i];
  if (!name) return `Face ${i + 1} of ${ctx.bodyName(body.id)}`;
  return describeFace(name, (id) => ctx.featureName?.(id) ?? null, body.names?.faces ?? null);
}

function listWords(body: BuiltBody, faces: readonly number[], ctx: BuildContext): string {
  const words = [...new Set(faces.map((i) => faceWords(body, i, ctx)))];
  if (words.length <= 2) return words.join(' and ');
  return `${words[0]}, ${words[1]} and ${words.length - 2} more`;
}

/**
 * The refusal in plain words: "healing filled more than the gap the deleted faces leave: it would
 * add 12,398 mm³ over faces you kept (Side face of Extrude 2 and Bottom face of Extrude 2)".
 */
export function healWords(c: HealCheck, body: BuiltBody, ctx: BuildContext): string {
  const kept = [...new Set([...c.covered, ...c.lost])];
  const which = kept.length ? ` (${listWords(body, kept, ctx)})` : '';
  if (c.covered.length) {
    const vol = c.added != null && c.added > 0 ? ` ${formatVolume(c.added, ctx.units.units())}` : '';
    return `healing filled more than the gap the deleted faces leave: it would add${vol || ' material'} over faces you kept${which}`;
  }
  return `healing would also take away faces you kept${which}`;
}
