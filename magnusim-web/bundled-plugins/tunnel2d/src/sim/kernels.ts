// WGSL for the tunnel: the D2Q9 step (pull streaming fused with the collision), the
// macroscopic pass, the displayed field and its sampled copy. Generated per direction
// so each pull is straight-line code.
//
// The physics is the one T0 validated (Schäfer–Turek 2D-2, 40 cells per D: St 0.302,
// Cd 3.256): recursive-regularized collision (third order) with an optional
// Smagorinsky model, Zou–He velocity inlet and pressure outlet, absorbing layers at
// both ends (relaxing to the free stream) with a viscosity ramp at the outlet, and
// Bouzidi's interpolated bounce-back on bodies, with the moving-wall term and
// Galilean-invariant momentum exchange. Bodies are signed distance fields in their own
// frame, sampled at the pose interpolated for each step; cells inside hold equilibrium
// at the wall's velocity, so a cell a moving body uncovers starts from it.
// SPDX-License-Identifier: GPL-3.0-or-later

export const WG = 128;
export const MAX_BODIES = 8;
/** Steps one frame may take (the per-step uniforms and the force ring are this long). */
export const MAX_STEPS = 2048;
/** Fixed-point scale of the force atomics (2^20). */
export const FORCE_FIX = 1048576;
/** Index of the health counter (cells with a density out of range) after the force ring. */
export const HEALTH_SLOT = MAX_STEPS * MAX_BODIES * 2;
export const FORCE_WORDS = HEALTH_SLOT + 4;
/** The limiter's bounds: density 1 ± LIMIT_RHO, speed LIMIT_U (lattice). */
export const LIMIT_RHO = 0.1;
export const LIMIT_U = 0.2;

export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
/** The direction mirrored in y (a slip wall's reflection). */
export const MIRY = [0, 1, 4, 3, 2, 8, 7, 6, 5];

export const WALLS = { slip: 0, noslip: 1, periodic: 2 } as const;

const n10 = (v: number) => v.toFixed(10);
const n1 = (v: number) => v.toFixed(1);

/** Shared declarations: the parameters, the bodies and their distance fields. */
export const COMMON = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, n: u32, nBodies: u32,
  omega: f32, smag: f32, uIn: f32, absorb: f32,
  absorbIn: f32, spongeX: f32, frameSteps: u32, profile: u32,
};
struct Body {
  c0: vec2f, c1: vec2f,
  a0: f32, a1: f32, bound: f32, texel: f32,
  org: vec2f, w: u32, h: u32,
  off: u32, p0: u32, p1: u32, p2: u32,
};
struct Hit { d: f32, b: u32 };

fn sdfLocal(b: u32, lp: vec2f) -> f32 {
  let bd = B[b];
  let uv = (lp - bd.org) / bd.texel;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > f32(bd.w - 1u) || uv.y > f32(bd.h - 1u)) { return 4.0; }
  let i = min(u32(uv.x), bd.w - 2u);
  let j = min(u32(uv.y), bd.h - 2u);
  let f = uv - vec2f(f32(i), f32(j));
  let k = bd.off + j * bd.w + i;
  return mix(mix(sdf[k], sdf[k + 1u], f.x), mix(sdf[k + bd.w], sdf[k + bd.w + 1u], f.x), f.y);
}

/** The nearest body's signed distance (cells) at p, over the bodies in the mask. */
fn sdfAt(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${MAX_BODIES}>>) -> Hit {
  var h = Hit(4.0, 0u);
  for (var b = 0u; b < P.nBodies; b++) {
    if ((near & (1u << b)) == 0u) { continue; }
    let q = (*bp)[b];
    let r = p - q.xy;
    let lp = vec2f(q.z * r.x + q.w * r.y, -q.w * r.x + q.z * r.y);
    let d = sdfLocal(b, lp);
    if (d < h.d) { h = Hit(d, b); }
  }
  return h;
}

