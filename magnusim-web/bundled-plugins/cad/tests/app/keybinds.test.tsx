// The person's keybinds (src/app/keybinds.ts) and the Set keybind dialog (src/ui/keybinds):
// set, a conflict with the command that has the combo (Replace or Cancel), replace, reset to
// default, clear, current; the overrides as ws.prefs keeps them (physical keys, [] cleared, missing
// the defaults); a change made elsewhere (Settings) taking effect live in the keyboard, the
// tooltips and the keyboard-only actions; the layout's labels; and the dialog as the person uses it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandKeys, createKeybinds, KEYBINDS_PREF, keybindsFor, parseOverrides, setKeybindsFor } from '../../src/app/keybinds';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import type { PrefsApi } from '../../src/lib/bridge';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import { keybindMenuItem, openSetKeybind } from '../../src/ui/keybinds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** ws.prefs in memory; `elsewhere` is a change made outside the page (Settings, another tab). */
function memoryPrefs(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  const writes: string[] = [];
  const listeners = new Set<(key: string, value: unknown) => void>();
  const api: PrefsApi = {
    get: async <T,>(key: string) => (key in values ? (JSON.parse(JSON.stringify(values[key])) as T) : null),
    set: async (key, value) => {
      writes.push(`set ${key}`);
      values[key] = JSON.parse(JSON.stringify(value));
    },
    remove: async (key) => {
      writes.push(`remove ${key}`);
      delete values[key];
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const elsewhere = (key: string, value: unknown) => {
    if (value === null) delete values[key];
    else values[key] = value;
    for (const fn of [...listeners]) fn(key, value);
  };
  return { api, values, writes, elsewhere };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the keybinds model', () => {
  it('set, conflict (with the command that has it), replace, reset to default and clear; current and the stored overrides', async () => {
    const p = memoryPrefs();
    const k = createKeybinds({ prefs: p.api, layout: false });
    await k.ready;
    expect(k.current('sketch.rectangle')).toEqual(['KeyR']);
    expect(k.isDefault('sketch.rectangle')).toBe(true);
    // A free combo: set at once (its only key), stored by its physical key.
    expect(k.setKeybind('sketch.rectangle', 'Shift+T')).toEqual({ ok: true, id: 'sketch.rectangle', keys: ['Shift+KeyT'], was: ['KeyR'] });
    expect(await k.flush()).toBe(true);
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'sketch.rectangle': ['Shift+KeyT'] });
    // Another command's combo in a context that meets: a conflict naming it, nothing changed.
    const c = k.setKeybind('sketch.rectangle', 'Shift+R');
    expect(c).toMatchObject({ ok: false, reason: 'conflict', combo: 'Shift+KeyR', with: 'view.sketch-relations', label: 'Show relations' });
    expect(k.current('sketch.rectangle')).toEqual(['Shift+KeyT']);
    // The same combo in the other mode is no conflict (Ctrl+Z is the model's Undo and the sketch's).
    expect(k.conflictsWith('solid.revolve', 'R')).toEqual([]);
    expect(k.conflictsWith('sketch.line', 'F')).toEqual(['view.fit']);
    // Replace takes it from the other command.
    expect(k.replace('sketch.rectangle', 'Shift+R')).toMatchObject({ ok: true, keys: ['Shift+KeyR'], took: [{ id: 'view.sketch-relations', label: 'Show relations' }] });
    expect(k.current('view.sketch-relations')).toEqual([]);
    // Reset: its default, unless another command has it now.
    k.setKeybind('sketch.line', 'R');
    expect(k.resetToDefault('sketch.rectangle')).toMatchObject({ ok: false, reason: 'conflict', with: 'sketch.line' });
    expect(k.resetToDefault('sketch.rectangle', { replace: true })).toMatchObject({ ok: true, keys: ['KeyR'] });
    expect(k.isDefault('sketch.rectangle')).toBe(true);
    expect(k.clear('sketch.circle')).toMatchObject({ ok: true, keys: [] });
    await k.flush();
    // [] cleared, a default left out.
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'view.sketch-relations': [], 'sketch.line': [], 'sketch.circle': [] });
    // Refused: unknown, the browser's, the app's own.
    expect(k.setKeybind('nope', 'K')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(k.setKeybind('sketch.circle', 'Ctrl+W')).toMatchObject({ ok: false, reason: 'refused', message: '"Ctrl+KeyW" is kept for the browser and the system (Close the tab)' });
    expect(k.setKeybind('sketch.circle', 'Ctrl+/')).toMatchObject({ ok: false, reason: 'refused', message: '"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)' });
    k.resetAll();
    await k.flush();
    expect(p.values[KEYBINDS_PREF]).toBeUndefined();
    expect(p.writes.at(-1)).toBe(`remove ${KEYBINDS_PREF}`);
  });

  it('reads the stored overrides, keeping only known commands and keys it can have', async () => {
    expect(parseOverrides({ 'sketch.rectangle': ['shift+r', 'Shift+KeyR', 7], 'nope.x': ['K'], 'sketch.line': [], 'sketch.circle': ['Ctrl+W'], 'view.fit': 'F' })).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'sketch.line': [] });
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'sketch.rectangle': ['Shift+KeyR'] } });
    const k = createKeybinds({ prefs: p.api, layout: false });
    await k.ready;
    expect(k.current('sketch.rectangle')).toEqual(['Shift+KeyR']);
    // Stored overrides may conflict (written elsewhere): both keep it, conflicts() says so.
    expect(k.conflicts()).toEqual([{ combo: 'Shift+KeyR', ids: ['view.sketch-relations', 'sketch.rectangle'] }]);
  });

  it("shows punctuation keys through the layout's map when the browser has one; letters stay the letter they match", async () => {
    const nav = navigator as unknown as { keyboard?: unknown };
    // A German layout: Backslash's place types #, the key US keyboards call Z types y.
    nav.keyboard = {
      getLayoutMap: async () =>
        new Map([
          ['Backslash', '#'],
          ['KeyZ', 'y'],
        ]),
    };
    try {
      const k = createKeybinds({ prefs: null });
      const told = vi.fn();
      k.subscribe(told);
      await vi.waitFor(() => expect(k.shown('ui.toggle-rail')).toBe('Ctrl+#'));
      expect(told).toHaveBeenCalled();
      expect(k.shown('edit.undo')).toBe('Ctrl+Z');
      expect(k.shown('view.front')).toBe('1');
    } finally {
      delete nav.keyboard;
    }
  });

  it('never writes over keybinds it could not read: a failed first read, then a change, stores the change on top of what is stored (review)', async () => {
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'sketch.line': ['KeyK'], 'view.fit': ['Shift+KeyF'] } });
    const realGet = p.api.get;
    let fail = true;
    p.api.get = async <T,>(key: string) => {
      if (fail) throw new Error('the host did not answer');
      return realGet<T>(key);
    };
    const k = createKeybinds({ prefs: p.api, layout: false });
    await k.ready;
    // The defaults apply meanwhile.
    expect(k.current('sketch.line')).toEqual(['KeyL']);
    // Still unreadable: the change applies here and is not saved, and nothing is written.
    k.setKeybind('sketch.circle', 'Shift+C');
    expect(await k.flush()).toMatch(/^your keybinds could not be read, so the change was not saved/);
    expect(p.writes).toEqual([]);
    // Readable again: the next change stores both changes on top of the stored ones, and shows them.
    fail = false;
    k.setKeybind('view.front', 'Shift+Digit1');
    expect(await k.flush()).toBe(true);
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyK'], 'view.fit': ['Shift+KeyF'], 'sketch.circle': ['Shift+KeyC'], 'view.front': ['Shift+Digit1'] });
    expect(k.current('sketch.line')).toEqual(['KeyK']);
    expect(k.current('sketch.circle')).toEqual(['Shift+KeyC']);
  });

  it('a change made before a slow first read keeps the stored keybinds (they apply when read, the change on top)', async () => {
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'sketch.line': ['KeyK'] } });
    const realGet = p.api.get;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    p.api.get = async <T,>(key: string) => {
      if (first) {
        first = false;
        await gate;
      }
      return realGet<T>(key);
    };
    const k = createKeybinds({ prefs: p.api, layout: false });
    k.setKeybind('sketch.circle', 'Shift+C');
    release();
    await k.ready;
    expect(await k.flush()).toBe(true);
    expect(k.current('sketch.line')).toEqual(['KeyK']);
    expect(k.current('sketch.circle')).toEqual(['Shift+KeyC']);
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'sketch.line': ['KeyK'], 'sketch.circle': ['Shift+KeyC'] });
  });

  it('a change made in another tab between two changes here is kept (each store reads the stored value again)', async () => {
    const p = memoryPrefs();
    const k = createKeybinds({ prefs: p.api, layout: false });
    await k.ready;
    k.setKeybind('sketch.circle', 'Shift+C');
    await k.flush();
    // Another tab stores its own change; this page has not heard it yet.
    p.values[KEYBINDS_PREF] = { 'sketch.circle': ['Shift+KeyC'], 'sketch.line': ['KeyK'] };
    k.setKeybind('view.front', 'Shift+Digit1');
    expect(await k.flush()).toBe(true);
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'sketch.circle': ['Shift+KeyC'], 'sketch.line': ['KeyK'], 'view.front': ['Shift+Digit1'] });
    expect(k.current('sketch.line')).toEqual(['KeyK']);
  });

  it("Finish sketch has no key of its own: its tooltip shows Place or finish's Enter, and says so", async () => {
    const k = createKeybinds({ prefs: null, layout: false });
    expect(k.current('sketch.finish')).toEqual([]);
    expect(k.shown('sketch.finish')).toBe('Enter');
    expect(k.via('sketch.finish')).toEqual({ id: 'sketch.enter', label: 'Place or finish', shown: 'Enter' });
    expect(k.via('sketch.rectangle')).toBeNull();
    expect(k.owners('KeyR')).toEqual(['sketch.rectangle']);
    expect(k.owners('Delete')).toEqual(['ui.delete', 'sketch.delete']);
  });
});

