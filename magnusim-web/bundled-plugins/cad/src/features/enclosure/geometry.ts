// The Enclosure's geometry as pure functions: each side's padding from the
// padding mode (Zero / Percent / Fixed) or the user's own value, and the box
// or cylinder that sits that far out from the enclosed bodies' exact bounding
// box. The feature's build (def.ts), its panel and its drag arrows all use
// these, so they agree to the last digit.
//   Box: corner = bbox min - (-X, -Y, -Z padding); far corner = bbox max +
//     (+X, +Y, +Z padding). Percent: of the part's size along that axis.
//   Cylinder about an origin axis: its axis runs through the middle of the
//     bounding box; with no padding it passes through the box's corners
//     (r0 = half the diagonal across the axis); Radius adds to r0; Top and
//     Bottom extend the two ends. Percent: of r0 (Radius) and of the part's
//     length along the axis (Top, Bottom).
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { AXIS_DIR, MIN_SIZE_MM } from '../../doc/features/primitives';
import type { EnclosureFeature, EnclosureSide, OriginAxisRef, Vec3 } from '../../types/doc';
import type { ResolveResult } from '../../types/doc-service';
import type { BBox } from '../../types/kernel-protocol';
import type { Expr, LengthUnit, UnitsService } from '../../types/units';

export const BOX_SIDES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const satisfies readonly EnclosureSide[];
export const CYLINDER_SIDES = ['radius', 'top', 'bottom'] as const satisfies readonly EnclosureSide[];

/** What the panel calls each side (a cylinder's ends: sideLabel, which knows its axis). */
export const SIDE_LABELS: Record<EnclosureSide, string> = {
  '+x': '+X',
  '-x': '−X',
  '+y': '+Y',
  '-y': '−Y',
  '+z': '+Z',
  '-z': '−Z',
  radius: 'Radius',
  top: 'Top',
  bottom: 'Bottom',
};

/** Field ids without signs ("side-px"), for data-field and element ids. */
export const SIDE_KEYS: Record<EnclosureSide, string> = { '+x': 'px', '-x': 'nx', '+y': 'py', '-y': 'ny', '+z': 'pz', '-z': 'nz', radius: 'radius', top: 'top', bottom: 'bottom' };

export const AXIS_LABELS: Record<OriginAxisRef, string> = { 'origin:x': 'X', 'origin:y': 'Y', 'origin:z': 'Z' };

/**
 * A side's name as the user reads it: a cylinder about Z has a Top and a Bottom; about X or Y its
 * ends are "+X end" and "−X end" (SD review round 1: a cylinder lying along X had a "Top").
 */
export function sideLabel(side: EnclosureSide, axis: OriginAxisRef = 'origin:z'): string {
  if ((side === 'top' || side === 'bottom') && axis !== 'origin:z') return `${side === 'top' ? '+' : '−'}${AXIS_LABELS[axis] ?? 'Z'} end`;
  return SIDE_LABELS[side];
}

/** A default fixed distance per display unit (explicit unit, so it reads the same anywhere). */
export const DEFAULT_DISTANCE: Record<LengthUnit, Expr> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

export function sidesOf(shape: EnclosureFeature['shape']): readonly EnclosureSide[] {
  return shape === 'cylinder' ? CYLINDER_SIDES : BOX_SIDES;
}

/** The feature's expressions evaluated (mm, percent as a number). */
export interface EnclosureValues {
  shape: 'box' | 'cylinder';
  axis: OriginAxisRef;
  padding: EnclosureFeature['padding'];
  /** Percent mode: the percent (10 = 10 %). */
  percent: number | null;
  /** Fixed mode: the distance (mm). */
  distance: number | null;
  /** Sides the user set (mm). */
  sides: Partial<Record<EnclosureSide, number>>;
}

function evalLength(label: string, expr: Expr | undefined, units: UnitsService): { ok: true; value: number } | { ok: false; message: string } {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), 'length');
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

