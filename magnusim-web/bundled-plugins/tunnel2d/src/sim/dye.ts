// Dye: up to four colours of dye, one per dye rake, carried by the flow on the lattice's
// own grid. Each sub-step is MacCormack's corrected semi-Lagrangian step (forward,
// backward, then half the round trip's error added back, clamped to the values it came
// from so it never overshoots), which keeps streaks sharp where plain semi-Lagrangian
// smears them. Dye is fed at each rake's emitters and is zero inside bodies.
// SPDX-License-Identifier: GPL-3.0-or-later
import { WG } from './kernels';

/** Largest motion (cells) of one dye sub-step; more steps per frame mean more sub-steps. */
const SUBSTEP_CELLS = 3;
const MAX_SUBSTEPS = 48;
export const DYE_CHANNELS = 4;
/** Radius (cells) of the spot each emitter feeds. */
const SOURCE_R = 2.5;

const header = `
struct G { nx: u32, ny: u32, dt: f32, sign: f32, nsrc: u32, r: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<uniform> Gd: G;
`;

const sampleFn = `
fn idx(i: i32, j: i32) -> u32 { return u32(clamp(i, 0, i32(Gd.nx) - 1)) + u32(clamp(j, 0, i32(Gd.ny) - 1)) * Gd.nx; }
fn bil(c: vec2f) -> vec4f {
  let p = clamp(c, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(p.x);
  let j = i32(p.y);
  let f = p - vec2f(f32(i), f32(j));
  return mix(mix(src[idx(i, j)], src[idx(i + 1, j)], f.x), mix(src[idx(i, j + 1)], src[idx(i + 1, j + 1)], f.x), f.y);
}
`;

/** dst = src carried back along the flow by sign * dt (one semi-Lagrangian step). */
export const advectShader = () => `${header}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
${sampleFn}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${WG}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx));
  dst[k] = bil(p - Gd.sign * Gd.dt * m.xy);
}
`;

/** MacCormack's correction: out = fwd + (c - back) / 2, clamped to the departure cell's corners in c. */
export const correctShader = () => `${header}
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read> fwd: array<vec4f>;
@group(0) @binding(4) var<storage, read> back: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4f>;
${sampleFn}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid.x + gid.y * nwg.x * ${WG}u;
  if (k >= Gd.nx * Gd.ny) { return; }
  let m = mac[k];
  if (m.w > 0.5) { dst[k] = vec4f(0.0); return; }
  let p = vec2f(f32(k % Gd.nx), f32(k / Gd.nx)) - Gd.dt * m.xy;
  let q = clamp(p, vec2f(0.0), vec2f(f32(Gd.nx) - 1.001, f32(Gd.ny) - 1.001));
  let i = i32(q.x);
  let j = i32(q.y);
  let a = src[idx(i, j)];
  let b = src[idx(i + 1, j)];
  let c = src[idx(i, j + 1)];
  let d = src[idx(i + 1, j + 1)];
  let lo = min(min(a, b), min(c, d));
  let hi = max(max(a, b), max(c, d));
  dst[k] = clamp(fwd[k] + 0.5 * (src[k] - back[k]), lo, hi);
}
`;

/** Feed the sources: one thread per (source, cell of its square). */
export const injectShader = () => `${header}
struct Src { x: f32, y: f32, ch: u32, pad: u32 };
@group(0) @binding(2) var<storage, read> srcs: array<Src>;
@group(0) @binding(3) var<storage, read_write> dye: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let side = 2u * u32(ceil(Gd.r)) + 1u;
  let per = side * side;
  let s = gid.x / per;
  if (s >= Gd.nsrc) { return; }
  let o = gid.x % per;
  let sc = srcs[s];
  let ci = i32(round(sc.x)) - i32(side / 2u) + i32(o % side);
  let cj = i32(round(sc.y)) - i32(side / 2u) + i32(o / side);
  if (ci < 0 || cj < 0 || ci >= i32(Gd.nx) || cj >= i32(Gd.ny)) { return; }
  let dd = distance(vec2f(f32(ci), f32(cj)), vec2f(sc.x, sc.y));
  if (dd > Gd.r) { return; }
  let k = u32(ci) + u32(cj) * Gd.nx;
  if (mac[k].w > 0.5) { return; }
  var v = dye[k];
  let w = clamp(1.0 - dd / Gd.r, 0.0, 1.0) * 0.5 + 0.5;
  v[sc.ch] = max(v[sc.ch], w);
  dye[k] = v;
}
`;

export interface DyeSource {
  x: number;
  y: number;
  channel: number;
}

