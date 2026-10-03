// The app's services over the REAL DocService and a given kernel (the hybrid
// real kernel, or a scripted one), with the P2 modules installed, the UI shell
// mounted (toolbar, tree + flyout, dock, menus) and a scripted viewport handle
// whose pick() answers what a test says is under the pointer. Tests click in
// the "viewport" through the tools P2 panels push.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, render } from '@testing-library/react';
import { Group } from 'three';
import { vi } from 'vitest';
import { createCommandRegistry } from '../../../src/app/commands';
import { bindCommandShortcuts, createKeyboard } from '../../../src/app/keyboard';
import { createDocService } from '../../../src/doc';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createSelectionStore } from '../../../src/lib/selection';
import { ServicesProvider } from '../../../src/lib/services';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices, AreaApis } from '../../../src/types/app';
import type { Mode } from '../../../src/types/commands';
import type { Vec3 } from '../../../src/types/doc';
import type { CadEvents } from '../../../src/types/events';
import type { KernelAdapter } from '../../../src/types/kernel';
import type { CadModule, ModuleRegistry } from '../../../src/types/modules';
import type { PickResult, SelectionItem } from '../../../src/types/selection';
import type { OverlayLayer, ViewportHandle, ViewportPointer, ViewportTool } from '../../../src/types/viewport';
import { LeftStack, Overlays, StatusDock, Toolbar } from '../../../src/ui';
import { installUi } from '../../../src/ui/commands';
import { tipTiming } from '../../../src/ui/kit';
import importModule from '../../../src/features/import';
import deleteFacesModule from '../../../src/features/delete_faces';
import pressPullModule from '../../../src/features/press_pull';
import splitModule from '../../../src/features/split';
import combineModule from '../../../src/features/combine';
import measureModule from '../../../src/features/measure';
import massModule from '../../../src/features/mass';
import checkModule from '../../../src/features/check';
import exportModule from '../../../src/features/export';
import { FakeFolder } from '../../doc/fake-files';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
tipTiming.hoverDelayMs = 0;

/**
 * The module registry over a fixed list (src/modules.ts does the same over every
 * module in the tree; importing it would pull other areas' modules into these tests).
 */
function registryOf(modules: readonly CadModule[]): ModuleRegistry {
  return {
    all: () => modules,
    panelFor: (type) => modules.map((m) => m.panels?.[type]).find(Boolean) ?? null,
    tool: (id) => modules.flatMap((m) => m.tools ?? []).find((t) => t.id === id) ?? null,
  };
}

export const P2_MODULES: CadModule[] = [checkModule, combineModule, deleteFacesModule, exportModule, importModule, massModule, measureModule, pressPullModule, splitModule];

export interface FakeView {
  handle: ViewportHandle;
  tools: ViewportTool[];
  layers: Map<string, OverlayLayer>;
  /** What pick() answers next (by click position, or always). */
  under: PickResult | null;
  /** Faces planeNormal() calls flat ("<body>:<index>"), all when null. */
  flat: Set<string> | null;
  /** A left click (no drag) in the viewport with `item` under the pointer: offered to the tools as the viewport does. Returns whether a tool took it. */
  click(item: SelectionItem | null, opts?: { ctrl?: boolean }): boolean;
}

