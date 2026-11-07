// @vitest-environment node
// GitHub issue 15 in the document, on the REAL kernel (mk32.wasm, or CAD_KERNEL_DIR, through the real KernelAdapter):
// a helical thread groove in the wall of a hole, running out through the block's bottom face, that
// OCCT 7.9.3 cuts as if the two were apart (nothing removed, valid, no warning; kernel API 10
// answers as_if_apart 'wrong'). A body-making feature's Cut (applyBodyOp, as Extrude, Loft, Sweep,
// Revolve and Hole hand their shape over) and a Combine Cut are red in History with words that say
// what removed nothing and why, scoped or not, never "Nothing to cut" (the tool does overlap); the
// groove that ends inside the block still cuts. The groove is a feature type of this test (Loft's
// build: loft_regions, then the Operation) so the shape is the reporter's: 16 profiles a turn.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { applyBodyOp } from '../../src/doc/features/body-op';
import { combineDef } from '../../src/features/combine/feature';
import { isMiss } from '../../src/assistant/diagnose';
import { newId, nextName } from '../../src/lib/ids';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { BodyId, BodyOp, CadDoc, Feature, LoftFeature } from '../../src/types/doc';
import type { BuildContext, DocService, FeatureBuildResult, FeatureTypeDef } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import type { RegionSection, SketchCurve } from '../../src/types/kernel-protocol';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, cylinder, registerSolidFeatures } from './blocks';
import { realKernelAdapter } from '../features/extrude/kernel-adapter';

const PITCH = 1.27;
const HOLE_D = 5.1054;
const R_IN = HOLE_D / 2 - 0.0254;
const R_OUT = 6.35 / 2;
const HALF_OUT = PITCH / 16;
const HALF_IN = HALF_OUT + (R_OUT - R_IN) * Math.tan(Math.PI / 6);

interface GrooveFeature {
  id: string;
  type: 'groove';
  name: string;
  op: BodyOp;
  creates: BodyId | null;
  scope: BodyId[];
  turns: number;
}

/** The reporter's groove: `turns` turns down from z = 20 round the axis x = 15, y = 0, then the Operation. */
const grooveDef = {
  type: 'groove',
  label: 'Groove',
  icon: '',
  create: (doc: CadDoc, init: Partial<GrooveFeature> = {}): GrooveFeature => ({ id: newId('f'), type: 'groove', name: nextName('Groove', doc.features.map((f) => f.name)), op: 'cut', creates: null, scope: [], turns: 16.75, ...init }),
  resolve: () => ({ ok: true, values: {} }),
  incomplete: () => null,
  parents: () => [],
  exprs: () => [],
  mapExprs: (f: GrooveFeature) => f,
  async build(f: GrooveFeature, _v: unknown, ctx: BuildContext): Promise<FeatureBuildResult> {
    const n = Math.round(f.turns * 16);
    const sections: RegionSection[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (f.turns * i) / n;
      const a = 2 * Math.PI * t;
      const plane = { origin: [15, 0, 20 - PITCH * t], normal: [-Math.sin(a), Math.cos(a), 0], xdir: [Math.cos(a), Math.sin(a), 0] } as RegionSection['plane'];
      const curves: SketchCurve[] = [
        { id: 'l1', kind: 'line', a: [R_IN, -HALF_IN], b: [R_OUT, -HALF_OUT] },
        { id: 'l2', kind: 'line', a: [R_OUT, -HALF_OUT], b: [R_OUT, HALF_OUT] },
        { id: 'l3', kind: 'line', a: [R_OUT, HALF_OUT], b: [R_IN, HALF_IN] },
        { id: 'l4', kind: 'line', a: [R_IN, HALF_IN], b: [R_IN, -HALF_IN] },
      ];
      const key = (await ctx.kernel.call('sketch_regions', { plane, curves, tess: false })).result.regions[0].key;
      sections.push({ plane, curves, regions: [key] });
    }
    const loft = (await ctx.kernel.call('loft_regions', { sections, ruled: false })).result;
    return applyBodyOp(f as unknown as LoftFeature, f.name, { shape: loft.id, valid: loft.valid !== false, names: null }, ctx);
  },
} as unknown as FeatureTypeDef;

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
  for (const def of [grooveDef, combineDef as unknown as FeatureTypeDef]) doc.features.register(def);
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

/** Body 1: the 60 x 40 x 20 block with its 5.1054 mm hole at (15, 0), from z = 0 to 20 (Sketch 1, Extrude 1; Sketch 2, Extrude 2). */
function drilledBlock(doc: DocService): BodyId {
  const body = block(doc, { at: [-15, -20, 0], size: [60, 40, 20] }).body!;
  cylinder(doc, { op: 'cut', at: [15, 0, 0], size: [HOLE_D, 20] });
  return body;
}

const add = (doc: DocService, init: Partial<GrooveFeature> | Record<string, unknown>, type = 'groove') => {
  const s = doc.beginNew(type as Feature['type'], init as Partial<Feature>);
  const id = s.feature;
  s.commit();
  return id;
};

const BLOCK_VOLUME = 60 * 40 * 20 - Math.PI * (HOLE_D / 2) ** 2 * 20;
const WORDS = "it overlaps Body 1, but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart)";

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