/** A body's wall velocity (cells per step) at p: its translation and its turn. */
fn wallU(b: u32, p: vec2f, c: vec2f) -> vec2f {
  let bd = B[b];
  let fs = f32(P.frameSteps);
  let v = (bd.c1 - bd.c0) / fs;
  let w = (bd.a1 - bd.a0) / fs;
  return v + w * vec2f(-(p.y - c.y), p.x - c.x);
}

/** Each body's pose at fraction t of the frame (x, y, cos, sin) and the ones near p. */
fn poses(p: vec2f, t: f32, bp: ptr<function, array<vec4f, ${MAX_BODIES}>>) -> u32 {
  var near = 0u;
  for (var b = 0u; b < P.nBodies; b++) {
    let bd = B[b];
    let c = mix(bd.c0, bd.c1, t);
    let a = mix(bd.a0, bd.a1, t);
    (*bp)[b] = vec4f(c, cos(a), sin(a));
    if (distance(p, c) < bd.bound + 2.0) { near |= 1u << b; }
  }
  return near;
}

fn feqAt(k: u32, rho: f32, u: vec2f) -> f32 {
  let c = vec2f(CXF[k], CYF[k]);
  let cu = dot(c, u);
  return WF[k] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
`;

export const TABLES = /* wgsl */ `
const CXF = array<f32, 9>(${CX.map(n1).join(', ')});
const CYF = array<f32, 9>(${CY.map(n1).join(', ')});
const WF = array<f32, 9>(${W.map(n10).join(', ')});
`;

/** The step kernel. Overrides: WALLS (0 slip, 1 no-slip, 2 periodic), SMAG (Smagorinsky on). */
export function stepShader(): string {
  const rd = (k: number | string, idx: string) => `fin[${k}u * P.n + ${idx}]`;
  const eqU = (k: number, rho: string, ux: string, uy: string) =>
    `(${n10(W[k])} * ${rho} * (1.0 + 3.0 * (${n1(CX[k])} * ${ux} + ${n1(CY[k])} * ${uy}) + 4.5 * (${n1(CX[k])} * ${ux} + ${n1(CY[k])} * ${uy}) * (${n1(CX[k])} * ${ux} + ${n1(CY[k])} * ${uy}) - 1.5 * (${ux} * ${ux} + ${uy} * ${uy})))`;

  let pull = '';
  for (let k = 1; k < 9; k++) {
    const i = OPP[k];
    const cx = CX[k];
    const cy = CY[k];
    let xEdge = '';
    if (cx > 0) xEdge = `if (x == 0u) { f${k} = 0.0; } else `;
    if (cx < 0) xEdge = `if (x == P.nx - 1u) { f${k} = ${rd(k, 'idx')}; } else `;
    let yEdge = '';
    if (cy !== 0) {
      const out = cy > 0 ? 'y == 0u' : 'y == P.ny - 1u';
      const wrapY = cy > 0 ? 'P.ny - 1u' : '0u';
      yEdge = `if (${out}) {
      if (WALLS == 1u) { f${k} = ${rd(i, 'idx')}; }
      else if (WALLS == 0u) { f${k} = ${rd(MIRY[k], `u32(i32(x) - (${cx})) + y * P.nx`)}; }
      else { f${k} = ${rd(k, `u32(i32(x) - (${cx})) + ${wrapY} * P.nx`)}; }
    } else `;
    }
    const cu = `(${n1(cx)} * uw.x + ${n1(cy)} * uw.y)`;
    pull += `
  var f${k}: f32;
  ${xEdge}${yEdge}{
    let sx = i32(x) - (${cx});
    let sy = i32(y) - (${cy});
    let src = u32(sx) + u32(sy) * P.nx;
    var hit = Hit(4.0, 0u);
    if (near != 0u) { hit = sdfAt(vec2f(f32(sx), f32(sy)), near, &bp); }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${i} leaves this cell into the body, q of the way to its wall.
      var q = clamp(d0 / (d0 - hit.d), 0.001, 1.0);
      let bx = i32(x) + (${cx});
      let by = i32(y) + (${cy});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uw = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      let fi = ${rd(i, 'idx')};
      let mw = ${n10(6 * W[k])} * ${cu};
      if (q < 0.5) { f${k} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${rd(i, 'u32(bx) + u32(by) * P.nx')} + mw; }
      else { f${k} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${rd(k, 'idx')} + mw / (2.0 * q); }
      let slot = (S.slot * ${MAX_BODIES}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${n1(CX[i])} * (fi + f${k}) - uw.x * (fi - f${k})) * ${FORCE_FIX}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${n1(CY[i])} * (fi + f${k}) - uw.y * (fi - f${k})) * ${FORCE_FIX}.0)));
    } else {
      f${k} = ${rd(k, 'src')};
    }
  }`;
  }

  let collide = '';
  for (let k = 0; k < 9; k++) collide += `  let e${k} = ${eqU(k, 'rho', 'ux', 'uy')};\n`;
  const neq = (k: number) => `(f${k} - e${k})`;
  collide += `
  let pxx = ${[1, 3, 5, 6, 7, 8].map(neq).join(' + ')};
  let pyy = ${[2, 4, 5, 6, 7, 8].map(neq).join(' + ')};
  let pxy = ${neq(5)} - ${neq(6)} + ${neq(7)} - ${neq(8)};
  var tP = 1.0 / P.omega;
  if (SMAG) {
    let Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
    tP = 0.5 * (tP + sqrt(tP * tP + P.smag * Q / rho));
  }
  var sig = 0.0;
  if (xf > P.spongeX) { let r = (xf - P.spongeX) / (f32(P.nx) - P.spongeX); tP += r * r; sig = P.absorb * r * r; }
  if (xf < P.absorbIn) { let r = (P.absorbIn - xf) / P.absorbIn; sig = P.absorb * r * r; }
  let omP = 1.0 / tP;
  let axxy = 2.0 * ux * pxy + uy * pxx;
  let axyy = 2.0 * uy * pxy + ux * pyy;
  let keep = 1.0 - omP;
