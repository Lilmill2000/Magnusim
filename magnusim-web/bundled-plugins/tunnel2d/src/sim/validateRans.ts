// The turbulence model's own checks: an airfoil at a real Reynolds number in a large open
// tunnel, and a flat plate's skin friction, run through the plugin's solver and body path.
// The forces come two ways (momentum exchange on the GPU, the surface integral of Cp and
// Cf on the CPU) and are compared with published data by the caller (R1 plan, gates G1–G4).
// SPDX-License-Identifier: GPL-3.0-or-later
import { generate } from '../geometry/naca';
import { ensureCcw, transform, type Poly } from '../geometry/polygon';
import { bakeSdf } from '../geometry/sdf';
import { MAX_STEPS, SA_SDF_BAND, TE_MIN_CELLS, TURB } from './kernels';
import { thickenRear } from '../geometry/shapes';
import { Solver } from './solver';
import { analyzeSurface, blStation, type BlStation, type Panel } from './surface';
import { GRID_RE_MAX, SMAG_BELOW_NU, SMAG_CS, U_LATTICE } from './units';


export interface CaseSpec {
  /** Outline in the body's frame (cells, counter-clockwise, pivot at the origin). */
  poly: Poly;
  /** Reference length (cells) and the Reynolds number on it. */
  lRef: number;
  re: number;
  turb: keyof typeof TURB;
  /** Pivot position (cells) and angle (degrees, nose up). */
  x: number;
  y: number;
  alpha: number;
  nx: number;
  ny: number;
  /** Run length in convective times (lRef / u). */
  tstar: number;
  /** Average the forces over this last fraction of the run. */
  tail?: number;
  /** Least total viscosity as a grid Reynolds number (default the app's). */
  gridRe?: number;
  /** Return the final fields too (small grids: for looking at profiles). */
  dump?: boolean;
  /** Bulk relaxation (Physics.bulkKeep) and lattice inflow speed, for the checks. */
  bulkKeep?: number;
  u?: number;
  walls?: 'farfield' | 'slip' | 'noslip';
  /** Chord stations (x/c from the leading edge, the body's own frame) to report the boundary layer at. */
  blStations?: number[];
  /** Leading edge's offset from the pivot (cells, body frame) for those stations. */
  leX?: number;
}

export interface CaseResult {
  /** Boundary layer per station: upper and lower sides (thicknesses in chords). */
  bl?: { xc: number; upper: BlStation | null; lower: BlStation | null }[];
  fields?: { nx: number; ny: number; mac: number[]; aux: number[] | null };
  steps: number;
  seconds: number;
  mlups: number;
  bad: number;
  limited: number;
  /** Momentum-exchange coefficients, averaged over the tail (x = drag, y = lift, wind axes). */
  cd: number;
  cl: number;
  /** Their spread over the tail (max - min), to tell steady from shedding. */
  cdSpread: number;
  clSpread: number;
  /** Surface integral at the end: pressure and friction parts. */
  surface: { cd: number; cl: number; cdP: number; cdF: number; clP: number; clF: number };
  /** Coefficient history, one entry per convective time: [t*, cd, cl]. */
  history: [number, number, number][];
  panels: Panel[];
  /** The free stream's density measured upstream, and the lattice numbers used. */
  rhoInf: number;
  nuMol: number;
  nuFloor: number;
  /** Mean and largest ν_t / ν at the end (SA). */
  nutMax: number;
}

/** A NACA section in cells: chord `c`, quarter chord at the origin, closed trailing edge as drawn. */
export function nacaCells(code: string, c: number, perSide = 181, teMin = TE_MIN_CELLS): Poly {
  const s = thickenRear(generate(code, perSide).x, generate(code, perSide).y, teMin / c);
  const out: Poly = [];
  for (let i = 0; i < s.x.length; i++) out.push((s.x[i] - 0.25) * c, s.y[i] * c);
  return ensureCcw(out);
}

/** A thin plate of length L and thickness th (cells) with elliptic ends 4 th long, centred on the origin. */
export function plateCells(L: number, th: number, perEnd = 48): Poly {
  const a = 4 * th;
  const b = th / 2;
  const out: Poly = [];
  // Bottom from the leading edge's tangent point to the trailing end's, then round the tail, the top back, round the nose.
  const x0 = -L / 2 + a;
  const x1 = L / 2 - a;
  for (let i = 0; i <= perEnd; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / perEnd;
    out.push(x1 + a * Math.cos(t), b * Math.sin(t));
  }
  for (let i = 0; i <= perEnd; i++) {
    const t = Math.PI / 2 + (Math.PI * i) / perEnd;
    out.push(x0 + a * Math.cos(t), b * Math.sin(t));
  }
  return ensureCcw(out);
}

