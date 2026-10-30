// @vitest-environment node
// Volumes the person sees on B-spline bodies (kernel API 7, 2026-10-30), through the document on
// the real kernel: a ruled Loft between two airfoil sketches (closed splines) on Top and on a plane
// 400 mm up. Its volume is its section's area (the sketch region's, exact) times 400; the plain
// integration read it 0.2 % low. A Press-pull of its top cap by 0.1 mm builds and adds the cap's
// area times 0.1 (it was refused: "its volume would change by ... instead of about ..."), and a
// Combine Cut with a block that only touches the cap says "Nothing to cut" (it passed, and the
// volume rose by thousands of mm³).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { refPlaneDef } from '../../../src/features/refgeom/defs';
import type { FeatureTypeDef } from '../../../src/types/doc-service';
import type { Vec2 } from '../../../src/types/doc';
import type { RealDoc } from '../p2/real-doc';
import { addFeature, addSketch, faceRef, onPlane, openSolids, regionsOf, SketchBuilder, topo, volume } from './solids-real';

const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

async function part() {
  const r = await openSolids();
  if (!r.doc.features.get('ref_plane')) r.doc.features.register(refPlaneDef as unknown as FeatureTypeDef);
  open.push(r);
  return r;
}

/** An airfoil-like closed outline (chord c, thickness th, centre offset (cx, cy)): 15 poles. */
function airfoilPoles(chord = 600, th = 0.24, cx = 0, cy = 0): Vec2[] {
  const P: Vec2[] = [];
  const n = 16;
  for (let i = 0; i < n - 1; i++) {
    const a = (2 * Math.PI * i) / (n - 1);
    const x = 0.5 * chord * Math.cos(a);
    const t = x / chord + 0.5;
    const y = th * chord * (0.2969 * Math.sqrt(Math.max(t, 0)) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4) * 5 * Math.sign(Math.sin(a) || 1) + 0.15 * chord * Math.sin(a);
    P.push([cx + x, cy + y]);
  }
  return P;
}

/**
 * A sketch of an airfoil on Top (z 0) or on the plane feature `on` at height z: a control spline
 * whose last pole is its first (closed, clamped ends), or a closed (periodic) one.
 */
async function airfoilSketch(r: RealDoc, on: string | null, z = 400, P = airfoilPoles(), periodic = true): Promise<string> {
  const points = Object.fromEntries(P.map((p, i) => [`p_${i + 1}`, p]));
  const ids = P.map((_, i) => `p_${i + 1}`);
  const entities = [periodic ? { id: 'e_1', kind: 'spline', form: 'control', pts: ids, degree: 3, closed: true } : { id: 'e_1', kind: 'spline', form: 'control', pts: [...ids, ids[0]], degree: 3 }];
  const base = onPlane('origin:top', new SketchBuilder());
  return addSketch(r, {
    ...base,
    ...(on ? { support: { kind: 'feature', feature: on }, plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] } } : {}),
    points,
    entities,
  } as never);
}

/** The ruled loft (its body id, the section's exact area, the top cap's face index). */
async function airfoilLoft(r: RealDoc) {
  const plane = await addFeature(r, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '400 mm' });
  expect(plane.status.state).toBe('ok');
  const s1 = await airfoilSketch(r, null);
  const s2 = await airfoilSketch(r, plane.id);
  const out = r.doc.state.get().rebuild.outputs[s1];
  if (!out || out.type !== 'sketch') throw new Error('the sketch did not build');
  expect(out.regions).toHaveLength(1);
  const area = out.regions[0].area;
  const lf = await addFeature(r, 'loft', { sections: [...regionsOf(r, s1), ...regionsOf(r, s2)], ruled: true });
  expect(lf.status.state).toBe('ok');
  const b = r.doc.state.get().rebuild.bodies.find((x) => x.feature === lf.id)!;
  const top = (await topo(r, b)).faces.find((f) => f.type === 'plane' && f.normal![2] > 0.99)!;
  return { body: b, area, top, loft: lf.id };
}

describe('volumes of a lofted B-spline body (kernel API 7)', () => {
  it("a ruled airfoil loft's volume is its section's area times its length (plain read it 0.2 % low)", async () => {
    const r = await part();
    const { body, area } = await airfoilLoft(r);
    expect(area).toBeGreaterThan(50_000);
    const v = await volume(r, body.id);
    expect(Math.abs(v / (area * 400) - 1)).toBeLessThan(1e-9);
  }, 120_000);

  it('Press-pull of its top cap by 0.1 mm builds and adds the area times 0.1 (it was refused for a wrong volume)', async () => {
    const r = await part();
    const { body, area, top } = await airfoilLoft(r);
    const v0 = await volume(r, body.id);
    const pp = await addFeature(r, 'press_pull', { body: body.id, faces: [await faceRef(r, body, top.i)], distance: '0.1 mm', version: 2 });
    expect(pp.status.message ?? '').toBe('');
    expect(pp.status.state).toBe('ok');
    const v1 = await volume(r, body.id);
    expect(Math.abs((v1 - v0) / (area * 0.1) - 1)).toBeLessThan(1e-3);
  }, 120_000);

  it('a Combine Cut with a block that only touches the top cap of a 3-section loft says Nothing to cut (it passed and the volume rose 17,756 mm³)', async () => {
    const r = await part();
    // The repro's loft: airfoils of chord 600, 520 and 420 at z 0, 200 and 400, each a little further along.
    const p200 = await addFeature(r, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '200 mm' });
    const p400 = await addFeature(r, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '400 mm' });
    const s0 = await airfoilSketch(r, null, 0, airfoilPoles(600, 0.24), false);
    const s1 = await airfoilSketch(r, p200.id, 200, airfoilPoles(520, 0.22, 30, 10), false);
    const s2 = await airfoilSketch(r, p400.id, 400, airfoilPoles(420, 0.2, 60, 20), false);
    const lf = await addFeature(r, 'loft', { sections: [...regionsOf(r, s0), ...regionsOf(r, s1), ...regionsOf(r, s2)], ruled: false });
    expect(lf.status.state).toBe('ok');
    const body = r.doc.state.get().rebuild.bodies.find((x) => x.feature === lf.id)!;
    const v0 = await volume(r, body.id);
    const sk = new SketchBuilder();
    sk.rect(0, 0, 200, 100);
    const s = await addSketch(r, onPlane('origin:top', sk));
    const blk = await addFeature(r, 'extrude', { profiles: regionsOf(r, s), extent: { kind: 'two', distance: '450 mm', distance2: '-400 mm' } });
    expect(blk.status.state).toBe('ok');
    const tool = r.doc.state.get().rebuild.bodies.find((x) => x.feature === blk.id)!;
    const cut = await addFeature(r, 'combine', { op: 'cut', targets: [body.id], tools: [tool.id], keepTools: false });
    expect(cut.status.state).toBe('error');
    expect(cut.status.message).toMatch(/failed: Nothing to cut: .* does not overlap .* \(touching is not enough\)$/);
    expect(await volume(r, body.id)).toBeCloseTo(v0, 3);
  }, 120_000);
});
