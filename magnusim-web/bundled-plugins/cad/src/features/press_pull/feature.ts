// Press-pull (proposal §2.8, docs/p2p3-plan.md §1.4, §2.4): each picked face moves along
// its own outward normal by the distance (> 0 adds material, < 0 removes it).
//   - A feature with no `version` (saved before press-pull took curved faces) keeps the API 3
//     path forever: kernel `press_pull` (a prism of each flat face, fuse or cut, unify), so a
//     saved document rebuilds exactly as it was made (fix round 1, B2).
//   - `version: 2` (every new Press-pull): flat and curved faces of one body, several at once,
//     through kernel API 6 `offset_faces` with its method chain (a true offset with fillets
//     and chamfers beside a moved face kept at their size; a cylinder's ring; the faces'
//     prisms or thickened faces where no neighbour would leave a step) and its accept rule (no
//     result is taken that loses a face, splits from adding material, cuts through itself or
//     moves the volume the wrong way or far too little or too much). When no method works the
//     feature is red in plain words with the largest distance some method takes: "Press-pull
//     1 failed: the hole would close: 9.9 mm or less works", "… could not be moved cleanly by
//     -40 mm (the result would lose a face (End face of Extrude 1)). Up to -12 mm works".
// The body keeps its id; a moved face keeps its name; a prism side face is named by the
// edge it was swept from (F:<feature>:side:E:<faceA>&<faceB>).
// Owner: P2-FEATURES (curved faces: 2026-10-06, fix round 1).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { describeFace } from '../../naming';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import { formatVolume, MM_PER } from '../../ui/kit/format';
import type { LengthUnit } from '../../types/units';
import type { PressPullFeature } from '../../types/doc';
import type { BuildContext, BuiltBody, FeatureBuildResult, FeatureTypeDef, PressPullOutput } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { OffsetFaceAbout, OffsetFacesResult, OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { P2_ICONS } from '../p2/icons';
import { resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, repairActions, repairFuzzy, shapeFix } from '../p2/repair';
import { roundDown } from '../solids/local';

const DEFAULT_DISTANCE: Record<LengthUnit, string> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

/** Input edges that side faces were swept from (history `generated` from an edge of the input shape). */
export function sweptEdges(history: OpHistory | undefined, input: ShapeId): number[] {
  const out = new Set<number>();
  for (const e of history?.faces ?? []) for (const s of e.from) if (s.shape === input && s.edge !== undefined && s.how === 'generated') out.add(s.edge);
  return [...out];
}

/** A face kind in words, for refusals ("OCCT can't offset the B-spline face"). */
export function faceKindWords(type: string): string {
  if (type === 'plane') return 'the flat face';
  if (type === 'bspline') return 'the B-spline face';
  if (type === 'other') return 'the free-form face';
  return `the ${type}`;
}

type OffsetOk = Extract<OffsetFacesResult, { refused?: undefined }>;
type OffsetRefusal = Extract<OffsetFacesResult, { refused: object }>['refused'];

/** A Chamfer feature's face, by its name (put back at its size beside a moved face). */
const CHAMFER_FACE = /(^|[|+])F:[^:|]+:chamfer:/;

export const pressPullDef: FeatureTypeDef<PressPullFeature, { d: number }> = {
  type: 'press_pull',
  label: 'Press-pull',
  icon: P2_ICONS.pressPull,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'press_pull',
      name: nextName('Press-pull', doc.features.map((f) => f.name)),
      body: '',
      faces: [],
      distance: DEFAULT_DISTANCE[doc.units.length],
      version: 2,
      ...init,
    } as PressPullFeature;
  },
  resolve(f, units) {
    const r = units.evaluate(typeof f.distance === 'string' ? f.distance : String(f.distance ?? ''), 'length');
    if (!r.ok) return { ok: false, message: `Distance: ${r.error}` };
    if (r.value === 0) return { ok: false, message: 'Distance must not be 0' };
    return { ok: true, values: { d: r.value } };
  },
  incomplete(f, units) {
    if (!f.body || !f.faces?.length) return f.version === 2 ? 'Select faces to press-pull' : 'Select flat faces to press-pull';
    const r = pressPullDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => [{ path: 'distance', expr: f.distance }],
  mapExprs: (f, fn) => ({ ...f, distance: fn(f.distance) }),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const body = ctx.bodies.get(f.body);
    if (!body) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(f.body)} is not there at this point` };
    const res = await resolveRefs(ctx, body, f.faces);
    if (!res.ok) return { ok: false, message: `${f.name} failed: ${res.message}` };
    if (f.version !== 2) return legacyBuild(f, v.d, body, res.indices, res.warning, ctx);
    return offsetBuild(f, v.d, body, res.indices, res.warning, ctx);
  },
};

/**
 * The API 3 build, unchanged (a feature saved before version 2): a prism of each flat face, one
 * fuse or cut, unify; "Try repair" with a fuzzy tolerance, then ShapeFix.
 */
async function legacyBuild(f: PressPullFeature, d: number, body: BuiltBody, faces: number[], warning: string | null, ctx: BuildContext): Promise<FeatureBuildResult> {
  const fuzzy = repairFuzzy(f);
  const timeoutMs = timeoutForFaces('press_pull', await ctx.faces(body.shape));
  let r;
  try {
    r = await ctx.kernel.call('press_pull', { id: body.shape, faces, d, ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
    throw err;
  }
  const out = r.result;
  if (out.empty) {
    await ctx.release([out.id]);
    return { ok: false, message: `${f.name} failed: press-pull would remove the whole body` };
  }
  // Side faces are named by the edge they were swept from: the edge's two faces on the input.
  const edges = sweptEdges(out.history, body.shape);
  const pairs = new Map<number, [number, number]>();
  if (edges.length && body.names) {
    const t = await ctx.kernel.call('topo', { id: body.shape, faces: 'none', edges, vertices: 'none', edge_length: false });
    for (const e of t.result.edges) if (e.faces.length >= 2) pairs.set(e.i, [e.faces[0], e.faces[1]]);
  }
  let shape = out.id;
  let names: FaceNames | null = namesFromResult(f.id, out, new Map([[body.shape, body.names]]), { role: 'side', edgeFaces: (s, e) => (s === body.shape ? (pairs.get(e) ?? null) : null) });
  const notes: string[] = [];
  if (warning) notes.push(warning);
  if (out.valid === false) {
    const fixed = fuzzy ? await shapeFix(ctx, out.id) : null;
    if (fixed == null) {
      await ctx.release([out.id]);
      return { ok: false, message: `${f.name} failed: ${invalidWords(out.reason, fuzzy)}`, actions: repairActions(fuzzy) };
    }
    await ctx.release([out.id]);
    shape = fixed;
    names = null;
    notes.push(`${ctx.bodyName(f.body)} was repaired: check the result`);
  }
  if (out.solids > 1) notes.push(`${ctx.bodyName(f.body)} is now ${out.solids} separate solids`);
  const output: PressPullOutput = { type: 'press-pull', method: 'prism', faces: [], tangent: 0, note: null, legacy: true };
  return { ok: true, bodies: [{ id: f.body, shape, valid: true, names }], removed: [], output, ...(notes.length ? { warning: notes.join('; ') } : {}) };
}

/** A face of the body in the panels' words ("End face of Extrude 1"), or null. */
function faceWords(body: BuiltBody, i: number | undefined, ctx: BuildContext): string | null {
  if (i === undefined || i < 0) return null;
  const name = body.names?.faces[i];
  if (!name) return `Face ${i + 1} of ${ctx.bodyName(body.id)}`;
  return describeFace(name, (id) => ctx.featureName?.(id) ?? null, body.names?.faces ?? null);
}

async function offsetBuild(f: PressPullFeature, d: number, body: BuiltBody, faces: number[], warning: string | null, ctx: BuildContext): Promise<FeatureBuildResult> {
  const faceCount = await ctx.faces(body.shape);
  const carry = (body.names?.faces ?? []).flatMap((n, i) => (CHAMFER_FACE.test(n) && !faces.includes(i) ? [i] : []));
  const timeoutMs = timeoutForFaces('offset_faces', faceCount);
  const params = { id: body.shape, faces, d, chain: true, ...(carry.length ? { carry } : {}) };
  let out: OffsetFacesResult;
  try {
    out = (await ctx.kernel.call('offset_faces', params, timeoutMs ? { timeoutMs } : {})).result;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
    throw err;
  }
  if (out.refused === undefined) return finishOffset(f, body, out, warning, ctx, carry);
  const words = refusalWords(out.refused, out.about, d, body, ctx);
  const tip = await suggestion(params, out.refused, faceCount, ctx);
  const output: PressPullOutput = { type: 'press-pull', method: 'offset', faces: out.about, tangent: 0, note: null, ...(out.refused.detail ? { detail: out.refused.detail } : {}) };
  return { ok: false, message: `${f.name} failed: ${words}${tip}`, output };
}

/**
 * A refusal in plain words (BRepCheck's own words go to the panel's Details, never here):
 * "the hole would close"; "the face could not be moved cleanly by -40 mm (the result would
 * lose a face (End face of Extrude 1))".
 */
export function refusalWords(r: OffsetRefusal, about: OffsetFaceAbout[], d: number, body: BuiltBody, ctx: BuildContext): string {
  if (r.code === 'radius' && r.words) return r.words;
  const fw = faceWords(body, r.face, ctx);
  const subject = about.length > 1 ? 'the faces' : 'the face';
  const why = (() => {
    switch (r.code) {
      case 'empty':
        return 'nothing would be left of the body';
      case 'gone':
        return `the moved face would be cut away${fw ? ` (${fw})` : ''}`;
      case 'lost':
        return `the result would lose a face${fw ? ` (${fw})` : ''}`;
      case 'vanish':
        return `a face next to it would shrink to nothing${fw ? ` (${fw})` : ''}`;
      case 'split':
        return 'the body would break into pieces';
      case 'volume': {
        const u = ctx.units.units();
        return `its volume would change by ${formatVolume(r.dv ?? 0, u)} instead of about ${formatVolume(r.expected ?? 0, u)}`;
      }
      case 'self':
        return 'the result would cut through itself';
      case 'invalid':
        return 'the result would not be a valid solid';
      case 'fillet': {
        const picked = about.find((a) => a.face === r.face);
        if (picked?.role === 'fillet') return 'the fillet would not fit at that radius';
        return r.words ?? 'a fillet or chamfer beside it could not be put back';
      }
      case 'step':
        return `a face next to it is not square to it, so moving it alone would leave a step${fw ? ` (${fw})` : ''}`;
      default: {
        const which = r.face !== undefined ? about.find((a) => a.face === r.face) : undefined;
        return `OCCT can't offset ${which ? faceKindWords(which.type) : about.length > 1 ? 'these faces' : 'that face'}`;
      }
    }
  })();
  return `${subject} could not be moved cleanly by ${ctx.units.format(d, 'length')} (${why})`;
}

