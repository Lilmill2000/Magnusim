// The chamfer feature type (proposal §2.5): an equal distance, or two distances
// (Distance 1 on each edge's reference face, Distance 2 on the other; Flip swaps
// them), on edges of one body. Picks as Fillet's (an edge takes its tangent chain, a
// face all its edges). Kernel `chamfer` on a work copy; the result's `valid` flag is
// honoured; a failure names the edges and asks for a smaller distance. The body keeps
// its id; a chamfer face is F:<id>:chamfer:E:<a>&<b>.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { ChamferFeature } from '../../types/doc';
import type { ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { LengthUnit, UnitsService } from '../../types/units';
import { kernelStep } from '../solids/build';
import { SOLIDS_ICONS } from '../solids/icons';
import { bodyFor, cachedLookup, edgeListWords, resolveEdgeSet, roundDown } from '../solids/local';
import { describeFace } from '../../naming';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { NamingLookup } from '../../types/naming';
import { localOpNames } from '../solids/naming';

const DEFAULT_DISTANCE: Record<LengthUnit, string> = { mm: '1 mm', cm: '0.1 cm', m: '0.001 m', in: '0.05 in', ft: '0.05 in' };

export interface ChamferValues {
  d: number;
  d2: number | null;
}

function length(label: string, expr: string, units: UnitsService): { ok: true; value: number } | { ok: false; message: string } {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), 'length');
  if (!r.ok) return { ok: false, message: `${label}: ${r.error}` };
  if (!(r.value > 0)) return { ok: false, message: `${label} must be more than 0` };
  return { ok: true, value: r.value };
}

export function resolveChamfer(f: Pick<ChamferFeature, 'mode' | 'distance' | 'distance2'>, units: UnitsService): ResolveResult<ChamferValues> {
  const d = length(f.mode === 'two' ? 'Distance 1' : 'Distance', f.distance, units);
  if (!d.ok) return d;
  if (f.mode !== 'two') return { ok: true, values: { d: d.value, d2: null } };
  const d2 = length('Distance 2', f.distance2, units);
  if (!d2.ok) return d2;
  return { ok: true, values: { d: d.value, d2: d2.value } };
}

/**
 * The largest scale (0..1) of the distances that still chamfers, by halving on work copies (each
 * result released), or null when even a sixty-fourth fails. A too-large distance then says what
 * works, as Fillet's does (P4a review).
 */
