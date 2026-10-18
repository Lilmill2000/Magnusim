// The kernel's topo of the bodies the selectors read (CAD tools spec §5.8): one call per shape for
// everything a selector or a find row needs (faces with their area, centroid, normal or axis,
// radius and fast box; edges with their length, ends, faces and direction; vertices with their
// faces), kept for the newest 32 shapes and dropped when the kernel restarts (every shape id dies
// then). Shapes above 2000 faces are read in chunks with progress (topoInChunks). A coarse
// tessellation is kept the same way for bodies the page does not draw (the bodies before a
// feature an edit changes). The cache is also a NamingLookup, so references made from it are the
// ones a pick in the view makes (the same topo options as naming/refs.ts kernelLookup).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { topoInChunks } from '../../kernel-worker/topo-chunks';
import type { AppServices } from '../../types/app';
import type { KernelAdapter, TessPayload } from '../../types/kernel';
import type { ShapeId, TopoResult } from '../../types/kernel-protocol';
import type { NamingLookup } from '../../types/naming';

/** Shapes kept. */
export const TOPO_CACHE_SHAPES = 32;
/** Above this many faces a shape's topo is read in chunks. */
export const TOPO_CHUNK_ABOVE = 2000;

type Topo = TopoResult & { faceAt: Map<number, TopoResult['faces'][number]>; edgeAt: Map<number, TopoResult['edges'][number]>; vertexAt: Map<number, TopoResult['vertices'][number]> };

export interface TopoReadOptions {
  /** The shape's face count when known (a drawn body's): small ones are read in one call. */
  faces?: number | null;
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface TopoCache {
  /** Everything of `shape` the selectors read. */
  topo(shape: ShapeId, opts?: TopoReadOptions): Promise<Topo>;
  /** A coarse tessellation of `shape` (for a body the page does not draw), or null when it cannot be made. */
  tess(shape: ShapeId, size: number): Promise<TessPayload | null>;
  /** The cache as a NamingLookup (naming/resolve.ts, naming/edges.ts). */
  readonly lookup: NamingLookup;
  /** How many topo calls went to the kernel (tests). */
  readonly calls: number;
  clear(): void;
}

class Lru<V> {
  private readonly map = new Map<ShapeId, V>();
  constructor(private readonly max: number) {}
  get(k: ShapeId): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: ShapeId, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as ShapeId);
  }
  delete(k: ShapeId): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const OPTIONS = { face_bbox: 'fast', face_mass: true, edge_length: true, edge_ends: true, vertex_faces: true } as const;

function indexed(t: TopoResult): Topo {
  return { ...t, faceAt: new Map(t.faces.map((f) => [f.i, f])), edgeAt: new Map(t.edges.map((e) => [e.i, e])), vertexAt: new Map(t.vertices.map((v) => [v.i, v])) };
}

function tessOf(buffers: Record<string, ArrayBuffer>): TessPayload {
  const f32 = (n: string) => new Float32Array(buffers[n] ?? new ArrayBuffer(0));
  const u32 = (n: string) => new Uint32Array(buffers[n] ?? new ArrayBuffer(0));
  return { positions: f32('positions'), normals: f32('normals'), indices: u32('indices'), faceRanges: u32('face_ranges'), edgePositions: f32('edge_positions'), edgeRanges: u32('edge_ranges'), edgeFlags: null };
}

export function createTopoCache(kernel: KernelAdapter): TopoCache {
  const topos = new Lru<Promise<Topo>>(TOPO_CACHE_SHAPES);
  const tesses = new Lru<Promise<TessPayload | null>>(TOPO_CACHE_SHAPES);
  let calls = 0;
  const clear = () => {
    topos.clear();
    tesses.clear();
  };
  kernel.onRespawn(clear);
  const read = async (shape: ShapeId, o: TopoReadOptions): Promise<Topo> => {
    if (typeof o.faces === 'number' && o.faces <= TOPO_CHUNK_ABOVE) {
      calls++;
      return indexed((await kernel.call('topo', { id: shape, ...OPTIONS })).result);
    }
    const r = await topoInChunks(
      (params) => {
        calls++;
        return kernel.call('topo', { ...params, edge_ends: true, vertex_faces: true }).then((x) => x.result);
      },
      shape,
      { face_bbox: 'fast', face_mass: true, edge_length: true, onProgress: o.progress, signal: o.signal },
    );
    return indexed(r);
  };
  const topo = (shape: ShapeId, o: TopoReadOptions = {}): Promise<Topo> => {
    let p = topos.get(shape);
    if (!p) {
      p = read(shape, o);
      topos.set(shape, p);
      // A failed read is not kept (the next selector asks again).
      p.catch(() => topos.delete(shape));
    }
    return p;
  };
  const lookup: NamingLookup = {
    async faces(shape, indices) {
      const t = await topo(shape);
      return indices === 'all' ? t.faces : indices.map((i) => t.faceAt.get(i)).filter((f): f is TopoResult['faces'][number] => !!f);
    },
    async edges(shape, indices) {
      const t = await topo(shape);
      return indices === 'all' ? t.edges : indices.map((i) => t.edgeAt.get(i)).filter((e): e is TopoResult['edges'][number] => !!e);
    },
    async vertices(shape, indices) {
      const t = await topo(shape);
      return indices === 'all' ? t.vertices : indices.map((i) => t.vertexAt.get(i)).filter((v): v is TopoResult['vertices'][number] => !!v);
    },
  };
  return {
    topo,
    tess(shape, size) {
      let p = tesses.get(shape);
      if (!p) {
        const lin = Math.max(0.05, size * 0.005);
        p = kernel
          .call('tessellate', { id: shape, lin_defl: lin, ang_defl_deg: 20, edge_flags: false })
          .then((r) => tessOf(r.buffers))
          .catch(() => null);
        tesses.set(shape, p);
      }
      return p;
    },
    lookup,
    get calls() {
      return calls;
    },
    clear,
  };
}

const caches = new WeakMap<KernelAdapter, TopoCache>();

/** The page's topo cache (one per kernel). */
export function topoCacheOf(services: Pick<AppServices, 'kernel'>): TopoCache {
  let c = caches.get(services.kernel);
  if (!c) {
    c = createTopoCache(services.kernel);
    caches.set(services.kernel, c);
  }
  return c;
}

export type { Topo };
