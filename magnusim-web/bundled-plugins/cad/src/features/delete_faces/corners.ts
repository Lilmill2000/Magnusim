// Delete faces' third way (round 2 of the Analysis Situs work): rounds whose ends carry the corner
// pieces of other fillets. A T-block, Fillet 1 of every edge but the lateral ones R2, then Fillet 2
// of the 8 lateral edges R1: each R1 round ends in two small B-spline patches where it meets the
// R2 fillets (the other order, R1 first, gives a torus at a concave round and a B-spline patch at a
// convex one). OCCT's heal (BRepAlgoAPI_Defeaturing, BOPAlgo_RemoveFeatures) grows every face next
// to a removed round by the same length, the diagonal of the round's box (36 mm here); grown that
// far, a 2 mm B-spline corner patch of degree 7 x 8 is extrapolated about 22 times past its own
// range, and every intersection OCCT then runs against it crawls: the 8 rounds took 568 s natively
// and failed ("unable to remove the feature"), and in the app the kernel's 20 s watchdog stopped
// the worker. Even a heal that finished could not give the right body: in the T-block built without
// the R1 rounds the R2 fillets' straight pieces meet at a sharp corner, and the corner patches are
// gone; OCCT's heal only grows faces.
// So at today's red exits (feature.ts redExit), when every picked face is a recognised fillet and
// some carry such corner pieces ("riders"), each round goes with its riders, one group at a time,
// each on the previous result: OCCT then grows only planes and the other fillets' straight pieces,
// which it grows exactly. The result is kept only when every check of the second way passes
// (p2/heal-check.ts checkFilletsOff, with the riders counted as removed: lost and covered, the
// chain bound over the rounds and their riders, the surface rule) but the taken rule's faces: at a
// concave round the right body takes the material under its torus riders off the end faces (19.3
// mm³ on the T-block rounded R1 first), which that rule reads as taken from faces you kept; the
// volume taken is still bounded. A plus rounded R1 then R2 takes 24 riders' material, past the
// bound of its 12 rounds alone, so the bound counts the riders too (a rider's chain only by its
// share of the chain's area: the rest of that chain stays).
// A rider of a picked round: a kept face across one of its cross edges (not a spring edge, along
// which it rolls on a face) that is a corner piece of another fillet: a recognised blend, or an
// unrecognised curved face between two or more kept recognised blends. A curved face a round only
// ends on (a boss's side) is neither, nor is a face of the round's own fillet chain (the rest of
// that fillet, which the red words offer as the rest). Rounds read: cylinders and tori (other
// picks have no riders).
// Measured (2026-11-02, the whole build in Node): the app's T-block ok in 4.4 s with the volume of
// the reference T (only its non-lateral edges R2) to 2.4e-11 and a symmetric difference of 0; of 26
// T, L, U, plus, box, I and Z blocks rounded twice (either order, several radii), 17 ok this way,
// each with a symmetric difference of 0 against its reference; on the heal gate's 127 cases it
// never runs (none of the 17 still red after the second way has riders).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { checkFilletsOff, type FilletsCheck } from '../p2/heal-check';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { OpHistory, RecognizeResult, ShapeId, ShapeResult, TopoResult } from '../../types/kernel-protocol';
import { EDGE_FLAG } from '../../types/kernel-protocol';

