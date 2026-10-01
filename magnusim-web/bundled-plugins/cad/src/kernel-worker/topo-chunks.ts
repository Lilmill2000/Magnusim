// Naming signatures of a large part in chunks: `topo` asks for a range of faces,
// edges and vertices at a time, so each call stays well inside the kernel's
// per-call watchdog, other calls can run in between, and the caller can show
// progress. Works with any async `topo` caller (the KernelAdapter on the page, the
// Node kernel in tests). Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelParams, ShapeId, TopoResult } from '../types/kernel-protocol';

export type TopoCaller = (params: KernelParams<'topo'>) => Promise<TopoResult>;

export interface TopoChunkOptions {
  /** Faces per call (default 500; edges and vertices go 2x and 4x that). */
  chunk?: number;
  /** Per-face options, as in `topo`. */
  face_bbox?: 'exact' | 'fast' | 'none';
  face_mass?: boolean;
  edge_length?: boolean;
  /** Which parts to collect (default all three). */
  parts?: ('faces' | 'edges' | 'vertices')[];
  /** Called after each chunk: done and total count over all parts. */
  onProgress?: (done: number, total: number) => void;
  /** Stops between chunks (rejects with the signal's reason). */
  signal?: AbortSignal;
}

/** The whole `topo` of shape `id`, one chunk per call. Same content as one full call. */
export async function topoInChunks(topo: TopoCaller, id: ShapeId, opts: TopoChunkOptions = {}): Promise<TopoResult> {
  const chunk = Math.max(1, Math.floor(opts.chunk ?? 500));
  const parts = opts.parts ?? ['faces', 'edges', 'vertices'];
  const perPart = { faces: chunk, edges: 2 * chunk, vertices: 4 * chunk };
  const base = { id, face_bbox: opts.face_bbox, face_mass: opts.face_mass, edge_length: opts.edge_length };
  // One tiny call for the totals.
  const head = await topo({ ...base, faces: { start: 0, count: 0 }, edges: { start: 0, count: 0 }, vertices: { start: 0, count: 0 } });
  const counts = head.counts;
  const total = parts.reduce((n, p) => n + counts[p], 0);
  const out: TopoResult = { faces: [], edges: [], vertices: [], counts, timings: { faces_ms: 0, edges_ms: 0, vertices_ms: 0, calls: 1 } };
  let done = 0;
  opts.onProgress?.(0, total);
  for (const part of parts) {
    for (let start = 0; start < counts[part]; start += perPart[part]) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
      const count = Math.min(perPart[part], counts[part] - start);
      const none = { start: 0, count: 0 };
      const r = await topo({
        ...base,
        faces: part === 'faces' ? { start, count } : none,
        edges: part === 'edges' ? { start, count } : none,
        vertices: part === 'vertices' ? { start, count } : none,
      });
      (out[part] as unknown[]).push(...(r[part] as unknown[]));
      for (const key of ['faces_ms', 'edges_ms', 'vertices_ms']) out.timings[key] += r.timings?.[key] ?? 0;
      out.timings.calls += 1;
      done += count;
      opts.onProgress?.(done, total);
    }
  }
  return out;
}
