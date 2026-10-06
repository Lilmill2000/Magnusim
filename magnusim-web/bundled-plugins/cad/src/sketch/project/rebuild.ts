// Linked geometry at every rebuild (P4b SELECT): the sketch feature's build
// (src/features/sketch/def.ts) calls reprojectLinks before it solves. Each
// link is read again from the bodies before the sketch; the linked points that
// moved are put where their source is now (the build then re-solves, so what
// is constrained to them follows). A lost source keeps its entities where they
// were and the sketch still builds, with the words as a warning (amber: "Don't
// block, just report"). A face, silhouette or section that now gives another
// set of curves keeps the old ones until the sketch is opened (sketch mode
// re-reads every link on entry and applies it).
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, PlaneFrame, SketchFeature } from '../../types/doc';
import type { BuildContext } from '../../types/doc-service';
import type { SketchOutput } from '../../types/sketch';
import { entityLabel } from '../model';
import { applyLinkCurves, type LinkDraft } from './curves';
import { readLink, type LinkEnv } from './source';

/** The bodies a sketch's links read (the sketch feature's `uses`). */
export function linkBodies(f: Pick<SketchFeature, 'links'>): BodyId[] {
  return [...new Set((f.links ?? []).map((l) => l.source.body))];
}

export function envOf(ctx: Pick<BuildContext, 'kernel' | 'bodies' | 'bodyName' | 'featureName'>): LinkEnv {
  return {
    kernel: ctx.kernel,
    bodies: ctx.bodies,
    bodyName: (id) => ctx.bodyName(id),
    featureName: (id) => {
      const n = ctx.featureName(id);
      return n === 'a deleted feature' ? null : n;
    },
  };
}

export interface Reprojected {
  /** The feature with its linked points (and circle radii, spline knots) where the sources are now. */
  feature: SketchFeature;
  /** Whether any linked point or radius moved (the build must solve again). */
  moved: boolean;
  status: NonNullable<SketchOutput['links']>;
  warnings: string[];
}


/**
 * Read every link of a sketch at this rebuild (see the file comment). The links' curves are put into an
 * in-memory copy of the sketch exactly as the opened sketch will store them (applyLinkCurves: places
 * clustered, new curves with deterministic ids, lost ones left where they were), so what the rebuild
 * draws and extrudes is the source as it is now (P4b fix round 1, B-1).
 */
export async function reprojectLinks(f: SketchFeature, plane: PlaneFrame, env: LinkEnv): Promise<Reprojected> {
  const status: NonNullable<SketchOutput['links']> = {};
  const warnings: string[] = [];
  let draft: LinkDraft = { points: f.points, entities: f.entities, constraints: f.constraints, links: f.links };
  let moved = false;
  for (const link of f.links ?? []) {
    const r = await readLink(link, plane, env);
    const dropped = new Set(link.dropped ?? []);
    if (r.state === 'lost') {
      const lostIds = link.entities.filter((x) => !dropped.has(x.key)).map((x) => x.entity).filter((id) => f.entities.some((e) => e.id === id));
      status[link.id] = { state: 'lost', message: r.message, lost: lostIds };
      const what = lostIds.length === 1 ? entityLabel(f, lostIds[0]) : `${lostIds.length} curves`;
      warnings.push(`Lost reference: ${what} of ${f.name} (${r.message})`);
      continue;
    }
    if (r.warning) warnings.push(r.warning);
    const live = (draft.links ?? []).find((l) => l.id === link.id) ?? link;
    const a = applyLinkCurves(draft, live, r.curves, { construction: !!link.auto });
    if (a.changed) {
      draft = a.draft;
      moved = true;
    }
    const lostIds = a.link.entities.filter((x) => a.lostKeys.includes(x.key)).map((x) => x.entity);
    if (lostIds.length) {
      const msg = `${lostIds.length === 1 ? entityLabel({ entities: draft.entities }, lostIds[0]) : `${lostIds.length} curves`} no longer on the model`;
      status[link.id] = { state: 'lost', message: msg, lost: lostIds };
      warnings.push(`Lost reference: ${msg}`);
    } else status[link.id] = { state: 'ok' };
  }
  return { feature: moved ? { ...f, points: draft.points, entities: draft.entities, links: draft.links } : f, moved, status, warnings };
}
