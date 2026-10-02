export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string) => void;
  /** The select's aria-label. */
  label: string;
  id?: string;
  disabled?: boolean;
  /** 'fill': 100% up to 220 px, a schema form's width. Default 'auto'. */
  width?: 'auto' | 'fill';
}

/** The core's panel select (.bc-select, the BC and Materials panels). */
export function Select({ value, options, onChange, label, id, disabled, width = 'auto' }: SelectProps) {
  return (
    <select
      id={id}
      className={width === 'fill' ? 'mgk-select mgk-select--fill' : 'mgk-select'}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} className="mgk-option" value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
