// Undo from the app's Assistant panel, the page's store (src/workspace/assistantTools.ts; host
// API 1.9): each frame's undo offers in the snapshot by turn, the dock's
// undoWorkspaceTurn asking the frame that offers it, a frame that goes taking its offers, and the
// dock's own registration (setWorkspaceDock).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markWorkspaceFrameDead,
  offerWorkspaceUndo,
  resetWorkspaceToolsForTests,
  setWorkspaceDock,
  subscribeWorkspaceTools,
  undoWorkspaceTurn,
  withdrawWorkspaceTools,
  workspaceDock,
  workspaceToolsSnapshot,
  type WorkspaceToolsScope,
} from './assistantTools';

const SCOPE: WorkspaceToolsScope = { project_id: 'proj-a', plugin: 'ai-demo', workspace: 'counter', title: 'Counter', study_id: 'st-1' };

beforeEach(() => resetWorkspaceToolsForTests());
afterEach(() => resetWorkspaceToolsForTests());

describe("undo offers in the page's store (1.9)", () => {
  it('an offer shows in the snapshot by turn (a new snapshot each change); null from its frame withdraws it, from another frame does not', async () => {
    const heard = vi.fn();
    const off = subscribeWorkspaceTools(heard);
    const before = workspaceToolsSnapshot();
    expect(before.undo.size).toBe(0);
    const run = vi.fn(async () => ({ undone: true }));
    offerWorkspaceUndo(SCOPE, 'frame-1', 't-1', 'Assistant: add 2', run);
    const snap = workspaceToolsSnapshot();
    expect(snap).not.toBe(before);
    expect(snap.undo.get('t-1')).toEqual({ turn: 't-1', label: 'Assistant: add 2', frameId: 'frame-1', scope: SCOPE });
    expect(Object.isFrozen(snap.undo.get('t-1'))).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    // Another frame's null for the same turn leaves this frame's offer.
    offerWorkspaceUndo(SCOPE, 'frame-2', 't-1', null, run);
    expect(workspaceToolsSnapshot().undo.get('t-1')?.frameId).toBe('frame-1');
    offerWorkspaceUndo(SCOPE, 'frame-1', 't-1', null, run);
    expect(workspaceToolsSnapshot().undo.size).toBe(0);
    off();
  });

  it("undoWorkspaceTurn asks the frame that offers the turn (the newest offer of it), not_offered when none does, failed when that ask throws", async () => {
    const one = vi.fn(async () => ({ undone: false, reason: 'not_newest' }));
    const two = vi.fn(async () => ({ undone: true }));
    expect(await undoWorkspaceTurn('t-1')).toEqual({ undone: false, reason: 'not_offered' });
    offerWorkspaceUndo(SCOPE, 'frame-1', 't-1', 'One', one);
    expect(await undoWorkspaceTurn('t-1')).toEqual({ undone: false, reason: 'not_newest' });
    expect(one).toHaveBeenCalledWith('t-1');
    offerWorkspaceUndo(SCOPE, 'frame-2', 't-1', 'Two', two);
    expect(await undoWorkspaceTurn('t-1')).toEqual({ undone: true });
    expect(one).toHaveBeenCalledTimes(1);
    expect(await undoWorkspaceTurn('t-2')).toEqual({ undone: false, reason: 'not_offered' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    offerWorkspaceUndo(SCOPE, 'frame-2', 't-3', 'Three', async () => {
      throw new Error('the bridge broke');
    });
    expect(await undoWorkspaceTurn('t-3')).toEqual({ undone: false, reason: 'failed' });
    warn.mockRestore();
  });

  it("a frame that goes (withdrawn, or its plugin turned off) takes its offers with it, and a dead frame offers nothing; another frame's stay", async () => {
    const run = vi.fn(async () => ({ undone: true }));
    offerWorkspaceUndo(SCOPE, 'frame-1', 't-1', 'One', run);
    offerWorkspaceUndo(SCOPE, 'frame-1', 't-2', 'Two', run);
    offerWorkspaceUndo(SCOPE, 'frame-2', 't-3', 'Three', run);
    withdrawWorkspaceTools('frame-1');
    expect([...workspaceToolsSnapshot().undo.keys()]).toEqual(['t-3']);
    markWorkspaceFrameDead('frame-2', 'plugin_off');
    expect(workspaceToolsSnapshot().undo.size).toBe(0);
    offerWorkspaceUndo(SCOPE, 'frame-2', 't-4', 'Four', run);
    expect(workspaceToolsSnapshot().undo.size).toBe(0);
    expect(await undoWorkspaceTurn('t-1')).toEqual({ undone: false, reason: 'not_offered' });
    expect(run).not.toHaveBeenCalled();
  });

  it('setWorkspaceDock sets the dock; its clear function clears only that dock', () => {
    expect(workspaceDock()).toBeNull();
    const a = { key: vi.fn() };
    const b = { key: vi.fn() };
    const clearA = setWorkspaceDock(a);
    expect(workspaceDock()).toBe(a);
    const clearB = setWorkspaceDock(b);
    clearA();
    expect(workspaceDock()).toBe(b);
    clearB();
    expect(workspaceDock()).toBeNull();
  });
});
