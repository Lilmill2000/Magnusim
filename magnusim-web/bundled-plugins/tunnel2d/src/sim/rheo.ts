// The rheoscopic view: what a tank of fluid full of tiny reflective flakes (mica,
// Kalliroscope) would show.
//
// Each cell carries the average orientation of the flakes' normals, the second-moment
// tensor Q = <n nᵀ> (3x3, symmetric, trace 1). Every frame the field is carried by the
// flow, then turned by the velocity gradient L (L_ij = du_i/dx_j) as infinitely thin
// plates turn (their normals follow a material surface's, Jeffery's orbit for a plate):
//   dQ/dt = -Lᵀ Q - Q L + 2 (Q : L) Q        (quadratic closure)
// The flow in a real tank also shears between its floor and the surface, which lays the
// flakes flat and tilts them along the local flow; that depth shear is modelled as
// du/dz = u / depth. Where the fluid stands still the flakes tumble back to random
// (rotational diffusion, Q -> I/3), so dead water looks dull; flakes come in random at
// the inlet. The flakes' own sparkle is two layers of noise carried by the flow and
// renewed in turn, so it travels with the fluid and never freezes (Neyret's advected
// textures).
//
// The page then lights the flakes with two coloured lights low over the tank and looks
// straight down: a two-sided diffuse term sqrt(lᵀQl) and a glint (hᵀQh)^k, h the half
// vector between the light and the eye. Physics references: Hecht, Mucha & Turk,
// "Virtual Rheoscopic Fluids" (TVCG 2010); Jeffery (1922); the closure is the standard
// one of fibre-orientation models (Advani & Tucker).
// SPDX-License-Identifier: GPL-3.0-or-later
import { WG } from './kernels';

/** Frames between two renewals of one sparkle layer. */
export const SPARKLE_PERIOD = 96;
/** Largest rotation (radians) per sub-step of the orientation update. */
const ROT_STEP = 0.25;
const MAX_ROT_SUBSTEPS = 24;

