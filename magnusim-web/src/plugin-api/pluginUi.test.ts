import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginUiFor, unregisterPlugin } from './index';
import { pluginFieldWidgets } from './fieldWidgets';
import * as kit from '../plugin-ui';
import type { FieldWidgetProps } from '../plugin-ui';

// The keys pluginUiFor() had before API 1.3: a minor version never removes one.
const KEYS_BEFORE_1_3 = [
  'registerStudySettings',
  'registerRunSettings',
  'SciNumberInput',
  'schema',
  'registerPanel',
  'replacePanel',
  'registerFilterWidget',
  'registerFieldWidget',
  'useProject',
  'useSimulation',
  'useJob',
  'useRegistry',
  'useViewer',
  'usePrefs',
  'SchemaForm',
  'registerTreeTransform',
  'panelsFor',
];

describe('pluginUi (API 1.3)', () => {
  const ui = pluginUiFor('pluginui-test');

  afterEach(() => {
    delete window.__CFD_PREFS__;
    delete window.__CFD_PROJECT_UNITS__;
    unregisterPlugin('pluginui-test');
  });

  it('keeps every key it had before 1.3', () => {
    for (const key of KEYS_BEFORE_1_3) expect(ui, key).toHaveProperty(key);
  });

  it('kit is the page copy of the kit itself', () => {
    expect(ui.kit).toBe(kit);
    expect(ui.kit.Button).toBe(kit.Button);
    expect(ui.kit.PLUGIN_UI_API_VERSION).toBe('1.0.0');
  });

  it('panelDone sends one cfd:panel-done', () => {
    const heard = vi.fn();
    window.addEventListener('cfd:panel-done', heard);
    try {
      ui.panelDone();
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('cfd:panel-done', heard);
    }
  });

  it('toast sends cfd:toast with the message (300 characters at most) and a known kind', () => {
    const seen: Array<{ message: string; kind: string }> = [];
    const heard = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('cfd:toast', heard);
    try {
      ui.toast('Saved', { kind: 'success' });
      ui.toast('Broken', { kind: 'error' });
      ui.toast('Plain');
      ui.toast('Odd', { kind: 'shout' as unknown as 'info' });
      ui.toast('x'.repeat(400));
    } finally {
      window.removeEventListener('cfd:toast', heard);
    }
    expect(seen.slice(0, 4)).toEqual([
      { message: 'Saved', kind: 'success' },
      { message: 'Broken', kind: 'error' },
      { message: 'Plain', kind: 'info' },
      { message: 'Odd', kind: 'info' },
    ]);
    expect(seen[4].message).toHaveLength(300);
    expect(seen[4].kind).toBe('info');
  });

  it('unitSystem follows the project units, else the Settings choice', () => {
    expect(ui.unitSystem()).toBe('metric');
    window.__CFD_PREFS__ = { units: 'imperial' };
    expect(ui.unitSystem()).toBe('imperial');
    window.__CFD_PROJECT_UNITS__ = () => 'metric';
    expect(ui.unitSystem()).toBe('metric');
  });

  it('registerFieldWidget stores the component it is given', () => {
    function Rate(p: FieldWidgetProps) {
      return p.label;
    }
    ui.registerFieldWidget('pluginui-test.rate', Rate);
    expect(pluginFieldWidgets()['plugin:pluginui-test.rate']).toBe(Rate);
  });
});
