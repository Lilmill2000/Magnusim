import { useEffect, useRef, useState } from 'react';

const SMALL = 1e-3;
const LARGE = 1e6;

/** Tiny and huge magnitudes read as zero in a plain input, so show them as 1.5290e-5. */
export function formatSci(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude < SMALL || magnitude >= LARGE) return value.toExponential(4);
  return String(value);
}

export function parseSci(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface SciNumberInputProps {
  value: number | null | undefined;
  /** Blur and Enter. The value is always finite. */
  onCommit: (value: number) => void;
  /** Every keystroke that parses. Omit when an intermediate value must not be saved. */
  onLive?: (value: number) => void;
  label?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
}

/**
 * Text input that shows scientific notation for tiny/huge values and accepts
 * either notation back. Commits on blur and Enter so typing "1.5e-" never
 * round-trips through NaN.
 */
export function SciNumberInput({
  value,
  onCommit,
  onLive,
  label,
  className,
  id,
  disabled,
}: SciNumberInputProps) {
  const [text, setText] = useState(() => formatSci(value));
  const [editing, setEditing] = useState(false);
  // Re-format only when the value genuinely changes upstream, so a committed
  // edit is not snapped back while the save is still in flight.
  const lastValue = useRef(value);

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    if (!editing) setText(formatSci(value));
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const next = parseSci(text);
    if (next == null) {
      setText(formatSci(lastValue.current));
      return;
    }
    setText(formatSci(next));
    if (next !== lastValue.current) onCommit(next);
  }

  return (
    <input
      id={id}
      className={className || 'bc-input'}
      type="text"
      inputMode="decimal"
      spellCheck={false}
      aria-label={label}
      disabled={disabled}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        setEditing(true);
        setText(e.target.value);
        if (!onLive) return;
        const next = parseSci(e.target.value);
        if (next != null) onLive(next);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setEditing(false);
          setText(formatSci(value));
        }
      }}
    />
  );
}
