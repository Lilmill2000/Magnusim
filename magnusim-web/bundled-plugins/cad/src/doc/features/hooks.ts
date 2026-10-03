// The feature-type hooks (FeatureTypeDef.uses / ownsBody / newBodies / exprs /
// mapExprs) with their defaults, so the service and the rebuild ask one place:
// which bodies a feature reads and makes, which feature makes a body, which
// fields are expressions. Defaults are the body-making rules (extrude).
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyDef, BodyId, BodyMaking, CadDoc, Feature, FeatureId } from '../../types/doc';
import type { ExprField, FeatureRegistry } from '../../types/doc-service';
import type { Expr } from '../../types/units';
import { renameInExpr } from '../expr';

type BodyFeature = Feature & BodyMaking;
export const isBodyMaking = (f: Feature): f is BodyFeature => 'op' in f && 'scope' in f && 'creates' in f;

/** Bodies whose geometry `f` reads or changes ('all' = every body before it). */
export function featureUses(registry: FeatureRegistry, f: Feature): BodyId[] | 'all' {
  const def = registry.get(f.type);
  if (def?.uses) return def.uses(f);
  if (isBodyMaking(f)) return f.op === 'new' ? [] : f.scope.length ? f.scope : 'all';
  return [];
}

/** Whether `f` makes body `id`. */
export function ownsBody(registry: FeatureRegistry, f: Feature, id: BodyId): boolean {
  const def = registry.get(f.type);
  if (def?.ownsBody) return def.ownsBody(f, id);
  return isBodyMaking(f) && f.creates === id;
}

/** The feature that makes body `id`, or undefined. */
export function bodyMaker(registry: FeatureRegistry, doc: CadDoc, id: BodyId): Feature | undefined {
  return doc.features.find((g) => ownsBody(registry, g, id));
}

/** Feature ids `f` depends on: its declared parents and the features that make the bodies it names. */
export function dependencies(registry: FeatureRegistry, doc: CadDoc, f: Feature): FeatureId[] {
  const def = registry.get(f.type);
  const out = new Set(def ? def.parents(f) : []);
  const uses = featureUses(registry, f);
  if (uses !== 'all') {
    for (const b of uses) {
      const maker = bodyMaker(registry, doc, b);
      if (maker) out.add(maker.id);
    }
  }
  out.delete(f.id);
  return [...out];
}

/** Drop body definitions no feature makes any more. */
export function gcBodies(registry: FeatureRegistry, doc: CadDoc): CadDoc {
  const keys = Object.keys(doc.bodies);
  const kept = keys.filter((k) => doc.features.some((f) => ownsBody(registry, f, k)));
  if (kept.length === keys.length) return doc;
  const bodies: CadDoc['bodies'] = {};
  for (const k of kept) bodies[k] = doc.bodies[k];
  return { ...doc, bodies };
}

/** Add the BodyDefs a feature brings (import: the STEP's names and colours); existing ids are kept. */
export function withNewBodies(registry: FeatureRegistry, doc: CadDoc, f: Feature): CadDoc {
  const def = registry.get(f.type);
  const add: Record<BodyId, BodyDef> = def?.newBodies ? def.newBodies(f, doc) : {};
  const missing = Object.keys(add).filter((id) => !doc.bodies[id]);
  if (!missing.length) return doc;
  const bodies = { ...doc.bodies };
  for (const id of missing) bodies[id] = add[id];
  return { ...doc, bodies };
}

/** Keys that never hold expressions in the P1 features (the default walk skips them). */
const NOT_EXPRESSIONS = new Set(['id', 'type', 'name', 'op', 'creates', 'scope', 'axis', 'suppressed', 'repair']);

/** Every expression of a feature with its path: the type's own list, or the P1 walk over every other string field. */
export function featureExprFields(registry: FeatureRegistry | null, f: Feature): ExprField[] {
  const def = registry?.get(f.type);
  if (def?.exprs) return def.exprs(f);
  const out: ExprField[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') out.push({ path, expr: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  for (const [k, v] of Object.entries(f)) if (!NOT_EXPRESSIONS.has(k)) walk(v, k);
  return out;
}

/** Rewrite every expression of a feature (a parameter rename): the type's mapExprs, or the P1 walk. */
export function mapFeatureExprs(registry: FeatureRegistry | null, f: Feature, fn: (e: Expr) => Expr): Feature {
  const def = registry?.get(f.type);
  if (def?.mapExprs) return def.mapExprs(f, fn);
  if (def?.exprs) throw new Error(`feature type ${f.type} lists its expressions but cannot rewrite them (mapExprs)`);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = NOT_EXPRESSIONS.has(k) ? v : walk(v);
  return out as unknown as Feature;
}

/** Rename a parameter in every expression field of a feature. */
export function renameParamInFeature(registry: FeatureRegistry | null, f: Feature, from: string, to: string): Feature {
  return mapFeatureExprs(registry, f, (e) => renameInExpr(e, from, to));
}
