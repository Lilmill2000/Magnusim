// Press-pull of flat faces (proposal §2.8, docs/p2p3-plan.md §1.4, §2.4): each
// face moves along its own normal by the distance (> 0 adds material, < 0
// removes it). Kernel press_pull: a prism of each face, one fuse or cut with
// the body, then same-domain faces merged, with history. The body keeps its
// id; a moved face keeps its name; a side face is named by the edge it was
// swept from (F:<feature>:side:E:<faceA>&<faceB>). A neighbour that is not
// square to the face is not extended: a step forms (Offset Face is later).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { LengthUnit } from '../../types/units';
import type { PressPullFeature } from '../../types/doc';
import type { FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { P2_ICONS } from '../p2/icons';
import { resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, repairActions, repairFuzzy, shapeFix } from '../p2/repair';

const DEFAULT_DISTANCE: Record<LengthUnit, string> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

/** Input edges that side faces were swept from (history `generated` from an edge of the input shape). */
export function sweptEdges(history: OpHistory | undefined, input: ShapeId): number[] {
  const out = new Set<number>();
  for (const e of history?.faces ?? []) for (const s of e.from) if (s.shape === input && s.edge !== undefined && s.how === 'generated') out.add(s.edge);
  return [...out];
}

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
    if (!f.body || !f.faces?.length) return 'Select flat faces to press-pull';
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
    const fuzzy = repairFuzzy(f);
    const timeoutMs = timeoutForFaces('press_pull', await ctx.faces(body.shape));
    let r;
    try {
      r = await ctx.kernel.call('press_pull', { id: body.shape, faces: res.indices, d: v.d, ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {});
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
    if (res.warning) notes.push(res.warning);
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
    return { ok: true, bodies: [{ id: f.body, shape, valid: true, names }], removed: [], ...(notes.length ? { warning: notes.join('; ') } : {}) };
  },
};
