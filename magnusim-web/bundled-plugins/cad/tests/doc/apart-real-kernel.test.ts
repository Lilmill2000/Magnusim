// @vitest-environment node
// GitHub issue 15 in the document, on the REAL kernel (mk32.wasm, or CAD_KERNEL_DIR, through the real KernelAdapter):
// a helical thread groove in the wall of a hole, running out through the block's bottom face, that
// OCCT 7.9.3 cuts as if the two were apart (nothing removed, valid, no warning; kernel API 10
// answers as_if_apart 'wrong'). A body-making feature's Cut (applyBodyOp, as Extrude, Loft, Sweep,
// Revolve and Hole hand their shape over) and a Combine Cut are red in History with words that say
// what removed nothing and why, scoped or not, never "Nothing to cut" (the tool does overlap); the
// groove that ends inside the block still cuts. The groove is a feature type of this test
// (tests/doc/groove.ts: Loft's build) so the shape is the reporter's: 16 profiles a turn.
// Review round 1: the groove with a counterbore flush with the block's top fused on (one tool) is
// red as a Cut and as a Join (OCCT gave the block back as it was); a Join or Cut over the block and
// a second body the groove runs into is red, naming the block, and says the second body is left as
// it was (never Body 1 in two solids with Body 2 gone, "ok"); a Combine Cut of two targets says so
// too; a Linear pattern of the groove onto a second hole is red naming Instance 2, scoped or not
// (never "already cut away"); the Assistant's overlap facts and the interference check say the
// block and the groove overlap, unmeasured (never "overlap 0" or "touching").
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { combineDef } from '../../src/features/combine/feature';
import { checkInterference, UNMEASURED_OVERLAP } from '../../src/features/assembly/check';
import { PATTERN_DEFS } from '../../src/features/pattern/defs';
import { isMiss } from '../../src/assistant/diagnose';
import { overlapFacts } from '../../src/assistant/measure';
import { asBody, interferenceReply } from '../../src/assistant/tools/check';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { AppServices } from '../../src/types/app';
import type { Feature } from '../../src/types/doc';
import type { DocService, FeatureTypeDef } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, cylinder, registerSolidFeatures } from './blocks';
import { BLOCK_VOLUME, drilledBlock, grooveDef, HOLE_D, type GrooveFeature } from './groove';
import { realKernelAdapter } from '../features/extrude/kernel-adapter';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function open() {
  const ws = createFakeWorkspace({ units: 'metric' });
  const { kernel } = realKernelAdapter();
  await kernel.start();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  for (const def of [grooveDef('groove'), grooveDef('loft'), combineDef as unknown as FeatureTypeDef, ...(PATTERN_DEFS as unknown as FeatureTypeDef[])]) doc.features.register(def);
  disposers.push(() => {
    doc.dispose();
    kernel.dispose();
  });
  await doc.load();
  return { kernel, doc };
}

async function settle(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state ?? 'pending', f.name).not.toBe('pending');
    },
    { timeout: 90_000, interval: 20 },
  );
  return doc.state.get().rebuild;
}

const add = (doc: DocService, init: Partial<GrooveFeature> | Record<string, unknown>, type = 'groove') => {
  const s = doc.beginNew(type as Feature['type'], init as Partial<Feature>);
  const id = s.feature;
  s.commit();
  return id;
};

const WORDS = "it overlaps Body 1, but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart)";
/** Body 2 of the review's two-body Parts: a 6 x 6 x 2.7 block under the hole (z -3 to -0.3), which the groove runs into. */
const underBlock = (doc: DocService) => block(doc, { at: [12, -3, -3], size: [6, 6, 2.7] }).body!;
const UNDER_VOLUME = 6 * 6 * 2.7;

