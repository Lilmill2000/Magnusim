// Local grid refinement: a patch of cells half the size round a body, coupled to the grid
// it sits in (Lagrava et al. 2012, Astoul et al. 2020; vertex-centred, ratio 2, acoustic
// scaling: the lattice speed is the same on both, a patch cell's viscosity in its own
// units is twice the coarse one's, so τ_f = 2τ_c − ½).
//
// The coarse grid runs everywhere, the patch's inside too. Each coarse step:
//   1. the coarse step, which also writes each cell's pre-collision moments (ρ, Π_neq),
//      the last two steps' kept (swapped like the populations);
//   2. two fine steps; in each, the patch's edge cells are not stepped but rebuilt for the
//      next fine time from the coarse moments at the two coarse times (cubic along the edge,
//      linear in time), Π_neq rescaled (shear part by τ_f / 2τ_c, the trace by ½), as
//      post-collision recursive-regularized populations, the collision's own form (the step
//      kernel does this itself: no extra passes);
//   3. restriction: the coarse cells inside the patch (a cell in from its edge) take density
//      and velocity from the fine cell on them and Π_neq from a binomial filter of the fine
//      ones round it, rescaled back.
// The auxiliary field (velocity, ν̃, viscosity) goes across with the same rescaling (×2 to the
// patch, ½ back). A patch can hold patches of its own (its fine grid is a Solver).
// SPDX-License-Identifier: GPL-3.0-or-later
import { bakeSdf, type SdfGrid } from '../geometry/sdf';
import { transformRings, type Pose, type Poly, type Rings } from '../geometry/polygon';

/** One polygon or several rings, as rings. */
export const asRings = (o: Poly | Rings): Rings => (o.length && Array.isArray(o[0]) ? (o as Rings) : [o as Poly]);
import { POST_RR, TABLES, WG } from './kernels';
import { Solver, type FrameResult, type Physics } from './solver';

/** A patch's place on its parent grid: origin and size in parent cells. */
export interface PatchRect {
  ox: number;
  oy: number;
  wc: number;
  hc: number;
}

const HEADER = /* wgsl */ `
override KEEP_BULK: f32 = 0.0;
struct R {
  ox: u32, oy: u32, wc: u32, hc: u32,
  nxf: u32, nyf: u32, nxc: u32, nf: u32,
  nc: u32, sCount: u32, slotA: u32, slotB: u32,
  theta: f32, p0: f32, p1: f32, p2: f32,
};
${TABLES}
${POST_RR}
`;

/** Restriction: the coarse cells inside the patch from the fine cells on and round them. */
export function restrictShader(): string {
  return `${HEADER}
@group(0) @binding(0) var<uniform> U: R;
@group(0) @binding(1) var<storage, read> momF: array<vec4f>;
@group(0) @binding(2) var<storage, read> auxF: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> coarseF: array<f32>;
@group(0) @binding(4) var<storage, read_write> coarseAux: array<vec4f>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = U.wc - 1u;
  let h = U.hc - 1u;
  if (gid.x >= w * h) { return; }
  let i = gid.x % w + 1u;
  let j = gid.x / w + 1u;
  let fc = 2u * i + 2u * j * U.nxf;
  let kc = (U.ox + i) + (U.oy + j) * U.nxc;
  let ac = auxF[fc];
  if (ac.w < 0.0) {
    // In a body: equilibrium at the wall's speed, as the coarse step keeps it.
    for (var k = 0u; k < 9u; k++) { coarseF[k * U.nc + kc] = postRR(k, 1.0, ac.xy, 0.0, 0.0, 0.0, 1.0); }
    coarseAux[kc] = vec4f(ac.xy, 0.0, -1.0);
    return;
  }
  // Π_neq through the binomial filter (1/4 here, 1/8 each side, 1/16 each corner), with a
  // body's cells left out (their weight goes to the centre).
  var p = vec3f(0.0);
  var wsum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let wgt = select(select(0.0625, 0.125, dx == 0 || dy == 0), 0.25, dx == 0 && dy == 0);
      let kf = u32(i32(fc) + dx + dy * i32(U.nxf));
      if (auxF[kf].w < 0.0) { continue; }
      p += wgt * momF[kf].yzw;
      wsum += wgt;
    }
  }
  p /= wsum;
  let rho = momF[fc].x;
  let nuF = ac.w;
  let tauF = 3.0 * nuF + 0.5;
  let nuC = 0.5 * nuF;
  let tauC = 3.0 * nuC + 0.5;
  let pc = rescale(p, 2.0 * tauC / tauF, 2.0);
  for (var k = 0u; k < 9u; k++) { coarseF[k * U.nc + kc] = postRR(k, rho, ac.xy, pc.x, pc.y, pc.z, tauC); }
  coarseAux[kc] = vec4f(ac.xy, 0.5 * ac.z, nuC);
}
`;
}

