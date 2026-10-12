// Draws the tunnel on a WebGPU canvas: the displayed field through a colour map (the
// app's colour maps, from the UI kit), the absorbing zones tinted, and the bodies filled
// and outlined from their distance fields (smooth at any zoom).
// SPDX-License-Identifier: GPL-3.0-or-later
import { colormapRgb, type ColormapName } from '@magnusim/plugin-ui';
import { renderShader } from '../sim/kernels';
import type { Solver } from '../sim/solver';

export interface ViewXform {
  /** Lattice cells per CSS pixel... per device pixel. */
  scale: number;
  /** Lattice coordinates of the canvas's top-left device pixel. */
  ox: number;
  oy: number;
}

export interface Palette {
  bg: [number, number, number];
  body: [number, number, number];
  edge: [number, number, number];
  zone: [number, number, number, number];
}

export class Renderer {
  private device: GPUDevice;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipe: GPURenderPipeline;
  private viewBuf: GPUBuffer;
  private lutBuf: GPUBuffer;
  private lutName = '';
  private bg: GPUBindGroup | null = null;
  private bgSolver: Solver | null = null;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('The canvas has no WebGPU context.');
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: renderShader(), label: 'tunnel render' });
    this.pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.viewBuf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lutBuf = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  setColormap(name: ColormapName) {
    if (name === this.lutName) return;
    const rgb = colormapRgb(name);
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

  encode(enc: GPUCommandEncoder, solver: Solver, view: ViewXform, range: { lo: number; hi: number }, pal: Palette) {
    if (!this.bg || this.bgSolver !== solver || solver.renderBGDirty) {
      const b = solver.buffers;
      this.bg = this.device.createBindGroup({
        layout: this.pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: b.scalar } },
          { binding: 1, resource: { buffer: this.viewBuf } },
          { binding: 2, resource: { buffer: b.params } },
          { binding: 3, resource: { buffer: b.bodies } },
          { binding: 4, resource: { buffer: b.sdf } },
          { binding: 5, resource: { buffer: this.lutBuf } },
        ],
      });
      this.bgSolver = solver;
      solver.renderBGDirty = false;
    }
    const v = new Float32Array(28);
    v.set([view.scale, view.ox, view.oy, range.lo, range.hi, solver.nx, solver.ny, solver.absorbInX, solver.spongeX, 0, 0, 0]);
    v.set([...pal.bg, 1], 12);
    v.set([...pal.body, 1], 16);
    v.set([...pal.edge, 1], 20);
    v.set(pal.zone, 24);
    this.device.queue.writeBuffer(this.viewBuf, 0, v);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: pal.bg[0], g: pal.bg[1], b: pal.bg[2], a: 1 } }],
    });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bg);
    pass.draw(3);
    pass.end();
  }

  destroy() {
    this.viewBuf.destroy();
    this.lutBuf.destroy();
    this.ctx.unconfigure();
  }
}
