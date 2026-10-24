// Where the person is, as the dock reads it (phase 4 spec 3.3, 7): the workspace's tools and the intro.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PublishedTools } from '../../workspace/assistantTools';
import { CONNECTING_MS, useConnectingWindow, workspaceOf } from './context';
import { introOf } from './ConversationView';

const route = { projectId: 'p1', workspace: { plugin: 'cad', workspace: 'part' } };
const pub = (more: Partial<PublishedTools>): PublishedTools =>
  ({
    rev: 1,
    frameId: 'f',
    load: 0,
    scope: { project_id: 'p1', plugin: 'cad', workspace: 'part', title: 'Part', study_id: 's' },
    tools: [{ name: 'x' }],
    guide: '',
    review: null,
    invoke: async () => ({ ok: true, result: {} }),
    tellTurn: null,
    abandoned: false,
    dead: false,
    settled: true,
    taken: true,
    ...more,
  }) as unknown as PublishedTools;

describe('workspaceOf', () => {
  it('tools once the server took them; connecting while it registers (within the wait), late after; none when refused, dead or offering none', () => {
    expect(workspaceOf(route, pub({}), true)).toEqual({ plugin: 'cad', key: 'part', name: 'Part', state: 'tools' });
    expect(workspaceOf(route, pub({ settled: false, taken: false }), true)?.state).toBe('connecting');
    expect(workspaceOf(route, pub({ settled: false, taken: false }), false)?.state).toBe('late');
    expect(workspaceOf(route, null, true)).toEqual({ plugin: 'cad', key: 'part', name: 'part', state: 'connecting' });
    expect(workspaceOf(route, null, false)?.state).toBe('late');
    expect(workspaceOf(route, pub({ taken: false }), true)?.state).toBe('none');
    expect(workspaceOf(route, pub({ dead: true }), true)?.state).toBe('none');
    expect(workspaceOf(route, pub({ tools: [] }), true)?.state).toBe('none');
    expect(workspaceOf({ projectId: 'p1', workspace: null }, pub({}), true)).toBeNull();
    expect(workspaceOf({ projectId: null, workspace: null }, null, true)).toBeNull();
  });
});

describe('useConnectingWindow', () => {
  it('each opening of a workspace waits CONNECTING_MS: the same one opened again after Back waits again', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ k }) => useConnectingWindow(k), { initialProps: { k: 'p1/cad/part' } });
      expect(result.current).toBe(true);
      act(() => vi.advanceTimersByTime(CONNECTING_MS));
      expect(result.current).toBe(false);
      rerender({ k: '' });
      rerender({ k: 'p1/cad/part' });
      expect(result.current).toBe(true);
      act(() => vi.advanceTimersByTime(CONNECTING_MS - 1));
      expect(result.current).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('introOf', () => {
  it('Home, a project, a CAD Part, another workspace with tools', () => {
    const at = (projectId: string | null, ws: Parameters<typeof introOf>[0]['workspace'] = null) => introOf({ projectId, projectTitle: null, simulationId: null, workspace: ws });
    expect(at(null)).toMatch(/^Ask about your projects, or tell the Assistant what to simulate/);
    expect(at('p1')).toMatch(/^Tell the Assistant what to set up or run in this project/);
    expect(at('p1', { plugin: 'cad', key: 'part', name: 'Part 1', state: 'tools' })).toMatch(/^Tell the Assistant what to model in Part 1\./);
    expect(at('p1', { plugin: 'ai-demo', key: 'counter', name: 'Counter', state: 'tools' })).toBe('Tell the Assistant what to do in Counter.');
    expect(at('p1', { plugin: 'cad', key: 'part', name: 'Part 1', state: 'none' })).toMatch(/^Tell the Assistant what to set up or run in this project/);
  });
});