export async function runCase(device: GPUDevice, c: CaseSpec, onProgress?: (f: number) => void): Promise<CaseResult> {
  const u = c.u ?? U_LATTICE;
  const nuMol = (u * c.lRef) / c.re;
  const nuFloor = u / (c.gridRe ?? GRID_RE_MAX);
  const resolvedNu = Math.max(nuMol, nuFloor);
  const solver = new Solver(device, { nx: c.nx, ny: c.ny, walls: c.walls ?? 'farfield' });
  const sa = c.turb === 'sa';
  solver.setPhysics({
    u,
    tau: 3 * resolvedNu + 0.5,
    smagorinsky: !sa && resolvedNu < SMAG_BELOW_NU,
    smagCs: SMAG_CS,
    turb: c.turb,
    nuMol,
    nuFloor,
    bulkKeep: c.bulkKeep,
  });
  solver.reset(u);
  const sdf = bakeSdf(c.poly, c.turb === 'sa' ? SA_SDF_BAND : undefined);
  const theta = (-c.alpha * Math.PI) / 180;
  const pose = { x: c.x, y: c.y, theta };
  solver.setBodies([{ key: 'case', sdf, from: pose, to: pose }]);
  const convective = c.lRef / u;
  const steps = Math.ceil(c.tstar * convective);
  const tailFrom = Math.floor(steps * (1 - (c.tail ?? 0.25)));
  let bad = 0;
  let limited = 0;
  let sx = 0;
  let sy = 0;
  let sn = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  const history: [number, number, number][] = [];
  let accX = 0;
  let accY = 0;
  let accN = 0;
  const q = 0.5 * u * u * c.lRef;
  const t0 = performance.now();
  for (let s = 0; s < steps; ) {
    const count = Math.min(MAX_STEPS, steps - s);
    const enc = device.createCommandEncoder();
    solver.encodeFrame(enc, count, { mode: 1, uRef: u, lRef: c.lRef });
    const read = solver.prepareRead(enc, count);
    device.queue.submit([enc.finish()]);
    const r = await read();
    if (!r) throw new Error('The force readback failed.');
    bad += r.bad;
    limited += r.limited;
    for (let k = 0; k < count; k++) {
      const fx = r.forces[0].perStep[2 * k] / q;
      const fy = r.forces[0].perStep[2 * k + 1] / q;
      accX += fx;
      accY += fy;
      accN++;
      if (s + k >= tailFrom) {
        sx += fx;
        sy += fy;
        sn++;
        xMin = Math.min(xMin, fx);
        xMax = Math.max(xMax, fx);
        yMin = Math.min(yMin, fy);
        yMax = Math.max(yMax, fy);
      }
      if ((s + k + 1) % Math.round(convective) === 0) {
        history.push([(s + k + 1) / convective, accX / accN, accY / accN]);
        accX = 0;
        accY = 0;
        accN = 0;
      }
    }
    s += count;
    onProgress?.(s / steps);
    if (bad) break;
  }
  await device.queue.onSubmittedWorkDone();
  const seconds = (performance.now() - t0) / 1000;
  const { mac, aux } = await solver.readFields();
  solver.destroy();

  // The free stream's density: the median over a column a little past the inlet's layer.
  const col = Math.round(c.nx * 0.08);
  const rs: number[] = [];
  for (let j = Math.round(c.ny * 0.2); j < Math.round(c.ny * 0.8); j++) rs.push(mac[4 * (j * c.nx + col) + 2]);
  rs.sort((a, b) => a - b);
  const rhoInf = rs[Math.floor(rs.length / 2)] ?? 1;

  const world = transform(c.poly, pose);
  const surf = analyzeSurface({ nx: c.nx, ny: c.ny, mac }, world, {
    u,
    rho: rhoInf,
    lRef: c.lRef,
    shear: c.turb === 'off' ? 'resolved' : 'wall',
    nu: c.turb === 'off' ? resolvedNu : nuMol,
  });
  let bl: CaseResult['bl'];
  if (c.blStations) {
    const snap = { nx: c.nx, ny: c.ny, mac };
    const ca = Math.cos(-theta);
    const sa = Math.sin(-theta);
    const local = surf.panels.map((p) => {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      return { p, xc: (ca * dx - sa * dy - (c.leX ?? 0)) / c.lRef, yc: (sa * dx + ca * dy) / c.lRef };
    });
    const pick = (xc: number, upper: boolean) => {
      const side = local.filter((q) => (upper ? q.yc > 0 : q.yc <= 0));
      if (!side.length) return null;
      const q = side.reduce((b, v) => (Math.abs(v.xc - xc) < Math.abs(b.xc - xc) ? v : b), side[0]);
      const st = blStation(snap, q.p.x, q.p.y, q.p.nx, q.p.ny, 0.25 * c.lRef, { rho: rhoInf, u });
      return st ? { ...st, delta: st.delta / c.lRef, dstar: st.dstar / c.lRef, theta: st.theta / c.lRef, ue: st.ue / u } : null;
    };
    bl = c.blStations.map((xc) => ({ xc, upper: pick(xc, true), lower: pick(xc, false) }));
  }
  let nutMax = 0;
  const diag = { macNaN: 0, auxNaN: 0, z: [Infinity, -Infinity], w: [Infinity, -Infinity], rhoInf, panels: surf.panels.length };
  for (let i = 0; i < c.nx * c.ny; i++) if (!Number.isFinite(mac[4 * i + 2])) diag.macNaN++;
  if (aux) {
    for (let i = 0; i < c.nx * c.ny; i++) {
      const z = aux[4 * i + 2];
      const w = aux[4 * i + 3];
      if (!Number.isFinite(z) || !Number.isFinite(w)) { diag.auxNaN++; continue; }
      diag.z = [Math.min(diag.z[0], z), Math.max(diag.z[1], z)];
      diag.w = [Math.min(diag.w[0], w), Math.max(diag.w[1], w)];
      if (w >= 0) nutMax = Math.max(nutMax, z / nuMol);
    }
  }
  console.log('R1 diag', JSON.stringify(diag));
  return {
    steps,
    seconds,
    mlups: (c.nx * c.ny * steps) / seconds / 1e6,
    bad,
    limited,
    cd: sn ? sx / sn : NaN,
    cl: sn ? sy / sn : NaN,
    cdSpread: xMax - xMin,
    clSpread: yMax - yMin,
    surface: { cd: surf.cx, cl: surf.cy, cdP: surf.cxP, cdF: surf.cxF, clP: surf.cyP, clF: surf.cyF },
    history,
    panels: surf.panels,
    rhoInf,
    nuMol,
    nuFloor,
    nutMax,
    bl,
    fields: c.dump ? { nx: c.nx, ny: c.ny, mac: Array.from(mac), aux: aux ? Array.from(aux) : null } : undefined,
  };
}

