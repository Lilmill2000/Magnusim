export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The control's aria-label. */
  label: string;
  /** 'switch' (default) or the ON/OFF 'pill' of schema forms. */
  variant?: 'switch' | 'pill';
  disabled?: boolean;
  id?: string;
}

/**
 * The core's switch (.switch) or its ON/OFF pill (.mesh-toggle). The switch is
 * a real checkbox, so the browser's own Space handling applies.
 */
export function Toggle({ checked, onChange, label, variant = 'switch', disabled, id }: ToggleProps) {
  if (variant === 'pill') {
    return (
      <button
        id={id}
        type="button"
        className={checked ? 'mgk-pill mgk-pill--on' : 'mgk-pill'}
        aria-pressed={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        {checked ? 'ON' : 'OFF'}
      </button>
    );
  }
  return (
    <label className="mgk-type mgk-switch">
      <input
        id={id}
        className="mgk-switch-input"
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (!disabled) onChange(e.target.checked);
        }}
      />
      <span className="mgk-switch-track" />
    </label>
  );
}
