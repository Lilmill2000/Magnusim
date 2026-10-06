// Persistent names of a pattern's copies (proposal §4.5; Daniel's item 7): every face of copy
// `key` is F:<pattern>:i<key>:<the source face's name> (the mirror's F:<mirror>:m:<name>), each
// part of a merged source name prefixed on its own, so a fillet on an edge of instance 3 keeps
// its name when the count goes from 4 to 5 (instance 3 is still instance 3) and a reference to
// the source face never resolves onto a copy.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mergeNames, splitMerged } from '../../naming/names';

export { copyRoleWords, isCopyRole } from '../../naming/names';
import type { FeatureId } from '../../types/doc';
import type { FaceNames } from '../../types/naming';

/** The role of copy `key` in its faces' names: "i3", "i2.1", "i-2", "m". */
export function copyRole(key: string): string {
  return key === 'm' ? 'm' : `i${key}`;
}

/** The name of a copy's face made from source face `name`. */
export function copyFaceName(pattern: FeatureId, key: string, name: string): string {
  const role = copyRole(key);
  const parts = splitMerged(name).map((p) => `F:${pattern}:${role}:${p}`);
  return parts.length === 1 ? parts[0] : mergeNames(parts);
}

/**
 * The names of a copy's faces: `faces` faces, `map[i]` the copy's face index of source face i (null:
 * the same numbering). Null when the source has no names (the copy is then unnamed too).
 */
export function copyNames(pattern: FeatureId, key: string, source: FaceNames | null, map: readonly number[] | null, faces: number): FaceNames | null {
  if (!source) return null;
  const out: (string | null)[] = new Array(faces).fill(null);
  source.faces.forEach((n, i) => {
    const at = map ? map[i] : i;
    if (at >= 0 && at < faces) out[at] = copyFaceName(pattern, key, n);
  });
  if (out.some((n) => n == null)) return null;
  return { faces: out as string[] };
}
