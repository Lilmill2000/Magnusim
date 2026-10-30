// The app starts inside a (fake) host: services, empty tree, kernel handshake.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

// three's WebGLRenderer needs WebGL, which jsdom lacks: the viewport has its own tests. The
// stand-in keeps the palettes it is given (the host's appearance, src/app/appearance.ts).
const views = vi.hoisted(() => ({ palettes: [] as { name: string }[] }));
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => {
    let live: { name: string } | null = null;
    return {
      state: { get: () => ({ ready: true }), subscribe: () => () => {} },
      palette: () => live,
      setPalette(p: { name: string }) {
        live = p;
        views.palettes.push(p);
      },
      dispose() {},
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  setFakeConnection(null);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  views.palettes.length = 0;
});

describe('bootstrap', () => {
  it('shows an honest error card outside the host', async () => {
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    await act(async () => {
      expect(await bootstrap(root)).toBeNull();
    });
    expect(root.querySelector('[data-cad-fatal]')?.textContent).toMatch(/could not start.*Not inside a Magnusim workspace/);
  });

  it('connects, renders the empty tree and reaches kernel ready', async () => {
    const workers: FakeWorker[] = [];
    const ws = createFakeWorkspace({
      spawnWorker: () => {
        const w = new FakeWorker(okHandler());
        workers.push(w);
        w.ready();
        return w as unknown as Worker;
      },
    });
    setFakeConnection(ws);
    const { bootstrap } = await import('../../src/app/bootstrap');
    const root = document.createElement('div');
    document.body.append(root);
    let services: Awaited<ReturnType<typeof bootstrap>> = null;
    await act(async () => {
      services = await bootstrap(root);
    });
    expect(services).not.toBeNull();
    await vi.waitFor(() => expect(root.querySelector('[data-cad-app]')?.getAttribute('data-kernel')).toBe('ready'));
    expect(root.querySelector('[data-tree-empty="history"]')?.textContent).toBe('No features yet');
    expect([...root.querySelectorAll('[data-tree-node^="origin:"] .tl')].map((e) => e.textContent)).toEqual(['Top plane', 'Front plane', 'Right plane', 'X axis', 'Y axis', 'Z axis']);
    // Each area installed its commands: the toolbar shows only those that work, in the core's group order.
    const groups = [...root.querySelectorAll('[data-cad-toolbar] .tb-group-label')].map((e) => e.textContent);
    // P2/P3 modules (src/features/*, src/sketch): SKETCH first, CFD PREP after the modelling groups,
    // INSPECT and FILE after it. No Box or Cylinder (decision 2026-10-01): SOLID is Extrude, then P4a's Revolve, Sweep and Loft.
    // P4b (PATTERN): PATTERN right after SOLID, beside Extrude (Daniel's item 7).
    // ux010 (Daniel): SCALE MODELS (Banana for scale) right after VIEW.
    expect(groups).toEqual(['SKETCH', 'SOLID', 'PATTERN', 'MODIFY', 'CONSTRUCT', 'CFD PREP', 'INSPECT', 'FILE', 'VIEW', 'SCALE MODELS', 'EDIT']);
    // v0.5.0 ribbon (Daniel 2026-10-27: "yes show the rest as small buttons"): every command is on
    // the toolbar, each group's main command first (large), nothing in a More (P4b fix round 1 kept
    // all but the main command in More).
    const shownIn = (g: string) => [...root.querySelectorAll(`[data-cad-toolbar] [data-group="${g}"] .tb-btn[data-command]`)].map((e) => e.getAttribute('data-command'));
    const large = (id: string) => root.querySelector(`[data-cad-toolbar] .tb-btn[data-command="${id}"]`)?.classList.contains('is-large');
    expect(root.querySelector('[data-cad-toolbar] [data-tb-more]')).toBeNull();
    expect(shownIn('pattern')).toEqual(['pattern.linear', 'pattern.circular', 'pattern.mirror']);
    expect(root.querySelector('[data-command="pattern.linear"]')?.getAttribute('data-disabled-reason')).toBe('Make or import a body first');
    // P4a (REFERENCE): CONSTRUCT holds the reference Plane, Axis and Point.
    expect(shownIn('construct')).toEqual(['construct.plane', 'construct.axis', 'construct.point']);
    expect(shownIn('solid')).toEqual(['solid.extrude', 'solid.revolve', 'solid.sweep', 'solid.loft', 'solid.hole']);
    expect(shownIn('cfd')).toEqual(['cfd.enclosure']);
    // Greyed with the reason until a body exists.
    expect(root.querySelector('[data-command="cfd.enclosure"]')?.getAttribute('data-disabled-reason')).toBe('Add or import a body first');
    expect(shownIn('modify')).toEqual(['modify.fillet', 'modify.chamfer', 'modify.shell', 'modify.press-pull', 'modify.delete-faces', 'modify.split', 'modify.move-body', 'modify.combine', 'modify.parameters']);
    expect(shownIn('inspect')).toEqual(['inspect.measure', 'inspect.mass', 'inspect.check', 'inspect.find']);
    expect(shownIn('file')).toEqual(['file.import-step', 'file.export-step', 'file.picture']);
    for (const id of ['sketch.new', 'solid.extrude', 'pattern.linear', 'modify.fillet', 'construct.plane', 'cfd.enclosure', 'inspect.measure', 'file.import-step']) expect(large(id), `${id} large`).toBe(true);
    for (const id of ['solid.revolve', 'modify.chamfer', 'modify.shell', 'inspect.find', 'file.picture']) expect(large(id), `${id} small`).toBe(false);
    expect([...root.querySelectorAll('[data-cad-toolbar] [data-group="edit"] .tb-txt')].map((e) => e.textContent)).toEqual(['Undo', 'Redo']);
    expect(root.querySelector('[data-command="edit.undo"]')?.getAttribute('aria-disabled')).toBe('true');
    // P4a integration: the toolbar's fold order names only toolbar commands, and every toolbar
    // command either folds into its group's More menu or always stays in view (CONSTRAIN: glyphs).
    const { FOLD_ORDER, KEEP_IN_VIEW } = await import('../../src/ui/Toolbar');
    // v0.5.0: a toolbar flyout is one command on the bar (its bar id); its other variants ride with it.
    const { collapseFlyouts } = await import('../../src/ui/flyouts');
    const grouped = collapseFlyouts(window.__CAD__!.services.commands.all().filter((c) => c.group && !c.primary)).commands;
    expect(FOLD_ORDER.filter((id) => !grouped.some((c) => c.id === id))).toEqual([]);
    expect(KEEP_IN_VIEW.filter((id) => !grouped.some((c) => c.id === id))).toEqual([]);
    expect(FOLD_ORDER.filter((id) => KEEP_IN_VIEW.includes(id))).toEqual([]);
    expect(grouped.filter((c) => c.group !== 'constrain' && !FOLD_ORDER.includes(c.id) && !KEEP_IN_VIEW.includes(c.id)).map((c) => c.id)).toEqual([]);
    // jsdom has no layout: nothing folds there for width; nothing is in More by the default layout.
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-fit-folded')).toBe('0');
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-folded')).toBe('0');
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-layout')).toBe('default');
    expect(root.querySelector('[data-chip="kernel"]')).toBeNull();
    expect(window.__CAD__?.snapshot().kernel.state).toBe('ready');
    expect(workers).toHaveLength(1);
    // A host before 1.6 has no exit hook: nothing registered.
    await vi.waitFor(() => expect(window.__CAD__?.leave.hook).toBe('unavailable'));
    expect(ws.leaveHook).toBeNull();
  });

  it("follows the host's appearance: a dark view from the start, the toolbar's icon scale, light again on a change; never data-theme itself", async () => {
    const ws = createFakeWorkspace({
      appearance: { theme: 'dark', preference: 'system', textScale: 1, iconScale: 1.25 },
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
    await act(async () => {
      await bootstrap(root);
    });
    await vi.waitFor(() => expect(views.palettes.map((p) => p.name)).toEqual(['dark']));
    expect(document.documentElement.style.getPropertyValue('--cad-toolbar-scale')).toBe('1.25');
    expect(window.__CAD__?.appearance?.get()).toMatchObject({ appearance: { theme: 'dark', iconScale: 1.25 }, palette: 'dark', background: 0x1b1f27, followsFaces: true });
    // The SDK writes data-theme on <html>; the Part never does.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    act(() => ws.push('appearance', { theme: 'light', preference: 'light', textScale: 1, iconScale: 1 }));
    expect(views.palettes.map((p) => p.name)).toEqual(['dark', 'light']);
    expect(document.documentElement.style.getPropertyValue('--cad-toolbar-scale')).toBe('');
    // Dark again on the next change; the test handle only reads (e2e drives the host's own look).
    act(() => ws.push('appearance', { theme: 'dark', preference: 'dark', textScale: 1, iconScale: 1 }));
    expect(views.palettes.map((p) => p.name)).toEqual(['dark', 'light', 'dark']);
    expect(window.__CAD__!.appearance).not.toHaveProperty('push');
    // One dark set (Daniel picked E1 and E2): nothing to switch.
    expect(window.__CAD__!.appearance).not.toHaveProperty('darkLines');
  });

  it('stays light on a host without an appearance', async () => {
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
    await act(async () => {
      await bootstrap(root);
    });
    await vi.waitFor(() => expect(views.palettes.length).toBe(1));
    expect(views.palettes.map((p) => p.name)).toEqual(['light']);
    expect(document.documentElement.style.getPropertyValue('--cad-toolbar-scale')).toBe('');
    expect(window.__CAD__?.appearance?.get().appearance).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
  });

  it('L3: on a 1.6 host the exit hook is registered once the page has connected', async () => {
    const ws = createFakeWorkspace({
      hostVersion: '1.6',
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
    await act(async () => {
      await bootstrap(root);
    });
    await vi.waitFor(() => expect(window.__CAD__?.leave.hook).toBe('on'));
    expect(typeof ws.leaveHook).toBe('function');
  });

  it('Edit in CAD (1.7): a Part opened on a geometry asks the app for its STEP at once and says what it is doing; a Part on none does not', async () => {
    const asked: string[] = [];
    const ws = createFakeWorkspace({
      hostVersion: '1.7',
      edit: {
        geometry: { id: 'g1', name: 'Vortex CFD Test', format: 'step', fileName: 'Vortex CFD Test.step', linked: false, rev: 0, bodies: 1, faces: 6 },
        source: async () => {
          asked.push('source');
          throw Object.assign(new Error('The source file of Vortex CFD Test is missing.'), { code: 'no_source' });
        },
      },
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
    await act(async () => {
      await bootstrap(root);
    });
    await vi.waitFor(() => expect(document.querySelector('[data-edit-open]')?.getAttribute('data-edit-open')).toBe('error'));
    expect(asked).toEqual(['source']);
    expect(document.querySelector('[data-edit-open-line]')?.textContent).toBe('Vortex CFD Test could not be opened in CAD: The source file of Vortex CFD Test is missing.');
    expect(window.__CAD__?.edit?.geometry?.id).toBe('g1');
    // Said once, on the line, with Try again (no toast too: review N1).
    expect(ws.log.toasts).toEqual([]);
    expect(document.querySelector('[data-edit-open-action]')?.textContent).toBe('Try again');
    // The line's text is the line alone (review N10).
    expect(document.querySelector('[data-edit-open]')?.textContent).toBe('Vortex CFD Test could not be opened in CAD: The source file of Vortex CFD Test is missing.Try again');
  });

  it("the Assistant panel's key the person chose (unreleased 1.9): no handler of the Part hears it, no command may take it, and a change applies at once", async () => {
    const ws = createFakeWorkspace({
      assistant: { docked: true },
      assistantKeys: ['Ctrl+KeyK'],
      spawnWorker: () => {
        const w = new FakeWorker(okHandler());
        w.ready();
        return w as unknown as Worker;
      },
    });
    setFakeConnection(ws);
    const { bootstrap } = await import('../../src/app/bootstrap');
    const { keybindsFor } = await import('../../src/app/keybinds');
    const root = document.createElement('div');
    document.body.append(root);
    let services: Awaited<ReturnType<typeof bootstrap>> = null;
    await act(async () => {
      services = await bootstrap(root);
    });
    const k = keybindsFor(services);
    expect(k.setKeybind('view.fit', 'Ctrl+K')).toMatchObject({ ok: false, reason: 'refused', message: `"Ctrl+KeyK" is the app's own key (Open or close the Assistant panel)` });
    // Every handler of the Part listens after the one bootstrap adds first.
    const heard = vi.fn();
    document.addEventListener('keydown', heard, true);
    const press = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    try {
      press({ key: 'k', code: 'KeyK', ctrlKey: true });
      expect(heard).not.toHaveBeenCalled();
      press({ key: 'j', code: 'KeyJ', ctrlKey: true });
      expect(heard).toHaveBeenCalledTimes(1);
      // The person moves it in Settings: Ctrl+K is the Part's again, F9 the app's.
      ws.push('assistantKeys', ['F9']);
      press({ key: 'k', code: 'KeyK', ctrlKey: true });
      press({ key: 'F9', code: 'F9' });
      expect(heard).toHaveBeenCalledTimes(2);
      expect(k.setKeybind('view.fit', 'Ctrl+K')).toMatchObject({ ok: true, keys: ['Ctrl+KeyK'] });
    } finally {
      document.removeEventListener('keydown', heard, true);
      ws.push('assistantKeys', []);
    }
  });
});
