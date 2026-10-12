// The GPU side of the tunnel: populations, bodies, the step loop and the readbacks.
// One instance per grid; a new grid makes a new instance.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SdfGrid } from '../geometry/sdf';
import { FORCE_FIX, FORCE_WORDS, HEALTH_SLOT, MAX_BODIES, MAX_STEPS, W, WALLS, WG, fieldShader, macroShader, stepShader } from './kernels';

export interface SimConfig {
  nx: number;
  ny: number;
  walls: keyof typeof WALLS;
  /** 0: uniform inflow; 1: parabolic (the validation channel). */
  profile?: 0 | 1;
  /** Absorbing layers at the inlet (5 %) and outlet (15 %); off only for the validation channel. */
  absorbing?: boolean;
}

export interface Physics {
  /** Lattice inflow speed. */
  u: number;
  tau: number;
  smagorinsky: boolean;
  smagCs: number;
}

/** A body for the GPU: its baked field and its pose at the start and end of the frame (cells, radians CCW). */
export interface GpuBody {
  key: string;
  sdf: SdfGrid;
  from: { x: number; y: number; theta: number };
  to: { x: number; y: number; theta: number };
}

export interface FrameResult {
  steps: number;
  /** Per body (in the order given), force summed over the frame's steps (lattice units), and per step. */
  forces: { fx: number; fy: number; perStep: Float64Array }[];
  /** Cells whose density left [0.5, 2]: the run became unstable. */
  bad: number;
  /** Cell updates the limiter changed (flow squeezed between bodies). */
  limited: number;
  /** The first such cell (lattice), for the report. */
  badCell: { x: number; y: number } | null;
}

export const FIELD_MODES = { vorticity: 0, speed: 1, pressure: 2, schlieren: 3 } as const;
const SAMPLE_STRIDE = 4;

export class Solver {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  readonly config: Required<SimConfig>;
  private device: GPUDevice;
  private f: [GPUBuffer, GPUBuffer];
  private cur = 0;
  private paramsBuf: GPUBuffer;
  private params = new ArrayBuffer(48);
  private bodiesBuf: GPUBuffer;
  private bodyData = new ArrayBuffer(MAX_BODIES * 64);
  private sdfBuf: GPUBuffer;
  private sdfKey = '';
  private sdfOffsets: number[] = [];
  private forceBuf: GPUBuffer;
  private staging: GPUBuffer[] = [];
  private stepPipe!: GPUComputePipeline;
  private stepPipeKey = '';
  private stepBG: [GPUBindGroup, GPUBindGroup] | null = null;
  private slotBGs: GPUBindGroup[] = [];
  private slotBuf: GPUBuffer;
  private macroPipe: GPUComputePipeline;
  private fieldPipe: GPUComputePipeline;
  private stepModule: GPUShaderModule;
  readonly macroBuf: GPUBuffer;
  readonly scalarBuf: GPUBuffer;
  private fieldUni: GPUBuffer;
  private sampledBuf: GPUBuffer;
  private sampledRead: GPUBuffer;
  private sampledBusy = false;
  readonly sampleW: number;
  readonly sampleH: number;
  private bodies: GpuBody[] = [];
  private physics: Physics = { u: 0.05, tau: 0.6, smagorinsky: false, smagCs: 0.1 };
  private groups: [number, number];
  private destroyed = false;
  stepsDone = 0;