/**
 * Fill: a patch's cells at a new place (or new). Where the old patch covered the same spot its
 * populations are copied; elsewhere they are built from the parent's moments (bilinear,
 * Π_neq rescaled as on the edge; never left without their non-equilibrium part, which would
 * send out a pressure pulse).
 */
export function fillShader(): string {
  return `${HEADER}
struct O { ox: u32, oy: u32, nx: u32, ny: u32, valid: u32, n: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> U: R;
@group(0) @binding(1) var<uniform> Old: O;
@group(0) @binding(2) var<storage, read> parentF: array<f32>;
@group(0) @binding(3) var<storage, read> parentMom: array<vec4f>;
@group(0) @binding(4) var<storage, read> parentAux: array<vec4f>;
@group(0) @binding(5) var<storage, read> oldF: array<f32>;
@group(0) @binding(6) var<storage, read> oldAux: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> newF: array<f32>;
@group(0) @binding(8) var<storage, read_write> newAux: array<vec4f>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${WG}u;
  if (idx >= U.nf) { return; }
  let a = idx % U.nxf;
  let b = idx / U.nxf;
  // The same spot in the old patch's cells (both grids are on the parent's half cells).
  let oa = i32(a) + 2 * (i32(U.ox) - i32(Old.ox));
  let ob = i32(b) + 2 * (i32(U.oy) - i32(Old.oy));
  if (Old.valid == 1u && oa >= 0 && ob >= 0 && oa < i32(Old.nx) && ob < i32(Old.ny)) {
    let k0 = u32(oa) + u32(ob) * Old.nx;
    for (var k = 0u; k < 9u; k++) { newF[k * U.nf + idx] = oldF[k * Old.n + k0]; }
    newAux[idx] = oldAux[k0];
    return;
  }
  let X = f32(U.ox) + 0.5 * f32(a);
  let Y = f32(U.oy) + 0.5 * f32(b);
  let i0 = u32(floor(X));
  let j0 = u32(floor(Y));
  let fx = X - floor(X);
  let fy = Y - floor(Y);
  var rho = 0.0;
  var u = vec2f(0.0);
  var pp = vec3f(0.0);
  var nu = 0.0;
  var nt = 0.0;
  var ws = 0.0;
  for (var q = 0u; q < 4u; q++) {
    let di = q & 1u;
    let dj = q >> 1u;
    let kc = (i0 + di) + (j0 + dj) * U.nxc;
    let ax = parentAux[kc];
    if (ax.w < 0.0) { continue; }
    let w = select(1.0 - fx, fx, di == 1u) * select(1.0 - fy, fy, dj == 1u);
    var dr = 0.0;
    var m = vec2f(0.0);
    for (var k = 0u; k < 9u; k++) {
      let g = parentF[k * U.nc + kc];
      dr += g;
      m += g * vec2f(CXF[k], CYF[k]);
    }
    let r = 1.0 + dr;
    let mo = parentMom[kc];
    rho += w * r;
    u += w * m / r;
    if (mo.x > 0.5) { pp += w * mo.yzw; }
    nu += w * ax.w;
    nt += w * ax.z;
    ws += w;
  }
  if (ws < 1e-6) {
    rho = 1.0;
    ws = 1.0;
  }
  rho /= ws;
  u /= ws;
  pp /= ws;
  nu /= ws;
  nt /= ws;
  let tauC = 3.0 * nu + 0.5;
  let nuF = 2.0 * nu;
  let tauF = 3.0 * nuF + 0.5;
  let pf = rescale(pp, tauF / (2.0 * tauC), 0.5);
  for (var k = 0u; k < 9u; k++) { newF[k * U.nf + idx] = postRR(k, rho, u, pf.x, pf.y, pf.z, tauF); }
  newAux[idx] = vec4f(u, 2.0 * max(nt, 0.0), nuF);
}
`;
}

export function refineShaders(): { label: string; code: string }[] {
  return [
    { label: 'refine restrict', code: restrictShader() },
    { label: 'refine fill', code: fillShader() },
  ];
}

