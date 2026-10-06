// The viewport's wiring (bodies from the document, selection both ways, bus
// events, vertex positions from the kernel for small bodies), its commands
// (F, 1-7, N with honest reasons) and its chrome (filter chips, views menu,
// section toggle, Fit): every control calls what it says.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/lib/bus';
import { createSelectionStore } from '../../src/lib/selection';
import { ServicesProvider } from '../../src/lib/services';
import { createStateStore } from '../../src/lib/store';
import { createCommandRegistry } from '../../src/app/commands';
import type { AppServices } from '../../src/types/app';
import type { CadEvents } from '../../src/types/events';
import type { BodyInfo, TessPayload } from '../../src/types/kernel';
import type { PickResult, SelectionItem } from '../../src/types/selection';
import type { SavedCamera } from '../../src/types/doc';
import type { ViewportBody, ViewportHandle, ViewportPickEvent, ViewportState } from '../../src/types/viewport';
import { bindViewport } from '../../src/viewport/bind';
import { normalToTarget, viewportCommands } from '../../src/viewport/commands';
import { ViewportChrome } from '../../src/viewport/ViewportChrome';
import { DEFAULT_SECTION } from '../../src/viewport/section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tess(): TessPayload {
  return { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), faceRanges: new Uint32Array([0, 3]), edgePositions: new Float32Array(0), edgeRanges: new Uint32Array(0) };
}

function bodyInfo(id: string, shape = 7, key = 'k1'): BodyInfo {
  return { id, name: id, color: '#bdc9db', feature: 'f_1', shape, faces: 6, valid: true, edges: 12, bbox: [0, 0, 0, 1, 1, 1], volume: null, visible: true, tessKey: key, tess: tess() } as BodyInfo;
}

function fakeHandle() {
  const calls: { setBodies: ViewportBody[][]; highlight: SelectionItem[][]; filter: string[][]; vertices: [string, string, number][]; views: string[]; section: unknown[]; lookAt: unknown[]; projection: string[]; display: string[] } = {
    setBodies: [],
    highlight: [],
    filter: [],
    vertices: [],
    views: [],
    section: [],
    lookAt: [],
    projection: [],
    display: [],
  };
  const listeners = new Set<(e: ViewportPickEvent) => void>();
  const cameraListeners = new Set<(c: SavedCamera) => void>();
  const placed: SavedCamera[] = [];
  const state = createStateStore<ViewportState>({ ready: true, display: 'shaded-edges', projection: 'perspective', hover: null, triangles: 0, bodies: 0, section: { ...DEFAULT_SECTION }, planes: 'auto', bvhPending: 0, animating: false });
  let planar = true;
  const h = {
    state,
    setBodies: (b: ViewportBody[]) => calls.setBodies.push(b),
    setVisibility: () => {},
    setVertices: (id: string, key: string, v: Float32Array) => calls.vertices.push([id, key, v.length]),
    highlight: (items: SelectionItem[]) => calls.highlight.push(items),
    flash: () => {},
    setFilter: (k: string[]) => calls.filter.push(k),
    onPick: (fn: (e: ViewportPickEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fit: () => calls.views.push('fit'),
    setView: (v: string) => calls.views.push(v),
    lookAt: (n: unknown, u: unknown) => calls.lookAt.push([n, u]),
    setDisplay: (d: 'shaded') => {
      calls.display.push(d);
      state.set({ display: d });
    },
    setProjection: (p: 'orthographic') => {
      calls.projection.push(p);
      state.set({ projection: p });
    },
    setSection: (p: object) => {
      calls.section.push(p);
      state.set({ section: { ...state.get().section, ...p } });
    },
    setPlanes: (m: 'always') => state.set({ planes: m }),
    sectionRange: () => [0, 20] as [number, number],
    pick: () => null,
    project: () => null,
    planeNormal: (it: SelectionItem) => (planar && (it.kind === 'face' || it.kind === 'origin') ? ([0, 0, 1] as [number, number, number]) : null),
    stats: () => ({}) as never,
    measure: () => ({ msPerFrame: 0, frames: 0 }),
    camera: () => CAM,
    setCamera: (c: SavedCamera) => placed.push(c),
    onCameraChange: (fn: (c: SavedCamera) => void) => {
      cameraListeners.add(fn);
      return () => cameraListeners.delete(fn);
    },
    dispose: () => {},
  } as unknown as ViewportHandle;
  const moveCamera = (c: SavedCamera) => {
    for (const fn of cameraListeners) fn(c);
  };
  const fire = (e: Partial<ViewportPickEvent> & { type: ViewportPickEvent['type'] }) => {
    for (const fn of listeners) fn({ pick: null, additive: false, clientX: 1, clientY: 2, ...e });
  };
  return { h, calls, fire, setPlanar: (v: boolean) => (planar = v), placed, moveCamera };
}

const CAM: SavedCamera = { position: [10, -50, 30], target: [5, 5, 5], up: [0, 0, 1], orthoHeight: 40, projection: 'perspective' };

function fakeServices(handle: ViewportHandle | null) {
  const rebuild = { status: 'idle', seq: 0, features: {}, bodies: [] as BodyInfo[], ms: null, message: null };
  const docState = createStateStore({ status: 'ready', rebuild, view: { rollback: null, hiddenBodies: [], expanded: [] } } as unknown as ReturnType<AppServices['doc']['state']['get']>);
  const topoCalls: unknown[] = [];
  const kernel = {
    call: vi.fn(async (op: string, params: { id: number }) => {
      topoCalls.push(params);
      if (op !== 'topo') throw new Error('unexpected op');
      return { result: { faces: [], edges: [], vertices: [{ i: 0, p: [0, 0, 0] }, { i: 1, p: [1, 2, 3] }] }, buffers: {}, ms: 1, wall_ms: 1, heap_bytes: 0 };
    }),
  };
  const bus = createBus<CadEvents>();
  let services: AppServices;
  const commands = createCommandRegistry(() => services);
  services = {
    doc: { state: docState },
    selection: createSelectionStore(),
    bus,
    kernel,
    commands,
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle }),
  } as unknown as AppServices;
  const setBodies = (bodies: BodyInfo[]) => docState.set((s) => ({ ...s, rebuild: { ...s.rebuild, bodies } }) as typeof s);
  return { services, setBodies, topoCalls, bus };
}

