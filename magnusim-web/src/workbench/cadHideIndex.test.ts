// Hiding faces on big parts (cadHideIndex.ts): the same answers as the per-object code
// runtime.js had, and quick on a part the size of the one that froze the page.
import { describe, expect, it } from 'vitest';
import {
  buildCadFaceIndex,
  extractCells,
  hiddenFaceBodies,
  triSoupFromTris,
  triSoupSpan,
  visibleCellMask,
  type CadFaceIndex,
} from './cadHideIndex';

type V = [number, number, number];
type Tri = { faceId: number; a: V; b: V; c: V };

// ---- The per-object nearest-face grid runtime.js had (the reference) ----
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function refDist2(p: V, t: Tri): number {
  const ab = sub(t.b, t.a);
  const ac = sub(t.c, t.a);
  const ap = sub(p, t.a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, t.b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const d = sub(p, add(t.a, scale(ab, d1 / (d1 - d3))));
    return dot(d, d);
  }
  const cp = sub(p, t.c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const d = sub(p, add(t.a, scale(ac, d2 / (d2 - d6))));
    return dot(d, d);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const d = sub(p, add(t.b, scale(sub(t.c, t.b), w)));
    return dot(d, d);
  }
  const denom = 1 / (va + vb + vc);
  const d = sub(p, add(t.a, add(scale(ab, vb * denom), scale(ac, vc * denom))));
  return dot(d, d);
}

function refIndex(tris: Tri[], cell: number) {
  const grid = new Map<string, Tri[]>();
  const key = (i: number, j: number, k: number) => i + ',' + j + ',' + k;
  const eps = cell * 1e-4;
  for (const tri of tris) {
    const r = (ax: number) => [
      Math.floor((Math.min(tri.a[ax], tri.b[ax], tri.c[ax]) - eps) / cell),
      Math.floor((Math.max(tri.a[ax], tri.b[ax], tri.c[ax]) + eps) / cell),
    ];
    const [x0, x1] = r(0);
    const [y0, y1] = r(1);
    const [z0, z1] = r(2);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (let k = z0; k <= z1; k++) {
      const kk = key(i, j, k);
      if (!grid.has(kk)) grid.set(kk, []);
      grid.get(kk)!.push(tri);
    }
  }
  const ringTris = (p: V, ring: number, fn: (t: Tri) => void) => {
    const i0 = Math.floor(p[0] / cell);
    const j0 = Math.floor(p[1] / cell);
    const k0 = Math.floor(p[2] / cell);
    for (let i = i0 - ring; i <= i0 + ring; i++) for (let j = j0 - ring; j <= j0 + ring; j++) for (let k = k0 - ring; k <= k0 + ring; k++) {
      (grid.get(key(i, j, k)) || []).forEach(fn);
    }
  };
  const searchRing = (p: V, ring: number) => {
    let bestD = Infinity;
    let bestId = 0;
    ringTris(p, ring, (t) => {
      const d = refDist2(p, t);
      if (d < bestD) {
        bestD = d;
        bestId = t.faceId;
      }
    });
    return bestId;
  };
  const minByFace = (p: V, ring: number) => {
    const m = new Map<number, number>();
    ringTris(p, ring, (t) => {
      const d = refDist2(p, t);
      const prev = m.get(t.faceId);
      if (prev == null || d < prev) m.set(t.faceId, d);
    });
    return m;
  };
  return {
    faceIdAt(p: V) {
      return searchRing(p, 1) || searchRing(p, 3) || 0;
    },
    facesOnEdge(p: V, slop2: number) {
      let m = minByFace(p, 1);
      if (!m.size) m = minByFace(p, 3);
      let best = Infinity;
      m.forEach((d) => { if (d < best) best = d; });
      if (!Number.isFinite(best)) return [];
      const cut = Math.max(slop2 > 0 ? slop2 : 0, best * 4);
      const ids: number[] = [];
      m.forEach((d, fid) => { if (fid && d <= cut) ids.push(fid); });
      return ids;
    },
  };
}

// ---- Synthetic parts ----
/**
 * A wavy sheet of n x n square faces (each split into m x m x 2 triangles) and the grid
 * lines between them as edges (polylines of m + 1 points), plus a wall standing on one
 * row of faces so some edges meet three faces.
 */
