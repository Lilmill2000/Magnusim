// @vitest-environment node
// Delete faces must never pass off a heal that filled more than the gap (2026-10-30): on an
// L-block with every edge rounded R2, removing the 30 blends gave a valid 60 x 40 x 20 box
// (48,000 mm³ instead of 36,000) and Delete faces 1 was "ok". Through the document as the
// person does it (Sketch + Extrude, a cut, Fillet of every face, Delete faces of the blends): the
// L-block's heal is tried again in two goes and gives the sharp L-block; a T-block's cannot be
// made right that way, and Delete faces 1 is red, says what the heal would have done and that
// the body is unchanged. Then the rule (src/features/p2/heal-check.ts) on the real kernel: every
// wrong fill of the repro corpus refused (and five of the six bodies right in two goes), and none
// of its right removals (holes, bosses, pockets, slots, fillets, chamfers, ring fillets, wedge
// tips, a 50-hole plate, BREP round trips). Review 2026-10-30: rounds and chamfers that end on a
// face that stays (a boss's corners on its plate, a riser's corners on the step floor, a step edge
// into its wall, a notch edge between its walls, a tab's edges, the boss after a STEP round trip)
// were refused as fills, their corners' end caps read as material on the kept face: now the sharp
// part. A wavy loft rounded R1, whose check boolean returned the whole result, is shown with
// "check the result" instead of refused for the body's own volume; a defeature too slow for the
// boolean skips it (said so) instead of meeting the kernel limit.
// Kernel API 8 (Delete faces version 2, every new one): where OCCT's heal stays refused, a pick of
// every fillet up to its largest radius is taken off as fillets (Analysis Situs). The T-block is now
// the sharp T-block (32,000 mm³) with every face keeping its name, and a later Fillet on its restored
// edges builds; a Delete faces saved without a version keeps OCCT's refusal and says a new one may
// do it, also when a Part saved that way is opened. The corpus under version 2: every body that was
// right stays the same body, no wrong body is kept, and the bodies newly right are listed with
// their sharp volumes (the T, I, plus, comb and Z blocks at R1 and R2).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { checkHeal, healRefused, retryHoldBack, UNCHECKED, type HealCheck } from '../../../src/features/p2/heal-check';
import { pickFace } from '../../../src/features/p2/refs';
import { deleteFacesOn } from '../../../src/features/delete_faces/feature';
import { LEGACY_WORDS } from '../../../src/features/delete_faces/plan';
import { FakeFolder } from '../../doc/fake-files';
import { FAMILY, poly, polyArea } from '../../kernel/asi-lib';
import { refPlaneDef } from '../../../src/features/refgeom/defs';
import { PATTERN_DEFS } from '../../../src/features/pattern/defs';
import type { DeleteFacesFeature } from '../../../src/types/doc';
import type { BuildContext, BuiltBody, DeleteFacesOutput, FeatureTypeDef } from '../../../src/types/doc-service';
import type { OpHistory, TopoResult } from '../../../src/types/kernel-protocol';
import { extentFor } from '../../doc/blocks';
import { importFixture, type RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, close, edgeRef, faceRef, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo, volume } from '../solids/solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part(folder?: FakeFolder) {
  const r = await openSolids(folder ? { folder } : {});
  for (const d of PATTERN_DEFS) if (!r.doc.features.get(d.type)) r.doc.features.register(d as unknown as FeatureTypeDef);
  open.push(r);
  return r;
}

const bodies = (r: RealDoc) => r.doc.state.get().rebuild.bodies;

/** A W x D x H block from a Top sketch, corner (x, y, z0): a new body, or a cut / join into the bodies there. */
async function block(r: RealDoc, [x, y, z0]: number[], [w, d, h]: number[], op: 'new' | 'cut' | 'join' = 'new') {
  const sk = new SketchBuilder();
  sk.rect(x, y, x + w, y + d);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: extentFor(z0, h), ...(op === 'new' ? {} : { op, creates: null, scope: [] }) });
  expect(ex.status.state).toBe('ok');
  return ex.id;
}

