import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantKeys, defaultAppKeys, resetAppKeysForTests } from './appKeys';
import { DEMO_COMMANDS, fakeKeysServer } from '../test/keybindsFake';
import { onPrefChange } from '../workspace/prefsChannel';
import {
  appKeyRows,
  appResetName,
  applyAppChange,
  applyChange,
  ASSISTANT_FROM,
  canResetAll,
  conflictsOf,
  hasOwnKeys,
  isDefault,
  keptOffText,
  KEYBINDS_PREF,
  keysOf,
  loadPluginKeys,
  planAppChange,
  planChange,
  refusalOf,
  resetAllKeys,
  resetEveryPlugin,
  SETTINGS_FROM,
  takerName,
  type PluginKeys,
} from './catalog';
import { displayCombo } from './combo';

afterEach(() => {
  vi.unstubAllGlobals();
  resetAppKeysForTests();
});

async function demo(prefs?: Record<string, unknown>): Promise<{ p: PluginKeys; server: ReturnType<typeof fakeKeysServer> }> {
  const server = fakeKeysServer({ prefs: prefs ? { demo: { [KEYBINDS_PREF]: prefs } } : {} });
  const { plugins, error } = await loadPluginKeys();
  expect(error).toBe('');
  expect(plugins.map((x) => x.plugin)).toEqual(['demo']);
  return { p: plugins[0], server };
}

/** Commands with Alt keys among their defaults: the Assistant panel's key can be one (never a key that types text). */
const ALT_DEMO = {
  version: 1,
  contexts: [
    { id: 'sketch', label: 'Sketch' },
    { id: 'model', label: 'Model' },
  ],
  commands: [
    { id: 'sketch.line', label: 'Line', group: 'Draw', context: 'sketch', keys: ['Alt+KeyL', 'KeyL'] },
    { id: 'sketch.arc', label: 'Arc', group: 'Draw', context: 'sketch', keys: ['KeyA'] },
    { id: 'model.extrude', label: 'Extrude', group: 'Features', context: 'model', keys: ['Alt+KeyE'] },
  ],
};
const ALT_OTHER = {
  version: 1,
  contexts: [{ id: 'mesh', label: 'Mesh' }],
  commands: [
    { id: 'mesh.refine', label: 'Refine', group: 'Mesh', context: 'mesh', keys: ['KeyR'] },
    { id: 'view.fit', label: 'Fit', group: 'View', context: 'any', keys: ['Alt+KeyL'] },
  ],
};

/**
 * Demo and Other on, with ALT_DEMO's and ALT_OTHER's commands and the person's keys `prefs` (by
 * plugin); `app`: the Assistant panel's keys the person chose, stored and on this page.
 */
async function altPlugins(opts: { prefs?: Record<string, Record<string, unknown>>; app?: Record<string, string[]> } = {}) {
  const ws = { key: 'part', title: 'Part', commands: 'workspace/commands.json', commands_error: '' };
  const server = fakeKeysServer({
    rows: [
      { key: 'demo', name: 'Demo', status: 'enabled', workspaces: [ws] },
      { key: 'other', name: 'Other', status: 'enabled', workspaces: [ws] },
    ],
    files: { '/plugins/demo/workspace/commands.json': ALT_DEMO, '/plugins/other/workspace/commands.json': ALT_OTHER },
    prefs: Object.fromEntries(Object.entries(opts.prefs ?? {}).map(([k, v]) => [k, { [KEYBINDS_PREF]: v }])),
    app: opts.app,
  });
  resetAppKeysForTests(opts.app ?? null);
  const { plugins, error } = await loadPluginKeys();
  expect(error).toBe('');
  expect(plugins.map((x) => x.plugin)).toEqual(['demo', 'other']);
  return { plugins, server };
}

/** The app refuses every write to `url` (POST); its reads still answer. */
function refuseWrites(server: ReturnType<typeof fakeKeysServer>, url: string): void {
  const serve = server.fetch.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === url && init?.method === 'POST' ? new Response(JSON.stringify({ ok: false, error: 'the prefs file is read-only' }), { status: 500 }) : serve(input, init),
  );
}

