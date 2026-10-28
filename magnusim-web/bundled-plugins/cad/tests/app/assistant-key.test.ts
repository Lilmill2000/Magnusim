// The app's Assistant panel key in the Part (unreleased host 1.9: ws.context.assistantKeys and the
// assistantKeys event; the person's key from Settings → Keybinds, or the default Ctrl+/):
//  - the bridge reads the keys as the SDK does, hears each change, and an older host is as before;
//  - a press is the Assistant's by the very rule the SDK forwards it with: keymap.ts
//    isAssistantPress against the host's real SDK (src/plugin-sdk/workspace.ts), press by press,
//    letters and punctuation of other layouts too;
//  - passAssistantKey keeps that press from every handler of the Part, whichever way it listens
//    (the window or the document, capture or bubble, an element, React, the keyboard's bindings),
//    never calls preventDefault (the SDK still forwards it), follows a change at once, leaves a
//    composing key alone and lets the Set keybind field read it; bootstrap installs it;
//  - a combo is the Assistant's (refused, shown as taken) where every press of it is the SDK's:
//    the number pad's /, - and = by the person's key on /, - or =, held to the SDK's forward too.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeyboard, passAssistantKey } from '../../src/app/keyboard';
import { appClashesIn, comboProblem, defaultKeys, isAssistantCombo, isAssistantPress } from '../../src/app/keymap';
import { assistantKeysOf, createBridge } from '../../src/lib/bridge';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const later = () => new Promise((r) => setTimeout(r, 5));

describe('the bridge: the Assistant panel keys', () => {
  it('reads them as the SDK does (text only, each once; null the default) and hears each change', () => {
    const ws = createFakeWorkspace({ assistantKeys: ['Ctrl+KeyK', 'Ctrl+KeyK', 7 as unknown as string, 'F9'] });
    const bridge = createBridge(ws);
    expect(bridge.assistantKeys()).toEqual(['Ctrl+KeyK', 'F9']);
    const heard: (readonly string[] | null)[] = [];
    const off = bridge.onAssistantKeys((k) => heard.push(k));
    ws.push('assistantKeys', []);
    expect(bridge.assistantKeys()).toEqual([]);
    ws.push('assistantKeys', null);
    expect(bridge.assistantKeys()).toBeNull();
    off();
    ws.push('assistantKeys', ['Alt+KeyK']);
    expect(bridge.assistantKeys()).toEqual(['Alt+KeyK']);
    expect(heard).toEqual([[], null]);
    expect(assistantKeysOf('Ctrl+KeyK')).toBeNull();
    expect(createBridge(createFakeWorkspace({ assistantKeys: null })).assistantKeys()).toBeNull();
  });

  it('an older host (no assistantKeys in its welcome): the default, no event heard, nothing thrown', () => {
    const ws = createFakeWorkspace();
    const on = vi.spyOn(ws, 'on');
    const bridge = createBridge(ws);
    expect(bridge.assistantKeys()).toBeNull();
    expect(on.mock.calls.map((c) => c[0])).not.toContain('assistantKeys');
    const fn = vi.fn();
    bridge.onAssistantKeys(fn)();
    ws.push('assistantKeys', ['Ctrl+KeyK']);
    expect(bridge.assistantKeys()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    // An SDK whose on() refuses the event: the keys of the welcome stay.
    const odd = createFakeWorkspace({ assistantKeys: ['F9'] });
    const known = odd.on.bind(odd) as (event: string, fn: (v: never) => void) => () => void;
    odd.on = ((event: string, fn: (v: never) => void) => {
      if (event === 'assistantKeys') throw new Error('no such event');
      return known(event, fn);
    }) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createBridge(odd).assistantKeys()).toEqual(['F9']);
    warn.mockRestore();
  });
});

// ------------------------------------------------------------------ the host's real SDK

const CONTEXT = {
  plugin: 'cad',
  workspace: 'part',
  project: { id: 'proj-a', title: 'Project A' },
  study: { id: 'st-1' },
  units: 'metric',
  theme: { name: 'light', stylesheet: '/plugin-sdk/theme.css' },
  hostVersion: '1.8',
};

