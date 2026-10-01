// Undo/redo of the model (never of view state, camera or selection).
// Owner: DOC-CORE (src/doc/undo.ts).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface UndoEntry<T> {
  /** "Box 1", "Rename Box 1", "Edit Cylinder 2" (shown as "Undo Box 1"). */
  label: string;
  before: T;
  after: T;
}

/**
 * Snapshot undo with structural sharing: one user action = one step, one drag =
 * one step, one panel session = one step. Limit 100 steps, in memory.
 */
export interface UndoStack<T> {
  push(entry: UndoEntry<T>): void;
  /** The state to restore, or null when there is nothing to undo. */
  undo(): T | null;
  redo(): T | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  clear(): void;
}