export const rheoShader = () => `
struct R {
  nx: u32, ny: u32, frame: u32, seed: u32,
  dt: f32, kappa: f32, relax: f32, inletX: f32,
  period: u32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read> qin: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> qout: array<vec4f>;
@group(0) @binding(3) var<uniform> Rp: R;

fn hash(u: u32) -> u32 {
  var x = u;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn rnd(a: u32, b: u32) -> f32 { return f32(hash(a * 1664525u + hash(b)) & 0xffffffu) / 16777216.0; }

fn cid(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Rp.nx) - 1)) + u32(clamp(j, 0, i32(Rp.ny) - 1)) * Rp.nx; }
fn u2(i: i32, j: i32) -> vec2f { return mac[cid(i, j)].xy; }

/** Bilinear sample of the two vec4s of cell data (2 per cell) at p. */
fn sampleQ(p: vec2f) -> array<vec4f, 2> {
  let c = clamp(p, vec2f(0.0), vec2f(f32(Rp.nx) - 1.001, f32(Rp.ny) - 1.001));
  let i = i32(c.x);
  let j = i32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let a = cid(i, j); let b = cid(i + 1, j); let d = cid(i, j + 1); let e = cid(i + 1, j + 1);
  let q0 = mix(mix(qin[2u * a], qin[2u * b], f.x), mix(qin[2u * d], qin[2u * e], f.x), f.y);
  let q1 = mix(mix(qin[2u * a + 1u], qin[2u * b + 1u], f.x), mix(qin[2u * d + 1u], qin[2u * e + 1u], f.x), f.y);
  return array<vec4f, 2>(q0, q1);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${WG}u;
  if (k >= Rp.nx * Rp.ny) { return; }
  let i = i32(k % Rp.nx);
  let j = i32(k / Rp.nx);
  let m = mac[k];
  // Sparkle layers: each is renewed (fresh noise) once a period, half a period apart.
  let ph = Rp.frame % Rp.period;
  let renew1 = ph == 0u;
  let renew2 = ph == Rp.period / 2u;
  if (m.w > 0.5 || f32(i) < Rp.inletX) {
    // Inside a body, or coming in at the inlet: random flakes.
    qout[2u * k] = vec4f(1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0, 0.0);
    qout[2u * k + 1u] = vec4f(0.0, 0.0, rnd(k, Rp.seed), rnd(k, Rp.seed ^ 0x51ed27u));
    return;
  }
  // Carried by the flow (semi-Lagrangian, from where this fluid was a frame ago).
  let s = sampleQ(vec2f(f32(i), f32(j)) - Rp.dt * m.xy);
  var xx = s[0].x; var yy = s[0].y; var zz = s[0].z; var xy = s[0].w;
  var xz = s[1].x; var yz = s[1].y;
  var n1 = s[1].z; var n2 = s[1].w;
  if (renew1) { n1 = rnd(k, Rp.seed); }
  if (renew2) { n2 = rnd(k, Rp.seed ^ 0x51ed27u); }

  // The velocity gradient (per step), in plane and across the depth.
  let dudx = 0.5 * (u2(i + 1, j).x - u2(i - 1, j).x);
  let dudy = 0.5 * (u2(i, j + 1).x - u2(i, j - 1).x);
  let dvdx = 0.5 * (u2(i + 1, j).y - u2(i - 1, j).y);
  let dvdy = 0.5 * (u2(i, j + 1).y - u2(i, j - 1).y);
  let dudz = Rp.kappa * m.x;
  let dvdz = Rp.kappa * m.y;
  // L = [[dudx, dudy, dudz], [dvdx, dvdy, dvdz], [0, 0, 0]] (no vertical velocity).
  let rate = abs(dudx) + abs(dudy) + abs(dvdx) + abs(dvdy) + abs(dudz) + abs(dvdz);
  let sub = u32(clamp(ceil(rate * Rp.dt / ${ROT_STEP}), 1.0, ${MAX_ROT_SUBSTEPS}.0));
  let h = Rp.dt / f32(sub);
  let rlx = 1.0 - exp(-Rp.relax * h);
  for (var q = 0u; q < sub; q++) {
    // Q as a matrix (symmetric).
    let Q = mat3x3f(vec3f(xx, xy, xz), vec3f(xy, yy, yz), vec3f(xz, yz, zz));
    let L = mat3x3f(vec3f(dudx, dvdx, 0.0), vec3f(dudy, dvdy, 0.0), vec3f(dudz, dvdz, 0.0));
    let QL = Q * L;
    let LtQ = transpose(L) * Q;
    let qdl = xx * dudx + xy * dudy + xz * dudz + xy * dvdx + yy * dvdy + yz * dvdz;
    let dQ = 2.0 * qdl * Q - LtQ - QL;
    xx += h * dQ[0].x; yy += h * dQ[1].y; zz += h * dQ[2].z;
    xy += h * 0.5 * (dQ[1].x + dQ[0].y);
    xz += h * 0.5 * (dQ[2].x + dQ[0].z);
    yz += h * 0.5 * (dQ[2].y + dQ[1].z);
    // Tumbling back to random where nothing aligns them.
    xx += rlx * (1.0 / 3.0 - xx); yy += rlx * (1.0 / 3.0 - yy); zz += rlx * (1.0 / 3.0 - zz);
    xy -= rlx * xy; xz -= rlx * xz; yz -= rlx * yz;
    // Keep it a second moment: a positive diagonal, trace 1.
    xx = max(xx, 0.0); yy = max(yy, 0.0); zz = max(zz, 0.0);
    let tr = max(xx + yy + zz, 1e-6);
    xx /= tr; yy /= tr; zz /= tr; xy /= tr; xz /= tr; yz /= tr;
    // And its off-diagonal terms bounded as a second moment's are: |Q_ij| <= sqrt(Q_ii Q_jj).
    let bxy = sqrt(xx * yy); let bxz = sqrt(xx * zz); let byz = sqrt(yy * zz);
    xy = clamp(xy, -bxy, bxy); xz = clamp(xz, -bxz, bxz); yz = clamp(yz, -byz, byz);
  }
  if (!(xx == xx && yy == yy && zz == zz && xy == xy && xz == xz && yz == yz)) {
    xx = 1.0 / 3.0; yy = 1.0 / 3.0; zz = 1.0 / 3.0; xy = 0.0; xz = 0.0; yz = 0.0;
  }
  qout[2u * k] = vec4f(xx, yy, zz, xy);
  qout[2u * k + 1u] = vec4f(xz, yz, n1, n2);
}
`;

