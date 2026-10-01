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
    reg.register({ id: 'solid.cyl', label: 'Cylinder', group: 'solid', icon: 'M0 0', order: 2, run() {} });
    reg.register({ id: 'solid.box', label: 'Box', group: 'solid', icon: 'M0 0', order: 1, run() {} });
    reg.register({ id: 'draw.line', label: 'Line', group: 'draw', mode: 'sketch', icon: 'M0 0', run() {} });
    const tb = reg.toolbar('model');
    expect(tb.map((g) => g.label)).toEqual(['SOLID', 'FILE']);
    expect(tb[0].commands.map((c) => c.id)).toEqual(['solid.box', 'solid.cyl']);
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
});
