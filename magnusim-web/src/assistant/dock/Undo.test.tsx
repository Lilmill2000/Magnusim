// "Undo these changes" in the dock (phase 4 spec 8.3): offered while the workspace open here offers
// it, each answer in words, waiting while a request runs, and the Part's undo said to last only
// while it is open.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offerWorkspaceUndo, publishWorkspaceTools, resetWorkspaceToolsForTests, type WorkspaceToolsScope } from '../../workspace/assistantTools';
import type { TurnEvent } from '../wire';
import { addLocalTurn, resetDockStoreForTests, watchTurn } from './store';
import { applyEvents, emptyTurnView } from './turnView';
import { UndoChanges, undoLine } from './Undo';

vi.mock('../../api/eventHub', () => ({
  openChannel: () => ({ CONNECTING: 0, OPEN: 1, CLOSED: 2, readyState: 0, addEventListener() {}, removeEventListener() {}, close() {}, pin() {} }),
}));

const relay = vi.hoisted(() => ({ turns: [] as Array<{ id: string }>, listeners: new Set<() => void>() }));
vi.mock('../relay', () => ({
  relayTurnsSnapshot: () => relay.turns,
  subscribeRelayTurns: (fn: () => void) => {
    relay.listeners.add(fn);
    return () => relay.listeners.delete(fn);
  },
}));

const SCOPE: WorkspaceToolsScope = { project_id: 'p1', plugin: 'cad', workspace: 'part', title: 'Part 1', study_id: 's1' };
let seq = 0;
const ev = (x: Record<string, unknown>): TurnEvent => ({ seq: ++seq, at: 0, ...x }) as TurnEvent;
const cadTurn = (id: string) =>
  applyEvents(emptyTurnView(id), [
    ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'cad__extrude', title: 'Extrude', risk: 'edit', source: 'CAD', input_preview: '{}' }),
    ev({ type: 'tool_result', call: 'c1', ok: true, summary: 'Extruded', ms: 10 }),
    ev({ type: 'end', state: 'done', reason: 'done', message: null }),
  ]);

beforeEach(() => {
  resetWorkspaceToolsForTests();
  resetDockStoreForTests();
  relay.turns = [];
});
afterEach(() => {
  resetWorkspaceToolsForTests();
  resetDockStoreForTests();
});

describe('Undo these changes', () => {
  it('offered while the open workspace offers it; undone says how to redo, and the button goes', async () => {
    const run = vi.fn(async () => ({ undone: true }));
    act(() => offerWorkspaceUndo(SCOPE, 'f1', 't1', 'Assistant: Make a box', run));
    render(<UndoChanges view={cadTurn('t1')} />);
    const b = screen.getByRole('button', { name: 'Undo these changes' });
    expect(b.getAttribute('title')).toBe("Undo the Assistant's changes of this request in Part 1 (one step)");
    await act(async () => {
      fireEvent.click(b);
    });
    expect(run).toHaveBeenCalledWith('t1');
    // The frame withdraws the spent offer.
    act(() => offerWorkspaceUndo(SCOPE, 'f1', 't1', null, run));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Undone. Redo (Ctrl+Y) in Part 1 brings them back.')).toBeTruthy();
  });

  it('every answer in words', () => {
    expect([undoLine(undefined, true, 'Part 1'), undoLine('not_newest', false, 'Part 1'), undoLine('busy', false, 'Part 1'), undoLine('no_answer', false, 'Part 1'), undoLine('closed', false, 'Part 1')]).toEqual([
      'Undone. Redo (Ctrl+Y) in Part 1 brings them back.',
      "Something changed after this request, so its changes can't be undone as one step here. Use Undo in Part 1.",
      'Part 1 is busy; try again in a moment.',
      "Part 1 didn't answer. Its own Undo still works.",
      "Part 1 didn't answer. Its own Undo still works.",
    ]);
  });

  it('waits while a request runs in this tab, saying why', () => {
    relay.turns = [{ id: 't2' }];
    act(() => offerWorkspaceUndo(SCOPE, 'f1', 't-wait', 'Assistant: x', async () => ({ undone: true })));
    render(<UndoChanges view={cadTurn('t-wait')} />);
    const b = screen.getByRole('button', { name: 'Undo these changes' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Wait for the running request to end.');
    expect(document.querySelector('[data-dock-undo-wait]')?.textContent).toBe('Wait for the running request to end.');
  });

  it("a request this tab just started waits it too, before the relay's frame says it runs", () => {
    act(() => offerWorkspaceUndo(SCOPE, 'f1', 't-prev', 'Assistant: x', async () => ({ undone: true })));
    render(<UndoChanges view={cadTurn('t-prev')} />);
    const b = () => screen.getByRole('button', { name: 'Undo these changes' }) as HTMLButtonElement;
    expect(b().disabled).toBe(false);
    act(() => {
      watchTurn('t-new');
      addLocalTurn('c1', 't-new');
    });
    expect(b().disabled).toBe(true);
    expect(b().title).toBe('Wait for the running request to end.');
  });

  it('while the workspace is asked, the block says so', async () => {
    let answer: (a: { undone: boolean; reason?: string }) => void = () => undefined;
    const run = vi.fn(() => new Promise<{ undone: boolean; reason?: string }>((done) => (answer = done)));
    act(() => offerWorkspaceUndo(SCOPE, 'f1', 't-ask', 'Assistant: x', run));
    render(<UndoChanges view={cadTurn('t-ask')} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo these changes' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Asking Part 1 to undo them…');
    await act(async () => answer({ undone: false, reason: 'busy' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Part 1 is busy; try again in a moment.')).toBeTruthy();
  });

  it("no offer: a request that changed a Part says the undo lasts while it is open, once it isn't; a host-only request says nothing", () => {
    const { rerender, container } = render(<UndoChanges view={cadTurn('t-none')} />);
    expect(container.textContent).toBe('Undo lasts while the Part stays open.');
    act(() => {
      void publishWorkspaceTools(SCOPE, 'f1', { tools: [], guide: '' }, async () => ({ ok: true, result: {} }), null);
    });
    rerender(<UndoChanges view={cadTurn('t-none')} />);
    expect(container.textContent).toBe('');
    const hostOnly = applyEvents(emptyTurnView('t3'), [ev({ type: 'end', state: 'done', reason: 'done', message: null })]);
    rerender(<UndoChanges view={hostOnly} />);
    expect(container.textContent).toBe('');
  });
});