export class Rheo {
  private device: GPUDevice;
  readonly nx: number;
  readonly ny: number;
  private bufs: [GPUBuffer, GPUBuffer];
  private cur = 0;
  private pipe: GPUComputePipeline;
  private uni: GPUBuffer;
  private frame = 0;
  private seed = 7;

  constructor(device: GPUDevice, nx: number, ny: number) {
    this.device = device;
    this.nx = nx;
    this.ny = ny;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.bufs = [device.createBuffer({ size: nx * ny * 32, usage }), device.createBuffer({ size: nx * ny * 32, usage })];
    this.pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: rheoShader(), label: 'rheoscopic' }), entryPoint: 'main' } });
    this.uni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.reset();
  }

  /** Random flakes everywhere, fresh sparkle. */
  reset() {
    const d = new Float32Array(this.nx * this.ny * 8);
    let s = 99;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < this.nx * this.ny; k++) d.set([1 / 3, 1 / 3, 1 / 3, 0, 0, 0, rnd(), rnd()], 8 * k);
    this.device.queue.writeBuffer(this.bufs[0], 0, d);
    this.device.queue.writeBuffer(this.bufs[1], 0, d);
    this.frame = 0;
  }

  /** The current field: two vec4 per cell, (xx, yy, zz, xy) and (xz, yz, sparkle 1, sparkle 2). */
  get field(): GPUBuffer {
    return this.bufs[this.cur];
  }

  /** The two sparkle layers' weights now (each fades in after its renewal and out before the next). */
  get sparkleWeights(): [number, number] {
    const ph = (this.frame % SPARKLE_PERIOD) / SPARKLE_PERIOD;
    const w1 = Math.sin(Math.PI * ph) ** 2;
    return [w1, 1 - w1];
  }

  /**
   * One frame of `steps` lattice steps. `depthCells`: the tank's depth in cells (the depth
   * shear is the flow's speed over it); `relaxSteps`: how many steps still flakes take to
   * tumble back to random; `inletX`: cells at the inlet that bring in random flakes.
   */
  encode(enc: GPUCommandEncoder, steps: number, mac: GPUBuffer, o: { depthCells: number; relaxSteps: number; inletX: number }) {
    if (steps <= 0) return;
    const d = new ArrayBuffer(48);
    const u = new Uint32Array(d);
    const f = new Float32Array(d);
    u[0] = this.nx;
    u[1] = this.ny;
    u[2] = this.frame;
    u[3] = this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    f[4] = steps;
    f[5] = 1 / Math.max(1, o.depthCells);
    f[6] = 1 / Math.max(1, o.relaxSteps);
    f[7] = o.inletX;
    u[8] = SPARKLE_PERIOD;
    this.device.queue.writeBuffer(this.uni, 0, d);
    const bg = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: mac } },
        { binding: 1, resource: { buffer: this.bufs[this.cur] } },
        { binding: 2, resource: { buffer: this.bufs[this.cur ^ 1] } },
        { binding: 3, resource: { buffer: this.uni } },
      ],
    });
    const n = this.nx * this.ny;
    const groups = Math.ceil(n / WG);
    const gx = Math.min(groups, 32768);
    const pass = enc.beginComputePass({ label: 'rheoscopic' });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    pass.end();
    this.cur ^= 1;
    this.frame++;
  }

  /** The field (for tests). */
  async read(): Promise<Float32Array> {
    const bytes = this.nx * this.ny * 32;
    const b = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.field, 0, b, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(b.getMappedRange().slice(0));
    b.destroy();
    return out;
  }

  destroy() {
    this.bufs[0].destroy();
    this.bufs[1].destroy();
    this.uni.destroy();
  }
}
