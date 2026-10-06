// Toolbar (only working commands, tooltips, shortcuts), a feature panel opened
// from the viewport, the Parameters panel and the status chips. The shell has
// no feature panel of its own since Box and Cylinder were removed (decision
// 2026-10-01): the panel behaviours (live apply, Done, Delete, rename, errors,
// Ctrl+Z in a panel) are tested on the Enclosure panel
// (tests/features/enclosure/panel.test.tsx).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../src/types/doc';
import type { DocState } from '../../src/types/doc-service';
import { makeServices, type TestServices } from './fake-doc';
import { mountUi } from './mount';

let t: TestServices;
let ui: ReturnType<typeof mountUi>;

function start(opts: Parameters<typeof makeServices>[0] = {}) {
  t = makeServices(opts);
  ui = mountUi(t);
}

afterEach(() => {
  cleanup();
  ui?.dispose();
});

const key = (k: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(document.body, { key: k, ...init }));
const cmd = (id: string) => ui.$(`[data-command="${id}"]`)!;
const panelTitle = () => ui.$('[data-cad-panel] [data-panel-title]')?.textContent ?? null;
const seed = (type: 'extrude' | 'sketch') => {
  let f!: ReturnType<typeof t.doc.seed>;
  act(() => {
    f = t.doc.seed(type);
  });
  return f;
};

describe('toolbar', () => {
  it('shows nothing when the document has no feature types (nothing works yet)', () => {
    start({ types: [] });
    expect(ui.$('[data-cad-toolbar]')).toBeNull();
    expect(ui.$('[data-params-row]')).toBeNull();
  });

  it('shows only working commands, grouped, with tooltips and shortcuts; the shell itself has no Box or Cylinder', () => {
    start();
    // Feature commands come from their modules (none here); the shell's own are Parameters, Undo and Redo.
    expect(ui.$$('.tb-group').map((g) => g.getAttribute('data-group'))).toEqual(['modify', 'edit']);
    expect(ui.$$('.tb-group-label').map((g) => g.textContent)).toEqual(['MODIFY', 'EDIT']);
    expect(ui.$$('.tb-btn .tb-txt').map((b) => b.textContent)).toEqual(['Parameters', 'Undo', 'Redo']);
    expect(ui.$('[data-command="solid.box"]')).toBeNull();
    expect(ui.$('[data-command="solid.cylinder"]')).toBeNull();
    fireEvent.mouseEnter(cmd('modify.parameters'));
    expect(ui.tip()).toBe('ParametersNamed values that any size or position field can use');
    fireEvent.mouseLeave(cmd('modify.parameters'));
    // Undo is unavailable and says why; the shortcut is shown.
    expect(cmd('edit.undo').getAttribute('aria-disabled')).toBe('true');
    fireEvent.mouseEnter(cmd('edit.undo'));
    expect(ui.tip()).toBe('UndoCtrl+ZNothing to undo');
    expect(ui.$('[data-cad-tip] kbd')!.textContent).toBe('Ctrl+Z');
    fireEvent.click(cmd('edit.undo'));
    expect(t.doc.calls).not.toContain('undo');
  });

  it('shows the VIEW group for the viewport\'s view commands', () => {
    start();
    act(() => {
      t.services.commands.register({ id: 'view.fit', label: 'Fit', icon: 'M4 4h16v16H4z', shortcut: 'F', run: () => {} });
    });
    expect(ui.$$('.tb-group').map((g) => g.getAttribute('data-group'))).toEqual(['modify', 'view', 'edit']);
  });

  it('disables editing commands while the part cannot be edited, with the reason', () => {
    start();
    act(() => t.doc.setSave({ state: 'conflict', message: 'Changed in another tab' }));
    expect(cmd('modify.parameters').getAttribute('aria-disabled')).toBe('true');
    expect(cmd('modify.parameters').getAttribute('data-disabled-reason')).toBe('Changed in another tab · Reload to keep editing');
    fireEvent.click(cmd('modify.parameters'));
    expect(ui.$('[data-cad-panel="params"]')).toBeNull();
  });
});

