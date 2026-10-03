// A KernelAdapter over the REAL kernel (in-process mk32.wasm) that also answers
// the API 3 ops P2 needs while the kernel build does not have them yet, by
// composing ops it has. Ops the real kernel answers itself are passed through
// (so a new kernel takes over by itself), with the result's face count added
// when it does not report one. Stand-ins:
//   brep_write -> export_step (AP214);  brep_read -> import_step (no healing)
//   heal       -> repair (ShapeFix, no unify; no sewing)
//   combine    -> boolean (fuse / cut / common with several tools)
//   import_step diagnose -> check of every shape as read
// press_pull and measure are not stood in for (their tests use scripted fakes
// until the kernel has them). `ops` records what the PAGE asked for, so a test
// can say "no import_step on reopen" whatever a stand-in calls inside.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelAdapter, KernelCallError, KernelCallOptions, KernelReply } from '../../../src/types/kernel';
import type { KernelOp, KernelParams, ShapeDiagnostics, ShapeId } from '../../../src/types/kernel-protocol';

type Any = Record<string, unknown>;

export interface HybridKernel extends KernelAdapter {
  /** Ops the page asked for, in order. */
  readonly ops: KernelOp[];
  /** Ops answered by a stand-in (not the real kernel). */
  readonly emulated: Set<KernelOp>;
}

const SHAPE_OPS = new Set<string>(['box', 'cylinder', 'sphere', 'extrude', 'revolve', 'boolean', 'fillet', 'chamfer', 'defeature', 'shell', 'repair']);

function unknownOp(op: string): KernelCallError {
  return Object.assign(new Error(`unknown op '${op}'`), { kind: 'input' as const, op: op as KernelOp });
}

