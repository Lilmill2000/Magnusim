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
// One contact on a kept face is the gap's: a removed round or chamfer that ends on a face that
// stays (a boss's corner rounds on the plate, a riser's corner rounds on the step floor, a step
// edge's round against the wall it runs into) is healed by rebuilding the sharp corner, and that
// corner's end cap lies on the face it ended on. So material on a kept face is an end cap, not a
// fill, when each piece of it borders only removed faces that stand on that face (meet it at
// about a right angle along their shared edge) and it covers at most half the face. A heal never
// puts material on a face a removed blend runs along (tangent to it, or cut into it by a chamfer):
// it grows those faces instead. Measured: the caps touch 0.08-1.1 % of the face they end on; the
// fills cover the whole riser or floor, and the kept-torus bulge borders the removed rounds that
// run along the riser and floor.
// Measured on 30 legitimate removals (holes, bosses, pockets, slots, fillets, chamfers, ring
// fillets, a variable fillet from STEP, a 50-hole plate, wedge tips) and 41 wrong or subset runs:
// no refusal of a right body, every fill caught. A rule "the change stays near the faces" refused
// a wedge's tip chamfer, whose heal brings back a tip far from the small face, so it is not used.
// The boolean is trusted only when its volumes add up: on some B-spline bodies (a wavy loft
// rounded R1) OCCT's cut returned the whole result, valid and without a warning, and every kept
// face read as covered by the body's own volume; then the result is shown with "check the result".
// It runs only where it is affordable: not on a part over LARGE_PART_FACES faces, nor after a
// defeature slower than CHECK_SLOW_MS (the cut of two nearly identical B-spline bodies takes
// 1.7-1.8 times the defeature, and the kernel's 20 s limit would stop a defeature that finished);
// both say so ("check the result").
// When the check refuses, retryHoldBack tries the faces in two goes: all but one face next to a
// face the heal took or covered, then that one; the first result that passes the same check
// against the body before is taken, within RETRY_BUDGET_MS. Measured on the six refused bodies:
// the right body at the first to third try (0.16-0.36 s) on the L-block, U-channel, pocket, slot
// and side step; none on the T-block (two cavities: 1.5 s), which stays refused. Removing the
// faces in smaller groups (one by one, or blends at corners first) was never right on them.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { LARGE_PART_FACES } from '../../kernel/timeouts';
import { describeFace } from '../../naming/names';
import { formatVolume } from '../../ui/kit/format';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { OpHistory, ShapeId, TopoResult } from '../../types/kernel-protocol';

/** Added material on kept faces below this share of the added material's own area is a touch along an edge, not a face. */
const COVER_SHARE = 1e-4;
/** An end cap covers at most this share of the kept face it lies on (the fills cover all of it). */
const CAP_SHARE = 0.5;
/** A removed face stands on a kept face when their normals along the shared edge are this far from parallel (|cos| below it: over about 70 degrees). */
const STAND_COS = 0.35;
/** The added material is not trusted when the volumes imply the heal took more than this share of the body away. */
const NOOP_SHARE = 0.5;
/** After a defeature slower than this (ms), the check's boolean is not run (see the top). */
export const CHECK_SLOW_MS = 4000;
/** The check's boolean gets this limit (ms), not the 20 s default. */
const CHECK_TIMEOUT_MS = 60_000;
/** retryHoldBack starts no try that would end after this (ms). */
export const RETRY_BUDGET_MS = 5000;

/** Why the added material was not compared (the feature adds ": check the result"). */
export const UNCHECKED = {
  failed: 'the kernel could not compare the result with the body before it',
  large: 'this part is too large to compare the result with the body before it',
  slow: 'comparing the result with the body before it would take too long on this part',
} as const;

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

/** Per face of `input` not in `picked`: the area of the material `added` (with the boolean's history) lying on it. */
export function contactAreas(added: { history?: OpHistory }, areas: readonly number[], input: ShapeId, picked: readonly number[]): Map<number, number> {
  const asked = new Set(picked);
  const on = new Map<number, number>();
  for (const h of added.history?.faces ?? []) {
    for (const s of h.from) {
      if (s.shape !== input || s.face == null || asked.has(s.face) || s.how === 'generated') continue;
      on.set(s.face, (on.get(s.face) ?? 0) + (areas[h.out] ?? 0));
    }
  }
  return on;
}

/**
 * Faces of `input` not in `picked` that the material `added` (result minus input, with the
 * boolean's history) lies on, by area.
 */
export function coveredFaces(added: { history?: OpHistory }, areas: readonly number[], input: ShapeId, picked: readonly number[]): number[] {
  const on = contactAreas(added, areas, input, picked);
  const total = areas.reduce((a, b) => a + b, 0);
  return [...on].filter(([, a]) => a > COVER_SHARE * total && a > 1e-9).map(([f]) => f).sort((a, b) => a - b);
}

type Face = TopoResult['faces'][number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: number[]): number[] | null => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? v.map((x) => x / n) : null;
};

