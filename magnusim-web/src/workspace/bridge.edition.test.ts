import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';

// Magnusim CAD has no project geometries (src/app/edition.ts): its host refuses a page's link
// calls ("not_allowed": this host links nothing), so a Part never becomes a geometry. The exit
// hook stays, for the page's save at Back. Magnusim's host still takes the link calls.

const SCOPE: BridgeScope = {
  plugin: 'cad',
  pluginName: 'Magnusim CAD',
  workspace: 'part',
  projectId: 'proj-a',
  projectTitle: 'Project A',
  studyId: 'st-1',
};

function hooks(): BridgeHooks {
  return {
    back: vi.fn(async () => true),
    setDirty: vi.fn(),
    connected: vi.fn(),
    studyChanged: vi.fn(),
    studyGone: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => 'Named'),
    units: vi.fn(() => 'metric' as const),
    log: vi.fn(),
    openResults: vi.fn(async () => true),
    linkReport: vi.fn(),
    linkStarted: vi.fn(),
  } as unknown as BridgeHooks;
}

let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ ok: true, linked: { geometryId: 'g1', name: 'Wing', rev: 1 } }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('a workspace page in Magnusim CAD', () => {
  it('may not link its design into the project, and keeps its exit hook', async () => {
    document.head.innerHTML = '<meta name="magnusim-edition" content="cad">';
    const c = new WorkspaceCalls(SCOPE, hooks());
    c.setPush(() => undefined);
    for (const method of ['project.linkGeometry', 'project.linkedGeometry', 'project.followGeometry']) {
      await expect(c.handle(method, { on: true }), method).rejects.toMatchObject({ code: 'not_allowed' });
    }
    expect(asked, 'nothing reached the server').toEqual([]);
    await expect(c.handle('nav.leaveHook', { on: true })).resolves.toEqual({ ok: true });
    // The rest of the page's calls are as in Magnusim.
    await expect(c.handle('project.info', {})).resolves.toMatchObject({ id: 'proj-a', title: 'Project A' });
  });

  it('hears it in its welcome (context.projectLinks false), to leave out what only matters to a simulation', async () => {
    document.head.innerHTML = '<meta name="magnusim-edition" content="cad">';
    const c = new WorkspaceCalls(SCOPE, hooks());
    expect(await c.context()).toMatchObject({ projectLinks: false });
  });
});

describe('a workspace page in Magnusim (unchanged)', () => {
  it('reads its linked geometry and registers its exit hook', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    c.setPush(() => undefined);
    await expect(c.handle('project.linkedGeometry', {})).resolves.toMatchObject({ geometryId: 'g1' });
    expect(asked.some((u) => u.startsWith('/api/plugin-geometry/linked?'))).toBe(true);
    await expect(c.handle('nav.leaveHook', { on: true })).resolves.toEqual({ ok: true });
  });

  it('has no projectLinks in its welcome (absent: the link calls work)', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    expect('projectLinks' in (await c.context())).toBe(false);
  });
});
