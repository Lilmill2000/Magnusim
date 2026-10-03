// The foot Delete of a feature panel (Daniel's chrome rule: Delete only when
// something can be removed). A new feature can always be discarded; an existing
// one only while no later feature uses it (DocService.removeBlock). Otherwise
// the panel shows no Delete: a refused click once threw away the panel's work,
// and the foot says why (usePanelDeleteBlock; SD review round 1: a reopened
// Enclosure that a Combine uses had no Delete and no reason).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { FeatureId } from '../types/doc';
import { uiFor } from './controller';

/** The panel's onDelete, or null while a later feature uses `feature`. */
export function usePanelDelete(services: AppServices, feature: FeatureId, isNew: boolean): (() => void) | null {
  const block = usePanelDeleteBlock(services, feature, isNew);
  if (block) return null;
  return () => uiFor(services).deletePanelFeature();
}

/** Why the panel has no Delete ("Combine 1 uses Enclosure 1 of Enclosure 1: delete Combine 1 or ..."), or null. */
export function usePanelDeleteBlock(services: AppServices, feature: FeatureId, isNew: boolean): string | null {
  return useStateStore(services.doc.state, () => (isNew ? null : services.doc.removeBlock(feature)));
}
