// A plugin UI reload (each project switch, a plugin turned on or off, an install, the
// Reload button) loads every plugin's UI entry again: its old registration goes and the new
// one comes. Its FILTERS section and its Settings → Plugins panel must stay as they are,
// mounted once, with what was typed in them: drawn between the two (with no panel) they
// were unmounted and mounted again on every reload.
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiltersPanel } from '../chrome/FiltersPanel';
import { PluginsStep } from '../panels/prefs/PluginsStep';
import { unregisterPlugin } from '../plugin-api';
import { useProjectStore } from '../store/project';
import { loadOnePlugin } from './loader';

vi.mock('../api/workerRpc', () => ({ workerRpc: async () => ({}) }));

// Loaded once first, so the loader's import of it answers at once, as a cached module does.
const PROBE_UI = '/src/test/reloadedPluginUi.fixture.ts';
type Probe = typeof import('../test/reloadedPluginUi.fixture');
let probe: Probe;

const filtersDraft = () => document.querySelector<HTMLInputElement>('[data-filter-section] input[aria-label="Probe filter draft"]');
const prefsDraft = () => document.querySelector<HTMLInputElement>('[data-plugin-panel-host] input[aria-label="Probe settings draft"]');
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeAll(async () => {
  probe = (await import(/* @vite-ignore */ PROBE_UI)) as Probe;
});

beforeEach(() => {
  useProjectStore.setState({ projectId: 'proj', registry: { filter: [] } } as never);
  Object.assign(probe.counts, { filtersMounts: 0, filtersUnmounts: 0, prefsMounts: 0, prefsUnmounts: 0 });
  const row = { key: probe.KEY, name: 'Reload probe', version: '0.1.0', source: 'local', status: 'enabled', enabled: true, ui: 'index.js' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, plugins: [row] }), { status: 200 })),
  );
});

afterEach(() => {
  root?.unmount();
  root = null;
  unregisterPlugin(probe.KEY);
  useProjectStore.setState({ projectId: null, registry: null } as never);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('loadOnePlugin', () => {
  it("keeps a plugin's FILTERS section and Settings panel mounted, with their drafts, when its UI reloads", async () => {
    const plugin = { key: probe.KEY, status: 'enabled', enabled: true, ui: 'index.js', url: PROBE_UI };
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(FiltersPanel), createElement(PluginsStep)));
    await loadOnePlugin(plugin, 'p:proj');
    await settle(() => !!filtersDraft() && !!prefsDraft());
    expect(filtersDraft(), 'the FILTERS panel shows the plugin section').not.toBeNull();
    expect(prefsDraft(), "Settings → Plugins shows the plugin's panel").not.toBeNull();
    // The person types into both.
    filtersDraft()!.value = 'cut at x = 0.2';
    prefsDraft()!.value = 'my server';

    for (let i = 0; i < 3; i += 1) await loadOnePlugin(plugin, 'p:proj');
    await new Promise((r) => setTimeout(r, 50));

    expect(filtersDraft()?.value, 'the FILTERS section kept what was typed').toBe('cut at x = 0.2');
    expect(prefsDraft()?.value, 'the Settings panel kept what was typed').toBe('my server');
    expect(probe.counts).toEqual({ filtersMounts: 1, filtersUnmounts: 0, prefsMounts: 1, prefsUnmounts: 0 });
  });

  it('still removes the UI of a plugin turned off', async () => {
    const plugin = { key: probe.KEY, status: 'enabled', enabled: true, ui: 'index.js', url: PROBE_UI };
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(FiltersPanel));
    await loadOnePlugin(plugin, 'p:proj');
    await settle(() => !!filtersDraft());
    expect(filtersDraft()).not.toBeNull();
    await loadOnePlugin({ ...plugin, status: 'disabled', enabled: false }, 'p:proj');
    await settle(() => !filtersDraft());
    expect(filtersDraft(), 'the section of a plugin turned off is gone').toBeNull();
    expect(probe.counts.filtersUnmounts).toBe(1);
  });
});
