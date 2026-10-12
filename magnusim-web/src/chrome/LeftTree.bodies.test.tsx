// Bodies hidden in the view, in the setup tree: a hidden body's row is lighter grey, and a
// body row's right-click hides or shows it (or every picked body), next to the geometry's
// own actions.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetupTreeView } from './LeftTree';
import type { SetupTreeModel } from './treeModel';
import { useProjectStore } from '../store/project';
import { resetGeometryActionsForTests } from '../workspace/geometryActions';
import { publishBodyView, resetBodyViewForTests, setBodyViewHandler, type BodyViewRequest } from '../workbench/bodyView';

const ACTIONS = [
  { plugin: 'cad', plugin_name: 'Magnusim CAD', study_kind: 'part', label: 'Edit in CAD', hint: 'Open this part in CAD.', places: ['tree', 'viewport', 'panel'], workspace: 'cad', workspace_title: 'CAD', enabled: true, reason: '' },
];

function model(bodies: string[], editActions?: typeof ACTIONS): SetupTreeModel {
  return { selectedKey: null, geoms: [{ id: 'g1', name: 'boxes', bodies, studies: [], editActions }] };
}

const row = (i: number) => document.querySelector(`[data-w16-geom="g1"] [data-w16-body="1"][data-body-index="${i}"]`) as HTMLElement;
const menuLabels = () => Array.from(document.querySelectorAll('[data-geom-menu="g1"] [role="menuitem"]')).map((b) => b.textContent);

let asked: BodyViewRequest[] = [];

beforeEach(() => {
  asked = [];
  useProjectStore.setState({ projectId: 'proj-a' });
  resetGeometryActionsForTests();
  resetBodyViewForTests();
  setBodyViewHandler((req) => asked.push(req));
});

afterEach(() => {
  cleanup();
  resetBodyViewForTests();
});

describe('the tree: bodies hidden in the view', () => {
  it("a hidden body's row has the lighter class and says so; the others don't", () => {
    publishBodyView({ geometryId: 'g1', count: 2, hidden: [2], selected: [] });
    render(<ul><SetupTreeView model={model(['Body1', 'Body2'])} /></ul>);
    expect(row(2).classList.contains('is-hidden-body')).toBe(true);
    expect(row(2).getAttribute('title')).toBe('Hidden in the view');
    expect(row(2).getAttribute('data-body-hidden')).toBe('1');
    expect(row(1).classList.contains('is-hidden-body')).toBe(false);
    expect(row(1).getAttribute('title')).toBeNull();
  });

  it('a body row hides its body, and shows it again once hidden', () => {
    publishBodyView({ geometryId: 'g1', count: 2, hidden: [], selected: [] });
    const { rerender } = render(<ul><SetupTreeView model={model(['Body1', 'Body2'])} /></ul>);
    fireEvent.contextMenu(row(2).querySelector('.tree-row') as HTMLElement, { clientX: 20, clientY: 40 });
    expect(menuLabels()).toEqual(['Hide body']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide body' }));
    expect(asked).toEqual([{ kind: 'hide', bodies: [2] }]);
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
    act(() => publishBodyView({ hidden: [2] }));
    rerender(<ul><SetupTreeView model={model(['Body1', 'Body2'])} /></ul>);
    fireEvent.contextMenu(row(2).querySelector('.tree-row') as HTMLElement);
    expect(menuLabels()).toEqual(['Show body']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show body' }));
    expect(asked[1]).toEqual({ kind: 'show', bodies: [2] });
  });

  it('several picked rows: both marked, Hide 2 bodies, and the geometry actions stay below', () => {
    publishBodyView({ geometryId: 'g1', count: 3, hidden: [], selected: [1, 3] });
    render(<ul><SetupTreeView model={model(['Body1', 'Body2', 'Body3'], ACTIONS)} /></ul>);
    expect(row(1).classList.contains('selected')).toBe(true);
    expect(row(3).classList.contains('selected')).toBe(true);
    expect(row(2).classList.contains('selected')).toBe(false);
    fireEvent.contextMenu(row(3).querySelector('.tree-row') as HTMLElement);
    expect(menuLabels()).toEqual(['Hide 2 bodies', expect.stringContaining('Edit in CAD')]);
    expect(document.querySelector('[data-geom-menu="g1"] [role="separator"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide 2 bodies' }));
    expect(asked).toEqual([{ kind: 'hide', bodies: [1, 3] }]);
  });

  it('Show all bodies on another row while a body is hidden', () => {
    publishBodyView({ geometryId: 'g1', count: 2, hidden: [2], selected: [] });
    render(<ul><SetupTreeView model={model(['Body1', 'Body2'])} /></ul>);
    fireEvent.contextMenu(row(1).querySelector('.tree-row') as HTMLElement);
    expect(menuLabels()).toEqual(['Hide body', 'Show all bodies']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show all bodies' }));
    expect(asked).toEqual([{ kind: 'show-all' }]);
  });

  it('a single body has no hide item (and no menu without geometry actions)', () => {
    publishBodyView({ geometryId: 'g1', count: 1, hidden: [], selected: [] });
    const { unmount } = render(<ul><SetupTreeView model={model(['Body1'])} /></ul>);
    const r = row(1).querySelector('.tree-row') as HTMLElement;
    expect(r.getAttribute('tabindex')).toBeNull();
    fireEvent.contextMenu(r);
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
    unmount();
    render(<ul><SetupTreeView model={model(['Body1'], ACTIONS)} /></ul>);
    fireEvent.contextMenu(row(1).querySelector('.tree-row') as HTMLElement);
    expect(menuLabels()).toEqual([expect.stringContaining('Edit in CAD')]);
  });

  it("a geometry the viewport doesn't show: no hide items, no grey rows", () => {
    publishBodyView({ geometryId: 'g2', count: 2, hidden: [2], selected: [] });
    render(<ul><SetupTreeView model={model(['Body1', 'Body2'])} /></ul>);
    expect(row(2).classList.contains('is-hidden-body')).toBe(false);
    fireEvent.contextMenu(row(2).querySelector('.tree-row') as HTMLElement);
    expect(document.querySelector('[data-geom-menu]')).toBeNull();
  });
});
