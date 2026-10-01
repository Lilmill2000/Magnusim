// The feature registry: every feature type the document can build.
// Owner: DOC-CORE. P1: box, cylinder.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureType } from '../../types/doc';
import type { FeatureRegistry, FeatureTypeDef } from '../../types/doc-service';
import { boxDef, cylinderDef } from './primitives';

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

/** The registry with every built-in feature type. */
export function createBuiltinRegistry(): FeatureRegistry {
  const r = createFeatureRegistry();
  r.register(boxDef);
  r.register(cylinderDef);
  return r;
}
