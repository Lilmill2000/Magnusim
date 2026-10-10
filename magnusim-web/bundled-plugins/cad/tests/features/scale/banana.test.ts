// ux010 (TOOLBAR builder): Banana for scale. The placement maths (beside the bodies, on their
// ground, a gap of 10 % of their size and at least 20 mm, at the origin with none; the drag on the
// screen-parallel plane through the grabbed point; the leash; the magnet slots), the view field (optional: an older Part's view reads as before; malformed entries
// dropped), and the built mesh (workspace/models/banana.bin: there, within budget, about the size
// of a real banana, its colours yellow with dark ends).
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyView, readView } from '../../../src/doc/schema';
import { decodeBanana } from '../../../src/features/scale/banana-mesh';
import { gapFor, halfFootprint, leashOf, nearestSlot, onLeash, onLeash3, placeBeside, placedBox, rayOnPlane, slotsAround, unionBox } from '../../../src/features/scale/placement';
import { imagePixel, leashAround, placeTaped, TAPED_GAP, TAPED_H, TAPED_W } from '../../../src/features/scale/sketch-banana';
import type { BBox } from '../../../src/types/kernel-protocol';

const MESH = { min: [-17, -104, 0] as [number, number, number], max: [17, 104, 82] as [number, number, number] };

describe('placement', () => {
  it('a 100 mm box at the origin: the banana to +X with a 20 mm gap, on its ground, centred in Y, long axis along Y', () => {
    const box: BBox = [0, 0, 0, 100, 100, 100];
    const p = placeBeside([box], MESH);
    expect(p.rot).toBe(0);
    const b = placedBox(p, MESH);
    expect(b[0]).toBeCloseTo(120, 9);
    expect(b[2]).toBeCloseTo(0, 9);
    expect((b[1] + b[4]) / 2).toBeCloseTo(50, 9);
    expect(b[4] - b[1]).toBeCloseTo(208, 9);
  });

  it('the gap is 10 % of the largest size, at least 20 mm; the lowest Z of all the bodies counts', () => {
    expect(gapFor([0, 0, 0, 100, 50, 10])).toBe(20);
    expect(gapFor([0, 0, 0, 1000, 50, 10])).toBe(100);
    const p = placeBeside(
      [
        [-500, -40, 5, 200, 10, 30],
        [0, 0, -12, 500, 20, 4],
      ],
      MESH,
    );
    const b = placedBox(p, MESH);
    expect(b[0]).toBeCloseTo(500 + 100, 9);
    expect(b[2]).toBeCloseTo(-12, 9);
    expect((b[1] + b[4]) / 2).toBeCloseTo(-10, 9);
  });

  it('no body (or no usable box): at the origin', () => {
    expect(placeBeside([], MESH)).toEqual({ at: [0, 0, 0], rot: 0 });
    expect(unionBox([[Number.NaN, 0, 0, 1, 1, 1]])).toBeNull();
  });

  it('turned 90 degrees, its box turns with it', () => {
    const b = placedBox({ at: [0, 0, 0], rot: 90 }, MESH);
    expect(b[0]).toBeCloseTo(-104, 9);
    expect(b[3]).toBeCloseTo(104, 9);
    expect(b[1]).toBeCloseTo(-17, 9);
  });

  it('a drag on the screen-parallel plane through the grabbed point: the ray meets it there', () => {
    // Looking along +Y (a front view): the plane y = 20 through the grabbed point.
    expect(rayOnPlane({ origin: [35, -500, 12], dir: [0, 1, 0] }, [5, 20, 30], [0, 1, 0])).toEqual([35, 20, 12]);
    // A slanted view: the point found lies on the plane.
    const n = [0.6, 0.8, 0] as [number, number, number];
    const q = rayOnPlane({ origin: [-100, -200, 50], dir: [0.6, 0.8, 0] }, [10, 10, 0], n)!;
    expect((q[0] - 10) * n[0] + (q[1] - 10) * n[1] + q[2] * n[2]).toBeCloseTo(0, 9);
    expect(rayOnPlane({ origin: [0, 0, 0], dir: [1, 0, 0] }, [0, 5, 0], [0, 1, 0])).toBeNull();
  });
});