describe('a cut OCCT answers as if apart (GitHub issue 15)', () => {
  it('the groove that runs out through the bottom face, no scope: its Cut is red in History in words, not "Nothing to cut" (the common is empty too); the body is as it was', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    let r = await settle(doc);
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
    const g = add(doc, { turns: 16.75 });
    r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: `Groove 1 failed: ${WORDS}` });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
    // The Assistant reads a miss ("which way it missed") only from "Nothing to cut" words: an Extrude
    // or Revolve failing in these words is not one (region-tools' scoped-cut check never runs either).
    const asExtrude = { ...doc.state.get().doc.features.find((f) => f.type === 'extrude' && f.name === 'Extrude 2')!, name: 'Groove 1' } as Feature;
    expect(isMiss(asExtrude, r.features[g].message)).toBe(false);
  }, 180_000);

  it('scoped to Body 1 (the Bodies box, a scoped cut of the Assistant): red in the same words, where it built "ok" with nothing removed', async () => {
    const { doc } = await open();
    const body = drilledBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 16.75, scope: [body] });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: `Groove 1 failed: ${WORDS}` });
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
  }, 180_000);

  it('the groove that ends inside the block cuts 86.19 mm3 from it, as before', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 15.3 });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'ok' });
    expect(BLOCK_VOLUME - r.bodies[0].volume!).toBeCloseTo(86.195, 2);
  }, 180_000);

  it('Combine Cut of the block by the groove as a body: red in words naming both bodies, not "Nothing to cut"', async () => {
    const { doc } = await open();
    const body = drilledBlock(doc);
    const made = add(doc, { turns: 16.75, op: 'new' });
    let r = await settle(doc);
    expect(r.features[made]).toMatchObject({ state: 'ok' });
    const groove = (doc.state.get().doc.features.find((f) => f.id === made) as unknown as GrooveFeature).creates!;
    const c = add(doc, { op: 'cut', targets: [body], tools: [groove], keepTools: false }, 'combine');
    r = await settle(doc);
    expect(r.features[c]).toMatchObject({ state: 'error', message: "Combine 1 failed: Body 2 overlaps Body 1, but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart)" });
  }, 180_000);
});

