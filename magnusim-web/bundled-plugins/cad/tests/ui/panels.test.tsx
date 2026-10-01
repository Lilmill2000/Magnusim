// Toolbar (only working commands, tooltips, shortcuts), the Box / Cylinder
// flyouts (live apply, Done, Delete, rename, operation, errors), the
// Parameters panel and the status chips.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxFeature, CylinderFeature } from '../../src/types/doc';
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
const field = (name: string) => ui.$<HTMLInputElement>(`[data-cad-panel="feature"] .nui[data-field="${name}"] input`)!;
const fieldError = (name: string) => ui.$(`[data-cad-panel="feature"] .nui[data-field="${name}"] [data-nui-error]`)?.textContent ?? null;
const panelTitle = () => ui.$('[data-cad-panel] [data-panel-title]')?.textContent ?? null;
const setField = (name: string, text: string) => {
  const input = field(name);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
};
const features = () => t.doc.state.get().doc.features;
const seed = (type: 'box' | 'cylinder') => {
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

  it('shows only working commands, grouped, with tooltips and shortcuts', () => {
    start();
    expect(ui.$$('.tb-group').map((g) => g.getAttribute('data-group'))).toEqual(['solid', 'modify', 'edit']);
    expect(ui.$$('.tb-group-label').map((g) => g.textContent)).toEqual(['SOLID', 'MODIFY', 'EDIT']);
    expect(ui.$$('.tb-btn .tb-txt').map((b) => b.textContent)).toEqual(['Box', 'Cylinder', 'Parameters', 'Undo', 'Redo']);
    fireEvent.mouseEnter(cmd('solid.box'));
    expect(ui.tip()).toBe('BoxA box body from its size and corner position');
    fireEvent.mouseLeave(cmd('solid.box'));
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
    expect(ui.$$('.tb-group').map((g) => g.getAttribute('data-group'))).toEqual(['solid', 'modify', 'view', 'edit']);
  });

  it('disables editing commands while the part cannot be edited, with the reason', () => {
    start();
    act(() => t.doc.setSave({ state: 'conflict', message: 'Changed in another tab' }));
    expect(cmd('solid.box').getAttribute('aria-disabled')).toBe('true');
    expect(cmd('solid.box').getAttribute('data-disabled-reason')).toBe('Changed in another tab · Reload to keep editing');
    fireEvent.click(cmd('solid.box'));
    expect(t.doc.calls).not.toContain('beginNew box');
  });
});