type Face = TopoResult['faces'][number];
type Edge = TopoResult['edges'][number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]) => {
  const n = len(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const ANALYTIC = new Set(['plane', 'cylinder', 'cone', 'sphere', 'torus']);

/** Each group's heal gets this budget (ms; the kernel's budget_ms): a group that does not finish in it is refused in words. */
export const CORNER_GROUP_BUDGET_MS = 2500;
/** No group starts after this long (ms) since the first: the whole is refused in words. */
export const CORNERS_BUDGET_MS = 10_000;

/**
 * A lower budget for each group (ms), or null: CORNER_GROUP_BUDGET_MS. Tests lower it
 * (window.__CAD__.corners) to see the third way's refusal on a body it takes off.
 */
export const cornersBudget: { groupMs: number | null } = { groupMs: null };

/** A budget in seconds as the words say it: "2.5 s", "0.001 s". */
const secs = (ms: number) => `${+(ms / 1000).toFixed(ms < 100 ? 3 : 1)} s`;

/** Is edge e of round f a spring edge (along the round)? null: f is not a cylinder or torus. */
export function isSpring(f: Pick<Face, 'type' | 'axis'>, e: Pick<Edge, 'type' | 'dir' | 'axis_dir' | 'center'>): boolean | null {
  if (!f.axis) return null;
  const a = unit(f.axis.dir);
  if (f.type === 'cylinder') return e.type === 'line' && !!e.dir && Math.abs(Math.abs(dot(unit(e.dir), a)) - 1) < 1e-6;
  if (f.type === 'torus') {
    if (e.type !== 'circle' || !e.axis_dir || !e.center) return false;
    if (Math.abs(Math.abs(dot(unit(e.axis_dir), a)) - 1) > 1e-6) return false;
    const v = sub(e.center, f.axis.origin);
    return len(sub(v, a.map((x) => x * dot(v, a)))) < 1e-6;
  }
  return null;
}

/**
 * The riders of the picked faces (see the top), from the body's faces and edges (`t`), the edges'
 * flags (by edge index) and recognition (its blends and chains: a face of a picked face's own
 * chain is the rest of that fillet, never a rider); sorted. Pure: the tests feed it made-up topology.
 */
export function ridersFrom(t: Pick<TopoResult, 'faces' | 'edges'>, flags: ArrayLike<number>, picked: readonly number[], rec: Pick<RecognizeResult, 'blends' | 'chains'>): number[] {
  const pick = new Set(picked);
  const blendFaces = new Set(rec.blends.map((b) => b.face));
  const own = new Set<number>();
  for (const c of rec.chains) if (c.faces.some((x) => pick.has(x))) for (const x of c.faces) own.add(x);
  const faces = new Map(t.faces.map((f) => [f.i, f]));
  const edgesOf = new Map<number, Edge[]>();
  for (const e of t.edges) for (const f of new Set(e.faces)) edgesOf.set(f, [...(edgesOf.get(f) ?? []), e]);
  const keptBlendsBeside = (g: number) => {
    const n = new Set<number>();
    for (const e of edgesOf.get(g) ?? []) for (const o of e.faces) if (o !== g && !pick.has(o) && blendFaces.has(o)) n.add(o);
    return n.size;
  };
  const corner = (g: number) => blendFaces.has(g) || (!ANALYTIC.has(faces.get(g)?.type ?? 'plane') && keptBlendsBeside(g) >= 2);
  const out = new Set<number>();
  for (const p of picked) {
    const pf = faces.get(p);
    if (!pf) continue;
    for (const e of edgesOf.get(p) ?? []) {
      if ((flags[e.i] ?? 0) & (EDGE_FLAG.seam | EDGE_FLAG.degenerated | EDGE_FLAG.internal | EDGE_FLAG.same_domain)) continue;
      const o = e.faces.find((x) => x !== p);
      if (o == null || pick.has(o) || own.has(o) || faces.get(o)?.type === 'plane' || !corner(o)) continue;
      if (isSpring(pf, e) === false) out.add(o);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The riders of the picked faces of `input` (recognition `rec` of it), sorted. */
export async function ridersOf(ctx: BuildContext, input: ShapeId, picked: readonly number[], rec: RecognizeResult): Promise<number[]> {
  const t = (await ctx.kernel.call('topo', { id: input, faces: 'all', edges: 'all', vertices: 'none', edge_ends: true, face_bbox: 'none', face_mass: false })).result;
  const tess = await ctx.kernel.call('tessellate', { id: input, lin_defl: 0.5, ang_defl_deg: 15, edge_flags: true, smooth: true });
  return ridersFrom(t, new Uint8Array(tess.buffers.edge_flags), picked, rec);
}

/** input -> b from input -> a (h1) and a -> b (h2): the history the checks read against the body before. */
export function composeHistory(input: ShapeId, h1: OpHistory, a: ShapeId, h2: OpHistory): OpHistory {
  const srcOfA = new Map<number, OpHistory['faces'][number]['from']>();
  for (const e of h1.faces) srcOfA.set(e.out, e.from);
  const faces = h2.faces.map((e) => {
    const from: OpHistory['faces'][number]['from'] = [];
    for (const s of e.from) {
      if (s.shape !== a || s.face == null) continue;
      for (const x of srcOfA.get(s.face) ?? []) {
        const how = x.how === 'generated' || s.how === 'generated' ? 'generated' : x.how === 'same' && s.how === 'same' ? 'same' : 'modified';
        from.push({ ...x, how });
      }
    }
    return { out: e.out, from };
  });
  const deleted = [...h1.deleted];
  const goneA = new Set(h2.deleted.filter((d) => d.shape === a && d.face != null).map((d) => d.face as number));
  for (const e of h1.faces) {
    if (!goneA.has(e.out)) continue;
    for (const x of e.from) {
      if (x.shape !== input || x.face == null || x.how === 'generated') continue;
      const still = h1.faces.some((o) => o.out !== e.out && !goneA.has(o.out) && o.from.some((y) => y.shape === input && y.face === x.face));
      if (!still && !deleted.some((d) => d.shape === input && d.face === x.face)) deleted.push({ shape: input, face: x.face });
    }
  }
  return { faces, edges: [], deleted };
}

/** Groups of faces that share an edge (OCCT's features), each sorted, in order of their first face. */
export function groupsOf(t: Pick<TopoResult, 'edges'>, faces: readonly number[]): number[][] {
  const set = new Set(faces);
  const parent = new Map<number, number>(faces.map((f) => [f, f]));
  const root = (a: number): number => {
    const p = parent.get(a)!;
    if (p === a) return a;
    const r = root(p);
    parent.set(a, r);
    return r;
  };
  for (const e of t.edges) {
    const fs = [...new Set(e.faces)].filter((f) => set.has(f));
    for (let i = 1; i < fs.length; i++) parent.set(root(fs[i]), root(fs[0]));
  }
  const g = new Map<number, number[]>();
  for (const f of faces) g.set(root(f), [...(g.get(root(f)) ?? []), f]);
  return [...g.values()].map((x) => [...new Set(x)].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

/**
 * Recognition `rec` for the chain bound over `grown` (rounds and riders): a chain only partly in
 * it counts by the share of its area that is (a rider that is one piece of a long fillet chain
 * holds only its piece's corner material).
 */
export function boundRecognition(rec: RecognizeResult, grown: readonly number[], areaOf: (face: number) => number): RecognizeResult {
  const g = new Set(grown);
  return {
    ...rec,
    chains: rec.chains.map((c) => {
      const all = c.faces.reduce((s, f) => s + Math.abs(areaOf(f)), 0);
      const inside = c.faces.filter((f) => g.has(f)).reduce((s, f) => s + Math.abs(areaOf(f)), 0);
      return all > 0 && inside < all ? { ...c, length: (c.length * inside) / all } : c;
    }),
  };
}

/** One heal of the third way: the shape it ran on and its result (for the names, step by step). */
export interface CornerStep {
  from: ShapeId;
  result: ShapeResult & { history: OpHistory; faces?: number };
}

export type CornersOff =
  | { ok: true; out: { id: ShapeId; history: OpHistory; valid: true; faces?: number }; steps: CornerStep[]; riders: number[]; groups: number; check: FilletsCheck; ms: number }
  /** `tried`: false when there was nothing to do (no riders): then no words are said about it. */
  | { ok: false; reason: string; riders: number[]; tried: boolean };

/**
 * The third way: the picked rounds with their riders, one group at a time, then the checks (see
 * the top). `rec`: recognition of body.shape (every fillet, any radius). A kernel that stops or runs
 * out of memory is thrown, as defeature's is; every shape it made is released when it refuses, and
 * all but the result when it does not.
 */
export async function cornersOff(ctx: BuildContext, body: BuiltBody, picked: readonly number[], rec: RecognizeResult, opts: { now?: () => number } = {}): Promise<CornersOff> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const input = body.shape;
  const riders = await ridersOf(ctx, input, picked, rec);
  if (!riders.length) return { ok: false, reason: 'no corner of another fillet rides on them', riders, tried: false };
  const grown = [...new Set([...picked, ...riders])].sort((a, b) => a - b);
  const topo = (await ctx.kernel.call('topo', { id: input, faces: 'all', edges: 'all', vertices: 'none', face_bbox: 'none', face_mass: true })).result;
  const groups = groupsOf(topo, grown);
  let cur = input;
  let hist: OpHistory = { faces: topo.faces.map((f) => ({ out: f.i, from: [{ shape: input, face: f.i, how: 'same' as const }] })), edges: [], deleted: [] };
  let last: CornerStep['result'] | null = null;
  const steps: CornerStep[] = [];
  const made: ShapeId[] = [];
  let slowest = 0;
  const fail = async (reason: string): Promise<CornersOff> => {
    await ctx.release(made);
    return { ok: false, reason, riders, tried: true };
  };
  for (const g of groups) {
    const want = new Set(g);
    const at = hist.faces.filter((e) => e.from.some((x) => x.shape === input && x.face != null && want.has(x.face) && x.how !== 'generated')).map((e) => e.out);
    if (!at.length) continue;
    const group = Math.min(CORNER_GROUP_BUDGET_MS, cornersBudget.groupMs ?? CORNER_GROUP_BUDGET_MS);
    const left = CORNERS_BUDGET_MS - (now() - t0);
    if (left < Math.min(group, Math.max(250, slowest))) return fail(`it did not finish in ${secs(CORNERS_BUDGET_MS)}`);
    const budget = Math.max(1, Math.round(Math.min(group, left)));
    let r;
    const s = now();
    try {
      r = (await ctx.kernel.call('defeature', { id: cur, faces: at, budget_ms: budget })).result;
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return fail('OCCT could not take a round off with its corner faces');
      throw err;
    }
    slowest = Math.max(slowest, now() - s);
    if (r.stopped) return fail(`taking a round off with its corner faces did not finish in ${secs(r.stopped.budget_ms)}`);
    const gone = new Set(r.history.deleted.filter((d) => d.shape === cur && d.face != null).map((d) => d.face as number));
    if (at.some((i) => !gone.has(i)) || r.warnings || r.valid === false) {
      await ctx.release([r.id]);
      return fail(r.valid === false ? 'the result was not a valid solid' : 'OCCT could not take a round off with its corner faces');
    }
    hist = composeHistory(input, hist, cur, r.history);
    steps.push({ from: cur, result: r });
    last = r;
    cur = r.id;
    made.push(cur);
  }
  if (!last) return fail('OCCT could not take a round off with its corner faces');
  const out = { id: cur, history: hist, valid: true as const, ...(typeof last.faces === 'number' ? { faces: last.faces } : {}) };
  const areas = new Map(topo.faces.map((f) => [f.i, f.area ?? 0]));
  const check = await checkFilletsOff(ctx, body, grown, out, boundRecognition(rec, grown, (f) => areas.get(f) ?? 0), { suppressMs: slowest, takenRule: false });
  if (check.refused) return fail(check.refused.words);
  await ctx.release(made.slice(0, -1));
  return { ok: true, out, steps, riders, groups: steps.length, check, ms: now() - t0 };
}
