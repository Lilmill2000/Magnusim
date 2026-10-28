import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_COMMANDS, fakeKeysServer } from '../test/keybindsFake';
import { onPrefChange } from '../workspace/prefsChannel';
import {
  applyChange,
  conflictsOf,
  isDefault,
  KEYBINDS_PREF,
  keysOf,
  loadPluginKeys,
  planChange,
  refusalOf,
  resetAllKeys,
  SETTINGS_FROM,
  type PluginKeys,
} from './catalog';
import { displayCombo } from './combo';

afterEach(() => vi.unstubAllGlobals());

async function demo(prefs?: Record<string, unknown>): Promise<{ p: PluginKeys; server: ReturnType<typeof fakeKeysServer> }> {
  const server = fakeKeysServer({ prefs: prefs ? { demo: { [KEYBINDS_PREF]: prefs } } : {} });
  const { plugins, error } = await loadPluginKeys();
  expect(error).toBe('');
  expect(plugins.map((x) => x.plugin)).toEqual(['demo']);
  return { p: plugins[0], server };
}

describe('loadPluginKeys', () => {
  it('lists each plugin that is on and has commands, with what its files say', async () => {
    const ws = (key: string, commands: string, commands_error = '') => ({ key, title: key.toUpperCase(), entry: 'workspace/index.html', commands, commands_error });
    fakeKeysServer({
      rows: [
        { key: 'demo', name: 'Demo', status: 'enabled', workspaces: [ws('part', 'workspace/commands.json'), ws('plain', '')] },
        { key: 'off', name: 'Off', status: 'disabled', workspaces: [ws('part', 'workspace/commands.json')] },
        { key: 'none', name: 'None', status: 'enabled', workspaces: [ws('part', '')] },
        { key: 'bad', name: 'Bad', status: 'enabled', workspaces: [ws('a', 'workspace/bad.json'), ws('b', 'workspace/gone.json'), ws('c', 'workspace/text.json'), ws('d', '', 'workspace/x.json is missing')] },
      ],
      files: {
        '/plugins/demo/workspace/commands.json': DEMO_COMMANDS,
        '/plugins/off/workspace/commands.json': DEMO_COMMANDS,
        '/plugins/bad/workspace/bad.json': { version: 2, contexts: [], commands: [{ id: 'X', label: '', context: 'any', keys: [] }] },
        '/plugins/bad/workspace/text.json': 'not json',
      },
    });
    const { plugins } = await loadPluginKeys();
    expect(plugins.map((p) => p.plugin)).toEqual(['demo', 'bad']);
    const [demo, bad] = plugins;
    expect(demo.workspaces.map((w) => [w.workspace, w.commands.length, w.error])).toEqual([['part', 5, '']]);
    const errors = Object.fromEntries(bad.workspaces.map((w) => [w.workspace, w.error]));
    expect(errors.a).toBe('version must be 1, the format this host reads (and 2 more)');
    expect(errors.b).toBe('workspace/gone.json could not be read (the app answered 404)');
    expect(errors.c).toBe('workspace/text.json is not JSON');
    expect(errors.d).toBe('workspace/x.json is missing');
  });

  it('reads the person keys: known ids and valid combos only', async () => {
    const { p } = await demo({ 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': [], ghost: ['KeyG'], 'view.fit': ['Nope'] });
    expect({ ...p.overrides }).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': [] });
    expect(keysOf(p, 'view.fit')).toEqual(['KeyF']);
    expect(keysOf(p, 'sketch.rectangle')).toEqual(['Shift+KeyR']);
    expect(keysOf(p, 'sketch.line')).toEqual(['KeyL']);
    expect(isDefault(p, 'sketch.rectangle')).toBe(false);
    expect(isDefault(p, 'sketch.line')).toBe(true);
  });

  it('keys that cannot be read are said so, and no change is worked out from them', async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    const { plugins } = await loadPluginKeys();
    expect(plugins[0].unread).toMatch(/^Your keys for Demo could not be read: /);
    const plan = planChange(plugins[0], 'sketch.line', { action: 'set', combo: 'KeyK' });
    expect(plan).toMatchObject({ ok: false, code: 'unread' });
    expect(await resetAllKeys(plugins[0])).toMatchObject({ ok: false });
    expect(server.calls).toEqual([]);
  });
});

describe('refusalOf', () => {
  it("names the app's keys, the browser's and the system's, and the dialogs' Escape", () => {
    expect(refusalOf('Ctrl+Slash')).toBe('"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)');
    expect(refusalOf('Ctrl+KeyW', displayCombo)).toBe('Ctrl+W is kept for the browser and the system (Close the tab)');
    expect(refusalOf('Escape')).toBe('"Escape" is the app\'s own key in dialogs, menus and modes (Close the open dialog, menu or mode)');
    expect(refusalOf('Shift+KeyR')).toBe('');
  });
});

describe('planChange', () => {
  it('gives the command that one key, or refuses one the app keeps', async () => {
    const { p } = await demo();
    expect(planChange(p, 'sketch.line', { action: 'set', combo: 'Shift+KeyL' })).toEqual({ ok: true, patch: { 'sketch.line': ['Shift+KeyL'] }, keys: ['Shift+KeyL'], took: [] });
    expect(planChange(p, 'sketch.line', { action: 'set', combo: 'KeyL' })).toMatchObject({ ok: true, patch: { 'sketch.line': null } });
    expect(planChange(p, 'sketch.line', { action: 'set', combo: 'F5' })).toMatchObject({ ok: false, code: 'refused', message: '"F5" is kept for the browser and the system (Reload the page)' });
    expect(planChange(p, 'nope', { action: 'clear' })).toMatchObject({ ok: false, code: 'unknown', message: 'Demo has no command "nope"' });
  });

  it('a key another command has where the two meet is a conflict; Replace takes it', async () => {
    const { p } = await demo();
    // Sketch and model never meet: the same key is no conflict.
    expect(planChange(p, 'model.extrude', { action: 'set', combo: 'KeyR' })).toMatchObject({ ok: true, took: [] });
    // "any" meets every context.
    const conflict = planChange(p, 'sketch.line', { action: 'set', combo: 'KeyF' }, displayCombo);
    expect(conflict).toMatchObject({ ok: false, code: 'conflict', combo: 'KeyF', message: 'F is already the key of Fit (Everywhere)' });
    expect(conflictsOf(p, 'sketch.line', 'KeyR').map((c) => c.id)).toEqual(['sketch.rectangle']);
    const took = planChange(p, 'sketch.line', { action: 'set', combo: 'KeyR', replace: true });
    expect(took).toMatchObject({ ok: true, patch: { 'sketch.line': ['KeyR'], 'sketch.rectangle': [] } });
    expect(took.ok && took.took.map((c) => c.id)).toEqual(['sketch.rectangle']);
  });

  it('Reset puts the defaults back; a default taken meanwhile is a conflict unless Replace', async () => {
    const { p } = await demo({ 'edit.delete': ['KeyX'], 'sketch.line': ['Backspace'] });
    expect(planChange(p, 'edit.delete', { action: 'reset' })).toMatchObject({ ok: false, code: 'conflict', combo: 'Backspace' });
    const plan = planChange(p, 'edit.delete', { action: 'reset', replace: true });
    // Line is left with no key: its default (L) is not what it had.
    expect(plan).toMatchObject({ ok: true, patch: { 'edit.delete': null, 'sketch.line': [] }, keys: ['Delete', 'Backspace'] });
    expect(planChange(p, 'edit.delete', { action: 'clear' })).toMatchObject({ ok: true, patch: { 'edit.delete': [] }, keys: [] });
  });

  it('a Replace that takes two keys from one command keeps neither', async () => {
    const { p } = await demo({ 'edit.delete': [], 'view.fit': ['Delete', 'Backspace'] });
    const plan = planChange(p, 'edit.delete', { action: 'reset', replace: true });
    expect(plan).toMatchObject({ ok: true, patch: { 'edit.delete': null, 'view.fit': [] } });
  });
});

describe('applyChange', () => {
  it('reads the stored keys again and changes only the ids it touches', async () => {
    const { p, server } = await demo({ 'sketch.rectangle': ['Shift+KeyR'] });
    // Set elsewhere after Settings read them (the Part's Set keybind), and an id Settings doesn't list.
    server.prefs.demo[KEYBINDS_PREF] = { 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': ['KeyX'], 'later.command': ['KeyQ'] };
    const { result, plugin } = await applyChange(p, 'sketch.line', { action: 'set', combo: 'KeyK' });
    expect(result).toMatchObject({ ok: true, keys: ['KeyK'] });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': ['KeyX'], 'later.command': ['KeyQ'], 'sketch.line': ['KeyK'] });
    expect(keysOf(plugin, 'model.extrude')).toEqual(['KeyX']);
  });

  it('back to the defaults removes the pref, and every change is announced', async () => {
    const heard: unknown[] = [];
    const stop = onPrefChange((c) => heard.push(c));
    const { p, server } = await demo({ 'sketch.line': ['KeyK'] });
    const { result } = await applyChange(p, 'sketch.line', { action: 'reset' });
    expect(result.ok).toBe(true);
    expect(server.calls).toEqual([['remove', 'demo', null]]);
    await vi.waitFor(() => expect(heard).toEqual([{ plugin: 'demo', key: KEYBINDS_PREF, value: null, from: SETTINGS_FROM }]));
    stop();
  });

  it('two quick changes are stored one after the other: neither is lost', async () => {
    const { p, server } = await demo();
    const [a, b] = await Promise.all([applyChange(p, 'sketch.line', { action: 'set', combo: 'KeyK' }), applyChange(p, 'model.extrude', { action: 'clear' })]);
    expect(a.result.ok && b.result.ok).toBe(true);
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyK'], 'model.extrude': [] });
  });

  it('a write the app refuses is said so and changes nothing here', async () => {
    const { p, server } = await demo();
    server.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, value: null }), { status: 200 }));
    server.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, error: 'this plugin is not on' }), { status: 404 }));
    const { result, plugin } = await applyChange(p, 'sketch.line', { action: 'clear' });
    expect(result).toMatchObject({ ok: false, code: 'failed', message: 'Could not save the keys: this plugin is not on' });
    expect(plugin).toBe(p);
  });

  it('Reset all drops every key of the plugin', async () => {
    const { p, server } = await demo({ 'sketch.line': ['KeyK'], 'later.command': ['KeyQ'] });
    const r = await resetAllKeys(p);
    expect(r).toMatchObject({ ok: true });
    expect(server.prefs.demo[KEYBINDS_PREF]).toBeUndefined();
  });
});
