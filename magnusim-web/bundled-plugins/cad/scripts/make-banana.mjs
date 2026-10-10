// The "Banana for scale" mesh (ux010, Daniel 2026-10-09: "a banana for scale ... yellow").
// Our own model, made here from scratch with our own kernel (GPL, like the rest of the plugin;
// no outside file is used): one smooth loft of rounded-pentagon sections (a banana has five soft
// ridges) along a crescent spine, from a point at the blossom tip to a short stem cut flat. The
// body is 185 mm along X, about 205 mm end to end with the stem, and 37 mm thick at the middle.
//   node scripts/make-banana.mjs [outDir]   (default: workspace/) -> <outDir>/models/banana.bin
// scripts/build.mjs runs it on every build, so `npm run build:check` covers the file.
//
// The file (little endian; read by src/features/scale/banana-mesh.ts):
//   0  char[4] "BNA1"
//   4  u32     vertex count V
//   8  u32     index count I (triangles * 3)
//   12 f32     length end to end along the long axis, blossom tip to the stem's cut (mm)
//   16 f32     position unit (mm per step; positions are int16 steps)
//   20 f32[6]  bounding box min xyz, max xyz (mm)
//   44 u16[I]  indices (padded to 4 bytes)
//   .. i16[3V] positions (steps), i16[3V] normals (x32767), u8[3V] colours (sRGB)
// The banana lies on Z = 0 (its lowest point), centred on X and Y, its long axis along Y, the
// stem at +Y, curving up at both ends (lying on its back).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BANANA_OUT = 'models/banana.bin';

/**
 * The recipe (round 3, approved by Daniel: the coordinator's native preview banana3.py, our own
 * tables read off the shape of a side-on photo). Built along +X here (Z up), turned to +Y at the
 * end:
 * - centreline: the table CENTRE (x, z), through a natural cubic spline in x;
 * - diameter: the table DIAM (x), linear between stations: a blunt blossom end, a long even body
 *   (38 mm), a short shoulder (x 156-182) dropping into a 10-11 mm neck that bends up, the stem
 *   flaring to 13 mm at a flat cut (x = 204);
 * - sections at X_STATIONS: rounded pentagons (flat faces, corners rounded with 0.5 of the
 *   circumradius on the body, 0.32 past x = 178 where the stem is squarer, squashed 0.93 across),
 *   each a closed interpolated cubic B-spline; a point at the blossom tip (x = -0.8);
 * - colours along x: yellow, the neck greening from x 169, the stem from x 195, a dark cut over
 *   the last 5 mm and a dark nub over the first 3.5 mm.
 */
const CENTRE = [
  [0, -60.0],
  [9, -64.5],
  [45, -78],
  [90, -86],
  [135, -82],
  [165, -71],
  [175, -63.5],
  [184, -50],
  [191, -41],
  [198, -33],
  [204, -27],
];
const DIAM = [
  [0, 3.0],
  [3, 12.0],
  [9, 22.0],
  [20, 29.0],
  [45, 34.0],
  [90, 38.0],
  [135, 38.0],
  [156, 35.8],
  [164, 33.0],
  [170, 28.5],
  [175, 22.0],
  [179, 15.0],
  [182, 12.2],
  [185, 11.0],
  [192, 10.2],
  [198, 10.6],
  [202, 12.4],
  [204, 13.0],
];
const X_STATIONS = [1.2, 3, 6, 10, 16, 25, 38, 55, 75, 95, 115, 135, 150, 160, 167, 172, 176, 180, 184, 189, 194, 198, 201, 203.5];
const STEM_X = 181;
const YELLOW = [247, 212, 58];
const GREEN_Y = [196, 196, 70];
const STEM_C = [150, 120, 60];
const CUT = [96, 64, 36];
const NUB = [48, 36, 24];

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

