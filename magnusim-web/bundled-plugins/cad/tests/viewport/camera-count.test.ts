// The viewport counts the person's camera moves and not the app's own (userCameraMoves, for the
// Assistant's camera latch), and its snapshot draws off screen and puts everything back. The real
// viewport (src/viewport/viewport.ts) on a stand-in for three's WebGLRenderer (jsdom has no WebGL):
//   - every handle camera call without `auto` that moves the camera counts once: Fit, a standard
//     view, Normal to (F, 1-7, N and a menu's Normal to all call these), Orbit around, a camera
//     put back by hand, a reframe or refit that moved; with `auto` none of them counts;
//   - a drag counts once (orbit, pan, zoom), a wheel step once; a click and a box selection never;
//   - the app's own moves in bind.ts (a Part's camera put back on open, the refit after sketch
//     mode) pass `auto` (sketch entry, the reopened sketch's reframe and the new extrude's turn
//     to Isometric: tests/sketch/auto-camera.test.ts, tests/features/extrude/auto-camera.test.tsx;
//     all five in the real app: e2e/cad-viewport-snapshot.spec.ts);
//   - a snapshot renders into its own target with an orthographic camera, the hidden bodies, the
//     manipulator layers and the highlight left out and its own cut, then puts back the target,
//     the flags, the view's cut and highlight and the line widths, and moves, counts and writes
//     nothing; a lost context throws not_ready.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BoxGeometry, Mesh, type Object3D } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/lib/bus';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import { createCommandRegistry } from '../../src/app/commands';
import type { AppServices } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { SavedCamera, Vec3 } from '../../src/types/doc';
import type { CadEvents } from '../../src/types/events';
import type { TessPayload } from '../../src/types/kernel';
import type { ViewportHandle } from '../../src/types/viewport';
import { viewportCommands } from '../../src/viewport/commands';
import { createViewport } from '../../src/viewport/viewport';

/** What the stand-in renderer saw at each render call. */
interface Seen {
  toTarget: boolean;
  ortho: boolean;
  scissor: boolean;
  /** Own visible flag of every named object (bodies, edges, layers, caps). */
  visible: Record<string, boolean>;
  /** Sum of each body's highlight attribute (0: nothing lit). */
  lit: Record<string, number>;
  /** Clipping planes of each body's material. */
  clips: Record<string, number>;
  /** Line resolution of each body's edges. */
  resolution: Record<string, [number, number]>;
}

const gpu = vi.hoisted(() => ({ last: null as unknown as { lost: boolean; seen: Seen[]; target: unknown; clears: boolean[] } }));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StandInRenderer {
    domElement = document.createElement('canvas');
    info = { render: { calls: 0 }, autoReset: true };
    capabilities = { maxSamples: 4, maxTextureSize: 8192 };
    autoClear = true;
    localClippingEnabled = false;
    lost = false;
    seen: Seen[] = [];
    target: { scissorTest?: boolean; isWebGLRenderTarget?: boolean } | null = null;
    constructor() {
      gpu.last = this as never;
    }
    setPixelRatio() {}
    /** For each setClearColor: whether a render target was bound (the colour is set for that target). */
    clears: boolean[] = [];
    setClearColor() {
      this.clears.push(!!this.target);
    }
    getClearColor<T>(c: T) {
      return c;
    }
    getClearAlpha() {
      return 1;
    }
    setSize() {}
    setScissorTest() {}
    setScissor() {}
    setViewport() {}
    clear() {}
    clearDepth() {}
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: StandInRenderer['target']) {
      this.target = t;
    }
    render(scene: Object3D, camera: { isOrthographicCamera?: boolean }) {
      const s: Seen = { toTarget: !!this.target, ortho: !!camera.isOrthographicCamera, scissor: !!this.target?.scissorTest, visible: {}, lit: {}, clips: {}, resolution: {} };
      scene.traverse((o) => {
        if (o.name) s.visible[o.name] = o.visible;
        const m = o as Mesh & { material: { clippingPlanes?: unknown[] | null; resolution?: { x: number; y: number } } };
        if (o.name.startsWith('body:')) {
          const id = o.name.slice(5);
          s.lit[id] = Array.from(m.geometry.getAttribute('hl').array as Uint8Array).reduce((a, b) => a + b, 0);
          s.clips[id] = m.material.clippingPlanes?.length ?? 0;
        }
        if (o.name.startsWith('edges:')) s.resolution[o.name.slice(6)] = [m.material.resolution!.x, m.material.resolution!.y];
      });
      this.seen.push(s);
    }
    readRenderTargetPixels(_t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) {
      // Row r from the bottom has red r: the picture's rows must come out top first.
      for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) buf.set([r, 7, 9, 255], (r * w + x) * 4);
    }
    getContext() {
      return { isContextLost: () => this.lost, readPixels() {}, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401 };
    }
    dispose() {}
  }
  return { ...three, WebGLRenderer: StandInRenderer };
});

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** A cube from `at` with side `s`: six faces (BoxGeometry's order +X, -X, +Y, -Y, +Z, -Z) and its 12 edges. */
function cubeTess(at: Vec3, s: number): TessPayload {
  const g = new BoxGeometry(s, s, s).translate(at[0] + s / 2, at[1] + s / 2, at[2] + s / 2);
  const pts: number[] = [];
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
    const c = [i, j, k];
    for (let a = 0; a < 3; a++) {
      if (c[a]) continue;
      const d = [...c];
      d[a] = 1;
      pts.push(...c.map((v, n) => at[n] + v * s), ...d.map((v, n) => at[n] + v * s));
    }
  }
  return {
    positions: new Float32Array(g.getAttribute('position').array),
    normals: new Float32Array(g.getAttribute('normal').array),
    indices: new Uint32Array(g.getIndex()!.array),
    faceRanges: new Uint32Array(g.groups.flatMap((gr) => [gr.start, gr.count])),
    edgePositions: new Float32Array(pts),
    edgeRanges: new Uint32Array(Array.from({ length: 12 }, (_, e) => [2 * e, 2]).flat()),
  };
}

