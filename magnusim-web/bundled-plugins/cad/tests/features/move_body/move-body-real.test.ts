// @vitest-environment node
// Move/copy body (Daniel 2026-10-30: a body could not be moved after it was made) through the
// document on the real kernel: a move along X, a turn about Z through the centre of the body's box,
// a turn about a reference axis (the origin's X axis) and about one of the body's own edges, both
// together (it turns first, then moves), Keep a copy (the original stays, "Body 1 (Copy)" is a new
// body whose faces are named as a pattern copy's, "Body 1 (Copy 2)" for a second copy, a Combine
// can use it), a fillet made after the move on the moved body's edge that still builds when the
// move is edited, Undo, suppress, and the honest failures (nothing to move, a bad expression, a
// flat face as the axis, a body that is not there). Review fix: a hole sketched on the moved body's
// face stays in the body when the move's distance or turn is edited or a move is put in before it,
// and references on a turned body (a fillet's edge, a sketch's face) stay clean, with no repair.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { moveBodyDef, NOTHING_TO_MOVE } from '../../../src/features/move_body/feature';
import { forgetBreps } from '../../../src/features/import/feature';
import type { MoveBodyFeature } from '../../../src/types/doc';
import type { FeatureTypeDef } from '../../../src/types/doc-service';
import type { BodyInfo } from '../../../src/types/kernel';
import type { RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, close, edgeRef, faceRef, onFace, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo, volume } from '../solids/solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part() {
  const r = await openSolids();
  if (!r.doc.features.get('move_body')) r.doc.features.register(moveBodyDef as unknown as FeatureTypeDef);
  open.push(r);
  return r;
}

const bodies = (r: RealDoc) => r.doc.state.get().rebuild.bodies;
const named = (r: RealDoc, name: string) => {
  const b = bodies(r).find((x) => x.name === name);
  if (!b) throw new Error(`no body ${name}: ${bodies(r).map((x) => x.name).join(', ')}`);
  return b;
};
/** The body's box, rounded to 1e-6 mm: [xmin, ymin, zmin, xmax, ymax, zmax]. */
const box = (b: BodyInfo) => b.bbox.map((v) => Math.round(v * 1e6) / 1e6 + 0);

