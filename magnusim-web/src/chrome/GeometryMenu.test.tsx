// Geometry actions in the tree and the Geometry panel (host API 1.7): the right-click menu
// of a geometry and its bodies, its keyboard, an action that is off with its reason, and
// the panel's button and original row.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupTreeView } from './LeftTree';
import type { SetupTreeModel } from './treeModel';
import { GeometryPanel } from '../panels/geometry/GeometryPanel';
import { useProjectStore } from '../store/project';
import { rememberTreeActions, resetGeometryActionsForTests } from '../workspace/geometryActions';

const ACTIONS = [
  { plugin: 'cad', plugin_name: 'Magnusim CAD', study_kind: 'part', label: 'Edit in CAD', hint: 'Open this part in CAD.', places: ['tree', 'viewport', 'panel'], workspace: 'cad', workspace_title: 'CAD', enabled: true, reason: '' },
];
const OFF = [{ ...ACTIONS[0], enabled: false, reason: 'pipe is a mesh (STL). CAD edits STEP, IGES and BREP parts: import it as STEP to edit it.' }];

function model(editActions: typeof ACTIONS | undefined): SetupTreeModel {
  return { selectedKey: null, geoms: [{ id: 'g1', name: 'box', bodies: ['Body1'], studies: [], editActions }] };
}

let fetched: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  fetched = [];
  useProjectStore.setState({ projectId: 'proj-a' });
  resetGeometryActionsForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      fetched.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true, plugin: 'cad', study_id: 'st-1', workspace: 'cad', created: false }), { status: 200 });
    }),
  );
  location.hash = '';
});

afterEach(() => {
  // React unmounts the menus it rendered (a portal on the body) before anything else goes.
  cleanup();
  vi.unstubAllGlobals();
});

