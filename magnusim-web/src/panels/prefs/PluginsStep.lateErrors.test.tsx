// Settings → Plugins reads the plugin UIs that failed to load (the loader's client errors)
// when it renders and listens for new ones from an effect. A plugin UI that fails between
// the two (Settings opened while the page still loads plugin UIs) must still show: its row
// kept saying "On" with no error until something else recorded a failure.
import { createElement, Fragment, useEffect, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOnePlugin, subscribePluginClients } from '../../plugins/loader';
import { PluginsStep } from './PluginsStep';

vi.mock('../../api/workerRpc', () => ({ workerRpc: async () => ({}) }));

// Its register() throws; loaded once first, so the loader's import of it answers at once.
const BROKEN_UI = '/src/panels/prefs/brokenPluginUi.fixture.ts';
const LAMINAR = {
  key: 'example-laminar',
  name: 'example-laminar',
  version: '0.1.0',
  description: 'example-laminar does a thing',
  source: 'local',
  status: 'enabled',
  enabled: true,
};

/** The page's boot load of plugin UIs reaching this plugin right after Settings rendered. */
function Lands() {
  useLayoutEffect(() => {
    void loadOnePlugin({ ...LAMINAR, ui: 'index.js', url: BROKEN_UI }, '').catch(() => undefined);
  }, []);
  return null;
}

// Set once the step's passive effects (its subscriptions) have run.
let effectsRan = false;
function AfterEffects() {
  useEffect(() => {
    effectsRan = true;
  }, []);
  return null;
}

const row = () => document.querySelector('[data-plugin-key="example-laminar"]');
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeAll(async () => {
  await import(/* @vite-ignore */ BROKEN_UI);
});

beforeEach(() => {
  effectsRan = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, plugins: [LAMINAR] }), { status: 200 })),
  );
});

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('PluginsStep', () => {
  it('lists a plugin UI that failed between its first render and its subscription', async () => {
    // When the failure was recorded: before the step's effects had run (the forced timing).
    let recordedBeforeEffects: boolean | null = null;
    const stop = subscribePluginClients(() => {
      if (recordedBeforeEffects === null) recordedBeforeEffects = !effectsRan;
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(PluginsStep), createElement(Lands), createElement(AfterEffects)));
    await settle(() => row()?.getAttribute('data-plugin-status') === 'error');
    stop();
    expect(recordedBeforeEffects, 'the failure landed before the step subscribed').toBe(true);
    const li = row();
    expect(li, 'the plugin is listed').not.toBeNull();
    expect(li?.getAttribute('data-plugin-status'), `its row says: ${li?.textContent}`).toBe('error');
    expect(li?.querySelector('[role="alert"]')?.textContent).toBe('example-laminar UI: register() failed');
  });
});
