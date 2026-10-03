// Definition state: from the solver's answers (solve + analyze) to what the
// user sees: the status chip's words ("Under defined · 2 DOF", "Fully
// defined", "Over defined · 1 conflicting"), the tree state stored with the
// sketch, and each entity's colour class (under: the core's blue accent,
// fully: #101828, over: red; proposal §2.2, design-language §sketch colours).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchConstraintId, SketchFeature } from '../types/doc';
import type { DefinitionState, SketchModeState, SolverAnalysis, SolverSolveResult } from '../types/sketch';
import { ORIGIN, storedIds } from './model';

export type SketchStatus = NonNullable<SketchModeState['status']>;

/** The sketch's state from a solve and (when it ran) an analysis of the same geometry. */
export function statusOf(solve: Pick<SolverSolveResult, 'status' | 'solved' | 'dof' | 'conflicting' | 'redundant'> | null, analysis?: Pick<SolverAnalysis, 'dof' | 'conflicting' | 'redundant'> | null): SketchStatus {
  if (!solve && !analysis) return { state: 'unsolved', dof: 0, conflicting: [], redundant: [] };
  const conflicting = storedIds([...(analysis?.conflicting ?? []), ...(solve?.conflicting ?? [])]);
  const redundant = storedIds([...(analysis?.redundant ?? []), ...(solve?.redundant ?? [])]).filter((id) => !conflicting.includes(id));
  const dof = Math.max(0, analysis?.dof ?? solve?.dof ?? 0);
  if (conflicting.length || redundant.length) return { state: 'over', dof, conflicting, redundant };
  if (solve && !solve.solved) return { state: 'unsolved', dof, conflicting, redundant };
  return { state: dof > 0 ? 'under' : 'fully', dof, conflicting, redundant };
}

/** The status chip's words. `empty`: nothing drawn yet (review P2/P3 round 1: an empty sketch read "Fully defined"). */
export function statusText(s: SketchStatus | null, empty = false): string {
  if (!s) return '';
  switch (s.state) {
    case 'under':
      return `Under defined · ${s.dof} DOF`;
    case 'fully':
      return empty ? 'No geometry yet' : 'Fully defined';
    case 'over': {
      if (s.conflicting.length) return `Over defined · ${s.conflicting.length} conflicting`;
      return `Over defined · ${s.redundant.length} redundant`;
    }
    case 'unsolved':
      return 'Not solved: the constraints cannot all hold';
  }
}

/** What is stored with the sketch on every edit (tree prefix, the rebuild's "nothing changed" check). */
export function solvedStateOf(status: SketchStatus, values: Record<SketchConstraintId, number>): SketchFeature['solved'] {
  return { values, dof: status.dof, state: status.state };
}

export type ColourClass = 'under' | 'fully' | 'over' | 'construction';

/**
 * The colour of an entity or a point: over-defined wins (it is in a conflicting
 * or redundant constraint), then the analysis' per-entity state; with no
 * analysis yet, everything is under-defined (blue) except the origin.
 */
export function colourOf(id: string, kind: 'entity' | 'point', analysis: Pick<SolverAnalysis, 'perEntity' | 'perPoint'> | null, over: ReadonlySet<string>): DefinitionState {
  if (over.has(id)) return 'over';
  if (id === ORIGIN) return 'fully';
  const s = kind === 'entity' ? analysis?.perEntity[id] : analysis?.perPoint[id];
  return s ?? 'under';
}

/** The ids (entities and points) a list of over-defining constraints touches, through the sketch's references. */
export function overIds(f: Pick<SketchFeature, 'constraints' | 'entities'>, constraintIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  const ids = new Set(constraintIds);
  for (const c of f.constraints) {
    if (!ids.has(c.id)) continue;
    for (const r of c.refs) {
      out.add(r);
      const e = f.entities.find((x) => x.id === r);
      if (e?.kind === 'line') e.p.forEach((p) => out.add(p));
    }
  }
  return out;
}
