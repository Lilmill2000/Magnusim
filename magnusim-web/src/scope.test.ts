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

describe('plugin study scope', () => {
  it('formats and parses p:<pid>/plugin:<key>/study:<sid>', async () => {
    const { parsePluginScope, pluginStudyScope, scopeBelongsToProject, studyIdFromScope } = await import('./scope');
    const key = pluginStudyScope('proj', 'airfoil', 'st-1');
    expect(key).toBe('p:proj/plugin:airfoil/study:st-1');
    expect(parsePluginScope(key)).toEqual({ projectId: 'proj', plugin: 'airfoil', studyId: 'st-1' });
    expect(parsePluginScope(pluginStudyScope('proj', 'airfoil'))).toEqual({ projectId: 'proj', plugin: 'airfoil', studyId: '' });
    expect(parsePluginScope('p:proj/g:g1/s:sim_1')).toBeNull();
    expect(scopeBelongsToProject(key, 'proj')).toBe(true);
    expect(scopeBelongsToProject(key, 'other')).toBe(false);
    // Never read as a core study (the multi-geometry study invariant ignores it).
    expect(studyIdFromScope(key)).toBe('');
  });
});
