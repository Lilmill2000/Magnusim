// Number and unit formatting for the CAD fields: the host kit's formatSci
// (@magnusim/plugin-ui), display-unit conversion, and how a typed value
// is stored as an expression. Evaluation itself belongs to the document's
// UnitsService; this file only formats and recognises plain literals.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { formatSci } from '@magnusim/plugin-ui';
import type { AngleUnit, DocUnits, Expr, LengthUnit, Quantity } from '../../types/units';

/** The kit's formatSci (the core SciNumberInput's): tiny and huge magnitudes as 1.5290e-5, others with 6 significant digits. */
export { formatSci };

/** Below this magnitude a readout uses the scientific style, as formatSci does. */
const SMALL = 1e-3;

/** Millimetres per length unit, degrees per angle unit (internal units are mm and degrees). */
export const MM_PER: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const DEG_PER: Record<AngleUnit, number> = { deg: 1, rad: 180 / Math.PI };

/** An internal value (mm, degrees, plain) in the document's display unit. */
export function toDisplay(value: number, quantity: Quantity, units: DocUnits): number {
  if (quantity === 'length') return value / MM_PER[units.length];
  if (quantity === 'angle') return value / DEG_PER[units.angle];
  return value;
}

/** The display unit as shown after a value: "mm", "in", "°", "rad", or "" for scalars. */
export function unitText(quantity: Quantity, units: DocUnits): string {
  if (quantity === 'length') return units.length;
  if (quantity === 'angle') return units.angle === 'deg' ? '°' : 'rad';
  return '';
}

/** "20 mm", "15°", "0.5 rad", "3", "1,000,000 mm" (as readouts are: formatReadout). */
export function formatQuantity(value: number, quantity: Quantity, units: DocUnits): string {
  const text = formatReadout(toDisplay(value, quantity, units));
  const unit = unitText(quantity, units);
  if (!unit) return text;
  return unit === '°' ? `${text}°` : `${text} ${unit}`;
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** "1.30484 × 10⁸": 6 significant figures, the power in superscript. */
function timesTen(value: number): string {
  const exp = Math.floor(Math.log10(Math.abs(value)));
  let m = Number((value / 10 ** exp).toPrecision(6));
  let e = exp;
  // Rounding can reach 10 (9.999999 -> 10).
  if (Math.abs(m) >= 10) {
    m = Number((m / 10).toPrecision(6));
    e += 1;
  }
  const power = String(e)
    .split('')
    .map((c) => (c === '-' ? '⁻' : SUPERSCRIPT[Number(c)]))
    .join('');
  return `${m} × 10${power}`;
}

/**
 * A readout number (not an input): 6 significant digits, digit groups from
 * 10,000 up ("8000", "6994.69", "26,000", "400,000,000"); tiny values in the
 * input's scientific style ("1.2000e-5"). A value of 7 digits or more that 6
 * significant digits do not hold reads as significant figures ("1.30484 × 10⁸"):
 * "130,484,000" would show rounded digits as if exact (UX review).
 */
export function formatReadout(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  if (Math.abs(value) < SMALL) return value.toExponential(4);
  const n = Number(value.toPrecision(6));
  if (Math.abs(n) < 10_000) return String(n);
  if (Math.abs(n) >= 1_000_000 && Math.abs(n - value) > 1e-9 * Math.abs(value)) return timesTen(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: 20 });
}

/** mm³ per cubic metre. */
const MM3_PER_M3 = 1e9;

/**
 * A volume in mm³ in the document's length unit cubed ("6994.69 mm³",
 * "26,000 mm³", "0.366 in³"); a metric part of a cubic metre or more in m³
 * ("2.5 m³").
 */
export function formatVolume(mm3: number, units: DocUnits): string {
  const metric = units.length === 'mm' || units.length === 'cm' || units.length === 'm';
  // Compared as shown (6 significant digits): a 1000 mm cube measures 999999999.9999 mm³.
  if (metric && Math.abs(Number(mm3.toPrecision(6))) >= MM3_PER_M3) return `${formatReadout(mm3 / MM3_PER_M3)} m³`;
  const f = MM_PER[units.length];
  return `${formatReadout(mm3 / (f * f * f))} ${units.length}³`;
}

