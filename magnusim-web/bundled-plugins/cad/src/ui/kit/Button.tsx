// Buttons (H14 kit names). Variants map to the core recipes:
//   secondary -> .fp-btn (style.css:2008-2020), primary -> .fp-btn.is-primary,
//   done -> .js-btn.tree-panel-done (2450-2459, 3079), link -> .mat-clear-link
//   (3056-3064), danger -> red text button; IconButton -> .mesh-rename (2971-2990).
// A control that cannot act right now stays focusable with aria-disabled and
// says why in its tooltip (honest UI: a disabled control gives its reason).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon';
import { useTip, type TipContent } from './Tooltip';

export type ButtonVariant = 'secondary' | 'primary' | 'done' | 'link' | 'danger';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  secondary: 'fp-btn',
  primary: 'fp-btn is-primary',
  done: 'js-btn tree-panel-done',
  link: 'mat-clear-link',
  danger: 'mat-clear-link is-danger',
};

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
