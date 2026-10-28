// The view follows the host's theme (ViewportHandle.setPalette, src/viewport/palette.ts) and its
// pictures stay light. The real viewport on a stand-in for three's WebGLRenderer (jsdom has no
// WebGL) that records, at each render, the clear colour, the edges' colours, the rims and the
// triad's arrows:
//   - LIGHT is what the view draws until a palette comes, and setting it again changes nothing;
//   - a dark palette recolours the background, the edges and the triad at once (no rebuild: the
//     same materials) and calls every layer's `palette` hook, never at registration;
//   - E1 option (b) puts a rim line under each body's edges (new bodies too), gone with (c);
//   - a snapshot taken while dark draws LIGHT (background, edges, triad, no rim; the hooks of the
//     layers it shows called with LIGHT, a hidden layer's not) and puts the dark marks back in the
//     same task, also when it fails half-way (it rethrows); with LIGHT live it calls no hook and
//     swaps nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BoxGeometry, Color, LinearSRGBColorSpace, type Mesh, type Object3D } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../../src/types/doc';
import type { TessPayload } from '../../src/types/kernel';
import type { ViewportHandle } from '../../src/types/viewport';
import { EDGE_WIDTH_PX } from '../../src/viewport/colors';
import { DARK, darkPalette, LIGHT, type MarkPalette } from '../../src/viewport/palette';
import { createViewport } from '../../src/viewport/viewport';

interface Seen {
  toTarget: boolean;
  /** The triad's own render (scissored). */
  triad: boolean;
  clear: number;
  edges: Record<string, number>;
  rims: Record<string, { visible: boolean; color: number; width: number }>;
  /** The colours of the meshes drawn with a uColor uniform and no name (the triad's arrows), as 0xrrggbb. */
  arrows: number[];
}

/** `fail`: the next render or read of the picture's pixels throws (once). */
const gpu = vi.hoisted(() => ({ last: null as unknown as { seen: Seen[] }, log: [] as string[], fail: null as 'render' | 'read' | null }));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  const raw = (c: { getHex(cs?: string): number }) => c.getHex(three.LinearSRGBColorSpace);
  class StandInRenderer {
    domElement = document.createElement('canvas');
    info = { render: { calls: 0 }, autoReset: true };
    capabilities = { maxSamples: 4, maxTextureSize: 8192 };
    autoClear = true;
    localClippingEnabled = false;
    seen: Seen[] = [];
    target: { scissorTest?: boolean } | null = null;
    scissor = false;
    /** The clear colour as the view's sRGB 0xrrggbb (a Color is read as stored: the snapshot sets it so). */
    clearHex = 0;
    constructor() {
      gpu.last = this as never;
    }
    setPixelRatio() {}
    setClearColor(c: number | { isColor?: boolean; getHex(cs?: string): number }) {
      this.clearHex = typeof c === 'number' ? c : raw(c);
    }
    getClearColor(c: { setHex(n: number, cs?: string): unknown }) {
      c.setHex(this.clearHex, three.LinearSRGBColorSpace);
      return c;
    }
    getClearAlpha() {
      return 1;
    }
    setSize() {}
    setScissorTest(on: boolean) {
      this.scissor = on;
    }
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
    render(scene: Object3D) {
      gpu.log.push('render');
      if (gpu.fail === 'render' && this.target) {
        gpu.fail = null;
        throw new Error('render failed');
      }
      const s: Seen = { toTarget: !!this.target, triad: this.target ? !!this.target.scissorTest : this.scissor, clear: this.clearHex, edges: {}, rims: {}, arrows: [] };
      scene.traverse((o) => {
        const m = (o as Mesh).material as unknown as { color?: { getHex(): number }; linewidth?: number; uniforms?: { uColor?: { value: { x: number; y: number; z: number } } } };
        if (o.name.startsWith('edges:')) s.edges[o.name.slice(6)] = m.color!.getHex();
        if (o.name.startsWith('edge-rim:')) s.rims[o.name.slice(9)] = { visible: o.visible, color: m.color!.getHex(), width: m.linewidth! };
        const u = m?.uniforms?.uColor?.value;
        if (!o.name && (o as Mesh).isMesh && u) s.arrows.push((Math.round(u.x * 255) << 16) | (Math.round(u.y * 255) << 8) | Math.round(u.z * 255));
      });
      this.seen.push(s);
    }
    readRenderTargetPixels() {
      if (gpu.fail === 'read') {
        gpu.fail = null;
        throw new Error('read failed');
      }
    }
    getContext() {
      return { isContextLost: () => false, readPixels() {}, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401 };
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
  gpu.log.length = 0;
  gpu.fail = null;
  vi.useRealTimers();
});