`;
  for (let k = 0; k < 9; k++) {
    const cx = CX[k];
    const cy = CY[k];
    const hxx = cx * cx - 1 / 3;
    const hyy = cy * cy - 1 / 3;
    const hxy = cx * cy;
    const hxxy = cx * cx * cy - cy / 3;
    const hxyy = cx * cy * cy - cx / 3;
    collide += `  var o${k} = ${n10(W[k])} * rho * (1.0 + 3.0 * (${n10(cx)} * ux + ${n10(cy)} * uy) + 4.5 * (${n10(hxx)} * ux * ux + ${n10(hyy)} * uy * uy + ${n10(2 * hxy)} * ux * uy) + 13.5 * (${n10(hxxy)} * ux * ux * uy + ${n10(hxyy)} * ux * uy * uy))
    + keep * ${n10(W[k])} * (4.5 * (${n10(hxx)} * pxx + ${n10(hyy)} * pyy + ${n10(2 * hxy)} * pxy) + 13.5 * (${n10(hxxy)} * axxy + ${n10(hxyy)} * axyy));
`;
  }
  collide += `  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({ length: 9 }, (_, k) => `    o${k} = mix(o${k}, ${n10(W[k])} * (1.0 + 3.0 * ${n1(CX[k])} * uT + 4.5 * ${n1(CX[k] * CX[k])} * uT * uT - 1.5 * uT * uT), sig);`).join('\n')}
  }
${Array.from({ length: 9 }, (_, k) => `  fout[${k}u * P.n + idx] = o${k};`).join('\n')}
`;

  return `
override WALLS: u32 = 0u;
override SMAG: bool = false;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(1) @binding(0) var<uniform> S: Step;
${TABLES}
${COMMON}