/** Every expression the feature uses now, evaluated with its rules (the panel's fields say the same). */
export function resolveEnclosure(f: EnclosureFeature, units: UnitsService): ResolveResult<EnclosureValues> {
  if (f.shape !== 'box' && f.shape !== 'cylinder') return { ok: false, message: 'Shape: pick Box or Cylinder' };
  if (f.shape === 'cylinder' && !AXIS_DIR[f.axis]) return { ok: false, message: 'Axis: pick the X, Y or Z axis' };
  let percent: number | null = null;
  let distance: number | null = null;
  if (f.padding === 'percent') {
    const r = units.evaluate(typeof f.percent === 'string' ? f.percent : String(f.percent ?? ''), 'scalar');
    if (!r.ok) return { ok: false, message: `Percent: ${r.error}` };
    if (r.value < 0) return { ok: false, message: 'Percent must not be negative' };
    percent = r.value;
  } else if (f.padding === 'fixed') {
    const r = evalLength('Distance', f.distance, units);
    if (!r.ok) return r;
    if (r.value < 0) return { ok: false, message: 'Distance must not be negative' };
    distance = r.value;
  } else if (f.padding !== 'zero') return { ok: false, message: 'Padding: pick Zero, Percent of part size or Fixed distance' };
  const sides: Partial<Record<EnclosureSide, number>> = {};
  for (const s of sidesOf(f.shape)) {
    const e = f.sides?.[s];
    if (e === undefined || e === null || e === '') continue;
    const r = evalLength(SIDE_LABELS[s], e, units);
    if (!r.ok) return r;
    sides[s] = r.value;
  }
  return { ok: true, values: { shape: f.shape, axis: f.axis, padding: f.padding, percent, distance, sides } };
}

const AXIS_INDEX: Record<OriginAxisRef, 0 | 1 | 2> = { 'origin:x': 0, 'origin:y': 1, 'origin:z': 2 };
const XYZ = ['X', 'Y', 'Z'] as const;

/** The two axes across a cylinder's axis (indices), in X, Y, Z order. */
export function crossAxes(axis: OriginAxisRef): [number, number] {
  const k = AXIS_INDEX[axis];
  return k === 0 ? [1, 2] : k === 1 ? [0, 2] : [0, 1];
}

/** The radius of a cylinder about `axis` that passes through the bounding box's corners (no padding). */
export function baseRadius(bbox: BBox, axis: OriginAxisRef): number {
  const [i, j] = crossAxes(axis);
  return 0.5 * Math.hypot(bbox[i + 3] - bbox[i], bbox[j + 3] - bbox[j]);
}

/** The part's size a side's percent is taken of (mm). */
export function sizeForSide(side: EnclosureSide, bbox: BBox, axis: OriginAxisRef): number {
  if (side === 'radius') return baseRadius(bbox, axis);
  if (side === 'top' || side === 'bottom') {
    const k = AXIS_INDEX[axis];
    return bbox[k + 3] - bbox[k];
  }
  const k = side[1] === 'x' ? 0 : side[1] === 'y' ? 1 : 2;
  return bbox[k + 3] - bbox[k];
}

/** A side's padding from the padding mode alone (mm), whatever the user set on it. */
export function paddingFromMode(side: EnclosureSide, v: Pick<EnclosureValues, 'padding' | 'percent' | 'distance' | 'axis'>, bbox: BBox): number {
  if (v.padding === 'fixed') return v.distance ?? 0;
  if (v.padding === 'percent') return ((v.percent ?? 0) / 100) * sizeForSide(side, bbox, v.axis);
  return 0;
}

/** A side's padding as built (mm): the user's own value, else the padding mode's. */
export function paddingOf(side: EnclosureSide, v: EnclosureValues, bbox: BBox): number {
  const own = v.sides[side];
  return typeof own === 'number' ? own : paddingFromMode(side, v, bbox);
}

/** The side the same axis has at its other end (+X for −X, Top for Bottom), or null (Radius). */
function oppositeSide(side: EnclosureSide): EnclosureSide | null {
  if (side === 'radius') return null;
  if (side === 'top') return 'bottom';
  if (side === 'bottom') return 'top';
  return `${side[0] === '+' ? '-' : '+'}${side[1]}` as EnclosureSide;
}

