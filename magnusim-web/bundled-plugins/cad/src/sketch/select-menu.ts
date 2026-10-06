// Sketch mode's right-click items for a selection (P4b SELECT; Daniel's
// must-have 5): "Construction" as a state item on any selection with curves
// (checked when every selected curve is construction; a click turns them all
// the other way), and on a mixed selection two items, "Make construction" and
// "Make normal". The toolbar's Construction and X toggle as before
// (toggleConstruction). Points are never part of a profile, so a selection of
// points only offers the item disabled with that reason. Also the linked
// geometry's items (Break link), from src/sketch/project/.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature } from '../types/doc';
import type { MenuEntry } from '../ui/kit';
import type { SketchDraft } from './edit';
import type { SketchHit, SketchMode } from './mode';

/** The selected curves (lines, circles, arcs, splines; not points). */
export function selectedCurves(d: Pick<SketchFeature, 'entities'>, picked: readonly SketchHit[]): SketchEntity[] {
  const ids = new Set(picked.filter((h) => h.what === 'entity').map((h) => h.id));
  return d.entities.filter((e) => ids.has(e.id) && e.kind !== 'point');
}

/** The construction state of a selection: every selected curve construction, none, or some. */
export function constructionState(curves: readonly SketchEntity[]): 'all' | 'none' | 'mixed' | 'empty' {
  if (!curves.length) return 'empty';
  const on = curves.filter((e) => !!e.construction).length;
  return on === curves.length ? 'all' : on === 0 ? 'none' : 'mixed';
}

/** These curves made construction (on) or normal geometry (off); a centerline stays one only while construction. */
export function setConstruction(d: SketchDraft, ids: readonly string[], on: boolean): SketchDraft | null {
  const set = new Set(ids);
  let changed = false;
  const entities = d.entities.map((e) => {
    if (!set.has(e.id) || e.kind === 'point') return e;
    if (!!e.construction === on) return e;
    changed = true;
    if (on) return { ...e, construction: true } as SketchEntity;
    const { construction: _c, ...rest } = e as SketchEntity & { construction?: boolean; centerline?: boolean };
    if (rest.kind === 'line') delete (rest as { centerline?: boolean }).centerline;
    return rest as SketchEntity;
  });
  return changed ? { ...d, entities } : null;
}

/** The Construction items for the selection (empty when nothing is selected). */
export function constructionItems(mode: Pick<SketchMode, 'apply'>, d: Pick<SketchFeature, 'entities'>, picked: readonly SketchHit[]): MenuEntry[] {
  if (!picked.length) return [];
  const curves = selectedCurves(d, picked);
  const ids = curves.map((e) => e.id);
  const run = (on: boolean) => () =>
    void mode.apply(on ? 'Make construction' : 'Make normal', (cur) => {
      const next = setConstruction(cur, ids, on);
      return next ? { ok: true, draft: next, optional: [], removed: [] } : { ok: false, reason: 'nothing to change' };
    });
  switch (constructionState(curves)) {
    case 'empty':
      return picked.some((h) => h.what !== 'constraint') ? [{ id: 'construction', label: 'Construction', checked: false, disabled: 'Points are never part of a profile: select a line, a circle, an arc or a spline', run: () => {} }] : [];
    case 'all':
      return [{ id: 'construction', label: 'Construction', checked: true, run: run(false) }];
    case 'none':
      return [{ id: 'construction', label: 'Construction', checked: false, run: run(true) }];
    case 'mixed':
      return [
        { id: 'construction-on', label: 'Make construction', run: run(true) },
        { id: 'construction-off', label: 'Make normal', run: run(false) },
      ];
  }
}