const APP_RESET = "Magnusim (the Assistant panel's key)";

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

  it('reads a key as people write it too ("shift+r"), as the CAD plugin reads them', async () => {
    const { p } = await demo({ 'sketch.rectangle': ['shift+r'], 'sketch.line': ['ctrl+w'] });
    expect(keysOf(p, 'sketch.rectangle')).toEqual(['Shift+KeyR']);
    // A browser's key, however written, is still none of the person's: the defaults.
    expect(keysOf(p, 'sketch.line')).toEqual(['KeyL']);
  });

  it('a checked change writes nothing when the keys moved before the write', async () => {
    const { p, server } = await demo();
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.line': ['KeyM'] } };
    const { result } = await applyChange(p, 'sketch.line', { action: 'set', combo: 'KeyK' }, undefined, ASSISTANT_FROM, (now) => keysOf(now, 'sketch.line')[0] === 'KeyL');
    expect(result).toMatchObject({ ok: false, code: 'changed' });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyM'] });
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
  it("names the app's keys, the browser's and the system's, and Escape (a command's own default only)", () => {
    expect(refusalOf('Ctrl+Slash')).toBe('"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)');
    expect(refusalOf('Ctrl+KeyW', displayCombo)).toBe('Ctrl+W is kept for the browser and the system (Close the tab)');
    expect(refusalOf('Escape')).toBe('"Escape" is the app\'s own key in dialogs, menus and modes (Close the open dialog, menu or mode): only a command\'s own default can be it');
    expect(refusalOf('Shift+KeyR')).toBe('');
  });

  it("names the Assistant panel's key the person chose as the app's own, in Settings' words or the validators'", () => {
    resetAppKeysForTests({ 'app.assistant': ['Alt+KeyK', 'F2'] });
    expect(refusalOf('Alt+KeyK', displayCombo)).toBe("Alt+K is the app's own key (Open or close the Assistant panel)");
    expect(refusalOf('Alt+KeyK')).toBe('"Alt+KeyK" is the app\'s own key (Open or close the Assistant panel)');
    expect(refusalOf('F2', displayCombo)).toBe("F2 is the app's own key (Open or close the Assistant panel)");
    // Its defaults stay the app's whatever the person chose.
    expect(refusalOf('Ctrl+Slash', displayCombo)).toBe("Ctrl+/ is the app's own key (Open or close the Assistant panel)");
    expect(refusalOf('Alt+KeyL')).toBe('');
    // With no key for the panel, a command may have the one it had.
    resetAppKeysForTests({ 'app.assistant': [] });
    expect(refusalOf('Alt+KeyK')).toBe('');
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

  it("Reset is refused while a default is the Assistant panel's key, even with Replace; so is Change to it", async () => {
    const { plugins } = await altPlugins({ prefs: { demo: { 'sketch.line': ['KeyK'], 'model.extrude': [] } }, app: { 'app.assistant': ['Alt+KeyL'] } });
    const [p] = plugins;
    const why = "Alt+L is the app's own key (Open or close the Assistant panel)";
    expect(planChange(p, 'sketch.line', { action: 'reset' }, displayCombo)).toEqual({ ok: false, code: 'refused', id: 'sketch.line', message: why });
    expect(planChange(p, 'sketch.line', { action: 'reset', replace: true }, displayCombo)).toEqual({ ok: false, code: 'refused', id: 'sketch.line', message: why });
    expect(planChange(p, 'sketch.line', { action: 'reset' })).toMatchObject({ message: '"Alt+KeyL" is the app\'s own key (Open or close the Assistant panel)' });
    expect(planChange(p, 'sketch.line', { action: 'set', combo: 'Alt+KeyL' }, displayCombo)).toEqual({ ok: false, code: 'refused', id: 'sketch.line', message: why });
    // A command none of whose defaults is the panel's key resets as before.
    expect(planChange(p, 'model.extrude', { action: 'reset' })).toMatchObject({ ok: true, patch: { 'model.extrude': null }, keys: ['Alt+KeyE'] });
    // Once the panel has another key, the defaults come back.
    resetAppKeysForTests({ 'app.assistant': ['F2'] });
    expect(planChange(p, 'sketch.line', { action: 'reset' })).toMatchObject({ ok: true, patch: { 'sketch.line': null }, keys: ['Alt+KeyL', 'KeyL'] });
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

  it('Reset all keybinds asks once, naming the plugins it changes, and resets each; nothing to reset asks nothing', async () => {
    const ws = { key: 'part', title: 'Part', commands: 'workspace/commands.json', commands_error: '' };
    const server = fakeKeysServer({
      rows: [
        { key: 'demo', name: 'Demo', status: 'enabled', workspaces: [ws] },
        { key: 'other', name: 'Other', status: 'enabled', workspaces: [ws] },
        { key: 'plain', name: 'Plain', status: 'enabled', workspaces: [ws] },
      ],
      files: Object.fromEntries(['demo', 'other', 'plain'].map((k) => [`/plugins/${k}/workspace/commands.json`, DEMO_COMMANDS])),
      prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['KeyK'] } }, other: { [KEYBINDS_PREF]: { 'view.fit': [] } }, plain: { [KEYBINDS_PREF]: { 'sketch.line': ['KeyL'] } } },
    });
    const asked: string[][] = [];
    const no = await resetEveryPlugin(async (names) => (asked.push(names), false));
    expect(no).toEqual({ asked: true, reset: [], failed: [], error: '', keptOff: '' });
    expect(asked).toEqual([['Demo', 'Other']]);
    expect(server.calls).toEqual([]);
    const yes = await resetEveryPlugin(async () => true);
    expect(yes).toEqual({ asked: true, reset: ['Demo', 'Other'], failed: [], error: '', keptOff: '' });
    expect([server.prefs.demo[KEYBINDS_PREF], server.prefs.other[KEYBINDS_PREF]]).toEqual([undefined, undefined]);
    // Plain's stored keys are its defaults: it is left as it is.
    expect(server.prefs.plain[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyL'] });
    const again = await resetEveryPlugin(async () => {
      throw new Error('asked with nothing to reset');
    });
    expect(again).toEqual({ asked: false, reset: [], failed: [], error: '', keptOff: '' });
  });

  it("Reset all keybinds says which plugin's keys could not be read", async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    const out = await resetEveryPlugin(async () => true);
    expect(out.asked).toBe(false);
    expect(out.failed).toEqual([{ name: 'Demo', why: 'its keys could not be read' }]);
  });

  it('a plugin list the app could not read is an error, never "no plugins"', async () => {
    const server = fakeKeysServer();
    server.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'worker RPC timeout' }), { status: 500 }));
    expect(await loadPluginKeys()).toEqual({ plugins: [], error: 'Could not read the plugin list: worker RPC timeout.' });
    server.fetch.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect((await loadPluginKeys()).error).toBe('Could not read the plugin list: the app answered 200.');
    // Reset all keybinds says so too, and asks nothing.
    const out = await resetEveryPlugin(async () => {
      throw new Error('asked');
    });
    expect(out).toMatchObject({ asked: false, error: 'Could not read the plugin list: the app answered 200.' });
  });

  it('a Replace leaves the other command its local key (Escape), and it reads back as its own', async () => {
    const server = fakeKeysServer({
      files: {
        '/plugins/demo/workspace/commands.json': {
          version: 1,
          contexts: [{ id: 'sketch', label: 'Sketch' }],
          commands: [
            { id: 'sketch.line', label: 'Line', group: '', context: 'sketch', keys: ['KeyL'] },
            { id: 'sketch.cancel', label: 'Stop drawing', group: '', context: 'sketch', keys: ['Escape', 'KeyQ'] },
          ],
        },
      },
    });
    const p = (await loadPluginKeys()).plugins[0];
    const { result, plugin } = await applyChange(p, 'sketch.line', { action: 'set', combo: 'KeyQ', replace: true });
    expect(result.ok).toBe(true);
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyQ'], 'sketch.cancel': ['Escape'] });
    expect(keysOf(plugin, 'sketch.cancel')).toEqual(['Escape']);
    expect(conflictsOf(plugin, 'sketch.line', 'KeyQ')).toEqual([]);
  });

  it("every write says who made it: Settings, or the Assistant's tools", async () => {
    const heard: { from: string }[] = [];
    const stop = onPrefChange((c) => heard.push(c));
    const { p } = await demo();
    await applyChange(p, 'sketch.line', { action: 'set', combo: 'KeyK' });
    await applyChange(p, 'model.extrude', { action: 'clear' }, undefined, ASSISTANT_FROM);
    await vi.waitFor(() => expect(heard.map((h) => h.from)).toEqual([SETTINGS_FROM, ASSISTANT_FROM]));
    expect(SETTINGS_FROM).not.toBe(ASSISTANT_FROM);
    stop();
  });

  it('Reset all drops every key of the plugin', async () => {
    const { p, server } = await demo({ 'sketch.line': ['KeyK'], 'later.command': ['KeyQ'] });
    const r = await resetAllKeys(p);
    expect(r).toMatchObject({ ok: true });
    expect(server.prefs.demo[KEYBINDS_PREF]).toBeUndefined();
    // Its keys are looked up by id: a command named like an object property has none of the person's.
    if (r.ok) expect([Object.getPrototypeOf(r.plugin.overrides), 'constructor' in r.plugin.overrides]).toEqual([null, false]);
  });
});

