/**
 * The ways into the dock outside it (chat dock spec 1.6, 1.7): the corner button (DockShell)
 * and its key on this document: Ctrl+/ (Cmd+/ on macOS), or the keys the person chose in
 * Settings → Keybinds (keybinds/appKeys.ts). Inside a workspace frame keys never reach this
 * document: the SDK forwards the same key through the bridge, which calls dockShortcut().
 *
 * installDockToggle() wires the key and mirrors the dock's state onto the page:
 * body.assistant-dock-open / .assistant-corner-shown (style.css: toasts keep clear of the panel
 * and of the corner button).
 */
import { assistantKeys, pressIs, startAppKeys } from '../../keybinds/appKeys';
import { closeDock, dockSnapshot, focusDock, focusInDock, openDock, subscribeDock } from './dockState';

/** While one of these shows, the key does nothing (a dialog or Settings is in front). */
export const DIALOG_IDS = ['modal-confirm', 'modal-prompt', 'modal-link-choice', 'setup-wizard'] as const;

function isMac(): boolean {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return !!nav && /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent || '');
}

/**
 * The dock's key: the person's (`keys`, from Settings → Keybinds; none when []), else Ctrl+/
 * (Cmd+/ on macOS) by the character "/", with no Alt.
 */
export function isDockKey(e: KeyboardEvent, mac = isMac(), keys: readonly string[] | null = assistantKeys()): boolean {
  if (keys) return pressIs(e, keys);
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
 * The key: closed → open with the keyboard in it; open with the keyboard elsewhere → the
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
  // The corner button shows whenever the dock is closed: toasts keep clear of it too.
  document.body.classList.toggle('assistant-dock-open', s.open);
  document.body.classList.toggle('assistant-corner-shown', !s.open);
}

/** Wires the key and keeps the page in step with the dock; returns how to undo it. */
export function installDockToggle(): () => void {
  startAppKeys();
  window.addEventListener('keydown', onKeyDown, true);
  sync();
  const off = subscribeDock(sync);
  return () => {
    off();
    window.removeEventListener('keydown', onKeyDown, true);
    document.body.classList.remove('assistant-dock-open', 'assistant-corner-shown');
  };
}
