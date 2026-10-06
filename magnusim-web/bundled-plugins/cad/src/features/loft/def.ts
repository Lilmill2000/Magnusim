// The loft feature type (proposal §2.5; guide rails are V1): a solid through two or
// more profiles, one region of each sketch, in the order picked (the sketches lie on
// offset planes, faces or CONSTRUCT planes). ruled: flat sides between neighbouring
// profiles. Kernel loft_regions (API 4): a profile with a hole, or of several separate
// regions, is refused with the reason; the result's `valid` flag is honoured. Side
// faces by the first profile's sub-segment tokens, caps start (first) / end (last).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { LoftFeature } from '../../types/doc';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { RegionSection } from '../../types/kernel-protocol';
import { finishSwept, kernelStep, PROFILE_REPAIRED, profileKeys } from '../solids/build';
import { SOLIDS_ICONS } from '../solids/icons';

/** Why the sections cannot be lofted, or null. */
export function sectionsProblem(f: Pick<LoftFeature, 'sections'>): string | null {
  if (!f.sections?.length) return 'Pick two or more profiles, one in each sketch';
  if (f.sections.length < 2) return 'Pick a second profile, in another sketch';
  if (new Set(f.sections.map((s) => s.sketch)).size !== f.sections.length) return 'Pick one profile per sketch';
  return null;
}

export const loftDef: FeatureTypeDef<LoftFeature, Record<string, never>> = {
  type: 'loft',
  label: 'Loft',
  icon: SOLIDS_ICONS.loft,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'loft',
      name: nextName('Loft', doc.features.map((f) => f.name)),
      op: 'new',
      creates: null,
      scope: [],
      sections: [],
      ruled: false,
      ...init,
    };
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete: (f) => sectionsProblem(f),
  parents: (f) => [...new Set((f.sections ?? []).map((s) => s.sketch))],
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx) {
    const problem = sectionsProblem(f);
    if (problem) return { ok: false, message: `${f.name} failed: ${problem}` };
    const sections: RegionSection[] = [];
    let repaired = false;
    for (const s of f.sections) {
      const p = profileKeys(f.name, [s], ctx);
      if (!p.ok) return p;
      if (p.value.repaired) repaired = true;
      sections.push({ plane: p.value.out.plane, curves: p.value.out.curves, regions: p.value.keys });
    }
    const res = await kernelStep(f.name, () => ctx.kernel.call('loft_regions', { sections, ruled: !!f.ruled }));
    if (!res.ok) return res;
    return finishSwept(f, res.value.result, [], ctx, repaired ? [PROFILE_REPAIRED] : []);
  },
};
