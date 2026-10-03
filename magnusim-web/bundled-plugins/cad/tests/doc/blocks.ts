// Solids for document tests, made as the app makes them since Box and Cylinder
// were removed (decision 2026-10-01: parts come from sketches): a sketch on the
// Top plane (a rectangle or a circle), then an Extrude of its one region.
//   blockSketch / circleSketch  the sketch feature's fields (stored geometry)
//   profileOf                   the RegionRef an extrude keeps (key as the
//                               kernels below name it)
//   block / cylinder            Sketch N + Extrude N through the DocService
//                               (two features, two undo steps)
//   BlockKernel                 the scripted toy kernel (fake-profiles-kernel)
//                               answering any such sketch with its one region
// The z range [z0, z0 + h] is a blind extrude from the Top plane when z0 is 0,
// else Two sides (distance z0 + h along +Z, distance2 -z0 against it).
// SPDX-License-Identifier: GPL-3.0-or-later
import { extrudeDef } from '../../src/features/extrude/def';
import { sketchDef } from '../../src/features/sketch/def';
import { enclosureDef } from '../../src/features/enclosure/def';
import { ORIGIN_PLANES, type BodyId, type BodyOp, type ExtrudeExtentDef, type ExtrudeFeature, type Feature, type OriginPlaneRef, type RegionRef, type SketchFeature, type Vec2, type Vec3 } from '../../src/types/doc';
import type { DocService, FeatureTypeDef } from '../../src/types/doc-service';
import type { KernelReply } from '../../src/types/kernel';
import type { KernelOp, SketchCurve } from '../../src/types/kernel-protocol';
import { ProfilesFakeKernel, rectRegion, type FakeRegion } from '../features/sketch/fake-profiles-kernel';

/** Register the feature types a Part has in the app (the modules do it there). */
export function registerSolidFeatures(doc: DocService): void {
  for (const def of [sketchDef, extrudeDef, enclosureDef]) if (!doc.features.get(def.type)) doc.features.register(def as unknown as FeatureTypeDef);
}

