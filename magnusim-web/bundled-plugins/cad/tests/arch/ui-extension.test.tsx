// The UI shell's extension points for modules (docs/p2p3-plan.md §3.1, §3.8):
// a module's feature panel and tool panel in the flyout, its status chips, its
// context-menu items, the primary toolbar button, sketch mode's own Undo /
// Redo, and Delete on faces running "Delete faces" when a module has it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModuleRegistry } from '../../src/modules';
import { uiFor } from '../../src/ui/controller';
import { PanelChrome } from '../../src/ui/kit';
import type { CadModule, FeaturePanelProps, ToolPanelProps } from '../../src/types/modules';
import { makeServices, type TestServices } from '../ui/fake-doc';
import { mountUi } from '../ui/mount';

let t: TestServices;
let ui: ReturnType<typeof mountUi>;

afterEach(() => {
  cleanup();
  ui?.dispose();
});

function ToolPanel({ close }: ToolPanelProps) {
  return (
    <PanelChrome panel="tool" title="Measure" onDone={close}>
      <div data-fake-tool="1">Pick two things</div>
    </PanelChrome>
  );
}

function FakeExtrudePanel({ feature, isNew }: FeaturePanelProps) {
  return <div data-module-panel={feature} data-new={isNew ? '1' : '0'} />;
}

const ran: string[] = [];
const module: CadModule = {
  id: 'fake',
  panels: { extrude: FakeExtrudePanel },
  tools: [{ id: 'inspect.fake', label: 'Measure', panel: ToolPanel }],
  chips: [() => <span data-fake-chip="1">Under defined · 2 DOF</span>],
  contextMenu: (_s, pick) => (pick ? [] : [{ id: 'hello', label: 'Fake item', run: () => ran.push('menu') }]),
};

function start() {
  t = makeServices({});
  t.services.modules = createModuleRegistry([module]);
  ui = mountUi(t);
}

describe('module extension points in the UI shell', () => {
  it("renders a module's tool panel, chips and context-menu items", () => {
    start();
    act(() => uiFor(t.services).openTool('inspect.fake'));
    expect(ui.$('[data-fake-tool]')?.textContent).toBe('Pick two things');
    act(() => void fireEvent.click(ui.$('[data-panel-done]')!));
    expect(ui.$('[data-fake-tool]')).toBeNull();
    expect(ui.$('[data-fake-chip]')?.textContent).toBe('Under defined · 2 DOF');
    act(() => t.services.bus.emit('viewport:contextmenu', { pick: null, clientX: 10, clientY: 10 }));
    expect(ui.menu()).toContain('Fake item');
    act(() => void fireEvent.click(ui.menuItem('fake:hello')));
    expect(ran).toEqual(['menu']);
  });

  it("opens a module's panel for its feature type instead of the shell's", () => {
    start();
    act(() => uiFor(t.services).openNew('extrude'));
    const p = ui.$('[data-module-panel]');
    expect(p?.getAttribute('data-new')).toBe('1');
    expect(ui.$('[data-feature-panel]')).toBeNull();
  });

  it('shows the primary command and sketch Undo / Redo only in sketch mode', () => {
    start();
    const undo = vi.fn();
    act(() => {
      t.services.commands.register({ id: 'sketch.line', label: 'Line', group: 'draw', mode: 'sketch', icon: 'M0 0', run() {} });
      t.services.commands.register({ id: 'sketch.finish', label: 'Finish sketch', group: 'draw', mode: 'sketch', icon: 'M0 0', primary: true, run() {} });
      t.services.commands.register({ id: 'sketch.undo', label: 'Undo', mode: 'sketch', icon: 'M0 0', shortcut: 'Ctrl+Z', run: undo });
    });
    expect(ui.$('[data-command="sketch.finish"]')).toBeNull();
    act(() => t.services.mode.set({ mode: 'sketch' }));
    expect(ui.$('[data-cad-toolbar="sketch"] [data-group="primary"] [data-command="sketch.finish"]')?.className).toContain('is-primary');
    expect(ui.$$('[data-group="edit"] [data-command]').map((b) => b.getAttribute('data-command'))).toEqual(['sketch.undo']);
    expect(ui.$('[data-command="edit.undo"]')).toBeNull();
  });

  it('Delete with only faces selected runs "Delete faces" when a module registered it', async () => {
    start();
    const run = vi.fn();
    act(() => {
      t.services.commands.register({ id: 'modify.delete-faces', label: 'Delete faces', run });
      t.services.selection.set({ items: [{ kind: 'face', body: 'b_1', index: 2 }] });
    });
    act(() => void fireEvent.keyDown(document.body, { key: 'Delete' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
