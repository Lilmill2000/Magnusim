// Why a stored face or edge of a pattern's copy is not on the body any more, in words, for the
// "not found after rebuild" messages of the features that keep it (a fillet on instance 3): the
// copy is skipped, the pattern makes fewer instances now, or the pattern did not build (fix round 1,
// P4). Pure: reads the copy roles in the name and the patterns' build outputs.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { copyRoleWords, isCopyRole } from '../../naming/names';
import type { FeatureId } from '../../types/doc';
import type { FeatureOutput } from '../../types/doc-service';

/** Every (pattern, copy role) a stored name holds ("F:<pattern>:i3:..." anywhere in it, edges included). */
export function copiesIn(name: string): { pattern: FeatureId; role: string }[] {
  const out: { pattern: FeatureId; role: string }[] = [];
  const re = /F:([^:|&#]+):([^:|&#]+):/g;
  for (let m = re.exec(name); m; m = re.exec(name)) {
    if (isCopyRole(m[2]) && !out.some((x) => x.pattern === m![1] && x.role === m![2])) out.push({ pattern: m[1], role: m[2] });
  }
  return out;
}

/**
 * The reason a copy the name refers to is gone ("instance 3 of Linear pattern 1 is skipped",
 * "Linear pattern 1 now makes 2 instances", "Linear pattern 1 did not build"), or null.
 */
export function copyGoneWhy(name: string, outputs: ReadonlyMap<FeatureId, FeatureOutput> | undefined, featureName: (id: FeatureId) => string | null): string | null {
  if (!outputs) return null;
  for (const { pattern, role } of copiesIn(name)) {
    const pname = featureName(pattern) ?? 'the pattern';
    const out = outputs.get(pattern);
    if (!out || out.type !== 'pattern') return `${pname} did not build`;
    const key = role === 'm' ? 'm' : role.slice(1);
    const copy = out.copies.find((c) => c.key === key);
    if (!copy) return out.copies.some((c) => c.key === 'm') ? `${pname} makes no such copy now` : `${pname} now makes ${out.copies.length + 1} instance${out.copies.length ? 's' : ''}, so there is no ${copyRoleWords(role)}`;
    if (copy.skipped) return `${copyRoleWords(role)} of ${pname} is skipped`;
  }
  return null;
}
