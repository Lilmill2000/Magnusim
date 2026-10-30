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
// A panel the Assistant fills (PanelOwnerProvider, set by LeftStack from the
// panel's owner) is read-only: data-panel-owner="assistant", an "Assistant"
// badge in the head, the title not renamable, its fields inert (a wrapper
// inside the body: the body itself is the flyout's scroll container and must
// take the wheel and its scrollbar), no Delete, and Done disabled with the
// reason (the person takes over with Escape).
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
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { commitPendingEdits, focusPendingEdit, pendingEdits } from '../../lib/pendingEdits';
import { Button } from './Button';
import { RenameTitle, type RenameFn } from './Rename';

export type { SelectOption };

/** Who fills the open panel: the person, or the Assistant (its panels are read-only and drive no viewport tools). */
export type PanelOwner = 'person' | 'assistant';

const PanelOwnerContext = createContext<PanelOwner>('person');

/** Around the open panel's body (LeftStack): its owner, for the chrome and the pick tools inside it. */
export const PanelOwnerProvider = PanelOwnerContext.Provider;

/** The owner of the panel this component is in ('person' outside any panel). */
export function usePanelOwner(): PanelOwner {
  return useContext(PanelOwnerContext);
}

/** Done's reason on a panel the Assistant fills. */
export const ASSISTANT_PANEL_DONE = 'The Assistant is filling this in · Esc takes over (the Assistant pauses)';

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
  /** ux010 PANELS: more in the head after the title (the Sketch panel's state and its collapse chevron). */
  headAside?: ReactNode;
  /** ux010 PANELS: more in the foot's left, after Delete (the Sketch panel's Details disclosure). */
  footLeft?: ReactNode;
}

export function PanelChrome(props: PanelChromeProps) {
  const assistant = usePanelOwner() === 'assistant';
  // The Assistant's panel: its fields can be seen, not used (inert, set here: the host's React may
  // not know the attribute). On the fields' wrapper, never the body: an inert body takes no wheel
  // and no scrollbar drag, so a tall panel could not be scrolled while it is watched (review).
  const fieldsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    fieldsRef.current?.toggleAttribute('inert', assistant);
  }, [assistant]);
  const {
    title,
    renameLabel = 'feature',
    onRenameGiveUp,
    accent = null,
    children,
    onDone,
    deleteLabel = 'Delete',
    foot,
    className,
    panel,
    headAside = null,
    footLeft = null,
  } = props;
  // Read-only for the person while the Assistant fills it: no rename, no Delete, Done says why it waits.
  const onRename = assistant ? null : props.onRename;
  const onDelete = assistant ? null : props.onDelete;
  const deleteBlock = assistant ? null : (props.deleteBlock ?? null);
  const doneDisabled = assistant ? ASSISTANT_PANEL_DONE : (props.doneDisabled ?? null);
  const blocked = !onDelete && deleteBlock ? (
    <div data-delete-block="1">
      <Hint>Delete is off: {deleteBlock}</Hint>
    </div>
  ) : null;
  // Done applies what is typed, as Enter would; a value a field refuses keeps the panel open on that
  // field, its reason under it (UX review: Done closed and the refused value was dropped silently).
  const done = () => {
    commitPendingEdits();
    if (pendingEdits().refused && focusPendingEdit('refused')) return;
    onDone();
  };
  // The kit PanelChrome's markup (mgk-panel, -head, -title, -body, -foot, -foot-left, Done), card drawn.
  const cls = ['mgk-type', 'mgk-panel', 'mgk-panel--card', 'cad-panel', accent ? `is-accent-${accent}` : '', className || ''].filter(Boolean).join(' ');
  return (
    <section className={cls} data-cad-panel={panel} data-panel-owner={assistant ? 'assistant' : undefined} aria-label={title}>
      <div className="mgk-panel-head">
        {onRename ? (
          <RenameTitle name={title} label={renameLabel} onRename={onRename} onGiveUp={onRenameGiveUp} />
        ) : (
          <div className="mesh-title-row">
            <span className="mgk-panel-title" data-panel-title="1">
              {title}
            </span>
            {assistant ? (
              <span className="cad-panel-badge" data-panel-badge="assistant">
                Assistant
              </span>
            ) : null}
          </div>
        )}
        {headAside}
      </div>
      <div className="mgk-panel-body">
        <div className="cad-panel-fields" data-panel-fields="1" ref={fieldsRef}>
          {children}
        </div>
      </div>
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
          {footLeft}
        </div>
        <Button variant="done" onClick={done} disabledReason={doneDisabled} tip={doneDisabled ? 'Done' : null} data-panel-done="1">
          Done
        </Button>
      </div>
    </section>
  );
}

/** The flyout column beside the tree card (.tree-detail); `rail` (ux010): its panel is collapsed to a slim rail. */
export function Flyout({ children, wide = false, rail = false }: { children: ReactNode; wide?: boolean; rail?: boolean }) {
  return (
    <div className={`tree-detail${wide ? ' is-wide' : ''}${rail ? ' is-rail' : ''}`} data-cad-flyout="1">
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
 * A note in a panel's note line that is no problem: what an action did ("Copied 4 lines..."), in
 * the kit's plain hint ('info'), or what it did only in part (something left out), in the kit's
 * amber ('warning'). Never DisabledReason's red: a success must not look like a failure. On the
 * host's --mg-* tokens through the kit, so the dark theme has its own. data-panel-note marks it.
 */
export function Note({ children, tone = 'info' }: { children: string; tone?: 'info' | 'warning' }) {
  return (
    <div className="cad-note" data-panel-note={tone} role="status">
      <KitHint as="div" tone={tone === 'warning' ? 'warning' : 'muted'}>
        {children}
      </KitHint>
    </div>
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