/** The unit normal (up to its sign) of an analytic face at a point on it; null for B-spline and other faces. */
export function normalAt(f: Face, p: readonly number[]): number[] | null {
  if (f.type === 'plane') return f.normal ? unit([...f.normal]) : null;
  if (!f.axis) return null;
  const o = f.axis.origin;
  const d = unit([...f.axis.dir]);
  if (!d) return null;
  const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const h = dot(v, d);
  const radial = unit([v[0] - h * d[0], v[1] - h * d[1], v[2] - h * d[2]]);
  switch (f.type) {
    case 'sphere':
      return unit(v);
    case 'cylinder':
      return radial;
    case 'cone': {
      if (!radial || f.semi_angle_deg == null) return null;
      const a = (f.semi_angle_deg * Math.PI) / 180;
      return unit(radial.map((x, i) => x * Math.cos(a) - d[i] * Math.sin(a)));
    }
    case 'torus': {
      if (!radial || f.radius == null) return null;
      const ring = [o[0] + f.radius * radial[0], o[1] + f.radius * radial[1], o[2] + f.radius * radial[2]];
      return unit([p[0] - ring[0], p[1] - ring[1], p[2] - ring[2]]);
    }
    default:
      return null;
  }
}

/**
 * Does removed face `p` stand on kept face `k` at point `at` of their shared edge (meet it at about
 * a right angle: a round or chamfer that ends on k), rather than run along it (a fillet tangent to
 * it, a chamfer cut into it)? null when a normal is unknown (a B-spline face).
 */
export function standsOn(k: Face, p: Face, at: readonly number[]): boolean | null {
  const a = normalAt(k, at);
  const b = normalAt(p, at);
  if (!a || !b) return null;
  return Math.abs(dot(a, b)) < STAND_COS;
}

/**
 * Of the `covered` faces, those whose contact (`contact`: its area per face) is not only the end
 * caps of removed faces that stand on them (see the top). `addedId` is the added material, its
 * faces' areas `areas` and the boolean's `history`.
 */
