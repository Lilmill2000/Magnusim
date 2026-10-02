/**
 * One toast element, shown in turn. Every text pushed is painted, one after another:
 * each for its own time when nothing waits, and for the readable minimum (never less)
 * when another is waiting. It then fades out before the next one is painted, so two
 * notices that arrive in the same frame are both seen, and a run-finished toast and a
 * queue notice never hide each other.
 */

/** Shortest time a toast stays when another waits: long enough to read one line. */
export const TOAST_READ_MIN_MS = 3000;
/** The fade out (the `.is-on` transition in style.css). */
export const TOAST_FADE_MS = 280;

export interface ToastItem {
  text: string;
  /** Failure styling (`is-fail`); cleared for a toast that is not a failure. */
  fail: boolean;
  /** How long it stays when nothing waits behind it. */
  ms: number;
}

export interface ToastQueueDeps {
  el: () => HTMLElement | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  frame?: (fn: () => void) => void;
  minMs?: number;
  fadeMs?: number;
}

export interface ToastQueue {
  push(item: ToastItem): void;
  /** Toasts waiting behind the one on screen. */
  waiting(): number;
  /** The text on screen (also while it fades), or ''. */
  showing(): string;
}

export function createToastQueue(deps: ToastQueueDeps): ToastQueue {
  // A steady clock: setting the wall clock back or forward neither holds a toast nor cuts it short.
  const now = deps.now || (() => performance.now());
  const setTimer = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const frame = deps.frame || ((fn: () => void) => requestAnimationFrame(fn));
  const minMs = deps.minMs ?? TOAST_READ_MIN_MS;
  const fadeMs = deps.fadeMs ?? TOAST_FADE_MS;
  const queue: ToastItem[] = [];
  let current: { item: ToastItem; at: number; el: HTMLElement } | null = null;
  let fading = false;
  let timer: unknown = null;

  const arm = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(tick, Math.max(0, ms));
  };

  /** Its own time, or the readable minimum once another waits (never below it). */
  const endsAt = (c: { item: ToastItem; at: number }) => c.at + (queue.length ? Math.min(c.item.ms, minMs) : c.item.ms);

  const show = () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const el = deps.el();
      if (!el) continue;
      el.textContent = item.text;
      el.classList.toggle('is-fail', !!item.fail);
      el.hidden = false;
      const shown = { item, at: now(), el };
      current = shown;
      fading = false;
      frame(() => {
        if (current === shown && !fading) el.classList.add('is-on');
      });
      arm(endsAt(shown) - now());
      return;
    }
  };

  function tick() {
    timer = null;
    const c = current;
    if (!c) return;
    if (!fading) {
      fading = true;
      c.el.classList.remove('is-on');
      arm(fadeMs);
      return;
    }
    current = null;
    fading = false;
    if (queue.length) show();
    const next = current as { el: HTMLElement } | null;
    if (!next || next.el !== c.el) c.el.hidden = true;
  }

  return {
    push(item) {
      if (!item || !item.text) return;
      queue.push({ text: String(item.text), fail: !!item.fail, ms: Math.max(0, Number(item.ms) || 0) });
      if (!current) show();
      else if (!fading) arm(endsAt(current) - now());
    },
    waiting: () => queue.length,
    showing: () => (current ? current.item.text : ''),
  };
}
