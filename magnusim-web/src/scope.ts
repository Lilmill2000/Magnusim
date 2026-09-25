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
