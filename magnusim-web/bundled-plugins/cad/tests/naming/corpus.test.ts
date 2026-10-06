// @vitest-environment node
// The persistent-naming corpus (proposal §4.5 point 7): three parts on the real
// kernel, each edited upstream, whose later features must keep their references by
// name (a clean rebuild: no "Reference repaired · check", no lost edge) and keep the
// same face names and the same words in their panels:
//   bracket  Sketch -> Extrude 20 -> sketch on its top face -> cut Through all ->
//            Fillet the 4 outer vertical edges; then the plate's width 60 -> 50
//            (the P4a gate: "the Fillet panel lists the same edge names"), and a
//            radius too large turns Fillet 1 red while the plate still shows
//   pipe     a circle swept along a line, an arc and a line -> Shell with both ends
//            open; then the first line 50 -> 60 long
//   flange   the imported flange.step -> Press-pull its top 5 mm -> Chamfer the four
//            hole rims; then the press-pull 5 -> 8 mm
// Volumes against analytic values.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../src/features/import/feature';
import { edgeWords } from '../../src/naming/edges';
import type { ChamferFeature, Feature, FilletFeature, PersistentRef, PressPullFeature, ShellFeature, SketchFeature } from '../../src/types/doc';
import { importFixture, type RealDoc } from '../features/p2/real-doc';
import { PATTERN_DEFS } from '../../src/features/pattern/defs';
import type { FeatureTypeDef } from '../../src/types/doc-service';
import { addFeature, addSketch, body, close, edgeRef, faceRef, onFace, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo, volume } from '../features/solids/solids-real';

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