function sheet(n: number, m: number, size = 10) {
  const z = (x: number, y: number) => 2 * Math.sin(x / 37) * Math.cos(y / 23);
  const tris: Tri[] = [];
  const p = (x: number, y: number): V => [x, y, z(x, y)];
  for (let fi = 0; fi < n; fi++) {
    for (let fj = 0; fj < n; fj++) {
      const faceId = fi * n + fj + 1;
      const h = size / m;
      for (let a = 0; a < m; a++) {
        for (let b = 0; b < m; b++) {
          const x = fi * size + a * h;
          const y = fj * size + b * h;
          tris.push({ faceId, a: p(x, y), b: p(x + h, y), c: p(x + h, y + h) });
          tris.push({ faceId, a: p(x, y), b: p(x + h, y + h), c: p(x, y + h) });
        }
      }
    }
  }
  const wall = n * n + 1;
  for (let fi = 0; fi < n; fi++) {
    const x = fi * size;
    const y = size * Math.floor(n / 2);
    const lo0 = p(x, y);
    const lo1 = p(x + size, y);
    const hi0: V = [lo0[0], lo0[1], lo0[2] + 8];
    const hi1: V = [lo1[0], lo1[1], lo1[2] + 8];
    tris.push({ faceId: wall, a: lo0, b: lo1, c: hi1 }, { faceId: wall, a: lo0, b: hi1, c: hi0 });
  }
  const edges: V[][] = [];
  for (let line = 0; line <= n; line++) {
    for (let s = 0; s < n; s++) {
      const along: V[] = [];
      const across: V[] = [];
      for (let k = 0; k <= m; k++) {
        along.push(p(line * size, s * size + (k * size) / m));
        across.push(p(s * size + (k * size) / m, line * size));
      }
      edges.push(along, across);
    }
  }
  return { tris, edges };
}

/** The edge's sample points as runtime.js takes them (cadFacesAlongEdge). */
function samples(pts: V[]): V[] {
  const n = Math.min(11, Math.max(5, Math.min(pts.length, 9)));
  const seg = pts.slice(1).map((q, i) => Math.hypot(...sub(q, pts[i])));
  const len = seg.reduce((s, x) => s + x, 0);
  const out: V[] = [];
  for (let s = 1; s <= n; s++) {
    const want = (s / (n + 1)) * len;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      if (acc + seg[i - 1] >= want || i === pts.length - 1) {
        const u = seg[i - 1] > 1e-18 ? (want - acc) / seg[i - 1] : 0;
        out.push(add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), Math.max(0, Math.min(1, u)))));
        break;
      }
      acc += seg[i - 1];
    }
  }
  return out;
}

const sorted = (a: number[]) => a.slice().sort((x, y) => x - y);
const cellFor = (tris: Tri[]) => {
  const span = triSoupSpan(triSoupFromTris(tris));
  return Math.max(span / 140, span * 0.008);
};

describe('the nearest-face grid', () => {
  const { tris, edges } = sheet(24, 3);
  const cell = cellFor(tris);
  const ref = refIndex(tris, cell);
  const idx: CadFaceIndex = buildCadFaceIndex(triSoupFromTris(tris), cell);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  it('finds the same nearest face as the per-object grid, ties included', () => {
    const pts: V[] = [];
    for (let i = 0; i < 1500; i++) pts.push([rnd() * 250 - 5, rnd() * 250 - 5, rnd() * 14 - 4]);
    // Points on shared edges and corners: two or four faces are equally near.
    for (let i = 0; i <= 24; i += 3) for (let j = 0; j <= 24; j += 3) pts.push([i * 10, j * 10, 2 * Math.sin((i * 10) / 37) * Math.cos((j * 10) / 23)]);
    // Far off the part: the three-ring look, or nothing.
    pts.push([1000, 1000, 1000], [-30, 120, 0], [120, -30, 50]);
    for (const p of pts) expect(idx.faceIdAt(p)).toBe(ref.faceIdAt(p));
    expect(idx.faceIdAt(null)).toBe(0);
  });

  it('breaks a tie between faces meeting at a point as the per-object grid did', () => {
    // Points along the lines where faces meet (two faces equally near, three under the wall),
    // and on triangle sides inside faces: the first triangle in the ring's order wins.
    let n = 0;
    for (const e of edges) {
      for (const p of samples(e)) {
        expect(idx.faceIdAt(p)).toBe(ref.faceIdAt(p));
        n += 1;
      }
    }
    for (let q = 0; q < 3000; q++) {
      const t = tris[Math.floor(rnd() * tris.length)];
      const u = rnd();
      const p: V = [t.a[0] + (t.b[0] - t.a[0]) * u, t.a[1] + (t.b[1] - t.a[1]) * u, t.a[2] + (t.b[2] - t.a[2]) * u];
      expect(idx.faceIdAt(p)).toBe(ref.faceIdAt(p));
      expect(idx.faceIdAt(t.a)).toBe(ref.faceIdAt(t.a));
    }
    expect(n).toBeGreaterThan(5000);
  });

  it('finds the same faces along every edge, one point at a time or all at once', () => {
    const slop2 = 0.05 * 0.05;
    let shared = 0;
    for (const e of edges) {
      const at = samples(e);
      const many = idx.facesOnEdgeMany(at, slop2);
      at.forEach((p, i) => {
        const want = sorted(ref.facesOnEdge(p, slop2));
        expect(sorted(idx.facesOnEdge(p, slop2))).toEqual(want);
        expect(sorted(many[i])).toEqual(want);
        if (want.length > 1) shared += 1;
      });
    }
    expect(shared).toBeGreaterThan(1000);
    // Off the surface (no face within the tolerance): the nearest ones, as before.
    for (const p of [[55, 55, 6], [5, 5, -3], [-8, 40, 0]] as V[]) {
      expect(sorted(idx.facesOnEdgeMany([p], slop2)[0])).toEqual(sorted(ref.facesOnEdge(p, slop2)));
    }
    expect(idx.facesOnEdgeMany([], slop2)).toEqual([]);
  });

  it('is empty for a part with no triangles', () => {
    const none = buildCadFaceIndex(triSoupFromTris([]), 1);
    expect(none.empty).toBe(true);
    expect(none.faceIdAt([0, 0, 0])).toBe(0);
    expect(none.facesOnEdgeMany([[0, 0, 0]], 1)).toEqual([[]]);
  });
});