/** One patch: its fine grid (a Solver) and the coupling passes to its parent. */
export class Patch {
  /** Where the patch is (it moves: encodeMoveTo). */
  readonly rect: PatchRect;
  readonly fine: Solver;
  private device: GPUDevice;
  readonly parent: Solver;
  /** The rectangle and grid sizes, for restriction and fill. */
  private uni: GPUBuffer;
  /** For the fine step's edge rebuild: the rectangle, and whether to take the coarse grid's newer moments for both times. */
  private edgeUni: [GPUBuffer, GPUBuffer];
  private fillPipe: GPUComputePipeline;
  private restrictPipe: GPUComputePipeline;
  private bgCache = new Map<string, GPUBindGroup>();

  constructor(device: GPUDevice, parent: Solver, fine: Solver, rect: PatchRect, keepBulk: number) {
    this.device = device;
    this.parent = parent;
    this.fine = fine;
    this.rect = rect;
    if (fine.nx !== 2 * rect.wc + 1 || fine.ny !== 2 * rect.hc + 1) throw new Error('A patch grid must be 2 x its parent cells + 1.');
    if (rect.ox < 2 || rect.oy < 2 || rect.ox + rect.wc > parent.nx - 3 || rect.oy + rect.hc > parent.ny - 3) throw new Error('A patch must lie inside its parent grid, two cells in.');
    const pipe = (code: string, label: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main', constants: { KEEP_BULK: keepBulk } } });
    this.restrictPipe = pipe(restrictShader(), 'refine restrict');
    this.fillPipe = pipe(fillShader(), 'refine fill');
    this.oldUni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.edgeUni = [0, 1].map(() => device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })) as [GPUBuffer, GPUBuffer];
    this.writeUniforms();
  }

  private writeUniforms() {
    const { rect, fine, parent } = this;
    const d = new Uint32Array(16);
    d.set([rect.ox, rect.oy, rect.wc, rect.hc, fine.nx, fine.ny, parent.nx, fine.n, parent.n]);
    this.device.queue.writeBuffer(this.uni, 0, d);
    this.edgeUni.forEach((b, prime) => this.device.queue.writeBuffer(b, 0, new Uint32Array([rect.ox, rect.oy, parent.nx, prime])));
  }

  /**
   * Fill the patch's cells (at the frame's start, every level in step): copied from `old`
   * (a patch grid on the same parent cells, at `oldRect`) where it covered them, from the
   * parent elsewhere. With no `old`, all from the parent.
   */
  encodeFill(enc: GPUCommandEncoder, old: { solver: Solver; rect: PatchRect } | null) {
    const p = this.parent.levelBuffers;
    const f = this.fine.levelBuffers;
    const sameGrid = old?.solver === this.fine;
    const o = old ? old.solver.levelBuffers : null;
    this.device.queue.writeBuffer(
      this.oldUni,
      0,
      new Uint32Array(old ? [old.rect.ox, old.rect.oy, old.solver.nx, old.solver.ny, 1, old.solver.n, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0]),
    );
    // Into the other buffer when copying within the same grid (a shift), then swap to it.
    const dst = sameGrid ? f.cur ^ 1 : f.cur;
    const bg = this.device.createBindGroup({
      layout: this.fillPipe.getBindGroupLayout(0),
      entries: [
        this.uni,
        this.oldUni,
        p.f[p.cur],
        p.mom[p.cur],
        p.aux[p.cur],
        o ? o.f[o.cur] : f.f[f.cur ^ 1],
        o ? o.aux[o.cur] : f.aux[f.cur ^ 1],
        f.f[dst],
        f.aux[dst],
      ].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const pass = enc.beginComputePass({ label: 'refine fill' });
    pass.setPipeline(this.fillPipe);
    pass.setBindGroup(0, bg);
    const groups = Math.ceil(this.fine.n / WG);
    pass.dispatchWorkgroups(Math.min(groups, 32768), Math.ceil(groups / Math.min(groups, 32768)));
    pass.end();
    if (sameGrid) this.fine.swapCur();
    this.needPrime = true;
  }

  /** The fill's description of the old patch (one fill per patch per frame at most). */
  private oldUni: GPUBuffer;

  /** The parent's cells were renumbered under the patch (the parent moved): same place, new numbers. */
  shiftOrigin(dx: number, dy: number) {
    this.rect.ox += dx;
    this.rect.oy += dy;
    this.writeUniforms();
    this.invalidate();
    this.needPrime = true;
  }

  /** Move the patch (parent cells; same size): its cells are shifted with encodeFill. */
  encodeMoveTo(enc: GPUCommandEncoder, ox: number, oy: number) {
    const oldRect = { ...this.rect };
    this.rect.ox = ox;
    this.rect.oy = oy;
    this.writeUniforms();
    this.invalidate();
    this.encodeFill(enc, { solver: this.fine, rect: oldRect });
  }

  private bg(key0: string, layout: GPUBindGroupLayout, buffers: GPUBuffer[]): GPUBindGroup {
    const key = `${key0}|${this.parent.gen}|${this.fine.gen}`;
    let g = this.bgCache.get(key);
    if (!g) {
      g = this.device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.bgCache.set(key, g);
    }
    return g;
  }

  /** Buffers changed (a reset, a turbulence switch): forget the bind groups. */
  invalidate() {
    this.bgCache.clear();
  }

  /** The parent has no earlier step to go by (new patch, moved): its newer moments stand for both times once. */
  private needPrime = true;

  prime() {
    this.needPrime = true;
  }

  /**
   * After the parent's step (its buffers now at t+1, the previous ones still at t): two fine
   * steps that rebuild their own edges from those, then restriction. `slot` is the parent's
   * step index within the frame.
   */
  encodeCoupled(pass: GPUComputePassEncoder, slot: number) {
    const p = this.parent.levelBuffers;
    const prime = this.needPrime ? 1 : 0;
    const edge = this.bg(`edge${p.cur}|${prime}`, this.fine.edgeLayout, [this.edgeUni[prime], p.mom[p.cur ^ 1], p.mom[p.cur], p.aux[p.cur ^ 1], p.aux[p.cur]]);
    this.fine.encodeStep(pass, 2 * slot, edge);
    this.fine.encodeStep(pass, 2 * slot + 1, edge);
    const f = this.fine.levelBuffers;
    pass.setPipeline(this.restrictPipe);
    pass.setBindGroup(0, this.bg(`res|${f.cur}|${p.cur}`, this.restrictPipe.getBindGroupLayout(0), [this.uni, f.mom[f.cur], f.aux[f.cur], p.f[p.cur], p.aux[p.cur]]));
    pass.dispatchWorkgroups(Math.ceil(((this.rect.wc - 1) * (this.rect.hc - 1)) / WG));
    this.needPrime = false;
  }

  destroy() {
    this.fine.destroy();
    this.oldUni.destroy();
    this.uni.destroy();
    for (const b of this.edgeUni) b.destroy();
  }
}

/** A body for a refinement chain: its outline in coarse cells (body frame) and its coarse poses. */
export interface RefineBody {
  key: string;
  local: Poly | Rings;
  band?: number;
  from: Pose;
  to: Pose;
}

/**
 * A chain of nested patches round one region: level 1 a patch of the coarse grid, level 2
 * (if any) a patch of level 1's grid, each with cells half its parent's. Builds each level's
 * fine grid with the physics scaled to it (the fluid's viscosity ×2 per level in its own
 * units, the least viscosity the same number in its units, so twice the Reynolds number the
 * grid resolves), bakes the bodies per level, and gives the forces from the finest.
 */
export class Refinement {
  readonly levels: Patch[] = [];
  private sdfs = new Map<string, SdfGrid>();

  /**
   * `rects[i]` is level i+1's rectangle in level i's cells (level 0: the coarse grid). With
   * `attach` the first level is made the coarse grid's only patch; otherwise the caller adds it.
   */
  constructor(device: GPUDevice, coarse: Solver, rects: PatchRect[], physics: Physics, attach = true) {
    let parent = coarse;
    for (const rect of rects) {
      const fine = new Solver(device, { nx: 2 * rect.wc + 1, ny: 2 * rect.hc + 1, walls: 'slip', patch: true });
      const patch = new Patch(device, parent, fine, { ...rect }, physics.bulkKeep ?? 0);
      if (parent !== coarse || attach) parent.setPatches([patch]);
      this.levels.push(patch);
      parent = fine;
    }
    this.setPhysics(physics);
    for (const p of this.levels) p.fine.reset(physics.u);
  }

  /**
   * Fill every level from its parent, copying what `old` (an earlier chain on the same coarse
   * grid, at most as deep) already had at the same places.
   */
  encodeFill(enc: GPUCommandEncoder, old: Refinement | null) {
    this.levels.forEach((lv, i) => {
      const o = old?.levels[i];
      if (!o) {
        lv.encodeFill(enc, null);
        return;
      }
      // An old level below the first sits on its own parent's cells: put its rectangle on this one's.
      let rect = { ...o.rect };
      if (i > 0) {
        const op = old!.levels[i - 1].rect;
        const np = this.levels[i - 1].rect;
        rect = { ...rect, ox: rect.ox + 2 * (op.ox - np.ox), oy: rect.oy + 2 * (op.oy - np.oy) };
      }
      lv.encodeFill(enc, { solver: o.fine, rect });
    });
  }

  /** The finest level's rectangle in coarse cells, and its cells per coarse cell. */
  get finestBox(): { x0: number; y0: number; x1: number; y1: number; scale: number } {
    let x0 = 0;
    let y0 = 0;
    let k = 1;
    let w = 0;
    let h = 0;
    for (const lv of this.levels) {
      x0 += lv.rect.ox / k;
      y0 += lv.rect.oy / k;
      w = lv.rect.wc / k;
      h = lv.rect.hc / k;
      k *= 2;
    }
    return { x0, y0, x1: x0 + w, y1: y0 + h, scale: k };
  }

  get finest(): Solver {
    return this.levels[this.levels.length - 1].fine;
  }

  /** Finest cells per coarse cell. */
  get scale(): number {
    return 2 ** this.levels.length;
  }

  /** Each level's physics from the coarse grid's. */
  setPhysics(p: Physics) {
    this.levels.forEach((lv, i) => {
      const s = 2 ** (i + 1);
      const nuMol = (p.nuMol ?? 0) * s;
      lv.fine.setPhysics({ ...p, nuMol, tau: 3 * Math.max(nuMol, p.nuFloor ?? 0) + 0.5 });
    });
  }

  /** A coarse pose in level i+1's cells. */
  poseAt(level: number, pose: Pose): Pose {
    let x = pose.x;
    let y = pose.y;
    for (let i = 0; i <= level; i++) {
      x = 2 * (x - this.levels[i].rect.ox);
      y = 2 * (y - this.levels[i].rect.oy);
    }
    return { x, y, theta: pose.theta };
  }

  /** The bodies on every level (fields baked once per level and shape). */
  setBodies(bodies: RefineBody[]) {
    this.levels.forEach((lv, i) => {
      const s = 2 ** (i + 1);
      lv.fine.setBodies(
        bodies.map((b) => {
          const key = `${b.key}@L${i + 1}`;
          let sdf = this.sdfs.get(key);
          if (!sdf) {
            sdf = bakeSdf(transformRings(asRings(b.local), { x: 0, y: 0, theta: 0 }, s), b.band);
            this.sdfs.set(key, sdf);
          }
          return { key, sdf, from: this.poseAt(i, b.from), to: this.poseAt(i, b.to) };
        }),
      );
    });
  }

  /** Read the finest level's forces for a frame of `count` coarse steps (encode before submitting). */
  prepareRead(enc: GPUCommandEncoder, count: number): () => Promise<FrameResult | null> {
    const k = this.scale;
    const read = this.finest.prepareRead(enc, k * count);
    return async () => {
      const r = await read();
      if (!r) return null;
      // A coarse step's force: the sum over its finest steps, over 4 per level (momentum and
      // time units both shrink with the cell).
      const div = k * k;
      const forces = r.forces.map((f) => {
        const perStep = new Float64Array(count * 2);
        let fx = 0;
        let fy = 0;
        for (let s = 0; s < count; s++) {
          let x = 0;
          let y = 0;
          for (let q = 0; q < k; q++) {
            x += f.perStep[2 * (s * k + q)];
            y += f.perStep[2 * (s * k + q) + 1];
          }
          perStep[2 * s] = x / div;
          perStep[2 * s + 1] = y / div;
          fx += x / div;
          fy += y / div;
        }
        return { fx, fy, perStep };
      });
      return { ...r, steps: count, forces };
    };
  }

  destroy() {
    for (const lv of this.levels) lv.destroy();
  }
}

/**
 * A patch rectangle (parent cells) round a body's outline `world` (parent cells): margins
 * in body lengths ahead, to the sides and behind, kept `inset` cells inside [x0, x1] × [y0, y1].
 */
export function rectAround(
  world: Poly,
  lRef: number,
  margins: { ahead: number; side: number; behind: number },
  bounds: { x0: number; y0: number; x1: number; y1: number },
): PatchRect {
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let i = 0; i < world.length; i += 2) {
    bx0 = Math.min(bx0, world[i]);
    bx1 = Math.max(bx1, world[i]);
    by0 = Math.min(by0, world[i + 1]);
    by1 = Math.max(by1, world[i + 1]);
  }
  const ox = Math.max(bounds.x0, Math.floor(bx0 - margins.ahead * lRef));
  const oy = Math.max(bounds.y0, Math.floor(by0 - margins.side * lRef));
  const ex = Math.min(bounds.x1, Math.ceil(bx1 + margins.behind * lRef));
  const ey = Math.min(bounds.y1, Math.ceil(by1 + margins.side * lRef));
  return { ox, oy, wc: Math.max(4, ex - ox), hc: Math.max(4, ey - oy) };
}