describe('dragging it: a leash, magnet slots (Daniel: "it can be very hard to position it")', () => {
  it('the leash: max(the box diagonal, 300 mm) beyond the box; past it the centre slides along the limit', () => {
    const box: BBox = [0, 0, 0, 40, 30, 20];
    expect(leashOf(box)).toBe(300);
    expect(leashOf([0, 0, 0, 400, 300, 0])).toBe(500);
    expect(leashOf(null)).toBe(300);
    const rect: [number, number, number, number] = [0, 0, 40, 30];
    expect(onLeash([100, 15], rect, 300)).toEqual([100, 15]);
    // Far to +X: back to 300 mm from the right side, same y.
    expect(onLeash([2000, 15], rect, 300)).toEqual([340, 15]);
    // Far off a corner: on the circle of 300 mm round it.
    const c = onLeash([1040, 1030], rect, 300);
    expect(Math.hypot(c[0] - 40, c[1] - 30)).toBeCloseTo(300, 9);
    expect(c[0]).toBeCloseTo(c[1] + 10, 9);
    // No body: round the origin.
    expect(Math.hypot(...onLeash([0, -900], [0, 0, 0, 0], 300))).toBeCloseTo(300, 9);
  });
  it('12 slots: each side of the box, the gap away, centred or aligned with either end; turned, the footprint turns', () => {
    const box: BBox = [0, 0, 0, 40, 30, 20];
    const half = halfFootprint(MESH, 0);
    expect(half).toEqual([17, 104]);
    const slots = slotsAround(box, half);
    expect(slots).toHaveLength(12);
    const by = (n: string) => slots.find((x) => x.name === n)!.at;
    expect(by('+x centre')).toEqual([40 + 20 + 17, 15]);
    expect(by('+x min')).toEqual([77, 104]);
    expect(by('+x max')).toEqual([77, 30 - 104]);
    expect(by('-x centre')).toEqual([-20 - 17, 15]);
    expect(by('+y centre')).toEqual([20, 30 + 20 + 104]);
    expect(by('-y min')).toEqual([17, -124]);
    expect(halfFootprint(MESH, 90)[0]).toBeCloseTo(104, 9);
    expect(nearestSlot(slots, [70, 20])!.name).toBe('+x centre');
  });
  it('the leash in 3D: within max(diagonal, 300 mm) of the box, sliding along the limit (also above it)', () => {
    const box: BBox = [0, 0, 0, 40, 30, 20];
    expect(onLeash3([100, 15, 10], box, 300)).toEqual([100, 15, 10]);
    expect(onLeash3([20, 15, 900], box, 300)).toEqual([20, 15, 320]);
    const c = onLeash3([1040, 1030, 20], box, 300);
    expect(Math.hypot(c[0] - 40, c[1] - 30, c[2] - 20)).toBeCloseTo(300, 9);
  });
  it("the sketch picture's leash: max(the sketch's diagonal, 300 mm) beyond its bounds", () => {
    expect(leashAround([
      [0, 0],
      [40, 30],
    ])).toEqual({ rect: [0, 0, 40, 30], reach: 300 });
    expect(leashAround([]).reach).toBe(300);
  });
});

describe('the view field (CadView.scaleModels)', () => {
  it('optional: a view without it reads as before', () => {
    const v = readView({ rollback: null, hiddenBodies: ['b1'], expanded: ['origin'] }, 1);
    expect(v).toEqual({ ...emptyView(), hiddenBodies: ['b1'] });
    expect('scaleModels' in v).toBe(false);
  });
  it('a stored banana is read back; a bad one is dropped (not shown), never an error', () => {
    expect(readView({ scaleModels: { banana: { at: [10, 20, -3], rot: 450 } } }, 0).scaleModels).toEqual({ banana: { at: [10, 20, -3], rot: 90 } });
    expect(readView({ scaleModels: { banana: { at: [10, 20] } } }, 0).scaleModels).toBeUndefined();
    expect(readView({ scaleModels: { banana: { at: [10, 20, 0], rot: 'x' } } }, 0).scaleModels).toEqual({ banana: { at: [10, 20, 0], rot: 0 } });
    expect(readView({ scaleModels: 'nonsense' }, 0).scaleModels).toBeUndefined();
  });
});