describe('cells left drawn when faces or bodies are hidden', () => {
  it('reads hidden faces by their full name only', () => {
    const m = hiddenFaceBodies(['face 3@Body1', 'face 3@Body2', 'face 7@Body1', 'face 9', 'face 4@Body0', 'face 05@Body1', 'nonsense']);
    expect(Array.from(m.keys()).sort()).toEqual([3, 7]);
    expect(Array.from(m.get(3)!).sort()).toEqual([1, 2]);
  });

  it('hides a face of its own body, every face of a hidden body, and never a cell without ids', () => {
    const face = Int32Array.from([1, 1, 2, 2, 3, 0, 0, 4]);
    const solid = Int32Array.from([1, 1, 1, 2, 2, 0, 2, 0]);
    const faces = hiddenFaceBodies(['face 2@Body1', 'face 4@Body1']);
    // Face 2 of body 1 goes (not face 2 of body 2); a cell with no body counts as Body1 when the part has bodies.
    expect(Array.from(visibleCellMask(face, solid, 8, true, faces, new Set()))).toEqual([1, 1, 0, 1, 1, 1, 1, 0]);
    // Body 2 hidden: its cells go, the cell with neither id stays.
    expect(Array.from(visibleCellMask(face, solid, 8, true, new Map(), new Set([2])))).toEqual([1, 1, 1, 0, 0, 1, 0, 1]);
    // A part without bodies: the cell with neither id stays even when Body1 is hidden.
    expect(Array.from(visibleCellMask(face, null, 8, false, new Map(), new Set([1])))).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
  });

  it('copies the kept cells with their points renumbered in first-use order', () => {
    const pts = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 2, 2]);
    const polys = [3, 0, 1, 2, 3, 0, 2, 3, 3, 4, 2, 1];
    const out = extractCells(polys, pts, Uint8Array.from([0, 1, 1]));
    expect(Array.from(out.kept)).toEqual([1, 2]);
    expect(Array.from(out.cells)).toEqual([3, 0, 1, 2, 3, 3, 1, 4]);
    expect(Array.from(out.points)).toEqual([0, 0, 0, 1, 1, 0, 0, 1, 0, 2, 2, 2, 1, 0, 0]);
    // Lines need two points; the asked cells come in order.
    const asked: number[] = [];
    const lines = extractCells([2, 0, 1, 1, 4, 3, 2, 3, 4], pts, (c) => (asked.push(c), true), 2);
    expect(asked).toEqual([0, 2]);
    expect(Array.from(lines.kept)).toEqual([0, 2]);
    expect(Array.from(lines.cells)).toEqual([2, 0, 1, 3, 2, 3, 4]);
  });
});

describe('a part the size of the one that froze the page', () => {
  it('maps every edge to its faces and filters 470k triangles in well under a second or two', () => {
    // 4,900 faces, 470k triangles, 9,800 edges. The per-object code took minutes here.
    const { tris, edges } = sheet(70, 7);
    const t0 = performance.now();
    const soup = triSoupFromTris(tris);
    const idx = buildCadFaceIndex(soup, cellFor(tris));
    let pairs = 0;
    for (const e of edges) {
      for (const on of idx.facesOnEdgeMany(samples(e), 0.05 * 0.05)) pairs += on.length;
    }
    const tIndex = performance.now() - t0;
    expect(pairs).toBeGreaterThan(edges.length * 5);
    // Hide 50 faces and copy what is left (the drawn part).
    const t1 = performance.now();
    const conn: number[] = [];
    const pts = new Float32Array(soup.count * 9);
    for (let t = 0; t < soup.count; t++) {
      conn.push(3, t * 3, t * 3 + 1, t * 3 + 2);
      for (let k = 0; k < 9; k++) pts[t * 9 + k] = soup.xyz[t * 9 + k];
    }
    const faces = hiddenFaceBodies(Array.from({ length: 50 }, (_, i) => 'face ' + (i * 97 + 1) + '@Body1'));
    const keep = visibleCellMask(soup.faceIds, null, soup.count, true, faces, new Set());
    const out = extractCells(conn, pts, keep);
    const tFilter = performance.now() - t1;
    expect(out.kept.length).toBe(soup.count - 50 * 98);
    // Generous for slow CI machines; this took about 0.5 s and 0.1 s here.
    expect(tIndex).toBeLessThan(8000);
    expect(tFilter).toBeLessThan(3000);
  }, 60_000);
});
