// The view follows the host's theme (ViewportHandle.setPalette, src/viewport/palette.ts) and its
// pictures stay light. The real viewport on a stand-in for three's WebGLRenderer (jsdom has no
// WebGL) that records, at each render, the clear colour, the edges' colours, the bodies' and the
// cap's stencil, the layers' marks and their face twins (src/viewport/onface.ts), and the triad's
// arrows:
//   - LIGHT is what the view draws until a palette comes, and setting it again changes nothing;
//   - a dark palette recolours the background, the edges (E1: #e6e9ef, plain) and the triad at
//     once (no rebuild: the same materials) and calls every layer's `palette` hook, never at
//     registration;
//   - E2: while dark, an opaque light body's faces set the stencil's face bit (a dark custom
//     colour clears it; a see-through body leaves it), the section cap sets it, and a layer's mark
//     with a face ink is drawn twice (itself over the background, a twin over light surfaces);
//     in light none of it;
//   - E2 on a dark body: its faces lit by a pick or a hover set the bit again (their stencil-only
//     pass), the whole body selected or hovered sets it (the blue it is drawn in), and
//     lightSurfaceAt says the same; in light, and in a picture, none of it;
//   - a snapshot taken while dark draws LIGHT (background, edges, triad, no twin, no stencil; the
//     hooks of the layers it shows called with LIGHT, a hidden layer's not) and puts the dark marks
//     back in the same task, also when it fails half-way (it rethrows); with LIGHT live it calls
//     no hook and swaps nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Line, LineBasicMaterial, LinearSRGBColorSpace, type Material, type Mesh, type Object3D } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../../src/types/doc';
import type { TessPayload } from '../../src/types/kernel';
import type { ViewportHandle } from '../../src/types/viewport';
import { FACE_BIT, isFaceTwin, setFaceInk } from '../../src/viewport/onface';
import { DARK, LIGHT, type MarkPalette } from '../../src/viewport/palette';
import { createViewport } from '../../src/viewport/viewport';

interface Seen {
  toTarget: boolean;
  /** The triad's own render (scissored). */
  triad: boolean;
  clear: number;
  edges: Record<string, number>;
  /** Each body's edges: their stencil test and their face twin's colour where it shows (E1), as `marks`. */
  edgeTwins: Record<string, { only: 'all' | 'face' | 'ground'; twin: number | null }>;
  /** Each body's faces in the stencil: off, or the face bit set ('mark') or cleared ('clear'). */
  surfaces: Record<string, 'off' | 'mark' | 'clear'>;
  /** The section cap's stencil ref (0 in light, the face bit in dark), when the cap shows. */
  cap: number | null;
  /** Each body's lit faces' stencil pass: 'mark' where it draws (it sets the face bit, no colour, no depth), else 'hidden'. */
  litFaces: Record<string, 'mark' | 'hidden' | 'other'>;
  /** Each named layer mark: its stencil test (none, or the pixels with or without the face bit) and its twin's colour where one shows. */
  marks: Record<string, { only: 'all' | 'face' | 'ground'; twin: number | null }>;
  /** The colours of the meshes drawn with a uColor uniform and no name (the triad's arrows), as 0xrrggbb. */
  arrows: number[];
  /** Their lighting (the first arrow's ambient and diffuse). */
  triadLight: { ambient: number; diffuse: number } | null;
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
      const s: Seen = { toTarget: !!this.target, triad: this.target ? !!this.target.scissorTest : this.scissor, clear: this.clearHex, edges: {}, edgeTwins: {}, surfaces: {}, cap: null, litFaces: {}, marks: {}, arrows: [], triadLight: null };
      const only = (m: Material) => (!m.stencilWrite ? 'all' : m.stencilWriteMask === 0 && m.stencilFuncMask === FACE_BIT ? (m.stencilRef === FACE_BIT ? 'face' : 'ground') : 'other');
      scene.traverse((o) => {
        const m = (o as Mesh).material as unknown as Material & { color?: { getHex(): number }; linewidth?: number; uniforms?: { uColor?: { value: { x: number; y: number; z: number } }; uAmbient?: { value: number }; uDiffuse?: { value: number } } };
        if (o.name.startsWith('edges:')) {
          s.edges[o.name.slice(6)] = m.color!.getHex();
          const t = o.children.find(isFaceTwin) as (Object3D & { material: Material & { color: { getHex(): number } } }) | undefined;
          s.edgeTwins[o.name.slice(6)] = { only: only(m) as 'all', twin: t && t.visible ? t.material.color.getHex() : null };
          if (t?.visible) expect(only(t.material), 'an edge twin draws over light surfaces only').toBe('face');
        }
        if (o.name.startsWith('body:')) s.surfaces[o.name.slice(5)] = !m.stencilWrite ? 'off' : m.stencilWriteMask === FACE_BIT && m.stencilRef === FACE_BIT ? 'mark' : m.stencilWriteMask === FACE_BIT && m.stencilRef === 0 ? 'clear' : ('other' as never);
        if (o.name === 'section-cap' && o.parent?.visible) s.cap = m.stencilRef;
        if (o.name.startsWith('body-lit-faces:')) {
          const drawn = o.visible && !!o.parent?.visible;
          const mark = m.stencilWrite && m.stencilWriteMask === FACE_BIT && m.stencilRef === FACE_BIT && !m.colorWrite && !m.depthWrite;
          s.litFaces[o.name.slice(15)] = !drawn ? 'hidden' : mark ? 'mark' : 'other';
        }
        if (o.name.startsWith('mark:')) {
          const t = o.children.find(isFaceTwin) as (Object3D & { material: Material & { color: { getHex(): number } } }) | undefined;
          s.marks[o.name.slice(5)] = { only: only(m) as 'all', twin: t && t.visible ? t.material.color.getHex() : null };
          if (t?.visible) expect(only(t.material), 'a twin draws over light surfaces only').toBe('face');
        }
        const u = m?.uniforms?.uColor?.value;
        if (!o.name && (o as Mesh).isMesh && u) {
          s.arrows.push((Math.round(u.x * 255) << 16) | (Math.round(u.y * 255) << 8) | Math.round(u.z * 255));
          s.triadLight ??= { ambient: m.uniforms!.uAmbient!.value, diffuse: m.uniforms!.uDiffuse!.value };
        }
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

/** A layer with one mark (a measure-like line) whose material has a face ink while dark, as the layers set it from the palette. */
function markLayer(h: ViewportHandle) {
  const mat = new LineBasicMaterial({ color: LIGHT.measure });
  const g = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 10, 10, 10], 3));
  const line = new Line(g, mat);
  line.name = 'mark:measure';
  const paint = (p: MarkPalette) => {
    mat.color.setHex(p.measure);
    setFaceInk(mat, p.face?.measure ?? null);
  };
  const layer = h.addLayer('p2-other', { palette: paint });
  paint(h.palette!());
  layer.group.add(line);
  return { line, mat };
}

