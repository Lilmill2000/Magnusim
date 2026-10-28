// The one command and keybinding registry (src/app/keymap.ts): its own rules (ids once, combos in
// the registry's form, no default conflict, none of the app's own keys), physical-key combos and
// what people read, the capture of a key press, workspace/commands.json as the build writes it,
// and the booted app: every command the app registers has its entry (same label, same mode), and
// every shortcut in the app's source comes from the registry (no literal key in a command or a
// binding, but Escape, the app's own).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_SHORTCUTS,
  appClashesIn,
  appUseOf,
  captureCombo,
  comboOf,
  combosOf,
  comboProblem,
  commandsJson,
  conflictsIn,
  CONTEXTS,
  defaultKeys,
  displayCombo,
  isKeyCode,
  KEYMAP,
  normaliseCombo,
  parseCombo,
  RESERVED,
  SHOWN_VIA,
} from '../../src/app/keymap';
import { keybindsFor } from '../../src/app/keybinds';
import type { AppServices } from '../../src/types/app';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({ state: { get: () => ({ ready: true }), subscribe: () => () => {} }, dispose() {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The suite runs from the plugin's folder (jsdom's import.meta.url is no file URL).
const ROOT = process.cwd();

describe('the registry', () => {
  it('has every id once, its keys in the registry form, a known context, and no default conflict', () => {
    const ids = KEYMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of KEYMAP) {
      expect(['sketch', 'model', 'any'], e.id).toContain(e.context);
      expect(e.label.trim(), e.id).not.toBe('');
      expect(e.group.trim(), e.id).not.toBe('');
      for (const k of e.keys) {
        expect(normaliseCombo(k), `${e.id} ${k}`).toBe(k);
        expect(comboProblem(k), `${e.id} ${k}`).toBe('');
      }
    }
    expect(conflictsIn()).toEqual([]);
    for (const [id, via] of Object.entries(SHOWN_VIA)) {
      expect(KEYMAP.some((e) => e.id === id) && KEYMAP.some((e) => e.id === via), id).toBe(true);
    }
    // Escape is built in: the app's, never a command's key.
    expect(KEYMAP.flatMap((e) => e.keys)).not.toContain('Escape');
  });

  it("no default takes the app's key, a reserved key, CAD's Escape or a number-pad digit (the build refuses one that does)", () => {
    // The host's contract (appCommands.ts APP_KEYS), in its three groups.
    expect(APP_SHORTCUTS.app.flatMap((g) => g.keys)).toEqual(['Ctrl+Slash', 'Meta+Slash', 'Ctrl+NumpadDivide', 'Meta+NumpadDivide', 'Ctrl+Meta+Slash', 'Ctrl+Meta+NumpadDivide']);
    expect(APP_SHORTCUTS.app.map((g) => g.label)).toEqual(['Open or close the Assistant panel']);
    expect(APP_SHORTCUTS.local.flatMap((g) => g.keys)).toEqual(['Escape']);
    expect(APP_SHORTCUTS.reserved.flatMap((g) => g.keys)).toEqual([
      'Ctrl+KeyW', 'Ctrl+F4', 'Ctrl+Shift+KeyW', 'Alt+F4', 'Ctrl+KeyT', 'Ctrl+Shift+KeyT', 'Ctrl+KeyN', 'Ctrl+Shift+KeyN',
      'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', ...'123456789'.split('').map((d) => `Ctrl+Digit${d}`),
      'Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'F5', 'Ctrl+F5', 'Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ', 'F12', 'F11', 'Ctrl+KeyP',
      'Ctrl+Equal', 'Ctrl+Shift+Equal', 'Ctrl+Minus', 'Ctrl+Digit0', 'Ctrl+NumpadAdd', 'Ctrl+NumpadSubtract', 'Tab', 'Shift+Tab',
    ]);
    for (const g of APP_SHORTCUTS.reserved) for (const k of g.keys) expect(RESERVED[k], k).toBe(g.label);
    expect(appClashesIn()).toEqual([]);
    // A default on any of them would be found, in the host's words.
    const on = (combo: string) => appClashesIn((id) => (id === 'sketch.line' ? [combo] : defaultKeys(id)));
    expect(on('Ctrl+Slash')).toEqual([{ combo: 'Ctrl+Slash', id: 'sketch.line', by: '"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)' }]);
    expect(on('Ctrl+KeyP')).toEqual([{ combo: 'Ctrl+KeyP', id: 'sketch.line', by: '"Ctrl+KeyP" is kept for the browser and the system (Print the page)' }]);
    expect(on('Escape')).toEqual([{ combo: 'Escape', id: 'sketch.line', by: '"Escape" is CAD\'s built-in cancel key (it cancels, closes and lets go of the selection), never a command\'s' }]);
    // The host's local Escape is no conflict of its own: CAD's built-in Escape is why.
    expect(appUseOf('Escape')).toBeNull();
  });

  it('refuses every reserved key in the host\'s words, read by the printed letter (AZERTY: the key labelled W is Ctrl+W)', () => {
    for (const [press, reason] of [
      [{ key: 'r', code: 'KeyR', ctrlKey: true }, '"Ctrl+KeyR" is kept for the browser and the system (Reload the page)'],
      [{ key: 'F5', code: 'F5' }, '"F5" is kept for the browser and the system (Reload the page)'],
      [{ key: 'w', code: 'KeyZ', ctrlKey: true }, '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)'],
      [{ key: 'F4', code: 'F4', ctrlKey: true }, '"Ctrl+F4" is kept for the browser and the system (Close the tab)'],
      [{ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }, '"Ctrl+Shift+KeyT" is kept for the browser and the system (Open a new tab)'],
      [{ key: 'n', code: 'KeyN', ctrlKey: true }, '"Ctrl+KeyN" is kept for the browser and the system (Open a new window)'],
      [{ key: 'Tab', code: 'Tab', ctrlKey: true }, '"Ctrl+Tab" is kept for the browser and the system (Switch tabs)'],
      [{ key: '7', code: 'Digit7', ctrlKey: true }, '"Ctrl+Digit7" is kept for the browser and the system (Switch tabs)'],
      [{ key: 'F4', code: 'F4', altKey: true }, '"Alt+F4" is kept for the browser and the system (Close the window)'],
      [{ key: 'F11', code: 'F11' }, '"F11" is kept for the browser and the system (Full screen)'],
      [{ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true }, '"Ctrl+Shift+KeyJ" is kept for the browser and the system (Open the developer tools)'],
      [{ key: 'p', code: 'KeyP', ctrlKey: true }, '"Ctrl+KeyP" is kept for the browser and the system (Print the page)'],
      [{ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }, '"Ctrl+Shift+Equal" is kept for the browser and the system (Zoom the page)'],
      [{ key: '+', code: 'NumpadAdd', ctrlKey: true }, '"Ctrl+NumpadAdd" is kept for the browser and the system (Zoom the page)'],
      [{ key: '0', code: 'Digit0', ctrlKey: true }, '"Ctrl+Digit0" is kept for the browser and the system (Zoom the page)'],
      [{ key: 'Tab', code: 'Tab', shiftKey: true }, '"Shift+Tab" is kept for the browser and the system (Move between controls)'],
      [{ key: '/', code: 'NumpadDivide', ctrlKey: true }, '"Ctrl+NumpadDivide" is the app\'s own key (Open or close the Assistant panel)'],
    ] as const) {
      expect(captureCombo(press), reason).toMatchObject({ kind: 'refused', reason });
      expect(comboProblem(comboOf(press)), reason).toBe(reason);
    }
  });

  it('a conflict is the same combo in the same context or with "any"', () => {
    // Sketch Undo and the model's Undo share Ctrl+Z (two contexts); Fit (any) and a sketch F would not.
    expect(defaultKeys('edit.undo')).toEqual(defaultKeys('sketch.undo'));
    expect(conflictsIn((id) => (id === 'sketch.line' ? ['KeyF'] : defaultKeys(id)))).toEqual([{ combo: 'KeyF', ids: ['view.fit', 'sketch.line'] }]);
    expect(conflictsIn((id) => (id === 'solid.revolve' ? ['KeyR'] : defaultKeys(id)))).toEqual([]);
  });
});

describe('combos: how a press is read, what people read, a key press captured', () => {
  it('normalises any way of writing a combo to modifiers (Ctrl, Alt, Shift) and the key code', () => {
    expect(normaliseCombo('shift+r')).toBe('Shift+KeyR');
    expect(normaliseCombo('Shift+KeyR')).toBe('Shift+KeyR');
    expect(normaliseCombo('alt+ctrl+shift+k')).toBe('Ctrl+Alt+Shift+KeyK');
    expect(normaliseCombo('Cmd+Z')).toBe('Ctrl+KeyZ');
    expect(normaliseCombo('1')).toBe('Digit1');
    expect(normaliseCombo('Ctrl+\\')).toBe('Ctrl+Backslash');
    expect(normaliseCombo('Ctrl+/')).toBe('Ctrl+Slash');
    expect(normaliseCombo('del')).toBe('Delete');
    expect(normaliseCombo('f2')).toBe('F2');
    expect(normaliseCombo('return')).toBe('Enter');
    expect(normaliseCombo('ctrl+pgdn')).toBe('Ctrl+PageDown');
    expect(normaliseCombo('ctrl+numpadadd')).toBe('Ctrl+NumpadAdd');
    expect(normaliseCombo('NumpadEqual')).toBe('NumpadEqual');
    expect(normaliseCombo('Ctrl+')).toBe('');
  });

  it('refuses text that is not a key, and a number-pad digit or Enter, in the host\'s words (review: a dead key could be stored)', () => {
    const notAKey = (raw: string) => `${JSON.stringify(raw)} is not a key ${'(modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent.code such as KeyR)'}`;
    for (const bad of ['Ctrl+PgDown2', 'Shift+?', 'Ctrl+é', 'AltGr+Q', 'Win+E', 'Ctrl+A+B', 'Ctrl+Cmd+K', 'Shift', 'F (no change)', 'Numpad55', '']) {
      expect(parseCombo(bad), bad).toEqual({ ok: false, why: notAKey(bad) });
      expect(normaliseCombo(bad), bad).toBe('');
      expect(comboProblem(bad), bad).toBe(notAKey(bad));
    }
    // The number pad's digits and Enter never come from a press: the host names the one to write, modifiers kept.
    expect(comboProblem('Numpad5')).toBe('"Numpad5" never comes from a press: write "Digit5"');
    expect(comboProblem('Ctrl+Shift+Numpad0')).toBe('"Ctrl+Shift+Numpad0" never comes from a press: write "Ctrl+Shift+Digit0"');
    expect(comboProblem('NumpadEnter')).toBe('"NumpadEnter" never comes from a press: write "Enter"');
    for (const c of ['NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEqual']) expect(isKeyCode(c), c).toBe(true);
    for (const c of ['Numpad5', 'NumpadEnter', 'ContextMenu', 'PrintScreen', 'PgDn', 'pagedown']) expect(isKeyCode(c), c).toBe(false);
    expect(isKeyCode('PageDown')).toBe(true);
  });

  it('reads a Latin letter by the letter it types (QWERTZ, AZERTY: Ctrl+Z is Undo on the key labelled Z), anything else by its place', () => {
    // US: Ctrl+Z.
    expect(comboOf({ key: 'z', code: 'KeyZ', ctrlKey: true })).toBe('Ctrl+KeyZ');
    // German QWERTZ: the key labelled Z is where US keyboards have Y.
    expect(comboOf({ key: 'z', code: 'KeyY', ctrlKey: true })).toBe('Ctrl+KeyZ');
    expect(comboOf({ key: 'y', code: 'KeyZ', ctrlKey: true })).toBe('Ctrl+KeyY');
    // French AZERTY: the key labelled Z is where US keyboards have W (never the browser's Ctrl+W).
    expect(comboOf({ key: 'z', code: 'KeyW', ctrlKey: true })).toBe('Ctrl+KeyZ');
    expect(comboOf({ key: 'R', code: 'KeyR', shiftKey: true })).toBe('Shift+KeyR');
    // No Latin letter (a Cyrillic layout, Option on a Mac): by the place.
    expect(comboOf({ key: 'я', code: 'KeyZ', ctrlKey: true })).toBe('Ctrl+KeyZ');
    expect(comboOf({ key: 'å', code: 'KeyA', altKey: true })).toBe('Alt+KeyA');
    // Digits by their place (AZERTY types & on it), the number pad as the digits.
    expect(comboOf({ key: '&', code: 'Digit1' })).toBe('Digit1');
    expect(comboOf({ key: '!', code: 'Digit1', shiftKey: true })).toBe('Shift+Digit1');
    expect(comboOf({ key: '1', code: 'Numpad1' })).toBe('Digit1');
    expect(comboOf({ key: 'z', metaKey: true })).toBe('Ctrl+KeyZ');
    expect(comboOf({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, ctrlKey: true })).toBe('Ctrl+Shift');
    // Punctuation by its place and by what it types (Ctrl+\ on a UK keyboard's \ key, as the app always read it).
    expect(combosOf({ key: '\\', code: 'IntlBackslash', ctrlKey: true })).toEqual(['Ctrl+IntlBackslash', 'Ctrl+Backslash']);
    expect(combosOf({ key: '#', code: 'Backslash', ctrlKey: true })).toEqual(['Ctrl+Backslash']);
    expect(combosOf({ key: '/', code: 'BracketLeft', ctrlKey: true })).toEqual(['Ctrl+BracketLeft', 'Ctrl+Slash']);
  });

  it('shows a combo as people read it: letters as the letter, punctuation through the layout when the browser gives it', () => {
    expect(displayCombo('Shift+KeyR')).toBe('Shift+R');
    expect(displayCombo('Digit8')).toBe('8');
    expect(displayCombo('Ctrl+Backslash')).toBe('Ctrl+\\');
    expect(displayCombo('Ctrl+Shift+KeyZ')).toBe('Ctrl+Shift+Z');
    expect(displayCombo('F2')).toBe('F2');
    // A German layout: Undo still reads Ctrl+Z (it is the key labelled Z), Backslash's place types #.
    const de = new Map([
      ['KeyZ', 'y'],
      ['Backslash', '#'],
    ]);
    expect(displayCombo('Ctrl+KeyZ', de)).toBe('Ctrl+Z');
    expect(displayCombo('Ctrl+Backslash', de)).toBe('Ctrl+#');
  });

  it('a press: modifiers alone wait, a free combo is taken, keys the browser or Magnusim keep are refused with why', () => {
    expect(captureCombo({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).toEqual({ kind: 'modifier', partial: 'Ctrl' });
    expect(captureCombo({ key: 'R', code: 'KeyR', shiftKey: true })).toEqual({ kind: 'combo', combo: 'Shift+KeyR' });
    expect(captureCombo({ key: 'w', code: 'KeyW', ctrlKey: true })).toEqual({ kind: 'refused', combo: 'Ctrl+KeyW', reason: '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)' });
    expect(captureCombo({ key: '/', code: 'Slash', ctrlKey: true })).toEqual({ kind: 'refused', combo: 'Ctrl+Slash', reason: '"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)' });
    // Escape is CAD's own cancel key (the host's Escape never sees keys typed in the Part): not the app's.
    expect(captureCombo({ key: 'Escape', code: 'Escape' })).toMatchObject({ kind: 'refused', reason: '"Escape" is CAD\'s built-in cancel key (it cancels, closes and lets go of the selection), never a command\'s' });
    expect(captureCombo({ key: '2', code: 'Digit2', ctrlKey: true })).toMatchObject({ kind: 'refused', reason: '"Ctrl+Digit2" is kept for the browser and the system (Switch tabs)' });
    // The number pad's 5 is read as Digit5 (as the host's Settings records it).
    expect(captureCombo({ key: '5', code: 'Numpad5', shiftKey: true })).toEqual({ kind: 'combo', combo: 'Shift+Digit5' });
    // The browser's and the app's keys by what the key types: AZERTY's W key (US Z's place), Dvorak's / key.
    expect(captureCombo({ key: 'w', code: 'KeyZ', ctrlKey: true })).toMatchObject({ kind: 'refused', reason: '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)' });
    expect(captureCombo({ key: '/', code: 'BracketLeft', ctrlKey: true })).toMatchObject({ kind: 'refused', combo: 'Ctrl+BracketLeft', reason: '"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)' });
    // A key no shortcut can name.
    expect(captureCombo({ key: 'MediaPlayPause', code: 'MediaPlayPause' })).toEqual({ kind: 'refused', combo: 'MediaPlayPause', reason: '"MediaPlayPause" cannot be a shortcut key' });
  });
});

describe('workspace/commands.json', () => {
  it('is the registry as the build writes it: version 1, the contexts, every command with id, label, group, context and keys', () => {
    const text = readFileSync(join(ROOT, 'workspace', 'commands.json'), 'utf8');
    expect(text).toBe(commandsJson());
    expect(text).not.toContain('\r');
    const json = JSON.parse(text) as { version: number; contexts: unknown; commands: Record<string, unknown>[] };
    expect(json.version).toBe(1);
    expect(json.contexts).toEqual([
      { id: 'sketch', label: 'Sketch' },
      { id: 'model', label: 'Model' },
    ]);
    expect(json.contexts).toEqual(CONTEXTS);
    expect(json.commands).toHaveLength(KEYMAP.length);
    for (const c of json.commands) expect(Object.keys(c)).toEqual(['id', 'label', 'group', 'context', 'keys']);
    expect(json.commands.find((c) => c.id === 'sketch.rectangle')).toEqual({ id: 'sketch.rectangle', label: 'Rectangle', group: 'Sketch: Draw', context: 'sketch', keys: ['KeyR'] });
  });
});

/** Every .ts/.tsx file of src/. */
function sources(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The code of a file without its comments (line comments and block comments). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

describe('every shortcut in the app comes from the registry', () => {
  it('no command sets a key of its own and no binding names one, but Escape (built in, the app’s own)', () => {
    const bad: string[] = [];
    for (const f of sources()) {
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      if (rel === 'src/app/keymap.ts') continue;
      const c = code(readFileSync(f, 'utf8'));
      for (const m of c.matchAll(/\bshortcut\s*:\s*['"`]([^'"`]*)['"`]/g)) bad.push(`${rel}: shortcut '${m[1]}'`);
      for (const m of c.matchAll(/\bcombo\s*:\s*['"`]([^'"`]*)['"`]/g)) if (m[1] !== 'Escape') bad.push(`${rel}: combo '${m[1]}'`);
    }
    expect(bad).toEqual([]);
  });

  it('the booted app: every registered command has its entry (same label, same mode), every command entry is registered, and the keys it binds are the registry’s', async () => {
    const ws = createFakeWorkspace({
      spawnWorker: () => {
        const w = new FakeWorker(okHandler());
        w.ready();
        return w as unknown as Worker;
      },
    });
    setFakeConnection(ws);
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    let services: AppServices | null = null;
    await act(async () => {
      services = await bootstrap(root);
    });
    await vi.waitFor(() => expect(root.querySelector('[data-cad-app]')?.getAttribute('data-kernel')).toBe('ready'));
    const s = services! as AppServices;
    const problems: string[] = [];
    const registered = s.commands.all();
    for (const c of registered) {
      const e = KEYMAP.find((x) => x.id === c.id);
      if (!e) {
        problems.push(`${c.id}: not in the registry`);
        continue;
      }
      if (e.keyOnly) problems.push(`${c.id}: a command, listed as keyboard-only`);
      if (e.label !== c.label) problems.push(`${c.id}: label ${c.label} in the app, ${e.label} in the registry`);
      if (e.context !== (c.mode ?? 'model')) problems.push(`${c.id}: mode ${c.mode ?? 'model'} in the app, context ${e.context} in the registry`);
      expect(s.commands.keys!(c.id), c.id).toEqual(e.keys);
    }
    for (const e of KEYMAP) if (!e.keyOnly && !registered.some((c) => c.id === e.id)) problems.push(`${e.id}: in the registry, not registered`);
    expect(problems).toEqual([]);
    // Tooltips show the registry's keys as people read them.
    expect(s.commands.get('sketch.rectangle')!.shortcut).toBe('R');
    expect(s.commands.get('view.front')!.shortcut).toBe('1');
    expect(s.commands.get('edit.redo')!.shortcut).toBe('Ctrl+Y');
    // Finish sketch shows Place or finish's Enter (it has no key of its own).
    expect(s.commands.keys!('sketch.finish')).toEqual([]);
    expect(s.commands.get('sketch.finish')!.shortcut).toBe('Enter');
    // Line's hint names 3-point arc's key (it makes the tangent arc in a line chain), the person's (review).
    const line = () => s.commands.get('sketch.line')!.hint;
    expect(line()).toBe('Chained lines, click by click; A or a drag from the end makes a tangent arc');
    const kb = keybindsFor(s);
    kb.setKeybind('sketch.arc', 'Shift+A');
    expect(line()).toBe('Chained lines, click by click; Shift+A or a drag from the end makes a tangent arc');
    kb.clear('sketch.arc');
    expect(line()).toBe('Chained lines, click by click; a drag from the end makes a tangent arc');
    kb.resetAll();
  });
});
