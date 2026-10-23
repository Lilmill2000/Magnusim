/**
 * Where the person is, as the dock reads it (phase 4 spec 3.3, 6.3, 7): Home, a project, or a
 * workspace over its project, and whether that workspace's tools reached the Assistant.
 *
 * - The route (location.hash, parseHomeRoute) says Home or a project and its workspace.
 * - The project's title and study come from the project store once it holds that project.
 * - A workspace offers tools when its newest list (workspaceToolsSnapshot().current) is of
 *   this route, settled, taken and not dead: the dock then binds its turns to this tab
 *   (`tab: 'link'`). Still registering, it is `connecting` for up to CONNECTING_MS from when
 *   it opened, then `late`; refused, dead or an older plugin, it offers `none`. Late or none,
 *   the dock sends the project's context instead.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseHomeRoute } from '../../home/controller';
import { useProjectStore } from '../../store/project';
import { useWorkspaceTools, type PublishedTools } from '../../workspace/assistantTools';

/** How long a workspace may take to offer its tools before the dock sends without them. */
export const CONNECTING_MS = 10_000;

export interface DockWorkspace {
  plugin: string;
  /** Its key, as the route names it. */
  key: string;
  /** How the person reads it: its registration's title, else its key. */
  name: string;
  /**
   * tools: the server took its tools (turns bind to this tab); connecting: registering, within
   * CONNECTING_MS; late: still nothing past it; none: refused, dead, or an older plugin.
   */
  state: 'tools' | 'connecting' | 'late' | 'none';
}

export interface DockPlace {
  /** null: Home. */
  projectId: string | null;
  projectTitle: string | null;
  simulationId: string | null;
  workspace: DockWorkspace | null;
}

interface Route {
  projectId: string | null;
  workspace: { plugin: string; workspace: string } | null;
}

function readRoute(): Route {
  const r = parseHomeRoute() as { view: string; projectId: string | null; workspace?: { plugin: string; workspace: string } | null };
  if (r.view !== 'workbench' || !r.projectId) return { projectId: null, workspace: null };
  return { projectId: r.projectId, workspace: r.workspace ? { plugin: r.workspace.plugin, workspace: r.workspace.workspace } : null };
}

let routeSnap: Route = { projectId: null, workspace: null };
let routeKey = '';
function routeSnapshot(): Route {
  const next = readRoute();
  const key = `${next.projectId ?? ''}\n${next.workspace?.plugin ?? ''}\n${next.workspace?.workspace ?? ''}`;
  if (key !== routeKey) {
    routeKey = key;
    routeSnap = next;
  }
  return routeSnap;
}
function subscribeRoute(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

/** The workspace as the dock sees it, from the route and the tools this page offered. */
export function workspaceOf(route: Route, cur: PublishedTools | null, connecting: boolean): DockWorkspace | null {
  const ws = route.workspace;
  if (!ws || !route.projectId) return null;
  const mine = !!cur && cur.scope.project_id === route.projectId && cur.scope.plugin === ws.plugin && cur.scope.workspace === ws.workspace;
  const name = (mine && cur ? cur.scope.title || cur.scope.workspace : '') || ws.workspace;
  const base = { plugin: ws.plugin, key: ws.workspace, name };
  const offered = mine && !!cur && !cur.dead && cur.tools.length > 0;
  if (offered && cur.settled && cur.taken) return { ...base, state: 'tools' };
  // Registering, or nothing offered yet: connecting while the wait lasts.
  const pending = offered && !cur.settled && !cur.abandoned;
  if (pending || !mine) return { ...base, state: connecting ? 'connecting' : 'late' };
  return { ...base, state: 'none' };
}

/**
 * A workspace that opened is "connecting" for CONNECTING_MS, then offers none until its tools
 * come. Each opening has its own wait: the same workspace opened again (after Back) waits again.
 */
export function useConnectingWindow(wsKey: string): boolean {
  const [expired, setExpired] = useState<string>('');
  const [seen, setSeen] = useState(wsKey);
  if (seen !== wsKey) {
    // Another workspace, or none: a later opening of the one that expired starts afresh.
    setSeen(wsKey);
    setExpired('');
  }
  useEffect(() => {
    if (!wsKey) return;
    const t = setTimeout(() => setExpired(wsKey), CONNECTING_MS);
    return () => clearTimeout(t);
  }, [wsKey]);
  return expired !== wsKey || seen !== wsKey;
}

export function useDockPlace(): DockPlace {
  const route = useSyncExternalStore(subscribeRoute, routeSnapshot, routeSnapshot);
  const tools = useWorkspaceTools();
  const project = useProjectStore((s) => (route.projectId && s.projectId === route.projectId ? s : null));
  const hydrate = project?.hydrate as { project?: { title?: unknown; name?: unknown } } | null | undefined;
  const title = hydrate?.project ? String(hydrate.project.title || hydrate.project.name || '') || null : null;
  const wsKey = route.workspace ? `${route.projectId}\n${route.workspace.plugin}\n${route.workspace.workspace}` : '';
  const connecting = useConnectingWindow(wsKey);
  return {
    projectId: route.projectId,
    projectTitle: title,
    simulationId: project?.activeSimId ?? null,
    workspace: workspaceOf(route, tools.current, connecting),
  };
}