/** The axis a side moves along (0 X, 1 Y, 2 Z), or null (Radius). */
function sideAxis(side: EnclosureSide, axis: OriginAxisRef): number | null {
  if (side === 'radius') return null;
  if (side === 'top' || side === 'bottom') return AXIS_INDEX[axis];
  return side[1] === 'x' ? 0 : side[1] === 'y' ? 1 : 2;
}

/**
 * The least padding a side can take (mm): its face may go into the part (a symmetry plane), but
 * never as far as the part's far side (the enclosure would no longer hold any of the part: Combine
 * Cut would leave a "fluid" with nothing cut out of it), nor past the opposite side. A side moved
 * that far is refused, and its drag arrow stops there (SD review round 1: −X = −60 on a 40 mm block
 * made a slab beside the part, and the row stayed ok).
 */
export function sideMin(side: EnclosureSide, v: EnclosureValues, bbox: BBox): number {
  return sideMinWith(side, v.axis, bbox, (s) => paddingOf(s, v, bbox));
}

/** sideMin with the other sides' paddings from `padOf` (the drag arrows read them from what was built). */
export function sideMinWith(side: EnclosureSide, axis: OriginAxisRef, bbox: BBox, padOf: (s: EnclosureSide) => number): number {
  if (side === 'radius') return MIN_SIZE_MM - baseRadius(bbox, axis);
  const size = sizeForSide(side, bbox, axis);
  return MIN_SIZE_MM - size - Math.min(0, padOf(oppositeSide(side)!));
}

/** Whether a side goes into the part's bounding box (a negative padding): Combine Cut then leaves that part out of the fluid. */
export function sideCuts(side: EnclosureSide, v: EnclosureValues, bbox: BBox): boolean {
  return paddingOf(side, v, bbox) < -1e-9;
}

/** Length words for messages (the panel passes the document's units). */
export type LengthWords = (mm: number) => string;
const MM_WORDS: LengthWords = (mm) => `${Number(mm.toFixed(6))} mm`;

export type EnclosureShape =
  | { kind: 'box'; min: Vec3; max: Vec3; pad: Partial<Record<EnclosureSide, number>> }
  | { kind: 'cylinder'; base: Vec3; axis: Vec3; r: number; h: number; r0: number; pad: Partial<Record<EnclosureSide, number>> };

/**
 * The box or cylinder for these values around `bbox`, or why it cannot be made (in words) and the
 * sides the reason is about (the panel shows it under their fields: SD review round 2, after the
 * part shrank under a side set inwards the reason showed only at the panel's foot).
 */
export function enclosureShape(v: EnclosureValues, bbox: BBox, words: LengthWords = MM_WORDS): { ok: true; shape: EnclosureShape } | { ok: false; message: string; sides: EnclosureSide[] } {
  const pad: Partial<Record<EnclosureSide, number>> = {};
  for (const s of sidesOf(v.shape)) pad[s] = paddingOf(s, v, bbox);
  // A side moved past the part's far side: the enclosure would hold none of the part. Said in
  // the padding the user types, not as a position (UX review: "(z ≥ 25 mm)" while typing -40).
  for (const s of sidesOf(v.shape)) {
    const k = sideAxis(s, v.axis);
    const size = sizeForSide(s, bbox, v.axis);
    if (k == null || !(pad[s]! < MIN_SIZE_MM - size)) continue;
    return { ok: false, message: `${sideLabel(s, v.axis)} would put the enclosure past the part (padding more than ${words(-size).replace(/^-/, '−')})`, sides: [s] };
  }
  if (v.shape === 'box') {
    const min: Vec3 = [bbox[0] - pad['-x']!, bbox[1] - pad['-y']!, bbox[2] - pad['-z']!];
    const max: Vec3 = [bbox[3] + pad['+x']!, bbox[4] + pad['+y']!, bbox[5] + pad['+z']!];
    for (let k = 0; k < 3; k++) {
      if (!(max[k] - min[k] >= MIN_SIZE_MM)) {
        const a = XYZ[k];
        return { ok: false, message: `The enclosure has no size along ${a}: the −${a} and +${a} sides take away the part's whole ${a} size`, sides: [`-${a.toLowerCase()}`, `+${a.toLowerCase()}`] as EnclosureSide[] };
      }
    }
    return { ok: true, shape: { kind: 'box', min, max, pad } };
  }
  const k = AXIS_INDEX[v.axis];
  const [i, j] = crossAxes(v.axis);
  const r0 = baseRadius(bbox, v.axis);
  const r = r0 + pad.radius!;
  // "whole": at exactly the part's radius it takes away as much as it, not more (SD review round 2).
  if (!(r >= MIN_SIZE_MM)) return { ok: false, message: "The enclosure has no radius: the Radius side takes away the part's whole radius", sides: ['radius'] };
  const bottom = bbox[k] - pad.bottom!;
  const top = bbox[k + 3] + pad.top!;
  if (!(top - bottom >= MIN_SIZE_MM)) return { ok: false, message: `The enclosure has no length along ${XYZ[k]}: the ${sideLabel('top', v.axis)} and ${sideLabel('bottom', v.axis)} sides take away the part's whole length`, sides: ['top', 'bottom'] };
  const base: Vec3 = [0, 0, 0];
  base[i] = (bbox[i] + bbox[i + 3]) / 2;
  base[j] = (bbox[j] + bbox[j + 3]) / 2;
  base[k] = bottom;
  return { ok: true, shape: { kind: 'cylinder', base, axis: [...AXIS_DIR[v.axis]] as Vec3, r, h: top - bottom, r0, pad } };
}