describe("Reset all and the Assistant panel's key", () => {
  it("Reset all keeps the panel's key off the commands whose default it is, and says which", async () => {
    const { plugins, server } = await altPlugins({ prefs: { demo: { 'sketch.line': ['KeyK'], 'sketch.arc': [] } }, app: { 'app.assistant': ['Alt+KeyL', 'Alt+KeyE'] } });
    const r = await resetAllKeys(plugins[0]);
    if (!r.ok) throw new Error(r.message);
    // Stored as the defaults less that key: Extrude, whose only default it is, has none.
    expect(server.calls).toEqual([['set', 'demo', { 'sketch.line': ['KeyL'], 'model.extrude': [] }]]);
    expect(r.keptOff.map((k) => [k.command.id, k.keys])).toEqual([
      ['sketch.line', ['Alt+KeyL']],
      ['model.extrude', ['Alt+KeyE']],
    ]);
    expect(['sketch.line', 'sketch.arc', 'model.extrude'].map((id) => keysOf(r.plugin, id))).toEqual([['KeyL'], ['KeyA'], []]);
    expect(keptOffText(r.keptOff, displayCombo)).toBe("Alt+L, Alt+E kept off Line, Extrude: the Assistant panel's key.");
  });

  it('the words name each key kept off once, and say nothing when none was', () => {
    const line = { id: 'sketch.line', label: 'Line', group: 'Draw', context: 'sketch', keys: ['Alt+KeyL', 'KeyL'] };
    const fit = { id: 'view.fit', label: 'Fit', group: 'View', context: 'any', keys: ['Alt+KeyL'] };
    expect(keptOffText([])).toBe('');
    expect(keptOffText([{ command: line, keys: ['Alt+KeyL'] }, { command: fit, keys: ['Alt+KeyL'] }], displayCombo)).toBe("Alt+L kept off Line, Fit: the Assistant panel's key.");
    expect(keptOffText([{ command: fit, keys: ['Alt+KeyL'] }])).toBe('"Alt+KeyL" kept off Fit: the Assistant panel\'s key.');
  });

  it("Reset all is offered only when it would change a key: the panel's key kept off is not one", async () => {
    // Line's own key is what a Reset all stores while the panel has Alt+L; Fit still has it as its default.
    const { plugins } = await altPlugins({ prefs: { demo: { 'sketch.line': ['KeyL'] } }, app: { 'app.assistant': ['Alt+KeyL'] } });
    const [demo, other] = plugins;
    expect(hasOwnKeys(demo)).toBe(true);
    expect(canResetAll(demo)).toBe(false);
    expect(canResetAll(other)).toBe(true);
    // With the panel's key back to its defaults, Line's default comes back whole.
    expect(canResetAll(demo, [])).toBe(true);
    expect(canResetAll(other, [])).toBe(false);
    resetAppKeysForTests();
    expect([canResetAll(demo), canResetAll(other)]).toEqual([true, false]);
  });
});

