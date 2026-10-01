// The undo stack: order, labels, redo cleared by a new step, the 100-step limit.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createUndoStack, UNDO_LIMIT } from '../../src/doc/undo';

describe('undo stack', () => {
  it('undoes and redoes in order with labels; a new step clears redo', () => {
    const u = createUndoStack<number>();
    expect(u.canUndo).toBe(false);
    expect(u.undo()).toBeNull();
    u.push({ label: 'A', before: 0, after: 1 });
    u.push({ label: 'B', before: 1, after: 2 });
    expect(u.undoLabel).toBe('B');
    expect(u.undo()).toBe(1);
    expect(u.redoLabel).toBe('B');
    expect(u.undo()).toBe(0);
    expect(u.canUndo).toBe(false);
    expect(u.redo()).toBe(1);
    u.push({ label: 'C', before: 1, after: 3 });
    expect(u.canRedo).toBe(false);
    expect(u.redo()).toBeNull();
    expect(u.undoLabel).toBe('C');
  });

  it('keeps the last 100 steps', () => {
    expect(UNDO_LIMIT).toBe(100);
    const u = createUndoStack<number>();
    for (let i = 0; i < 150; i++) u.push({ label: `s${i}`, before: i, after: i + 1 });
    let n = 0;
    let last: number | null = null;
    for (let v = u.undo(); v !== null; v = u.undo()) {
      n++;
      last = v;
    }
    expect(n).toBe(100);
    expect(last).toBe(50);
  });
});
