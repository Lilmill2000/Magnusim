// A scripted KernelAdapter for P2 build tests: each op the test needs answers
// from a handler; every call is recorded; a missing handler is the kernel's
// "unknown op". Plus a BuildContext over it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../../src/lib/store';
import { createUnitsService } from '../../../src/doc/units';
import { emptyDoc } from '../../../src/doc/schema';
import type { BodyId, CadDoc } from '../../../src/types/doc';
import type { BuildContext, BuiltBody, FeatureFiles } from '../../../src/types/doc-service';
import type { KernelAdapter, KernelCallError, KernelCallErrorKind, KernelReply, KernelStatus } from '../../../src/types/kernel';
import type { KernelOp } from '../../../src/types/kernel-protocol';

type Handler = (params: Record<string, unknown>, opts: { bytes?: ArrayBuffer; timeoutMs?: number }) => unknown | { result: unknown; buffers: Record<string, ArrayBuffer> };

export interface ScriptKernel extends KernelAdapter {
  calls: { op: KernelOp; params: Record<string, unknown>; bytes?: number; timeoutMs?: number }[];
  released: number[];
  on(op: KernelOp | string, h: Handler): ScriptKernel;
  ops(): string[];
}

export function kernelError(message: string, kind: KernelCallErrorKind = 'occt', op: KernelOp = 'boolean'): KernelCallError {
  return Object.assign(new Error(message), { kind, op });
}

export function scriptKernel(occt = '7.9.3'): ScriptKernel {
  const handlers = new Map<string, Handler>();
  const status = createStateStore<KernelStatus>({ state: 'ready', info: { occt, variant: 'wasm32', ready_ms: 1, init_ms: 1, heap_bytes: 1 }, message: null, respawns: 0, busy: null, heap_bytes: 1, memory_high: false });
  const k: ScriptKernel = {
    calls: [],
    released: [],
    status,
    async start() {
      return status.get().info!;
    },
    async call(op: KernelOp, params: object, opts: { bytes?: ArrayBuffer; timeoutMs?: number } = {}): Promise<KernelReply<KernelOp>> {
      const p = params as Record<string, unknown>;
      k.calls.push({ op, params: p, ...(opts.bytes ? { bytes: opts.bytes.byteLength } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
      await Promise.resolve();
      if (op === 'release') {
        k.released.push(...((p.ids as number[]) ?? []));
        return { result: {} as never, buffers: {}, ms: 0, wall_ms: 0, heap_bytes: 0 };
      }
      const h = handlers.get(op);
      if (!h) throw kernelError(`unknown op '${op}'`, 'input', op);
      const out = await h(p, opts);
      const wrapped = out && typeof out === 'object' && 'result' in (out as object) && 'buffers' in (out as object) ? (out as { result: unknown; buffers: Record<string, ArrayBuffer> }) : { result: out, buffers: {} };
      return { result: wrapped.result as never, buffers: wrapped.buffers, ms: 0, wall_ms: 0, heap_bytes: 0 };
    },
    onRespawn: () => () => {},
    async restart() {
      return status.get().info!;
    },
    async recycleIfLarge() {
      return false;
    },
    dispose() {},
    on(op, h) {
      handlers.set(op, h);
      return k;
    },
    ops: () => k.calls.map((c) => c.op),
  } as ScriptKernel;
  return k;
}

/** A BuildContext over a scripted kernel and some bodies. */
export function ctxOf(kernel: KernelAdapter, bodies: BuiltBody[], opts: { doc?: CadDoc; files?: FeatureFiles | null; faces?: (shape: number) => number } = {}): BuildContext & { releasedByCtx: number[] } {
  const doc = opts.doc ?? emptyDoc('metric');
  const released: number[] = [];
  return {
    kernel,
    units: createUnitsService(() => doc.units, () => doc.params),
    bodies: new Map(bodies.map((b) => [b.id, b])),
    doc,
    bodyName: (id: BodyId) => doc.bodies[id]?.name ?? 'a deleted body',
    featureName: (id) => doc.features.find((f) => f.id === id)?.name ?? 'a deleted feature',
    bbox: async () => [0, 0, 0, 1, 1, 1],
    faces: async (s) => opts.faces?.(s) ?? 6,
    async release(ids) {
      released.push(...ids);
    },
    outputs: new Map(),
    files: opts.files === undefined ? null : opts.files,
    solver: null,
    releasedByCtx: released,
  };
}