describe('review round 1: a cap flush with the block, two bodies, a pattern, the overlap readers', () => {
  it('a counterbore flush with the block\'s top fused onto the groove (one tool), no scope: its Cut is red in the same words, where it built "ok" with nothing removed', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 16.75, counterbore: true });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: `Groove 1 failed: ${WORDS}` });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
  }, 180_000);

  it('the same tool as a Join, no scope: red in words that say the join gave Body 1 back as it was, never "ok" with the tool gone', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 16.75, counterbore: true, op: 'join' });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: "Groove 1 failed: it overlaps Body 1, but the geometry kernel's join gave Body 1 back as it was (OCCT took the two for apart)" });
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
  }, 180_000);

  it('a Join over the block and a block under it the groove runs into, no scope: red naming Body 1, Body 2 left as it was, where Body 1 became two solids and Body 2 went, "ok"', async () => {
    const { doc, kernel } = await open();
    drilledBlock(doc);
    underBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 16.75, op: 'join' });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: "Groove 1 failed: it overlaps Body 1, but the geometry kernel's join kept them as separate solids (OCCT took the two for apart); Body 2 is left as it was too" });
    expect(r.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    expect(r.bodies[0].volume).toBeCloseTo(BLOCK_VOLUME, 4);
    expect(r.bodies[1].volume).toBeCloseTo(UNDER_VOLUME, 6);
    expect((await kernel.call('props', { id: r.bodies[0].shape, bbox: 'none' })).result.solids).toBe(1);
  }, 180_000);

  it('a Cut over the same two bodies: red, and the words say Body 2 is left as it was too (the feature fails whole)', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    underBlock(doc);
    await settle(doc);
    const g = add(doc, { turns: 16.75 });
    const r = await settle(doc);
    expect(r.features[g]).toMatchObject({ state: 'error', message: `Groove 1 failed: ${WORDS}; Body 2 is left as it was too` });
    expect(r.bodies[1].volume).toBeCloseTo(UNDER_VOLUME, 6);
  }, 180_000);

  it('a Combine Cut of the block and a second body by the groove: red, and the words say the second body is left as it was too', async () => {
    const { doc } = await open();
    const body = drilledBlock(doc);
    const under = underBlock(doc);
    const made = add(doc, { turns: 16.75, op: 'new' });
    let r = await settle(doc);
    const groove = (doc.state.get().doc.features.find((f) => f.id === made) as unknown as GrooveFeature).creates!;
    const c = add(doc, { op: 'cut', targets: [body, under], tools: [groove], keepTools: false }, 'combine');
    r = await settle(doc);
    expect(r.features[c]).toMatchObject({ state: 'error', message: "Combine 1 failed: Body 3 overlaps Body 1, but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart); Body 2 is left as it was too" });
  }, 180_000);

  for (const scoped of [false, true])
    it(`a Linear pattern of the groove onto a second hole 20 mm along X, ${scoped ? 'scoped to Body 1' : 'no scope'}: red in words naming Instance 2, never "already cut away"`, async () => {
      const { doc } = await open();
      const body = drilledBlock(doc);
      cylinder(doc, { op: 'cut', at: [35, 0, 0], size: [HOLE_D, 20] });
      let r = await settle(doc);
      const before = r.bodies[0].volume!;
      const g = add(doc, { turns: 16.75, ...(scoped ? { scope: [body] } : {}) }, 'loft');
      await settle(doc);
      const p = add(doc, { of: 'features', features: [g], dir1: { axis: { kind: 'origin', axis: 'origin:x' }, flip: false, count: '2', mode: 'spacing', distance: '20 mm', symmetric: false } }, 'pattern_linear');
      r = await settle(doc);
      expect(r.features[p]).toMatchObject({ state: 'error', message: "Linear pattern 1 failed: Instance 2 of Groove 1 overlaps Body 1, but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart)" });
      expect(r.bodies[0].volume).toBeCloseTo(before, 4);
    }, 240_000);

  it('the pattern of the groove that ends inside the block cuts at the second hole, as before', async () => {
    const { doc } = await open();
    drilledBlock(doc);
    cylinder(doc, { op: 'cut', at: [35, 0, 0], size: [HOLE_D, 20] });
    await settle(doc);
    const g = add(doc, { turns: 15.3 }, 'loft');
    let r = await settle(doc);
    const after = r.bodies[0].volume!;
    const p = add(doc, { of: 'features', features: [g], dir1: { axis: { kind: 'origin', axis: 'origin:x' }, flip: false, count: '2', mode: 'spacing', distance: '20 mm', symmetric: false } }, 'pattern_linear');
    r = await settle(doc);
    expect(r.features[p]).toMatchObject({ state: 'ok' });
    expect(after - r.bodies[0].volume!).toBeCloseTo(86.195, 2);
  }, 240_000);

  it("the Assistant's overlap facts and the interference check on the block and the groove as a body: they overlap, unmeasured, in words (never overlap 0 or touching)", async () => {
    const { doc, kernel } = await open();
    drilledBlock(doc);
    add(doc, { turns: 16.75, op: 'new' });
    const r = await settle(doc);
    const [a, b] = r.bodies;
    expect([a.name, b.name]).toEqual(['Body 1', 'Body 2']);
    const services = { kernel } as unknown as AppServices;
    expect(await overlapFacts(services, a, b, { a: 1, b: 1 })).toEqual({ overlap: null, unionSolids: null, unionVoids: null, note: 'Body 1 and Body 2 overlap, but the geometry kernel could not compute what they share or their union (OCCT took the two for apart)' });
    const i = await checkInterference({ kernel }, [asBody(a), asBody(b)], { clearance: 0 });
    expect(i).toMatchObject({ checked: 1, touching: 0, complete: true });
    expect(i.rows).toEqual([{ a: 'Body 1', b: 'Body 2', overlap: null, unmeasured: true, press: false, gap: null, at: expect.any(Array) }]);
    // Where they overlap: a point of one inside the other, in the hole's wall where the groove is.
    const [x, y, z] = i.rows[0].at;
    expect(Math.hypot(x - 15, y)).toBeGreaterThan(HOLE_D / 2 - 1e-3);
    expect(Math.hypot(x - 15, y)).toBeLessThan(6.35 / 2 + 1e-3);
    expect(z).toBeGreaterThan(-1e-3);
    expect(z).toBeLessThan(20 + 1e-3);
    const reply = interferenceReply(i, 0);
    expect(reply.text).toBe('1 pair overlaps (2 bodies, 1 of 1 pairs near enough to measure): Body 1 and Body 2 (not measured)');
    expect(reply.data).toMatchObject({ overlaps: 1, rows: [{ bodies: ['Body 1', 'Body 2'], overlap_mm3: null, overlap_unmeasured: UNMEASURED_OVERLAP }] });
  }, 180_000);
});