describe('the tree: right-click on a geometry', () => {
  it('opens the menu on the geometry row and on a body row; a click opens the workspace', async () => {
    render(<ul><SetupTreeView model={model(ACTIONS)} /></ul>);
    const row = document.querySelector('[data-w16-geom="g1"] > .tree-row') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    const menu = document.querySelector('[data-geom-menu="g1"]') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('role')).toBe('menu');
    const item = screen.getByRole('menuitem', { name: /Edit in CAD/ });
    expect(item.textContent).toContain('Open this part in CAD.');
    await act(async () => {
      fireEvent.click(item);
    });
    expect(fetched[0]).toEqual({ url: '/api/geometry-actions/open', body: { project_id: 'proj-a', geometry_id: 'g1', plugin: 'cad', study_kind: 'part' } });
    expect(location.hash).toBe('#/p/proj-a/ws/cad/cad/st-1');
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
    // A body row has the same menu.
    const body = document.querySelector('[data-w16-body="1"] > .tree-row') as HTMLElement;
    fireEvent.contextMenu(body, { clientX: 40, clientY: 70 });
    expect(document.querySelector('[data-geom-menu="g1"]')).toBeTruthy();
  });

  it('Shift+F10 opens it at the row; Escape closes it and gives the row its focus back', () => {
    render(<ul><SetupTreeView model={model(ACTIONS)} /></ul>);
    const row = document.querySelector('[data-w16-geom="g1"] > .tree-row') as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const item = screen.getByRole('menuitem', { name: /Edit in CAD/ });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('an action that is off is shown disabled with its reason; no action, no menu', () => {
    const { unmount } = render(<ul><SetupTreeView model={model(OFF)} /></ul>);
    fireEvent.contextMenu(document.querySelector('[data-w16-geom="g1"] > .tree-row') as HTMLElement);
    const item = screen.getByRole('menuitem', { name: /Edit in CAD/ });
    expect(item).toBeDisabled();
    expect(document.querySelector('[data-geom-action-reason="1"]')?.textContent).toBe(OFF[0].reason);
    unmount();
    render(<ul><SetupTreeView model={model([])} /></ul>);
    const row = document.querySelector('[data-w16-geom="g1"] > .tree-row') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe(null);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
  });
});

describe('the Geometry panel', () => {
  beforeEach(() => {
    window.__CFD_GEOMETRY_STATE__ = { has_geometry: true, id: 'g1', title: 'box', name: 'box', representation: 'STEP (CAD)', volume: 'Body1', can_delete: true };
  });

  it('shows the action as a button with its hint, and its reason when it is off', () => {
    rememberTreeActions('proj-a', [{ id: 'g1', edit_actions: ACTIONS }]);
    const { unmount } = render(<GeometryPanel panelId="panel-geometry" scope="p:proj-a/g:g1" />);
    const btn = document.querySelector('[data-geometry-action-button="part"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('Edit in CAD');
    expect(btn.disabled).toBe(false);
    expect(screen.getByText('Open this part in CAD.')).toBeInTheDocument();
    unmount();
    rememberTreeActions('proj-a', [{ id: 'g1', edit_actions: OFF }]);
    render(<GeometryPanel panelId="panel-geometry" scope="p:proj-a/g:g1" />);
    expect((document.querySelector('[data-geometry-action-button="part"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-geometry-action-reason="1"]')?.textContent).toBe(OFF[0].reason);
  });

  it("an adopted geometry's original row imports it again", async () => {
    rememberTreeActions('proj-a', [{ id: 'g1', edit_actions: ACTIONS, original: { file_name: 'box.step', format: 'step', present: true } }]);
    render(<GeometryPanel panelId="panel-geometry" scope="p:proj-a/g:g1" />);
    const row = document.querySelector('[data-geometry-original="1"]') as HTMLElement;
    expect(row.textContent).toContain('box.step');
    await act(async () => {
      fireEvent.click(document.querySelector('[data-geometry-original-import="1"]') as HTMLElement);
    });
    expect(fetched.find((f) => f.url === '/api/geometry/original/import')?.body).toEqual({ project_id: 'proj-a', geometry_id: 'g1' });
  });
});

describe('review fixes: the menu with every action off, and a study editing a geometry', () => {
  it('Tab closes a menu whose every action is off (the menu itself has the focus)', () => {
    render(<ul><SetupTreeView model={model(OFF)} /></ul>);
    const row = document.querySelector('[data-w16-geom="g1"] > .tree-row') as HTMLElement;
    fireEvent.contextMenu(row);
    const menu = document.querySelector('[data-geom-menu="g1"]') as HTMLElement;
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
  });

  it('the geometry row says "Being edited in <Part>" with its Edit button', () => {
    const m: SetupTreeModel = {
      selectedKey: null,
      geoms: [{ id: 'g1', name: 'box', bodies: ['Body1'], studies: [], editActions: ACTIONS, editedIn: [{ plugin: 'cad', id: 'st-1', title: 'box (2)', workspace: 'cad', scopeKey: 'p:proj-a/plugin:cad/study:st-1', available: true }] }],
    };
    render(<ul><SetupTreeView model={m} /></ul>);
    expect(document.querySelector('[data-geom-edited-by="st-1"]')?.textContent).toContain('Being edited in box (2)');
    expect(document.querySelector('[data-geom-edited-open="st-1"]')).toBeTruthy();
  });

  it('the geometry action open gives up after its timeout with a message', async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on the platform's clock: one on the test's clock in its place.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return c.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: RequestInfo | URL, init: RequestInit = {}) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError'))))),
    );
    const { openGeometryAction, OPEN_TIMEOUT_MS, actionsFor } = await import('../workspace/geometryActions');
    const entry = actionsFor({ edit_actions: ACTIONS }, 'tree')[0];
    const p = openGeometryAction('proj-a', 'g1', entry, { open: vi.fn() });
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 10);
    expect((await p).message).toBe('The app did not answer within 15 seconds. Try again in a moment.');
    timeout.mockRestore();
    vi.useRealTimers();
  });
});
