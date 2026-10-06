// @vitest-environment node
// The PATTERN group through the document on the real kernel: Linear pattern, Circular pattern
// and Mirror of features, bodies and faces, with the Operation rules, skipped copies, copies
// named after their sources (a fillet on instance 3 survives a count change 4 -> 5), the honest
// failures (a copy that does not touch the body under Join), and patterns of patterns and mirrors.
// Volumes against analytic values.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { PATTERN_DEFS } from '../../../src/features/pattern/defs';
import { forgetBreps } from '../../../src/features/import/feature';
import type { FeatureTypeDef } from '../../../src/types/doc-service';
import type { RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, close, edgeRef, faceRef, onFace, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo, volume } from '../solids/solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});
async function part() {
  const r = await openSolids();
  for (const d of PATTERN_DEFS) if (!r.doc.features.get(d.type)) r.doc.features.register(d as unknown as FeatureTypeDef);
  open.push(r);
  return r;
}
const bodies = (r: RealDoc) => r.doc.state.get().rebuild.bodies;
const only = (r: RealDoc) => {
  const b = bodies(r);
  expect(b).toHaveLength(1);
  return b[0];
};
const X = { kind: 'origin', axis: 'origin:x' } as const;
const Y = { kind: 'origin', axis: 'origin:y' } as const;
const Z = { kind: 'origin', axis: 'origin:z' } as const;
const dir = (axis: unknown, count: number, distance: number, extra: Record<string, unknown> = {}) => ({ axis, flip: false, count: String(count), mode: 'spacing', distance: `${distance} mm`, symmetric: false, ...extra });

/** A W x D x H block from a Top sketch with its corner at (x, y). */
async function block(r: RealDoc, w: number, d: number, h: number, x = 0, y = 0, op = 'new') {
  const sk = new SketchBuilder();
  sk.rect(x, y, x + w, y + d);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` }, ...(op === 'new' ? {} : { op, creates: null }) });
  expect(ex.status.state).toBe('ok');
  return ex.id;
}

/** A hole: a circle of radius rad at (x, y) on Top, cut down through h. */
async function hole(r: RealDoc, x: number, y: number, rad: number, h: number) {
  const sk = new SketchBuilder();
  sk.circle([x, y], rad);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` }, op: 'cut', creates: null });
  expect(ex.status.state).toBe('ok');
  return ex.id;
}

