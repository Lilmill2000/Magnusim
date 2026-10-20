/**
 * A guarded Yes (the Assistant's questions, phase 4 spec 4.4): a model can ask one question right
 * after another, each in the same place, so Yes takes only a deliberate click. It is disabled
 * for its first YES_GUARD_MS on screen; then it counts a click only when the press began on it
 * after that, and never the second click of a double-click. A key on it (Tab, then Space: a
 * click with detail 0) counts once it is enabled. Enter never clicks it: the dialog answers No.
 *
 * Shared by the app's confirm dialog (dialogs.ts showConfirm with `guard`) and the dock's
 * question card (src/assistant/dock/GateCard.tsx), so the two can't drift.
 */

/** How long a guarded Yes stays disabled once it is shown. */
export const YES_GUARD_MS = 500;

export interface GuardedYes {
  /** Whether this click (or key) on Yes answers Yes. */
  accepts(e?: { detail?: number } | null): boolean;
  /** Whether it is enabled yet. */
  readonly armed: boolean;
  /** Stops guarding: its timer and listener go, and the button is enabled again (a shared button). */
  dispose(): void;
}

/**
 * Guards `button`: disabled now, enabled after `ms`. `onArmed` is told when it is enabled (a
 * React card renders its `disabled` from it); the button's own `disabled` is set too when given.
 */
export function guardYes(button: HTMLButtonElement | null, o: { ms?: number; onArmed?: () => void } = {}): GuardedYes {
  let armed = false;
  let pressed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onPress = () => {
    pressed = armed;
  };
  if (button) {
    button.disabled = true;
    button.addEventListener('pointerdown', onPress);
  }
  timer = setTimeout(() => {
    timer = null;
    armed = true;
    if (button) button.disabled = false;
    o.onArmed?.();
  }, o.ms ?? YES_GUARD_MS);
  return {
    get armed() {
      return armed;
    },
    accepts(e) {
      // Not before it is enabled, not a click whose press began before that (a key on it, detail
      // 0, has no press), and never the second click of a double-click.
      const detail = e?.detail ?? 0;
      return armed && detail <= 1 && (detail === 0 || pressed);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (button) {
        button.removeEventListener('pointerdown', onPress);
        button.disabled = false;
      }
    },
  };
}
