// The fillet feature type (proposal §2.5): a constant radius on edges of one body. A
// picked edge takes its tangent chain with it (the kernel follows tangency and says
// which edges it rounded: its contours); a picked face takes all its edges. Kernel
// `fillet` on a work copy; the result's `valid` flag is honoured. When it fails (OCCT
// refuses, or the result is not a valid solid), the kernel's diagnosis names the edges
// it could not round and the largest radius found to work: "Fillet 1 failed: a radius
// of 20 mm is too large for End · Side 2 of Extrude 1: 9.9 mm or less works".
// The body keeps its id; a fillet face is F:<id>:fillet:E:<a>&<b> (the edge it replaced).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { FilletFeature } from '../../types/doc';
import type { FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { FilletDiagnosis } from '../../types/kernel-protocol';
import type { LengthUnit } from '../../types/units';
import { kernelStep } from '../solids/build';
import { SOLIDS_ICONS } from '../solids/icons';
import { bodyFor, cachedLookup, edgeListWords, resolveEdgeSet, roundDown } from '../solids/local';
import { localOpNames } from '../solids/naming';

const DEFAULT_RADIUS: Record<LengthUnit, string> = { mm: '2 mm', cm: '0.2 cm', m: '0.002 m', in: '0.1 in', ft: '0.1 in' };

export const filletDef: FeatureTypeDef<FilletFeature, { r: number }> = {
  type: 'fillet',
  label: 'Fillet',
  icon: SOLIDS_ICONS.fillet,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'fillet',
      name: nextName('Fillet', doc.features.map((f) => f.name)),
      body: '',
      edges: [],
      faces: [],
      radius: DEFAULT_RADIUS[doc.units.length],
      ...init,
    } as FilletFeature;
  },
  resolve(f, units) {
    const r = units.evaluate(typeof f.radius === 'string' ? f.radius : String(f.radius ?? ''), 'length');
    if (!r.ok) return { ok: false, message: `Radius: ${r.error}` };
    if (!(r.value > 0)) return { ok: false, message: 'Radius must be more than 0' };
    return { ok: true, values: { r: r.value } };
  },
  incomplete(f, units) {
    if (!f.body || (!f.edges?.length && !f.faces?.length)) return 'Pick edges (or faces: all their edges) to round';
    const r = filletDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => [{ path: 'radius', expr: f.radius }],
  mapExprs: (f, fn) => ({ ...f, radius: fn(f.radius) }),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const b = bodyFor(f.name, f.body, ctx);
    if (!b.ok) return b;
    const body = b.value;
    const lookup = cachedLookup(ctx);
    const set = await resolveEdgeSet(f.name, body, f.edges, f.faces, ctx, lookup);
    if (!set.ok) return set;
    const edges = set.value.edges;
    if (!edges.length) return { ok: false, message: `${f.name} failed: the picked faces have no edges to round` };
    const timeoutMs = timeoutForFaces('fillet', await ctx.faces(body.shape));
    const opts = timeoutMs ? { timeoutMs } : {};
    const radius = ctx.units.format(v.r, 'length');
    const failed = async (): Promise<FeatureBuildResult> => {
      // Why, and what would work: the kernel tries smaller radii (nothing is stored).
      const d = await kernelStep(f.name, () => ctx.kernel.call('fillet', { id: body.shape, edges, r: v.r, diagnose: true }, opts));
      const diag = d.ok ? (d.value.result as unknown as FilletDiagnosis) : null;
      const which = await edgeListWords(body, diag?.faulty.length ? diag.faulty : edges, ctx, lookup);
      const ok = diag?.max_ok != null && diag.max_ok > 0 ? roundDown(diag.max_ok) : null;
      const tip = ok ? `: ${ctx.units.format(ok, 'length')} or less works` : ': try a smaller radius';
      return { ok: false, message: `${f.name} failed: a radius of ${radius} is too large for ${which}${tip}` };
    };
    const res = await kernelStep(f.name, () => ctx.kernel.call('fillet', { id: body.shape, edges, r: v.r }, opts));
    if (!res.ok) return /fillet failed/i.test(res.message) ? failed() : res;
    const out = res.value.result;
    if (out.valid === false) {
      await ctx.release([out.id]);
      return failed();
    }
    const names = await localOpNames(f.id, 'fillet', out, body, ctx.kernel);
    const done = new Set((out.contours ?? []).flat()).size;
    return {
      ok: true,
      bodies: [{ id: f.body, shape: out.id, valid: true, names }],
      removed: [],
      output: { type: 'edge-chain', picked: edges.length, done: Math.max(done, edges.length) },
      ...(set.value.warning ? { warning: set.value.warning } : {}),
    };
  },
};