/** A round hole of radius rad at (x, y) through the bodies from z = 0 up h. */
async function hole(r: RealDoc, x: number, y: number, rad: number, h: number) {
  const sk = new SketchBuilder();
  sk.circle([x, y], rad);
  const sketch = await addSketch(r, onPlane('origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${h} mm` }, op: 'cut', creates: null, scope: [] });
  expect(ex.status.state).toBe('ok');
}

/** Fillet every edge of the one body (all its faces picked) by `radius`. */
async function roundAll(r: RealDoc, radius: number) {
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const faces = await Promise.all(t.faces.map((f) => faceRef(r, b, f.i)));
  const fl = await addFeature(r, 'fillet', { body: b.id, edges: [], faces, radius: `${radius} mm` });
  expect(fl.status.state).toBe('ok');
  return fl.id;
}

/** Delete faces `pick` (indices on the body now) of the one body; `legacy`: as saved before version 2 (no version). */
async function deleteFaces(r: RealDoc, pick: (f: TopoResult['faces'][number]) => boolean, legacy = false) {
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const idx = t.faces.filter(pick).map((f) => f.i);
  const refs = await Promise.all(idx.map((i) => faceRef(r, b, i)));
  const d = await addFeature(r, 'delete_faces', { body: b.id, faces: refs, ...(legacy ? { version: undefined } : {}) } as Partial<DeleteFacesFeature> as Record<string, unknown>);
  return { ...d, count: idx.length };
}

/** The T-block as the person builds it (a bar 60 x 40 x 10 on a stem 20 x 40 x 10, joined), Fillet 1 of every face R2: the feature ids, and the sharp T-block's faces by name. */
async function roundedT(r: RealDoc) {
  const bar = await block(r, [0, 0, 10], [60, 40, 10]);
  const stem = await block(r, [20, 0, 0], [20, 40, 10], 'join');
  expect(close(await volume(r, bodies(r)[0].id), 32000)).toBe(true);
  const sharp = await faceSignatures(r);
  const fillet = await roundAll(r, 2);
  return { bar, stem, fillet, sharp };
}

/** Each face of the one body by its name: type, plane normal, centroid and area (rounded), so two faces' names cannot swap unseen. */
async function faceSignatures(r: RealDoc): Promise<Map<string, string>> {
  const b = bodies(r)[0];
  const t = await r.kernel.call('topo', { id: b.shape, edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true });
  const round = (v: readonly number[] | null | undefined) => (v ? v.map((x) => Math.round(x * 1e6) / 1e6 + 0).join(',') : '-');
  const out = new Map<string, string>();
  for (const f of t.result.faces) out.set(b.names!.faces[f.i], `${f.type} ${round(f.normal)} ${round(f.centroid)} ${Math.round((f.area ?? 0) * 1e6) / 1e6}`);
  return out;
}

describe('Delete faces through the document: a heal past the gap is tried again, else refused with the body unchanged', () => {
  it('L-block (Extrude, Extrude Cut), Fillet of every face R2, Delete faces of the 30 blends: ok, the sharp L-block (36,000 mm³, 8 faces, named)', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await block(r, [30, 0, 10], [30, 40, 10], 'cut');
    expect(close(await volume(r, bodies(r)[0].id), 36000)).toBe(true);
    await roundAll(r, 2);
    expect(await volume(r, bodies(r)[0].id)).toBeCloseTo(35601.626, 2);
    const del = await deleteFaces(r, (f) => f.type !== 'plane');
    expect(del.count).toBe(30);
    // One go gave the 48,000 mm³ box; two goes (all but the fillet on the riser's top, then it) the right body.
    expect(del.status).toMatchObject({ state: 'ok' });
    expect(del.status.message).toBeUndefined();
    const after = bodies(r)[0];
    expect(after.faces).toBe(8);
    expect(close(await volume(r, after.id), 36000)).toBe(true);
    const names = after.names?.faces ?? [];
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  }, 120_000);

  it('T-block (a bar on a stem), Fillet of every face R2, Delete faces of every blend: OCCT cannot, the fillets come off as fillets: the sharp T-block, every face keeping its name', async () => {
    const r = await part();
    const t = await roundedT(r);
    const del = await deleteFaces(r, (f) => f.type !== 'plane');
    expect(del.count).toBe(40);
    // Was red: "healing filled more than the gap ...: it would add 16,395 mm³ over faces you kept (...)".
    expect(del.status).toMatchObject({ state: 'ok', note: "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly" });
    expect(del.status.message).toBeUndefined();
    expect(del.rb.outputs[del.id]).toEqual({ type: 'delete-faces', how: 'fillets', rest: [], restRefs: [] } satisfies DeleteFacesOutput);
    const after = bodies(r)[0];
    expect(after.faces).toBe(10);
    expect(close(await volume(r, after.id), 32000)).toBe(true);
    // Every one of the 10 faces, by its name, is the face it was before Fillet 1 (decision D10: by name, not by plane).
    const now = await faceSignatures(r);
    expect(now.size).toBe(10);
    expect([...now.keys()].sort()).toEqual([...t.sharp.keys()].sort());
    for (const [name, sig] of t.sharp) expect(now.get(name), name).toBe(sig);
    // A later Fillet on the two restored concave edges (named by their faces, E:A&B) builds: R1.5 adds 2 x 40 x 2.25 (1 - pi/4).
    const b = bodies(r)[0];
    const tp = await topo(r, b);
    const concave = tp.edges.filter((e) => e.type === 'line' && e.first && e.last && near(e.first[2], 10) && near(e.last[2], 10) && (near(e.first[0], 20) || near(e.first[0], 40)) && near(e.first[0], e.last[0]));
    expect(concave).toHaveLength(2);
    const refs = await Promise.all(concave.map((e) => edgeRef(r, b, e.i)));
    for (const ref of refs) expect(ref.name).toMatch(/^E:F:[^&]+&F:/);
    const f2 = await addFeature(r, 'fillet', { body: b.id, edges: refs, faces: [], radius: '1.5 mm' });
    expect(f2.status).toMatchObject({ state: 'ok' });
    expect(f2.status.message).toBeUndefined();
    expect(await volume(r, bodies(r)[0].id)).toBeCloseTo(32000 + 2 * 40 * 2.25 * (1 - Math.PI / 4), 6);
  }, 120_000);

  it('the same T-block with a Delete faces saved before version 2: red as before, with what a new Delete faces may do; volume and faces as before', async () => {
    const r = await part();
    const { bar, fillet } = await roundedT(r);
    const before = bodies(r)[0];
    const v0 = await volume(r, before.id);
    const del = await deleteFaces(r, (f) => f.type !== 'plane', true);
    expect((r.doc.state.get().doc.features.find((f) => f.id === del.id) as DeleteFacesFeature).version).toBeUndefined();
    const st = del.status;
    expect(st.state).toBe('error');
    const fname = r.doc.state.get().doc.features.find((f) => f.id === fillet)!.name;
    const barName = r.doc.state.get().doc.features.find((f) => f.id === bar)!.name;
    // What the heal would have done (fill both sides of the stem: 16,395 mm³ more, on faces the bar and the stem made), that nothing changed, and the way that works.
    expect(st.message).toMatch(/^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d* mm³ over faces you kept \(/);
    expect(st.message).toContain(barName);
    expect(st.message).toContain(`; the body is unchanged. To take the whole fillet off, delete ${fname} instead. ${LEGACY_WORDS}`);
    expect(st.message!.endsWith(LEGACY_WORDS)).toBe(true);
    const after = bodies(r)[0];
    expect(after.shape).toBe(before.shape);
    expect(after.faces).toBe(before.faces);
    expect(await volume(r, after.id)).toBeCloseTo(v0, 6);
  }, 120_000);

  it('a box with a through hole, every edge R1, Delete faces of every blend: ok, the holed box (no false refusal)', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await hole(r, 30, 20, 5, 20);
    await roundAll(r, 1);
    const del = await deleteFaces(r, (f) => f.type !== 'plane' && !(f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 5) < 1e-6));
    expect(del.status.state).toBe('ok');
    expect(close(await volume(r, bodies(r)[0].id), 48000 - Math.PI * 25 * 20)).toBe(true);
  }, 120_000);

  it('a pattern of faces whose heal fills the step is refused with the same words', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await block(r, [30, 0, 10], [30, 40, 10], 'cut');
    await roundAll(r, 2);
    const b = bodies(r)[0];
    const t = await topo(r, b);
    const refs = await Promise.all(t.faces.filter((f) => f.type !== 'plane').map((f) => faceRef(r, b, f.i)));
    const lp = await addFeature(r, 'pattern_linear', { of: 'faces', faceBody: b.id, faces: refs, op: 'join', dir1: { axis: { kind: 'origin', axis: 'origin:x' }, flip: false, count: '2', mode: 'spacing', distance: '70 mm', symmetric: false } });
    expect(lp.status.state).toBe('error');
    expect(lp.status.message).toMatch(/OCCT could not take those faces off Body 1 cleanly \(healing filled more than the gap the deleted faces leave: it would add .* over faces you kept/);
  }, 120_000);
});

