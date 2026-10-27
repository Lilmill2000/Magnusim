// @vitest-environment node
// Ellipses, partial ellipses, parabolas and rho conics in the real kernel: the sketch feature's
// curves (src/features/sketch/geometry.ts: each one an exact rational quadratic B-spline) bound
// profile regions whose areas, and extruded volumes, match the closed forms (pi a b for an ellipse).
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { curvesOf, entityGeometry } from '../../src/features/sketch/geometry';
import type { SketchEntity, Vec2 } from '../../src/types/doc';
import { call, loadKernel, rel, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };

function curves(points: Record<string, Vec2>, entities: SketchEntity[]): R[] {
  return curvesOf(entityGeometry({ entities }, points, {})) as unknown as R[];
}
const regions = (cs: R[]): R => call(k, 'sketch_regions', { plane: TOP, curves: cs, tess: false });

describe('ellipses and conics as profiles', () => {
  it('a closed ellipse is one region of area pi a b; extruded, a volume of pi a b h', () => {
    const a = 30;
    const b = 12;
    const ang = (30 * Math.PI) / 180;
    const c: Vec2 = [5, 3];
    const ux: Vec2 = [Math.cos(ang), Math.sin(ang)];
    const pts: Record<string, Vec2> = { c, m: [c[0] + a * ux[0], c[1] + a * ux[1]], n: [c[0] - b * ux[1], c[1] + b * ux[0]] };
    const cs = curves(pts, [{ id: 'e1', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' }]);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: 'bspline', degree: 2, pa: 'm', pb: 'm' });
    const r = regions(cs);
    expect(r.regions).toHaveLength(1);
    expect(rel(r.regions[0].area, Math.PI * a * b)).toBeLessThan(1e-9);
    const body = call(k, 'extrude_regions', { plane: TOP, curves: cs, regions: [r.regions[0].key], extent: { kind: 'blind', d: 10 } });
    expect(rel(volume(k, body.id), Math.PI * a * b * 10)).toBeLessThan(1e-7);
    call(k, 'release', { ids: [body.id] });
  });

  it('a half ellipse closed by its major axis is half the area', () => {
    const pts: Record<string, Vec2> = { c: [0, 0], m: [20, 0], n: [0, 8], s: [20, 0], e: [-20, 0] };
    const cs = curves(pts, [
      { id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e' },
      { id: 'l1', kind: 'line', p: ['e', 's'] },
    ]);
    const r = regions(cs);
    expect(r.regions).toHaveLength(1);
    expect(rel(r.regions[0].area, (Math.PI * 20 * 8) / 2)).toBeLessThan(1e-9);
    // Clockwise the other half (ccw: false runs from a to b the other way round).
    const cw = regions(curves(pts, [{ id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e', ccw: false }, { id: 'l1', kind: 'line', p: ['e', 's'] }]));
    expect(rel(cw.regions[0].area, (Math.PI * 20 * 8) / 2)).toBeLessThan(1e-9);
    const body = call(k, 'extrude_regions', { plane: TOP, curves: cs, regions: [r.regions[0].key], extent: { kind: 'blind', d: 4 } });
    expect(rel(volume(k, body.id), Math.PI * 80 * 4)).toBeLessThan(1e-7);
    call(k, 'release', { ids: [body.id] });
  });

  it('a parabola closed by its chord is two thirds of the box round it', () => {
    // y^2 = 20 x (focal length 5) from (5, -10) to (5, 10), closed by x = 5.
    const pts: Record<string, Vec2> = { f: [5, 0], v: [0, 0], a: [5, -10], b: [5, 10] };
    const cs = curves(pts, [
      { id: 'pb', kind: 'parabola', f: 'f', v: 'v', a: 'a', b: 'b' },
      { id: 'l1', kind: 'line', p: ['b', 'a'] },
    ]);
    expect(cs[0].weights).toBeUndefined();
    const r = regions(cs);
    expect(r.regions).toHaveLength(1);
    expect(rel(r.regions[0].area, (2 / 3) * 20 * 5)).toBeLessThan(1e-9);
  });

  it('a conic of rho 0.5 is a parabola piece; rho of a quarter circle bounds a quarter disc', () => {
    const pts: Record<string, Vec2> = { a: [10, 0], b: [0, 10], t: [10, 10], o: [0, 0] };
    const sides: SketchEntity[] = [
      { id: 'l1', kind: 'line', p: ['b', 'o'] },
      { id: 'l2', kind: 'line', p: ['o', 'a'] },
    ];
    // rho 0.5: the region between the curve and the chord is 2/3 of the control triangle (area 50).
    const half = regions(curves(pts, [{ id: 'k1', kind: 'conic', a: 'a', b: 'b', t: 't', rho: 0.5 }, { id: 'ch', kind: 'line', p: ['b', 'a'] }]));
    expect(rel(half.regions[0].area, (2 / 3) * 50)).toBeLessThan(1e-9);
    const w = Math.SQRT1_2;
    const r = regions(curves(pts, [{ id: 'k1', kind: 'conic', a: 'a', b: 'b', t: 't', rho: w / (1 + w) }, ...sides]));
    expect(r.regions).toHaveLength(1);
    expect(rel(r.regions[0].area, (Math.PI * 100) / 4)).toBeLessThan(1e-9);
  });
});
