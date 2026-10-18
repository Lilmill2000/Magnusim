// Snapshot undo/redo with structural sharing (the snapshots are frozen
// documents that share every unchanged part). Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { UndoEntry, UndoSnapshot, UndoStack } from '../types/undo';

export const UNDO_LIMIT = 100;

export function createUndoStack<T>(limit = UNDO_LIMIT): UndoStack<T> {
  let done: UndoEntry<T>[] = [];
  let undone: UndoEntry<T>[] = [];
  let version = 0;
  return {
    push(entry) {
      done.push(entry);
      if (done.length > limit) done = done.slice(done.length - limit);
      undone = [];
      version++;
    },
    undo() {
      const e = done.pop();
      if (!e) return null;
      undone.push(e);
      version++;
      return e.before;
    },
    redo() {
      const e = undone.pop();
      if (!e) return null;
      done.push(e);
      version++;
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
      version++;
    },
    get top() {
      return done.length ? done[done.length - 1] : null;
    },
    get version() {
      return version;
    },
    snapshot(): UndoSnapshot<T> {
      return Object.freeze({ done: Object.freeze(done.slice()), undone: Object.freeze(undone.slice()), version });
    },
    restore(s) {
      done = s.done.length > limit ? s.done.slice(s.done.length - limit) : s.done.slice();
      undone = s.undone.slice();
      version++;
    },
    dropTop() {
      const e = done.pop();
      if (!e) return null;
      version++;
      return e;
    },
  };
}
