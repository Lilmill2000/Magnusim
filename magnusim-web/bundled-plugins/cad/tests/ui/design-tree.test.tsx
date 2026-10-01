// The design tree: order, rollback bar (drag and keys), row states, badges,
// context menu actions, inline rename, selection sync, bodies.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../src/types/doc';
import { makeServices, type TestServices } from './fake-doc';
import { mountUi } from './mount';

let t: TestServices;
let ui: ReturnType<typeof mountUi>;
let f: Feature[];

beforeEach(() => {
  t = makeServices({ viewport: true });
  f = [t.doc.seed('box'), t.doc.seed('cylinder'), t.doc.seed('box')];
  ui = mountUi(t);
});

afterEach(() => {
  cleanup();
  ui.dispose();
});

const key = (k: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(document.body, { key: k, ...init }));

describe('design tree', () => {
  it('shows the part name, the origin, bodies and the history in document order', () => {
    expect(ui.$('[data-part-name] .tl')!.textContent).toBe('Part 1');
    expect(ui.$$('.geo-head').map((e) => e.textContent)).toEqual(['PART', 'HISTORY']);
    expect(ui.$$('[data-tree-node^="origin:"] .tl').map((e) => e.textContent)).toEqual(['Top plane', 'Front plane', 'Right plane']);
    expect(ui.history()).toEqual(['Box 1', 'Cylinder 1', 'Box 2', '|']);
    expect(ui.$('[data-bodies-folder] > .tree-row .tl')!.textContent).toBe('Bodies (3)');
    expect(ui.$('[data-params-row] .tl')!.textContent).toBe('Parameters (0)');
    // Feature type icons come from the document's registry.
    expect(ui.row(f[0].id).querySelector('path')!.getAttribute('d')).toBe(t.doc.features.get('box')!.icon);
  });

  it('follows a rename in the host header', () => {
    act(() => t.ws.push('study', { ...t.ws.context.study, title: 'Pump housing', rev: 2 }));
    expect(ui.$('[data-part-name] .tl')!.textContent).toBe('Pump housing');
  });

  it('moves the rollback bar with the keyboard and dims what is below it', () => {
    const bar = () => ui.$('[data-rollback-bar]')!;
    act(() => bar().focus());
    key('ArrowUp');
    fireEvent.keyDown(bar(), { key: 'ArrowUp' });
    expect(t.doc.calls).toContain('setRollback 2');
    expect(ui.history()).toEqual(['Box 1', 'Cylinder 1', '|', 'Box 2']);
    expect(ui.node(f[2].id).className).toContain('is-rolled-back');
    expect(ui.node(f[1].id).className).not.toContain('is-rolled-back');
    expect(ui.$('[data-bodies-folder] > .tree-row .tl')!.textContent).toBe('Bodies (2)');
    fireEvent.keyDown(bar(), { key: 'Home' });
    expect(ui.history()).toEqual(['|', 'Box 1', 'Cylinder 1', 'Box 2']);
    expect(ui.$$('[data-rolled-back]')).toHaveLength(3);
    fireEvent.keyDown(bar(), { key: 'ArrowDown' });
    expect(ui.history()).toEqual(['Box 1', '|', 'Cylinder 1', 'Box 2']);
    fireEvent.keyDown(bar(), { key: 'End' });
    expect(ui.history()).toEqual(['Box 1', 'Cylinder 1', 'Box 2', '|']);
    expect(t.doc.state.get().view.rollback).toBeNull();
    expect(bar().getAttribute('aria-valuenow')).toBe('3');
  });

  it('drags the rollback bar between rows', () => {
    const rows = [f[0], f[1], f[2]].map((x) => ui.row(x.id));
    rows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: 100 + i * 24, height: 24, bottom: 124 + i * 24, left: 0, right: 200, width: 200, x: 0, y: 100 + i * 24, toJSON() {} }) as DOMRect;
    });
    const bar = ui.$('[data-rollback-bar]')!;
    fireEvent.pointerDown(bar, { button: 0, clientY: 175 });
    // Over the middle of Cylinder 1's row (y 124..148): the bar goes above it while dragging.
    act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientY: 130 })));
    expect(ui.history()).toEqual(['Box 1', '|', 'Cylinder 1', 'Box 2']);
    expect(ui.node(f[1].id).className).toContain('is-rolled-back');
    expect(t.doc.calls.filter((c) => c.startsWith('setRollback'))).toEqual([]);
    act(() => void window.dispatchEvent(new MouseEvent('pointerup', { clientY: 130 })));
    expect(t.doc.calls).toContain('setRollback 1');
    expect(t.doc.state.get().view.rollback).toBe(1);
    expect(ui.history()).toEqual(['Box 1', '|', 'Cylinder 1', 'Box 2']);
  });

  it('suppresses from the context menu: the row greys and says so', () => {
    fireEvent.contextMenu(ui.row(f[1].id), { clientX: 40, clientY: 60 });
    expect(ui.menu()).toEqual(['Edit Cylinder 1', 'Rename Cylinder 1', 'Suppress Cylinder 1', 'Roll back to here', 'Delete Cylinder 1']);
    expect(ui.node(f[1].id).className).toContain('selected');
    fireEvent.click(ui.menuItem('suppress'));
    expect(t.doc.calls).toContain(`setSuppressed ${f[1].id} true`);
    expect(ui.menu()).toEqual([]);
    expect(ui.node(f[1].id).className).toContain('is-suppressed');
    expect(ui.row(f[1].id).querySelector('.tree-sub')!.textContent).toBe('Suppressed');
    fireEvent.contextMenu(ui.row(f[1].id), { clientX: 40, clientY: 60 });
    expect(ui.menu()).toContain('Unsuppress Cylinder 1');
    fireEvent.click(ui.menuItem('suppress'));
    expect(ui.node(f[1].id).className).not.toContain('is-suppressed');
  });

  it('rolls back to a feature and to the end from the context menu', () => {
    fireEvent.contextMenu(ui.row(f[0].id), { clientX: 40, clientY: 60 });
    fireEvent.click(ui.menuItem('rollback'));
    expect(t.doc.calls).toContain('setRollback 1');
    expect(ui.history()).toEqual(['Box 1', '|', 'Cylinder 1', 'Box 2']);
    fireEvent.contextMenu(ui.row(f[2].id), { clientX: 40, clientY: 60 });
    // A rolled-back feature cannot be edited until the bar moves below it.
    expect(ui.menu()).toEqual(['(Edit Box 2)', 'Rename Box 2', 'Suppress Box 2', 'Roll back to here', 'Roll to end', 'Delete Box 2']);
    fireEvent.click(ui.menuItem('roll-end'));
    expect(t.doc.state.get().view.rollback).toBeNull();
  });

  it('deletes from the menu, and says why when the document refuses', () => {
    fireEvent.contextMenu(ui.row(f[2].id), { clientX: 40, clientY: 60 });
    fireEvent.click(ui.menuItem('delete'));
    expect(ui.history()).toEqual(['Box 1', 'Cylinder 1', '|']);
    act(() => {
      t.doc.rename(f[0].id, 'Locked');
    });
    fireEvent.contextMenu(ui.row(f[0].id), { clientX: 40, clientY: 60 });
    fireEvent.click(ui.menuItem('delete'));
    expect(ui.history()).toEqual(['Locked', 'Cylinder 1', '|']);
    expect(t.ws.log.toasts.at(-1)).toEqual({ message: 'Delete Locked failed: Cylinder 1 uses Locked', kind: 'error' });
  });

  it('deletes the selected feature with the Delete key', () => {
    fireEvent.click(ui.row(f[1].id));
    key('Delete');
    expect(t.doc.calls).toContain(`remove ${f[1].id}`);
    expect(ui.history()).toEqual(['Box 1', 'Box 2', '|']);
    expect(t.services.selection.get().items).toEqual([]);
  });

  it('shows a failed feature in red with a "What\'s wrong" tooltip and its fix in the menu', () => {
    act(() => t.doc.setStatus(f[2].id, { state: 'error', message: 'Box 2 failed: the result is not a valid solid', actions: ['repair'] }));
    expect(ui.node(f[2].id).className).toContain('is-error');
    const badge = ui.$(`[data-tree-node="${f[2].id}"] [data-feature-badge]`)!;
    expect(badge.getAttribute('data-feature-badge')).toBe('error');
    expect(badge.getAttribute('aria-label')).toBe("What's wrong: Box 2 failed: the result is not a valid solid");
    fireEvent.mouseEnter(badge);
    expect(ui.tip()).toBe("What's wrongBox 2 failed: the result is not a valid solid");
    fireEvent.mouseLeave(badge);
    expect(ui.tip()).toBeNull();
    // The tooltip goes with the badge when the error is fixed under a still pointer.
    fireEvent.mouseEnter(badge);
    expect(ui.tip()).not.toBeNull();
    act(() => t.doc.setStatus(f[2].id, null));
    expect(ui.$(`[data-tree-node="${f[2].id}"] [data-feature-badge]`)).toBeNull();
    expect(ui.tip()).toBeNull();
    act(() => t.doc.setStatus(f[2].id, { state: 'error', message: 'Box 2 failed: the result is not a valid solid', actions: ['repair'] }));
    fireEvent.contextMenu(ui.row(f[2].id), { clientX: 40, clientY: 60 });
    expect(ui.menu()).toContain('Try repair');
    fireEvent.click(ui.menuItem('action-repair'));
    expect(t.doc.calls).toContain(`repair ${f[2].id}`);

    act(() => t.doc.setStatus(f[0].id, { state: 'warning', message: 'Nothing to cut' }));
    expect(ui.node(f[0].id).className).toContain('is-warning');
    expect(ui.$(`[data-tree-node="${f[0].id}"] [data-feature-badge]`)!.getAttribute('data-feature-badge')).toBe('warning');
  });

  it('opens the feature panel on double-click, but not for a rolled-back feature', () => {
    fireEvent.doubleClick(ui.row(f[1].id));
    expect(t.doc.calls).toContain(`beginEdit ${f[1].id}`);
    expect(ui.$('[data-cad-panel="feature"] [data-panel-title]')!.textContent).toBe('Cylinder 1');
    act(() => t.doc.setRollback(2));
    fireEvent.doubleClick(ui.row(f[2].id));
    expect(t.ws.log.toasts.at(-1)).toEqual({ message: 'Roll forward to edit Box 2', kind: 'info' });
    expect(t.doc.calls).not.toContain(`beginEdit ${f[2].id}`);
  });

  it('renames in place with F2: Enter commits, a duplicate is refused inline, Escape cancels', () => {
    fireEvent.click(ui.row(f[0].id));
    key('F2');
    const input = () => ui.$<HTMLInputElement>(`[data-tree-node="${f[0].id}"] input`);
    expect(input()!.value).toBe('Box 1');
    fireEvent.change(input()!, { target: { value: 'cylinder 1' } });
    fireEvent.keyDown(input()!, { key: 'Enter' });
    expect(ui.$(`[data-tree-node="${f[0].id}"] [role="alert"]`)!.textContent).toBe('A feature named "Cylinder 1" already exists');
    expect(input()).not.toBeNull();
    fireEvent.keyDown(input()!, { key: 'Escape' });
    expect(input()).toBeNull();
    expect(ui.row(f[0].id).querySelector('.tl')!.textContent).toBe('Box 1');

    fireEvent.contextMenu(ui.row(f[0].id), { clientX: 40, clientY: 60 });
    fireEvent.click(ui.menuItem('rename'));
    fireEvent.change(input()!, { target: { value: '  Base plate ' } });
    fireEvent.keyDown(input()!, { key: 'Enter' });
    expect(t.doc.calls).toContain(`rename ${f[0].id} Base plate`);
    expect(input()).toBeNull();
    expect(ui.history()[0]).toBe('Base plate');
  });

  it('selects rows (Ctrl toggles) and follows viewport picks', () => {
    fireEvent.click(ui.row(f[0].id));
    fireEvent.click(ui.row(f[2].id), { ctrlKey: true });
    expect(t.services.selection.get().items).toEqual([
      { kind: 'feature', feature: f[0].id },
      { kind: 'feature', feature: f[2].id },
    ]);
    expect(ui.$$('[data-feature-row].selected').map((e) => e.getAttribute('data-tree-node'))).toEqual([f[0].id, f[2].id]);
    fireEvent.click(ui.row(f[2].id), { ctrlKey: true });
    expect(ui.$$('[data-feature-row].selected')).toHaveLength(1);

    // A face picked in the viewport selects its body row and marks the feature that made it.
    const body = t.doc.state.get().rebuild.bodies[2];
    act(() => t.services.selection.set({ items: [{ kind: 'face', body: body.id, index: 4 }] }));
    fireEvent.click(ui.$('[data-bodies-folder] > .tree-row')!);
    expect(ui.node(`body:${body.id}`).className).toContain('selected');
    expect(ui.node(f[2].id).className).toContain('is-related');
    expect(ui.node(f[0].id).className).not.toContain('selected');
  });

  it('flashes the hovered row in the viewport and looks at a plane from its menu', () => {
    fireEvent.mouseEnter(ui.row(f[1].id));
    expect(t.flashes.at(-1)).toEqual([{ kind: 'feature', feature: f[1].id }]);
    fireEvent.mouseLeave(ui.row(f[1].id));
    expect(t.flashes.at(-1)).toEqual([]);
    fireEvent.contextMenu(ui.row('origin:front'), { clientX: 10, clientY: 10 });
    expect(ui.menu()).toEqual(['Look at']);
    fireEvent.click(ui.menuItem('look-at'));
    expect(t.looks.at(-1)).toEqual([[0, -1, 0], [0, 0, 1]]);
  });

  it('switches the origin planes between drawn when needed and always drawn', () => {
    const eye = () => ui.$('[data-tree-node="origin"] > .tree-row [data-origin-act="planes"]')!;
    expect(eye().getAttribute('aria-label')).toBe('Always draw the origin planes');
    expect(eye().getAttribute('aria-pressed')).toBe('false');
    fireEvent.mouseEnter(eye());
    expect(ui.tip()).toBe('Always draw the origin planesOff: drawn on an empty part, and while one is selected or hovered');
    fireEvent.click(eye());
    expect(eye().getAttribute('aria-pressed')).toBe('true');
    expect(eye().getAttribute('data-planes')).toBe('always');
    // The click did not fold the Origin folder.
    expect(ui.node('origin').className).toContain('expanded');
    fireEvent.click(eye());
    expect(eye().getAttribute('data-planes')).toBe('auto');
  });

  it('hides a body with its eye and renames it', () => {
    fireEvent.click(ui.$('[data-bodies-folder] > .tree-row')!);
    const b = t.doc.state.get().rebuild.bodies[0];
    const eye = ui.$(`[data-body-row="${b.id}"] [data-body-act="visibility"]`)!;
    expect(eye.getAttribute('aria-label')).toBe('Hide Body 1');
    fireEvent.click(eye);
    expect(t.doc.calls).toContain(`setBodyVisible ${b.id} false`);
    expect(ui.$(`[data-body-row="${b.id}"]`)!.getAttribute('data-visible')).toBe('0');
    expect(ui.$(`[data-body-row="${b.id}"] [data-body-act="visibility"]`)!.getAttribute('aria-label')).toBe('Show Body 1');
    fireEvent.click(ui.$(`[data-body-row="${b.id}"] [data-body-act="rename"]`)!);
    const input = ui.$<HTMLInputElement>(`[data-body-row="${b.id}"] input`)!;
    fireEvent.change(input, { target: { value: 'Body 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ui.$(`[data-body-row="${b.id}"] [role="alert"]`)!.textContent).toBe('A body named "Body 2" already exists');
    fireEvent.change(input, { target: { value: 'Housing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ui.$(`[data-body-row="${b.id}"] .cad-body-name`)!.textContent).toBe('Housing');
  });

  it('says the part is opening, or why it could not be read with a way to try again', () => {
    cleanup();
    ui.dispose();
    t = makeServices({ status: 'loading' });
    ui = mountUi(t);
    expect(ui.$('[data-tree-empty="loading"]')!.textContent).toBe('Opening the part…');
    expect(ui.$('[data-tree-empty="history"]')).toBeNull();
    expect(ui.$('[data-command="solid.box"]')!.getAttribute('data-disabled-reason')).toBe('The part is still loading');
    act(() => (t.doc.state as unknown as { set(v: object): void }).set({ status: 'error', error: 'Could not read the part: bad JSON' }));
    const err = ui.$('[data-tree-error]')!;
    expect(err.textContent).toBe('Could not read the part: bad JSONTry again');
    fireEvent.click(err.querySelector('[data-fix="Try again"]')!);
    expect(t.doc.calls).toContain('reload');
  });

  it('shows "No features yet" and no rollback bar in an empty part', () => {
    cleanup();
    ui.dispose();
    t = makeServices();
    ui = mountUi(t);
    expect(ui.$('[data-tree-empty="history"]')!.textContent).toBe('No features yet');
    expect(ui.$('[data-rollback-bar]')).toBeNull();
    expect(ui.$('[data-bodies-folder] > .tree-row .tl')!.textContent).toBe('Bodies (0)');
    fireEvent.click(ui.$('[data-bodies-folder] > .tree-row')!);
    expect(ui.$('[data-tree-empty="bodies"]')!.textContent).toBe('No bodies yet');
  });
});
