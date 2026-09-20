import type { ReactNode } from 'react';
import { dispatchPanelDone } from '../islands';

export function PanelChrome({
  title,
  children,
  onDelete,
  deleteLabel = 'Delete',
}: {
  title: string;
  children: ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  return (
    <>
      <div className="mat-panel-head sim-def-head">
        <span className="mat-panel-title sim-def-title">{title}</span>
      </div>
      <div className="mat-panel-body sim-def-body">{children}</div>
      <div className="mat-panel-foot">
        <div className="mesh-foot-left">
          {onDelete ? (
            <button type="button" className="mat-clear-link" onClick={onDelete}>
              {deleteLabel}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="js-btn tree-panel-done"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('cfd:panel-done'));
            dispatchPanelDone();
          }}
        >
          Done
        </button>
      </div>
    </>
  );
}