describe('Delete faces version 2 through the document: still refused in words, the rest, a Part saved before version 2', () => {
  it('a T-block with a hole in its bar, every face R2: the hole rims are rings, so taking the fillets off fails too: red with both reasons, the body unchanged', async () => {
    const d = await part();
    await block(d, [0, 0, 10], [60, 40, 10]);
    await block(d, [20, 0, 0], [20, 40, 10], 'join');
    await hole(d, 10, 20, 4, 20);
    const fillet = await roundAll(d, 2);
    const before = bodies(d)[0];
    const v0 = await volume(d, before.id);
    const del = await deleteFaces(d, (f) => f.type !== 'plane' && !(f.type === 'cylinder' && near(f.radius ?? 0, 4)));
    expect(del.count).toBe(42);
    expect(del.status.state).toBe('error');
    const fname = d.doc.state.get().doc.features.find((f) => f.id === fillet)!.name;
    expect(del.status.message).toMatch(
      new RegExp(`^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\\d,.]+ mm³ over faces you kept \\([^)]*\\); taking them off as fillets did not work either: 1 of the 42 fillet faces could not be taken off \\(a ring round a boss or a hole cannot be taken off as a fillet\\); the body is unchanged\\. To take the whole fillet off, delete ${fname} instead$`),
    );
    // Nothing more to add: no rest.
    expect(del.rb.outputs[del.id]).toBeUndefined();
    const after = bodies(d)[0];
    expect(after.shape).toBe(before.shape);
    expect(await volume(d, after.id)).toBeCloseTo(v0, 6);
  }, 180_000);

  it('the same holed T-block with every fillet but the rim rings picked, or every fillet and the hole wall: red, and the words say the rings stop taking them off as fillets, never "with all 42" or "the fillets alone" (review 2026-11-02)', async () => {
    const d = await part();
    await block(d, [0, 0, 10], [60, 40, 10]);
    await block(d, [20, 0, 0], [20, 40, 10], 'join');
    await hole(d, 10, 20, 4, 20);
    const fillet = await roundAll(d, 2);
    const fname = d.doc.state.get().doc.features.find((f) => f.id === fillet)!.name;
    const before = bodies(d)[0];
    const v0 = await volume(d, before.id);
    const t = await topo(d, before);
    const wall = (f: TopoResult['faces'][number]) => f.type === 'cylinder' && near(f.radius ?? 0, 4);
    // The hole's two rim rounds: tori round its axis, each closing on itself (a seam).
    const rim = (f: TopoResult['faces'][number]) => f.type === 'torus' && !!f.axis && near(f.axis.origin[0], 10) && near(f.axis.origin[1], 20);
    expect(t.faces.filter(rim)).toHaveLength(2);
    const rings = 'Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: 2 of the 42 are rings round a boss or a hole';
    // Every fillet but the rims: was "Every fillet up to R2 on Body 1 is 42 faces and 40 are picked: with all 42, Delete faces can
    // take them off as fillets" with the rims as the rest, which taking off as fillets then refuses.
    const del = await deleteFaces(d, (f) => f.type !== 'plane' && !wall(f) && !rim(f));
    expect(del.count).toBe(40);
    expect(del.status.state).toBe('error');
    expect(del.status.message).toMatch(new RegExp(`^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\\d,.]+ mm³ over faces you kept \\([^)]*\\); the body is unchanged\\. To take the whole fillet off, delete ${fname} instead\\. `));
    expect(del.status.message!.endsWith(`. ${rings}`)).toBe(true);
    expect(del.status.message).not.toContain('Delete faces can take them off');
    expect(del.rb.outputs[del.id]).toBeUndefined();
    // Every fillet and the hole's wall: was "The fillets alone (42 faces, every fillet up to R2) can be taken off as fillets in a Delete faces of their own".
    const ses = d.doc.beginEdit(del.id);
    ses.update({ faces: await Promise.all(t.faces.filter((f) => f.type !== 'plane').map((f) => faceRef(d, before, f.i))) } as Partial<DeleteFacesFeature>);
    ses.commit();
    const rb = await settle(d.doc);
    expect(rb.features[del.id]).toMatchObject({ state: 'error', message: `Delete faces 1 failed: 3 of the 43 faces could not be removed and healed (the faces around them cannot be extended to close the gap). ${rings}` });
    expect(rb.outputs[del.id]).toBeUndefined();
    expect(bodies(d)[0].shape).toBe(before.shape);
    expect(await volume(d, bodies(d)[0].id)).toBeCloseTo(v0, 6);
  }, 180_000);

  it('a T-block with all its fillets but one picked: red with every fillet up to R2 and how many are picked; Add the rest (the panel and get_model) makes it the sharp T-block', async () => {
    const r = await part();
    await roundedT(r);
    const b = bodies(r)[0];
    const t = await topo(r, b);
    const round = t.faces.filter((f) => f.type !== 'plane').map((f) => f.i);
    expect(round).toHaveLength(40);
    const v0 = await volume(r, b.id);
    // All but the first: OCCT's heal fills the cavities, two goes cannot, and the pick is not every fillet up to R2.
    const del = await deleteFaces(r, (f) => round.slice(1).includes(f.i));
    expect(del.status.state).toBe('error');
    expect(del.status.message).toMatch(/^Delete faces 1 failed: .*\. Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets$/);
    expect(del.status.message).not.toContain('taking them off as fillets did not work');
    const out = del.rb.outputs[del.id] as DeleteFacesOutput;
    expect(out).toMatchObject({ type: 'delete-faces', how: null, rest: [round[0]] });
    expect(out.restRefs.map((x) => x.name)).toEqual([b.names!.faces[round[0]]]);
    expect(await volume(r, bodies(r)[0].id)).toBeCloseTo(v0, 6);
    // Add the rest: the faces field gains the rest's references, as the panel's button does.
    const ses = r.doc.beginEdit(del.id);
    const f = ses.draft as DeleteFacesFeature;
    ses.update({ faces: [...f.faces, ...out.restRefs] } as Partial<DeleteFacesFeature>);
    ses.commit();
    const rb = await settle(r.doc);
    expect(rb.features[del.id]).toMatchObject({ state: 'ok', note: "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly" });
    expect(close(await volume(r, bodies(r)[0].id), 32000)).toBe(true);
  }, 180_000);

  it('a Part saved with a Delete faces before version 2 (its JSON written here without the version) opens red with the legacy words, the body as Fillet 1 left it; with version 2 the same file opens ok', async () => {
    const r = await part();
    const { fillet } = await roundedT(r);
    const v0 = await volume(r, bodies(r)[0].id);
    const del = await deleteFaces(r, (f) => f.type !== 'plane');
    expect(del.status.state).toBe('ok');
    await r.doc.flush();
    const saved = new Map([...r.folder.entries].map(([rel, e]) => [rel, new TextDecoder().decode(e.bytes)]));
    const rel = [...saved.keys()].find((k) => k.endsWith('model.json'))!;
    const model = JSON.parse(saved.get(rel)!);
    const df = (model.doc ?? model).features.find((x: { type: string }) => x.type === 'delete_faces');
    expect(df.version).toBe(2);
    for (const legacy of [true, false]) {
      if (legacy) delete df.version;
      else df.version = 2;
      const folder = new FakeFolder();
      for (const [k, text] of saved) folder.put(k, new TextEncoder().encode(k === rel ? JSON.stringify(model) : text));
      const d = await part(folder);
      // openRealDoc loads before the solid feature types are registered: read the Part again with them.
      await d.doc.reload();
      const rb = await settle(d.doc);
      const fname = d.doc.state.get().doc.features.find((f) => f.id === fillet)!.name;
      if (legacy) {
        expect(d.doc.state.get().doc.features.find((f) => f.id === del.id)).not.toHaveProperty('version');
        expect(rb.features[del.id].state).toBe('error');
        expect(rb.features[del.id].message).toMatch(new RegExp(`; the body is unchanged\\. To take the whole fillet off, delete ${fname} instead\\. ${LEGACY_WORDS}$`));
        expect(await volume(d, rb.bodies[0].id)).toBeCloseTo(v0, 6);
      } else {
        expect(rb.features[del.id]).toMatchObject({ state: 'ok' });
        expect(close(await volume(d, rb.bodies[0].id), 32000)).toBe(true);
      }
    }
  }, 180_000);

  it('a version-less L-block (OCCT right in two goes) opens as it was made: ok, 36,000 mm³, the same names', async () => {
    const r = await part();
    await block(r, [0, 0, 0], [60, 40, 20]);
    await block(r, [30, 0, 10], [30, 40, 10], 'cut');
    await roundAll(r, 2);
    const del = await deleteFaces(r, (f) => f.type !== 'plane', true);
    expect(del.status).toMatchObject({ state: 'ok' });
    expect(del.status.note).toBeUndefined();
    const names = bodies(r)[0].names!.faces;
    await r.doc.flush();
    const folder = new FakeFolder();
    for (const [rel, e] of r.folder.entries) folder.put(rel, e.bytes);
    const d = await part(folder);
    await d.doc.reload();
    const rb = await settle(d.doc);
    expect(rb.features[del.id]).toMatchObject({ state: 'ok' });
    expect(rb.outputs[del.id]).toBeUndefined();
    expect(close(await volume(d, rb.bodies[0].id), 36000)).toBe(true);
    expect(rb.bodies[0].names!.faces).toEqual(names);
  }, 180_000);
});