/** mm per display unit (1 for mm, 25.4 for in, ...). */
function mmPerUnit(ctx: BuildContext): number {
  return MM_PER[ctx.units.units().length] ?? 1;
}

/**
 * What works instead, from the kernel's bisection over every method with the same accept
 * rule (at most 10 tries; not on parts over 2,000 faces), rounded down in the display unit
 * (review P6: "0.389764 in" was rounded in mm): ": 9.9 mm or less works" after a radius
 * refusal, ". 12 mm or less works" / ". Up to -12 mm works" after the others; else "try a
 * smaller distance".
 */
async function suggestion(params: { id: ShapeId; faces: number[]; d: number; chain: boolean; carry?: number[] }, refused: OffsetRefusal, faceCount: number, ctx: BuildContext): Promise<string> {
  const d = params.d;
  const radius = refused.code === 'radius';
  // Not searched (a part over 2,000 faces): a guess, said as one. Searched and nothing found: said
  // so (review B4: "try a smaller distance" was false for the Vortex outlet bores at -0.05).
  const unsearched = radius ? ': a smaller distance may work' : '. A smaller distance may work';
  const none = radius ? ': no smaller distance works either' : '. No smaller distance works either';
  if (timeoutForFaces('offset_faces', faceCount)) return unsearched;
  let r: OffsetFacesResult;
  try {
    r = (await ctx.kernel.call('offset_faces', { ...params, diagnose: true })).result;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return unsearched;
    throw err;
  }
  if (r.refused === undefined) {
    await ctx.release([r.id]);
    return unsearched;
  }
  const max = r.max_ok;
  if (!(typeof max === 'number' && max > 0)) return none;
  const unit = mmPerUnit(ctx);
  const shown = ctx.units.format(roundDown(max / unit) * unit, 'length');
  if (radius) return d > 0 ? `: ${shown} or less works` : `: up to -${shown} works`;
  return d > 0 ? `. ${shown} or less works` : `. Up to -${shown} works`;
}

