// NumberUnitInput (H14 kit name): the core SciNumberInput (src/forms/
// SciNumberInput.tsx) for expression fields.
// - Commits only on blur or Enter; Escape reverts; leaving the field untouched
//   never re-saves the rounded text (SciNumberInput.tsx:61-75, 95-104).
// - A plain value ("25.4 mm") shows as a number in the document's display unit,
//   formatted as readouts are (formatField: "20", "1,000,000"; tiny values in
//   the core's scientific style), with the unit label after it. An expression
//   ("width / 2") shows as typed, with its value after it ("= 12.5 mm").
// - While the field has focus it shows every stored digit ("12.3456789", not
//   "12.3457"; "1000000", not "1,000,000"), so an edit never drops digits the
//   user cannot see (review round 3).
// - Commas in a number are refused with a reason, as the core's number fields
//   refuse them ("1,500" could be 1500 or 1.5; commaProblem).
// - A bare number is stored with the display unit ("20" -> "20 mm"); anything
//   else is stored as typed and evaluated by the document (UnitsService).
// - An invalid entry keeps its text, shows why inline and is not applied.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { Expr, Quantity, UnitsService } from '../../types/units';
import { commaProblem, exprToStore, formatField, formatQuantity, fullPrecision, literalDigits, parseLiteral, storeUnit, toDisplay, unitText } from './format';

export interface NumberUnitInputProps {
  /** The stored expression ("20 mm", "width / 2"). */
  expr: Expr;
  quantity: Quantity;
  /** The document's units service (evaluate + display units). */
  units: UnitsService;
  /**
   * Called on Enter/blur with a changed, valid entry: what to store and its
   * value (mm / deg / plain). Return a reason to refuse it (the document said
   * no): the text stays and the reason shows inline.
   */
  onCommit(expr: Expr, value: number): void | string | null;
  /** Extra rule on the evaluated value ("Must be more than 0") and the parameters it reads, or null when fine. */
  validate?(value: number, uses: string[]): string | null;
  /** Accessible name ("Length (X)"). */
  label: string;
  id?: string;
  disabled?: boolean;
  /** Show the expression text as typed even for plain values (parameter table). */
  raw?: boolean;
  /** Show the unit / value after the input (default true). */
  showUnit?: boolean;
  className?: string;
  /** For tests and e2e: data-field on the wrapper. */
  field?: string;
}

interface Shown {
  text: string;
  literal: boolean;
  value: number | null;
  error: string | null;
}

/** What the field shows for a stored expression. Exported for tests. */
export function displayOf(expr: Expr, quantity: Quantity, units: UnitsService, raw = false): Shown {
  const t = (expr ?? '').trim();
  if (!t) return { text: '', literal: true, value: null, error: null };
  const r = units.evaluate(t, quantity);
  const lit = raw ? null : parseLiteral(t, quantity);
  if (lit && r.ok) return { text: formatField(toDisplay(r.value, quantity, units.units())), literal: true, value: r.value, error: null };
  return { text: t, literal: false, value: r.ok ? r.value : null, error: r.ok ? null : r.error };
}

/**
 * What the field shows while it has focus: every digit of the stored value.
 * A number stored in the display unit (or with none) shows its digits exactly
 * as written; one in another unit shows the converted value to 15 significant
 * digits; an expression shows as typed. Exported for tests.
 */
export function editTextOf(expr: Expr, quantity: Quantity, units: UnitsService, raw = false): string {
  const t = (expr ?? '').trim();
  if (!t || raw) return t;
  const lit = parseLiteral(t, quantity);
  if (!lit) return t;
  const docUnits = units.units();
  const unit = lit.unit === '°' ? 'deg' : lit.unit;
  if (!unit || unit === storeUnit(quantity, docUnits)) return literalDigits(t) ?? t;
  const r = units.evaluate(t, quantity);
  return r.ok ? fullPrecision(toDisplay(r.value, quantity, docUnits)) : t;
}

