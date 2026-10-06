// The extrude feature type (docs/p2p3-plan.md §1.8): profiles of one sketch,
// an extent (Blind / Symmetric / Two sides, flip), and the Operation (New
// body / Join / Cut / Intersect, through applyBodyOp: the P1.5 rules and
// words). The kernel's extrude_regions builds the shape from the sketch's
// curves and the region keys; the shape's `valid` flag is honoured (an
// invalid shape is red with "Try repair", which runs the kernel's ShapeFix).
// P4a (SOLIDS): the extents Through all (one side or both) and Up to a face or a
// vertex of a body (with an offset), and a flat face of a body extruded directly
// with no sketch (Daniel's item 8: `face`; kernel extrude_face; its side faces are
// named by the edge they were swept from, F:<id>:side:E:<a>&<b>).
// Owner: P3-PROFILES (src/features/extrude/); P4a extents and face: SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { applyBodyOp, nothingToActOn } from '../../doc/features/body-op';
import { MIN_SIZE_MM } from '../../doc/features/primitives';
import { plainKernelMessage } from '../../doc/rebuild';
import { describeFace, kernelLookup, resolveFace } from '../../naming';
import { edgeName, faceName } from '../../naming/names';
import { resolveVertex, vertexWords } from '../../naming/edges';
import { namesFromResult } from '../../naming/result';
import type { BodyId, BodyRef, ExtrudeFeature, SketchFeature } from '../../types/doc';
import type { BuildContext, ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { SketchOutput } from '../../types/sketch';
import type { KernelCallError } from '../../types/kernel';
import type { ExtrudeExtent, OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { Expr, LengthUnit, UnitsService } from '../../types/units';
import { extrudeNames } from './names';
import { refBodies, refParents, resolveAxis } from '../refgeom/resolve';
import type { Vec3 } from '../../types/doc';
import { entityParents, PROFILE_REPAIRED, resolveRegionRef } from './profiles';

/** Outline glyph (24 viewBox): a profile with an arrow out of it. */
export const EXTRUDE_ICON = 'M3 16l9 4.5 9-4.5-9-4.5z M12 15.5V3.5 M8.5 7l3.5-3.5L15.5 7';

/** A default distance per display unit (explicit unit, so it reads the same anywhere). */
export const DEFAULT_DISTANCE: Record<LengthUnit, Expr> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

/**
 * An extent with its expressions evaluated (mm). Through all and Up to are completed at the
 * build, where the bodies are known (kernelExtent).
 */
export type ExtentValues = Extract<ExtrudeExtent, { kind: 'blind' | 'symmetric' | 'two' }> | { kind: 'through_all'; both: boolean } | { kind: 'to'; offset: number };

export interface ExtrudeValues {
  extent: ExtentValues;
}

function evalLength(label: string, expr: Expr, units: UnitsService): { ok: true; value: number } | { ok: false; message: string } {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), 'length');
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

const EXTENT_WORDS = 'Extent: pick Blind, Symmetric, Two sides, Through all or Up to';

/** Evaluate the extent's distances with their rules (the panel's fields say the same). */
export function resolveExtent(f: Pick<ExtrudeFeature, 'extent'>, units: UnitsService): ResolveResult<ExtentValues> {
  const e = f.extent;
  if (!e || typeof e !== 'object') return { ok: false, message: EXTENT_WORDS };
  if (e.kind === 'blind') {
    const d = evalLength('Distance', e.distance, units);
    if (!d.ok) return d;
    if (d.value === 0) return { ok: false, message: 'Distance must not be 0' };
    if (Math.abs(d.value) < MIN_SIZE_MM) return { ok: false, message: 'Distance must be at least 0.000001 mm' };
    return { ok: true, values: { kind: 'blind', d: d.value } };
  }
  if (e.kind === 'symmetric') {
    // The panel's own words for the field: "Total distance", "Distance 1".
    const d = evalLength('Total distance', e.distance, units);
    if (!d.ok) return d;
    if (!(d.value > 0)) return { ok: false, message: 'Distance must be more than 0' };
    if (d.value < MIN_SIZE_MM) return { ok: false, message: 'Distance must be at least 0.000001 mm' };
    return { ok: true, values: { kind: 'symmetric', d: d.value } };
  }
  if (e.kind === 'two') {
    const d1 = evalLength('Distance 1', e.distance, units);
    if (!d1.ok) return d1;
    const d2 = evalLength('Distance 2', e.distance2, units);
    if (!d2.ok) return d2;
    if (Math.abs(d1.value + d2.value) < MIN_SIZE_MM) return { ok: false, message: 'The two distances must not add up to 0' };
    return { ok: true, values: { kind: 'two', d1: d1.value, d2: d2.value } };
  }
  if (e.kind === 'through_all') return { ok: true, values: { kind: 'through_all', both: !!e.both } };
  if (e.kind === 'to') {
    const o = evalLength('Offset', e.offset, units);
    if (!o.ok) return o;
    return { ok: true, values: { kind: 'to', offset: o.value } };
  }
  return { ok: false, message: EXTENT_WORDS };
}

/** Why the profiles cannot be built from, or null. */
export function profilesProblem(f: Pick<ExtrudeFeature, 'profiles'> & { face?: ExtrudeFeature['face'] }): string | null {
  if (f.face) return Array.isArray(f.profiles) && f.profiles.length ? 'Extrude either a flat face or sketch profiles, not both' : null;
  if (!Array.isArray(f.profiles) || !f.profiles.length) return 'Pick a profile';
  if (new Set(f.profiles.map((p) => p.sketch)).size > 1) return 'Pick profiles from one sketch';
  return null;
}

/** Why an extent is not ready to build yet (Up to with nothing picked), or null. */
export function extentProblem(f: Pick<ExtrudeFeature, 'extent'>): string | null {
  if (f.extent?.kind === 'to' && !f.extent.target) return 'Up to: pick a face or a vertex to extrude up to';
  return null;
}

/** "End face of Extrude 1", "Corner of End, Side 1 and Side 2 of Extrude 1": what an Up to target is. */
export function targetWords(t: BodyRef, featureName: (id: string) => string | null, faceNames: readonly string[] | null = null): string {
  if (t.ref.signature.kind === 'vertex') return vertexWords(t.ref.name, featureName, faceNames) ?? 'A vertex';
  return describeFace(t.ref.name, featureName, faceNames);
}

/** The bodies an extrude reads besides the ones its Operation acts on: its face's, its Up to target's. */
function extraBodies(f: ExtrudeFeature): BodyId[] {
  const out: BodyId[] = [];
  if (f.face) out.push(f.face.body);
  if (f.extent?.kind === 'to' && f.extent.target) out.push(f.extent.target.body);
  out.push(...refBodies([f.direction]));
  return out;
}

type Ctx = Pick<BuildContext, 'bodies' | 'kernel' | 'bodyName' | 'featureName'>;

/**
 * The kernel's extent for the values: Through all goes past the scope's bodies (or every body
 * before the extrude), Up to resolves its face or vertex on the body as it is now.
 */
export async function kernelExtent(f: ExtrudeFeature, v: ExtentValues, ctx: Ctx): Promise<{ ok: true; extent: ExtrudeExtent; warning?: string } | { ok: false; message: string }> {
  if (v.kind === 'blind' || v.kind === 'symmetric' || v.kind === 'two') return { ok: true, extent: v };
  if (v.kind === 'through_all') {
    const ids = f.scope.length ? f.scope : [...ctx.bodies.keys()];
    const targets = ids.map((id) => ctx.bodies.get(id)).filter((b) => !!b);
    if (!targets.length) return { ok: false, message: 'Through all: there is no body to go through at this point (make or import one first)' };
    // A New body or a Join keeps what it makes: it ends exactly at the bodies' farthest extent (no
    // made-up margin) and is refused when the profile misses them; a Cut or an Intersect goes past them.
    const fit = f.op === 'new' || f.op === 'join';
    return { ok: true, extent: { kind: 'through_all', targets: targets.map((b) => b!.shape), both: v.both, ...(fit ? { fit: true } : {}) } };
  }
  const t = f.extent.kind === 'to' ? f.extent.target : null;
  if (!t) return { ok: false, message: 'Up to: pick a face or a vertex to extrude up to' };
  const body = ctx.bodies.get(t.body);
  const words = targetWords(t, (id) => ctx.featureName(id), ctx.bodies.get(t.body)?.names?.faces ?? null);
  if (!body) return { ok: false, message: `Up to: ${ctx.bodyName(t.body)} is not there at this point` };
  if (!body.names) return { ok: false, message: `Up to: the faces of ${ctx.bodyName(t.body)} have no names` };
  const lookup = kernelLookup(ctx.kernel);
  if (t.ref.signature.kind === 'vertex') {
    const r = await resolveVertex({ ref: t.ref, shape: body.shape, names: body.names, lookup });
    if (!r.ok) return { ok: false, message: `Up to: ${words} not found on ${ctx.bodyName(t.body)} after rebuild` };
    return { ok: true, extent: { kind: 'to_vertex', target: body.shape, vertex: r.index, offset: v.offset }, ...(r.warning ? { warning: `Up to: ${r.warning}` } : {}) };
  }
  const r = await resolveFace({ ref: t.ref, shape: body.shape, names: body.names, lookup });
  if (!r.ok) return { ok: false, message: `Up to: ${words} not found on ${ctx.bodyName(t.body)} after rebuild` };
  if (r.signature.type !== 'plane') return { ok: false, message: `Up to: ${words} is curved; pick a flat face or a vertex` };
  return { ok: true, extent: { kind: 'to_face', target: body.shape, face: r.index, offset: v.offset }, ...(r.warning ? { warning: `Up to: ${r.warning}` } : {}) };
}

/** The direction an extrude goes along when it is not the profile's normal (its axis now), or none. */
async function directionOf(f: ExtrudeFeature, ctx: BuildContext): Promise<{ ok: true; dir: Vec3 | null; warning?: string } | { ok: false; message: string }> {
  if (!f.direction) return { ok: true, dir: null };
  const a = await resolveAxis(f.direction, ctx);
  if (!a.ok) return { ok: false, message: `Direction: ${a.message}` };
  return { ok: true, dir: a.value.dir, ...(a.warning ? { warning: `Direction: ${a.warning}` } : {}) };
}

/** "tick" when Flip direction is off, "untick" when it is on (the advice turns the switch the other way). */
export const flipVerb = (flip: boolean | undefined) => (flip ? 'untick' : 'tick');

/**
 * A kernel refusal of an extent in the panel's words ("Up to: the face is behind the profile (tick
 * Flip direction)"); with Flip direction already on, the advice is to untick it (P4a review).
 */
export function extentWords(e: ExtrudeExtent, message: string, flip?: boolean): string {
  const m = plainKernelMessage(message);
  const v = flipVerb(flip);
  if (e.kind === 'to_face' || e.kind === 'to_vertex' || e.kind === 'to_point') return `Up to: ${m.replace(/\(flip the direction\)/, `(${v} Flip direction)`)}`;
  if (e.kind === 'through_all') return `Through all: ${m.replace(/\(flip it\)/, `(${v} Flip direction or tick Both sides)`)}`;
  return m;
}

export const extrudeDef: FeatureTypeDef<ExtrudeFeature, ExtrudeValues> = {
  type: 'extrude',
  label: 'Extrude',
  icon: EXTRUDE_ICON,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'extrude',
      name: nextName('Extrude', doc.features.map((f) => f.name)),
      op: 'new',
      creates: null,
      scope: [],
      profiles: [],
      extent: { kind: 'blind', distance: DEFAULT_DISTANCE[doc.units.length] ?? '10 mm' },
      flip: false,
      ...init,
    };
  },
  resolve(f, units) {
    const r = resolveExtent(f, units);
    return r.ok ? { ok: true, values: { extent: r.values } } : r;
  },
  incomplete(f, units) {
    const p = profilesProblem(f);
    if (p) return p;
    const e = extentProblem(f);
    if (e) return e;
    const r = extrudeDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => [...new Set([...(f.profiles ?? []).map((p) => p.sketch), ...refParents([f.direction])])],
  uses(f) {
    // Through all goes past the scope's bodies, or every body before it.
    if (f.extent?.kind === 'through_all' && !f.scope.length) return 'all';
    const own = f.op === 'new' ? [] : f.scope.length ? f.scope : 'all';
    if (own === 'all') return 'all';
    return [...new Set([...own, ...(f.extent?.kind === 'through_all' ? f.scope : []), ...extraBodies(f)])];
  },
  exprs: (f) => {
    const out: ExprField[] = [{ path: 'extent.distance', expr: f.extent.distance }];
    if (f.extent.kind === 'two') out.push({ path: 'extent.distance2', expr: f.extent.distance2 });
    if (f.extent.kind === 'to') out.push({ path: 'extent.offset', expr: f.extent.offset });
    return out;
  },
  mapExprs: (f, fn) => {
    const e = f.extent;
    if (e.kind === 'two') return { ...f, extent: { ...e, distance: fn(e.distance), distance2: fn(e.distance2) } };
    if (e.kind === 'to') return { ...f, extent: { ...e, distance: fn(e.distance), offset: fn(e.offset) } };
    return { ...f, extent: { ...e, distance: fn(e.distance) } };
  },
  async build(f, v, ctx) {
    const problem = profilesProblem(f);
    if (problem) return { ok: false, message: `${f.name} failed: ${problem}` };
    if (f.face) return buildFace(f, v, ctx);
    const sketchId = f.profiles[0].sketch;
    const sketchName = ctx.featureName(sketchId);
    const out = ctx.outputs.get(sketchId);
    if (!out || out.type !== 'sketch') return { ok: false, message: `${f.name} failed: ${sketchName} did not build` };
    const sketch = ctx.doc.features.find((g) => g.id === sketchId) as SketchFeature | undefined;
    const parents = entityParents(sketch?.entities);
    const lost = `${f.name} failed: Profile lost: the region of ${sketchName} it used is gone`;

    const keys: string[] = [];
    let repaired = false;
    for (const ref of f.profiles) {
      const r = resolveRegionRef(ref, out.regions, parents);
      if (!r.ok) return { ok: false, message: lost };
      if (r.how === 'repaired') repaired = true;
      if (!keys.includes(r.key)) keys.push(r.key);
    }
    const ext = await kernelExtent(f, v.extent, ctx);
    if (!ext.ok) return { ok: false, message: `${f.name} failed: ${ext.message}` };
    const dir = await directionOf(f, ctx);
    if (!dir.ok) return { ok: false, message: `${f.name} failed: ${dir.message}` };

    let made: ShapeId | null = null;
    try {
      let res;
      try {
        res = await ctx.kernel.call('extrude_regions', { plane: out.plane, curves: out.curves, regions: keys, extent: ext.extent, flip: !!f.flip, ...(dir.dir ? { direction: dir.dir } : {}) });
      } catch (err) {
        const e = err as KernelCallError;
        if (e.kind === 'input' && /region not found/i.test(e.message)) return { ok: false, message: lost };
        if (e.kind === 'input' && /unknown op/i.test(e.message)) return { ok: false, message: `${f.name} failed: this kernel cannot extrude profile regions (it needs kernel API 3)` };
        if (e.kind === 'input' || e.kind === 'occt') return { ok: false, message: `${f.name} failed: ${extentWords(ext.extent, e.message, f.flip)}` };
        throw err;
      }
      made = res.result.id;
      let shape: ShapeId = made;
      let names: FaceNames | null = extrudeNames(f.id, res.result, keys);
      const notes: string[] = [];
      if (repaired) notes.push(PROFILE_REPAIRED);
      if (ext.warning) notes.push(ext.warning);
      if (dir.warning) notes.push(dir.warning);

      if (res.result.valid === false) {
        const why = res.result.reason ? `: ${res.result.reason.replace(/^invalid result\s*/i, '').trim()}` : '';
        // Try repair: the kernel's ShapeFix on the extruded shape (the Operation's booleans then also get the fuzzy tolerance).
        if (!f.repair) return { ok: false, message: `${f.name} failed: the extruded shape is not a valid solid${why}`, actions: ['repair'] };
        let fixed: ShapeId | null = null;
        let fixedNames: FaceNames | null = null;
        try {
          const rep = await ctx.kernel.call('repair', { id: made });
          fixed = rep.result.id;
          if (rep.result.valid === false) {
            await ctx.release([fixed]);
            fixed = null;
          } else fixedNames = namesFromResult(f.id, rep.result, new Map([[made, names]]));
        } catch (err) {
          const e = err as KernelCallError;
          if (e.kind !== 'occt' && e.kind !== 'input' && e.kind !== 'internal') throw err;
        }
        if (fixed == null) return { ok: false, message: `${f.name} failed: the extruded shape is not a valid solid (repair did not fix it)${why}` };
        await ctx.release([made]);
        made = fixed;
        shape = fixed;
        names = fixedNames;
        notes.push(`${f.name} was repaired: check the result`);
      }

      // The Operation owns the shape from here (it releases it unless it becomes a body).
      made = null;
      const r: FeatureBuildResult = await applyBodyOp(f, f.name, { shape, valid: true, names }, ctx);
      if (r.ok && notes.length) return { ...r, warning: [r.warning, ...notes].filter(Boolean).join('; ') };
      // A Cut or Intersect that points away from the bodies: say that the other way acts on one
      // (review P2/P3 round 4: a Cut from a face pointed out of the body and said only "Nothing to cut").
      if (!r.ok && (f.op === 'cut' || f.op === 'intersect') && !f.scope.length && (v.extent.kind === 'blind' || v.extent.kind === 'two') && r.message === nothingToActOn(f.op, f.name)) {
        const other = await bodyTheOtherWay(f, ext.extent, out, keys, ctx);
        if (other) return { ...r, message: `${r.message}: ${flipVerb(f.flip)} Flip direction to ${f.op === 'cut' ? 'cut' : 'intersect'} ${f.op === 'cut' ? 'into' : 'with'} ${other}` };
      }
      return r;
    } finally {
      if (made != null) await ctx.release([made]).catch(() => {});
    }
  },
};