describe('appKeyRows', () => {
  it("lists the Assistant panel's key: its defaults, or the person's", () => {
    const defaults = defaultAppKeys('app.assistant');
    expect(defaults).toContain('Ctrl+Slash');
    const row = { id: 'app.assistant', label: 'Open or close the Assistant panel', group: 'Assistant', defaults };
    expect(appKeyRows()).toEqual([{ ...row, keys: defaults, isDefault: true }]);
    resetAppKeysForTests({ 'app.assistant': ['Alt+KeyK'] });
    expect(appKeyRows()).toEqual([{ ...row, keys: ['Alt+KeyK'], isDefault: false }]);
    resetAppKeysForTests({ 'app.assistant': [] });
    expect(appKeyRows()).toEqual([{ ...row, keys: [], isDefault: false }]);
  });
});

describe('planAppChange', () => {
  it('refuses a key that types text, one the browser or the system keeps, and Escape', () => {
    const set = (combo: string) => planAppChange([], 'app.assistant', { action: 'set', combo }, displayCombo);
    expect(set('KeyK')).toEqual({ ok: false, code: 'refused', id: 'app.assistant', message: "K types text: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)" });
    expect(set('Shift+KeyK')).toMatchObject({ code: 'refused', message: "Shift+K types text: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)" });
    expect(set('Ctrl+KeyW')).toMatchObject({ code: 'refused', message: 'Ctrl+W is kept for the browser and the system (Close the tab)' });
    expect(set('F5')).toMatchObject({ code: 'refused', message: 'F5 is kept for the browser and the system (Reload the page)' });
    expect(set('Escape')).toMatchObject({ code: 'refused', message: "Escape is the app's own key in dialogs, menus and modes (Close the open dialog, menu or mode)" });
    expect(planAppChange([], 'app.assistant', { action: 'set', combo: 'KeyK' })).toMatchObject({ code: 'refused', message: expect.stringMatching(/^"KeyK" types text: /) });
    // A function key, or a key with Ctrl or Alt, it can have.
    expect(set('F2')).toMatchObject({ ok: true, stored: ['F2'], keys: ['F2'] });
    expect(set('Ctrl+Shift+KeyK')).toMatchObject({ ok: true, stored: ['Ctrl+Shift+KeyK'] });
    expect(planAppChange([], 'app.close', { action: 'clear' })).toEqual({ ok: false, code: 'unknown', id: 'app.close', message: 'Magnusim has no key "app.close" that can be changed' });
  });

  it('one of its own defaults, Reset and Clear need no plugin read; a key a command may have does', async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    const { plugins } = await loadPluginKeys();
    expect(plugins[0].unread).not.toBe('');
    const defaults = defaultAppKeys('app.assistant');
    const none = new Map();
    // One of its defaults is stored as the defaults: they go by the character "/".
    expect(planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Ctrl+Slash' })).toEqual({ ok: true, stored: null, keys: defaults, took: [], patches: none });
    expect(planAppChange(plugins, 'app.assistant', { action: 'reset' })).toEqual({ ok: true, stored: null, keys: defaults, took: [], patches: none });
    expect(planAppChange(plugins, 'app.assistant', { action: 'clear' })).toEqual({ ok: true, stored: [], keys: [], took: [], patches: none });
    expect(planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' })).toEqual({ ok: false, code: 'unread', id: 'app.assistant', message: plugins[0].unread });
    // A key it can never have is refused all the same.
    expect(planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'KeyK' })).toMatchObject({ code: 'refused' });
  });

  it('a key a command of any plugin has, in any context, is a conflict naming each; Replace takes it from each', async () => {
    // Extrude has Alt+L besides its default.
    const { plugins } = await altPlugins({ prefs: { demo: { 'model.extrude': ['Alt+KeyE', 'Alt+KeyL'] } } });
    const conflict = planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL' }, displayCombo);
    expect(conflict).toMatchObject({
      ok: false,
      code: 'conflict',
      id: 'app.assistant',
      combo: 'Alt+KeyL',
      message: 'Alt+L is already the key of Demo · Line (Sketch), Demo · Extrude (Model), Other · Fit (Everywhere)',
    });
    if (conflict.ok || conflict.code !== 'conflict') throw new Error('not a conflict');
    expect(conflict.takers.map(takerName)).toEqual(['Demo · Line (Sketch)', 'Demo · Extrude (Model)', 'Other · Fit (Everywhere)']);
    const plan = planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true });
    if (!plan.ok) throw new Error(plan.message);
    expect([plan.stored, plan.keys]).toEqual([['Alt+KeyL'], ['Alt+KeyL']]);
    expect(plan.took.map((t) => [t.plugin.plugin, t.command.id, t.before, t.after])).toEqual([
      ['demo', 'sketch.line', ['Alt+KeyL', 'KeyL'], ['KeyL']],
      ['demo', 'model.extrude', ['Alt+KeyE', 'Alt+KeyL'], ['Alt+KeyE']],
      ['other', 'view.fit', ['Alt+KeyL'], []],
    ]);
    // Each plugin's patch: Extrude is left its default (none of the person's), Fit no key.
    expect([...plan.patches]).toEqual([
      ['demo', { 'sketch.line': ['KeyL'], 'model.extrude': null }],
      ['other', { 'view.fit': [] }],
    ]);
    // A key no command has takes nothing.
    expect(planAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' })).toEqual({ ok: true, stored: ['Alt+KeyK'], keys: ['Alt+KeyK'], took: [], patches: new Map() });
  });

  it('Magnusim CAD names itself in the words', () => {
    window.__MAGNUSIM_EDITION__ = 'cad';
    try {
      expect(planAppChange([], 'app.close', { action: 'clear' })).toMatchObject({ code: 'unknown', message: 'Magnusim CAD has no key "app.close" that can be changed' });
      expect(appResetName()).toBe("Magnusim CAD (the Assistant panel's key)");
    } finally {
      delete window.__MAGNUSIM_EDITION__;
    }
    expect(appResetName()).toBe(APP_RESET);
  });
});

