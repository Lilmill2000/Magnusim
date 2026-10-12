/**
 * Fast lookups behind hiding faces and bodies in the viewport (runtime.js), for parts
 * with thousands of faces: which CAD face lies nearest a point, which faces meet along
 * an edge, which drawn cells a hidden face or body removes, and copying the kept cells.
 * Plain typed arrays, no per-cell objects or strings: hiding a face of a part with
 * 6,500 faces, 23,000 edges and 112,000 triangles froze the page for 45 s before.
 * The answers are the same as the per-object code they replace.
 */

/** Triangles of the shown part: xyz holds 9 numbers per triangle (a, b, c). */
export interface TriSoup {
  count: number;
  xyz: Float64Array;
  faceIds: Int32Array;
}

export interface CadFaceIndex {
  empty: boolean;
  /** The face whose triangle lies nearest the point (0 for none). */
  faceIdAt(pt: ArrayLike<number> | null | undefined): number;
  /** Faces within sqrt(tol2) of the point (or within twice the nearest distance). */
  faceIdsNear(pt: ArrayLike<number> | null | undefined, tol2: number): number[];
  /** Faces a point on an edge lies on: within sqrt(slop2), or within twice the nearest distance. */
  facesOnEdge(pt: ArrayLike<number> | null | undefined, slop2: number): number[];
  /** facesOnEdge for each of these points of one edge (one grid look-up for them all). */
  facesOnEdgeMany(pts: readonly ArrayLike<number>[], slop2: number): number[][];
}

type Tri = { faceId: number; a: ArrayLike<number>; b: ArrayLike<number>; c: ArrayLike<number> };

export function triSoupFromTris(tris: readonly Tri[]): TriSoup {
  const n = tris.length;
  const xyz = new Float64Array(n * 9);
  const faceIds = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    const tri = tris[t];
    const o = t * 9;
    xyz[o] = tri.a[0];
    xyz[o + 1] = tri.a[1];
    xyz[o + 2] = tri.a[2];
    xyz[o + 3] = tri.b[0];
    xyz[o + 4] = tri.b[1];
    xyz[o + 5] = tri.b[2];
    xyz[o + 6] = tri.c[0];
    xyz[o + 7] = tri.c[1];
    xyz[o + 8] = tri.c[2];
    faceIds[t] = tri.faceId;
  }
  return { count: n, xyz, faceIds };
}

/** The largest side of the triangles' bounding box (at least 1). */
export function triSoupSpan(soup: TriSoup): number {
  const { xyz, count } = soup;
  if (!count) return 1;
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < count * 9; i += 3) {
    const x = xyz[i];
    const y = xyz[i + 1];
    const z = xyz[i + 2];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  return Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1);
}

/**
 * Squared distance from (px, py, pz) to triangle t of xyz: the same arithmetic, in the same
 * order, as runtime.js's distPointTri2 (closest point by Voronoi region), without arrays.
 */
export function distPointTri2(xyz: Float64Array, t: number, px: number, py: number, pz: number): number {
  const o = t * 9;
  const ax = xyz[o];
  const ay = xyz[o + 1];
  const az = xyz[o + 2];
  const bx = xyz[o + 3];
  const by = xyz[o + 4];
  const bz = xyz[o + 5];
  const cx = xyz[o + 6];
  const cy = xyz[o + 7];
  const cz = xyz[o + 8];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = px - (ax + abx * v);
    const dy = py - (ay + aby * v);
    const dz = pz - (az + abz * v);
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = px - (ax + acx * w);
    const dy = py - (ay + acy * w);
    const dz = pz - (az + acz * w);
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = px - (bx + (cx - bx) * w);
    const dy = py - (by + (cy - by) * w);
    const dz = pz - (bz + (cz - bz) * w);
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc);
  const qx = ax + (abx * (vb * denom) + acx * (vc * denom));
  const qy = ay + (aby * (vb * denom) + acy * (vc * denom));
  const qz = az + (abz * (vb * denom) + acz * (vc * denom));
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// A triangle (or grid cell) is skipped only when it is surely farther than the bound; the
// slack (and a hair of a cell) keeps a rounding difference between a box and the exact
// distance from mattering.
const SKIP_SLACK = 1 + 1e-9;

