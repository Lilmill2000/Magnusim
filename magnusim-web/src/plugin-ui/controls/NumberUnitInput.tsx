import { fieldUnit, fromSi, toSi, type Quantity, type UnitSystem } from '../units';
import { SciNumberInput } from './SciNumberInput';

export interface NumberUnitInputProps {
  /** The input's aria-label. */
  label: string;
  /** The SI value; the plain value when there is no quantity. */
  valueSi: number | null;
  /** Blur and Enter: a finite SI value, only when it changed. */
  onCommitSi: (v: number) => void;
  /** Each keystroke that parses, in SI. */
  onLiveSi?: (v: number) => void;
  /** Omitted: no conversion and no unit label. */
  quantity?: Quantity;
  /** Default 'metric'. */
  units?: UnitSystem;
  /** The unit to show; else fieldUnit(quantity, units). */
  unit?: string;
  id?: string;
  disabled?: boolean;
  /** 72 px, 128 px, or 100% up to 220 px (a schema form's width). Default 'narrow'. */
  width?: 'narrow' | 'wide' | 'fill';
}

/** A number in a unit, stored in SI: the core's value row (BC and Materials panels, schema forms). */
export function NumberUnitInput({
  label,
  valueSi,
  onCommitSi,
  onLiveSi,
  quantity,
  units = 'metric',
  unit,
  id,
  disabled,
  width = 'narrow',
}: NumberUnitInputProps) {
  const shown = unit || (quantity ? fieldUnit(quantity, units) : '');
  const display = quantity && shown && typeof valueSi === 'number' ? fromSi(quantity, valueSi, shown) : valueSi;
  const emit = (n: number) => (quantity && shown ? toSi(quantity, n, shown) : n);
  return (
    <span className="mgk-type mgk-value-row">
      <SciNumberInput
        id={id}
        className={`mgk-input mgk-input--${width}`}
        value={typeof display === 'number' ? display : null}
        label={label}
        disabled={disabled}
        onLive={onLiveSi ? (n) => onLiveSi(emit(n)) : undefined}
        onCommit={(n) => onCommitSi(emit(n))}
      />
      {shown ? <span className="mgk-unit">{shown}</span> : null}
    </span>
  );
}
