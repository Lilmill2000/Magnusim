// @vitest-environment node
// The selectors' tables (CAD tools spec §5.5, §5.8): handles numbered per kind in the order first
// listed, one handle for the same face listed twice (also after a rebuild moved it), a new table
// when the key changes, at most 2000 kept (the oldest dropped); the topo cache: one kernel call
// per small shape with every option a selector and a pick need, chunks with progress above 2000
// faces or when the size is not known, the newest 32 shapes kept, a failed read not kept, all
// dropped when the kernel restarts. And the guide's and the help's selector examples read.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/assistant/guide';
import { HELP } from '../../src/assistant/help';
import { currentHandles, handlesOf, HANDLES_MAX, type HandleEntry } from '../../src/assistant/selectors/handles';
import { parseSelector, type KnownNames } from '../../src/assistant/selectors/parse';
import { createTopoCache, TOPO_CACHE_SHAPES } from '../../src/assistant/selectors/topo-cache';
import type { AppServices } from '../../src/types/app';
import type { PersistentRef } from '../../src/types/doc';
import type { KernelAdapter } from '../../src/types/kernel';
import type { KernelParams, TopoResult } from '../../src/types/kernel-protocol';

const ref = (name: string, at: [number, number, number] = [0, 0, 0]): PersistentRef => ({ name, signature: { kind: 'face', type: 'plane', at, dir: [0, 0, 1], radius: null, bbox: null } });
const face = (name: string, at?: [number, number, number]): HandleEntry => ({ kind: 'face', body: 'b_1', bodyName: 'Body 1', ref: ref(name, at), label: null, words: name });

describe('handles', () => {
  it('numbers each kind in the order first listed; the same face keeps its handle, also once it moved', () => {
    const services = {} as AppServices;
    const t = handlesOf(services, 'turn:a');
    expect(t.give(face('F:x:end'))).toBe('#f1');
    expect(t.give(face('F:x:start'))).toBe('#f2');
    expect(t.give({ kind: 'edge', body: 'b_1', bodyName: 'Body 1', ref: { ...ref('E:F:x:end&F:x:start'), signature: { ...ref('E').signature, kind: 'edge' } }, label: null, words: 'edge' })).toBe('#e1');
    expect(t.give({ kind: 'body', body: 'b_1', bodyName: 'Body 1', ref: null, label: 'Body 1', words: 'Body 1' })).toBe('#b1');
    expect(t.give({ kind: 'vertex', body: 'b_1', bodyName: 'Body 1', ref: ref('V:a&b&c'), label: null, words: 'v' })).toBe('#v1');
    // Listed again after a rebuild moved it: the same handle, the reference as it is now.
    expect(t.give(face('F:x:end', [0, 0, 12]))).toBe('#f1');
    expect(t.get('#f1')!.ref!.signature.at).toEqual([0, 0, 12]);
    expect(t.get('#F1')).not.toBeNull();
    // Two edges between the same two faces: two handles.
    const e = (at: [number, number, number]): HandleEntry => ({ kind: 'edge', body: 'b_1', bodyName: 'Body 1', ref: { name: 'E:F:a&F:b', signature: { kind: 'edge', type: 'line', at, dir: null, radius: null, bbox: null } }, label: null, words: 'e' });
    expect(t.give(e([1, 0, 0]))).toBe('#e2');
    expect(t.give(e([2, 0, 0]))).toBe('#e3');
    expect(t.give(e([1, 0, 0]))).toBe('#e2');
    expect(t.get('#f9')).toBeNull();
  });

  it('starts again when the key changes, and keeps at most 2000', () => {
    const services = {} as AppServices;
    const a = handlesOf(services, 'turn:a');
    a.give(face('F:x:end'));
    expect(currentHandles(services, 'turn:a')).toBe(a);
    expect(currentHandles(services, 'turn:b')).toBeNull();
    const b = handlesOf(services, 'turn:b');
    expect(b).not.toBe(a);
    expect(b.get('#f1')).toBeNull();
    expect(b.give(face('F:y:end'))).toBe('#f1');
    for (let i = 0; i < HANDLES_MAX + 5; i++) b.give(face(`F:z:side:e${i}[]`));
    expect(b.size).toBe(HANDLES_MAX);
    // The oldest went first.
    expect(b.get('#f1')).toBeNull();
    expect(b.get('#f7')).not.toBeNull();
    expect(b.give(face('F:new:end'))).toBe(`#f${HANDLES_MAX + 7}`);
  });
});

