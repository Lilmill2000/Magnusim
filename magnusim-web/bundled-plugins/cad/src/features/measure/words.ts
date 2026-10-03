// What Measure shows, as plain rows (pure; unit-tested): one entity's length,
// area, radius, position; two entities' minimum distance with its X/Y/Z parts,
// the angle between them and the distance between centres. Values in the
// document's units (UnitsService.format).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { placeWords } from '../../naming';
import { ORIGIN_PLANES, type OriginRef, type Vec3 } from '../../types/doc';
import type { MeasureOne, MeasureResult, MeasureTarget } from '../../types/kernel-protocol';
import type { BodyInfo } from '../../types/kernel';
import type { SelectionItem } from '../../types/selection';
import type { DocUnits, UnitsService } from '../../types/units';
import { formatQuantity, formatReadout, MM_PER } from '../../ui/kit/format';

export interface Row {
  key: string;
  label: string;
  value: string;
}

const AXES: Record<string, { label: string; dir: Vec3 }> = {
  'origin:x': { label: 'X axis', dir: [1, 0, 0] },
  'origin:y': { label: 'Y axis', dir: [0, 1, 0] },
  'origin:z': { label: 'Z axis', dir: [0, 0, 1] },
};

/** The kernel target for a picked item, or null when it cannot be measured. */
export function targetOf(item: SelectionItem, bodies: readonly BodyInfo[]): MeasureTarget | null {
  if (item.kind === 'face' || item.kind === 'edge' || item.kind === 'vertex') {
    const b = bodies.find((x) => x.id === item.body);
    if (!b) return null;
    return { id: b.shape, [item.kind]: item.index } as MeasureTarget;
  }
  if (item.kind === 'body') {
    const b = bodies.find((x) => x.id === item.body);
    return b ? { id: b.shape } : null;
  }
  if (item.kind === 'origin') {
    const ref = item.ref as OriginRef;
    if (ref === 'origin:point') return { point: [0, 0, 0] };
    if (ref in ORIGIN_PLANES) {
      const p = ORIGIN_PLANES[ref as keyof typeof ORIGIN_PLANES];
      return { plane: { origin: p.origin, normal: p.normal } };
    }
    if (AXES[ref]) return { axis: { origin: [0, 0, 0], dir: AXES[ref].dir } };
  }
  return null;
}

/** "Face 3 of Body 1", "Edge 12 of Body 1", "Top plane". */
export function itemLabel(item: SelectionItem, bodies: readonly BodyInfo[]): string {
  if (item.kind === 'face' || item.kind === 'edge' || item.kind === 'vertex') {
    const b = bodies.find((x) => x.id === item.body);
    const what = item.kind === 'vertex' ? 'Point' : item.kind === 'face' ? 'Face' : 'Edge';
    // A face with a place of its own on the body ("+Z face of Enclosure 1").
    const place = item.kind === 'face' ? placeWords(b?.names?.faces[item.index]) : null;
    if (place && b) return `${place} of ${b.name}`;
    return `${what} ${item.index + 1} of ${b?.name ?? 'a body'}`;
  }
  if (item.kind === 'body') return bodies.find((x) => x.id === item.body)?.name ?? 'A body';
  if (item.kind === 'origin') {
    const ref = item.ref as OriginRef;
    if (ref === 'origin:point') return 'Origin';
    if (ref in ORIGIN_PLANES) return ORIGIN_PLANES[ref as keyof typeof ORIGIN_PLANES].label;
    return AXES[ref]?.label ?? 'Origin';
  }
  return 'Item';
}

const TYPE_WORDS: Record<string, string> = {
  plane: 'Flat',
  cylinder: 'Cylinder',
  cone: 'Cone',
  sphere: 'Sphere',
  torus: 'Torus',
  bspline: 'Freeform',
  other: 'Other',
  line: 'Straight',
  circle: 'Circle',
  ellipse: 'Ellipse',
};

/** An area in the document's length unit squared ("314.159 mm²", "0.487 in²"). */
export function formatArea(mm2: number, units: DocUnits): string {
  const f = MM_PER[units.length];
  return `${formatReadout(mm2 / (f * f))} ${units.length}²`;
}

function vec(v: Vec3, u: UnitsService): string {
  return v.map((x) => formatReadout(x / MM_PER[u.units().length])).join(', ') + ` ${u.unitLabel('length')}`;
}

function oneRows(prefix: string, m: MeasureOne, u: UnitsService): Row[] {
  const rows: Row[] = [];
  const add = (key: string, label: string, value: string) => rows.push({ key: `${prefix}${key}`, label, value });
  if (m.type && TYPE_WORDS[m.type]) add('type', 'Type', TYPE_WORDS[m.type]);
  if (m.length != null) add('length', 'Length', formatQuantity(m.length, 'length', u.units()));
  if (m.area != null) add('area', 'Area', formatArea(m.area, u.units()));
  if (m.radius != null) add('radius', 'Radius', formatQuantity(m.radius, 'length', u.units()));
  if (m.radius != null) add('diameter', 'Diameter', formatQuantity(2 * m.radius, 'length', u.units()));
  if (m.kind === 'vertex' && m.point) add('point', 'Position', vec(m.point, u));
  if (m.center && (m.kind === 'edge' || m.type === 'sphere' || m.type === 'cylinder')) add('center', 'Centre', vec(m.center, u));
  return rows;
}

/** The rows Measure shows for a result (one entity, or two). */
export function measureRows(r: MeasureResult, u: UnitsService): Row[] {
  if (!r.b) return oneRows('a.', r.a, u);
  const rows: Row[] = [];
  if (r.distance != null) rows.push({ key: 'distance', label: 'Distance', value: formatQuantity(r.distance, 'length', u.units()) });
  if (r.delta) {
    rows.push({ key: 'dx', label: 'ΔX', value: formatQuantity(Math.abs(r.delta[0]), 'length', u.units()) });
    rows.push({ key: 'dy', label: 'ΔY', value: formatQuantity(Math.abs(r.delta[1]), 'length', u.units()) });
    rows.push({ key: 'dz', label: 'ΔZ', value: formatQuantity(Math.abs(r.delta[2]), 'length', u.units()) });
  }
  if (r.angle_deg != null) rows.push({ key: 'angle', label: 'Angle', value: formatQuantity(r.angle_deg, 'angle', u.units()) });
  if (r.center_distance != null) rows.push({ key: 'centers', label: 'Centre distance', value: formatQuantity(r.center_distance, 'length', u.units()) });
  return rows;
}
