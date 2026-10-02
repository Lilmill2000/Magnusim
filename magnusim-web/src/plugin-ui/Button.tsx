import type { MouseEvent, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'neutral' | 'link' | 'fix' | 'danger';
/** data-* attributes spread on a component's root, for tests and hooks. */
export type DataAttrs = Record<`data-${string}`, string>;

export interface ButtonProps {
  /** Default 'secondary'. */
  variant?: ButtonVariant;
  /** Default 'button'. */
  type?: 'button' | 'submit';
  /** Full width. */
  block?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** Appended to the kit's classes. */
  className?: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  attrs?: DataAttrs;
  children: ReactNode;
}

/** The core's panel buttons: primary (Start, Generate), secondary, neutral (Done), link, fix, danger. */
export function Button({
  variant = 'secondary',
  type = 'button',
  block,
  disabled,
  title,
  ariaLabel,
  className,
  onClick,
  attrs,
  children,
}: ButtonProps) {
  const classes = ['mgk-btn', `mgk-btn--${variant}`];
  if (block) classes.push('mgk-btn--block');
  if (className) classes.push(className);
  return (
    <button
      type={type}
      className={classes.join(' ')}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      {...attrs}
    >
      {children}
    </button>
  );
}
