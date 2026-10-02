import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import type { DataAttrs } from '../Button';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastProps {
  message: string;
  /** Default 'info'. */
  kind?: ToastKind;
  /** Called when its time is up or × is pressed. */
  onClose: () => void;
  /** Default 3800 (info, success) or 9000 (error). 0 keeps it until it is closed. */
  durationMs?: number;
  /** Holds the time, as hover does; when it turns false the full duration starts again. */
  paused?: boolean;
  attrs?: DataAttrs;
}

const DURATION_MS: Record<ToastKind, number> = { info: 3800, success: 3800, error: 9000 };

/**
 * One toast: a message with ×. It closes by itself after its duration; the time
 * stops while the pointer is over it or the focus is in it, and starts again from
 * the full duration when they leave. A parent holds it with `paused` and
 * restarts it with a new `key`.
 */
export function Toast({ message, kind, onClose, durationMs, paused: held, attrs }: ToastProps) {
  const k: ToastKind = kind === 'success' || kind === 'error' ? kind : 'info';
  const ms = durationMs ?? DURATION_MS[k];
  // The latest onClose, so a parent's re-render (a new arrow) does not restart the time.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused || !!held;

  useEffect(() => {
    if (paused || !(ms > 0)) return undefined;
    const t = setTimeout(() => closeRef.current(), ms);
    return () => clearTimeout(t);
  }, [ms, paused]);

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    <div
      className={`mgk-type mgk-toast mgk-toast--${k}`}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      {...attrs}
    >
      <span className="mgk-toast-msg">{message}</span>
      <button type="button" className="mgk-toast-close" aria-label="Close" onClick={() => closeRef.current()}>
        ×
      </button>
    </div>
  );
}
