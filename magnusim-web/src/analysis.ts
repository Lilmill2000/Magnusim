/**
 * The registered analyses as the page reads them (registry.describe): which
 * analysis a study or run solves with, its sibling of the other time
 * dependency, and the settings a new run starts with. Nothing here knows a
 * particular physics; it reads what each analysis's contract publishes.
 */
import type { RegistryRow } from './api/registry.gen';
import { useProjectStore } from './store/project';

export function analysisRows(): RegistryRow[] {
  return ((useProjectStore.getState().registry?.analysis || []) as RegistryRow[]).filter((row) =>
    String(row.key || '').trim(),
  );
}

export function analysisRow(key: string | undefined | null): RegistryRow | undefined {
  if (!key) return undefined;
  return analysisRows().find((row) => row.key === key);
}

/**
 * Why a study or run of `key` cannot be set up or run because its analysis is
 * not installed (its plugin is off or did not load), else ''. Nothing is
 * missing before the page has the registry.
 */
export function analysisMissingText(key: string | undefined | null, subject: 'run' | 'study'): string {
  const registry = useProjectStore.getState().registry;
  if (!registry || analysisRow(key)) return '';
  const required = (registry.required_missing || [])[0];
  if (required) {
    const name = required.name || required.key;
    return subject === 'run'
      ? `${name} failed to load, so this run can't start.`
      : `${name} failed to load, so this simulation can't be set up or run.`;
  }
  return subject === 'run'
    ? "This run's analysis is not available: its plugin is off or did not load."
    : "This simulation's analysis is not available: its plugin is off or did not load.";
}

function td(value: unknown): 'steady' | 'transient' {
  return /transient/i.test(String(value || '')) ? 'transient' : 'steady';
}

/**
 * The analysis a study gets when none is named (the required bundled plugin's
 * [default_analysis], registry.describe default_analysis) at a time
 * dependency: '' without it (the plugin did not load).
 */
export function defaultAnalysisKey(timeDependency?: unknown): string {
  const d = useProjectStore.getState().registry?.default_analysis;
  if (!d || !d.steady) return '';
  return td(timeDependency) === 'transient' ? d.transient || d.steady : d.steady;
}

function isDefaultAlias(name: string): boolean {
  const d = useProjectStore.getState().registry?.default_analysis;
  const raw = name.trim().toLowerCase();
  return !!raw && !!d && (d.aliases || []).some((a) => String(a).toLowerCase() === raw);
}

/**
 * The analysis of `key`'s family at a time dependency (the same rule as the
 * server's analysisKeyFor): itself when it already has it, its registered
 * `_steady` / `_transient` sibling, else its family's analysis of that time
 * dependency when the family pairs one of each (a clone keeps the family of
 * the analysis it copied), else `key` unchanged (also when it is not
 * installed). Blank, or a name studies saved before analysis keys carry (the
 * default analysis's aliases), is the default analysis.
 */
export function siblingKey(key: string | undefined | null, timeDependency: unknown): string {
  const want = td(timeDependency);
  const raw = String(key || '').trim();
  if (!raw || isDefaultAlias(raw)) return defaultAnalysisKey(want);
  const row = analysisRow(raw);
  if (!row) return raw;
  if (td(row.time_dependency) === want) return row.key;
  const named = raw.match(/^(.*)_(steady|transient)$/);
  if (named && analysisRow(`${named[1]}_${want}`)) return `${named[1]}_${want}`;
  const family = row.family && row.family.key;
  if (family) {
    const members = analysisRows().filter((r) => r.family && r.family.key === family);
    const same = members.filter((r) => td(r.time_dependency) === td(row.time_dependency));
    const other = members.filter((r) => td(r.time_dependency) === want);
    if (same.length === 1 && other.length === 1) return other[0].key;
  }
  return row.key;
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
  return siblingKey(studyAnalysisType, transient ? 'transient' : 'steady');
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
