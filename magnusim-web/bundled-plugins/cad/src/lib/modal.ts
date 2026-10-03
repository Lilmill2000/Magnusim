// In-frame modal dialogs (<dialog> opened with showModal): while one is open,
// the keyboard stays inside it and no workspace shortcut runs behind it.
// Review P2/P3 round 2: one Tab from the dialog's last button sent the keyboard
// out of the frame; keys that then reached the page ran Finish sketch, the
// Front view and a second Delete dialog behind the open one.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The modal dialog open in this document (shown with showModal, or marked aria-modal), or null. */
export function openModal(doc: Document): HTMLDialogElement | null {
  for (const d of Array.from(doc.querySelectorAll('dialog[open]'))) {
    let modal = d.getAttribute('aria-modal') === 'true';
    try {
      modal ||= d.matches(':modal');
    } catch {
      /* no :modal support: only aria-modal counts */
    }
    if (modal) return d as HTMLDialogElement;
  }
  return null;
}

/** The dialog's buttons and fields the keyboard can reach, in order. */
export function dialogFocusables(dlg: HTMLElement): HTMLElement[] {
  return Array.from(dlg.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && !el.hidden && !el.closest('[hidden]'),
  );
}

/** Move the keyboard to the next (or, with `back`, the previous) control of the dialog, round from the last to the first. */
export function cycleDialogFocus(dlg: HTMLElement, back: boolean): void {
  const items = dialogFocusables(dlg);
  if (!items.length) return;
  const i = items.indexOf(dlg.ownerDocument.activeElement as HTMLElement);
  const next = back ? (i <= 0 ? items.length - 1 : i - 1) : i < 0 || i === items.length - 1 ? 0 : i + 1;
  items[next].focus();
}

/**
 * Keys inside a modal dialog: Tab and Shift+Tab go round its controls (never
 * out of the dialog or the frame), Escape calls `onEscape`, Enter and Space
 * press the focused button (the browser's own), and no key reaches the
 * workspace's shortcuts. Returns the function that removes the handler.
 */
export function trapDialogKeys(dlg: HTMLElement, onEscape: () => void): () => void {
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cycleDialogFocus(dlg, e.shiftKey);
    }
  };
  dlg.addEventListener('keydown', keys);
  return () => dlg.removeEventListener('keydown', keys);
}
