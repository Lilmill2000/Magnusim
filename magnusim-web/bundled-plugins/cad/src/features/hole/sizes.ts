// Hole sizes from a fastener, metric or inch (fastener()): the clearance hole for a bolt (close,
// normal or loose fit) and the tap drill and thread of a tapped hole.
//   Metric (ISO): M1.6 to M64, coarse pitches only (ISO 261); the ISO 273 clearance holes; the tap
//   drill is the major diameter minus the pitch. With a clearance hole, the counterbore for an
//   ISO 4762 socket head cap screw (DIN 974-1, M3 to M30) and the countersink for an ISO 10642
//   countersunk head screw (its head's theoretical diameter at 90 deg, M3 to M20).
//   Unified inch: #0 to 1 in, UNC and UNF (ASME B1.1; "1/4-20", "1/4-28 UNF", "#10-32", "1/4"
//   alone is its UNC); the ASME B18.2.8 clearance holes (the smaller end of each fit's range; the
//   standard's table has no #12 or 9/16); the tap drill for about 75% thread, by its drill name.
//   Inch sizes stay in inches in the expressions ("0.201 in"). There is no inch head table.
// The numbers are the standards' published values. The metric clearance holes, pitches and
// ISO 4762 head sizes, and the Unified majors and threads per inch, were cross-checked against
// SolidCraft's tables (https://github.com/tangency-labs/solidcraft, MIT OR Apache-2.0), which
// THIRD_PARTY_NOTICES.md credits; the Unified tap drills and clearance holes against two or more
// published charts each.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ExtrudeExtentDef, ExtrudeFeature, Feature } from '../../types/doc';

export type ClearanceFit = 'close' | 'normal' | 'loose';
const MM_PER_IN = 25.4;

/** A fastener size Hole knows, all lengths in mm (and as the expressions the hole keeps). */
export interface Fastener {
  system: 'metric' | 'unified';
  /** The size alone: "M6", "1/4", "#10". */
  size: string;
  /** Its thread: "M6x1", "1/4-20 UNC". */
  thread: string;
  major: number;
  pitch: number;
  /** The tap drill: its expression in the size's own unit ("5 mm", "0.201 in") and in words ("#7, 0.201 in"). */
  tap: { expr: string; mm: number; words: string };
  /** The clearance hole for each fit, or null when the standard's table has none for this size. */
  clearance: Record<ClearanceFit, { expr: string; mm: number }> | null;
}

// ---- metric: [d, pitch, close, normal, loose] (mm)
const METRIC: readonly [number, number, number, number, number][] = [
  [1.6, 0.35, 1.7, 1.8, 2.0],
  [2, 0.4, 2.2, 2.4, 2.6],
  [2.5, 0.45, 2.7, 2.9, 3.1],
  [3, 0.5, 3.2, 3.4, 3.6],
  [4, 0.7, 4.3, 4.5, 4.8],
  [5, 0.8, 5.3, 5.5, 5.8],
  [6, 1, 6.4, 6.6, 7.0],
  [8, 1.25, 8.4, 9.0, 10.0],
  [10, 1.5, 10.5, 11.0, 12.0],
  [12, 1.75, 13.0, 13.5, 14.5],
  [14, 2, 15.0, 15.5, 16.5],
  [16, 2, 17.0, 17.5, 18.5],
  [20, 2.5, 21.0, 22.0, 24.0],
  [24, 3, 25.0, 26.0, 28.0],
  [30, 3.5, 31.0, 33.0, 35.0],
  [36, 4, 37.0, 39.0, 42.0],
  [42, 4.5, 43.0, 45.0, 48.0],
  [48, 5, 50.0, 52.0, 56.0],
  [56, 5.5, 58.0, 62.0, 66.0],
  [60, 5.5, 62.0, 66.0, 70.0],
  [64, 6, 66.0, 70.0, 74.0],
];