/** A kernel stub answering topo for shapes of `faces[shape]` faces. */
function stubKernel(faces: (shape: number) => number) {
  const calls: KernelParams<'topo'>[] = [];
  const respawn: ((r: string) => void)[] = [];
  let failNext = false;
  const topo = (p: KernelParams<'topo'>): TopoResult => {
    const n = faces(p.id);
    const pick = (sel: KernelParams<'topo'>['faces'], total: number) => {
      if (sel === 'none') return [];
      if (sel === undefined || sel === 'all') return [...Array(total).keys()];
      if (Array.isArray(sel)) return sel;
      return [...Array(sel.count).keys()].map((k) => k + sel.start);
    };
    return {
      faces: pick(p.faces, n).map((i) => ({ i, type: 'plane', area: 1, centroid: [i, 0, 0], normal: [0, 0, 1], bbox: [i, 0, 0, i + 1, 1, 1] })),
      edges: pick(p.edges, 2 * n).map((i) => ({ i, type: 'line', length: 1, mid: [i, 0, 0], faces: [i % n, (i + 1) % n] })),
      vertices: pick(p.vertices, n).map((i) => ({ i, p: [i, 0, 0], faces: [i % n] })),
      counts: { faces: n, edges: 2 * n, vertices: n },
      timings: {},
    };
  };
  const kernel = {
    call: async (op: string, params: KernelParams<'topo'>) => {
      if (op !== 'topo') throw new Error(op);
      calls.push(params);
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('watchdog'), { kind: 'watchdog' });
      }
      return { result: topo(params), buffers: {}, ms: 1, wall_ms: 1, heap_bytes: 0 };
    },
    onRespawn: (fn: (r: string) => void) => {
      respawn.push(fn);
      return () => {};
    },
  } as unknown as KernelAdapter;
  return { kernel, calls, respawn: () => respawn.forEach((f) => f('test')), failNext: () => (failNext = true) };
}

describe('the topo cache', () => {
  it('reads a small shape in one call with the options of a pick, and keeps it', async () => {
    const k = stubKernel(() => 6);
    const c = createTopoCache(k.kernel);
    const t = await c.topo(7, { faces: 6 });
    expect(k.calls).toEqual([{ id: 7, face_bbox: 'fast', face_mass: true, edge_length: true, edge_ends: true, vertex_faces: true }]);
    expect(t.faces).toHaveLength(6);
    expect(t.faceAt.get(3)?.centroid).toEqual([3, 0, 0]);
    await c.topo(7);
    expect(await c.lookup.faces(7, [2, 5])).toEqual([t.faceAt.get(2), t.faceAt.get(5)]);
    expect(await c.lookup.edges!(7, 'all')).toHaveLength(12);
    expect(await c.lookup.vertices!(7, [1])).toEqual([t.vertexAt.get(1)]);
    expect(k.calls).toHaveLength(1);
    expect(c.calls).toBe(1);
  });

  it('reads a large shape (or one of unknown size) in chunks with progress', async () => {
    const k = stubKernel(() => 2500);
    const c = createTopoCache(k.kernel);
    const progress: number[] = [];
    const t = await c.topo(1, { faces: 2500, progress: (done) => progress.push(done) });
    expect(t.faces).toHaveLength(2500);
    expect(t.edges).toHaveLength(5000);
    expect(k.calls.length).toBeGreaterThan(3);
    expect(k.calls.every((p) => p.edge_ends && p.vertex_faces)).toBe(true);
    expect(progress.at(-1)).toBe(2500 + 5000 + 2500);
    const small = stubKernel(() => 4);
    const c2 = createTopoCache(small.kernel);
    expect((await c2.topo(2)).faces).toHaveLength(4);
    // Unknown size: a first call for the counts, then the parts.
    expect(small.calls[0]).toMatchObject({ faces: { start: 0, count: 0 } });
  });

  it(`keeps the newest ${TOPO_CACHE_SHAPES} shapes, never a failed read, and drops all when the kernel restarts`, async () => {
    const k = stubKernel(() => 3);
    const c = createTopoCache(k.kernel);
    for (let s = 1; s <= TOPO_CACHE_SHAPES + 1; s++) await c.topo(s, { faces: 3 });
    expect(k.calls).toHaveLength(TOPO_CACHE_SHAPES + 1);
    await c.topo(TOPO_CACHE_SHAPES + 1, { faces: 3 });
    expect(k.calls).toHaveLength(TOPO_CACHE_SHAPES + 1);
    // The oldest went.
    await c.topo(1, { faces: 3 });
    expect(k.calls).toHaveLength(TOPO_CACHE_SHAPES + 2);
    k.failNext();
    await expect(c.topo(100, { faces: 3 })).rejects.toThrow('watchdog');
    expect((await c.topo(100, { faces: 3 })).faces).toHaveLength(3);
    const before = k.calls.length;
    k.respawn();
    await c.topo(100, { faces: 3 });
    expect(k.calls.length).toBe(before + 1);
  });
});

