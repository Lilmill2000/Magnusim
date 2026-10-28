// Where the relations palette goes (review, relations lane): the free spot nearest the wanted one
// (beside the selection) that keeps clear of everything a person may click next in the sketch: its
// curves (the whole visible length of each, however long: a line 4,000 px long when zoomed in is
// clear all along), its points (the origin and the centres too), the relation glyphs, the
// dimension labels, the construction badge and the floating chrome. Pure and cheap, as it runs on
// the frames the selection moves on screen (a zoom with a selection): only what lies within reach
// of the wanted spot is drawn into an occupancy grid of CELL px cells, whose summed-area table
// answers "is this rectangle free?" at once for each candidate, the candidates taken nearest first
// from one list sorted when the module loads.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface PlaceBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What to keep clear of, in client px: rectangles, segments (curves, in pieces) and points. */
export interface PlaceObstacles {
  boxes: readonly PlaceBox[];
  segments: readonly (readonly [number, number, number, number])[];
  points: readonly (readonly [number, number])[];
}

/** Grid cell (px). */
const CELL = 4;
/** How far from the wanted spot the palette may go (px). */
export const PLACE_REACH = 360;
/** How close it may come to a curve, a point or a box (px). */
export const PLACE_CLEAR = 8;
/** A move sideways costs this much more than one up or down (the palette stays over the selection where it can). */
const SIDE = 1.5;

/** Candidate offsets (cells), nearest first: sorted once, on the first placement. */
let offsetList: Int16Array | null = null;
function offsets(): Int16Array {
  if (offsetList) return offsetList;
  const n = Math.ceil(PLACE_REACH / CELL);
  const list: [number, number, number][] = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) list.push([dx, dy, SIDE * Math.abs(dx) + Math.abs(dy)]);
  list.sort((a, b) => a[2] - b[2]);
  const out = new Int16Array(list.length * 2);
  list.forEach(([dx, dy], i) => {
    out[2 * i] = dx;
    out[2 * i + 1] = dy;
  });
  offsetList = out;
  return out;
}

/**
 * The top-left for a w x h palette: `want` where it is free, else the nearest free spot within
 * PLACE_REACH inside `area`; with none free, `want` kept inside `area`.
 */
export function placePalette(want: { left: number; top: number }, w: number, h: number, area: PlaceBox, obs: PlaceObstacles): { left: number; top: number } {
  const clamp = (l: number, t: number) => ({
    left: Math.max(area.left, Math.min(l, area.right - w)),
    top: Math.max(area.top, Math.min(t, area.bottom - h)),
  });
  const start = clamp(want.left, want.top);
  // The grid: everything a candidate (with its clearance) can touch.
  const x0 = Math.max(area.left, start.left - PLACE_REACH - PLACE_CLEAR);
  const y0 = Math.max(area.top, start.top - PLACE_REACH - PLACE_CLEAR);
  const x1 = Math.min(area.right, start.left + w + PLACE_REACH + PLACE_CLEAR);
  const y1 = Math.min(area.bottom, start.top + h + PLACE_REACH + PLACE_CLEAR);
  if (x1 - x0 < w || y1 - y0 < h) return start;
  const cols = Math.ceil((x1 - x0) / CELL) + 1;
  const rows = Math.ceil((y1 - y0) / CELL) + 1;
  const grid = new Uint8Array(cols * rows);
  const mark = (x: number, y: number) => {
    const c = Math.floor((x - x0) / CELL);
    const r = Math.floor((y - y0) / CELL);
    if (c >= 0 && r >= 0 && c < cols && r < rows) grid[r * cols + c] = 1;
  };
  for (const b of obs.boxes) {
    const c0 = Math.max(0, Math.floor((b.left - x0) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((b.right - x0) / CELL));
    const r0 = Math.max(0, Math.floor((b.top - y0) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((b.bottom - y0) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * cols + c] = 1;
  }
  for (const [x, y] of obs.points) mark(x, y);
  for (const s of obs.segments) {
    const clip = clipSegment(s, x0, y0, x1, y1);
    if (!clip) continue;
    const [ax, ay, bx, by] = clip;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 2)));
    for (let i = 0; i <= steps; i++) mark(ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps);
  }
  // Summed-area table: sat[(r + 1) * (cols + 1) + c + 1] = cells marked in [0..r] x [0..c].
  const sw = cols + 1;
  const sat = new Uint32Array(sw * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += grid[r * cols + c];
      sat[(r + 1) * sw + c + 1] = sat[r * sw + c + 1] + run;
    }
  }
  const taken = (l: number, t: number): boolean => {
    const c0 = Math.max(0, Math.floor((l - PLACE_CLEAR - x0) / CELL));
    const r0 = Math.max(0, Math.floor((t - PLACE_CLEAR - y0) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((l + w + PLACE_CLEAR - x0) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((t + h + PLACE_CLEAR - y0) / CELL));
    if (c1 < c0 || r1 < r0) return false;
    return sat[(r1 + 1) * sw + c1 + 1] - sat[r0 * sw + c1 + 1] - sat[(r1 + 1) * sw + c0] + sat[r0 * sw + c0] > 0;
  };
  const off = offsets();
  for (let i = 0; i < off.length; i += 2) {
    const l = start.left + off[i] * CELL;
    const t = start.top + off[i + 1] * CELL;
    if (l < area.left || t < area.top || l + w > area.right || t + h > area.bottom) continue;
    if (!taken(l, t)) return { left: l, top: t };
  }
  return start;
}

/** A segment clipped to a rectangle (Liang-Barsky), or null when it lies outside. */
function clipSegment(s: readonly [number, number, number, number], x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  const [ax, ay, bx, by] = s;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}
