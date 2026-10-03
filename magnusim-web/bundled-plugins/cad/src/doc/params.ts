// User parameters: names, evaluation with cycle detection, who uses what.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc, Feature, Param } from '../types/doc';
import type { FeatureRegistry } from '../types/doc-service';
import type { DocUnits, EvalResult, Quantity } from '../types/units';
import { dimsOf, evaluateExpr, isReservedName, namesIn, type EvalScope, type Qty } from './expr';
import { featureExprFields } from './features/hooks';

export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_PARAM_NAME = 64;

/** Why `name` cannot be a parameter name in `doc` (ignoring the parameter `selfId`), or null. */
export function paramNameProblem(name: string, params: readonly Param[], selfId?: string): string | null {
  if (!name) return 'Enter a name';
  if (name.length > MAX_PARAM_NAME) return `A name can have at most ${MAX_PARAM_NAME} characters`;
  if (!PARAM_NAME_RE.test(name)) return 'A name starts with a letter or _ and has only letters, digits and _';
  if (isReservedName(name)) return `"${name}" is a unit or function name`;
  const clash = params.find((p) => p.id !== selfId && p.name === name);
  if (clash) return `There is already a parameter called ${name}`;
  return null;
}

type ParamValue = { ok: true; q: Qty; value: number } | { ok: false; error: string };

/**
 * Evaluates a document's parameters on demand, each once, with cycle detection
 * ("Circular reference: a → b → a"). Immutable input: build a new scope when
 * the parameters or the units change.
 */
export interface ParamScope extends EvalScope {
  /** A parameter's evaluation as its own quantity (internal units). */
  valueOf(name: string): EvalResult | undefined;
}

export function createParamScope(params: readonly Param[], units: DocUnits): ParamScope {
  const byName = new Map(params.map((p) => [p.name, p] as const));
  const memo = new Map<string, ParamValue>();
  const results = new Map<string, EvalResult>();
  const stack: string[] = [];

  function evalParam(name: string): ParamValue | undefined {
    const p = byName.get(name);
    if (!p) return undefined;
    const hit = memo.get(name);
    if (hit) return hit;
    const cyc = stack.indexOf(name);
    if (cyc >= 0) return { ok: false, error: `Circular reference: ${[...stack.slice(cyc), name].join(' → ')}` };
    stack.push(name);
    let r: EvalResult;
    try {
      r = evaluateExpr(p.expr, p.quantity, scope);
    } finally {
      stack.pop();
    }
    const out: ParamValue = r.ok ? { ok: true, value: r.value, q: { v: r.value, ...dimsOf(p.quantity) } } : { ok: false, error: r.error };
    memo.set(name, out);
    results.set(name, r);
    return out;
  }

  const scope: ParamScope = {
    units,
    param(name) {
      const r = evalParam(name);
      if (!r) return undefined;
      return r.ok ? { ok: true, q: r.q } : { ok: false, error: r.error };
    },
    valueOf(name) {
      if (!byName.has(name)) return undefined;
      evalParam(name);
      return results.get(name) ?? { ok: false, error: memo.get(name)?.ok === false ? (memo.get(name) as { error: string }).error : 'Not evaluated' };
    },
  };
  return scope;
}

const scopes = new WeakMap<readonly Param[], { key: string; scope: ParamScope }>();

/** The (cached) scope of a parameter list under some units. */
export function scopeFor(params: readonly Param[], units: DocUnits): ParamScope {
  const key = `${units.length}|${units.angle}`;
  const hit = scopes.get(params);
  if (hit && hit.key === key) return hit.scope;
  const scope = createParamScope(params, units);
  scopes.set(params, { key, scope });
  return scope;
}

/** Evaluate an expression against a document's parameters and units. */
export function evaluateIn(doc: Pick<CadDoc, 'params' | 'units'>, text: string, quantity: Quantity): EvalResult {
  return evaluateExpr(text, quantity, scopeFor(doc.params, doc.units));
}

/**
 * Every expression inside a feature, with its JSON path: the type's own list
 * (FeatureTypeDef.exprs) when the registry has one, else every string field
 * except identity, naming and references (the P1 walk).
 */
export function featureExprs(f: Feature, registry: FeatureRegistry | null = null): { path: string; expr: string }[] {
  return featureExprFields(registry, f);
}

/** Who reads parameter `name`: other parameters and features (by name, for messages). */
export function usersOfParam(doc: CadDoc, name: string, registry: FeatureRegistry | null = null): { params: Param[]; features: Feature[] } {
  return {
    params: doc.params.filter((p) => p.name !== name && namesIn(p.expr).includes(name)),
    features: doc.features.filter((f) => featureExprs(f, registry).some((e) => namesIn(e.expr).includes(name))),
  };
}
