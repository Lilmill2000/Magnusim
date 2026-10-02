import type { ReactNode } from 'react';
import { Button } from '../Button';

export interface PanelChromeProps {
  title: string;
  children: ReactNode;
  /**
   * What Done does. Required, so Done is never a dead button: `host.pluginUi.panelDone`
   * in the app, `() => ws.nav.back()` in a workspace frame.
   */
  onDone: () => void;
  /** Shows a Delete link at the left of the foot. */
  onDelete?: () => void;
  /** Default 'Delete'. */
  deleteLabel?: string;
  /** More controls at the left of the foot, after Delete. */
  footExtra?: ReactNode;
  /** Draw the card (in a frame; in the app's flyout the host draws it). */
  card?: boolean;
}

/** A panel as the core draws one: title, body, and a foot with Delete and Done. No header actions. */
export function PanelChrome({ title, children, onDone, onDelete, deleteLabel = 'Delete', footExtra, card }: PanelChromeProps) {
  return (
    <div className={card ? 'mgk-type mgk-panel mgk-panel--card' : 'mgk-type mgk-panel'}>
      <div className="mgk-panel-head">
        <span className="mgk-panel-title">{title}</span>
      </div>
      <div className="mgk-panel-body">{children}</div>
      <div className="mgk-panel-foot">
        <div className="mgk-panel-foot-left">
          {onDelete ? (
            <Button variant="link" onClick={() => onDelete()}>
              {deleteLabel}
            </Button>
          ) : null}
          {footExtra}
        </div>
        <Button variant="neutral" className="mgk-panel-done" onClick={() => onDone()}>
          Done
        </Button>
      </div>
    </div>
  );
}
