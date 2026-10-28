// The person's keybinds (src/app/keybinds.ts) and the Set keybind dialog (src/ui/keybinds):
// set, a conflict with the command that has the combo (Replace or Cancel), replace, reset to
// default, clear, current; the overrides as ws.prefs keeps them (physical keys, [] cleared, missing
// the defaults); a change made elsewhere (Settings) taking effect live in the keyboard, the
// tooltips and the keyboard-only actions; the layout's labels; and the dialog as the person uses it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandKeys, createKeybinds, KEYBINDS_PREF, keybindsFor, keyLabel, parseOverrides, setKeybindsFor, type AssistantKeysSource } from '../../src/app/keybinds';
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

  it('never works a change out from the defaults: unreadable saved keybinds refuse changes and are read again; then Replace takes from the saved holder (review)', async () => {
    // Saved: Fit moved to G, Plane on F.
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'view.fit': ['KeyG'], 'construct.plane': ['KeyF'] } });
    const realGet = p.api.get;
    let fail = true;
    p.api.get = async <T,>(key: string) => {
      if (fail) throw new Error('the host did not answer');
      return realGet<T>(key);
    };
    const k = createKeybinds({ prefs: p.api, layout: false });
    await k.ready;
    const unreadable = 'your keybinds could not be read, so they cannot be changed now (nothing was changed): the host did not answer';
    expect(k.known()).toBe(unreadable);
    // From the defaults this would say Fit has F; it refuses instead (and reads again), and writes nothing.
    expect(k.setKeybind('inspect.measure', 'F')).toEqual({ ok: false, reason: 'unread', id: 'inspect.measure', message: unreadable });
    await k.load();
    expect(k.replace('inspect.measure', 'F')).toMatchObject({ ok: false, reason: 'unread' });
    await k.load();
    expect(k.resetAll()).toBe(unreadable);
    expect(p.writes).toEqual([]);
    // Readable again: the next try reads them; the conflict is the saved holder's (Plane), not Fit's.
    fail = false;
    expect(await k.load()).toBe(true);
    expect(k.current('view.fit')).toEqual(['KeyG']);
    expect(k.setKeybind('inspect.measure', 'F')).toMatchObject({ ok: false, reason: 'conflict', with: 'construct.plane', conflicts: [{ id: 'construct.plane', name: 'Plane (model)' }] });
    expect(k.replace('inspect.measure', 'F')).toMatchObject({ ok: true, keys: ['KeyF'], took: [{ id: 'construct.plane' }] });
    expect(await k.flush()).toBe(true);
    // Fit keeps its saved G; Plane is back to its default (no key); nobody shares F.
    expect(p.values[KEYBINDS_PREF]).toEqual({ 'view.fit': ['KeyG'], 'inspect.measure': ['KeyF'] });
    expect(k.current('construct.plane')).toEqual([]);
  });

  it('a change made while the first read is still under way waits for it: refused, then made from the saved keys', async () => {
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
    expect(k.setKeybind('sketch.circle', 'K')).toEqual({ ok: false, reason: 'unread', id: 'sketch.circle', message: 'your keybinds are still being read: try again in a moment (nothing was changed)' });
    release();
    expect(await k.load()).toBe(true);
    // K is Line's (saved): a conflict, not a silent clash.
    expect(k.setKeybind('sketch.circle', 'K')).toMatchObject({ ok: false, reason: 'conflict', with: 'sketch.line' });
    expect(p.writes).toEqual([]);
  });

  it('a value heard while the first read is under way is the person\'s keybinds: a late failure of that read never makes them unknown again (review)', async () => {
    const p = memoryPrefs();
    let fail: (err: Error) => void = () => {};
    p.api.get = () => new Promise((_, reject) => (fail = reject));
    const k = createKeybinds({ prefs: p.api, layout: false });
    await Promise.resolve();
    expect(k.known()).toBe('your keybinds are still being read: try again in a moment (nothing was changed)');
    // Settings (another tab) saves, and the page hears the whole value.
    p.elsewhere(KEYBINDS_PREF, { 'view.fit': ['KeyG'] });
    expect(k.known()).toBe(true);
    // Then the read under way fails: the keys heard stay the person's.
    fail(new Error('the host did not answer'));
    await k.ready;
    expect(k.known()).toBe(true);
    expect(await k.load()).toBe(true);
    expect(k.current('view.fit')).toEqual(['KeyG']);
    expect(k.setKeybind('sketch.circle', 'Shift+C')).toMatchObject({ ok: true });
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

  it('the dialog with unreadable saved keybinds says so and changes nothing; once they are read it names the saved holder (review)', async () => {
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'view.fit': ['KeyG'], 'construct.plane': ['KeyF'] } });
    const realGet = p.api.get;
    let fail = true;
    p.api.get = async <T,>(key: string) => {
      if (fail) throw new Error('the host did not answer');
      return realGet<T>(key);
    };
    const services = { bridge: { prefs: p.api } } as unknown as AppServices;
    await keybindsFor(services).ready;
    await act(async () => {
      close = openSetKeybind(services, 'inspect.measure');
      await flush();
    });
    const q = (sel: string) => document.querySelector(`[data-cad-keybind-dialog="inspect.measure"] ${sel}`) as HTMLElement;
    const press = async (init: KeyboardEventInit) => {
      await act(async () => {
        q('[data-keybind-capture]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        await flush();
      });
    };
    await vi.waitFor(() => expect(q('[data-keybind-status]').textContent).toBe('Your keybinds could not be read, so they cannot be changed now (nothing was changed): the host did not answer'));
    await press({ key: 'f', code: 'KeyF' });
    expect(q('[data-keybind-status]').textContent).toMatch(/^Your keybinds could not be read/);
    expect(p.writes).toEqual([]);
    // Readable again (a press tries the read again): F is Plane's, as saved.
    fail = false;
    await press({ key: 'f', code: 'KeyF' });
    await press({ key: 'f', code: 'KeyF' });
    expect(q('[data-keybind-status]').textContent).toBe('F is the key of Plane (model). Replace it?');
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

/** The Assistant panel's keys the person chose, as the bridge has them (null: its default); `move` is a change in the app's Settings. */
function assistantKeys(initial: string[] | null) {
  let keys: readonly string[] | null = initial;
  const listeners = new Set<(k: readonly string[] | null) => void>();
  const api: AssistantKeysSource = {
    assistantKeys: () => keys,
    onAssistantKeys: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const move = (next: string[] | null) => {
    keys = next;
    for (const fn of [...listeners]) fn(keys);
  };
  return { api, move };
}

/** The host's words for a key of the app's own (its catalog's refusal; CAD's own too). */
const appOwn = (combo: string) => `"${combo}" is the app's own key (Open or close the Assistant panel)`;

describe("the Assistant panel's key the person chose (the app's Settings → Keybinds, live)", () => {
  it("no new key of a command may be it: set, replace, reset to default and the capture refuse it in the host's words; [] refuses nothing more, null only Ctrl+/", async () => {
    const a = assistantKeys(['Ctrl+KeyK', 'Ctrl+KeyZ']);
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'edit.undo': ['Ctrl+KeyU'] } });
    const k = createKeybinds({ prefs: p.api, layout: false, assistant: a.api });
    await k.ready;
    expect(k.assistantKeys()).toEqual(['Ctrl+KeyK', 'Ctrl+KeyZ']);
    expect(k.setKeybind('view.fit', 'Ctrl+K')).toMatchObject({ ok: false, reason: 'refused', combo: 'Ctrl+KeyK', message: appOwn('Ctrl+KeyK') });
    expect(k.replace('view.fit', 'ctrl+k')).toMatchObject({ ok: false, reason: 'refused', message: appOwn('Ctrl+KeyK') });
    // Undo's default Ctrl+Z is the person's Assistant key now: it cannot come back.
    expect(k.resetToDefault('edit.undo', { replace: true })).toMatchObject({ ok: false, reason: 'refused', combo: 'Ctrl+KeyZ', message: appOwn('Ctrl+KeyZ') });
    expect(k.current('edit.undo')).toEqual(['Ctrl+KeyU']);
    expect(k.current('view.fit')).toEqual(['KeyF']);
    // A press in the dialog's field, read as the keyboard reads it (AZERTY: the letter typed).
    expect(k.capture({ key: 'k', code: 'KeyK', ctrlKey: true })).toEqual({ kind: 'refused', combo: 'Ctrl+KeyK', reason: appOwn('Ctrl+KeyK') });
    expect(k.capture({ key: 'z', code: 'KeyW', ctrlKey: true })).toEqual({ kind: 'refused', combo: 'Ctrl+KeyZ', reason: appOwn('Ctrl+KeyZ') });
    expect(k.capture({ key: 'k', code: 'KeyK', altKey: true })).toEqual({ kind: 'combo', combo: 'Alt+KeyK' });
    expect(k.problem('Ctrl+KeyK')).toBe(appOwn('Ctrl+KeyK'));
    expect(k.problem('Ctrl+KeyJ')).toBe('');
    // The published default stays the app's whatever the person chose (no plugin may take it).
    expect(k.problem('Ctrl+/')).toBe(appOwn('Ctrl+Slash'));
    // No key: nothing more is refused.
    a.move([]);
    expect(k.setKeybind('view.fit', 'Ctrl+K')).toMatchObject({ ok: true, keys: ['Ctrl+KeyK'] });
    // The default: only Ctrl+/ and its kin.
    a.move(null);
    expect(k.assistantKeys()).toBeNull();
    expect(k.problem('Ctrl+KeyZ')).toBe('');
    expect(k.resetToDefault('edit.undo')).toMatchObject({ ok: true, keys: ['Ctrl+KeyZ'] });
    expect(k.capture({ key: '/', code: 'Slash', ctrlKey: true })).toEqual({ kind: 'refused', combo: 'Ctrl+Slash', reason: appOwn('Ctrl+Slash') });
    // A model without the bridge's keys (an older host): as before.
    const old = createKeybinds({ prefs: null, layout: false });
    expect(old.assistantKeys()).toBeNull();
    expect(old.setKeybind('view.fit', 'Ctrl+K')).toMatchObject({ ok: true });
  });

  it('a stored keybind that is it stays stored (back when the person moves the Assistant key away), shows as taken, and a move tells the subscribers', async () => {
    expect(parseOverrides({ 'view.fit': ['Ctrl+KeyK'] })).toEqual({ 'view.fit': ['Ctrl+KeyK'] });
    const a = assistantKeys(['Ctrl+KeyK']);
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'view.fit': ['Ctrl+KeyK'] } });
    const k = createKeybinds({ prefs: p.api, layout: false, assistant: a.api });
    await k.ready;
    expect(k.current('view.fit')).toEqual(['Ctrl+KeyK']);
    expect(k.appClashes()).toEqual([{ combo: 'Ctrl+KeyK', id: 'view.fit', by: appOwn('Ctrl+KeyK') }]);
    // Heard again from Settings or another tab: still kept.
    p.elsewhere(KEYBINDS_PREF, { 'view.fit': ['Ctrl+KeyK'], 'sketch.line': ['KeyG'] });
    expect(k.current('view.fit')).toEqual(['Ctrl+KeyK']);
    const told = vi.fn();
    k.subscribe(told);
    a.move(['F9']);
    expect(told).toHaveBeenCalledTimes(1);
    expect(k.appClashes()).toEqual([]);
    expect(k.current('view.fit')).toEqual(['Ctrl+KeyK']);
    // A default the Assistant key took shows as taken too (Undo's Ctrl+Z, the model's and the sketch's).
    a.move(['Ctrl+KeyZ']);
    expect(told).toHaveBeenCalledTimes(2);
    expect(k.appClashes().map((c) => c.id)).toEqual(['edit.undo', 'sketch.undo']);
    // Nothing was written for any of it.
    expect(p.writes).toEqual([]);
    k.dispose();
    a.move(null);
    expect(told).toHaveBeenCalledTimes(2);
  });

  it('the Set keybind dialog: the key is refused in the field (the field keeps it), a key of the command it took says so, and both follow a move at once', async () => {
    const a = assistantKeys(['Ctrl+KeyK']);
    const p = memoryPrefs();
    const services = { bridge: { prefs: p.api, ...a.api } } as unknown as AppServices;
    const k = keybindsFor(services);
    await k.ready;
    let closeIt: () => void = () => {};
    await act(async () => {
      closeIt = openSetKeybind(services, 'view.fit');
    });
    const dlg = () => document.querySelector('[data-cad-keybind-dialog="view.fit"]') as HTMLDialogElement;
    const q = (sel: string) => dlg().querySelector(sel) as HTMLElement | null;
    const keys = async (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      await act(async () => {
        q('[data-keybind-capture]')!.dispatchEvent(e);
      });
      return e;
    };
    try {
      const e = await keys({ key: 'k', code: 'KeyK', ctrlKey: true });
      expect(e.defaultPrevented).toBe(true);
      expect(q('[data-keybind-status]')!.getAttribute('data-keybind-status')).toBe('refused');
      expect(q('[data-keybind-status]')!.textContent).toBe(appOwn('Ctrl+KeyK'));
      expect(k.current('view.fit')).toEqual(['KeyF']);
      expect(q('[data-keybind-taken]')).toBeNull();
      // Moved to F9 in Settings: Ctrl+K is free for Fit.
      await act(async () => a.move(['F9']));
      await keys({ key: 'k', code: 'KeyK', ctrlKey: true });
      expect(q('[data-keybind-status]')!.textContent).toBe('Fit: Ctrl+K');
      expect(q('[data-keybind-current]')!.textContent).toBe('Ctrl+K');
      // Moved back to Ctrl+K: Fit keeps it, and the dialog says the app has it.
      await act(async () => a.move(['Ctrl+KeyK']));
      expect(q('[data-keybind-current]')!.textContent).toBe('Ctrl+K');
      expect(q('[data-keybind-taken="Ctrl+KeyK"]')!.textContent).toBe(`${appOwn('Ctrl+KeyK')}, so it does not run Fit here`);
      await act(async () => a.move(null));
      expect(q('[data-keybind-taken]')).toBeNull();
    } finally {
      closeIt();
      await act(async () => {
        await flush();
      });
    }
  });

  it("no tooltip, menu or hint names a key the panel's key took: shown and via skip it (the next key, else none), the menu item says so; current() keeps it, and a move applies at once", async () => {
    const a = assistantKeys(['Ctrl+KeyK', 'Ctrl+KeyY']);
    const p = memoryPrefs({ [KEYBINDS_PREF]: { 'sketch.rectangle': ['Ctrl+KeyK'] } });
    const keybinds = createKeybinds({ prefs: p.api, layout: false, assistant: a.api });
    await keybinds.ready;
    let services: AppServices | null = null;
    const commands = createCommandRegistry(() => services!, keybinds);
    services = { commands, bridge: { prefs: p.api, ...a.api } } as unknown as AppServices;
    setKeybindsFor(services, keybinds);
    commands.register({ id: 'sketch.rectangle', label: 'Rectangle', mode: 'sketch', run: () => {} });
    const told = vi.fn();
    commands.subscribe(told);
    // Rectangle's only key is the panel's: its toolbar tooltip, menus and aria-keyshortcuts name none; the stored key stays.
    expect(commands.get('sketch.rectangle')!.shortcut).toBeUndefined();
    expect(keyLabel(services, 'sketch.rectangle')).toBeUndefined();
    expect(keybinds.current('sketch.rectangle')).toEqual(['Ctrl+KeyK']);
    expect(keybindMenuItem(services, 'sketch.rectangle').hint).toBe("Now Ctrl+K (Ctrl+K opens the app's Assistant panel instead): press new keys, Reset to default or Clear");
    // Redo's first key is the panel's: its next one shows.
    expect(keybinds.shown('edit.redo')).toBe('Ctrl+Shift+Z');
    expect(keybindMenuItem(services, 'edit.redo').hint).toBe("Now Ctrl+Y or Ctrl+Shift+Z (Ctrl+Y opens the app's Assistant panel instead): press new keys, Reset to default or Clear");
    expect(keybinds.shown('edit.undo')).toBe('Ctrl+Z');
    // Finish sketch shows Place or finish's Enter while Enter runs it, none once the panel has it.
    expect(keybinds.shown('sketch.finish')).toBe('Enter');
    a.move(['Enter']);
    expect(told).toHaveBeenCalled();
    expect(keybinds.via('sketch.finish')).toBeNull();
    expect(keybinds.shown('sketch.finish')).toBeUndefined();
    expect(keybinds.shown('sketch.enter')).toBeUndefined();
    expect(keybinds.current('sketch.enter')).toEqual(['Enter']);
    // The number pad's / with Alt is the panel's while its key is Alt+/ (the SDK forwards it by the "/" it types).
    expect(keybinds.setKeybind('view.fit', 'Alt+NumpadDivide')).toMatchObject({ ok: true, keys: ['Alt+NumpadDivide'] });
    expect(keybinds.shown('view.fit')).toBe('Alt+NumpadDivide');
    a.move(['Alt+Slash']);
    expect(keybinds.shown('view.fit')).toBeUndefined();
    expect(keybinds.appClashes()).toEqual([{ combo: 'Alt+NumpadDivide', id: 'view.fit', by: appOwn('Alt+NumpadDivide') }]);
    expect(keybinds.problem('Alt+NumpadDivide')).toBe(appOwn('Alt+NumpadDivide'));
    expect(keybinds.capture({ key: '/', code: 'NumpadDivide', altKey: true })).toEqual({ kind: 'refused', combo: 'Alt+NumpadDivide', reason: appOwn('Alt+NumpadDivide') });
    // Moved away in Settings: every key shows again at once, and the toolbar hears it.
    told.mockClear();
    a.move(['F9']);
    expect(told).toHaveBeenCalled();
    expect(commands.get('sketch.rectangle')!.shortcut).toBe('Ctrl+K');
    expect(keybinds.shown('edit.redo')).toBe('Ctrl+Y');
    expect(keybinds.shown('sketch.finish')).toBe('Enter');
    expect(keybinds.shown('view.fit')).toBe('Alt+NumpadDivide');
    expect(keybindMenuItem(services, 'sketch.rectangle').hint).toBe('Now Ctrl+K: press new keys, Reset to default or Clear');
    // Undo's default Ctrl+Z, while the panel has it; then the panel back to its default (Ctrl+/: no command has it).
    a.move(['Ctrl+KeyZ']);
    expect(keybinds.shown('edit.undo')).toBeUndefined();
    expect(keybinds.shown('sketch.undo')).toBeUndefined();
    a.move(null);
    expect(keybinds.shown('edit.undo')).toBe('Ctrl+Z');
    expect(commands.get('sketch.rectangle')!.shortcut).toBe('Ctrl+K');
    keybinds.dispose();
  });
});
