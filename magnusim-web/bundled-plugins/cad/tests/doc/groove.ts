// GitHub issue 15's shapes as a feature type of tests, for the document on the REAL kernel: the
// 60 x 40 x 20 block with its 5.1054 mm hole at (15, 0) (a 1/4-20 tap drill), and the helical
// groove in the hole's wall (a loft through a 1/4-20 thread's basic profile, 16 profiles a turn,
// 1.27 mm a turn, its inner edge 0.0254 mm inside the wall) that OCCT 7.9.3 takes for apart from
// the block when it runs out through the block's bottom face (16.75 turns; 15.3 turns ends inside
// and cuts 86.19 mm3). The groove's build is Loft's: loft_regions, then the Operation (applyBodyOp),
// so the shape is the reporter's. With `counterbore`, a 7 mm cylinder from z = 18 to 20 is fused onto
// it, its top flush with the block's top (review round 1). Registered as type 'groove', or as 'loft'
// so a feature pattern may repeat it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { applyBodyOp } from '../../src/doc/features/body-op';
import { newId, nextName } from '../../src/lib/ids';
import type { BodyId, BodyOp, CadDoc, LoftFeature } from '../../src/types/doc';
import type { BuildContext, DocService, FeatureBuildResult, FeatureTypeDef } from '../../src/types/doc-service';
import type { RegionSection, SketchCurve } from '../../src/types/kernel-protocol';
import { block, cylinder } from './blocks';

const PITCH = 1.27;
export const HOLE_D = 5.1054;
const R_IN = HOLE_D / 2 - 0.0254;
const R_OUT = 6.35 / 2;
const HALF_OUT = PITCH / 16;
const HALF_IN = HALF_OUT + (R_OUT - R_IN) * Math.tan(Math.PI / 6);

export interface GrooveFeature {
  id: string;
  type: 'groove' | 'loft';
  name: string;
  op: BodyOp;
  creates: BodyId | null;
  scope: BodyId[];
  turns: number;
  /** Round the axis x = at, y = 0 (15: the block's hole). */
  at?: number;
  counterbore?: boolean;
}

/** The reporter's groove: `turns` turns down from z = 20 round the axis x = at, y = 0, then the Operation. */
export function grooveDef(type: GrooveFeature['type'] = 'groove'): FeatureTypeDef {
  return {
    type,
    label: 'Groove',
    icon: '',
    create: (doc: CadDoc, init: Partial<GrooveFeature> = {}): GrooveFeature => ({ id: newId('f'), type, name: nextName('Groove', doc.features.map((f) => f.name)), op: 'cut', creates: null, scope: [], turns: 16.75, ...init }),
    resolve: () => ({ ok: true, values: {} }),
    incomplete: () => null,
    parents: () => [],
    exprs: () => [],
    mapExprs: (f: GrooveFeature) => f,
    async build(f: GrooveFeature, _v: unknown, ctx: BuildContext): Promise<FeatureBuildResult> {
      const x = f.at ?? 15;
      const n = Math.round(f.turns * 16);
      const sections: RegionSection[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (f.turns * i) / n;
        const a = 2 * Math.PI * t;
        const plane = { origin: [x, 0, 20 - PITCH * t], normal: [-Math.sin(a), Math.cos(a), 0], xdir: [Math.cos(a), Math.sin(a), 0] } as RegionSection['plane'];
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
      let shape = loft.id;
      if (f.counterbore) {
        const cb = (await ctx.kernel.call('cylinder', { r: 3.5, h: 2, origin: [x, 0, 18], axis: [0, 0, 1] })).result.id;
        shape = (await ctx.kernel.call('boolean', { op: 'fuse', targets: [loft.id], tools: [cb] })).result.id;
        await ctx.release([loft.id, cb]);
      }
      return applyBodyOp(f as unknown as LoftFeature, f.name, { shape, valid: loft.valid !== false, names: null }, ctx);
    },
  } as unknown as FeatureTypeDef;
}

/** Body 1: the 60 x 40 x 20 block with its 5.1054 mm hole at (15, 0), from z = 0 to 20 (Sketch 1, Extrude 1; Sketch 2, Extrude 2). */
export function drilledBlock(doc: DocService): BodyId {
  const body = block(doc, { at: [-15, -20, 0], size: [60, 40, 20] }).body!;
  cylinder(doc, { op: 'cut', at: [15, 0, 0], size: [HOLE_D, 20] });
  return body;
}

/** The drilled block's volume (mm3). */
export const BLOCK_VOLUME = 60 * 40 * 20 - Math.PI * (HOLE_D / 2) ** 2 * 20;