@compute @workgroup_size(${WG})
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${WG}u;
  if (idx >= P.n) { return; }
  let x = idx % P.nx;
  let y = idx / P.nx;
  let xf = f32(x);
  let p = vec2f(xf, f32(y));
  var bp: array<vec4f, ${MAX_BODIES}>;
  let near = poses(p, f32(S.slot + 1u) / f32(P.frameSteps), &bp);
  var d0 = 4.0;
  if (near != 0u) {
    let h0 = sdfAt(p, near, &bp);
    d0 = h0.d;
    if (d0 < 0.0) {
      let uw = wallU(h0.b, p, bp[h0.b].xy);
      for (var k = 0u; k < 9u; k++) { fout[k * P.n + idx] = feqAt(k, 1.0, uw); }
      return;
    }
  }
  var f0 = ${rd(0, 'idx')};
  ${pull}
  if (x == 0u) {
    var u = P.uIn;
    if (P.profile == 1u) {
      let H = f32(P.ny);
      let yy = f32(y) + 0.5;
      u = 4.0 * P.uIn * yy * (H - yy) / (H * H);
    }
    let r = (f0 + f2 + f4 + 2.0 * (f3 + f6 + f7)) / (1.0 - u);
    f1 = f3 + (2.0 / 3.0) * r * u;
    f5 = f7 - 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
    f8 = f6 + 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
  }
  if (x == P.nx - 1u) {
    let uo = -1.0 + (f0 + f2 + f4 + 2.0 * (f1 + f5 + f8));
    f3 = f1 - (2.0 / 3.0) * uo;
    f7 = f5 + 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
    f6 = f8 - 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
  }
  var rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  if (!(rho > 0.5 && rho < 2.0)) {
    atomicAdd(&force[${HEALTH_SLOT}u], 1);
    atomicMax(&force[${HEALTH_SLOT + 1}u], i32(P.n - idx));
  }
  var ux = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  var uy = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
  // The limiter: flow squeezed in a gap two moving bodies close has nowhere to go. A cell
  // whose density leaves ±${LIMIT_RHO * 100} % or whose speed passes ${LIMIT_U} (4 x the inflow) is put
  // back to equilibrium inside those bounds. Ordinary flow here stays within about 1 %, so
  // only such pockets are touched; each use is counted and the page says so.
  let usq0 = ux * ux + uy * uy;
  if (!(rho >= ${1 - LIMIT_RHO} && rho <= ${1 + LIMIT_RHO} && usq0 <= ${LIMIT_U * LIMIT_U})) {
    atomicAdd(&force[${HEALTH_SLOT + 2}u], 1);
    let ok = rho == rho && ux == ux && uy == uy;
    rho = select(1.0, clamp(rho, ${1 - LIMIT_RHO}, ${1 + LIMIT_RHO}), ok);
    var uc = select(vec2f(0.0), vec2f(ux, uy), ok);
    let m = length(uc);
    if (m > ${LIMIT_U}) { uc = uc * (${LIMIT_U} / m); }
    ux = uc.x;
    uy = uc.y;
${Array.from({ length: 9 }, (_, k) => `    f${k} = feqAt(${k}u, rho, uc);`).join('\n')}
  }
${collide}
}
`;
}

/** Density and velocity per cell (x, y = velocity, z = density, w = 1 inside a body). */
export function macroShader(): string {
  return `
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
${TABLES}
${COMMON}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${WG}u;
  if (idx >= P.n) { return; }
  let p = vec2f(f32(idx % P.nx), f32(idx / P.nx));
  var bp: array<vec4f, ${MAX_BODIES}>;
  let near = poses(p, 1.0, &bp);
  if (near != 0u) {
    let h = sdfAt(p, near, &bp);
    if (h.d < 0.0) {
      mac[idx] = vec4f(wallU(h.b, p, bp[h.b].xy), 1.0, 1.0);
      return;
    }
  }
  var rho = 0.0;
  var m = vec2f(0.0);
  for (var k = 0u; k < 9u; k++) {
    let f = fin[k * P.n + idx];
    rho += f;
    m += f * vec2f(CXF[k], CYF[k]);
  }
  mac[idx] = vec4f(m / rho, rho, 0.0);
}
`;
}

/** The displayed scalar (dimensionless) and a sampled copy for the automatic range. */
export function fieldShader(): string {
  return `
