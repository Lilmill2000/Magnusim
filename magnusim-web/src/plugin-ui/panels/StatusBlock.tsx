import { useEffect, useState, type ReactNode } from 'react';
import { formatElapsed } from '../format/time';

export interface StatusBlockProps {
  /** The first line, muted ("Generating mesh"). */
  title: string;
  /** Set as data-status, for tests and hooks. */
  status?: string;
  line?: ReactNode;
  /** The large clock: a fixed string, or <Elapsed> while it runs. */
  elapsed?: ReactNode;
  /** The time left (formatEta). */
  eta?: string | null;
  /** One small line, the parts joined with " · ". */
  meta?: string[];
  /** Between the time left and the meta line (a plot, for example). */
  children?: ReactNode;
}

function shown(v: ReactNode): boolean {
  return v !== undefined && v !== null && v !== false && v !== '';
}

/** The progress block under a panel's main action, as the Mesh and Run panels draw it. */
export function StatusBlock({ title, status, line, elapsed, eta, meta, children }: StatusBlockProps) {
  return (
    <div className="mgk-type mgk-status" data-status={status}>
      <div className="mgk-status-title">{title}</div>
      {shown(line) ? <div className="mgk-status-line">{line}</div> : null}
      {shown(elapsed) ? <div className="mgk-status-elapsed">{elapsed}</div> : null}
      {eta ? <div className="mgk-status-eta">{eta}</div> : null}
      {children}
      {meta && meta.length ? <div className="mgk-status-meta">{meta.join(' · ')}</div> : null}
    </div>
  );
}

/**
 * Wall-clock time since `startedAt` (epoch ms) as m:ss, or h:mm:ss from one hour.
 * Ticks every second, freezes on `finishedAt`, and is 0:00 before the start.
 */
export function useElapsed(startedAt?: number, finishedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || finishedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedAt]);
  if (!startedAt) return '0:00';
  return formatElapsed((finishedAt ?? now) - startedAt);
}

export interface ElapsedProps {
  startedAt?: number;
  finishedAt?: number;
}

/** useElapsed as text. */
export function Elapsed({ startedAt, finishedAt }: ElapsedProps) {
  return <span className="mgk-elapsed">{useElapsed(startedAt, finishedAt)}</span>;
}
