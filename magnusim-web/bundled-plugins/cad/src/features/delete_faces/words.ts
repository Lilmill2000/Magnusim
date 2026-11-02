// The Delete faces panel's Add by size (the Analysis Situs plan §3.3), in words and numbers, pure:
// the default sizes from the body's box diagonal, what Add can use when no body is picked yet, and
// the result line ("Added 12 faces: 3 fillet chains, R1.5 to R2", "Added 8 faces: 4 holes up to Ø6 mm
// (2 through)", "No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 6 fillet
// faces, R3 to R5)"). Lengths come in mm and are written in the Part's units (4 significant digits,
// as plan.ts's radius words; mm unwritten after R and Ø in a range, as Find's type cell).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeaturesSummary } from '../../kernel/recognition';
import type { DocUnits } from '../../types/units';
import { toDisplay } from '../../ui/kit/format';

/** Which Add row. */
export type SizeKind = 'fillets' | 'holes';

/** The hint under the panel's fields. */
export const DELETE_FACES_HINT = 'The faces around each deleted face grow to close the gap (holes, fillets, bosses). Fillets up to and Holes up to add faces by size.';

/** Why Add cannot run with no face picked yet and not exactly one solid body in the Part. */
export const CLICK_A_FACE_FIRST = 'Click a face of the body first';

/** The largest 1, 2 or 5 x 10^k not above `x` (2 for 3.4, 5 for 8.5, 0.05 for 0.07); null when x is not above 0. */
export function nice(x: number): number | null {
  if (!(x > 0) || !Number.isFinite(x)) return null;
  const k = Math.floor(Math.log10(x));
  // From the decade above (log10 may round 1000 down to 2.999...), largest first.
  for (const e of [k + 1, k, k - 1])
    for (const m of [5, 2, 1]) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v <= x * (1 + 1e-12)) return v;
    }
  return null;
}

/**
 * The sizes Add starts with, from the body's box diagonal (mm), in the Part's display unit: fillets
 * nice(d / 50), holes nice(d / 20) (a 170 mm diagonal: 2 mm and 5 mm). Null with no box.
 */
export function defaultSizes(diagonalMm: number, units: DocUnits): { fillets: number; holes: number } | null {
  const d = toDisplay(diagonalMm, 'length', units);
  const fillets = nice(d / 50);
  const holes = nice(d / 20);
  return fillets !== null && holes !== null ? { fillets, holes } : null;
}

/**
 * The body Add works on: the field's body, else the Part's one solid body (a body whose solid count
 * is not known yet counts as one: recognition says so in words when it is not). Else why it cannot.
 */
export function addTarget(bodies: readonly { id: string; solids?: number | null }[], body: string): { body: string } | { why: string } {
  if (body) return { body };
  const solids = bodies.filter((b) => b.solids !== 0);
  return solids.length === 1 ? { body: solids[0].id } : { why: CLICK_A_FACE_FIRST };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const num = (mm: number, units: DocUnits) => +toDisplay(mm, 'length', units).toPrecision(4);
const unitAfter = (units: DocUnits) => (units.length === 'mm' ? '' : ` ${units.length}`);

/** "2 mm", "0.0787 in": a size as the line writes it. */
export function sizeWords(mm: number, units: DocUnits): string {
  return `${num(mm, units)} ${units.length}`;
}

/** "R2", "R1.5 to R2"; "Ø8 to Ø12" ("... in" after the range on a Part in inches). */
export function rangeWords(prefix: 'R' | 'Ø', lo: number, hi: number, units: DocUnits): string {
  const a = num(lo, units);
  const b = num(hi, units);
  return `${a === b ? `${prefix}${a}` : `${prefix}${a} to ${prefix}${b}`}${unitAfter(units)}`;
}

/** What Add added, for its line. */
export type Added =
  | { kind: 'fillets'; faces: number; chains: number; r_min: number; r_max: number }
  | { kind: 'holes'; faces: number; holes: number; through: number; size: number };

/** "Added 12 faces: 3 fillet chains, R1.5 to R2"; "Added 8 faces: 4 holes up to Ø6 mm (2 through)" (through holes are counted out loud). */
export function addedWords(a: Added, units: DocUnits): string {
  const head = `Added ${a.faces} ${plural(a.faces, 'face', 'faces')}`;
  if (a.kind === 'fillets') return `${head}: ${a.chains} fillet ${plural(a.chains, 'chain', 'chains')}, ${rangeWords('R', a.r_min, a.r_max, units)}`;
  return `${head}: ${a.holes} ${plural(a.holes, 'hole', 'holes')} up to Ø${sizeWords(a.size, units)}${a.through ? ` (${a.through} through)` : ''}`;
}

/**
 * What the body has (recognition's summary), in the Part's units, for Delete faces' Add line and
 * Find's no-match line alike: "Body 1 has 6 fillet faces, R3 to R5", "Body 1 has 4 drilled holes,
 * Ø8 to Ø12", "Body 1 has no drilled holes". Holes recognised with no cylinder (no bore to size: a
 * B-spline bore, a closed round void) are not drilled holes: "..., and 3 round hollows with no
 * cylinder, which no size matches".
 */
export function hasWords(body: string, kind: SizeKind, s: FeaturesSummary, units: DocUnits): string {
  if (kind === 'fillets') {
    const f = s.fillets;
    if (!f.faces || f.r_min === null || f.r_max === null) return `${body} has no fillets`;
    return `${body} has ${f.faces} fillet ${plural(f.faces, 'face', 'faces')}, ${rangeWords('R', f.r_min, f.r_max, units)}`;
  }
  const h = s.holes;
  const u = h.unsized;
  const hollows = `${u} round ${plural(u, 'hollow', 'hollows')} with no cylinder, which no size matches`;
  if (!h.count) return u ? `${body} has no drilled holes, only ${hollows}` : `${body} has no drilled holes`;
  const sizes = h.d_min !== null && h.d_max !== null ? `, ${rangeWords('Ø', h.d_min, h.d_max, units)}` : '';
  return `${body} has ${h.count} drilled ${plural(h.count, 'hole', 'holes')}${sizes}${u ? `, and ${hollows}` : ''}`;
}

/** Add found nothing new: "No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 6 fillet faces, R3 to R5)". */
export function noneWords(kind: SizeKind, size: number, body: string, s: FeaturesSummary, units: DocUnits): string {
  const what = kind === 'fillets' ? `fillets up to ${sizeWords(size, units)}` : `holes up to Ø${sizeWords(size, units)}`;
  return `No ${what} on ${body} that are not already picked (${hasWords(body, kind, s, units)})`;
}
