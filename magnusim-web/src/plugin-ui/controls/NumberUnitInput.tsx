import { useState } from 'react';
import { fieldUnit, fromSi, toSi, unitLabels, type Quantity, type UnitSystem } from '../units';
import { SciNumberInput } from './SciNumberInput';
import { Select } from './Select';

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
  /**
   * API 1.8: the unit is a picker, not a label. `true` offers every unit of the
   * quantity; a list offers those. The value stays in SI either way: a pick
   * only changes what is shown and typed. Without `unit` the picker keeps its
   * own choice; with `unit`, report picks through `onUnit`.
   */
  unitChoices?: boolean | readonly string[];
  /** API 1.8: the unit picked (with `unitChoices`). */
  onUnit?: (unit: string) => void;
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
  unitChoices,
  onUnit,
}: NumberUnitInputProps) {
  const [picked, setPicked] = useState('');
  const choices = quantity && unitChoices ? (unitChoices === true ? unitLabels(quantity) : [...unitChoices]) : [];
  const fallback = unit || (quantity ? fieldUnit(quantity, units) : '');
  const shown = choices.length && !unit && picked && choices.includes(picked) ? picked : fallback;
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
      {choices.length ? (
        <Select
          label={`${label} unit`}
          value={shown}
          disabled={disabled}
          options={(choices.includes(shown) ? choices : [shown, ...choices]).map((u) => ({ value: u, label: u }))}
          onChange={(u) => {
            setPicked(u);
            onUnit?.(u);
          }}
        />
      ) : shown ? (
        <span className="mgk-unit">{shown}</span>
      ) : null}
    </span>
  );
}
