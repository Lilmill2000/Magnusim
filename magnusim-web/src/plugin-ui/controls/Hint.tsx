import type { ReactNode } from 'react';
import { Button } from '../Button';

export interface HintProps {
  /** Default 'muted'. */
  tone?: 'muted' | 'warning' | 'danger';
  /** Default 'p'. */
  as?: 'p' | 'div';
  children: ReactNode;
}

/** A small note under a control (.mat-assign-hint). */
export function Hint({ tone = 'muted', as = 'p', children }: HintProps) {
  const Tag = as;
  const className = tone === 'muted' ? 'mgk-type mgk-hint' : `mgk-type mgk-hint mgk-hint--${tone}`;
  return <Tag className={className}>{children}</Tag>;
}

export interface DisabledReasonProps {
  /** Why the action is not available. */
  reason: string;
  /** A link-style button that fixes it. */
  fix?: { label: string; onFix: () => void };
  /** None by default, as the core's run reason. 'alert' for a short error. */
  role?: 'alert' | 'status';
}

/** Why something cannot run, with an optional fix (the Run panel's reason). */
export function DisabledReason({ reason, fix, role }: DisabledReasonProps) {
  return (
    <div className="mgk-type mgk-hint mgk-reason" role={role}>
      <span className="mgk-reason-msg">{reason}</span>
      {fix ? (
        <Button variant="fix" onClick={() => fix.onFix()}>
          {fix.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  /** 'list' (default) for an empty list, 'chart' for a chart with no data yet. */
  variant?: 'list' | 'chart';
  /** Default 'div'; 'li' inside a list. */
  as?: 'div' | 'li';
  children: ReactNode;
}

/** What an empty list or chart shows (.hub-empty, .mon-empty). */
export function EmptyState({ variant = 'list', as = 'div', children }: EmptyStateProps) {
  const Tag = as;
  const className = variant === 'chart' ? 'mgk-type mgk-empty mgk-empty--chart' : 'mgk-type mgk-empty';
  return <Tag className={className}>{children}</Tag>;
}
