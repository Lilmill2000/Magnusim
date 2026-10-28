import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The cases python/tools/workspace_commands.py answers too (test_workspace_commands.py).
import CASES from '../../scripts/__tests__/fixtures/workspace-commands-cases.json';
import { isDockKey } from '../assistant/dock/toggle';
import { APP_COMMANDS, APP_KEYS, APP_LOCAL_KEYS, RESERVED_KEYS } from './appCommands';
import { type CommandsFile, comboOf, isCombo, KEY_CODES, readCommandsFile, readKeybindOverrides, sharedCommandIds } from './commands';

const NO_KEYS = { app: [], local: [], reserved: [] };

// A key press: its code, the character it types (key) and the modifiers held.
const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}, key = '') => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  code,
  key,
  ...mods,
});

describe('a workspace commands file', () => {
  for (const c of CASES.cases) {
    it(c.name, () => {
      const { file, problems } = readCommandsFile(c.doc);
      expect(problems).toEqual(c.problems);
      expect(file === null).toBe(c.problems.length > 0);
    });
  }

  for (const p of CASES.plugins) {
    it(`a plugin: ${p.name}`, () => {
      const workspaces = p.workspaces.map((w) => ({ key: w.key, file: readCommandsFile(w.doc).file as CommandsFile }));
      expect(workspaces.every((w) => w.file)).toBe(true);
      expect(sharedCommandIds(workspaces)).toEqual(p.problems);
    });
  }

  it('a good file reads as its contexts and commands, a group left out read as ""', () => {
    const { file } = readCommandsFile(CASES.cases[0].doc);
    expect(file?.contexts).toEqual([{ id: 'sketch', label: 'Sketch' }, { id: 'model', label: 'Model' }]);
    expect(file?.commands[2]).toEqual({ id: 'edit.undo', label: 'Undo', group: '', context: 'any', keys: ['Ctrl+KeyZ'] });
    expect(file?.commands.map((c) => c.id)).toEqual(['sketch.rectangle', 'model.extrude', 'edit.undo', 'view.fit', 'sketch.dim-2']);
  });
});