const featureName = (r: RealDoc) => (id: string) => r.doc.state.get().doc.features.find((f) => f.id === id)?.name ?? null;
/** The words the Fillet / Chamfer panel lists for its edges, against the body as shown. */
const panelWords = (r: RealDoc, refs: readonly PersistentRef[]) => refs.map((e) => edgeWords(e.name, featureName(r), body(r).names?.faces ?? null));
const sortedNames = (r: RealDoc) => [...(body(r).names?.faces ?? [])].map((n) => n.replace(/#\d+$/, '')).sort();

async function edit(r: RealDoc, id: string, patch: Partial<Feature>) {
  const s = r.doc.beginEdit(id);
  s.update(patch);
  s.commit();
  return settle(r.doc);
}

/** The flat, the sketch-entity ends: a W x 40 plate from Sketch 1's four points. */
function platePoints(w: number) {
  return { p_1: [0, 0], p_2: [w, 0], p_3: [w, 40], p_4: [0, 40] } as SketchFeature['points'];
}

describe('naming corpus', () => {
  it('bracket: the width 60 -> 50 keeps Fillet 1 on the same edges, by name, with the same words; a 20 mm radius turns it red and the plate still shows', async () => {
    const r = await part();
    const sk = new SketchBuilder();
    sk.rect(0, 0, 60, 40);
    const plate = await addSketch(r, onPlane('origin:top', sk));
    const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, plate), extent: { kind: 'blind', distance: '20 mm' } });
    expect(ex.status.state).toBe('ok');
    const b = body(r);
    const top = (await topo(r, b)).faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
    const hole = new SketchBuilder();
    hole.rect(25, 15, 35, 25);
    const hs = await addSketch(r, await onFace(r, b, top.i, hole));
    const cut = await addFeature(r, 'extrude', { profiles: regionsOf(r, hs), extent: { kind: 'through_all', both: false, distance: '10 mm' }, flip: true, op: 'cut', creates: null });
    expect(cut.status).toMatchObject({ state: 'ok' });
    // The four outer vertical edges (x and y at the plate's corners).
    const t = await topo(r, body(r));
    const outer = t.edges.filter((e) => e.type === 'line' && Math.abs(e.dir![2]) > 0.99 && (Math.abs(e.mid![0]) < 1e-6 || Math.abs(e.mid![0] - 60) < 1e-6));
    expect(outer).toHaveLength(4);
    const refs = await Promise.all(outer.map((e) => edgeRef(r, body(r), e.i)));
    const fl = await addFeature(r, 'fillet', { body: b.id, edges: refs, radius: '4 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const expected = (w: number) => w * 40 * 20 - 10 * 10 * 20 - 4 * (1 - Math.PI / 4) * 16 * 20;
    expect(close(await volume(r, b.id), expected(60))).toBe(true);
    const wordsBefore = panelWords(r, refs);
    expect(wordsBefore.every((w) => /^Side \d · Side \d of Extrude 1$/.test(w ?? ''))).toBe(true);
    const namesBefore = sortedNames(r);
    expect(namesBefore.filter((n) => n.startsWith(`F:${fl.id}:fillet:E:`))).toHaveLength(4);

    // Upstream: the plate's width 60 -> 50 (Sketch 1's right side moves).
    const rb = await edit(r, plate, { points: platePoints(50) } as Partial<SketchFeature>);
    for (const id of [ex.id, cut.id, fl.id]) expect(rb.features[id], id).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id].message).toBeUndefined();
    expect(close(await volume(r, b.id), expected(50))).toBe(true);
    expect(panelWords(r, (r.doc.state.get().doc.features.find((f) => f.id === fl.id) as FilletFeature).edges)).toEqual(wordsBefore);
    expect(sortedNames(r)).toEqual(namesBefore);

    // A 20 mm radius: Fillet 1 red with the edges and a radius that works; the cut plate still shows.
    const red = await edit(r, fl.id, { radius: '20 mm' } as Partial<FilletFeature>);
    expect(red.features[fl.id].state).toBe('error');
    expect(red.features[fl.id].message).toMatch(/^Fillet 1 failed: a radius of 20 mm is too large for Side \d · Side \d of Extrude 1, .*: [\d.]+ mm or less works$/);
    expect(red.bodies).toHaveLength(1);
    expect(close(await volume(r, b.id), 50 * 40 * 20 - 10 * 10 * 20)).toBe(true);
  });

  it('pipe: the path 50 -> 60 long keeps Shell 1 on the two ends, by name', async () => {
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
    const pipe = body(r);
    const caps = pipe.names!.faces.flatMap((n, i) => (n === `F:${sw.id}:start` || n === `F:${sw.id}:end` ? [i] : []));
    expect(caps).toHaveLength(2);
    const sh = await addFeature(r, 'shell', { body: pipe.id, faces: await Promise.all(caps.map((i) => faceRef(r, pipe, i))), thickness: '1 mm' });
    expect(sh.status).toMatchObject({ state: 'ok' });
    const len = (l1: number) => l1 + 10 * Math.PI + 30;
    const rel = async (l1: number) => Math.abs((await volume(r, pipe.id)) / (Math.PI * (25 - 16) * len(l1)) - 1);
    expect(await rel(50)).toBeLessThan(1e-4);
    const namesBefore = sortedNames(r);
    // Upstream: the first line 50 -> 60 (the arc and the last line move up 10).
    const s = r.doc.state.get().doc.features.find((f) => f.id === pth) as SketchFeature;
    const moved = Object.fromEntries(Object.entries(s.points).map(([k, p]) => [k, p[1] >= 50 ? [p[0], p[1] + 10] : p])) as SketchFeature['points'];
    const rb = await edit(r, pth, { points: moved } as Partial<SketchFeature>);
    expect(rb.features[sw.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[sh.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[sh.id].message).toBeUndefined();
    expect(await rel(60)).toBeLessThan(1e-4);
    expect(sortedNames(r)).toEqual(namesBefore);
    expect((r.doc.state.get().doc.features.find((f) => f.id === sh.id) as ShellFeature).faces.map((f) => f.name).sort()).toEqual([`F:${sw.id}:end`, `F:${sw.id}:start`]);
  });

  it('imported flange: the press-pull 5 -> 8 mm keeps Chamfer 1 on the four hole rims, by name', async () => {
    const r = await part();
    await importFixture(r, 'flange.step');
    const b = body(r);
    const t = await topo(r, b);
    const zTop = Math.max(...t.faces.filter((f) => f.type === 'plane' && f.normal![2] > 0.99).map((f) => f.centroid![2]));
    const top = t.faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99 && Math.abs(f.centroid![2] - zTop) < 1e-6)!;
    const pp = await addFeature(r, 'press_pull', { body: b.id, faces: [await faceRef(r, b, top.i)], distance: '5 mm' });
    expect(pp.status).toMatchObject({ state: 'ok' });
    const t2 = await topo(r, body(r));
    const rims = t2.edges.filter((e) => e.type === 'circle' && Math.abs(e.mid![2] - (zTop + 5)) < 1e-6);
    expect(rims).toHaveLength(4);
    const refs = await Promise.all(rims.map((e) => edgeRef(r, body(r), e.i)));
    const ch = await addFeature(r, 'chamfer', { body: b.id, edges: refs, mode: 'distance', distance: '1 mm' });
    expect(ch.status).toMatchObject({ state: 'ok' });
    const vol0 = 100 * 100 * 10 - 4 * Math.PI * 25 * 10;
    const chamfers = 4 * 2 * Math.PI * (5 + 1 / 3) * 0.5;
    const expected = (h: number) => vol0 + (100 * 100 - 4 * Math.PI * 25) * h - chamfers;
    expect(Math.abs((await volume(r, b.id)) / expected(5) - 1)).toBeLessThan(1e-6);
    const wordsBefore = panelWords(r, refs);
    const namesBefore = sortedNames(r);
    const rb = await edit(r, pp.id, { distance: '8 mm' } as Partial<PressPullFeature>);
    expect(rb.features[ch.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[ch.id].message).toBeUndefined();
    expect(Math.abs((await volume(r, b.id)) / expected(8) - 1)).toBeLessThan(1e-6);
    expect(panelWords(r, (r.doc.state.get().doc.features.find((f) => f.id === ch.id) as ChamferFeature).edges)).toEqual(wordsBefore);
    expect(sortedNames(r)).toEqual(namesBefore);
  });
});

// ---- P4b (PATTERN): copies of patterns and mirrors keep the names of their faces, so features
// on a copy survive upstream edits of the pattern and of its source.
describe('naming corpus: patterns and mirrors (P4b)', () => {
  async function partWithPatterns() {
    const r = await part();
    for (const d of PATTERN_DEFS) if (!r.doc.features.get(d.type)) r.doc.features.register(d as unknown as FeatureTypeDef);
    return r;
  }

  it('a hole patterned 4 along X with a fillet on the rim of instance 3: count 4 -> 5 and spacing 20 -> 18 keep the fillet on that rim, by name, with the same words', async () => {
    const r = await partWithPatterns();
    const sk = new SketchBuilder();
    sk.rect(0, 0, 100, 20);
    const plate = await addSketch(r, onPlane('origin:top', sk));
    expect((await addFeature(r, 'extrude', { profiles: regionsOf(r, plate), extent: { kind: 'blind', distance: '10 mm' } })).status.state).toBe('ok');
    const hs = new SketchBuilder();
    hs.circle([10, 10], 3);
    const hsk = await addSketch(r, onPlane('origin:top', hs));
    const hole = await addFeature(r, 'extrude', { profiles: regionsOf(r, hsk), extent: { kind: 'blind', distance: '10 mm' }, op: 'cut', creates: null });
    expect(hole.status.state).toBe('ok');
    const dir1 = (count: number, spacing: number) => ({ axis: { kind: 'origin', axis: 'origin:x' }, flip: false, count: String(count), mode: 'spacing', distance: `${spacing} mm`, symmetric: false });
    const lp = await addFeature(r, 'pattern_linear', { of: 'features', features: [hole.id], op: 'source', dir1: dir1(4, 20) });
    expect(lp.status).toMatchObject({ state: 'ok' });
    const t = await topo(r, body(r));
    const rim = t.edges.find((e) => e.type === 'circle' && Math.abs(e.mid![2] - 10) < 1e-6 && Math.abs(e.center![0] - 50) < 1e-6)!;
    const ref = await edgeRef(r, body(r), rim.i);
    expect(ref.name).toContain(`F:${lp.id}:i3:`);
    const fl = await addFeature(r, 'fillet', { body: body(r).id, edges: [ref], radius: '1 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const words = panelWords(r, [ref]);
    // The two faces in their name's (sorted) order: either way round.
    expect(words[0]).toMatch(/^(End of Extrude 1 · Side 1 \(instance 3\) of Extrude 2|Side 1 \(instance 3\) of Extrude 2 · End of Extrude 1)$/);
    // A 1 mm round on a hole's rim of radius 3 removes 2 pi rho A (Pappus): A = r^2 (1 - pi/4), rho = R + its centroid's offset.
    const A = 1 - Math.PI / 4;
    const rho = 3 + (5 / 6 - Math.PI / 4) / A;
    const round = 2 * Math.PI * rho * A;
    const hole1 = Math.PI * 9 * 10;
    expect(close(await volume(r, body(r).id), 100 * 20 * 10 - 4 * hole1 - round, 1e-6)).toBe(true);
    const rb = await edit(r, lp.id, { dir1: dir1(5, 18) } as Partial<Feature>);
    expect(rb.features[fl.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id].message).toBeUndefined();
    expect(close(await volume(r, body(r).id), 100 * 20 * 10 - 5 * hole1 - round, 1e-6)).toBe(true);
    expect(panelWords(r, (r.doc.state.get().doc.features.find((f) => f.id === fl.id) as FilletFeature).edges)).toEqual(words);
    // The fillet face sits on the rim of instance 3, now at x = 10 + 2 x 18.
    const t2 = await topo(r, body(r));
    const filletFace = body(r).names!.faces.findIndex((n) => n.startsWith(`F:${fl.id}:fillet:`));
    expect(t2.faces.find((f) => f.i === filletFace)!.centroid![0]).toBeCloseTo(46, 6);
  });

  it('a block mirrored as a new body with a fillet on the copy: the source made taller keeps the fillet, by name', async () => {
    const r = await partWithPatterns();
    const sk = new SketchBuilder();
    sk.rect(5, 0, 15, 10);
    const s = await addSketch(r, onPlane('origin:top', sk));
    const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, s), extent: { kind: 'blind', distance: '10 mm' } });
    const src = body(r).id;
    const m = await addFeature(r, 'mirror', { of: 'bodies', bodies: [src], op: 'new', plane: { kind: 'origin', plane: 'origin:right' } });
    expect(m.status).toMatchObject({ state: 'ok' });
    const copy = r.doc.state.get().rebuild.bodies.find((b) => b.id !== src)!;
    const t = await topo(r, copy);
    const edge = t.edges.find((e) => e.type === 'line' && Math.abs(e.dir![2]) > 0.99 && Math.abs(e.mid![0] + 15) < 1e-6 && Math.abs(e.mid![1]) < 1e-6)!;
    const ref = await edgeRef(r, copy, edge.i);
    expect(ref.name.split('&').every((p) => p.includes(`F:${m.id}:m:`))).toBe(true);
    const fl = await addFeature(r, 'fillet', { body: copy.id, edges: [ref], radius: '1 mm' });
    expect(fl.status).toMatchObject({ state: 'ok' });
    const words = panelWords(r, [ref]);
    const vol = async () => (await r.doc.measure(copy.id)).volume;
    expect(close(await vol(), 1000 - (1 - Math.PI / 4) * 10)).toBe(true);
    const rb = await edit(r, ex.id, { extent: { kind: 'blind', distance: '12 mm' } } as Partial<Feature>);
    expect(rb.features[fl.id]).toMatchObject({ state: 'ok' });
    expect(rb.features[fl.id].message).toBeUndefined();
    expect(close(await vol(), 1200 - (1 - Math.PI / 4) * 12)).toBe(true);
    const fe = (r.doc.state.get().doc.features.find((f) => f.id === fl.id) as FilletFeature).edges;
    const shown = r.doc.state.get().rebuild.bodies.find((b) => b.id === copy.id)!;
    expect(fe.map((e) => edgeWords(e.name, featureName(r), shown.names?.faces ?? null))).toEqual(words);
  });
});
