// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { createKeybinds } from '../../src/app/keybinds';
import { bindCommandShortcuts, comboOf, createKeyboard, isToolKeyAgain, normaliseCombo, toolKeyAgain } from '../../src/app/keyboard';
import { createStateStore } from '../../src/lib/store';
import type { CommandDef } from '../../src/types/commands';
import type { SketchModeState } from '../../src/types/sketch';
import type { AppServices } from '../../src/types/app';

const services = {} as AppServices;

describe('command registry', () => {
  it('groups toolbar commands by mode in display order and hides empty groups', () => {
    const reg = createCommandRegistry(() => services);
    expect(reg.toolbar('model')).toEqual([]);
    reg.register({ id: 'file.export', label: 'Export', group: 'file', icon: 'M0 0', run() {} });
    reg.register({ id: 'solid.revolve', label: 'Revolve', group: 'solid', icon: 'M0 0', order: 2, run() {} });
    reg.register({ id: 'solid.extrude', label: 'Extrude', group: 'solid', icon: 'M0 0', order: 1, run() {} });
    reg.register({ id: 'draw.line', label: 'Line', group: 'draw', mode: 'sketch', icon: 'M0 0', run() {} });
    const tb = reg.toolbar('model');
    expect(tb.map((g) => g.label)).toEqual(['SOLID', 'FILE']);
    expect(tb[0].commands.map((c) => c.id)).toEqual(['solid.extrude', 'solid.revolve']);
    expect(reg.toolbar('sketch').map((g) => g.label)).toEqual(['DRAW']);
  });

  it('refuses a toolbar command without an icon, and run() returns the disabled reason', async () => {
    const reg = createCommandRegistry(() => services);
    expect(() => reg.register({ id: 'x', label: 'X', group: 'solid', run() {} })).toThrow(/icon/);
    const run = vi.fn();
    reg.register({ id: 'edit.undo', label: 'Undo', enabled: () => 'Nothing to undo', run });
    expect(await reg.run('edit.undo')).toBe('Nothing to undo');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('normalises combos', () => {
    // Written with KeyboardEvent.code names (src/app/keymap.ts).
    expect(normaliseCombo('cmd+shift+z')).toBe('Ctrl+Shift+KeyZ');
    expect(normaliseCombo('Shift+f')).toBe('Shift+KeyF');
    expect(normaliseCombo('esc')).toBe('Escape');
    expect(comboOf(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe('Ctrl+KeyZ');
    // A letter is the letter the key types, wherever the layout puts it.
    expect(comboOf(new KeyboardEvent('keydown', { key: 'y', code: 'KeyZ', ctrlKey: true }))).toBe('Ctrl+KeyY');
  });

  it("a key a control already handled (preventDefault) is the control's: no shortcut runs too (review: Delete on a ribbon width line deleted the selected feature)", () => {
    const kb = createKeyboard(document);
    const del = vi.fn();
    kb.bind({ combo: 'Delete', run: del });
    const line = document.createElement('div');
    line.tabIndex = 0;
    line.addEventListener('keydown', (e) => {
      if (e.key === 'Delete') e.preventDefault();
    });
    document.body.append(line);
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }));
    expect(del).not.toHaveBeenCalled();
    // Not handled there: the shortcut runs.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }));
    expect(del).toHaveBeenCalledTimes(1);
    line.remove();
    kb.dispose();
  });

  it("Undo and Redo stay on the keys labelled Z and Y on QWERTZ and AZERTY (review: they swapped, or Undo went to the browser's close-tab key)", async () => {
    const reg = createCommandRegistry(() => services);
    const kb = createKeyboard(document);
    const undo = vi.fn();
    const redo = vi.fn();
    reg.register({ id: 'edit.undo', label: 'Undo', run: undo });
    reg.register({ id: 'edit.redo', label: 'Redo', run: redo });
    const off = bindCommandShortcuts(reg, kb);
    const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, ...init }));
    // German QWERTZ: Z is where US keyboards have Y, and Y where they have Z.
    press({ key: 'z', code: 'KeyY' });
    await Promise.resolve();
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([1, 0]);
    press({ key: 'y', code: 'KeyZ' });
    await Promise.resolve();
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([1, 1]);
    // French AZERTY: Z is where US keyboards have W.
    press({ key: 'z', code: 'KeyW' });
    await Promise.resolve();
    expect(undo).toHaveBeenCalledTimes(2);
    // The tooltip reads Ctrl+Z on every layout.
    expect(reg.get('edit.undo')!.shortcut).toBe('Ctrl+Z');
    off();
    kb.dispose();
  });

  it('only Undo and Redo themselves, on Ctrl keys, reach the app from an untouched field: a letter rebound to Redo is typed (review)', async () => {
    const keybinds = createKeybinds({ prefs: null, layout: false });
    const reg = createCommandRegistry(() => services, keybinds);
    const kb = createKeyboard(document);
    const redo = vi.fn();
    const rect = vi.fn();
    reg.register({ id: 'edit.redo', label: 'Redo', run: redo });
    reg.register({ id: 'sketch.rectangle', label: 'Rectangle', mode: 'sketch', run: rect });
    // Redo (model) on R: no conflict with Rectangle's R (sketch only).
    expect(keybinds.setKeybind('edit.redo', 'R')).toMatchObject({ ok: true });
    let mode: 'model' | 'sketch' = 'model';
    const off = bindCommandShortcuts(reg, kb, undefined, () => mode);
    const input = document.createElement('input');
    input.setAttribute('data-undo-to-app', '1');
    document.body.append(input);
    const key = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // The field keeps the letter in both modes.
    expect(key({ key: 'r', code: 'KeyR' })).toBe(false);
    mode = 'sketch';
    expect(key({ key: 'r', code: 'KeyR' })).toBe(false);
    await Promise.resolve();
    expect(redo).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
    // Ctrl+Y is not Redo's any more (Redo has only R): the field keeps it too.
    mode = 'model';
    expect(key({ key: 'y', code: 'KeyY', ctrlKey: true })).toBe(false);
    // Outside a field R is Redo.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true }));
    await Promise.resolve();
    expect(redo).toHaveBeenCalledTimes(1);
    input.remove();
    off();
    kb.dispose();
  });

  it('runs command shortcuts, but not while typing in an input', async () => {
    const reg = createCommandRegistry(() => services);
    const kb = createKeyboard(document);
    const run = vi.fn();
    reg.register({ id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', run });
    bindCommandShortcuts(reg, kb);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    kb.dispose();
  });

  it("ux010: Enter on a menu item, or on a button the keyboard focused, is the control's own; after a mouse click on a button Enter runs the shortcut as before", async () => {
    const reg = createCommandRegistry(() => services);
    const kb = createKeyboard(document);
    const finish = vi.fn();
    reg.register({ id: 'sketch.finish', label: 'Finish sketch', shortcut: 'Enter', run: finish });
    bindCommandShortcuts(reg, kb);
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    const button = document.createElement('button');
    const inner = document.createElement('span');
    button.append(inner);
    document.body.append(item, button);
    const enter = (el: Element) => {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    // A menu item: always its own (however it got the focus).
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    item.focus();
    expect(enter(item)).toBe(false);
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    // A button the keyboard focused (Tab): its own.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    button.focus();
    expect(enter(button)).toBe(false);
    expect(enter(inner)).toBe(false);
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    // The same button clicked with the mouse: Enter runs Finish sketch, as before.
    button.blur();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    button.focus();
    expect(enter(button)).toBe(true);
    await Promise.resolve();
    expect(finish).toHaveBeenCalledTimes(1);
    // Nothing focused: the shortcut.
    button.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(finish).toHaveBeenCalledTimes(2);
    item.remove();
    button.remove();
    kb.dispose();
  });

  it('a field marked data-undo-to-app hands Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z to the app, and the browser does not undo its text (review P2/P3 round 3)', async () => {
    const reg = createCommandRegistry(() => services);
    const kb = createKeyboard(document);
    const undo = vi.fn();
    const redo = vi.fn();
    const other = vi.fn();
    // Their keys are the keybinding registry's: Ctrl+Z; Ctrl+Y and Ctrl+Shift+Z; F.
    reg.register({ id: 'edit.undo', label: 'Undo', run: undo });
    reg.register({ id: 'edit.redo', label: 'Redo', run: redo });
    reg.register({ id: 'view.fit', label: 'Fit', mode: 'any', run: other });
    bindCommandShortcuts(reg, kb);
    const input = document.createElement('input');
    input.setAttribute('data-undo-to-app', '1');
    document.body.append(input);
    const key = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(key({ key: 'z', ctrlKey: true })).toBe(true);
    expect(key({ key: 'y', ctrlKey: true })).toBe(true);
    expect(key({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe(true);
    await Promise.resolve();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
    // Other shortcuts still type into the field.
    expect(key({ key: 'f' })).toBe(false);
    expect(other).not.toHaveBeenCalled();
    // Without the mark (something typed), Ctrl+Z stays with the field.
    input.removeAttribute('data-undo-to-app');
    expect(key({ key: 'z', ctrlKey: true })).toBe(false);
    await Promise.resolve();
    expect(undo).toHaveBeenCalledTimes(1);
    input.remove();
    kb.dispose();
  });
});

// Daniel (2026-10-28): "I want to be able to draw a line and then press L, and it fully escapes out
// of the line tool altogether, not just like pressing Escape once".
describe("a sketch tool's key pressed again", () => {
  const tool = (id: string, sketchTool: string, flyout?: string): CommandDef => ({ id, label: id, mode: 'sketch', activeWhen: { sketchTool }, ...(flyout ? { flyout } : {}), run() {} });
  const line = tool('sketch.line', 'line', 'line');
  const centerline = tool('sketch.centerline', 'centerline', 'line');
  const rect = tool('sketch.rectangle', 'rectangle-corner', 'rectangle');
  const rectCenter = tool('sketch.rectangle-center', 'rectangle-center', 'rectangle');
  const dim = tool('sketch.dimension', 'dimension');
  const all = [line, centerline, rect, rectCenter, dim, { id: 'sketch.construction', label: 'Construction', mode: 'sketch', run() {} } as CommandDef];

  it("is the key of the tool in hand, or of its flyout's variant in hand; never Select, never another tool, never a command that is no tool", () => {
    expect(isToolKeyAgain(line, 'line', all)).toBe(true);
    expect(isToolKeyAgain(dim, 'dimension', all)).toBe(true);
    // The Rectangle flyout's R with Center rectangle in hand; the Line flyout's L with Centerline.
    expect(isToolKeyAgain(rect, 'rectangle-center', all)).toBe(true);
    expect(isToolKeyAgain(line, 'centerline', all)).toBe(true);
    // Another tool's key switches to it, as before.
    expect(isToolKeyAgain(rect, 'line', all)).toBe(false);
    expect(isToolKeyAgain(dim, 'line', all)).toBe(false);
    expect(isToolKeyAgain(line, 'select', all)).toBe(false);
    expect(isToolKeyAgain(line, null, all)).toBe(false);
    expect(isToolKeyAgain(all[5], 'line', all)).toBe(false);
  });

  it("a variant's own key with another variant of its flyout in hand switches to it: only the flyout's own key (its bar command's) leaves a variant", () => {
    // Centerline's key (the person gave it one) with Line in hand: Centerline, as its flyout row says.
    expect(isToolKeyAgain(centerline, 'line', all)).toBe(false);
    expect(isToolKeyAgain(rectCenter, 'rectangle-corner', all)).toBe(false);
    // Its own tool in hand: the key leaves it.
    expect(isToolKeyAgain(centerline, 'centerline', all)).toBe(true);
    expect(isToolKeyAgain(rectCenter, 'rectangle-center', all)).toBe(true);
    // A flyout whose main is not registered: its first variant by order stands for it on the bar.
    const ellipse = { ...tool('sketch.ellipse-partial', 'ellipse-partial', 'ellipse'), order: 21 };
    const parabola = { ...tool('sketch.parabola', 'parabola', 'ellipse'), order: 22 };
    expect(isToolKeyAgain(ellipse, 'parabola', [ellipse, parabola])).toBe(true);
    expect(isToolKeyAgain(parabola, 'ellipse-partial', [ellipse, parabola])).toBe(false);
  });

  function setup(active: string) {
    const keybinds = createKeybinds({ prefs: null, layout: false });
    const reg = createCommandRegistry(() => services, keybinds);
    const kb = createKeyboard(document);
    const ran: string[] = [];
    for (const c of [line, rect, rectCenter, dim]) reg.register({ ...c, run: () => void ran.push(c.id) });
    const state = createStateStore<SketchModeState>({ feature: 'f', tool: active as SketchModeState['tool'], status: null, analyzing: false, typing: false });
    const left: string[] = [];
    const sketch = {
      state,
      leaveTool: () => {
        const was = state.get().tool;
        if (was === 'select') return false;
        left.push(was);
        state.set({ tool: 'select' });
        return true;
      },
    };
    const off = bindCommandShortcuts(reg, kb, undefined, () => 'sketch', (c) => toolKeyAgain(sketch, c, reg.all()));
    const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return { keybinds, reg, kb, ran, state, left, press, dispose: () => (off(), kb.dispose()) };
  }

  it('L with Line in hand leaves it (the command does not run again); L again takes it up; another key switches as before', async () => {
    const t = setup('line');
    expect(t.press({ key: 'l', code: 'KeyL' })).toBe(true);
    await Promise.resolve();
    expect(t.left).toEqual(['line']);
    expect(t.ran).toEqual([]);
    expect(t.state.get().tool).toBe('select');
    // From Select: L takes up the Line tool (the command runs).
    t.press({ key: 'l', code: 'KeyL' });
    await Promise.resolve();
    expect(t.ran).toEqual(['sketch.line']);
    // D with Line in hand: Dimension runs (no leaving).
    t.state.set({ tool: 'line' });
    t.press({ key: 'd', code: 'KeyD' });
    await Promise.resolve();
    expect(t.ran).toEqual(['sketch.line', 'sketch.dimension']);
    expect(t.left).toEqual(['line']);
    // R with Center rectangle in hand (the Rectangle flyout's key): leaves it.
    t.state.set({ tool: 'rectangle-center' });
    t.press({ key: 'r', code: 'KeyR' });
    await Promise.resolve();
    expect(t.left).toEqual(['line', 'rectangle-center']);
    t.dispose();
  });

  it("follows the person's keybind: Line on G, G leaves it and L is no key of it; a held key acts once; a key typed in a field stays there", async () => {
    const t = setup('line');
    expect(t.keybinds.setKeybind('sketch.line', 'G')).toMatchObject({ ok: true });
    t.press({ key: 'l', code: 'KeyL' });
    await Promise.resolve();
    expect(t.left).toEqual([]);
    expect(t.state.get().tool).toBe('line');
    t.press({ key: 'g', code: 'KeyG' });
    await Promise.resolve();
    expect(t.left).toEqual(['line']);
    // Held: the repeats neither take the tool up again nor run anything.
    expect(t.press({ key: 'g', code: 'KeyG', repeat: true })).toBe(true);
    expect(t.press({ key: 'g', code: 'KeyG', repeat: true })).toBe(true);
    await Promise.resolve();
    expect(t.state.get().tool).toBe('select');
    expect(t.ran).toEqual([]);
    // In a value box: the key is the box's.
    t.state.set({ tool: 'line' });
    const input = document.createElement('input');
    document.body.append(input);
    expect(t.press({ key: 'g', code: 'KeyG' }, input)).toBe(false);
    await Promise.resolve();
    expect(t.left).toEqual(['line']);
    expect(t.state.get().tool).toBe('line');
    input.remove();
    t.dispose();
  });
});