describe('Box panel', () => {
  it('creates Box 1 live, applies valid fields, refuses invalid ones inline, Done keeps it', () => {
    start();
    fireEvent.click(cmd('solid.box'));
    expect(t.doc.calls).toContain('beginNew box');
    expect(panelTitle()).toBe('Box 1');
    expect(cmd('solid.box').className).toContain('is-active');
    // No tick in the head; Done and Delete in the foot.
    expect(ui.$('[data-cad-panel] .mat-panel-head')!.textContent).toBe('Box 1');
    expect(ui.$$('[data-cad-panel] .mat-panel-foot button').map((b) => b.textContent)).toEqual(['Delete', 'Done']);
    // Defaults, in the display unit.
    expect([field('size.0').value, field('size.1').value, field('size.2').value]).toEqual(['10', '20', '30']);
    expect(ui.$('[data-cad-panel] [data-field-row="op"]')).toBeNull();
    // The new box is already in the part (live), with its body and volume.
    expect(ui.history()).toEqual(['Box 1', '|']);
    expect(ui.$('[data-chip="volume"]')!.textContent).toBe('Volume6000 mm³');

    setField('size.0', '50');
    expect((features()[0] as BoxFeature).size).toEqual(['50 mm', '20 mm', '30 mm']);
    expect(ui.$('[data-chip="volume"] [data-volume-mm3]')!.getAttribute('data-volume-mm3')).toBe('30000');

    setField('size.1', 'abc');
    expect(fieldError('size.1')).toBe('Unknown parameter "abc"');
    setField('size.2', '-5');
    expect(fieldError('size.2')).toBe('Height must be more than 0');
    expect((features()[0] as BoxFeature).size).toEqual(['50 mm', '20 mm', '30 mm']);

    setField('origin.2', '1 in');
    expect((features()[0] as BoxFeature).origin[2]).toBe('1 in');
    expect(field('origin.2').value).toBe('25.4');

    fireEvent.click(ui.$('[data-panel-done]')!);
    expect(ui.$('[data-cad-panel]')).toBeNull();
    expect(t.doc.state.get().history.undoLabel).toBe('Box 1');
    expect(cmd('edit.undo').getAttribute('aria-disabled')).toBeNull();
    fireEvent.mouseEnter(cmd('edit.undo'));
    expect(ui.tip()).toBe('UndoCtrl+ZUndo Box 1');
    fireEvent.mouseLeave(cmd('edit.undo'));

    // Ctrl+Z removes the box; Ctrl+Y and Ctrl+Shift+Z bring it back.
    key('z', { ctrlKey: true });
    expect(features()).toHaveLength(0);
    expect(ui.$('[data-tree-empty="history"]')!.textContent).toBe('No features yet');
    key('y', { ctrlKey: true });
    expect(features()).toHaveLength(1);
    key('z', { ctrlKey: true });
    key('Z', { ctrlKey: true, shiftKey: true });
    expect(features()).toHaveLength(1);
  });

  it('selects the feature it edits while open and lets go on Done', () => {
    start();
    fireEvent.click(cmd('solid.box'));
    const id = features()[0].id;
    expect(t.services.selection.get().items).toEqual([{ kind: 'feature', feature: id }]);
    fireEvent.click(ui.$('[data-panel-done]')!);
    expect(t.services.selection.get().items).toEqual([]);
    // A selection the user made meanwhile stays.
    fireEvent.doubleClick(ui.row(id));
    const plane = { kind: 'origin' as const, ref: 'origin:top' as const };
    act(() => t.services.selection.set((s) => ({ ...s, items: [...s.items, plane] })));
    fireEvent.click(ui.$('[data-panel-done]')!);
    expect(t.services.selection.get().items).toEqual([{ kind: 'feature', feature: id }, plane]);
  });

  it('refuses field changes while another tab changed the part, and says why', () => {
    start();
    fireEvent.click(cmd('solid.box'));
    act(() => t.doc.setSave({ state: 'conflict', message: 'Changed in another tab' }));
    setField('size.0', '77');
    expect(fieldError('size.0')).toBe('Changed in another tab · Reload to keep editing');
    expect(field('size.0').value).toBe('77');
    expect((features()[0] as BoxFeature).size[0]).toBe('10 mm');
    expect(ui.$('[data-chip="save"]')!.textContent).toBe('Changed in another tabReload');
  });

  it('Delete on a new box discards it', () => {
    start();
    fireEvent.click(cmd('solid.box'));
    expect(features()).toHaveLength(1);
    fireEvent.click(ui.$('[data-panel-delete]')!);
    expect(t.doc.calls).toContain('discard');
    expect(features()).toHaveLength(0);
    expect(ui.$('[data-cad-panel]')).toBeNull();
    expect(t.doc.state.get().history.canUndo).toBe(false);
  });

  it('Delete on an existing box removes it (one undo step)', () => {
    start();
    const f = seed('box');
    fireEvent.doubleClick(ui.row(f.id));
    setField('size.0', '12');
    fireEvent.click(ui.$('[data-panel-delete]')!);
    expect(features()).toHaveLength(0);
    act(() => t.doc.undo());
    expect((features()[0] as BoxFeature).size[0]).toBe('10 mm');
  });

  it('Done is disabled with the reason while a new feature is incomplete', () => {
    // A type whose new feature starts incomplete (like an Extrude without a profile).
    start({ incompleteCylinder: true });
    fireEvent.click(cmd('solid.cylinder'));
    expect(panelTitle()).toBe('Cylinder 1');
    expect(features()).toHaveLength(0);
    expect(field('height').value).toBe('');
    expect(fieldError('height')).toBeNull();
    const done = ui.$('[data-panel-done]')!;
    expect(done.getAttribute('aria-disabled')).toBe('true');
    expect(ui.$('[data-cad-panel] [data-run-reason]')!.textContent).toBe('Height: Enter a value');
    fireEvent.mouseEnter(done);
    expect(ui.tip()).toBe('DoneHeight: Enter a value');
    fireEvent.mouseLeave(done);
    fireEvent.click(done);
    expect(ui.$('[data-cad-panel]')).not.toBeNull();
    // Filling it in applies it live and enables Done.
    setField('height', '15');
    expect(features()).toHaveLength(1);
    expect(ui.$('[data-panel-done]')!.getAttribute('aria-disabled')).toBeNull();
    expect(ui.$('[data-cad-panel] [data-run-reason]')).toBeNull();
    act(() => t.doc.undo());
  });

  it('Escape discards a new feature that is still incomplete', () => {
    start({ incompleteCylinder: true });
    fireEvent.click(cmd('solid.cylinder'));
    key('Escape');
    expect(ui.$('[data-cad-panel]')).toBeNull();
    expect(t.doc.calls).toContain('discard');
    expect(features()).toHaveLength(0);
  });

  it('renames from the title pencil, shows Operation once another body exists, and edits the axis', () => {
    start();
    seed('box');
    fireEvent.click(cmd('solid.cylinder'));
    expect(panelTitle()).toBe('Cylinder 1');
    const op = ui.$<HTMLSelectElement>('[data-cad-panel] select[data-field="op"]')!;
    expect([...op.options].map((o) => o.textContent)).toEqual(['New body', 'Join', 'Cut', 'Intersect']);
    fireEvent.change(op, { target: { value: 'cut' } });
    expect((features()[1] as CylinderFeature).op).toBe('cut');
    const axis = ui.$<HTMLSelectElement>('[data-cad-panel] select[data-field="axis"]')!;
    fireEvent.change(axis, { target: { value: 'origin:x' } });
    expect((features()[1] as CylinderFeature).axis).toBe('origin:x');

    fireEvent.click(ui.$('[data-cad-panel] [data-rename-btn]')!);
    const input = ui.$<HTMLInputElement>('[data-cad-panel] .mesh-rename-input')!;
    fireEvent.change(input, { target: { value: 'Box 1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ui.$('[data-cad-panel] .cad-rename-err')!.textContent).toBe('A feature named "Box 1" already exists');
    fireEvent.change(input, { target: { value: 'Pin' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(panelTitle()).toBe('Pin');
    expect(features()[1].name).toBe('Pin');
    expect(ui.history()).toEqual(['Box 1', 'Pin', '|']);
  });

  it('offers Operation only when a body is made before the feature in history; a stored Join keeps it so it can be set back (review round 3)', () => {
    start();
    const b1 = seed('box');
    let b2!: ReturnType<typeof t.doc.seed>;
    act(() => {
      b2 = t.doc.seed('box', { origin: ['20 mm', '0 mm', '0 mm'] } as never);
    });
    const opOf = () => ui.$<HTMLSelectElement>('[data-cad-panel] select[data-field="op"]');
    // Box 1 is first: no body before it, though Box 2 made one after it.
    act(() => t.services.bus.emit('ui:edit-feature', { feature: b1.id }));
    expect(panelTitle()).toBe('Box 1');
    expect(opOf()).toBeNull();
    // Box 2 has Box 1's body before it.
    act(() => t.services.bus.emit('ui:edit-feature', { feature: b2.id }));
    expect(panelTitle()).toBe('Box 2');
    expect(opOf()).not.toBeNull();
    fireEvent.click(ui.$('[data-panel-done]')!);
    cleanup();
    // A first feature stored as Join (nothing to join) still shows the row, so it can be set back to New body.
    start();
    let j!: ReturnType<typeof t.doc.seed>;
    act(() => {
      j = t.doc.seed('box', { op: 'join', creates: null } as never);
    });
    act(() => t.services.bus.emit('ui:edit-feature', { feature: j.id }));
    expect(opOf()!.value).toBe('join');
  });

  it('Ctrl+Z inside a panel cancels that panel only', () => {
    start();
    const f = seed('box');
    act(() => {
      t.doc.rename(f.id, 'Base');
    });
    fireEvent.doubleClick(ui.row(f.id));
    setField('size.0', '99');
    expect((features()[0] as BoxFeature).size[0]).toBe('99 mm');
    fireEvent.click(cmd('edit.undo'));
    expect(ui.$('[data-cad-panel]')).toBeNull();
    expect((features()[0] as BoxFeature).size[0]).toBe('10 mm');
    // The earlier rename is still there.
    expect(features()[0].name).toBe('Base');
  });

  it('shows a rebuild error in the foot with its fix', () => {
    start();
    const f = seed('box');
    act(() => t.doc.setStatus(f.id, { state: 'error', message: 'Box 1 failed: the result is not a valid solid', actions: ['repair'] }));
    fireEvent.doubleClick(ui.row(f.id));
    const reason = ui.$('[data-cad-panel] [data-run-reason]')!;
    expect(reason.textContent).toBe('Box 1 failed: the result is not a valid solidTry repair');
    fireEvent.click(reason.querySelector('[data-fix="Try repair"]')!);
    expect(t.doc.calls).toContain(`repair ${f.id}`);
  });

  it('opens from the viewport\'s double-click and context menu', () => {
    start();
    const f = seed('box');
    const body = t.doc.state.get().rebuild.bodies[0];
    const pick = { item: { kind: 'face' as const, body: body.id, index: 2 }, point: [0, 0, 0] as [number, number, number], normal: null, depth: 1, screen: [5, 5] as [number, number] };
    act(() => t.services.bus.emit('viewport:contextmenu', { pick, clientX: 50, clientY: 60 }));
    expect(ui.menu()).toEqual(['Hide Body 1', 'Rename Body 1', 'Edit Box 1', 'Rename Box 1', 'Suppress Box 1', '(Roll back to here)', 'Delete Box 1']);
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
    expect(panelTitle()).toBe('Box 1');
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
    expect(ui.$$('[data-cad-panel="params"] .mat-panel-foot button').map((b) => b.textContent)).toEqual(['Done']);
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
    fireEvent.change(ui.$('[data-param-row="width"] [data-param-unit]')!, { target: { value: 'angle' } });
    // Said once, by what the expression is (review round 1: no "is not a plain number: Expected a number without units").
    expect(ui.$('[data-param-error="width"]')!.textContent).toBe('80 mm is a length, not an angle');
    fireEvent.change(ui.$('[data-param-row="width"] [data-param-unit]')!, { target: { value: 'scalar' } });
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
      t.doc.seed('box', { size: ['len', '10 mm', '10 mm'] } as never);
    });
    fireEvent.click(ui.$('[data-param-row="len"] [data-param-delete]')!);
    // review round 3: the reason says it all (no "Delete failed:" before it).
    expect(ui.$('[data-param-error="len"]')!.textContent).toBe("len can't be deleted: Box 1 uses it");
    expect(values()).toEqual([['len', '40 mm']]);
  });
});

describe('status chips', () => {
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
    expect(chip('save')!.textContent).toBe('Changed in another tabReload');
    fireEvent.click(chip('save')!.querySelector('[data-chip-action="Reload"]')!);
    expect(t.doc.calls).toContain('reload');

    act(() => t.kernelStatus.set({ memory_high: true, heap_bytes: 1.5 * 1024 ** 3 }));
    expect(chip('memory')!.textContent).toBe('Large model · 1.5 GB memory');
    act(() => t.kernelStatus.set({ state: 'failed', message: 'The kernel failed to start: out of memory' }));
    expect(chip('memory')).toBeNull();
    expect(chip('kernel')!.textContent).toBe('The kernel failed to start: out of memoryRetry');

    // Volume: the shown bodies' total (said so), or the selected ones; unmeasured bodies offer Measure.
    act(() => {
      t.doc.seed('box');
      t.doc.seed('box');
    });
    expect(chip('volume')!.textContent).toBe('VolumeTotal of 2 bodies · 12,000 mm³');
    const b = t.doc.state.get().rebuild.bodies[1];
    act(() => t.services.selection.set({ items: [{ kind: 'body', body: b.id }] }));
    expect(chip('volume')!.textContent).toBe('VolumeBody 2 · 6000 mm³');
    // A hidden body is not counted, and the chip says the total is of the shown ones.
    act(() => t.services.selection.set({ items: [] }));
    const s0 = t.doc.state.get();
    act(() => (t.doc.state as unknown as { set(v: object): void }).set({ rebuild: { ...s0.rebuild, bodies: s0.rebuild.bodies.map((x, i) => (i === 1 ? { ...x, visible: false } : x)) } }));
    expect(chip('volume')!.textContent).toBe('VolumeTotal of 1 shown body · 6000 mm³');
  });

  it('offers Measure when a large body has no volume yet', async () => {
    start();
    act(() => {
      t.doc.seed('box');
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
