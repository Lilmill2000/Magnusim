// The app's services over the REAL DocService (tests/features/sketch/
// fake-profiles-kernel.ts behind it), with the sketch and extrude modules
// installed, the UI shell mounted (toolbar, tree + flyout, dock, menus) and a
// scripted viewport handle: layers, tools, a straight top or front view for
// project() and rays, pixelSize. Tests drive the viewport tools with pointer
// events built from model points.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, render } from '@testing-library/react';
import { Group } from 'three';
import { vi } from 'vitest';
import { createCommandRegistry } from '../../../src/app/commands';
import { bindCommandShortcuts, createKeyboard } from '../../../src/app/keyboard';
import { createDocService } from '../../../src/doc';
import extrudeModule from '../../../src/features/extrude';
import sketchModule from '../../../src/features/sketch';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createSelectionStore } from '../../../src/lib/selection';
import { ServicesProvider } from '../../../src/lib/services';
import { createStateStore } from '../../../src/lib/store';
import { createModuleRegistry, installModules, registerModuleFeatures } from '../../../src/modules';
import type { AppServices, AreaApis } from '../../../src/types/app';
import type { Mode } from '../../../src/types/commands';
import type { CadModule } from '../../../src/types/modules';
import type { Vec3 } from '../../../src/types/doc';
import type { DocService } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { OverlayLayer, ViewportHandle, ViewportPointer, ViewportTool } from '../../../src/types/viewport';
import { LeftStack, Overlays, StatusDock, Toolbar } from '../../../src/ui';
import { installUi } from '../../../src/ui/commands';
import { tipTiming } from '../../../src/ui/kit';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { ProfilesFakeKernel } from '../sketch/fake-profiles-kernel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
tipTiming.hoverDelayMs = 0;

/** 2 CSS px per mm; top view: x right, y up; front view: x right, z up. */
const PX_PER_MM = 2;

export interface FakeViewport {
  handle: ViewportHandle;
  tools: ViewportTool[];
  layers: Map<string, OverlayLayer>;
  view: 'top' | 'front';
  /** Who asked the origin planes to stay hidden (setPlanesBusy). */
  planesBusy: Set<string>;
  /** A pointer event at a model point as the view sees it (its ray goes through it). */
  at(type: ViewportPointer['type'], p: Vec3, extra?: Partial<ViewportPointer>): ViewportPointer;
  /** Offer an event to the tools, newest first, as the viewport does; true when one took it. */
  offer(e: ViewportPointer): boolean;
}

export function fakeViewport(): FakeViewport {
  const tools: ViewportTool[] = [];
  const layers = new Map<string, OverlayLayer>();
  const frames = new Set<() => void>();
  const fv: FakeViewport = {
    tools,
    layers,
    view: 'top',
    planesBusy: new Set(),
    handle: null as unknown as ViewportHandle,
    at(type, p, extra = {}) {
      const [x, y] = fv.handle.project(p)!;
      const ray = fv.view === 'top' ? { origin: [p[0], p[1], 1000] as Vec3, dir: [0, 0, -1] as Vec3 } : { origin: [p[0], -1000, p[2]] as Vec3, dir: [0, 1, 0] as Vec3 };
      return { type, button: 0, buttons: 0, clientX: x, clientY: y, ctrl: false, shift: false, alt: false, ray, native: new MouseEvent('pointerdown'), ...extra };
    },
    offer(e) {
      for (let i = tools.length - 1; i >= 0; i--) if (tools[i].onPointer(e)) return true;
      return false;
    },
  };
  const state = createStateStore({ ready: true, planes: 'auto' as const, bodies: 0 });
  fv.handle = {
    state,
    flash: () => {},
    highlight: () => {},
    lookAt: () => {},
    reframe: () => false,
    setPlanes: () => {},
    setPlanesBusy: (owner: string, busy: boolean) => void (busy ? fv.planesBusy.add(owner) : fv.planesBusy.delete(owner)),
    setPlanesWanted: () => {},
    planeNormal: () => null,
    pick: () => null,
    project: (p: Vec3) => (fv.view === 'top' ? [500 + p[0] * PX_PER_MM, 500 - p[1] * PX_PER_MM] : [500 + p[0] * PX_PER_MM, 500 - p[2] * PX_PER_MM]) as [number, number],
    pixelSize: () => 1 / PX_PER_MM,
    onFrame: (fn: () => void) => {
      frames.add(fn);
      return () => frames.delete(fn);
    },
    addLayer(id: string) {
      const html = document.createElement('div');
      document.body.appendChild(html);
      const layer: OverlayLayer = { id, group: new Group(), html, setVisible() {}, changed() {}, dispose: () => (html.remove(), layers.delete(id)) };
      layers.set(id, layer);
      return layer;
    },
    pushTool(tool: ViewportTool) {
      tools.push(tool);
      return () => {
        const i = tools.indexOf(tool);
        if (i >= 0) tools.splice(i, 1);
      };
    },
  } as unknown as ViewportHandle;
  return fv;
}

export interface FakeApp {
  services: AppServices;
  ws: ReturnType<typeof createFakeWorkspace>;
  doc: DocService;
  kernel: ProfilesFakeKernel;
  vp: FakeViewport;
  $<E extends Element = HTMLElement>(sel: string): E | null;
  $$<E extends Element = HTMLElement>(sel: string): E[];
  /** Wait for the rebuild to settle (every feature built or failed). */
  settle(): Promise<void>;
  dispose(): void;
}

export async function startApp(opts: { units?: 'metric' | 'imperial'; modules?: CadModule[] } = {}): Promise<FakeApp> {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
  const ws = createFakeWorkspace({ units: opts.units ?? 'metric' });
  const kernel = new ProfilesFakeKernel();
  const bus = createBus<CadEvents>();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus, saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  // More modules (the Enclosure's tests add theirs) after the two this app always has.
  const modules = [extrudeModule, sketchModule, ...(opts.modules ?? [])];
  registerModuleFeatures(doc.features, modules);
  const vp = fakeViewport();
  let services: AppServices | null = null;
  const commands = createCommandRegistry(() => services!);
  const keyboard = createKeyboard(document);
  services = {
    bridge: createBridge(ws),
    bus,
    commands,
    keyboard,
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: vp.handle }),
    modules: createModuleRegistry(modules),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  const offUi = installUi(services);
  const offModules = installModules(services, modules);
  const unbind = bindCommandShortcuts(commands, keyboard, undefined, () => services!.mode.get().mode);
  await act(async () => {
    await doc.load();
  });
  const view = render(
    <ServicesProvider services={services}>
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
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 2));
      });
      const s = doc.state.get();
      if (s.rebuild.status === 'done' && s.doc.features.every((f) => s.rebuild.features[f.id] && s.rebuild.features[f.id].state !== 'pending')) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 2));
        });
        if (doc.state.get().rebuild.status === 'done') return;
      }
    }
    throw new Error('the rebuild did not settle');
  };
  return {
    services,
    ws,
    doc,
    kernel,
    vp,
    $: <E extends Element = HTMLElement>(sel: string) => view.container.querySelector<E>(sel),
    $$: <E extends Element = HTMLElement>(sel: string) => [...view.container.querySelectorAll<E>(sel)],
    settle,
    dispose() {
      view.unmount();
      unbind();
      offModules();
      offUi();
      keyboard.dispose();
      doc.dispose();
      spy.mockRestore();
      if (errors.length) throw new Error('console errors: ' + errors.join(' | ').slice(0, 800));
    },
  };
}
