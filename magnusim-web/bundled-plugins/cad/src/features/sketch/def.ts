// The sketch feature type (docs/p2p3-plan.md §1.7): where it lies, its
// geometry (the stored solved coordinates, or re-solved when a parameter
// changed a dimension), and its profile regions from the kernel. It makes no
// body; it publishes a SketchOutput that extrudes and the overlays read.
// Sketch mode (src/sketch/, P3-SKETCH) gives its panel and edits it.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { plainKernelMessage } from '../../doc/rebuild';
import { ORIGIN_PLANES, type PlaneFrame, type SketchConstraintId, type SketchFeature, type SketchPointId, type Vec2, type Vec3 } from '../../types/doc';
import type { ExprField, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { SketchCurve } from '../../types/kernel-protocol';
import type { SketchOutput, SketchRegion, SketchSolveSource, SolverSolveResult } from '../../types/sketch';
import { curvesOf, dimensionLabel, drivenMeasures, drivingValues, entityGeometry, hasProfileCurves, isDimension, sameValues, storedRadii, withOrigin, type EntityGeom } from './geometry';
import { resolveSupport } from './plane';
import { unpackRegions } from './regions';

/** Outline glyph (24 viewBox): a pencil over a sketched corner. */
export const SKETCH_ICON = 'M4 4h7 M4 4v7 M5.5 19.5l1-4L16 6l3 3-9.5 9.5z M14 8l3 3';

export interface SketchValues {
  /** Every driving dimension's value (mm or degrees). */
  dims: Record<SketchConstraintId, number>;
}

const plainFrame = (p: PlaneFrame): PlaneFrame => ({ origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 });

export const sketchDef: FeatureTypeDef<SketchFeature, SketchValues> = {
  type: 'sketch',
  label: 'Sketch',
  icon: SKETCH_ICON,
  // Fusion: editing a sketch rolls the history to it; nothing downstream rebuilds on every stroke.
  isolateWhileEditing: true,
  create(doc, init = {}) {
    const support = init.support ?? { kind: 'plane' as const, plane: 'origin:top' as const };
    // A face support's frame comes from the kernel at the first rebuild (its output's plane); until then the given one.
    const plane = init.plane ?? plainFrame(support.kind === 'plane' ? ORIGIN_PLANES[support.plane] : ORIGIN_PLANES['origin:top']);
    return {
      id: newId('f'),
      type: 'sketch',
      name: nextName('Sketch', doc.features.map((f) => f.name)),
      points: {},
      entities: [],
      constraints: [],
      // An empty sketch has nothing free (0 DOF); sketch mode writes its own analysis on Finish sketch.
      solved: { values: {}, dof: 0, state: 'fully' },
      ...init,
      support,
      plane,
    };
  },
  resolve(f, units) {
    const r = drivingValues(f, units);
    return r.ok ? { ok: true, values: { dims: r.values } } : r;
  },
  incomplete(f, units) {
    const r = sketchDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses: (f) => (f.support.kind === 'face' ? [f.support.body] : []),
  exprs: (f) => f.constraints.flatMap((c, i): ExprField[] => (isDimension(c) ? [{ path: `constraints[${i}].expr`, expr: c.expr }] : [])),
  mapExprs: (f, fn) => ({ ...f, constraints: f.constraints.map((c) => (isDimension(c) ? { ...c, expr: fn(c.expr) } : c)) }),
  async build(f, v, ctx) {
    const warnings: string[] = [];
    const at = await resolveSupport(f, ctx);
    if (at.warning) warnings.push(at.warning);

    // Geometry: the stored solution when every driving dimension still has the value it was solved for.
    let points: Record<SketchPointId, Vec2> = f.points;
    let radii = storedRadii(f);
    let source: SketchSolveSource = 'stored';
    if (!sameValues(v.dims, f.solved.values)) {
      let solved: SolverSolveResult | null = null;
      if (!ctx.solver) {
        warnings.push(`${f.name} shows its last solved shape: the sketch solver is not running`);
      } else {
        try {
          solved = await ctx.solver.solveFeature(f, v.dims);
        } catch (err) {
          warnings.push(`${f.name} shows its last solved shape: the sketch solver failed (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (!solved) source = 'stored-unsolved';
      else if (!solved.solved) {
        const conflicting = (solved.conflicting.length ? solved.conflicting : solved.redundant).map((id) => dimensionLabel(f, id));
        return { ok: false, message: `${f.name} failed: the dimensions cannot all hold${conflicting.length ? ` (conflicting: ${conflicting.join(', ')})` : ''}` };
      } else {
        const next: Record<SketchPointId, Vec2> = { ...f.points };
        for (const id of Object.keys(f.points)) {
          const p = solved.values.points[id];
          if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) next[id] = [p[0], p[1]];
        }
        points = next;
        radii = { ...radii };
        for (const [id, r] of Object.entries(solved.values.radii ?? {})) if (Number.isFinite(r)) radii[id] = r;
        source = 'solved';
      }
    }

    let geom: EntityGeom[];
    try {
      geom = entityGeometry(f, points, radii);
    } catch (err) {
      return { ok: false, message: `${f.name} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const curves: SketchCurve[] = curvesOf(geom);

    let regions: SketchRegion[] = [];
    let open: SketchOutput['open'] = [];
    let dangling: SketchOutput['dangling'] = [];
    if (hasProfileCurves(curves)) {
      try {
        const r = await ctx.kernel.call('sketch_regions', { plane: at.plane, curves, tess: true });
        regions = unpackRegions(r.result.regions ?? [], r.buffers ?? {});
        open = r.result.open ?? [];
        dangling = r.result.dangling ?? [];
      } catch (err) {
        const e = err as KernelCallError;
        if (e.kind === 'input' && /unknown op/i.test(e.message)) {
          warnings.push(`${f.name} has no profiles: this kernel cannot find profile regions (it needs kernel API 3)`);
        } else if (e.kind === 'input' || e.kind === 'occt') {
          // The geometry itself is the problem ("line e_3 has no length"): the sketch still shows; profiles wait for a fix.
          warnings.push(`${f.name} has no profiles: ${plainKernelMessage(e.message)}`);
        } else if (e.kind === 'internal') {
          return { ok: false, message: `${f.name} failed: the kernel could not find its profiles (${e.message})` };
        } else throw err;
      }
    }

    const used: Record<string, number> = {};
    for (const g of geom) if (g.kind === 'circle' || g.kind === 'arc') used[g.id] = g.r;
    const output: SketchOutput = {
      type: 'sketch',
      plane: at.plane,
      points: withOrigin(points),
      radii: used,
      curves,
      regions,
      open,
      dangling,
      measured: drivenMeasures(f, geom, points),
      source,
      ...(at.lost ? { supportLost: true } : {}),
    };
    return { ok: true, bodies: [], removed: [], output, ...(warnings.length ? { warning: warnings.join('; ') } : {}) };
  },
};
