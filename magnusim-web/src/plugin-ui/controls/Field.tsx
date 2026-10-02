import { useId, type ReactNode } from 'react';

export interface FieldProps {
  label: string;
  /** The id of the control the label is for. */
  htmlFor?: string;
  /** Shown in a tip on hovering the label or focusing its "?". */
  help?: string;
  /** Renders nothing. */
  hidden?: boolean;
  children: ReactNode;
}

/** A settings row: label (and help) on the left, the control on the right, as schema forms draw it. */
export function Field({ label, htmlFor, help, hidden, children }: FieldProps) {
  // Called on every render, before any return, so hooks keep their order.
  const autoId = useId();
  if (hidden) return null;
  const tipId = `${htmlFor || autoId}__help`;
  return (
    <div className="mgk-type mgk-field">
      <span className="mgk-field-k" data-help={help ? '1' : undefined}>
        <label htmlFor={htmlFor}>{label}</label>
        {help ? (
          <>
            <span className="mgk-field-help" tabIndex={0} role="button" aria-label={`About ${label}`} aria-describedby={tipId}>
              ?
            </span>
            <span className="mgk-field-tip" role="tooltip" id={tipId}>
              {help}
            </span>
          </>
        ) : null}
      </span>
      <span className="mgk-field-v">{children}</span>
    </div>
  );
}