export class Dye {
  private device: GPUDevice;
  readonly nx: number;
  readonly ny: number;
  private bufs: GPUBuffer[];
  private cur = 0;
  private advect: GPUComputePipeline;
  private correct: GPUComputePipeline;
  private inject: GPUComputePipeline;
  private unis: GPUBuffer[] = [];
  private srcBuf: GPUBuffer;
  private srcCount = 0;
  private srcKey = '';

  constructor(device: GPUDevice, nx: number, ny: number) {
    this.device = device;
    this.nx = nx;
    this.ny = ny;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.bufs = [0, 1, 2, 3].map(() => device.createBuffer({ size: nx * ny * 16, usage }));
    const mk = (code: string, label: string) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' } });
    this.advect = mk(advectShader(), 'dye advect');
    this.correct = mk(correctShader(), 'dye correct');
    this.inject = mk(injectShader(), 'dye inject');
    this.srcBuf = device.createBuffer({ size: 16 * 512, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.unis = [0, 1].map(() => device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  }

  /** The current dye field (vec4 per cell: one channel per colour). */
  get field(): GPUBuffer {
    return this.bufs[this.cur];
  }

  setSources(srcs: DyeSource[]) {
    const key = srcs.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.channel}`).join('|');
    if (key === this.srcKey) return;
    this.srcKey = key;
    const d = new ArrayBuffer(16 * Math.min(512, srcs.length));
    const f = new Float32Array(d);
    const u = new Uint32Array(d);
    srcs.slice(0, 512).forEach((s, i) => {
      f[4 * i] = s.x;
      f[4 * i + 1] = s.y;
      u[4 * i + 2] = s.channel;
    });
    if (d.byteLength) this.device.queue.writeBuffer(this.srcBuf, 0, d);
    this.srcCount = Math.min(512, srcs.length);
  }

  clear() {
    for (const b of this.bufs) this.device.queue.writeBuffer(b, 0, new Float32Array(this.nx * this.ny * 4));
  }

  private uniform(which: 0 | 1, dt: number, sign: number): GPUBuffer {
    const d = new ArrayBuffer(32);
    const u = new Uint32Array(d);
    const f = new Float32Array(d);
    u[0] = this.nx;
    u[1] = this.ny;
    f[2] = dt;
    f[3] = sign;
    u[4] = this.srcCount;
    f[5] = SOURCE_R;
    const b = this.unis[which];
    this.device.queue.writeBuffer(b, 0, d);
    return b;
  }

  /** Carry the dye through `steps` lattice steps with the frame's velocity, feeding the sources each sub-step. */
  encode(enc: GPUCommandEncoder, steps: number, mac: GPUBuffer) {
    if (steps <= 0 || this.srcCount === 0) return;
    const sub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((steps * 0.1) / SUBSTEP_CELLS)));
    const dt = steps / sub;
    const fwdU = this.uniform(0, dt, 1);
    const backU = this.uniform(1, dt, -1);
    const n = this.nx * this.ny;
    const groups = Math.ceil(n / WG);
    const gx = Math.min(groups, 32768);
    const gy = Math.ceil(groups / gx);
    const bg = (pipe: GPUComputePipeline, uni: GPUBuffer, bufs: GPUBuffer[]) =>
      this.device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: mac } }, { binding: 1, resource: { buffer: uni } }, ...bufs.map((b, i) => ({ binding: 2 + i, resource: { buffer: b } }))],
      });
    const side = 2 * Math.ceil(SOURCE_R) + 1;
    const pass = enc.beginComputePass({ label: 'dye' });
    for (let s = 0; s < sub; s++) {
      const c = this.bufs[this.cur];
      const [fwd, back, out] = [1, 2, 3].map((o) => this.bufs[(this.cur + o) % 4]);
      pass.setPipeline(this.advect);
      pass.setBindGroup(0, bg(this.advect, fwdU, [c, fwd]));
      pass.dispatchWorkgroups(gx, gy);
      pass.setBindGroup(0, bg(this.advect, backU, [fwd, back]));
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.correct);
      pass.setBindGroup(0, bg(this.correct, fwdU, [c, fwd, back, out]));
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.inject);
      pass.setBindGroup(0, bg(this.inject, fwdU, [this.srcBuf, out]));
      pass.dispatchWorkgroups(Math.ceil((this.srcCount * side * side) / 64));
      this.cur = (this.cur + 3) % 4;
    }
    pass.end();
  }

  /** The dye field (for tests). */
  async read(): Promise<Float32Array> {
    const b = this.device.createBuffer({ size: this.nx * this.ny * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.field, 0, b, 0, this.nx * this.ny * 16);
    this.device.queue.submit([enc.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(b.getMappedRange().slice(0));
    b.destroy();
    return out;
  }

  destroy() {
    for (const b of [...this.bufs, this.srcBuf, ...this.unis]) b.destroy();
  }
}