/**
 * Names of a face extrude's result: the kernel's sides `e<i>` (input edge i) become the edge's
 * name on the body (F:<id>:side:E:<a>&<b>), caps F:<id>:start / end. Null when the input body
 * or an edge's faces have no names.
 */
export async function faceExtrudeNames(feature: string, result: { faces?: number; history?: OpHistory | null }, input: { shape: ShapeId; names: FaceNames | null }, ctx: Pick<BuildContext, 'kernel'>): Promise<FaceNames | null> {
  const base = extrudeNames(feature, result, []);
  if (!base || !input.names || !result.history?.sides) return null;
  const sides = result.history.sides;
  const edges = Object.keys(sides).map((s) => Number(s.slice(1)));
  if (!edges.length) return base;
  const t = await ctx.kernel.call('topo', { id: input.shape, faces: 'none', edges, vertices: 'none', edge_length: false });
  const byEdge = new Map(t.result.edges.map((e) => [e.i, e.faces]));
  const faces = [...base.faces];
  for (const [seg, out] of Object.entries(sides)) {
    const fs = [...new Set(byEdge.get(Number(seg.slice(1))) ?? [])];
    const a = input.names.faces[fs[0]];
    const b = input.names.faces[fs.length > 1 ? fs[1] : fs[0]];
    if (!a || !b) return null;
    if (out >= 0 && out < faces.length) faces[out] = faceName(feature, 'side', edgeName(a, b));
  }
  // The same edge name twice (two edges between the same two faces): tell them apart by position.
  const seen = new Map<string, number[]>();
  faces.forEach((n, i) => seen.set(n, [...(seen.get(n) ?? []), i]));
  for (const [n, list] of seen) if (list.length > 1) list.forEach((i, k) => (faces[i] = `${n}#${k}`));
  return { faces };
}