// ---------------------------------------------------------------- the rule on the kernel corpus

type K = RealDoc['kernel'];
type Edge = TopoResult['edges'][number];
type Face = TopoResult['faces'][number];

function kit(r: RealDoc) {
  const k: K = r.kernel;
  const c = async (op: string, params: Record<string, unknown>) => (await k.call(op as never, params as never)).result as Record<string, any>;
  const id = async (op: string, params: Record<string, unknown>) => {
    const res = await c(op, params);
    expect(res.valid, `${op} valid`).not.toBe(false);
    return res.id as number;
  };
  const box = (dx: number, dy: number, dz: number, origin = [0, 0, 0]) => id('box', { dx, dy, dz, origin });
  const cyl = (rad: number, h: number, origin: number[]) => id('cylinder', { r: rad, h, origin, axis: [0, 0, 1] });
  const cut = (a: number, tools: number[]) => id('boolean', { op: 'cut', targets: [a], tools });
  const fuse = (a: number, tools: number[]) => id('boolean', { op: 'fuse', targets: [a], tools });
  const edges = async (s: number) => (await c('topo', { id: s, faces: 'none', vertices: 'none', edge_ends: true })).edges as Edge[];
  const faces = async (s: number) => (await c('topo', { id: s, edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true })).faces as Face[];
  const vol = async (s: number) => (await c('props', { id: s, volume: true, bbox: 'none' })).volume as number;
  /** A fillet / chamfer: the result and its blend faces (generated from an edge or a vertex). */
  const blend = async (op: 'fillet' | 'chamfer', s: number, es: number[], size: number) => {
    const res = await c(op, { id: s, edges: es, ...(op === 'fillet' ? { r: size } : { d: size }) });
    expect(res.valid).toBe(true);
    const made = (res.history as OpHistory).faces.filter((e) => e.from.some((x) => x.how === 'generated')).map((e) => e.out);
    return { id: res.id as number, blends: made.sort((a, b) => a - b) };
  };
  const ctx = {
    kernel: k,
    faces: async (s: number) => (await c('props', { id: s, bbox: 'none' })).faces as number,
    release: async (ids: number[]) => void (await c('release', { ids })),
  } as unknown as BuildContext;
  /** Defeature `rm` of `s` (as Delete faces calls it) and the heal check; the result's volume. */
  const run = async (s: number, rm: number[], name = ""): Promise<{ check: HealCheck; v: number }> => {
    const d = await c('defeature', { id: s, faces: rm });
    expect(d.warnings, `${name}: OCCT removed every face`).toBe(false);
    const check = await checkHeal(ctx, s, rm, d as { id: number; history: OpHistory });
    const v = await vol(d.id);
    await ctx.release([d.id]);
    return { check, v };
  };
  return { c, ctx, box, cyl, cut, fuse, edges, faces, vol, blend, run, extrude: (profile: unknown, d: number) => id('extrude', { profile, extent: { kind: 'blind', d } }) };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const along = (e: Edge, axis: number) => e.type === 'line' && !!e.dir && near(Math.abs(e.dir[axis]), 1);

/** The plate 60 x 40 x 10 with a boss 20 x 10 x 6 joined on it, the boss's 4 vertical edges R2 by Fillet 1. */
async function roundedBoss(r: RealDoc) {
  await block(r, [0, 0, 0], [60, 40, 10]);
  await block(r, [20, 15, 10], [20, 10, 6], 'join');
  const b = bodies(r)[0];
  const t = await topo(r, b);
  const vertical = t.edges.filter((e) => e.type === 'line' && e.mid![2] > 10 + 1e-6 && Math.abs(e.mid![2] - 13) < 1e-6).map((e) => e.i);
  expect(vertical).toHaveLength(4);
  const fl = await addFeature(r, 'fillet', { body: b.id, edges: await Promise.all(vertical.map((i) => edgeRef(r, b, i))), faces: [], radius: '2 mm' });
  expect(fl.status.state).toBe('ok');
  expect(await volume(r, bodies(r)[0].id)).toBeCloseTo(25200 - 4 * (4 - Math.PI) * 6, 6);
}

describe('Delete faces of rounds that end on a face that stays: the sharp part (review 2026-10-30)', () => {
  it("a boss's 4 vertical corner rounds R2 on its plate: ok, the sharp boss (25,200 mm³, 11 faces), not refused for the corners' end caps", async () => {
    const r = await part();
    await roundedBoss(r);
    const del = await deleteFaces(r, (f) => f.type === 'cylinder');
    expect(del.count).toBe(4);
    // Was: "healing filled more than the gap the deleted faces leave: it would add 20.6018 mm³ over faces you kept (End face of Extrude 1)".
    expect(del.status).toMatchObject({ state: 'ok' });
    expect(del.status.message).toBeUndefined();
    const after = bodies(r)[0];
    expect(after.faces).toBe(11);
    expect(close(await volume(r, after.id), 25200)).toBe(true);
  }, 120_000);

  it('the same after a STEP round trip (an imported boss)', async () => {
    const r = await part();
    await roundedBoss(r);
    const e = await r.kernel.call('export_step', { shapes: [{ id: bodies(r)[0].shape, name: 'Boss' }], schema: 'AP214' } as never);
    const bytes = new Uint8Array((e as unknown as { buffers: { step: ArrayBuffer } }).buffers.step);
    const d = await part();
    await importFixture(d, 'boss.step', { bytes });
    const b = bodies(d)[0];
    const t = await topo(d, b);
    const rounds = t.faces.filter((f) => f.type === 'cylinder').map((f) => f.i);
    expect(rounds).toHaveLength(4);
    const refs = [];
    for (const i of rounds) {
      const p = await pickFace(d.services, b, i, null);
      if (!p.ok) throw new Error(p.reason);
      refs.push(p.ref);
    }
    const del = await addFeature(d, 'delete_faces', { body: b.id, faces: refs } as Partial<DeleteFacesFeature> as Record<string, unknown>);
    expect(del.status).toMatchObject({ state: 'ok' });
    expect(close(await volume(d, bodies(d)[0].id), 25200)).toBe(true);
  }, 120_000);

  it('a defeature slow enough that the check would meet the kernel limit: the boolean is skipped and the result shown with "check the result", not stopped', async () => {
    const r = await part();
    await roundedBoss(r);
    // The kernel as on a 606-face lofted part: the defeature takes 12 s, the check's cut of the two
    // nearly identical bodies 21 s, past the 20 s default limit (the watchdog stops it).
    const real = r.kernel.call.bind(r.kernel);
    const now = performance.now.bind(performance);
    let skew = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + skew);
    const cuts: number[] = [];
    r.kernel.call = (async (op: string, params: Record<string, unknown>, opts: { timeoutMs?: number } = {}) => {
      if (op === 'boolean' && params.op === 'cut') {
        const limit = opts.timeoutMs ?? 20_000;
        cuts.push(limit);
        if (limit < 21_000) throw Object.assign(new Error('boolean was stopped'), { kind: 'watchdog', op, seconds: limit / 1000 });
        skew += 21_000;
      }
      const out = await real(op as never, params as never, opts as never);
      if (op === 'defeature') skew += 12_000;
      return out;
    }) as typeof r.kernel.call;
    try {
      const del = await deleteFaces(r, (f) => f.type === 'cylinder');
      expect(del.status.state).toBe('warning');
      expect(del.status.message).toContain(`${UNCHECKED.slow}: check the result`);
      expect(cuts).toEqual([]);
      expect(close(await volume(r, bodies(r)[0].id), 25200)).toBe(true);
    } finally {
      clock.mockRestore();
      r.kernel.call = real;
    }
  }, 120_000);
});

