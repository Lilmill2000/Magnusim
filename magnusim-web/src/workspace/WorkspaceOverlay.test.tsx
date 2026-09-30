import { describe, expect, it } from 'vitest';
import { pluginNotReady } from './WorkspaceOverlay';

describe('a workspace whose plugin is not on says why', () => {
  it('names the state Settings → Plugins shows', () => {
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'disabled' })).toMatchObject({
      title: 'Workspace demo is off.',
      retry: true,
    });
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'needs setup' }).title).toBe('Workspace demo needs setup.');
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'error', error: 'manifest: bad icon' })).toMatchObject({
      title: 'Workspace demo did not load.',
      detail: 'manifest: bad icon',
    });
    expect(pluginNotReady('ws-demo', null)).toMatchObject({ title: 'The ws-demo plugin is not installed.', retry: false });
  });
});
