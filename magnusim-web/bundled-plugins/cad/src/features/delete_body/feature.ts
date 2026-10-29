// Delete body (SOLIDWORKS' Delete/Keep Body; Daniel 2026-10-28: a body in the tree could be hidden,
// renamed and coloured, but not removed). The bodies leave the model from this point in the
// history: no kernel call, the rebuild drops them (FeatureBuildResult.removed). They are named by
// id, as Combine's and Split's are (a split piece by its derived id); one that is not there at this
// point (consumed by a Combine before it, its feature deleted or moved below) fails the feature, red,
// with the model as before it, until the feature is edited or deleted.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { DeleteBodyFeature } from '../../types/doc';
import type { FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';

/** A body with a line through it (24 viewBox outline, as P2_ICONS). */
export const DELETE_BODY_ICON = 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8 M3 3l18 18';

export const deleteBodyDef: FeatureTypeDef<DeleteBodyFeature, Record<string, never>> = {
  type: 'delete_body',
  label: 'Delete body',
  icon: DELETE_BODY_ICON,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'delete_body',
      // "Body-Delete 1" (SOLIDWORKS' Body-Delete/Keep1), never "Delete body 1": that read as Body 1
      // deleted when Body 3 was.
      name: nextName('Body-Delete', doc.features.map((f) => f.name)),
      bodies: [],
      ...init,
    } as DeleteBodyFeature;
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete(f) {
    if (!f.bodies?.length) return 'Pick the bodies to delete';
    return null;
  },
  parents: () => [],
  uses: (f) => [...new Set(f.bodies ?? [])],
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx): Promise<FeatureBuildResult> {
    const ids = [...new Set(f.bodies)];
    const missing = ids.filter((id) => !ctx.bodies.has(id));
    if (missing.length) return { ok: false, message: `${f.name} failed: ${missing.map((id) => ctx.bodyName(id)).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not there at this point` };
    return { ok: true, bodies: [], removed: ids };
  },
};