describe('feature panels', () => {
  it('opens from the viewport\'s double-click and context menu', () => {
    start({ panels: true });
    const f = seed('extrude');
    const body = t.doc.state.get().rebuild.bodies[0];
    const pick = { item: { kind: 'face' as const, body: body.id, index: 2 }, point: [0, 0, 0] as [number, number, number], normal: null, depth: 1, screen: [5, 5] as [number, number] };
    act(() => t.services.bus.emit('viewport:contextmenu', { pick, clientX: 50, clientY: 60 }));
    expect(ui.menu()).toEqual(['Hide Body 1', 'Leave Body 1 out of the simulation', 'Rename Body 1', 'Edit Extrude 1', 'Rename Extrude 1', 'Suppress Extrude 1', '(Roll back to here)', 'Delete Extrude 1']);
    // Bug 2026-09-30: body and feature items shared ids (React key clash); every item id is unique.
    const ids = ui.$$('[data-cad-menu] [data-menu-item]').map((b) => b.getAttribute('data-menu-item'));
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.click(ui.menuItem('body-rename'));
    expect(ui.$<HTMLInputElement>('[data-body-row] input, [data-cad-tree] input[aria-label="Body name"]')).not.toBeNull();
    key('Escape');
    act(() => t.services.bus.emit('viewport:contextmenu', { pick, clientX: 50, clientY: 60 }));
    key('Escape');
    expect(ui.menu()).toEqual([]);
    act(() => t.services.bus.emit('viewport:dblclick', { pick }));
    expect(t.doc.calls).toContain(`beginEdit ${f.id}`);
    expect(panelTitle()).toBe('Extrude 1');
  });

  it('a feature of a removed type (a P1 Box) is not opened: Edit says why, and the row offers Delete', () => {
    start({ panels: true });
    let f!: ReturnType<typeof t.doc.seed>;
    act(() => {
      f = t.doc.seed('extrude');
      const s = t.doc.state.get();
      // A Part saved by P1 still holds a Box: the document keeps it as it was.
      const box = { id: 'f_old', type: 'box', name: 'Box 1', op: 'new', creates: 'b_old', scope: [], origin: ['0', '0', '0'], size: ['20', '20', '20'] };
      (t.doc.state as unknown as { set(v: object): void }).set({ doc: { ...s.doc, features: [box, ...s.doc.features] } });
      t.doc.setStatus('f_old', { state: 'error', message: 'This part uses a removed feature (Box 1)' });
    });
    expect(ui.history()).toEqual(['Box 1', 'Extrude 1', '|']);
    fireEvent.doubleClick(ui.row('f_old'));
    expect(ui.$('[data-cad-panel]')).toBeNull();
    expect(t.doc.calls).not.toContain('beginEdit f_old');
    expect(t.ws.log.toasts.at(-1)).toEqual({ message: 'This part uses a removed feature (Box 1). Solids come from sketches now: delete it, then sketch the shape and extrude it.', kind: 'info' });
    fireEvent.contextMenu(ui.row('f_old'));
    expect(ui.menu()).toEqual(['(Edit Box 1)', 'Rename Box 1', 'Suppress Box 1', 'Roll back to here', 'Delete Box 1']);
    fireEvent.mouseEnter(ui.menuItem('edit'));
    expect(ui.tip()).toBe('Edit Box 1This part uses a removed feature (Box 1). Solids come from sketches now: delete it, then sketch the shape and extrude it');
    fireEvent.mouseLeave(ui.menuItem('edit'));
    fireEvent.click(ui.menuItem('delete'));
    expect(t.doc.calls).toContain('remove f_old');
    expect(ui.history()).toEqual(['Extrude 1', '|']);
    void f;
  });
});

