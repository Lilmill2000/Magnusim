import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantKeys, defaultAppKeys, refreshAppKeys, resetAppKeysForTests } from '../keybinds/appKeys';
import { ASSISTANT_FROM, KEYBINDS_PREF, loadPluginKeys } from '../keybinds/catalog';
import { onPrefChange, type PrefChange } from '../workspace/prefsChannel';
import { DEMO_COMMANDS, fakeKeysServer } from '../test/keybindsFake';
import type { AssistantInvoke } from '../workspace/bridge';
import { coreKeybinds, coreSetKeybind, SET_IN, type KeysRuntime } from './keybindTools';

afterEach(() => {
  vi.unstubAllGlobals();
  resetAppKeysForTests();
});

/** The page's runtime with the person's answer to each confirm, and what each one asked. */
function runtime(answer: boolean | (() => boolean)) {
  const asked: { title: string; copy: string; yes: string }[] = [];
  const rt: KeysRuntime = {
    load: loadPluginKeys,
    refreshApp: refreshAppKeys,
    confirm: async (o) => {
      asked.push({ title: o.title, copy: o.copy, yes: o.yes });
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return { rt, asked };
}

function invoke(input: Record<string, unknown>) {
  const progress: [string, boolean][] = [];
  const req = {
    tool: 'set_keybind',
    input,
    signal: new AbortController().signal,
    onProgress: (_f: number | null, label: string, o?: { waiting?: boolean }) => progress.push([label, !!o?.waiting]),
    onAlive: () => {},
  } as unknown as AssistantInvoke;
  return { req, progress };
}

const set = (o: Record<string, unknown>) => ({ plugin: 'demo', command: '', action: 'set', keys: '', replace: false, person_asked: true, ...o });

type Row = { id: string; shown: string[] };
/** core__keybinds' answer, as far as these tests read it. */
type KeysData = {
  set_in: string;
  app: { keys: Row[] };
  reserved: { keys: Row[] };
  plugins: { workspaces: { commands: Row[] }[] }[];
};
const dataOf = (out: Awaited<ReturnType<typeof coreKeybinds>>) => (out.ok ? (out.result.data as KeysData) : null);

/** core__keybinds' answer for plugin "app". */
type AppKeysData = { app: { name: string; keys: (Row & Record<string, unknown>)[] }; set_in: string; plugins?: unknown };
const appDataOf = (out: Awaited<ReturnType<typeof coreKeybinds>>) => (out.ok ? (out.result.data as AppKeysData) : null);

/** The Assistant panel's own key, as core__set_keybind names it. */
const panel = (o: Record<string, unknown>) => set({ plugin: 'app', command: 'app.assistant', ...o });
/** How the question names the panel's key. */
const PANEL = 'Magnusim · Open or close the Assistant panel';
const CHANGED = 'The keybinds changed while the person was asked (in Settings, a workspace or another tab); nothing changed.';
const panelKeyRefusal = (k: string) => `"${k}" is the app's own key (Open or close the Assistant panel)`;

/** Demo with a command whose default is Alt+K, a key the person may choose for the panel. */
const MEASURE_FILES = {
  '/plugins/demo/workspace/commands.json': {
    version: 1,
    contexts: [{ id: 'sketch', label: 'Sketch' }],
    commands: [
      { id: 'sketch.line', label: 'Line', group: 'Draw', context: 'sketch', keys: ['KeyL'] },
      { id: 'tool.measure', label: 'Measure', group: 'Tools', context: 'any', keys: ['Alt+KeyK', 'KeyM'] },
    ],
  },
};

/** Two plugins on, Demo and Other, with the same commands. */
const TWO_PLUGINS = {
  rows: [
    ['demo', 'Demo'],
    ['other', 'Other'],
  ].map(([key, name]) => ({
    key,
    name,
    status: 'enabled',
    workspaces: [{ key: 'part', title: 'Part', entry: 'workspace/index.html', commands: 'workspace/commands.json', commands_error: '' }],
  })),
  files: { '/plugins/demo/workspace/commands.json': DEMO_COMMANDS, '/plugins/other/workspace/commands.json': DEMO_COMMANDS },
};

describe('core__keybinds', () => {
  it("reads the app's keys and each plugin's commands, with where the person sets them", async () => {
    fakeKeysServer({ prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Shift+KeyL'] } } } });
    const out = await coreKeybinds({ plugin: '', target: '' }, runtime(true).rt);
    const data = dataOf(out)!;
    expect(data.set_in).toBe(SET_IN);
    expect(data.app.keys.find((k) => k.id === 'app.assistant')?.shown).toContain('Ctrl+/');
    expect(data.reserved.keys.map((k) => k.id)).toContain('browser.close-tab');
    const line = data.plugins[0].workspaces[0].commands.find((c) => c.id === 'sketch.line');
    expect(line).toEqual({ id: 'sketch.line', label: 'Line', group: 'Draw', workspace: 'part', where: 'Sketch', keys: ['Shift+KeyL'], shown: ['Shift+L'], defaults: ['KeyL'], is_default: false });
  });

  it('names one plugin or command by id or label, and says when there is none', async () => {
    fakeKeysServer();
    const { rt } = runtime(true);
    const one = await coreKeybinds({ plugin: 'Demo', target: 'rectangle' }, rt);
    expect(dataOf(one)?.plugins[0].workspaces[0].commands.map((c) => c.id)).toEqual(['sketch.rectangle']);
    expect(await coreKeybinds({ plugin: 'nope', target: '' }, rt)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await coreKeybinds({ plugin: '', target: 'teleport' }, rt)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it("lists the Assistant panel's key as one the person can change, with the keys they chose as stored; the app's other keys are shown only", async () => {
    // Stored by Settings or another tab: this page has not read it yet.
    const server = fakeKeysServer({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt } = runtime(true);
    const data = dataOf(await coreKeybinds({ plugin: '', target: '' }, rt))!;
    expect(data.app.keys.find((k) => k.id === 'app.assistant')).toEqual({
      id: 'app.assistant',
      label: 'Open or close the Assistant panel',
      where: 'Everywhere',
      keys: ['Alt+KeyK'],
      shown: ['Alt+K'],
      defaults: defaultAppKeys('app.assistant'),
      is_default: false,
      changeable: true,
    });
    expect(data.app.keys.find((k) => k.id === 'app.close')).toEqual({ id: 'app.close', label: 'Close the open dialog, menu or mode', keys: ['Escape'], shown: ['Escape'] });
    // No key at all, then its defaults again.
    server.app = { 'app.assistant': [] };
    expect(dataOf(await coreKeybinds({ plugin: '', target: '' }, rt))!.app.keys[0]).toMatchObject({ id: 'app.assistant', keys: [], shown: [], is_default: false, changeable: true });
    server.app = {};
    const back = dataOf(await coreKeybinds({ plugin: '', target: '' }, rt))!.app.keys[0];
    expect(back).toMatchObject({ id: 'app.assistant', keys: defaultAppKeys('app.assistant'), is_default: true, changeable: true });
    expect(back.shown).toContain('Ctrl+/');
  });

  it('plugin "app" (or the app\'s name) lists the app\'s keys alone; a target names one by id or label, and none is not_found', async () => {
    fakeKeysServer({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt } = runtime(true);
    const all = await coreKeybinds({ plugin: 'app', target: '' }, rt);
    expect(all).toMatchObject({ ok: true, result: { summary: 'Keys of Magnusim' } });
    const data = appDataOf(all)!;
    expect(data.app.name).toBe('Magnusim');
    expect(data.app.keys.map((k) => k.id)).toEqual(['app.assistant', 'app.close']);
    expect(data.set_in).toBe(SET_IN);
    expect(data.plugins).toBeUndefined();
    const byLabel = appDataOf(await coreKeybinds({ plugin: 'app', target: 'open or close the assistant panel' }, rt))!;
    expect(byLabel.app.keys).toEqual([expect.objectContaining({ id: 'app.assistant', keys: ['Alt+KeyK'], shown: ['Alt+K'], changeable: true })]);
    const byId = appDataOf(await coreKeybinds({ plugin: 'APP', target: 'app.close' }, rt))!;
    expect(byId.app.keys.map((k) => k.id)).toEqual(['app.close']);
    expect(await coreKeybinds({ plugin: 'app', target: 'teleport' }, rt)).toMatchObject({ ok: false, code: 'not_found', message: 'Magnusim has no key "teleport".' });
  });
});

describe('core__set_keybind', () => {
  it('changes nothing unless the person asked for it in this request', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(true);
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'K', person_asked: false }), invoke({}).req, rt);
    expect(out).toMatchObject({ ok: false, code: 'not_asked', hint: SET_IN });
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it('asks the person every time; their No changes nothing', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(false);
    const { req, progress } = invoke({});
    const out = await coreSetKeybind(set({ command: 'Line', keys: 'shift+k' }), req, rt);
    expect(out).toMatchObject({ ok: false, code: 'step_declined' });
    expect(asked).toEqual([{ title: 'Change a keybind?', copy: 'Demo · Line (sketch): L → Shift+K', yes: 'Change' }]);
    // The call waits for the person meanwhile (the turn's minutes stop).
    expect(progress[0]).toEqual(['Waiting for you to confirm the keybind change', true]);
    expect(server.calls).toEqual([]);
  });

  it('on the Yes it stores the change as Settings does, and answers the keys now', async () => {
    const server = fakeKeysServer();
    const { rt } = runtime(true);
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'Shift+K' }), invoke({}).req, rt);
    expect(out).toMatchObject({ ok: true, result: { data: { id: 'sketch.line', keys: ['Shift+KeyK'], shown: ['Shift+K'], changed: true }, summary: 'Line: Shift+K' } });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['Shift+KeyK'] });
  });

  it('a key another command has is key_taken until replace (after the person agreed); the confirm names who loses it', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'F' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'key_taken', message: '"KeyF" is already the key of Fit (Everywhere).' });
    expect(asked).toEqual([]);
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'F', replace: true }), invoke({}).req, rt);
    expect(asked[0].copy).toBe('Demo · Line (sketch): L → F; Demo · Fit (everywhere): F → no key');
    expect(out).toMatchObject({ ok: true, result: { data: { took: [{ id: 'view.fit', label: 'Fit', keys: [] }] } } });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyF'], 'view.fit': [] });
  });

  it("refuses the app's and the browser's keys, and text that is no key, before asking", async () => {
    fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'Ctrl+W' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input', message: '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)' });
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'Ctrl+/' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'Numpad5' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input', message: '"Numpad5" never comes from a press: write "Digit5"' });
    expect(asked).toEqual([]);
  });

  it('reset, clear and reset_all ask in their own words', async () => {
    const server = fakeKeysServer({ prefs: { demo: { [KEYBINDS_PREF]: { 'edit.delete': ['KeyX'] } } } });
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(set({ command: 'edit.delete', action: 'reset' }), invoke({}).req, rt)).toMatchObject({ ok: true });
    expect(await coreSetKeybind(set({ command: 'view.fit', action: 'clear' }), invoke({}).req, rt)).toMatchObject({ ok: true });
    expect(await coreSetKeybind(set({ action: 'reset_all' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { changed: true } } });
    expect(asked.map((a) => a.copy)).toEqual([
      'Demo · Delete (everywhere): X → Delete, Backspace',
      'Demo · Fit (everywhere): F → no key',
      'Demo · every command: its own keys → its default keys',
    ]);
    expect(server.prefs.demo[KEYBINDS_PREF]).toBeUndefined();
    // Nothing to change: nothing asked.
    expect(await coreSetKeybind(set({ action: 'reset_all' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { changed: false } } });
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'L' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { changed: false } } });
    expect(asked).toHaveLength(3);
  });

  it('keys that could not be read are never changed', async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'K' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(asked).toEqual([]);
  });

  it('the question names every key the command loses, as the CAD Part asks', async () => {
    fakeKeysServer();
    const { rt, asked } = runtime(false);
    await coreSetKeybind(set({ command: 'edit.delete', keys: 'D' }), invoke({}).req, rt);
    expect(asked[0].copy).toBe('Demo · Delete (everywhere): Delete, Backspace → D');
  });

  it('a change that moved while the person was asked is not made: changed', async () => {
    const server = fakeKeysServer();
    // The person (or a workspace) gives Fit the key K while the question is open.
    const { rt } = runtime(() => {
      server.prefs.demo = { [KEYBINDS_PREF]: { 'view.fit': ['KeyK'] } };
      return true;
    });
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'K' }), invoke({}).req, rt);
    expect(out).toMatchObject({ ok: false, code: 'changed', message: 'The keybinds changed while the person was asked (in Settings, a workspace or another tab); nothing changed.' });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'view.fit': ['KeyK'] });
  });

  it("a Yes to 'L → Shift+K' is not applied once the command's own keys moved meanwhile", async () => {
    const server = fakeKeysServer();
    const { rt } = runtime(() => {
      server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.line': ['KeyL', 'KeyM'] } };
      return true;
    });
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'Shift+K' }), invoke({}).req, rt);
    expect(out).toMatchObject({ ok: false, code: 'changed' });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyL', 'KeyM'] });
  });

  it('keys that cannot be read again after the Yes are unavailable, never changed', async () => {
    const server = fakeKeysServer();
    const { rt } = runtime(() => {
      server.failReads = true;
      return true;
    });
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'K' }), invoke({}).req, rt);
    expect(out).toMatchObject({ ok: false, code: 'unavailable' });
    expect(server.calls).toEqual([]);
  });

  it('a write the app refuses after the Yes is failed (not unavailable), with its reason', async () => {
    const server = fakeKeysServer();
    const real = server.fetch.getMockImplementation()!;
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/plugin-prefs/set' ? new Response(JSON.stringify({ ok: false, error: 'A plugin keeps at most 64 KB of prefs' }), { status: 413 }) : real(input, init),
    );
    const out = await coreSetKeybind(set({ command: 'sketch.line', keys: 'K' }), invoke({}).req, runtime(true).rt);
    expect(out).toMatchObject({ ok: false, code: 'failed', message: 'Could not save the keys: A plugin keeps at most 64 KB of prefs' });
  });

  it('Escape is no key the Assistant sets: the person cannot set it in Settings either', async () => {
    fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'Esc' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(asked).toEqual([]);
  });

  it("the Assistant's changes are announced as its own, so an open Settings shows them", async () => {
    fakeKeysServer();
    const heard: string[] = [];
    const stop = onPrefChange((c) => heard.push(c.from));
    await coreSetKeybind(set({ command: 'sketch.line', keys: 'K' }), invoke({}).req, runtime(true).rt);
    await vi.waitFor(() => expect(heard).toEqual([ASSISTANT_FROM]));
    stop();
  });

  it("the page's question is the app's guarded one: a deliberate click only, Enter answers Cancel", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.doMock('../workbench/dialogs', () => ({
      confirmAction: async (o: Record<string, unknown>) => {
        calls.push(o);
        return false;
      },
    }));
    vi.resetModules();
    const { pageKeysRuntime } = await import('./keybindTools');
    const signal = new AbortController().signal;
    expect(await pageKeysRuntime().confirm({ title: 'Change a keybind?', copy: 'Demo · Line (sketch): L → K', yes: 'Change', signal })).toBe(false);
    expect(calls).toEqual([{ title: 'Change a keybind?', copy: 'Demo · Line (sketch): L → K', yes: 'Change', signal, guard: true, safe: true }]);
    vi.doUnmock('../workbench/dialogs');
    vi.resetModules();
  });

  it('a label two commands share asks for the id', async () => {
    fakeKeysServer({
      files: {
        '/plugins/demo/workspace/commands.json': {
          version: 1,
          contexts: [],
          commands: [
            { id: 'a.delete', label: 'Delete', group: '', context: 'any', keys: [] },
            { id: 'b.delete', label: 'Delete', group: '', context: 'any', keys: [] },
          ],
        },
      },
    });
    const out = await coreSetKeybind(set({ command: 'delete', action: 'clear' }), invoke({}).req, runtime(true).rt);
    expect(out).toMatchObject({ ok: false, code: 'invalid_input', message: '"delete" names 2 commands: a.delete, b.delete.' });
  });

  it("a command may not have the Assistant panel's key the person chose; once the panel has another, it may", async () => {
    const server = fakeKeysServer({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt, asked } = runtime(false);
    expect(await coreSetKeybind(set({ command: 'sketch.line', keys: 'Alt+K' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input', message: panelKeyRefusal('Alt+KeyK') });
    expect(asked).toEqual([]);
    // The panel's key changed in Settings or another tab: Line may have Alt+K now.
    server.app = { 'app.assistant': ['Alt+KeyJ'] };
    await coreSetKeybind(set({ command: 'sketch.line', keys: 'Alt+K' }), invoke({}).req, rt);
    expect(asked.map((a) => a.copy)).toEqual(['Demo · Line (sketch): L → Alt+K']);
  });

  it("a Reset that would bring back a default that is the Assistant panel's key now is refused, replace or not", async () => {
    const server = fakeKeysServer({ files: MEASURE_FILES, prefs: { demo: { [KEYBINDS_PREF]: { 'tool.measure': ['KeyM'] } } }, app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt, asked } = runtime(true);
    for (const replace of [false, true]) {
      expect(await coreSetKeybind(set({ command: 'tool.measure', action: 'reset', replace }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input', message: panelKeyRefusal('Alt+KeyK') });
    }
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("Reset all keeps the Assistant panel's key off the command whose default it is, and says so", async () => {
    const server = fakeKeysServer({
      files: MEASURE_FILES,
      prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Shift+KeyL'], 'tool.measure': ['KeyM'] } } },
      app: { 'app.assistant': ['Alt+KeyK'] },
    });
    const { rt, asked } = runtime(true);
    const out = await coreSetKeybind(set({ action: 'reset_all' }), invoke({}).req, rt);
    expect(asked.map((a) => a.copy)).toEqual(["Demo · every command: its own keys → its default keys (Alt+K kept off Measure: the Assistant panel's key)"]);
    expect(out).toMatchObject({
      ok: true,
      result: {
        data: { plugin: 'demo', changed: true, kept_off: [{ id: 'tool.measure', keys: ['Alt+KeyK'] }] },
        summary: "Every Demo command has its default keys again (Alt+K kept off Measure: the Assistant panel's key.)",
      },
    });
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'tool.measure': ['KeyM'] });
    // All that is left is the panel's key kept off: nothing to reset, nothing asked.
    expect(await coreSetKeybind(set({ action: 'reset_all' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { changed: false } } });
    expect(asked).toHaveLength(1);
    // The panel's key back to its defaults (Settings, another tab): Measure gets Alt+K back.
    server.app = {};
    const back = await coreSetKeybind(set({ action: 'reset_all' }), invoke({}).req, rt);
    expect(back).toMatchObject({ ok: true, result: { data: { plugin: 'demo', changed: true }, summary: 'Every Demo command has its default keys again' } });
    expect(back.ok && back.result.data).not.toHaveProperty('kept_off');
    expect(server.prefs.demo[KEYBINDS_PREF]).toBeUndefined();
  });
});

describe("core__set_keybind: the Assistant panel's own key (plugin \"app\")", () => {
  it('changes nothing unless the person asked for it in this request', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ keys: 'Alt+K', person_asked: false }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'not_asked', hint: SET_IN });
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it('refuses a key that types text, one the browser, the system or the dialogs keep, and text that is no key, before asking', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(true);
    const typesText = (k: string) => `"${k}" types text: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)`;
    const refused: [string, string][] = [
      ['K', typesText('KeyK')],
      ['Shift+K', typesText('Shift+KeyK')],
      ['Ctrl+W', '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)'],
      ['Esc', `"Escape" is the app's own key in dialogs, menus and modes (Close the open dialog, menu or mode)`],
      ['Numpad5', '"Numpad5" never comes from a press: write "Digit5"'],
    ];
    for (const [keys, message] of refused) {
      expect(await coreSetKeybind(panel({ keys }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'invalid_input', message });
    }
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("names only the panel's key: the app's other keys are not_found", async () => {
    fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ command: 'app.close', action: 'clear' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'not_found',
      message: 'Magnusim has no key "app.close" that can be changed.',
      hint: 'Only app.assistant (Open or close the Assistant panel) can be.',
    });
    expect(asked).toEqual([]);
  });

  it('keys it has already answer changed false without asking', async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ keys: 'Ctrl+/' }), invoke({}).req, rt)).toMatchObject({
      ok: true,
      result: { data: { id: 'app.assistant', is_default: true, changed: false }, summary: 'Open or close the Assistant panel has those keys already' },
    });
    expect(await coreSetKeybind(panel({ action: 'reset' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { is_default: true, changed: false } } });
    server.app = { 'app.assistant': ['Alt+KeyK'] };
    expect(await coreSetKeybind(panel({ keys: 'alt+k' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { keys: ['Alt+KeyK'], changed: false } } });
    server.app = { 'app.assistant': [] };
    expect(await coreSetKeybind(panel({ action: 'clear' }), invoke({}).req, rt)).toMatchObject({ ok: true, result: { data: { keys: [], changed: false } } });
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("asks in each action's own words, naming the app and the keys before and after (by the app's name and the key's label too)", async () => {
    const server = fakeKeysServer({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt, asked } = runtime(false);
    await coreSetKeybind(panel({ keys: 'Alt+J' }), invoke({}).req, rt);
    await coreSetKeybind(set({ plugin: 'app', command: 'open or close the assistant panel', action: 'clear' }), invoke({}).req, rt);
    await coreSetKeybind(panel({ action: 'reset' }), invoke({}).req, rt);
    expect(asked.slice(0, 2)).toEqual([
      { title: 'Change a keybind?', copy: `${PANEL}: Alt+K → Alt+J`, yes: 'Change' },
      { title: 'Clear a keybind?', copy: `${PANEL}: Alt+K → no key`, yes: 'Clear' },
    ]);
    // Reset names the defaults it brings back, Ctrl+/ first.
    // Its defaults read as the one key people know: Ctrl+/.
    expect(asked[2]).toEqual({ title: 'Reset a keybind?', copy: 'Magnusim · Open or close the Assistant panel: Alt+K → Ctrl+/', yes: 'Reset' });
    expect(server.calls).toEqual([]);
  });

  it("the person's No changes nothing: step_declined, and the call waited for them meanwhile", async () => {
    const server = fakeKeysServer();
    const { rt, asked } = runtime(false);
    const { req, progress } = invoke({});
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), req, rt)).toMatchObject({ ok: false, code: 'step_declined' });
    expect(asked).toHaveLength(1);
    expect(progress[0]).toEqual(['Waiting for you to confirm the keybind change', true]);
    expect(server.calls).toEqual([]);
    expect(server.app).toEqual({});
    expect(assistantKeys()).toBeNull();
  });

  it("on the Yes it stores the panel's key as Settings does, the page takes it, and it is announced as the Assistant's", async () => {
    const server = fakeKeysServer();
    const heard: PrefChange[] = [];
    const stop = onPrefChange((c) => heard.push(c));
    const out = await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, runtime(true).rt);
    expect(out).toMatchObject({
      ok: true,
      result: {
        data: { id: 'app.assistant', keys: ['Alt+KeyK'], shown: ['Alt+K'], is_default: false, changeable: true, changed: true },
        summary: 'Open or close the Assistant panel: Alt+K',
      },
    });
    expect(out.ok && out.result.data).not.toHaveProperty('took');
    expect(server.app).toEqual({ 'app.assistant': ['Alt+KeyK'] });
    expect(server.calls).toEqual([['app', '', { 'app.assistant': ['Alt+KeyK'] }]]);
    expect(assistantKeys()).toEqual(['Alt+KeyK']);
    await vi.waitFor(() => expect(heard).toEqual([{ plugin: '', key: 'keybinds', value: { 'app.assistant': ['Alt+KeyK'] }, from: ASSISTANT_FROM }]));
    stop();
  });

  it('reset_all on the app is its Reset: the panel has its defaults again', async () => {
    const server = fakeKeysServer({ app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt, asked } = runtime(true);
    const out = await coreSetKeybind(set({ plugin: 'app', command: '', action: 'reset_all' }), invoke({}).req, rt);
    expect(asked.map((a) => [a.title, a.yes])).toEqual([['Reset a keybind?', 'Reset']]);
    expect(out).toMatchObject({ ok: true, result: { data: { id: 'app.assistant', keys: defaultAppKeys('app.assistant'), is_default: true, changed: true } } });
    expect(server.app).toEqual({});
    expect(assistantKeys()).toBeNull();
  });

  it("a key a plugin command has is key_taken until replace; the question names who loses it, and it loses it before the panel has it", async () => {
    const server = fakeKeysServer({ prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL'] } } }, app: { 'app.assistant': ['Alt+KeyK'] } });
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ keys: 'Alt+L' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'key_taken',
      message: '"Alt+KeyL" is already the key of Demo · Line (Sketch).',
      hint: 'Ask the person whether to take it from them; with their yes, call again with replace true.',
    });
    expect(asked).toEqual([]);
    const out = await coreSetKeybind(panel({ keys: 'Alt+L', replace: true }), invoke({}).req, rt);
    expect(asked).toEqual([{ title: 'Change a keybind?', copy: `${PANEL}: Alt+K → Alt+L; Demo · Line (sketch): Alt+L → no key`, yes: 'Change' }]);
    expect(out).toMatchObject({
      ok: true,
      result: { data: { keys: ['Alt+KeyL'], changed: true, took: [{ plugin: 'demo', id: 'sketch.line', label: 'Line', keys: [] }] }, summary: 'Open or close the Assistant panel: Alt+L' },
    });
    expect(server.calls).toEqual([
      ['set', 'demo', { 'sketch.line': [] }],
      ['app', '', { 'app.assistant': ['Alt+KeyL'] }],
    ]);
    expect(server.prefs.demo[KEYBINDS_PREF]).toEqual({ 'sketch.line': [] });
  });

  it('the panel works everywhere: a key commands of several plugins have is taken from each, and one left with its defaults has them again', async () => {
    const server = fakeKeysServer({
      ...TWO_PLUGINS,
      prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL'] } }, other: { [KEYBINDS_PREF]: { 'view.fit': ['KeyF', 'Alt+KeyL'] } } },
      app: { 'app.assistant': ['Alt+KeyK'] },
    });
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ keys: 'Alt+L' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'key_taken',
      message: '"Alt+KeyL" is already the key of Demo · Line (Sketch), Other · Fit (Everywhere).',
    });
    const out = await coreSetKeybind(panel({ keys: 'Alt+L', replace: true }), invoke({}).req, rt);
    expect(asked.map((a) => a.copy)).toEqual([`${PANEL}: Alt+K → Alt+L; Demo · Line (sketch): Alt+L → no key; Other · Fit (everywhere): F, Alt+L → F`]);
    expect(out).toMatchObject({
      ok: true,
      result: {
        data: {
          took: [
            { plugin: 'demo', id: 'sketch.line', label: 'Line', keys: [] },
            { plugin: 'other', id: 'view.fit', label: 'Fit', keys: ['KeyF'] },
          ],
        },
      },
    });
    expect(server.calls).toEqual([
      ['set', 'demo', { 'sketch.line': [] }],
      ['remove', 'other', null],
      ['app', '', { 'app.assistant': ['Alt+KeyL'] }],
    ]);
  });

  it("a Yes is not applied once the panel's key changed elsewhere while the person was asked: changed", async () => {
    const server = fakeKeysServer();
    const { rt } = runtime(() => {
      server.app = { 'app.assistant': ['Alt+KeyJ'] };
      return true;
    });
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'changed',
      message: CHANGED,
      hint: 'Call core__keybinds, then ask the person again with the new wording.',
    });
    expect(server.calls).toEqual([]);
    expect(server.app).toEqual({ 'app.assistant': ['Alt+KeyJ'] });
  });

  it('a Yes is not applied once a command it takes the key from moved, or another command took the key, while the person was asked', async () => {
    const server = fakeKeysServer({ prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL'] } } } });
    // Line gets another key besides Alt+L while the question is open.
    const one = runtime(() => {
      server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL', 'KeyM'] } };
      return true;
    });
    expect(await coreSetKeybind(panel({ keys: 'Alt+L', replace: true }), invoke({}).req, one.rt)).toMatchObject({ ok: false, code: 'changed', message: CHANGED });
    // Fit takes Alt+K while the person is asked about a key no command had.
    const two = runtime(() => {
      server.prefs.demo = { [KEYBINDS_PREF]: { 'view.fit': ['Alt+KeyK'] } };
      return true;
    });
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, two.rt)).toMatchObject({ ok: false, code: 'changed', message: CHANGED });
    expect(server.calls).toEqual([]);
    expect(server.app).toEqual({});
  });

  it('each write reads its keys once more after the Yes and writes nothing when they moved: changed', async () => {
    const server = fakeKeysServer({ prefs: { demo: { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL'] } } } });
    const real = server.fetch.getMockImplementation()!;
    let yes = false;
    let pluginReads = 0;
    let appReads = 0;
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // After the Yes the keys are read for the second look, then by the write: they move in between.
      if (yes && url === '/api/plugin-prefs/get' && ++pluginReads === 2) server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.line': ['Alt+KeyL', 'KeyM'] } };
      if (yes && url === '/api/prefs' && init?.method !== 'POST' && ++appReads === 2) server.app = { 'app.assistant': ['Alt+KeyJ'] };
      return real(input, init);
    });
    const { rt } = runtime(() => (yes = true));
    // A command's keys, read by its write.
    expect(await coreSetKeybind(panel({ keys: 'Alt+L', replace: true }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'changed', message: CHANGED });
    expect(pluginReads).toBe(2);
    expect(server.calls).toEqual([]);
    // The panel's own keys, read by its write.
    yes = false;
    appReads = 0;
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, rt)).toMatchObject({ ok: false, code: 'changed', message: CHANGED });
    expect(appReads).toBe(2);
    expect(server.calls).toEqual([]);
    expect(server.app).toEqual({ 'app.assistant': ['Alt+KeyJ'] });
  });

  it("nothing is worked out from a plugin's keys that could not be read: unavailable, nothing asked", async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    const { rt, asked } = runtime(true);
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'unavailable',
      message: 'Your keys for Demo could not be read: the plugin list is not available right now',
    });
    expect(asked).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("the app's keys that cannot be read again after the Yes are never written over: unavailable", async () => {
    const server = fakeKeysServer();
    const { rt } = runtime(() => {
      server.failAppReads = true;
      return true;
    });
    expect(await coreSetKeybind(panel({ keys: 'Alt+K' }), invoke({}).req, rt)).toMatchObject({
      ok: false,
      code: 'unavailable',
      message: "The panel's key was not saved (the settings are not available right now); nothing changed.",
    });
    expect(server.calls).toEqual([]);
    expect(assistantKeys()).toBeNull();
  });
});
