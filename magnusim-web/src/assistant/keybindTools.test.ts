import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYBINDS_PREF, loadPluginKeys } from '../keybinds/catalog';
import { fakeKeysServer } from '../test/keybindsFake';
import type { AssistantInvoke } from '../workspace/bridge';
import { coreKeybinds, coreSetKeybind, SET_IN, type KeysRuntime } from './keybindTools';

afterEach(() => vi.unstubAllGlobals());

/** The page's runtime with the person's answer to each confirm, and what each one asked. */
function runtime(answer: boolean | (() => boolean)) {
  const asked: { title: string; copy: string; yes: string }[] = [];
  const rt: KeysRuntime = {
    load: loadPluginKeys,
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
    expect(asked).toEqual([{ title: 'Change a keybind?', copy: 'The Assistant asks to give Line (Demo) the key Shift+K.', yes: 'Change' }]);
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
    expect(asked[0].copy).toBe('The Assistant asks to give Line (Demo) the key F, taking it from Fit.');
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
      'The Assistant asks to put Delete (Demo) back to its default: Delete, Backspace.',
      'The Assistant asks to leave Fit (Demo) with no key.',
      'The Assistant asks to put every Demo command back to its default keys.',
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
});