/** The union of bounding boxes (null for none). */
export function unionBox(boxes: readonly BBox[]): BBox | null {
  let out: BBox | null = null;
  for (const b of boxes) {
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.min(out[2], b[2]), Math.max(out[3], b[3]), Math.max(out[4], b[4]), Math.max(out[5], b[5])] : [...b];
  }
  return out;
}

/** The enclosure's volume (mm³), exactly as the kernel's box or cylinder makes it. */
export function shapeVolume(s: EnclosureShape): number {
  if (s.kind === 'box') return (s.max[0] - s.min[0]) * (s.max[1] - s.min[1]) * (s.max[2] - s.min[2]);
  return Math.PI * s.r * s.r * s.h;
}

/**
 * Where each side's drag arrow starts and the way it points (model mm): a box
 * side's middle, outwards; a cylinder's top and bottom middles along the axis,
 * and its radius at mid-height across the axis (along the first cross axis).
 */
export function sideAnchors(s: EnclosureShape): { side: EnclosureSide; base: Vec3; dir: Vec3 }[] {
  if (s.kind === 'box') {
    const c: Vec3 = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2];
    const out: { side: EnclosureSide; base: Vec3; dir: Vec3 }[] = [];
    BOX_SIDES.forEach((side) => {
      const k = side[1] === 'x' ? 0 : side[1] === 'y' ? 1 : 2;
      const plus = side[0] === '+';
      const base: Vec3 = [c[0], c[1], c[2]];
      base[k] = plus ? s.max[k] : s.min[k];
      const dir: Vec3 = [0, 0, 0];
      dir[k] = plus ? 1 : -1;
      out.push({ side, base, dir });
    });
    return out;
  }
  const a = s.axis;
  const top: Vec3 = [s.base[0] + a[0] * s.h, s.base[1] + a[1] * s.h, s.base[2] + a[2] * s.h];
  const mid: Vec3 = [s.base[0] + (a[0] * s.h) / 2, s.base[1] + (a[1] * s.h) / 2, s.base[2] + (a[2] * s.h) / 2];
  const k = a[0] ? 0 : a[1] ? 1 : 2;
  const cross: Vec3 = [0, 0, 0];
  cross[k === 0 ? 1 : 0] = 1;
  return [
    { side: 'radius', base: [mid[0] + cross[0] * s.r, mid[1] + cross[1] * s.r, mid[2] + cross[2] * s.r], dir: cross },
    { side: 'top', base: top, dir: [a[0], a[1], a[2]] },
    { side: 'bottom', base: [s.base[0], s.base[1], s.base[2]], dir: [-a[0], -a[1], -a[2]] },
  ];
}
