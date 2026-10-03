// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandShortcuts, comboOf, createKeyboard, normaliseCombo } from '../../src/app/keyboard';
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
    expect(normaliseCombo('cmd+shift+z')).toBe('Ctrl+Shift+Z');
    expect(normaliseCombo('Shift+f')).toBe('Shift+F');
    expect(normaliseCombo('esc')).toBe('Escape');
    expect(comboOf(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe('Ctrl+Z');
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

  it('a field marked data-undo-to-app hands Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z to the app, and the browser does not undo its text (review P2/P3 round 3)', async () => {
    const reg = createCommandRegistry(() => services);
    const kb = createKeyboard(document);
    const undo = vi.fn();
    const redo = vi.fn();
    const other = vi.fn();
    reg.register({ id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', run: undo });
    reg.register({ id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', run: redo });
    reg.register({ id: 'view.fit', label: 'Fit', shortcut: 'F', run: other });
    bindCommandShortcuts(reg, kb);
    kb.bind({ combo: 'Ctrl+Shift+Z', run: () => void reg.run('edit.redo') });
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