const opened: ViewportHandle[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function viewport(services?: AppServices) {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 800 });
  Object.defineProperty(host, 'clientHeight', { value: 600 });
  document.body.appendChild(host);
  const h = createViewport(host, { spawnWorker: null, ...(services ? { services } : {}) });
  opened.push(h);
  const gl = gpu.last;
  const canvas = host.querySelector('canvas')!;
  return { h, gl, canvas, host };
}

function withCube(h: ViewportHandle) {
  h.setBodies([
    { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
    { id: 'b_2', color: '#d02828', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
  ]);
}

const moves = (h: ViewportHandle) => h.userCameraMoves!();
const dir = (c: SavedCamera) => {
  const d = c.position.map((v, i) => v - c.target[i]);
  const l = Math.hypot(...d);
  return d.map((v) => v / l);
};

function pointer(canvas: HTMLCanvasElement, type: string, o: { x: number; y: number; button?: number; buttons?: number; ctrl?: boolean }) {
  const e = new MouseEvent(type, { clientX: o.x, clientY: o.y, button: o.button ?? 0, buttons: o.buttons ?? 0, ctrlKey: !!o.ctrl, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  canvas.dispatchEvent(e);
}

function drag(canvas: HTMLCanvasElement, button: number, o: { ctrl?: boolean } = {}) {
  const buttons = button === 0 ? 1 : button === 2 ? 2 : 4;
  pointer(canvas, 'pointerdown', { x: 300, y: 300, button, buttons, ...o });
  for (let i = 1; i <= 4; i++) pointer(canvas, 'pointermove', { x: 300 + 20 * i, y: 300 + 10 * i, button, buttons, ...o });
  pointer(canvas, 'pointerup', { x: 380, y: 340, button, buttons: 0, ...o });
}

describe('userCameraMoves', () => {
  it("counts each of the person's camera calls once, and none of the same calls passed auto", () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const { h } = viewport();
    withCube(h);
    // The viewport's own framing of the first bodies is nobody's move.
    expect(moves(h)).toBe(0);
    h.fit({ animate: false });
    h.setView('top', { animate: false });
    h.lookAt([1, 0, 0], [0, 0, 1], { animate: false });
    h.orbitAround('center');
    h.setCamera(h.camera());
    expect(moves(h)).toBe(5);
    // A reframe counts only when it frames (after setCamera the view is no longer framed).
    expect(h.reframe()).toBe(false);
    expect(moves(h)).toBe(5);
    h.fit({ animate: false });
    expect(h.reframe()).toBe(true);
    expect(moves(h)).toBe(7);

    // The same calls as the app's own: the camera moves, the count does not.
    h.setView('front', { animate: false, auto: true });
    expect(dir(h.camera())[1]).toBeCloseTo(-1, 6);
    h.lookAt([0, 0, 1], [0, 1, 0], { animate: false, auto: true });
    expect(dir(h.camera())[2]).toBeCloseTo(1, 6);
    h.fit({ animate: false, auto: true });
    h.orbitAround([0, 0, 0], { auto: true });
    h.setCamera(h.camera(), { auto: true });
    h.fit({ animate: false, auto: true });
    expect(h.reframe({ auto: true })).toBe(true);
    expect(moves(h)).toBe(7);

    // A refit that moves counts like the rest; one that does not (nothing off screen) does not.
    expect(h.refitIfOffScreen!()).toBe(false);
    const far = h.addLayer('far', { frame: true });
    const m = new Mesh(new BoxGeometry(1, 1, 1));
    m.position.set(5000, 0, 0);
    far.group.add(m);
    expect(h.refitIfOffScreen!({ auto: true })).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(moves(h)).toBe(7);
    m.position.set(-90000, 0, 0);
    expect(h.refitIfOffScreen!()).toBe(true);
    expect(moves(h)).toBe(8);
  });

  it('a drag counts once (orbit, pan, zoom), a wheel step once; a click or a box selection never', () => {
    const { h, canvas } = viewport();
    withCube(h);
    const before = h.camera();
    drag(canvas, 0);
    expect(moves(h)).toBe(1);
    expect(dir(h.camera())).not.toEqual(dir(before));
    drag(canvas, 1);
    drag(canvas, 2);
    expect(moves(h)).toBe(3);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 300, clientY: 300, cancelable: true }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 300, cancelable: true }));
    expect(moves(h)).toBe(5);
    // A click (no move) and a Ctrl + left drag (a box selection) do not move the camera.
    pointer(canvas, 'pointerdown', { x: 200, y: 200, buttons: 1 });
    pointer(canvas, 'pointerup', { x: 200, y: 200 });
    drag(canvas, 0, { ctrl: true });
    expect(moves(h)).toBe(5);
  });

  it('F, the standard views (1-7) and N are the person\'s: each counts', () => {
    const { h } = viewport();
    withCube(h);
    let services: AppServices;
    const commands = createCommandRegistry(() => services);
    services = { viewport: createStateStore({ handle: h }), selection: createSelectionStore(), commands, doc: { state: createStateStore({ doc: { features: [] }, rebuild: { outputs: {} } }) } } as unknown as AppServices;
    for (const c of viewportCommands()) commands.register(c);
    services.selection.set((s) => ({ ...s, items: [{ kind: 'origin', ref: 'origin:right' }] }));
    for (const id of ['view.fit', 'view.top', 'view.iso', 'view.normal-to']) commands.get(id)!.run(services);
    expect(moves(h)).toBe(4);
  });

  it("bind.ts's own moves pass auto: a Part's camera put back when it opens, the refit after sketch mode", () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const CAM: SavedCamera = { position: [40, -60, 50], target: [5, 5, 5], up: [0, 0, 1], orthoHeight: 40, projection: 'perspective' };
    const rebuild = { status: 'idle', seq: 0, features: {}, bodies: [], outputs: {}, ms: null, message: null };
    const docState = createStateStore({ status: 'loading', rebuild, view: { rollback: null, hiddenBodies: [], expanded: [] } } as unknown as ReturnType<AppServices['doc']['state']['get']>);
    const saved: SavedCamera[] = [];
    const mode = createStateStore<{ mode: Mode }>({ mode: 'model' });
    const services = {
      doc: { state: docState, setCamera: (c: SavedCamera) => saved.push(c), setPlanes: () => {} },
      selection: createSelectionStore(),
      bus: createBus<CadEvents>(),
      kernel: { call: async () => ({ result: { faces: [], edges: [], vertices: [] } }) },
      mode,
    } as unknown as AppServices;
    const { h } = viewport(services);
    docState.set((s) => ({ ...s, status: 'ready', view: { ...s.view, camera: CAM } }) as typeof s);
    docState.set((s) => ({ ...s, rebuild: { ...s.rebuild, status: 'done', seq: 1 } }) as typeof s);
    expect(h.camera().position).toEqual(CAM.position);
    expect(moves(h)).toBe(0);
    // Sketch mode ends with a sketch drawn past the edge of a framed view: the view refits by itself.
    h.fit({ animate: false, auto: true });
    const far = h.addLayer('far', { frame: true });
    const m = new Mesh(new BoxGeometry(1, 1, 1));
    m.position.set(0, 4000, 0);
    far.group.add(m);
    const before = h.camera();
    mode.set({ mode: 'sketch' });
    mode.set({ mode: 'model' });
    vi.advanceTimersByTime(3000);
    expect(h.camera().target).not.toEqual(before.target);
    expect(moves(h)).toBe(0);
  });
});

