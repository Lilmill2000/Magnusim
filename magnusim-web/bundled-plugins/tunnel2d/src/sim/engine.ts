// The running tunnel: the scene turned into a lattice, bodies and their motion, the
// frame loop (steps per frame fitted to the GPU), the drawing, and what the UI reads
// back (speed, Reynolds numbers, forces, the field's range, trouble).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColormapName } from '@magnusim/plugin-ui';
import { outline, referenceLength } from '../geometry/shapes';
import { bakeSdf, type SdfGrid } from '../geometry/sdf';
import { radius, transform } from '../geometry/polygon';
import { Renderer, type Palette, type ViewXform } from '../render/renderer';
import { FLUIDS, type Body, type FieldMode, type Resolution, type Scene } from '../scene/scene';
import { MAX_BODIES, MAX_STEPS } from './kernels';
import { FIELD_MODES, Solver, type FrameResult, type GpuBody } from './solver';
import { SMAG_CS, latticeMap, reynolds, type LatticeMap } from './units';

/** Cells in the lattice for each resolution (the grid keeps the tunnel's aspect). */
export const RESOLUTION_CELLS: Record<Exclude<Resolution, 'auto'>, number> = {
  low: 512 * 256,
  medium: 1024 * 512,
  high: 1536 * 768,
  ultra: 2048 * 1024,
};
/** A body's wall moves at most this fast (cells per step): the lattice's Mach limit. */
export const WALL_SPEED_MAX = 0.05;
/** A spinning body's edge moves at most this fast (cells per step): twice the inflow speed. */
export const SPIN_TIP_MAX = 0.1;
/** Target GPU time per frame (ms) when running as fast as possible. */
const FRAME_BUDGET_MS = 12;

export const FIELD_COLORMAP: Record<FieldMode, ColormapName> = { vorticity: 'balance', speed: 'viridis', pressure: 'balance', schlieren: 'viridis' };

export function gridFor(scene: Scene, cells: number): { nx: number; ny: number } {
  const { length, height } = scene.tunnel;
  let nx = Math.round(Math.sqrt((cells * length) / height));
  let ny = Math.round(cells / nx);
  nx = Math.max(32, Math.min(8192, nx));
  ny = Math.max(16, Math.min(8192, ny));
  return { nx, ny };
}

export interface Stats {
  adapter: string;
  nx: number;
  ny: number;
  stepsPerFrame: number;
  mlups: number;
  /** Simulated seconds per wall-clock second. */
  speedRatio: number;
  simTime: number;
  fps: number;
  map: LatticeMap | null;
  state: 'running' | 'paused' | 'unstable';
}

export interface BodyLive {
  /** Pose the flow sees now (m, degrees nose up). */
  x: number;
  y: number;
  angle: number;
  /** Mean force over the last frames (N per metre of span), and the coefficients. */
  fx: number;
  fy: number;
  cd: number;
  cl: number;
}

interface BodyState {
  body: Body;
  key: string;
  sdf: SdfGrid;
  rCells: number;
  /** Lattice pose now. */
  pose: { x: number; y: number; theta: number };
  spinAngle: number;
  fxEma: number;
  fyEma: number;
  /** Forces per step for the tests (lattice units), the most recent first trimmed. */
  history: number[];
}

type Listener = () => void;

let benchCache: number | null = null;

