// @vitest-environment node
// The camera model against the core's vtk.js manipulators: a full-width drag
// turns 360 deg about the pivot, pan keeps the pivot-depth point under the
// pointer, zoom keeps the anchor fixed on screen (both projections), fit uses
// r / sin(15 deg), projection switches keep the size, standard views look the
// right way, and transitions start and end on the given poses.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, VIEW_DIRS } from '../../src/viewport/camera';

const W = 800;
const H = 600;
function screen(rig: CameraRig, p: Vector3): [number, number] {
  const cam = rig.apply(W / H);
  const v = p.clone().project(cam);
  return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
}
function rigAt(view: keyof typeof VIEW_DIRS = 'home'): CameraRig {
  const r = new CameraRig();
  r.orient(VIEW_DIRS[view].dir, VIEW_DIRS[view].up);
  r.frame(new Sphere(new Vector3(5, 10, 15), 20));
  r.scene.set(new Vector3(5, 10, 15), 20);
  r.pivot.set(5, 10, 15);
  return r;
}
const close = (a: Vector3, b: Vector3, tol = 1e-6) => a.distanceTo(b) <= tol;

describe('CameraRig', () => {
  it('frames a sphere at r / sin(fov / 2) along the view direction (vtk resetCamera)', () => {
    const r = rigAt('front');
    expect(r.target.toArray()).toEqual([5, 10, 15]);
    expect(r.distance).toBeCloseTo(20 / Math.sin((15 * Math.PI) / 180), 9);
    expect(r.dop().toArray().map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0]);
    expect(r.up.toArray().map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    expect(r.orthoHeight).toBe(40);
  });

  it('standard views: front looks along +Y, top looks down with +Y up, bottom has the front at the top', () => {
    const top = rigAt('top');
    expect(close(top.dop(), new Vector3(0, 0, -1))).toBe(true);
    expect(close(top.up, new Vector3(0, 1, 0))).toBe(true);
    const bottom = rigAt('bottom');
    expect(close(bottom.dop(), new Vector3(0, 0, 1))).toBe(true);
    expect(close(bottom.up, new Vector3(0, -1, 0))).toBe(true);
    const right = rigAt('right');
    expect(close(right.dop(), new Vector3(-1, 0, 0))).toBe(true);
    const iso = rigAt('iso');
    expect(close(iso.dop(), new Vector3(-1, 1, -1).normalize())).toBe(true);
  });

  it('orbit: a drag across the whole width turns 360 deg about the pivot and comes back', () => {
    const r = rigAt('home');
    r.pivot.set(0, 0, 0);
    const p0 = r.position.clone();
    const d0 = p0.distanceTo(r.pivot);
    for (let i = 0; i < 80; i++) r.orbit(W / 80, 0, W, H);
    expect(r.position.distanceTo(r.pivot)).toBeCloseTo(d0, 6);
    expect(close(r.position, p0, 1e-6 * d0)).toBe(true);
    // A quarter width is 90 deg about the view-up; dragging right moves the camera left (the model follows the mouse).
    const s = rigAt('front');
    s.pivot.copy(s.target);
    s.orbit(W / 4, 0, W, H);
    expect(close(s.dop(), new Vector3(1, 0, 0), 1e-9)).toBe(true);
    // Dragging down a quarter height tips the camera over the top: it looks down.
    const t = rigAt('front');
    t.pivot.copy(t.target);
    t.orbit(0, H / 4, W, H);
    expect(close(t.dop(), new Vector3(0, 0, -1), 1e-9)).toBe(true);
  });

  it('pan keeps the point at the pivot depth under the pointer (perspective and orthographic)', () => {
    for (const proj of ['perspective', 'orthographic'] as const) {
      const r = rigAt('home');
      r.setProjection(proj);
      const before = screen(r, r.pivot);
      r.pan(40, -25, H);
      const after = screen(r, r.pivot);
      expect(after[0] - before[0]).toBeCloseTo(40, 6);
      expect(after[1] - before[1]).toBeCloseTo(-25, 6);
    }
  });

  it('zoom to cursor keeps the anchor on screen and gets closer (perspective and orthographic)', () => {
    for (const proj of ['perspective', 'orthographic'] as const) {
      const r = rigAt('home');
      r.setProjection(proj);
      const anchor = new Vector3(12, 3, 22);
      const s0 = screen(r, anchor);
      const h0 = r.viewHeightAtTarget();
      r.zoomAt(1.1, anchor);
      const s1 = screen(r, anchor);
      expect(s1[0]).toBeCloseTo(s0[0], 6);
      expect(s1[1]).toBeCloseTo(s0[1], 6);
      expect(r.viewHeightAtTarget()).toBeCloseTo(h0 / 1.1, 6);
    }
  });

  it('switching projection keeps the size at the target', () => {
    const r = rigAt('home');
    const h = r.viewHeightAtTarget();
    r.setProjection('orthographic');
    expect(r.orthoHeight).toBeCloseTo(h, 9);
    r.orthoHeight = h / 2;
    r.setProjection('perspective');
    expect(r.viewHeightAtTarget()).toBeCloseTo(h / 2, 9);
  });

  it('near and far enclose the scene sphere', () => {
    const r = rigAt('home');
    const cam = r.apply(W / H) as { near: number; far: number };
    const d = r.distance;
    expect(cam.near).toBeLessThanOrEqual(d - 20);
    expect(cam.far).toBeGreaterThanOrEqual(d + 20);
    expect(cam.near).toBeGreaterThan(0);
  });

  it('blend starts and ends on the given poses and slerps the direction', () => {
    const a = rigAt('front').pose();
    const b = rigAt('right').pose();
    const p0 = CameraRig.blend(a, b, 0);
    const p1 = CameraRig.blend(a, b, 1);
    expect(close(p0.position, a.position, 1e-6)).toBe(true);
    expect(close(p1.position, b.position, 1e-6)).toBe(true);
    const mid = CameraRig.blend(a, b, 0.5);
    const dir = mid.position.clone().sub(mid.target).normalize();
    expect(close(dir, new Vector3(1, -1, 0).normalize(), 1e-6)).toBe(true);
    expect(mid.position.distanceTo(mid.target)).toBeCloseTo(a.position.distanceTo(a.target), 6);
  });
});
