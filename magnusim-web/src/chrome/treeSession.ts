export interface TreeActivity {
  project_id?: string | null;
  simulation_id?: string | null;
  kind?: string | null;
  mesh_id?: string | null;
  run_id?: string | null;
  queue?: Array<{
    kind?: string;
    mesh_id?: string | null;
    run_id?: string | null;
    project_id?: string | null;
    simulation_id?: string | null;
    /** 1-based place in the whole queue (all projects); the list itself is this project's rows. */
    position?: number | null;
  }>;
}

export interface TreeSession {
  projectId: string;
  expanded: Record<string, boolean>;
  selectedKey: string | null;
  activity: TreeActivity | null;
}

type TreeActionHandler = (scopeKey: string, action: string) => void;

let session: TreeSession = {
  projectId: '',
  expanded: {},
  selectedKey: null,
  activity: null,
};
let actionHandler: TreeActionHandler | null = null;
const listeners = new Set<() => void>();

export function getTreeSession(): TreeSession {
  return session;
}

export function treeExpanded(label: string, fallback = false): boolean {
  const expanded = session.expanded;
  if (Object.prototype.hasOwnProperty.call(expanded, label)) return !!expanded[label];
  return fallback;
}

export function applyTreeSession(next: Partial<TreeSession>): void {
  session = {
    projectId: next.projectId !== undefined ? next.projectId : session.projectId,
    expanded: next.expanded ? { ...next.expanded } : session.expanded,
    selectedKey: next.selectedKey !== undefined ? next.selectedKey : session.selectedKey,
    activity: next.activity !== undefined ? next.activity : session.activity,
  };
  listeners.forEach((fn) => fn());
}

export function subscribeTreeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTreeActionHandler(fn: TreeActionHandler | null): void {
  actionHandler = fn;
}

export function onTreeAction(scopeKey: string, action: string): void {
  if (actionHandler) actionHandler(scopeKey, action);
}