/** A natural cubic spline through (x, y) knots: value and slope at x (scipy's CubicSpline bc 'natural'). */
function naturalSpline(pts) {
  const n = pts.length - 1;
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  const h = Array.from({ length: n }, (_, i) => x[i + 1] - x[i]);
  // Second derivatives M (M_0 = M_n = 0): tridiagonal solve.
  const a = new Array(n + 1).fill(0);
  const b = new Array(n + 1).fill(1);
  const c = new Array(n + 1).fill(0);
  const d = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    a[i] = h[i - 1];
    b[i] = 2 * (h[i - 1] + h[i]);
    c[i] = h[i];
    d[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
  }
  for (let i = 1; i <= n; i++) {
    const m = a[i] / b[i - 1];
    b[i] -= m * c[i - 1];
    d[i] -= m * d[i - 1];
  }
  const M = new Array(n + 1).fill(0);
  M[n] = d[n] / b[n];
  for (let i = n - 1; i >= 0; i--) M[i] = (d[i] - c[i] * M[i + 1]) / b[i];
  return (q) => {
    let i = 0;
    while (i < n - 1 && q > x[i + 1]) i++;
    const t0 = x[i + 1] - q;
    const t1 = q - x[i];
    const hi = h[i];
    const v = (M[i] * t0 ** 3 + M[i + 1] * t1 ** 3) / (6 * hi) + (y[i] / hi - (M[i] * hi) / 6) * t0 + (y[i + 1] / hi - (M[i + 1] * hi) / 6) * t1;
    const s = (-M[i] * t0 ** 2 + M[i + 1] * t1 ** 2) / (2 * hi) - (y[i] / hi - (M[i] * hi) / 6) + (y[i + 1] / hi - (M[i + 1] * hi) / 6);
    return { v, s };
  };
}
const centre = naturalSpline(CENTRE);
/** The centreline at x: point and unit tangent (XZ plane). */
function spine(x) {
  const { v, s } = centre(x);
  return { p: [x, 0, v], t: norm([1, 0, s]) };
}
/** The diameter at x (linear between the table's stations, held past its ends). */
function diam(x) {
  if (x <= DIAM[0][0]) return DIAM[0][1];
  for (let i = 1; i < DIAM.length; i++) {
    const [x0, d0] = DIAM[i - 1];
    const [x1, d1] = DIAM[i];
    if (x <= x1) return d0 + ((d1 - d0) * (x - x0)) / (x1 - x0);
  }
  return DIAM[DIAM.length - 1][1];
}

/** A rounded pentagon of circumradius `rad` as points (a, b): flat faces, corners of radius roundFrac * rad, b squashed by `flat`. */
function roundedPentagon(rad, roundFrac = 0.5, perArc = 9, flat = 0.93) {
  const rho = roundFrac * rad;
  const rin = rad - rho;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const al = Math.PI / 2 + (2 * Math.PI * i) / 5;
    const cx = rin * Math.cos(al);
    const cy = rin * Math.sin(al);
    for (let j = 0; j < perArc - 1; j++) {
      const ps = al - Math.PI / 5 + ((2 * Math.PI) / 5) * (j / (perArc - 1));
      out.push([cx + rho * Math.cos(ps), cy + rho * Math.sin(ps)]);
    }
    // The flat face's midpoint, toward the next corner.
    const al2 = al + (2 * Math.PI) / 5;
    const nx = Math.cos(al + Math.PI / 5);
    const ny = Math.sin(al + Math.PI / 5);
    out.push([(cx + rin * Math.cos(al2)) / 2 + rho * nx, (cy + rin * Math.sin(al2)) / 2 + rho * ny]);
  }
  return out.map(([a, b]) => [a, b * flat]);
}

/**
 * The same rounded pentagon as `n` points evenly spaced along it (from its top), so a uniform
 * interpolation through them neither bulges between sparse points on the flats nor kinks where
 * they crowd at the corners (a squarer stem section, rounding 0.32, made the loft fold there).
 */