export interface AirfoilSpec {
  code: string;
  alpha: number;
  /** Cells per chord. */
  chord: number;
  re: number;
  turb: keyof typeof TURB;
  tstar?: number;
  /** Domain in chords: upstream of the quarter chord, downstream of it, and half the height. */
  up?: number;
  down?: number;
  half?: number;
  gridRe?: number;
  dump?: boolean;
  bulkKeep?: number;
  u?: number;
  walls?: 'farfield' | 'slip' | 'noslip';
  blStations?: number[];
  /** Pivot offset from a cell centre (cells, in x and y). */
  offset?: number;
  /** Least trailing-edge thickness (cells). */
  teMin?: number;
}

export function airfoilCase(a: AirfoilSpec): CaseSpec {
  const up = a.up ?? 4;
  const down = a.down ?? 8;
  const half = a.half ?? 4;
  return {
    poly: nacaCells(a.code, a.chord, 181, a.teMin ?? TE_MIN_CELLS),
    lRef: a.chord,
    re: a.re,
    turb: a.turb,
    x: up * a.chord + (a.offset ?? 0),
    y: half * a.chord + (a.offset ?? 0),
    alpha: a.alpha,
    nx: Math.round((up + down) * a.chord),
    ny: Math.round(2 * half * a.chord),
    tstar: a.tstar ?? 12,
    gridRe: a.gridRe,
    dump: a.dump,
    bulkKeep: a.bulkKeep,
    u: a.u,
    walls: a.walls,
    blStations: a.blStations,
    leX: -0.25 * a.chord,
  };
}

export interface PlateSpec {
  /** Plate length (cells) and the Reynolds number on it. */
  length: number;
  re: number;
  turb: keyof typeof TURB;
  thickness?: number;
  tstar?: number;
  gridRe?: number;
  dump?: boolean;
  /** Offset of the plate's centre line from a cell centre (cells). */
  yOffset?: number;
  bulkKeep?: number;
  u?: number;
}

export function plateCase(p: PlateSpec): CaseSpec {
  const L = p.length;
  return {
    poly: plateCells(L, p.thickness ?? 6),
    lRef: L,
    re: p.re,
    turb: p.turb,
    x: 0.3 * L + L / 2,
    y: Math.round(0.2 * L) + (p.yOffset ?? 0.3),
    alpha: 0,
    nx: Math.round(1.9 * L),
    ny: Math.round(0.4 * L),
    tstar: p.tstar ?? 3,
    gridRe: p.gridRe,
    dump: p.dump,
    bulkKeep: p.bulkKeep,
    u: p.u,
  };
}

/** White's turbulent flat-plate skin friction, Cf = 0.455 / ln²(0.06 Re_x). */
export function cfWhite(reX: number): number {
  const l = Math.log(0.06 * reX);
  return 0.455 / (l * l);
}
