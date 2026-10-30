// Sketch Copy and Paste on the keyboard (src/sketch/tools/paste.ts, src/app/keyboard.ts): Ctrl+C and
// Ctrl+V are theirs in sketch mode (the keybinding registry's defaults, listed in Settings >
// Keybinds under Sketch), never in a text or number field (the browser copies and pastes the text
// there), never in model mode, and Copy with no sketch geometry selected leaves Ctrl+C to the
// browser (it copies the selected text): the press is not taken (no preventDefault).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { createKeybinds } from '../../src/app/keybinds';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import { appClashesIn, conflictsIn, keymapEntry, keymapFor } from '../../src/app/keymap';
import type { AppServices } from '../../src/types/app';

const services = {} as AppServices;

describe('Copy and Paste keys', () => {
  it('are in the keybinding registry: Sketch, Ctrl+C and Ctrl+V, in both editions; no conflict, no key the app or the browser keeps', () => {
    expect(keymapEntry('sketch.copy')).toMatchObject({ label: 'Copy', group: 'Sketch', context: 'sketch', keys: ['Ctrl+KeyC'] });
    expect(keymapEntry('sketch.paste')).toMatchObject({ label: 'Paste', group: 'Sketch', context: 'sketch', keys: ['Ctrl+KeyV'] });
    for (const projects of [true, false]) {
      const ids = keymapFor(projects).map((e) => e.id);
      expect(ids).toContain('sketch.copy');
      expect(ids).toContain('sketch.paste');
      expect(conflictsIn(undefined, keymapFor(projects))).toEqual([]);
      expect(appClashesIn(undefined, null, keymapFor(projects))).toEqual([]);
    }
    // The person's Assistant panel key on Ctrl+C makes it the app's.
    expect(appClashesIn(undefined, ['Ctrl+KeyC'], keymapFor(false)).map((x) => x.id)).toEqual(['sketch.copy']);
  });

  it('in a sketch they run; in a text or number field the field keeps them; in model mode the browser has them; Copy with nothing to copy leaves Ctrl+C to the browser', async () => {
    const reg = createCommandRegistry(() => services, createKeybinds({ prefs: null, layout: false }));
    const kb = createKeyboard(document);
    const copy = vi.fn();
    const paste = vi.fn();
    let selected = true;
    reg.register({ id: 'sketch.copy', label: 'Copy', mode: 'sketch', passKey: () => !selected, run: copy });
    reg.register({ id: 'sketch.paste', label: 'Paste', mode: 'sketch', run: paste });
    let mode: 'model' | 'sketch' = 'sketch';
    const off = bindCommandShortcuts(reg, kb, undefined, () => mode);
    const press = (target: EventTarget, key: 'c' | 'v') => {
      const e = new KeyboardEvent('keydown', { key, code: key === 'c' ? 'KeyC' : 'KeyV', ctrlKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // In the sketch: theirs.
    expect(press(document.body, 'c')).toBe(true);
    expect(press(document.body, 'v')).toBe(true);
    await Promise.resolve();
    expect([copy.mock.calls.length, paste.mock.calls.length]).toEqual([1, 1]);
    // A number field (a dimension's value box), a text field, a text area: the field's.
    const number = document.createElement('input');
    number.type = 'number';
    const text = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(number, text, area);
    for (const f of [number, text, area]) {
      f.focus();
      expect(press(f, 'c')).toBe(false);
      expect(press(f, 'v')).toBe(false);
    }
    await Promise.resolve();
    expect([copy.mock.calls.length, paste.mock.calls.length]).toEqual([1, 1]);
    // Nothing of the sketch selected: Ctrl+C is the browser's (selected text), not taken.
    selected = false;
    expect(press(document.body, 'c')).toBe(false);
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
    // Model mode: no command has them.
    selected = true;
    mode = 'model';
    expect(press(document.body, 'c')).toBe(false);
    expect(press(document.body, 'v')).toBe(false);
    await Promise.resolve();
    expect([copy.mock.calls.length, paste.mock.calls.length]).toEqual([1, 1]);
    for (const f of [number, text, area]) f.remove();
    off();
    kb.dispose();
  });
});
