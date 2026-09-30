/**
 * A plugin workspace's address: `#/p/<project>/ws/<plugin>/<workspace>/<study>`.
 * The workbench stays open underneath; the workspace is an overlay on it, so
 * Back, reload and deep links work and the project's scope is untouched.
 */
export interface WorkspaceRoute {
  projectId: string;
  plugin: string;
  workspace: string;
  studyId: string;
}

const WS_HASH = /^#?\/p\/([^/]+)\/ws\/([^/]+)\/([^/]+)\/([^/]+)$/;

export function parseWorkspaceHash(hash: string): WorkspaceRoute | null {
  const m = String(hash || '').match(WS_HASH);
  if (!m) return null;
  try {
    const [projectId, plugin, workspace, studyId] = m.slice(1).map((part) => decodeURIComponent(part));
    return { projectId, plugin, workspace, studyId };
  } catch {
    // A hand-edited link with a broken %-escape is not a workspace.
    return null;
  }
}

export function workspaceHash(route: WorkspaceRoute): string {
  const enc = encodeURIComponent;
  return `#/p/${enc(route.projectId)}/ws/${enc(route.plugin)}/${enc(route.workspace)}/${enc(route.studyId)}`;
}

/** True for the project's own hash and any of its workspace hashes. */
export function hashIsProject(hash: string, projectId: string): boolean {
  const base = `#/p/${encodeURIComponent(projectId)}`;
  return hash === base || hash.startsWith(`${base}/ws/`);
}
