// @vitest-environment node
// Fix round 1, B2: a document saved before press-pull took curved faces (the f54f8b7 build: a
// press_pull feature with no `version`) rebuilds exactly as it was made: the prism path,
// with its step beside a slope, a chamfer or rounded edges, not the new offset. The fixture
// (tests/features/press_pull/legacy-press-pull.json) holds three saved Parts' folders: a
// 40 x 30 x 20 block (Sketch 1 + Extrude 1) with its two top edges along Y rounded r 3, one
// with its top edge at x 40 chamfered 4 mm, and a trapezoid prism whose top meets a slope;
// each with Press-pull 1: the top face +5 mm. The volumes and boxes are the prism's (the
// reviewer measured the first two with the f54f8b7 build: 28,984.12 and 29,160.00).
// The same parts with a new Press-pull (version 2) give the new geometry: the walls stay,
// the fillets stay r 3, the chamfer keeps its size, the slope is extended.
// Regenerate the fixture (it is written by this build with `version` left out, which is the
// f54f8b7 format byte for byte: the schema did not change): GEN_PP_LEGACY=<path> npx vitest run
// tests/features/press_pull/legacy-doc.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import type { RealDoc } from '../p2/real-doc';
import { FakeFolder } from '../../doc/fake-files';
import { addFeature, addSketch, body, close, edgeRef, faceRef, onPlane, openSolids, regionsOf, settle, SketchBuilder, topo } from '../solids/solids-real';

const FIXTURE = new URL('./legacy-press-pull.json', import.meta.url);
const GEN = process.env.GEN_PP_LEGACY || '';
const open: RealDoc[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
  forgetBreps();
});

type Kind = 'fillet' | 'chamfer' | 'slope';
const CORNER = (1 - Math.PI / 4) * 9 * 30;
/** What the prism path makes (the f54f8b7 build), and what a new Press-pull makes. */
const EXPECT: Record<Kind, { legacy: { volume: number; box: number[] }; v2: { volume: number; box: number[] } }> = {
  // The top (x 3..37) raised 5 as a prism: a step above each fillet.
  fillet: { legacy: { volume: 40 * 30 * 20 - 2 * CORNER + 34 * 30 * 5, box: [0, 0, 0, 40, 30, 25] }, v2: { volume: 40 * 30 * 25 - 2 * CORNER, box: [0, 0, 0, 40, 30, 25] } },
  // The top (x 0..36) raised 5 as a prism beside the chamfer, or the chamfer kept 4 mm at the new top.
  chamfer: { legacy: { volume: 40 * 30 * 20 - 0.5 * 16 * 30 + 36 * 30 * 5, box: [0, 0, 0, 40, 30, 25] }, v2: { volume: 40 * 30 * 25 - 0.5 * 16 * 30, box: [0, 0, 0, 40, 30, 25] } },
  // x 0..40 at z 0, 0..30 at z 20, 30 deep: the prism of the 30 mm top, or the slope run on to z 25.
  slope: { legacy: { volume: 21000 + 30 * 30 * 5, box: [0, -30, 0, 40, 0, 25] }, v2: { volume: (40 * 25 - 0.25 * 625) * 30, box: [0, -30, 0, 40, 0, 25] } },
};

