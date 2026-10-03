// Panel chrome and the controls inside a panel, on the host's UI kit
// (@magnusim/plugin-ui, H14; its stylesheet /plugin-sdk/plugin-ui.css draws
// them, held equal to the core by the kit's parity gate).
// - From the kit as they are: Field, Select, Hint, DisabledReason and
//   EmptyState (and Toggle: Switch in src/features/p2/panel.tsx). CAD wraps
//   them only to carry the data-* hooks tests address them by (the kit's
//   components take none), in a box of their own that changes no layout.
// - PanelChrome is CAD's own, drawn with the kit's panel classes: the kit's
//   head is a plain title and its Done is always on, while a CAD panel renames
//   its feature from the head (the core's pencil, Rename.tsx), keeps Done
//   disabled with a reason until a new feature can be made, shows a note line
//   above the foot, and has a 3 px accent bar (feature / sketch).
// - The Flyout (the column beside the tree card, .tree-detail) and FieldGroup
//   (a titled group of rows) have no kit counterpart.
// Rules (Daniel's): Done in the foot closes; Delete (a link, foot left) only
// when something can be removed; NO tick or checkmark in the head; valid field
// changes apply live, so Done only closes.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Button as KitButton,
  DisabledReason as KitDisabledReason,
  EmptyState as KitEmptyState,
  Field as KitField,
  Hint as KitHint,
  Select as KitSelect,
  type DataAttrs,
  type SelectOption,
} from '@magnusim/plugin-ui';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { RenameTitle, type RenameFn } from './Rename';

export type { SelectOption };

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
  /** Why Done cannot close yet ("Pick a profile to create Extrude 1"), or null. */
  doneDisabled?: string | null;
  /** Only when something can be removed. */
  onDelete?: (() => void) | null;
  /** Why there is no Delete (a later feature uses this one): shown above the foot. */
  deleteBlock?: string | null;
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
  deleteBlock = null,
  deleteLabel = 'Delete',
  foot,
  className,
  panel,
}: PanelChromeProps) {
  const blocked = !onDelete && deleteBlock ? (
    <div data-delete-block="1">
      <Hint>Delete is off: {deleteBlock}</Hint>
    </div>
  ) : null;
  // The kit PanelChrome's markup (mgk-panel, -head, -title, -body, -foot, -foot-left, Done), card drawn.
  const cls = ['mgk-type', 'mgk-panel', 'mgk-panel--card', 'cad-panel', accent ? `is-accent-${accent}` : '', className || ''].filter(Boolean).join(' ');
  return (
    <section className={cls} data-cad-panel={panel} aria-label={title}>
      <div className="mgk-panel-head">
        {onRename ? (
          <RenameTitle name={title} label={renameLabel} onRename={onRename} onGiveUp={onRenameGiveUp} />
        ) : (
          <div className="mesh-title-row">
            <span className="mgk-panel-title" data-panel-title="1">
              {title}
            </span>
          </div>
        )}
      </div>
      <div className="mgk-panel-body">{children}</div>
      {foot || blocked ? (
        <div className="cad-panel-note">
          {foot}
          {blocked}
        </div>
      ) : null}
      <div className="mgk-panel-foot">
        <div className="mgk-panel-foot-left">
          {onDelete ? (
            <Button variant="link" onClick={onDelete} data-panel-delete="1">
              {deleteLabel}
            </Button>
          ) : null}
        </div>
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

/** One label + control row: the kit's Field (the core's .mat-row), with data-field-row for tests. */
export function Field({ label, htmlFor, help, children, field }: { label: string; htmlFor?: string; help?: string; children: ReactNode; field?: string }) {
  return (
    <div className="cad-field" data-field-row={field}>
      <KitField label={label} htmlFor={htmlFor} help={help}>
        {children}
      </KitField>
    </div>
  );
}

/** A group heading inside a panel body ("Sides", "Direction"). The kit has none. */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cad-field-group">
      <div className="cad-field-group-title">{title}</div>
      {children}
    </div>
  );
}

/** An 11 px note under a control: the kit's Hint (the core's .mat-assign-hint), muted or a warning. */
export function Hint({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <KitHint as="div" tone={tone}>
      {children}
    </KitHint>
  );
}

/**
 * Why something cannot happen yet, in red, with a fix link: the kit's
 * DisabledReason (the core's Run reason). data-run-reason marks it for tests.
 * The kit takes one fix; a second one (none today) follows it as a kit fix button.
 */
export function DisabledReason({ children, fixes }: { children: string; fixes?: { label: string; run(): void }[] | null }) {
  const [first, ...more] = fixes ?? [];
  return (
    <div className="cad-reason" data-run-reason="1">
      <KitDisabledReason reason={children} role="status" fix={first ? { label: first.label, onFix: () => first.run() } : undefined} />
      {more.map((f) => (
        <KitButton key={f.label} variant="fix" onClick={() => f.run()}>
          {f.label}
        </KitButton>
      ))}
    </div>
  );
}

/**
 * "No X yet". In the tree it is the core tree's own empty row (.sim-empty, the
 * recipe the tree parity test compares); elsewhere the kit's EmptyState.
 */
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
      <KitEmptyState>{children}</KitEmptyState>
    </div>
  );
}

export interface SelectProps {
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange(value: string): void;
  /** The select's accessible name. */
  label: string;
  id?: string;
  disabled?: boolean;
  /** data-field on the select's box (tests: `[data-field="op"] select`). */
  field?: string;
  /** Other data-* hooks on the box. */
  attrs?: DataAttrs;
}

/** The kit's Select (the core's .bc-select), in a box that carries the data-* hooks. */
export function Select({ field, attrs, ...rest }: SelectProps) {
  return (
    <span className="cad-select" data-field={field} {...attrs}>
      <KitSelect {...rest} />
    </span>
  );
}
