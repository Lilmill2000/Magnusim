// @vitest-environment node
// Extrude: direction sign and flip (the Vortex recipe extrudes -508 mm and -50.8 mm),
// tapered extrudes both ways, and the kernel-only extents through_all and to_face
// (not offered in the UI yet).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, circle, loadKernel, rect, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

const bbox = (id: number): number[] => call(k, 'props', { id, bbox: 'exact' }).bbox;
const close = (a: number[], b: number[], tol = 1e-7) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
/** z of a planar face's centroid (history caps). */
const faceZ = (id: number, fi: number) => call(k, 'topo', { id, faces: [fi], edges: 'none', vertices: 'none' }).faces[0].centroid[2];

describe('direction', () => {
  const sq = rect(0, 0, 10, 10);
  it('blind d > 0 goes along the plane normal; flip or d < 0 goes the other way', () => {
    const up = call(k, 'extrude', { profile: sq, extent: { kind: 'blind', d: 10 } });
    const flipped = call(k, 'extrude', { profile: sq, extent: { kind: 'blind', d: 10 }, flip: true });
    const neg = call(k, 'extrude', { profile: sq, extent: { kind: 'blind', d: -10 } });
    const both = call(k, 'extrude', { profile: sq, extent: { kind: 'blind', d: -10 }, flip: true });
    for (const r of [up, flipped, neg, both]) {
      expect(r.valid).toBe(true);
      expect(rel(volume(k, r.id), 1000)).toBeLessThan(1e-12);
    }
    expect(close(bbox(up.id), [0, 0, 0, 10, 10, 10])).toBe(true);
    expect(close(bbox(flipped.id), [0, 0, -10, 10, 10, 0])).toBe(true);
    expect(close(bbox(neg.id), [0, 0, -10, 10, 10, 0])).toBe(true);
    expect(close(bbox(both.id), [0, 0, 0, 10, 10, 10])).toBe(true);
    // The start cap is always the profile's plane; the end cap is the far one.
    expect(faceZ(flipped.id, flipped.history.start)).toBeCloseTo(0, 9);
    expect(faceZ(flipped.id, flipped.history.end)).toBeCloseTo(-10, 9);
    expect(flipped).toMatchObject({ from: 0, to: 10, direction: [0, 0, -1] });
    expect(Object.keys(flipped.history.sides).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('two distances and symmetric follow the flip too', () => {
    const two = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'two', d1: 3, d2: 7 } });
    const twoF = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'two', d1: 3, d2: 7 }, flip: true });
    expect(close(bbox(two.id), [0, 0, -7, 10, 10, 3])).toBe(true);
    expect(close(bbox(twoF.id), [0, 0, -3, 10, 10, 7])).toBe(true);
    const sym = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'symmetric', d: 8 } });
    const symF = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'symmetric', d: 8 }, flip: true });
    expect(close(bbox(sym.id), [0, 0, -4, 10, 10, 4])).toBe(true);
    expect(close(bbox(symF.id), [0, 0, -4, 10, 10, 4])).toBe(true);
    expect(faceZ(sym.id, sym.history.start)).toBeCloseTo(-4, 9);
    expect(faceZ(symF.id, symF.history.start)).toBeCloseTo(4, 9);
  });

  it('a tapered extrude keeps its taper sense when flipped (frustum volume, mirrored box)', () => {
    const a = (10 * Math.PI) / 180;
    const d = 10;
    const top = 10 - 2 * d * Math.tan(a); // positive taper narrows away from the profile
    const frustum = (d / 3) * (100 + top * top + 10 * top);
    const up = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'blind', d }, taper_deg: 10 });
    const down = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'blind', d }, taper_deg: 10, flip: true });
    const neg = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'blind', d: -d }, taper_deg: 10 });
    for (const r of [up, down, neg]) {
      expect(r.valid).toBe(true);
      expect(rel(volume(k, r.id), frustum)).toBeLessThan(1e-6);
      expect(Object.keys(r.history.sides).sort()).toEqual(['s1', 's2', 's3', 's4']);
    }
    expect(close(bbox(up.id), [0, 0, 0, 10, 10, 10], 1e-6)).toBe(true);
    expect(close(bbox(down.id), [0, 0, -10, 10, 10, 0], 1e-6)).toBe(true);
    expect(close(bbox(neg.id), [0, 0, -10, 10, 10, 0], 1e-6)).toBe(true);
    // The far cap is the small one.
    const area = (id: number, fi: number) => call(k, 'topo', { id, faces: [fi], edges: 'none', vertices: 'none' }).faces[0].area;
    expect(area(down.id, down.history.end)).toBeCloseTo(top * top, 6);
    expect(area(down.id, down.history.start)).toBeCloseTo(100, 6);
  });
});