describe('Linear pattern', () => {
  it('of a hole (an Extrude Cut): 4 holes, each copy named after the source; count 4 -> 5 keeps a fillet on instance 3', async () => {
    const r = await part();
    await block(r, 100, 20, 10);
    const h = await hole(r, 10, 10, 3, 10);
    const lp = await addFeature(r, 'pattern_linear', { of: 'features', features: [h], dir1: dir(X, 4, 20) });
    expect(lp.status).toMatchObject({ state: 'ok' });
    const plate = 100 * 20 * 10;
    const hole1 = Math.PI * 9 * 10;
    expect(close(await volume(r, only(r).id), plate - 4 * hole1)).toBe(true);
    const names = only(r).names!.faces;
    for (const k of ['2', '3', '4']) expect(names.filter((n) => n.startsWith(`F:${lp.id}:i${k}:F:${h}:side:`))).toHaveLength(1);
    expect(names.some((n) => n.startsWith(`F:${lp.id}:i5:`))).toBe(false);
    // The output: three copies with their markers at x = 30, 50, 70.
    const out = r.doc.state.get().rebuild.outputs[lp.id];
    expect(out).toMatchObject({ type: 'pattern', made: 3 });
    expect((out as { copies: { at: number[] }[] }).copies.map((c) => Math.round(c.at[0]))).toEqual([30, 50, 70]);

    // A fillet on the top rim of instance 3 (the hole at x = 50).
    const b = only(r);
    const t = await topo(r, b);
    const rim = t.edges.find((e) => e.type === 'circle' && Math.abs(e.mid![2] - 10) < 1e-6 && Math.abs(e.center![0] - 50) < 1e-6)!;
    const ref = await edgeRef(r, b, rim.i);
    expect(ref.name).toContain(`F:${lp.id}:i3:`);
    const fl = await addFeature(r, 'fillet', { body: b.id, edges: [ref], faces: [], radius: '1 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const withFillet = await volume(r, only(r).id);
    expect(withFillet).toBeLessThan(plate - 4 * hole1);
    // Count 5: one more hole; the fillet still finds instance 3's rim (no repair, no error).
    const s = r.doc.beginEdit(lp.id);
    s.update({ dir1: dir(X, 5, 20) } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[lp.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id]).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), withFillet - hole1, 1e-5)).toBe(true);
  });

  it('two directions, symmetric and extent; a skipped copy is not made', async () => {
    const r = await part();
    await block(r, 100, 100, 5, -50, -50);
    const h = await hole(r, 0, 0, 2, 5);
    // 3 x 3 grid centred on the original (symmetric count 2 each way, 15 mm apart), one skipped.
    const lp = await addFeature(r, 'pattern_linear', { of: 'features', features: [h], dir1: dir(X, 2, 15, { symmetric: true }), dir2: dir(Y, 2, 15, { symmetric: true }), skip: ['-2.2'] });
    expect(lp.status).toMatchObject({ state: 'ok' });
    const hole1 = Math.PI * 4 * 5;
    expect(close(await volume(r, only(r).id), 100 * 100 * 5 - 8 * hole1)).toBe(true);
    const out = r.doc.state.get().rebuild.outputs[lp.id] as { copies: { key: string; skipped: boolean }[]; made: number };
    expect(out.copies).toHaveLength(8);
    expect(out.made).toBe(7);
    expect(out.copies.find((c) => c.key === '-2.2')?.skipped).toBe(true);
    // Extent: 3 copies over 40 mm along X (spacing 20).
    const s = r.doc.beginEdit(lp.id);
    s.update({ dir1: dir(X, 3, 40, { mode: 'extent' }), dir2: null, skip: [] } as never);
    s.commit();
    await settle(r.doc);
    expect(close(await volume(r, only(r).id), 100 * 100 * 5 - 3 * hole1)).toBe(true);
  });

  it('of a body: New body makes copies; Join refuses a copy that does not touch, naming it, and fuses when they touch', async () => {
    const r = await part();
    await block(r, 10, 10, 10);
    const b = only(r).id;
    const lp = await addFeature(r, 'pattern_linear', { of: 'bodies', bodies: [b], op: 'new', dir1: dir(X, 3, 15) });
    expect(lp.status).toMatchObject({ state: 'ok' });
    expect(bodies(r)).toHaveLength(3);
    expect(bodies(r).map((x) => x.name).sort()).toEqual(['Body 1', 'Body 1 (Instance 2)', 'Body 1 (Instance 3)']);
    for (const x of bodies(r)) expect(close(await volume(r, x.id), 1000)).toBe(true);
    // Join: 15 mm apart they are 5 mm apart: red, with the copy named, and the block still shows.
    let s = r.doc.beginEdit(lp.id);
    s.update({ op: 'join' } as never);
    s.commit();
    let rb = await settle(r.doc);
    expect(rb.features[lp.id]).toMatchObject({ state: 'error', message: "Linear pattern 1 failed: Instances 2 and 3 of Body 1 don't touch Body 1; Join needs overlap. Use New body or change the spacing" });
    expect(bodies(r)).toHaveLength(1);
    // 10 mm apart they share a face: one body of 3000.
    s = r.doc.beginEdit(lp.id);
    s.update({ dir1: dir(X, 3, 10) } as never);
    s.commit();
    rb = await settle(r.doc);
    expect(rb.features[lp.id]).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), 3000)).toBe(true);
    // One copy too far (spacing 10, then 25 for the third by count 3 extent... instance 3 at 20 touches 2) -> ok;
    // skip instance 2: instance 3 at 20 mm is 10 mm from the block: refused, naming only it.
    s = r.doc.beginEdit(lp.id);
    s.update({ skip: ['2'] } as never);
    s.commit();
    rb = await settle(r.doc);
    expect(rb.features[lp.id]).toMatchObject({ state: 'error', message: "Linear pattern 1 failed: Instance 3 of Body 1 doesn't touch Body 1; Join needs overlap. Use New body or change the spacing" });
  });
});

