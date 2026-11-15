// Draws the tunnel on a WebGPU canvas: the displayed field through a colour map (the
// app's colour maps, from the UI kit) or a plain background, the absorbing zones tinted,
// the dye, the particles' trail texture, velocity arrows and the bodies (filled and
// outlined from their distance fields, smooth at any zoom); then anything drawn into the
// same pass after it (the streamlines).
// SPDX-License-Identifier: GPL-3.0-or-later
import { colormapRgb, type ColormapName } from '@magnusim/plugin-ui';
import { INFERNO } from './inferno';

/** The kit's colour maps, and inferno (the particles view's). */
export type MapName = ColormapName | 'inferno';

/** A colour map as 256 RGB entries (0..255). */
export function mapRgb(name: MapName): Uint8Array {
  return name === 'inferno' ? INFERNO : colormapRgb(name);
}
import { renderShader } from '../sim/kernels';
import type { Solver } from '../sim/solver';

export interface ViewXform {
  /** Lattice cells per device pixel. */
  scale: number;
  /** Lattice coordinates of the canvas's top-left device pixel. */
  ox: number;
  oy: number;
}

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

export interface Palette {
  bg: RGB;
  body: RGB;
  edge: RGB;
  zone: RGBA;
  /** The background when no field is shown (particles and dye on their own). */
  plain: RGB;
  arrow: RGBA;
}

export interface Overlays {
  plain: boolean;
  arrows: boolean;
  /** Arrow grid spacing (cells). */
  arrowCells: number;
  /** Lattice inflow speed (arrow length scale). */
  uRef: number;
  dye: GPUBuffer | null;
  dyeColors: RGBA[];
  trail: GPUTexture | null;
  /** The rheoscopic field and its lighting, when that view is on. */
  rheo: { field: GPUBuffer; look: RheoLook; sparkle: [number, number] } | null;
  /** A refinement patch's own field (its cells per lattice cell, grid and rectangle in lattice cells). */
  patch?: { scalar: GPUBuffer; scale: number; nx: number; ny: number; x0: number; y0: number; x1: number; y1: number } | null;
}

/** A rheoscopic look: the tank's dark base and two lights (direction xyz, colour rgb, diffuse strength). */
export interface RheoLook {
  base: RGB;
  l1: { dir: [number, number, number]; color: RGB; diffuse: number };
  l2: { dir: [number, number, number]; color: RGB; diffuse: number };
  /** Glint sharpness (exponent) and strength. */
  sharp: number;
  glint: number;
}

/**
 * How a frame reaches the screen. 'canvas': the canvas's own WebGPU context, always in the
 * app. 'readback': the frame is drawn into a texture of its own, read back and put on the
 * canvas as a 2D picture, pixel for pixel the same, one frame behind. The browser tests on
 * GitHub's Linux runners use it: Chrome there has no GPU and cannot show a WebGPU canvas at
 * all (it loses its GPU process or draws nothing), while it computes and reads back fine.
 */
export type Present = 'canvas' | 'readback';

/** A read-back frame on its way to the 2D canvas. */
interface Readback {
  buf: GPUBuffer;
  w: number;
  h: number;
  /** Bytes per row in the buffer (a multiple of 256). */
  bpr: number;
  busy: boolean;
}