// ---- Unified inch: [size, major, UNC tpi | null, UNF tpi, UNC tap drill, UNF tap drill, B18.2.8 close/normal/loose | null] (in)
type Drill = [string, number];
const UNIFIED: readonly [string, number, number | null, number, Drill | null, Drill, [number, number, number] | null][] = [
  ['#0', 0.06, null, 80, null, ['3/64', 0.0469], [0.067, 0.076, 0.094]],
  ['#1', 0.073, 64, 72, ['#53', 0.0595], ['#53', 0.0595], [0.081, 0.089, 0.104]],
  ['#2', 0.086, 56, 64, ['#50', 0.07], ['#50', 0.07], [0.094, 0.102, 0.116]],
  ['#3', 0.099, 48, 56, ['#47', 0.0785], ['#45', 0.082], [0.106, 0.116, 0.128]],
  ['#4', 0.112, 40, 48, ['#43', 0.089], ['#42', 0.0935], [0.12, 0.128, 0.144]],
  ['#5', 0.125, 40, 44, ['#38', 0.1015], ['#37', 0.104], [0.141, 0.156, 0.172]],
  ['#6', 0.138, 32, 40, ['#36', 0.1065], ['#33', 0.113], [0.154, 0.17, 0.185]],
  ['#8', 0.164, 32, 36, ['#29', 0.136], ['#29', 0.136], [0.18, 0.196, 0.213]],
  ['#10', 0.19, 24, 32, ['#25', 0.1495], ['#21', 0.159], [0.206, 0.221, 0.238]],
  ['#12', 0.216, 24, 28, ['#16', 0.177], ['#14', 0.182], null],
  ['1/4', 0.25, 20, 28, ['#7', 0.201], ['#3', 0.213], [0.266, 0.281, 0.297]],
  ['5/16', 0.3125, 18, 24, ['F', 0.257], ['I', 0.272], [0.328, 0.344, 0.359]],
  ['3/8', 0.375, 16, 24, ['5/16', 0.3125], ['Q', 0.332], [0.391, 0.406, 0.422]],
  ['7/16', 0.4375, 14, 20, ['U', 0.368], ['25/64', 0.3906], [0.453, 0.469, 0.484]],
  ['1/2', 0.5, 13, 20, ['27/64', 0.4219], ['29/64', 0.4531], [0.531, 0.562, 0.609]],
  ['9/16', 0.5625, 12, 18, ['31/64', 0.4844], ['33/64', 0.5156], null],
  ['5/8', 0.625, 11, 18, ['17/32', 0.5312], ['37/64', 0.5781], [0.656, 0.688, 0.734]],
  ['3/4', 0.75, 10, 16, ['21/32', 0.6562], ['11/16', 0.6875], [0.781, 0.812, 0.906]],
  ['7/8', 0.875, 9, 14, ['49/64', 0.7656], ['13/16', 0.8125], [0.906, 0.938, 1.031]],
  ['1', 1, 8, 12, ['7/8', 0.875], ['59/64', 0.9219], [1.031, 1.094, 1.156]],
];

const FITS: readonly ClearanceFit[] = ['close', 'normal', 'loose'];
const round = (v: number) => Math.round(v * 1e6) / 1e6;

function metricOf(row: (typeof METRIC)[number]): Fastener {
  const [d, pitch, ...holes] = row;
  return {
    system: 'metric',
    size: `M${d}`,
    thread: `M${d}x${pitch}`,
    major: d,
    pitch,
    tap: { expr: `${round(d - pitch)} mm`, mm: round(d - pitch), words: `${round(d - pitch)} mm` },
    clearance: Object.fromEntries(FITS.map((f, i) => [f, { expr: `${holes[i]} mm`, mm: holes[i] }])) as Fastener['clearance'],
  };
}

function unifiedOf(row: (typeof UNIFIED)[number], tpi: number, series: 'UNC' | 'UNF'): Fastener {
  const [size, major, , , unc, unf, holes] = row;
  const drill = (series === 'UNC' ? unc : unf)!;
  return {
    system: 'unified',
    size,
    thread: `${size}-${tpi} ${series}`,
    major: round(major * MM_PER_IN),
    pitch: round(MM_PER_IN / tpi),
    tap: { expr: `${drill[1]} in`, mm: round(drill[1] * MM_PER_IN), words: `${drill[0]}, ${drill[1]} in` },
    clearance: holes ? (Object.fromEntries(FITS.map((f, i) => [f, { expr: `${holes[i]} in`, mm: round(holes[i] * MM_PER_IN) }])) as Fastener['clearance']) : null,
  };
}

/**
 * The fastener a size names, or null: "M6" (any case; "M6x1" only with its coarse pitch), or an
 * inch size "1/4", "1/4-20", "1/4-28 UNF", "#10-32" (UNC or UNF by its threads per inch or the
 * series named; the size alone is its UNC, #0's UNF).
 */
