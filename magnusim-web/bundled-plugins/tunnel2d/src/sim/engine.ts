// The running tunnel: the scene turned into a lattice, bodies and their motion, the
// frame loop (steps per frame fitted to the GPU), the drawing, and what the UI reads
// back (speed, Reynolds numbers, forces, the field's range, trouble).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColormapName } from '@magnusim/plugin-ui';
import { hasOutline, outlineRings, referenceLength } from '../geometry/shapes';
import { bakeSdf, type SdfGrid } from '../geometry/sdf';
import { radiusRings, transformRings, type Rings } from '../geometry/polygon';
import { Renderer, type Palette, type ViewXform } from '../render/renderer';
import type { Drawn } from '../render/domain';
import { FLUIDS, LIMITS, flowModelFor, type Body, type FieldMode, type Resolution, type Scene } from '../scene/scene';
import { Dye, type DyeSource } from './dye';
import { MAX_BODIES, MAX_STEPS, PATCH_STORAGE_BUFFERS, SA_SDF_BAND, TE_MIN_CELLS } from './kernels';
import { Particles, type RakeGpu } from './particles';
import { Rheo } from './rheo';
import type { MapName, RheoLook } from '../render/renderer';
import { Streamlines } from './streamlines';
import { RefineManager } from './refineManager';
import { outerRing, splitSurface, surfacePoints, type CpPoint } from './surfaceCp';
import { FIELD_MODES, Solver, type FrameResult, type GpuBody, type Physics } from './solver';
import { GRID_RE_MAX, SMAG_CS, U_LATTICE, latticeMap, reynolds, type LatticeMap } from './units';

/** Cells in the lattice for each resolution (the grid keeps the tunnel's aspect). */
export const RESOLUTION_CELLS: Record<Exclude<Resolution, 'auto'>, number> = {
  low: 512 * 256,
  medium: 1024 * 512,
  high: 1536 * 768,
  ultra: 2048 * 1024,
};
/** A body's wall moves at most this fast (cells per step): 0.6 of the inflow speed. */
export const WALL_SPEED_MAX = 0.03;

/**
 * One frame of a critically damped follow toward a target: the gap e and its rate v after
 * t steps, with natural rate w (1/steps). Smooth starts and stops keep a dragged body from
 * slamming the fluid (every jolt is a pressure wave in a slightly compressible lattice).
 */
function follow(e0: number, v0: number, w: number, t: number): [number, number] {
  const c = v0 + w * e0;
  const decay = Math.exp(-w * t);
  return [(e0 + c * t) * decay, (c - w * (e0 + c * t)) * decay];
}
/** A spinning body's edge moves at most this fast (cells per step): twice the inflow speed. */
export const SPIN_TIP_MAX = 0.1;
/** Target GPU time per frame (ms) when running as fast as possible. */
const FRAME_BUDGET_MS = 12;

export const FIELD_COLORMAP: Record<FieldMode, MapName> = { particles: 'inferno', vorticity: 'balance', speed: 'viridis', pressure: 'balance', schlieren: 'viridis', rheoscopic: 'viridis', none: 'viridis' };
/** The tank's depth for the rheoscopic view's depth shear, as a fraction of the tunnel's height. */
const RHEO_DEPTH = 0.3;
/** Still flakes tumble back to random over this many tunnel crossings. */
const RHEO_RELAX_CROSSINGS = 1.5;

/** Tracer particles per lattice cell, by density. */
const TRACERS_PER_CELL = { low: 1 / 110, normal: 1 / 40, high: 1 / 16 } as const;
/** A GPU slower than this (million cell updates a second) gets at most LOW_GPU_TRACERS. */
const LOW_GPU_MLUPS = 3000;
const LOW_GPU_TRACERS = 40_000;
/** How much of the trail stays from one frame to the next. */
/** Tracers are short motion streaks (CSS px), drawn fresh each frame: nothing piles up. */
const STREAK_PX = { off: 0, short: 11, long: 22 } as const;
/** Spacing of the velocity arrows and of the streamlines' seeds (CSS pixels). */
const ARROW_PX = 34;
const STREAMLINE_PX = 14;

/** The colours flow markers use (from the design tokens). */
export interface MarkerColors {
  tracerDark: [number, number, number, number];
  tracerLight: [number, number, number, number];
  rakes: [number, number, number, number][];
  /** The rake colours lightened for the dark views (plain and rheoscopic). */
  rakesOnDark: [number, number, number, number][];
  streamline: [number, number, number, number];
  streamlineLight: [number, number, number, number];
}

/** The colour map a view draws its field (and, in the particles view, its particles) with. */
export function particleMap(view: Scene['view']): MapName {
  if (view.field === 'particles') return view.particleColor === 'vorticity' ? 'balance' : 'inferno';
  return FIELD_COLORMAP[view.field];
}

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
  /** Moment about the pivot (N·m per metre of span, nose up positive) and its coefficient (M / (q L²)). */
  mz: number;
  cm: number;
}

interface BodyState {
  body: Body;
  key: string;
  sdf: SdfGrid;
  /** Outline rings in lattice cells, body frame (the refinement bakes its own fields from them). */
  local: Rings;
  rCells: number;
  /** Lattice pose now. */
  pose: { x: number; y: number; theta: number };
  spinAngle: number;
  /** Its velocity now (cells per step) and turning rate (radians per step), for the smooth follow. */
  vel: { x: number; y: number; theta: number };
  fxEma: number;
  fyEma: number;
  /** Moment about the pivot (lattice, counter-clockwise positive), averaged as the forces. */
  mzEma: number;
  /**
   * Its lift averaged over a couple of passes of the flow (lattice): its circulation for the far
   * field (a shedding body's swing is damped, as its shed vortices cancel it far away).
   */
  fyMean: number;
  /** Forces per step for the tests (lattice units), the most recent first trimmed. */
  history: number[];
  /** Force coefficients through time (simulated seconds), a few dozen samples per convective time (Cm nose up positive). */
  samples: { t: number[]; cd: number[]; cl: number[]; cm: number[] };
}

