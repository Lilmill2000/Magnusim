// Panel chrome (H14 kit: PanelChrome, Field, Hint, DisabledReason,
// EmptyState, Select) and the Flyout that holds a panel beside the tree
// (.tree-detail > .mat-panel, style.css:459-512, 2899-3081).
// Rules (Daniel's): Done in the foot closes; Delete (a link, foot left) only
// when something can be removed; NO tick or checkmark in the head; valid field
// changes apply live, so Done only closes.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Button } from './Button';
import { RenameTitle, type RenameFn } from './Rename';

export interface PanelChromeProps {
  title: string;
  /** Rename from the head's pencil (null = the title cannot be renamed). */
  onRename?: RenameFn | null;
  /** What the pencil renames ("feature"). */
  renameLabel?: string;
  /** Blur with a refused name: show the reason. */
  onRenameGiveUp?: (reason: string) => void;
  /** 3 px accent bar on the left: slate for feature panels, blue for sketch panels. */
  accent?: 'feature' | 'sketch' | null;
  children: ReactNode;
  onDone(): void;
  /** Why Done cannot close yet ("Enter a height to create Cylinder 1"), or null. */
  doneDisabled?: string | null;
  /** Only when something can be removed. */
  onDelete?: (() => void) | null;
  deleteLabel?: string;
  /** A line above the foot buttons (a refused action, a feature error). */
  foot?: ReactNode;
  className?: string;
  /** data-cad-panel value (tests). */
  panel: string;
}

export function PanelChrome({
  title,
  onRename,
  renameLabel = 'feature',
  onRenameGiveUp,
  accent = null,
  children,
  onDone,
  doneDisabled = null,
  onDelete,
  deleteLabel = 'Delete',
  foot,
  className,
  panel,
}: PanelChromeProps) {
  const cls = ['mat-panel', 'cad-panel', accent ? `is-accent-${accent}` : '', className || ''].filter(Boolean).join(' ');
  return (
    <section className={cls} data-cad-panel={panel} aria-label={title}>
      <div className="mat-panel-head">
        {onRename ? (
          <RenameTitle name={title} label={renameLabel} onRename={onRename} onGiveUp={onRenameGiveUp} />
        ) : (
          <div className="mesh-title-row">
            <span className="mat-panel-title" data-panel-title="1">
              {title}
            </span>
          </div>
        )}
      </div>
      <div className="mat-panel-body">{children}</div>
      {foot ? <div className="cad-panel-note">{foot}</div> : null}
      <div className={`mat-panel-foot${onDelete ? '' : ' foot-end'}`}>
        {onDelete ? (
          <div className="mesh-foot-left">
            <Button variant="link" onClick={onDelete} data-panel-delete="1">
              {deleteLabel}
            </Button>
          </div>
        ) : null}
        <Button variant="done" onClick={onDone} disabledReason={doneDisabled} tip={doneDisabled ? 'Done' : null} data-panel-done="1">
          Done
        </Button>
      </div>
    </section>
  );
}

/** The flyout column beside the tree card (.tree-detail). */
export function Flyout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`tree-detail${wide ? ' is-wide' : ''}`} data-cad-flyout="1">
      {children}
    </div>
  );
}

/** One label + control row (.mat-row / .mat-k / .mat-v). */
export function Field({ label, htmlFor, children, field, axis }: { label: ReactNode; htmlFor?: string; children: ReactNode; field?: string; axis?: 'x' | 'y' | 'z' }) {
  return (
    <div className="mat-row cad-field" data-field-row={field}>
      <label className="mat-k" htmlFor={htmlFor}>
        {axis ? (
          <span className="bc-axis-lab" data-axis={axis}>
            {label}
          </span>
        ) : (
          label
        )}
      </label>
      <div className="mat-v">{children}</div>
    </div>
  );
}

/** A group heading inside a panel body ("Size", "Position"). */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cad-field-group">
      <div className="cad-field-group-title">{title}</div>
      {children}
    </div>
  );
}

/** 11 px muted hint (.mat-assign-hint). */
export function Hint({ children }: { children: ReactNode }) {
  return <div className="mat-assign-hint">{children}</div>;
}

/** Why something cannot happen yet, in red (.mat-assign-hint[data-run-reason]), with optional fix links (.sim-fix-go). */
export function DisabledReason({ children, fixes }: { children: ReactNode; fixes?: { label: string; run(): void }[] | null }) {
  return (
    <div className="mat-assign-hint" data-run-reason="1" role="status">
      <span className="sim-run-hint-msg">{children}</span>
      {fixes?.map((fix) => (
        <button key={fix.label} type="button" className="sim-fix-go" onClick={fix.run} data-fix={fix.label}>
          {fix.label}
        </button>
      ))}
    </div>
  );
}

/** "No X yet" (.sim-empty in trees; .cad-empty elsewhere). */
export function EmptyState({ children, tree = false, attr }: { children: ReactNode; tree?: boolean; attr?: Record<string, string> }) {
  if (tree) {
    return (
      <li className="sim-empty" {...attr}>
        {children}
      </li>
    );
  }
  return (
    <div className="cad-empty" {...attr}>
      {children}
    </div>
  );
}

/** Native select in the core look (.bc-select). */
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={['bc-select', className || ''].filter(Boolean).join(' ')} />;
}
