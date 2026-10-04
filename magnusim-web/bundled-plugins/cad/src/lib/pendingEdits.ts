// Values typed in a panel field and not applied yet (NumberUnitInput commits on
// Enter or blur only). They are unsaved work like any other change (SD review
// round 2: a value typed with no Enter was lost when the user clicked Back to
// project, because in a real browser the frame's blur reaches the field after
// the host has already closed the workspace):
// - while a field holds typed text, the page is dirty (doc/service.ts tells the
//   host with nav.setDirty), so every way out asks first unless the text was
//   applied and saved by then;
// - the leave keys (F5, Ctrl+W, the mouse's side buttons) apply the typed text
//   first, as Enter would (commitPendingEdits), then save;
// - the pointer leaving the frame (on its way to the app's Back) applies it only
//   when it is a whole value the field takes and the user is not still typing
//   (commitPendingEdits('quiet'): "-" on the way to "-5", or "1" typed a moment
//   ago on the way to "15", is left alone, and no refusal shows for it; LINK
//   polish, SD final review);
// - the frame losing focus (the app's header, its dialogs, another window) and
//   the page going apply nothing: the text waits in the field. While it waits
//   the app asks before leaving, and its "Leaving discards them" is then true
//   (SD final review: the dialog's own focus used to apply and save it).
// A typed value the field refuses keeps the page dirty with the reason, so the
// app's question says what would be lost.
// - Focus coming back (UX review U1): after the app's "Stay" (or any return to
//   the window or frame) the field's focus is gone and the chip says "Not
//   applied: press Enter"; so when the window regains focus with nothing
//   focused, the field holding typed text takes it back, caret at the end. And an
//   Enter that reaches the page with nothing focused applies the typed text, as
//   the chip says it will.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface PendingEdit {
  /** The field's name as the user reads it ("+Y padding", "Distance"). */
  label: string;
  /** Typed text that differs from the applied value (or a refused entry). */
  pending(): boolean;
  /** Why the typed text was refused, or null. */
  error(): string | null;
  /** Apply the typed text as Enter would (a refusal stays in the field with its reason). */
  commit(): void;
  /**
   * The pointer left the frame: apply the typed text only when it is a whole value
   * the field takes and the user is not typing right now; never show a refusal.
   */
  commitQuiet?(): void;
  /** Put the keyboard back in the field, caret at the end of its text. */
  focus?(): void;
}

export interface PendingEditsState {
  /** Some field holds typed text that is not applied. */
  pending: boolean;
  /** The first field whose typed text was refused, with the reason. */
  refused: { label: string; error: string } | null;
}

const edits = new Set<PendingEdit>();
const listeners = new Set<() => void>();
let last: PendingEditsState = { pending: false, refused: null };

function compute(): PendingEditsState {
  let pending = false;
  let refused: PendingEditsState['refused'] = null;
  for (const e of edits) {
    if (!e.pending()) continue;
    pending = true;
    const why = e.error();
    if (why && !refused) refused = { label: e.label, error: why };
  }
  return { pending, refused };
}

/** A field says its typed text (or its refusal) changed: listeners hear it when the summary changes. */
export function pendingEditsChanged(): void {
  const next = compute();
  if (next.pending === last.pending && next.refused?.label === last.refused?.label && next.refused?.error === last.refused?.error) return;
  last = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[cad] pending-edit listener failed', err);
    }
  }
}

/** A mounted field: unregister when it goes (its typed text goes with it). */
export function registerPendingEdit(edit: PendingEdit): () => void {
  edits.add(edit);
  pendingEditsChanged();
  return () => {
    edits.delete(edit);
    pendingEditsChanged();
  };
}

export function pendingEdits(): PendingEditsState {
  return last;
}

export function subscribePendingEdits(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The first field holding typed text that is not applied ("+Y padding"), or null. */
export function pendingEditLabel(): string | null {
  for (const e of edits) if (e.pending()) return e.label;
  return null;
}

/**
 * Focus the first field holding typed text (`refused`: the first one whose text
 * was refused). Returns whether one took it.
 */
export function focusPendingEdit(which: 'pending' | 'refused' = 'pending'): boolean {
  for (const e of edits) {
    if (!e.pending() || (which === 'refused' && !e.error()) || !e.focus) continue;
    try {
      e.focus();
      return true;
    } catch (err) {
      console.error('[cad] a field could not take the focus', err);
    }
  }
  return false;
}

/** Nothing that takes keys has the focus (the page's body, or nothing at all). */
function nothingFocused(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/**
 * U1: the window regains focus with nothing focused: the field holding typed text
 * takes it back; Enter with nothing focused applies the typed text (as the chip
 * says), and a refusal keeps its field focused with the reason. Installed once.
 */
export function installPendingEditKeys(win: Window = window): () => void {
  const doc = win.document;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onFocus = () => {
    if (timer) clearTimeout(timer);
    // After the browser has put back (or not) what had the focus before.
    timer = setTimeout(() => {
      timer = null;
      if (nothingFocused() && last.pending) focusPendingEdit();
    }, 0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || !nothingFocused() || !compute().pending) return;
    // Before the page's own Enter (a sketch's Finish): the typed text is what Enter is for now.
    e.preventDefault();
    e.stopPropagation();
    commitPendingEdits();
    if (last.refused) focusPendingEdit('refused');
  };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('keydown', onKey, true);
  return () => {
    if (timer) clearTimeout(timer);
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('keydown', onKey, true);
  };
}

/**
 * Apply every field's typed text now, as Enter would (the user is leaving).
 * Refusals stay. 'quiet' (the pointer left the frame): only whole values the
 * field takes, not while the user is typing, and no refusal is shown.
 */
export function commitPendingEdits(mode: 'all' | 'quiet' = 'all'): void {
  for (const e of [...edits]) {
    if (!e.pending() || e.error()) continue;
    try {
      if (mode === 'quiet') e.commitQuiet?.();
      else e.commit();
    } catch (err) {
      console.error('[cad] a typed value could not be applied', err);
    }
  }
  pendingEditsChanged();
}