describe('applyAppChange', () => {
  it("a Replace stores each plugin it takes the key from first, then the panel's key, each announced as who made it", async () => {
    const heard: { plugin: string; key: string; from: string }[] = [];
    const stop = onPrefChange((c) => heard.push(c));
    const { plugins, server } = await altPlugins({ prefs: { demo: { 'model.extrude': ['Alt+KeyE', 'Alt+KeyL'] } } });
    const out = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true }, undefined, ASSISTANT_FROM);
    expect(out.result).toMatchObject({ ok: true, id: 'app.assistant', keys: ['Alt+KeyL'] });
    expect(server.calls).toEqual([
      ['set', 'demo', { 'sketch.line': ['KeyL'] }],
      ['set', 'other', { 'view.fit': [] }],
      ['app', '', { 'app.assistant': ['Alt+KeyL'] }],
    ]);
    // The plugins as stored now, and the panel's key on this page: no command may have it now.
    expect([keysOf(out.plugins[0], 'sketch.line'), keysOf(out.plugins[0], 'model.extrude'), keysOf(out.plugins[1], 'view.fit')]).toEqual([['KeyL'], ['Alt+KeyE'], []]);
    expect(assistantKeys()).toEqual(['Alt+KeyL']);
    expect(refusalOf('Alt+KeyL', displayCombo)).toBe("Alt+L is the app's own key (Open or close the Assistant panel)");
    await vi.waitFor(() =>
      expect(heard.map((h) => `${h.plugin}/${h.key}/${h.from}`).sort()).toEqual([`/keybinds/${ASSISTANT_FROM}`, `demo/keybinds/${ASSISTANT_FROM}`, `other/keybinds/${ASSISTANT_FROM}`]),
    );
    stop();
  });

  it('Clear leaves the panel no key and Reset gives back its defaults, as Settings', async () => {
    const heard: { plugin: string; value: unknown; from: string }[] = [];
    const stop = onPrefChange((c) => heard.push(c));
    const { plugins, server } = await altPlugins({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const cleared = await applyAppChange(plugins, 'app.assistant', { action: 'clear' });
    expect(cleared.result).toEqual({ ok: true, id: 'app.assistant', keys: [], took: [] });
    expect([server.app, assistantKeys()]).toEqual([{ 'app.assistant': [] }, []]);
    const reset = await applyAppChange(plugins, 'app.assistant', { action: 'reset' });
    expect(reset.result).toEqual({ ok: true, id: 'app.assistant', keys: defaultAppKeys('app.assistant'), took: [] });
    expect([server.app, assistantKeys()]).toEqual([{}, null]);
    await vi.waitFor(() =>
      expect(heard).toEqual([
        { plugin: '', key: 'keybinds', value: { 'app.assistant': [] }, from: SETTINGS_FROM },
        { plugin: '', key: 'keybinds', value: {}, from: SETTINGS_FROM },
      ]),
    );
    stop();
  });

  it("after the person's Yes, nothing is written once a command's keys moved since the change was worked out", async () => {
    const { plugins, server } = await altPlugins();
    // Line lost its L elsewhere after the plugins were read.
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL'] } };
    const out = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true }, undefined, ASSISTANT_FROM, true);
    expect(out.result).toEqual({ ok: false, code: 'changed', id: 'app.assistant', message: 'The keys changed meanwhile; nothing more changed.' });
    expect(server.calls).toEqual([]);
    expect([server.app, assistantKeys()]).toEqual([{}, null]);
    expect(out.plugins).toEqual(plugins);
  });

  it("after the person's Yes, a later plugin whose keys moved stops the change there: the panel's key is not written", async () => {
    const { plugins, server } = await altPlugins();
    // Fit was given another key elsewhere after the plugins were read.
    server.prefs.other = { [KEYBINDS_PREF]: { 'view.fit': ['Alt+KeyF'] } };
    const out = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true }, undefined, ASSISTANT_FROM, true);
    expect(out.result).toMatchObject({ ok: false, code: 'changed', message: 'The keys changed meanwhile; nothing more changed.' });
    // Demo, written first, is as stored; Other and the panel are as they were.
    expect(server.calls).toEqual([['set', 'demo', { 'sketch.line': ['KeyL'] }]]);
    expect(server.prefs.other[KEYBINDS_PREF]).toEqual({ 'view.fit': ['Alt+KeyF'] });
    expect([server.app, assistantKeys()]).toEqual([{}, null]);
    expect(keysOf(out.plugins[0], 'sketch.line')).toEqual(['KeyL']);
    expect(out.plugins[1]).toBe(plugins[1]);
  });

  it("after the person's Yes, the panel's key is not written once it moved since; Settings' change is", async () => {
    const { plugins, server } = await altPlugins();
    // Set in another tab, not heard on this page yet.
    server.app = { 'app.assistant': ['F2'] };
    const checked = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' }, undefined, ASSISTANT_FROM, true);
    expect(checked.result).toEqual({ ok: false, code: 'changed', id: 'app.assistant', message: "The panel's key was not saved (the panel's key changed meanwhile); nothing changed." });
    expect([server.calls, server.app, assistantKeys()]).toEqual([[], { 'app.assistant': ['F2'] }, null]);
    const settings = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' });
    expect(settings.result).toMatchObject({ ok: true, keys: ['Alt+KeyK'] });
    expect([server.app, assistantKeys()]).toEqual([{ 'app.assistant': ['Alt+KeyK'] }, ['Alt+KeyK']]);
  });

  it('keys that cannot be read again before a write are said so, and nothing is written', async () => {
    const { plugins, server } = await altPlugins();
    server.failReads = true;
    const taking = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true });
    expect(taking.result).toEqual({ ok: false, code: 'unread', id: 'app.assistant', message: 'The keys could not be read: the plugin list is not available right now' });
    server.failReads = false;
    server.failAppReads = true;
    const own = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' }, undefined, ASSISTANT_FROM, true);
    expect(own.result).toEqual({ ok: false, code: 'unread', id: 'app.assistant', message: "The panel's key was not saved (the settings are not available right now); nothing changed." });
    expect([server.calls, assistantKeys()]).toEqual([[], null]);
  });

  it('a write the app refuses is said so: the panel keeps its key, and a refused Replace never reaches it', async () => {
    const { plugins, server } = await altPlugins({ app: { 'app.assistant': ['F2'] } });
    refuseWrites(server, '/api/prefs');
    const own = await applyAppChange(plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyK' });
    expect(own.result).toEqual({ ok: false, code: 'failed', id: 'app.assistant', message: "The panel's key was not saved (the prefs file is read-only); nothing changed." });
    expect([server.app, assistantKeys()]).toEqual([{ 'app.assistant': ['F2'] }, ['F2']]);

    const again = await altPlugins();
    refuseWrites(again.server, '/api/plugin-prefs/set');
    const taking = await applyAppChange(again.plugins, 'app.assistant', { action: 'set', combo: 'Alt+KeyL', replace: true });
    expect(taking.result).toEqual({ ok: false, code: 'failed', id: 'app.assistant', message: 'Could not save the keys: the prefs file is read-only' });
    expect([again.server.calls, again.server.app, assistantKeys()]).toEqual([[], {}, null]);
  });
});