/**
 * A uniform grid over the triangles (cell size `cell`; a triangle sits in every cell its box,
 * grown by cell/10000, touches), searched one ring (3x3x3 cells) around a point, three rings
 * when that ring holds no triangle. A first look at the point's own cell bounds the answer, so
 * the rest of the ring skips the cells and triangles that cannot change it.
 */
export function buildCadFaceIndex(soup: TriSoup, cell: number): CadFaceIndex {
  const { count, xyz, faceIds } = soup;
  if (!count || !(cell > 0)) {
    return { empty: true, faceIdAt: () => 0, faceIdsNear: () => [], facesOnEdge: () => [], facesOnEdgeMany: (pts) => pts.map(() => []) };
  }
  const eps = cell * 1e-4;
  const box = new Float64Array(count * 6);
  const lo = new Int32Array(count * 3);
  const hi = new Int32Array(count * 3);
  let gx0 = Infinity;
  let gy0 = Infinity;
  let gz0 = Infinity;
  let gx1 = -Infinity;
  let gy1 = -Infinity;
  let gz1 = -Infinity;
  let maxFace = 0;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const xmin = Math.min(xyz[o], xyz[o + 3], xyz[o + 6]);
    const xmax = Math.max(xyz[o], xyz[o + 3], xyz[o + 6]);
    const ymin = Math.min(xyz[o + 1], xyz[o + 4], xyz[o + 7]);
    const ymax = Math.max(xyz[o + 1], xyz[o + 4], xyz[o + 7]);
    const zmin = Math.min(xyz[o + 2], xyz[o + 5], xyz[o + 8]);
    const zmax = Math.max(xyz[o + 2], xyz[o + 5], xyz[o + 8]);
    box[t * 6] = xmin;
    box[t * 6 + 1] = ymin;
    box[t * 6 + 2] = zmin;
    box[t * 6 + 3] = xmax;
    box[t * 6 + 4] = ymax;
    box[t * 6 + 5] = zmax;
    const x0 = Math.floor((xmin - eps) / cell);
    const x1 = Math.floor((xmax + eps) / cell);
    const y0 = Math.floor((ymin - eps) / cell);
    const y1 = Math.floor((ymax + eps) / cell);
    const z0 = Math.floor((zmin - eps) / cell);
    const z1 = Math.floor((zmax + eps) / cell);
    lo[t * 3] = x0;
    lo[t * 3 + 1] = y0;
    lo[t * 3 + 2] = z0;
    hi[t * 3] = x1;
    hi[t * 3 + 1] = y1;
    hi[t * 3 + 2] = z1;
    if (x0 < gx0) gx0 = x0;
    if (y0 < gy0) gy0 = y0;
    if (z0 < gz0) gz0 = z0;
    if (x1 > gx1) gx1 = x1;
    if (y1 > gy1) gy1 = y1;
    if (z1 > gz1) gz1 = z1;
    if (faceIds[t] > maxFace) maxFace = faceIds[t];
  }
  const nx = gx1 - gx0 + 1;
  const ny = gy1 - gy0 + 1;
  const nz = gz1 - gz0 + 1;
  // Occupied cells only (a long thin part leaves most of its box empty): cell key -> slot.
  const slotOf = new Map<number, number>();
  const keyOf = (i: number, j: number, k: number) => (i - gx0) + nx * ((j - gy0) + ny * (k - gz0));
  const counts: number[] = [];
  for (let t = 0; t < count; t++) {
    for (let i = lo[t * 3]; i <= hi[t * 3]; i++) {
      for (let j = lo[t * 3 + 1]; j <= hi[t * 3 + 1]; j++) {
        for (let k = lo[t * 3 + 2]; k <= hi[t * 3 + 2]; k++) {
          const key = keyOf(i, j, k);
          let s = slotOf.get(key);
          if (s === undefined) {
            s = counts.length;
            slotOf.set(key, s);
            counts.push(0);
          }
          counts[s] += 1;
        }
      }
    }
  }
  const start = new Int32Array(counts.length + 1);
  for (let s = 0; s < counts.length; s++) start[s + 1] = start[s] + counts[s];
  const fill = start.slice(0, counts.length);
  const items = new Int32Array(start[counts.length]);
  // Triangles go into each cell in triangle order, as the per-object grid had them.
  for (let t = 0; t < count; t++) {
    for (let i = lo[t * 3]; i <= hi[t * 3]; i++) {
      for (let j = lo[t * 3 + 1]; j <= hi[t * 3 + 1]; j++) {
        for (let k = lo[t * 3 + 2]; k <= hi[t * 3 + 2]; k++) {
          const s = slotOf.get(keyOf(i, j, k)) as number;
          items[fill[s]++] = t;
        }
      }
    }
  }
  // A flat cell -> slot table when the box is not too big (a Map lookup costs ~10x more).
  const flat = nx * ny * nz <= 1 << 22 ? new Int32Array(nx * ny * nz).fill(-1) : null;
  if (flat) slotOf.forEach((s, key) => { flat[key] = s; });
  const slot = (i: number, j: number, k: number): number => {
    if (i < gx0 || i > gx1 || j < gy0 || j > gy1 || k < gz0 || k > gz1) return -1;
    if (flat) return flat[keyOf(i, j, k)];
    const s = slotOf.get(keyOf(i, j, k));
    return s === undefined ? -1 : s;
  };
  const boxDist2 = (t: number, px: number, py: number, pz: number): number => {
    const o = t * 6;
    const dx = px < box[o] ? box[o] - px : px > box[o + 3] ? px - box[o + 3] : 0;
    const dy = py < box[o + 1] ? box[o + 1] - py : py > box[o + 4] ? py - box[o + 4] : 0;
    const dz = pz < box[o + 2] ? box[o + 2] - pz : pz > box[o + 5] ? pz - box[o + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  };
  // How far the point is from a cell, a hair short (rounding in i * cell against
  // floor(p / cell) must not skip the cell a triangle at distance 0 sits in).
  const hair = cell * 1e-6;
  const cellDist2 = (i: number, j: number, k: number, px: number, py: number, pz: number): number => {
    const ax = i * cell - hair;
    const ay = j * cell - hair;
    const az = k * cell - hair;
    const w = cell + 2 * hair;
    const dx = px < ax ? ax - px : px > ax + w ? px - ax - w : 0;
    const dy = py < ay ? ay - py : py > ay + w ? py - ay - w : 0;
    const dz = pz < az ? az - pz : pz > az + w ? pz - az - w : 0;
    return dx * dx + dy * dy + dz * dz;
  };
  /** The nearest distance over the point's own cell (Infinity when it holds none). */
  const ownCellBest = (i0: number, j0: number, k0: number, px: number, py: number, pz: number): number => {
    const s = slot(i0, j0, k0);
    let best = Infinity;
    if (s < 0) return best;
    for (let b = start[s]; b < start[s + 1]; b++) {
      const t = items[b];
      if (boxDist2(t, px, py, pz) > best) continue;
      const d = distPointTri2(xyz, t, px, py, pz);
      if (d < best) best = d;
    }
    return best;
  };

  const searchRing = (px: number, py: number, pz: number, ring: number) => {
    const i0 = Math.floor(px / cell);
    const j0 = Math.floor(py / cell);
    const k0 = Math.floor(pz / cell);
    // Nothing beyond the bound can be the nearest. A triangle whose nearest part lies outside
    // the ring is at least ring*cell away, so cells are skipped only below that.
    const bound = ownCellBest(i0, j0, k0, px, py, pz);
    const skipCells = bound < (ring * cell) * (ring * cell);
    const limit = bound * SKIP_SLACK + hair * hair;
    // Equally near triangles: the first in the full ring's order wins, as it did. That is
    // the first ring cell the triangle sits in (it may sit in a skipped one), then its number.
    const side = 2 * ring + 1;
    const rank = (t: number): number => {
      const ci = Math.max(lo[t * 3], i0 - ring) - (i0 - ring);
      const cj = Math.max(lo[t * 3 + 1], j0 - ring) - (j0 - ring);
      const ck = Math.max(lo[t * 3 + 2], k0 - ring) - (k0 - ring);
      return ((ci * side + cj) * side + ck) * count + t;
    };
    let bestD = Infinity;
    let bestT = -1;
    for (let i = i0 - ring; i <= i0 + ring; i++) {
      for (let j = j0 - ring; j <= j0 + ring; j++) {
        for (let k = k0 - ring; k <= k0 + ring; k++) {
          const s = slot(i, j, k);
          if (s < 0) continue;
          const own = i === i0 && j === j0 && k === k0;
          if (skipCells && !own && cellDist2(i, j, k, px, py, pz) > limit) continue;
          for (let b = start[s]; b < start[s + 1]; b++) {
            const t = items[b];
            if (boxDist2(t, px, py, pz) > limit) continue;
            const d = distPointTri2(xyz, t, px, py, pz);
            if (d < bestD || (d === bestD && t !== bestT && rank(t) < rank(bestT))) {
              bestD = d;
              bestT = t;
            }
          }
        }
      }
    }
    return bestT >= 0 ? faceIds[bestT] : 0;
  };

  // Per-face nearest distance of one query, reused (faces seen are reset after each); a Map
  // for ids a flat array can't hold.
  const dense = maxFace <= 1 << 22;
  const minByFace = new Float64Array(dense ? maxFace + 1 : 1).fill(Infinity);
  const minByOther = new Map<number, number>();
  const seen: number[] = [];
  const facesNear = (px: number, py: number, pz: number, slop2: number, ring: number): number[] | null => {
    const i0 = Math.floor(px / cell);
    const j0 = Math.floor(py / cell);
    const k0 = Math.floor(pz / cell);
    const slop = slop2 > 0 ? slop2 : 0;
    let best = Infinity;
    let any = false;
    // The answer keeps faces within max(slop2, 4 x nearest) only: the point's own cell, looked
    // at first, bounds that, and the rest of the ring skips what lies beyond the bound.
    let limit = Infinity;
    let skipCells = false;
    const visit = (s: number) => {
      for (let b = start[s]; b < start[s + 1]; b++) {
        const t = items[b];
        if (boxDist2(t, px, py, pz) > limit) continue;
        const d = distPointTri2(xyz, t, px, py, pz);
        if (d < best) best = d;
        const fid = faceIds[t];
        if (fid > 0 && dense) {
          if (minByFace[fid] === Infinity) seen.push(fid);
          if (d < minByFace[fid]) minByFace[fid] = d;
        } else if (fid !== 0) {
          const prev = minByOther.get(fid);
          if (prev === undefined) seen.push(fid);
          if (prev === undefined || d < prev) minByOther.set(fid, d);
        }
      }
    };
    const own = slot(i0, j0, k0);
    if (own >= 0) {
      any = true;
      visit(own);
      const bound = Math.max(slop, best * 4);
      skipCells = bound < (ring * cell) * (ring * cell);
      limit = bound * SKIP_SLACK + hair * hair;
    }
    for (let i = i0 - ring; i <= i0 + ring; i++) {
      for (let j = j0 - ring; j <= j0 + ring; j++) {
        for (let k = k0 - ring; k <= k0 + ring; k++) {
          if (i === i0 && j === j0 && k === k0) continue;
          const s = slot(i, j, k);
          if (s < 0) continue;
          any = true;
          if (skipCells && cellDist2(i, j, k, px, py, pz) > limit) continue;
          visit(s);
        }
      }
    }
    if (!any) return null;
    const out: number[] = [];
    if (Number.isFinite(best)) {
      const cut = Math.max(slop, best * 4);
      for (let q = 0; q < seen.length; q++) {
        const fid = seen[q];
        const d = fid > 0 && dense ? minByFace[fid] : (minByOther.get(fid) as number);
        if (d <= cut) out.push(fid);
      }
    }
    for (let q = 0; q < seen.length; q++) if (seen[q] > 0 && dense) minByFace[seen[q]] = Infinity;
    minByOther.clear();
    seen.length = 0;
    return out;
  };

  // The triangles near one edge, gathered once for all its points (stamp = seen this edge).
  const stamp = new Int32Array(count);
  let stampNo = 0;
  const near: number[] = [];
  const facesOnEdgeMany = (pts: readonly ArrayLike<number>[], slop2: number): number[][] => {
    const slop = slop2 > 0 ? slop2 : 0;
    const r = Math.sqrt(slop);
    const one = (p: ArrayLike<number>) => index.facesOnEdge(p, slop2);
    if (!pts.length) return [];
    // Exact only when the points' faces lie within r of them and r is under a cell.
    if (!(r > 0) || r >= cell) return pts.map(one);
    let xmin = Infinity;
    let ymin = Infinity;
    let zmin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    let zmax = -Infinity;
    for (const p of pts) {
      const x = Number(p[0]);
      const y = Number(p[1]);
      const z = Number(p[2]);
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (z < zmin) zmin = z;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
      if (z > zmax) zmax = z;
    }
    // A hair wider than r, so rounding never leaves out a triangle right at r.
    const grow = r * (1 + 1e-6) + hair;
    xmin -= grow;
    ymin -= grow;
    zmin -= grow;
    xmax += grow;
    ymax += grow;
    zmax += grow;
    const i0 = Math.floor(xmin / cell);
    const i1 = Math.floor(xmax / cell);
    const j0 = Math.floor(ymin / cell);
    const j1 = Math.floor(ymax / cell);
    const k0 = Math.floor(zmin / cell);
    const k1 = Math.floor(zmax / cell);
    if (!Number.isFinite(i0 + i1 + j0 + j1 + k0 + k1)) return pts.map(one);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 4096) return pts.map(one);
    stampNo += 1;
    if (stampNo > 2_000_000_000) {
      stamp.fill(0);
      stampNo = 1;
    }
    near.length = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const s = slot(i, j, k);
          if (s < 0) continue;
          for (let b = start[s]; b < start[s + 1]; b++) {
            const t = items[b];
            if (stamp[t] === stampNo) continue;
            stamp[t] = stampNo;
            const o = t * 6;
            if (box[o] > xmax || box[o + 3] < xmin || box[o + 1] > ymax || box[o + 4] < ymin || box[o + 2] > zmax || box[o + 5] < zmin) continue;
            near.push(t);
          }
        }
      }
    }
    const limit = slop * SKIP_SLACK + hair * hair;
    return pts.map((p) => {
      const px = Number(p[0]);
      const py = Number(p[1]);
      const pz = Number(p[2]);
      let best = Infinity;
      for (let q = 0; q < near.length; q++) {
        const t = near[q];
        if (boxDist2(t, px, py, pz) > limit) continue;
        const d = distPointTri2(xyz, t, px, py, pz);
        if (d < best) best = d;
        const fid = faceIds[t];
        if (fid > 0 && dense) {
          if (minByFace[fid] === Infinity) seen.push(fid);
          if (d < minByFace[fid]) minByFace[fid] = d;
        } else if (fid !== 0) {
          const prev = minByOther.get(fid);
          if (prev === undefined) seen.push(fid);
          if (prev === undefined || d < prev) minByOther.set(fid, d);
        }
      }
      // Its nearest face within r/2: every face within the cut (r) is among the near
      // triangles, and the nearest is the ring's nearest. Otherwise the full look-up.
      const exact = best * 4 <= slop;
      const out: number[] = [];
      if (exact) {
        for (let q = 0; q < seen.length; q++) {
          const fid = seen[q];
          const d = fid > 0 && dense ? minByFace[fid] : (minByOther.get(fid) as number);
          if (d <= slop) out.push(fid);
        }
      }
      for (let q = 0; q < seen.length; q++) if (seen[q] > 0 && dense) minByFace[seen[q]] = Infinity;
      minByOther.clear();
      seen.length = 0;
      return exact ? out : one(p);
    });
  };

  const index: CadFaceIndex = {
    empty: false,
    faceIdAt(pt) {
      if (!pt) return 0;
      const px = Number(pt[0]);
      const py = Number(pt[1]);
      const pz = Number(pt[2]);
      let id = searchRing(px, py, pz, 1);
      if (!id) id = searchRing(px, py, pz, 3);
      return id || 0;
    },
    faceIdsNear(pt, tol2) {
      if (!pt || !(tol2 > 0)) return [];
      return index.facesOnEdge(pt, tol2);
    },
    facesOnEdge(pt, slop2) {
      if (!pt) return [];
      const px = Number(pt[0]);
      const py = Number(pt[1]);
      const pz = Number(pt[2]);
      let ids = facesNear(px, py, pz, slop2, 1);
      if (ids === null) ids = facesNear(px, py, pz, slop2, 3);
      return ids || [];
    },
    facesOnEdgeMany,
  };
  return index;
}

