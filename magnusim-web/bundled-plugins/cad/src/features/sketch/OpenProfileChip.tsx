// "Open profile: 2 open ends" in the status dock, for the sketch in focus: the
// one being edited, else the one selected (its tree row or its profiles) or
// the one the open Extrude panel picks from. Nothing when every chain closes.
// The viewport marks each open end with a small white ring (overlay.ts).
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { FeatureId } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { Selection } from '../../types/selection';
import { Chip } from '../../ui/kit';
import { editedSketch, profilesView, sketchOutput, type ProfilesViewState } from './view';

/** The sketch the open-profile chip talks about, or null. */
export function focusSketch(s: Pick<DocState, 'session' | 'doc'>, sel: Selection, view: Pick<ProfilesViewState, 'forced'>): FeatureId | null {
  const edited = editedSketch(s);
  if (edited) return edited.id;
  const isSketch = (id: FeatureId) => s.doc.features.some((f) => f.id === id && f.type === 'sketch');
  for (const it of sel.items) {
    if (it.kind === 'region') return it.feature;
    if (it.kind === 'feature' && isSketch(it.feature)) return it.feature;
  }
  return view.forced[0] ?? null;
}

export function openEndsText(n: number): string {
  return `Open profile: ${n} open end${n === 1 ? '' : 's'}`;
}

export function OpenProfileChip() {
  const services = useServices();
  const sel = useStateStore(services.selection);
  const view = useStateStore(profilesView(services));
  const open = useStateStore(services.doc.state, (s) => {
    const id = focusSketch(s, sel, view);
    const out = id ? sketchOutput(s, id) : null;
    return out ? out.open.length : 0;
  });
  if (!open) return null;
  return (
    <Chip chip="open-profile" kind="warning" state="open">
      {openEndsText(open)}
    </Chip>
  );
}
