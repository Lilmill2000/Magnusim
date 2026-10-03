// The Enclosure feature type (decision 2026-10-01, CFD prep): a box or a
// cylinder around the exact bounding box of bodies made before it, made as a
// new body ("Enclosure 1"). It never cuts: the air volume is a separate
// Combine (Cut, keep tools), so it has no Operation. Parametric: its cache key
// holds the enclosed bodies, so it is built again when they change, with the
// user's padding and sides kept.
//   - bodies: the picked ones, or (none picked) every solid body before it
//     except other enclosures' bodies (surface bodies have no inside);
//   - their exact bounding box (kernel props bbox:'exact', never the padded
//     fast box), one call per body;
//   - the kernel's box / cylinder op (it keeps them for this), checked;
//   - face names by side: F:<id>:enclosure:+x ... -z (OCCT makes a box's faces
//     in the order -X, +X, -Y, +Y, -Z, +Z, a cylinder's as side, top, bottom
//     whatever their sizes: tests/features/enclosure checks it on the real
//     kernel), so a later Combine or boundary condition keeps its face. A
//     cylinder about X or Y names its ends +x-end / -x-end (+y-end / -y-end):
//     panels say "+X end of Enclosure 1", not "Top".
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { faceName } from '../../naming/names';
import type { BodyId, EnclosureFeature, EnclosureSide, OriginAxisRef } from '../../types/doc';
import type { BuildContext, ExprField, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { BBox } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { Expr } from '../../types/units';
import { formatQuantity } from '../../ui/kit/format';
import { kernelWords } from '../p2/repair';
import { DEFAULT_DISTANCE, enclosureShape, resolveEnclosure, sidesOf, unionBox, type EnclosureValues } from './geometry';

/** Outline glyph (24 viewBox): a dashed box around a small solid. */
export const ENCLOSURE_ICON = 'M3 7l4-3h14v13l-4 3H3z M3 7h14v13 M17 7l4-3 M8 12h5v5H8z';

/** The colour an Enclosure's body starts in: a pale blue, so it reads as the space round the part. */
export const ENCLOSURE_COLOR = '#d3e1f2';

/** OCCT's face order of a box and of a cylinder (checked on the real kernel in the tests). */
export const BOX_FACE_SIDES: readonly EnclosureSide[] = ['-x', '+x', '-y', '+y', '-z', '+z'];
export const CYLINDER_FACE_SIDES = ['side', 'top', 'bottom'] as const;

/** A cylinder's face details about its axis: side, then its two ends (top, bottom about Z; +x-end, -x-end about X). */
export function cylinderFaceSides(axis: OriginAxisRef = 'origin:z'): readonly string[] {
  if (axis === 'origin:z') return CYLINDER_FACE_SIDES;
  const a = axis === 'origin:x' ? 'x' : 'y';
  return ['side', `+${a}-end`, `-${a}-end`];
}

/** The face names of an Enclosure's body, or null when the kernel's face count is not the expected one. */
export function enclosureNames(feature: string, shape: 'box' | 'cylinder', faces: number | undefined, axis: OriginAxisRef = 'origin:z'): FaceNames | null {
  const order: readonly string[] = shape === 'box' ? BOX_FACE_SIDES : cylinderFaceSides(axis);
  if (faces !== order.length) return null;
  return { faces: order.map((s) => faceName(feature, 'enclosure', s)) };
}

/** Whether `id` is the body of an Enclosure in `features`. */
export function isEnclosureBody(features: readonly { type: string; creates?: unknown }[], id: BodyId): boolean {
  return features.some((g) => g.type === 'enclosure' && (g as EnclosureFeature).creates === id);
}

/** Exact boxes of these bodies' shapes, and how many solids each has. */
async function exactBoxes(ctx: BuildContext, ids: BodyId[]): Promise<Map<BodyId, { bbox: BBox | null; solids: number }>> {
  const out = new Map<BodyId, { bbox: BBox | null; solids: number }>();
  for (const id of ids) {
    const b = ctx.bodies.get(id)!;
    const r = await ctx.kernel.call('props', { id: b.shape, bbox: 'exact' });
    out.set(id, { bbox: (r.result.bbox as BBox | null | undefined) ?? null, solids: r.result.solids });
  }
  return out;
}

const exprList = (f: EnclosureFeature): ExprField[] => {
  const out: ExprField[] = [
    { path: 'percent', expr: f.percent },
    { path: 'distance', expr: f.distance },
  ];
  for (const [side, e] of Object.entries(f.sides ?? {})) if (typeof e === 'string') out.push({ path: `sides.${side}`, expr: e });
  return out;
};

export const enclosureDef: FeatureTypeDef<EnclosureFeature, EnclosureValues> = {
  type: 'enclosure',
  label: 'Enclosure',
  icon: ENCLOSURE_ICON,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'enclosure',
      name: nextName('Enclosure', doc.features.map((f) => f.name)),
      shape: 'box',
      axis: 'origin:z',
      bodies: [],
      padding: 'zero',
      percent: '10',
      distance: DEFAULT_DISTANCE[doc.units.length] ?? '10 mm',
      sides: {},
      creates: newId('b'),
      ...init,
    };
  },
  resolve: (f, units) => resolveEnclosure(f, units),
  incomplete(f, units) {
    const r = resolveEnclosure(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  // The picked bodies, or every body before it (the cache key then holds them all: any change rebuilds it).
  uses: (f) => (f.bodies?.length ? [...f.bodies] : 'all'),
  ownsBody: (f, id) => f.creates === id,
  // Drawn see-through: the part inside and the air around it are both seen (SD review round 1).
  seeThrough: () => true,
  newBodies: (f) => ({ [f.creates]: { name: f.name, color: ENCLOSURE_COLOR } }),
  exprs: exprList,
  mapExprs: (f, fn) => {
    const sides: Partial<Record<EnclosureSide, Expr>> = {};
    for (const [side, e] of Object.entries(f.sides ?? {}) as [EnclosureSide, Expr][]) sides[side] = typeof e === 'string' ? fn(e) : e;
    return { ...f, percent: fn(f.percent), distance: fn(f.distance), sides };
  },
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const picked = f.bodies ?? [];
    const missing = picked.filter((id) => !ctx.bodies.has(id));
    if (missing.length) return { ok: false, message: `${f.name} failed: ${missing.map((id) => ctx.bodyName(id)).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not there at this point` };
    // Every body before it but other enclosures' (the fluid of an earlier one is not part of the part).
    const candidates = picked.length ? picked : [...ctx.bodies.keys()].filter((id) => id !== f.creates && !isEnclosureBody(ctx.doc.features, id));
    if (!candidates.length) return { ok: false, message: `${f.name} failed: there is no body before it to enclose: add or import a body first` };
    let boxes;
    try {
      boxes = await exactBoxes(ctx, candidates);
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
      throw err;
    }
    // With none picked, only solid bodies (a surface body has no inside to keep air out of).
    const used = picked.length ? candidates : candidates.filter((id) => (boxes.get(id)?.solids ?? 0) > 0);
    if (!used.length) return { ok: false, message: `${f.name} failed: there is no solid body before it to enclose (surface bodies are left out unless picked)` };
    const bbox = unionBox(used.map((id) => boxes.get(id)?.bbox).filter((b): b is BBox => !!b && b.every(Number.isFinite)));
    if (!bbox) return { ok: false, message: `${f.name} failed: the kernel gave no bounding box for ${used.map((id) => ctx.bodyName(id)).join(', ')}` };
    const s = enclosureShape(v, bbox, (mm) => formatQuantity(mm, 'length', ctx.doc.units));
    // Failed, it still says what it encloses and their box: its panel shows the reason under the
    // side at fault and the bodies it counts (SD review round 2). No box or cylinder: no arrows.
    if (!s.ok) return { ok: false, message: `${f.name} failed: ${s.message}`, output: { type: 'enclosure', bodies: used, bbox, pad: {} } };
    const sh = s.shape;
    let res;
    try {
      res =
        sh.kind === 'box'
          ? await ctx.kernel.call('box', { dx: sh.max[0] - sh.min[0], dy: sh.max[1] - sh.min[1], dz: sh.max[2] - sh.min[2], origin: sh.min })
          : await ctx.kernel.call('cylinder', { r: sh.r, h: sh.h, origin: sh.base, axis: sh.axis });
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
      throw err;
    }
    const valid = res.result.valid !== false;
    if (!valid) {
      await ctx.release([res.result.id]);
      return { ok: false, message: `${f.name} failed: the kernel made an invalid ${sh.kind}${res.result.reason ? ` (${res.result.reason})` : ''}` };
    }
    return {
      ok: true,
      bodies: [{ id: f.creates, shape: res.result.id, valid, names: enclosureNames(f.id, sh.kind, res.result.faces, v.axis) }],
      removed: [],
      output: {
        type: 'enclosure',
        bodies: used,
        bbox,
        pad: { ...sh.pad },
        ...(sh.kind === 'box' ? { box: { min: sh.min, max: sh.max } } : { cylinder: { base: sh.base, axis: sh.axis, r: sh.r, h: sh.h, r0: sh.r0 } }),
      },
    };
  },
};

/** The sides of this enclosure's shape the user set on their own. */
export function ownSides(f: EnclosureFeature): EnclosureSide[] {
  return sidesOf(f.shape).filter((s) => typeof f.sides?.[s] === 'string' && f.sides[s] !== '');
}