export function hybridKernel(real: KernelAdapter): HybridKernel {
  const ops: KernelOp[] = [];
  const emulated = new Set<KernelOp>();
  const known = new Map<string, boolean>();

  async function realCall(op: string, params: Any, opts: KernelCallOptions = {}): Promise<KernelReply<KernelOp>> {
    return (real.call as (o: string, p: Any, x?: KernelCallOptions) => Promise<KernelReply<KernelOp>>)(op, params, opts);
  }
  async function faces(id: ShapeId): Promise<number> {
    const r = await realCall('props', { id, bbox: 'none' });
    return (r.result as { faces: number }).faces;
  }
  /** Does the real kernel have this op? (asked once, by calling it) */
  async function has(op: string, params: Any, opts: KernelCallOptions): Promise<KernelReply<KernelOp> | null> {
    if (known.get(op) === false) return null;
    try {
      const r = await realCall(op, params, opts);
      known.set(op, true);
      return r;
    } catch (err) {
      const e = err as KernelCallError;
      if (e.kind === 'input' && /unknown op/.test(e.message)) {
        known.set(op, false);
        return null;
      }
      throw err;
    }
  }
  const reply = (result: unknown, buffers: Record<string, ArrayBuffer> = {}): KernelReply<KernelOp> => ({ result: result as never, buffers, ms: 0, wall_ms: 0, heap_bytes: 0 });

  async function diagnose(ids: ShapeId[]): Promise<ShapeDiagnostics> {
    const shapes: ShapeDiagnostics['shapes'] = [];
    for (const id of ids) {
      const c = (await realCall('check', { id })).result as Any & { valid: boolean; problems?: never[]; problem_counts?: Record<string, number>; problem_total?: number };
      const p = (await realCall('props', { id, bbox: 'none' })).result as { solids: number; shells: number };
      shapes.push({ id, valid: c.valid, problems: c.problems ?? [], problem_counts: c.problem_counts ?? {}, problem_total: c.problem_total ?? 0, free_edges: 0, closed: p.solids > 0 });
    }
    return { total: shapes.reduce((n, s) => n + s.problem_total, 0), shapes };
  }

  async function call(op: KernelOp, params: Any, opts: KernelCallOptions = {}): Promise<KernelReply<KernelOp>> {
    ops.push(op);
    switch (op) {
      case 'brep_write': {
        const r = await has('brep_write', params, opts);
        if (r) return r;
        emulated.add(op);
        const ids = params.ids as ShapeId[];
        const e = await realCall('export_step', { shapes: ids.map((id, i) => ({ id, name: `Body ${i + 1}` })), schema: 'AP214' });
        return reply({ bytes: e.buffers.step.byteLength, occt: '7.9.3', timings: {} }, { brep: e.buffers.step });
      }
      case 'brep_read': {
        const r = await has('brep_read', params, opts);
        if (r) return r;
        emulated.add(op);
        const i = await realCall('import_step', { name: 'stored.brep', heal: false }, opts);
        const shapes = [];
        for (const s of (i.result as { shapes: { id: ShapeId; type: string }[] }).shapes) shapes.push({ id: s.id, type: s.type, faces: await faces(s.id) });
        return reply({ shapes, occt: '7.9.3', timings: {} });
      }
      case 'heal': {
        // Copies its bytes? No: heal takes ids only, so asking the real kernel first is safe.
        const r = await has('heal', params, opts);
        if (r) return r;
        emulated.add(op);
        const out = [];
        let fixed = 0;
        for (const id of params.ids as ShapeId[]) {
          const rep = (await realCall('repair', { id, tol: params.tol ?? 0.001, max_tol: params.tol ?? 0.001, unify: false })).result as { id: ShapeId; valid: boolean; fixed: boolean; reason?: string };
          if (rep.fixed) fixed++;
          const p = (await realCall('props', { id: rep.id, bbox: 'none' })).result as { faces: number; solids: number };
          out.push({ id: rep.id, from: id, name: '', color: null, type: p.solids ? 'solid' : 'shell', faces: p.faces, valid: rep.valid, ...(rep.reason ? { reason: rep.reason } : {}) });
        }
        return reply({ shapes: out, fixed, sewn: 0, free_edges: 0, diagnostics: params.diagnose === false ? undefined : await diagnose(out.map((s) => s.id)), history: { faces: [], edges: [], deleted: [] }, timings: {} });
      }
      case 'import_step': {
        const wantDiag = params.diagnose !== false;
        const { diagnose: _d, ...rest } = params;
        const r = await realCall('import_step', rest, opts);
        const res = r.result as Any & { shapes: (Any & { id: ShapeId; faces?: number })[]; diagnostics?: unknown };
        for (const s of res.shapes) if (typeof s.faces !== 'number') s.faces = await faces(s.id);
        if (wantDiag && !res.diagnostics) {
          emulated.add(op);
          res.diagnostics = await diagnose(res.shapes.map((s) => s.id));
        }
        return r;
      }
      case 'combine': {
        const r = await has('combine', params, opts);
        if (r) return r;
        emulated.add(op);
        const targets = params.targets as ShapeId[];
        const tools = params.tools as ShapeId[];
        const fuzzy = params.fuzzy as number | undefined;
        const results = [];
        const one = async (bop: string, t: ShapeId, others: ShapeId[]) => {
          const b = (await realCall("boolean", { op: bop, targets: [t], tools: others, ...(fuzzy ? { fuzzy } : {}) })).result as unknown as Any & { id: ShapeId; faces?: number };
          return { ...b, target: t, faces: typeof b.faces === 'number' ? b.faces : await faces(b.id) };
        };
        if (params.op === 'join') results.push(await one('fuse', targets[0], [...targets.slice(1), ...tools]));
        else for (const t of targets) results.push(await one(params.op === 'cut' ? 'cut' : 'common', t, tools));
        return reply({ results, timings: {} });
      }
      default: {
        const r = await realCall(op, params, opts);
        const res = r.result as Any;
        if (SHAPE_OPS.has(op) && typeof res.id === 'number' && typeof res.faces !== 'number') res.faces = await faces(res.id as ShapeId);
        return r;
      }
    }
  }

  return {
    ops,
    emulated,
    get status() {
      return real.status;
    },
    start: () => real.start(),
    call: call as KernelAdapter['call'],
    onRespawn: (fn) => real.onRespawn(fn),
    restart: (reason) => real.restart(reason),
    recycleIfLarge: () => real.recycleIfLarge(),
    dispose: () => real.dispose(),
  };
}

export type { KernelParams };
export { unknownOp };
