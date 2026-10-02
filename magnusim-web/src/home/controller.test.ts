import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wizard/controller', () => ({ initSetupWizard: () => {} }));

// The open workspace, as the leave guard would report it.
const guard = vi.hoisted(() => ({
  route: null as null | { projectId: string; plugin: string; workspace: string; studyId: string },
  dirty: false,
  // The user's answer: at once, or (a promise) once they give it.
  answer: false as boolean | Promise<boolean>,
  asked: [] as unknown[][],
}));
vi.mock('../workspace/leaveGuard', () => ({
  openWorkspaceRoute: () => guard.route,
  workspaceDirty: () => guard.dirty,
  confirmLeaveWorkspace: async (reason: string, opts: { interactive?: boolean } = {}) => {
    guard.asked.push([reason, opts]);
    return opts.interactive === false ? false : await guard.answer;
  },
}));

import { formatHomeSolveLine, openProject } from './controller';

// A project card's progress line reads the run on its analysis's x axis
// (contract x_axis): simulated seconds or iterations.
describe('home card progress', () => {
  const live = { simulating: true, sim_time: 1.5, sim_end: 5, iteration: 40, endTime: 200 };

  it('shows simulated time on a seconds axis', () => {
    expect(formatHomeSolveLine({ ...live, x_axis: 'seconds', time_dependency: 'Steady-state' })).toBe('1.5 s / 5 s');
  });

  it('labels 1 to 10 ms as the workbench does (0.005 s, not 5.0e-3 s)', () => {
    expect(formatHomeSolveLine({ ...live, x_axis: 'seconds', sim_time: 0.005, sim_end: 0.0099996 })).toBe('0.005 s / 0.01 s');
    expect(formatHomeSolveLine({ ...live, x_axis: 'seconds', sim_time: 99.95, sim_end: 200 })).toBe('100 s / 200 s');
  });

  it('shows iterations on an iterations axis', () => {
    expect(formatHomeSolveLine({ ...live, x_axis: 'iterations', time_dependency: 'Transient' })).toBe('40 / 200');
  });

  it('reads the time dependency when the server sends no axis', () => {
    expect(formatHomeSolveLine({ ...live, time_dependency: 'Transient' })).toBe('1.5 s / 5 s');
    expect(formatHomeSolveLine({ ...live, time_dependency: 'Steady-state' })).toBe('40 / 200');
  });

  it('adds the time left once the run has been solving a while', () => {
    const started = new Date(Date.now() - 60_000).toISOString();
    const line = formatHomeSolveLine({ ...live, x_axis: 'seconds', solve_started_at: started });
    expect(line).toMatch(/^1\.5 s \/ 5 s · ~\d+:\d\d left$/);
  });
});

// Opening another project replaces an open workspace: with unsaved work it asks first.
describe('openProject over a workspace with unsaved work', () => {
  const REFUSED = { ok: false, stayed: true, error: 'The open workspace has unsaved changes.' };
  let opens: string[] = [];
  let prepare: ReturnType<typeof vi.fn>;
  // Holds the app's answer to /api/project/open until released (an open still on its way).
  let opening: Promise<void> | null = null;

  beforeEach(() => {
    guard.route = { projectId: 'proj', plugin: 'ws-demo', workspace: 'bench', studyId: 'st-1' };
    guard.dirty = true;
    guard.answer = false;
    guard.asked = [];
    opens = [];
    opening = null;
    prepare = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/project/open') {
          const id = JSON.parse(String(init?.body || '{}')).project_id;
          opens.push(id);
          if (opening) await opening;
          return new Response(JSON.stringify({ ok: true, project: { id } }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const w = window as unknown as Record<string, unknown>;
    w.__CFD_PREPARE_PROJECT_SWITCH__ = prepare;
    w.__CFD_PROJECT_OPEN_BEGIN__ = vi.fn();
    w.__CFD_HYDRATE_PROJECT__ = vi.fn(async () => ({}));
    w.__CFD_PROJECT_READY__ = 'proj';
    w.__CFD_W16__ = { project: { id: 'proj' } };
    document.body.classList.add('on-workbench');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const w = window as unknown as Record<string, unknown>;
    for (const k of ['__CFD_PREPARE_PROJECT_SWITCH__', '__CFD_PROJECT_OPEN_BEGIN__', '__CFD_HYDRATE_PROJECT__', '__CFD_PROJECT_READY__', '__CFD_W16__']) {
      delete w[k];
    }
    document.body.classList.remove('on-workbench', 'on-home');
  });

  it('a caller that must not ask is refused: no dialog, nothing opened, nothing reset', async () => {
    expect(await openProject('other', { reloadIfNeeded: false, askToLeave: false })).toEqual(REFUSED);
    expect(guard.asked).toEqual([['project', { interactive: false }]]);
    expect(opens).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('asks; Stay is refused the same way', async () => {
    expect(await openProject('other', { reloadIfNeeded: false })).toEqual(REFUSED);
    expect(guard.asked).toEqual([['project', { interactive: true }]]);
    expect(opens).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('asks; Leave opens the other project', async () => {
    guard.answer = true;
    expect(await openProject('other', { reloadIfNeeded: false })).toMatchObject({ ok: true, project: { id: 'other' } });
    expect(guard.asked).toHaveLength(1);
    expect(prepare).toHaveBeenCalledWith('other');
    expect(opens).toEqual(['other']);
  });

  it('Leave joins an open of the same project that started while the question was on screen', async () => {
    let reply: (ok: boolean) => void = () => undefined;
    guard.answer = new Promise<boolean>((r) => (reply = r));
    let release: () => void = () => undefined;
    opening = new Promise<void>((r) => (release = r));
    const asked = openProject('other', { reloadIfNeeded: false });
    await vi.waitFor(() => expect(guard.asked).toHaveLength(1));
    // Meanwhile the page saved, and the same project started opening from elsewhere.
    guard.dirty = false;
    const started = openProject('other', { reloadIfNeeded: false });
    await vi.waitFor(() => expect(opens).toEqual(['other']));
    reply(true);
    release();
    const [a, b] = await Promise.all([asked, started]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ ok: true, project: { id: 'other' } });
    expect(opens).toEqual(['other']);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("never asks for the workspace's own project, or when nothing would be lost", async () => {
    // Already open and shown.
    await openProject('proj');
    // Not shown yet (it opens again).
    (window as unknown as Record<string, unknown>).__CFD_PROJECT_READY__ = null;
    await openProject('proj', { reloadIfNeeded: false });
    // Clean workspace, another project.
    guard.dirty = false;
    await openProject('other', { reloadIfNeeded: false });
    expect(guard.asked).toEqual([]);
    expect(opens).toEqual(['proj', 'proj', 'other']);
  });
});
