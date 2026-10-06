// How linked geometry looks in sketch mode (P4b SELECT): every linked entity
// and its points purple (--cad-sketch-projected), those whose source the last
// rebuild could not find amber (--cad-sketch-lost), and an auto-made reference
// (a snap on the model while drawing) light: drawn dashed, as guides are.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature } from '../../types/doc';
import type { FeatureOutput } from '../../types/doc-service';
import { entityPoints } from '../model';

export interface LinkLook {
  entities: Map<string, { lost: boolean; light: boolean }>;
  points: Map<string, { lost: boolean }>;
}

/** The look of each linked entity and point of a sketch, from its last build's link states. */
export function linkLook(d: Pick<SketchFeature, 'entities' | 'links'>, out: FeatureOutput | undefined): LinkLook {
  const entities = new Map<string, { lost: boolean; light: boolean }>();
  const points = new Map<string, { lost: boolean }>();
  if (!d.links?.length) return { entities, points };
  const lost = new Set<string>();
  if (out?.type === 'sketch') for (const s of Object.values(out.links ?? {})) for (const id of s.lost ?? []) lost.add(id);
  const auto = new Set(d.links.filter((l) => l.auto).map((l) => l.id));
  for (const e of d.entities) {
    if (!e.link) continue;
    const isLost = lost.has(e.id);
    entities.set(e.id, { lost: isLost, light: auto.has(e.link) });
    for (const p of entityPoints(e)) if (!points.get(p)?.lost) points.set(p, { lost: isLost });
  }
  return { entities, points };
}

/**
 * The inner control poles of linked B-splines (P4b fix round 1, polish 1): the curve is what the
 * source gives, so its poles are neither drawn, picked, boxed nor snapped to (Fusion and SolidWorks
 * show the projected curve only). Its two ends stay points.
 */
export function hiddenPoles(f: Pick<SketchFeature, 'entities'>): Set<string> {
  const out = new Set<string>();
  for (const e of f.entities) if (e.kind === 'spline' && e.link) e.pts.slice(1, -1).forEach((p) => out.add(p));
  if (!out.size) return out;
  // A pole another (unlinked) entity uses stays visible.
  for (const e of f.entities) if (!(e.kind === 'spline' && e.link)) for (const p of entityPoints(e)) out.delete(p);
  return out;
}
