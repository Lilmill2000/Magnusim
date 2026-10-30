// Sketch Copy and Paste on the keyboard (src/sketch/tools/paste.ts, src/app/keyboard.ts): Ctrl+C and
// Ctrl+V are theirs in sketch mode (the keybinding registry's defaults, listed in Settings >
// Keybinds under Sketch), never in a text or number field (the browser copies and pastes the text
// there), never in model mode, and Copy with no sketch geometry selected leaves Ctrl+C to the
// browser (it copies the selected text): the press is not taken (no preventDefault). Nor with
// text selected on the page (the panel's red reason, selectable to copy into a report) while
// sketch geometry is selected: the real Copy command leaves the key, and the reason, alone.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { createKeybinds } from '../../src/app/keybinds';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import { appClashesIn, conflictsIn, keymapEntry, keymapFor } from '../../src/app/keymap';
import { createBus } from '../../src/lib/bus';
import { createStateStore } from '../../src/lib/store';
import type { SketchMode } from '../../src/sketch/mode';
import { forgetClip, pageTextSelected, peekClip, registerClipboardCommands } from '../../src/sketch/tools/paste';
import type { AppServices } from '../../src/types/app';

const services = {} as AppServices;

afterEach(() => {
  forgetClip();
  document.getSelection()?.removeAllRanges();
});

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

  it("the real Copy with sketch geometry selected: text selected on the page (the panel's red reason) keeps Ctrl+C the browser's, nothing copied and the reason as it was; let go of the text and Ctrl+C copies the geometry", async () => {
    const notes: (string | null)[] = [];
    const said = 'Not applied: Paste would over-define the sketch';
    const mode = {
      active: true,
      selected: () => [{ what: 'entity', id: 'e1' }],
      draft: () => ({ name: 'Sketch 1', points: { a: [0, 0], b: [10, 0] }, entities: [{ id: 'e1', kind: 'line', p: ['a', 'b'] }], constraints: [] }),
      note: (n: string | null) => notes.push(n),
      services: { doc: { units: { units: () => ({ length: 'mm', angle: 'deg' }) } } },
    } as unknown as SketchMode;
    const svc = { bridge: { toast() {} }, bus: createBus(), doc: { editable: () => true, session: () => null, state: createStateStore({ status: 'ready' }) } } as unknown as AppServices;
    const reg = createCommandRegistry(() => svc, createKeybinds({ prefs: null, layout: false }));
    svc.commands = reg;
    const offCmds = registerClipboardCommands(svc, mode);
    const kb = createKeyboard(document);
    const off = bindCommandShortcuts(reg, kb, undefined, () => 'sketch');
    const reason = document.createElement('div');
    reason.className = 'cad-reason';
    reason.textContent = said;
    document.body.append(reason);
    const press = () => {
      const e = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    try {
      const range = document.createRange();
      range.selectNodeContents(reason);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      expect(pageTextSelected()).toBe(true);
      expect(press()).toBe(false);
      await Promise.resolve();
      expect(peekClip()).toBeNull();
      expect(notes).toEqual([]);
      // The text let go: Ctrl+C is Copy again.
      document.getSelection()!.removeAllRanges();
      expect(pageTextSelected()).toBe(false);
      expect(press()).toBe(true);
      await vi.waitFor(() => expect(notes).toEqual(['Copied 1 line.']));
      expect(peekClip()?.entities.map((e) => e.id)).toEqual(['e1']);
    } finally {
      off();
      kb.dispose();
      offCmds();
      reason.remove();
    }
  });
});