/**
 * The faces hidden by name ("face N@BodyM", runtime.js's faceLabel): face id -> its hidden
 * bodies. A name in any other form names no drawn face, as before.
 */
export function hiddenFaceBodies(labels: Iterable<string>): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const lab of labels) {
    const m = /^face (-?\d+)@Body(-?\d+)$/.exec(String(lab));
    if (!m) continue;
    const f = Number(m[1]);
    const b = Number(m[2]);
    if ('face ' + f + '@Body' + (b || 1) !== lab) continue;
    let set = out.get(f);
    if (!set) {
      set = new Set();
      out.set(f, set);
    }
    set.add(b);
  }
  return out;
}

/**
 * Which cells of the part's face polydata still draw (1) with these faces and bodies
 * hidden. A cell's face and body come from its faceId / solidId arrays; with no body id a
 * part that has bodies counts as Body1. A cell with neither id always draws.
 */
export function visibleCellMask(
  faceRaw: ArrayLike<number> | null | undefined,
  solidRaw: ArrayLike<number> | null | undefined,
  nCells: number,
  hasBodies: boolean,
  hiddenFaces: Map<number, Set<number>>,
  hiddenBodies: ReadonlySet<number>,
): Uint8Array {
  const keep = new Uint8Array(nCells);
  const anyBody = hiddenBodies.size > 0;
  const anyFace = hiddenFaces.size > 0;
  for (let i = 0; i < nCells; i++) {
    const f = faceRaw ? Number(faceRaw[i]) || 0 : 0;
    let s = solidRaw ? Number(solidRaw[i]) || 0 : 0;
    if (!s && hasBodies) s = 1;
    if (!f && !s) {
      keep[i] = 1;
      continue;
    }
    if (anyBody && hiddenBodies.has(s || 1)) continue;
    if (!f || !anyFace) {
      keep[i] = 1;
      continue;
    }
    const bodies = hiddenFaces.get(f);
    keep[i] = bodies && bodies.has(s || 1) ? 0 : 1;
  }
  return keep;
}