export class Renderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private ctx: GPUCanvasContext | null = null;
  private g2d: CanvasRenderingContext2D | null = null;
  private target: GPUTexture | null = null;
  private readbacks: Readback[] = [];
  /** The read-back this frame copied into, until shown() hands it on. */
  private copied: Readback | null = null;
  readonly present: Present;
  readonly format: GPUTextureFormat;
  private pipe: GPURenderPipeline;
  private viewBuf: GPUBuffer;
  private lutBuf: GPUBuffer;
  private lutName = '';
  private dummyBuf: GPUBuffer;
  private dummyTex: GPUTexture;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, present: Present = 'canvas') {
    this.device = device;
    this.canvas = canvas;
    this.present = present;
    if (present === 'readback') {
      const g = canvas.getContext('2d');
      if (!g) throw new Error('The canvas has no 2D context.');
      this.g2d = g;
      // RGBA bytes in the order a 2D canvas takes them.
      this.format = 'rgba8unorm';
    } else {
      const ctx = canvas.getContext('webgpu');
      if (!ctx) throw new Error('The canvas has no WebGPU context.');
      this.ctx = ctx;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    }
    const module = device.createShaderModule({ code: renderShader(), label: 'tunnel render' });
    this.pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.viewBuf = device.createBuffer({ size: 336, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lutBuf = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.dummyBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE });
    this.dummyTex = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  setColormap(name: MapName) {
    if (name === this.lutName) return;
    const rgb = mapRgb(name);
    const count = rgb.length / 3;
    const lut = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const j = Math.min(count - 1, Math.round((i / 255) * (count - 1)));
      lut[4 * i] = rgb[3 * j] / 255;
      lut[4 * i + 1] = rgb[3 * j + 1] / 255;
      lut[4 * i + 2] = rgb[3 * j + 2] / 255;
      lut[4 * i + 3] = 1;
    }
    this.device.queue.writeBuffer(this.lutBuf, 0, lut);
    this.lutName = name;
  }

  /** The colour map now set (256 vec4), for particles coloured by the field. */
  get lut(): GPUBuffer {
    return this.lutBuf;
  }
  /** Small buffers to bind where nothing else is. */
  get dummies() {
    return { scalar: this.dummyBuf, lut: this.lutBuf };
  }

  /** The canvas's size in device pixels. */
  get size() {
    if (!this.ctx) return { w: Math.max(1, this.canvas.width), h: Math.max(1, this.canvas.height) };
    const t = this.ctx.getCurrentTexture();
    return { w: t.width, h: t.height };
  }

  /** Read back: a frame is still on its way to the canvas (the engine draws no new one meanwhile). */
  get waiting(): boolean {
    return this.readbacks.some((r) => r.busy);
  }

  /** Where this frame is drawn: the canvas's texture, or (read back) a texture of the canvas's size. */
  private frameTexture(): GPUTexture {
    if (this.ctx) return this.ctx.getCurrentTexture();
    const { w, h } = this.size;
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.destroy();
      this.target = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'tunnel frame' });
    }
    return this.target;
  }

  /** Read back: copy the frame just drawn into a free buffer (none free: this frame is not shown, the next one is). */
  private copyOut(enc: GPUCommandEncoder) {
    const t = this.target;
    if (!t) return;
    const w = t.width;
    const h = t.height;
    const bpr = Math.ceil((w * 4) / 256) * 256;
    let r = this.readbacks.find((x) => !x.busy && x.w === w && x.h === h);
    if (!r) {
      if (this.readbacks.filter((x) => x.busy).length >= 2) return;
      for (const x of this.readbacks.filter((y) => !y.busy)) x.buf.destroy();
      this.readbacks = this.readbacks.filter((x) => x.busy);
      r = { buf: this.device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'tunnel frame read back' }), w, h, bpr, busy: false };
      this.readbacks.push(r);
    }
    enc.copyTextureToBuffer({ texture: t }, { buffer: r.buf, bytesPerRow: bpr }, [w, h]);
    r.busy = true;
    this.copied = r;
  }

  /**
   * After the frame's submit. On the canvas: shown already, null. Read back: a promise that
   * settles true once the frame is on the canvas (false when it was not copied, or the canvas
   * changed size meanwhile).
   */
  shown(): Promise<boolean> | null {
    if (this.ctx) return null;
    const r = this.copied;
    this.copied = null;
    if (!r) return Promise.resolve(false);
    return r.buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const src = new Uint8Array(r.buf.getMappedRange());
        const g = this.g2d;
        let drawn = false;
        if (g && this.canvas.width === r.w && this.canvas.height === r.h) {
          const img = new ImageData(r.w, r.h);
          const row = r.w * 4;
          for (let y = 0; y < r.h; y++) img.data.set(src.subarray(y * r.bpr, y * r.bpr + row), y * row);
          // Opaque, as the WebGPU canvas is ('opaque' alpha mode).
          for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
          g.putImageData(img, 0, 0);
          drawn = true;
        }
        r.buf.unmap();
        r.busy = false;
        return drawn;
      },
      () => {
        r.busy = false;
        return false;
      },
    );
  }

  encode(enc: GPUCommandEncoder, solver: Solver, view: ViewXform, range: { lo: number; hi: number }, pal: Palette, ov: Overlays, after?: (pass: GPURenderPassEncoder) => void) {
    const b = solver.buffers;
    const bg = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: b.scalar } },
        { binding: 1, resource: { buffer: this.viewBuf } },
        { binding: 2, resource: { buffer: b.params } },
        { binding: 3, resource: { buffer: b.bodies } },
        { binding: 4, resource: { buffer: b.sdf } },
        { binding: 5, resource: { buffer: this.lutBuf } },
        { binding: 6, resource: { buffer: solver.macroBuf } },
        { binding: 7, resource: { buffer: ov.dye ?? this.dummyBuf } },
        { binding: 8, resource: (ov.trail ?? this.dummyTex).createView() },
        { binding: 9, resource: { buffer: ov.rheo?.field ?? this.dummyBuf } },
        { binding: 10, resource: { buffer: ov.patch?.scalar ?? this.dummyBuf } },
      ],
    });
    const flags = (ov.plain ? 1 : 0) | (ov.arrows ? 2 : 0) | (ov.dye ? 4 : 0) | (ov.trail ? 8 : 0) | (ov.rheo ? 16 : 0);
    const d = new ArrayBuffer(336);
    const f = new Float32Array(d);
    const u = new Uint32Array(d);
    f.set([view.scale, view.ox, view.oy, range.lo, range.hi, solver.nx, solver.ny, solver.absorbInX, solver.spongeX, ov.uRef, ov.arrowCells]);
    u[11] = flags;
    f.set([...pal.bg, 1], 12);
    f.set([...pal.body, 1], 16);
    f.set([...pal.edge, 1], 20);
    f.set(pal.zone, 24);
    f.set([...pal.plain, 1], 28);
    f.set(pal.arrow, 32);
    for (let c = 0; c < 4; c++) f.set(ov.dyeColors[c] ?? [0, 0, 0, 0], 36 + 4 * c);
    if (ov.rheo) {
      const L = ov.rheo.look;
      f.set([...L.base, 1], 52);
      f.set([...L.l1.dir, 0], 56);
      f.set([...L.l1.color, L.l1.diffuse], 60);
      f.set([...L.l2.dir, 0], 64);
      f.set([...L.l2.color, L.l2.diffuse], 68);
      f.set([L.sharp, ov.rheo.sparkle[0], ov.rheo.sparkle[1], L.glint], 72);
    }
    if (ov.patch) {
      const q = ov.patch;
      f.set([q.x0, q.y0, q.x1, q.y1, q.scale, q.nx, q.ny, 1], 76);
    }
    this.device.queue.writeBuffer(this.viewBuf, 0, d);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.frameTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: pal.bg[0], g: pal.bg[1], b: pal.bg[2], a: 1 } }],
    });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    after?.(pass);
    pass.end();
    if (!this.ctx) this.copyOut(enc);
  }

  destroy() {
    this.viewBuf.destroy();
    this.lutBuf.destroy();
    this.dummyBuf.destroy();
    this.dummyTex.destroy();
    this.target?.destroy();
    // A buffer still mapping is destroyed too (its read settles false).
    for (const r of this.readbacks) r.buf.destroy();
    this.readbacks = [];
    this.ctx?.unconfigure();
  }
}
