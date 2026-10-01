// Origin planes (auto: drawn on an empty part and while selected or hovered;
// sized to the bodies; picks only what is drawn) and the section plane (which
// side is kept, flip, the coordinate the chrome shows).
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { EMPTY_PLANE_HALF, OriginPlanes } from '../../src/viewport/origin';
import { sectionPlane } from '../../src/viewport/section';
import { sectionAxis } from '../../src/viewport/ViewportChrome';

describe('OriginPlanes', () => {
  it('draws all planes, or only the selected / hovered ones, and picks only what is drawn', () => {
    const host = document.createElement('div');
    const o = new OriginPlanes(host);
    expect(host.querySelectorAll('.cad-vp-label')).toHaveLength(3);
    expect(o.picks().map((p) => p.ref)).toEqual(['origin:top', 'origin:front', 'origin:right']);
    expect(o.setShown(false)).toBe(true);
    expect(o.picks()).toEqual([]);
    o.setState({ 'origin:front': 'pick', 'origin:right': 'hover' });
    o.setShown(false);
    expect(o.picks().map((p) => p.ref)).toEqual(['origin:front', 'origin:right']);
    expect(host.querySelector('[data-plane-label="origin:front"]')!.getAttribute('data-state')).toBe('pick');
    o.setState({});
    o.setShown(false);
    expect(o.picks()).toEqual([]);
    o.setShown(true);
    expect(o.picks()).toHaveLength(3);
    o.dispose();
    expect(host.querySelector('.cad-vp-labels')).toBeNull();
  });

  it('sizes each plane to the footprint of the bodies on it and the origin, 15 % wider (review round 2)', () => {
    const o = new OriginPlanes(document.createElement('div'));
    expect(o.halfSize).toBe(EMPTY_PLANE_HALF);
    expect(o.box().min.toArray()).toEqual([-EMPTY_PLANE_HALF, -EMPTY_PLANE_HALF, -EMPTY_PLANE_HALF]);
    o.fitTo(new Box3(new Vector3(0, 0, 0), new Vector3(10, 20, 300)));
    o.setShown(true);
    const [top, front, right] = o.picks();
    // Top (XY): 10 x 20 from the origin -> a 23 mm square centred at (5, 10).
    expect(top.ref).toBe('origin:top');
    expect(top.half).toBeCloseTo(11.5, 9);
    expect(top.origin.toArray()).toEqual([5, 10, 0]);
    // Front (XZ) and Right (YZ): 300 tall.
    expect(front.half).toBeCloseTo(172.5, 9);
    expect(front.origin.x).toBeCloseTo(5, 9);
    expect(front.origin.z).toBeCloseTo(150, 9);
    expect(right.half).toBeCloseTo(172.5, 9);
    expect(o.halfSize).toBeCloseTo(172.5, 9);
    // A part away from the origin: the square still takes the origin in.
    o.fitTo(new Box3(new Vector3(100, 100, 0), new Vector3(120, 120, 20)));
    const t2 = o.picks()[0];
    expect(t2.half).toBeCloseTo(69, 9);
    expect(t2.origin.toArray()).toEqual([60, 60, 0]);
    // No body shown any more (rolled to the start, suppressed): they keep that size,
    // so they do not fill a view fitted to the part (review round 2).
    o.fitTo(null);
    expect(o.picks()[0].half).toBeCloseTo(69, 9);
    // A part that never showed a body gets the default size around the origin.
    const fresh = new OriginPlanes(document.createElement('div'));
    fresh.fitTo(null);
    expect(fresh.halfSize).toBe(EMPTY_PLANE_HALF);
  });
});

describe('section plane', () => {
  it('keeps the side behind the plane (away from its normal), Flip keeps the other', () => {
    // Front plane: normal -Y. Offset -10 along it is y = 10; kept: y >= 10.
    const p = sectionPlane({ on: true, plane: 'origin:front', offset: -10, flip: false });
    expect(p.distanceToPoint(new Vector3(0, 15, 0))).toBeGreaterThan(0);
    expect(p.distanceToPoint(new Vector3(0, 5, 0))).toBeLessThan(0);
    expect(p.distanceToPoint(new Vector3(3, 10, 7))).toBeCloseTo(0, 12);
    const f = sectionPlane({ on: true, plane: 'origin:front', offset: -10, flip: true });
    expect(f.distanceToPoint(new Vector3(0, 5, 0))).toBeGreaterThan(0);
    expect(f.distanceToPoint(new Vector3(0, 15, 0))).toBeLessThan(0);
    // Top plane: normal +Z, offset 4 is z = 4; kept: z <= 4.
    const t = sectionPlane({ on: true, plane: 'origin:top', offset: 4, flip: false });
    expect(t.distanceToPoint(new Vector3(0, 0, 1))).toBeGreaterThan(0);
    expect(t.distanceToPoint(new Vector3(0, 0, 9))).toBeLessThan(0);
  });

  it('shows the cut as the coordinate it fixes', () => {
    expect(sectionAxis('origin:front')).toEqual({ label: 'Y', sign: -1 });
    expect(sectionAxis('origin:top')).toEqual({ label: 'Z', sign: 1 });
    expect(sectionAxis('origin:right')).toEqual({ label: 'X', sign: 1 });
  });
});
