// Units: expression evaluation against the document's parameters, conversion
// and formatting (mm / deg internally, the document's display units outside).
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Param } from '../types/doc';
import type { DocUnits, EvalResult, Quantity, UnitsService } from '../types/units';
import { DEG_PER, MM_PER, evaluateExpr } from './expr';
import { scopeFor } from './params';

export { DEG_PER, MM_PER };

/** Core SciNumberInput formatting: exponent outside [1e-3, 1e6), else 6 significant digits. */
export function formatSci(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(4);
  return String(Number(v.toPrecision(6)));
}

const NO_PARAMS: readonly Param[] = Object.freeze([]);

/**
 * The document's units service. `getParams` gives the parameters expressions
 * may use (the current document's); without it only plain values evaluate.
 */
export function createUnitsService(getUnits: () => DocUnits, getParams: () => readonly Param[] = () => NO_PARAMS): UnitsService {
  function unitLabel(q: Quantity): string {
    if (q === 'length') return getUnits().length;
    if (q === 'angle') return getUnits().angle === 'deg' ? '°' : 'rad';
    return '';
  }
  return {
    units: getUnits,
    unitLabel,
    evaluate(text: string, quantity: Quantity): EvalResult {
      return evaluateExpr(text, quantity, scopeFor(getParams(), getUnits()));
    },
    format(value: number, quantity: Quantity, opts: { unit?: boolean; digits?: number } = {}): string {
      let v = value;
      if (quantity === 'length') v = value / MM_PER[getUnits().length];
      if (quantity === 'angle') v = value / DEG_PER[getUnits().angle];
      const text = opts.digits != null ? String(Number(v.toFixed(opts.digits))) : formatSci(v);
      const label = unitLabel(quantity);
      if (opts.unit === false || !label) return text;
      return label === '°' ? `${text}°` : `${text} ${label}`;
    },
  };
}
