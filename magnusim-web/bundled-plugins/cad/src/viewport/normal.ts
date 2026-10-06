// What "Normal to" looks at (P4b SELECT; Daniel 2026-10-06: "ensure a 'normal to'
// option is available for a face or a sketch"): the first of the selected items
// that has a plane: a flat face, an origin plane, a CONSTRUCT plane (its row or
// its drawing), or a SKETCH (its tree row, one of its profiles or curves picked
// in model mode), whose own up direction is kept as sketch mode's Normal to keeps
// it. N, the views menu, the face / plane / sketch right-click menus and the tree
// rows all ask here, so they agree. A curved face says so.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { FeatureId, PlaneFrame, Vec3 } from '../types/doc';
import type { DocState } from '../types/doc-service';
import type { SelectionItem } from '../types/selection';
import type { ViewportHandle } from '../types/viewport';

export interface NormalTarget {
  normal: Vec3;
  up: Vec3;
  /** What it looks at, for a menu's words ("Sketch 2", "Plane 1", "face", "Top plane"). */
  what: string;
}

export const NORMAL_TO_REASON = 'Select a flat face, a plane or a sketch to look at it straight on';
export const CURVED_REASON = 'That face is curved: select a flat face, a plane or a sketch';

/** The usual up for a plane normal: +Y when looking along Z, else +Z. */
export function upFor(n: Vec3): Vec3 {
  return Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
}

/** A plane frame's own y (normal x xdir). */
export function frameUp(p: PlaneFrame): Vec3 {
  const [nx, ny, nz] = p.normal;
  const [x, y, z] = p.xdir;
  return [ny * z - nz * y, nz * x - nx * z, nx * y - ny * x];
}

/**
 * The up a sketch is looked at with: its own y, turned over when it points against the usual up of
 * its normal (P4b fix round 1, polish 8: a sketch on a bottom face showed upside down beside "Normal
 * to" of that face). Sketch entry, sketch mode's Normal to and model mode's agree, and a plane looks
 * the same whatever way it is reached.
 */
export function sketchUp(p: PlaneFrame): Vec3 {
  const y = frameUp(p);
  const u = upFor(p.normal);
  return y[0] * u[0] + y[1] * u[1] + y[2] * u[2] < 0 ? [-y[0], -y[1], -y[2]] : y;
}

/** A sketch's plane at the last rebuild (its stored plane when it was not built). */
export function sketchPlane(state: Pick<DocState, 'doc' | 'rebuild'>, id: FeatureId): PlaneFrame | null {
  const f = state.doc.features.find((x) => x.id === id);
  if (!f || f.type !== 'sketch') return null;
  const out = state.rebuild.outputs[id];
  if (out && out.type === 'sketch' && out.plane) return out.plane;
  return f.plane ?? null;
}

/** The target of one item, or null (not a planar thing), or the curved-face reason. */
export function targetOfItem(state: Pick<DocState, 'doc' | 'rebuild'>, handle: Pick<ViewportHandle, 'planeNormal'>, it: SelectionItem): NormalTarget | null | 'curved' {
  if (it.kind === 'face' || (it.kind === 'origin' && !/^origin:[xyz]$/.test(it.ref))) {
    const n = handle.planeNormal(it);
    if (!n) return it.kind === 'face' ? 'curved' : null;
    return { normal: n, up: upFor(n), what: it.kind === 'face' ? 'face' : 'plane' };
  }
  const sketchId = it.kind === 'sketch' || it.kind === 'region' ? it.feature : it.kind === 'feature' ? it.feature : null;
  if (!sketchId) return null;
  const f = state.doc.features.find((x) => x.id === sketchId);
  if (!f) return null;
  if (f.type === 'sketch') {
    const p = sketchPlane(state, sketchId);
    return p ? { normal: [...p.normal] as Vec3, up: sketchUp(p), what: f.name } : null;
  }
  if (f.type === 'ref_plane') {
    const out = state.rebuild.outputs[sketchId];
    if (out && out.type === 'plane') return { normal: [...out.frame.normal] as Vec3, up: upFor(out.frame.normal), what: f.name };
  }
  return null;
}

/** What Normal to would look at for these items, or why not. */
export function normalTarget(state: Pick<DocState, 'doc' | 'rebuild'>, handle: Pick<ViewportHandle, 'planeNormal'>, items: readonly SelectionItem[]): NormalTarget | { reason: string } {
  let curved = false;
  for (const it of items) {
    const t = targetOfItem(state, handle, it);
    if (t === 'curved') curved = true;
    else if (t) return t;
  }
  return { reason: curved ? CURVED_REASON : NORMAL_TO_REASON };
}

/** Look along a target (the viewport's Look at, framing the shown part). */
export function lookNormal(services: Pick<AppServices, 'viewport'>, t: NormalTarget): void {
  services.viewport.get().handle?.lookAt(t.normal, t.up);
}