describe('Parameters panel', () => {
  const add = (name: string, expr: string, quantity?: string) => {
    fireEvent.change(ui.$('[aria-label="New parameter name"]')!, { target: { value: name } });
    fireEvent.change(ui.$('[aria-label="New parameter expression"]')!, { target: { value: expr } });
    if (quantity) fireEvent.change(ui.$('[aria-label="New parameter unit"]')!, { target: { value: quantity } });
    fireEvent.click(ui.$('[data-param-add-btn]')!);
  };
  const values = () => ui.$$('[data-param-row]').map((r) => [r.getAttribute('data-param-row'), r.querySelector('[data-param-value]')!.textContent]);
  const addError = () => ui.$('[data-param-error="new"]')?.textContent ?? null;

  it('adds, evaluates, refuses bad names and expressions inline, and deletes', () => {
    start();
    fireEvent.click(cmd('modify.parameters'));
    expect(panelTitle()).toBe('Parameters');
    expect(ui.$$('[data-cad-panel="params"] .mgk-panel-foot button').map((b) => b.textContent)).toEqual(['Done']);
    expect(ui.$('[data-params-empty]')!.textContent).toBe('No parameters yet');

    add('width', '50');
    expect(t.doc.calls).toContain('addParam width 50 mm length');
    expect(values()).toEqual([['width', '50 mm']]);
    expect(ui.$('[data-params-row] .tl')!.textContent).toBe('Parameters (1)');

    add('2x', '1');
    expect(addError()).toBe('A name starts with a letter or _ and has only letters, digits and _');
    add('mm', '1');
    expect(addError()).toBe('"mm" is a unit or function name');
    add('Width', '1');
    expect(addError()).toBe('A parameter named "width" already exists');
    add('depth', 'nothing * 2');
    expect(addError()).toBe('Unknown parameter "nothing"');
    // A new parameter that names itself is said as such, not as unknown (review round 1).
    add('depth', 'depth * 2');
    expect(addError()).toBe('depth cannot use itself');
    add('depth', 'width / 2');
    expect(addError()).toBeNull();
    add('angle1', '15', 'angle');
    expect(values()).toEqual([
      ['width', '50 mm'],
      ['depth', '25 mm'],
      ['angle1', '15°'],
    ]);

    // Editing an expression: a self-reference is refused inline; a valid one re-evaluates what uses it.
    const expr = ui.$<HTMLInputElement>('[data-param-row="width"] .nui input')!;
    fireEvent.focus(expr);
    fireEvent.change(expr, { target: { value: 'width + 1' } });
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(ui.$('[data-param-row="width"] [data-nui-error]')!.textContent).toBe('width cannot use itself');
    fireEvent.change(expr, { target: { value: '80' } });
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(values()[1]).toEqual(['depth', '40 mm']);

    // A cycle through another parameter is the document's to refuse; its reason shows inline.
    fireEvent.focus(expr);
    fireEvent.change(expr, { target: { value: 'depth * 2' } });
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(ui.$('[data-param-row="width"] [data-nui-error]')!.textContent).toBe('depth: width: depth uses itself');
    expect(t.doc.state.get().doc.params[0].expr).toBe('80 mm');
    fireEvent.keyDown(expr, { key: 'Escape' });
    expect(expr.value).toBe('80 mm');

    // Unit (quantity) change that does not fit the expression is refused inline.
    fireEvent.change(ui.$('[data-param-row="width"] [data-param-unit] select')!, { target: { value: 'angle' } });
    // Said once, by what the expression is (review round 1: no "is not a plain number: Expected a number without units").
    expect(ui.$('[data-param-error="width"]')!.textContent).toBe('80 mm is a length, not an angle');
    fireEvent.change(ui.$('[data-param-row="width"] [data-param-unit] select')!, { target: { value: 'scalar' } });
    expect(ui.$('[data-param-error="width"]')!.textContent).toBe('80 mm is a length, not a plain number');

    // Rename through the name cell.
    const name = ui.$<HTMLInputElement>('[data-param-row="angle1"] .cad-param-name')!;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'draft' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(t.doc.state.get().doc.params.map((p) => p.name)).toEqual(['width', 'depth', 'draft']);

    // Delete.
    fireEvent.click(ui.$('[data-param-row="draft"] [data-param-delete]')!);
    expect(values().map((v) => v[0])).toEqual(['width', 'depth']);

    fireEvent.click(ui.$('[data-panel-done]')!);
    expect(ui.$('[data-cad-panel]')).toBeNull();
  });

  it('refuses to delete a parameter a feature uses, with the reason', () => {
    start();
    fireEvent.click(cmd('modify.parameters'));
    add('len', '40');
    act(() => {
      t.doc.seed('extrude', { extent: { kind: 'blind', distance: 'len' } } as never);
    });
    fireEvent.click(ui.$('[data-param-row="len"] [data-param-delete]')!);
    // review round 3: the reason says it all (no "Delete failed:" before it).
    expect(ui.$('[data-param-error="len"]')!.textContent).toBe("len can't be deleted: Extrude 1 uses it");
    expect(values()).toEqual([['len', '40 mm']]);
  });
});

