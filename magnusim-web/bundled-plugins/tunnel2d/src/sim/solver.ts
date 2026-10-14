// The GPU side of the tunnel: populations, bodies, the step loop and the readbacks.
// One instance per grid; a new grid makes a new instance.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SdfGrid } from '../geometry/sdf';
import { FORCE_FIX, FORCE_STRIDE, FORCE_WORDS, HEALTH_SLOT, TORQUE_FIX, MAX_BODIES, MAX_STEPS, TURB, W, WALLS, WG, fieldShader, macroShader, sampleShader, stepShader } from './kernels';
import type { Patch } from './refine';

export interface SimConfig {
  nx: number;
  ny: number;
  walls: keyof typeof WALLS;
  /** 0: uniform inflow; 1: parabolic (the validation channel). */
  profile?: 0 | 1;
  /** Absorbing layers at the inlet (5 %) and outlet (15 %); off only for the validation channel. */
  absorbing?: boolean;
  /** A refinement patch's fine grid: no domain edges (its edge cells are set by the coupling). */
  patch?: boolean;
}

export interface Physics {
  /** Lattice inflow speed. */
  u: number;
  tau: number;
  smagorinsky: boolean;
  smagCs: number;
  /**
   * Turbulence model: 'off' (resolved; τ above), 'wall' (wall functions on bodies) or 'sa'
   * (Spalart–Allmaras with wall functions: each cell's viscosity is ν + ν_t, at least nuFloor).
   */
  turb?: keyof typeof TURB;
  /** The fluid's own lattice viscosity (the wall law and SA use it). */
  nuMol?: number;
  /** The least total viscosity a cell runs at in 'sa' (what the grid can carry). */
  nuFloor?: number;
  /** 1 - the bulk relaxation rate: 0 (default) relaxes compression fully each step; below 0, at the shear's rate. */
  bulkKeep?: number;
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
  /**
   * Per body (in the order given), force summed over the frame's steps (lattice units), and per
   * step (x, y pairs); the moment about its pivot likewise (counter-clockwise positive).
   */
  forces: { fx: number; fy: number; mz: number; perStep: Float64Array; mzStep: Float64Array }[];
  /** Cells whose density left [0.5, 2]: the run became unstable. */
  bad: number;
  /** Cell updates the limiter changed (flow squeezed between bodies). */
  limited: number;
  /** The first such cell (lattice), for the report. */
  badCell: { x: number; y: number } | null;
}