export function NumberUnitInput({ expr, quantity, units, onCommit, validate, label, id, disabled, raw = false, showUnit = true, className, field }: NumberUnitInputProps) {
  const docUnits = units.units();
  const unitKey = `${docUnits.length}|${docUnits.angle}`;
  const shown = displayOf(expr, quantity, units, raw);
  const [text, setText] = useState(shown.text);
  const [error, setError] = useState<string | null>(null);
  /** The user typed since the field last showed the stored value. */
  const editing = useRef(false);
  /** The field has focus (it shows every digit then). */
  const focused = useRef(false);
  const lastShown = useRef(shown.text);
  lastShown.current = shown.text;
  /** What the field showed when focus came (every digit): typing nothing new is "untouched". */
  const base = useRef(shown.text);
  const shownFor = (e: Expr) => (focused.current ? editTextOf(e, quantity, units, raw) : displayOf(e, quantity, units, raw).text);

  // Re-format only when the stored expression (or the display unit) really
  // changes upstream, and never while the user is typing in the field.
  useEffect(() => {
    if (!editing.current) {
      const next = shownFor(expr);
      if (focused.current) base.current = next;
      setText(next);
      setError(null);
    }
  }, [expr, quantity, unitKey, raw]);

  function commit() {
    editing.current = false;
    const typed = text.trim();
    // Untouched: never store the shown text over the stored expression.
    if (typed === base.current.trim() || typed === lastShown.current) {
      setText(shownFor(expr));
      setError(null);
      return;
    }
    if (!typed) {
      setError('Enter a value');
      return;
    }
    const comma = commaProblem(typed);
    if (comma) {
      setError(comma);
      return;
    }
    const plain = typed;
    const r = units.evaluate(plain, quantity);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const why = validate?.(r.value, r.uses) ?? null;
    if (why) {
      setError(why);
      return;
    }
    const next = exprToStore(plain, quantity, docUnits);
    if (next === (expr ?? '').trim()) {
      setError(null);
      setText(shownFor(expr));
      return;
    }
    const refused = onCommit(next, r.value);
    if (refused) {
      setError(refused);
      return;
    }
    setError(null);
    const now = shownFor(next);
    if (focused.current) base.current = now;
    setText(now);
  }

  const storedError = !error && !editing.current ? shown.error : null;
  const shownError = error ?? storedError;
  let after: string | null = null;
  // A stored expression that does not evaluate ("w", an unknown parameter) keeps the
  // unit after it, so the field stays in line with the others and says what it
  // takes (P1.5 review round 1: it lost "mm" and moved right).
  const unitAfter = shown.literal || !!error || shown.value == null;
  if (showUnit) {
    if (unitAfter) after = unitText(quantity, docUnits) || null;
    else after = `= ${formatQuantity(shown.value as number, quantity, docUnits)}`;
  }

  return (
    <span className={['nui', shownError ? 'is-invalid' : '', className || ''].filter(Boolean).join(' ')} data-field={field}>
      <span className="bc-value-row">
        <input
          id={id}
          className="bc-input"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          aria-invalid={shownError ? true : undefined}
          disabled={disabled}
          value={text}
          onFocus={(e) => {
            focused.current = true;
            // Every digit while editing (the readout rounds to 6 significant digits): an edit keeps them.
            if (!editing.current && !error) {
              const full = editTextOf(expr, quantity, units, raw);
              base.current = full;
              const el = e.currentTarget;
              if (el.value !== full) {
                // Now, not at React's next render, and all of it selected: the text changed
                // under the caret, so typing right away replaces the value, as after Tab
                // (a click then puts the caret where it lands).
                el.value = full;
                el.select();
              }
              setText(full);
            } else base.current = lastShown.current;
          }}
          onChange={(e) => {
            editing.current = true;
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              // Something typed: revert it and keep focus (SciNumberInput.tsx:100-103).
              // Nothing to revert: let the Escape through, so it closes the panel
              // as it does anywhere else in the panel (review round 1).
              const typed = (text !== base.current && text !== lastShown.current) || !!error;
              editing.current = false;
              if (!typed) return;
              e.preventDefault();
              e.stopPropagation();
              setText(focused.current ? base.current : lastShown.current);
              setError(null);
            }
          }}
        />
        {after ? (
          <span className={unitAfter ? 'bc-unit-label' : 'nui-eq'} data-nui-after="1">
            {after}
          </span>
        ) : null}
      </span>
      {shownError ? (
        <span className="nui-error" role="alert" data-nui-error="1">
          {shownError}
        </span>
      ) : null}
    </span>
  );
}