describe('applied live', () => {
  it('a change made elsewhere (Settings) moves the key at once: the keyboard, the tooltip and a keyboard-only action', async () => {
    const p = memoryPrefs();
    const keybinds = createKeybinds({ prefs: p.api, layout: false });
    await keybinds.ready;
    const mode = createStateStore<{ mode: 'model' | 'sketch' }>({ mode: 'sketch' });
    let services: AppServices | null = null;
    const commands = createCommandRegistry(() => services!, keybinds);
    const keyboard = createKeyboard(document);
    services = { commands, keyboard, mode, bridge: { prefs: p.api } } as unknown as AppServices;
    setKeybindsFor(services, keybinds);
    const rect = vi.fn();
    const rename = vi.fn();
    commands.register({ id: 'sketch.rectangle', label: 'Rectangle', mode: 'sketch', run: rect });
    const told = vi.fn();
    commands.subscribe(told);
    const unbind = bindCommandShortcuts(commands, keyboard, undefined, () => mode.get().mode);
    const offRename = bindCommandKeys(services, 'ui.rename', { run: rename });
    const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press({ key: 'r', code: 'KeyR' });
    press({ key: 'F2', code: 'F2' });
    await flush();
    expect(rect).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(commands.get('sketch.rectangle')!.shortcut).toBe('R');
    // Settings writes ws.prefs; the page hears it.
    p.elsewhere(KEYBINDS_PREF, { 'sketch.rectangle': ['Shift+KeyR'], 'ui.rename': ['F4'] });
    expect(told).toHaveBeenCalled();
    expect(commands.get('sketch.rectangle')!.shortcut).toBe('Shift+R');
    press({ key: 'r', code: 'KeyR' });
    press({ key: 'F2', code: 'F2' });
    await flush();
    expect(rect).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    press({ key: 'R', code: 'KeyR', shiftKey: true });
    press({ key: 'F4', code: 'F4' });
    await flush();
    expect(rect).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(2);
    // Back to the defaults (Settings' reset removes the pref).
    p.elsewhere(KEYBINDS_PREF, null);
    press({ key: 'r', code: 'KeyR' });
    await flush();
    expect(rect).toHaveBeenCalledTimes(3);
    expect(commands.get('sketch.rectangle')!.shortcut).toBe('R');
    unbind();
    offRename();
    keyboard.dispose();
  });

  it('a keyboard-only action of one mode passes its key on in the other', async () => {
    const keybinds = createKeybinds({ prefs: null, layout: false });
    const mode = createStateStore<{ mode: 'model' | 'sketch' }>({ mode: 'sketch' });
    const keyboard = createKeyboard(document);
    const services = { keyboard, mode } as unknown as AppServices;
    setKeybindsFor(services, keybinds);
    const del = vi.fn();
    const older = vi.fn();
    keyboard.bind({ combo: 'Delete', run: older });
    bindCommandKeys(services, 'ui.delete', { run: del });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
    expect(del).not.toHaveBeenCalled();
    expect(older).toHaveBeenCalledTimes(1);
    mode.set({ mode: 'model' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
    expect(del).toHaveBeenCalledTimes(1);
    keyboard.dispose();
  });
});

describe('the Set keybind dialog', () => {
  let close: (() => void) | null = null;
  afterEach(async () => {
    close?.();
    close = null;
    await act(async () => {
      await flush();
    });
  });

  async function open(id: string) {
    const p = memoryPrefs();
    const services = { bridge: { prefs: p.api } } as unknown as AppServices;
    const k = keybindsFor(services);
    await k.ready;
    await act(async () => {
      close = openSetKeybind(services, id);
    });
    const dlg = () => document.querySelector(`[data-cad-keybind-dialog="${id}"]`) as HTMLDialogElement;
    const q = (sel: string) => dlg().querySelector(sel) as HTMLElement;
    const keys = async (init: KeyboardEventInit) => {
      await act(async () => {
        q('[data-keybind-capture]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      });
    };
    const click = async (action: string) => {
      await act(async () => {
        q(`[data-keybind-action="${action}"]`).click();
      });
    };
    return { services, k, p, dlg, q, keys, click };
  }

  it('shows the current key, takes the new keys, asks Replace or Cancel on a conflict, refuses reserved and app keys, resets and clears', async () => {
    const d = await open('sketch.rectangle');
    expect(d.dlg().getAttribute('aria-modal')).toBe('true');
    expect(d.q('h2').textContent).toBe('Set keybind: Rectangle');
    expect(d.q('[data-keybind-current]').textContent).toBe('R');
    expect(d.q('[data-keybind-capture]').textContent).toBe('Press the new keys');
    expect(document.activeElement).toBe(d.q('[data-keybind-capture]'));
    expect((d.q('[data-keybind-action="reset"]') as HTMLButtonElement).disabled).toBe(true);
    // A modifier alone waits for the key.
    await d.keys({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(d.q('[data-keybind-capture]').textContent).toBe('Shift+…');
    // Shift+R is Show relations' key: Replace or Cancel; Cancel changes nothing.
    await d.keys({ key: 'R', code: 'KeyR', shiftKey: true });
    expect(d.q('[data-keybind-status]').getAttribute('data-keybind-status')).toBe('conflict');
    expect(d.q('[data-keybind-status]').textContent).toBe('Shift+R is the key of Show relations (sketch). Replace it?');
    await d.click('cancel');
    expect(d.k.current('sketch.rectangle')).toEqual(['KeyR']);
    await d.keys({ key: 'R', code: 'KeyR', shiftKey: true });
    await d.click('replace');
    expect(d.k.current('sketch.rectangle')).toEqual(['Shift+KeyR']);
    expect(d.k.current('view.sketch-relations')).toEqual([]);
    expect(d.q('[data-keybind-current]').textContent).toBe('Shift+R');
    expect(d.q('[data-keybind-status]').textContent).toBe('Rectangle: Shift+R; taken from Show relations (sketch)');
    await d.k.flush();
    expect(d.p.values[KEYBINDS_PREF]).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'view.sketch-relations': [] });
    // The browser's and the app's keys: refused with why, nothing changed.
    await d.keys({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(d.q('[data-keybind-status]').textContent).toBe('"Ctrl+KeyW" is kept for the browser and the system (Close the tab)');
    await d.keys({ key: '/', code: 'Slash', ctrlKey: true });
    expect(d.q('[data-keybind-status]').textContent).toBe('"Ctrl+Slash" is the app\'s own key (Open or close the Assistant panel)');
    expect(d.k.current('sketch.rectangle')).toEqual(['Shift+KeyR']);
    // Reset to default, then Clear.
    await d.click('reset');
    expect(d.k.current('sketch.rectangle')).toEqual(['KeyR']);
    expect(d.q('[data-keybind-current]').textContent).toBe('R');
    await d.click('clear');
    expect(d.k.current('sketch.rectangle')).toEqual([]);
    expect(d.q('[data-keybind-current]').textContent).toBe('None');
    expect(d.q('[data-keybind-status]').textContent).toBe('Rectangle: no key');
    // Done closes it.
    await d.click('done');
    await act(async () => {
      await flush();
    });
    expect(document.querySelector('[data-cad-keybind-dialog]')).toBeNull();
    close = null;
  });

  it('a key two commands have: the question names both and where they work; Replace takes it from both (review)', async () => {
    const d = await open('view.front');
    await d.keys({ key: 'Delete', code: 'Delete' });
    expect(d.q('[data-keybind-status]').textContent).toBe('Delete is the key of Delete selected features (model) and Delete (sketch). Replace both?');
    await d.click('replace');
    expect(d.k.current('view.front')).toEqual(['Delete']);
    expect(d.k.current('ui.delete')).toEqual([]);
    expect(d.k.current('sketch.delete')).toEqual([]);
    expect(d.q('[data-keybind-status]').textContent).toBe('Front view: Delete; taken from Delete selected features (model) and Delete (sketch)');
  });

  it("Finish sketch's dialog says it has no key of its own, and which key finishes the sketch", async () => {
    const d = await open('sketch.finish');
    expect(d.q('[data-keybind-current]').textContent).toBe('None of its own (Enter runs Place or finish)');
  });

  it('a change that could not be saved says so in the dialog', async () => {
    const p = memoryPrefs();
    p.api.get = async () => {
      throw new Error('the host did not answer');
    };
    const services = { bridge: { prefs: p.api } } as unknown as AppServices;
    await keybindsFor(services).ready;
    await act(async () => {
      close = openSetKeybind(services, 'sketch.circle');
    });
    const q = (sel: string) => document.querySelector(`[data-cad-keybind-dialog="sketch.circle"] ${sel}`) as HTMLElement;
    await act(async () => {
      q('[data-keybind-capture]').dispatchEvent(new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', shiftKey: true, bubbles: true, cancelable: true }));
      await flush();
    });
    await vi.waitFor(() => expect(q('[data-keybind-status]').textContent).toMatch(/^Circle: Shift\+C\. Not saved: your keybinds could not be read/));
    expect(p.writes).toEqual([]);
  });

  it('Escape closes it; a change made elsewhere shows at once; the menu item opens it', async () => {
    const d = await open('sketch.circle');
    await act(async () => {
      d.k.setKeybind('sketch.circle', 'Shift+C');
    });
    expect(d.q('[data-keybind-current]').textContent).toBe('Shift+C');
    await d.keys({ key: 'Escape', code: 'Escape' });
    await act(async () => {
      await flush();
    });
    expect(document.querySelector('[data-cad-keybind-dialog]')).toBeNull();
    const item = keybindMenuItem(d.services, 'sketch.circle');
    expect(item).toMatchObject({ id: 'set-keybind', label: 'Set keybind…', disabled: null });
    expect(item.hint).toBe('Now Shift+C: press new keys, Reset to default or Clear');
    await act(async () => {
      item.run();
    });
    expect(document.querySelector('[data-cad-keybind-dialog="sketch.circle"]')).not.toBeNull();
    close = () => (document.querySelector('[data-keybind-action="done"]') as HTMLButtonElement)?.click();
  });
});
