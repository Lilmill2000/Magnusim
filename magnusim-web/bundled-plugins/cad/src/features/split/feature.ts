// Split bodies (proposal §2.7; decision 2026-09-30; docs/p2p3-plan.md §1.5):
// by an origin plane (with an offset), by the plane of a flat face, or by
// another body. The kernel's split (BRepAlgoAPI_Splitter on work copies)
// orders the pieces (along the plane's normal; largest volume first for a tool
// body). Piece 0 keeps the target's id; piece k gets deriveBodyId(feature,
// target, k), named "<target> (k+1)" in the target's colour until renamed.
// A tool body goes unless kept. Faces keep their names through the history;
// the new cut faces are F:<feature>:cut (#k when a piece has several).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { deriveBodyId, parseDerivedBodyId } from '../../doc/features/body-ids';
import { DEFAULT_BODY_COLOR } from '../../doc/schema';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import { ORIGIN_PLANES, type BodyId, type SplitFeature, type SplitTool, type Vec3 } from '../../types/doc';
import type { BuildContext, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { KernelResult, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { P2_ICONS } from '../p2/icons';
import { resolveRefs } from '../p2/refs';
import { invalidWords, kernelWords, repairFuzzy, shapeFix } from '../p2/repair';

export interface SplitValues {
  offset: number;
}

function toolBody(t: SplitTool): BodyId | null {
  return t.kind === 'face' || t.kind === 'body' ? t.body || null : null;
}

/** Words for what a split cuts with ("the Right plane", "Body 2"). */
export function toolWords(f: SplitFeature, bodyName: (id: BodyId) => string): string {
  const t = f.tool;
  if (t.kind === 'plane') return `the ${ORIGIN_PLANES[t.plane]?.label ?? 'plane'}`;
  if (t.kind === 'face') return `the face's plane`;
  return bodyName(t.body);
}

type Plane = { origin: Vec3; normal: Vec3 };

async function planeOf(f: SplitFeature, v: SplitValues, ctx: BuildContext): Promise<{ ok: true; plane: Plane; warning: string | null } | { ok: false; message: string }> {
  const t = f.tool;
  if (t.kind === 'plane') {
    const p = ORIGIN_PLANES[t.plane];
    if (!p) return { ok: false, message: 'pick the Top, Front or Right plane' };
    const n = p.normal;
    return { ok: true, plane: { origin: [p.origin[0] + n[0] * v.offset, p.origin[1] + n[1] * v.offset, p.origin[2] + n[2] * v.offset], normal: n }, warning: null };
  }
  if (t.kind !== 'face') return { ok: false, message: 'not a plane tool' };
  const body = ctx.bodies.get(t.body);
  if (!body) return { ok: false, message: `${ctx.bodyName(t.body)} is not there at this point` };
  const r = await resolveRefs(ctx, body, [t.face]);
  if (!r.ok) return { ok: false, message: r.message };
  const topo = await ctx.kernel.call('topo', { id: body.shape, faces: r.indices, edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true });
  const face = topo.result.faces[0];
  if (!face || face.type !== 'plane' || !face.normal || !face.centroid) return { ok: false, message: 'the face it splits with is not flat any more' };
  return { ok: true, plane: { origin: face.centroid, normal: face.normal }, warning: r.warning };
}

export const splitDef: FeatureTypeDef<SplitFeature, SplitValues> = {
  type: 'split',
  label: 'Split',
  icon: P2_ICONS.split,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'split',
      name: nextName('Split', doc.features.map((f) => f.name)),
      targets: [],
      tool: { kind: 'plane', plane: 'origin:right', offset: '0' },
      ...init,
    } as SplitFeature;
  },
  resolve(f, units) {
    if (f.tool?.kind === 'plane') {
      const r = units.evaluate(typeof f.tool.offset === 'string' ? f.tool.offset : String(f.tool.offset ?? ''), 'length');
      if (!r.ok) return { ok: false, message: `Offset: ${r.error}` };
      return { ok: true, values: { offset: r.value } };
    }
    return { ok: true, values: { offset: 0 } };
  },
  incomplete(f, units) {
    if (!f.targets?.length) return 'Pick the bodies to split';
    const t = f.tool;
    if (!t) return 'Pick what to split with';
    if (t.kind === 'face' && (!t.body || !t.face)) return 'Pick a flat face to split with';
    if (t.kind === 'body' && !t.body) return 'Pick the body to split with';
    const tb = toolBody(t);
    if (t.kind === 'body' && tb && f.targets.includes(tb)) return 'A body cannot split itself: take it out of the bodies to split';
    const r = splitDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses(f) {
    const tb = f.tool ? toolBody(f.tool) : null;
    return tb && !f.targets.includes(tb) ? [...f.targets, tb] : [...f.targets];
  },
  ownsBody: (f, id) => parseDerivedBodyId(f.id, id) != null,
  exprs: (f) => (f.tool?.kind === 'plane' ? [{ path: 'tool.offset', expr: f.tool.offset }] : []),
  mapExprs: (f, fn) => (f.tool?.kind === 'plane' ? { ...f, tool: { ...f.tool, offset: fn(f.tool.offset) } } : f),
  async build(f, v, ctx) {
    return buildSplit(f, v, ctx);
  },
};

async function buildSplit(f: SplitFeature, v: SplitValues, ctx: BuildContext): Promise<FeatureBuildResult> {
  const notes: string[] = [];
  let plane: Plane | null = null;
  let tool: { id: BodyId; shape: ShapeId; names: FaceNames | null } | null = null;
  if (f.tool.kind === 'body') {
    const b = ctx.bodies.get(f.tool.body);
    if (!b) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(f.tool.body)} is not there at this point` };
    tool = { id: b.id, shape: b.shape, names: b.names };
  } else {
    const p = await planeOf(f, v, ctx);
    if (!p.ok) return { ok: false, message: `${f.name} failed: ${p.message}` };
    plane = p.plane;
    if (p.warning) notes.push(p.warning);
  }
  const bodies: Extract<FeatureBuildResult, { ok: true }>['bodies'] = [];
  const made: ShapeId[] = [];
  const uncut: string[] = [];
  const repaired: string[] = [];
  const fuzzy = repairFuzzy(f);
  try {
    for (const target of f.targets) {
      const t = ctx.bodies.get(target);
      if (!t) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(target)} is not there at this point` };
      const timeoutMs = timeoutForFaces('split', (await ctx.faces(t.shape)) + (tool ? await ctx.faces(tool.shape) : 0));
      let r: KernelResult<'split'>;
      try {
        const params = plane ? { id: t.shape, plane } : { id: t.shape, tool: tool!.shape };
        r = (await ctx.kernel.call('split', params, timeoutMs ? { timeoutMs } : {})).result;
      } catch (err) {
        const k = (err as KernelCallError).kind;
        if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
        throw err;
      }
      made.push(...r.ids);
      // OCCT's splitter can drop part of the body without an error (the kernel counts
      // the input faces in no piece): a failed split, never "does not cut". No Try
      // repair: ShapeFix cannot bring back faces that are in no piece.
      if ((r.lost_faces ?? 0) > 0) {
        return { ok: false, message: `${f.name} failed: ${ctx.bodyName(target)}: ${r.reason ?? `split lost part of the body: ${r.lost_faces} of its faces are in no piece`}` };
      }
      if (r.ids.length < 2) {
        // Not cut: the body stays as it was (the pieces made here are freed).
        uncut.push(ctx.bodyName(target));
        continue;
      }
      const inputs = new Map<ShapeId, FaceNames | null>([[t.shape, t.names]]);
      if (tool) inputs.set(tool.shape, tool.names);
      const def = ctx.doc.bodies[target];
      for (let k = 0; k < r.ids.length; k++) {
        let shape = r.ids[k];
        let valid = r.pieces_valid ? r.pieces_valid[k] !== false : r.valid !== false;
        const piece = r.history?.pieces?.[k];
        let names = piece ? namesFromResult(f.id, { faces: await ctx.faces(shape), history: { faces: piece.faces, edges: piece.edges, deleted: r.history.deleted } }, inputs, { role: 'cut' }) : null;
        if (!valid) {
          const fixed = fuzzy ? await shapeFix(ctx, shape) : null;
          if (fixed == null) {
            const why = r.piece_problems?.[String(k)]?.reason ?? r.reason;
            return { ok: false, message: `${f.name} failed: piece ${k + 1} of ${ctx.bodyName(target)}: ${invalidWords(why, undefined)}${fuzzy ? ' (repair did not fix it)' : ''}`, actions: fuzzy ? undefined : ['repair'] };
          }
          made.push(fixed);
          shape = fixed;
          valid = true;
          names = null;
          repaired.push(`piece ${k + 1} of ${ctx.bodyName(target)}`);
        }
        const id = deriveBodyId(f.id, target, k);
        bodies.push(k === 0 ? { id, shape, valid, names } : { id, shape, valid, names, name: `${def?.name ?? ctx.bodyName(target)} (${k + 1})`, color: def?.color ?? DEFAULT_BODY_COLOR });
      }
    }
    if (!bodies.length) return { ok: false, message: `${f.name} failed: ${toolWords(f, ctx.bodyName)} does not cut ${uncut.join(', ')}` };
    if (uncut.length) notes.push(`${toolWords(f, ctx.bodyName)} does not cut ${uncut.join(', ')}`);
    if (repaired.length) notes.push(`${repaired.join(', ')} ${repaired.length === 1 ? 'was' : 'were'} repaired: check the result`);
    const removed = f.tool.kind === 'body' && !f.tool.keepTool ? [f.tool.body] : [];
    const kept = new Set(bodies.map((b) => b.shape));
    const extra = made.filter((s) => !kept.has(s));
    made.length = 0;
    await ctx.release(extra);
    return { ok: true, bodies, removed, ...(notes.length ? { warning: notes.join('; ') } : {}) };
  } finally {
    if (made.length) await ctx.release(made).catch(() => {});
  }
}
