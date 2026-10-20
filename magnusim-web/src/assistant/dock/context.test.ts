// Where the person is, as the dock reads it (phase 4 spec 3.3, 7): the workspace's tools and the intro.
import { describe, expect, it } from 'vitest';
import type { PublishedTools } from '../../workspace/assistantTools';
import { workspaceOf } from './context';
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

describe('introOf', () => {
  it('Home, a project, a CAD Part, another workspace with tools', () => {
    const at = (projectId: string | null, ws: Parameters<typeof introOf>[0]['workspace'] = null) => introOf({ projectId, projectTitle: null, simulationId: null, workspace: ws });
    expect(at(null)).toMatch(/^Ask about Magnusim/);
    expect(at('p1')).toMatch(/^The Assistant can read this project/);
    expect(at('p1', { plugin: 'cad', key: 'part', name: 'Part 1', state: 'tools' })).toMatch(/^Tell the Assistant what to model in Part 1\./);
    expect(at('p1', { plugin: 'ai-demo', key: 'counter', name: 'Counter', state: 'tools' })).toBe('Tell the Assistant what to do in Counter.');
    expect(at('p1', { plugin: 'cad', key: 'part', name: 'Part 1', state: 'none' })).toMatch(/^The Assistant can read this project/);
  });
});
