// A KernelAdapter stand-in with toy geometry (every shape is an axis-aligned
// box: its bounding box and volume), for rebuild and document tests without
// wasm. Scripts failures, invalid results, watchdog stops and respawns, and
// records every call.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../src/lib/store';
import type { KernelAdapter, KernelCallError, KernelCallErrorKind, KernelReply, KernelStatus } from '../../src/types/kernel';
import type { BBox, KernelOp } from '../../src/types/kernel-protocol';

interface Toy {
  bbox: BBox;
  volume: number;
}

const vol = (b: BBox) => Math.max(0, b[3] - b[0]) * Math.max(0, b[4] - b[1]) * Math.max(0, b[5] - b[2]);
function inter(a: BBox, b: BBox): BBox | null {
  const r: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5])];
  return r[0] < r[3] && r[1] < r[4] && r[2] < r[5] ? r : null;
}
const union = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];

export interface FakeKernelScript {
  /** Throw this for a call (kind occt/input/watchdog/trap/...); null = answer normally. */
  fail?(op: KernelOp, params: Record<string, unknown>): { kind: KernelCallErrorKind; message: string; oom?: boolean } | null;
  /** Result validity for shape ops (default true). */
  valid?(op: KernelOp, params: Record<string, unknown>): boolean;
  /** The facade's ShapeFix `repair` (absent: the op is unknown, like an older kernel). */
  repair?(input: { bbox: BBox; volume: number }): { shape: { bbox: BBox; volume: number }; valid: boolean };
}

function err(message: string, kind: KernelCallErrorKind, op: KernelOp, extra: Partial<KernelCallError> = {}): KernelCallError {
  return Object.assign(new Error(message), { kind, op, ...extra }) as KernelCallError;
}

export class FakeKernel implements KernelAdapter {
  readonly status = createStateStore<KernelStatus>({ state: 'idle', info: null, message: null, respawns: 0, busy: null, heap_bytes: null, memory_high: false });
  shapes = new Map<number, Toy>();
  calls: { op: KernelOp; params: Record<string, unknown>; timeoutMs?: number }[] = [];
  /** Face count props reports (default 6: a box). */
  facesOf: (id: number) => number = () => 6;
  released: number[] = [];
  heap = 64 << 20;
  script: FakeKernelScript = {};
  private nextId = 1;
  private listeners = new Set<(reason: string) => void>();
  recycles = 0;

  async start() {
    if (this.status.get().state !== 'ready') this.status.set({ state: 'ready', info: { occt: '7.9.3', variant: 'wasm32', ready_ms: 1, init_ms: 1, heap_bytes: this.heap }, heap_bytes: this.heap });
    return this.status.get().info!;
  }

  /** Ops made so far (optionally only these). */
  ops(filter?: KernelOp[]): KernelOp[] {
    return this.calls.map((c) => c.op).filter((o) => !filter || filter.includes(o));
  }

  private put(t: Toy): number {
    const id = this.nextId++;
    this.shapes.set(id, t);
    return id;
  }

  private get(id: unknown, op: KernelOp): Toy {
    const t = this.shapes.get(Number(id));
    if (!t) throw err(`unknown shape id ${id}`, 'input', op);
    return t;
  }