export function fastener(text: string): Fastener | null {
  const t = text.trim();
  const m = /^m\s*(\d+(?:\.\d+)?)\s*(?:x\s*(\d+(?:\.\d+)?))?$/i.exec(t);
  if (m) {
    const row = METRIC.find((r) => Math.abs(r[0] - Number(m[1])) < 1e-9);
    if (!row || (m[2] !== undefined && Math.abs(Number(m[2]) - row[1]) > 1e-9)) return null;
    return metricOf(row);
  }
  const u = /^(#\s*\d+|\d+\/\d+|1)\s*(?:-\s*(\d+))?\s*(unc|unf)?$/i.exec(t);
  if (!u) return null;
  const name = u[1].replace(/\s+/g, '');
  const row = UNIFIED.find((r) => r[0] === name);
  if (!row) return null;
  const [, , unc, unf] = row;
  const asked = u[3]?.toUpperCase() as 'UNC' | 'UNF' | undefined;
  const tpi = u[2] !== undefined ? Number(u[2]) : null;
  const series: 'UNC' | 'UNF' | null = tpi !== null ? (tpi === unc ? 'UNC' : tpi === unf ? 'UNF' : null) : (asked ?? (unc !== null ? 'UNC' : 'UNF'));
  if (!series || (asked && asked !== series) || (series === 'UNC' && unc === null)) return null;
  return unifiedOf(row, series === 'UNC' ? unc! : unf, series);
}

/** The sizes for the panel's pickers: every metric size, and each inch size's UNC and UNF threads. */
export const SIZE_CHOICES = {
  metric: METRIC.map((r) => ({ value: `M${r[0]}`, label: `M${r[0]}`, tapped: `M${r[0]}x${r[1]}` })),
  unified: UNIFIED.flatMap((r) => [...(r[2] !== null ? [{ value: `${r[0]}-${r[2]}`, label: `${r[0]}-${r[2]} UNC` }] : []), { value: `${r[0]}-${r[3]}`, label: `${r[0]}-${r[3]} UNF` }]),
  /** Inch sizes with a clearance hole in the standard's table. */
  unifiedClearance: UNIFIED.filter((r) => r[6]).map((r) => ({ value: r[0], label: r[0] })),
};

// ---- screw heads (metric, with a clearance hole)

/**
 * Counterbores for ISO 4762 socket head cap screws (DIN 974-1): the counterbore's diameter and
 * depth (mm), the screw's head (dk, k) sitting just below the face. M3 to M30.
 */
const COUNTERBORES: readonly [number, number, number][] = [
  [3, 6.5, 3.4],
  [4, 8, 4.4],
  [5, 10, 5.4],
  [6, 11, 6.4],
  [8, 15, 8.6],
  [10, 18, 10.6],
  [12, 20, 12.6],
  [14, 24, 14.6],
  [16, 26, 16.6],
  [20, 33, 20.6],
  [24, 40, 24.8],
  [30, 48, 30.8],
];

/** Countersinks for ISO 10642 countersunk head screws: the head's theoretical diameter dk at 90 deg (mm), so it sits flush. M3 to M20. */
const COUNTERSINKS: readonly [number, number][] = [
  [3, 6.72],
  [4, 8.96],
  [5, 11.2],
  [6, 13.44],
  [8, 17.92],
  [10, 22.4],
  [12, 26.88],
  [14, 30.8],
  [16, 33.6],
  [20, 40.32],
];

/** The sizes each table has, for the words of a refusal ("M3 to M30"). */
export const COUNTERBORE_SIZES = 'M3 to M30';
export const COUNTERSINK_SIZES = 'M3 to M20';

/** The counterbore for an ISO 4762 socket head cap screw of this size (mm), or null (an inch size has none). */
export function counterboreFor(size: string): { diameter: number; depth: number } | null {
  const f = fastener(size);
  const row = f?.system === 'metric' ? COUNTERBORES.find((x) => Math.abs(x[0] - f.major) < 1e-9) : undefined;
  return row ? { diameter: row[1], depth: row[2] } : null;
}

/** The countersink for an ISO 10642 countersunk head screw of this size (its diameter at the face, mm; the angle is 90 deg), or null (an inch size has none). */
export function countersinkFor(size: string): { diameter: number } | null {
  const f = fastener(size);
  const row = f?.system === 'metric' ? COUNTERSINKS.find((x) => Math.abs(x[0] - f.major) < 1e-9) : undefined;
  return row ? { diameter: row[1] } : null;
}

/** How deep a cut's thread runs, in words: a Blind cut's distance, else the whole hole (its cut's own extent). */
function threadDepthWords(extent: ExtrudeExtentDef): string {
  return extent.kind === 'blind' ? `${extent.distance} deep` : extent.kind === 'through_all' ? 'the whole hole' : "the cut's depth";
}

/**
 * A tapped hole's thread in words, for its cut's row in get_model and its Extrude panel: "M6x1 thread,
 * 12 mm deep, cut into the wall (Hole 1 thread)" while a thread feature cuts it (built: the rule the
 * view's threads.ts follows too), else "... (cosmetic: drawn and listed, not modelled)".
 */
export function threadWords(features: readonly Feature[], states: Readonly<Record<string, { state?: string } | undefined>>, cut: ExtrudeFeature): string {
  if (!cut.thread) return '';
  const by = features.find((g) => g.type === 'thread' && g.hole === cut.id && !g.suppressed && states[g.id]?.state === 'ok');
  return `${cut.thread.designation} thread, ${threadDepthWords(cut.extent)}${by ? `, cut into the wall (${by.name})` : ' (cosmetic: drawn and listed, not modelled)'}`;
}
