import { describe, expect, it } from 'vitest';
import { scopeBelongsToProject, scopeKey } from './scope';

describe('scopeKey', () => {
  it('matches the Python ScopeId key for the same ids', () => {
    expect(
      scopeKey({
        projectId: 'proj',
        geometryId: 'geo',
        studyId: 'study',
        meshId: 'mesh1',
      }),
    ).toBe('p:proj/g:geo/s:study/mesh:mesh1');
  });

  it('keeps a run key on the study even when a mesh id is also set', () => {
    expect(
      scopeKey({
        projectId: 'proj',
        geometryId: 'geo',
        studyId: 'study',
        meshId: 'mesh1',
        runId: 'run1',
        itemId: 'bc1',
      }),
    ).toBe('p:proj/g:geo/s:study/mesh:mesh1/run:run1/item:bc1');
  });

  it('rejects a key from another project', () => {
    const key = scopeKey({ projectId: 'a', geometryId: 'g', studyId: 's' });
    expect(scopeBelongsToProject(key, 'a')).toBe(true);
    expect(scopeBelongsToProject(key, 'b')).toBe(false);
    expect(scopeBelongsToProject('p:ab/g:g', 'a')).toBe(false);
  });
});
