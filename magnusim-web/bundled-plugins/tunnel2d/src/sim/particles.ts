// Flow markers on the GPU: tracer particles over the whole tunnel, and the particles of
// rakes (streaks: a continuous thread from each emitter; timelines: a whole line released
// at intervals). Each frame the particles are carried by the velocity field (midpoint
// steps of under a cell, so they never cut through a body; one that gets inside a body
// is pushed back out along the distance field). Tracers are drawn as short segments from
// where they were to where they are into a trail texture that fades a little every frame.
// A rake's particles are drawn as the lines they make: a streak joins the particles one
// emitter released one after another, a timeline the particles released together.
//
// A particle is two vec4s: pos (x, y, previous x, previous y) in lattice cells, and meta
// (age in steps, source: -1 for a tracer or the rake's index, colour index, alive). An
// age below 0 is a particle emitted part-way through the frame: it waits that long
// before it moves, so emission is continuous however many steps a frame takes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { COMMON, MAX_BODIES, TABLES, WG } from './kernels';

/** Largest motion (cells) a particle makes in one sub-step. */
const SUBSTEP_CELLS = 0.8;
/** The fastest the flow is expected to go (lattice), for the sub-step count. */
const U_EXPECTED_MAX = 0.12;
const MAX_SUBSTEPS = 160;
export const MAX_RAKE_COLORS = 8;
/** Streak particles one emitter releases per cell the flow moves. */
const STREAK_PER_CELL = 1.4;
/** Particles in one timeline, and timelines alive at once. */
const TIMELINE_POINTS = 320;
const TIMELINES = 14;

export const advectShader = () => `
struct A {
  count: u32, substeps: u32, dt: f32, seed: u32,
  nx: f32, ny: f32, outX: f32, respawnX0: f32,
  respawnW: f32, maxAge: f32, wrapY: u32, pad: u32,
};
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> pmeta: array<vec4f>;
@group(0) @binding(3) var<uniform> P: Params;
@group(0) @binding(4) var<storage, read> B: array<Body>;
@group(0) @binding(5) var<storage, read> sdf: array<f32>;
@group(0) @binding(6) var<uniform> Ad: A;
${TABLES}
${COMMON}

fn hash(u: u32) -> u32 {
  var x = u;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn rnd(a: u32, b: u32) -> f32 { return f32(hash(a * 1664525u + hash(b)) & 0xffffffu) / 16777216.0; }

fn vel(p: vec2f) -> vec2f {
  let c = clamp(p, vec2f(0.0), vec2f(Ad.nx - 1.001, Ad.ny - 1.001));
  let i = u32(c.x);
  let j = u32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let nx = u32(Ad.nx);
  let k = i + j * nx;
  return mix(mix(mac[k].xy, mac[k + 1u].xy, f.x), mix(mac[k + nx].xy, mac[k + nx + 1u].xy, f.x), f.y);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${WG}u;
  if (i >= Ad.count) { return; }
  var m = pmeta[i];
  if (m.w < 0.5) { return; }
  var q = pos[i].xy;
  var prev = q;
  var gone = false;
  var bp: array<vec4f, ${MAX_BODIES}>;
  for (var s = 0u; s < Ad.substeps; s++) {
    m.x += Ad.dt;
    if (m.x < 0.0) { prev = q; continue; }
    let v1 = vel(q);
    q += Ad.dt * vel(q + 0.5 * Ad.dt * v1);
    if (P.nBodies > 0u) {
      let near = poses(q, f32(s + 1u) / f32(Ad.substeps), &bp);
      if (near != 0u) {
        let h = sdfAt(q, near, &bp);
        if (h.d < 0.35) {
          let e = 0.5;
          let g = vec2f(sdfAt(q + vec2f(e, 0.0), near, &bp).d - sdfAt(q - vec2f(e, 0.0), near, &bp).d,
                        sdfAt(q + vec2f(0.0, e), near, &bp).d - sdfAt(q - vec2f(0.0, e), near, &bp).d);
          let gl = length(g);
          if (gl > 1e-6) { q += (g / gl) * (0.35 - h.d); }
          // Deep inside (where the field is flat, so there is no way out to follow): the
          // particle cannot be put back on the surface; it leaves the flow.
          if (gl <= 1e-6 || sdfAt(q, near, &bp).d < 0.0) { gone = true; break; }
        }
      }
    }
    if (Ad.wrapY == 1u && (q.y < 0.0 || q.y > Ad.ny - 1.0)) {
      q.y = q.y - floor(q.y / (Ad.ny - 1.0)) * (Ad.ny - 1.0);
      prev = q;
    }
    if (q.x < 0.0 || q.x > Ad.outX || q.y < 0.0 || q.y > Ad.ny - 1.0 || q.x != q.x || q.y != q.y) { gone = true; break; }
  }
  if (m.y < 0.0) {
    if (gone || m.x > Ad.maxAge) {
      // A tracer that left (or grew too old in a dead-water zone) comes back in with the
      // stream: anywhere in the strip the inflow brought in this frame.
      q = vec2f(Ad.respawnX0 + rnd(i, Ad.seed) * Ad.respawnW, rnd(i, Ad.seed ^ 0x9e3779b9u) * (Ad.ny - 1.0));
      m.x = 0.0;
      prev = q;
    }
  } else if (gone) {
    m.w = 0.0;
  }
  pos[i] = vec4f(q, prev);
  pmeta[i] = m;
}
`;

