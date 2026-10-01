// @vitest-environment node
// Cheap by default, exact on request: props gives counts and a fast padded bbox
// unless volume/area/exact bbox are asked for; topo computes signatures only for
// the faces/edges/vertices asked for, and topoInChunks walks a part in chunks.
// (The 113 MB part's timings: kernel-bigstep.test.ts, opt-in.)
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { topoInChunks } from '../../src/kernel-worker/topo-chunks';
import type { TopoResult } from '../../src/types/kernel-protocol';
import { call, importStep, loadKernel, REF, rel, tryCall, type R } from './kernel-lib';

let k: Kernel;
let vortex: number;
beforeAll(async () => {
  k = await loadKernel();
  vortex = importStep(k, 'vortex-cfd-test.step').shapes[0].id;
});

describe('props', () => {
  it('by default: counts and a fast bbox that encloses the exact one, no volume or area', () => {
    const p = call(k, 'props', { id: vortex });
    expect(p).toMatchObject({ faces: 17, edges: 34, vertices: 18, solids: 1, shells: 1, bbox_mode: 'fast' });
    expect(p.volume).toBeUndefined();
    expect(p.area).toBeUndefined();
    const ex = REF.vortex.import.bbox_exact;
    for (let i = 0; i < 3; i++) {
      expect(p.bbox[i]).toBeLessThanOrEqual(ex[i]);
      expect(p.bbox[i + 3]).toBeGreaterThanOrEqual(ex[i + 3]);
    }
    // It is the tolerance-padded box OCCT's BRepBndLib::Add gives natively.
    for (let i = 0; i < 6; i++) expect(p.bbox[i]).toBeCloseTo(REF.vortex.import.bbox_add[i], 6);
  });

  it('on request: volume and centroid, area, exact bbox; none skips the bbox', () => {
    const p = call(k, 'props', { id: vortex, volume: true, area: true, bbox: 'exact' });
    expect(rel(p.volume, REF.vortex.import.volume)).toBeLessThan(1e-9);
    expect(rel(p.area, REF.vortex.import.area)).toBeLessThan(1e-9);
    for (let i = 0; i < 3; i++) expect(p.centroid[i]).toBeCloseTo(REF.vortex.import.centroid[i], 6);
    expect(p.bbox_mode).toBe('exact');
    for (let i = 0; i < 6; i++) expect(p.bbox[i]).toBeCloseTo(REF.vortex.import.bbox_exact[i], 9);
    const none = call(k, 'props', { id: vortex, bbox: 'none' });
    expect(none.bbox).toBeUndefined();
    expect(none.bbox_mode).toBe('none');
    // The older spelling still works.
    expect(call(k, 'props', { id: vortex, bbox_mode: 'optimal' }).bbox_mode).toBe('exact');
    expect(tryCall(k, 'props', { id: vortex, bbox: 'tight' })).toMatchObject({ ok: false, kind: 'input' });
  });
});

describe('topo', () => {
  it('computes only the requested faces, edges and vertices', () => {
    const full = call(k, 'topo', { id: vortex });
    expect(full.counts).toEqual({ faces: 17, edges: 34, vertices: 18 });
    expect(full.faces).toHaveLength(17);
    const some = call(k, 'topo', { id: vortex, faces: [3, 11], edges: { start: 30, count: 10 }, vertices: 'none' });
    expect(some.faces.map((f: R) => f.i)).toEqual([3, 11]);
    expect(some.faces[1]).toEqual(full.faces[11]);
    expect(some.edges.map((e: R) => e.i)).toEqual([30, 31, 32, 33]); // clipped to the 34 edges
    expect(some.edges[0]).toEqual(full.edges[30]);
    expect(some.vertices).toEqual([]);
    expect(some.counts).toEqual(full.counts);
  });

  it('can skip the slow parts (exact face bbox, face area/centroid, edge length)', () => {
    const cheap = call(k, 'topo', { id: vortex, face_bbox: 'fast', face_mass: false, edge_length: false, vertices: 'none' });
    expect(cheap.faces[0].area).toBeUndefined();
    expect(cheap.faces[0].centroid).toBeUndefined();
    expect(cheap.faces[0].bbox).toHaveLength(6);
    expect(cheap.edges[0].length).toBeUndefined();
    expect(cheap.edges[0].faces.length).toBeGreaterThan(0);
    expect(call(k, 'topo', { id: vortex, face_bbox: 'none', edges: 'none', vertices: 'none' }).faces[0].bbox).toBeUndefined();
  });

  it('rejects out-of-range indices and bad selectors', () => {
    expect(tryCall(k, 'topo', { id: vortex, faces: [17] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'topo', { id: vortex, faces: 'some' })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'topo', { id: vortex, face_bbox: 'tight' })).toMatchObject({ ok: false, kind: 'input' });
  });

  it('topoInChunks gives exactly the full result, with progress', async () => {
    const full = call(k, 'topo', { id: vortex });
    const progress: [number, number][] = [];
    let calls = 0;
    const chunked = await topoInChunks(
      async (p) => {
        calls++;
        return call(k, 'topo', p) as unknown as TopoResult;
      },
      vortex,
      { chunk: 4, onProgress: (d, t) => progress.push([d, t]) },
    );
    expect(chunked.faces).toEqual(full.faces);
    expect(chunked.edges).toEqual(full.edges);
    expect(chunked.vertices).toEqual(full.vertices);
    // 1 head call + ceil(17/4) + ceil(34/8) + ceil(18/16) = 1 + 5 + 5 + 2
    expect(calls).toBe(13);
    expect(progress[0]).toEqual([0, 69]);
    expect(progress[progress.length - 1]).toEqual([69, 69]);
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(topoInChunks(async (p) => call(k, 'topo', p) as unknown as TopoResult, vortex, { signal: ctl.signal })).rejects.toThrow('stop');
  });
});