/** The host's SDK connected in this window with the panel docked: how many presses it forwarded, and the host's events. */
async function hostSdk(keys: string[] | null) {
  const sdk = await import('../../../../src/plugin-sdk/workspace');
  let docks = 0;
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    start() {},
    postMessage(msg: { id: number; method: string }) {
      if (msg.method === 'assistant.dock') docks++;
      void Promise.resolve().then(() => port.onmessage?.({ data: { id: msg.id, result: { ok: true } } }));
    },
  };
  const parent = {
    postMessage: (msg: { magnusim?: string; instance?: string }) => {
      if (msg.magnusim !== 'hello') return;
      const welcome = new Event('message');
      Object.defineProperties(welcome, {
        source: { value: parent },
        data: { value: { magnusim: 'welcome', instance: msg.instance, context: { ...CONTEXT, assistantDock: true, assistantKeys: keys } } },
        ports: { value: [port] },
      });
      window.dispatchEvent(welcome);
    },
  };
  const spy = vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  const ws = await sdk.connect({ timeoutMs: 1000 });
  spy.mockRestore();
  return {
    ws,
    docks: () => docks,
    /** The host's assistantKeys event, as the SDK takes it. */
    setKeys: (k: string[] | null) => port.onmessage?.({ data: { event: 'assistantKeys', data: k } }),
  };
}

/** Presses of other layouts too: AZERTY letters, a German "/" on Shift+7, Cyrillic on K, the number pad, Cmd. */
const PRESSES: (KeyboardEventInit & { key: string; code: string })[] = [
  { key: '/', code: 'Slash', ctrlKey: true },
  { key: '/', code: 'Slash', metaKey: true },
  { key: '/', code: 'Slash', ctrlKey: true, metaKey: true },
  { key: '/', code: 'NumpadDivide', ctrlKey: true },
  { key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true },
  { key: '/', code: 'Digit7', shiftKey: true, altKey: true },
  { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true },
  { key: '/', code: 'Slash', ctrlKey: true, altKey: true },
  { key: '-', code: 'Slash', ctrlKey: true },
  { key: '!', code: 'Slash', ctrlKey: true },
  { key: 'k', code: 'KeyK', ctrlKey: true },
  { key: 'k', code: 'KeyK', metaKey: true },
  { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true },
  { key: 'k', code: 'KeyK', altKey: true },
  { key: 'k', code: 'KeyV', ctrlKey: true },
  { key: 'q', code: 'KeyA', ctrlKey: true },
  { key: 'a', code: 'KeyQ', ctrlKey: true },
  { key: 'л', code: 'KeyK', ctrlKey: true },
  { key: ';', code: 'Comma', ctrlKey: true },
  { key: ':', code: 'Period', ctrlKey: true },
  { key: 'ù', code: 'Quote', ctrlKey: true },
  { key: '#', code: 'Backslash', ctrlKey: true },
  { key: '1', code: 'Numpad1', ctrlKey: true },
  { key: '&', code: 'Digit1', ctrlKey: true },
  { key: 'Enter', code: 'NumpadEnter', altKey: true },
  { key: '/', code: 'NumpadDivide', altKey: true },
  { key: '-', code: 'NumpadSubtract', ctrlKey: true, shiftKey: true },
  { key: '=', code: 'NumpadEqual', altKey: true },
  { key: '\\', code: 'IntlBackslash', ctrlKey: true },
  { key: 'Enter', code: 'Enter', ctrlKey: true },
  { key: ' ', code: 'Space', ctrlKey: true },
  { key: 'F9', code: 'F9' },
  { key: 'F9', code: 'F9', ctrlKey: true },
  { key: 'F2', code: 'F2', shiftKey: true },
  { key: 'ArrowUp', code: 'ArrowUp', altKey: true },
  { key: 'Control', code: 'ControlLeft', ctrlKey: true },
  { key: '/', code: '', ctrlKey: true },
  { key: 'F9', code: '' },
];
const KEY_LISTS: (string[] | null)[] = [
  null,
  [],
  ['Ctrl+KeyK'],
  ['Ctrl+KeyQ', 'Ctrl+KeyA'],
  ['Alt+Shift+Slash', 'F9'],
  ['Ctrl+Comma', 'Ctrl+Semicolon', 'Ctrl+Period', 'Ctrl+Quote', 'Ctrl+Backslash'],
  ['Ctrl+Digit1', 'Alt+Enter', 'Ctrl+Space', 'Shift+F2', 'Alt+ArrowUp'],
  ['Ctrl+Slash', 'Ctrl+Shift+Slash', 'Ctrl+Shift+Digit7', 'Ctrl+NumpadDivide', 'Ctrl+Minus'],
  ['Alt+Slash', 'Ctrl+Shift+Minus', 'Alt+Equal'],
  ['Alt+NumpadDivide', 'Ctrl+IntlBackslash'],
  ['Meta+KeyK', 'ctrl+k', 'Ctrl+Control'],
];

