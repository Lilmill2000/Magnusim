// @vitest-environment node
// The 113 MB STEP (Daniel's 8m0119333_V12.step, 11,776 faces): opt-in, because the
// file stays outside the repository and the run takes minutes and ~1.5 GB.
//   CAD_KERNEL_BIG_STEP=<path to 8m0119333_V12.step> npm run test:kernel -- bigstep
// Measures what decision 6 (02 - P0 results) asks for: the cheap defaults (props
// fast bbox, topo per requested face/edge, chunks) against the slow exact ones,
// the cost of work copies, and edge flags on a large part. Numbers go to the
// console and to .cache/kernel-bigstep.json.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { topoInChunks } from '../../src/kernel-worker/topo-chunks';
import type { TopoResult } from '../../src/types/kernel-protocol';
import { call, loadKernel, PLUGIN, REF, rel, type R } from './kernel-lib';

const FILE = process.env.CAD_KERNEL_BIG_STEP;
const ref = REF.large_step;

describe.skipIf(!FILE)('the 113 MB STEP (opt-in: CAD_KERNEL_BIG_STEP)', () => {
  it('imports, and the cheap paths stay cheap', async () => {
    const out: R = { file: FILE, kernel: process.env.CAD_KERNEL_DIR || 'workspace/kernel' };
    const timed = <T>(name: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      out[name] = { ...(out[name] || {}), ms: Math.round(performance.now() - t0) };
      console.log(`[bigstep] ${name}: ${out[name].ms} ms`);
      return r;
    };
    const k = await loadKernel();
    const bytes = new Uint8Array(readFileSync(FILE!));
    expect(bytes.length).toBe(ref.bytes);

    const imp = timed('import', () => call(k, 'import_step', { ...k.putBytes(bytes), name: 'large.step', heal: true, tol: 1e-3 }));
    out.import.timings = imp.timings;
    out.import.heap_mb = Math.round(k.heapBytes() / 2 ** 20);
    const id = imp.shapes[0].id;
    expect(imp.shapes).toHaveLength(1);
    expect(imp.faces).toBe(ref.healed_counts.faces);
    expect(imp.edges).toBe(ref.healed_counts.edges);

    // props: the default is counts + fast bbox; volume and exact bbox on request.
    const fast = timed('props_default', () => call(k, 'props', { id }));
    expect(fast.faces).toBe(ref.healed_counts.faces);
    expect(fast.volume).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      expect(fast.bbox[i]).toBeLessThanOrEqual(ref.bbox_exact[i] + 1e-9);
      expect(fast.bbox[i + 3]).toBeGreaterThanOrEqual(ref.bbox_exact[i + 3] - 1e-9);
    }
    const vol = timed('props_volume', () => call(k, 'props', { id, volume: true, bbox: 'none' }));
    expect(rel(vol.volume, ref.volume)).toBeLessThan(1e-6);

    // topo: one chunk of 500 faces / 1000 edges with the full signature, then the whole
    // part in chunks with the fast face bbox.
    timed('topo_chunk_500_faces_exact', () => call(k, 'topo', { id, faces: { start: 0, count: 500 }, edges: 'none', vertices: 'none' }));
    timed('topo_chunk_500_faces_fast', () => call(k, 'topo', { id, faces: { start: 0, count: 500 }, edges: 'none', vertices: 'none', face_bbox: 'fast' }));
    timed('topo_chunk_1000_edges', () => call(k, 'topo', { id, faces: 'none', edges: { start: 0, count: 1000 }, vertices: 'none' }));
    timed('topo_one_face', () => call(k, 'topo', { id, faces: [5000], edges: 'none', vertices: 'none' }));
    let chunks = 0;
    let longest = 0;
    const t0 = performance.now();
    const all = await topoInChunks(
      async (p) => {
        const c0 = performance.now();
        const r = call(k, 'topo', p) as unknown as TopoResult;
        longest = Math.max(longest, performance.now() - c0);
        chunks++;
        return r;
      },
      id,
      { chunk: 500, face_bbox: 'fast' },
    );
    out.topo_all_chunked_fast = { ms: Math.round(performance.now() - t0), calls: chunks, longest_call_ms: Math.round(longest) };
    console.log(`[bigstep] topo_all_chunked_fast: ${JSON.stringify(out.topo_all_chunked_fast)}`);
    expect(all.faces).toHaveLength(ref.healed_counts.faces);
    expect(all.edges).toHaveLength(ref.healed_counts.edges);
    // Every chunk stays well inside the 20 s default watchdog.
    expect(longest).toBeLessThan(20_000);

    // Tessellation with edge flags.
    const t = timed('tessellate', () => call(k, 'tessellate', { id }));
    const b = k.takeBuffers(t as never);
    out.tessellate.triangles = t.triangles;
    out.tessellate.hidden_edges = t.hidden_edges;
    out.tessellate.timings = t.timings;
    expect(b.edge_flags.length).toBe(ref.healed_counts.edges);

    const chk = timed('check', () => call(k, 'check', { id }));
    expect(chk.valid).toBe(true);

    // A boolean on the part: the external fluid box (box minus part), with the copy cost.
    const bb = ref.bbox_exact;
    const m = 0.1 * Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
    const box = call(k, 'box', { origin: [bb[0] - m, bb[1] - m, bb[2] - m], dx: bb[3] - bb[0] + 2 * m, dy: bb[4] - bb[1] + 2 * m, dz: bb[5] - bb[2] + 2 * m });
    const vbox = (bb[3] - bb[0] + 2 * m) * (bb[4] - bb[1] + 2 * m) * (bb[5] - bb[2] + 2 * m);
    const cut = timed('cut_fluid', () => call(k, 'boolean', { op: 'cut', targets: [box.id], tools: [id] }));
    out.cut_fluid.timings = cut.timings;
    out.cut_fluid.check_ms = Math.round(cut.check_ms);
    out.cut_fluid.valid = cut.valid;
    const cv = call(k, 'props', { id: cut.id, volume: true, bbox: 'none' }).volume;
    out.cut_fluid.volume_rel = rel(cv, vbox - vol.volume);
    expect(cut.valid).toBe(true);
    expect(rel(cv, vbox - vol.volume)).toBeLessThan(1e-6);

    out.heap_peak_mb = Math.round(k.heapBytes() / 2 ** 20);
    mkdirSync(join(PLUGIN, '.cache'), { recursive: true });
    writeFileSync(join(PLUGIN, '.cache', 'kernel-bigstep.json'), JSON.stringify(out, null, 1));
    console.log(`[bigstep] ${JSON.stringify(out)}`);
  }, 1_200_000);
});