struct D { nx: u32, ny: u32, mode: u32, stride: u32, uRef: f32, lRef: f32, sw: u32, sh: u32, rhoRef: f32, p0: f32, p1: f32, p2: f32 };
@group(0) @binding(0) var<storage, read> mac: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> scalar: array<f32>;
@group(0) @binding(2) var<uniform> V: D;
@group(0) @binding(3) var<storage, read_write> sampled: array<f32>;

fn at(x: i32, y: i32) -> vec4f {
  let cx = clamp(x, 0, i32(V.nx) - 1);
  let cy = clamp(y, 0, i32(V.ny) - 1);
  return mac[u32(cx) + u32(cy) * V.nx];
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${WG}u;
  if (idx >= V.nx * V.ny) { return; }
  let x = i32(idx % V.nx);
  let y = i32(idx / V.nx);
  let m = mac[idx];
  var s = 0.0;
  if (V.mode == 0u) {
    // Vorticity x reference length / free-stream speed.
    let dvdx = 0.5 * (at(x + 1, y).y - at(x - 1, y).y);
    let dudy = 0.5 * (at(x, y + 1).x - at(x, y - 1).x);
    s = (dvdx - dudy) * V.lRef / V.uRef;
  } else if (V.mode == 1u) {
    s = length(m.xy) / V.uRef;
  } else if (V.mode == 2u) {
    // Pressure coefficient against the free stream's pressure (rhoRef, measured upstream).
    s = ((m.z - V.rhoRef) / 3.0) / (0.5 * V.uRef * V.uRef);
  } else {
    let g = vec2f(at(x + 1, y).z - at(x - 1, y).z, at(x, y + 1).z - at(x, y - 1).z) * 0.5;
    s = length(g) / (V.uRef * V.uRef) * V.lRef;
  }
  if (m.w > 0.5) { s = 0.0; }
  scalar[idx] = s;
  if (u32(x) % V.stride == 0u && u32(y) % V.stride == 0u) {
    let sx = u32(x) / V.stride;
    let sy = u32(y) / V.stride;
    if (sx < V.sw && sy < V.sh) { sampled[sx + sy * V.sw] = select(s, 1e30, m.w > 0.5); }
  }
}
`;
}

/**
 * Full-screen render: the field through a colour map (or a plain background), the sponge
 * zones tinted, the dye, the particles' trail, velocity arrows, and the bodies on top.
 * Flags: 1 plain background, 2 arrows, 4 dye, 8 trail.
 */
export function renderShader(): string {
  return `
struct View {
  scale: f32, ox: f32, oy: f32, lo: f32,
  hi: f32, nxf: f32, nyf: f32, absorbIn: f32,
  spongeX: f32, uRef: f32, arrowCells: f32, flags: u32,
  bg: vec4f, body: vec4f, edge: vec4f, zone: vec4f,
  plain: vec4f, arrow: vec4f,
  dye: array<vec4f, 4>,
};
@group(0) @binding(0) var<storage, read> scalar: array<f32>;
@group(0) @binding(1) var<uniform> Vw: View;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read> lut: array<vec4f, 256>;
@group(0) @binding(6) var<storage, read> mac: array<vec4f>;
@group(0) @binding(7) var<storage, read> dye: array<vec4f>;
@group(0) @binding(8) var trail: texture_2d<f32>;
${TABLES}
${COMMON}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn cellIndex(c: vec2f) -> vec4u {
  let nx = u32(Vw.nxf);
  let n = nx * u32(Vw.nyf);
  let i = u32(c.x);
  let j = u32(c.y);
  let k = i + j * nx;
  return vec4u(k, min(k + 1u, n - 1u), min(k + nx, n - 1u), min(k + nx + 1u, n - 1u));
}
fn clampCell(l: vec2f) -> vec2f { return clamp(l, vec2f(0.0), vec2f(Vw.nxf - 1.001, Vw.nyf - 1.001)); }