export const drawShader = () => `
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, pad: f32,
  tracer: vec4f,
  colors: array<vec4f, ${MAX_RAKE_COLORS}>,
};
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> pmeta: array<vec4f>;
@group(0) @binding(2) var<uniform> Dr: D;

struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let m = pmeta[ii];
  if (m.w < 0.5 || m.x < 0.0) { o.p = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let q = pos[ii];
  let b = vec2f((q.x - Dr.ox) / Dr.scale, (Dr.oy - q.y) / Dr.scale);
  var a = vec2f((q.z - Dr.ox) / Dr.scale, (Dr.oy - q.w) / Dr.scale);
  if (distance(a, b) > Dr.maxSeg) { a = b; }
  var dir = b - a;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / max(len, 1e-6), len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  let hw = Dr.halfW;
  // Two triangles around the segment, a little longer than it on each end.
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let along = select(a - dir * hw, b + dir * hw, c.x > 0.5);
  let px = along + nrm * hw * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  o.c = select(Dr.colors[min(u32(m.z), ${MAX_RAKE_COLORS - 1}u)], Dr.tracer, m.y < 0.0);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  // Soft edges across the segment's width.
  let a = i.c.a * clamp((1.0 - abs(i.d)) * 2.0, 0.0, 1.0);
  return vec4f(i.c.rgb, a);
}
`;

/**
 * Rake lines: a segment from particle i to particle i + 1 of the same rake when both are
 * alive and were released close together (their ages differ by less than the rake's
 * gap: a streak's emission interval, a timeline's nothing), so a ring's wrap and the join
 * between two timelines are never drawn. Segments stretched past maxSeg pixels are left
 * out (a streak torn apart in the wake).
 */