describe("Reset all keybinds and the Assistant panel's key", () => {
  it("names the panel's key first and puts it back before the plugins, whose defaults come back whole", async () => {
    // As after the panel was given Alt+L with Replace: Line kept its other default, Fit has none.
    const { server } = await altPlugins({ prefs: { demo: { 'sketch.line': ['KeyL'] }, other: { 'view.fit': [] } }, app: { 'app.assistant': ['Alt+KeyL'] } });
    const asked: string[][] = [];
    const no = await resetEveryPlugin(async (names) => (asked.push(names), false));
    expect(no).toEqual({ asked: true, reset: [], failed: [], error: '', keptOff: '' });
    expect(asked).toEqual([[APP_RESET, 'Demo', 'Other']]);
    expect(appResetName()).toBe(APP_RESET);
    expect(server.calls).toEqual([]);
    const yes = await resetEveryPlugin(async () => true);
    expect(yes).toEqual({ asked: true, reset: [APP_RESET, 'Demo', 'Other'], failed: [], error: '', keptOff: '' });
    expect(server.calls).toEqual([
      ['app', '', {}],
      ['remove', 'demo', null],
      ['remove', 'other', null],
    ]);
    expect(assistantKeys()).toBeNull();
    const { plugins } = await loadPluginKeys();
    expect([keysOf(plugins[0], 'sketch.line'), keysOf(plugins[1], 'view.fit')]).toEqual([['Alt+KeyL', 'KeyL'], ['Alt+KeyL']]);
    const again = await resetEveryPlugin(async () => {
      throw new Error('asked with nothing to reset');
    });
    expect(again).toEqual({ asked: false, reset: [], failed: [], error: '', keptOff: '' });
  });

  it("asks about the panel's key as stored, though this page has not heard of it yet", async () => {
    const { server } = await altPlugins({ app: { 'app.assistant': ['F2'] } });
    resetAppKeysForTests();
    const asked: string[][] = [];
    const out = await resetEveryPlugin(async (names) => (asked.push(names), true));
    expect(asked).toEqual([[APP_RESET]]);
    expect(out).toEqual({ asked: true, reset: [APP_RESET], failed: [], error: '', keptOff: '' });
    expect(server.calls).toEqual([['app', '', {}]]);
  });

  it("when the panel's key could not be put back, the plugins are reset with it kept off their commands, and it says which", async () => {
    const { server } = await altPlugins({ prefs: { demo: { 'sketch.line': ['KeyK'] }, other: { 'view.fit': [] } }, app: { 'app.assistant': ['Alt+KeyL'] } });
    refuseWrites(server, '/api/prefs');
    const out = await resetEveryPlugin(async () => true);
    expect(out).toMatchObject({ asked: true, reset: ['Demo', 'Other'], failed: [{ name: APP_RESET, why: 'the prefs file is read-only' }], error: '' });
    expect(out.keptOff).toMatch(/ kept off Line, Fit: the Assistant panel's key\.$/);
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyL'] });
    expect(server.prefs.other[KEYBINDS_PREF]).toEqual({ 'view.fit': [] });
    expect([server.app, assistantKeys()]).toEqual([{ 'app.assistant': ['Alt+KeyL'] }, ['Alt+KeyL']]);
  });
});
