// Sketch mode's status chip (bottom-left dock): the definition state
// ("Under defined · 2 DOF" / "Fully defined" / "Over defined · 1 conflicting"),
// busy while the solver analyses; nothing outside sketch mode. ("Open profile:
// 2 open ends" is the sketch feature module's chip, src/features/sketch/.)
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { createStateStore, useStateStore } from '../lib/store';
import type { SketchModeState } from '../types/sketch';
import { Chip } from '../ui/kit';
import { statusText } from './dof';
import { modeFor } from './mode';

/** Read when sketch mode is not installed (no sketch feature type in this build): the chips say nothing. */
const OFF = createStateStore<SketchModeState>({ feature: null, tool: 'select', status: null, analyzing: false, typing: false });
const OFF_VIEW = createStateStore<{ draft: { entities: unknown[] } | null }>({ draft: null });

export function SketchStatusChip() {
  const services = useServices();
  const mode = modeFor(services);
  const s = useStateStore(mode?.state ?? OFF, (x) => ({ feature: x.feature, status: x.status, analyzing: x.analyzing }));
  const empty = useStateStore(mode?.view ?? OFF_VIEW, (v) => !!v.draft && v.draft.entities.length === 0);
  if (!mode || !s.feature) return null;
  if (!s.status) {
    return (
      <Chip chip="sketch" state="solving" busy>
        Solving…
      </Chip>
    );
  }
  const kind = s.status.state === 'over' || s.status.state === 'unsolved' ? 'error' : 'info';
  return (
    <Chip chip="sketch" state={s.status.state} kind={kind} busy={s.analyzing}>
      <span data-sketch-dof={s.status.dof}>{statusText(s.status, empty)}</span>
    </Chip>
  );
}