function viewport() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 800 });
  Object.defineProperty(host, 'clientHeight', { value: 600 });
  document.body.appendChild(host);
  const h = createViewport(host, { spawnWorker: null });
  opened.push(h);
  h.setBodies([
    { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
    { id: 'b_2', color: '#d02828', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
  ]);
  return { h, gl: gpu.last };
}

/** Draw one frame of the view; its main render and its triad's. */
function frame(gl: { seen: Seen[] }) {
  gl.seen.length = 0;
  vi.advanceTimersByTime(20);
  const main = gl.seen.find((s) => !s.toTarget && !s.triad)!;
  const triad = gl.seen.find((s) => !s.toTarget && s.triad)!;
  expect(main, 'a frame was drawn').toBeTruthy();
  return { main, triad };
}

const snap = (h: ViewportHandle) => h.snapshot!({ view: 'iso', width: 400, height: 300, hide: [], section: null });

describe('the view and the theme', () => {
  it('draws LIGHT until a palette comes, and LIGHT again changes nothing', () => {
    const { h, gl } = viewport();
    expect(h.palette!()).toBe(LIGHT);
    const f = frame(gl);
    expect(f.main.clear).toBe(0xf0f2f7);
    expect(f.main.edges).toEqual({ b_1: 0x0a0b0e, b_2: 0x0a0b0e });
    expect(f.main.rims).toEqual({});
    expect(f.triad.arrows).toEqual([0xd42828, 0xd42828, 0x1f9a3a, 0x1f9a3a, 0x2a5bd7, 0x2a5bd7]);
    const hook = vi.fn();
    h.addLayer('sketch-geometry', { palette: hook });
    h.setPalette!(LIGHT);
    gl.seen.length = 0;
    vi.advanceTimersByTime(20);
    expect(hook).not.toHaveBeenCalled();
    expect(h.palette!()).toBe(LIGHT);
  });

  it('a dark palette recolours the background, the edges and the triad at once, and calls each layer hook (never when added)', () => {
    const { h, gl } = viewport();
    const hook = vi.fn();
    const off = vi.fn();
    h.addLayer('profiles.sketches', { palette: hook });
    h.addLayer('extrude.handle', { palette: off });
    expect(hook).not.toHaveBeenCalled();
    h.setPalette!(DARK);
    expect(h.palette!()).toBe(DARK);
    expect(hook.mock.calls).toEqual([[DARK]]);
    expect(off.mock.calls).toEqual([[DARK]]);
    const f = frame(gl);
    expect(f.main.clear).toBe(0x1b1f27);
    expect(f.main.edges).toEqual({ b_1: DARK.edge, b_2: DARK.edge });
    expect(f.main.rims).toEqual({});
    expect(f.triad.arrows).toEqual([0xff6b6b, 0xff6b6b, 0x4cd07d, 0x4cd07d, 0x6f9bff, 0x6f9bff]);
    // The same palette again: nothing.
    h.setPalette!(darkPalette());
    expect(hook).toHaveBeenCalledTimes(1);
    // Back to light: every mark as before.
    h.setPalette!(LIGHT);
    expect(hook.mock.calls[1]).toEqual([LIGHT]);
    const g = frame(gl);
    expect([g.main.clear, g.main.edges.b_1, g.triad.arrows[0]]).toEqual([0xf0f2f7, 0x0a0b0e, 0xd42828]);
  });

  it('gives each edge a rim in the background colour with E1 (b), new bodies too, and takes it away with (c)', () => {
    const { h, gl } = viewport();
    const b = darkPalette({ edges: 'b' });
    h.setPalette!(b);
    let f = frame(gl);
    expect(f.main.edges).toEqual({ b_1: 0xe6e9ef, b_2: 0xe6e9ef });
    expect(f.main.rims).toEqual({ b_1: { visible: true, color: 0x1b1f27, width: EDGE_WIDTH_PX + 2 }, b_2: { visible: true, color: 0x1b1f27, width: EDGE_WIDTH_PX + 2 } });
    h.setBodies([
      { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
      { id: 'b_3', color: '#bdc9db', visible: true, tessKey: 'k3', tess: cubeTess([0, 30, 0], 10) },
    ]);
    f = frame(gl);
    expect(Object.keys(f.main.rims).sort()).toEqual(['b_1', 'b_3']);
    expect(f.main.edges.b_3).toBe(0xe6e9ef);
    // Shaded only: no edges, no rims.
    h.setDisplay('shaded');
    f = frame(gl);
    expect(f.main.rims.b_1.visible).toBe(false);
    h.setDisplay('shaded-edges');
    h.setPalette!(DARK);
    f = frame(gl);
    expect(f.main.rims).toEqual({});
    expect(f.main.edges.b_1).toBe(0x8a93a3);
  });

  it('a picture taken while dark is LIGHT, and the dark marks are back in the same task', () => {
    const { h, gl } = viewport();
    const shown = vi.fn((p: MarkPalette) => gpu.log.push(`palette:${p.name}`));
    const hidden = vi.fn((p: MarkPalette) => gpu.log.push(`hidden:${p.name}`));
    h.addLayer('sketch-geometry', { palette: shown });
    h.addLayer('scale-banana', { palette: hidden });
    h.setPalette!(darkPalette({ edges: 'b' }));
    frame(gl);
    gpu.log.length = 0;
    gl.seen.length = 0;
    snap(h);
    const pic = gl.seen.filter((s) => s.toTarget);
    expect(pic.length).toBe(2);
    expect(pic[0].clear).toBe(0xf0f2f7);
    expect(pic[0].edges).toEqual({ b_1: 0x0a0b0e, b_2: 0x0a0b0e });
    expect(Object.values(pic[0].rims).map((r) => r.visible)).toEqual([false, false]);
    expect(pic[1].arrows).toEqual([0xd42828, 0xd42828, 0x1f9a3a, 0x1f9a3a, 0x2a5bd7, 0x2a5bd7]);
    // The layer the picture shows draws LIGHT for it and the live palette after; a hidden one is not asked.
    expect(gpu.log).toEqual(['palette:light', 'render', 'render', 'palette:dark']);
    expect(hidden.mock.calls.length).toBe(1);
    // Back, before any frame: the view's next frame is dark, rims and all.
    expect(h.palette!().name).toBe('dark');
    const f = frame(gl);
    expect(f.main.clear).toBe(0x1b1f27);
    expect(f.main.edges.b_1).toBe(0xe6e9ef);
    expect(f.main.rims.b_1.visible).toBe(true);
    expect(f.triad.arrows[0]).toBe(0xff6b6b);
  });

  // Review round 1: the restore in snapshot's finally was pinned on the success path only.
  for (const [fail, log] of [
    ['render', ['palette:light', 'render', 'palette:dark']],
    ['read', ['palette:light', 'render', 'render', 'palette:dark']],
  ] as const)
    it(`a picture whose ${fail} fails while dark rethrows and puts every dark mark back: the next frame is dark, rims and triad too`, () => {
      const { h, gl } = viewport();
      h.addLayer('sketch-geometry', { palette: (p: MarkPalette) => gpu.log.push(`palette:${p.name}`) });
      h.setPalette!(darkPalette({ edges: 'b' }));
      frame(gl);
      gpu.log.length = 0;
      gpu.fail = fail;
      expect(() => snap(h)).toThrow(`${fail} failed`);
      // The layer drew LIGHT for the picture and has the live palette again, last.
      expect(gpu.log).toEqual([...log]);
      expect(h.palette!()).toEqual(darkPalette({ edges: 'b' }));
      const f = frame(gl);
      expect(f.main.clear).toBe(0x1b1f27);
      expect(f.main.edges).toEqual({ b_1: 0xe6e9ef, b_2: 0xe6e9ef });
      expect(f.main.rims).toEqual({ b_1: { visible: true, color: 0x1b1f27, width: EDGE_WIDTH_PX + 2 }, b_2: { visible: true, color: 0x1b1f27, width: EDGE_WIDTH_PX + 2 } });
      expect(f.triad.arrows).toEqual([0xff6b6b, 0xff6b6b, 0x4cd07d, 0x4cd07d, 0x6f9bff, 0x6f9bff]);
      // And the next picture is LIGHT again.
      gl.seen.length = 0;
      snap(h);
      const pic = gl.seen.filter((s) => s.toTarget);
      expect([pic[0].clear, pic[0].edges.b_1, pic[1].arrows[0]]).toEqual([0xf0f2f7, 0x0a0b0e, 0xd42828]);
    });

  it('a picture taken while light swaps nothing', () => {
    const { h, gl } = viewport();
    const hook = vi.fn();
    h.addLayer('sketch-geometry', { palette: hook });
    gl.seen.length = 0;
    snap(h);
    expect(hook).not.toHaveBeenCalled();
    const pic = gl.seen.filter((s) => s.toTarget);
    expect(pic[0].clear).toBe(new Color().setRGB(0xf0 / 255, 0xf2 / 255, 0xf7 / 255, LinearSRGBColorSpace).getHex(LinearSRGBColorSpace));
    expect(pic[0].edges.b_1).toBe(0x0a0b0e);
  });
});
