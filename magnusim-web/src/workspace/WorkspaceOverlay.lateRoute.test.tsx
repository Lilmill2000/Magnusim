// The workspace overlay reads the page's route from the address when it renders and listens
// for hashchange from an effect. An address change that lands between the two (a workspace
// link opened while the page boots) must still open the workspace: the overlay stayed shut
// on the project, with the address on the workspace, until the next address change.
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/project';
import { WorkspaceOverlay } from './WorkspaceOverlay';

const PROJECT_HASH = '#/p/proj';
const WS_HASH = '#/p/proj/ws/ws-demo/bench/st-1';

const overlay = () => document.getElementById('workspace-overlay') as HTMLElement;
const header = () => overlay().querySelector('[data-workspace-header="1"]');

let openAtChange: boolean | null = null;
/** The address moving to the workspace right after the overlay rendered, before its passive effects ran. */
function Lands() {
  useLayoutEffect(() => {
    openAtChange = !!header();
    const oldURL = location.href;
    history.replaceState(null, '', WS_HASH);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
  }, []);
  return null;
}

const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><div id="workspace-overlay" hidden></div></div>';
  history.replaceState(null, '', PROJECT_HASH);
  useProjectStore.setState({ projectId: 'proj' });
  openAtChange = null;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/plugins') {
        return json({
          plugins: [{ key: 'ws-demo', name: 'Workspace demo', status: 'enabled', workspaces: [{ key: 'bench', title: 'Bench', entry: 'workspace/index.html' }] }],
        });
      }
      if (url.startsWith('/api/plugin-studies/get')) return json({ study: { id: 'st-1', plugin: 'ws-demo', kind: 'section', title: 'Wing section' } });
      if (url.startsWith('/api/plugin-studies?')) return json({ studies: [] });
      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  useProjectStore.setState({ projectId: null });
  history.replaceState(null, '', '#/');
  document.body.innerHTML = '';
});

describe('WorkspaceOverlay', () => {
  it('opens the workspace the address moved to between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(WorkspaceOverlay), createElement(Lands)));
    await settle(() => !!header() && !overlay().hidden);
    // The timing was forced: the overlay was shut on the project when the address moved.
    expect(openAtChange).toBe(false);
    expect(location.hash).toBe(WS_HASH);
    expect(overlay().hidden, 'the workspace overlay is open').toBe(false);
    expect(header()?.querySelector('.ws-plugin')?.textContent).toBe('Workspace demo');
  });
});