async function finishOffset(f: PressPullFeature, body: BuiltBody, out: OffsetOk, warning: string | null, ctx: BuildContext, chamferFaces: number[] = []): Promise<FeatureBuildResult> {
  const notes: string[] = warning ? [warning] : [];
  const edges = sweptEdges(out.history, body.shape);
  const pairs = new Map<number, [number, number]>();
  if (edges.length && body.names) {
    const t = await ctx.kernel.call('topo', { id: body.shape, faces: 'none', edges, vertices: 'none', edge_length: false });
    for (const e of t.result.edges) if (e.faces.length >= 2) pairs.set(e.i, [e.faces[0], e.faces[1]]);
  }
  const names = namesFromResult(f.id, out, new Map([[body.shape, body.names]]), { role: 'side', edgeFaces: (s, e) => (s === body.shape ? (pairs.get(e) ?? null) : null) });
  if (out.solids > 1) notes.push(`${ctx.bodyName(f.body)} is now ${out.solids} separate solids`);
  const carried = out.carried ?? [];
  const chamfers = carried.filter((i) => chamferFaces.includes(i)).length;
  const output: PressPullOutput = { type: 'press-pull', method: out.method, faces: out.about, tangent: new Set(out.tangent).size, note: null, carried: { fillets: carried.length - chamfers, chamfers } };
  return { ok: true, bodies: [{ id: f.body, shape: out.id, valid: true, names }], removed: [], output, ...(notes.length ? { warning: notes.join('; ') } : {}) };
}
