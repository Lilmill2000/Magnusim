// @vitest-environment node
// The P4a solids through the document on the real kernel, as a user makes them:
// Revolve (a centerline, an origin axis, an edge; one side / symmetric / two sides;
// Cut; a profile across the axis is red with the reason), Sweep (along a path of a
// line, an arc and a line), Loft (a square to a smaller square on a face), Fillet
// (one edge; a face's edges; a radius too large is red, names the edges and suggests a
// radius, and the body before it still shows), Chamfer (two distances), Shell (inside
// and outside), the Extrude extents Through all and Up to a face or a vertex, and a flat
// face extruded directly. Volumes against analytic values.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import type { RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, body, close, edgeRef, faceRef, onFace, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo, vertexRef, volume } from './solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});
async function part() {
  const r = await openSolids();
  open.push(r);
  return r;
}

/** A W x D x H block from a Top sketch (corner at the origin): Sketch 1 + Extrude 1. */
async function block(r: RealDoc, w = 20, d = 20, h = 20) {
  const sk = new SketchBuilder();
  sk.rect(0, 0, w, d);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` } });
  expect(ex.status.state).toBe('ok');
  return { sketch, extrude: ex.id, body: body(r).id };
}

describe('Revolve', () => {
  it('a rectangle on Front about its own centerline: a tube, full and partial, then Cut', async () => {
    const r = await part();
    const sk = new SketchBuilder();
    sk.rect(10, 0, 20, 30);
    const cl = sk.line([0, -5], [0, 40], { centerline: true });
    const sketch = await addSketch(r, onPlane('origin:front', sk));
    const profiles = regionsOf(r, sketch);
    const rv = await addFeature(r, 'revolve', { profiles, axis: { kind: 'sketch-line', sketch, entity: cl } });
    expect(rv.status).toMatchObject({ state: 'ok' });
    const b = body(r);
    expect(close(await volume(r, b.id), Math.PI * 300 * 30)).toBe(true);
    expect(b.names?.faces.every((n) => n.startsWith(`F:${rv.id}:side:`))).toBe(true);
    // 90 degrees, symmetric, two sides: a quarter each time.
    for (const extent of [{ kind: 'one', angle: '90 deg' }, { kind: 'symmetric', angle: '90 deg' }, { kind: 'two', angle: '30 deg', angle2: '60 deg' }]) {
      const s = r.doc.beginEdit(rv.id);
      s.update({ extent } as never);
      s.commit();
      await settle(r.doc);
      expect(r.doc.state.get().rebuild.features[rv.id]).toMatchObject({ state: 'ok' });
      expect(close(await volume(r, body(r).id), (Math.PI * 300 * 30) / 4)).toBe(true);
      expect(body(r).names?.faces.some((n) => n === `F:${rv.id}:start`)).toBe(true);
    }
    // A cut revolve about the Z axis (an origin axis) removes a ring from the tube.
    const sk2 = new SketchBuilder();
    sk2.rect(10, 10, 20, 20);
    const s2 = await addSketch(r, onPlane('origin:front', sk2));
    const cut = await addFeature(r, 'revolve', { profiles: regionsOf(r, s2), axis: { kind: 'origin', axis: 'origin:z' }, op: 'cut', creates: null });
    expect(cut.status).toMatchObject({ state: 'ok' });
    // The quarter tube (two sides 30/60) minus the quarter of the ring z 10..20.
    expect(close(await volume(r, body(r).id), (Math.PI * 300 * 20) / 4)).toBe(true);
  });

  it('a profile across the axis is red with the reason; an axis on a straight model edge works', async () => {
    const r = await part();
    const sk = new SketchBuilder();
    sk.rect(-5, 0, 10, 10);
    const sketch = await addSketch(r, onPlane('origin:front', sk));
    const bad = await addFeature(r, 'revolve', { profiles: regionsOf(r, sketch), axis: { kind: 'origin', axis: 'origin:z' } });
    expect(bad.status).toMatchObject({ state: 'error', message: 'Revolve 1 failed: the profile crosses the axis: keep the profile on one side of the axis' });
    expect(r.doc.state.get().rebuild.bodies).toHaveLength(0);
    // A block, and a ring revolved about its vertical edge at x = 20, y = 0.
    const r2 = await part();
    const blk = await block(r2);
    const t = await topo(r2, body(r2));
    const edge = t.edges.find((e) => e.type === 'line' && Math.abs(e.mid![0] - 20) < 1e-6 && Math.abs(e.mid![1]) < 1e-6)!;
    const ref = await edgeRef(r2, body(r2), edge.i);
    const sk2 = new SketchBuilder();
    sk2.rect(30, 0, 40, 10);
    const s2 = await addSketch(r2, onPlane('origin:front', sk2));
    const rv = await addFeature(r2, 'revolve', { profiles: regionsOf(r2, s2), axis: { kind: 'edge', body: blk.body, ref } });
    expect(rv.status).toMatchObject({ state: 'ok' });
    const ring = r2.doc.state.get().rebuild.bodies.find((b) => b.feature === rv.id)!;
    expect(close(await volume(r2, ring.id), Math.PI * (400 - 100) * 10)).toBe(true);
  });
});

describe('Sweep', () => {
  it('a circle along a line, a quarter arc and a line: pi r^2 times the path length; a gap is red', async () => {
    const r = await part();
    const prof = new SketchBuilder();
    prof.circle([0, 0], 5);
    const ps = await addSketch(r, onPlane('origin:top', prof));
    const path = new SketchBuilder();
    const a = path.line([0, 0], [0, 50]);
    const b = path.arc([20, 50], [0, 50], [20, 70], false);
    const c = path.line([20, 70], [50, 70]);
    const pth = await addSketch(r, onPlane('origin:front', path));
    const sw = await addFeature(r, 'sweep', { profiles: regionsOf(r, ps), path: { sketch: pth, entities: [a, b, c] } });
    expect(sw.status).toMatchObject({ state: 'ok' });
    expect(Math.abs((await volume(r, body(r).id)) / (Math.PI * 25 * (50 + 10 * Math.PI + 30)) - 1)).toBeLessThan(1e-4);
    const names = body(r).names!.faces;
    expect(names).toContain(`F:${sw.id}:start`);
    expect(names.filter((n) => n.includes(`@${b}`))).toHaveLength(1);
    // Leaving the arc out leaves a gap: red, with the kernel's words.
    const s = r.doc.beginEdit(sw.id);
    s.update({ path: { sketch: pth, entities: [a, c] } } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[sw.id]).toMatchObject({ state: 'error', message: 'Sweep 1 failed: the path has a gap: its curves must join end to end in one chain' });
  });
});

describe('Loft', () => {
  it('a 20 mm square on Top to a 10 mm square on the face of a block 30 mm up: the frustum volume', async () => {
    const r = await part();
    // A thin plate whose top face (z = 30) carries the second profile, far to the side.
    const sk = new SketchBuilder();
    sk.rect(-10, -10, 10, 10);
    const base = await addSketch(r, onPlane('origin:top', sk));
    const plate = new SketchBuilder();
    plate.rect(-50, -50, 50, 50);
    const plateSketch = await addSketch(r, { ...onPlane('origin:top', plate) });
    const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, plateSketch), extent: { kind: 'two', distance: '30 mm', distance2: '-29 mm' } });
    expect(ex.status.state).toBe('ok');
    const b = body(r);
    const top = (await topo(r, b)).faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
    const small = new SketchBuilder();
    small.rect(-5, -5, 5, 5);
    const up = await addSketch(r, await onFace(r, b, top.i, small));
    const lf = await addFeature(r, 'loft', { sections: [...regionsOf(r, base), ...regionsOf(r, up, (p) => Math.abs(p[0]) < 6 && Math.abs(p[1]) < 6)] });
    expect(lf.status).toMatchObject({ state: 'ok' });
    const loftBody = r.doc.state.get().rebuild.bodies.find((x) => x.feature === lf.id)!;
    expect(close(await volume(r, loftBody.id), (30 / 3) * (400 + 100 + 200))).toBe(true);
    expect(loftBody.names!.faces).toContain(`F:${lf.id}:start`);
    expect(loftBody.names!.faces).toContain(`F:${lf.id}:end`);
  });
});

describe('Fillet, Chamfer, Shell', () => {
  it('Fillet: one edge removes (1 - pi/4) r^2 L; a face takes all its edges; names follow the edge', async () => {
    const r = await part();
    const blk = await block(r);
    const b = body(r);
    const t = await topo(r, b);
    const e = t.edges.find((x) => x.type === 'line' && x.mid![2] > 19.99 && Math.abs(x.mid![1]) < 1e-6)!;
    const ref = await edgeRef(r, b, e.i);
    const fl = await addFeature(r, 'fillet', { body: blk.body, edges: [ref], radius: '2 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, blk.body), 8000 - (4 - Math.PI) * 20)).toBe(true);
    expect(body(r).names!.faces).toContain(`F:${fl.id}:fillet:${ref.name}`);
    expect(r.doc.state.get().rebuild.outputs[fl.id]).toEqual({ type: 'edge-chain', picked: 1, done: 1 });
    // The top face instead: its 4 edges.
    const top = t.faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
    const s = r.doc.beginEdit(fl.id);
    s.update({ edges: [], faces: [await faceRef(r, b, top.i)] } as never);
    s.commit();
    await settle(r.doc);
    expect(r.doc.state.get().rebuild.features[fl.id]).toMatchObject({ state: 'ok' });
    expect(r.doc.state.get().rebuild.outputs[fl.id]).toEqual({ type: 'edge-chain', picked: 4, done: 4 });
  });

  it('Fillet: too large a radius is red, names the edges, suggests a radius that works; the body before it still shows', async () => {
    const r = await part();
    const blk = await block(r, 20, 20, 10);
    const b = body(r);
    const t = await topo(r, b);
    const top = t.edges.filter((x) => x.type === 'line' && x.mid![2] > 9.99);
    const refs = await Promise.all(top.map((x) => edgeRef(r, b, x.i)));
    const fl = await addFeature(r, 'fillet', { body: blk.body, edges: refs, radius: '20 mm' });
    expect(fl.status.state).toBe('error');
    expect(fl.status.message).toMatch(/^Fillet 1 failed: a radius of 20 mm is too large for (Start|End) · Side \d of Extrude 1, .+: [\d.]+ mm or less works$/);
    const suggested = Number(/: ([\d.]+) mm or less works/.exec(fl.status.message!)![1]);
    const bodies = r.doc.state.get().rebuild.bodies;
    expect(bodies).toHaveLength(1);
    expect(close(await volume(r, blk.body), 4000)).toBe(true);
    // The suggestion works.
    const s = r.doc.beginEdit(fl.id);
    s.update({ radius: `${suggested} mm` } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[fl.id]).toMatchObject({ state: 'ok' });
  });

  it('Chamfer two distances: 0.5 d1 d2 L; Shell inside and outside', async () => {
    const r = await part();
    const blk = await block(r);
    const b = body(r);
    const t = await topo(r, b);
    const e = t.edges.find((x) => x.type === 'line' && x.mid![2] > 19.99)!;
    const ch = await addFeature(r, 'chamfer', { body: blk.body, edges: [await edgeRef(r, b, e.i)], mode: 'two', distance: '2 mm', distance2: '4 mm' });
    expect(ch.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, blk.body), 8000 - 80)).toBe(true);
    expect(body(r).names!.faces.some((n) => n.startsWith(`F:${ch.id}:chamfer:E:`))).toBe(true);
    // The panel says which face Distance 1 is on (P4a review).
    const out = r.doc.state.get().rebuild.outputs[ch.id] as { distance1On?: string };
    expect(out.distance1On).toMatch(/^(End face|Side \d) of Extrude 1$/);
    // Too large: red, with what works, as Fillet says it (P4a review); the suggestion works.
    const sc = r.doc.beginEdit(ch.id);
    sc.update({ distance: '25 mm', distance2: '6 mm' } as never);
    sc.commit();
    let rb = await settle(r.doc);
    expect(rb.features[ch.id].state).toBe('error');
    const m = /^Chamfer 1 failed: distances of 25 mm and 6 mm are too large for .+: ([\d.]+) mm and ([\d.]+) mm or less work$/.exec(rb.features[ch.id].message ?? '');
    expect(m, rb.features[ch.id].message ?? '').not.toBeNull();
    const sc2 = r.doc.beginEdit(ch.id);
    sc2.update({ distance: `${m![1]} mm`, distance2: `${m![2]} mm` } as never);
    sc2.commit();
    rb = await settle(r.doc);
    expect(rb.features[ch.id]).toMatchObject({ state: 'ok' });

    const r2 = await part();
    const blk2 = await block(r2);
    const b2 = body(r2);
    const top = (await topo(r2, b2)).faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
    const sh = await addFeature(r2, 'shell', { body: blk2.body, faces: [await faceRef(r2, b2, top.i)], thickness: '2 mm' });
    expect(sh.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r2, blk2.body), 8000 - 16 * 16 * 18)).toBe(true);
    expect(body(r2).names!.faces.filter((n) => n.startsWith(`F:${sh.id}:inner:`))).toHaveLength(5);
    const s = r2.doc.beginEdit(sh.id);
    s.update({ direction: 'outside' } as never);
    s.commit();
    await settle(r2.doc);
    expect(close(await volume(r2, blk2.body), 24 * 24 * 22 - 8000)).toBe(true);
  });
});

describe('Extrude: Through all, Up to, a flat face', () => {
  it('a circle cut Through all both sides; Up to a face and to a vertex; a flat face extruded with no sketch', async () => {
    const r = await part();
    const blk = await block(r);
    // A circle on a plane in the middle (a face sketch would do too): Top plane, cut through all both ways.
    const c = new SketchBuilder();
    c.circle([10, 10], 3);
    const cs = await addSketch(r, onPlane('origin:top', c));
    const cut = await addFeature(r, 'extrude', { profiles: regionsOf(r, cs), extent: { kind: 'through_all', both: true, distance: '10 mm' }, op: 'cut', creates: null });
    expect(cut.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, blk.body), 8000 - Math.PI * 9 * 20)).toBe(true);
    // One side only, pointing away from the block: nothing to go through that way.
    const s = r.doc.beginEdit(cut.id);
    s.update({ extent: { kind: 'through_all', both: false, distance: '10 mm' }, flip: true } as never);
    s.commit();
    let rb = await settle(r.doc);
    expect(rb.features[cut.id]).toMatchObject({ state: 'error', message: 'Extrude 2 failed: Through all: there is nothing to go through in this direction (untick Flip direction or tick Both sides)' });
    r.doc.undo();
    await settle(r.doc);

    // Up to the block's top face, from a square beside it on Top: 20 high.
    const b = body(r);
    const t = await topo(r, b);
    const top = t.faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
    const sq = new SketchBuilder();
    sq.rect(40, 0, 45, 5);
    const ss = await addSketch(r, onPlane('origin:top', sq));
    const up = await addFeature(r, 'extrude', { profiles: regionsOf(r, ss), extent: { kind: 'to', target: { body: b.id, ref: await faceRef(r, b, top.i) }, offset: '0 mm', distance: '10 mm' } });
    expect(up.status).toMatchObject({ state: 'ok' });
    const post = r.doc.state.get().rebuild.bodies.find((x) => x.feature === up.id)!;
    expect(close(await volume(r, post.id), 25 * 20)).toBe(true);
    // Up to a vertex of the block, with a 5 mm offset.
    const v = t.vertices.find((x) => x.p[2] > 19.99)!;
    const s2 = r.doc.beginEdit(up.id);
    s2.update({ extent: { kind: 'to', target: { body: b.id, ref: await vertexRef(r, b, v.i) }, offset: '5 mm', distance: '10 mm' } } as never);
    s2.commit();
    rb = await settle(r.doc);
    expect(rb.features[up.id]).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, post.id), 25 * 25)).toBe(true);

    // The block's top face (with the hole) extruded 10 mm with no sketch, joined: 20 x 20 x 30, the hole through it all.
    const b2 = body(r);
    const top2 = (await topo(r, b2)).faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99 && Math.abs(f.centroid![0] - 10) < 1)!;
    const fx = await addFeature(r, 'extrude', { face: { body: b2.id, ref: await faceRef(r, b2, top2.i) }, op: 'join', creates: null, extent: { kind: 'blind', distance: '10 mm' } });
    expect(fx.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, blk.body), 20 * 20 * 30 - Math.PI * 9 * 30)).toBe(true);
    // Its sides are named by the block's edges they were swept from (merged with the block's sides in the same plane).
    expect(body(r).names!.faces.filter((n) => n.split('|').some((p) => p.startsWith(`F:${fx.id}:side:E:`))).length).toBe(5);
  });
});

describe('Extrude along a direction', () => {
  it('a square on Top along a slanted line of a Front sketch: area x height; a direction in the plane is red', async () => {
    const r = await part();
    const sq = new SketchBuilder();
    sq.rect(0, 0, 10, 10);
    const s = await addSketch(r, onPlane('origin:top', sq));
    const ln = new SketchBuilder();
    const slant = ln.line([0, 0], [10, 10], { construction: true });
    const flat = ln.line([0, 0], [10, 0], { construction: true });
    const ls = await addSketch(r, onPlane('origin:front', ln));
    const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, s), extent: { kind: 'blind', distance: '20 mm' }, direction: { kind: 'sketch-line', sketch: ls, entity: slant } });
    expect(ex.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, body(r).id), (100 * 20) / Math.SQRT2)).toBe(true);
    expect(body(r).bbox[3]).toBeCloseTo(10 + 20 / Math.SQRT2, 3);
    const rb = await (async () => {
      const se = r.doc.beginEdit(ex.id);
      se.update({ direction: { kind: 'sketch-line', sketch: ls, entity: flat } } as never);
      se.commit();
      return settle(r.doc);
    })();
    expect(rb.features[ex.id]).toMatchObject({ state: 'error', message: "Extrude 1 failed: the direction lies in the profile's plane: pick one that leaves it" });
  });
});