function evenPentagon(rad, roundFrac, n = 40) {
  const dense = roundedPentagon(rad, roundFrac, 25);
  // Every flat face sampled too (the dense outline: arcs, then the face to the next arc).
  const pts = [];
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    for (let k = 0; k < 8; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8]);
  }
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[pts.length];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / n;
    while (cum[j + 1] < s) j++;
    const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const a = pts[j];
    const b = pts[(j + 1) % pts.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * The closed cubic B-spline through `pts` (uniform, periodic: P_i = (C_(i-1) + 4 C_i + C_(i+1)) / 6,
 * solved by Jacobi iteration), written as the kernel's clamped B-spline with SIMPLE interior knots:
 * the periodic curve, its knot at the seam raised to full multiplicity (Boehm insertion), so the
 * same C2 curve everywhere, the seam too, with one knot span per point (the loft then gets one
 * smooth face per section, not one per span).
 */
function closedSpline(id, pts) {
  const n = pts.length;
  let c = pts.map((p) => [...p]);
  for (let it = 0; it < 300; it++) c = c.map((_, i) => [0, 1].map((d) => (6 * pts[i][d] - c[(i - 1 + n) % n][d] - c[(i + 1) % n][d]) / 4));
  // The periodic curve as an open uniform cubic valid on [-1, n + 1] (so 0 and n are inner knots):
  // poles C_(n-2), C_(n-1), C_0 .. C_(n-1), C_0, C_1, C_2 (n + 5), knots -4 .. n + 4.
  let P = [c[n - 2], c[n - 1], ...c, c[0], c[1], c[2]].map((q) => [...q]);
  let T = Array.from({ length: n + 9 }, (_, j) => j - 4);
  const insert = (u) => {
    let k = 0;
    while (k + 1 < T.length && T[k + 1] <= u) k++;
    const Q = [];
    for (let i = 0; i <= P.length; i++) {
      if (i <= k - 3) Q.push(P[i]);
      else if (i >= k + 1) Q.push(P[i - 1]);
      else {
        const a = (u - T[i]) / (T[i + 3] - T[i]);
        Q.push([0, 1].map((d) => (1 - a) * P[i - 1][d] + a * P[i][d]));
      }
    }
    P = Q;
    T = [...T.slice(0, k + 1), u, ...T.slice(k + 1)];
  };
  // Knots 0 and n: from multiplicity 1 to 3 (the curve then passes through a pole there).
  for (const u of [0, 0, n, n]) insert(u);
  // The clamped spline over [0, n]: its first pole is the one at the knot 0 (multiplicity 3).
  const first = T.indexOf(0) - 1;
  const poles = P.slice(first, first + n + 3).map((q) => q.map((v) => +v.toFixed(12)));
  poles[poles.length - 1] = poles[0];
  const knots = Array.from({ length: n + 1 }, (_, i) => i / n);
  const mults = knots.map((_, i) => (i === 0 || i === n ? 4 : 1));
  return { id, kind: 'bspline', degree: 3, poles, knots, mults, pa: `${id}p`, pb: `${id}p` };
}

/**
 * A section at `c` across direction `t` (unit, in the XZ plane): the plane's x is the in-plane
 * normal n = (-t.z, 0, t.x) and its y is -Y, so a pentagon point (a, b) lies at c + a n + b Y.
 */
function sectionAt(id, c, t, rad, roundFrac = 0.5) {
  const plane = { origin: c, normal: t, xdir: [-t[2], 0, t[0]] };
  return { plane, curve: closedSpline(id, evenPentagon(rad, roundFrac).map(([a, b]) => [a, -b])) };
}

const lerp = (a, b, w) => a.map((x, i) => x + (b[i] - x) * w);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** The colour bands along x (the preview's): xmin, xmax of the whole banana. */
function colourAt(x, xmin, xmax) {
  let col = YELLOW;
  col = lerp(col, GREEN_Y, 0.55 * clamp01((x - (STEM_X - 12)) / 14));
  col = lerp(col, STEM_C, clamp01((x - (STEM_X + 14)) / 6));
  col = lerp(col, CUT, clamp01((x - (xmax - 5)) / 3));
  col = lerp(col, NUB, clamp01((xmin + 3.5 - x) / 2.5));
  return col.map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

async function loadKernel() {
  // src/kernel-worker/kernel-api.ts has no imports: strip its types with vite's esbuild (no new dependency).
  const { transformWithEsbuild } = await import('vite');
  const src = readFileSync(join(ROOT, 'src', 'kernel-worker', 'kernel-api.ts'), 'utf8');
  const js = (await transformWithEsbuild(src, 'kernel-api.ts', { loader: 'ts', format: 'esm', target: 'es2022' })).code;
  const tmp = join(ROOT, '.cache', 'make-banana', 'kernel-api.mjs');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, js);
  const { createKernel } = await import(pathToFileURL(tmp).href);
  const dir = join(ROOT, 'workspace', 'kernel');
  return createKernel({ moduleUrl: pathToFileURL(join(dir, 'mk32.mjs')).href, wasmBinary: readFileSync(join(dir, 'mk32.wasm')) });
}

/**
 * One vertex per place on the smooth skin: the kernel's tessellation repeats a vertex on every
 * face (and the loft's seam); vertices at the same place whose normals are within 60 degrees are
 * merged and their normals averaged (no faceting at a seam), the flat cut's rim stays sharp.
 */
function weld(pos, nor, idx) {
  const groups = new Map();
  const out = { pos: [], nor: [], map: new Int32Array(pos.length / 3) };
  for (let i = 0; i < pos.length / 3; i++) {
    const key = [0, 1, 2].map((a) => Math.round(pos[3 * i + a] * 1000)).join(',');
    const n = norm(nor.slice(3 * i, 3 * i + 3));
    const list = groups.get(key) ?? [];
    let hit = list.find((g) => g.n[0] * n[0] + g.n[1] * n[1] + g.n[2] * n[2] > 0.5);
    if (!hit) {
      hit = { v: out.pos.length / 3, n, sum: [0, 0, 0] };
      out.pos.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
      out.nor.push(0, 0, 0);
      list.push(hit);
      groups.set(key, list);
    }
    for (let a = 0; a < 3; a++) out.nor[3 * hit.v + a] += n[a];
    out.map[i] = hit.v;
  }
  for (let v = 0; v < out.nor.length / 3; v++) {
    const n = norm(out.nor.slice(3 * v, 3 * v + 3));
    for (let a = 0; a < 3; a++) out.nor[3 * v + a] = n[a];
  }
  const indices = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = out.map[idx[t]];
    const b = out.map[idx[t + 1]];
    const c = out.map[idx[t + 2]];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { pos: out.pos, nor: out.nor, idx: indices };
}

/** The mesh (positions mm, normals, colours, indices), lying on Z = 0, centred on X and Y, long axis along +Y. */
export async function bananaMesh() {
  const k = await loadKernel();
  const call = (op, params) => k.call(op, params);
  const sections = [];
  const add = ({ plane, curve }) => {
    const regions = call('sketch_regions', { plane, curves: [curve], tess: false }).regions;
    if (regions.length !== 1) throw new Error(`section ${curve.id}: ${regions.length} regions`);
    sections.push({ plane, curves: [curve], regions: [regions[0].key] });
  };
  // The blossom tip: a point (a section 0.1 mm across), 0.8 mm out along the centreline.
  const s0 = spine(0);
  add(sectionAt('tip', [s0.p[0] - s0.t[0] * 0.8, 0, s0.p[2] - s0.t[2] * 0.8], s0.t, 0.05));
  // The stations; past x = 178 (the stem) the corners are tighter, the stem squarer.
  X_STATIONS.forEach((x, i) => {
    const { p, t } = spine(x);
    add(sectionAt(`s${i}`, p, t, diam(x) / 2, x < 178 ? 0.5 : 0.32));
  });
  const loft = call('loft_regions', { sections, ruled: false });
  if (!loft.valid) throw new Error(`the banana's loft is not a valid solid: ${loft.reason ?? ''}`);
  const tess = call('tessellate', { id: loft.id, lin_defl: 0.1, ang_defl_deg: 15, edge_flags: false });
  const b = k.takeBuffers(tess);
  call('release', { ids: [loft.id] });
  const w = weld(Array.from(b.positions), Array.from(b.normals), Array.from(b.indices));
  // Colours along x, then turn +X to +Y (x, y, z) -> (-y, x, z), lie on Z = 0 and centre on X, Y.
  const V = w.pos.length / 3;
  let xmin = Infinity;
  let xmax = -Infinity;
  for (let i = 0; i < V; i++) (xmin = Math.min(xmin, w.pos[3 * i])), (xmax = Math.max(xmax, w.pos[3 * i]));
  const col = [];
  const pos = [];
  const nor = [];
  for (let i = 0; i < V; i++) {
    const [x, y, z] = w.pos.slice(3 * i, 3 * i + 3);
    const [nx, ny, nz] = w.nor.slice(3 * i, 3 * i + 3);
    col.push(...colourAt(x, xmin, xmax));
    pos.push(-y, x, z);
    nor.push(-ny, nx, nz);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) for (let a = 0; a < 3; a++) (min[a] = Math.min(min[a], pos[3 * i + a])), (max[a] = Math.max(max[a], pos[3 * i + a]));
  const shift = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < V; i++) for (let a = 0; a < 3; a++) pos[3 * i + a] += shift[a];
  for (let a = 0; a < 3; a++) (min[a] += shift[a]), (max[a] += shift[a]);
  // Its length end to end along its long axis (the blossom tip to the stem's cut), as a user measures a banana on a table.
  const length = max[1] - min[1];
  return { positions: pos, normals: nor, colours: col, indices: w.idx, min, max, length };
}

/** The mesh as the compact file described above. */
export function encode(m) {
  const V = m.positions.length / 3;
  const I = m.indices.length;
  if (V > 65535) throw new Error(`too many vertices for u16 indices: ${V}`);
  const UNIT = 0.01;
  const idxBytes = Math.ceil((I * 2) / 4) * 4;
  const size = 44 + idxBytes + V * 6 + V * 6 + V * 3;
  const buf = Buffer.alloc(size);
  buf.write('BNA1', 0, 'ascii');
  buf.writeUInt32LE(V, 4);
  buf.writeUInt32LE(I, 8);
  buf.writeFloatLE(m.length, 12);
  buf.writeFloatLE(UNIT, 16);
  [...m.min, ...m.max].forEach((v, i) => buf.writeFloatLE(v, 20 + 4 * i));
  let o = 44;
  for (const i of m.indices) (buf.writeUInt16LE(i, o), (o += 2));
  o = 44 + idxBytes;
  for (const v of m.positions) (buf.writeInt16LE(Math.round(v / UNIT), o), (o += 2));
  for (let i = 0; i < V; i++) {
    const n = m.normals.slice(3 * i, 3 * i + 3);
    const l = Math.hypot(...n) || 1;
    for (const c of n) (buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((c / l) * 32767))), o), (o += 2));
  }
  for (const c of m.colours) (buf.writeUInt8(c, o), (o += 1));
  return buf;
}

/** Write <outDir>/models/banana.bin; returns its size and triangle count. */
export async function makeBanana(outDir = join(ROOT, 'workspace')) {
  const m = await bananaMesh();
  const buf = encode(m);
  const out = join(outDir, BANANA_OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  return { bytes: buf.length, triangles: m.indices.length / 3, vertices: m.positions.length / 3, min: m.min, max: m.max };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await makeBanana(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`banana: ${r.triangles} triangles, ${r.vertices} vertices, ${r.bytes} bytes, box ${r.min.map((v) => v.toFixed(1))} .. ${r.max.map((v) => v.toFixed(1))}`);
}
