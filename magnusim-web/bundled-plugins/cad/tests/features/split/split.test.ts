// Split's and Delete faces' builds against the kernel with a scripted kernel
// (the real-geometry flows are in tests/features/p2/edits-real.test.ts): the
// plane of an origin plane with its offset and of a flat face, a tool body
// kept or removed, the derived ids and default names of pieces, a target the
// plane misses, an invalid piece with Try repair; Delete faces refusing a
// result that kept a face it was asked to remove.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { indexedNames } from '../../../src/naming/names';
import { deriveBodyId } from '../../../src/doc/features/body-ids';
import { splitDef } from '../../../src/features/split/feature';
import { deleteFacesDef } from '../../../src/features/delete_faces/feature';
import { emptyDoc } from '../../../src/doc/schema';
import { createUnitsService } from '../../../src/doc/units';
import type { CadDoc, DeleteFacesFeature, PersistentRef, SplitFeature } from '../../../src/types/doc';
import type { BuiltBody } from '../../../src/types/doc-service';
import { ctxOf, scriptKernel } from '../p2/script-kernel';

const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
const b = (id: string, shape: number): BuiltBody => ({ id, shape, valid: true, feature: `f_${id}`, names: indexedNames(`f_${id}`, 'primitive', 6) });
const doc: CadDoc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Plate', color: '#123456' }, b_2: { name: 'Cutter', color: '#bdc9db' } } };
const f = (over: Partial<SplitFeature> = {}): SplitFeature => ({ id: 'f_s', type: 'split', name: 'Split 1', targets: ['b_1'], tool: { kind: 'plane', plane: 'origin:right', offset: '0' }, ...over });
const pieces = (ids: number[], over: Record<string, unknown> = {}) => ({ ids, valid: true, pieces_valid: ids.map(() => true), history: { pieces: ids.map((id) => ({ id, faces: [{ out: 0, from: [{ shape: 1, face: 0, how: 'modified' }] }], edges: [] })), deleted: [] }, ...over });

