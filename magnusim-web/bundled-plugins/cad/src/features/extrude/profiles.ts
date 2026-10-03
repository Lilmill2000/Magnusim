// Profiles an extrude keeps (RegionRef, proposal §4.5 point 2) and how they are
// found again after the sketch changed:
//   - the same region key: found (a dimension change keeps keys: the kernel's
//     keys hold no numbers);
//   - else a region with the same boundary entities (through trim lineage:
//     e_1.b counts as e_1) that contains the point stored inside the region
//     when it was picked: found, with "Profile repaired · check";
//   - else "Profile lost".
// The stored point is required even when only one region has the same
// entities: two overlapping circles make three regions bounded by the same two
// circles, and after a trim removes the lens the one left with those entities
// is a crescent, not the lens (docs/p2p3-plan.md §5.2 item 8 wants "Profile
// lost" there, not a quiet switch to another region).
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId, RegionRef, SketchEntityId } from '../../types/doc';
import type { KernelRegion } from '../../types/kernel-protocol';
import type { SketchRegion } from '../../types/sketch';
import { lineageRoot } from '../sketch/geometry';
import { regionContains } from '../sketch/regions';

export const PROFILE_REPAIRED = 'Profile repaired · check';

export type ProfileResolution = { ok: true; key: string; how: 'exact' | 'repaired'; region: SketchRegion } | { ok: false };

function rootSet(ids: readonly SketchEntityId[], parents: ReadonlyMap<SketchEntityId, SketchEntityId | null | undefined>): string {
  return [...new Set(ids.map((id) => lineageRoot(id, parents)))].sort().join('\n');
}

/** Find a kept profile in the sketch's regions now (see the file header). */
export function resolveRegionRef(ref: RegionRef, regions: readonly SketchRegion[], parents: ReadonlyMap<SketchEntityId, SketchEntityId | null | undefined> = new Map()): ProfileResolution {
  const exact = regions.find((r) => r.key === ref.region);
  if (exact) return { ok: true, key: exact.key, how: 'exact', region: exact };
  const want = rootSet(ref.entities ?? [], parents);
  const inside = regions.filter((r) => rootSet(r.entities, parents) === want && regionContains(r, ref.sample));
  if (inside.length === 1) return { ok: true, key: inside[0].key, how: 'repaired', region: inside[0] };
  return { ok: false };
}

/** The reference an extrude keeps for a region the user picked (the re-anchoring point). */
export function refOfRegion(sketch: FeatureId, region: Pick<KernelRegion, 'key' | 'entities' | 'sample'>): RegionRef {
  return { sketch, region: region.key, entities: [...region.entities].sort(), sample: [region.sample[0], region.sample[1]] };
}

/** Lineage parents of a sketch's entities (for resolveRegionRef). */
export function entityParents(entities: readonly { id: SketchEntityId; parent?: SketchEntityId | null }[] | undefined): Map<SketchEntityId, SketchEntityId | null | undefined> {
  return new Map((entities ?? []).map((e) => [e.id, e.parent]));
}
