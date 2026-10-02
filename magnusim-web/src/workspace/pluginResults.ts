/**
 * results.openIn3D: a plugin case's saved frames in the project's 3D view.
 *
 * The app finds the case (/api/plugin-cases/resolve: its results key, folder,
 * frames and solver), asks before it replaces results already on screen, then
 * leaves the workspace for the project (asking first when the page has unsaved
 * work). Once the workspace has closed (cfd:workspace-close), the workbench
 * opens the frames (window.__CFD_OPEN_PLUGIN_RESULTS__). This module, not the
 * overlay, waits for that close: the overlay is gone by then.
 */
import type { PluginResultsInfo } from '../workbench/pluginResultsRules';
import { BridgeError } from './bridge';
import { LEAVE_APPROVAL_MS } from './leaveGuard';

/** The workspace the results come from. */
export interface ResultsScope {
  projectId: string;
  plugin: string;
  pluginName: string;
  studyId: string;
  studyTitle: string;
}

/** What /api/plugin-cases/resolve says of a finished case. */
export interface ResolvedCase {
  key: string;
  case_dir: string;
  times: string[];
  app: string | null;
  time_dependency: string;
  frame_fields: string[];
}

export interface OpenResultsDeps {
  /** The page's question, in turn with the app's dialogs; false on Cancel. */
  ask(q: { title: string; copy: string; yes: string }): Promise<boolean>;
  /** Leave the workspace for `hash` ('results': with unsaved work the app asks first); false when the user stays. */
  leave(hash: string): Promise<boolean>;
  /** Results are on screen now (window.__CFD_RESULTS_VIEW__). */
  resultsShown(): boolean;
}

/** Asked only when other results are on screen. */
export const REPLACE_QUESTION = { title: 'Open these results?', copy: 'This replaces the results currently shown.', yes: 'Open results' };

/** A finished case of this study, or the app's refusal (running, no_results, not_found, invalid_path, …) with its code. */
export async function resolvePluginCase(scope: ResultsScope, caseRel: string): Promise<ResolvedCase> {
  const q = new URLSearchParams({ project_id: scope.projectId, plugin: scope.plugin, study_id: scope.studyId, case_rel: caseRel });
  const r = await fetch(`/api/plugin-cases/resolve?${q}`, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as Partial<ResolvedCase> & { error?: string; code?: unknown };
  if (!r.ok) {
    const code = typeof j.code === 'string' && j.code ? j.code : r.status === 404 ? 'not_found' : r.status === 409 ? 'conflict' : 'failed';
    throw new BridgeError(String(j.error || `the app answered ${r.status}`), code);
  }
  return {
    key: String(j.key || ''),
    case_dir: String(j.case_dir || ''),
    times: Array.isArray(j.times) ? j.times.map((t) => String(t)) : [],
    app: typeof j.app === 'string' && j.app ? j.app : null,
    time_dependency: String(j.time_dependency || 'steady'),
    frame_fields: Array.isArray(j.frame_fields) ? j.frame_fields.map((f) => String(f)) : [],
  };
}

/**
 * Open a case's results in 3D. False when the user cancelled or stayed; true once
 * the workspace is closing for them (the results open when it has closed).
 */
export async function openPluginResults(scope: ResultsScope, caseRel: string, deps: OpenResultsDeps): Promise<boolean> {
  const found = await resolvePluginCase(scope, caseRel);
  if (deps.resultsShown() && !(await deps.ask({ ...REPLACE_QUESTION }))) return false;
  const info: PluginResultsInfo = {
    key: found.key,
    projectId: scope.projectId,
    caseDir: found.case_dir,
    plugin: scope.plugin,
    pluginName: scope.pluginName,
    studyId: scope.studyId,
    studyTitle: scope.studyTitle,
    caseRel,
    app: found.app,
    timeDependency: found.time_dependency,
    times: found.times,
  };
  if (!(await deps.leave(`#/p/${encodeURIComponent(scope.projectId)}`))) return false;
  openWhenClosed(info);
  return true;
}

let waiting: { cancel(): void } | null = null;

/**
 * Hand the results to the workbench once the workspace has closed. One at a
 * time (a newer one replaces it); dropped when no close comes within LEAVE_APPROVAL_MS.
 */
export function openWhenClosed(info: PluginResultsInfo, timeoutMs = LEAVE_APPROVAL_MS): void {
  waiting?.cancel();
  const onClose = () => {
    stop();
    const open = window.__CFD_OPEN_PLUGIN_RESULTS__;
    if (typeof open !== 'function') {
      console.warn('[workspace] the results view is not loaded: plugin case results not opened');
      return;
    }
    void Promise.resolve()
      .then(() => open(info))
      .then((r) => {
        // A study or geometry picked meanwhile wins (stale) and says nothing.
        if (r && !r.ok && !r.stale) toast(r.error || 'These results could not be opened');
      })
      .catch((err) => {
        console.warn('[workspace] opening plugin case results failed', err);
        toast('These results could not be opened');
      });
  };
  const timer = setTimeout(() => stop(), timeoutMs);
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener('cfd:workspace-close', onClose);
    if (waiting === entry) waiting = null;
  };
  const entry = { cancel: stop };
  waiting = entry;
  window.addEventListener('cfd:workspace-close', onClose, { once: true });
}

function toast(message: string): void {
  window.dispatchEvent(new CustomEvent('cfd:toast', { detail: { message, kind: 'error' } }));
}
