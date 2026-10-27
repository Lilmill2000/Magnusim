// Two-way parity for keybinds (review: the Assistant could change Delete, F2, Ctrl+\, Enter and the
// sketch's Delete, the person could not): every command of the registry has a place where the person
// opens Set keybind for it (src/ui/keybinds/places.ts), and each place is there in the app:
//  - toolbar: a command the booted app shows on the toolbar (a group's, VIEW's, EDIT's, the primary);
//  - views-menu: a row of the views menu;
//  - tree: a tree row's right-click menu (Delete and Rename), and a body's (Rename);
//  - rail: the right-click on the collapse arrows;
//  - sketch-menu, sketch-finish: the sketch's right-click menus and Finish sketch's on the toolbar
//    (e2e/cad-keybinds.spec.ts cad:keybinds-person-paths right-clicks each).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KEYMAP } from '../../src/app/keymap';
import { uiFor } from '../../src/ui/controller';
import { railKeybindMenu } from '../../src/ui/keybinds';
import { keybindPlace, keybindPlaces } from '../../src/ui/keybinds/places';
import { VIEW_TOOLBAR } from '../../src/ui/Toolbar';
import type { AppServices } from '../../src/types/app';
import { VIEW_COMMANDS } from '../../src/viewport/commands';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';
import { makeServices } from './fake-doc';

vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({ state: { get: () => ({ ready: true }), subscribe: () => () => {} }, dispose() {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = (entries: readonly { id: string; label?: string }[]) => entries.map((e) => e.id);

describe('every keybind has a Set keybind the person can reach', () => {
  it('every registry id has a place, said in words the Assistant passes on', () => {
    const places = keybindPlaces();
    expect(places.map((p) => p.id)).toEqual(KEYMAP.map((e) => e.id));
    for (const p of places) expect(p.words, p.id).toMatch(/Set keybind/);
    expect(keybindPlace('ui.delete')).toEqual({ place: 'tree', words: 'right-click a feature in the design tree, then Set keybind for Delete…' });
    expect(keybindPlace('sketch.enter')?.place).toBe('sketch-finish');
    expect(keybindPlace('view.back')?.place).toBe('views-menu');
    expect(keybindPlace('view.front')?.place).toBe('toolbar');
    expect(keybindPlace('nope')).toBeNull();
  });

  it('the toolbar and the views menu have the commands the places say (the booted app)', async () => {
    const ws = createFakeWorkspace({
      spawnWorker: () => {
        const w = new FakeWorker(okHandler());
        w.ready();
        return w as unknown as Worker;
      },
    });
    setFakeConnection(ws);
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    let services: AppServices | null = null;
    await act(async () => {
      services = await bootstrap(root);
    });
    await vi.waitFor(() => expect(root.querySelector('[data-cad-app]')?.getAttribute('data-kernel')).toBe('ready'));
    const s = services! as AppServices;
    const edit = new Set(['edit.undo', 'edit.redo', 'sketch.undo', 'sketch.redo']);
    const views = new Set([...VIEW_COMMANDS.map((v) => `view.${v.view}`), 'view.normal-to']);
    const wrong: string[] = [];
    for (const p of keybindPlaces()) {
      if (p.place === 'toolbar') {
        const c = s.commands.get(p.id);
        // On the toolbar: a group's command (bar, More or flyout), the primary, EDIT's, or VIEW's (its list, or a view command with an icon).
        const onBar = !!c && (!!c.group || edit.has(p.id) || (p.id.startsWith('view.') && (VIEW_TOOLBAR.some((v) => v.id === p.id) || !!c.icon)));
        if (!onBar) wrong.push(`${p.id}: said to be on the toolbar`);
      } else if (p.place === 'views-menu') {
        if (!views.has(p.id)) wrong.push(`${p.id}: said to be in the views menu`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a tree row's right-click has Delete's and Rename's keybinds; a body's has Rename's; the collapse arrows have the toggle's", () => {
    const t = makeServices();
    const ui = uiFor(t.services);
    const f = t.doc.seed('extrude', { name: 'Base' });
    expect(items(ui.featureMenu(f.id)).slice(-2)).toEqual(['set-keybind-ui.delete', 'set-keybind-ui.rename']);
    const body = t.doc.state.get().rebuild.bodies[0];
    expect(items(ui.bodyMenu(body.id)).slice(-1)).toEqual(['set-keybind-ui.rename']);
    const e = { preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20 };
    act(() => railKeybindMenu(t.services, e));
    expect(ui.state.get().menu?.items.map((i) => ('label' in i ? `${i.id}: ${i.label}` : i.id))).toEqual(['set-keybind-ui.toggle-rail: Set keybind…']);
    ui.dispose();
  });
});