const pick = (item: SelectionItem): PickResult => ({ item, point: [0, 0, 0], normal: null, depth: 1, screen: [0, 0] });

describe('bindViewport', () => {
  it('each Part keeps how it was viewed: planes mode and camera come back when it opens, and changes are kept (review round 3)', () => {
    const { h, placed, moveCamera } = fakeHandle();
    const calls: string[] = [];
    const rebuild = { status: 'idle', seq: 0, features: {}, bodies: [] as BodyInfo[], ms: null, message: null };
    const docState = createStateStore({ status: 'loading', rebuild, view: { rollback: null, hiddenBodies: [], expanded: [] } } as unknown as ReturnType<AppServices['doc']['state']['get']>);
    const doc = {
      state: docState,
      setPlanes: (m: string) => calls.push(`planes ${m}`),
      setCamera: (c: SavedCamera) => calls.push(`camera ${c.position.join(',')}`),
    };
    const services = { doc, selection: createSelectionStore(), bus: createBus<CadEvents>(), kernel: { call: vi.fn() }, viewport: createStateStore({ handle: h }) } as unknown as AppServices;
    const off = bindViewport(h, services);
    // Read: planes at once, the camera only once the first rebuild is drawn (over the first bodies' framing).
    docState.set((s) => ({ ...s, status: 'ready', view: { ...s.view, planes: 'always', camera: CAM } }) as typeof s);
    expect(h.state.get().planes).toBe('always');
    expect(placed).toEqual([]);
    docState.set((s) => ({ ...s, rebuild: { ...s.rebuild, status: 'done', seq: 1 } }) as typeof s);
    expect(placed).toEqual([CAM]);
    // Putting them back is not a change of the user's: nothing written.
    expect(calls).toEqual([]);
    // The user's changes are kept with the Part.
    h.setPlanes('auto');
    moveCamera({ ...CAM, position: [1, 2, 3] });
    expect(calls).toEqual(['planes auto', 'camera 1,2,3']);
    // A later rebuild does not move the camera again.
    docState.set((s) => ({ ...s, rebuild: { ...s.rebuild, seq: 2 } }) as typeof s);
    expect(placed).toHaveLength(1);
    off();
  });

  it('draws the rebuilt bodies and asks the kernel for their vertices (vertices only)', async () => {
    const { h, calls } = fakeHandle();
    const { services, setBodies, topoCalls } = fakeServices(h);
    const off = bindViewport(h, services);
    expect(calls.setBodies).toEqual([[]]);
    setBodies([bodyInfo('b_1'), bodyInfo('b_2', 8), { ...bodyInfo('b_3', 9), tess: null }]);
    expect(calls.setBodies[1].map((b) => b.id)).toEqual(['b_1', 'b_2']);
    expect(calls.setBodies[1][0]).toMatchObject({ id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', feature: 'f_1', vertices: null });
    await vi.waitFor(() => expect(calls.vertices).toEqual([['b_1', 'k1', 6], ['b_2', 'k1', 6]]));
    expect(topoCalls).toEqual([
      { id: 7, faces: 'none', edges: 'none', vertices: 'all' },
      { id: 8, faces: 'none', edges: 'none', vertices: 'all' },
    ]);
    // The next rebuild carries the vertices it already has; a new tessellation asks again.
    setBodies([bodyInfo('b_1'), bodyInfo('b_2', 10, 'k2')]);
    expect(calls.setBodies[2][0].vertices?.length).toBe(6);
    expect(calls.setBodies[2][1].vertices).toBeNull();
    await vi.waitFor(() => expect(topoCalls).toHaveLength(3));
    off();
  });

  it('a body that comes back with an earlier tessellation (an Undo) is asked for its vertices again (P4a review)', async () => {
    const { h, calls } = fakeHandle();
    const { services, setBodies, topoCalls } = fakeServices(h);
    const off = bindViewport(h, services);
    setBodies([bodyInfo('b_1', 7, 'k1')]);
    await vi.waitFor(() => expect(calls.vertices).toEqual([['b_1', 'k1', 6]]));
    // An edit: a new tessellation; then Undo: the first one again, under a new shape id.
    setBodies([bodyInfo('b_1', 8, 'k2')]);
    await vi.waitFor(() => expect(calls.vertices).toHaveLength(2));
    setBodies([bodyInfo('b_1', 9, 'k1')]);
    await vi.waitFor(() => expect(calls.vertices).toEqual([['b_1', 'k1', 6], ['b_1', 'k2', 6], ['b_1', 'k1', 6]]));
    expect((topoCalls as { id: number }[]).map((c) => c.id)).toEqual([7, 8, 9]);
    expect(calls.setBodies.at(-1)![0].vertices).toBeNull();
    off();
  });

  it('writes picks into the selection and reads it back as highlight and filter', () => {
    const { h, calls, fire } = fakeHandle();
    const { services, bus } = fakeServices(h);
    const events: string[] = [];
    bus.on('viewport:contextmenu', (e) => events.push(`menu:${e.pick?.item.kind ?? 'none'}`));
    bus.on('viewport:dblclick', (e) => events.push(`dbl:${e.pick.item.kind}`));
    bindViewport(h, services);
    const f1: SelectionItem = { kind: 'face', body: 'b_1', index: 1 };
    const f2: SelectionItem = { kind: 'face', body: 'b_1', index: 2 };
    fire({ type: 'click', pick: pick(f1) });
    expect(services.selection.get().items).toEqual([f1]);
    expect(calls.highlight.at(-1)).toEqual([f1]);
    fire({ type: 'click', pick: pick(f2), additive: true });
    expect(services.selection.get().items).toEqual([f1, f2]);
    fire({ type: 'click', pick: pick(f1), additive: true });
    expect(services.selection.get().items).toEqual([f2]);
    // Ctrl+click on empty space keeps the selection; a plain click clears it.
    fire({ type: 'click', pick: null, additive: true });
    expect(services.selection.get().items).toEqual([f2]);
    fire({ type: 'click', pick: null });
    expect(services.selection.get().items).toEqual([]);
    // Right-click selects what is under the pointer, then opens the menu.
    fire({ type: 'contextmenu', pick: pick(f1) });
    expect(services.selection.get().items).toEqual([f1]);
    fire({ type: 'dblclick', pick: pick(f1) });
    expect(events).toEqual(['menu:face', 'dbl:face']);
    services.selection.set({ filter: ['edge'] });
    expect(calls.filter.at(-1)).toEqual(['edge']);
  });
});

describe('viewport commands', () => {
  it('registers Fit (F), the standard views (1-7) and Normal to (N)', () => {
    const cmds = viewportCommands();
    expect(cmds.map((c) => `${c.id}=${c.shortcut}`)).toEqual([
      'view.fit=F',
      'view.front=1',
      'view.back=2',
      'view.left=3',
      'view.right=4',
      'view.top=5',
      'view.bottom=6',
      'view.iso=7',
      'view.normal-to=N',
    ]);
    expect(cmds.every((c) => !c.group)).toBe(true);
  });

  it('runs on the viewport and says why when it cannot', async () => {
    const { h, calls, setPlanar } = fakeHandle();
    const { services } = fakeServices(h);
    for (const c of viewportCommands()) services.commands.register(c);
    await services.commands.run('view.fit');
    await services.commands.run('view.top');
    expect(calls.views).toEqual(['fit', 'top']);
    expect(await services.commands.run('view.normal-to')).toBe('Select a planar face or a plane to look at it straight on');
    services.selection.set({ items: [{ kind: 'origin', ref: 'origin:top' }] });
    expect(await services.commands.run('view.normal-to')).toBe(true);
    expect(calls.lookAt).toEqual([[[0, 0, 1], [0, 1, 0]]]);
    setPlanar(false);
    services.selection.set({ items: [{ kind: 'face', body: 'b', index: 0 }] });
    expect('reason' in normalToTarget(services.selection.get(), h)).toBe(true);
    services.viewport.set({ handle: null });
    expect(await services.commands.run('view.fit')).toBe('The viewport is not ready');
  });
});

describe('viewport chrome', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  function mount() {
    const f = fakeHandle();
    const s = fakeServices(f.h);
    const el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
    act(() =>
      root!.render(
        <ServicesProvider services={s.services}>
          <ViewportChrome handle={f.h} />
        </ServicesProvider>,
      ),
    );
    const click = (sel: string) => act(() => (el.querySelector(sel) as HTMLElement).click());
    return { ...f, ...s, el, click };
  }

  it('Fit, the views menu, projection and display call the viewport', () => {
    const { el, calls, click } = mount();
    expect(el.querySelector('[data-triad-slot]')).not.toBeNull();
    expect([...el.querySelectorAll('.cad-vp-axes-key .ax')].map((e) => e.textContent)).toEqual(['X', 'Y', 'Z']);
    click('[data-vp-fit]');
    expect(calls.views).toEqual(['home']);
    click('[data-vp-opens="views"]');
    expect([...el.querySelectorAll('[data-view]')].map((b) => b.textContent)).toEqual(['Front1', 'Back2', 'Left3', 'Right4', 'Top5', 'Bottom6', 'Isometric7', 'Normal toN']);
    // Normal to is disabled with its reason while nothing planar is selected.
    const nt = el.querySelector('[data-view="normal-to"]') as HTMLButtonElement;
    expect(nt.disabled).toBe(true);
    expect(nt.title).toMatch(/Select a planar face or a plane/);
    click('[data-view="top"]');
    expect(calls.views).toEqual(['home', 'top']);
    expect(el.querySelector('[data-vp-pop="views"]')).toBeNull();
    click('[data-vp-opens="views"]');
    click('[data-vp-seg="Projection"] [data-value="orthographic"]');
    expect(calls.projection).toEqual(['orthographic']);
    expect(el.querySelector('[data-vp-seg="Projection"] [data-value="orthographic"]')!.getAttribute('aria-checked')).toBe('true');
    click('[data-vp-seg="Display"] [data-value="wireframe"]');
    expect(calls.display).toEqual(['wireframe']);
  });

  it('the filter chips set the selection filter; Pick anything clears it', () => {
    const { el, services, click } = mount();
    click('[data-vp-opens="filter"]');
    click('[data-filter="edge"]');
    click('[data-filter="face"]');
    expect(services.selection.get().filter).toEqual(['face', 'edge']);
    expect(el.querySelector('[data-vp-opens="filter"]')!.className).toMatch(/is-on/);
    click('[data-filter="edge"]');
    expect(services.selection.get().filter).toEqual(['face']);
    click('[data-filter-clear]');
    expect(services.selection.get().filter).toEqual([]);
  });

  it('the section button turns the cut on at the middle of the bodies, and off again', () => {
    const { el, calls, click } = mount();
    click('[data-vp-opens="section"]');
    expect(calls.section[0]).toEqual({ on: true, plane: 'origin:front', offset: 10 });
    expect(el.querySelector('[data-vp-pop="section"]')).not.toBeNull();
    // Shown as the coordinate the cut fixes: the Front plane's normal is -Y, so offset 10 is y = -10.
    expect(el.querySelector('[data-section-value]')!.textContent).toBe('Y -10 mm');
    click('[data-vp-seg="Section plane"] [data-value="origin:top"]');
    expect(calls.section[1]).toEqual({ plane: 'origin:top', offset: 10 });
    click('[data-section-flip]');
    expect(calls.section[2]).toEqual({ flip: true });
    click('[data-vp-opens="section"]');
    expect(calls.section[3]).toEqual({ on: false });
    expect(el.querySelector('[data-vp-pop="section"]')).toBeNull();
  });
});