/** The field pass's mode per view ('none' draws a plain background; its field is not shown). */
export const FIELD_MODES = { particles: 0, vorticity: 0, speed: 1, pressure: 2, schlieren: 3, rheoscopic: 1, none: 1 } as const;
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
  private params = new ArrayBuffer(64);
  private bodiesBuf: GPUBuffer;
  private bodyData = new ArrayBuffer(MAX_BODIES * 64);
  private sdfBuf: GPUBuffer;
  private sdfKey = '';
  private sdfOffsets: number[] = [];
  private forceBuf: GPUBuffer;
  private staging: GPUBuffer[] = [];
  private stepPipe!: GPUComputePipeline;
  private stepPipeKey = '';
  /** Step pipelines built (null: being built in the background), by their constants. */
  private pipes = new Map<string, GPUComputePipeline | null>();
  private stepBG: [GPUBindGroup, GPUBindGroup] | null = null;
  private slotBGs: GPUBindGroup[] = [];
  private slotBuf: GPUBuffer;
  private macroPipe: GPUComputePipeline;
  private fieldPipe: GPUComputePipeline;
  private stepModule: GPUShaderModule;
  /** Per-step velocity, ν̃ and total viscosity (two, swapped with the populations) while a turbulence model is on. */
  private aux: [GPUBuffer, GPUBuffer] | null = null;
  private auxDummy: [GPUBuffer, GPUBuffer];
  /** Pre-collision moments per cell (density, Π_neq), for refinement interfaces: two, swapped with the populations. */
  private mom: [GPUBuffer, GPUBuffer] | null = null;
  private momDummy: [GPUBuffer, GPUBuffer];

  /** Refinement patches inside this grid, stepped with it. */
  private children: Patch[] = [];
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
    this.config = { profile: 0, absorbing: !cfg.patch, patch: false, ...cfg };
    this.nx = cfg.nx;
    this.ny = cfg.ny;
    this.n = cfg.nx * cfg.ny;
    const S = GPUBufferUsage;
    const fBytes = 9 * this.n * 4;
    this.f = [device.createBuffer({ size: fBytes, usage: S.STORAGE | S.COPY_DST }), device.createBuffer({ size: fBytes, usage: S.STORAGE | S.COPY_DST })];
    this.paramsBuf = device.createBuffer({ size: 64, usage: S.UNIFORM | S.COPY_DST });
    this.bodiesBuf = device.createBuffer({ size: MAX_BODIES * 64, usage: S.STORAGE | S.COPY_DST });
    this.sdfBuf = device.createBuffer({ size: 16, usage: S.STORAGE | S.COPY_DST });
    this.forceBuf = device.createBuffer({ size: FORCE_WORDS * 4, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
    this.slotBuf = device.createBuffer({ size: MAX_STEPS * 256, usage: S.UNIFORM | S.COPY_DST });
    this.auxDummy = [device.createBuffer({ size: 16, usage: S.STORAGE }), device.createBuffer({ size: 16, usage: S.STORAGE })];
    this.momDummy = [device.createBuffer({ size: 16, usage: S.STORAGE }), device.createBuffer({ size: 16, usage: S.STORAGE })];
    const slots = new Uint32Array(MAX_STEPS * 64);
    for (let s = 0; s < MAX_STEPS; s++) slots[s * 64] = s;
    device.queue.writeBuffer(this.slotBuf, 0, slots);
    this.macroBuf = device.createBuffer({ size: this.n * 16, usage: S.STORAGE | S.COPY_SRC });
    this.scalarBuf = device.createBuffer({ size: this.n * 4, usage: S.STORAGE });
    this.fieldUni = device.createBuffer({ size: 48, usage: S.UNIFORM | S.COPY_DST });
    this.sampleW = Math.ceil(this.nx / SAMPLE_STRIDE);
    this.sampleH = Math.ceil(this.ny / SAMPLE_STRIDE);
    this.sampledBuf = device.createBuffer({ size: this.sampleW * this.sampleH * 4, usage: S.STORAGE | S.COPY_SRC });
    this.sampledRead = device.createBuffer({ size: this.sampleW * this.sampleH * 4, usage: S.MAP_READ | S.COPY_DST });
    this.stepModule = device.createShaderModule({ code: stepShader(this.config.patch), label: this.config.patch ? 'tunnel patch step' : 'tunnel step' });
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
      // Stored less the rest weight (see the step kernel).
      init.fill(W[k] * (cu + 0.5 * cu * cu - usq), k * this.n, (k + 1) * this.n);
    }
    this.device.queue.writeBuffer(this.f[0], 0, init);
    this.device.queue.writeBuffer(this.f[1], 0, init);
    this.resetAux(u);
    this.stepsDone = 0;
  }

  /** The free stream in the auxiliary field: the inflow, ν̃ = 3 ν (the model's usual free-stream value). */
  private resetAux(u = this.physics.u) {
    if (!this.aux) return;
    const a = new Float32Array(4 * this.n);
    const nuMol = this.physics.nuMol ?? 0;
    const nuCell = Math.max(nuMol, this.physics.nuFloor ?? 0);
    for (let i = 0; i < this.n; i++) {
      a[4 * i] = u;
      a[4 * i + 2] = 3 * nuMol;
      a[4 * i + 3] = nuCell;
    }
    this.device.queue.writeBuffer(this.aux[0], 0, a);
    this.device.queue.writeBuffer(this.aux[1], 0, a);
  }

  /** Refinement (being a patch, or holding one) needs the auxiliary field and the moments. */
  private get refining() {
    return this.config.patch || this.children.length > 0;
  }

  /** The refinement patches stepped with this grid (each made with this as its parent). */
  setPatches(children: Patch[]) {
    const was = this.refining;
    this.children = children;
    if (this.refining !== was) this.setPhysics(this.physics, true);
  }

  get patches(): readonly Patch[] {
    return this.children;
  }

  /** Bumped whenever a buffer a refinement coupling binds is replaced. */
  gen = 0;

  /** After a fill into the other population buffer: make it the current one. */
  swapCur() {
    this.cur ^= 1;
  }

  /** What a refinement coupling reads and writes: populations, auxiliary field, moments, which buffer is now. */
  get levelBuffers() {
    return { f: this.f, aux: this.aux ?? this.auxDummy, mom: this.mom ?? this.momDummy, cur: this.cur };
  }

  setPhysics(p: Physics, force = false) {
    this.physics = p;
    const turb = p.turb ?? 'off';
    const needAux = turb !== 'off' || this.refining;
    if (this.refining && !this.mom) {
      const mk = () => this.device.createBuffer({ size: 16 * this.n, usage: GPUBufferUsage.STORAGE });
      this.mom = [mk(), mk()];
      this.stepBG = null;
      this.gen++;
    } else if (!this.refining && this.mom) {
      for (const b of this.mom) b.destroy();
      this.mom = null;
      this.stepBG = null;
      this.gen++;
    }
    if (needAux && !this.aux) {
      const S = GPUBufferUsage;
      this.aux = [this.device.createBuffer({ size: 16 * this.n, usage: S.STORAGE | S.COPY_DST | S.COPY_SRC }), this.device.createBuffer({ size: 16 * this.n, usage: S.STORAGE | S.COPY_DST | S.COPY_SRC })];
      this.resetAux();
      this.stepBG = null;
      this.gen++;
    } else if (!needAux && this.aux) {
      for (const b of this.aux) b.destroy();
      this.aux = null;
      this.stepBG = null;
      this.gen++;
    }
    const bulk = p.bulkKeep ?? 0;
    const key = this.pipeKey(p.smagorinsky, turb, bulk);
    if (key !== this.stepPipeKey || force) {
      this.stepPipe = this.pipes.get(key) ?? this.device.createComputePipeline(this.pipeDesc(p.smagorinsky, turb, bulk));
      this.pipes.set(key, this.stepPipe);
      this.warmOther(p.smagorinsky, turb, bulk);
      this.stepPipeKey = key;
      this.stepBG = null;
      this.slotBGs = [];
      // A new pipeline has its own layouts: groups made for the old one no longer fit.
      this.gen++;
    }
  }

  private pipeKey(smag: boolean, turb: keyof typeof TURB, bulk: number) {
    return `${this.config.walls}|${smag}|${turb}|${bulk}|${this.config.patch}|${this.refining}`;
  }

  private pipeDesc(smag: boolean, turb: keyof typeof TURB, bulk: number): GPUComputePipelineDescriptor {
    return {
      layout: 'auto',
      compute: {
        module: this.stepModule,
        entryPoint: 'step',
        constants: {
          WALLS: WALLS[this.config.walls],
          SMAG: smag ? 1 : 0,
          TURB: TURB[turb],
          KEEP_BULK: bulk,
          PATCH: this.config.patch ? 1 : 0,
          AUXW: this.refining ? 1 : 0,
          MOMW: this.refining ? 1 : 0,
        },
      },
    };
  }

  /**
   * Build the other flow model's step pipelines in the background (the turbulence model and
   * the resolved flow, with and without its subgrid model): a switch between them (a sketch's
   * outline opening or closing, a body added to an empty tunnel) then finds its pipeline
   * ready, instead of holding the GPU while it is built.
   */
  private warmOther(smag: boolean, turb: keyof typeof TURB, bulk: number) {
    const other: [boolean, keyof typeof TURB][] = turb === 'sa' ? [[false, 'off'], [true, 'off']] : [[false, 'sa']];
    if (turb !== 'sa') other.push([!smag, 'off']);
    for (const [s, t] of other) {
      const k = this.pipeKey(s, t, bulk);
      if (this.pipes.has(k)) continue;
      this.pipes.set(k, null);
      this.device
        .createComputePipelineAsync(this.pipeDesc(s, t, bulk))
        .then((pl) => {
          if (this.pipes.get(k) === null) this.pipes.set(k, pl);
        })
        .catch(() => this.pipes.delete(k));
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
    f32[7] = this.config.absorbing || this.config.walls === 'farfield' ? 0.05 : 0;
    f32[8] = this.config.absorbing ? this.absorbInX : -1;
    f32[9] = this.spongeX;
    u32[10] = Math.max(1, frameSteps);
    u32[11] = this.config.profile;
    // The open boundary's absorbing band: 6 % of the height on each side.
    f32[12] = this.config.walls === 'farfield' ? Math.max(4, this.ny * 0.06) : 0;
    f32[13] = p.nuMol ?? 0;
    f32[14] = p.nuFloor ?? 0;
    f32[15] = 3 * (p.nuMol ?? 0);
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.params);
  }

  /** Where the inlet's absorbing layer ends and the outlet's sponge starts (cells). */
  get absorbInX() {
    return this.config.absorbing ? this.nx * 0.05 : -1;
  }
  get spongeX() {
    return this.config.patch ? 1e9 : this.nx * 0.85;
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
      f[o + 13] = b.sdf.band;
    });
    this.device.queue.writeBuffer(this.bodiesBuf, 0, this.bodyData);
  }

  get buffers() {
    return { params: this.paramsBuf, bodies: this.bodiesBuf, sdf: this.sdfBuf, scalar: this.scalarBuf };
  }

  private bindGroups() {
    if (!this.stepBG) {
      const layout = this.stepPipe.getBindGroupLayout(0);
      const aux = this.aux ?? this.auxDummy;
      const mom = this.mom ?? this.momDummy;
      const bg = (a: GPUBuffer, b: GPUBuffer, xa: GPUBuffer, xb: GPUBuffer, m: GPUBuffer) =>
        this.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: a } },
            { binding: 1, resource: { buffer: b } },
            { binding: 2, resource: { buffer: this.paramsBuf } },
            { binding: 3, resource: { buffer: this.bodiesBuf } },
            { binding: 4, resource: { buffer: this.sdfBuf } },
            { binding: 5, resource: { buffer: this.forceBuf } },
            { binding: 6, resource: { buffer: xa } },
            { binding: 7, resource: { buffer: xb } },
            { binding: 8, resource: { buffer: m } },
          ],
        });
      // The moments are written with the step's output, swapped like it.
      this.stepBG = [bg(this.f[0], this.f[1], aux[0], aux[1], mom[1]), bg(this.f[1], this.f[0], aux[1], aux[0], mom[0])];
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
  /** The most steps a frame may take: the patches' fine steps share the per-step slots. */
  get maxFrameSteps(): number {
    return Math.floor(MAX_STEPS / this.depthFactor);
  }

  /** Fine steps per step of this grid, down its deepest chain of patches (1 with none). */
  private get depthFactor(): number {
    return this.children.reduce((m, c) => Math.max(m, 2 * c.fine.depthFactor), 1);
  }

  /** Set this grid (and its patches) up for a frame of `count` steps: parameters, poses, cleared forces. */
  private beginFrame(enc: GPUCommandEncoder, count: number) {
    this.writeParams(Math.max(1, count));
    this.writeBodies();
    this.bindGroups();
    if (count > 0) {
      enc.clearBuffer(this.forceBuf, 0, Math.min(FORCE_WORDS * 4, count * MAX_BODIES * FORCE_STRIDE * 4));
      enc.clearBuffer(this.forceBuf, HEALTH_SLOT * 4, 16);
    }
    for (const c of this.children) c.fine.beginFrame(enc, 2 * count);
  }

  /** The layout of the step's group 2: a patch's edge rebuild reads its parent through it. */
  get edgeLayout(): GPUBindGroupLayout {
    return this.stepPipe.getBindGroupLayout(2);
  }

  /** One step of this grid as step `slot` of the frame (a patch's with its edge group), then its patches' coupled fine steps. */
  encodeStep(pass: GPUComputePassEncoder, slot: number, edge?: GPUBindGroup) {
    const bgs = this.bindGroups();
    pass.setPipeline(this.stepPipe);
    pass.setBindGroup(0, bgs[this.cur]);
    pass.setBindGroup(1, this.slotBGs[slot]);
    if (this.config.patch) {
      if (!edge) throw new Error('A patch steps with its edge group.');
      pass.setBindGroup(2, edge);
    }
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    this.cur ^= 1;
    this.stepsDone++;
    for (const c of this.children) c.encodeCoupled(pass, slot);
  }

  encodeFrame(enc: GPUCommandEncoder, steps: number, field: { mode: number; uRef: number; lRef: number; rhoRef?: number }): { readForces: boolean } {
    const count = Math.min(this.maxFrameSteps, Math.max(0, Math.floor(steps)));
    this.beginFrame(enc, count);
    let readForces = false;
    if (count > 0) {
      const pass = enc.beginComputePass({ label: 'tunnel steps' });
      for (let s = 0; s < count; s++) this.encodeStep(pass, s);
      pass.end();
      readForces = count > 0;
    }
    this.encodeField(enc, field);
    return { readForces };
  }

  /** The macro and field passes alone (density, velocity, the displayed scalar). */
  encodeField(enc: GPUCommandEncoder, field: { mode: number; uRef: number; lRef: number; rhoRef?: number }) {
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
    const macroBG = this.macroBindGroup();
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
    const bytes = count * MAX_BODIES * FORCE_STRIDE * 4;
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
        const mzStep = new Float64Array(count);
        let fx = 0;
        let fy = 0;
        let mz = 0;
        for (let s = 0; s < count; s++) {
          const o = (s * MAX_BODIES + b) * FORCE_STRIDE;
          const x = v[o] / FORCE_FIX;
          const y = v[o + 1] / FORCE_FIX;
          const m = v[o + 2] / TORQUE_FIX;
          perStep[2 * s] = x;
          perStep[2 * s + 1] = y;
          mzStep[s] = m;
          fx += x;
          fy += y;
          mz += m;
        }
        return { fx, fy, mz, perStep, mzStep };
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

  /**
   * The flow now, for the validation runs: per cell (velocity x, y, density, 1 in a body)
   * from the last field pass, and the turbulence model's (velocity x, y, ν̃, total ν; -1 in a body).
   */
  async readFields(): Promise<{ mac: Float32Array; aux: Float32Array | null }> {
    const bytes = this.n * 16;
    const S = GPUBufferUsage;
    const mk = () => this.device.createBuffer({ size: bytes, usage: S.MAP_READ | S.COPY_DST });
    const m = mk();
    const a = this.aux ? mk() : null;
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.macroBuf, 0, m, 0, bytes);
    if (a && this.aux) enc.copyBufferToBuffer(this.aux[this.cur], 0, a, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    const read = async (b: GPUBuffer) => {
      await b.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(b.getMappedRange().slice(0));
      b.unmap();
      b.destroy();
      return out;
    };
    const [mac, aux] = await Promise.all([read(m), a ? read(a) : Promise.resolve(null)]);
    return { mac, aux };
  }

  private rowRead: GPUBuffer | null = null;
  private sampler: { pipe: GPUComputePipeline; uni: GPUBuffer; pts: GPUBuffer; out: GPUBuffer; read: GPUBuffer; cap: number } | null = null;
  private sampleChain: Promise<unknown> = Promise.resolve();

  /**
   * The flow at points (lattice x, y pairs): per point velocity x, y, density and the fluid
   * weight found (0 inside a body), from a fresh macro pass. Reads run one after another;
   * null when the grid is gone or the read failed.
   */
  samplePoints(points: Float32Array): Promise<Float32Array | null> {
    const run = this.sampleChain.then(() => this.sampleNow(points));
    this.sampleChain = run.catch(() => undefined);
    return run;
  }

  private async sampleNow(points: Float32Array): Promise<Float32Array | null> {
    const n = points.length >> 1;
    if (this.destroyed || n === 0) return null;
    try {
      const S = GPUBufferUsage;
      if (!this.sampler || this.sampler.cap < n) {
        if (this.sampler) for (const b of [this.sampler.pts, this.sampler.out, this.sampler.read, this.sampler.uni]) b.destroy();
        const cap = Math.max(256, 1 << Math.ceil(Math.log2(n)));
        const pipe = this.sampler?.pipe ?? this.device.createComputePipeline({ layout: 'auto', compute: { module: this.device.createShaderModule({ code: sampleShader(), label: 'tunnel sample' }), entryPoint: 'main' } });
        this.sampler = {
          pipe,
          cap,
          uni: this.device.createBuffer({ size: 16, usage: S.UNIFORM | S.COPY_DST }),
          pts: this.device.createBuffer({ size: cap * 8, usage: S.STORAGE | S.COPY_DST }),
          out: this.device.createBuffer({ size: cap * 16, usage: S.STORAGE | S.COPY_SRC }),
          read: this.device.createBuffer({ size: cap * 16, usage: S.MAP_READ | S.COPY_DST }),
        };
      }
      const sp = this.sampler;
      this.device.queue.writeBuffer(sp.uni, 0, new Uint32Array([n, this.nx, this.ny, 0]));
      this.device.queue.writeBuffer(sp.pts, 0, points.buffer, points.byteOffset, n * 8);
      const enc = this.device.createCommandEncoder();
      this.encodeMacro(enc);
      const pass = enc.beginComputePass({ label: 'tunnel sample' });
      pass.setPipeline(sp.pipe);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: sp.pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.macroBuf } },
            { binding: 1, resource: { buffer: sp.pts } },
            { binding: 2, resource: { buffer: sp.out } },
            { binding: 3, resource: { buffer: sp.uni } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      enc.copyBufferToBuffer(sp.out, 0, sp.read, 0, n * 16);
      this.device.queue.submit([enc.finish()]);
      await sp.read.mapAsync(GPUMapMode.READ, 0, n * 16);
      const out = new Float32Array(sp.read.getMappedRange(0, n * 16).slice(0));
      sp.read.unmap();
      return out;
    } catch {
      return null;
    }
  }

  /** The macro pass alone (density and velocity per cell, bodies marked), for reads. */
  encodeMacro(enc: GPUCommandEncoder) {
    const pass = enc.beginComputePass({ label: 'tunnel macro' });
    pass.setPipeline(this.macroPipe);
    pass.setBindGroup(0, this.macroBindGroup());
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    pass.end();
  }

  private macroBindGroup() {
    return this.device.createBindGroup({
      layout: this.macroPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.f[this.cur] } },
        { binding: 1, resource: { buffer: this.macroBuf } },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 3, resource: { buffer: this.bodiesBuf } },
        { binding: 4, resource: { buffer: this.sdfBuf } },
      ],
    });
  }

  /** One row of the last field pass's cells (velocity, density, in a body), or null while a read is on. */
  async readRow(j: number): Promise<Float32Array | null> {
    if (this.destroyed || j < 0 || j >= this.ny) return null;
    if (this.rowRead && this.rowRead.mapState !== 'unmapped') return null;
    const bytes = this.nx * 16;
    if (!this.rowRead) this.rowRead = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const buf = this.rowRead;
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.macroBuf, j * bytes, buf, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    try {
      await buf.mapAsync(GPUMapMode.READ);
    } catch {
      return null;
    }
    const out = new Float32Array(buf.getMappedRange().slice(0));
    buf.unmap();
    return out;
  }

  destroy() {
    this.destroyed = true;
    this.rowRead?.destroy();
    if (this.sampler) for (const b of [this.sampler.pts, this.sampler.out, this.sampler.read, this.sampler.uni]) b.destroy();
    for (const b of [...(this.aux ?? []), ...this.auxDummy, ...this.momDummy, ...(this.mom ?? [])]) b.destroy();
    for (const c of this.children) c.destroy();
    for (const b of [...this.f, this.paramsBuf, this.bodiesBuf, this.sdfBuf, this.forceBuf, this.slotBuf, this.macroBuf, this.scalarBuf, this.fieldUni, this.sampledBuf, ...this.staging]) b.destroy();
    this.staging = [];
  }
}
