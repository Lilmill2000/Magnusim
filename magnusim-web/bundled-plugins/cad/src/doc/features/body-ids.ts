// Derived body ids: bodies a feature makes whose number is known only at rebuild
// (the pieces of a split). Piece 0 keeps the target's id; piece k >= 1 is
// `<target>.<feature id without "f_">.<k>`, the same on every rebuild, so later
// features, names and colours can keep them without storing them.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, CadDoc, FeatureId } from '../../types/doc';

export function deriveBodyId(feature: FeatureId, target: BodyId, k: number): BodyId {
  if (k === 0) return target;
  return `${target}.${feature.replace(/^f_/, '')}.${k}`;
}

/** The (target, k) of a body id derived by `feature`, or null when it is not one. */
export function parseDerivedBodyId(feature: FeatureId, id: BodyId): { target: BodyId; k: number } | null {
  const tag = `.${feature.replace(/^f_/, '')}.`;
  const at = id.lastIndexOf(tag);
  if (at <= 0) return null;
  const k = Number(id.slice(at + tag.length));
  if (!Number.isInteger(k) || k < 1) return null;
  return { target: id.slice(0, at), k };
}

/**
 * A body's name from the Part alone, also where no rebuild builds it now (a
 * Combine's tool that the Combine consumed): the stored name, or for a derived
 * body without one (a split piece never renamed) the derived-name rule
 * "<target> (k+1)", the name the split gives it. Null when the Part has no such body.
 * (Review P2/P3 round 1: a consumed split piece read "A deleted body".)
 * A Move/copy body's copy is "<target> (Copy)" (copyBodyName), the name its build gives it.
 */
export function storedBodyName(doc: Pick<CadDoc, 'bodies' | 'features'>, id: BodyId, depth = 0): string | null {
  const own = doc.bodies[id];
  if (own) return own.name;
  if (depth > 16) return null;
  for (const f of doc.features) {
    const d = parseDerivedBodyId(f.id, id);
    if (!d) continue;
    const target = storedBodyName(doc, d.target, depth + 1);
    if (f.type === 'move_body') return target ? copyBodyName(doc, f.id, d.target, target) : null;
    return target ? `${target} (${d.k + 1})` : null;
  }
  return null;
}

/**
 * The name a Move/copy body gives its copy of `target` (named `targetName`): "Body 1 (Copy)", and
 * "Body 1 (Copy 2)" for the second Move/copy body in the history that copies Body 1 (suppressed
 * ones counted, so a suppress never renames a later copy). From the Part alone, so a copy that is
 * not built now reads the same.
 */
export function copyBodyName(doc: Pick<CadDoc, 'features'>, feature: FeatureId, target: BodyId, targetName: string): string {
  let n = 0;
  for (const f of doc.features) {
    if (f.type === 'move_body' && f.copy && f.bodies.includes(target)) n += 1;
    if (f.id === feature) break;
  }
  return n > 1 ? `${targetName} (Copy ${n})` : `${targetName} (Copy)`;
}
