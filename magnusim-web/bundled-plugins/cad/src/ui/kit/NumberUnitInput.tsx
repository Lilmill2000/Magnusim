// NumberUnitInput: the core SciNumberInput (src/forms/SciNumberInput.tsx) for
// expression fields, drawn with the host kit's value row (mgk-value-row,
// mgk-input, mgk-unit from /plugin-sdk/plugin-ui.css).
// Why not the kit's NumberUnitInput: it takes a number in SI and gives one
// back, while a CAD field holds an expression ("width / 2", "20 mm + 1 in")
// evaluated against the part's parameters in the document's units, shows its
// value after it ("= 12.5 mm") and why it is refused under it, and hands
// Ctrl+Z to the app's Undo; none of that fits the kit's props.
// - Commits only on blur or Enter; Escape reverts; leaving the field untouched
//   never re-saves the rounded text (SciNumberInput.tsx:61-75, 95-104).
// - A plain value ("25.4 mm") shows as a number in the document's display unit,
//   formatted as readouts are (formatField: "20", "1,000,000"; tiny values in
//   the core's scientific style), with the unit label after it. An expression
//   ("width / 2") shows as typed, with its value after it ("= 12.5 mm").
// - While the field has focus it shows every stored digit ("12.3456789", not
//   "12.3457"; "1000000", not "1,000,000"), so an edit never drops digits the
//   user cannot see (review round 3).
// - Typed text that is not applied yet is unsaved work (lib/pendingEdits.ts):
//   the page is dirty while a field holds it, so the app asks before leaving
//   (SD review round 2: Back to project lost it without a word). The pointer
//   leaving the frame applies a whole value the user stopped typing, while the field
//   still has the keyboard (commitQuiet); the frame losing focus applies nothing,
//   then or at a later pointer leave (the text waits, as the app's question says).
// - Commas in a number are refused with a reason, as the core's number fields
//   refuse them ("1,500" could be 1500 or 1.5; commaProblem).
// - A bare number is stored with the display unit ("20" -> "20 mm"); anything
//   else is stored as typed and evaluated by the document (UnitsService).
// - An invalid entry keeps its text, shows why inline and is not applied.
// - Ctrl+Z first drops what was typed and not applied (as Escape does); with
//   nothing typed it is the app's Undo (the input carries data-undo-to-app, so
//   the keyboard hands Ctrl+Z / Ctrl+Y on), never the browser's own text undo,
//   which showed an old value the model did not have (review P2/P3 round 3).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pendingEditsChanged, registerPendingEdit } from '../../lib/pendingEdits';
import type { Expr, Quantity, UnitsService } from '../../types/units';
import { commaProblem, exprToStore, formatField, formatQuantity, fullPrecision, literalDigits, parseLiteral, storeUnit, toDisplay, unitText } from './format';

/** Typing this recently (ms) keeps the pointer leaving the frame from applying the text. */
export const QUIET_MS = 800;

/**
 * When the page last saw a press (ms). A field that loses focus applies its text
 * only when the focus went somewhere in this page: to another of its controls
 * (the blur's relatedTarget), or to a press in it (a click on the view or a panel's
 * background focuses nothing). The frame losing focus (the app's header or dialog,
 * another window) is neither, and applies nothing: document.hasFocus() is not
 * reliable for that in a real browser, where the frame runs in its own process and
 * still reports focus during the blur (LINK polish: Stay found the text applied).
 */
let pressedAt = 0;
let pressedOn: EventTarget | null = null;
if (typeof document !== 'undefined') {
  const pressed = (e: Event) => {
    pressedAt = Date.now();
    pressedOn = e.target;
  };
  document.addEventListener('pointerdown', pressed, true);
  document.addEventListener('mousedown', pressed, true);
  document.addEventListener('touchstart', pressed, true);
}
const PRESS_MS = 1000;

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
  /**
   * A unit of the field's own for a plain number ("%"), drawn where a length's unit is, in the
   * input's row (so it stays on the input's line under an error). Replaces the quantity's unit.
   */
  unit?: ReactNode;
  className?: string;
  /** For tests and e2e: data-field on the wrapper. */
  field?: string;
  /**
   * Why the document cannot use the stored value now (an Enclosure side the part shrank under):
   * shown under the field, as a refusal is, while nothing is typed.
   */
  problem?: string | null;
  /**
   * Something drawn in the input's row before the input ("Use padding"): it stays beside the
   * input whatever the reason under the field (UX review: the link moved left in error rows).
   */
  lead?: ReactNode;
  /** The reason the field shows for typed text it refused (null when none): the panel can leave out what it would say twice. */
  onRefusal?(why: string | null): void;
}

interface Shown {
  text: string;
  literal: boolean;
  value: number | null;
  error: string | null;
}

/**
 * A reason that ends in a bracketed bound ("... past the part (x ≥ 40 mm)") keeps
 * the bracket on one line: it wrapped as "(x" / "≥ 40 mm)" (SD final review). The
 * text is unchanged; only where the line may break. Exported for tests.
 */
export function keepBoundTogether(text: string): ReactNode {
  const m = /^([\s\S]*?\s)(\([^()]*\))$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]}
      <span className="nui-keep">{m[2]}</span>
    </>
  );
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

