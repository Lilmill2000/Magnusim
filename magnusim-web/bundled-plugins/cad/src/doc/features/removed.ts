// Feature types this version no longer builds (decision 2026-10-01, "fully
// sketch-driven": no one-click solids; Box and Cylinder came off). A Part that
// still has one opens normally: the row stays in the history in red with
// "This part uses a removed feature (Box 1)", its Edit says
// the same, and Delete removes it. Nothing is dropped and nothing crashes.
// Owner: SD pass (DOC-CORE file).
// SPDX-License-Identifier: GPL-3.0-or-later
import { REMOVED_FEATURE_TYPES } from '../../types/doc';

/** Whether a stored feature is of a removed type (box, cylinder). */
export function isRemovedFeature(f: { type: string }): boolean {
  return Object.prototype.hasOwnProperty.call(REMOVED_FEATURE_TYPES, f.type);
}

/** "This part uses a removed feature (Box 1)", or null for a type that is still built. */
export function removedFeatureMessage(f: { type: string; name: string }): string | null {
  return isRemovedFeature(f) ? `This part uses a removed feature (${f.name})` : null;
}