async function makePart(kind: Kind, version?: 2): Promise<RealDoc> {
  const r = await openSolids();
  open.push(r);
  const sk = new SketchBuilder();
  if (kind === 'slope') {
    sk.line([0, 0], [40, 0]);
    sk.line([40, 0], [30, 20]);
    sk.line([30, 20], [0, 20]);
    sk.line([0, 20], [0, 0]);
  } else sk.rect(0, 0, 40, 30);
  const sketch = await addSketch(r, onPlane(kind === 'slope' ? 'origin:front' : 'origin:top', sk));
  const ex = await addFeature(r, 'extrude', { profiles: regionsOf(r, sketch), extent: { kind: 'blind', distance: `${kind === 'slope' ? 30 : 20} mm` } });
  expect(ex.status.state).toBe('ok');
  if (kind !== 'slope') {
    const t = await topo(r, body(r));
    const at = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const edges = t.edges.filter((e) => e.type === 'line' && e.first && e.last && at(e.first[2], 20) && at(e.last[2], 20) && at(e.first[0], e.last[0]) && (kind === 'fillet' || at(e.first[0], 40)));
    expect(edges).toHaveLength(kind === 'fillet' ? 2 : 1);
    const refs = await Promise.all(edges.map((e) => edgeRef(r, body(r), e.i)));
    const made = kind === 'fillet' ? await addFeature(r, 'fillet', { body: body(r).id, edges: refs, radius: '3 mm' }) : await addFeature(r, 'chamfer', { body: body(r).id, edges: refs, mode: 'distance', distance: '4 mm', distance2: '4 mm' });
    expect(made.status.state).toBe('ok');
  }
  const t = await topo(r, body(r));
  const top = t.faces.find((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99)!;
  const pp = await addFeature(r, 'press_pull', { body: body(r).id, faces: [await faceRef(r, body(r), top.i)], distance: '5 mm', version });
  expect(pp.status.state).toBe('ok');
  return r;
}

async function boxOf(r: RealDoc): Promise<number[]> {
  const b = body(r);
  const p = await r.kernel.call('props', { id: b.shape, bbox: 'exact' } as never);
  return ((p.result as { bbox: number[] }).bbox).map((x) => Math.round(x * 1e6) / 1e6 + 0);
}

describe('Press-pull saved before version 2 (fix round 1, B2)', () => {
  it.skipIf(!GEN)('writes the fixture (GEN_PP_LEGACY)', async () => {
    const out: Record<string, Record<string, string>> = {};
    for (const kind of ['fillet', 'chamfer', 'slope'] as Kind[]) {
      const r = await makePart(kind);
      const f = r.doc.state.get().doc.features.find((x) => x.type === 'press_pull')!;
      expect('version' in f && (f as { version?: number }).version !== undefined).toBe(false);
      await r.doc.flush();
      out[kind] = Object.fromEntries([...r.folder.entries].map(([rel, e]) => [rel, new TextDecoder().decode(e.bytes)]));
    }
    writeFileSync(GEN, JSON.stringify(out, null, 1) + '\n');
  }, 120_000);

  for (const kind of ['fillet', 'chamfer', 'slope'] as Kind[])
    it(`${kind}: the saved Part reopens with the prism's volume and box, and Press-pull 1 says it is the old kind`, async () => {
      const saved = JSON.parse(readFileSync(FIXTURE, 'utf8'))[kind] as Record<string, string>;
      const folder = new FakeFolder();
      for (const [rel, text] of Object.entries(saved)) folder.put(rel, new TextEncoder().encode(text));
      const model = Object.entries(saved).find(([rel]) => rel.endsWith('model.json'));
      expect(model, 'the Part file').toBeTruthy();
      const doc = JSON.parse(model![1]);
      const pf = (doc.doc ?? doc).features.find((x: { type: string }) => x.type === 'press_pull');
      expect(pf.version).toBeUndefined();
      const r = await openSolids({ folder });
      open.push(r);
      // openRealDoc loads before the solid feature types are registered: read the Part again with them.
      await r.doc.reload();
      const rb = await settle(r.doc);
      expect(rb.features[pf.id]).toMatchObject({ state: 'ok' });
      expect(rb.outputs[pf.id]).toMatchObject({ type: 'press-pull', method: 'prism', legacy: true });
      expect(rb.bodies).toHaveLength(1);
      expect(close((await r.doc.measure(rb.bodies[0].id)).volume, EXPECT[kind].legacy.volume, 1e-9)).toBe(true);
      expect(await boxOf(r)).toEqual(EXPECT[kind].legacy.box);
    }, 60_000);

  for (const kind of ['fillet', 'chamfer', 'slope'] as Kind[])
    it(`${kind}: a new Press-pull (version 2) on the same part gives the new geometry`, async () => {
      const r = await makePart(kind, 2);
      const rb = r.doc.state.get().rebuild;
      expect(close((await r.doc.measure(rb.bodies[0].id)).volume, EXPECT[kind].v2.volume, 1e-9)).toBe(true);
      expect(await boxOf(r)).toEqual(EXPECT[kind].v2.box);
    }, 60_000);
});
