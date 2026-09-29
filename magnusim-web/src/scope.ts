/** Same key shape as python/cfddesk/project/scope.py ScopeId.key. */

export interface ScopeId {
  projectId: string;
  geometryId?: string;
  studyId?: string;
  meshId?: string;
  runId?: string;
  itemId?: string;
}

export function scopeKey(scope: ScopeId): string {
  const parts = [`p:${scope.projectId}`];
  if (scope.geometryId) parts.push(`g:${scope.geometryId}`);
  if (scope.studyId) parts.push(`s:${scope.studyId}`);
  if (scope.meshId) parts.push(`mesh:${scope.meshId}`);
  if (scope.runId) parts.push(`run:${scope.runId}`);
  if (scope.itemId) parts.push(`item:${scope.itemId}`);
  return parts.join('/');
}

export function scopeBelongsToProject(scopeKeyValue: string, projectId: string): boolean {
  const pid = String(projectId || '');
  const key = String(scopeKeyValue || '');
  if (!key || !pid) return false;
  return key === `p:${pid}` || key.startsWith(`p:${pid}/`);
}

export function studyIdFromScope(scopeKeyValue: string): string {
  const match = String(scopeKeyValue || '').match(/(?:^|\/)s:([^/]+)/);
  return match ? match[1] : '';
}

/**
 * `p:<pid>/plugin:<key>[/study:<sid>]`: a plugin's project-level data or one of
 * its studies (python cfddesk.project.scope.plugin_study_scope). Plugin studies
 * belong to the project, not a geometry: not part of the ScopeId chain.
 */
export function pluginStudyScope(projectId: string, plugin: string, studyId = ''): string {
  const key = `p:${projectId}/plugin:${plugin}`;
  return studyId ? `${key}/study:${studyId}` : key;
}

export interface PluginScope {
  projectId: string;
  plugin: string;
  studyId: string;
}

/** The parts of a plugin scope key, or null for any other key. */
export function parsePluginScope(scopeKeyValue: string): PluginScope | null {
  const m = String(scopeKeyValue || '').match(/^p:([^/]+)\/plugin:([^/]+)(?:\/study:([^/]+))?$/);
  return m ? { projectId: m[1], plugin: m[2], studyId: m[3] || '' } : null;
}
