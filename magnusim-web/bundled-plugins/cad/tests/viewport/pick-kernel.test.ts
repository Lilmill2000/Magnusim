// @vitest-environment node
// Picking on real kernel geometry (the shipped mk32.wasm in Node): a 10x20x30
// box and a cylinder are tessellated by the kernel, turned into viewport
// geometry, and picked through a camera like the viewport's. Face, edge and
// vertex indices must be the kernel's own (checked against `topo`): the
// triangle -> face mapping, the 8 px screen tolerance, hidden edges, the
// selection filter, origin planes and the section cut.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Plane, Ray, Sphere, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernel, type Kernel } from '../../src/kernel-worker/kernel-api';
import type { OriginPlaneRef, Vec3 } from '../../src/types/doc';
import type { TessPayload } from '../../src/types/kernel';
import type { SelectKind } from '../../src/types/selection';
import { buildBvhBuffers, buildBvhSync, bvhFromBuffers } from '../../src/viewport/bvh-build';
import { CameraRig, VIEW_DIRS } from '../../src/viewport/camera';
import { ORIGIN_PLANES } from '../../src/types/doc';
import { kindsForFilter, pickAt, raycastBodies, rayAt, type PickBody, type PickPlane, type PickView } from '../../src/viewport/pick';
import { buildBodyData, faceOfTriangle, planarFaceNormal } from '../../src/viewport/tess';

const MODULE = fileURLToPath(new URL('../../workspace/kernel/mk32.mjs', import.meta.url));
const WASM = fileURLToPath(new URL('../../workspace/kernel/mk32.wasm', import.meta.url));

interface Topo {
  faces: { i: number; type: string; normal?: Vec3; centroid: Vec3 }[];
  edges: { i: number; mid: Vec3 }[];
  vertices: { i: number; p: Vec3 }[];
}

let k: Kernel;
function tessOf(id: number): TessPayload {
  const t = k.call('tessellate', { id });
  const b = k.takeBuffers(t) as Record<string, Float32Array & Uint32Array & Uint8Array>;
  return { positions: b.positions, normals: b.normals, indices: b.indices, faceRanges: b.face_ranges, edgePositions: b.edge_positions, edgeRanges: b.edge_ranges, edgeFlags: b.edge_flags ?? null };
}

function body(id: string, tess: TessPayload, topo: Topo | null): PickBody {
  const data = buildBodyData(tess);
  return { id, data, bvh: buildBvhSync(data.geometry), vertices: topo ? new Float32Array(topo.vertices.flatMap((v) => v.p)) : null };
}

const W = 800;
const H = 600;
function viewFor(rig: CameraRig, clip: Plane | null = null): PickView {
  const camera = rig.apply(W / H);
  return { camera, width: W, height: H, worldPerPixel: (p) => rig.worldPerPixel(p, H), clip, occlude: true, faces: true };
}
function rigLooking(view: keyof typeof VIEW_DIRS, sphere: Sphere): CameraRig {
  const rig = new CameraRig();
  rig.orient(VIEW_DIRS[view].dir, VIEW_DIRS[view].up);
  rig.frame(sphere);
  rig.scene.copy(sphere);
  return rig;
}
function screenOf(view: PickView, p: Vec3): [number, number] {
  const v = new Vector3(...p).project(view.camera);
  return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
}
function planes(half: number): PickPlane[] {
  return (['origin:top', 'origin:front', 'origin:right'] as OriginPlaneRef[]).map((ref) => {
    const d = ORIGIN_PLANES[ref];
    const normal = new Vector3(...d.normal);
    const u = new Vector3(...d.xdir);
    return { ref, origin: new Vector3(), normal, u, v: new Vector3().crossVectors(normal, u), half };
  });
}
const ALL = kindsForFilter([]);
const near = (a: Vec3, b: Vec3, tol = 1e-4) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

