// @vitest-environment node
// Geometry from tessellation buffers: the geometry shares the kernel's arrays,
// triangle -> face mapping (incl. faces without triangles and unsorted
// ranges), each face's vertex span, edge spheres, planar normals, centroid,
// and highlight updates touching only one face's vertices.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { TessPayload } from '../../src/types/kernel';
import { buildBodyData, edgeSegments, faceOfTriangle, HL_PICK, meshCentroid, planarFaceNormal, setFaceHl } from '../../src/viewport/tess';

/** A unit square in z=0 (face 0, normal +z) and one in x=0 (face 1, normal -x); face 2 has no triangles. */
function twoQuads(): TessPayload {
  const positions = new Float32Array([
    // face 0: z = 0
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    // face 1: x = 0, curved normals on purpose for vertex 7
    0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
  ]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const faceRanges = new Uint32Array([0, 6, 6, 6, 12, 0]);
  const edgePositions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
  const edgeRanges = new Uint32Array([0, 4, 4, 0]);
  return { positions, normals, indices, faceRanges, edgePositions, edgeRanges };
}

describe('buildBodyData', () => {
  it('shares the kernel arrays and derives the lookups', () => {
    const t = twoQuads();
    const d = buildBodyData(t);
    expect(d.geometry.getAttribute('position').array).toBe(t.positions);
    expect(d.geometry.getAttribute('normal').array).toBe(t.normals);
    expect(d.geometry.getIndex()!.array).toBe(t.indices);
    expect(d.faces).toBe(3);
    expect(d.triangles).toBe(4);
    expect(d.sortedFaces).toBe(true);
    expect([...d.faceVerts]).toEqual([0, 4, 4, 4, 0, 0]);
    expect(d.edges).toBe(2);
    // Edge 0 polyline (0,0,0)-(1,0,0)-(1,1,0): box centre (.5,.5,0), farthest point at sqrt(.5).
    expect([...d.edgeSpheres.slice(0, 3)]).toEqual([0.5, 0.5, 0]);
    expect(d.edgeSpheres[3]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(d.edgeSpheres[7]).toBe(-1);
    expect(d.bounds.min.toArray()).toEqual([0, 0, 0]);
    expect(d.bounds.max.toArray()).toEqual([1, 1, 1]);
    expect([...edgeSegments(d, 0)]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(edgeSegments(d, 1).length).toBe(0);
  });

  it('maps every triangle to its B-rep face', () => {
    const d = buildBodyData(twoQuads());
    expect([0, 1, 2, 3].map((t) => faceOfTriangle(d, t))).toEqual([0, 0, 1, 1]);
    expect(faceOfTriangle(d, 4)).toBe(-1);
    expect(faceOfTriangle(d, -1)).toBe(-1);
  });

  it('skips faces without triangles in the middle of the ranges', () => {
    const t = twoQuads();
    // face 0 (2 tris), face 1 empty, face 2 (2 tris)
    t.faceRanges = new Uint32Array([0, 6, 6, 0, 6, 6]);
    const d = buildBodyData(t);
    expect([0, 1, 2, 3].map((x) => faceOfTriangle(d, x))).toEqual([0, 0, 2, 2]);
  });

  it('falls back to a triangle table when face ranges are out of order', () => {
    const t = twoQuads();
    t.faceRanges = new Uint32Array([6, 6, 0, 6]);
    const d = buildBodyData(t);
    expect(d.sortedFaces).toBe(false);
    expect([0, 1, 2, 3].map((x) => faceOfTriangle(d, x))).toEqual([1, 1, 0, 0]);
  });

  it('refuses buffers that do not fit together', () => {
    const t = twoQuads();
    t.faceRanges = new Uint32Array([0, 5]);
    expect(() => buildBodyData(t)).toThrow(/whole triangles/);
    const u = twoQuads();
    u.normals = new Float32Array(3);
    expect(() => buildBodyData(u)).toThrow(/normals/);
  });

  it('finds planar faces and their normals', () => {
    const t = twoQuads();
    const d = buildBodyData(t);
    expect(planarFaceNormal(d, 0)).toEqual([0, 0, 1]);
    expect(planarFaceNormal(d, 1)).toEqual([-1, 0, 0]);
    expect(planarFaceNormal(d, 2)).toBeNull();
    t.normals[3 * 7] = 0;
    t.normals[3 * 7 + 1] = 1;
    expect(planarFaceNormal(buildBodyData(t), 1)).toBeNull();
  });

  it('changes the highlight of one face only', () => {
    const d = buildBodyData(twoQuads());
    expect(setFaceHl(d, 1, HL_PICK)).toBe(true);
    expect([...(d.hl.array as Uint8Array)]).toEqual([0, 0, 0, 0, 2, 2, 2, 2]);
    expect(d.hl.updateRanges).toEqual([{ start: 4, count: 4 }]);
    expect(setFaceHl(d, 1, HL_PICK)).toBe(false);
    expect(setFaceHl(d, 2, HL_PICK)).toBe(false);
  });
});

describe('meshCentroid', () => {
  it('is the volume centroid of a closed box and the surface centroid of an open sheet', () => {
    // A 2 x 4 x 6 box from (1, 1, 1), outward triangles.
    const [x0, y0, z0, x1, y1, z1] = [1, 1, 1, 3, 5, 7];
    const p = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
    const q = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
    const ix = new Uint32Array([...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)]);
    const c = meshCentroid([{ positions: p, indices: ix }])!;
    expect(c[0]).toBeCloseTo(2, 5);
    expect(c[1]).toBeCloseTo(3, 5);
    expect(c[2]).toBeCloseTo(4, 5);
    const sheet = meshCentroid([{ positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }])!;
    expect(sheet.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 1, 0]);
    expect(meshCentroid([])).toBeNull();
  });
});