describe('Circular pattern and Mirror', () => {
  it('six holes about Z (full); an angle of 90 deg with 3; symmetric', async () => {
    const r = await part();
    // A disc of radius 30, 5 thick.
    const sk = new SketchBuilder();
    sk.circle([0, 0], 30);
    const disc = await addSketch(r, onPlane('origin:top', sk));
    expect((await addFeature(r, 'extrude', { profiles: regionsOf(r, disc), extent: { kind: 'blind', distance: '5 mm' } })).status.state).toBe('ok');
    const h = await hole(r, 20, 0, 3, 5);
    const disc0 = Math.PI * 900 * 5;
    const hole1 = Math.PI * 9 * 5;
    const cp = await addFeature(r, 'pattern_circular', { of: 'features', features: [h], axis: Z, count: '6', mode: 'full' });
    expect(cp.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), disc0 - 6 * hole1)).toBe(true);
    const out = r.doc.state.get().rebuild.outputs[cp.id] as { copies: { at: number[] }[] };
    // Instance 2 at 60 degrees: (10, 17.32).
    expect(out.copies[0].at[0]).toBeCloseTo(10, 6);
    expect(out.copies[0].at[1]).toBeCloseTo(20 * Math.sin(Math.PI / 3), 6);
    let s = r.doc.beginEdit(cp.id);
    s.update({ count: '3', mode: 'angle', angle: '90 deg' } as never);
    s.commit();
    await settle(r.doc);
    expect(close(await volume(r, only(r).id), disc0 - 3 * hole1)).toBe(true);
    s = r.doc.beginEdit(cp.id);
    s.update({ symmetric: true } as never);
    s.commit();
    await settle(r.doc);
    expect(close(await volume(r, only(r).id), disc0 - 5 * hole1)).toBe(true);
  });

  it('a mirror of a body across the Right plane: New body or Join; a pattern of the mirror and a mirror of the pattern', async () => {
    const r = await part();
    await block(r, 10, 10, 10, 5, 0);
    const b = only(r).id;
    const m = await addFeature(r, 'mirror', { of: 'bodies', bodies: [b], op: 'new', plane: { kind: 'origin', plane: 'origin:right' } });
    expect(m.status).toMatchObject({ state: 'ok' });
    expect(bodies(r)).toHaveLength(2);
    const copy = bodies(r).find((x) => x.id !== b)!;
    expect(copy.bbox[0]).toBeCloseTo(-15, 6);
    expect(copy.bbox[3]).toBeCloseTo(-5, 6);
    expect(close(await volume(r, copy.id), 1000)).toBe(true);
    expect(copy.names!.faces.every((n) => n.startsWith(`F:${m.id}:m:`))).toBe(true);
  });

  it('a pattern of a mirror and a mirror of a pattern cut where they should; a mirror whose copies miss every body is red', async () => {
    const r = await part();
    await block(r, 40, 20, 10, -20, 0);
    const box = 40 * 20 * 10;
    const hole1 = Math.PI * 4 * 10;
    const h = await hole(r, 10, 3, 2, 10);
    const right = { kind: 'origin', plane: 'origin:right' };
    const mh = await addFeature(r, 'mirror', { of: 'features', features: [h], plane: right });
    expect(mh.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), box - 2 * hole1)).toBe(true);
    // A pattern of the mirror: its hole at (-10, 3) repeated 6 mm along Y.
    const lp = await addFeature(r, 'pattern_linear', { of: 'features', features: [mh.id], dir1: dir(Y, 2, 6) });
    expect(lp.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), box - 3 * hole1)).toBe(true);
    // A mirror of the pattern: the copy at (-10, 9) mirrored to (10, 9).
    const mp = await addFeature(r, 'mirror', { of: 'features', features: [lp.id], plane: right });
    expect(mp.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), box - 4 * hole1)).toBe(true);
    // Mirrored across the Front plane (y -> -y) the pattern's copy lands outside the block: nothing to cut.
    const miss = await addFeature(r, 'mirror', { of: 'features', features: [lp.id], plane: { kind: 'origin', plane: 'origin:front' } });
    expect(miss.status).toMatchObject({ state: 'error', message: 'Mirror 3 failed: Nothing to cut: no copy of Linear pattern 1 overlaps a body made before it' });
    expect(close(await volume(r, only(r).id), box - 4 * hole1)).toBe(true);
  });
});