/**
 * What a field shows for a value while it is not being edited: as a readout
 * ("20", "62.3156", "1,000,000"), with digit groups also above a million (a
 * field's text is what the user typed, rounded; review round 2: the field said
 * "1.0000e+6"). While the field has focus it shows every digit instead
 * (editTextOf), so editing never drops digits.
 */
export function formatField(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  if (Math.abs(value) < SMALL) return value.toExponential(4);
  const n = Number(value.toPrecision(6));
  if (Math.abs(n) < 10_000) return String(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: 20 });
}

/** An internal value in the display unit with all its digits (15 significant: no float noise such as 0.30000000000000004). */
export function fullPrecision(value: number): string {
  if (!Number.isFinite(value)) return '';
  const n = Number(value.toPrecision(15));
  return String(Object.is(n, -0) ? 0 : n);
}

/** Decimals a derived length keeps in each display unit: about 0.1 µm, below the kernel's own noise. */
const DERIVED_DECIMALS: Record<LengthUnit, number> = { mm: 4, cm: 5, m: 7, in: 6, ft: 7 };

/**
 * A length the app works out (an Enclosure side's padding from Percent: 10 % of
 * 304.8 mm is 30.480000000000004 in floating point, and an exact bounding box of
 * a curved part carries the kernel's 1e-5 mm), as the expression a field shows:
 * rounded to the display tolerance, then every digit that is left ("30.48 mm",
 * "81.28 mm"), never float noise (UX review U2).
 */
export function derivedLength(mm: number, units: DocUnits): Expr {
  if (!Number.isFinite(mm)) return `0 ${units.length}`;
  const v = Number(toDisplay(mm, 'length', units).toFixed(DERIVED_DECIMALS[units.length] ?? 6));
  return `${fullPrecision(v)} ${units.length}`;
}

/**
 * Commas in a number ("1,500", "1,5", "12,345.6 mm") are refused, as the core's
 * number fields refuse them (SciNumberInput parses with Number(): no locale
 * digit groups, the dot is the decimal point). "1,500" could mean 1500 or 1.5,
 * so it is never guessed. A comma inside a function's brackets separates its
 * arguments ("max(a, 10 mm)") and is fine.
 */
export function commaProblem(text: string): string | null {
  let depth = 0;
  let outside = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) outside += ch;
  }
  return outside.includes(',') ? 'No commas in numbers: write 1500, or 1.5 for a decimal' : null;
}

const LITERAL = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z°]*)\s*$/i;
const LENGTH_UNITS = new Set<string>(Object.keys(MM_PER));
const ANGLE_UNITS = new Set<string>(['deg', 'rad', '°']);

/** The digits of a plain number as written ("12.3456789 mm" -> "12.3456789"), or null. */
export function literalDigits(text: string): string | null {
  const m = LITERAL.exec(text);
  return m ? m[1] : null;
}

/** A plain number with an optional unit of `quantity` ("20", "20 mm", "1.5e-3 in", "15°"), or null. */
export function parseLiteral(text: string, quantity: Quantity): { n: number; unit: string } | null {
  const m = LITERAL.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (!unit) return { n, unit };
  if (quantity === 'length' && LENGTH_UNITS.has(unit)) return { n, unit };
  if (quantity === 'angle' && ANGLE_UNITS.has(unit)) return { n, unit };
  return null;
}

/** The unit a bare number is stored with, so it keeps its meaning if the document's unit changes. */
export function storeUnit(quantity: Quantity, units: DocUnits): string {
  if (quantity === 'length') return units.length;
  if (quantity === 'angle') return units.angle;
  return '';
}

/**
 * What to store for what the user typed: a bare number gets the display unit
 * ("20" in an inch document is stored as "20 in"; the typed digits are kept,
 * like the core's SciNumberInput keeps full precision); anything else is
 * stored as typed (trimmed), because it is an expression the document evaluates.
 */
export function exprToStore(text: string, quantity: Quantity, units: DocUnits): Expr {
  const t = text.trim();
  const lit = parseLiteral(t, quantity);
  if (lit && !lit.unit) {
    const u = storeUnit(quantity, units);
    return u ? `${t} ${u}` : t;
  }
  return t;
}