  constructor(device: GPUDevice, cfg: SimConfig) {
    this.device = device;
    this.config = { profile: 0, absorbing: true, ...cfg };
    this.nx = cfg.nx;
    this.ny = cfg.ny;
    this.n = cfg.nx * cfg.ny;
    const S = GPUBufferUsage;
    const fBytes = 9 * this.n * 4;
    this.f = [device.createBuffer({ size: fBytes, usage: S.STORAGE | S.COPY_DST }), device.createBuffer({ size: fBytes, usage: S.STORAGE | S.COPY_DST })];
    this.paramsBuf = device.createBuffer({ size: 48, usage: S.UNIFORM | S.COPY_DST });
    this.bodiesBuf = device.createBuffer({ size: MAX_BODIES * 64, usage: S.STORAGE | S.COPY_DST });
    this.sdfBuf = device.createBuffer({ size: 16, usage: S.STORAGE | S.COPY_DST });
    this.forceBuf = device.createBuffer({ size: FORCE_WORDS * 4, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
    this.slotBuf = device.createBuffer({ size: MAX_STEPS * 256, usage: S.UNIFORM | S.COPY_DST });
    const slots = new Uint32Array(MAX_STEPS * 64);
    for (let s = 0; s < MAX_STEPS; s++) slots[s * 64] = s;
    device.queue.writeBuffer(this.slotBuf, 0, slots);
    this.macroBuf = device.createBuffer({ size: this.n * 16, usage: S.STORAGE });
    this.scalarBuf = device.createBuffer({ size: this.n * 4, usage: S.STORAGE });
    this.fieldUni = device.createBuffer({ size: 48, usage: S.UNIFORM | S.COPY_DST });
    this.sampleW = Math.ceil(this.nx / SAMPLE_STRIDE);
    this.sampleH = Math.ceil(this.ny / SAMPLE_STRIDE);
    this.sampledBuf = device.createBuffer({ size: this.sampleW * this.sampleH * 4, usage: S.STORAGE | S.COPY_SRC });
    this.sampledRead = device.createBuffer({ size: this.sampleW * this.sampleH * 4, usage: S.MAP_READ | S.COPY_DST });
    this.stepModule = device.createShaderModule({ code: stepShader(), label: 'tunnel step' });
    this.macroPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: macroShader(), label: 'tunnel macro' }), entryPoint: 'main' } });
    this.fieldPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: fieldShader(), label: 'tunnel field' }), entryPoint: 'main' } });
    const groups = Math.ceil(this.n / WG);
    this.groups = [Math.min(groups, 32768), Math.ceil(groups / Math.min(groups, 32768))];
    this.writeBodies();
    this.reset();
  }

  /** Uniform flow at the lattice inflow speed everywhere (bodies settle in on the first step). */
  reset(u = this.physics.u) {
    const init = new Float32Array(9 * this.n);
    const usq = 1.5 * u * u;
    for (let k = 0; k < 9; k++) {
      const cu = 3 * [0, 1, 0, -1, 0, 1, -1, -1, 1][k] * u;
      init.fill(W[k] * (1 + cu + 0.5 * cu * cu - usq), k * this.n, (k + 1) * this.n);
    }
    this.device.queue.writeBuffer(this.f[0], 0, init);
    this.device.queue.writeBuffer(this.f[1], 0, init);
    this.stepsDone = 0;
  }

  setPhysics(p: Physics) {
    this.physics = p;
    const key = `${this.config.walls}|${p.smagorinsky}`;
    if (key !== this.stepPipeKey) {
      this.stepPipe = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.stepModule, entryPoint: 'step', constants: { WALLS: WALLS[this.config.walls], SMAG: p.smagorinsky ? 1 : 0 } },
      });
      this.stepPipeKey = key;
      this.stepBG = null;
      this.slotBGs = [];
    }
  }

  private writeParams(frameSteps: number) {
    const u32 = new Uint32Array(this.params);
    const f32 = new Float32Array(this.params);
    const p = this.physics;
    u32[0] = this.nx;
    u32[1] = this.ny;
    u32[2] = this.n;
    u32[3] = this.bodies.length;
    f32[4] = 1 / p.tau;
    f32[5] = 18 * Math.SQRT2 * p.smagCs * p.smagCs;
    f32[6] = p.u;
    f32[7] = this.config.absorbing ? 0.05 : 0;
    f32[8] = this.config.absorbing ? this.absorbInX : -1;
    f32[9] = this.spongeX;
    u32[10] = Math.max(1, frameSteps);
    u32[11] = this.config.profile;
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.params);
  }

  /** Where the inlet's absorbing layer ends and the outlet's sponge starts (cells). */
  get absorbInX() {
    return this.config.absorbing ? this.nx * 0.05 : -1;
  }
  get spongeX() {
    return this.nx * 0.85;
  }

  /** The bodies in the flow; their fields are uploaded again only when a shape or the set changes. */
  setBodies(bodies: GpuBody[]) {
    if (bodies.length > MAX_BODIES) throw new Error(`At most ${MAX_BODIES} bodies are in the flow at once.`);
    this.bodies = bodies;
    const key = bodies.map((b) => b.key).join('|');
    if (key !== this.sdfKey) {
      const total = Math.max(4, bodies.reduce((s, b) => s + b.sdf.data.length, 0));
      if (this.sdfBuf.size < total * 4) {
        this.sdfBuf.destroy();
        this.sdfBuf = this.device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.stepBG = null;
        this.renderBGDirty = true;
      }
      this.sdfOffsets = [];
      let off = 0;
      for (const b of bodies) {
        this.sdfOffsets.push(off);
        this.device.queue.writeBuffer(this.sdfBuf, off * 4, b.sdf.data);
        off += b.sdf.data.length;
      }
      this.sdfKey = key;
    }
    this.writeBodies();
  }

  /** Set when the buffers a renderer binds were replaced. */
  renderBGDirty = false;

  private writeBodies() {
    const f = new Float32Array(this.bodyData);
    const u = new Uint32Array(this.bodyData);
    this.bodies.forEach((b, i) => {
      const o = i * 16;
      f[o] = b.from.x;
      f[o + 1] = b.from.y;
      f[o + 2] = b.to.x;
      f[o + 3] = b.to.y;
      f[o + 4] = b.from.theta;
      f[o + 5] = b.to.theta;
      f[o + 6] = b.sdf.bound;
      f[o + 7] = b.sdf.texel;
      f[o + 8] = b.sdf.ox;
      f[o + 9] = b.sdf.oy;
      u[o + 10] = b.sdf.w;
      u[o + 11] = b.sdf.h;
      u[o + 12] = this.sdfOffsets[i] ?? 0;
    });
    this.device.queue.writeBuffer(this.bodiesBuf, 0, this.bodyData);
  }

  get buffers() {
    return { params: this.paramsBuf, bodies: this.bodiesBuf, sdf: this.sdfBuf, scalar: this.scalarBuf };
  }

  private bindGroups() {
    if (!this.stepBG) {
      const layout = this.stepPipe.getBindGroupLayout(0);
      const bg = (a: GPUBuffer, b: GPUBuffer) =>
        this.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: a } },
            { binding: 1, resource: { buffer: b } },
            { binding: 2, resource: { buffer: this.paramsBuf } },
            { binding: 3, resource: { buffer: this.bodiesBuf } },
            { binding: 4, resource: { buffer: this.sdfBuf } },
            { binding: 5, resource: { buffer: this.forceBuf } },
          ],
        });
      this.stepBG = [bg(this.f[0], this.f[1]), bg(this.f[1], this.f[0])];
    }
    if (!this.slotBGs.length) {
      const layout = this.stepPipe.getBindGroupLayout(1);
      for (let s = 0; s < MAX_STEPS; s++) this.slotBGs.push(this.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.slotBuf, offset: s * 256, size: 16 } }] }));
    }
    return this.stepBG;
  }

  /**
   * Advance `steps` (≤ MAX_STEPS; 0 = only refresh the displayed field) with each body moving
   * from its `from` pose to its `to` pose. Encodes into `enc`; call `finish` after submitting.
   */
  encodeFrame(enc: GPUCommandEncoder, steps: number, field: { mode: number; uRef: number; lRef: number; rhoRef?: number }): { readForces: boolean } {
    const count = Math.min(MAX_STEPS, Math.max(0, Math.floor(steps)));
    this.writeParams(Math.max(1, count));
    this.writeBodies();
    const bgs = this.bindGroups();
    let readForces = false;
    if (count > 0) {
      enc.clearBuffer(this.forceBuf, 0, Math.min(FORCE_WORDS * 4, count * MAX_BODIES * 8));
      enc.clearBuffer(this.forceBuf, HEALTH_SLOT * 4, 16);
      const pass = enc.beginComputePass({ label: 'tunnel steps' });
      pass.setPipeline(this.stepPipe);
      for (let s = 0; s < count; s++) {
        pass.setBindGroup(0, bgs[this.cur]);
        pass.setBindGroup(1, this.slotBGs[s]);
        pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
        this.cur ^= 1;
      }
      pass.end();
      this.stepsDone += count;
      readForces = true;
    }
    this.encodeField(enc, field);
    return { readForces };
  }

  private encodeField(enc: GPUCommandEncoder, field: { mode: number; uRef: number; lRef: number; rhoRef?: number }) {
    const d = new ArrayBuffer(48);
    const u = new Uint32Array(d);
    const f = new Float32Array(d);
    u[0] = this.nx;
    u[1] = this.ny;
    u[2] = field.mode;
    u[3] = SAMPLE_STRIDE;
    f[4] = field.uRef;
    f[5] = field.lRef;
    f[8] = field.rhoRef ?? 1;
    u[6] = this.sampleW;
    u[7] = this.sampleH;
    this.device.queue.writeBuffer(this.fieldUni, 0, d);
    const macroBG = this.device.createBindGroup({
      layout: this.macroPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.f[this.cur] } },
        { binding: 1, resource: { buffer: this.macroBuf } },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 3, resource: { buffer: this.bodiesBuf } },
        { binding: 4, resource: { buffer: this.sdfBuf } },
      ],
    });
    const fieldBG = this.device.createBindGroup({
      layout: this.fieldPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.macroBuf } },
        { binding: 1, resource: { buffer: this.scalarBuf } },
        { binding: 2, resource: { buffer: this.fieldUni } },
        { binding: 3, resource: { buffer: this.sampledBuf } },
      ],
    });
    const pass = enc.beginComputePass({ label: 'tunnel field' });
    pass.setPipeline(this.macroPipe);
    pass.setBindGroup(0, macroBG);
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    pass.setPipeline(this.fieldPipe);
    pass.setBindGroup(0, fieldBG);
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    pass.end();
  }

  /**
   * Copy the frame's forces and health into a staging buffer (encode before submitting);
   * the returned function, called after the submit, resolves when the GPU is done.
   */
  prepareRead(enc: GPUCommandEncoder, steps: number): () => Promise<FrameResult | null> {
    const count = Math.min(MAX_STEPS, steps);
    const bytes = count * MAX_BODIES * 8;
    let st = this.staging.pop();
    if (!st) st = this.device.createBuffer({ size: FORCE_WORDS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.forceBuf, 0, st, 0, bytes);
    enc.copyBufferToBuffer(this.forceBuf, HEALTH_SLOT * 4, st, HEALTH_SLOT * 4, 16);
    const buf = st;
    return async () => {
      try {
        await buf.mapAsync(GPUMapMode.READ);
      } catch {
        return null;
      }
      const v = new Int32Array(buf.getMappedRange().slice(0));
      buf.unmap();
      if (!this.destroyed) this.staging.push(buf);
      else buf.destroy();
      const forces = this.bodies.map((_, b) => {
        const perStep = new Float64Array(count * 2);
        let fx = 0;
        let fy = 0;
        for (let s = 0; s < count; s++) {
          const x = v[(s * MAX_BODIES + b) * 2] / FORCE_FIX;
          const y = v[(s * MAX_BODIES + b) * 2 + 1] / FORCE_FIX;
          perStep[2 * s] = x;
          perStep[2 * s + 1] = y;
          fx += x;
          fy += y;
        }
        return { fx, fy, perStep };
      });
      const first = v[HEALTH_SLOT] > 0 ? this.n - v[HEALTH_SLOT + 1] : -1;
      return { steps: count, forces, bad: v[HEALTH_SLOT], limited: v[HEALTH_SLOT + 2], badCell: first >= 0 ? { x: first % this.nx, y: Math.floor(first / this.nx) } : null };
    };
  }

  /** The displayed field sampled every SAMPLE_STRIDE cells (bodies as NaN), or null while a read is on. */
  async readSampled(): Promise<Float32Array | null> {
    if (this.sampledBusy || this.destroyed) return null;
    this.sampledBusy = true;
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.sampledBuf, 0, this.sampledRead, 0, this.sampledRead.size);
      this.device.queue.submit([enc.finish()]);
      await this.sampledRead.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(this.sampledRead.getMappedRange().slice(0));
      this.sampledRead.unmap();
      for (let i = 0; i < out.length; i++) if (out[i] > 1e29) out[i] = NaN;
      return out;
    } catch {
      return null;
    } finally {
      this.sampledBusy = false;
    }
  }

  destroy() {
    this.destroyed = true;
    for (const b of [...this.f, this.paramsBuf, this.bodiesBuf, this.sdfBuf, this.forceBuf, this.slotBuf, this.macroBuf, this.scalarBuf, this.fieldUni, this.sampledBuf, ...this.staging]) b.destroy();
    this.staging = [];
  }
}