export function fakeView(): FakeView {
  const tools: ViewportTool[] = [];
  const layers = new Map<string, OverlayLayer>();
  const v: FakeView = {
    tools,
    layers,
    under: null,
    flat: null,
    handle: null as unknown as ViewportHandle,
    click(item, opts = {}) {
      v.under = item ? { item, point: [0, 0, 0], normal: null, depth: 1, screen: [10, 10] } : null;
      const e: ViewportPointer = { type: 'click', button: 0, buttons: 0, clientX: 10, clientY: 10, ctrl: !!opts.ctrl, shift: false, alt: false, ray: { origin: [0, 0, 100], dir: [0, 0, -1] }, native: new MouseEvent('click') };
      let used = false;
      act(() => {
        for (let i = tools.length - 1; i >= 0 && !used; i--) used = tools[i].onPointer(e);
      });
      return used;
    },
  };
  const state = createStateStore({ ready: true, planes: 'auto' as const, bodies: 0 });
  v.handle = {
    state,
    flash: () => {},
    highlight: () => {},
    lookAt: () => {},
    reframe: () => false,
    setPlanes: () => {},
    setPlanesBusy: () => {},
    setPlanesWanted: () => {},
    setFilter: () => {},
    planeNormal: (it: SelectionItem) => (it.kind === 'origin' || (it.kind === 'face' && (!v.flat || v.flat.has(`${it.body}:${it.index}`))) ? ([0, 0, 1] as Vec3) : null),
    pick: () => v.under,
    project: (p: Vec3) => [500 + p[0], 500 - p[1]] as [number, number],
    pixelSize: () => 1,
    onFrame: () => () => {},
    lineResolution: () => [1000, 1000] as [number, number],
    addLayer(id: string) {
      const html = document.createElement('div');
      document.body.appendChild(html);
      const layer: OverlayLayer = { id, group: new Group(), html, setVisible: () => {}, changed: () => {}, dispose: () => html.remove() };
      layers.set(id, layer);
      return layer;
    },
    pushTool(t: ViewportTool) {
      tools.push(t);
      return () => {
        const i = tools.indexOf(t);
        if (i >= 0) tools.splice(i, 1);
      };
    },
  } as unknown as ViewportHandle;
  return v;
}

export interface TestApp {
  services: AppServices;
  view: FakeView;
  folder: FakeFolder;
  $<E extends Element = HTMLElement>(sel: string): E | null;
  $$<E extends Element = HTMLElement>(sel: string): E[];
  /** Run a command as the toolbar does. */
  run(id: string): Promise<true | string>;
  dispose(): void;
}

export function mountApp(kernel: KernelAdapter, opts: { folder?: FakeFolder; modules?: CadModule[] } = {}): TestApp {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ');
    // The real kernel answers asynchronously, outside act(): React says so, and that is not a fault of the page.
    if (text.includes('not wrapped in act(')) return;
    errors.push(text);
  });
  const folder = opts.folder ?? new FakeFolder();
  const ws = createFakeWorkspace({ hostVersion: '1.2', folder });
  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const doc = createDocService({ bridge, kernel, bus, saveIntervalMs: 10, log: () => {} });
  const modules = opts.modules ?? P2_MODULES;
  for (const m of modules) for (const def of m.features ?? []) doc.features.register(def);
  const view = fakeView();
  let services: AppServices | null = null;
  const commands = createCommandRegistry(() => services!);
  const keyboard = createKeyboard(document);
  services = {
    bridge,
    bus,
    commands,
    keyboard,
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: view.handle }),
    modules: registryOf(modules),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  const s = services;
  const offUi = installUi(s);
  const offs = modules.map((m) => m.install?.(s) ?? (() => {}));
  const offModules = () => {
    for (const off of offs.reverse()) off();
  };
  const offKeys = bindCommandShortcuts(commands, keyboard, undefined, () => s.mode.get().mode);
  const r = render(
    <ServicesProvider services={s}>
      <div className="cad-app">
        <Toolbar />
        <div className="cad-stage">
          <LeftStack />
          <StatusDock />
          <Overlays />
        </div>
      </div>
    </ServicesProvider>,
  );
  return {
    services: s,
    view,
    folder,
    $: (sel) => r.container.querySelector(sel),
    $$: (sel) => [...r.container.querySelectorAll(sel)] as never,
    run: (id) => commands.run(id),
    dispose() {
      r.unmount();
      offKeys();
      offModules();
      offUi();
      doc.dispose();
      keyboard.dispose();
      spy.mockRestore();
      if (errors.length) throw new Error('console errors: ' + errors.join(' | ').slice(0, 800));
    },
  };
}
