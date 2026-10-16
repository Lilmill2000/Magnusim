import { describe, expect, it, vi } from 'vitest';
import {
  PANEL_ID_ALIASES,
  panelsFor,
  placeHostOnlyPanel,
  pluginTreeNodes,
  pluginUi,
  pluginUiFor,
  registeredPluginKeys,
  replacePanel,
  unregisterPlugin,
  type PanelPlace,
} from './index';
import { islandComponent, unregisterIsland } from '../islands';
import { hasFieldWidget, pluginFieldWidgets } from './fieldWidgets';

const Blank = () => null;

// gate:h6-ui-ledger — what a plugin registers is recorded under its key, so a
// reload never doubles it and a disable removes it without a page reload.
describe('plugin UI ledger', () => {
  function registerDemo(ui: ReturnType<typeof pluginUiFor>) {
    ui.registerPanel({ key: 'ledger-demo', title: 'Demo', place: 'prefs', Component: Blank });
    ui.registerTreeTransform((nodes) => [...nodes, { label: 'Demo row', projectId: 'p1' }]);
    ui.registerFieldWidget('ledger-demo-widget', Blank);
  }

  it('a second register after unregister leaves exactly one of each', () => {
    for (let i = 0; i < 3; i += 1) {
      unregisterPlugin('ledger-demo');
      registerDemo(pluginUiFor('ledger-demo'));
    }
    expect(panelsFor('prefs').filter((p) => p.key === 'ledger-demo')).toHaveLength(1);
    expect(pluginTreeNodes('p1').filter((n) => n.label === 'Demo row')).toHaveLength(1);
    expect(pluginFieldWidgets()['plugin:ledger-demo-widget']).toBe(Blank);
    expect(registeredPluginKeys()).toContain('ledger-demo');
  });

  it('unregisterPlugin removes its panels, tree rows and field widgets', () => {
    unregisterPlugin('ledger-demo');
    registerDemo(pluginUiFor('ledger-demo'));
    unregisterPlugin('ledger-demo');
    expect(panelsFor('prefs').some((p) => p.key === 'ledger-demo')).toBe(false);
    expect(pluginTreeNodes('p1').some((n) => n.label === 'Demo row')).toBe(false);
    expect(hasFieldWidget('ledger-demo-widget')).toBe(false);
    expect(registeredPluginKeys()).not.toContain('ledger-demo');
  });

  it('a place the host never renders is an error, not a panel that silently never shows', () => {
    const ui = pluginUiFor('ledger-bad-place');
    expect(() =>
      ui.registerPanel({ key: 'x', title: 'X', place: 'toolbar' as unknown as PanelPlace, Component: Blank }),
    ).toThrow(/not rendered/);
    unregisterPlugin('ledger-bad-place');
  });

  it("replacePanel with the study panel's old id replaces panel-study-settings; unloading restores the host's", () => {
    const Host = () => null;
    const Probe = () => null;
    expect(PANEL_ID_ALIASES['panel-incompressible-defaults']).toBe('panel-study-settings');
    replacePanel('panel-study-settings', Host);
    try {
      pluginUiFor('ledger-old-id').replacePanel('panel-incompressible-defaults', Probe);
      expect(islandComponent('panel-study-settings')).toBe(Probe);
      expect(islandComponent('panel-incompressible-defaults')).toBeUndefined();
      unregisterPlugin('ledger-old-id');
      expect(islandComponent('panel-study-settings')).toBe(Host);
    } finally {
      unregisterPlugin('ledger-old-id');
      unregisterIsland('panel-study-settings');
    }
  });

  it("nothing but Magnusim's own registration replaces Settings → Assistant (the key field's panel)", () => {
    const Host = () => null;
    const Probe = () => null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    placeHostOnlyPanel('wiz-assistant', Host);
    try {
      // A plugin's own API.
      pluginUiFor('ledger-key-grab').replacePanel('wiz-assistant', Probe);
      expect(islandComponent('wiz-assistant')).toBe(Host);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('wiz-assistant'));
      unregisterPlugin('ledger-key-grab');
      expect(islandComponent('wiz-assistant')).toBe(Host);
      // The host-owned API the page puts on window (window.__CFD_PLUGIN_UI__)...
      pluginUi.replacePanel('wiz-assistant', Probe);
      expect(islandComponent('wiz-assistant')).toBe(Host);
      // ...and the host's replacePanel, which window.__CFD_REPLACE_PANEL__ calls.
      replacePanel('wiz-assistant', Probe);
      expect(islandComponent('wiz-assistant')).toBe(Host);
      // Magnusim's own registration (panels/register.ts) places it, and only host-only panels.
      placeHostOnlyPanel('wiz-assistant', Probe);
      expect(islandComponent('wiz-assistant')).toBe(Probe);
      expect(() => placeHostOnlyPanel('panel-geometry', Probe)).toThrow(/not a host-only panel/);
    } finally {
      warn.mockRestore();
      unregisterPlugin('ledger-key-grab');
      unregisterIsland('wiz-assistant');
    }
  });
});
