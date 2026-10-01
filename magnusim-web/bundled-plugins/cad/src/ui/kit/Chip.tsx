// Status chip (core .measure-chip / .hidden-faces-chip, style.css:1070-1140):
// white, border #d0d5dd, radius 6, shadow-sm, 600 12px #344054, an optional
// 10px uppercase key, and optional link actions ("Retry", "Reload").
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';

export interface ChipAction {
  label: string;
  run(): void;
}

export function Chip({
  chip,
  k,
  kind = 'info',
  children,
  actions,
  state,
  busy = false,
}: {
  /** data-chip value (tests): "kernel", "save", "volume", "rebuild". */
  chip: string;
  /** Key label above/before the value ("VOLUME"). */
  k?: string;
  kind?: 'info' | 'error' | 'warning';
  children: ReactNode;
  actions?: ChipAction[];
  /** data-state value (tests). */
  state?: string;
  busy?: boolean;
}) {
  const cls = ['cad-chip', kind === 'error' ? 'is-error' : '', kind === 'warning' ? 'is-warning' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-chip={chip} data-state={state} role={kind === 'error' ? 'alert' : 'status'} aria-busy={busy || undefined}>
      {busy ? <span className="tree-spin cad-chip-spin" aria-hidden="true" /> : null}
      {k ? <span className="cad-chip-k">{k}</span> : null}
      <span className="cad-chip-v">{children}</span>
      {actions?.map((a) => (
        <button key={a.label} type="button" className="cad-chip-link" onClick={a.run} data-chip-action={a.label}>
          {a.label}
        </button>
      ))}
    </div>
  );
}
