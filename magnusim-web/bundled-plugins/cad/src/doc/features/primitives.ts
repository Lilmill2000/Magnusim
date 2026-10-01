// The P1 primitives: Box and Cylinder, each with an Operation (New body /
// Join / Cut / Intersect). Pure functions of their resolved values and the
// bodies before them. Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { BoxFeature, CadDoc, CylinderFeature, OriginAxisRef, Vec3 } from '../../types/doc';
import type { FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { Expr, LengthUnit, Quantity, UnitsService } from '../../types/units';
import { applyBodyOp } from './body-op';

/** Same glyphs as the UI's ICONS.box / ICONS.cylinder (24 viewBox outline). */
export const BOX_ICON = 'M3 9l5-4h13v10l-5 4H3z M3 9h13v10 M16 9l5-4';
export const CYLINDER_ICON = 'M6 6a6 2.5 0 1 0 12 0a6 2.5 0 1 0 -12 0 M6 6v12a6 2.5 0 0 0 12 0V6';

/** A friendly default size per display unit (explicit unit, so it reads the same anywhere). */
const DEFAULT_SIZE: Record<LengthUnit, Expr> = { mm: '20 mm', cm: '2 cm', m: '0.02 m', in: '1 in', ft: '1 in' };

export const AXIS_DIR: Record<OriginAxisRef, Vec3> = { 'origin:x': [1, 0, 0], 'origin:y': [0, 1, 0], 'origin:z': [0, 0, 1] };

type Field = { label: string; expr: Expr; quantity: Quantity; positive?: boolean };

/**
 * The smallest size a primitive takes (mm). Below it the kernel either refuses
 * (Standard_DomainError) or builds a solid it then calls invalid; the field
 * says so in plain words instead.
 */
export const MIN_SIZE_MM = 1e-6;
/** "Length must be at least 0.000001 mm" (the UI's field check says the same). */
export function sizeProblem(label: string, mm: number): string | null {
  if (!(mm > 0)) return `${label} must be more than 0`;
  if (mm < MIN_SIZE_MM) return `${label} must be at least 0.000001 mm`;
  return null;
}

/** Evaluate fields in order; the first problem wins ("Height: Enter a value"). */
function evalFields(fields: Field[], units: UnitsService): ResolveResult<number[]> {
  const values: number[] = [];
  for (const f of fields) {
    const r = units.evaluate(typeof f.expr === 'string' ? f.expr : String(f.expr ?? ''), f.quantity);
    if (!r.ok) return { ok: false, message: `${f.label}: ${r.error}` };
    if (f.positive) {
      const why = sizeProblem(f.label, r.value);
      if (why) return { ok: false, message: why };
    }
    values.push(r.value);
  }
  return { ok: true, values };
}

function existingNames(doc: CadDoc): string[] {
  return doc.features.map((f) => f.name);
}

export interface BoxValues {
  origin: Vec3;
  size: Vec3;
}

export const boxDef: FeatureTypeDef<BoxFeature, BoxValues> = {
  type: 'box',
  label: 'Box',
  icon: BOX_ICON,
  create(doc, init = {}) {
    const s = DEFAULT_SIZE[doc.units.length];
    return {
      id: newId('f'),
      type: 'box',
      name: nextName('Box', existingNames(doc)),
      op: 'new',
      creates: null,
      scope: [],
      origin: ['0', '0', '0'],
      size: [s, s, s],
      ...init,
    };
  },
  resolve(f, units) {
    const o = f.origin ?? ['', '', ''];
    const s = f.size ?? ['', '', ''];
    const r = evalFields(
      [
        { label: 'Length', expr: s[0], quantity: 'length', positive: true },
        { label: 'Width', expr: s[1], quantity: 'length', positive: true },
        { label: 'Height', expr: s[2], quantity: 'length', positive: true },
        { label: 'Corner X', expr: o[0], quantity: 'length' },
        { label: 'Corner Y', expr: o[1], quantity: 'length' },
        { label: 'Corner Z', expr: o[2], quantity: 'length' },
      ],
      units,
    );
    if (!r.ok) return r;
    const [l, w, h, x, y, z] = r.values;
    return { ok: true, values: { size: [l, w, h], origin: [x, y, z] } };
  },
  incomplete(f, units) {
    const r = boxDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  async build(f, v, ctx) {
    const r = await ctx.kernel.call('box', { dx: v.size[0], dy: v.size[1], dz: v.size[2], origin: v.origin });
    return applyBodyOp(f, f.name, { shape: r.result.id, valid: r.result.valid !== false }, ctx);
  },
};

export interface CylinderValues {
  origin: Vec3;
  axis: Vec3;
  diameter: number;
  height: number;
}

export const cylinderDef: FeatureTypeDef<CylinderFeature, CylinderValues> = {
  type: 'cylinder',
  label: 'Cylinder',
  icon: CYLINDER_ICON,
  create(doc, init = {}) {
    const s = DEFAULT_SIZE[doc.units.length];
    return {
      id: newId('f'),
      type: 'cylinder',
      name: nextName('Cylinder', existingNames(doc)),
      op: 'new',
      creates: null,
      scope: [],
      origin: ['0', '0', '0'],
      axis: 'origin:z',
      diameter: s,
      height: s,
      ...init,
    };
  },
  resolve(f, units) {
    const axis = AXIS_DIR[f.axis as OriginAxisRef];
    if (!axis) return { ok: false, message: 'Axis: pick the X, Y or Z axis' };
    const o = f.origin ?? ['', '', ''];
    const r = evalFields(
      [
        { label: 'Diameter', expr: f.diameter, quantity: 'length', positive: true },
        { label: 'Height', expr: f.height, quantity: 'length', positive: true },
        { label: 'Centre X', expr: o[0], quantity: 'length' },
        { label: 'Centre Y', expr: o[1], quantity: 'length' },
        { label: 'Centre Z', expr: o[2], quantity: 'length' },
      ],
      units,
    );
    if (!r.ok) return r;
    const [d, h, x, y, z] = r.values;
    return { ok: true, values: { diameter: d, height: h, origin: [x, y, z], axis } };
  },
  incomplete(f, units) {
    const r = cylinderDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  async build(f, v, ctx) {
    const r = await ctx.kernel.call('cylinder', { r: v.diameter / 2, h: v.height, origin: v.origin, axis: v.axis });
    return applyBodyOp(f, f.name, { shape: r.result.id, valid: r.result.valid !== false }, ctx);
  },
};
