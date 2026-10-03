// The selection list (core .mat-assign-list, style.css:3085-3146; the
// SOLIDWORKS selection box): what a field holds, one row each with a remove
// button, "(none)" when empty. A field is active (a border in the pick green)
// while viewport clicks go to it; clicking the box activates it.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { DisabledReason, Hint } from '../../ui/kit';

export interface PickRow {
  key: string;
  label: string;
  /** The row's tooltip when it says more than the label (where a face came from). */
  title?: string;
  /** A second, muted part ("planar", "12 faces"). */
  sub?: string | null;
  /** What the row names is not there now (a face lost after a rebuild): red, `sub` says so. */
  missing?: boolean;
  /** Hovering the row flashes this in the viewport (optional). */
  onHover?(on: boolean): void;
}

export function PickList({
  field,
  label,
  rows,
  active,
  onActivate,
  onRemove,
  hint,
  error,
  single = false,
  empty = null,
}: {
  field: string;
  label: ReactNode;
  rows: PickRow[];
  active: boolean;
  onActivate(): void;
  onRemove(key: string): void;
  /** Shown under the list while it is active ("Click faces in the viewport"). */
  hint?: string | null;
  /** A refused pick ("That face is not flat"). */
  error?: string | null;
  /** Holds one item: a click replaces it. */
  single?: boolean;
  /** What an empty list means, in the list itself ("All solid bodies"), instead of "(none)". */
  empty?: string | null;
}) {
  return (
    <div className={`cad-pick${active ? ' is-active' : ''}`} data-pick-field={field} data-active={active ? '1' : '0'}>
      <div className="cad-pick-head">
        <span className="cad-pick-label">{label}</span>
      </div>
      <ul
        className="mat-assign-list cad-pick-list"
        role="listbox"
        aria-label={typeof label === 'string' ? label : field}
        aria-multiselectable={!single || undefined}
        tabIndex={0}
        onClick={onActivate}
        onFocus={onActivate}
        data-pick-list={field}
      >
        {!rows.length && empty ? (
          <li className="cad-pick-empty" data-pick-empty="1">
            {empty}
          </li>
        ) : null}
        {rows.map((r) => (
          <li
            key={r.key}
            className={`bc-assign-item${r.missing ? ' is-missing' : ''}`}
            role="option"
            aria-selected="true"
            data-pick-row={r.key}
            data-pick-missing={r.missing ? '1' : undefined}
            title={r.missing ? r.title : undefined}
            onMouseEnter={() => r.onHover?.(true)}
            onMouseLeave={() => r.onHover?.(false)}
          >
            <span className="cad-pick-name" title={r.title ?? r.label}>
              {r.label}
            </span>
            {r.sub ? (
              <span className={`mat-assign-state${r.missing ? ' is-missing' : ''}`} data-pick-sub="1">
                {r.sub}
              </span>
            ) : null}
            <button
              type="button"
              className="bc-assign-x"
              aria-label={`Remove ${r.label}`}
              data-pick-remove={r.key}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(r.key);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <div data-pick-error={field}>
          <DisabledReason>{error}</DisabledReason>
        </div>
      ) : active && hint ? (
        <div data-pick-hint={field}>
          <Hint>{hint}</Hint>
        </div>
      ) : null}
    </div>
  );
}
