// The app starts inside a (fake) host: services, empty tree, kernel handshake.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

// three's WebGLRenderer needs WebGL, which jsdom lacks: the viewport has its own tests.
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({
    state: { get: () => ({ ready: true }), subscribe: () => () => {} },
    dispose() {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  setFakeConnection(null);
  document.body.innerHTML = '';
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
    // P4b fix round 1 (Daniel): the model toolbar starts compact at every width: each group's main
    // command(s) on the bar, the rest in its More menu (in the group's order).
    const shownIn = (g: string) => [...root.querySelectorAll(`[data-cad-toolbar] [data-group="${g}"] .tb-btn[data-command] .tb-txt`)].map((e) => e.textContent);
    const moreIn = (g: string) => root.querySelector(`[data-cad-toolbar] [data-tb-more="${g}"]`)?.getAttribute('data-more-commands') ?? '';
    expect(shownIn('pattern')).toEqual(['Linear pattern']);
    expect(moreIn('pattern')).toBe('pattern.circular pattern.mirror');
    expect(root.querySelector('[data-command="pattern.linear"]')?.getAttribute('data-disabled-reason')).toBe('Make or import a body first');
    // P4a (REFERENCE): CONSTRUCT holds the reference Plane, Axis and Point.
    expect(shownIn('construct')).toEqual(['Plane']);
    expect(moreIn('construct')).toBe('construct.axis construct.point');
    expect(shownIn('solid')).toEqual(['Extrude']);
    expect(moreIn('solid')).toBe('solid.revolve solid.sweep solid.loft');
    expect(shownIn('cfd')).toEqual(['Enclosure']);
    expect(moreIn('cfd')).toBe('');
    // Greyed with the reason until a body exists.
    expect(root.querySelector('[data-command="cfd.enclosure"]')?.getAttribute('data-disabled-reason')).toBe('Add or import a body first');
    expect(shownIn('modify')).toEqual(['Fillet', 'Chamfer']);
    expect(moreIn('modify')).toBe('modify.parameters modify.shell modify.press-pull modify.delete-faces modify.split modify.combine');
    expect(shownIn('inspect')).toEqual(['Measure']);
    expect(moreIn('inspect')).toBe('inspect.mass inspect.check');
    expect(shownIn('file')).toEqual(['Import STEP']);
    expect(moreIn('file')).toBe('file.export-step');
    expect([...root.querySelectorAll('[data-cad-toolbar] [data-group="edit"] .tb-txt')].map((e) => e.textContent)).toEqual(['Undo', 'Redo']);
    expect(root.querySelector('[data-command="edit.undo"]')?.getAttribute('aria-disabled')).toBe('true');
    // P4a integration: the toolbar's fold order names only toolbar commands, and every toolbar
    // command either folds into its group's More menu or always stays in view (CONSTRAIN: glyphs).
    const { FOLD_ORDER, KEEP_IN_VIEW } = await import('../../src/ui/Toolbar');
    const grouped = window.__CAD__!.services.commands.all().filter((c) => c.group && !c.primary);
    expect(FOLD_ORDER.filter((id) => !grouped.some((c) => c.id === id))).toEqual([]);
    expect(KEEP_IN_VIEW.filter((id) => !grouped.some((c) => c.id === id))).toEqual([]);
    expect(FOLD_ORDER.filter((id) => KEEP_IN_VIEW.includes(id))).toEqual([]);
    expect(grouped.filter((c) => c.group !== 'constrain' && !FOLD_ORDER.includes(c.id) && !KEEP_IN_VIEW.includes(c.id)).map((c) => c.id)).toEqual([]);
    // jsdom has no layout: nothing folds there for width; 16 commands are in More by the default layout.
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-fit-folded')).toBe('0');
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-folded')).toBe('16');
    expect(root.querySelector('[data-cad-toolbar]')?.getAttribute('data-layout')).toBe('default');
    expect(root.querySelector('[data-chip="kernel"]')).toBeNull();
    expect(window.__CAD__?.snapshot().kernel.state).toBe('ready');
    expect(workers).toHaveLength(1);
    // A host before 1.6 has no exit hook: nothing registered.
    await vi.waitFor(() => expect(window.__CAD__?.leave.hook).toBe('unavailable'));
    expect(ws.leaveHook).toBeNull();
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
});
