/**
 * Where an app tab is (core host tools spec C5, C7): what its registrations say now.
 *
 * Every app tab on this PC registers its core page (where it is: Home, a project's workbench, or
 * a workspace, with the project and study it shows), and a workspace open in it registers its own
 * tools beside. A turn bound to the tab reads this at each step, so it follows its tab: the loop
 * (loop.ts), a coding agent's turn at each call (agents/turn.ts), and the start (turns.ts
 * resolveTab). Kept apart from turns.ts so the runners read it without importing the manager.
 */
import type { CorePlace, WorkspaceRegistration } from './registry.ts';

/** What the registry says of a tab, as tabHere reads it. */
export interface TabRegistrations {
  workspaceOf(tab: string): { connected: boolean; reg: Pick<WorkspaceRegistration, 'projectId' | 'studyId'> } | null;
  coreOf?(tab: string): { connected: boolean; projectId: string; studyId: string; place: CorePlace } | null;
}

/**
 * Where `tab` is now: its connected workspace's project and study (the plugin study), else its
 * core page's (projectId '' on Home). Null when neither registered. `connected`: its link is live.
 */
export function tabHere(reg: TabRegistrations, tab: string): { projectId: string; studyId: string; place: CorePlace; connected: boolean } | null {
  const ws = reg.workspaceOf(tab);
  const core = reg.coreOf?.(tab) ?? null;
  if (ws && ws.connected && ws.reg.projectId) return { projectId: ws.reg.projectId, studyId: ws.reg.studyId, place: 'workspace', connected: true };
  if (core) return { projectId: core.projectId, studyId: core.studyId, place: core.place, connected: core.connected };
  if (ws && ws.reg.projectId) return { projectId: ws.reg.projectId, studyId: ws.reg.studyId, place: 'workspace', connected: false };
  return null;
}

/**
 * ToolCtx.place for a context (core host tools spec 11.3, C8): a connected workspace registration →
 * workspace; else the tab's core page's place, else a project → workbench, else Home. A tab-less
 * MCP client is Home (its project tools take project_id).
 */
export function placeOf(reg: TabRegistrations, tab: string | null, projectId: string | null): CorePlace {
  const here = tab ? tabHere(reg, tab) : null;
  if (here) return here.place;
  return projectId ? 'workbench' : 'home';
}

