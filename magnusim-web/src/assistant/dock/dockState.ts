/**
 * The dock's place on screen (chat dock spec 1.3, 2.9, 6.1): open, a pill, or closed, and what
 * the pill says. The one owner of these: the conversation store (store.ts) opens the dock for a
 * question and sets the pill through openDock and setDockPill. One module store, read with
 * useSyncExternalStore; a publish replaces the snapshot.
 *
 * - `open`: the person opened it (the corner button, Ctrl+/), or a question arrived.
 * - `pill`: closed while something is worth seeing (setDockPill): a running request, a
 *   question, or an end not yet seen. A `done` pill goes after 120 s or when the dock opens.
 * - `closed`: nothing going on; the corner button (DockShell) says "Assistant" and opens it.
 *
 * The app starts with the dock closed, whatever it was before (Daniel: it shouldn't pop up
 * when the app starts).
 *
 * Focus: opening remembers where the keyboard was (the opener) and asks the shell to focus
 * the dock's entry (DockShell: a `[data-dock-autofocus]` element, else the composer, else
 * the panel's first button); closing with the keyboard in the dock gives it back to the
 * opener, or, over a workspace, leaves it to the overlay, which hands it to the frame when
 * the panel hides (WorkspaceOverlay HOST_UI).
 */
import { useSyncExternalStore } from 'react';

export type DockSize = 'open' | 'pill' | 'closed';
export type DockPillKind = 'running' | 'question' | 'done';
/** The toggle buttons' dot: warning for a question, primary while working, success when done. */
export type DockBadge = 'question' | 'working' | 'done';

export interface DockPill {
  kind: DockPillKind;
  /** The pill's words, also its aria-label (2.9 "The pill"). */
  text: string;
  /** With a running request: the pill's Stop. */
  onStop?: () => void;
}

export interface DockSnapshot {
  open: boolean;
  size: DockSize;
  pill: DockPill | null;
  badge: DockBadge | null;
  /** Goes up each time the dock should take the keyboard (DockShell focuses its entry). */
  focusSeq: number;
}

/** How long a `done` pill stays when the dock isn't opened (2.9). */
export const DONE_PILL_MS = 120_000;

const BADGE: Record<DockPillKind, DockBadge> = { running: 'working', question: 'question', done: 'done' };

function make(open: boolean, pill: DockPill | null, focusSeq: number): DockSnapshot {
  return { open, size: open ? 'open' : pill ? 'pill' : 'closed', pill, badge: pill ? BADGE[pill.kind] : null, focusSeq };
}

let snap: DockSnapshot = make(false, null, 0);
let opener: HTMLElement | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;
/** A close's way to give the keyboard back, not taken yet (takeReturnFocus). */
let returnFocus: (() => boolean) | null = null;
const listeners = new Set<() => void>();

function publish(next: DockSnapshot): void {
  snap = next;
  for (const fn of [...listeners]) fn();
}

export function dockSnapshot(): DockSnapshot {
  return snap;
}

export function subscribeDock(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDock(): DockSnapshot {
  return useSyncExternalStore(subscribeDock, dockSnapshot, dockSnapshot);
}

/** The dock's panel, when it is in the page. */
export function dockPanel(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('assistant-dock');
}

/** Whether the keyboard is in the dock (its panel or its pill). */
export function focusInDock(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (!active || active === document.body) return false;
  return !!active.closest('#assistant-dock, [data-assistant-pill]');
}

function clearDoneTimer(): void {
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = null;
}

/** Where the keyboard is now, unless that is the dock itself or nowhere. */
function rememberOpener(from?: HTMLElement | null): void {
  const el = from ?? (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  if (!el || el === document.body || el.closest('#assistant-dock')) return;
  // The corner button that opened it gets the keyboard back (it shows again as the dock
  // closes); the keyboard merely resting on it doesn't make it the opener.
  if (!from && el.closest('[data-assistant-pill]')) return;
  opener = el;
}

/**
 * Opens the dock and gives it the keyboard. `from`: the control that opened it (the corner
 * button), when the browser may not have focused it on click; else wherever the keyboard is.
 * `focus: false`: the keyboard stays (a question's card takes it itself).
 */
export function openDock(opts: { from?: HTMLElement | null; focus?: boolean } = {}): void {
  rememberOpener(opts.from);
  // A done pill is seen once the dock opens.
  const pill = snap.pill && snap.pill.kind === 'done' ? null : snap.pill;
  if (!pill) clearDoneTimer();
  publish(make(true, pill, opts.focus === false ? snap.focusSeq : snap.focusSeq + 1));
}

/** The dock is open and the keyboard is elsewhere: it goes to the dock's entry. */
export function focusDock(from?: HTMLElement | null): void {
  if (!snap.open) {
    openDock({ from });
    return;
  }
  rememberOpener(from);
  publish(make(true, snap.pill, snap.focusSeq + 1));
}

/** Whether `el` can take the keyboard: in the page, shown, not under an inert cover. */
function canTakeFocus(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden], [inert]')) return false;
  return !(el as HTMLButtonElement).disabled;
}

/** The corner button that opens the dock (shown again once it closes). */
function cornerButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-assistant-pill] .assistant-dock-pill-open');
}

/**
 * Closes the dock (to the pill when something is worth seeing). With the keyboard in the dock
 * it goes back to the opener; over a workspace with no opener to go back to it is left to the
 * overlay, which gives it to the frame once the panel hides.
 */
export function closeDock(): void {
  if (!snap.open) return;
  const inDock = focusInDock();
  const back = opener;
  opener = null;
  publish(make(false, snap.pill, snap.focusSeq));
  if (!inDock) return;
  // Back to the opener, else the corner button; over a workspace the keyboard is left to the
  // overlay, which gives it to the frame. The corner button shows again once React renders
  // this close, so a target still hidden is tried again on the next frame.
  const give = (): boolean => {
    const target = canTakeFocus(back) ? back : document.body.classList.contains('workspace-open') ? null : cornerButton();
    if (!target || !canTakeFocus(target)) return false;
    target.focus({ preventScroll: true });
    return true;
  };
  if (give()) return;
  // DockShell gives it as it renders the close (takeReturnFocus, before a workspace's overlay
  // hands the keyboard to its frame); a frame later otherwise.
  returnFocus = give;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (returnFocus !== give) return;
      returnFocus = null;
      give();
    });
  }
}

/** The keyboard's way back after a close, once the page shows the corner button again (DockShell). */
export function takeReturnFocus(): (() => boolean) | null {
  const f = returnFocus;
  returnFocus = null;
  return f;
}

/** Open, or close when open. */
export function toggleDock(from?: HTMLElement | null): void {
  if (snap.open) closeDock();
  else openDock({ from });
}

/**
 * What the dock has worth seeing (null: nothing). Shown as the pill while the dock is
 * closed. A `done` pill goes by itself after 120 s.
 */
export function setDockPill(pill: DockPill | null): void {
  clearDoneTimer();
  if (pill && pill.kind === 'done') {
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (snap.pill === pill) publish(make(snap.open, null, snap.focusSeq));
    }, DONE_PILL_MS);
  }
  publish(make(snap.open, pill, snap.focusSeq));
}

/** Tests only: a fresh page (closed, no pill, no opener). */
export function resetDockForTests(): void {
  clearDoneTimer();
  opener = null;
  returnFocus = null;
  publish(make(false, null, 0));
}