describe('status chips', () => {
  it('a removed feature (Box, Cylinder) not suppressed: the notice names it, and Suppress suppresses them in one step (L3 review B2)', () => {
    start();
    const chip = () => ui.$('[data-chip="removed"]');
    const docState = t.doc.state as unknown as { set(fn: (s: DocState) => DocState): void };
    expect(chip()).toBeNull();
    act(() => docState.set((s) => ({ ...s, doc: { ...s.doc, features: [{ id: 'f_box', type: 'box', name: 'Old box' } as unknown as Feature] } })));
    expect(chip()!.textContent).toBe('This Part uses a removed feature: Old boxSuppress it');
    act(() => docState.set((s) => ({ ...s, doc: { ...s.doc, features: [...s.doc.features, { id: 'f_cyl', type: 'cylinder', name: 'Old cylinder' } as unknown as Feature] } })));
    expect(chip()!.textContent).toBe('This Part uses removed features: Old box and Old cylinderSuppress them');
    fireEvent.click(chip()!.querySelector('[data-chip-action="Suppress"]')!);
    expect(t.doc.calls).toContain('suppressRemoved');
    expect(chip()).toBeNull();
  });

  it('shows save, kernel and volume states', () => {
    start();
    const chip = (k: string) => ui.$(`[data-chip="${k}"]`);
    expect(chip('save')).toBeNull();
    act(() => t.doc.setSave({ state: 'saving' }));
    expect(chip('save')!.textContent).toBe('Saving…');
    act(() => t.doc.setSave({ state: 'saved', at: '2026-09-30T12:00:00Z' }));
    expect(chip('save')!.textContent).toBe('Saved');
    act(() => t.doc.setSave({ state: 'error', message: 'the disk is full' }));
    // With Retry beside it (review round 3): the save is tried again at once.
    expect(chip('save')!.textContent).toBe('Not saved: the disk is fullRetry');
    fireEvent.click(chip('save')!.querySelector('[data-chip-action="Retry"]')!);
    expect(t.doc.calls).toContain('retrySave');
    act(() => t.doc.setSave({ state: 'error', message: 'the disk is full' }));
    act(() => t.doc.setSave({ state: 'conflict', message: 'Changed in another tab' }));
    expect(chip('save')!.textContent).toBe("Changed in another tabReload (discard my change)Keep mine (replace the other tab's save)");
    fireEvent.click(chip('save')!.querySelector('[data-chip-action="Reload"]')!);
    expect(t.doc.calls).toContain('reload');
    // L3 review B1: a tab with no change of its own that another tab saved over: Reload only (no Keep mine).
    act(() => t.doc.setSave({ state: 'updated', message: 'Updated in another tab' }));
    expect(chip('save')!.textContent).toBe('Updated in another tabReload');
    expect(chip('save')!.getAttribute('data-state')).toBe('updated');
    expect(chip('save')!.classList.contains('is-warning')).toBe(false);

    act(() => t.kernelStatus.set({ memory_high: true, heap_bytes: 1.5 * 1024 ** 3 }));
    expect(chip('memory')!.textContent).toBe('Large model · 1.5 GB memory');
    act(() => t.kernelStatus.set({ state: 'failed', message: 'The kernel failed to start: out of memory' }));
    expect(chip('memory')).toBeNull();
    expect(chip('kernel')!.textContent).toBe('The kernel failed to start: out of memoryRetry');

    // Volume (P4a, Daniel 2026-10-02): the selected body's; with nothing selected each shown body on
    // its own, never added together; unmeasured bodies offer Measure.
    act(() => {
      t.doc.seed('extrude');
      t.doc.seed('extrude');
    });
    expect(chip('volume')!.textContent).toBe('VolumeBody 1: 6000 mm³ · Body 2: 6000 mm³');
    expect(chip('volume')!.textContent).not.toContain('12,000');
    const b = t.doc.state.get().rebuild.bodies[1];
    act(() => t.services.selection.set({ items: [{ kind: 'body', body: b.id }] }));
    expect(chip('volume')!.textContent).toBe('VolumeBody 2 · 6000 mm³');
    // Two selected: each on its own too.
    act(() => t.services.selection.set({ items: t.doc.state.get().rebuild.bodies.map((x) => ({ kind: 'body' as const, body: x.id })) }));
    expect(chip('volume')!.textContent).toBe('VolumeBody 1: 6000 mm³ · Body 2: 6000 mm³');
    // A hidden body is not listed, and the chip says so.
    act(() => t.services.selection.set({ items: [] }));
    const s0 = t.doc.state.get();
    act(() => (t.doc.state as unknown as { set(v: object): void }).set({ rebuild: { ...s0.rebuild, bodies: s0.rebuild.bodies.map((x, i) => (i === 1 ? { ...x, visible: false } : x)) } }));
    expect(chip('volume')!.textContent).toBe('VolumeBody 1 · 6000 mm³ (1 hidden body not listed)');
  });

  it('offers Measure when a large body has no volume yet', async () => {
    start();
    act(() => {
      t.doc.seed('extrude');
    });
    const s = t.doc.state.get();
    act(() => (t.doc.state as unknown as { set(v: object): void }).set({ rebuild: { ...s.rebuild, bodies: s.rebuild.bodies.map((x) => ({ ...x, volume: null })) } }));
    const chip = ui.$('[data-chip="volume"]')!;
    expect(chip.textContent).toBe('VolumeNot measured yetMeasure');
    await act(async () => {
      fireEvent.click(chip.querySelector('[data-chip-action="Measure"]')!);
    });
    expect(t.doc.calls.some((c) => c.startsWith('measure '))).toBe(true);
    expect(ui.$('[data-chip="volume"]')!.textContent).toBe('Volume1000 mm³');
  });
});
