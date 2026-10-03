// Buttons. They are drawn by the host's UI kit (@magnusim/plugin-ui, H14): the
// kit's classes and stylesheet (/plugin-sdk/plugin-ui.css), which the kit's
// parity gate holds equal to the core's panel buttons:
//   secondary -> mgk-btn--secondary (core .fp-btn), primary -> mgk-btn--primary,
//   done -> mgk-btn--neutral + mgk-panel-done (core .js-btn.tree-panel-done),
//   link -> mgk-btn--link (core .mat-clear-link), fix -> mgk-btn--fix (core
//   .sim-fix-go), danger -> the link in red (a destructive text action; the
//   kit's own 'danger' is a solid red button, which CAD does not use).
// Why not the kit's <Button> itself: it disables with the native attribute, so a
// button that cannot act takes no focus and no hover, and its reason could not
// be read (honest UI: a disabled control says why, by tooltip and by keyboard);
// it also takes no ref, aria-pressed, key or pointer handlers. So this button
// stays focusable with aria-disabled and the kit's disabled look (ui.css).
// IconButton -> .mesh-rename (style.css:2971-2990): the kit has no icon button.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon';
import { useTip, type TipContent } from './Tooltip';

export type ButtonVariant = 'secondary' | 'primary' | 'done' | 'link' | 'fix' | 'danger';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  secondary: 'mgk-btn mgk-btn--secondary',
  primary: 'mgk-btn mgk-btn--primary',
  done: 'mgk-btn mgk-btn--neutral mgk-panel-done',
  link: 'mgk-btn mgk-btn--link',
  fix: 'mgk-btn mgk-btn--fix',
  danger: 'mgk-btn mgk-btn--link cad-btn-danger',
};

/** The kit classes of a button variant, for buttons made outside React (in-frame dialogs, the view's boxes). */
export function buttonClass(variant: ButtonVariant): string {
  return VARIANT_CLASS[variant];
}

type NativeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'type' | 'title'>;

export interface ButtonProps extends NativeProps {
  variant?: ButtonVariant;
  /** null/undefined = enabled; a string = unavailable, and why ("Nothing to undo"). */
  disabledReason?: string | null;
  /** Tooltip; the disabled reason is added as its detail line. */
  tip?: TipContent | string | null;
  children?: ReactNode;
}

function tipOf(tip: TipContent | string | null | undefined, reason: string | null | undefined): TipContent | null {
  const base: TipContent | null = typeof tip === 'string' ? { text: tip } : tip ?? null;
  if (!reason) return base;
  if (!base) return { text: reason };
  return { ...base, detail: reason };
}

export function Button({ variant = 'secondary', disabledReason, tip, className, onClick, children, ...rest }: ButtonProps) {
  const disabled = !!disabledReason;
  const tipHandlers = useTip(tipOf(tip, disabledReason));
  const cls = [VARIANT_CLASS[variant], disabled ? 'is-disabled' : '', className || ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      {...rest}
      {...tipHandlers}
      className={cls}
      aria-disabled={disabled || undefined}
      data-disabled-reason={disabledReason || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}

export interface IconButtonProps extends NativeProps {
  /** SVG path d (24 viewBox). */
  icon: string;
  /** Accessible name and tooltip ("Rename Box 1", "Hide Body 1"). */
  label: string;
  size?: 'row' | 'panel';
  disabledReason?: string | null;
  pressed?: boolean;
  /** Tooltip second line (the state a toggle is in). */
  hint?: string;
}

/** A square icon-only button (.mesh-rename recipe): 26 px in panels, 20 px in tree rows. */
export function IconButton({ icon, label, size = 'panel', disabledReason, pressed, hint, className, onClick, ...rest }: IconButtonProps) {
  const disabled = !!disabledReason;
  const tipHandlers = useTip(tipOf(hint ? { text: label, detail: hint } : label, disabledReason));
  const cls = ['mesh-rename', size === 'row' ? 'is-row' : '', disabled ? 'is-disabled' : '', className || ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      {...rest}
      {...tipHandlers}
      className={cls}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (disabled) return;
        onClick?.(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon d={icon} size={size === 'row' ? 13 : 15} />
    </button>
  );
}