/** A W x D rectangle with its corner at (x, y), counter-clockwise: e_1..e_4 through pt_1..pt_4. */
export function blockSketch(x = 0, y = 0, w = 20, d = 20): Partial<SketchFeature> {
  return {
    support: { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points: { pt_1: [x, y], pt_2: [x + w, y], pt_3: [x + w, y + d], pt_4: [x, y + d] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
      { id: 'e_2', kind: 'line', p: ['pt_2', 'pt_3'] },
      { id: 'e_3', kind: 'line', p: ['pt_3', 'pt_4'] },
      { id: 'e_4', kind: 'line', p: ['pt_4', 'pt_1'] },
    ],
    constraints: [],
    solved: { values: {}, dof: 8, state: 'under' },
  };
}

/** A circle of radius r about (cx, cy) on an origin plane (Top by default): e_1 round pt_1. */
export function circleSketch(cx = 0, cy = 0, r = 10, plane: OriginPlaneRef = 'origin:top'): Partial<SketchFeature> {
  const p = ORIGIN_PLANES[plane];
  return {
    support: { kind: 'plane', plane },
    plane: { origin: [...p.origin], normal: [...p.normal], xdir: [...p.xdir] },
    points: { pt_1: [cx, cy] },
    entities: [{ id: 'e_1', kind: 'circle', c: 'pt_1', r }],
    constraints: [],
    solved: { values: {}, dof: 3, state: 'under' },
  };
}

/** The region key the real kernel and BlockKernel give these sketches. */
export const BLOCK_KEY = '+e_1[p:pt_1>p:pt_2] +e_2[p:pt_2>p:pt_3] +e_3[p:pt_3>p:pt_4] +e_4[p:pt_4>p:pt_1]';
export const CIRCLE_KEY = '+e_1[]';

/** The profile an extrude of one of these sketches keeps. */
export function profileOf(sketch: string, init: Partial<SketchFeature>): RegionRef {
  const circle = init.entities?.[0]?.kind === 'circle';
  const pts = Object.values(init.points ?? {}) as Vec2[];
  const sample: Vec2 = circle ? pts[0] : [(Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2, (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2];
  return { sketch, region: circle ? CIRCLE_KEY : BLOCK_KEY, entities: circle ? ['e_1'] : ['e_1', 'e_2', 'e_3', 'e_4'], sample };
}

/** The extent that spans z0 .. z0 + h from the Top plane. */
export function extentFor(z0: number, h: number): ExtrudeExtentDef {
  return z0 === 0 ? { kind: 'blind', distance: `${h} mm` } : { kind: 'two', distance: `${z0 + h} mm`, distance2: `${-z0} mm` };
}

export interface BlockOptions {
  /** Corner (x, y, z) of a block; centre (x, y) and base z of a cylinder. */
  at?: Vec3;
  /** Block: [W, D, H]; cylinder: [diameter, height]. */
  size?: number[];
  op?: BodyOp;
  scope?: BodyId[];
  /** A cylinder's axis: Z (a circle on Top, the default) or X (a circle on the Right plane, centre (y, z) = (at[1], at[2]), from x = at[0]). */
  axis?: 'x' | 'z';
  /** Leave the extrude's panel session open (returned) instead of committing it. */
  open?: boolean;
  extrude?: Partial<ExtrudeFeature>;
}

export interface Made {
  sketch: string;
  extrude: string;
  /** The extrude's body (op new). */
  body: BodyId | null;
  session: ReturnType<DocService['beginNew']> | null;
}

function solid(doc: DocService, init: Partial<SketchFeature>, z0: number, h: number, o: BlockOptions): Made {
  const sk = doc.beginNew('sketch', init as Partial<Feature>);
  sk.commit();
  const ex = doc.beginNew('extrude', { profiles: [profileOf(sk.feature, init)], extent: extentFor(z0, h), op: o.op ?? 'new', ...(o.op && o.op !== 'new' ? { creates: null, scope: o.scope ?? [] } : {}), ...o.extrude } as Partial<Feature>);
  const id = ex.feature;
  if (!o.open) ex.commit();
  const f = doc.state.get().doc.features.find((g) => g.id === id) as ExtrudeFeature | undefined;
  return { sketch: sk.feature, extrude: id, body: f?.creates ?? null, session: o.open ? ex : null };
}

/** Sketch N (a rectangle on Top) + Extrude N: a W x D x H block with its corner at `at`. */
export function block(doc: DocService, o: BlockOptions = {}): Made {
  const [x, y, z] = o.at ?? [0, 0, 0];
  const [w, d, h] = o.size ?? [20, 20, 20];
  return solid(doc, blockSketch(x, y, w, d), z, h, o);
}

/** Sketch N (a circle) + Extrude N: a cylinder along Z (or X), its base centre at `at`. */
export function cylinder(doc: DocService, o: BlockOptions = {}): Made {
  const [x, y, z] = o.at ?? [0, 0, 0];
  const [dia, h] = o.size ?? [20, 20];
  if (o.axis === 'x') return solid(doc, circleSketch(y, z, dia / 2, 'origin:right'), x, h, o);
  return solid(doc, circleSketch(x, y, dia / 2), z, h, o);
}

/** The one region of a rectangle or circle sketch (the toy kernel's answer). */
export function blockRegions(curves: SketchCurve[]): { regions: FakeRegion[] } {
  const circle = curves.find((c): c is Extract<SketchCurve, { kind: 'circle' }> => c.kind === 'circle');
  if (circle) {
    const r = rectRegion(CIRCLE_KEY, [circle.id], circle.c[0] - circle.r, circle.c[1] - circle.r, circle.c[0] + circle.r, circle.c[1] + circle.r);
    return { regions: [{ ...r, area: Math.PI * circle.r * circle.r, sample: [circle.c[0], circle.c[1]] }] };
  }
  const lines = curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');
  if (lines.length < 4) return { regions: [] };
  const us = lines.flatMap((l) => [l.a[0], l.b[0]]);
  const vs = lines.flatMap((l) => [l.a[1], l.b[1]]);
  const key = lines.map((l) => `+${l.id}[p:${l.pa}>p:${l.pb}]`).join(' ');
  return { regions: [rectRegion(key, lines.map((l) => l.id), Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs))] };
}

/**
 * The toy kernel (every shape an axis-aligned box) that also answers sketches and
 * extrudes. A scripted failure of sketch_regions / extrude_regions / repair is
 * thrown (a stop: watchdog, crash, out of memory, respawns the worker) as
 * FakeKernel does for its own ops.
 */
export class BlockKernel extends ProfilesFakeKernel {
  constructor() {
    super();
    this.regionsFor = blockRegions;
  }

  override async call<Op extends KernelOp>(op: Op, params: Record<string, unknown> & object, opts: { timeoutMs?: number } = {}): Promise<KernelReply<Op>> {
    // The ops the profiles kernel answers itself (it would not run the failure script for repair).
    if (op === 'sketch_regions' || op === 'extrude_regions' || op === 'repair') {
      const f = this.script.fail?.(op, params as Record<string, unknown>);
      if (f) {
        this.calls.push({ op, params: params as Record<string, unknown>, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
        await Promise.resolve();
        const e = Object.assign(new Error(f.message), { kind: f.kind, op, oom: f.oom, seconds: f.kind === 'watchdog' ? 20 : undefined });
        if (f.kind === 'watchdog' || f.kind === 'trap' || f.kind === 'crash' || f.oom) queueMicrotask(() => void this.respawn(f.message));
        throw e;
      }
    }
    return super.call(op, params, opts);
  }
}

/**
 * A block as stored features (for engine tests without a DocService): Sketch n
 * (id f_sk<n>) and Extrude n (id f_ex<n>, body b_<n> when op is new).
 */
export function blockPair(n: number, op: BodyOp, at: Vec3, size: number | Vec3 = 20, extra: Partial<ExtrudeFeature> = {}): [SketchFeature, ExtrudeFeature] {
  const [w, d, h] = typeof size === 'number' ? [size, size, size] : size;
  const init = blockSketch(at[0], at[1], w, d);
  const sketch = { id: `f_sk${n}`, type: 'sketch', name: `Sketch ${n}`, ...init } as SketchFeature;
  const extrude: ExtrudeFeature = {
    id: `f_ex${n}`,
    type: 'extrude',
    name: `Extrude ${n}`,
    op,
    creates: op === 'new' ? `b_${n}` : null,
    scope: [],
    profiles: [profileOf(sketch.id, init)],
    extent: extentFor(at[2], h),
    flip: false,
    ...extra,
  };
  return [sketch, extrude];
}
