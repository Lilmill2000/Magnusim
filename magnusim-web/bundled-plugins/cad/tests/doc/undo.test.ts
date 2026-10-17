// The undo stack: order, labels, redo cleared by a new step, the 100-step limit;
// tags, the newest step, the change counter, snapshots, restore and dropTop.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createUndoStack, UNDO_LIMIT } from '../../src/doc/undo';
import type { UndoEntry, UndoStack } from '../../src/types/undo';

function labels<T>(u: UndoStack<T>) {
  const s = u.snapshot();
  return { done: s.done.map((e) => e.label), undone: s.undone.map((e) => e.label) };
}

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

  it('carries a tag through undo and redo; top is the step Undo reverts', () => {
    const u = createUndoStack<number>();
    expect(u.top).toBeNull();
    u.push({ label: 'Box 1', before: 0, after: 1 });
    u.push({ label: 'Assistant: plate', before: 1, after: 2, tag: 'turn:t1' });
    expect(u.top).toEqual({ label: 'Assistant: plate', before: 1, after: 2, tag: 'turn:t1' });
    expect(u.undoLabel).toBe('Assistant: plate');
    expect(u.undo()).toBe(1);
    // The person's own step has no tag.
    expect(u.top).toEqual({ label: 'Box 1', before: 0, after: 1 });
    expect(u.top?.tag).toBeUndefined();
    expect(u.redo()).toBe(2);
    expect(u.top?.tag).toBe('turn:t1');
    expect(u.undo()).toBe(1);
    expect(u.undo()).toBe(0);
    expect(u.top).toBeNull();
  });

  it('version goes up once on every change and never on a no-op', () => {
    const u = createUndoStack<number>();
    expect(u.version).toBe(0);
    // Nothing to undo, redo or drop: no change.
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBeNull();
    expect(u.dropTop()).toBeNull();
    expect(u.version).toBe(0);
    u.push({ label: 'A', before: 0, after: 1 });
    expect(u.version).toBe(1);
    u.push({ label: 'B', before: 1, after: 2 });
    expect(u.version).toBe(2);
    u.undo();
    expect(u.version).toBe(3);
    u.redo();
    expect(u.version).toBe(4);
    // Reading the stack changes nothing.
    void u.top;
    void u.undoLabel;
    const s = u.snapshot();
    expect(u.version).toBe(4);
    u.dropTop();
    expect(u.version).toBe(5);
    u.restore(s);
    expect(u.version).toBe(6);
    u.clear();
    expect(u.version).toBe(7);
    // clear and restore count even when the lists were already as they leave them.
    u.clear();
    expect(u.version).toBe(8);
    u.restore(u.snapshot());
    expect(u.version).toBe(9);
    // A push past the limit is still one change.
    for (let i = 0; i < UNDO_LIMIT + 5; i++) u.push({ label: `s${i}`, before: i, after: i + 1 });
    expect(u.version).toBe(9 + UNDO_LIMIT + 5);
  });

  it('a snapshot is a frozen copy that later changes never touch, and records the version', () => {
    const u = createUndoStack<number>();
    u.push({ label: 'A', before: 0, after: 1 });
    u.push({ label: 'B', before: 1, after: 2, tag: 'turn:t1' });
    u.push({ label: 'C', before: 2, after: 3 });
    u.undo();
    const s = u.snapshot();
    expect(s.version).toBe(u.version);
    expect(s.done.map((e) => e.label)).toEqual(['A', 'B']);
    expect(s.undone.map((e) => e.label)).toEqual(['C']);
    expect(s.done[1].tag).toBe('turn:t1');
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.done)).toBe(true);
    expect(Object.isFrozen(s.undone)).toBe(true);
    expect(() => (s.done as UndoEntry<number>[]).push({ label: 'X', before: 0, after: 0 })).toThrow();

    // Every kind of change after the snapshot leaves it as it was.
    u.push({ label: 'D', before: 2, after: 4 });
    u.undo();
    u.undo();
    u.dropTop();
    u.clear();
    expect(s.done.map((e) => e.label)).toEqual(['A', 'B']);
    expect(s.undone.map((e) => e.label)).toEqual(['C']);
    expect(s.version).toBe(4);
  });

  it('restore puts both lists back exactly, and the same snapshot restores twice', () => {
    const u = createUndoStack<number>();
    u.push({ label: 'A', before: 0, after: 1 });
    u.push({ label: 'B', before: 1, after: 2 });
    u.push({ label: 'C', before: 2, after: 3 });
    u.undo();
    const s = u.snapshot();
    const entries = [...s.done, ...s.undone];

    // A run of changes after the mark: two new steps (which also clear redo) and an undo.
    u.push({ label: 'D', before: 2, after: 5 });
    u.push({ label: 'E', before: 5, after: 6, tag: 'turn:t1' });
    u.undo();
    expect(labels(u)).toEqual({ done: ['A', 'B', 'D'], undone: ['E'] });

    u.restore(s);
    expect(labels(u)).toEqual({ done: ['A', 'B'], undone: ['C'] });
    const back = u.snapshot();
    // The same entry objects, not copies of them.
    expect([...back.done, ...back.undone].every((e, i) => e === entries[i])).toBe(true);
    expect(u.canUndo).toBe(true);
    expect(u.canRedo).toBe(true);
    expect(u.undoLabel).toBe('B');
    expect(u.redoLabel).toBe('C');
    // Redo still works after a restore, and changes made after it don't reach the snapshot.
    expect(u.redo()).toBe(3);
    expect(u.undo()).toBe(2);
    expect(u.undo()).toBe(1);
    expect(labels(u)).toEqual({ done: ['A'], undone: ['C', 'B'] });
    expect(s.done.map((e) => e.label)).toEqual(['A', 'B']);

    u.restore(s);
    expect(labels(u)).toEqual({ done: ['A', 'B'], undone: ['C'] });
    expect(u.top?.label).toBe('B');
  });

  it('restoring an empty snapshot empties both lists', () => {
    const u = createUndoStack<number>();
    const empty = u.snapshot();
    u.push({ label: 'A', before: 0, after: 1 });
    u.push({ label: 'B', before: 1, after: 2 });
    u.undo();
    u.restore(empty);
    expect(u.canUndo).toBe(false);
    expect(u.canRedo).toBe(false);
    expect(u.top).toBeNull();
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBeNull();
  });

  it('restore keeps only the newest steps up to the limit', () => {
    const big = createUndoStack<number>(10);
    for (let i = 0; i < 8; i++) big.push({ label: `s${i}`, before: i, after: i + 1 });
    const small = createUndoStack<number>(5);
    small.restore(big.snapshot());
    expect(labels(small).done).toEqual(['s3', 's4', 's5', 's6', 's7']);
    let n = 0;
    while (small.undo() !== null) n++;
    expect(n).toBe(5);

    // A full stack snapshotted and restored keeps all 100 steps.
    const u = createUndoStack<number>();
    for (let i = 0; i < UNDO_LIMIT; i++) u.push({ label: `s${i}`, before: i, after: i + 1 });
    const s = u.snapshot();
    u.clear();
    u.restore(s);
    expect(u.snapshot().done.length).toBe(UNDO_LIMIT);
    expect(u.undoLabel).toBe(`s${UNDO_LIMIT - 1}`);
  });

  it('dropTop removes the newest step without making it redoable, and leaves redo alone', () => {
    const u = createUndoStack<number>();
    u.push({ label: 'A', before: 0, after: 1 });
    u.push({ label: 'B', before: 1, after: 2 });
    u.push({ label: 'C', before: 2, after: 3 });
    u.undo();
    const dropped = u.dropTop();
    expect(dropped).toEqual({ label: 'B', before: 1, after: 2 });
    expect(labels(u)).toEqual({ done: ['A'], undone: ['C'] });
    expect(u.top?.label).toBe('A');
    expect(u.redoLabel).toBe('C');
    expect(u.dropTop()?.label).toBe('A');
    expect(u.dropTop()).toBeNull();
    expect(u.canUndo).toBe(false);
    expect(u.canRedo).toBe(true);
  });

  it('restore, dropTop and push merge the steps since a mark into one tagged group', () => {
    // The recipe a sealed step uses: back to the mark, drop the same-tag group below
    // it when it ends where the mark began, then push one merged step.
    const u = createUndoStack<string>();
    u.push({ label: 'Box 1', before: 'd0', after: 'd1' });

    function seal(mark: ReturnType<typeof u.snapshot>, markDoc: string, tag: string, label: string) {
      const owned = u.snapshot().done.slice(mark.done.length);
      u.restore(mark);
      const below = u.top;
      let before = owned[0].before;
      if (below && below.tag === tag && below.after === markDoc) {
        before = below.before;
        u.dropTop();
      }
      u.push({ tag, label, before, after: owned[owned.length - 1].after });
    }

    // First call of a turn: two steps (a sketch and an extrude), sealed into one.
    let mark = u.snapshot();
    u.push({ label: 'Sketch 1', before: 'd1', after: 'd2' });
    u.push({ label: 'Extrude 1', before: 'd2', after: 'd3' });
    seal(mark, 'd1', 'turn:t1', 'Assistant: plate');
    expect(labels(u).done).toEqual(['Box 1', 'Assistant: plate']);
    expect(u.top).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', before: 'd1', after: 'd3' });

    // A second call of the same turn joins the group.
    mark = u.snapshot();
    u.push({ label: 'Fillet 1', before: 'd3', after: 'd4' });
    seal(mark, 'd3', 'turn:t1', 'Assistant: plate');
    expect(labels(u).done).toEqual(['Box 1', 'Assistant: plate']);
    expect(u.top).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', before: 'd1', after: 'd4' });

    // The person's own step between calls is never absorbed: the next call starts a new group.
    u.push({ label: 'Rename Body 1', before: 'd4', after: 'd5' });
    mark = u.snapshot();
    u.push({ label: 'Hole 1', before: 'd5', after: 'd6' });
    seal(mark, 'd5', 'turn:t1', 'Assistant: plate');
    expect(labels(u).done).toEqual(['Box 1', 'Assistant: plate', 'Rename Body 1', 'Assistant: plate']);
    expect(u.top).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', before: 'd5', after: 'd6' });

    // One Undo takes the whole group back; Redo brings it back.
    expect(u.undo()).toBe('d5');
    expect(u.undoLabel).toBe('Rename Body 1');
    expect(u.redo()).toBe('d6');
  });
});
