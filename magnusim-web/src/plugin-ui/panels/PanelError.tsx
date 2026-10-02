import { Button, type DataAttrs } from '../Button';

export interface PanelErrorProps {
  message: string;
  /** Default 'This panel stopped working.' */
  title?: string;
  /** Shows Try again. */
  onRetry?: () => void;
  /** Shows the panel foot with Done. */
  onDone?: () => void;
  attrs?: DataAttrs;
}

/** The longest message shown; a longer one is cut and ends in an ellipsis. */
const MAX_MESSAGE = 300;

function shortMessage(message: string): string {
  const text = String(message ?? '');
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** The card a panel shows in place of itself when it fails. */
export function PanelError({ message, title = 'This panel stopped working.', onRetry, onDone, attrs }: PanelErrorProps) {
  return (
    <div className="mgk-type mgk-error" role="alert" {...attrs}>
      <div className="mgk-error-title">{title}</div>
      <div className="mgk-error-msg">{shortMessage(message)}</div>
      {onRetry ? (
        <Button variant="fix" onClick={() => onRetry()}>
          Try again
        </Button>
      ) : null}
      {onDone ? (
        <div className="mgk-panel-foot">
          <div className="mgk-panel-foot-left" />
          <Button variant="neutral" className="mgk-panel-done" onClick={() => onDone()}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}