export const lineShader = () => `
struct D {
  scale: f32, ox: f32, oy: f32, w: f32,
  h: f32, halfW: f32, maxSeg: f32, first: f32,
  colors: array<vec4f, ${MAX_RAKE_COLORS}>,
  gaps: array<vec4f, ${MAX_RAKE_COLORS}>,
};
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@group(0) @binding(1) var<storage, read> pmeta: array<vec4f>;
@group(0) @binding(2) var<uniform> Dr: D;
struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let i = u32(Dr.first) + ii;
  let ma = pmeta[i];
  let mb = pmeta[i + 1u];
  o.p = vec4f(2.0, 2.0, 0.0, 1.0);
  if (ma.w < 0.5 || mb.w < 0.5 || ma.x < 0.0 || mb.x < 0.0 || ma.y < 0.0 || ma.y != mb.y) { return o; }
  let src = min(u32(ma.y), ${MAX_RAKE_COLORS - 1}u);
  if (abs(ma.x - mb.x) > Dr.gaps[src].x) { return o; }
  let qa = pos[i];
  let qb = pos[i + 1u];
  let a = vec2f((qa.x - Dr.ox) / Dr.scale, (Dr.oy - qa.y) / Dr.scale);
  let b = vec2f((qb.x - Dr.ox) / Dr.scale, (Dr.oy - qb.y) / Dr.scale);
  let len = distance(a, b);
  if (len > Dr.maxSeg) { return o; }
  var dir = select(vec2f(1.0, 0.0), (b - a) / max(len, 1e-6), len > 1e-4);
  let n = vec2f(-dir.y, dir.x);
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let px = select(a - dir * Dr.halfW * 0.5, b + dir * Dr.halfW * 0.5, c.x > 0.5) + n * Dr.halfW * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  o.c = Dr.colors[min(u32(ma.z), ${MAX_RAKE_COLORS - 1}u)];
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.c.rgb, i.c.a * clamp((1.0 - abs(i.d)) * 1.8, 0.0, 1.0));
}
`;

