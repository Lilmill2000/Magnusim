// The revolve feature type (proposal §2.5): profiles of one sketch turned about an
// axis (a sketch centerline or line, a straight or round model edge, a round face's
// axis, an origin axis or a CONSTRUCT axis: AxisRef), one side / symmetric / two
// sides, any Operation. Kernel revolve_regions (API 4): the profile must not cross
// the axis and the axis must not be normal to the sketch (both refused with the
// reason); the result's `valid` flag is honoured. Face names as Extrude's.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { RevolveFeature } from '../../types/doc';
import type { ExprField, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { RevolveExtent } from '../../types/kernel-protocol';
import type { Expr, UnitsService } from '../../types/units';
import { refBodies, refParents, resolveAxis } from '../refgeom/resolve';
import { finishSwept, kernelStep, PROFILE_REPAIRED, profileKeys } from '../solids/build';
import { SOLIDS_ICONS } from '../solids/icons';

export interface RevolveValues {
  extent: RevolveExtent;
}

function angle(label: string, expr: Expr, units: UnitsService): { ok: true; value: number } | { ok: false; message: string } {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), 'angle');
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

/** The angles evaluated with their rules (the panel's fields say the same). */
export function resolveRevolveExtent(f: Pick<RevolveFeature, 'extent'>, units: UnitsService): ResolveResult<RevolveExtent> {
  const e = f.extent;
  if (!e || typeof e !== 'object') return { ok: false, message: 'Extent: pick One side, Symmetric or Two sides' };
  if (e.kind === 'one' || e.kind === 'symmetric') {
    const a = angle(e.kind === 'one' ? 'Angle' : 'Total angle', e.angle, units);
    if (!a.ok) return a;
    if (!(a.value > 0)) return { ok: false, message: 'Angle must be more than 0' };
    if (a.value > 360 + 1e-9) return { ok: false, message: 'Angle must be at most 360°' };
    return { ok: true, values: { kind: e.kind, angle: a.value } };
  }
  if (e.kind === 'two') {
    const a1 = angle('Angle 1', e.angle, units);
    if (!a1.ok) return a1;
    const a2 = angle('Angle 2', e.angle2, units);
    if (!a2.ok) return a2;
    if (a1.value < 0 || a2.value < 0) return { ok: false, message: 'The angles must not be negative' };
    if (!(a1.value + a2.value > 0)) return { ok: false, message: 'The two angles must add up to more than 0' };
    if (a1.value + a2.value > 360 + 1e-9) return { ok: false, message: 'The two angles must add up to at most 360°' };
    return { ok: true, values: { kind: 'two', angle: a1.value, angle2: a2.value } };
  }
  return { ok: false, message: 'Extent: pick One side, Symmetric or Two sides' };
}

export const revolveDef: FeatureTypeDef<RevolveFeature, RevolveValues> = {
  type: 'revolve',
  label: 'Revolve',
  icon: SOLIDS_ICONS.revolve,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'revolve',
      name: nextName('Revolve', doc.features.map((f) => f.name)),
      op: 'new',
      creates: null,
      scope: [],
      profiles: [],
      axis: null,
      extent: { kind: 'one', angle: '360 deg' },
      flip: false,
      ...init,
    };
  },
  resolve(f, units) {
    const r = resolveRevolveExtent(f, units);
    return r.ok ? { ok: true, values: { extent: r.values } } : r;
  },
  incomplete(f, units) {
    if (!f.profiles?.length) return 'Pick a profile';
    if (new Set(f.profiles.map((p) => p.sketch)).size > 1) return 'Pick profiles from one sketch';
    if (!f.axis) return 'Pick an axis: a centerline, a line or an edge, a round face, or an axis';
    const r = resolveRevolveExtent(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => [...new Set([...(f.profiles ?? []).map((p) => p.sketch), ...refParents([f.axis])])],
  uses(f) {
    const own = f.op === 'new' ? [] : f.scope.length ? f.scope : 'all';
    if (own === 'all') return 'all';
    return [...new Set([...own, ...refBodies([f.axis])])];
  },
  exprs: (f) => {
    const out: ExprField[] = [{ path: 'extent.angle', expr: f.extent.angle }];
    if (f.extent.kind === 'two') out.push({ path: 'extent.angle2', expr: f.extent.angle2 });
    return out;
  },
  mapExprs: (f, fn) => ({ ...f, extent: f.extent.kind === 'two' ? { ...f.extent, angle: fn(f.extent.angle), angle2: fn(f.extent.angle2) } : { ...f.extent, angle: fn(f.extent.angle) } }),
  async build(f, v, ctx) {
    const p = profileKeys(f.name, f.profiles, ctx);
    if (!p.ok) return p;
    if (!f.axis) return { ok: false, message: `${f.name} failed: Pick an axis` };
    const ax = await resolveAxis(f.axis, ctx);
    if (!ax.ok) return { ok: false, message: `${f.name} failed: Axis: ${ax.message}` };
    const { out, keys, repaired } = p.value;
    const res = await kernelStep(f.name, () => ctx.kernel.call('revolve_regions', { plane: out.plane, curves: out.curves, regions: keys, axis: ax.value, extent: v.extent, flip: !!f.flip }));
    if (!res.ok) return res;
    const notes = [repaired ? PROFILE_REPAIRED : null, ax.warning ? `Axis: ${ax.warning}` : null].filter((x): x is string => !!x);
    return finishSwept(f, res.value.result, keys, ctx, notes);
  },
};
