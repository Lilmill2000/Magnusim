/**
 * Plugin case results opened in 3D (results.openIn3D). The workspace closes
 * back to its project and the case's saved frames show in the main viewer,
 * with no core study active. runtime.js keeps one record for them and asks
 * these rules what changes while they show: no filter autosave and no saved
 * Views (there is no run doc to keep them in), no Compare, and no mesh
 * scaling to the CAD (the case is not the CAD, which is hidden).
 */

/** What the workspace hands over when it closes (`window.__CFD_OPEN_PLUGIN_RESULTS__`). */
export type PluginResultsInfo = {
  /** 'pf-' and 12 hex: the results' run id in the viewer, never a core run's. */
  key: string;
  projectId: string;
  caseDir: string;
  plugin: string;
  pluginName?: string | null;
  studyId: string;
  studyTitle?: string | null;
  caseRel: string;
  app?: string | null;
  /** 'transient' or 'steady' (anything else reads as steady). */
  timeDependency?: string | null;
  /** Saved complete frames, oldest first. */
  times?: Array<string | number> | null;
};

/** The run record the viewer's results code reads while plugin results show. */
export type PluginResultsRecord = {
  id: string;
  run_id: string;
  project_id: string;
  simulation_id: null;
  name: string;
  status: 'done';
  has_results: true;
  n_saved_times: number;
  last_saved_iteration: number;
  case_dir: string;
  path_kind: string;
  time_dependency: string;
  plugin_case: { plugin: string; study_id: string; case_rel: string };
};

export const PLUGIN_RESULTS_KEY_RE = /^pf-[0-9a-f]{12}$/;

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/** True for the run id of plugin case results ('pf-…'). */
export function isPluginResultsKey(id: unknown): boolean {
  return typeof id === 'string' && PLUGIN_RESULTS_KEY_RE.test(id);
}

/**
 * The record for these results, or null when the info is not usable or names
 * another project than the open one.
 */
export function pluginResultsRecord(
  info: Partial<PluginResultsInfo> | null | undefined,
  opts?: { projectId?: unknown },
): PluginResultsRecord | null {
  if (!info || !isPluginResultsKey(info.key)) return null;
  const projectId = text(info.projectId);
  const caseDir = text(info.caseDir);
  const plugin = text(info.plugin);
  const studyId = text(info.studyId);
  if (!projectId || !caseDir || !plugin || !studyId) return null;
  const open = text(opts && opts.projectId);
  if (open && open !== projectId) return null;
  const times = (Array.isArray(info.times) ? info.times : []).map((t) => text(t)).filter(Boolean);
  const last = Number(times[times.length - 1]);
  const transient = /transient/i.test(text(info.timeDependency));
  return {
    id: info.key as string,
    run_id: info.key as string,
    project_id: projectId,
    simulation_id: null,
    name: `${text(info.pluginName) || plugin} \u{203A} ${text(info.studyTitle) || studyId}`,
    status: 'done',
    has_results: true,
    n_saved_times: times.length,
    last_saved_iteration: Number.isFinite(last) ? last : 0,
    case_dir: caseDir,
    path_kind: text(info.app),
    time_dependency: transient ? 'transient' : 'steady',
    plugin_case: { plugin, study_id: studyId, case_rel: text(info.caseRel) },
  };
}

/** The record answers this run id (findRunRecord asks it first). */
export function pluginResultsMatch(rec: { id?: unknown } | null | undefined, runId: unknown): boolean {
  return !!rec && isPluginResultsKey(runId) && text(rec.id) === text(runId);
}

/** The filter set autosaves into the run doc; plugin results have none. */
export function pluginResultsAutosaveAllowed(runId: unknown): boolean {
  return !isPluginResultsKey(runId);
}

/** Saved Views live in the run doc too: hidden for plugin results. */
export function pluginResultsShowsViews(runId: unknown): boolean {
  return !isPluginResultsKey(runId);
}

/** Compare (#btn-compare) compares core runs or meshes: hidden while plugin results show. */
export function pluginResultsShowsCompare(rec: unknown): boolean {
  return !rec;
}

/** The shown geometry's CAD is not the case's geometry: hidden while plugin results show. */
export function pluginResultsShowsCad(rec: unknown): boolean {
  return !rec;
}

/**
 * The mesh/results display scale while plugin results show: 1 (the case is
 * drawn as it is; the CAD it would be scaled to is not its geometry). Null
 * when no plugin results show: the usual rule applies.
 */
export function pluginResultsDisplayScale(rec: unknown): number | null {
  return rec ? 1 : null;
}