/** A W x D x H block from a Top sketch with its corner at (x, y), its body id. */
async function block(r: RealDoc, w: number, d: number, h: number, x = 0, y = 0) {
  const sk = new SketchBuilder();
  sk.rect(x, y, x + w, y + d);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` } });
  expect(ex.status.state).toBe('ok');
  return bodies(r).at(-1)!.id;
}

const move = (bodyIds: string[], o: Partial<MoveBodyFeature> = {}) => ({ bodies: bodyIds, ...o }) as Record<string, unknown>;
const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** Edit a feature with `patch` (one panel session) and wait for the rebuild. */
async function edit(r: RealDoc, id: string, patch: Record<string, unknown>) {
  const s = r.doc.beginEdit(id);
  s.update(patch as never);
  s.commit();
  return settle(r.doc);
}

/** A hole 4 mm across and 4 mm deep at (x, y) of the top face of the first body: its sketch and its cut. */
async function holeOnTop(r: RealDoc, x: number, y: number) {
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const top = t.faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
  const sk = new SketchBuilder();
  sk.circle([x, y], 2);
  const sketch = await addSketch(r, await onFace(r, b, top.i, sk));
  const cut = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: '4 mm' }, op: 'cut', creates: null, flip: true });
  expect(cut.status.state).toBe('ok');
  return { sketch, cut: cut.id };
}

/** Where the hole is: the middle of its round face (2 mm radius). */
async function holeAt(r: RealDoc): Promise<number[]> {
  const t = await topo(r, bodies(r)[0]);
  const c = t.faces.filter((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 2) < 1e-6);
  expect(c).toHaveLength(1);
  return c[0].centroid!.map(round);
}

const HOLED = 2000 - Math.PI * 2 * 2 * 4;

describe('Move/copy body: moves and turns', () => {
  it('a move along X keeps the body, its name and its faces; Undo puts it back', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const before = bodies(r)[0];
    const faceNames = before.names!.faces;
    const m = await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'] }));
    expect(m.status).toMatchObject({ state: 'ok' });
    const after = bodies(r);
    expect(after.map((x) => [x.id, x.name])).toEqual([[b, 'Body 1']]);
    expect(box(after[0])).toEqual([20, 0, 0, 40, 10, 10]);
    expect(after[0].names!.faces).toEqual(faceNames);
    expect(close(await volume(r, b), 2000)).toBe(true);
    expect(r.doc.state.get().doc.features.at(-1)!.name).toBe('Body-Move 1');
    expect(r.doc.state.get().history.undoLabel).toBe('Body-Move 1');
    r.doc.undo();
    await settle(r.doc);
    expect(box(bodies(r)[0])).toEqual([0, 0, 0, 20, 10, 10]);
    r.doc.redo();
    await settle(r.doc);
    expect(box(bodies(r)[0])).toEqual([20, 0, 0, 40, 10, 10]);
    // Suppressed, the body is where it was; back on, moved again.
    expect(r.doc.setSuppressed(m.id, true)).toEqual({ ok: true });
    await settle(r.doc);
    expect(box(bodies(r)[0])).toEqual([0, 0, 0, 20, 10, 10]);
  });

  it('a turn of 90 deg about Z goes through the centre of the body\'s box (no pivot typed); a typed pivot moves it', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'z' }));
    expect(m.status).toMatchObject({ state: 'ok' });
    // Centre (10, 5, 5): x 10 +- 5, y 5 +- 10.
    expect(box(bodies(r)[0])).toEqual([5, -5, 0, 15, 15, 10]);
    expect(r.doc.state.get().rebuild.outputs[m.id]).toMatchObject({ type: 'move_body', centre: [10, 5, 5], axis: { origin: [10, 5, 5], dir: [0, 0, 1] } });
    // Pivot at the origin: (x, y) -> (-y, x).
    const s = r.doc.beginEdit(m.id);
    s.update({ pivot: ['0 mm', '0 mm', '0 mm'] } as never);
    s.commit();
    await settle(r.doc);
    expect(box(bodies(r)[0])).toEqual([-10, 0, 0, 0, 20, 10]);
  });

  it('a turn about a reference axis (the origin X axis) and about an edge of the body itself', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'axis', axis: { kind: 'origin', axis: 'origin:x' } }));
    expect(m.status).toMatchObject({ state: 'ok' });
    // About the X axis itself: (y, z) -> (-z, y).
    expect(box(bodies(r)[0])).toEqual([0, -10, 0, 20, 0, 10]);
    // About the body's own vertical edge at x = 20, y = 10 (a straight edge gives its line).
    const s0 = r.doc.beginEdit(m.id);
    s0.update({ angle: '0 deg', move: ['1 mm', '0 mm', '0 mm'] } as never);
    s0.commit();
    await settle(r.doc);
    const r0 = r.doc.state.get().doc.features.findIndex((f) => f.id === m.id);
    r.doc.setRollback(r0);
    await settle(r.doc);
    const t = await topo(r, bodies(r)[0]);
    const edge = t.edges.find((e) => e.type === 'line' && Math.abs(e.first![0] - 20) < 1e-6 && Math.abs(e.first![1] - 10) < 1e-6 && Math.abs(e.last![0] - 20) < 1e-6 && Math.abs(e.last![1] - 10) < 1e-6)!;
    expect(edge).toBeTruthy();
    const ref = await edgeRef(r, bodies(r)[0], edge.i);
    r.doc.setRollback(null);
    await settle(r.doc);
    const s = r.doc.beginEdit(m.id);
    s.update({ angle: '180 deg', move: ['0 mm', '0 mm', '0 mm'], axis: { kind: 'edge', body: b, ref } } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[m.id]).toMatchObject({ state: 'ok' });
    // Half a turn about the line x = 20, y = 10: x 20..40, y 10..20.
    expect(box(bodies(r)[0])).toEqual([20, 10, 0, 40, 20, 10]);
  });

  it('turn and move together: it turns first (about the pivot), then moves', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'z', pivot: ['0 mm', '0 mm', '0 mm'], move: ['100 mm', '0 mm', '5 mm'] }));
    expect(m.status).toMatchObject({ state: 'ok' });
    // Turned about Z at the origin: x -10..0, y 0..20; then moved +100 X, +5 Z.
    expect(box(bodies(r)[0])).toEqual([90, 0, 5, 100, 20, 15]);
  });

  it('several bodies in one feature, one transform each; a turn of 360 deg with no distance is nothing to move', async () => {
    const r = await part();
    const a = await block(r, 10, 10, 10);
    const b = await block(r, 10, 10, 10, 30, 0);
    const m = await addFeature(r, 'move_body', move([a, b], { move: ['0 mm', '50 mm', '0 mm'] }));
    expect(m.status).toMatchObject({ state: 'ok' });
    expect(bodies(r).map(box)).toEqual([
      [0, 50, 0, 10, 60, 10],
      [30, 50, 0, 40, 60, 10],
    ]);
    const units = r.doc.units;
    const f = r.doc.state.get().doc.features.find((g) => g.id === m.id) as MoveBodyFeature;
    expect(moveBodyDef.incomplete({ ...f, move: ['0 mm', '0 mm', '0 mm'], angle: '360 deg' }, units)).toBe(NOTHING_TO_MOVE);
  });
});

describe('Move/copy body: Keep a copy', () => {
  it('the original stays; the copy is a new body "Body 1 (Copy)" with its faces named as a copy; a second copy is "(Copy 2)"; Combine can use it', async () => {
    const r = await part();
    const b = await block(r, 10, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'], copy: true }));
    expect(m.status).toMatchObject({ state: 'ok' });
    expect(r.doc.state.get().doc.features.at(-1)!.name).toBe('Body-Copy 1');
    expect(bodies(r).map((x) => x.name)).toEqual(['Body 1', 'Body 1 (Copy)']);
    expect(box(named(r, 'Body 1'))).toEqual([0, 0, 0, 10, 10, 10]);
    const copy = named(r, 'Body 1 (Copy)');
    expect(box(copy)).toEqual([20, 0, 0, 30, 10, 10]);
    expect(copy.id).toBe(`${b}.${m.id.replace(/^f_/, '')}.1`);
    expect(copy.names!.faces.every((n) => n.startsWith(`F:${m.id}:i2:`))).toBe(true);
    expect(copy.color).toBe(named(r, 'Body 1').color);
    // The feature owns the copy (its BodyDef lives with it; a rename keeps).
    expect(moveBodyDef.ownsBody!(r.doc.state.get().doc.features.at(-1) as MoveBodyFeature, copy.id)).toBe(true);
    // A second copy of Body 1, turned in place.
    const m2 = await addFeature(r, 'move_body', move([b], { angle: '45 deg', copy: true }));
    expect(m2.status).toMatchObject({ state: 'ok' });
    expect(bodies(r).map((x) => x.name)).toEqual(['Body 1', 'Body 1 (Copy)', 'Body 1 (Copy 2)']);
    // A Combine joins the original and the first copy (they do not touch: one body of two solids).
    const c = await addFeature(r, 'combine', { op: 'join', targets: [b], tools: [copy.id], keepTools: false });
    expect(c.status.state === 'ok' || c.status.state === 'warning').toBe(true);
    expect(bodies(r).map((x) => x.name)).toEqual(['Body 1', 'Body 1 (Copy 2)']);
    expect(close(await volume(r, b), 2000)).toBe(true);
  });

  it('a copy in place (nothing to move) is allowed and said; without Keep a copy it is incomplete', async () => {
    const r = await part();
    const b = await block(r, 10, 10, 10);
    const units = r.doc.units;
    const blank = moveBodyDef.create(r.doc.state.get().doc, { bodies: [b] });
    expect(blank).toMatchObject({ name: 'Body-Move 1', move: ['0 mm', '0 mm', '0 mm'], angle: '0 deg', about: 'z', axis: null, pivot: null, copy: false });
    expect(moveBodyDef.incomplete(blank, units)).toBe(NOTHING_TO_MOVE);
    expect(moveBodyDef.incomplete({ ...blank, copy: true }, units)).toBeNull();
    const m = await addFeature(r, 'move_body', move([b], { copy: true }));
    expect(m.status).toMatchObject({ state: 'ok', note: 'the copy sits where the original is (no distance, no turn)' });
    expect(bodies(r).map((x) => [x.name, box(x)])).toEqual([
      ['Body 1', [0, 0, 0, 10, 10, 10]],
      ['Body 1 (Copy)', [0, 0, 0, 10, 10, 10]],
    ]);
  });
});

describe('Move/copy body: later features', () => {
  it('a fillet made after the move on the moved body\'s edge still builds; an edit of the move re-runs it', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'] }));
    const t = await topo(r, bodies(r)[0]);
    // The top edge along X at y = 10 (moved: x 20..40).
    const top = t.edges.find((e) => e.type === 'line' && Math.abs(e.first![2] - 10) < 1e-6 && Math.abs(e.last![2] - 10) < 1e-6 && Math.abs(e.first![1] - 10) < 1e-6 && Math.abs(e.last![1] - 10) < 1e-6)!;
    const ref = await edgeRef(r, bodies(r)[0], top.i);
    const fl = await addFeature(r, 'fillet', { body: b, edges: [ref], faces: [], radius: '2 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const filleted = await volume(r, b);
    expect(filleted).toBeLessThan(2000);
    // The move goes to 50 mm: the fillet follows the body, on the same edge, with no repair.
    const s = r.doc.beginEdit(m.id);
    s.update({ move: ['50 mm', '0 mm', '0 mm'] } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[m.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id]).toMatchObject({ state: 'ok' });
    expect(box(bodies(r)[0])).toEqual([50, 0, 0, 70, 10, 10]);
    expect(close(await volume(r, b), filleted, 1e-6)).toBe(true);
  });
});

describe('Move/copy body: what was made on a moved body follows it (review fix)', () => {
  it("a hole sketched on the moved body's top face stays at the body's middle when the move's distance and turn are edited; nothing says repaired", async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'] }));
    // The body carries where the move took it; a reference made on it keeps that.
    expect(bodies(r)[0].placement).toEqual([1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]);
    const h = await holeOnTop(r, 30, 5);
    const sketchRef = (r.doc.state.get().doc.features.find((f) => f.id === h.sketch) as unknown as { support: { face: { placement?: number[] } } }).support.face;
    expect(sketchRef.placement).toEqual([1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(close(await volume(r, b), HOLED)).toBe(true);
    expect(await holeAt(r)).toEqual([30, 5, 8]);
    const states = (rb: Awaited<ReturnType<typeof settle>>) => [m.id, h.sketch, h.cut].map((id) => rb.features[id]?.state);
    // 50 mm: the body, its sketch and its hole go together (the hole was lost: volume 2000).
    let rb = await edit(r, m.id, { move: ['50 mm', '0 mm', '0 mm'] });
    expect(states(rb)).toEqual(['ok', 'ok', 'ok']);
    expect(box(bodies(r)[0])).toEqual([50, 0, 0, 70, 10, 10]);
    expect(close(await volume(r, b), HOLED)).toBe(true);
    expect(await holeAt(r)).toEqual([60, 5, 8]);
    // Turned 90 deg about Z through its centre first: the hole stays at the body's middle.
    rb = await edit(r, m.id, { angle: '90 deg', about: 'z' });
    expect(states(rb)).toEqual(['ok', 'ok', 'ok']);
    expect(box(bodies(r)[0])).toEqual([55, -5, 0, 65, 15, 10]);
    expect(close(await volume(r, b), HOLED)).toBe(true);
    expect(await holeAt(r)).toEqual([60, 5, 8]);
    // Turned about X: the top face now faces -Y; the sketch keeps its face with no repair, the hole goes along.
    rb = await edit(r, m.id, { about: 'x' });
    expect(states(rb)).toEqual(['ok', 'ok', 'ok']);
    expect(box(bodies(r)[0])).toEqual([50, 0, 0, 70, 10, 10]);
    expect(close(await volume(r, b), HOLED)).toBe(true);
    expect(await holeAt(r)).toEqual([60, 2, 5]);
  });

  it('a move put in before a hole and a fillet made with no move: both go with the body, with no repair', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const h = await holeOnTop(r, 10, 5);
    // A top edge along X (y = 0), filleted.
    const t = await topo(r, bodies(r)[0]);
    const top = t.edges.find((e) => e.type === 'line' && [e.first!, e.last!].every((p) => Math.abs(p[2] - 10) < 1e-6 && Math.abs(p[1]) < 1e-6))!;
    const fl = await addFeature(r, 'fillet', { body: b, edges: [await edgeRef(r, bodies(r)[0], top.i)], faces: [], radius: '1 mm' });
    expect(fl.status.state).toBe('ok');
    const done = await volume(r, b);
    // The bar after Extrude 1: the move goes in there, turning 90 deg about Y through its centre, then 100 mm along X.
    r.doc.setRollback(2);
    await settle(r.doc);
    const m = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'y', move: ['100 mm', '0 mm', '0 mm'] }));
    r.doc.setRollback(null);
    const rb = await settle(r.doc);
    expect(r.doc.state.get().doc.features.map((f) => f.id)).toEqual([expect.any(String), expect.any(String), m.id, h.sketch, h.cut, fl.id]);
    expect([m.id, h.sketch, h.cut, fl.id].map((id) => rb.features[id]?.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
    // About Y through (10, 5, 5): x 5..15, z -5..15; then 100 along X. The hole's axis was (10, 5) at z 8: now x 113, z 5.
    expect(box(bodies(r)[0])).toEqual([105, 0, -5, 115, 10, 15]);
    expect(close(await volume(r, b), done)).toBe(true);
    expect(await holeAt(r)).toEqual([113, 5, 5]);
  });

  it('while Body-Move 1 is edited the bodies are drawn just after it (a later turning Move rolled back): what its handle drags is what is built', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m1 = await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'] }));
    const m2 = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'z', pivot: ['0 mm', '0 mm', '0 mm'] }));
    // Turned about Z at the origin: (x, y) -> (-y, x).
    expect(box(bodies(r)[0])).toEqual([-10, 20, 0, 0, 40, 10]);
    const s = r.doc.beginEdit(m1.id);
    let rb = await settle(r.doc);
    expect(rb.features[m2.id]).toMatchObject({ state: 'rolled-back' });
    expect(box(bodies(r)[0])).toEqual([20, 0, 0, 40, 10, 10]);
    s.update({ move: ['30 mm', '0 mm', '0 mm'] } as never);
    await settle(r.doc);
    expect(box(bodies(r)[0])).toEqual([30, 0, 0, 50, 10, 10]);
    s.commit();
    rb = await settle(r.doc);
    expect(rb.features[m2.id]).toMatchObject({ state: 'ok' });
    expect(box(bodies(r)[0])).toEqual([-10, 30, 0, 0, 50, 10]);
  });

  it("a fillet on a turned body's edge stays clean when the turn is edited (it read Reference repaired · check)", async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { angle: '90 deg', about: 'z' }));
    const t = await topo(r, bodies(r)[0]);
    const top = t.edges.find((e) => e.type === 'line' && [e.first!, e.last!].every((p) => Math.abs(p[2] - 10) < 1e-6))!;
    const ref = await edgeRef(r, bodies(r)[0], top.i);
    expect(ref.placement).toHaveLength(12);
    const fl = await addFeature(r, 'fillet', { body: b, edges: [ref], faces: [], radius: '2 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const filleted = await volume(r, b);
    const rb = await edit(r, m.id, { angle: '45 deg' });
    expect(rb.features[m.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id]).toEqual(expect.objectContaining({ state: 'ok' }));
    expect(rb.features[fl.id]?.message).toBeUndefined();
    expect(close(await volume(r, b), filleted, 1e-6)).toBe(true);
    // A copy carries the same placement as a moved body, then its own move; a body never moved carries none.
    const c = await addFeature(r, 'move_body', move([b], { move: ['0 mm', '40 mm', '0 mm'], copy: true }));
    expect(c.status.state).toBe('ok');
    const moved = bodies(r).find((x) => x.id === b)!.placement!;
    expect(named(r, 'Body 1 (Copy)').placement!.map(round)).toEqual(moved.map((v, i) => (i === 7 ? v + 40 : v)).map(round));
    const other = await block(r, 5, 5, 5, 100, 100);
    expect(bodies(r).find((x) => x.id === other)!.placement).toBeUndefined();
  });

  it("a moved body's split pieces carry its placement (a reference made on a piece compares where the body was made)", async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    await addFeature(r, 'move_body', move([b], { move: ['20 mm', '0 mm', '0 mm'] }));
    const sp = await addFeature(r, 'split', { targets: [b], tool: { kind: 'plane', plane: 'origin:right', offset: '30 mm' } });
    expect(sp.status.state).toBe('ok');
    expect(bodies(r).map((x) => [x.id === b ? 'kept' : 'piece', x.placement])).toEqual([
      ['kept', [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]],
      ['piece', [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]],
    ]);
  });
});

describe('Move/copy body: failures in the panel\'s words', () => {
  it('no bodies, a bad expression, a flat face as the axis, a body that is not there', async () => {
    const r = await part();
    const b = await block(r, 10, 10, 10);
    const units = r.doc.units;
    const base = moveBodyDef.create(r.doc.state.get().doc, {});
    expect(moveBodyDef.incomplete(base, units)).toBe('Pick the bodies to move');
    expect(moveBodyDef.incomplete({ ...base, bodies: [b], move: ['10 kg', '0 mm', '0 mm'] }, units)).toMatch(/^Move X: /);
    expect(moveBodyDef.incomplete({ ...base, bodies: [b], move: ['nope', '0 mm', '0 mm'] }, units)).toMatch(/^Move X: /);
    expect(moveBodyDef.incomplete({ ...base, bodies: [b], angle: '1 mm' }, units)).toMatch(/^Angle: /);
    expect(moveBodyDef.incomplete({ ...base, bodies: [b], angle: '30 deg', pivot: ['0 mm', 'x', '0 mm'] }, units)).toMatch(/^Pivot Y: /);
    expect(moveBodyDef.incomplete({ ...base, bodies: [b], angle: '30 deg', about: 'axis' }, units)).toMatch(/^Pick the axis to turn about/);
    // A flat face where a round face's axis is wanted: red, by the build, with the body where it was.
    const top = bodies(r)[0];
    const t = await topo(r, top);
    const flat = await faceRef(r, top, t.faces.findIndex((f) => f.type === 'plane'));
    const m = await addFeature(r, 'move_body', move([b], { angle: '30 deg', about: 'axis', axis: { kind: 'face-axis', body: b, ref: flat } }));
    expect(m.status.state).toBe('error');
    expect(m.status.message).toMatch(/^Body-Move 1 failed: Axis: .* has no axis \(it is flat\)$/);
    expect(box(bodies(r)[0])).toEqual([0, 0, 0, 10, 10, 10]);
    // A body that is not there at this point.
    const gone = await addFeature(r, 'move_body', move(['b_gone'], { move: ['1 mm', '0 mm', '0 mm'] }));
    expect(gone.status).toMatchObject({ state: 'error', message: 'Body-Move 2 failed: a deleted body is not there at this point' });
  });
});

describe("Move/copy body: what the view's handle reads of the build", () => {
  it('the transform it applied, and a picked axis found also with no turn (its ring); none for a flat face with no turn, which still builds', async () => {
    const r = await part();
    const b = await block(r, 20, 10, 10);
    const m = await addFeature(r, 'move_body', move([b], { move: ['5 mm', '0 mm', '0 mm'], about: 'axis', axis: { kind: 'origin', axis: 'origin:x' } }));
    expect(m.status).toMatchObject({ state: 'ok' });
    const out = r.doc.state.get().rebuild.outputs[m.id] as { matrix: number[]; turnAxis: unknown; axis: unknown };
    expect(out.axis).toBeNull();
    expect(out.turnAxis).toEqual({ origin: [0, 0, 0], dir: [1, 0, 0] });
    expect(out.matrix).toEqual([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0]);
    // A turn of 90 about Z through the centre (10, 5, 5), then 5 along X: the matrix is the build's.
    const s = r.doc.beginEdit(m.id);
    s.update({ about: 'z', angle: '90 deg' } as never);
    s.commit();
    await settle(r.doc);
    const o2 = r.doc.state.get().rebuild.outputs[m.id] as { matrix: number[]; turnAxis: unknown };
    expect(o2.turnAxis).toBeNull();
    expect(o2.matrix.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, -1, 0, 20, 1, 0, 0, -5, 0, 0, 1, 0]);
    expect(box(bodies(r)[0])).toEqual([10, -5, 0, 20, 15, 10]);
    // About a flat face with no turn: it builds (nothing turns), with no axis for a ring.
    const top = bodies(r)[0];
    const t = await topo(r, top);
    const flat = await faceRef(r, top, t.faces.findIndex((f) => f.type === 'plane'));
    const m2 = await addFeature(r, 'move_body', move([b], { move: ['1 mm', '0 mm', '0 mm'], about: 'axis', axis: { kind: 'face-axis', body: b, ref: flat } }));
    expect(m2.status).toMatchObject({ state: 'ok' });
    expect((r.doc.state.get().rebuild.outputs[m2.id] as { turnAxis: unknown }).turnAxis).toBeNull();
  });
});
