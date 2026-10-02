import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast, type ToastKind } from '../plugin-ui';

/** The most app toasts on screen at once; a new one drops the oldest. */
export const MAX_TOASTS = 3;

type AppToast = {
  /** Stable, for closing it. */
  id: number;
  /** The React key: a new one restarts its time (the same toast again). */
  key: number;
  message: string;
  kind: ToastKind;
  /** From cfd:plugin-toast (a plugin's UI failed to load). */
  plugin: boolean;
};

function toastKind(kind: unknown): ToastKind {
  return kind === 'success' || kind === 'error' ? kind : 'info';
}

/**
 * The app's toasts, bottom right, newest last: a plugin UI that failed to load
 * (cfd:plugin-toast) and in-page plugin toasts (pluginUi.toast, cfd:toast).
 * Workspace toasts stay in the workspace overlay.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const serial = useRef(0);
  // The pointer is on one of the toasts: all of them wait, so none closes and
  // slides another out from under a pointer that did not move.
  const [held, setHeld] = useState(false);
  // × on the last one leaves no toast for a mouseleave to come from.
  if (held && toasts.length === 0) setHeld(false);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const add = (message: string, kind: ToastKind, plugin: boolean) => {
      if (!message) return;
      const n = ++serial.current;
      setToasts((list) => {
        // The same toast again restarts its time instead of showing a copy.
        const same = list.find((t) => t.message === message && t.kind === kind && t.plugin === plugin);
        if (same) return list.map((t) => (t === same ? { ...t, key: n } : t));
        return [...list, { id: n, key: n, message, kind, plugin }].slice(-MAX_TOASTS);
      });
    };
    const onPluginToast = (event: Event) => {
      add(String((event as CustomEvent<unknown>).detail ?? ''), 'error', true);
    };
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown; kind?: unknown } | null>).detail;
      add(String(detail?.message ?? '').slice(0, 300), toastKind(detail?.kind), false);
    };
    window.addEventListener('cfd:plugin-toast', onPluginToast);
    window.addEventListener('cfd:toast', onToast);
    return () => {
      window.removeEventListener('cfd:plugin-toast', onPluginToast);
      window.removeEventListener('cfd:toast', onToast);
    };
  }, []);

  return (
    // The region itself takes no clicks (pointer-events: none); it enters and
    // leaves as the pointer enters and leaves its toasts.
    <div
      className="app-toasts"
      role="region"
      aria-label="Notifications"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      {toasts.map((t) => (
        <Toast
          key={t.key}
          message={t.message}
          kind={t.kind}
          paused={held}
          onClose={() => remove(t.id)}
          attrs={t.plugin ? { 'data-plugin-toast': '1' } : undefined}
        />
      ))}
    </div>
  );
}
