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

/** Top and bottom: slip, no-slip, periodic, or open (the free stream beyond, waves pass out). */
export const WALLS = { slip: 0, noslip: 1, periodic: 2, farfield: 3 } as const;

const n10 = (v: number) => v.toFixed(10);
const n1 = (v: number) => v.toFixed(1);

/** Shared declarations: the parameters, the bodies and their distance fields. */
export const COMMON = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, n: u32, nBodies: u32,
  omega: f32, smag: f32, uIn: f32, absorb: f32,
  absorbIn: f32, spongeX: f32, frameSteps: u32, profile: u32,
  farW: f32, nuMol: f32, nuFloor: f32, nuInf: f32,
};
struct Body {
  c0: vec2f, c1: vec2f,
  a0: f32, a1: f32, bound: f32, texel: f32,
  org: vec2f, w: u32, h: u32,
  off: u32, band: f32, p1: u32, p2: u32,
};
struct Hit { d: f32, b: u32 };

fn sdfLocal(b: u32, lp: vec2f) -> f32 {
  let bd = B[b];
  let uv = (lp - bd.org) / bd.texel;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > f32(bd.w - 1u) || uv.y > f32(bd.h - 1u)) { return bd.band; }
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

/** The distance field's gradient at p (unnormalized, half-cell differences). */
fn sdfGrad(p: vec2f, near: u32, bp: ptr<function, array<vec4f, ${MAX_BODIES}>>) -> vec2f {
  return vec2f(sdfAt(p + vec2f(0.5, 0.0), near, bp).d - sdfAt(p - vec2f(0.5, 0.0), near, bp).d,
               sdfAt(p + vec2f(0.0, 0.5), near, bp).d - sdfAt(p - vec2f(0.0, 0.5), near, bp).d);
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

/** Turbulence modes (the step's TURB override): resolved, wall function only, Spalart–Allmaras with wall functions. */
export const TURB = { off: 0, wall: 1, sa: 2 } as const;
/** Wall law and Spalart–Allmaras constants (shared with the CPU surface analysis). */
export const KAPPA = 0.41;
export const WALL_B = 5.0;
export const SA = { cb1: 0.1355, sigma: 2 / 3, cb2: 0.622, cw2: 0.3, cw3: 2, cv1: 7.1, cv2: 0.7, cv3: 0.9 } as const;
export const SA_CW1 = SA.cb1 / (KAPPA * KAPPA) + (1 + SA.cb2) / SA.sigma;
/** Largest eddy viscosity (lattice) the model may reach: τ stays at or below 1.1. */
export const NU_T_MAX = 0.2;
/** An airfoil's trailing edge is kept at least this thick (cells) on the grid (shapes.thickenRear). */
export const TE_MIN_CELLS = 2;
/** The distance-field band (cells) bodies are baked with when the turbulence model needs wall distance. */
export const SA_SDF_BAND = 32;
/** Where the wall model takes its velocity: this many cells off the wall, along the normal. */
export const WALL_REF_CELLS = 2;

/**
 * The turbulence model's functions: Spalding's wall law solved for the friction velocity,
 * the wall model's slip (Ponsin & Lozano 2026: the wall moves at the speed that makes the
 * resolved stress between it and the cell equal the wall law's), and one explicit step of
 * Spalart–Allmaras (Allmaras 2012, no trip term, S̃ kept positive) on the per-step
 * auxiliary field (velocity, ν̃, the cell's total viscosity; -1 there marks a solid cell).
 */
export const TURB_FNS = /* wgsl */ `
const KAPPA = ${n10(KAPPA)};
const WALL_EKB = ${n10(Math.exp(-KAPPA * WALL_B))};
const SA_CB1 = ${n10(SA.cb1)};
const SA_SIGMA = ${n10(SA.sigma)};
const SA_CB2 = ${n10(SA.cb2)};
const SA_CW1 = ${n10(SA_CW1)};
const SA_CW2 = ${n10(SA.cw2)};
const SA_CW3_6 = ${n10(SA.cw3 ** 6)};
const SA_CV1_3 = ${n10(SA.cv1 ** 3)};
const SA_CV2 = ${n10(SA.cv2)};
const SA_CV3 = ${n10(SA.cv3)};

/** u+ where y ut / ν = reY on Spalding's law (Newton from the right: the law is convex). */
fn wallUplus(reY: f32) -> f32 {
  var up = min(sqrt(max(reY, 0.0)), 45.0);
  for (var i = 0; i < 18; i++) {
    let k = KAPPA * up;
    let ek = exp(k);
    let Y = up + WALL_EKB * (ek - 1.0 - k - 0.5 * k * k - k * k * k / 6.0);
    let dY = 1.0 + WALL_EKB * KAPPA * (ek - 1.0 - k - 0.5 * k * k);
    up = max(up - (Y * up - reY) / (dY * up + Y), 1e-4);
  }
  return up;
}

fn auxAt(x: i32, y: i32) -> vec4f {
  let cx = clamp(x, 0, i32(P.nx) - 1);
  let cy = clamp(y, 0, i32(P.ny) - 1);
  return auxIn[u32(cx) + u32(cy) * P.nx];
}

/** The last step's auxiliary field at l (bilinear over the fluid cells only; w -1 if none). */
fn auxLerp(l: vec2f) -> vec4f {
  let c = clamp(l, vec2f(0.0), vec2f(f32(P.nx) - 1.001, f32(P.ny) - 1.001));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  var s = vec4f(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let a = auxAt(i.x + o.x, i.y + o.y);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    if (a.w >= 0.0) { s += w * a; wsum += w; }
  }
  return select(vec4f(0.0, 0.0, 0.0, -1.0), s / wsum, wsum > 1e-6);
}

/** Distance (cells) to the nearest body, beyond the baked band too (a lower bound there). */
fn wallDist(p: vec2f, bp: ptr<function, array<vec4f, ${MAX_BODIES}>>) -> f32 {
  var d = 1e6;
  for (var b = 0u; b < P.nBodies; b++) {
    let q = (*bp)[b];
    let bd = B[b];
    let r = p - q.xy;
    let far = length(r) - bd.bound;
    if (far > bd.band) { d = min(d, far); continue; }
    let lp = vec2f(q.z * r.x + q.w * r.y, -q.w * r.x + q.z * r.y);
    let s = sdfLocal(b, lp);
    d = min(d, select(s, max(s, far), s >= bd.band - 0.01));
  }
  return max(d, 0.05);
}

/** One explicit step of ν̃ at a fluid cell: advection (third-order upwind), diffusion, production, destruction. */
fn saStep(xi: i32, yi: i32, u: vec2f, d: f32) -> f32 {
  let c = auxAt(xi, yi);
  let e = auxAt(xi + 1, yi);
  let w = auxAt(xi - 1, yi);
  let n = auxAt(xi, yi + 1);
  let s = auxAt(xi, yi - 1);
  let n0 = c.z;
  let nE = select(e.z, 0.0, e.w < 0.0);
  let nW = select(w.z, 0.0, w.w < 0.0);
  let nN = select(n.z, 0.0, n.w < 0.0);
  let nS = select(s.z, 0.0, s.w < 0.0);
  let ee = auxAt(xi + 2, yi);
  let ww = auxAt(xi - 2, yi);
  let nn = auxAt(xi, yi + 2);
  let ss = auxAt(xi, yi - 2);
  let nEE = select(ee.z, 0.0, ee.w < 0.0);
  let nWW = select(ww.z, 0.0, ww.w < 0.0);
  let nNN = select(nn.z, 0.0, nn.w < 0.0);
  let nSS = select(ss.z, 0.0, ss.w < 0.0);
  var adv = 0.0;
  if (u.x > 0.0) { adv += u.x * (2.0 * nE + 3.0 * n0 - 6.0 * nW + nWW) / 6.0; }
  else { adv += u.x * (-nEE + 6.0 * nE - 3.0 * n0 - 2.0 * nW) / 6.0; }
  if (u.y > 0.0) { adv += u.y * (2.0 * nN + 3.0 * n0 - 6.0 * nS + nSS) / 6.0; }
  else { adv += u.y * (-nNN + 6.0 * nN - 3.0 * n0 - 2.0 * nS) / 6.0; }
  let nu = P.nuMol;
  let diff = ((nu + 0.5 * (n0 + nE)) * (nE - n0) - (nu + 0.5 * (n0 + nW)) * (n0 - nW)
            + (nu + 0.5 * (n0 + nN)) * (nN - n0) - (nu + 0.5 * (n0 + nS)) * (n0 - nS)) / SA_SIGMA;
  let gx = 0.5 * (nE - nW);
  let gy = 0.5 * (nN - nS);
  let cross = SA_CB2 / SA_SIGMA * (gx * gx + gy * gy);
  let om = abs(0.5 * (e.y - w.y) - 0.5 * (n.x - s.x));
  let chi = n0 / nu;
  let chi3 = chi * chi * chi;
  let fv1 = chi3 / (chi3 + SA_CV1_3);
  let fv2 = 1.0 - chi / (1.0 + chi * fv1);
  let kd2 = KAPPA * KAPPA * d * d;
  let sbar = n0 * fv2 / kd2;
  var st = om + sbar;
  if (sbar < -SA_CV2 * om) { st = om + om * (SA_CV2 * SA_CV2 * om + SA_CV3 * sbar) / ((SA_CV3 - 2.0 * SA_CV2) * om - sbar); }
  var r = 10.0;
  if (st > 1e-12) { r = min(n0 / (st * kd2), 10.0); }
  let r2 = r * r;
  let g = r + SA_CW2 * (r2 * r2 * r2 - r);
  let g2 = g * g;
  let fw = g * pow((1.0 + SA_CW3_6) / (g2 * g2 * g2 + SA_CW3_6), 1.0 / 6.0);
  let prod = SA_CB1 * st * n0;
  let dest = SA_CW1 * fw * (n0 / d) * (n0 / d);
  return clamp(n0 + prod - dest + diff + cross - adv, 0.0, ${NU_T_MAX});
}

fn saFv1(nt: f32) -> f32 {
  let chi = nt / P.nuMol;
  let chi3 = chi * chi * chi;
  return chi3 / (chi3 + SA_CV1_3);
}
`;

/** The step kernel. Overrides: WALLS (0 slip, 1 no-slip, 2 periodic, 3 open), SMAG (Smagorinsky on), TURB (see TURB). */
export function stepShader(): string {
  // Populations are stored less their rest weights (g = f - w): the flow's information
  // sits in the small part, which f32 then keeps to about 1e-9 instead of 3e-8.
  const rd = (k: number | string, idx: string) => `fin[${k}u * P.n + ${idx}]`;
  const eqG = (k: number) =>
    `(${n10(W[k])} * (drho + rho * (3.0 * (${n1(CX[k])} * ux + ${n1(CY[k])} * uy) + 4.5 * (${n1(CX[k])} * ux + ${n1(CY[k])} * uy) * (${n1(CX[k])} * ux + ${n1(CY[k])} * uy) - 1.5 * (ux * ux + uy * uy))))`;

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
      else if (WALLS == 3u) { f${k} = ${n10(W[k])} * (3.0 * ${n1(cx)} * P.uIn + 4.5 * ${n1(cx * cx)} * P.uIn * P.uIn - 1.5 * P.uIn * P.uIn); }
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
    var qThin = -1.0;
    if (near != 0u) {
      hit = sdfAt(vec2f(f32(sx), f32(sy)), near, &bp);
      // A body thinner than a cell (a trailing edge, a plate) can lie between two fluid
      // cells: the link's middle is inside it. Without this the flow streams through it.
      // Only a real crossing counts: the two cells on opposite sides (the field's gradients
      // there point apart), not a link grazing a wall the interpolated field dips under.
      if (hit.d >= 0.0 && d0 < 0.75) {
        let hm = sdfAt(vec2f(f32(x) - ${n1(cx * 0.5)}, f32(y) - ${n1(cy * 0.5)}), near, &bp);
        if (hm.d < 0.0 && dot(sdfGrad(p, near, &bp), sdfGrad(vec2f(f32(sx), f32(sy)), near, &bp)) < 0.0) {
          hit = hm;
          qThin = clamp(0.5 * d0 / (d0 - hm.d), 0.001, 0.5);
        }
      }
    }
    if (hit.d < 0.0) {
      // Bouzidi: direction ${i} leaves this cell into the body, q of the way to its wall.
      var q = select(clamp(d0 / (d0 - hit.d), 0.001, 1.0), qThin, qThin >= 0.0);
      let bx = i32(x) + (${cx});
      let by = i32(y) + (${cy});
      var behindFluid = bx >= 0 && by >= 0 && bx < i32(P.nx) && by < i32(P.ny);
      if (behindFluid && q < 0.5) { behindFluid = sdfAt(vec2f(f32(bx), f32(by)), near, &bp).d >= 0.0; }
      if (q < 0.5 && !behindFluid) { q = 0.5; }
      let c = bp[hit.b].xy;
      let uwB = wallU(hit.b, vec2f(f32(sx), f32(sy)), c);
      // The wall model's slip moves the wall along itself (only the body it was worked out for).
      let uw = uwB + select(vec2f(0.0), slip, hit.b == wfB);
      let fi = ${rd(i, 'idx')};
      let mw = ${n10(6 * W[k])} * ${cu};
      if (q < 0.5) { f${k} = 2.0 * q * fi + (1.0 - 2.0 * q) * ${rd(i, 'u32(bx) + u32(by) * P.nx')} + mw; }
      else { f${k} = fi / (2.0 * q) + (2.0 * q - 1.0) / (2.0 * q) * ${rd(k, 'idx')} + mw / (2.0 * q); }
      let slot = (S.slot * ${MAX_BODIES}u + hit.b) * 2u;
      atomicAdd(&force[slot], i32(round((${n1(CX[i])} * (fi + f${k}) - uwB.x * (fi - f${k})) * ${FORCE_FIX}.0)));
      atomicAdd(&force[slot + 1u], i32(round((${n1(CY[i])} * (fi + f${k}) - uwB.y * (fi - f${k})) * ${FORCE_FIX}.0)));
    } else {
      f${k} = ${rd(k, 'src')};
    }
  }`;
  }

  let collide = '';
  for (let k = 0; k < 9; k++) collide += `  let e${k} = ${eqG(k)};\n`;
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
  // Spalart–Allmaras: this cell's ν̃ (from the wall law in the first cells off a wall), and
  // its total viscosity ν + ν_t, floored where the grid cannot carry less.
  var ntOut = 0.0;
  if (TURB == 2u) {
    if (wfNt >= 0.0) { ntOut = wfNt; }
    else { ntOut = saStep(i32(x), i32(y), vec2f(ux, uy), wallDist(p, &bp)); }
    tP = 3.0 * max(P.nuMol + ntOut * saFv1(ntOut), P.nuFloor) + 0.5;
  }
  let nuCell = (tP - 0.5) / 3.0;
  var sig = 0.0;
  if (xf > P.spongeX) { let r = (xf - P.spongeX) / (f32(P.nx) - P.spongeX); tP += r * r; sig = P.absorb * r * r; }
  if (xf < P.absorbIn) { let r = (P.absorbIn - xf) / P.absorbIn; sig = P.absorb * r * r; }
  if (WALLS == 3u) {
    // Open top and bottom: a band that relaxes to the free stream, so what reaches the
    // edge (sound, a wake) passes out instead of reflecting.
    let yb = min(f32(y), f32(P.ny - 1u) - f32(y));
    if (yb < P.farW) { let r = (P.farW - yb) / P.farW; sig = max(sig, P.absorb * r * r); }
  }
  if (TURB == 2u) {
    if (x == 0u) { ntOut = P.nuInf; }
    ntOut = mix(ntOut, P.nuInf, sig);
  }
  if (TURB > 0u) { auxOut[idx] = vec4f(ux, uy, ntOut, nuCell); }
  let omP = 1.0 / tP;
  let axxy = 2.0 * ux * pxy + uy * pxx;
  let axyy = 2.0 * uy * pxy + ux * pyy;
  let keep = 1.0 - omP;
  // Bulk viscosity: the stress's trace (compression) relaxes fully every step while its
  // deviatoric part (shear) relaxes at omP. Sound waves (from dragged bodies, the start)
  // then die out within a few cells instead of ringing between the walls, and the
  // incompressible flow is unchanged (the Schafer-Turek check runs with it).
  let half = 0.5 * (pxx + pyy);
  let kb = select(KEEP_BULK, keep, KEEP_BULK < 0.0);
  let dxx = keep * (pxx - half) + kb * half;
  let dyy = keep * (pyy - half) + kb * half;
  let dxy = keep * pxy;
`;
  for (let k = 0; k < 9; k++) {
    const cx = CX[k];
    const cy = CY[k];
    const hxx = cx * cx - 1 / 3;
    const hyy = cy * cy - 1 / 3;
    const hxy = cx * cy;
    const hxxy = cx * cx * cy - cy / 3;
    const hxyy = cx * cy * cy - cx / 3;
    collide += `  var o${k} = ${n10(W[k])} * (drho + rho * (3.0 * (${n10(cx)} * ux + ${n10(cy)} * uy) + 4.5 * (${n10(hxx)} * ux * ux + ${n10(hyy)} * uy * uy + ${n10(2 * hxy)} * ux * uy) + 13.5 * (${n10(hxxy)} * ux * ux * uy + ${n10(hxyy)} * ux * uy * uy)))
    + ${n10(W[k])} * (4.5 * (${n10(hxx)} * dxx + ${n10(hyy)} * dyy + ${n10(2 * hxy)} * dxy) + 13.5 * keep * (${n10(hxxy)} * axxy + ${n10(hxyy)} * axyy));
`;
  }
  collide += `  if (sig > 0.0) {
    let uT = P.uIn;
${Array.from({ length: 9 }, (_, k) => `    o${k} = mix(o${k}, ${n10(W[k])} * (3.0 * ${n1(CX[k])} * uT + 4.5 * ${n1(CX[k] * CX[k])} * uT * uT - 1.5 * uT * uT), sig);`).join('\n')}
  }
${Array.from({ length: 9 }, (_, k) => `  fout[${k}u * P.n + idx] = o${k};`).join('\n')}
`;

  return `
override WALLS: u32 = 0u;
override SMAG: bool = false;
override TURB: u32 = 0u;
/** 1 - the bulk relaxation rate (0: the stress's trace fully relaxed each step; below 0: as the shear's). */
override KEEP_BULK: f32 = 0.0;
struct Step { slot: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<storage, read> fin: array<f32>;
@group(0) @binding(1) var<storage, read_write> fout: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read> B: array<Body>;
@group(0) @binding(4) var<storage, read> sdf: array<f32>;
@group(0) @binding(5) var<storage, read_write> force: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read> auxIn: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> auxOut: array<vec4f>;
@group(1) @binding(0) var<uniform> S: Step;
${TABLES}
${COMMON}
${TURB_FNS}

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
  var b0 = 0u;
  if (near != 0u) {
    let h0 = sdfAt(p, near, &bp);
    d0 = h0.d;
    b0 = h0.b;
    if (d0 < 0.0) {
      let uw = wallU(h0.b, p, bp[h0.b].xy);
      for (var k = 0u; k < 9u; k++) { fout[k * P.n + idx] = feqAt(k, 1.0, uw) - WF[k]; }
      if (TURB > 0u) { auxOut[idx] = vec4f(uw, 0.0, -1.0); }
      return;
    }
  }
  // The wall model, in the cells next to a wall: the friction velocity from the wall law at
  // the velocity ${WALL_REF_CELLS} cells off the wall (last step's), then the slip that makes the
  // stress resolved between the wall and the point one cell off it the law's (that point, not
  // this cell: a cell on the wall would set its own slip), and ν̃ = κ u_τ d here.
  var slip = vec2f(0.0);
  var wfB = ${MAX_BODIES}u;
  var wfNt = -1.0;
  if (TURB > 0u && near != 0u && d0 < 1.5) {
    let gx = sdfAt(p + vec2f(0.5, 0.0), near, &bp).d - sdfAt(p - vec2f(0.5, 0.0), near, &bp).d;
    let gy = sdfAt(p + vec2f(0.0, 0.5), near, &bp).d - sdfAt(p - vec2f(0.0, 0.5), near, &bp).d;
    let gl = length(vec2f(gx, gy));
    if (gl > 1e-6) {
      let nrm = vec2f(gx, gy) / gl;
      let xw = p - d0 * nrm;
      let ub = wallU(b0, xw, bp[b0].xy);
      let aR = auxLerp(xw + ${WALL_REF_CELLS.toFixed(3)} * nrm);
      let aV = auxLerp(xw + nrm);
      let uR = aR.xy - ub;
      let utR = uR - dot(uR, nrm) * nrm;
      let ut = length(utR);
      if (ut > 1e-7 && aR.w >= 0.0 && aV.w >= 0.0) {
        let t = utR / ut;
        let utau = ut / wallUplus(${WALL_REF_CELLS.toFixed(3)} * ut / P.nuMol);
        let uv = dot(aV.xy - ub, t);
        let s = clamp(uv - utau * utau / max(aV.w, P.nuMol), 0.0, max(uv, 0.0));
        slip = s * t;
        wfB = b0;
        wfNt = KAPPA * utau * d0;
      }
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
    let r = (1.0 + f0 + f2 + f4 + 2.0 * (f3 + f6 + f7)) / (1.0 - u);
    f1 = f3 + (2.0 / 3.0) * r * u;
    f5 = f7 - 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
    f8 = f6 + 0.5 * (f2 - f4) + (1.0 / 6.0) * r * u;
  }
  if (x == P.nx - 1u) {
    let uo = f0 + f2 + f4 + 2.0 * (f1 + f5 + f8);
    f3 = f1 - (2.0 / 3.0) * uo;
    f7 = f5 + 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
    f6 = f8 - 0.5 * (f2 - f4) - (1.0 / 6.0) * uo;
  }
  var drho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
  var rho = 1.0 + drho;
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
    drho = rho - 1.0;
${Array.from({ length: 9 }, (_, k) => `    f${k} = feqAt(${k}u, rho, uc) - ${n10(W[k])};`).join('\n')}
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
  // Stored as f - w: the density is 1 + their sum, the momentum their first moment.
  var drho = 0.0;
  var m = vec2f(0.0);
  for (var k = 0u; k < 9u; k++) {
    let g = fin[k * P.n + idx];
    drho += g;
    m += g * vec2f(CXF[k], CYF[k]);
  }
  let rho = 1.0 + drho;
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
 * Flags: 1 plain background, 2 arrows, 4 dye, 8 trail, 16 rheoscopic (flakes lit by two lights).
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
  rBase: vec4f, l1dir: vec4f, l1col: vec4f, l2dir: vec4f, l2col: vec4f,
  rParams: vec4f,
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
@group(0) @binding(9) var<storage, read> rheo: array<vec4f>;
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

/**
 * The flakes' colour at l: two lights low over the tank, the eye straight above. Each
 * light gives a two-sided diffuse term sqrt(lᵀQl) (its strength in the light's alpha) and
 * a glint (hᵀQh)^k (rParams: k, the two sparkle layers' weights, glint strength), the
 * glint lit up where the carried sparkle noise is high.
 */
fn rheoColor(l: vec2f) -> vec3f {
  let c = clampCell(l);
  let k = cellIndex(c);
  let f = fract(c);
  let a = mix(mix(rheo[2u * k.x], rheo[2u * k.y], f.x), mix(rheo[2u * k.z], rheo[2u * k.w], f.x), f.y);
  let b = mix(mix(rheo[2u * k.x + 1u], rheo[2u * k.y + 1u], f.x), mix(rheo[2u * k.z + 1u], rheo[2u * k.w + 1u], f.x), f.y);
  let Q = mat3x3f(vec3f(a.x, a.w, b.x), vec3f(a.w, a.y, b.y), vec3f(b.x, b.y, a.z));
  let eye = vec3f(0.0, 0.0, 1.0);
  let sparkle = Vw.rParams.y * b.z + Vw.rParams.z * b.w;
  let glitter = 0.35 + 2.4 * smoothstep(0.62, 1.0, sparkle);
  var col = Vw.rBase.rgb;
  for (var i = 0u; i < 2u; i++) {
    let ld = normalize(select(Vw.l2dir.xyz, Vw.l1dir.xyz, i == 0u));
    let lc = select(Vw.l2col, Vw.l1col, i == 0u);
    let dif = sqrt(max(dot(ld, Q * ld), 0.0));
    let hv = normalize(ld + eye);
    let gl = pow(clamp(dot(hv, Q * hv), 0.0, 1.0), Vw.rParams.x);
    col += lc.rgb * (lc.a * dif + Vw.rParams.w * gl * glitter);
  }
  return col;
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
  if ((Vw.flags & 16u) != 0u) {
    col = rheoColor(l);
  } else if ((Vw.flags & 1u) != 0u) {
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