  async call<Op extends KernelOp>(op: Op, params: Record<string, unknown> & object, opts: { timeoutMs?: number } = {}): Promise<KernelReply<Op>> {
    const p = params as Record<string, unknown>;
    this.calls.push({ op, params: p, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    await Promise.resolve();
    if (this.status.get().state !== 'ready') throw err('The kernel is not running', 'boot', op);
    const f = this.script.fail?.(op, p);
    if (f) {
      const e = err(f.message, f.kind, op, { oom: f.oom, seconds: f.kind === 'watchdog' ? 20 : undefined });
      if (f.kind === 'watchdog' || f.kind === 'trap' || f.kind === 'crash' || f.oom) queueMicrotask(() => void this.respawn(f.message));
      throw e;
    }
    const valid = this.script.valid ? this.script.valid(op, p) : true;
    let result: Record<string, unknown> = {};
    let buffers: Record<string, ArrayBuffer> = {};
    switch (op) {
      case 'box': {
        const o = (p.origin as number[]) ?? [0, 0, 0];
        const b: BBox = [o[0], o[1], o[2], o[0] + Number(p.dx), o[1] + Number(p.dy), o[2] + Number(p.dz)];
        if (!(Number(p.dx) > 0 && Number(p.dy) > 0 && Number(p.dz) > 0)) throw err('BRepPrimAPI_MakeBox: bad size', 'occt', op);
        result = { id: this.put({ bbox: b, volume: vol(b) }), valid };
        break;
      }
      case 'cylinder': {
        const o = (p.origin as number[]) ?? [0, 0, 0];
        const a = (p.axis as number[]) ?? [0, 0, 1];
        const r = Number(p.r);
        const h = Number(p.h);
        const ext = a.map((c) => (c ? h : 0));
        const b: BBox = [o[0] - (a[0] ? 0 : r), o[1] - (a[1] ? 0 : r), o[2] - (a[2] ? 0 : r), o[0] + (a[0] ? ext[0] : r), o[1] + (a[1] ? ext[1] : r), o[2] + (a[2] ? ext[2] : r)];
        result = { id: this.put({ bbox: b, volume: Math.PI * r * r * h }), valid };
        break;
      }
      case 'boolean': {
        const targets = (p.targets as number[]).map((id) => this.get(id, op));
        const tools = (p.tools as number[]).map((id) => this.get(id, op));
        const t0 = targets[0];
        let out: Toy;
        if (p.op === 'fuse') {
          out = [...targets.slice(1), ...tools].reduce<Toy>((acc, t) => {
            const i = inter(acc.bbox, t.bbox);
            return { bbox: union(acc.bbox, t.bbox), volume: acc.volume + t.volume - (i ? vol(i) : 0) };
          }, t0);
        } else if (p.op === 'cut') {
          const i = inter(t0.bbox, tools[0].bbox);
          out = { bbox: t0.bbox, volume: t0.volume - (i ? vol(i) : 0) };
        } else {
          const i = inter(t0.bbox, tools[0].bbox);
          out = i ? { bbox: i, volume: vol(i) } : { bbox: [0, 0, 0, 0, 0, 0], volume: 0 };
        }
        const empty = out.volume <= 1e-9;
        result = { id: this.put(out), valid, empty, solids: empty ? 0 : 1 };
        break;
      }
      case 'check':
        this.get(p.id, op);
        result = { valid: true, check_ms: 0 };
        break;
      case 'props': {
        // Like the facade: counts always; volume / area on request; bbox unless 'none'.
        const t = this.get(p.id, op);
        result = { faces: this.facesOf(Number(p.id)), edges: 12, vertices: 8, solids: 1, shells: 1, bbox_mode: p.bbox ?? 'fast', timings: {} };
        if (p.bbox !== 'none') result.bbox = t.bbox;
        if (p.volume) Object.assign(result, { volume: t.volume, centroid: null });
        if (p.area) result.area = 0;
        break;
      }
      case 'tessellate': {
        const t = this.get(p.id, op);
        const [x0, y0, z0, x1, y1, z1] = t.bbox;
        buffers = {
          positions: new Float32Array([x0, y0, z0, x1, y1, z1, x0, y1, z1]).buffer,
          normals: new Float32Array(9).buffer,
          indices: new Uint32Array([0, 1, 2]).buffer,
          face_ranges: new Uint32Array(12).buffer,
          edge_positions: new Float32Array(6).buffer,
          edge_ranges: new Uint32Array(24).buffer,
        };
        result = { triangles: 1, vertices: 3, lin_defl: 0.1, mesh_status: 0, faces_without_triangles: 0 };
        break;
      }
      case 'release':
        for (const id of p.ids as number[]) {
          if (this.shapes.delete(id)) this.released.push(id);
        }
        break;
      case 'repair': {
        if (!this.script.repair) throw err('unknown op "repair"', 'input', op);
        const t = this.get(p.id, op);
        const out = this.script.repair(t);
        result = { id: this.put(out.shape), valid: out.valid, fixed: true };
        break;
      }
      case 'version':
      case 'mem':
        result = {};
        break;
      default:
        throw err(`unknown op "${op}"`, 'input', op);
    }
    this.status.set({ heap_bytes: this.heap });
    return { result: result as never, buffers, ms: 0, wall_ms: 0, heap_bytes: this.heap };
  }

  onRespawn(fn: (reason: string) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A worker respawn: every shape id dies; listeners run once "ready". */
  async respawn(reason: string) {
    this.shapes.clear();
    this.status.set({ state: 'restarting', message: reason, respawns: this.status.get().respawns + 1 });
    await Promise.resolve();
    this.status.set({ state: 'ready' });
    for (const fn of [...this.listeners]) fn(reason);
    return this.status.get().info!;
  }

  restart(reason: string) {
    return this.respawn(reason);
  }

  async recycleIfLarge() {
    if (this.heap > 1.2e9 && this.recycles === 0) {
      this.recycles++;
      this.heap = 64 << 20;
      await this.respawn('memory recycle');
      return true;
    }
    return false;
  }

  dispose() {
    this.status.set({ state: 'closed' });
  }

  /** Every live shape (for leak checks). */
  live(): number[] {
    return [...this.shapes.keys()];
  }
}
