import { describe, expect, it } from 'vitest';
import { panelsFor, pluginTreeNodes, pluginUiFor, registeredPluginKeys, unregisterPlugin, type PanelPlace } from './index';
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
});
