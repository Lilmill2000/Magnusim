// Which tool made a feature, when one tool makes features of other types (hole: a sketch and a
// cut extrude): get_model full says made_by "hole" beside their inputs (CAD tools spec §3.2.18),
// so the model edits them as a sketch and an extrude. Kept with this page's Assistant (as
// runtime.madeBy is), so a reload or a new install forgets it.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { FeatureId } from '../types/doc';
import { runtimeOf, type AssistantRuntime } from './runtime';

const made = new WeakMap<AssistantRuntime, Map<FeatureId, string>>();

/** Note that `tool` made the features `ids` (after its step was kept). */
export function setMadeWith(services: AppServices, ids: readonly FeatureId[], tool: string): void {
  const rt = runtimeOf(services);
  if (!rt) return;
  let m = made.get(rt);
  if (!m) made.set(rt, (m = new Map()));
  for (const id of ids) m.set(id, tool);
}

/** The tool that made feature `id` as part of its own work, or null. */
export function madeWith(services: AppServices, id: FeatureId): string | null {
  const rt = runtimeOf(services);
  return (rt && made.get(rt)?.get(id)) ?? null;
}
