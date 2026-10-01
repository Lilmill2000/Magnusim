// Snapshot undo/redo with structural sharing (the snapshots are frozen
// documents that share every unchanged part). Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { UndoEntry, UndoStack } from '../types/undo';

export const UNDO_LIMIT = 100;

export function createUndoStack<T>(limit = UNDO_LIMIT): UndoStack<T> {
  let done: UndoEntry<T>[] = [];
  let undone: UndoEntry<T>[] = [];
  return {
    push(entry) {
      done.push(entry);
      if (done.length > limit) done = done.slice(done.length - limit);
      undone = [];
    },
    undo() {
      const e = done.pop();
      if (!e) return null;
      undone.push(e);
      return e.before;
    },
    redo() {
      const e = undone.pop();
      if (!e) return null;
      done.push(e);
      return e.after;
    },
    get canUndo() {
      return done.length > 0;
    },
    get canRedo() {
      return undone.length > 0;
    },
    get undoLabel() {
      return done.length ? done[done.length - 1].label : null;
    },
    get redoLabel() {
      return undone.length ? undone[undone.length - 1].label : null;
    },
    clear() {
      done = [];
      undone = [];
    },
  };
}
