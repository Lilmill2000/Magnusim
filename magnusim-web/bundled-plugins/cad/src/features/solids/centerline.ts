// A sketch's one centerline, taken as the axis when a Revolve's profiles come from
// that sketch and no axis is picked yet (SOLIDWORKS takes a sketch's single
// centerline the same way). With none or several, the user picks.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc, FeatureId } from '../../types/doc';
import type { AxisRef } from '../../types/references';

export function soleCenterline(doc: Pick<CadDoc, 'features'>, sketch: FeatureId): AxisRef | null {
  const f = doc.features.find((g) => g.id === sketch);
  if (!f || f.type !== 'sketch') return null;
  const lines = f.entities.filter((e) => e.kind === 'line' && e.centerline);
  return lines.length === 1 ? { kind: 'sketch-line', sketch, entity: lines[0].id } : null;
}
