/**
 * The ways into the dock outside it (chat dock spec 1.6, 1.7): the header buttons
 * `#home-assistant` and `#wb-assistant` (shell.html; a workspace borrows the workbench's),
 * and Ctrl+/ (Cmd+/ on macOS) on this document. Inside a workspace frame keys never reach
 * this document: the SDK forwards Ctrl+/ through the bridge, which calls dockShortcut().
 *
 * installDockToggle() wires them and mirrors the dock's state onto the page: each button's
 * aria-expanded and data-assistant-badge, and body.assistant-dock-open (style.css: toasts
 * above the bottom sheet of a narrow window).
 */
import { closeDock, dockSnapshot, focusDock, focusInDock, openDock, subscribeDock, toggleDock } from './dockState';

/** The header buttons that open and close the dock. */
export const TOGGLE_IDS = ['home-assistant', 'wb-assistant'] as const;

/** While one of these shows, Ctrl+/ does nothing (a dialog or Settings is in front). */
export const DIALOG_IDS = ['modal-confirm', 'modal-prompt', 'modal-link-choice', 'setup-wizard'] as const;

function isMac(): boolean {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return !!nav && /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent || '');
}

/** Ctrl+/ (Cmd+/ on macOS), with no Alt. */
export function isDockKey(e: KeyboardEvent, mac = isMac()): boolean {
  if (e.altKey) return false;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  return e.key === '/' || (e.code === 'Slash' && !e.shiftKey);
}

function dialogShown(): boolean {
  return DIALOG_IDS.some((id) => {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  });
}

/**
 * Ctrl+/: closed → open with the keyboard in it; open with the keyboard elsewhere → the
 * keyboard goes to it; open with the keyboard in it → closed, the keyboard back where it came
 * from. Nothing while a dialog or Settings shows. Returns whether it did something.
 */
export function dockShortcut(): boolean {
  if (dialogShown()) return false;
  if (!dockSnapshot().open) openDock();
  else if (focusInDock()) closeDock();
  else focusDock();
  return true;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented || !isDockKey(e)) return;
  if (dockShortcut()) e.preventDefault();
}

function sync(): void {
  const s = dockSnapshot();
  for (const id of TOGGLE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.setAttribute('aria-expanded', s.open ? 'true' : 'false');
    if (s.badge) el.setAttribute('data-assistant-badge', s.badge);
    else el.removeAttribute('data-assistant-badge');
  }
  document.body.classList.toggle('assistant-dock-open', s.size === 'open');
}

/** Wires the buttons and the key, and keeps the page in step with the dock; returns how to undo it. */
export function installDockToggle(): () => void {
  const wired: Array<[HTMLElement, () => void]> = [];
  for (const id of TOGGLE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const onClick = () => toggleDock(el);
    el.addEventListener('click', onClick);
    wired.push([el, onClick]);
  }
  window.addEventListener('keydown', onKeyDown, true);
  sync();
  const off = subscribeDock(sync);
  return () => {
    off();
    window.removeEventListener('keydown', onKeyDown, true);
    for (const [el, onClick] of wired) el.removeEventListener('click', onClick);
    document.body.classList.remove('assistant-dock-open');
  };
}