/** Extrude a flat face of a body (no sketch): kernel extrude_face, then the Operation. */
async function buildFace(f: ExtrudeFeature, v: ExtrudeValues, ctx: BuildContext): Promise<FeatureBuildResult> {
  const t = f.face!;
  const body = ctx.bodies.get(t.body);
  const words = describeFace(t.ref.name, (id) => ctx.featureName(id), ctx.bodies.get(t.body)?.names?.faces ?? null);
  if (!body) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(t.body)} is not there at this point` };
  if (!body.names) return { ok: false, message: `${f.name} failed: the faces of ${ctx.bodyName(t.body)} have no names` };
  const r = await resolveFace({ ref: t.ref, shape: body.shape, names: body.names, lookup: kernelLookup(ctx.kernel) });
  if (!r.ok) return { ok: false, message: `${f.name} failed: ${words} not found on ${ctx.bodyName(t.body)} after rebuild` };
  if (r.signature.type !== 'plane') return { ok: false, message: `${f.name} failed: ${words} is no longer flat` };
  const ext = await kernelExtent(f, v.extent, ctx);
  if (!ext.ok) return { ok: false, message: `${f.name} failed: ${ext.message}` };
  const dir = await directionOf(f, ctx);
  if (!dir.ok) return { ok: false, message: `${f.name} failed: ${dir.message}` };
  let made: ShapeId | null = null;
  try {
    let res;
    try {
      res = await ctx.kernel.call('extrude_face', { id: body.shape, face: r.index, extent: ext.extent, flip: !!f.flip, ...(dir.dir ? { direction: dir.dir } : {}) });
    } catch (err) {
      const e = err as KernelCallError;
      if (e.kind === 'input' || e.kind === 'occt') return { ok: false, message: `${f.name} failed: ${extentWords(ext.extent, e.message, f.flip)}` };
      throw err;
    }
    made = res.result.id;
    if (res.result.valid === false) {
      const why = res.result.reason ? `: ${res.result.reason.replace(/^invalid result\s*/i, '').trim()}` : '';
      return { ok: false, message: `${f.name} failed: the extruded shape is not a valid solid${why}` };
    }
    const names = await faceExtrudeNames(f.id, res.result, body, ctx);
    const notes = [r.warning, ext.warning, dir.warning].filter((x): x is string => !!x);
    const shape = made;
    made = null;
    const out = await applyBodyOp(f, f.name, { shape, valid: true, names }, ctx);
    if (out.ok && notes.length) return { ...out, warning: [out.warning, ...notes].filter(Boolean).join('; ') };
    return out;
  } finally {
    if (made != null) await ctx.release([made]).catch(() => {});
  }
}

/** The first body the extrude flipped would overlap (its name), or null. Every shape made here is released. */
async function bodyTheOtherWay(f: ExtrudeFeature, extent: ExtrudeExtent, out: SketchOutput, keys: string[], ctx: BuildContext): Promise<string | null> {
  const made: ShapeId[] = [];
  try {
    const res = await ctx.kernel.call('extrude_regions', { plane: out.plane, curves: out.curves, regions: keys, extent, flip: !f.flip });
    const tool = res.result.id;
    made.push(tool);
    const tb = await ctx.bbox(tool);
    const tol = 1e-7 * Math.max(1, Math.hypot(tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]));
    for (const body of ctx.bodies.values()) {
      const bb = await ctx.bbox(body.shape);
      if (!(tb[0] <= bb[3] + tol && bb[0] <= tb[3] + tol && tb[1] <= bb[4] + tol && bb[1] <= tb[4] + tol && tb[2] <= bb[5] + tol && bb[2] <= tb[5] + tol)) continue;
      const c = await ctx.kernel.call('boolean', { op: 'common', targets: [body.shape], tools: [tool] });
      made.push(c.result.id);
      if (!c.result.empty) return ctx.bodyName(body.id);
    }
    return null;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw err;
  } finally {
    if (made.length) await ctx.release(made).catch(() => {});
  }
}
