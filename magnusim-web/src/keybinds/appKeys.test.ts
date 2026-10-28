import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appKeyRefusal,
  appKeybinds,
  ASSISTANT_KEYS_EVENT,
  assistantKeys,
  defaultAppKeys,
  onAppKeys,
  pressIs,
  readAppKeybinds,
  resetAppKeysForTests,
  startAppKeys,
  storeAppKeybinds,
} from './appKeys';
import { APP_COMMANDS } from './appCommands';
import { displayCombo } from './combo';
import { announcePref, PREFS_CHANNEL } from '../workspace/prefsChannel';

const press = (init: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }) as KeyboardEvent;

beforeEach(() => resetAppKeysForTests());
afterEach(() => {
  resetAppKeysForTests();
  vi.unstubAllGlobals();
});

describe("the Assistant panel's key the person chose", () => {
  it('may be any key with Ctrl or Alt, or a function key; never one the browser, the system or the dialogs keep, nor one that types text', () => {
    for (const ok of ['Ctrl+KeyK', 'Alt+KeyA', 'Ctrl+Shift+Slash', 'F9', 'Shift+F2', 'Ctrl+Alt+Digit1', 'Ctrl+Slash']) expect(appKeyRefusal(ok), ok).toBe('');
    expect(appKeyRefusal('Ctrl+KeyW', displayCombo)).toBe('Ctrl+W is kept for the browser and the system (Close the tab)');
    expect(appKeyRefusal('F5', displayCombo)).toBe('F5 is kept for the browser and the system (Reload the page)');
    expect(appKeyRefusal('Escape', displayCombo)).toBe("Escape is the app's own key in dialogs, menus and modes (Close the open dialog, menu or mode)");
    for (const text of ['KeyK', 'Shift+KeyK', 'Space', 'Digit1', 'Shift+Slash']) {
      expect(appKeyRefusal(text, displayCombo), text).toBe(
        `${displayCombo(text)} types text: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)`,
      );
    }
    // A key that moves or edits while the person types is no key for it either, in its own words.
    for (const used of ['Enter', 'Delete', 'ArrowUp', 'Home', 'Backspace']) {
      expect(appKeyRefusal(used, displayCombo), used).toBe(
        `${displayCombo(used)} is a key used while typing: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)`,
      );
    }
    expect(appKeyRefusal('Ctrl+Nope')).toBe('"Ctrl+Nope" is not a key');
  });

  it("is read from the prefs as the plugins' keys are: valid distinct combos, at most 4, an id with none valid keeps its defaults, other ids left out", () => {
    expect(readAppKeybinds(null)).toEqual({});
    expect(readAppKeybinds({ 'app.assistant': ['Ctrl+KeyK', 'Ctrl+KeyK', 'F9'] })).toEqual({ 'app.assistant': ['Ctrl+KeyK', 'F9'] });
    expect(readAppKeybinds({ 'app.assistant': [] })).toEqual({ 'app.assistant': [] });
    expect(readAppKeybinds({ 'app.assistant': ['KeyK', 'Ctrl+KeyW', 7] })).toEqual({});
    expect(readAppKeybinds({ 'app.assistant': ['F1', 'F2', 'F3', 'F4', 'F6'] })).toEqual({ 'app.assistant': ['F1', 'F2', 'F3', 'F4'] });
    expect(readAppKeybinds({ 'app.close': ['Ctrl+KeyK'], 'app.assistant': 'F9' })).toEqual({});
    expect(defaultAppKeys('app.assistant')).toEqual(APP_COMMANDS[0].keys);
  });

  it('is matched as a workspace matches its commands: Cmd as Ctrl, a letter by the letter it types, punctuation by its place and by the character it types', () => {
    expect(pressIs(press({ key: 'k', code: 'KeyK', ctrlKey: true }), ['Ctrl+KeyK'])).toBe(true);
    expect(pressIs(press({ key: 'k', code: 'KeyK', metaKey: true }), ['Ctrl+KeyK'])).toBe(true);
    expect(pressIs(press({ key: 'k', code: 'KeyV', ctrlKey: true }), ['Ctrl+KeyK'])).toBe(true);
    expect(pressIs(press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), ['Ctrl+KeyK'])).toBe(false);
    expect(pressIs(press({ key: '/', code: 'Digit7', altKey: true, shiftKey: true }), ['Alt+Shift+Slash'])).toBe(true);
    expect(pressIs(press({ key: 'F9', code: 'F9' }), [])).toBe(false);
    expect(pressIs(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), ['Ctrl+KeyK'])).toBe(false);
  });

  it('is read once from GET /api/prefs, then follows the prefs channel; each change tells the listeners and the window (an open workspace)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, units: 'Metric', keybinds: { 'app.assistant': ['Ctrl+KeyK'] } })));
    vi.stubGlobal('fetch', fetchMock);
    const told = vi.fn();
    const windowTold = vi.fn();
    onAppKeys(told);
    window.addEventListener(ASSISTANT_KEYS_EVENT, windowTold);
    expect(assistantKeys()).toBeNull();
    startAppKeys();
    startAppKeys();
    await vi.waitFor(() => expect(assistantKeys()).toEqual(['Ctrl+KeyK']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledTimes(1);
    expect(windowTold).toHaveBeenCalledTimes(1);
    // Another tab cleared it; then put the defaults back. A plugin's keybinds are not the app's.
    announcePref('', 'keybinds', { 'app.assistant': [] }, 'settings:other');
    await vi.waitFor(() => expect(assistantKeys()).toEqual([]));
    announcePref('cad', 'keybinds', { 'app.assistant': ['F9'] }, 'settings:other');
    announcePref('', 'keybinds', null, 'settings:other');
    await vi.waitFor(() => expect(assistantKeys()).toBeNull());
    expect(appKeybinds()).toEqual({});
    expect(told).toHaveBeenCalledTimes(3);
    window.removeEventListener(ASSISTANT_KEYS_EVENT, windowTold);
    expect(PREFS_CHANNEL).toBe('magnusim-plugin-prefs');
  });

  it('a change reads the stored value again, writes the whole value with only its ids changed, takes it here and tells the other tabs', async () => {
    let stored: Record<string, unknown> = { 'app.assistant': ['F9'] };
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { keybinds: Record<string, unknown> };
          bodies.push(body);
          stored = body.keybinds;
        }
        return new Response(JSON.stringify({ ok: true, keybinds: stored, prefs: { keybinds: stored } }));
      }),
    );
    const heard: unknown[] = [];
    const ch = new BroadcastChannel(PREFS_CHANNEL);
    ch.onmessage = (e) => heard.push(e.data);
    expect(await storeAppKeybinds({ 'app.assistant': ['Ctrl+KeyK'] }, 'settings:me')).toEqual({ 'app.assistant': ['Ctrl+KeyK'] });
    expect(assistantKeys()).toEqual(['Ctrl+KeyK']);
    expect(await storeAppKeybinds({ 'app.assistant': null }, 'settings:me')).toEqual({});
    expect(assistantKeys()).toBeNull();
    expect(bodies).toEqual([{ keybinds: { 'app.assistant': ['Ctrl+KeyK'] } }, { keybinds: {} }]);
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard[0]).toEqual({ plugin: '', key: 'keybinds', value: { 'app.assistant': ['Ctrl+KeyK'] }, from: 'settings:me' });
    ch.close();
    await expect(storeAppKeybinds({ 'app.close': ['F9'] }, 'settings:me')).rejects.toThrow('"app.close" is not a key the person can change');
  });

  it('a refused write changes nothing here and says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? new Response(JSON.stringify({ ok: false, error: 'keybinds must map app.assistant to a list of at most 4 keys' }), { status: 400 }) : new Response(JSON.stringify({ ok: true })),
      ),
    );
    await expect(storeAppKeybinds({ 'app.assistant': ['F9'] }, 'settings:me')).rejects.toThrow('keybinds must map');
    expect(assistantKeys()).toBeNull();
  });
});
