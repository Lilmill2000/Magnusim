// P4b follow-up: where the user's toolbar layout is kept (src/ui/toolbar-layout.ts toolbarPrefs):
// the host's plugin prefs (ws.prefs, host API 1.7) when its SDK has them, the project's plugin
// data on a 1.6 host; a project's old per-project layout copied to the prefs once; Reset removes
// the user's layout; another tab's change followed at once; a refused ws.prefs falls back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PrefsApi } from '../../src/lib/bridge';
import type { AppServices } from '../../src/types/app';
import { emptyLayout, TOOLBAR_LAYOUT_FILE, TOOLBAR_MIGRATED_KEY, TOOLBAR_PREF_KEY, toolbarPrefs, type ToolbarLayout } from '../../src/ui/toolbar-layout';

/** The user's prefs (shared by every "tab" made over it), with a way to fire another tab's change. */
function userPrefs(init: Record<string, unknown> = {}, refuse = false) {
  const values: Record<string, unknown> = { ...init };
  const listeners = new Set<(k: string, v: unknown) => void>();
  const calls: string[] = [];
  const api: PrefsApi = {
    async get<T>(key: string) {
      calls.push(`get ${key}`);
      if (refuse) throw Object.assign(new Error('not allowed'), { code: 'not_allowed' });
      return (values[key] ?? null) as T | null;
    },
    async set(key, value) {
      calls.push(`set ${key}`);
      values[key] = JSON.parse(JSON.stringify(value));
    },
    async remove(key) {
      calls.push(`remove ${key}`);
      delete values[key];
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  /** Another tab set or removed a pref. */
  const fromOtherTab = (key: string, value: unknown) => {
    if (value == null) delete values[key];
    else values[key] = value;
    for (const fn of listeners) fn(key, value);
  };
  return { api, values, calls, fromOtherTab };
}

/** One project's plugin data. */
function projectData(init: Record<string, unknown> = {}) {
  const files: Record<string, unknown> = { ...init };
  return {
    files,
    data: {
      async read<T>(rel: string) {
        return (files[rel] ?? null) as T | null;
      },
      async write(rel: string, doc: unknown) {
        files[rel] = JSON.parse(JSON.stringify(doc));
      },
    },
  };
}

function servicesOf(data: ReturnType<typeof projectData>['data'], prefs: PrefsApi | null): AppServices {
  return { bridge: { data, prefs, toast: () => {} } } as unknown as AppServices;
}

const custom = (): ToolbarLayout => ({ ...emptyLayout(), model: { place: { 'solid.revolve': 'bar' }, order: {} } });

describe('toolbar layout storage', () => {
  it('a 1.6 host (no ws.prefs): the project keeps it in its plugin data', async () => {
    const proj = projectData();
    const tb = toolbarPrefs(servicesOf(proj.data, null));
    await tb.loaded;
    tb.setMode('model', custom().model);
    await tb.saved();
    expect(proj.files[TOOLBAR_LAYOUT_FILE]).toEqual(custom());
  });

  it('ws.prefs: the user layout is read and written there, in every project; Reset removes it', async () => {
    const u = userPrefs({ [TOOLBAR_PREF_KEY]: custom(), [TOOLBAR_MIGRATED_KEY]: true });
    const a = projectData();
    const tbA = toolbarPrefs(servicesOf(a.data, u.api));
    await tbA.loaded;
    expect(tbA.state.get().layout).toEqual(custom());
    tbA.setMode('sketch', { place: { 'sketch.spline': 'more' }, order: {} });
    await tbA.saved();
    expect((u.values[TOOLBAR_PREF_KEY] as ToolbarLayout).sketch.place).toEqual({ 'sketch.spline': 'more' });
    expect(a.files[TOOLBAR_LAYOUT_FILE]).toBeUndefined();
    // Another project: the same layout.
    const tbB = toolbarPrefs(servicesOf(projectData().data, u.api));
    await tbB.loaded;
    expect(tbB.state.get().layout.sketch.place).toEqual({ 'sketch.spline': 'more' });
    // Reset of both modes: the user's layout is removed, not stored as an empty one.
    tbB.reset('model');
    tbB.reset('sketch');
    await tbB.saved();
    expect(TOOLBAR_PREF_KEY in u.values).toBe(false);
    expect(u.calls).toContain(`remove ${TOOLBAR_PREF_KEY}`);
  });

  it("a project's old per-project layout is copied to the user's prefs once; after that the prefs win, also after a Reset", async () => {
    const u = userPrefs();
    const old = projectData({ [TOOLBAR_LAYOUT_FILE]: custom() });
    const tb = toolbarPrefs(servicesOf(old.data, u.api));
    await tb.loaded;
    expect(tb.state.get().layout).toEqual(custom());
    expect(u.values[TOOLBAR_PREF_KEY]).toEqual(custom());
    expect(u.values[TOOLBAR_MIGRATED_KEY]).toBe(true);
    // Another project with a different old file: the user's layout wins, the file is not copied.
    const other = projectData({ [TOOLBAR_LAYOUT_FILE]: { ...emptyLayout(), model: { place: { 'modify.fillet': 'more' }, order: {} } } });
    const tb2 = toolbarPrefs(servicesOf(other.data, u.api));
    await tb2.loaded;
    expect(tb2.state.get().layout).toEqual(custom());
    // Reset everything, then open the first project again: its old file does not come back.
    tb2.reset('model');
    await tb2.saved();
    const tb3 = toolbarPrefs(servicesOf(old.data, u.api));
    await tb3.loaded;
    expect(tb3.state.get().layout).toEqual(emptyLayout());
    expect(TOOLBAR_PREF_KEY in u.values).toBe(false);
  });

  it('no old file and no user layout: the defaults, and the copy is not tried again', async () => {
    const u = userPrefs();
    const tb = toolbarPrefs(servicesOf(projectData().data, u.api));
    await tb.loaded;
    expect(tb.state.get().layout).toEqual(emptyLayout());
    expect(u.values[TOOLBAR_MIGRATED_KEY]).toBe(true);
    expect(TOOLBAR_PREF_KEY in u.values).toBe(false);
  });

  it("another tab's change is followed at once; its Reset brings the defaults", async () => {
    const u = userPrefs({ [TOOLBAR_MIGRATED_KEY]: true });
    const tb = toolbarPrefs(servicesOf(projectData().data, u.api));
    await tb.loaded;
    u.fromOtherTab(TOOLBAR_PREF_KEY, custom());
    expect(tb.state.get().layout).toEqual(custom());
    u.fromOtherTab('something-else', 1);
    expect(tb.state.get().layout).toEqual(custom());
    u.fromOtherTab(TOOLBAR_PREF_KEY, null);
    expect(tb.state.get().layout).toEqual(emptyLayout());
  });

  it('ws.prefs refused by the host (not_allowed): the layout stays with the project', async () => {
    const u = userPrefs({}, true);
    const proj = projectData({ [TOOLBAR_LAYOUT_FILE]: custom() });
    const tb = toolbarPrefs(servicesOf(proj.data, u.api));
    await tb.loaded;
    expect(tb.state.get().layout).toEqual(custom());
    tb.setMode('model', { place: {}, order: { solid: ['solid.loft'] } });
    await tb.saved();
    expect((proj.files[TOOLBAR_LAYOUT_FILE] as ToolbarLayout).model.order).toEqual({ solid: ['solid.loft'] });
    expect(u.calls.filter((c) => c.startsWith('set'))).toEqual([]);
  });
});