describe('picking on kernel geometry', () => {
  let boxTopo: Topo;
  let box: PickBody;
  let sphere: Sphere;

  beforeAll(async () => {
    k = await createKernel({ moduleUrl: pathToFileURL(MODULE).href, wasmBinary: readFileSync(WASM) });
    const id = k.call('box', { dx: 10, dy: 20, dz: 30 }).id as number;
    boxTopo = k.call('topo', { id }) as unknown as Topo;
    box = body('b_box', tessOf(id), boxTopo);
    sphere = box.data.sphere.clone();
  });

  it('maps the kernel triangles of each face to that face, with the kernel face normals', () => {
    const d = box.data;
    expect(d.faces).toBe(6);
    for (let f = 0; f < d.faces; f++) {
      const r = d.tess.faceRanges;
      for (let t = r[2 * f] / 3; t < (r[2 * f] + r[2 * f + 1]) / 3; t++) expect(faceOfTriangle(d, t)).toBe(f);
      expect(near(planarFaceNormal(d, f)!, boxTopo.faces[f].normal!)).toBe(true);
    }
  });

  it('picks the front face in the front view, and the same face through a worker-built BVH', () => {
    const rig = rigLooking('front', sphere);
    const view = viewFor(rig);
    const [x, y] = screenOf(view, [5, 10, 15]);
    const r = pickAt([box], [], view, x, y, ALL)!;
    const front = boxTopo.faces.find((f) => near(f.normal ?? [0, 0, 0], [0, -1, 0]))!.i;
    expect(r.item).toEqual({ kind: 'face', body: 'b_box', index: front });
    expect(near(r.point, [5, 0, 15], 1e-3)).toBe(true);
    expect(near(r.normal!, [0, -1, 0])).toBe(true);
    // The serialised (worker) BVH gives the same hit.
    const bufs = buildBvhBuffers(box.data.tess.positions.slice(), box.data.tess.indices.slice());
    const viaWorker: PickBody = { ...box, bvh: bvhFromBuffers(box.data.geometry, bufs) };
    expect(pickAt([viaWorker], [], view, x, y, ALL)!.item).toEqual(r.item);
  });

  it('picks edges within 8 px of the pointer and not beyond', () => {
    const rig = rigLooking('front', sphere);
    const view = viewFor(rig);
    const topEdge = boxTopo.edges.find((e) => near(e.mid, [5, 0, 30]))!.i;
    const [x, y] = screenOf(view, [5, 0, 30]);
    const r = pickAt([box], [], view, x, y - 6, ALL)!;
    expect(r.item).toEqual({ kind: 'edge', body: 'b_box', index: topEdge });
    // 12 px above the silhouette is empty space.
    expect(pickAt([box], [], view, x, y - 12, ALL)).toBeNull();
  });

  it('picks vertices within 8 px (kernel vertex order), before the edges that meet there', () => {
    const rig = rigLooking('home', sphere);
    const view = viewFor(rig);
    const corner = boxTopo.vertices.find((v) => near(v.p, [0, 0, 30]))!.i;
    const [x, y] = screenOf(view, [0, 0, 30]);
    const r = pickAt([box], [], view, x + 3, y + 2, ALL)!;
    expect(r.item).toEqual({ kind: 'vertex', body: 'b_box', index: corner });
    // Without vertex positions the same spot gives an edge.
    const noVerts = pickAt([{ ...box, vertices: null }], [], view, x + 3, y + 2, ALL)!;
    expect(noVerts.item.kind).toBe('edge');
  });

  it('does not pick edges hidden behind the body', () => {
    const rig = rigLooking('home', sphere);
    const view = viewFor(rig);
    // The vertical edge at x=10, y=20 is at the back from the home view (front-left, above).
    const hidden = boxTopo.edges.find((e) => near(e.mid, [10, 20, 15]))!.i;
    const [x, y] = screenOf(view, [10, 20, 15]);
    const r = pickAt([box], [], view, x, y, ALL)!;
    expect(r.item.kind).toBe('face');
    expect(r.item).not.toEqual({ kind: 'edge', body: 'b_box', index: hidden });
    // In wireframe nothing hides it.
    const wire = pickAt([box], [], { ...view, occlude: false, faces: false }, x, y, ALL)!;
    expect(wire.item).toEqual({ kind: 'edge', body: 'b_box', index: hidden });
  });

  it('follows the selection filter', () => {
    const rig = rigLooking('front', sphere);
    const view = viewFor(rig);
    const [x, y] = screenOf(view, [5, 10, 15]);
    const only = (kinds: SelectKind[]) => pickAt([box], planes(40), view, x, y, kindsForFilter(kinds));
    expect(only(['body'])!.item).toEqual({ kind: 'body', body: 'b_box' });
    // Planes only: the front plane (y = 0, coplanar with the front face) is picked through the body.
    expect(only(['origin'])!.item).toEqual({ kind: 'origin', ref: 'origin:front' });
    // Edges only: nothing within 8 px of the face centre.
    expect(only(['edge'])).toBeNull();
    // Everything: the body wins over the plane behind or on it.
    expect(pickAt([box], planes(40), view, x, y, ALL)!.item.kind).toBe('face');
    // Off the body, the plane is picked.
    const [px, py] = screenOf(view, [-20, 0, 15]);
    expect(pickAt([box], planes(40), view, px, py, ALL)!.item).toEqual({ kind: 'origin', ref: 'origin:front' });
  });

  it('with a section cut: the cap hides what is behind it and is not selectable', () => {
    const rig = rigLooking('front', sphere);
    // Keep y >= 10 (the front half is cut away); the viewer looks at the cut.
    const clip = new Plane(new Vector3(0, 1, 0), -10);
    const view = viewFor(rig, clip);
    const [x, y] = screenOf(view, [5, 10, 15]);
    expect(pickAt([box], [], view, x, y, ALL)).toBeNull();
    const hit = raycastBodies([box], rayAt(view, x, y, new Ray()), view)!;
    expect(hit.cap).toBe(true);
    expect(hit.point.y).toBeCloseTo(10, 4);
    // The side face (x = 0) is still picked where it is kept... it is edge-on in the front view, so use the home view.
    const home = rigLooking('home', sphere);
    const hv = viewFor(home, clip);
    const left = boxTopo.faces.find((f) => near(f.normal ?? [0, 0, 0], [-1, 0, 0]))!.i;
    const [lx, ly] = screenOf(hv, [0, 15, 15]);
    expect(pickAt([box], [], hv, lx, ly, ALL)!.item).toEqual({ kind: 'face', body: 'b_box', index: left });
    // A point on the cut-away part is not visible: its edge is not picked.
    const [cx, cy] = screenOf(hv, [0, 0, 30]);
    const r = pickAt([box], [], hv, cx, cy, ALL);
    expect(r === null || r.item.kind !== 'vertex' || !near(r.point, [0, 0, 30])).toBe(true);
  });

  it('a cylinder: its side is not planar, its caps are; its seam is neither drawn nor picked', () => {
    const id = k.call('cylinder', { r: 5, h: 12 }).id as number;
    const topo = k.call('topo', { id }) as unknown as Topo;
    const cyl = body('b_cyl', tessOf(id), topo);
    // 3 edges: two circles and the seam, which the kernel flags as hidden.
    expect(cyl.data.edges).toBe(3);
    expect(cyl.data.hiddenEdges).toBe(1);
    const seam = [0, 1, 2].find((e) => cyl.data.edgeSpheres[4 * e + 3] < 0)!;
    const er = cyl.data.tess.edgeRanges;
    const drawn = [0, 1, 2].filter((e) => e !== seam).reduce((n, e) => n + er[2 * e + 1], 0);
    expect(cyl.data.drawEdges.length).toBe(3 * drawn);
    // Look straight at the seam: the pick is the side face, not the seam edge.
    const sp = cyl.data.tess.edgePositions;
    const s0 = er[2 * seam];
    const mid = new Vector3(sp[3 * s0], sp[3 * s0 + 1], sp[3 * s0 + 2]).lerp(new Vector3(sp[3 * s0 + 3], sp[3 * s0 + 4], sp[3 * s0 + 5]), 0.5);
    const out = new Vector3(mid.x, mid.y, 0).normalize();
    const seamRig = new CameraRig();
    seamRig.orient([out.x, out.y, 0], [0, 0, 1]);
    seamRig.frame(cyl.data.sphere);
    seamRig.scene.copy(cyl.data.sphere);
    const sv = viewFor(seamRig);
    const [mx, my] = screenOf(sv, [mid.x, mid.y, mid.z]);
    expect(pickAt([cyl], [], sv, mx, my, ALL)!.item.kind).toBe('face');
    for (const f of topo.faces) {
      const n = planarFaceNormal(cyl.data, f.i);
      if (f.type === 'plane') expect(near(n!, f.normal!)).toBe(true);
      else expect(n).toBeNull();
    }
    // Front view: the middle of the cylinder is its side face.
    const rig = rigLooking('front', cyl.data.sphere);
    const view = viewFor(rig);
    const [x, y] = screenOf(view, [0, -5, 6]);
    const r = pickAt([cyl], [], view, x, y, ALL)!;
    const side = topo.faces.find((f) => f.type === 'cylinder')!.i;
    expect(r.item).toEqual({ kind: 'face', body: 'b_cyl', index: side });
  });
});