describe('snapshot', () => {
  it("draws off screen with its own camera and cut, leaves out what it should, and puts everything back", async () => {
    const { h, gl } = viewport();
    withCube(h);
    await vi.waitFor(() => expect(h.state.get().bvhPending).toBe(0));
    // The person's view: a face selected, a section on, a manipulator and a sketch layer shown.
    h.highlight([{ kind: 'face', body: 'b_1', index: 4 }]);
    h.setSection({ on: true, plane: 'origin:right', offset: 5 });
    const manip = h.addLayer('extrude.handle');
    manip.group.add(new Mesh(new BoxGeometry(1, 1, 1)));
    const sketch = h.addLayer('profiles.sketches', { frame: true });
    sketch.group.add(new Mesh(new BoxGeometry(1, 1, 1)));
    const camera = h.camera();
    const vstate = h.state.get();
    const framed = h.stats().framed;
    const count = moves(h);
    gl.seen.length = 0;
    gl.clears.length = 0;

    const r = h.snapshot!({ view: 'iso_back', width: 160, height: 120, hide: ['b_2'], section: { plane: 'top', offset: 5, flip: false } });

    // Into a target of its own: the scene orthographic, then the triad in a scissored corner.
    expect(gl.seen.map((s) => [s.toTarget, s.ortho, s.scissor])).toEqual([
      [true, true, false],
      [true, false, true],
    ]);
    const drawn = gl.seen[0];
    expect(drawn.visible).toMatchObject({ 'body:b_1': true, 'edges:b_1': true, 'body:b_2': false, 'edges:b_2': false, 'layer:extrude.handle': false, 'layer:profiles.sketches': true, 'section-caps': true });
    // Nothing lit, its own cut on every body, lines as wide as in a 160 x 120 view.
    expect(drawn.lit).toEqual({ b_1: 0, b_2: 0 });
    expect(drawn.clips).toEqual({ b_1: 1, b_2: 1 });
    expect(drawn.resolution.b_1).toEqual([160, 120]);

    // Everything put back: the target, the camera, the view's state, the count, the framing.
    expect(gl.target).toBeNull();
    // Its own clear colour for the target, then the view's set again with no target bound (no darker frame next).
    expect(gl.clears).toEqual([true, false]);
    expect(h.camera()).toEqual(camera);
    expect(h.state.get()).toEqual(vstate);
    expect(moves(h)).toBe(count);
    expect(h.stats().framed).toBe(framed);
    gl.seen.length = 0;
    // The next frame of the view: the hidden body, the manipulator and the highlight back, the view's own cut.
    await vi.waitFor(() => expect(gl.seen.length).toBeGreaterThan(0));
    const next = gl.seen[0];
    expect(next.toTarget).toBe(false);
    expect(next.visible).toMatchObject({ 'body:b_2': true, 'layer:extrude.handle': true, 'section-caps': true });
    expect(next.lit.b_1).toBeGreaterThan(0);
    expect(next.clips).toEqual({ b_1: 1, b_2: 1 });
    expect(next.resolution.b_1).toEqual([800, 600]);

    // The picture: its size, rows top first, mm per pixel; the shown body framed in the middle.
    expect([r.width, r.height, r.rgba.length]).toEqual([160, 120, 160 * 120 * 4]);
    expect([r.rgba[0], r.rgba[119 * 160 * 4]]).toEqual([119, 0]);
    expect(r.mmPerPx).toBeGreaterThan(0);
    const c = r.project([5, 5, 5])!;
    expect(c[0]).toBeCloseTo(80, 6);
    expect(c[1]).toBeCloseTo(60, 6);
    // Seen from back-left-top, +X runs to the left.
    expect(r.project([10, 5, 5])![0]).toBeLessThan(80);
  });

  it('visibleFaceAt: the face of that body in front at a picture pixel, else null', async () => {
    const { h } = viewport();
    withCube(h);
    await vi.waitFor(() => expect(h.state.get().bvhPending).toBe(0));
    const r = h.snapshot!({ view: 'top', width: 200, height: 100, hide: [], section: null });
    const top1 = r.project([5, 5, 10])!;
    const top2 = r.project([25, 5, 10])!;
    // BoxGeometry's face 4 is +Z.
    expect(r.visibleFaceAt('b_1', top1[0], top1[1])).toBe(4);
    expect(r.visibleFaceAt('b_2', top2[0], top2[1])).toBe(4);
    expect(r.visibleFaceAt('b_2', top1[0], top1[1])).toBeNull();
    expect(r.visibleFaceAt('b_1', 1, 1)).toBeNull();
    // A cut keeping what is below z = 5: from the top the cap is in front, not a face.
    const cut = h.snapshot!({ view: 'top', width: 200, height: 100, hide: ['b_2'], section: { plane: 'top', offset: 5, flip: false } });
    const p = cut.project([5, 5, 5])!;
    expect(cut.visibleFaceAt('b_1', p[0], p[1])).toBeNull();
  });

  it('a lost WebGL context: snapshot throws not_ready and stats says so', () => {
    const { h, gl } = viewport();
    withCube(h);
    expect(h.stats().contextLost).toBe(false);
    gl.lost = true;
    expect(h.stats().contextLost).toBe(true);
    let err: unknown = null;
    try {
      h.snapshot!({ view: 'iso', width: 32, height: 32, hide: [], section: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('not_ready');
    expect((err as { code?: string }).code).toBe('not_ready');
    expect(() => {
      gl.lost = false;
      h.snapshot!({ view: 'iso', width: 0, height: 32, hide: [], section: null });
    }).toThrow(RangeError);
  });
});