/** A sketch of a 60 x 30 outline whose top edge is a wavy control spline (14 poles), on Top or on ref plane `plane` at height z. */
async function wavySketch(r: RealDoc, plane: string | null, z: number, amp: number) {
  const n = 14;
  const P: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    P.push([60 * (1 - t), 30 + amp * Math.sin(3 * Math.PI * t) * Math.sin(Math.PI * t)]);
  }
  P[1] = [P[1][0], 30];
  P[n - 2] = [P[n - 2][0], 30];
  const points: Record<string, number[]> = { a: [0, 0], b: [60, 0] };
  P.forEach((p, i) => (points[`s${i}`] = p));
  const entities = [
    { id: 'e1', kind: 'line', p: ['a', 'b'] },
    { id: 'e2', kind: 'line', p: ['b', 's0'] },
    { id: 'e3', kind: 'spline', form: 'control', pts: P.map((_, i) => `s${i}`), degree: 3 },
    { id: 'e4', kind: 'line', p: [`s${n - 1}`, 'a'] },
  ];
  const base = onPlane('origin:top', new SketchBuilder());
  return addSketch(r, { ...base, ...(plane ? { support: { kind: 'feature', feature: plane }, plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] } } : {}), points, entities } as never);
}

describe('B-spline bodies whose check boolean returns the whole result (review 2026-10-30)', () => {
  it('a ruled loft with a wavy top, Fillet of the wavy face R1, Delete faces of its 4 rounds: the sharp loft with "check the result", not refused for the whole volume', async () => {
    const r = await part();
    if (!r.doc.features.get('ref_plane')) r.doc.features.register(refPlaneDef as unknown as FeatureTypeDef);
    const plane = await addFeature(r, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '40 mm' });
    const s1 = await wavySketch(r, null, 0, 4);
    const s2 = await wavySketch(r, plane.id, 40, 4);
    const lf = await addFeature(r, 'loft', { sections: [...regionsOf(r, s1), ...regionsOf(r, s2)], ruled: true });
    expect(lf.status.state).toBe('ok');
    const b = bodies(r).find((x) => x.feature === lf.id)!;
    const sharp = await volume(r, b.id);
    const wavy = (await topo(r, b)).faces.find((f) => f.type !== 'plane')!;
    const fl = await addFeature(r, 'fillet', { body: b.id, edges: [], faces: [await faceRef(r, b, wavy.i)], radius: '1 mm' });
    expect(fl.status.state).toBe('ok');
    const b2 = bodies(r).find((x) => x.id === b.id)!;
    const t2 = await topo(r, b2);
    const big = t2.faces.filter((f) => f.type !== 'plane').reduce((m, f) => ((f.area ?? 0) > (m.area ?? 0) ? f : m));
    const rounds = t2.faces.filter((f) => f.type !== 'plane' && f.i !== big.i).map((f) => f.i);
    expect(rounds).toHaveLength(4);
    const del = await addFeature(r, 'delete_faces', { body: b2.id, faces: await Promise.all(rounds.map((i) => faceRef(r, b2, i))) } as Partial<DeleteFacesFeature> as Record<string, unknown>);
    // Was: "Delete faces 1 failed: healing filled more than the gap ...: it would add 71,765.2 mm³ over faces you kept (Side 4 of Loft 1, ...)".
    expect(del.status.state).toBe('warning');
    expect(del.status.message).toBe(`${UNCHECKED.failed}: check the result`);
    expect(Math.abs((await volume(r, bodies(r).find((x) => x.id === b.id)!.id)) - sharp)).toBeLessThan(0.05);
  }, 120_000);
});

describe('the heal check on the real kernel: every wrong fill refused', () => {
  it('bodies with every edge rounded around a cavity heal into their box: all refused (lost and covered faces)', async () => {
    const r = await part();
    const K = kit(r);
    const cases: [string, () => Promise<number>, number][] = [
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 2],
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 1],
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 4],
      ['U-channel', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 42, 11, [20, -1, 10])]), 2],
      ['T-block', async () => K.fuse(await K.box(60, 40, 10, [0, 0, 10]), [await K.box(20, 40, 10, [20, 0, 0])]), 2],
      ['pocket', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 10, 9, [20, 15, 12])]), 1],
      ['pocket', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 10, 9, [20, 15, 12])]), 3],
      ['slot', async () => K.cut(await K.box(60, 40, 20), [await K.box(62, 10, 5, [-1, 15, 15])]), 1],
      ['side step', async () => K.cut(await K.box(60, 40, 20), [await K.box(11, 42, 6, [50, -1, 15])]), 1],
    ];
    for (const [name, make, rad] of cases) {
      const s = await make();
      const sharp = await K.vol(s);
      const f = await K.blend('fillet', s, (await K.edges(s)).map((e) => e.i), rad);
      const { check, v } = await K.run(f.id, f.blends, name);
      // The repro: OCCT's result is the full 60 x 40 x 20 box, valid and without a warning.
      expect(v, name).toBeCloseTo(48000, 3);
      expect(v - sharp, name).toBeGreaterThan(1000);
      expect(healRefused(check), `${name} R${rad} refused`).toBe(true);
      expect(check.lost.length, name).toBeGreaterThan(0);
      expect(check.covered.length, name).toBeGreaterThan(0);
      // Two goes: the sharp body, except the T-block (a cavity each side of its stem).
      const again = await retryHoldBack(K.ctx, f.id, f.blends, [...check.lost, ...check.covered]);
      if (name === 'T-block') {
        expect(again, name).toBeNull();
      } else {
        expect(again, `${name} R${rad} in two goes`).not.toBeNull();
        expect(await K.vol(again!.second.id), `${name} R${rad} in two goes`).toBeCloseTo(sharp, 3);
        await K.ctx.release([again!.first.id, again!.second.id]);
      }
    }
  }, 120_000);

  it('the L-block\'s blends but one: refused unless the kept blend borders the step; kept tori grown into the step corner refused too', async () => {
    const r = await part();
    const K = kit(r);
    const L = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const f = await K.blend('fillet', L, (await K.edges(L)).map((e) => e.i), 2);
    const fs = await K.faces(f.id);
    const tori = f.blends.filter((i) => fs[i].type === 'torus');
    expect(tori).toHaveLength(2);
    // Keeping one mixed-corner torus: the riser and the floor survive as slivers (no face lost), the step still filled.
    const t = await K.run(f.id, f.blends.filter((i) => i !== tori[0]));
    expect(t.v).toBeGreaterThan(47000);
    expect(t.check.lost).toEqual([]);
    expect(healRefused(t.check)).toBe(true);
    // Keeping both tori: OCCT grows them into the step's corner (+258.7 mm³ over the sharp L with no fill).
    const both = await K.run(f.id, f.blends.filter((i) => !tori.includes(i)));
    expect(both.v).toBeGreaterThan(36100);
    expect(both.check.lost).toEqual([]);
    expect(healRefused(both.check)).toBe(true);
    // Keeping a convex fillet on the riser's top edge: the right body (the sharp L with that edge round), accepted.
    const riserTop = fs.find((x) => x.type === 'cylinder' && near(x.bbox![0], 28) && near(x.bbox![3], 30) && near(x.bbox![5], 20))!;
    const ok = await K.run(f.id, f.blends.filter((i) => i !== riserTop.i));
    expect(ok.v).toBeLessThan(36000);
    expect(ok.v).toBeGreaterThan(35960);
    expect(healRefused(ok.check)).toBe(false);
  }, 120_000);
});