export const fadeShader = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.0); }
`;

export interface RakeGpu {
  id: string;
  kind: 'streaks' | 'timelines';
  /** Ends of the rake (lattice cells). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  emitters: number;
  color: number;
}

interface RakeState {
  rake: RakeGpu;
  index: number;
  base: number;
  /** Streaks: slots per emitter; timelines: slots per line. */
  per: number;
  slots: number;
  head: number;
  acc: number;
}

export interface ParticleFrame {
  steps: number;
  /** Lattice inflow speed (cells per step). */
  u: number;
  nx: number;
  ny: number;
  absorbInX: number;
  outX: number;
  wrapY: boolean;
}

export class Particles {
  private device: GPUDevice;
  private pos: GPUBuffer | null = null;
  private meta: GPUBuffer | null = null;
  private capacity = 0;
  private tracers = 0;
  private rakes: RakeState[] = [];
  private layoutKey = '';
  private advectPipe: GPUComputePipeline;
  private advectUni: GPUBuffer;
  private drawPipe: GPURenderPipeline;
  private fadePipe: GPURenderPipeline;
  private drawUni: GPUBuffer;
  private linePipe: GPURenderPipeline | null = null;
  private lineUni: GPUBuffer;
  private seed = 1;
  /** Steps between two particles one streak emitter releases. */
  private streakGap = 1;
  trail: GPUTexture | null = null;
  private trailKey = '';
  private clearTrail = true;
  readonly format: GPUTextureFormat = 'rgba16float';

  constructor(device: GPUDevice) {
    this.device = device;
    this.advectPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: advectShader(), label: 'particles advect' }), entryPoint: 'main' } });
    this.advectUni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const draw = device.createShaderModule({ code: drawShader(), label: 'particles draw' });
    const over: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.drawPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: draw, entryPoint: 'vs' },
      fragment: { module: draw, entryPoint: 'fs', targets: [{ format: this.format, blend: over }] },
      primitive: { topology: 'triangle-list' },
    });
    const fade = device.createShaderModule({ code: fadeShader, label: 'trail fade' });
    this.fadePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fade, entryPoint: 'vs' },
      fragment: {
        module: fade,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: { color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.drawUni = device.createBuffer({ size: 48 + 16 * MAX_RAKE_COLORS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lineUni = device.createBuffer({ size: 32 + 32 * MAX_RAKE_COLORS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Draw the rakes' lines into a render pass whose target has `format` (the canvas's). */
  encodeRakeLines(pass: GPURenderPassEncoder, format: GPUTextureFormat, size: { w: number; h: number }, view: { scale: number; ox: number; oy: number }, colors: [number, number, number, number][], dpr: number) {
    if (!this.pos || !this.meta || !this.rakes.length) return;
    if (!this.linePipe) {
      const m = this.device.createShaderModule({ code: lineShader(), label: 'rake lines' });
      this.linePipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: {
          module: m,
          entryPoint: 'fs',
          targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }
    const d = new Float32Array(8 + 8 * MAX_RAKE_COLORS);
    d.set([view.scale, view.ox, view.oy, size.w, size.h, 1.3 * dpr, 80 * dpr, this.tracers]);
    colors.slice(0, MAX_RAKE_COLORS).forEach((c, i) => d.set(c, 8 + 4 * i));
    for (const r of this.rakes) {
      // A streak's neighbours were released one emission interval apart; a timeline's together.
      d[8 + 4 * MAX_RAKE_COLORS + 4 * Math.min(r.index, MAX_RAKE_COLORS - 1)] = r.rake.kind === 'streaks' ? this.streakGap * 2.5 : 0.5;
    }
    this.device.queue.writeBuffer(this.lineUni, 0, d);
    const bg = this.device.createBindGroup({
      layout: this.linePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pos } },
        { binding: 1, resource: { buffer: this.meta } },
        { binding: 2, resource: { buffer: this.lineUni } },
      ],
    });
    pass.setPipeline(this.linePipe);
    pass.setBindGroup(0, bg);
    const segments = this.capacity - this.tracers - 1;
    if (segments > 0) pass.draw(6, segments);
  }

  get count() {
    return this.capacity;
  }
  get tracerCount() {
    return this.tracers;
  }
  get buffers() {
    return this.pos && this.meta ? { pos: this.pos, meta: this.meta } : null;
  }
  /** Which rake owns each pool (for tests and readbacks). */
  get pools() {
    return this.rakes.map((r) => ({ id: r.rake.id, index: r.index, base: r.base, slots: r.slots }));
  }

  /**
   * Lay the pools out: `tracers` tracer particles, then each rake's pool. A changed layout
   * starts every particle again (tracers spread over the tunnel, rake pools empty).
   */
  configure(tracers: number, rakes: RakeGpu[], f: Pick<ParticleFrame, 'nx' | 'ny' | 'absorbInX' | 'outX'>) {
    const states: RakeState[] = [];
    let base = tracers;
    rakes.forEach((r, index) => {
      const per = r.kind === 'streaks' ? Math.ceil(f.nx * 1.2 * STREAK_PER_CELL) : TIMELINE_POINTS;
      const slots = r.kind === 'streaks' ? per * r.emitters : per * TIMELINES;
      states.push({ rake: r, index, base, per, slots, head: 0, acc: 0 });
      base += slots;
    });
    const key = `${tracers}|${f.nx}x${f.ny}|${rakes.map((r) => `${r.id}:${r.kind}:${r.emitters}`).join(',')}`;
    // Same pools: keep the particles, take the rakes' new positions and colours.
    if (key === this.layoutKey) {
      states.forEach((s, i) => {
        this.rakes[i].rake = s.rake;
      });
      return;
    }
    this.layoutKey = key;
    this.rakes = states;
    this.tracers = tracers;
    const capacity = Math.max(1, base);
    if (capacity > this.capacity || !this.pos) {
      this.pos?.destroy();
      this.meta?.destroy();
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      this.pos = this.device.createBuffer({ size: capacity * 16, usage });
      this.meta = this.device.createBuffer({ size: capacity * 16, usage });
    }
    this.capacity = capacity;
    const pos = new Float32Array(capacity * 4);
    const meta = new Float32Array(capacity * 4);
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < tracers; i++) {
      const x = f.absorbInX + rnd() * (f.outX - f.absorbInX);
      const y = rnd() * (f.ny - 1);
      pos.set([x, y, x, y], 4 * i);
      meta.set([0, -1, 0, 1], 4 * i);
    }
    this.device.queue.writeBuffer(this.pos!, 0, pos);
    this.device.queue.writeBuffer(this.meta!, 0, meta);
    this.clearTrail = true;
  }

  /** Release this frame's rake particles (written before the frame's commands run). */
  private emit(f: ParticleFrame) {
    if (!this.pos || !this.meta || f.steps <= 0) return;
    for (const r of this.rakes) {
      const { rake } = r;
      if (rake.kind === 'streaks') {
        // One particle per 1/STREAK_PER_CELL cells the flow moves, from every emitter.
        this.streakGap = 1 / (f.u * STREAK_PER_CELL);
        r.acc += f.u * f.steps * STREAK_PER_CELL;
        const n = Math.min(r.per, Math.floor(r.acc));
        r.acc -= n;
        if (n <= 0) continue;
        const pos = new Float32Array(n * 4);
        const meta = new Float32Array(n * 4);
        for (let e = 0; e < rake.emitters; e++) {
          const t = rake.emitters === 1 ? 0.5 : e / (rake.emitters - 1);
          const x = rake.x0 + (rake.x1 - rake.x0) * t;
          const y = rake.y0 + (rake.y1 - rake.y0) * t;
          for (let k = 0; k < n; k++) {
            pos.set([x, y, x, y], 4 * k);
            meta.set([-((k + 0.5) / n) * f.steps, r.index, rake.color, 1], 4 * k);
          }
          this.writeRing(r.base + e * r.per, r.per, r.head, pos, meta, n);
        }
        r.head = (r.head + n) % r.per;
      } else {
        // A whole line every tenth of the tunnel's crossing.
        const every = (f.nx * 0.1) / f.u;
        r.acc += f.steps;
        while (r.acc >= every) {
          r.acc -= every;
          const wait = -Math.max(0, f.steps - r.acc);
          const pos = new Float32Array(r.per * 4);
          const meta = new Float32Array(r.per * 4);
          for (let k = 0; k < r.per; k++) {
            const t = k / (r.per - 1);
            const x = rake.x0 + (rake.x1 - rake.x0) * t;
            const y = rake.y0 + (rake.y1 - rake.y0) * t;
            pos.set([x, y, x, y], 4 * k);
            meta.set([wait, r.index, rake.color, 1], 4 * k);
          }
          const line = r.head % TIMELINES;
          this.device.queue.writeBuffer(this.pos, (r.base + line * r.per) * 16, pos);
          this.device.queue.writeBuffer(this.meta, (r.base + line * r.per) * 16, meta);
          r.head = (r.head + 1) % TIMELINES;
        }
      }
    }
  }

  private writeRing(start: number, per: number, head: number, pos: Float32Array<ArrayBuffer>, meta: Float32Array<ArrayBuffer>, n: number) {
    const first = Math.min(n, per - head);
    this.device.queue.writeBuffer(this.pos!, (start + head) * 16, pos, 0, first * 4);
    this.device.queue.writeBuffer(this.meta!, (start + head) * 16, meta, 0, first * 4);
    if (n > first) {
      this.device.queue.writeBuffer(this.pos!, start * 16, pos, first * 4, (n - first) * 4);
      this.device.queue.writeBuffer(this.meta!, start * 16, meta, first * 4, (n - first) * 4);
    }
  }

  /** Carry the particles through the frame's steps (and release the rakes' new ones). */
  encodeAdvect(enc: GPUCommandEncoder, f: ParticleFrame, mac: GPUBuffer, solverBufs: { params: GPUBuffer; bodies: GPUBuffer; sdf: GPUBuffer }) {
    if (!this.pos || !this.meta || f.steps <= 0) return;
    this.emit(f);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((f.steps * U_EXPECTED_MAX) / SUBSTEP_CELLS)));
    const a = new ArrayBuffer(48);
    const u = new Uint32Array(a);
    const fl = new Float32Array(a);
    u[0] = this.capacity;
    u[1] = substeps;
    fl[2] = f.steps / substeps;
    u[3] = this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    fl[4] = f.nx;
    fl[5] = f.ny;
    fl[6] = f.outX;
    fl[7] = f.absorbInX;
    fl[8] = Math.max(1, f.u * f.steps);
    fl[9] = (3 * f.nx) / f.u;
    u[10] = f.wrapY ? 1 : 0;
    this.device.queue.writeBuffer(this.advectUni, 0, a);
    const bg = this.device.createBindGroup({
      layout: this.advectPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: mac } },
        { binding: 1, resource: { buffer: this.pos } },
        { binding: 2, resource: { buffer: this.meta } },
        { binding: 3, resource: { buffer: solverBufs.params } },
        { binding: 4, resource: { buffer: solverBufs.bodies } },
        { binding: 5, resource: { buffer: solverBufs.sdf } },
        { binding: 6, resource: { buffer: this.advectUni } },
      ],
    });
    const groups = Math.ceil(this.capacity / WG);
    const gx = Math.min(groups, 32768);
    const pass = enc.beginComputePass({ label: 'particles' });
    pass.setPipeline(this.advectPipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    pass.end();
  }

  /** The trail texture, at the canvas's size (made again, and cleared, when it changes). */
  private ensureTrail(w: number, h: number, viewKey: string) {
    const key = `${w}x${h}`;
    if (!this.trail || key !== this.trailKey) {
      this.trail?.destroy();
      this.trail = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.trailKey = key;
      this.clearTrail = true;
    }
    if (viewKey !== this.lastView) {
      this.lastView = viewKey;
      this.clearTrail = true;
    }
  }
  private lastView = '';

  /**
   * Fade the trail by `keep` (0: no trail beyond this frame's motion) and draw the particles
   * into it. `view` is the canvas transform (cells per device pixel, top-left in cells).
   */
  encodeDraw(
    enc: GPUCommandEncoder,
    size: { w: number; h: number },
    view: { scale: number; ox: number; oy: number },
    keep: number,
    show: { tracers: boolean },
    colors: { tracer: [number, number, number, number] },
  ) {
    const viewKey = `${view.scale.toFixed(9)}|${view.ox.toFixed(4)}|${view.oy.toFixed(4)}`;
    this.ensureTrail(size.w, size.h, viewKey);
    const target = this.trail!.createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: this.clearTrail ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    this.clearTrail = false;
    pass.setPipeline(this.fadePipe);
    pass.setBlendConstant({ r: keep, g: keep, b: keep, a: keep });
    pass.draw(3);
    if (this.pos && this.meta && show.tracers && this.tracers > 0) {
      const d = new Float32Array(12 + 4 * MAX_RAKE_COLORS);
      d.set([view.scale, view.ox, view.oy, size.w, size.h, 0.75, 60, 0]);
      d.set(colors.tracer, 8);
      this.device.queue.writeBuffer(this.drawUni, 0, d);
      const bg = this.device.createBindGroup({
        layout: this.drawPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.pos } },
          { binding: 1, resource: { buffer: this.meta } },
          { binding: 2, resource: { buffer: this.drawUni } },
        ],
      });
      pass.setPipeline(this.drawPipe);
      pass.setBindGroup(0, bg);
      pass.draw(6, this.tracers);
    }
    pass.end();
  }

  /** Every particle's position and meta (for tests). */
  async read(): Promise<{ pos: Float32Array; meta: Float32Array } | null> {
    if (!this.pos || !this.meta) return null;
    const bytes = this.capacity * 16;
    const a = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const b = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.pos, 0, a, 0, bytes);
    enc.copyBufferToBuffer(this.meta, 0, b, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    const out = { pos: new Float32Array(a.getMappedRange().slice(0)), meta: new Float32Array(b.getMappedRange().slice(0)) };
    a.destroy();
    b.destroy();
    return out;
  }

  /** Start the trail afresh (after a reset of the flow). */
  clear() {
    this.clearTrail = true;
    this.layoutKey = '';
  }

  destroy() {
    this.pos?.destroy();
    this.meta?.destroy();
    this.trail?.destroy();
    this.advectUni.destroy();
    this.drawUni.destroy();
    this.lineUni.destroy();
  }
}