async function largestScaleThatWorks(ctx: BuildContext, body: BuiltBody, edges: number[], v: ChamferValues, flip: boolean): Promise<number | null> {
  const tries = async (s: number) => {
    try {
      const r = await ctx.kernel.call('chamfer', { id: body.shape, edges, d: v.d * s, ...(v.d2 != null ? { d2: v.d2 * s, flip } : {}) });
      await ctx.release([r.result.id]);
      return r.result.valid !== false;
    } catch (err) {
      const k = (err as { kind?: string }).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return false;
      throw err;
    }
  };
  let lo = 0;
  let hi = 1;
  for (let s = 0.5; s >= 1 / 64; s /= 2) {
    if (await tries(s)) {
      lo = s;
      break;
    }
    hi = s;
  }
  if (!lo) return null;
  for (let k = 0; k < 5; k++) {
    const mid = (lo + hi) / 2;
    if (await tries(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The faces Distance 1 runs on (each edge's lower-numbered face, the other with Flip), in words. */
async function distance1Words(body: BuiltBody, edges: number[], flip: boolean, ctx: Pick<BuildContext, 'featureName'>, lookup: NamingLookup): Promise<string | undefined> {
  if (!body.names || !lookup.edges) return undefined;
  const all = await lookup.edges(body.shape, edges);
  const faces: number[] = [];
  for (const e of all) {
    const fs = [...new Set(e.faces)].sort((a, b) => a - b);
    const f = fs.length > 1 && flip ? fs[1] : fs[0];
    if (f != null && !faces.includes(f)) faces.push(f);
  }
  const words = [...new Set(faces.map((i) => describeFace(body.names!.faces[i] ?? '', (id) => ctx.featureName(id), body.names!.faces)))];
  if (!words.length) return undefined;
  return words.length <= 2 ? words.join(' and ') : `${words.slice(0, 2).join(', ')} and ${words.length - 2} more`;
}

export const chamferDef: FeatureTypeDef<ChamferFeature, ChamferValues> = {
  type: 'chamfer',
  label: 'Chamfer',
  icon: SOLIDS_ICONS.chamfer,
  create(doc, init = {}) {
    const d = DEFAULT_DISTANCE[doc.units.length];
    return {
      id: newId('f'),
      type: 'chamfer',
      name: nextName('Chamfer', doc.features.map((f) => f.name)),
      body: '',
      edges: [],
      faces: [],
      mode: 'distance',
      distance: d,
      distance2: d,
      flip: false,
      ...init,
    } as ChamferFeature;
  },
  resolve: (f, units) => resolveChamfer(f, units),
  incomplete(f, units) {
    if (!f.body || (!f.edges?.length && !f.faces?.length)) return 'Pick edges (or faces: all their edges) to chamfer';
    const r = resolveChamfer(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => {
    const out: ExprField[] = [{ path: 'distance', expr: f.distance }];
    out.push({ path: 'distance2', expr: f.distance2 });
    return out;
  },
  mapExprs: (f, fn) => ({ ...f, distance: fn(f.distance), distance2: fn(f.distance2) }),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const b = bodyFor(f.name, f.body, ctx);
    if (!b.ok) return b;
    const body = b.value;
    const lookup = cachedLookup(ctx);
    const set = await resolveEdgeSet(f.name, body, f.edges, f.faces, ctx, lookup);
    if (!set.ok) return set;
    const edges = set.value.edges;
    if (!edges.length) return { ok: false, message: `${f.name} failed: the picked faces have no edges to chamfer` };
    const timeoutMs = timeoutForFaces('chamfer', await ctx.faces(body.shape));
    const size = v.d2 == null ? ctx.units.format(v.d, 'length') : `${ctx.units.format(v.d, 'length')} and ${ctx.units.format(v.d2, 'length')}`;
    const failed = async () => {
      // What works (as Fillet says it), unless the part is large (each try is a whole chamfer).
      const s = timeoutMs ? null : await largestScaleThatWorks(ctx, body, edges, v, !!f.flip);
      const fmt = (mm: number) => ctx.units.format(roundDown(mm), 'length');
      const tip = s ? (v.d2 == null ? `: ${fmt(v.d * s)} or less works` : `: ${fmt(v.d * s)} and ${fmt(v.d2 * s)} or less work`) : ': try a smaller distance';
      return { ok: false as const, message: `${f.name} failed: ${v.d2 == null ? 'a distance' : 'distances'} of ${size} ${v.d2 == null ? 'is' : 'are'} too large for ${await edgeListWords(body, edges, ctx, lookup)}${tip}` };
    };
    const res = await kernelStep(f.name, () => ctx.kernel.call('chamfer', { id: body.shape, edges, d: v.d, ...(v.d2 != null ? { d2: v.d2, flip: !!f.flip } : {}) }, timeoutMs ? { timeoutMs } : {}));
    if (!res.ok) return /chamfer failed|returned no shape/i.test(res.message) ? failed() : res;
    const out = res.value.result;
    if (out.valid === false) {
      await ctx.release([out.id]);
      return failed();
    }
    const names = await localOpNames(f.id, 'chamfer', out, body, ctx.kernel);
    const done = new Set((out.contours ?? []).flat()).size;
    return {
      ok: true,
      bodies: [{ id: f.body, shape: out.id, valid: true, names }],
      removed: [],
      output: { type: 'edge-chain', picked: edges.length, done: Math.max(done, edges.length), ...(v.d2 != null ? { distance1On: await distance1Words(body, edges, !!f.flip, ctx, lookup) } : {}) },
      ...(set.value.warning ? { warning: set.value.warning } : {}),
    };
  },
};
