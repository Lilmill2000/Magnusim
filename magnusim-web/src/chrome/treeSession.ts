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

/**
 * The project's studies as the workbench has them, once it has their list. A tree read
 * sent before a study was deleted still has its row (active, with the + buttons) until
 * the next read lands; the workbench's word wins over that read.
 */
export interface TreeStudies {
  projectId: string;
  /** Studies it has seen go: their rows are dropped. */
  gone: string[];
  /** The study it has open ('' for none): that row is the active one. */
  activeId: string;
}

export interface TreeSession {
  projectId: string;
  expanded: Record<string, boolean>;
  selectedKey: string | null;
  activity: TreeActivity | null;
  studies: TreeStudies | null;
}

/** A tree row's action: its scope key, the action, and what the row shows (a plugin study's title and rev). */
type TreeActionHandler = (scopeKey: string, action: string, detail?: Record<string, unknown>) => void;

let session: TreeSession = {
  projectId: '',
  expanded: {},
  selectedKey: null,
  activity: null,
  studies: null,
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
    studies: next.studies !== undefined ? next.studies : session.studies,
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

export function onTreeAction(scopeKey: string, action: string, detail?: Record<string, unknown>): void {
  if (actionHandler) actionHandler(scopeKey, action, detail);
}
