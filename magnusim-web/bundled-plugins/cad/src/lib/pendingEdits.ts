// Values typed in a panel field and not applied yet (NumberUnitInput commits on
// Enter or blur only). They are unsaved work like any other change (SD review
// round 2: a value typed with no Enter was lost when the user clicked Back to
// project, because in a real browser the frame's blur reaches the field after
// the host has already closed the workspace):
// - while a field holds typed text, the page is dirty (doc/service.ts tells the
//   host with nav.setDirty), so every way out asks first unless the text was
//   applied and saved by then;
// - every signal that the user is about to leave (the pointer leaving the frame,
//   the frame losing focus, the leave keys, the page going) applies the typed
//   text first (commitPendingEdits), then saves.
// A typed value the field refuses keeps the page dirty with the reason, so the
// app's question says what would be lost.
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

/** Apply every field's typed text now, as Enter would (the user is leaving). Refusals stay. */
export function commitPendingEdits(): void {
  for (const e of [...edits]) {
    if (!e.pending() || e.error()) continue;
    try {
      e.commit();
    } catch (err) {
      console.error('[cad] a typed value could not be applied', err);
    }
  }
  pendingEditsChanged();
}