describe('Split build', () => {
  it('an origin plane moved by the offset; piece 0 keeps the id, piece 1 is derived and named after it', async () => {
    const k = scriptKernel().on('split', () => pieces([10, 11]));
    const r = await splitDef.build(f({ tool: { kind: 'plane', plane: 'origin:right', offset: '15 mm' } }), { offset: 15 }, ctxOf(k, [b('b_1', 1)], { doc, faces: () => 6 }));
    expect(k.calls.find((c) => c.op === 'split')!.params).toEqual({ id: 1, plane: { origin: [15, 0, 0], normal: [1, 0, 0] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bodies.map((x) => [x.id, x.shape, x.name, x.color])).toEqual([
      ['b_1', 10, undefined, undefined],
      [deriveBodyId('f_s', 'b_1', 1), 11, 'Plate (2)', '#123456'],
    ]);
    // Faces with history keep their names; the cut faces are the split's.
    expect(r.bodies[0].names?.faces[0]).toBe('F:f_b_1:primitive:0');
    expect(r.bodies[0].names?.faces.slice(1)).toEqual(Array.from({ length: 5 }, (_, i) => `F:f_s:cut#${i}`));
    expect(splitDef.ownsBody!(f(), deriveBodyId('f_s', 'b_1', 1))).toBe(true);
    expect(splitDef.ownsBody!(f(), 'b_1')).toBe(false);
  });

  it('a tool body goes unless it is kept; the split uses it', async () => {
    const k = scriptKernel().on('split', () => pieces([10, 11]));
    const bodies = [b('b_1', 1), b('b_2', 2)];
    let r = await splitDef.build(f({ tool: { kind: 'body', body: 'b_2', keepTool: false } }), { offset: 0 }, ctxOf(k, bodies, { doc }));
    expect(k.calls.find((c) => c.op === 'split')!.params).toEqual({ id: 1, tool: 2 });
    expect(r).toMatchObject({ ok: true, removed: ['b_2'] });
    r = await splitDef.build(f({ tool: { kind: 'body', body: 'b_2', keepTool: true } }), { offset: 0 }, ctxOf(k, bodies, { doc }));
    expect(r).toMatchObject({ ok: true, removed: [] });
    expect(splitDef.uses!(f({ tool: { kind: 'body', body: 'b_2', keepTool: true } }))).toEqual(['b_1', 'b_2']);
    expect(splitDef.incomplete(f({ tool: { kind: 'body', body: 'b_1', keepTool: true } }), units)).toBe('A body cannot split itself: take it out of the bodies to split');
  });

  it("a flat face's plane: its centroid and normal", async () => {
    const face: PersistentRef = { name: 'F:f_b_2:primitive:5', signature: { kind: 'face', type: 'plane', size: 100, at: [0, 0, 7], dir: [0, 0, 1] } };
    const k = scriptKernel()
      .on('split', () => pieces([10, 11]))
      .on('topo', () => ({ faces: [{ i: 5, type: 'plane', area: 100, centroid: [3, 4, 7], normal: [0, 0, 1] }], edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} }));
    await splitDef.build(f({ tool: { kind: 'face', body: 'b_2', face } }), { offset: 0 }, ctxOf(k, [b('b_1', 1), b('b_2', 2)], { doc }));
    expect(k.calls.find((c) => c.op === 'split')!.params).toEqual({ id: 1, plane: { origin: [3, 4, 7], normal: [0, 0, 1] } });
  });

  it('a plane that misses every target is red; one that misses some is amber', async () => {
    let k = scriptKernel().on('split', () => pieces([10]));
    let ctx = ctxOf(k, [b('b_1', 1)], { doc });
    let r = await splitDef.build(f(), { offset: 0 }, ctx);
    expect(r).toEqual({ ok: false, message: 'Split 1 failed: the Right plane does not cut Plate' });
    expect(ctx.releasedByCtx).toEqual([10]);
    let n = 0;
    k = scriptKernel().on('split', () => (n++ === 0 ? pieces([10, 11]) : pieces([12])));
    ctx = ctxOf(k, [b('b_1', 1), b('b_2', 2)], { doc });
    r = await splitDef.build(f({ targets: ['b_1', 'b_2'] }), { offset: 0 }, ctx);
    expect(r).toMatchObject({ ok: true, warning: 'the Right plane does not cut Cutter' });
    expect(ctx.releasedByCtx).toEqual([12]);
  });

  it('an invalid piece is red with Try repair; then ShapeFix', async () => {
    const bad = () => pieces([10, 11], { valid: false, pieces_valid: [true, false], piece_problems: { '1': { valid: false, reason: 'invalid result (BRepCheck): NotClosed x1' } } });
    let k = scriptKernel().on('split', bad);
    let r = await splitDef.build(f(), { offset: 0 }, ctxOf(k, [b('b_1', 1)], { doc }));
    expect(r).toEqual({ ok: false, message: 'Split 1 failed: piece 2 of Plate: the result is not a valid solid: (BRepCheck): NotClosed x1', actions: ['repair'] });
    k = scriptKernel()
      .on('split', bad)
      .on('repair', () => ({ id: 50, valid: true, fixed: true, before: { faces: 6, edges: 12, vertices: 8 }, after: { faces: 6, edges: 12, vertices: 8 } }))
      .on('props', () => ({ faces: 6, edges: 12, vertices: 8, solids: 1, shells: 1, volume: 10, bbox_mode: 'none', timings: {} }));
    r = await splitDef.build({ ...f(), repair: { fuzzy: 0.001 } } as SplitFeature, { offset: 0 }, ctxOf(k, [b('b_1', 1)], { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'piece 2 of Plate was repaired: check the result' });
    if (r.ok) expect(r.bodies[1]).toMatchObject({ shape: 50, valid: true, names: null });
  });

  it('a split that lost part of the body (OCCT dropped a piece) is red with the kernel reason, not "does not cut"', async () => {
    // The 113 MB part at its middle X plane: one "valid" piece of half the volume, lost_faces > 0.
    const reason = "split lost part of the body: 5989 of its faces are in no piece (OCCT's splitter)";
    const k = scriptKernel().on('split', () => pieces([10], { valid: false, lost_faces: 5989, reason }));
    const ctx = ctxOf(k, [b('b_1', 1)], { doc });
    const r = await splitDef.build(f(), { offset: 0 }, ctx);
    expect(r).toEqual({ ok: false, message: `Split 1 failed: Plate: ${reason}` });
    expect(ctx.releasedByCtx).toEqual([10]);
  });

  it('expressions: only the plane offset', () => {
    expect(splitDef.exprs!(f({ tool: { kind: 'plane', plane: 'origin:top', offset: 'w/2' } }))).toEqual([{ path: 'tool.offset', expr: 'w/2' }]);
    expect(splitDef.exprs!(f({ tool: { kind: 'body', body: 'b_2', keepTool: false } }))).toEqual([]);
    expect(splitDef.resolve(f({ tool: { kind: 'plane', plane: 'origin:top', offset: 'nope' } }), units)).toMatchObject({ ok: false });
  });
});

describe('Delete faces build', () => {
  const names = indexedNames('f_b_1', 'primitive', 6);
  const ref = (i: number): PersistentRef => ({ name: names.faces[i], signature: { kind: 'face', type: 'cylinder', at: [i === 4 ? -20 : 20, 0, 5], dir: [0, 0, 1], radius: 5 } });
  const del = (over: Partial<DeleteFacesFeature> = {}): DeleteFacesFeature => ({ id: 'f_d', type: 'delete_faces', name: 'Delete faces 1', body: 'b_1', faces: [ref(4), ref(5)], ...over });
  // Two holes: the topo of the faces asked for.
  const topo = (p: Record<string, unknown>) => ({ faces: [4, 5].filter((i) => p.faces === 'all' || (p.faces as number[]).includes(i)).map((i) => ({ i, type: 'cylinder', area: 300, centroid: [i === 4 ? -20 : 20, 0, 5], axis: { origin: [i === 4 ? -20 : 20, 0, 0], dir: [0, 0, 1] }, radius: 5 })), edges: [], vertices: [], counts: { faces: 6, edges: 0, vertices: 0 }, timings: {} });

  it('every face asked for must be gone: OCCT keeping one is red, not a quiet partial result', async () => {
    const k = scriptKernel()
      .on('topo', topo)
      .on('defeature', () => ({ id: 9, valid: true, faces: 5, warnings: true, warning_text: 'BOPAlgo_AlertUnableToRemoveTheFeature', history: { faces: [], edges: [], deleted: [{ shape: 1, face: 4 }] } }));
    const ctx = ctxOf(k, [b('b_1', 1)], { doc });
    const r = await deleteFacesDef.build(del(), {}, ctx);
    expect(r).toEqual({ ok: false, message: 'Delete faces 1 failed: 1 of the 2 faces could not be removed and healed (the faces around them cannot be extended to close the gap)' });
    expect(ctx.releasedByCtx).toEqual([9]);
  });

  it('removed faces: the body keeps its id; healed faces are named by the feature', async () => {
    const k = scriptKernel()
      .on('topo', topo)
      .on('defeature', () => ({
        id: 9,
        valid: true,
        faces: 5,
        warnings: false,
        history: { faces: [0, 1, 2, 3].map((i) => ({ out: i, from: [{ shape: 1, face: i, how: 'modified' }] })), edges: [], deleted: [{ shape: 1, face: 4 }, { shape: 1, face: 5 }] },
      }));
    const r = await deleteFacesDef.build(del(), {}, ctxOf(k, [b('b_1', 1)], { doc }));
    expect(k.calls.find((c) => c.op === 'defeature')!.params).toEqual({ id: 1, faces: [4, 5] });
    expect(r).toMatchObject({ ok: true, removed: [] });
    if (r.ok) {
      expect(r.bodies[0]).toMatchObject({ id: 'b_1', shape: 9, valid: true });
      expect(r.bodies[0].names?.faces).toEqual([...names.faces.slice(0, 4), 'F:f_d:heal']);
    }
  });

  it('an invalid result offers Try repair once (ShapeFix); a failed repair offers nothing more', async () => {
    const bad = () => ({ id: 9, valid: false, reason: 'invalid result (BRepCheck): NotClosed x1', faces: 4, warnings: false, history: { faces: [], edges: [], deleted: [{ shape: 1, face: 4 }, { shape: 1, face: 5 }] } });
    let r = await deleteFacesDef.build(del(), {}, ctxOf(scriptKernel().on('topo', topo).on('defeature', bad), [b('b_1', 1)], { doc }));
    expect(r).toMatchObject({ ok: false, actions: ['repair'] });
    r = await deleteFacesDef.build({ ...del(), repair: { fuzzy: 0.001 } } as DeleteFacesFeature, {}, ctxOf(scriptKernel().on('topo', topo).on('defeature', bad), [b('b_1', 1)], { doc }));
    expect(r).toEqual({ ok: false, message: 'Delete faces 1 failed: the result is not a valid solid: (BRepCheck): NotClosed x1 (repair did not fix it)', actions: undefined });
  });

  it('a body that is not there is said', async () => {
    const r = await deleteFacesDef.build(del({ body: 'b_7' }), {}, ctxOf(scriptKernel(), [], { doc }));
    expect(r).toEqual({ ok: false, message: 'Delete faces 1 failed: a deleted body is not there at this point' });
    expect(deleteFacesDef.incomplete(del({ faces: [] }), units)).toBe('Select the faces to delete');
  });
});