describe('through_all (kernel only)', () => {
  it('cuts a hole through everything in the targets, from a sketch above them', () => {
    const plate = call(k, 'box', { origin: [0, 0, 0], dx: 100, dy: 100, dz: 10 }).id;
    const above = { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const tool = call(k, 'extrude', { profile: circle(50, 50, 5, above), extent: { kind: 'through_all', targets: [plate] }, flip: true });
    expect(tool.valid).toBe(true);
    expect(tool.from).toBe(0);
    expect(tool.to).toBeGreaterThan(20); // past the plate's far side (z = 0), with a margin
    const cut = call(k, 'boolean', { op: 'cut', targets: [plate], tools: [tool.id] });
    expect(cut.valid).toBe(true);
    expect(rel(volume(k, cut.id), 100000 - Math.PI * 25 * 10)).toBeLessThan(1e-9);
    // Pointing away from the plate there is nothing to go through.
    expect(tryCall(k, 'extrude', { profile: circle(50, 50, 5, above), extent: { kind: 'through_all', targets: [plate] } })).toMatchObject({
      ok: false,
      kind: 'input',
    });
    // both: through everything on either side of the sketch plane.
    const mid = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const both = call(k, 'extrude', { profile: circle(50, 50, 5, mid), extent: { kind: 'through_all', targets: [plate], both: true } });
    const b = bbox(both.id);
    expect(b[2]).toBeLessThan(0);
    expect(b[5]).toBeGreaterThan(10);
  });
});

describe('to_face (kernel only)', () => {
  it('stops on a parallel face', () => {
    const block = call(k, 'box', { origin: [-20, -20, 25], dx: 40, dy: 40, dz: 5 }).id;
    const bottom = call(k, 'topo', { id: block, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.normal && f.normal[2] < -0.5).i;
    const r = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'to_face', target: block, face: bottom } });
    expect(r.valid).toBe(true);
    expect(close(bbox(r.id), [0, 0, 0, 10, 10, 25])).toBe(true);
    const off = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'to_face', target: block, face: bottom, offset: 2 } });
    expect(close(bbox(off.id), [0, 0, 0, 10, 10, 27])).toBe(true);
  });

  it('ends exactly on a tilted plane (volume = area x height at the centroid), end cap on that plane', () => {
    // A block whose top was cut by the plane z = 50 + 0.5 y.
    const tall = call(k, 'box', { origin: [-50, -50, 0], dx: 100, dy: 100, dz: 100 }).id;
    const n = [0, -0.5, 1];
    const split = call(k, 'split', { id: tall, plane: { origin: [0, 0, 50], normal: n } });
    const upper = split.ids[1];
    const tilted = call(k, 'topo', { id: upper, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'plane' && Math.abs(f.normal[1]) > 0.1 && Math.abs(f.normal[2]) > 0.1).i;
    const r = call(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'to_face', target: upper, face: tilted } });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), 100 * (50 + 0.5 * 5))).toBeLessThan(1e-9);
    const end = call(k, 'topo', { id: r.id, faces: [r.history.end], edges: 'none', vertices: 'none' }).faces[0];
    const len = Math.hypot(n[0], n[1], n[2]);
    expect(Math.abs(end.normal[1] * len)).toBeCloseTo(0.5, 9);
    expect(end.centroid[2]).toBeCloseTo(50 + 0.5 * end.centroid[1], 9);
    expect(faceZ(r.id, r.history.start)).toBeCloseTo(0, 9);
    expect(Object.keys(r.history.sides).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('refuses faces it cannot reach', () => {
    const block = call(k, 'box', { origin: [-20, -20, 25], dx: 40, dy: 40, dz: 5 }).id;
    const faces = call(k, 'topo', { id: block, edges: 'none', vertices: 'none' }).faces as R[];
    const side = faces.find((f) => f.normal && Math.abs(f.normal[0]) > 0.5)!.i;
    const bottom = faces.find((f) => f.normal && f.normal[2] < -0.5)!.i;
    expect(tryCall(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'to_face', target: block, face: side } })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'extrude', { profile: rect(0, 0, 10, 10), extent: { kind: 'to_face', target: block, face: bottom }, flip: true })).toMatchObject({
      ok: false,
      kind: 'input',
    });
    const cyl = call(k, 'cylinder', { r: 5, h: 5, origin: [0, 0, 30] }).id;
    const round = call(k, 'topo', { id: cyl, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'cylinder').i;
    expect(tryCall(k, 'extrude', { profile: rect(0, 0, 1, 1), extent: { kind: 'to_face', target: cyl, face: round } })).toMatchObject({ ok: false, kind: 'input' });
  });
});