/** The flow at a point, in the scene's units. */
export interface FlowReading {
  /** Velocity (m/s). */
  u: number;
  v: number;
  speed: number;
  /** Pressure against the free stream's (Pa), and as a coefficient (against ½ρU²). */
  p: number;
  cp: number;
  /** The point is inside a body (no flow there). */
  inBody: boolean;
}

/**
 * Passes of the flow past a body its far-field circulation is averaged over: short enough to
 * follow an angle change within a sweep's settling (2 % left after 8 passes), long enough to
 * damp a shedding body's lift swing (a period is about 6 passes).
 */
const FAR_FIELD_PASSES = 2;

/** Points across the free stream just past the inlet's absorbing layer: its density is the reference. */
const REF_POINTS = 16;

/** What a body's forces have done over a stretch of time (Measurement). */
export interface Measurement {
  /** Simulated seconds of samples since the flow (re)started, and those averaged. */
  since: number;
  span: number;
  cd: number;
  cl: number;
  /** Mean moment coefficient about the pivot, nose up positive. */
  cm: number;
  /** Half the lift's swing, and the shedding's Strouhal number (f D / U; null while it does not swing). */
  clAmp: number;
  st: number | null;
}

/** Samples kept per body. */
const SAMPLES_MAX = 40_000;

type Listener = () => void;

