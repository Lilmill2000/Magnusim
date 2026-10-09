// ux010 PANELS: the left column's collapsed states (src/ui/left-rails.ts): the tree's rail while a
// sketch is edited (for that sketch only, never written), the user's own tree chevron in model mode,
// the Sketch panel's rail and Details (remembered in ws.prefs: absent = false, set true, removed when
// false), a click before the prefs were read winning over them, a host without or refusing ws.prefs,
// and Ctrl+\ (the panel in sketch mode, the tree in model mode).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PrefsApi } from '../../src/lib/bridge';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { KeyBinding } from '../../src/types/commands';
import { PREF_SKETCH_COLLAPSED, PREF_SKETCH_DETAILS, PREF_TREE_COLLAPSED, PREFS_READ_GIVE_UP_MS, RAIL_SHORTCUT, railsFor, type Rails } from '../../src/ui/left-rails';
import { vi } from 'vitest';

function userPrefs(init: Record<string, unknown> = {}, opts: { refuse?: boolean; slow?: Promise<void> } = {}) {
  const values: Record<string, unknown> = { ...init };
  const calls: string[] = [];
  const api: PrefsApi = {
    async get<T>(key: string) {
      calls.push(`get ${key}`);
      if (opts.slow) await opts.slow;
      if (opts.refuse) throw Object.assign(new Error('not allowed'), { code: 'not_allowed' });
      return (values[key] ?? null) as T | null;
    },
    async set(key, value) {
      calls.push(`set ${key}`);
      values[key] = value;
    },
    async remove(key) {
      calls.push(`remove ${key}`);
      delete values[key];
    },
    onChange: () => () => {},
  };
  return { api, values, calls };
}

function servicesOf(prefs: PrefsApi | null) {
  const bindings: KeyBinding[] = [];
  const mode = createStateStore<{ mode: 'model' | 'sketch' }>({ mode: 'model' });
  const services = { bridge: { prefs }, keyboard: { bind: (b: KeyBinding) => (bindings.push(b), () => {}) }, mode } as unknown as AppServices;
  const press = (combo: string) => {
    const b = bindings.find((x) => x.combo === combo);
    if (!b) throw new Error(`nothing bound to ${combo}`);
    b.run({} as KeyboardEvent);
  };
  return { services, mode, press, bindings };
}

