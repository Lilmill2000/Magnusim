// Undo/redo of the model (never of view state, camera or selection).
// Owner: DOC-CORE (src/doc/undo.ts).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface UndoEntry<T> {
  /** "Box 1", "Rename Box 1", "Edit Cylinder 2" (shown as "Undo Box 1"). */
  label: string;
  before: T;
  after: T;
  /** The group this step belongs to (for example one Assistant turn); absent on the person's own steps. */
  tag?: string;
}

/** Both lists as they were at one moment, for `UndoStack.restore`. The arrays are frozen copies. */
export interface UndoSnapshot<T> {
  readonly done: readonly UndoEntry<T>[];
  readonly undone: readonly UndoEntry<T>[];
  /** The stack's `version` when the snapshot was taken. */
  readonly version: number;
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
  /** The newest step (the one Undo reverts), or null when there is nothing to undo. */
  readonly top: UndoEntry<T> | null;
  /**
   * Counts changes to the history and never goes down: push, an undo or redo that
   * moved a step, clear, restore and a dropTop that removed a step each add one.
   */
  readonly version: number;
  /** Copies of both lists, unaffected by later changes. */
  snapshot(): UndoSnapshot<T>;
  /** Put both lists back as the snapshot holds them (the newest steps up to the limit); `version` still goes up. */
  restore(s: UndoSnapshot<T>): void;
  /** Remove the newest step without making it redoable; returns it, or null when there is none. */
  dropTop(): UndoEntry<T> | null;
}