export function NumberUnitInput({ expr, quantity, units, onCommit, validate, label, id, disabled, raw = false, showUnit = true, unit, className, field, problem = null, lead, onRefusal }: NumberUnitInputProps) {
  const docUnits = units.units();
  const unitKey = `${docUnits.length}|${docUnits.angle}`;
  const shown = displayOf(expr, quantity, units, raw);
  const [text, setTextState] = useState(shown.text);
  const [error, setErrorState] = useState<string | null>(null);
  // The same as refs: commitPendingEdits() reads and applies them outside React's render.
  const textRef = useRef(text);
  const errorRef = useRef(error);
  const setText = (t: string) => {
    textRef.current = t;
    setTextState(t);
  };
  const setError = (e: string | null) => {
    errorRef.current = e;
    setErrorState(e);
  };
  /** The user typed since the field last showed the stored value. */
  const editing = useRef(false);
  /** The field has focus (it shows every digit then). */
  const focused = useRef(false);
  /** When the user last typed in it (ms): the pointer leaving the frame right after typing applies nothing. */
  const typedAt = useRef(0);
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
    const typed = textRef.current.trim();
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

  /**
   * The pointer left the frame: apply the typed text only when it is a whole
   * value the field takes ("-", "1e", "2." and anything refused stay as typed,
   * with no reason shown), nothing was typed in the last QUIET_MS, and the field
   * still has the keyboard. A field that lost it (the frame lost focus: the app's
   * header, its leave question, another window) keeps its text: the app asks before
   * leaving, and its "Leaving discards them" stays true (CI: the browser's Back
   * opened the question, its overlay came over the frame under a pointer that never
   * moved, and the mouseleave that sent applied and saved the text behind it).
   */
  function commitQuiet() {
    if (!editing.current || errorRef.current || !focused.current) return;
    if (Date.now() - typedAt.current < QUIET_MS) return;
    const typed = textRef.current.trim();
    if (!typed || /[-+*/^(.eE,]$/.test(typed) || commaProblem(typed)) return;
    const r = units.evaluate(typed, quantity);
    if (!r.ok || validate?.(r.value, r.uses)) return;
    commit();
  }

  /** Something typed and not applied (or refused): Escape and Ctrl+Z take it back first. */
  const isPending = () => (textRef.current !== base.current && textRef.current !== lastShown.current) || !!errorRef.current;
  const pending = isPending();
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const quietRef = useRef(commitQuiet);
  quietRef.current = commitQuiet;
  const pendingRef = useRef(isPending);
  pendingRef.current = isPending;
  const labelRef = useRef(label);
  labelRef.current = label;
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Unsaved work while typed text waits (lib/pendingEdits.ts); it goes with the field.
  useEffect(
    () =>
      registerPendingEdit({
        get label() {
          return labelRef.current;
        },
        pending: () => pendingRef.current(),
        error: () => errorRef.current,
        commit: () => commitRef.current(),
        commitQuiet: () => quietRef.current(),
        focus: () => {
          const el = inputRef.current;
          if (!el || el.disabled || !el.isConnected) return;
          el.focus();
          const n = el.value.length;
          try {
            el.setSelectionRange(n, n);
          } catch {
            /* not a text field */
          }
        },
      }),
    [],
  );
  useEffect(() => {
    pendingEditsChanged();
  });
  const refusalRef = useRef(onRefusal);
  refusalRef.current = onRefusal;
  useEffect(() => {
    refusalRef.current?.(error);
  }, [error]);
  const storedError = !error && !editing.current ? (shown.error ?? problem) : null;
  const shownError = error ?? storedError;
  let after: ReactNode = null;
  // A stored expression that does not evaluate ("w", an unknown parameter) keeps the
  // unit after it, so the field stays in line with the others and says what it
  // takes (P1.5 review round 1: it lost "mm" and moved right).
  const unitAfter = shown.literal || !!error || shown.value == null;
  if (unit != null && (unitAfter || !showUnit)) after = unit;
  else if (showUnit) {
    if (unitAfter) after = unitText(quantity, docUnits) || null;
    else after = `= ${formatQuantity(shown.value as number, quantity, docUnits)}`;
  }

  return (
    <span className={['nui', shownError ? 'is-invalid' : '', className || ''].filter(Boolean).join(' ')} data-field={field}>
      <span className="mgk-type mgk-value-row">
        {lead}
        <input
          ref={inputRef}
          id={id}
          className="mgk-input"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          aria-invalid={shownError ? true : undefined}
          data-undo-to-app={pending ? undefined : '1'}
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
            typedAt.current = Date.now();
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={(e) => {
            focused.current = false;
            // The whole frame lost focus (the app's header or dialog, another window):
            // the text waits in the field, unapplied, and the page stays unsaved, so the
            // app's "Leaving discards them" is true. Focus coming back finds it as typed.
            // A press on the field itself (the click that started the typing) is not one elsewhere.
            const pressedElsewhere = Date.now() - pressedAt < PRESS_MS && pressedOn !== e.currentTarget;
            const inPage = e.relatedTarget != null || pressedElsewhere;
            if (editing.current && !inPage) return;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
              // Nothing typed: the keyboard runs the app's Undo / Redo (data-undo-to-app).
              // Typed and not applied: Ctrl+Z puts the applied value back; no text undo or redo.
              if (!pending) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
                editing.current = false;
                setText(focused.current ? base.current : lastShown.current);
                setError(null);
              }
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
          <span className={unitAfter || (unit != null && after === unit) ? 'mgk-unit' : 'nui-eq'} data-nui-after="1">
            {after}
          </span>
        ) : null}
      </span>
      {shownError ? (
        <span className="nui-error" role="alert" data-nui-error="1">
          {keepBoundTogether(shownError)}
        </span>
      ) : null}
    </span>
  );
}