export interface ExtractedCells {
  points: Float32Array;
  cells: Uint32Array;
  /** The source cell index of each kept cell, in order. */
  kept: Int32Array;
}

/**
 * The kept cells of a legacy vtk cell array ([n, id0..idn-1, n, ...]) with only the points
 * they use, renumbered in first-use order. `keep` is a mask, or asked once per cell in order.
 * Cells with fewer than `minPoints` points are dropped without asking (lines need 2).
 */
export function extractCells(
  data: ArrayLike<number>,
  points: ArrayLike<number>,
  keep: Uint8Array | ((cellId: number) => boolean),
  minPoints = 0,
): ExtractedCells {
  const nPts = Math.floor(points.length / 3);
  const remap = new Int32Array(nPts).fill(-1);
  const mask = typeof keep === 'function' ? null : keep;
  const ask = typeof keep === 'function' ? keep : null;
  const keptIds: number[] = [];
  let connLen = 0;
  let newPts = 0;
  let cellId = 0;
  // Pass 1: which cells, which points (in first-use order).
  for (let i = 0; i < data.length; ) {
    const n = data[i];
    const a = i + 1;
    i = a + n;
    const id = cellId++;
    if (n < minPoints) continue;
    const on = mask ? mask[id] === 1 : (ask as (c: number) => boolean)(id);
    if (!on) continue;
    keptIds.push(id);
    connLen += n + 1;
    for (let k = a; k < a + n; k++) {
      const p = data[k];
      if (remap[p] < 0) remap[p] = newPts++;
    }
  }
  const kept = Int32Array.from(keptIds);
  const cells = new Uint32Array(connLen);
  const outPts = new Float32Array(newPts * 3);
  for (let p = 0; p < nPts; p++) {
    const q = remap[p];
    if (q < 0) continue;
    outPts[q * 3] = points[p * 3];
    outPts[q * 3 + 1] = points[p * 3 + 1];
    outPts[q * 3 + 2] = points[p * 3 + 2];
  }
  // Pass 2: the kept cells, renumbered.
  let w = 0;
  let next = 0;
  cellId = 0;
  for (let i = 0; i < data.length && next < kept.length; ) {
    const n = data[i];
    const a = i + 1;
    i = a + n;
    const id = cellId++;
    if (id !== kept[next]) continue;
    next += 1;
    cells[w++] = n;
    for (let k = a; k < a + n; k++) cells[w++] = remap[data[k]];
  }
  return { points: outPts, cells, kept };
}
