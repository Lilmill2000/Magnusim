// The feature registry: every feature type the document can build.
// Owner: DOC-CORE. Every type comes from a module (src/features/*: sketch,
// extrude, import, ..., enclosure); P1's box and cylinder are removed
// (REMOVED_FEATURE_TYPES, decision 2026-10-01: no one-click solids).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureType } from '../../types/doc';
import type { FeatureRegistry, FeatureTypeDef } from '../../types/doc-service';

export function createFeatureRegistry(): FeatureRegistry {
  const defs = new Map<FeatureType, FeatureTypeDef>();
  return {
    register(def) {
      defs.set(def.type, def as unknown as FeatureTypeDef);
    },
    get: (type) => defs.get(type),
    all: () => [...defs.values()],
  };
}

/** The registry the document starts with: empty (modules register every type before the Part loads). */
export function createBuiltinRegistry(): FeatureRegistry {
  return createFeatureRegistry();
}
