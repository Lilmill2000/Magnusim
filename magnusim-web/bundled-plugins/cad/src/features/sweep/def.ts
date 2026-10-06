// The sweep feature type (proposal §2.5): profiles of one sketch swept along a path
// made of curves of another sketch (lines and arcs end to end, or one circle);
// orientation Follow path (the profile turns with the path) or Keep orientation.
// The profile is best drawn on a plane normal to the path's start (REFERENCE's
// "Plane normal to a curve at a point"). Kernel sweep_regions (API 4): a path with a
// gap or a branch is refused with the reason; the result's `valid` flag is honoured.
// Side faces F:<id>:side:<token>@<path curve id>, caps start / end.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { SketchFeature, SweepFeature } from '../../types/doc';
import type { FeatureTypeDef } from '../../types/doc-service';
import { finishSwept, kernelStep, PROFILE_REPAIRED, profileKeys } from '../solids/build';
import { curveWords, pathCurves } from '../solids/geom';
import { SOLIDS_ICONS } from '../solids/icons';

export const sweepDef: FeatureTypeDef<SweepFeature, Record<string, never>> = {
  type: 'sweep',
  label: 'Sweep',
  icon: SOLIDS_ICONS.sweep,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'sweep',
      name: nextName('Sweep', doc.features.map((f) => f.name)),
      op: 'new',
      creates: null,
      scope: [],
      profiles: [],
      path: null,
      orientation: 'follow',
      ...init,
    };
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete(f) {
    if (!f.profiles?.length) return 'Pick a profile';
    if (new Set(f.profiles.map((p) => p.sketch)).size > 1) return 'Pick profiles from one sketch';
    if (!f.path || !f.path.entities.length) return 'Pick a path: curves of another sketch, end to end';
    if (f.path.sketch === f.profiles[0].sketch) return 'The path must be in another sketch than the profile';
    return null;
  },
  parents: (f) => [...new Set([...(f.profiles ?? []).map((p) => p.sketch), ...(f.path ? [f.path.sketch] : [])])],
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx) {
    const p = profileKeys(f.name, f.profiles, ctx);
    if (!p.ok) return p;
    if (!f.path) return { ok: false, message: `${f.name} failed: Pick a path` };
    const pathName = ctx.featureName(f.path.sketch);
    const out2 = ctx.outputs.get(f.path.sketch);
    if (!out2 || out2.type !== 'sketch') return { ok: false, message: `${f.name} failed: Path: ${pathName} did not build` };
    const sketch = ctx.doc.features.find((g) => g.id === f.path!.sketch) as SketchFeature | undefined;
    const { curves, missing } = pathCurves(out2, f.path.entities);
    if (missing.length) return { ok: false, message: `${f.name} failed: Path: ${missing.map((id) => curveWords(sketch, id)).join(', ')} of ${pathName} ${missing.length === 1 ? 'is' : 'are'} gone (deleted, or made construction)` };
    const { out, keys, repaired } = p.value;
    const res = await kernelStep(f.name, () => ctx.kernel.call('sweep_regions', { plane: out.plane, curves: out.curves, regions: keys, path: { plane: out2.plane, curves }, orientation: f.orientation }));
    if (!res.ok) return res;
    return finishSwept(f, res.value.result, keys, ctx, repaired ? [PROFILE_REPAIRED] : []);
  },
};
