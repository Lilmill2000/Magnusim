// The right-click items of linked sketch geometry (P4b SELECT): "Break link"
// turns the selected projected or intersection curves into ordinary geometry
// where they are (their fixes go, constraints on them stay; one sketch undo
// step). Deleting one uses the menu's Delete as any curve does.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature } from '../../types/doc';
import type { MenuEntry } from '../../ui/kit';
import type { SketchHit, SketchMode } from '../mode';
import { breakLinks } from './curves';

/** The selected entities that are linked. */
export function selectedLinked(d: Pick<SketchFeature, 'entities'>, picked: readonly SketchHit[]): string[] {
  const ids = new Set(picked.filter((h) => h.what === 'entity').map((h) => h.id));
  return d.entities.filter((e) => ids.has(e.id) && !!e.link).map((e) => e.id);
}

/** Break the link of these entities (sketch mode, one undo step). */
export function breakLinkOf(mode: Pick<SketchMode, 'apply'>, ids: readonly string[]) {
  return mode.apply('Break link', (cur) => {
    const next = breakLinks(cur, ids);
    return next ? { ok: true, draft: next, optional: [], removed: [] } : { ok: false, reason: 'nothing selected follows the model' };
  });
}

export function linkMenuItems(mode: Pick<SketchMode, 'apply'>, d: Pick<SketchFeature, 'entities'>, picked: readonly SketchHit[]): MenuEntry[] {
  const ids = selectedLinked(d, picked);
  if (!ids.length) return [];
  return [{ id: 'break-link', label: 'Break link', run: () => void breakLinkOf(mode, ids) }];
}
