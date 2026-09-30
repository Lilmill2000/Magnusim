import { describe, expect, it } from 'vitest';
import { hashIsProject, parseWorkspaceHash, workspaceHash } from './route';

describe('workspace route', () => {
  it('round-trips #/p/<pid>/ws/<plugin>/<ws>/<sid>, escaping each part', () => {
    const route = { projectId: 'my project', plugin: 'ws-demo', workspace: 'bench', studyId: 'st-1a2b3c4d' };
    const hash = workspaceHash(route);
    expect(hash).toBe('#/p/my%20project/ws/ws-demo/bench/st-1a2b3c4d');
    expect(parseWorkspaceHash(hash)).toEqual(route);
    expect(parseWorkspaceHash(hash.slice(1))).toEqual(route);
  });

  it('is not a workspace: the project itself, a partial or longer path, a broken escape', () => {
    for (const hash of ['#/p/a', '#/p/a/ws/p/w', '#/p/a/ws/p/w/s/x', '#/p/a/ws//w/s', '#/recent', '', '#/p/a/ws/p/%E0%A4%A/s']) {
      expect(parseWorkspaceHash(hash)).toBeNull();
    }
  });

  it('keeps a project hash and its workspace hashes as that project', () => {
    expect(hashIsProject('#/p/a', 'a')).toBe(true);
    expect(hashIsProject('#/p/a/ws/p/w/s', 'a')).toBe(true);
    expect(hashIsProject('#/p/ab', 'a')).toBe(false);
    expect(hashIsProject('#/p/b/ws/p/w/s', 'a')).toBe(false);
  });
});
