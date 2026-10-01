// Units and expressions: the contract between the document (which evaluates)
// and the UI (NumberUnitInput, parameter table), which only formats and asks.
// Owner: DOC-CORE implements UnitsService in src/doc/. UI-SHELL consumes it.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Length units a document can display. Internally every length is mm. */
export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
/** Angle units. Internally every angle is degrees (the kernel API is in degrees too). */
export type AngleUnit = 'deg' | 'rad';

/** What a numeric field or parameter measures. `scalar` has no unit (counts, ratios). */
export type Quantity = 'length' | 'angle' | 'scalar';

/** A document's display units (never rewritten when the app preference changes). */
export interface DocUnits {
  length: LengthUnit;
  angle: AngleUnit;
}

/** Expression text as the user typed it: "20 mm", "width/2 + 3 mm", "15 deg", "3". */
export type Expr = string;

/** The result of evaluating an expression, in internal units (mm, deg, or plain). */
export type EvalResult =
  | { ok: true; value: number; quantity: Quantity; /** names of parameters it read */ uses: string[] }
  | { ok: false; error: string; /** 0-based character offset of the problem, when known */ at?: number };

export interface UnitsService {
  /** The document's display units right now. */
  units(): DocUnits;
  /**
   * Evaluate `text` as a `quantity`. A bare number takes the document's display
   * unit ("20" in an inch document is 508 mm). Parameter names resolve against
   * the document's parameters; cycles and unknown names are errors.
   */
  evaluate(text: Expr, quantity: Quantity): EvalResult;
  /** Format an internal value (mm / deg / plain) in the display unit: "20 mm", "0.75 in". */
  format(value: number, quantity: Quantity, opts?: { unit?: boolean; digits?: number }): string;
  /** Display unit label for a quantity ("mm", "in", "°" or ""). */
  unitLabel(quantity: Quantity): string;
}
