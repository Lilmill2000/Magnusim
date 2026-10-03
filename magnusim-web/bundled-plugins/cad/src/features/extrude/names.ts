// Face names of an extruded shape (docs/p2p3-plan.md §1.8, proposal §4.5 point 3):
//   sides  F:<extrude>:side:<sub-segment token>   from the history's `seg`
//   caps   F:<extrude>:start / F:<extrude>:end     with one profile
//          F:<extrude>:start:<n> / :end:<n>        with several: n = the profile's
//                                                  index in `profiles` (regions
//                                                  that merged take the lowest n)
// Several caps are never told apart by position: two caps are planes with the
// same normal, and a '#k' that swapped would resolve cleanly to the wrong one.
// Null (unnamed) when the kernel gave no face count or history, or several
// profiles without their caps per region.
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from '../../types/doc';
import type { OpHistory } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { faceName, namesAfter } from '../../naming/names';

export function extrudeNames(feature: FeatureId, result: { faces?: number; history?: OpHistory | null }, keys: readonly string[]): FaceNames | null {
  if (typeof result.faces !== 'number' || !result.history) return null;
  const { names } = namesAfter({ feature, faces: result.faces, history: result.history, inputs: new Map() });
  const faces = [...names.faces];
  if (keys.length <= 1) {
    // The caps the history names by index (as well as by `cap` sources).
    const h = result.history;
    if (h.start != null && h.start >= 0 && h.start < faces.length) faces[h.start] = faceName(feature, 'start');
    if (h.end != null && h.end >= 0 && h.end < faces.length) faces[h.end] = faceName(feature, 'end');
  } else {
    const caps = result.history.caps;
    if (!caps) return null;
    const named = new Set<number>();
    keys.forEach((key, n) => {
      const c = caps[key];
      if (!c) return;
      for (const [role, i] of [
        ['start', c.start],
        ['end', c.end],
      ] as const) {
        if (i == null || i < 0 || i >= faces.length || named.has(i)) continue;
        faces[i] = faceName(feature, role, n);
        named.add(i);
      }
    });
    // A cap the history did not attribute to a region would keep a positional name: refuse to name.
    if (faces.some((n, i) => /^F:[^:]+:(start|end)(#\d+)?$/.test(n) && !named.has(i))) return null;
  }
  return { faces };
}