describe('the view and the theme', () => {
  it('draws LIGHT until a palette comes, and LIGHT again changes nothing', () => {
    const { h, gl } = viewport();
    expect(h.palette!()).toBe(LIGHT);
    const f = frame(gl);
    expect(f.main.clear).toBe(0xf0f2f7);
    expect(f.main.edges).toEqual({ b_1: 0x0a0b0e, b_2: 0x0a0b0e });
    expect(f.main.surfaces).toEqual({ b_1: 'off', b_2: 'off' });
    expect(f.triad.arrows).toEqual([0xd42828, 0xd42828, 0x1f9a3a, 0x1f9a3a, 0x2a5bd7, 0x2a5bd7]);
    expect(f.triad.triadLight).toEqual({ ambient: 0, diffuse: 1 });
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
    expect(f.main.edges).toEqual({ b_1: 0xe6e9ef, b_2: 0xe6e9ef });
    // E1: the edges over the background, and their twin in LIGHT's near-black over light surfaces.
    expect(f.main.edgeTwins).toEqual({ b_1: { only: 'ground', twin: 0x0a0b0e }, b_2: { only: 'ground', twin: 0x0a0b0e } });
    expect(f.triad.arrows).toEqual([0xff6b6b, 0xff6b6b, 0x4cd07d, 0x4cd07d, 0x6f9bff, 0x6f9bff]);
    expect(f.triad.triadLight).toEqual(DARK.triadLight);
    // The same palette again: nothing.
    h.setPalette!({ ...DARK } as MarkPalette);
    expect(hook).toHaveBeenCalledTimes(1);
    // Back to light: every mark as before.
    h.setPalette!(LIGHT);
    expect(hook.mock.calls[1]).toEqual([LIGHT]);
    const g = frame(gl);
    expect([g.main.clear, g.main.edges.b_1, g.triad.arrows[0]]).toEqual([0xf0f2f7, 0x0a0b0e, 0xd42828]);
    expect(g.main.edgeTwins, 'the edges drawn once again, as they are').toEqual({ b_1: { only: 'all', twin: null }, b_2: { only: 'all', twin: null } });
    expect(g.triad.triadLight).toEqual({ ambient: 0, diffuse: 1 });
  });

  it("E2: while dark, a light body's faces set the face bit (a dark one clears it, a see-through one leaves it), the cap sets it, and a mark with a face ink is drawn twice; in light none of it", () => {
    const { h, gl } = viewport();
    const { mat } = markLayer(h);
    // Light: no stencil from the bodies, the mark drawn once, as it is.
    let f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'off', b_2: 'off' });
    expect(f.main.marks).toEqual({ measure: { only: 'all', twin: null } });
    h.setPalette!(DARK);
    f = frame(gl);
    // #bdc9db is a light surface (the light view's ink reads better on it); the strong red #d02828
    // is not (the dark view's light ink reads better there), so it clears the bit.
    expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'clear' });
    expect(f.main.marks).toEqual({ measure: { only: 'ground', twin: LIGHT.measure } });
    expect(mat.color.getHex()).toBe(DARK.measure);
    // A navy body, a see-through one (an Enclosure's air), and a body made while dark.
    h.setBodies([
      { id: 'b_1', color: '#1d2939', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
      { id: 'b_2', color: '#d02828', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10), seeThrough: true },
      { id: 'b_3', color: '#bdc9db', visible: true, tessKey: 'k3', tess: cubeTess([0, 30, 0], 10) },
    ]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'clear', b_2: 'off', b_3: 'mark' });
    expect(f.main.edges.b_3).toBe(0xe6e9ef);
    // Its colour made light, and the air made solid (and light): they set it now.
    h.setBodies([
      { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
      { id: 'b_2', color: '#f5d742', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
      { id: 'b_3', color: '#bdc9db', visible: true, tessKey: 'k3', tess: cubeTess([0, 30, 0], 10) },
    ]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'mark', b_3: 'mark' });
    // A section: the cap, a light surface, sets the bit in dark.
    h.setSection({ on: true, plane: 'origin:front', offset: 5, flip: false });
    f = frame(gl);
    expect(f.main.cap).toBe(FACE_BIT);
    // Back to light: the bodies and the cap as before, the mark once.
    h.setPalette!(LIGHT);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'off', b_2: 'off', b_3: 'off' });
    expect(f.main.cap).toBe(0);
    expect(f.main.marks).toEqual({ measure: { only: 'all', twin: null } });
    expect(mat.color.getHex()).toBe(LIGHT.measure);
  });

  it("E2 on a dark body: its faces lit by a pick or a hover, and the whole body selected or hovered, set the face bit; lightSurfaceAt says so; light and a picture none of it", () => {
    const { h, gl } = viewport();
    h.setPalette!(DARK);
    // A navy b_1 (it clears the bit) beside the red b_2.
    h.setBodies([
      { id: 'b_1', color: '#1d2939', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
      { id: 'b_2', color: '#d02828', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
    ]);
    let f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'clear', b_2: 'clear' });
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'hidden' });
    // The top faces' middles (index 4 is +z), on screen.
    const top1 = h.project([5, 5, 10])!;
    const top2 = h.project([25, 5, 10])!;
    const light = (at: [number, number]) => h.lightSurfaceAt!(at[0], at[1]);
    expect([light(top1), light(top2)]).toEqual([false, false]);
    // b_1's top face picked (a Measure's picks, the selection): the pick green, a light surface.
    h.highlight([{ kind: 'face', body: 'b_1', index: 4 }]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'clear', b_2: 'clear' });
    expect(f.main.litFaces).toEqual({ b_1: 'mark', b_2: 'hidden' });
    expect([light(top1), light(top2)]).toEqual([true, false]);
    // Hovered instead (a list row's flash lights it as the pointer does): the hover blue, light too.
    h.highlight([]);
    h.flash([{ kind: 'face', body: 'b_1', index: 4 }]);
    f = frame(gl);
    expect(f.main.litFaces).toEqual({ b_1: 'mark', b_2: 'hidden' });
    expect(light(top1)).toBe(true);
    h.flash([]);
    // The whole body selected: drawn in the selected blue, a light surface: the body sets the bit itself.
    h.highlight([{ kind: 'body', body: 'b_1' }]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'clear' });
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'hidden' });
    expect([light(top1), light(top2)]).toEqual([true, false]);
    // Nothing lit: b_1 clears the bit again.
    h.highlight([]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'clear', b_2: 'clear' });
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'hidden' });
    expect(light(top1)).toBe(false);
    // A light body with a face picked sets the bit itself: no second pass.
    h.setBodies([
      { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
      { id: 'b_2', color: '#d02828', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
    ]);
    h.highlight([{ kind: 'face', body: 'b_1', index: 4 }, { kind: 'face', body: 'b_2', index: 4 }]);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'clear' });
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'mark' });
    // A picture while dark: no stencil, no lit faces' pass (and nothing lit).
    gl.seen.length = 0;
    snap(h);
    const pic = gl.seen.find((s) => s.toTarget && !s.triad)!;
    expect(pic.surfaces).toEqual({ b_1: 'off', b_2: 'off' });
    expect(pic.litFaces).toEqual({ b_1: 'hidden', b_2: 'hidden' });
    // And back: the next frame has them again.
    f = frame(gl);
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'mark' });
    // Light: none of it, whatever is lit.
    h.setPalette!(LIGHT);
    f = frame(gl);
    expect(f.main.surfaces).toEqual({ b_1: 'off', b_2: 'off' });
    expect(f.main.litFaces).toEqual({ b_1: 'hidden', b_2: 'hidden' });
    expect(light(top2)).toBe(true);
  });

  it('a picture taken while dark is LIGHT, and the dark marks are back in the same task', () => {
    const { h, gl } = viewport();
    const shown = vi.fn((p: MarkPalette) => gpu.log.push(`palette:${p.name}`));
    const hidden = vi.fn((p: MarkPalette) => gpu.log.push(`hidden:${p.name}`));
    h.addLayer('sketch-geometry', { palette: shown });
    h.addLayer('scale-banana', { palette: hidden });
    markLayer(h);
    h.setPalette!(DARK);
    frame(gl);
    gpu.log.length = 0;
    gl.seen.length = 0;
    snap(h);
    const pic = gl.seen.filter((s) => s.toTarget);
    expect(pic.length).toBe(2);
    expect(pic[0].clear).toBe(0xf0f2f7);
    expect(pic[0].edges).toEqual({ b_1: 0x0a0b0e, b_2: 0x0a0b0e });
    // No mark drawn twice, no stencil test or write: the light picture.
    expect(pic[0].edgeTwins).toEqual({ b_1: { only: 'all', twin: null }, b_2: { only: 'all', twin: null } });
    expect(pic[0].surfaces).toEqual({ b_1: 'off', b_2: 'off' });
    expect(pic[0].marks).toEqual({ measure: { only: 'all', twin: null } });
    expect(pic[1].arrows).toEqual([0xd42828, 0xd42828, 0x1f9a3a, 0x1f9a3a, 0x2a5bd7, 0x2a5bd7]);
    // The picture's triad is lit as the core's.
    expect(pic[1].triadLight).toEqual(LIGHT.triadLight);
    // The layer the picture shows draws LIGHT for it and the live palette after; a hidden one is not asked.
    expect(gpu.log).toEqual(['palette:light', 'render', 'render', 'palette:dark']);
    expect(hidden.mock.calls.length).toBe(1);
    // Back, before any frame: the view's next frame is dark, twins and all.
    expect(h.palette!().name).toBe('dark');
    const f = frame(gl);
    expect(f.main.clear).toBe(0x1b1f27);
    expect(f.main.edges.b_1).toBe(0xe6e9ef);
    expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'clear' });
    expect(f.main.marks).toEqual({ measure: { only: 'ground', twin: LIGHT.measure } });
    expect(f.triad.arrows[0]).toBe(0xff6b6b);
    expect(f.triad.triadLight).toEqual(DARK.triadLight);
  });

  // Review round 1: the restore in snapshot's finally was pinned on the success path only.
  for (const [fail, log] of [
    ['render', ['palette:light', 'render', 'palette:dark']],
    ['read', ['palette:light', 'render', 'render', 'palette:dark']],
  ] as const)
    it(`a picture whose ${fail} fails while dark rethrows and puts every dark mark back: the next frame is dark, twins and triad too`, () => {
      const { h, gl } = viewport();
      h.addLayer('sketch-geometry', { palette: (p: MarkPalette) => gpu.log.push(`palette:${p.name}`) });
      markLayer(h);
      h.setPalette!(DARK);
      frame(gl);
      gpu.log.length = 0;
      gpu.fail = fail;
      expect(() => snap(h)).toThrow(`${fail} failed`);
      // The layer drew LIGHT for the picture and has the live palette again, last.
      expect(gpu.log).toEqual([...log]);
      expect(h.palette!()).toBe(DARK);
      const f = frame(gl);
      expect(f.main.clear).toBe(0x1b1f27);
      expect(f.main.edges).toEqual({ b_1: 0xe6e9ef, b_2: 0xe6e9ef });
      expect(f.main.surfaces).toEqual({ b_1: 'mark', b_2: 'clear' });
      expect(f.main.marks).toEqual({ measure: { only: 'ground', twin: LIGHT.measure } });
      expect(f.triad.arrows).toEqual([0xff6b6b, 0xff6b6b, 0x4cd07d, 0x4cd07d, 0x6f9bff, 0x6f9bff]);
      // And the next picture is LIGHT again.
      gl.seen.length = 0;
      snap(h);
      const pic = gl.seen.filter((s) => s.toTarget);
      expect([pic[0].clear, pic[0].edges.b_1, pic[1].arrows[0]]).toEqual([0xf0f2f7, 0x0a0b0e, 0xd42828]);
      expect([pic[0].surfaces.b_1, pic[0].marks.measure]).toEqual(['off', { only: 'all', twin: null }]);
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
