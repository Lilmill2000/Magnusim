// Settings → Plugins draws each plugin's own settings panel (registerPanel, place "prefs")
// in that plugin's row. A panel registered or removed while the list is on screen (the
// plugin's UI loading late, a reload, the plugin turned off) shows or goes at once.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginUiFor, unregisterPlugin } from '../../plugin-api';
import { PluginsStep } from './PluginsStep';

vi.mock('../../api/workerRpc', () => ({ workerRpc: async () => ({}) }));

const KEY = 'example-laminar';
const LAMINAR = { key: KEY, name: 'example-laminar', version: '0.1.0', source: 'local', status: 'enabled', enabled: true };

const row = () => document.querySelector(`[data-plugin-key="${KEY}"]`);
const panel = () => row()?.querySelector(`[data-plugin-panel-host="${KEY}"]`) || null;
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, plugins: [LAMINAR] }), { status: 200 })),
  );
});

afterEach(() => {
  root?.unmount();
  root = null;
  unregisterPlugin(KEY);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('PluginsStep', () => {
  it("shows a plugin's settings panel registered while the list is on screen, and drops it when its UI goes", async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(PluginsStep));
    await settle(() => !!row());
    expect(row(), 'the plugin is listed').not.toBeNull();
    // The list has settled: nothing else re-renders it.
    await new Promise((r) => setTimeout(r, 50));
    expect(panel()).toBeNull();

    pluginUiFor(KEY).registerPanel({
      key: KEY,
      title: 'Laminar settings',
      place: 'prefs',
      Component: function LaminarSettings() {
        return createElement('p', null, 'Laminar server: local');
      },
    });
    await settle(() => !!panel());
    expect(panel()?.textContent, "the plugin's row shows its panel").toBe('Laminar server: local');

    unregisterPlugin(KEY);
    await settle(() => !panel());
    expect(panel(), 'the panel goes with its UI').toBeNull();
    expect(row(), 'the row stays').not.toBeNull();
  });
});