export class Engine {
  readonly device: GPUDevice;
  readonly adapterName: string;
  readonly canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private solver: Solver | null = null;
  private scene: Scene | null = null;
  private map: LatticeMap | null = null;
  private bodies = new Map<string, BodyState>();
  private order: string[] = [];
  private targets = new Map<string, { x: number; y: number; angle: number }>();
  private raf = 0;
  private stepsTarget = 64;
  private gpuMs = 0;
  private lastFrame = 0;
  private fpsEma = 0;
  private readPending = false;
  private sampledAt = 0;
  private listeners = new Set<Listener>();
  private range = { lo: -10, hi: 10 };
  private autoRange = { lo: -10, hi: 10, ready: false };
  private gridKey = '';
  private rangeField: FieldMode | null = null;
  /** The free stream's density (lattice), the reference for Cp. */
  private rhoRef = 1;
  private physKey = '';
  paused = false;
  unstable = false;
  palette: Palette;
  /** What the canvas shows: the world point at its centre (m), metres per CSS pixel, its size. */
  worldView = { cx: 4, cy: 2, mpp: 0.01, w: 800, h: 400, dpr: 1 };
  simTime = 0;
  stats: Stats;
  /** Every step's force per body, kept for tests (window.__TUNNEL__), off by default. */
  recordForces = false;
  onUnstable: (() => void) | null = null;
  /** Where the flow first went wrong (world metres) and the bodies' poses then. */
  unstableAt: { x: number; y: number; poses: { id: string; x: number; y: number; angle: number }[] } | null = null;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, adapterName: string, palette: Palette) {
    this.device = device;
    this.adapterName = adapterName;
    this.palette = palette;
    this.canvas = canvas;
    this.renderer = new Renderer(device, canvas);
    this.stats = { adapter: adapterName, nx: 0, ny: 0, stepsPerFrame: 0, mlups: 0, speedRatio: 0, simTime: 0, fps: 0, map: null, state: 'running' };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get solverReady() {
    return !!this.solver;
  }
  get lattice() {
    return this.map;
  }
  get grid() {
    return this.solver ? { nx: this.solver.nx, ny: this.solver.ny } : null;
  }

  /** Million lattice updates per second on this GPU (a short run; once per page). */
  async benchmark(): Promise<number> {
    if (benchCache !== null) return benchCache;
    const s = new Solver(this.device, { nx: 1024, ny: 512, walls: 'slip' });
    s.setPhysics({ u: 0.05, tau: 0.51, smagorinsky: true, smagCs: SMAG_CS });
    const run = async (steps: number) => {
      const enc = this.device.createCommandEncoder();
      s.encodeFrame(enc, steps, { mode: 0, uRef: 0.05, lRef: 50 });
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    };
    await run(50);
    const t0 = performance.now();
    await run(400);
    const ms = performance.now() - t0;
    s.destroy();
    benchCache = (1024 * 512 * 400) / (ms / 1000) / 1e6;
    return benchCache;
  }

  /** The grid a resolution gives (auto: the largest that moves the flow at least 0.4 tunnel lengths a second). */
  async cellsFor(res: Resolution, scene: Scene): Promise<number> {
    if (res !== 'auto') return RESOLUTION_CELLS[res];
    const mlups = await this.benchmark();
    const order: Exclude<Resolution, 'auto'>[] = ['ultra', 'high', 'medium', 'low'];
    for (const r of order) {
      const { nx } = gridFor(scene, RESOLUTION_CELLS[r]);
      const need = (8 * nx * RESOLUTION_CELLS[r]) / 1e6;
      if (mlups >= need) return RESOLUTION_CELLS[r];
    }
    return RESOLUTION_CELLS.low;
  }

  /** Apply a scene: a new grid when the tunnel or resolution changed, new bodies, new physics. */
  async setScene(scene: Scene) {
    this.scene = scene;
    const cells = await this.cellsFor(scene.tunnel.resolution, scene);
    if (this.scene !== scene) return; // a newer scene came while benchmarking
    const { nx, ny } = gridFor(scene, cells);
    const gridKey = `${nx}x${ny}|${scene.tunnel.walls}|${scene.tunnel.length}`;
    if (gridKey !== this.gridKey) {
      this.solver?.destroy();
      this.solver = new Solver(this.device, { nx, ny, walls: scene.tunnel.walls });
      this.gridKey = gridKey;
      this.bodies.clear();
      this.physKey = '';
      this.simTime = 0;
      this.unstable = false;
      this.autoRange.ready = false;
      this.rhoRef = 1;
    }
    const fluid = FLUIDS[scene.flow.fluid];
    this.map = latticeMap(scene.tunnel.length, nx, scene.flow.speed, fluid.nu);
    const physKey = `${this.map.u}|${this.map.tau}|${this.map.smagorinsky}`;
    if (physKey !== this.physKey) {
      this.solver!.setPhysics({ u: this.map.u, tau: this.map.tau, smagorinsky: this.map.smagorinsky, smagCs: SMAG_CS });
      if (!this.physKey) this.solver!.reset(this.map.u);
      this.physKey = physKey;
    }
    this.syncBodies(scene);
    this.emit();
  }

  private syncBodies(scene: Scene) {
    const dx = this.map!.dx;
    const live = scene.bodies.filter((b) => b.enabled).slice(0, MAX_BODIES);
    const keep = new Set(live.map((b) => b.id));
    for (const id of [...this.bodies.keys()]) if (!keep.has(id)) this.bodies.delete(id);
    for (const b of live) {
      const key = `${JSON.stringify(b.shape)}@${dx}`;
      const st = this.bodies.get(b.id);
      const target = this.targetPose(b);
      if (!st || st.key !== key) {
        const local = transform(outline(b.shape), { x: 0, y: 0, theta: 0 }, 1 / dx);
        const sdf = bakeSdf(local);
        this.bodies.set(b.id, {
          body: b,
          key,
          sdf,
          rCells: radius(local),
          pose: st?.pose ?? target,
          spinAngle: st?.spinAngle ?? 0,
          fxEma: 0,
          fyEma: 0,
          history: [],
        });
      } else {
        st.body = b;
      }
    }
    this.order = live.map((b) => b.id);
  }

  /** Where a body should be (lattice), from the scene or a drag in progress. */
  private targetPose(b: Body): { x: number; y: number; theta: number } {
    const dx = this.map!.dx;
    const t = this.targets.get(b.id);
    const x = t?.x ?? b.x;
    const y = t?.y ?? b.y;
    const angle = t?.angle ?? b.angle;
    const spin = this.bodies.get(b.id)?.spinAngle ?? 0;
    return { x: x / dx - 0.5, y: y / dx - 0.5, theta: (-angle * Math.PI) / 180 + spin };
  }

  /** A drag in progress (world metres, degrees) or null to follow the scene again. */
  setTarget(id: string, t: { x: number; y: number; angle: number } | null) {
    if (t) this.targets.set(id, t);
    else this.targets.delete(id);
  }

  /** The pose the flow sees for a body now (world metres, degrees nose up). */
  livePose(id: string): { x: number; y: number; angle: number } | null {
    const st = this.bodies.get(id);
    if (!st || !this.map) return null;
    const dx = this.map.dx;
    return { x: (st.pose.x + 0.5) * dx, y: (st.pose.y + 0.5) * dx, angle: (-(st.pose.theta - st.spinAngle) * 180) / Math.PI };
  }

  bodyLive(id: string): BodyLive | null {
    const st = this.bodies.get(id);
    const pose = this.livePose(id);
    if (!st || !pose || !this.map || !this.scene) return null;
    const fluid = FLUIDS[this.scene.flow.fluid];
    // Lattice force per step -> N per metre span: F = f * rho * dx^2 * (dx/dt)^2 / dx ... (2D: per unit depth).
    const u = this.map.u;
    const q = 0.5 * u * u * (referenceLength(st.body.shape) / this.map.dx);
    const toN = (fl: number) => (fl / q) * 0.5 * fluid.rho * this.scene!.flow.speed ** 2 * referenceLength(st.body.shape);
    return { ...pose, fx: toN(st.fxEma), fy: toN(st.fyEma), cd: st.fxEma / q, cl: st.fyEma / q };
  }

  /** The fastest spin (rad/s) a body may turn at: its edge at SPIN_TIP_MAX. Null before the grid is set. */
  spinCap(id: string): number | null {
    const st = this.bodies.get(id);
    if (!st || !this.map) return null;
    return SPIN_TIP_MAX / Math.max(1, st.rCells) / this.map.dt;
  }

  forceHistory(id: string): number[] {
    return this.bodies.get(id)?.history ?? [];
  }

  reynoldsFor(b: Body): { real: number; sim: number } | null {
    if (!this.map || !this.scene) return null;
    return reynolds(this.map, referenceLength(b.shape), this.scene.flow.speed, FLUIDS[this.scene.flow.fluid].nu);
  }

  resetFlow() {
    if (!this.solver || !this.map) return;
    this.solver.reset(this.map.u);
    this.simTime = 0;
    this.rhoRef = 1;
    this.unstable = false;
    for (const st of this.bodies.values()) {
      st.fxEma = 0;
      st.fyEma = 0;
      st.history = [];
    }
    this.emit();
  }

  setColormap(name: ColormapName) {
    this.renderer.setColormap(name);
  }

  /** The automatic colour range (dimensionless) once the field has been sampled. */
  get autoRangeNow() {
    return this.autoRange.ready ? { lo: this.autoRange.lo, hi: this.autoRange.hi } : null;
  }

  setRange(lo: number, hi: number) {
    this.range = { lo, hi };
  }

  start() {
    if (this.raf) return;
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Reference length (cells) for the dimensionless vorticity: the first body's, or an eighth of the height. */
  private lRefCells(): number {
    const first = this.order.length ? this.bodies.get(this.order[0]) : null;
    if (first && this.map) return referenceLength(first.body.shape) / this.map.dx;
    return this.solver ? this.solver.ny / 8 : 50;
  }

  private frame(now: number) {
    const solver = this.solver;
    const scene = this.scene;
    const map = this.map;
    if (!solver || !scene || !map) return;
    const wall = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + (1000 / Math.max(1, wall)) * 0.1 : 60;

    let steps = this.paused || this.unstable ? 0 : Math.round(this.stepsTarget);
    if (steps > 0 && scene.view.speed === 'realtime') steps = Math.max(1, Math.min(steps, Math.round(wall / 1000 / map.dt)));
    steps = Math.min(MAX_STEPS, steps);

    // Bodies: each moves toward its target at the wall-speed limit (teleports while paused).
    const gpuBodies: GpuBody[] = [];
    for (const id of this.order) {
      const st = this.bodies.get(id)!;
      if (steps > 0 && st.body.spin) {
        const cap = this.spinCap(st.body.id) ?? Infinity;
        st.spinAngle += Math.sign(st.body.spin) * Math.min(Math.abs(st.body.spin), cap) * map.dt * steps;
      }
      const to = this.targetPose(st.body);
      const from = { ...st.pose };
      if (steps === 0) {
        st.pose = to;
      } else {
        const maxMove = WALL_SPEED_MAX * steps;
        const dxp = to.x - from.x;
        const dyp = to.y - from.y;
        const dist = Math.hypot(dxp, dyp);
        const k = dist > maxMove ? maxMove / dist : 1;
        let dth = to.theta - from.theta;
        const maxTurn = (WALL_SPEED_MAX * steps) / Math.max(1, st.rCells);
        if (Math.abs(dth) > maxTurn) dth = Math.sign(dth) * maxTurn;
        st.pose = { x: from.x + dxp * k, y: from.y + dyp * k, theta: from.theta + dth };
      }
      gpuBodies.push({ key: `${id}:${st.key}`, sdf: st.sdf, from: steps === 0 ? st.pose : from, to: st.pose });
    }
    solver.setBodies(gpuBodies);

    const mode = FIELD_MODES[scene.view.field];
    const enc = this.device.createCommandEncoder();
    if (scene.view.field !== this.rangeField) {
      // A new field: its own range from scratch (never blended with the last field's).
      this.rangeField = scene.view.field;
      this.autoRange = { lo: 0, hi: 1, ready: false };
    }
    const { readForces } = solver.encodeFrame(enc, steps, { mode, uRef: map.u, lRef: this.lRefCells(), rhoRef: this.rhoRef });
    const range = scene.view.autoRange && this.autoRange.ready ? this.autoRange : this.range;
    this.renderer.setColormap(FIELD_COLORMAP[scene.view.field]);
    this.renderer.encode(enc, solver, this.latticeView(map.dx), range, this.palette);
    const read = readForces && !this.readPending ? solver.prepareRead(enc, steps) : null;
    const t0 = performance.now();
    this.device.queue.submit([enc.finish()]);
    this.simTime += steps * map.dt;

    if (steps > 0) {
      void this.device.queue.onSubmittedWorkDone().then(() => {
        const ms = performance.now() - t0;
        this.gpuMs = this.gpuMs ? this.gpuMs * 0.8 + ms * 0.2 : ms;
        const perStep = this.gpuMs / steps;
        const want = FRAME_BUDGET_MS / Math.max(1e-4, perStep);
        this.stepsTarget = Math.max(1, Math.min(MAX_STEPS, this.stepsTarget * 0.7 + want * 0.3));
      });
    }
    if (read) {
      this.readPending = true;
      void read().then((r) => {
        this.readPending = false;
        if (r) this.takeForces(r);
      });
    }
    if (scene.view.autoRange && now - this.sampledAt > 400) {
      this.sampledAt = now;
      void solver.readSampled().then((s) => s && this.takeSample(s, scene.view.field));
    }

    this.stats = {
      adapter: this.adapterName,
      nx: solver.nx,
      ny: solver.ny,
      stepsPerFrame: steps,
      mlups: steps > 0 && this.gpuMs > 0 ? (solver.n * steps) / (this.gpuMs / 1000) / 1e6 : this.stats.mlups,
      speedRatio: (steps * map.dt) / Math.max(1e-3, wall / 1000),
      simTime: this.simTime,
      fps: this.fpsEma,
      map,
      state: this.unstable ? 'unstable' : this.paused ? 'paused' : 'running',
    };
  }

  /** When the limiter last changed a cell (performance.now()), and how many cell updates in all. */
  limitedAt = 0;
  limitedTotal = 0;

  private takeForces(r: FrameResult) {
    if (r.limited > 0) {
      this.limitedAt = performance.now();
      this.limitedTotal += r.limited;
    }
    if (r.bad > 0 && !this.unstable) {
      this.unstable = true;
      this.unstableAt = r.badCell && this.map ? { x: (r.badCell.x + 0.5) * this.map.dx, y: (r.badCell.y + 0.5) * this.map.dx, poses: this.order.map((id) => ({ id, ...this.livePose(id)! })) } : null;
      this.onUnstable?.();
      this.emit();
      return;
    }
    r.forces.forEach((f, i) => {
      const st = this.bodies.get(this.order[i]);
      if (!st || r.steps === 0) return;
      const fx = f.fx / r.steps;
      const fy = f.fy / r.steps;
      const a = Math.min(1, r.steps / 400);
      st.fxEma = st.fxEma ? st.fxEma * (1 - a) + fx * a : fx;
      st.fyEma = st.fyEma ? st.fyEma * (1 - a) + fy * a : fy;
      if (this.recordForces) {
        for (let s = 0; s < r.steps; s++) st.history.push(f.perStep[2 * s], f.perStep[2 * s + 1]);
      }
    });
  }

  private takeSample(s: Float32Array, field: FieldMode) {
    if (field !== this.rangeField) return;
    if (field === 'pressure' && this.solver && this.map) {
      // The free stream's pressure: the median of a column just past the inlet's absorbing
      // layer. Cp is drawn against it (the outlet's pressure is not the free stream's).
      const sw = this.solver.sampleW;
      const col = Math.min(sw - 1, Math.ceil((this.solver.absorbInX + this.solver.nx * 0.03) / 4));
      const c: number[] = [];
      for (let j = 0; j < this.solver.sampleH; j++) {
        const v = s[j * sw + col];
        if (Number.isFinite(v)) c.push(v);
      }
      if (c.length > 4) {
        c.sort((a, b) => a - b);
        const cp = c[Math.floor(c.length / 2)];
        this.rhoRef += cp * 1.5 * this.map.u * this.map.u;
        if (Math.abs(cp) > 0.02) return; // not settled: the next sample ranges it
      }
    }
    const vals = Array.from(s).filter((v) => Number.isFinite(v));
    if (vals.length < 16) return;
    vals.sort((a, b) => a - b);
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
    let lo: number;
    let hi: number;
    if (field === 'vorticity') {
      const abs = vals.map(Math.abs).sort((a, b) => a - b);
      const m = Math.max(1e-6, abs[Math.round(0.985 * (abs.length - 1))]);
      lo = -m;
      hi = m;
    } else if (field === 'pressure') {
      const m = Math.max(Math.abs(q(0.01)), Math.abs(q(0.99)), 1e-3);
      lo = -m;
      hi = m;
    } else {
      lo = 0;
      hi = Math.max(1e-6, q(0.995));
    }
    const a = this.autoRange.ready ? 0.3 : 1;
    this.autoRange = { lo: this.autoRange.lo * (1 - a) + lo * a, hi: this.autoRange.hi * (1 - a) + hi * a, ready: true };
    this.emit();
  }

  /** The displayed field sampled every 4 cells (dimensionless; NaN inside bodies). */
  sampleField(): Promise<Float32Array | null> {
    return this.solver ? this.solver.readSampled() : Promise.resolve(null);
  }

  /** The canvas transform in lattice cells per device pixel (cell i's centre is at (i + 0.5) dx). */
  private latticeView(dx: number): ViewXform {
    const v = this.worldView;
    const mppDev = v.mpp / v.dpr;
    return { scale: mppDev / dx, ox: (v.cx - (v.w / 2) * v.mpp) / dx - 0.5, oy: (v.cy + (v.h / 2) * v.mpp) / dx - 0.5 };
  }

  destroy() {
    this.stop();
    this.solver?.destroy();
    this.renderer.destroy();
  }
}