describe('the heal check on the real kernel: no right removal refused', () => {
  it("rounds and chamfers that end on a face that stays: a riser's corners, a step edge into its wall, a notch edge between its walls, a tab's edges", async () => {
    const r = await part();
    const K = kit(r);
    const L = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const riser = (await K.edges(L)).filter((e) => along(e, 2) && near(e.mid![0], 30)).map((e) => e.i);
    const notch = await K.cut(await K.box(60, 40, 20), [await K.box(20, 11, 11, [20, -1, 10])]);
    const notchEdge = (await K.edges(notch)).filter((x) => along(x, 0) && near(x.mid![1], 0) && near(x.mid![2], 10) && near(x.mid![0], 30)).map((x) => x.i);
    const tab = await K.fuse(await K.box(60, 40, 10), [await K.box(30, 5, 25, [15, 0, 10])]);
    const tabEdges = (await K.edges(tab)).filter((e) => along(e, 2) && e.mid![2] > 10 + 1e-6 && e.mid![1] > 1).map((e) => e.i);
    const step = await K.fuse(await K.box(30, 40, 20), [await K.box(30, 40, 10, [30, 0, 0])]);
    const stepEdge = [(await K.edges(step)).find((x) => along(x, 0) && near(x.mid![1], 0) && near(x.mid![2], 10))!.i];
    const cases: [string, number, Promise<{ id: number; blends: number[] }>][] = [
      ["L-block riser's vertical rounds R3 (on the step floor)", L, K.blend('fillet', L, riser, 3)],
      ["L-block riser's vertical chamfers 3", L, K.blend('chamfer', L, riser, 3)],
      ["L-block riser's vertical rounds R2", L, K.blend('fillet', L, riser, 2)],
      ["a notch's floor edge R2 (between the notch walls)", notch, K.blend('fillet', notch, notchEdge, 2)],
      ["an upright tab's back vertical edges R2 (on the plate)", tab, K.blend('fillet', tab, tabEdges, 2)],
      ["a step's front edge R3 (into the wall)", step, K.blend('fillet', step, stepEdge, 3)],
      ["a step's front edge chamfer 3 (into the wall)", step, K.blend('chamfer', step, stepEdge, 3)],
    ];
    for (const [name, sharp, made] of cases) {
      const f = await made;
      const { check, v } = await K.run(f.id, f.blends, name);
      expect(v, name).toBeCloseTo(await K.vol(sharp), 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('holes, bosses, a pocket, a slot (each healed exactly)', async () => {
    const r = await part();
    const K = kit(r);
    const B = () => K.box(60, 40, 20);
    const inBox = (f: Face, b: number[]) => f.bbox![0] >= b[0] - 1e-6 && f.bbox![1] >= b[1] - 1e-6 && f.bbox![2] >= b[2] - 1e-6 && f.bbox![3] <= b[3] + 1e-6 && f.bbox![4] <= b[4] + 1e-6 && f.bbox![5] <= b[5] + 1e-6;
    const cases: [string, () => Promise<number>, (f: Face) => boolean, number][] = [
      ['through hole r4', async () => K.cut(await B(), [await K.cyl(4, 22, [20, 20, -1])]), (f) => f.type === 'cylinder', 48000],
      ['blind hole r4', async () => K.cut(await B(), [await K.cyl(4, 11, [20, 20, 10])]), (f) => f.type === 'cylinder' || (f.type === 'plane' && near(f.centroid![2], 10) && near(f.centroid![0], 20) && near(f.centroid![1], 20)), 48000],
      ['through hole r15', async () => K.cut(await B(), [await K.cyl(15, 22, [30, 20, -1])]), (f) => f.type === 'cylinder', 48000],
      ['round boss', async () => K.fuse(await K.box(60, 40, 10), [await K.cyl(8, 10, [30, 20, 10])]), (f) => f.type === 'cylinder' || (f.type === 'plane' && near(f.centroid![2], 20)), 24000],
      ['rect boss', async () => K.fuse(await K.box(60, 40, 10), [await K.box(20, 10, 6, [20, 15, 10])]), (f) => f.centroid![2] > 10 + 1e-6, 24000],
      ['big rect boss', async () => K.fuse(await K.box(60, 40, 10), [await K.box(40, 30, 10, [10, 5, 10])]), (f) => f.centroid![2] > 10 + 1e-6, 24000],
      ['pocket', async () => K.cut(await B(), [await K.box(20, 10, 9, [20, 15, 12])]), (f) => inBox(f, [20, 15, 12, 40, 25, 20]), 48000],
      ['slot', async () => K.cut(await B(), [await K.box(62, 10, 5, [-1, 15, 15])]), (f) => inBox(f, [-1, 15, 15, 61, 25, 20]) && f.bbox![3] - f.bbox![0] > 59, 48000],
    ];
    for (const [name, make, pick, want] of cases) {
      const s = await make();
      const rm = (await K.faces(s)).filter(pick).map((f) => f.i);
      const { check, v } = await K.run(s, rm, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('fillets and chamfers: one edge, a concave edge, every edge of a box, ring fillets round a boss, rounded holed boxes and plates', async () => {
    const r = await part();
    const K = kit(r);
    const box = await K.box(60, 40, 20);
    const lblock = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const topX = (await K.edges(box)).find((e) => along(e, 0) && near(e.mid![1], 0) && near(e.mid![2], 20))!.i;
    const concave = (await K.edges(lblock)).find((e) => along(e, 1) && near(e.mid![0], 30) && near(e.mid![2], 10))!.i;
    const boss = await K.fuse(await K.box(60, 40, 10), [await K.cyl(10, 10, [30, 20, 10])]);
    const ring = async (s: number, z: number) => (await K.edges(s)).find((e) => e.type === 'circle' && near(e.center![2], z))!.i;
    const ringRef = 24000 + Math.PI * 100 * 10;
    const foot = await K.blend('fillet', boss, [await ring(boss, 10)], 3);
    const both = await K.blend('fillet', foot.id, [await ring(foot.id, 20)], 2);
    const bothTori = (await K.faces(both.id)).filter((f) => f.type === 'torus').map((f) => f.i);
    const cases: [string, Promise<{ id: number; blends: number[] }>, number][] = [
      ['convex fillet R4', K.blend('fillet', box, [topX], 4), 48000],
      ['concave fillet R4', K.blend('fillet', lblock, [concave], 4), 36000],
      ['concave fillet R2', K.blend('fillet', lblock, [concave], 2), 36000],
      ['chamfer 4', K.blend('chamfer', box, [topX], 4), 48000],
      ['concave chamfer 4', K.blend('chamfer', lblock, [concave], 4), 36000],
      ['box every edge R4', K.blend('fillet', box, (await K.edges(box)).map((e) => e.i), 4), 48000],
      ['ring fillet R3 at a boss foot', Promise.resolve(foot), ringRef],
      ['ring fillets at a boss foot and rim', Promise.resolve({ id: both.id, blends: bothTori }), ringRef],
      ['ring fillet R2 at a boss rim', K.blend('fillet', boss, [await ring(boss, 20)], 2), ringRef],
    ];
    for (const base of [
      ['box with a through hole r5, every edge R1', await K.cut(await K.box(60, 40, 20), [await K.cyl(5, 22, [30, 20, -1])])],
      ['plate with a round boss, every edge R1', await K.fuse(await K.box(60, 40, 10), [await K.cyl(8, 10, [30, 20, 10])])],
      ['plate with a rect boss, every edge R1', await K.fuse(await K.box(60, 40, 10), [await K.box(20, 10, 6, [20, 15, 10])])],
    ] as [string, number][]) {
      cases.push([base[0], K.blend('fillet', base[1], (await K.edges(base[1])).map((e) => e.i), 1), await K.vol(base[1])]);
    }
    for (const [name, made, want] of cases) {
      const f = await made;
      const { check, v } = await K.run(f.id, f.blends, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('a wedge\'s tip chamfer or round (the heal brings the tip back far from the small face), and a rounded holed box read back from BREP', async () => {
    const r = await part();
    const K = kit(r);
    for (const deg of [20, 10]) {
      const t = Math.tan((deg * Math.PI) / 180);
      const profile = {
        plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
        loops: [[
          { id: 'a', kind: 'line', a: [0, 0], b: [60, 0] },
          { id: 'b', kind: 'line', a: [60, 0], b: [0, 60 * t] },
          { id: 'c', kind: 'line', a: [0, 60 * t], b: [0, 0] },
        ]],
      };
      const w = await K.extrude(profile, 40);
      const want = await K.vol(w);
      const tip = (await K.edges(w)).find((e) => along(e, 1) && near(e.mid![0], 60))!.i;
      for (const [name, made] of [
        [`${deg} deg wedge, tip chamfer 1`, K.blend('chamfer', w, [tip], 1)],
        [`${deg} deg wedge, tip round 0.5`, K.blend('fillet', w, [tip], 0.5)],
      ] as const) {
        const f = await made;
        const { check, v } = await K.run(f.id, f.blends, name);
        expect(v, name).toBeCloseTo(want, 3);
        expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
      }
    }
    // A box with R5 vertical edges, its top chain R3 and two holes, written and read back as BREP: blends, then holes.
    const b = await K.box(60, 40, 20);
    const f1 = await K.blend('fillet', b, (await K.edges(b)).filter((e) => along(e, 2)).map((e) => e.i), 5);
    const top = (await K.faces(f1.id)).find((f) => f.type === 'plane' && f.normal![2] > 0.5 && near(f.centroid![2], 20))!.i;
    const f2 = await K.blend('fillet', f1.id, (await K.edges(f1.id)).filter((e) => e.faces.includes(top)).map((e) => e.i), 3);
    const made = await K.cut(await K.cut(f2.id, [await K.cyl(3, 22, [15, 20, -1])]), [await K.cyl(4, 11, [45, 20, 10])]);
    const bytes = (await r.kernel.call('brep_write', { ids: [made] })).buffers.brep;
    const A = (await r.kernel.call('brep_read', { check: true }, { bytes })).result.shapes[0].id;
    const fsA = await K.faces(A);
    const isHole = (f: Face) => f.type === 'cylinder' && ((near(f.radius!, 3) && Math.abs(f.axis!.dir[2]) > 0.5) || near(f.radius!, 4));
    const blends = fsA.filter((f) => (f.type === 'cylinder' && !isHole(f)) || f.type === 'torus').map((f) => f.i);
    const holes = fsA.filter((f) => isHole(f) || (f.type === 'plane' && near(f.centroid![2], 10) && near(f.centroid![0], 45))).map((f) => f.i);
    const holed = await K.cut(await K.cut(await K.box(60, 40, 20), [await K.cyl(3, 22, [15, 20, -1])]), [await K.cyl(4, 11, [45, 20, 10])]);
    for (const [name, rm, want] of [
      ['blends of the rounded holed box', blends, await K.vol(holed)],
      ['holes of the rounded holed box', holes, await K.vol(f2.id)],
    ] as [string, number[], number][]) {
      const { check, v } = await K.run(A, rm, name);
      expect(v, name).toBeCloseTo(want, 3);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);

  it('a 200 x 100 plate with every edge R2 and 50 holes: the 20 blends, then the 50 holes', async () => {
    const r = await part();
    const K = kit(r);
    const plate = await K.box(200, 100, 10);
    const f = await K.blend('fillet', plate, (await K.edges(plate)).map((e) => e.i), 2);
    const tools: number[] = [];
    for (let i = 0; i < 10; ++i) for (let j = 0; j < 5; ++j) tools.push(await K.cyl(3, 12, [19 + 18 * i, 14 + 18 * j, -1]));
    const H = await K.cut(f.id, tools);
    const fs = await K.faces(H);
    const holeF = fs.filter((x) => x.type === 'cylinder' && near(x.radius!, 3) && Math.abs(x.axis!.dir[2]) > 0.5).map((x) => x.i);
    const blendF = fs.filter((x) => x.type !== 'plane' && !holeF.includes(x.i)).map((x) => x.i);
    expect(holeF).toHaveLength(50);
    expect(blendF).toHaveLength(20);
    const plain = await K.cut(await K.box(200, 100, 10), tools);
    for (const [name, rm, want] of [
      ['20 blends', blendF, await K.vol(plain)],
      ['50 holes', holeF, await K.vol(f.id)],
    ] as [string, number[], number][]) {
      const { check, v } = await K.run(H, rm, name);
      expect(v, name).toBeCloseTo(want, 2);
      expect(check, name).toMatchObject({ lost: [], covered: [], unchecked: null });
    }
  }, 120_000);
});

// ---------------------------------------------------------------- the corpus under version 2

describe('the corpus under version 2: the right bodies stay, nothing wrong is kept, the newly right listed', () => {
  /** Delete faces version 2 (or legacy) on a kernel-built body, as its build runs once the faces are found. */
  async function v2(K: ReturnType<typeof kit>, input: number, picks: number[], legacy = false) {
    const body: BuiltBody = { id: 'b_k', shape: input, valid: true, feature: 'f_k', names: null };
    const f = { id: 'f_d', type: 'delete_faces', name: 'Delete faces 1', body: 'b_k', faces: [], ...(legacy ? {} : { version: 2 }) } as DeleteFacesFeature;
    const ctx = { ...K.ctx, units: { units: () => ({ length: 'mm', angle: 'deg' }) }, bodyName: () => 'Body 1', featureName: () => null, doc: { features: [] } } as unknown as BuildContext;
    return deleteFacesOn(f, ctx, body, picks);
  }
  /** The symmetric difference of two shapes (mm³). */
  async function symdiff(K: ReturnType<typeof kit>, a: number, b: number) {
    let s = 0;
    for (const [x, y] of [[a, b], [b, a]]) {
      const d = await K.c('boolean', { op: 'cut', targets: [x], tools: [y] });
      if (!d.empty) s += await K.vol(d.id);
      await K.ctx.release([d.id]);
    }
    return s;
  }

  it('the bodies rounded round a cavity: OCCT right in two goes stays so; the T-block, which it fills, is now the sharp T-block; never a wrong body', async () => {
    const r = await part();
    const K = kit(r);
    const cases: [string, () => Promise<number>, number, 'today' | 'fillets'][] = [
      ['L-block', async () => K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]), 2, 'today'],
      ['U-channel', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 42, 11, [20, -1, 10])]), 2, 'today'],
      ['T-block', async () => K.fuse(await K.box(60, 40, 10, [0, 0, 10]), [await K.box(20, 40, 10, [20, 0, 0])]), 2, 'fillets'],
      ['pocket', async () => K.cut(await K.box(60, 40, 20), [await K.box(20, 10, 9, [20, 15, 12])]), 3, 'today'],
      ['slot', async () => K.cut(await K.box(60, 40, 20), [await K.box(62, 10, 5, [-1, 15, 15])]), 1, 'today'],
      ['side step', async () => K.cut(await K.box(60, 40, 20), [await K.box(11, 42, 6, [50, -1, 15])]), 1, 'today'],
    ];
    for (const [name, make, rad, how] of cases) {
      const s = await make();
      const sharp = await K.vol(s);
      const f = await K.blend('fillet', s, (await K.edges(s)).map((e) => e.i), rad);
      const res = await v2(K, f.id, f.blends);
      expect(res.ok, name).toBe(true);
      if (!res.ok) continue;
      expect(res.note ?? null, name).toBe(how === 'fillets' ? `Taken off as fillets up to R${rad} by Analysis Situs: OCCT's heal could not do it cleanly` : null);
      expect(await symdiff(K, res.bodies[0].shape, s), name).toBeLessThan(1e-6 * sharp);
      // Saved before version 2: the same as before kernel API 8 (the T-block red, the others the same body).
      const old = await v2(K, f.id, f.blends, true);
      expect(old.ok ? (old.warning ?? 'ok') : 'red', `${name} legacy`).toBe(how === 'today' ? 'ok' : 'red');
    }
  }, 180_000);

  it('the right removals that never reach the second way keep their body exactly (holes, bosses, a pocket, chamfers, ring fillets, a wedge tip)', async () => {
    const r = await part();
    const K = kit(r);
    const B = () => K.box(60, 40, 20);
    const boss = await K.fuse(await K.box(60, 40, 10), [await K.cyl(10, 10, [30, 20, 10])]);
    const ring = (await K.edges(boss)).find((e) => e.type === 'circle' && near(e.center![2], 10))!.i;
    const lblock = await K.cut(await K.box(60, 40, 20), [await K.box(31, 42, 11, [30, -1, 10])]);
    const concave = (await K.edges(lblock)).find((e) => along(e, 1) && near(e.mid![0], 30) && near(e.mid![2], 10))!.i;
    const cases: [string, number, number[], number][] = [];
    {
      const s = await K.cut(await B(), [await K.cyl(4, 22, [20, 20, -1])]);
      cases.push(['through hole r4', s, (await K.faces(s)).filter((f) => f.type === 'cylinder').map((f) => f.i), 48000]);
    }
    {
      const s = await K.fuse(await K.box(60, 40, 10), [await K.box(20, 10, 6, [20, 15, 10])]);
      cases.push(['rect boss', s, (await K.faces(s)).filter((f) => f.centroid![2] > 10 + 1e-6).map((f) => f.i), 24000]);
    }
    {
      const f = await K.blend('fillet', boss, [ring], 3);
      cases.push(['ring fillet R3 at a boss foot', f.id, f.blends, 24000 + Math.PI * 100 * 10]);
      const ch = await K.blend('chamfer', lblock, [concave], 4);
      cases.push(['concave chamfer 4', ch.id, ch.blends, 36000]);
      const cf = await K.blend('fillet', lblock, [concave], 2);
      cases.push(['concave fillet R2', cf.id, cf.blends, 36000]);
    }
    for (const [name, input, picks, want] of cases) {
      const res = await v2(K, input, picks);
      expect(res.ok, name).toBe(true);
      if (!res.ok) continue;
      expect(res.note, name).toBeUndefined();
      expect(await K.vol(res.bodies[0].shape), name).toBeCloseTo(want, 3);
    }
  }, 180_000);

  it('newly right: the T, I, plus, comb and Z blocks with every edge R1 or R2, which OCCT fills, are their sharp blocks', async () => {
    const r = await part();
    const K = kit(r);
    const listed: Record<string, number> = {};
    for (const name of ['T', 'I', 'plus', 'comb', 'Z']) {
      const d = FAMILY[name];
      const want = polyArea(d.xz) * d.depth;
      for (const rad of [1, 2]) {
        const sharp = await K.c('extrude', { profile: poly(d.xz), extent: { kind: 'blind', d: d.depth } });
        const f = await K.blend('fillet', sharp.id, (await K.edges(sharp.id)).map((e) => e.i), rad);
        const res = await v2(K, f.id, f.blends);
        expect(res.ok ? res.note : (res as { message: string }).message, `${name} R${rad}`).toBe(`Taken off as fillets up to R${rad} by Analysis Situs: OCCT's heal could not do it cleanly`);
        if (!res.ok) continue;
        const v = await K.vol(res.bodies[0].shape);
        expect(Math.abs(v / want - 1), `${name} R${rad}`).toBeLessThan(1e-9);
        expect(await symdiff(K, res.bodies[0].shape, sharp.id), `${name} R${rad}`).toBeLessThan(1e-6 * want);
        listed[`${name} R${rad}`] = Math.round(v * 1e6) / 1e6;
      }
    }
    // The sharp volumes (mm³): the body each Delete faces now gives.
    expect(listed).toEqual(Object.fromEntries(['T', 'I', 'plus', 'comb', 'Z'].flatMap((n) => [1, 2].map((rad) => [`${n} R${rad}`, Math.round(polyArea(FAMILY[n].xz) * FAMILY[n].depth * 1e6) / 1e6]))));
  }, 180_000);
});
