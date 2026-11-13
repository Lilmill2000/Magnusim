// The grid keeps the tunnel's shape: square cells, a side held at a limit sets the other.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { RESOLUTION_CELLS, gridFor, gridHeight } from '../src/sim/grid';
import { defaultScene } from '../src/scene/scene';

const tunnel = (length: number, height: number) => {
  const s = defaultScene();
  return { ...s, tunnel: { ...s.tunnel, length, height } };
};

/** The grid as it was before limits set the other side (still the rule when nothing is held). */
function unclamped(length: number, height: number, cells: number) {
  const nx = Math.round(Math.sqrt((cells * length) / height));
  return { nx, ny: Math.round(cells / nx) };
}

describe('the grid', () => {
  it('is what it always was where no side reaches a limit (the default tunnel, the presets)', () => {
    for (const [l, h] of [
      [8, 4],
      [45, 30],
      [10, 1],
      [2, 3],
    ]) {
      for (const cells of Object.values(RESOLUTION_CELLS)) {
        const g = gridFor(tunnel(l, h), cells);
        const u = unclamped(l, h, cells);
        if (u.nx <= 8192 && u.nx >= 32 && u.ny <= 8192 && u.ny >= 16) expect(g).toEqual(u);
      }
    }
  });

  it('a long, low tunnel at Ultra keeps its height when the length reaches the limit (16 m by 0.25 m)', () => {
    const s = tunnel(16, 0.25);
    const g = gridFor(s, RESOLUTION_CELLS.ultra);
    expect(g.nx).toBe(8192);
    // Square cells: the height to within half a cell (it was 181 cells, a 0.354 m tunnel).
    expect(Math.abs(gridHeight(s, g) - 0.25)).toBeLessThan((0.5 * 16) / 8192);
    expect(g.ny).toBe(128);
  });

  it('a tall, narrow tunnel keeps its length the same way', () => {
    const s = tunnel(0.25, 16);
    const g = gridFor(s, RESOLUTION_CELLS.ultra);
    expect(g.ny).toBe(8192);
    expect(Math.abs((g.nx * 16) / g.ny - 0.25)).toBeLessThan((0.5 * 16) / 8192);
  });

  it('only a tunnel more than 512 times as long as tall cannot keep its height (the panel says so)', () => {
    const s = tunnel(1000, 0.5);
    const g = gridFor(s, RESOLUTION_CELLS.medium);
    expect(g).toEqual({ nx: 8192, ny: 16 });
    expect(gridHeight(s, g)).toBeGreaterThan(0.5 * 1.02);
  });
});