async function notEndCaps(ctx: BuildContext, input: ShapeId, picked: readonly number[], addedId: ShapeId, history: OpHistory | undefined, areas: readonly number[], covered: readonly number[], contact: Map<number, number>): Promise<number[]> {
  const asked = new Set(picked);
  const isCovered = new Set(covered);
  const total = areas.reduce((a, b) => a + b, 0);
  // Which input faces each face of the added material lies on.
  const onKept = new Map<number, number[]>();
  const onPicked = new Map<number, number[]>();
  for (const h of history?.faces ?? []) {
    for (const s of h.from) {
      if (s.shape !== input || s.face == null || s.how === 'generated') continue;
      const into = asked.has(s.face) ? onPicked : isCovered.has(s.face) ? onKept : null;
      if (into) into.set(h.out, [...(into.get(h.out) ?? []), s.face]);
    }
  }
  // Per piece of contact: the removed faces it borders in the added material.
  const addedEdges = (await ctx.kernel.call('topo', { id: addedId, faces: 'none', edges: 'all', vertices: 'none', edge_length: false })).result.edges;
  const borders = new Map<number, Set<number>>();
  for (const e of addedEdges) {
    if (e.faces.length !== 2) continue;
    for (const [c, x] of [e.faces, [e.faces[1], e.faces[0]]]) {
      if (!onKept.has(c)) continue;
      const set = borders.get(c) ?? new Set<number>();
      for (const p of onPicked.get(x) ?? []) set.add(p);
      borders.set(c, set);
    }
  }
  // The input's edges between those faces, and the faces' geometry.
  const need = new Set<number>(covered);
  for (const s of borders.values()) for (const p of s) need.add(p);
  const inEdges = (await ctx.kernel.call('topo', { id: input, faces: 'none', edges: 'all', vertices: 'none', edge_length: false })).result.edges;
  const inFaces = (await ctx.kernel.call('topo', { id: input, faces: [...need].sort((a, b) => a - b), edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result.faces;
  const face = new Map(inFaces.map((f) => [f.i, f]));
  const stands = (k: number, p: number): boolean => {
    const fk = face.get(k);
    const fp = face.get(p);
    const shared = inEdges.filter((e) => e.faces.length === 2 && e.faces.includes(k) && e.faces.includes(p) && e.mid);
    return !!fk && !!fp && shared.length > 0 && shared.every((e) => standsOn(fk, fp, e.mid!) === true);
  };
  const pieces = new Map<number, number[]>();
  for (const [c, ks] of onKept) for (const k of ks) if ((areas[c] ?? 0) > COVER_SHARE * total) pieces.set(k, [...(pieces.get(k) ?? []), c]);
  return covered.filter((k) => {
    const own = Math.abs(face.get(k)?.area ?? 0);
    if (!(own > 0) || (contact.get(k) ?? 0) > CAP_SHARE * own) return true;
    const cs = pieces.get(k) ?? [];
    return !cs.length || cs.some((c) => {
      const ps = borders.get(c);
      return !ps || !ps.size || [...ps].some((p) => !stands(k, p));
    });
  });
}

const volumeOf = async (ctx: BuildContext, id: ShapeId) => (await ctx.kernel.call('props', { id, volume: true, bbox: 'none' })).result.volume ?? null;

/**
 * Both rules on a defeature result `out` of `input` with faces `picked` removed (`lostKnown`: the
 * lost faces when `out` came in more than one step; `defeatureMs`: how long the defeature took).
 * Shapes it makes are released.
 */
export async function checkHeal(ctx: BuildContext, input: ShapeId, picked: readonly number[], out: { id: ShapeId; history?: OpHistory }, lostKnown?: number[], opts: { defeatureMs?: number } = {}): Promise<HealCheck> {
  const lost = lostKnown ?? (out.history ? lostFaces(out.history, input, picked) : []);
  // A large part (a 100 MB STEP import: one Cut of it took 21.6 s, and a boolean of two nearly
  // identical bodies is OCCT's slowest case) gets the history rule only (on its own it caught every
  // whole fill of the corpus and 24 of the 26 fills of partial picks), and says so.
  if ((await ctx.faces(input)) > LARGE_PART_FACES) return { lost, covered: [], added: null, unchecked: UNCHECKED.large };
  if ((opts.defeatureMs ?? 0) > CHECK_SLOW_MS) return { lost, covered: [], added: null, unchecked: UNCHECKED.slow };
  let added: { id: ShapeId; empty: boolean; history?: OpHistory };
  try {
    added = (await ctx.kernel.call('boolean', { op: 'cut', targets: [out.id], tools: [input] }, { timeoutMs: CHECK_TIMEOUT_MS })).result;
  } catch (err) {
    const k = (err as { kind?: string }).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { lost, covered: [], added: null, unchecked: UNCHECKED.failed };
    throw err;
  }
  try {
    if (added.empty) return { lost, covered: [], added: 0, unchecked: null };
    const topo = (await ctx.kernel.call('topo', { id: added.id, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result;
    const areas: number[] = [];
    for (const f of topo.faces) areas[f.i] = Math.abs(f.area ?? 0);
    let covered = coveredFaces(added, areas, input, picked);
    if (!covered.length) return { lost, covered, added: lost.length ? await volumeOf(ctx, added.id) : null, unchecked: null };
    // The volumes must add up (result = body + added - taken away, nothing taken from most of the
    // body): a cut that returned the whole result is not a comparison.
    const [va, vr, vb] = [await volumeOf(ctx, added.id), await volumeOf(ctx, out.id), await volumeOf(ctx, input)];
    if (va == null || vr == null || vb == null || vb + va - vr > NOOP_SHARE * Math.abs(vb)) return { lost, covered: [], added: null, unchecked: UNCHECKED.failed };
    covered = await notEndCaps(ctx, input, picked, added.id, added.history, areas, covered, contactAreas(added, areas, input, picked));
    return { lost, covered, added: covered.length || lost.length ? va : null, unchecked: null };
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
 * No try starts that would end past RETRY_BUDGET_MS, a try taking about twice `costMs` (the first
 * defeature and its check) until one is timed. The caller releases `first` once it has named the result.
 */
export async function retryHoldBack(ctx: BuildContext, input: ShapeId, picked: readonly number[], bad: readonly number[], opts: { costMs?: number; now?: () => number } = {}): Promise<{ first: Defeatured; second: Defeatured } | null> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
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
  const defeature = async (id: ShapeId, faces: number[]): Promise<{ r: Defeatured; ms: number } | null> => {
    const s = now();
    try {
      const r = (await ctx.kernel.call('defeature', { id, faces })).result;
      return { r, ms: now() - s };
    } catch (err) {
      const k = (err as { kind?: string }).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return null;
      throw err;
    }
  };
  let tryMs = 2 * (opts.costMs ?? 0);
  for (const h of tries) {
    if (now() - t0 + tryMs > RETRY_BUDGET_MS) break;
    const started = now();
    try {
      const rest = picked.filter((x) => x !== h);
      const d1 = await defeature(input, rest);
      if (!d1) continue;
      const first = d1.r;
      const h1 = first.history;
      const gone1 = new Set((h1?.deleted ?? []).filter((d) => d.shape === input && d.face != null).map((d) => d.face as number));
      const img = h1 ? imagesOf(h1, input, h) : [];
      if (!h1 || first.warnings || first.valid === false || rest.some((i) => !gone1.has(i)) || img.length !== 1) {
        await ctx.release([first.id]);
        continue;
      }
      const d2 = await defeature(first.id, img);
      const second = d2?.r;
      const h2 = second?.history;
      if (!d2 || !second || !h2 || second.warnings || second.valid === false || !h2.deleted.some((d) => d.shape === first.id && d.face === img[0])) {
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
      const c = await checkHeal(ctx, input, picked, second, lost, { defeatureMs: Math.max(d1.ms, d2.ms) });
      if (!healRefused(c) && !c.unchecked) return { first, second };
      await ctx.release([first.id, second.id]);
    } finally {
      tryMs = Math.max(tryMs, now() - started);
    }
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