function ready(rails: Rails): Promise<void> {
  return new Promise((resolve) => {
    if (rails.state.get().ready) return resolve();
    const off = rails.state.subscribe((s) => {
      if (!s.ready) return;
      off();
      resolve();
    });
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the left column rails', () => {
  it('one store per page; nothing stored: every card shows, Details closed', async () => {
    const u = userPrefs();
    const { services } = servicesOf(u.api);
    const rails = railsFor(services);
    expect(railsFor(services)).toBe(rails);
    await ready(rails);
    expect(rails.state.get()).toMatchObject({ treeCollapsed: false, treeShownInSketch: false, sketchCollapsed: false, sketchDetails: false, ready: true });
    expect(rails.treeIsRail(false)).toBe(false);
    // While a sketch is edited the tree is a rail by itself.
    expect(rails.treeIsRail(true)).toBe(true);
  });

  it('stored values are read; a change is written (true set, false removed)', async () => {
    const u = userPrefs({ [PREF_TREE_COLLAPSED]: true, [PREF_SKETCH_COLLAPSED]: true, [PREF_SKETCH_DETAILS]: true });
    const rails = railsFor(servicesOf(u.api).services);
    await ready(rails);
    expect(rails.state.get()).toMatchObject({ treeCollapsed: true, sketchCollapsed: true, sketchDetails: true });
    expect(rails.treeIsRail(false)).toBe(true);
    rails.setSketchCollapsed(false);
    rails.setSketchDetails(false);
    rails.setTreeShown(true, false);
    await flush();
    expect(u.values).toEqual({});
    rails.setSketchDetails(true);
    await flush();
    expect(u.values).toEqual({ [PREF_SKETCH_DETAILS]: true });
  });

  it('the tree in a sketch: shown for that sketch only, never written; a new sketch starts with the rail again; the user\'s model choice comes back', async () => {
    const u = userPrefs({ [PREF_TREE_COLLAPSED]: true });
    const rails = railsFor(servicesOf(u.api).services);
    await ready(rails);
    rails.setTreeShown(true, true);
    expect(rails.treeIsRail(true)).toBe(false);
    rails.setTreeShown(false, true);
    expect(rails.treeIsRail(true)).toBe(true);
    rails.setTreeShown(true, true);
    rails.sketchChanged();
    expect(rails.treeIsRail(true)).toBe(true);
    // Model mode: still the user's collapsed tree (the sketch's click did not change it).
    expect(rails.treeIsRail(false)).toBe(true);
    await flush();
    expect(u.calls.filter((c) => !c.startsWith('get'))).toEqual([]);
  });

  it('a click before the prefs were read wins over what is stored', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const u = userPrefs({ [PREF_SKETCH_COLLAPSED]: true, [PREF_SKETCH_DETAILS]: true }, { slow });
    const rails = railsFor(servicesOf(u.api).services);
    rails.setSketchCollapsed(false);
    release();
    await ready(rails);
    expect(rails.state.get().sketchCollapsed).toBe(false);
    expect(rails.state.get().sketchDetails).toBe(true);
    expect(u.values[PREF_SKETCH_COLLAPSED]).toBeUndefined();
  });

  it('no ws.prefs (a 1.6 host), or refused: ready at once with the defaults, kept for the page only', async () => {
    const none = railsFor(servicesOf(null).services);
    expect(none.state.get().ready).toBe(true);
    none.setSketchCollapsed(true);
    expect(none.state.get().sketchCollapsed).toBe(true);
    const u = userPrefs({ [PREF_SKETCH_COLLAPSED]: true }, { refuse: true });
    const refused = railsFor(servicesOf(u.api).services);
    await ready(refused);
    expect(refused.state.get().sketchCollapsed).toBe(false);
    refused.setSketchDetails(true);
    await flush();
    expect(refused.state.get().sketchDetails).toBe(true);
    expect(u.calls.filter((c) => !c.startsWith('get'))).toEqual([]);
  });

  it('Ctrl+\\: the Sketch panel in sketch mode, the tree in model mode', async () => {
    const u = userPrefs();
    const { services, mode, press } = servicesOf(u.api);
    const rails = railsFor(services);
    await ready(rails);
    expect(RAIL_SHORTCUT).toBe('Ctrl+\\');
    press(RAIL_SHORTCUT);
    expect(rails.state.get().treeCollapsed).toBe(true);
    press(RAIL_SHORTCUT);
    expect(rails.state.get().treeCollapsed).toBe(false);
    mode.set({ mode: 'sketch' });
    press(RAIL_SHORTCUT);
    expect(rails.state.get().sketchCollapsed).toBe(true);
    expect(rails.state.get().treeCollapsed).toBe(false);
    press(RAIL_SHORTCUT);
    expect(rails.state.get().sketchCollapsed).toBe(false);
  });

  it('Ctrl+\\ by its place on the keyboard (AltGr layouts: Ctrl+Alt+\\): toggles once; not while typing', async () => {
    const { services, mode } = servicesOf(null);
    const rails = railsFor(services);
    mode.set({ mode: 'sketch' });
    const key = (init: KeyboardEventInit, target: EventTarget = document) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    key({ key: '\\', code: 'Backslash', ctrlKey: true, altKey: true });
    expect(rails.state.get().sketchCollapsed).toBe(true);
    // The plain combo is the keyboard binding's (no second toggle here).
    key({ key: '\\', code: 'Backslash', ctrlKey: true });
    expect(rails.state.get().sketchCollapsed).toBe(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    key({ key: '#', code: 'Backslash', ctrlKey: true }, input);
    expect(rails.state.get().sketchCollapsed).toBe(true);
    key({ key: '#', code: 'Backslash', ctrlKey: true });
    expect(rails.state.get().sketchCollapsed).toBe(false);
    input.remove();
  });

  it('a host that never answers the prefs read: the column is drawn with the defaults after the give-up', async () => {
    vi.useFakeTimers();
    try {
      const u = userPrefs({}, { slow: new Promise<void>(() => {}) });
      const rails = railsFor(servicesOf(u.api).services);
      expect(rails.state.get().ready).toBe(false);
      vi.advanceTimersByTime(PREFS_READ_GIVE_UP_MS);
      expect(rails.state.get().ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('focus after a toggle goes to its counterpart, once', () => {
    const rails = railsFor(servicesOf(null).services);
    expect(rails.takeFocus('sketch-expand')).toBe(false);
    rails.focusAfter('sketch-expand');
    expect(rails.takeFocus('tree-rail')).toBe(false);
    expect(rails.takeFocus('sketch-expand')).toBe(true);
    expect(rails.takeFocus('sketch-expand')).toBe(false);
  });
});