describe('keys', () => {
  it('a combo: modifiers in the order Ctrl, Alt, Shift, Meta, each once, then a KeyboardEvent.code', () => {
    for (const ok of ['KeyR', 'Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'Ctrl+Alt+Shift+Meta+F24', 'Alt+Digit0', 'Meta+Slash', 'Escape', 'Shift+Space']) expect(isCombo(ok), ok).toBe(true);
    for (const bad of ['R', 'Ctrl+R', 'Shift+Ctrl+KeyR', 'Ctrl+Ctrl+KeyR', 'Ctrl', 'Ctrl+', '+KeyR', 'ControlLeft', 'Cmd+KeyR', 'F25', '', null, 5]) expect(isCombo(bad), String(bad)).toBe(false);
  });

  it("a key press's combo, read as the CAD plugin reads it; a modifier alone or a key no combo names is none", () => {
    expect(comboOf(press('KeyR', {}, 'r'))).toBe('KeyR');
    expect(comboOf(press('KeyR', { shiftKey: true, ctrlKey: true }, 'R'))).toBe('Ctrl+Shift+KeyR');
    // Cmd counts as Ctrl.
    expect(comboOf(press('KeyZ', { metaKey: true }, 'z'))).toBe('Ctrl+KeyZ');
    expect(comboOf(press('F2', { metaKey: true, altKey: true }, 'F2'))).toBe('Ctrl+Alt+F2');
    // A Latin letter by the letter it types: Z on a QWERTZ keyboard sits where Y is on QWERTY.
    expect(comboOf(press('KeyY', { ctrlKey: true }, 'z'))).toBe('Ctrl+KeyZ');
    // Not a Latin letter (a Greek layout, an Option letter): by its place.
    expect(comboOf(press('KeyR', { ctrlKey: true }, 'ρ'))).toBe('Ctrl+KeyR');
    expect(comboOf(press('KeyR', { altKey: true }, '®'))).toBe('Alt+KeyR');
    // The number pad's digits and Enter as Digit and Enter; its other keys by their place.
    expect(comboOf(press('Numpad5', {}, '5'))).toBe('Digit5');
    expect(comboOf(press('NumpadEnter', { ctrlKey: true }, 'Enter'))).toBe('Ctrl+Enter');
    expect(comboOf(press('NumpadDivide', { ctrlKey: true }, '/'))).toBe('Ctrl+NumpadDivide');
    expect(comboOf(press('Digit7', { shiftKey: true }, '/'))).toBe('Shift+Digit7');
    expect(comboOf(press('ShiftLeft', { shiftKey: true }, 'Shift'))).toBeNull();
    expect(comboOf(press('MediaPlayPause', {}, 'MediaPlayPause'))).toBeNull();
    for (const code of KEY_CODES) expect(isCombo(comboOf(press(code, { ctrlKey: true, shiftKey: true }, code))), code).toBe(true);
  });
});

describe("the app's own keys", () => {
  it('are three groups of commands with combos, all in the "any" context, no key in two of them', () => {
    expect(APP_KEYS).toEqual({ app: APP_COMMANDS, local: APP_LOCAL_KEYS, reserved: RESERVED_KEYS });
    const seen = new Set<string>();
    for (const c of [...APP_COMMANDS, ...APP_LOCAL_KEYS, ...RESERVED_KEYS]) {
      expect(c.context).toBe('any');
      for (const k of c.keys) {
        expect(isCombo(k), k).toBe(true);
        expect(seen.has(k), `${k} twice`).toBe(false);
        seen.add(k);
      }
      // Their shape is a command's (more keys than a workspace command may have, fine for the app).
      expect(readCommandsFile({ version: 1, contexts: [], commands: [{ ...c, keys: c.keys.slice(0, 4) }] }, NO_KEYS).problems).toEqual([]);
    }
    expect(APP_LOCAL_KEYS.flatMap((c) => c.keys)).toEqual(['Escape']);
  });

  it('the app and reserved keys are no command\'s; a local key (Escape) is a workspace\'s to use', () => {
    const one = (keys: string[]) => readCommandsFile({ version: 1, contexts: [], commands: [{ id: 'a', label: 'A', context: 'any', keys }] }).problems;
    expect(one(['Escape'])).toEqual([]);
    for (const c of [...APP_COMMANDS, ...RESERVED_KEYS]) for (const k of c.keys) expect(one([k]), k).toHaveLength(1);
  });

  // Every key with Ctrl or Cmd that types "/" on every layout, as the page and the SDK act on it.
  it("are the Assistant panel's keys: each is the page's own (toggle.ts isDockKey) or the SDK's forward from a workspace", () => {
    const dock = APP_COMMANDS.find((c) => c.id === 'app.assistant');
    expect(dock?.keys).toEqual(['Ctrl+Slash', 'Meta+Slash', 'Ctrl+NumpadDivide', 'Meta+NumpadDivide', 'Ctrl+Meta+Slash', 'Ctrl+Meta+NumpadDivide']);
    const event = (combo: string) => {
      const parts = combo.split('+');
      const code = parts.pop() as string;
      return { code, key: '/', ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: parts.includes('Meta') } as KeyboardEvent;
    };
    // src/plugin-sdk/workspace.ts forwards Ctrl or Cmd (or both) with no Alt or Shift on the key that types "/".
    const forwarded = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '/';
    for (const k of dock?.keys ?? []) {
      const e = event(k);
      expect(isDockKey(e, false) || isDockKey(e, true) || forwarded(e), k).toBe(true);
      expect(forwarded(e), k).toBe(true);
    }
    expect(isDockKey(event('Ctrl+NumpadDivide'), false)).toBe(true);
    expect(isDockKey(event('Meta+NumpadDivide'), true)).toBe(true);
    const sdk = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin-sdk', 'workspace.ts'), 'utf8');
    expect(sdk).toContain("if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;");
    expect(sdk).toContain("if (e.key !== '/') return;");
  });
});

describe("the person's keys (the plugin's prefs key \"keybinds\")", () => {
  const commands = [{ id: 'sketch.rectangle' }, { id: 'model.extrude' }, { id: 'view.fit' }];

  it('keeps known commands with their valid keys; [] means none; the rest is left out', () => {
    expect(
      readKeybindOverrides(
        {
          'sketch.rectangle': ['Shift+KeyR', 'Ctrl+R', 'Shift+KeyR'],
          'model.extrude': [],
          'view.fit': 'KeyF',
          'gone.command': ['KeyG'],
        },
        commands,
      ),
    ).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': [] });
    expect(readKeybindOverrides({ 'view.fit': ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE'] }, commands)).toEqual({ 'view.fit': ['KeyA', 'KeyB', 'KeyC', 'KeyD'] });
    for (const v of [null, [], 'x', 3]) expect(readKeybindOverrides(v, commands)).toEqual({});
  });

  it("drops the app's and the browser's keys (a local one, Escape, is a workspace's), and an id with no key left has its defaults", () => {
    expect(
      readKeybindOverrides(
        {
          'sketch.rectangle': ['Ctrl+KeyW', 'Shift+KeyR'],
          'model.extrude': ['Ctrl+Slash', 'Escape', 'F5'],
          'view.fit': ['Nope'],
        },
        commands,
      ),
    ).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'model.extrude': ['Escape'] });
    expect(readKeybindOverrides({ 'model.extrude': ['Ctrl+Slash'] }, commands, NO_KEYS)).toEqual({ 'model.extrude': ['Ctrl+Slash'] });
  });

  it('a command named like an object property is looked up as any other: no prototype answers for it', () => {
    const odd = [{ id: 'constructor' }, { id: 'tostring' }, { id: '__proto__' }];
    const none = readKeybindOverrides({}, odd);
    expect(Object.getPrototypeOf(none)).toBeNull();
    expect('constructor' in none).toBe(false);
    const set = readKeybindOverrides(JSON.parse('{"__proto__": ["KeyA"], "constructor": []}'), odd);
    expect(Object.getPrototypeOf(set)).toBeNull();
    expect(Object.keys(set)).toEqual(['__proto__', 'constructor']);
    expect(set['__proto__']).toEqual(['KeyA']);
    expect(set.constructor).toEqual([]);
  });
});
