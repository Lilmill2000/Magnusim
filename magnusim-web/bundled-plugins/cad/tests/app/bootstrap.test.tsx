// The app starts inside a (fake) host: services, empty tree, kernel handshake.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

// three's WebGLRenderer needs WebGL, which jsdom lacks: the viewport has its own tests.
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({
    state: { get: () => ({ ready: true }), subscribe: () => () => {} },
    dispose() {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  setFakeConnection(null);
  document.body.innerHTML = '';
});

describe('bootstrap', () => {
  it('shows an honest error card outside the host', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    await act(async () => {
      expect(await bootstrap(root)).toBeNull();
    });
    expect(root.querySelector('[data-cad-fatal]')?.textContent).toMatch(/could not start.*Not inside a Magnusim workspace/);
  });

  it('connects, renders the empty tree and reaches kernel ready', async () => {
    const workers: FakeWorker[] = [];
    const ws = createFakeWorkspace({
      spawnWorker: () => {
        const w = new FakeWorker(okHandler());
        workers.push(w);
        w.ready();
        return w as unknown as Worker;
      },
    });
    setFakeConnection(ws);
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    let services: Awaited<ReturnType<typeof bootstrap>> = null;
    await act(async () => {
      services = await bootstrap(root);
    });
    expect(services).not.toBeNull();
    await vi.waitFor(() => expect(root.querySelector('[data-cad-app]')?.getAttribute('data-kernel')).toBe('ready'));
    expect(root.querySelector('[data-tree-empty="history"]')?.textContent).toBe('No features yet');
    expect([...root.querySelectorAll('[data-tree-node^="origin:"] .tl')].map((e) => e.textContent)).toEqual(['Top plane', 'Front plane', 'Right plane']);
    // Each area installed its commands: the toolbar shows only those that work, in the core's group order.
    const groups = [...root.querySelectorAll('[data-cad-toolbar] .tb-group-label')].map((e) => e.textContent);
    expect(groups).toEqual(['SOLID', 'MODIFY', 'VIEW', 'EDIT']);
    expect([...root.querySelectorAll('[data-cad-toolbar] [data-group="solid"] .tb-txt')].map((e) => e.textContent)).toEqual(['Box', 'Cylinder']);
    expect([...root.querySelectorAll('[data-cad-toolbar] [data-group="edit"] .tb-txt')].map((e) => e.textContent)).toEqual(['Undo', 'Redo']);
    expect(root.querySelector('[data-command="edit.undo"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('[data-chip="kernel"]')).toBeNull();
    expect(window.__CAD__?.snapshot().kernel.state).toBe('ready');
    expect(workers).toHaveLength(1);
  });
});
