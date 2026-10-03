// freeSpot (src/lib/chrome.ts): where a sketch value box or a label goes so that
// nothing floating over the view hides it (review P2/P3 round 3).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { freeSpot, near, type ScreenRect } from '../../src/lib/chrome';

const area: ScreenRect = { left: 6, top: 77, right: 1274, bottom: 750 };
const box = (left: number, top: number, w = 120, h = 30): ScreenRect => ({ left, top, right: left + w, bottom: top + h });

describe('freeSpot', () => {
  it('keeps the wanted spot when it is free', () => {
    expect(freeSpot({ left: 700, top: 300 }, 120, 30, [box(100, 100)], area)).toEqual({ left: 700, top: 300 });
  });

  it('moves a box half under the Sketch panel to the nearest free spot, clear of it by the gap', () => {
    const panel: ScreenRect = { left: 240, top: 83, right: 600, bottom: 341 };
    const s = freeSpot({ left: 578, top: 260 }, 120, 30, [panel], area)!;
    expect(near(box(s.left, s.top), panel, 3.9)).toBe(false);
    // Sideways by 26 px (39 counted) beats down by 85.
    expect(s).toEqual({ left: 604, top: 260 });
  });

  it('never puts the second box back onto the first at the bottom edge', () => {
    const first = box(763, 716);
    const s = freeSpot({ left: 766, top: 716 }, 114, 30, [first], area)!;
    expect(near(box(s.left, s.top, 114), first)).toBe(false);
    expect(s.top + 30).toBeLessThanOrEqual(area.bottom);
    expect(s.top).toBe(716 - 4 - 30);
  });

  it('a box wanted past the edges comes inside the area', () => {
    expect(freeSpot({ left: 1250, top: 760 }, 120, 30, [], area)).toEqual({ left: 1154, top: 720 });
  });

  it('goes around several rectangles (the dock chips and the pointer)', () => {
    const chips = [box(18, 706, 56, 34), box(82, 706, 117, 34)];
    const pointer: ScreenRect = { left: 76, top: 728, right: 100, bottom: 752 };
    const s = freeSpot({ left: 28, top: 711 }, 120, 30, [...chips, pointer], area)!;
    for (const t of [...chips, pointer]) expect(near(box(s.left, s.top), t, 3.9)).toBe(false);
    expect(s.top + 30).toBeLessThanOrEqual(706 - 4);
  });

  it('null when nothing fits', () => {
    expect(freeSpot({ left: 10, top: 10 }, 500, 30, [], { left: 0, top: 0, right: 100, bottom: 100 })).toBeNull();
  });
});
