// Streamlines of the current flow: lines everywhere tangent to the velocity, traced on
// the GPU from seeds spaced evenly up the tunnel just past the inlet's absorbing layer
// (midpoint steps along the unit direction; a line stops at a body, the tunnel's edge or
// where the flow stands still). They are the flow's instantaneous picture: in shedding,
// unsteady flow they differ from the particles' paths, which is the point of having both.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Points along each line. */
export const LINE_POINTS = 1024;
export const MAX_LINES = 512;

export const traceShader = /* wgsl */ `
struct L { nx: f32, ny: f32, lines: u32, K: u32, x0: f32, y0: f32, dy: f32, h: f32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> verts: array<vec4f>;
@group(0) @binding(2) var<uniform> Lp: L;

fn at(p: vec2f) -> vec4f {
  let c = clamp(p, vec2f(0.0), vec2f(Lp.nx - 1.001, Lp.ny - 1.001));
  let i = u32(c.x);
  let j = u32(c.y);
  let f = c - vec2f(f32(i), f32(j));
  let nx = u32(Lp.nx);
  let k = i + j * nx;
  return mix(mix(mac[k], mac[k + 1u], f.x), mix(mac[k + nx], mac[k + nx + 1u], f.x), f.y);
}
fn dir(p: vec2f) -> vec2f {
  let v = at(p).xy;
  let l = length(v);
  return select(vec2f(0.0), v / l, l > 1e-7);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let s = gid.x;
  if (s >= Lp.lines) { return; }
  var q = vec2f(Lp.x0, Lp.y0 + Lp.dy * (f32(s) + 0.5));
  var alive = true;
  for (var k = 0u; k < Lp.K; k++) {
    verts[s * Lp.K + k] = vec4f(q, select(0.0, 1.0, alive), 0.0);
    if (!alive) { continue; }
    let d1 = dir(q);
    let d2 = dir(q + 0.5 * Lp.h * d1);
    if (dot(d2, d2) < 0.5) { alive = false; continue; }
    q += Lp.h * d2;
    if (q.x < 0.0 || q.y < 0.0 || q.x > Lp.nx - 1.0 || q.y > Lp.ny - 1.0 || at(q).w > 0.5) { alive = false; }
  }
}
`;

export const drawShader = /* wgsl */ `
struct D { scale: f32, ox: f32, oy: f32, w: f32, h: f32, halfW: f32, K: f32, pad: f32, color: vec4f };
@group(0) @binding(0) var<storage, read> verts: array<vec4f>;
@group(0) @binding(1) var<uniform> Dr: D;
struct Out { @builtin(position) p: vec4f, @location(0) d: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var o: Out;
  let K = u32(Dr.K);
  let line = ii / (K - 1u);
  let k = ii % (K - 1u);
  let va = verts[line * K + k];
  let vb = verts[line * K + k + 1u];
  if (va.z < 0.5 || vb.z < 0.5) { o.p = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let a = vec2f((va.x - Dr.ox) / Dr.scale, (Dr.oy - va.y) / Dr.scale);
  let b = vec2f((vb.x - Dr.ox) / Dr.scale, (Dr.oy - vb.y) / Dr.scale);
  var dv = b - a;
  let len = length(dv);
  dv = select(vec2f(1.0, 0.0), dv / max(len, 1e-6), len > 1e-4);
  let n = vec2f(-dv.y, dv.x);
  let corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corner[vi];
  let px = select(a, b, c.x > 0.5) + n * Dr.halfW * c.y;
  o.p = vec4f(px.x / Dr.w * 2.0 - 1.0, 1.0 - px.y / Dr.h * 2.0, 0.0, 1.0);
  o.d = c.y;
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(Dr.color.rgb, Dr.color.a * clamp((1.0 - abs(i.d)) * 1.6, 0.0, 1.0));
}
`;

export class Streamlines {
  private device: GPUDevice;
  private verts: GPUBuffer;
  private trace: GPUComputePipeline;
  private draw: GPURenderPipeline;
  private traceUni: GPUBuffer;
  private drawUni: GPUBuffer;
  private lines = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.verts = device.createBuffer({ size: MAX_LINES * LINE_POINTS * 16, usage: GPUBufferUsage.STORAGE });
    this.trace = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: traceShader, label: 'streamlines trace' }), entryPoint: 'main' } });
    const m = device.createShaderModule({ code: drawShader, label: 'streamlines draw' });
    this.draw = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs' },
      fragment: {
        module: m,
        entryPoint: 'fs',
        targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.traceUni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawUni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  get count() {
    return this.lines;
  }

  /** Trace `lines` streamlines from x0 (cells) through the field in `mac`. */
  encodeTrace(enc: GPUCommandEncoder, mac: GPUBuffer, grid: { nx: number; ny: number }, x0: number, lines: number) {
    this.lines = Math.max(1, Math.min(MAX_LINES, Math.floor(lines)));
    const d = new ArrayBuffer(32);
    const f = new Float32Array(d);
    const u = new Uint32Array(d);
    f[0] = grid.nx;
    f[1] = grid.ny;
    u[2] = this.lines;
    u[3] = LINE_POINTS;
    f[4] = x0;
    f[5] = 0;
    f[6] = (grid.ny - 1) / this.lines;
    // Long enough to cross the tunnel and a bit (a line round a body is longer than straight).
    f[7] = Math.max(0.5, (grid.nx * 1.4) / LINE_POINTS);
    this.device.queue.writeBuffer(this.traceUni, 0, d);
    const bg = this.device.createBindGroup({
      layout: this.trace.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: mac } },
        { binding: 1, resource: { buffer: this.verts } },
        { binding: 2, resource: { buffer: this.traceUni } },
      ],
    });
    const pass = enc.beginComputePass({ label: 'streamlines' });
    pass.setPipeline(this.trace);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.lines / 64));
    pass.end();
  }

  /** Draw the traced lines into a render pass whose target has `format`. */
  encodeDraw(pass: GPURenderPassEncoder, size: { w: number; h: number }, view: { scale: number; ox: number; oy: number }, color: [number, number, number, number], dpr: number) {
    if (!this.lines) return;
    this.device.queue.writeBuffer(this.drawUni, 0, new Float32Array([view.scale, view.ox, view.oy, size.w, size.h, 0.7 * dpr, LINE_POINTS, 0, ...color]));
    const bg = this.device.createBindGroup({
      layout: this.draw.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.verts } },
        { binding: 1, resource: { buffer: this.drawUni } },
      ],
    });
    pass.setPipeline(this.draw);
    pass.setBindGroup(0, bg);
    pass.draw(6, this.lines * (LINE_POINTS - 1));
  }

  destroy() {
    this.verts.destroy();
    this.traceUni.destroy();
    this.drawUni.destroy();
  }
}