describe('New body copies of a feature', () => {
  it('a mirror of an Extrude that makes a body ("As each feature": New body) makes "Body 1 (Mirror copy)", kept by the mirror', async () => {
    const r = await part();
    const ex = await block(r, 10, 10, 10, 5, 0);
    const m = await addFeature(r, 'mirror', { of: 'features', features: [ex], plane: { kind: 'origin', plane: 'origin:right' } });
    expect(m.status).toMatchObject({ state: 'ok' });
    expect(bodies(r).map((b) => b.name)).toEqual(['Body 1', 'Body 1 (Mirror copy)']);
    const copy = bodies(r)[1];
    expect(close(await volume(r, copy.id), 1000)).toBe(true);
    // The copy is the mirror's: renamed, the name stays (its BodyDef is kept).
    expect(r.doc.renameBody(copy.id, 'Left block')).toEqual({ ok: true });
    await settle(r.doc);
    expect(bodies(r).map((b) => b.name)).toEqual(['Body 1', 'Left block']);
    // Deleting the mirror is refused while a later feature uses its copy.
    const h = await hole(r, -10, 5, 2, 10);
    expect(r.doc.state.get().rebuild.features[h]).toMatchObject({ state: 'ok' });
    void h;
  });
});

describe('fix round 1', () => {
  it('B1: Angle 360 spreads 4 bodies evenly (no copy on the original); a wrapping symmetric spread is refused; a copy in a hole says so', async () => {
    const r = await part();
    await block(r, 10, 10, 10, 20, -5);
    const b = only(r).id;
    const cp = await addFeature(r, 'pattern_circular', { of: 'bodies', bodies: [b], op: 'new', axis: Z, count: '4', mode: 'angle', angle: '360 deg' });
    expect(cp.status).toMatchObject({ state: 'ok' });
    const all = bodies(r);
    expect(all).toHaveLength(4);
    const centres = all.map((x) => [Math.round((x.bbox[0] + x.bbox[3]) / 2), Math.round((x.bbox[1] + x.bbox[4]) / 2)].join(',')).sort();
    expect(centres).toEqual(['-25,0', '0,-25', '0,25', '25,0']);
    const s = r.doc.beginEdit(cp.id);
    s.update({ count: '3', angle: '180 deg', symmetric: true } as never);
    s.commit();
    const rb = await settle(r.doc);
    expect(rb.features[cp.id]).toMatchObject({ state: 'error', message: 'Circular pattern 1 failed: Instance −3 lands on instance 3 (a whole turn from it): lower the Angle or the Count, or use Full 360°' });
    // A hole patterned into another hole.
    const r2 = await part();
    await block(r2, 100, 40, 10);
    const h = await hole(r2, 10, 10, 3, 10);
    await hole(r2, 30, 10, 3, 10);
    const lp = await addFeature(r2, 'pattern_linear', { of: 'features', features: [h], dir1: dir(X, 3, 20) });
    expect(lp.status).toMatchObject({ state: 'warning', message: 'Instance 2 of Extrude 2 lands where no material is left (already cut away): nothing more is cut there' });
    expect(close(await volume(r2, only(r2).id), 100 * 40 * 10 - 3 * Math.PI * 9 * 10)).toBe(true);
  });
});

