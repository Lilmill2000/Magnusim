// The extrude feature type (docs/p2p3-plan.md §1.8): profiles of one sketch,
// an extent (Blind / Symmetric / Two sides, flip), and the Operation (New
// body / Join / Cut / Intersect, through applyBodyOp: the P1.5 rules and
// words). The kernel's extrude_regions builds the shape from the sketch's
// curves and the region keys; the shape's `valid` flag is honoured (an
// invalid shape is red with "Try repair", which runs the kernel's ShapeFix).
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { applyBodyOp, nothingToActOn } from '../../doc/features/body-op';
import { MIN_SIZE_MM } from '../../doc/features/primitives';
import { plainKernelMessage } from '../../doc/rebuild';
import { namesFromResult } from '../../naming/result';
import type { ExtrudeFeature, SketchFeature } from '../../types/doc';
import type { BuildContext, ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { SketchOutput } from '../../types/sketch';
import type { KernelCallError } from '../../types/kernel';
import type { ExtrudeExtent, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { Expr, LengthUnit, UnitsService } from '../../types/units';
import { extrudeNames } from './names';
import { entityParents, PROFILE_REPAIRED, resolveRegionRef } from './profiles';

/** Outline glyph (24 viewBox): a profile with an arrow out of it. */
export const EXTRUDE_ICON = 'M3 16l9 4.5 9-4.5-9-4.5z M12 15.5V3.5 M8.5 7l3.5-3.5L15.5 7';

/** A default distance per display unit (explicit unit, so it reads the same anywhere). */
const DEFAULT_DISTANCE: Record<LengthUnit, Expr> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

export interface ExtrudeValues {
  /** The extent as the kernel takes it (mm). */
  extent: ExtrudeExtent;
}

function evalLength(label: string, expr: Expr, units: UnitsService): { ok: true; value: number } | { ok: false; message: string } {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), 'length');
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

/** Evaluate the extent's distances with their rules (the panel's fields say the same). */
export function resolveExtent(f: Pick<ExtrudeFeature, 'extent'>, units: UnitsService): ResolveResult<ExtrudeExtent> {
  const e = f.extent;
  if (!e || typeof e !== 'object') return { ok: false, message: 'Extent: pick Blind, Symmetric or Two sides' };
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
  return { ok: false, message: 'Extent: pick Blind, Symmetric or Two sides' };
}

/** Why the profiles cannot be built from, or null. */
export function profilesProblem(f: Pick<ExtrudeFeature, 'profiles'>): string | null {
  if (!Array.isArray(f.profiles) || !f.profiles.length) return 'Pick a profile';
  if (new Set(f.profiles.map((p) => p.sketch)).size > 1) return 'Pick profiles from one sketch';
  return null;
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
    const r = extrudeDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => [...new Set((f.profiles ?? []).map((p) => p.sketch))],
  exprs: (f) => {
    const out: ExprField[] = [{ path: 'extent.distance', expr: f.extent.distance }];
    if (f.extent.kind === 'two') out.push({ path: 'extent.distance2', expr: f.extent.distance2 });
    return out;
  },
  mapExprs: (f, fn) => ({ ...f, extent: f.extent.kind === 'two' ? { ...f.extent, distance: fn(f.extent.distance), distance2: fn(f.extent.distance2) } : { ...f.extent, distance: fn(f.extent.distance) } }),
  async build(f, v, ctx) {
    const problem = profilesProblem(f);
    if (problem) return { ok: false, message: `${f.name} failed: ${problem}` };
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

    let made: ShapeId | null = null;
    try {
      let res;
      try {
        res = await ctx.kernel.call('extrude_regions', { plane: out.plane, curves: out.curves, regions: keys, extent: v.extent, flip: !!f.flip });
      } catch (err) {
        const e = err as KernelCallError;
        if (e.kind === 'input' && /region not found/i.test(e.message)) return { ok: false, message: lost };
        if (e.kind === 'input' && /unknown op/i.test(e.message)) return { ok: false, message: `${f.name} failed: this kernel cannot extrude profile regions (it needs kernel API 3)` };
        if (e.kind === 'input' || e.kind === 'occt') return { ok: false, message: `${f.name} failed: ${plainKernelMessage(e.message)}` };
        throw err;
      }
      made = res.result.id;
      let shape: ShapeId = made;
      let names: FaceNames | null = extrudeNames(f.id, res.result, keys);
      const notes: string[] = [];
      if (repaired) notes.push(PROFILE_REPAIRED);

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
      if (!r.ok && (f.op === 'cut' || f.op === 'intersect') && !f.scope.length && v.extent.kind !== 'symmetric' && r.message === nothingToActOn(f.op, f.name)) {
        const other = await bodyTheOtherWay(f, v, out, keys, ctx);
        if (other) return { ...r, message: `${r.message}: tick Flip direction to ${f.op === 'cut' ? 'cut' : 'intersect'} ${f.op === 'cut' ? 'into' : 'with'} ${other}` };
      }
      return r;
    } finally {
      if (made != null) await ctx.release([made]).catch(() => {});
    }
  },
};

/** The first body the extrude flipped would overlap (its name), or null. Every shape made here is released. */
async function bodyTheOtherWay(f: ExtrudeFeature, v: ExtrudeValues, out: SketchOutput, keys: string[], ctx: BuildContext): Promise<string | null> {
  const made: ShapeId[] = [];
  try {
    const res = await ctx.kernel.call('extrude_regions', { plane: out.plane, curves: out.curves, regions: keys, extent: v.extent, flip: !f.flip });
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
