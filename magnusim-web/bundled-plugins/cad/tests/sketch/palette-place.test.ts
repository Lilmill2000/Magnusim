// Review (relations lane): where the relations palette goes (src/sketch/palette-place.ts). It never
// covers a curve, however long (the old dots along a 4,000 px line left gaps the palette sat in),
// a point (the origin), a box (the construction badge's ×, a glyph, a label), and it stays cheap
// with a big sketch on screen (it runs on every frame a selection moves while zooming).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PLACE_CLEAR, placePalette, type PlaceBox, type PlaceObstacles } from '../../src/sketch/palette-place';

const AREA: PlaceBox = { left: 0, top: 0, right: 1600, bottom: 900 };
const W = 90;
const H = 34;

/** Whether the palette at `at` comes within `gap` px of a segment, a point or a box. */
function covers(at: { left: number; top: number }, obs: PlaceObstacles, gap = PLACE_CLEAR - 1): boolean {
  const r = { left: at.left - gap, top: at.top - gap, right: at.left + W + gap, bottom: at.top + H + gap };
  const inside = (x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  if (obs.points.some(([x, y]) => inside(x, y))) return true;
  if (obs.boxes.some((b) => b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom)) return true;
  return obs.segments.some(([ax, ay, bx, by]) => {
    for (let i = 0; i <= 400; i++) if (inside(ax + ((bx - ax) * i) / 400, ay + ((by - ay) * i) / 400)) return true;
    return false;
  });
}

describe('placePalette', () => {
  it('the wanted spot when it is free', () => {
    expect(placePalette({ left: 500, top: 300 }, W, H, AREA, { boxes: [], segments: [], points: [] })).toEqual({ left: 500, top: 300 });
  });

  it('never across a long line (a rectangle edge 4,000 px long when zoomed in), the origin or a box', () => {
    const obs: PlaceObstacles = {
      // The edge runs through the wanted spot, far past both sides of the view.
      segments: [[-1200, 317, 2800, 317]],
      // The origin just under it, the construction badge's × above it.
      points: [[545, 340]],
      boxes: [{ left: 480, top: 270, right: 620, bottom: 296 }],
    };
    const at = placePalette({ left: 500, top: 300 }, W, H, AREA, obs);
    expect(covers(at, obs)).toBe(false);
    // Near where it was wanted.
    expect(Math.hypot(at.left - 500, at.top - 300)).toBeLessThan(120);
  });

  it('a dense sketch on screen: placed clear of everything in a few milliseconds', () => {
    // 80 curves (long slanted lines and 32-piece circles) across the view, 150 points, 80 labels.
    const segments: [number, number, number, number][] = [];
    for (let i = 0; i < 20; i++) segments.push([-2000 + 300 * i, 0, -2000 + 300 * i + 2400, 900]);
    for (let i = 0; i < 60; i++) {
      const cx = 100 + (i % 12) * 120;
      const cy = 100 + Math.floor(i / 12) * 150;
      for (let k = 0; k < 32; k++) {
        const a0 = (k / 32) * 2 * Math.PI;
        const a1 = ((k + 1) / 32) * 2 * Math.PI;
        segments.push([cx + 40 * Math.cos(a0), cy + 40 * Math.sin(a0), cx + 40 * Math.cos(a1), cy + 40 * Math.sin(a1)]);
      }
    }
    const points: [number, number][] = Array.from({ length: 150 }, (_, i) => [(i * 97) % 1600, (i * 53) % 900]);
    const boxes: PlaceBox[] = Array.from({ length: 80 }, (_, i) => ({ left: (i * 71) % 1550, top: (i * 29) % 880, right: ((i * 71) % 1550) + 20, bottom: ((i * 29) % 880) + 16 }));
    const obs = { segments, points, boxes };
    placePalette({ left: 700, top: 400 }, W, H, AREA, obs); // the candidate list is sorted once
    const t0 = performance.now();
    let at = { left: 0, top: 0 };
    for (let i = 0; i < 20; i++) at = placePalette({ left: 700 + i, top: 400 }, W, H, AREA, obs);
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(8);
    expect(covers(at, obs)).toBe(false);
    // With no free spot in reach (lines closer than the palette is tall), it still answers at once.
    const packed = { segments: Array.from({ length: 200 }, (_, i) => [0, 5 * i, 1600, 5 * i] as [number, number, number, number]), points: [], boxes: [] };
    const t1 = performance.now();
    placePalette({ left: 700, top: 400 }, W, H, AREA, packed);
    expect(performance.now() - t1).toBeLessThan(15);
  });
});
