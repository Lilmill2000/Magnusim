// INSPECT > See-through's rule (Daniel 2026-10-29: a body drawn see-through is a view state, as a
// hidden one): it acts on the bodies the person's selection touches (a selected face, edge or point
// counts for its body). When every one of them is see-through it makes them opaque again; else (none
// is, or a mix) it makes them all see-through. A body its feature always draws see-through (an
// Enclosure's air) is left as it is: a selection of only such bodies has nothing to change.
// Owner: VIEWPORT (see-through bodies).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { BodyId } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { SelectionItem } from '../../types/selection';
import { seeThroughBy } from '../../viewport/bind';

export const SEE_THROUGH_COMMAND = 'inspect.see-through';

/** Why nothing is selected for it. */
export const NOTHING_SELECTED = 'Select a body first, in the view or the tree';

/** A selected body as the rule reads it: see-through by its feature (`by`: that feature's name), by the person's choice ('view'), or not. */
export interface SeeEntry {
  id: BodyId;
  name: string;
  why: 'feature' | 'view' | null;
  by: string | null;
}

/** What the command does now: these bodies, see-through (on) or opaque. */
export interface SeeTarget {
  ids: BodyId[];
  on: boolean;
}

/** The bodies built now that `items` touch, in the Part's order, with why each is see-through. */
export function selectedEntries(s: Pick<DocState, 'doc' | 'view' | 'rebuild'>, services: Pick<AppServices, 'doc'>, items: readonly SelectionItem[]): SeeEntry[] {
  const touched = new Set<BodyId>();
  for (const it of items) if (it.kind === 'body' || it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex') touched.add(it.body);
  return s.rebuild.bodies
    .filter((b) => touched.has(b.id))
    .map((b) => {
      const by = seeThroughBy(s, services, b.id);
      return { id: b.id, name: b.name, why: by ? 'feature' : s.view.seeThroughBodies?.includes(b.id) ? 'view' : null, by: by?.name ?? null };
    });
}

/** Every selected body is drawn see-through now (the command shows pressed). */
export function allSeeThrough(entries: readonly SeeEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.why !== null);
}

/** What INSPECT > See-through does to the selected bodies, or why it cannot. */
export function seeThroughTarget(entries: readonly SeeEntry[]): SeeTarget | string {
  if (!entries.length) return NOTHING_SELECTED;
  if (allSeeThrough(entries)) {
    const mine = entries.filter((e) => e.why === 'view');
    if (!mine.length) {
      const e = entries[0];
      return entries.length === 1 ? `${e.name} is always see-through: ${e.by ?? 'its feature'} draws it so` : 'These bodies are always see-through: their features draw them so';
    }
    return { ids: mine.map((e) => e.id), on: false };
  }
  return { ids: entries.filter((e) => e.why === null).map((e) => e.id), on: true };
}