const benchCache = new Map<string, number>();
/** Below this (million lattice updates a second) a device is too slow for the full benchmark: T0's slowest GPU, an AMD iGPU, ran 425. */
const SLOW_DEVICE_MLUPS = 100;

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
  /** GPU time per step (ms), and frames in a row far slower than it (see frame()). */
  private perStepMs = 0;
  private slowFrames = 0;
  private lastFrame = 0;
  private fpsEma = 0;
  private readPending = false;
  private sampledAt = 0;
  private listeners = new Set<Listener>();
  private range = { lo: -10, hi: 10 };
  private autoRange = { lo: -10, hi: 10, ready: false };
  private gridKey = '';
  private rangeField: FieldMode | null = null;
  private rangeKey = '';
  /** The free stream's density (lattice), the reference for Cp. */
  private rhoRef = 1;
  private physKey = '';
  /** The flow model running: resolved, or Spalart–Allmaras with wall functions. */
  private turb: 'off' | 'sa' = 'off';
  /** Refinement round the bodies (levels from the scene), and the physics it scales. */
  private refine: RefineManager | null = null;
  private physics: Physics | null = null;
  paused = false;
  /** Set to run one frame's steps while paused (the "step" key). */
  private stepRequest = false;
  /** Called right after each frame is submitted (captures read the GPU canvas then). */
  afterFrame: (() => void) | null = null;

  /** Run one frame's worth of steps while paused. */
  stepOnce() {
    this.stepRequest = true;
  }
  unstable = false;
  palette: Palette;
  /** What the canvas shows: the world point at its centre (m), metres per CSS pixel, its size. */
  worldView = { cx: 4, cy: 2, mpp: 0.01, w: 800, h: 400, dpr: 1 };
  /** The frame on the canvas: its lattice view as the shader has it, its grid and size (the dark view's margins follow it). */
  drawn: Drawn | null = null;
  simTime = 0;
  stats: Stats;
  private particles: Particles;
  private dye: Dye | null = null;
  private rheo: Rheo | null = null;
  /** The rheoscopic looks (from the design tokens), by preset. */
  rheoLooks: Record<string, RheoLook> = {};
  private streamlines: Streamlines;
  private rakeGpu: RakeGpu[] = [];
  private dyeChannels = new Map<string, number>();
  private frameNo = 0;
  markerColors: MarkerColors | null = null;
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
    this.particles = new Particles(device);
    this.streamlines = new Streamlines(device, this.renderer.format);
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

  /** Million lattice updates per second on this GPU at the medium grid (a short run; once per page). */
  benchmark(): Promise<number> {
    return this.benchmarkAt(1024, 512);
  }

  /** Why refinement cannot run on this GPU, or '' (a patch's step binds more storage buffers than some GPUs allow). */
  get refineUnavailable(): string {
    const n = this.device.limits.maxStorageBuffersPerShaderStage;
    return n < PATCH_STORAGE_BUFFERS ? `This GPU lets a shader use ${n} storage buffers; refinement needs ${PATCH_STORAGE_BUFFERS}.` : '';
  }

  /** The refinement levels in force: the scene's, where the GPU allows them. */
  private refineLevels(scene: Scene): number {
    return this.refineUnavailable ? 0 : scene.tunnel.refine;
  }

  /** Cells across a body's reference length on the finest grid it is on. */
  cellsAcross(b: Body): number | null {
    if (!this.map) return null;
    const k = this.refine?.refinedIds.has(b.id) ? this.refine.scale : 1;
    return (referenceLength(b.shape) / this.map.dx) * k;
  }

  /** The refinement patches now (for tests). */
  refineInfo() {
    return this.refine?.info() ?? [];
  }

  /** The model running now. */
  get flowModel(): 'off' | 'sa' {
    return this.turb;
  }

  /**
   * Million lattice updates per second at one grid size (cached). Each size is measured
   * itself: a grid that fits the GPU's cache runs much faster per cell than one that does
   * not, so a small grid's speed says little about a big one's.
   */
  /** This device's speed from its last benchmark (million lattice updates a second), or 0. */
  private deviceMlups = 0;

  async benchmarkAt(nx: number, ny: number, turb: 'off' | 'sa' = 'off'): Promise<number> {
    const key = `${nx}x${ny}|${turb}`;
    const cached = benchCache.get(key);
    if (cached !== undefined) {
      this.deviceMlups = cached;
      return cached;
    }
    const s = new Solver(this.device, { nx, ny, walls: 'slip' });
    if (turb === 'sa') s.setPhysics({ u: U_LATTICE, tau: 0.51, smagorinsky: false, smagCs: SMAG_CS, turb: 'sa', nuMol: 1e-6, nuFloor: U_LATTICE / GRID_RE_MAX });
    else s.setPhysics({ u: U_LATTICE, tau: 0.51, smagorinsky: true, smagCs: SMAG_CS });
    const run = async (steps: number) => {
      const enc = this.device.createCommandEncoder();
      s.encodeFrame(enc, steps, { mode: 0, uRef: 0.05, lRef: 50 });
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    };
    // A first look: a device far slower than any GPU (Chrome's software adapter, a few
    // MLUPS) answers from four steps. The full run below would take it minutes, and the page
    // waits on this before it shows anything.
    await run(2);
    const tq = performance.now();
    await run(4);
    const quick = (nx * ny * 4) / (Math.max(0.1, performance.now() - tq) / 1000) / 1e6;
    if (quick < SLOW_DEVICE_MLUPS) {
      s.destroy();
      benchCache.set(key, quick);
      this.deviceMlups = quick;
      return quick;
    }
    await run(30);
    const steps = Math.max(40, Math.min(400, Math.round(2e8 / (nx * ny))));
    const t0 = performance.now();
    await run(steps);
    const ms = Math.max(0.1, performance.now() - t0);
    s.destroy();
    const mlups = (nx * ny * steps) / (ms / 1000) / 1e6;
    benchCache.set(key, mlups);
    this.deviceMlups = mlups;
    return mlups;
  }

  /**
   * The grid a resolution gives. Auto: the finest grid on which this GPU moves the flow at
   * least 0.4 tunnel lengths a second (with a quarter to spare for the markers and the
   * drawing), measured at that grid's own size, from medium upward (or down to low).
   */
  async cellsFor(res: Resolution, scene: Scene): Promise<number> {
    if (res !== 'auto') return RESOLUTION_CELLS[res];
    const turb = flowModelFor(scene);
    const fits = async (r: Exclude<Resolution, 'auto'>) => {
      const { nx, ny } = gridFor(scene, RESOLUTION_CELLS[r]);
      const need = (8 * nx * nx * ny * 1.25) / 1e6;
      return (await this.benchmarkAt(nx, ny, turb)) >= need;
    };
    if (!(await fits('medium'))) return RESOLUTION_CELLS.low;
    if (!(await fits('high'))) return RESOLUTION_CELLS.medium;
    if (!(await fits('ultra'))) return RESOLUTION_CELLS.high;
    return RESOLUTION_CELLS.ultra;
  }

  /** Apply a scene: a new grid when the tunnel or resolution changed, new bodies, new physics. */
  async setScene(scene: Scene) {
    this.scene = scene;
    const cells = await this.cellsFor(scene.tunnel.resolution, scene);
    if (this.scene !== scene) return; // a newer scene came while benchmarking
    const { nx, ny } = gridFor(scene, cells);
    const gridKey = `${nx}x${ny}|${scene.tunnel.walls}|${scene.tunnel.length}`;
    if (gridKey !== this.gridKey) {
      // Start the steps a frame where this device carries them (its speed from the last
      // benchmark, then they adapt): a slow device would spend its first frames, tens of
      // seconds each on the software adapter, on far too many.
      if (this.deviceMlups) this.stepsTarget = Math.max(1, Math.min(MAX_STEPS, (this.deviceMlups * 1e3 * FRAME_BUDGET_MS) / (nx * ny)));
      this.perStepMs = 0;
      this.refine?.clear();
      this.solver?.destroy();
      this.solver = new Solver(this.device, { nx, ny, walls: scene.tunnel.walls });
      this.refine = new RefineManager(this.device, this.solver);
      this.particles.clear();
      this.dye?.destroy();
      this.dye = null;
      this.rheo?.destroy();
      this.rheo = null;
      this.gridKey = gridKey;
      this.epoch++;
      this.bodies.clear();
      this.physKey = '';
      this.simTime = 0;
      this.unstable = false;
      this.autoRange.ready = false;
      this.rhoRef = 1;
    }
    const fluid = FLUIDS[scene.flow.fluid];
    this.map = latticeMap(scene.tunnel.length, nx, scene.flow.speed, fluid.nu);
    this.turb = flowModelFor(scene);
    const sa = this.turb === 'sa';
    const physKey = `${this.map.u}|${this.map.tau}|${this.map.smagorinsky}|${this.turb}|${this.map.nuFluid}`;
    if (physKey !== this.physKey) {
      this.physics = {
        u: this.map.u,
        tau: this.map.tau,
        smagorinsky: this.map.smagorinsky && !sa,
        smagCs: SMAG_CS,
        turb: this.turb,
        nuMol: this.map.nuFluid,
        nuFloor: this.map.nuFloor,
      };
      this.solver!.setPhysics(this.physics);
      this.refine!.setPhysics(this.physics);
      if (!this.physKey) this.solver!.reset(this.map.u);
      this.physKey = physKey;
      // Measurements start again with new physics.
      for (const st of this.bodies.values()) st.samples = { t: [], cd: [], cl: [], cm: [] };
    }
    this.syncBodies(scene);
    await this.syncMarkers(scene);
    this.emit();
  }

  /** Tracers and rakes for the GPU: pools laid out again when their number or kinds change. */
  private async syncMarkers(scene: Scene) {
    const solver = this.solver!;
    const dx = this.map!.dx;
    const mlups = await this.benchmark();
    const want = scene.view.tracers || scene.view.field === 'particles';
    let tracers = want ? Math.round(solver.n * TRACERS_PER_CELL[scene.view.density]) : 0;
    if (mlups < LOW_GPU_MLUPS) tracers = Math.min(tracers, LOW_GPU_TRACERS);
    const toCell = (v: number) => v / dx - 0.5;
    const live = scene.rakes.filter((r) => r.enabled);
    this.rakeGpu = live
      .filter((r) => r.kind !== 'dye')
      .map((r) => ({ id: r.id, kind: r.kind as RakeGpu['kind'], x0: toCell(r.x0), y0: toCell(r.y0), x1: toCell(r.x1), y1: toCell(r.y1), emitters: r.emitters, color: r.color }));
    this.particles.configure(tracers, this.rakeGpu, { nx: solver.nx, ny: solver.ny, absorbInX: Math.max(0, solver.absorbInX), outX: solver.spongeX });
    const dyeRakes = live.filter((r) => r.kind === 'dye').slice(0, LIMITS.maxDyeRakes);
    this.dyeChannels = new Map(dyeRakes.map((r, i) => [r.id, i]));
    if (dyeRakes.length) {
      if (!this.dye) {
        this.dye = new Dye(this.device, solver.nx, solver.ny);
        this.dye.clear();
      }
      const srcs: DyeSource[] = [];
      dyeRakes.forEach((r, ch) => {
        for (let e = 0; e < r.emitters; e++) {
          const t = r.emitters === 1 ? 0.5 : e / (r.emitters - 1);
          srcs.push({ x: toCell(r.x0 + (r.x1 - r.x0) * t), y: toCell(r.y0 + (r.y1 - r.y0) * t), channel: ch });
        }
      });
      this.dye.setSources(srcs);
    } else if (this.dye) {
      this.dye.destroy();
      this.dye = null;
    }
  }

  /** The dye channel of each dye rake (by id). */
  get dyeChannelOf(): ReadonlyMap<string, number> {
    return this.dyeChannels;
  }

  /** Every particle (for tests): positions and meta, and which pools are whose. */
  async readParticles() {
    const r = await this.particles.read();
    return r ? { ...r, tracers: this.particles.tracerCount, pools: this.particles.pools, dx: this.map?.dx ?? 0 } : null;
  }

  async readDye() {
    return this.dye ? { data: await this.dye.read(), nx: this.dye.nx, ny: this.dye.ny, channels: Object.fromEntries(this.dyeChannels), dx: this.map?.dx ?? 0 } : null;
  }

  /** The flake-orientation field, summed up (for tests): mean of Q's diagonal and of |Q_xy|, its spread, NaNs. */
  async readRheo() {
    if (!this.rheo) return null;
    const d = await this.rheo.read();
    const n = this.rheo.nx * this.rheo.ny;
    let zz = 0;
    let xy = 0;
    let nan = 0;
    let tr = 0;
    let min = Infinity;
    let max = -Infinity;
    // A brightness proxy: Q_zz (flakes lying flat face the eye).
    for (let k = 0; k < n; k++) {
      const v = d.slice(8 * k, 8 * k + 6);
      if (!v.every(Number.isFinite)) {
        nan++;
        continue;
      }
      zz += v[2];
      xy += Math.abs(v[3]);
      tr += v[0] + v[1] + v[2];
      min = Math.min(min, v[2]);
      max = Math.max(max, v[2]);
    }
    const ok = Math.max(1, n - nan);
    return { meanZZ: zz / ok, meanAbsXY: xy / ok, meanTrace: tr / ok, minZZ: min, maxZZ: max, nan, nx: this.rheo.nx, ny: this.rheo.ny, data: null as Float32Array | null };
  }

  get streamlineCount() {
    return this.scene?.view.streamlines ? this.streamlines.count : 0;
  }

  private syncBodies(scene: Scene) {
    const dx = this.map!.dx;
    // A sketch with no closed loop yet has no outline: it stays out of the flow (its panel says why).
    const live = scene.bodies.filter((b) => b.enabled && hasOutline(b.shape)).slice(0, MAX_BODIES);
    const keep = new Set(live.map((b) => b.id));
    for (const id of [...this.bodies.keys()]) if (!keep.has(id)) this.bodies.delete(id);
    for (const b of live) {
      // The turbulence model reads the wall distance farther out: a wider band.
      const band = this.turb === 'sa' ? SA_SDF_BAND : undefined;
      // Trailing edges at least two cells thick on the finest grid round the body.
      const scale = 2 ** this.refineLevels(scene);
      const key = `${JSON.stringify(b.shape)}@${dx}|${band ?? ''}|${scale}`;
      const st = this.bodies.get(b.id);
      const target = this.targetPose(b);
      if (!st || st.key !== key) {
        // Drawn the same wherever they fall (shapes.thickenRear).
        const local = transformRings(outlineRings(b.shape, (TE_MIN_CELLS * dx) / scale), { x: 0, y: 0, theta: 0 }, 1 / dx);
        const sdf = bakeSdf(local, band);
        this.bodies.set(b.id, {
          body: b,
          key,
          sdf,
          local,
          rCells: radiusRings(local),
          pose: st?.pose ?? target,
          spinAngle: st?.spinAngle ?? 0,
          vel: st?.vel ?? { x: 0, y: 0, theta: 0 },
          fxEma: 0,
          fyEma: 0,
          mzEma: 0,
          fyMean: 0,
          history: [],
          samples: { t: [], cd: [], cl: [], cm: [] },
        });
      } else {
        st.body = b;
      }
    }
    const order = live.map((b) => b.id);
    // A different set of bodies: forces read for the old one must not land on the new.
    if (order.join('|') !== this.order.join('|')) this.epoch++;
    this.order = order;
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
    const L = referenceLength(st.body.shape);
    const q = 0.5 * u * u * (L / this.map.dx);
    const qRef = 0.5 * fluid.rho * this.scene!.flow.speed ** 2;
    const toN = (fl: number) => (fl / q) * qRef * L;
    // Nose up is clockwise here (the leading side is on the left, upstream).
    const cm = -st.mzEma / (q * (L / this.map.dx));
    return { ...pose, fx: toN(st.fxEma), fy: toN(st.fyEma), cd: st.fxEma / q, cl: st.fyEma / q, mz: cm * qRef * L * L, cm };
  }

  /** The fastest spin (rad/s) a body may turn at: its edge at SPIN_TIP_MAX. Null before the grid is set. */
  spinCap(id: string): number | null {
    const st = this.bodies.get(id);
    if (!st || !this.map) return null;
    return SPIN_TIP_MAX / Math.max(1, st.rCells) / this.map.dt;
  }

  /**
   * A body's mean drag and lift, lift swing and shedding frequency over the last `window`
   * simulated seconds (null until there are samples). The Strouhal number comes from the
   * times the lift crosses its mean going up.
   */
  measure(id: string, window: number): Measurement | null {
    const st = this.bodies.get(id);
    if (!st || !this.scene || !this.map) return null;
    const { t, cd, cl, cm } = st.samples;
    if (t.length < 4) return null;
    const end = t[t.length - 1];
    let i0 = t.length - 1;
    while (i0 > 0 && t[i0 - 1] >= end - window) i0--;
    const n = t.length - i0;
    if (n < 4) return null;
    let mcd = 0;
    let mcl = 0;
    let mcm = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < t.length; i++) {
      mcd += cd[i];
      mcl += cl[i];
      mcm += cm[i];
      lo = Math.min(lo, cl[i]);
      hi = Math.max(hi, cl[i]);
    }
    mcd /= n;
    mcl /= n;
    mcm /= n;
    const ups: number[] = [];
    for (let i = i0 + 1; i < t.length; i++) {
      const a = cl[i - 1] - mcl;
      const b = cl[i] - mcl;
      if (a < 0 && b >= 0) ups.push(t[i - 1] + ((t[i] - t[i - 1]) * a) / (a - b));
    }
    const amp = (hi - lo) / 2;
    let stn: number | null = null;
    // A swing worth the name (above 1 % of the drag) over at least two whole periods.
    if (ups.length >= 3 && amp > 0.01 * Math.abs(mcd)) {
      const period = (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
      stn = referenceLength(st.body.shape) / (period * this.scene.flow.speed);
    }
    return { since: end - t[0], span: end - t[i0], cd: mcd, cl: mcl, cm: mcm, clAmp: amp, st: stn };
  }

  /**
   * The recirculation behind a body: how far (in body lengths, from its rear) the flow along
   * the line through its centre runs back upstream. Null with no reversed flow there.
   */
  async wakeLength(id: string): Promise<number | null> {
    const st = this.bodies.get(id);
    const solver = this.solver;
    if (!st || !solver || !this.map) return null;
    const j = Math.round(st.pose.y);
    const row = await solver.readRow(j);
    if (!row) return null;
    const L = referenceLength(st.body.shape) / this.map.dx;
    const rear = st.pose.x + L / 2;
    let i = Math.ceil(rear);
    // Past the body and its first cells, the reversed flow (u < 0) runs to where u turns positive.
    while (i < solver.nx - 1 && row[4 * i + 3] > 0.5) i++;
    if (!(row[4 * i] < 0)) return null;
    while (i < solver.nx - 1 && row[4 * (i + 1)] < 0) i++;
    const a = row[4 * i];
    const b = row[4 * (i + 1)];
    const x = i + a / (a - b);
    return (x - rear) / L;
  }

  /** The free stream's density (lattice) from the last read: Cp and p are against it. */
  private rhoInf = 1;

  /**
   * The flow at points (lattice, main grid), each read from the finest grid that holds it,
   * with the free stream's density read in the same pass. Null while a read is on.
   */
  private async readLattice(pts: { x: number; y: number }[]): Promise<({ u: number; v: number; rho: number } | null)[] | null> {
    const solver = this.solver;
    if (!solver) return null;
    const groups = new Map<Solver, { idx: number[]; xy: number[] }>();
    const coarse = { idx: [] as number[], xy: [] as number[] };
    groups.set(solver, coarse);
    // The reference column first (index -1).
    const xr = Math.max(0, solver.absorbInX) + solver.nx * 0.03;
    for (let k = 0; k < REF_POINTS; k++) {
      coarse.idx.push(-1);
      coarse.xy.push(xr, ((k + 0.5) / REF_POINTS) * 0.8 * solver.ny + 0.1 * solver.ny);
    }
    pts.forEach((p, i) => {
      const fine = this.refine?.depth ? this.refine.finestAt(p.x, p.y) : null;
      if (fine) {
        let g = groups.get(fine.solver);
        if (!g) groups.set(fine.solver, (g = { idx: [], xy: [] }));
        const q = fine.map(p.x, p.y);
        g.idx.push(i);
        g.xy.push(q.x, q.y);
      } else {
        coarse.idx.push(i);
        coarse.xy.push(p.x, p.y);
      }
    });
    const out: ({ u: number; v: number; rho: number } | null)[] = pts.map(() => null);
    const ref: number[] = [];
    for (const [s, g] of groups) {
      if (!g.idx.length) continue;
      const r = await s.samplePoints(new Float32Array(g.xy));
      if (!r) return null;
      g.idx.forEach((i, k) => {
        const w = r[4 * k + 3];
        if (w <= 0) return;
        if (i < 0) ref.push(r[4 * k + 2]);
        else out[i] = { u: r[4 * k], v: r[4 * k + 1], rho: r[4 * k + 2] };
      });
    }
    if (ref.length) {
      ref.sort((a, b) => a - b);
      this.rhoInf = ref[ref.length >> 1];
    }
    return out;
  }

  /** The flow at world points (m). Null while a read is on or before the grid is set. */
  async readAt(points: { x: number; y: number }[]): Promise<FlowReading[] | null> {
    const map = this.map;
    const scene = this.scene;
    if (!map || !scene) return null;
    const r = await this.readLattice(points.map((p) => ({ x: p.x / map.dx - 0.5, y: p.y / map.dx - 0.5 })));
    if (!r) return null;
    const U = scene.flow.speed;
    const k = U / map.u;
    const qRef = 0.5 * FLUIDS[scene.flow.fluid].rho * U * U;
    return r.map((m) => {
      if (!m) return { u: 0, v: 0, speed: 0, p: 0, cp: 0, inBody: true };
      const cp = (m.rho - this.rhoInf) / (1.5 * map.u * map.u);
      return { u: m.u * k, v: m.v * k, speed: Math.hypot(m.u, m.v) * k, p: cp * qRef, cp, inBody: false };
    });
  }

  /**
   * The pressure coefficient round a body now: read one cell (of the grid that holds it) off
   * its outline, split into the upper and lower surfaces by x along the body from its leading
   * point (0) to its trailing one (1). Null while a read is on or without the body.
   */
  async surfaceCp(id: string): Promise<{ upper: CpPoint[]; lower: CpPoint[] } | null> {
    const st = this.bodies.get(id);
    const map = this.map;
    if (!st || !map) return null;
    const ring = outerRing(st.local);
    const fine = this.refine?.depth ? this.refine.finestAt(st.pose.x, st.pose.y) : null;
    const cell = fine ? 1 / fine.scale : 1;
    const pts = surfacePoints(ring, Math.max(0.5 * cell, 0.5), cell);
    const c = Math.cos(st.pose.theta);
    const s = Math.sin(st.pose.theta);
    const lat = pts.map((p) => ({ x: st.pose.x + c * p.px - s * p.py, y: st.pose.y + s * p.px + c * p.py }));
    const r = await this.readLattice(lat);
    if (!r) return null;
    return splitSurface(
      pts,
      r.map((m) => (m ? (m.rho - this.rhoInf) / (1.5 * map.u * map.u) : null)),
    );
  }

  /**
   * A body's circulation for the far field (cells × lattice speed, counter-clockwise positive):
   * from its mean lift, Kutta-Joukowski (L = -ρUΓ). Open tunnels only (a walled tunnel's inlet is
   * the tunnel's own); capped at a lift coefficient of 4.
   */
  private circulation(st: BodyState, scene: Scene, map: LatticeMap): number {
    if (scene.tunnel.walls !== 'farfield') return 0;
    const L = referenceLength(st.body.shape) / map.dx;
    const cap = 0.5 * map.u * map.u * L * 4;
    return -Math.max(-cap, Math.min(cap, st.fyMean)) / map.u;
  }

  /** The circulation the far field holds round each body now (tests). */
  farField(): { id: string; gamma: number; cl: number }[] {
    const map = this.map;
    const scene = this.scene;
    if (!map || !scene) return [];
    return this.order.map((id) => {
      const st = this.bodies.get(id)!;
      const L = referenceLength(st.body.shape) / map.dx;
      return { id, gamma: this.circulation(st, scene, map), cl: st.fyMean / (0.5 * map.u * map.u * L) };
    });
  }

  /** A body's coefficient samples from simulated time `from` on (copies; empty without the body). */
  samplesOf(id: string, from = 0): { t: number[]; cd: number[]; cl: number[]; cm: number[] } {
    const sm = this.bodies.get(id)?.samples;
    if (!sm) return { t: [], cd: [], cl: [], cm: [] };
    let i = sm.t.length;
    while (i > 0 && sm.t[i - 1] >= from) i--;
    return { t: sm.t.slice(i), cd: sm.cd.slice(i), cl: sm.cl.slice(i), cm: sm.cm.slice(i) };
  }

  forceHistory(id: string): number[] {
    return this.bodies.get(id)?.history ?? [];
  }

  /** The real Reynolds number and the one simulated: the real one when the turbulence model carries it. */
  reynoldsFor(b: Body): { real: number; sim: number } | null {
    if (!this.map || !this.scene) return null;
    const re = reynolds(this.map, referenceLength(b.shape), this.scene.flow.speed, FLUIDS[this.scene.flow.fluid].nu);
    if (this.turb === 'sa') return { real: re.real, sim: re.real };
    // A refined body's flow runs on cells 2^levels smaller: that much higher a Reynolds number, up to the real one.
    const k = this.refine?.refinedIds.has(b.id) ? this.refine.scale : 1;
    return { real: re.real, sim: Math.min(re.real, re.sim * k) };
  }

  resetFlow() {
    if (!this.solver || !this.map) return;
    this.solver.reset(this.map.u);
    this.epoch++;
    // The patches start again from the reset flow (rebuilt at the next frame).
    this.refine?.clear();
    this.simTime = 0;
    this.rhoRef = 1;
    this.particles.clear();
    this.dye?.clear();
    this.rheo?.reset();
    if (this.scene) void this.syncMarkers(this.scene);
    this.unstable = false;
    for (const st of this.bodies.values()) {
      st.fxEma = 0;
      st.fyEma = 0;
      st.mzEma = 0;
      st.fyMean = 0;
      st.history = [];
      st.samples = { t: [], cd: [], cl: [], cm: [] };
    }
    this.emit();
  }

  setColormap(name: ColormapName) {
    this.renderer.setColormap(name);
  }

  /** The palette of the frame: bodies dark with a light outline in the particles view (the colours of the view's own look). */
  bodyLook: { body: [number, number, number]; edge: [number, number, number] } | null = null;

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

    let steps = (this.paused && !this.stepRequest) || this.unstable ? 0 : Math.round(this.stepsTarget);
    this.stepRequest = false;
    if (steps > 0 && scene.view.speed === 'realtime') steps = Math.max(1, Math.min(steps, Math.round(wall / 1000 / map.dt)));
    // Each refinement level doubles the fine steps a frame's per-step slots must hold.
    steps = Math.min(MAX_STEPS >> this.refineLevels(scene), steps);

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
        st.vel = { x: 0, y: 0, theta: 0 };
      } else {
        // Settle over about two sound crossings of the body (at least 300 steps): slow
        // enough that the fluid around it is not jolted, quick on a fast GPU.
        const w = 1 / Math.max(300, (2 * 2 * st.rCells) / 0.577);
        const r = Math.max(1, st.rCells);
        const [ex, vx] = follow(from.x - to.x, st.vel.x, w, steps);
        const [ey, vy] = follow(from.y - to.y, st.vel.y, w, steps);
        const [et, vt] = follow(from.theta - to.theta, st.vel.theta, w, steps);
        let mx = to.x + ex - from.x;
        let my = to.y + ey - from.y;
        let mt = to.theta + et - from.theta;
        // The wall-speed limit: a frame moves at most WALL_SPEED_MAX a step, edges included.
        const move = Math.hypot(mx, my);
        if (move > WALL_SPEED_MAX * steps) {
          mx *= (WALL_SPEED_MAX * steps) / move;
          my *= (WALL_SPEED_MAX * steps) / move;
        }
        const maxTurn = (WALL_SPEED_MAX * steps) / r;
        if (Math.abs(mt) > maxTurn) mt = Math.sign(mt) * maxTurn;
        const capped = Math.hypot(mx, my) < move - 1e-9;
        st.vel = { x: capped ? mx / steps : vx, y: capped ? my / steps : vy, theta: Math.abs(mt) >= maxTurn ? mt / steps : vt };
        st.pose = { x: from.x + mx, y: from.y + my, theta: from.theta + mt };
      }
      gpuBodies.push({ key: `${id}:${st.key}`, sdf: st.sdf, from: steps === 0 ? st.pose : from, to: st.pose, gamma: this.circulation(st, scene, map) });
    }
    solver.setBodies(gpuBodies);
    const enc = this.device.createCommandEncoder();
    // Refinement: patches placed or moved for where the bodies end this frame, before its steps.
    if (this.refine) {
      const farW = scene.tunnel.walls === 'farfield' ? Math.max(4, solver.ny * 0.06) : 0;
      const bounds = { x0: Math.ceil(Math.max(0, solver.absorbInX)) + 4, y0: Math.ceil(farW) + 4, x1: Math.floor(solver.spongeX) - 4, y1: Math.floor(solver.ny - farW) - 5 };
      this.refine.update(
        enc,
        this.order.map((id, i) => {
          const st = this.bodies.get(id)!;
          return { id, key: gpuBodies[i].key, local: st.local, band: st.sdf.band, from: gpuBodies[i].from, to: gpuBodies[i].to, r: st.rCells };
        }),
        steps > 0 ? this.refineLevels(scene) : this.refine.depth,
        bounds,
      );
    }

    // The particles view colours its tracers by vorticity or speed: the field pass computes that.
    const pview = scene.view.field === 'particles';
    const mode = pview ? (scene.view.particleColor === 'vorticity' ? FIELD_MODES.vorticity : FIELD_MODES.speed) : FIELD_MODES[scene.view.field];
    const rangeKey = pview ? `particles:${scene.view.particleColor}` : scene.view.field;
    if (rangeKey !== this.rangeKey) {
      // A new field: its own range from scratch (never blended with the last field's).
      this.rangeKey = rangeKey;
      this.rangeField = pview ? (scene.view.particleColor === 'vorticity' ? 'vorticity' : 'speed') : scene.view.field;
      this.autoRange = { lo: 0, hi: 1, ready: false };
    }
    const fieldSpec = { mode, uRef: map.u, lRef: this.lRefCells(), rhoRef: this.rhoRef };
    const { readForces } = solver.encodeFrame(enc, steps, fieldSpec);
    // Inside a refinement patch the field is drawn from the patch's own, finer cells.
    const patchField = this.refine?.encodeDisplay(enc, fieldSpec) ?? null;
    const range = scene.view.autoRange && this.autoRange.ready ? this.autoRange : this.range;
    this.renderer.setColormap(particleMap(scene.view));
    const lv = this.latticeView(map.dx);
    const view = scene.view;
    const plain = view.field === 'none';
    // Markers on a dark view (plain, rheoscopic, particles) are drawn light.
    const dark = plain || view.field === 'rheoscopic' || pview;
    const mc = this.markerColors;
    const pf = { steps, u: map.u, nx: solver.nx, ny: solver.ny, absorbInX: Math.max(0, solver.absorbInX), outX: solver.spongeX, wrapY: scene.tunnel.walls === 'periodic' };
    this.particles.encodeAdvect(enc, pf, solver.macroBuf, solver.buffers);
    this.dye?.encode(enc, steps, solver.macroBuf);
    const rheoOn = view.field === 'rheoscopic';
    if (rheoOn && !this.rheo) this.rheo = new Rheo(this.device, solver.nx, solver.ny);
    if (!rheoOn && this.rheo) {
      this.rheo.destroy();
      this.rheo = null;
    }
    this.rheo?.encode(enc, steps, solver.macroBuf, {
      depthCells: solver.ny * RHEO_DEPTH,
      relaxSteps: (RHEO_RELAX_CROSSINGS * solver.nx) / map.u,
      inletX: Math.max(1, solver.absorbInX),
    });
    this.frameNo++;
    if (view.streamlines && (steps > 0 || this.frameNo % 10 === 0)) {
      const lines = scene.tunnel.height / this.worldView.mpp / STREAMLINE_PX;
      this.streamlines.encodeTrace(enc, solver.macroBuf, solver, Math.max(0, solver.absorbInX) + 1, Math.max(8, lines));
    }
    const size = this.renderer.size;
    this.drawn = { scale: Math.fround(lv.scale), ox: Math.fround(lv.ox), oy: Math.fround(lv.oy), nx: solver.nx, ny: solver.ny, w: size.w, h: size.h };
    const markers = (view.tracers || view.field === 'particles') && this.particles.tracerCount > 0;
    if (markers && mc) {
      const dpr = this.worldView.dpr;
      // In the particles view each streak takes the field's colour under it, lightened, so
      // the particles are the field's own texture; over another field they are faint marks.
      const byField = pview ? { scalar: solver.buffers.scalar, lut: this.renderer.lut, nx: solver.nx, ny: solver.ny, lo: range.lo, hi: range.hi, lift: 0.36 } : null;
      const tracer = pview ? ([1, 1, 1, 0.66] as [number, number, number, number]) : dark ? mc.tracerLight : ([...mc.tracerDark.slice(0, 3), 0.3] as [number, number, number, number]);
      this.particles.encodeDraw(
        enc,
        { ...size, dot: (pview ? 0.95 : 0.6) * dpr, tail: steps > 0 ? STREAK_PX[view.trail] * dpr : 0, taper: true },
        lv,
        0,
        { tracers: true },
        { tracer },
        byField,
        this.renderer.dummies,
      );
    }
    const dyeColors = [...this.dyeChannels.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => {
        const r = scene.rakes.find((x) => x.id === id);
        // Dye a little lighter than its rake's colour, so it reads on dark and light views.
        const c = mc?.rakesOnDark[r?.color ?? 0] ?? [0, 0, 0, 1];
        return [c[0], c[1], c[2], 0.95] as [number, number, number, number];
      });
    this.renderer.encode(
      enc,
      solver,
      lv,
      range,
      (pview || view.field === 'rheoscopic') && this.bodyLook ? { ...this.palette, ...this.bodyLook } : this.palette,
      {
        plain,
        arrows: view.arrows,
        arrowCells: (ARROW_PX * this.worldView.mpp) / map.dx,
        uRef: map.u,
        dye: this.dye ? this.dye.field : null,
        dyeColors,
        trail: markers && mc ? this.particles.trail : null,
        rheo: this.rheo && this.rheoLooks[view.rheoPreset] ? { field: this.rheo.field, look: this.rheoLooks[view.rheoPreset], sparkle: this.rheo.sparkleWeights } : null,
        patch: patchField,
      },
      mc
        ? (pass) => {
            if (view.streamlines) this.streamlines.encodeDraw(pass, size, lv, dark ? mc.streamlineLight : mc.streamline, this.worldView.dpr);
            if (this.rakeGpu.length) this.particles.encodeRakeLines(pass, this.renderer.format, size, lv, dark ? mc.rakesOnDark : mc.rakes, this.worldView.dpr);
          }
        : undefined,
    );
    const read = readForces && !this.readPending ? solver.prepareRead(enc, steps) : null;
    const tStart = this.simTime;
    const epoch = this.epoch;
    const readFine = read && this.refine?.depth ? this.refine.prepareRead(enc, steps) : null;
    const t0 = performance.now();
    this.device.queue.submit([enc.finish()]);
    this.simTime += steps * map.dt;
    this.afterFrame?.();

    if (steps > 0) {
      void this.device.queue.onSubmittedWorkDone().then(() => {
        const ms = performance.now() - t0;
        const perStep = ms / steps;
        // A frame held up by something other than its steps (shaders built for a new flow
        // model, a sketch's body baked again) says nothing about the GPU's speed: alone it
        // would drop the steps to a few and they would take seconds to climb back. Only a
        // slowdown that lasts (a finer grid, refinement) is taken as one.
        if (this.perStepMs && perStep > 4 * this.perStepMs && ++this.slowFrames < 4) return;
        this.slowFrames = 0;
        // Per step, so frames of few steps and of many average alike.
        this.perStepMs = this.perStepMs ? this.perStepMs * 0.8 + perStep * 0.2 : perStep;
        this.gpuMs = this.perStepMs * steps;
        let want = FRAME_BUDGET_MS / Math.max(1e-4, this.perStepMs);
        // At a few steps a frame the fixed wait for the GPU dominates and makes a step look
        // dear: a frame done within half the budget may double (back up in a few frames).
        if (ms < FRAME_BUDGET_MS / 2) want = Math.max(want, steps * 2);
        this.stepsTarget = Math.max(1, Math.min(MAX_STEPS, this.stepsTarget * 0.7 + want * 0.3));
      });
    }
    if (read) {
      this.readPending = true;
      void read().then((r) => {
        this.readPending = false;
        if (!r) return;
        if (readFine) {
          void readFine().then((f) => {
            if (f) {
              // A refined body's force from its finest grid.
              r.forces = r.forces.map((fc, i) => f.byId.get(this.order[i]) ?? fc);
              r.bad += f.bad;
              r.limited += f.limited;
            }
            this.takeForces(r, tStart, epoch);
          });
        } else this.takeForces(r, tStart, epoch);
      });
    }
    if (scene.view.autoRange && now - this.sampledAt > 400) {
      this.sampledAt = now;
      void solver.readSampled().then((s) => s && this.rangeField && this.takeSample(s, this.rangeField));
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

  /** Bumped when the flow restarts or its bodies change: a force read from before is dropped. */
  private epoch = 0;

  private takeForces(r: FrameResult, tStart: number, epoch: number) {
    if (epoch !== this.epoch) return;
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
      const mz = f.mz / r.steps;
      st.mzEma = st.mzEma ? st.mzEma * (1 - a) + mz * a : mz;
      if (this.map) {
        const passes = FAR_FIELD_PASSES * (referenceLength(st.body.shape) / this.map.dx / this.map.u);
        const b = Math.min(1, r.steps / Math.max(1, passes));
        st.fyMean = st.fyMean * (1 - b) + fy * b;
      }
      if (this.recordForces) {
        for (let s = 0; s < r.steps; s++) st.history.push(f.perStep[2 * s], f.perStep[2 * s + 1]);
      }
      // Coefficient samples: about 50 per convective time.
      if (this.map) {
        const L = referenceLength(st.body.shape) / this.map.dx;
        const q = 0.5 * this.map.u * this.map.u * L;
        const every = Math.max(1, Math.floor(L / this.map.u / 50));
        const sm = st.samples;
        // Time only runs forward in a record (a restart begins a new one).
        if (sm.t.length && tStart < sm.t[sm.t.length - 1]) st.samples = { t: [], cd: [], cl: [], cm: [] };
        const smp = st.samples;
        for (let s = 0; s < r.steps; s += every) {
          const k = Math.min(every, r.steps - s);
          let x = 0;
          let y = 0;
          let z = 0;
          for (let m = 0; m < k; m++) {
            x += f.perStep[2 * (s + m)];
            y += f.perStep[2 * (s + m) + 1];
            z += f.mzStep[s + m];
          }
          smp.t.push(tStart + (s + k / 2) * this.map.dt);
          smp.cd.push(x / k / q);
          smp.cl.push(y / k / q);
          smp.cm.push(-z / k / (q * L));
        }
        if (smp.t.length > SAMPLES_MAX) {
          const cut = smp.t.length - SAMPLES_MAX;
          smp.t.splice(0, cut);
          smp.cd.splice(0, cut);
          smp.cl.splice(0, cut);
          smp.cm.splice(0, cut);
        }
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
      // Speed: at least to 1.8 times the free stream, so the free stream sits mid-scale and
      // only flow sped up round a body reaches the top.
      hi = Math.max(field === 'speed' ? 1.8 : 1e-6, q(0.995));
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
    this.particles.destroy();
    this.dye?.destroy();
    this.rheo?.destroy();
    this.streamlines.destroy();
    this.renderer.destroy();
  }
}