fn sampleScalar(l: vec2f) -> f32 {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(scalar[k.x], scalar[k.y], f.x), mix(scalar[k.z], scalar[k.w], f.x), f.y);
}
fn sampleMac(l: vec2f) -> vec4f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(mac[k.x], mac[k.y], f.x), mix(mac[k.z], mac[k.w], f.x), f.y);
}
fn sampleDye(l: vec2f) -> vec4f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  return mix(mix(dye[k.x], dye[k.y], f.x), mix(dye[k.z], dye[k.w], f.x), f.y);
}

/** Coverage (0..1) of the velocity arrow of the grid cell around l. */
fn arrowCover(l: vec2f) -> f32 {
  let G = Vw.arrowCells;
  let c = (floor(l / G) + 0.5) * G;
  if (c.x < 0.0 || c.y < 0.0 || c.x > Vw.nxf - 1.0 || c.y > Vw.nyf - 1.0) { return 0.0; }
  let m = sampleMac(c);
  if (m.w > 0.25) { return 0.0; }
  let sp = length(m.xy);
  if (sp < Vw.uRef * 0.02) { return 0.0; }
  let L = clamp(sp / Vw.uRef, 0.05, 2.0) * 0.42 * G;
  let d = m.xy / sp;
  let r = l - c;
  let along = dot(r, d) + L * 0.5;
  let across = abs(dot(r, vec2f(-d.y, d.x)));
  let px = Vw.scale;
  let head = min(L * 0.4, 7.0 * px);
  var dist = 1e9;
  if (along >= 0.0 && along <= L - head) { dist = across - 0.6 * px; }
  if (along > L - head && along <= L) {
    let half = (L - along) / head * head * 0.45;
    dist = min(dist, across - half);
  }
  return clamp(0.5 - dist / px, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let l = vec2f(Vw.ox + pos.x * Vw.scale, Vw.oy - pos.y * Vw.scale);
  if (l.x < -0.5 || l.y < -0.5 || l.x > Vw.nxf - 0.5 || l.y > Vw.nyf - 0.5) { return Vw.bg; }
  var col: vec3f;
  if ((Vw.flags & 1u) != 0u) {
    col = Vw.plain.rgb;
  } else {
    let s = sampleScalar(l);
    let t = clamp((s - Vw.lo) / max(1e-12, Vw.hi - Vw.lo), 0.0, 1.0);
    col = lut[u32(t * 255.0 + 0.5)].rgb;
  }
  if (l.x < Vw.absorbIn || l.x > Vw.spongeX) { col = mix(col, Vw.zone.rgb, Vw.zone.a); }
  if ((Vw.flags & 4u) != 0u) {
    let d = sampleDye(l);
    for (var c = 0u; c < 4u; c++) { col = mix(col, Vw.dye[c].rgb, clamp(d[c], 0.0, 1.0) * Vw.dye[c].a); }
  }
  if ((Vw.flags & 8u) != 0u) {
    let t = textureLoad(trail, vec2i(pos.xy), 0);
    col = col * (1.0 - clamp(t.a, 0.0, 1.0)) + t.rgb;
  }
  if ((Vw.flags & 2u) != 0u) {
    col = mix(col, Vw.arrow.rgb, arrowCover(l) * Vw.arrow.a);
  }
  var bp: array<vec4f, ${MAX_BODIES}>;
  let near = poses(l, 1.0, &bp);
  if (near != 0u) {
    let h = sdfAt(l, near, &bp);
    let px = h.d / Vw.scale;
    let fill = clamp(0.5 - px, 0.0, 1.0);
    let edge = clamp(1.0 - abs(px + 0.5) / 1.0, 0.0, 1.0);
    col = mix(col, Vw.body.rgb, fill);
    col = mix(col, Vw.edge.rgb, edge * 0.85);
  }
  return vec4f(col, 1.0);
}
`;
}

/** Every shader the tunnel uses, for the start-up compile check. */
export function allShaders(): { label: string; code: string }[] {
  return [
    { label: 'step', code: stepShader() },
    { label: 'macro', code: macroShader() },
    { label: 'field', code: fieldShader() },
    { label: 'render', code: renderShader() },
  ];
}