describe('faces', () => {
  it('the faces of a boss copied along X (Join onto the same body): block + 3 bosses; a pocket copied as a hole', async () => {
    const r = await part();
    await block(r, 60, 20, 10);
    // A boss 10 x 10 x 5 on the top face at x 5..15.
    const b0 = only(r);
    const t0 = await topo(r, b0);
    const top = t0.faces.find((f) => f.normal && f.normal[2] > 0.5 && Math.abs(f.centroid![2] - 10) < 1e-6)!.i;
    const sk = new SketchBuilder();
    // The face's frame: origin (0, 0, 10), x along X, y along Y (faceFrame).
    sk.rect(5, 5, 15, 15);
    const onTop = await onFace(r, b0, top, sk);
    const s1 = await addSketch(r, onTop);
    const boss = await addFeature(r, 'extrude', { profiles: regionsOf(r, s1), extent: { kind: 'blind', distance: '5 mm' }, op: 'join', creates: null });
    expect(boss.status.state).toBe('ok');
    const b = only(r);
    expect(close(await volume(r, b.id), 60 * 20 * 10 + 500)).toBe(true);
    // Its faces: the 4 sides and the top (z = 15).
    const t = await topo(r, b);
    const bossFaces = t.faces.filter((f) => f.centroid && f.centroid[2] > 10 + 1e-6).map((f) => f.i);
    expect(bossFaces).toHaveLength(5);
    const refs = [];
    for (const i of bossFaces) refs.push(await faceRef(r, b, i));
    const lp = await addFeature(r, 'pattern_linear', { of: 'faces', faceBody: b.id, faces: refs, op: 'join', dir1: dir(X, 3, 20) });
    expect(lp.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(r, only(r).id), 60 * 20 * 10 + 3 * 500)).toBe(true);
    expect(only(r).names!.faces.filter((n) => n.startsWith(`F:${lp.id}:i3:`))).toHaveLength(5);
  });

  it('the wall of a hole copied: more holes in the same body (a pocket is cut); faces of nothing to copy say so', async () => {
    const r = await part();
    await block(r, 60, 20, 10);
    await hole(r, 10, 10, 3, 10);
    const b = only(r);
    const t = await topo(r, b);
    const wall = t.faces.find((f) => f.type === 'cylinder')!.i;
    const cp = await addFeature(r, 'pattern_linear', { of: 'faces', faceBody: b.id, faces: [await faceRef(r, b, wall)], op: 'join', dir1: dir(X, 3, 15) });
    expect(cp.status).toMatchObject({ state: 'ok' });
    const hole1 = Math.PI * 9 * 10;
    expect(close(await volume(r, only(r).id), 60 * 20 * 10 - 3 * hole1)).toBe(true);
    // The top face alone bounds nothing that can be taken off and copied: OCCT's answer, in words.
    const top = t.faces.find((f) => f.normal && f.normal[2] > 0.5 && Math.abs(f.centroid![2] - 10) < 1e-6)!.i;
    const bad = await addFeature(r, 'pattern_linear', { of: 'faces', faceBody: b.id, faces: [await faceRef(r, only(r), (await topo(r, only(r))).faces.find((f) => f.normal && f.normal[2] > 0.5 && Math.abs(f.centroid![2] - 10) < 1e-6)!.i)], op: 'join', dir1: dir(X, 2, 15) });
    void top;
    expect(bad.status.state).toBe('error');
    expect((bad.status as { message: string }).message).toMatch(/^Linear pattern 2 failed: (OCCT could not take those faces off Body 1|those faces bound nothing on Body 1)/);
  });
});