describe('the taped banana in a sketch', () => {
  it('true size; beside the sketch to +u with a gap of max(20 mm, 15 % of its size), centred in v; near the origin in an empty sketch', () => {
    expect(TAPED_W / TAPED_H).toBeCloseTo(684 / 900, 2);
    // A 40 x 30 rectangle from the origin: 15 % of 40 is less than 20, so 20 mm right of u = 40.
    const at = placeTaped([
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ]);
    expect(TAPED_GAP).toBe(20);
    expect(at[0] - TAPED_W / 2).toBeCloseTo(60, 9);
    expect(at[1]).toBeCloseTo(15, 9);
    // A 400 mm sketch: 15 % of it, 60 mm.
    expect(placeTaped([
      [0, 0],
      [400, 100],
    ])[0] - TAPED_W / 2).toBeCloseTo(460, 9);
    expect(placeTaped([])).toEqual([TAPED_GAP + TAPED_W / 2, 0]);
  });
  it('a sketch point on the picture is its pixel (x right, y down); outside it, none', () => {
    const size = { w: 684, h: 900 };
    expect(imagePixel([0, 0], [-TAPED_W / 2 + 0.01, TAPED_H / 2 - 0.01], size)).toEqual([0, 0]);
    expect(imagePixel([0, 0], [TAPED_W / 2 - 0.01, -TAPED_H / 2 + 0.01], size)).toEqual([683, 899]);
    expect(imagePixel([0, 0], [0, 0], size)).toEqual([342, 450]);
    expect(imagePixel([0, 0], [TAPED_W, 0], size)).toBeNull();
  });
  it('the view field is optional, per sketch; malformed entries dropped', () => {
    expect(readView({ scaleModels: { sketch: { f_1: { at: [50, 15] }, f_2: { at: [1] }, f_3: 'x' } } }, 0).scaleModels).toEqual({ sketch: { f_1: { at: [50, 15] } } });
    expect(readView({}, 0).scaleModels).toBeUndefined();
  });
});

describe('the built mesh (workspace/models/banana.bin)', () => {
  // vitest runs from the plugin's folder (the jsdom environment's import.meta.url is not a file URL).
  const file = join(process.cwd(), 'workspace', 'models', 'banana.bin');
  it('is there, within budget, about a real banana, smooth, yellow with dark ends', () => {
    expect(existsSync(file), 'run npm run build').toBe(true);
    const bytes = readFileSync(file);
    // Smooth (the coordinator's review: 16-24k triangles, 300 KB at most).
    expect(bytes.length).toBeLessThan(300 * 1024);
    const m = decodeBanana(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const tris = m.indices.length / 3;
    expect(tris).toBeGreaterThanOrEqual(16000);
    expect(tris).toBeLessThanOrEqual(24000);
    // About 190 mm (the approved shape: 204 mm from the blossom tip to the stem's cut along X).
    expect(m.length).toBeGreaterThan(180);
    expect(m.length).toBeLessThan(215);
    expect(m.max[1] - m.min[1]).toBeCloseTo(m.length, 3);
    // 38 mm across the body, squashed 0.93 and rounded: 32..38 mm; lying on Z = 0, centred.
    expect(m.max[0] - m.min[0]).toBeGreaterThan(32);
    expect(m.max[0] - m.min[0]).toBeLessThan(38);
    expect(m.min[2]).toBeCloseTo(0, 6);
    expect(m.min[0] + m.max[0]).toBeCloseTo(0, 6);
    // Smooth: neighbouring vertices of a triangle have close normals (no creases) except at the
    // stem's flat cut and the blossom tip (the last and first 3 mm).
    let creased = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ids = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const y = ids.map((i) => m.positions[3 * i + 1]);
      if (Math.min(...y) < m.min[1] + 3 || Math.max(...y) > m.max[1] - 3) continue;
      for (const [a, b] of [
        [ids[0], ids[1]],
        [ids[1], ids[2]],
        [ids[2], ids[0]],
      ]) {
        const dot = m.normals[3 * a] * m.normals[3 * b] + m.normals[3 * a + 1] * m.normals[3 * b + 1] + m.normals[3 * a + 2] * m.normals[3 * b + 2];
        if (dot < Math.cos((40 * Math.PI) / 180)) creased++;
      }
    }
    expect(creased, 'triangle edges whose ends turn more than 40 degrees').toBe(0);
    // Every index in range; normals unit length.
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1)).toBeLessThan(0.02);
    // Mostly yellow (#F7D43A), the stem's cut and the blossom nub dark.
    const V = m.positions.length / 3;
    let yellow = 0;
    let atMin: number[] = [];
    let atMax: number[] = [];
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < V; i++) {
      const [r, g, b] = [m.colors[3 * i], m.colors[3 * i + 1], m.colors[3 * i + 2]];
      if (Math.abs(r - 247 / 255) < 0.02 && Math.abs(g - 212 / 255) < 0.02 && Math.abs(b - 58 / 255) < 0.02) yellow++;
      const y = m.positions[3 * i + 1];
      if (y < yMin) (yMin = y), (atMin = [r, g, b]);
      if (y > yMax) (yMax = y), (atMax = [r, g, b]);
    }
    expect(yellow / V).toBeGreaterThan(0.5);
    expect(Math.max(...atMin)).toBeLessThan(0.3);
    expect(Math.max(...atMax)).toBeLessThan(0.45);
  });
});