describe("the press: the SDK's own rule", () => {
  let host: Awaited<ReturnType<typeof hostSdk>>;
  beforeAll(async () => {
    host = await hostSdk(null);
  });

  it('isAssistantPress answers as the host SDK forwards, press by press, for the default, none and the person\'s keys', async () => {
    const differ: string[] = [];
    let forwarded = 0;
    for (const keys of KEY_LISTS) {
      host.setKeys(keys);
      expect(host.ws.context.assistantKeys ?? null).toEqual(keys);
      for (const init of PRESSES) {
        const before = host.docks();
        press(init);
        await later();
        const sdk = host.docks() > before;
        if (sdk) forwarded++;
        if (isAssistantPress(init, keys) !== sdk) differ.push(`${JSON.stringify(keys)} ${JSON.stringify(init)}: SDK ${sdk}`);
      }
    }
    expect(differ).toEqual([]);
    // The table is not all "no": the SDK forwarded a good share of it.
    expect(forwarded).toBeGreaterThan(20);
    host.setKeys(null);
  });

  it('passAssistantKey keeps the press from every handler of the Part, without preventDefault: the SDK still forwards it; other keys reach them', async () => {
    let keys: readonly string[] | null = ['Ctrl+KeyK'];
    host.setKeys(['Ctrl+KeyK']);
    const off = passAssistantKey(window, { assistant: { docked: true } as never, assistantKeys: () => keys });
    // Handlers the Part has (and may add later), each way a page listens.
    const heard: string[] = [];
    const ear = (name: string) => (e: Event) => heard.push(`${name} ${(e as KeyboardEvent).key}`);
    const later1 = ear('window capture (added later: the extrude and enclosure handles, the toolbar drag)');
    const docCap = ear('document capture (sketch overlay, pending edits, leave key, view tools, busy)');
    const docBub = ear('document bubble (keyboard dispatcher, left rails)');
    const field = document.createElement('input');
    document.body.append(field);
    const own = ear('element (a dialog, an overlay box)');
    window.addEventListener('keydown', later1, true);
    document.addEventListener('keydown', docCap, true);
    document.addEventListener('keydown', docBub);
    field.addEventListener('keydown', own);
    // React's handlers (ContextMenu, the panels, the tree, Rename, number fields).
    const root = document.createElement('div');
    document.body.append(root);
    const react = vi.fn();
    await act(async () => {
      createRoot(root).render(createElement('button', { onKeyDown: react, id: 'r' }, 'r'));
    });
    const button = root.querySelector('#r') as HTMLButtonElement;
    // The keyboard's bindings: a command whose stored key is Ctrl+K.
    const kb = createKeyboard(document);
    const run = vi.fn(() => true);
    kb.bind({ combo: 'Ctrl+KeyK', run });
    try {
      for (const target of [document.body, field, button]) {
        const before = host.docks();
        const e = press({ key: 'k', code: 'KeyK', ctrlKey: true }, target);
        expect(e.defaultPrevented).toBe(false);
        await later();
        expect(host.docks()).toBe(before + 1);
      }
      expect(heard).toEqual([]);
      expect(react).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      // Another key reaches them all; a held Assistant key is the app's too; composing text keeps its key.
      press({ key: 'j', code: 'KeyJ', ctrlKey: true }, field);
      expect(heard).toHaveLength(4);
      press({ key: 'k', code: 'KeyK', ctrlKey: true, repeat: true });
      expect(heard).toHaveLength(4);
      press({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }, field);
      expect(heard).toHaveLength(8);
      // A change heard from the host: Ctrl+K is the Part's again, F9 the app's.
      keys = ['F9'];
      host.setKeys(['F9']);
      heard.length = 0;
      press({ key: 'k', code: 'KeyK', ctrlKey: true });
      expect(run).toHaveBeenCalledTimes(1);
      expect(heard).toHaveLength(3);
      const f9 = host.docks();
      press({ key: 'F9', code: 'F9' }, button);
      await later();
      expect(host.docks()).toBe(f9 + 1);
      expect(heard).toHaveLength(3);
      expect(react).not.toHaveBeenCalled();
      // The default again: Ctrl+/ by the character "/" (a German Shift+7 with Ctrl is not it: Shift).
      keys = null;
      host.setKeys(null);
      heard.length = 0;
      const before = host.docks();
      press({ key: '/', code: 'Slash', ctrlKey: true }, field);
      press({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true }, field);
      await later();
      expect(host.docks()).toBe(before + 1);
      expect(heard.filter((h) => h.startsWith('element'))).toEqual(['element (a dialog, an overlay box) /']);
      // None: every key is the Part's.
      keys = [];
      host.setKeys([]);
      heard.length = 0;
      press({ key: '/', code: 'Slash', ctrlKey: true }, field);
      expect(heard).toHaveLength(4);
    } finally {
      off();
      kb.dispose();
      window.removeEventListener('keydown', later1, true);
      document.removeEventListener('keydown', docCap, true);
      document.removeEventListener('keydown', docBub);
      document.body.innerHTML = '';
      host.setKeys(null);
    }
  });

  it("a number-pad key that types the same character everywhere is the person's key on it: the SDK forwards every press of it, so it is refused and shows as taken; not the other way, nor the UK \\ key for Backslash", async () => {
    const appOwn = (combo: string) => `"${combo}" is the app's own key (Open or close the Assistant panel)`;
    const fitOn = (combo: string) => (id: string) => (id === 'view.fit' ? [combo] : defaultKeys(id));
    try {
      for (const [pad, ch, typed] of [
        ['NumpadDivide', '/', 'Slash'],
        ['NumpadSubtract', '-', 'Minus'],
        ['NumpadEqual', '=', 'Equal'],
      ] as const) {
        const keys = [`Alt+${typed}`];
        host.setKeys(keys);
        const before = host.docks();
        press({ key: ch, code: pad, altKey: true });
        await later();
        expect(host.docks(), pad).toBe(before + 1);
        expect(isAssistantCombo(`Alt+${pad}`, keys)).toBe(true);
        expect(comboProblem(`Alt+${pad}`, null, keys)).toBe(appOwn(`Alt+${pad}`));
        expect(appClashesIn(fitOn(`Alt+${pad}`), keys)).toEqual([{ combo: `Alt+${pad}`, id: 'view.fit', by: appOwn(`Alt+${pad}`) }]);
        // Other modifiers are another key.
        expect(comboProblem(`Shift+${pad}`, null, keys)).toBe('');
        // Not the other way: the person's key on the pad leaves the main key's combo free (it may type another character).
        expect(isAssistantCombo(`Alt+${typed}`, [`Alt+${pad}`])).toBe(false);
        expect(comboProblem(`Alt+${typed}`, null, [`Alt+${pad}`])).toBe('');
      }
      // The pad's decimal key types "," on many layouts: it stays free with the person's key on Alt+. .
      expect(comboProblem('Alt+NumpadDecimal', null, ['Alt+Period'])).toBe('');
      // A UK keyboard's \ by Z is not its Backslash key (that one types #): Show or hide the tree keeps Ctrl+\, which still runs from its own key.
      const uk = ['Ctrl+IntlBackslash'];
      host.setKeys(uk);
      const before = host.docks();
      press({ key: '#', code: 'Backslash', ctrlKey: true });
      await later();
      expect(host.docks()).toBe(before);
      expect(comboProblem('Ctrl+Backslash', null, uk)).toBe('');
      expect(appClashesIn(defaultKeys, uk)).toEqual([]);
      expect(comboProblem('Ctrl+IntlBackslash', null, uk)).toBe(appOwn('Ctrl+IntlBackslash'));
      // None, or the default (APP_SHORTCUTS has it): nothing more.
      expect(isAssistantCombo('Alt+NumpadDivide', [])).toBe(false);
      expect(isAssistantCombo('Ctrl+NumpadDivide', null)).toBe(false);
    } finally {
      host.setKeys(null);
    }
  });

  it("the Set keybind field reads the Assistant's key (to say why it is refused) and keeps it: the panel does not open over the dialog", async () => {
    host.setKeys(['Ctrl+KeyK']);
    const off = passAssistantKey(window, { assistant: { docked: true } as never, assistantKeys: () => ['Ctrl+KeyK'] });
    const recorder = document.createElement('div');
    recorder.setAttribute('data-keybind-capture', '1');
    const inner = document.createElement('span');
    recorder.append(inner);
    document.body.append(recorder);
    const read = vi.fn((e: KeyboardEvent) => e.preventDefault());
    recorder.addEventListener('keydown', read);
    try {
      const before = host.docks();
      const e = press({ key: 'k', code: 'KeyK', ctrlKey: true }, inner);
      await later();
      expect(read).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
      expect(host.docks()).toBe(before);
    } finally {
      off();
      document.body.innerHTML = '';
      host.setKeys(null);
    }
  });
});

describe('passAssistantKey on a host without the panel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds nothing: no SDK forward to leave the key to, so every handler hears it as before', () => {
    for (const assistant of [null, { docked: false }]) {
      const off = passAssistantKey(window, { assistant: assistant as never, assistantKeys: () => ['Ctrl+KeyK'] });
      const heard = vi.fn();
      document.addEventListener('keydown', heard);
      press({ key: 'k', code: 'KeyK', ctrlKey: true });
      press({ key: '/', code: 'Slash', ctrlKey: true });
      expect(heard).toHaveBeenCalledTimes(2);
      document.removeEventListener('keydown', heard);
      off();
    }
  });
});