describe("the guide's and help's selectors", () => {
  const names: KnownNames = {
    features: ['Base', 'Bracket', 'Flange', 'Plate', 'Pipe', 'Fillet 1', 'Shell 1', 'Row', 'Flip', 'Split 1', 'Pattern 1', 'Boss.v2'].map((n, i) => ({ id: `f_${i}`, name: n, type: 'extrude' })).concat([
      { id: 'f_s', name: 'Plate sketch', type: 'sketch' },
      { id: 'f_p', name: 'Profile', type: 'sketch' },
    ]),
    bodies: [
      { id: 'b_1', name: 'Body 1' },
      { id: 'b_10', name: 'Body 10' },
    ],
  };
  const reads = (text: string, want: Parameters<typeof parseSelector>[2]) => expect(() => parseSelector(text, names, want), text).not.toThrow();

  it('every selector the guide shows reads', () => {
    const section = GUIDE.slice(GUIDE.indexOf('SELECTORS'), GUIDE.indexOf('BOOLEANS'));
    const quoted = [...section.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((q) => !['+Z', '|Z', '#Z', '%cylinder', 'hole', 'largest', '>Z[2]'].includes(q));
    expect(quoted).toEqual(['Base.start', 'Base.end', 'Base.side', 'Base.side(l2)', 'Body 1 faces >Z', 'edges of Base.end', 'Base.end & Base.side(r.top)', 'Body 1 edges |Z', 'Body 1 face at (0, 0, 6)', 'selection']);
    for (const q of quoted) reads(q, 'any');
    for (const f of ['>Z[2]', '+Z', '|Z', '#Z', '%cylinder', 'hole', 'largest']) reads(`Body 1 faces ${f}`, 'face');
    reads('#f3', 'face');
    for (const q of ['Bracket.side(p.3) & Bracket.side(p.4)']) reads(q, 'edge');
    for (const q of ['Plate.end', 'Flange.side(r.top)']) reads(q, 'face');
    for (const q of ['Top offset 12 mm', 'Base.end offset 2 mm']) reads(q, 'plane');
    reads('Z axis', 'axis');
  });

  it('every example of help selectors reads', () => {
    const faces = ['Base.start', 'Base.end', 'Base.side', 'Base.side(l2)', 'Base.end(2)', 'Pipe.side(o@a2)', 'Fillet 1.fillet(1)', 'Shell 1.inner(Base.end)', 'Row.copy(2)', 'Flip.mirror', 'Split 1.cut', 'Base.end~1', 'Base.end~2', 'Body 1 faces >Z', 'Body 1 face at (0, 0, 6)'];
    for (const q of faces) reads(q, 'face');
    for (const q of ['edges of Base.end', 'edges of Base.end %line', 'Base.end & Base.side(r.top)', 'Body 1 edges |Z']) reads(q, 'edge');
    for (const q of ['Body 1', 'bodies of Pattern 1', 'all bodies', 'bodies']) reads(q, 'body');
    for (const q of ['Top offset 12 mm', 'Base.end offset 2 mm', 'Front offset t/2 flip']) reads(q, 'plane');
    for (const q of ['X axis', 'Profile.ax', 'Profile.r.left', 'Base.end & Base.side(l1)', 'axis of Base.side(c1)', 'normal of Top']) reads(q, 'axis');
    for (const q of ['all', 'largest', 'r1', 'at(10, 5)', 'Plate sketch r2', 'Plate sketch']) reads(q, 'region');
    reads('Plate sketch regions', 'any');
    reads('"Boss.v2".end', 'face');
    // Each of those appears in the topic's text.
    const text = HELP.selectors.map((r) => r.text).join(' ');
    for (const q of [...faces.slice(0, 11), 'edges of Base.end %line', 'bodies of Pattern 1', 'Front offset t/2 flip', 'normal of Top', 'Plate sketch regions']) expect(text, q).toContain(q);
  });
});
