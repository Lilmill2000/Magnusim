/**
 * The registered analyses as the page reads them (registry.describe): which
 * analysis a study or run solves with, its sibling of the other time
 * dependency, and the settings a new run starts with. Nothing here knows a
 * particular physics; it reads what each analysis's contract publishes.
 */
import type { RegistryRow } from './api/registry.gen';
import { useProjectStore } from './store/project';

/** The analysis a new study gets when none is picked (the required bundled plugin's steady one). */
export const DEFAULT_ANALYSIS_KEY = 'incompressible_steady';

export function analysisRows(): RegistryRow[] {
  return ((useProjectStore.getState().registry?.analysis || []) as RegistryRow[]).filter((row) =>
    String(row.key || '').trim(),
  );
}

export function analysisRow(key: string | undefined | null): RegistryRow | undefined {
  if (!key) return undefined;
  return analysisRows().find((row) => row.key === key);
}

function td(value: unknown): 'steady' | 'transient' {
  return /transient/i.test(String(value || '')) ? 'transient' : 'steady';
}

/**
 * The analysis of `key`'s family at a time dependency: itself when it already
 * has it, its sibling when the family has one, else `key` unchanged.
 */
export function siblingKey(key: string | undefined | null, timeDependency: unknown): string {
  const want = td(timeDependency);
  const row = analysisRow(key) || analysisRow(DEFAULT_ANALYSIS_KEY);
  if (!row) return String(key || '');
  if (td(row.time_dependency) === want) return row.key;
  const family = row.family && row.family.key;
  const hit = family
    ? analysisRows().find((r) => r.family && r.family.key === family && td(r.time_dependency) === want)
    : undefined;
  return hit ? hit.key : row.key;
}

/** The analysis a run solves with: its stamp, else its study's family at the run's time dependency. */
/**
 * Whether a run's progress axis is simulated seconds: its analysis's x_axis
 * (contract), else its time dependency (an analysis that is not installed).
 */
export function xAxisIsSeconds(key: string | undefined | null, transient: boolean): boolean {
  const axis = analysisRow(key)?.x_axis;
  if (axis === 'seconds' || axis === 'iterations') return axis === 'seconds';
  return transient;
}

export function runAnalysisKey(
  rec: { analysis_key?: unknown } | null | undefined,
  studyAnalysisType: string | undefined,
  transient: boolean,
): string {
  const stamped = rec && typeof rec.analysis_key === 'string' ? rec.analysis_key : '';
  if (stamped && analysisRow(stamped)) return stamped;
  return siblingKey(studyAnalysisType || DEFAULT_ANALYSIS_KEY, transient ? 'transient' : 'steady');
}

/** A new run's settings for this analysis (its run model's defaults; null = calculated). */
export function runDefaults(key: string | undefined | null): Record<string, unknown> {
  const row = analysisRow(key) as (RegistryRow & { run_defaults?: Record<string, unknown> }) | undefined;
  return row && row.run_defaults && typeof row.run_defaults === 'object' ? { ...row.run_defaults } : {};
}

/** Program names of registered transient solvers (runs from before stamps are told apart by these). */
export function transientSolverApps(): string[] {
  const solvers = (useProjectStore.getState().registry?.solver || []) as Array<{
    application?: string;
    key?: string;
    time_dependency?: string;
  }>;
  return solvers.filter((s) => td(s.time_dependency) === 'transient').map((s) => String(s.application || s.key || ''));
}
