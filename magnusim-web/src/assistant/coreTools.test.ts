// The app page's own Assistant tools (core host tools spec 5, C7, 16.2): the registration is
// published again when the route, project or study changes (and not for the same place); the
// person first: a tool that would move the view waits up to 10 s while they drag or use the
// Filters panel, saying so, then answers person_busy, and a picture never waits; core__show's
// targets go the person's own way (leave guards, Back, the project's ready mark); core__view's
// pictures and moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../home/controller', () => ({ openProject: vi.fn(), parseHomeRoute: vi.fn(), showHome: vi.fn() }));

import { resetWorkspaceToolsForTests, workspaceToolsSnapshot, type PublishedTools } from '../workspace/assistantTools';
import type { AssistantInvoke } from '../workspace/bridge';
import { useProjectStore } from '../store/project';
import { CORE_KEYBINDS_SCHEMA, CORE_SET_KEYBIND_SCHEMA } from './coreToolDefs';
import {
  CORE_GUIDE,
  CORE_SHOW_SCHEMA,
  CORE_TOOLS,
  CORE_VIEW_SCHEMA,
  HOME_PICTURE_NOTE,
  VIEW_WAIT_LABEL,
  VIEW_WAIT_MS,
  runCoreTool,
  scopeNow,
  startCoreTools,
  type AssistantCoreApi,
  type CoreRuntime,
} from './coreTools';

type Route = ReturnType<CoreRuntime['route']>;

/** A fake page: its route, its clock and the workbench's functions, each recorded. */
function fakeRuntime(o: Partial<CoreRuntime> = {}) {
  const calls: string[] = [];
  let now = 1_000_000;
  const state = {
    route: { view: 'workbench', projectId: 'p1', workspace: null } as Route,
    ready: 'p1' as string | null,
    study: 's1',
    pressed: false,
    inputAt: 0,
    filters: false,
    busy: '',
    tools: null as PublishedTools | null,
    job: null as string | null,
  };
  const pic = { blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), width: 640, height: 400, type: 'image/png' };
  const api: AssistantCoreApi = {
    viewerPressed: () => state.pressed,
    viewerInputAt: () => state.inputAt,
    viewBusy: () => state.busy,
    filtersInUse: () => state.filters,
    captureViewImage: vi.fn(async (x) => (calls.push(`picture ${x.aspect} ${x.width} ${x.legend}`), pic)),
    saveAssistantPicture: vi.fn(async () => (calls.push('save'), { id: 'img-1' })),
    shown: () => ({ project_id: 'p1', geometry_id: 'g1', study_id: state.study, mesh_id: '', run_id: '', results: false, mesh_inspect: false }),
    hasGeometry: (id) => id === 'g1',
    hasStudy: (id) => id === 's1' || id === 's2',
    hasMesh: (id) => id === 'm1',
    hasRun: (id) => id === 'r1',
    switchGeometry: async (id) => calls.push(`geometry ${id}`),
    selectStudy: async (id) => {
      calls.push(`study ${id}`);
      state.study = id;
      return {};
    },
    showMesh: async (id) => calls.push(`mesh ${id}`),
    showRun: async (id) => calls.push(`run ${id}`),
    showResults: async (id) => calls.push(`results ${id}`),
    openPanel: (p) => (calls.push(`panel ${p}`), true),
    fit: () => void calls.push('fit'),
    normalTo: (id) => (calls.push(`normal ${id}`), id === 'face 3@Body1'),
    orbitAt: (id) => (calls.push(`orbit ${id}`), true),
    setHidden: (ids, hide) => {
      calls.push(`${hide ? 'hide' : 'show'} ${ids.join(',')}`);
      const known = ids.filter((i) => /^face|^Body/.test(i));
      return { faces: known.filter((i) => i.startsWith('face')).length, bodies: known.filter((i) => i.startsWith('Body')).length, unknown: ids.filter((i) => !known.includes(i)) };
    },
    showAll: () => void calls.push('show all'),
    edges: (on) => void calls.push(`edges ${on}`),
    legend: (on) => void calls.push(`legend ${on}`),
  };
  const rt: CoreRuntime = {
    route: () => state.route,
    api: () => api,
    projectReady: () => state.ready,
    studyOf: (id) => (id === state.route.projectId ? state.study : ''),
    openProject: vi.fn(async (id: string) => {
      calls.push(`open ${id}`);
      state.route = { view: 'workbench', projectId: id, workspace: null };
      state.ready = id;
      return { ok: true };
    }),
    goHome: vi.fn(async () => {
      calls.push('home');
      state.route = { view: 'home', projectId: null, workspace: null };
      return true;
    }),
    leaveWorkspaceTo: vi.fn(async (hash: string) => {
      calls.push(`leave ${hash}`);
      state.route = { view: 'workbench', projectId: state.route.projectId, workspace: null };
      return true;
    }),
    leaveAsks: () => false,
    lastLeaveLinkJob: () => state.job,
    setHash: (hash) => void calls.push(`hash ${hash}`),
    pluginStudies: async () => [{ id: 'ps-1', plugin: 'cad', workspace: 'part', title: 'Plate', available: true }],
    workspaceTools: () => state.tools,
    subscribeWorkspaceTools: () => () => undefined,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pagePicture: vi.fn(async (p: { aspect: string; width: number }) => ({ blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), width: p.width, height: Math.round(p.width * 0.5625), type: 'image/png' })),
    ...o,
  };
  return { rt, api, calls, state, advance: (ms: number) => (now += ms) };
}

function req(tool: string, input: Record<string, unknown>) {
  const progress: Array<[number | null, string, boolean]> = [];
  const ac = new AbortController();
  const r: AssistantInvoke = {
    call: 'ai-1',
    turn: 't-1',
    tool,
    input,
    timeoutS: 60,
    signal: ac.signal,
    onProgress: (f, label, opts) => progress.push([f, label, opts?.waiting === true]),
    onAlive: () => undefined,
  };
  return { r, progress, abort: () => ac.abort() };
}

const show = (target: string, o: Record<string, unknown> = {}) => req('show', { target, project_id: '', id: '', panel: '', ...o });
const view = (action: string, o: Record<string, unknown> = {}) => req('view', { action, target_ids: [], aspect: 'view', size: 'small', with_legend: true, on: false, save: false, ...o });

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  resetWorkspaceToolsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the registration', () => {
  it('the four tools, strict-shaped (every property required, no unions), and the short guide', () => {
    expect(CORE_TOOLS.map((t) => [t.name, t.risk])).toEqual([
      ['show', 'edit'],
      ['view', 'read'],
      ['keybinds', 'read'],
      ['set_keybind', 'edit'],
    ]);
    for (const schema of [CORE_SHOW_SCHEMA, CORE_VIEW_SCHEMA, CORE_KEYBINDS_SCHEMA, CORE_SET_KEYBIND_SCHEMA]) {
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    }
    for (const t of CORE_TOOLS) expect(t.description.length).toBeLessThanOrEqual(400);
    expect(CORE_GUIDE).toBe('Use core__show to move between Home, a project and its workspaces; your tools change with the place.');
  });

  it('published at once and again when the route, the project or the study changes; the same place publishes nothing; stopping withdraws it', async () => {
    const f = fakeRuntime();
    f.state.route = { view: 'home', projectId: null, workspace: null };
    const stop = startCoreTools(f.rt);
    const first = workspaceToolsSnapshot().core;
    expect(first?.scope).toEqual({ project_id: '', study_id: '', place: 'home' });
    expect(first?.tools).toBe(CORE_TOOLS);
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: null };
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();
    expect(workspaceToolsSnapshot().core?.scope).toEqual({ project_id: 'p1', study_id: 's1', place: 'workbench' });
    const second = workspaceToolsSnapshot().core;
    expect(second && first && second.rev > first.rev).toBe(true);
    f.state.study = 's2';
    window.dispatchEvent(new CustomEvent('cfd:study'));
    await Promise.resolve();
    expect(workspaceToolsSnapshot().core?.scope.study_id).toBe('s2');
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: { projectId: 'p1', plugin: 'cad', workspace: 'part', studyId: 'ps-1' } };
    useProjectStore.getState().setActiveSim('s2');
    await Promise.resolve();
    const inWs = workspaceToolsSnapshot().core;
    expect(inWs?.scope.place).toBe('workspace');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();
    expect(workspaceToolsSnapshot().core).toBe(inWs);
    stop();
    expect(workspaceToolsSnapshot().core).toBeNull();
  });

  it('where the tab is: Home, the workbench, a workspace', () => {
    const f = fakeRuntime();
    expect(scopeNow(f.rt)).toEqual({ project_id: 'p1', study_id: 's1', place: 'workbench' });
    f.state.route = { view: 'home', projectId: null, workspace: null };
    expect(scopeNow(f.rt)).toEqual({ project_id: '', study_id: '', place: 'home' });
  });
});

describe('the person first (§5.3)', () => {
  it('while they drag (or did within 1.5 s) or use the Filters panel: waits up to 10 s saying so, then person_busy; the view never moved', async () => {
    const f = fakeRuntime();
    f.state.pressed = true;
    const { r, progress } = view('fit');
    const out = await runCoreTool(r, f.rt);
    expect(out).toMatchObject({ ok: false, code: 'person_busy', hint: 'Try again in a moment.' });
    expect(progress[0]).toEqual([null, VIEW_WAIT_LABEL, true]);
    expect(f.calls).toEqual([]);
    f.state.pressed = false;
    f.state.filters = true;
    expect(await runCoreTool(show('study', { id: 's2' }).r, f.rt)).toMatchObject({ code: 'person_busy' });
    expect(f.calls).toEqual([]);
    f.state.filters = false;
    f.state.inputAt = f.rt.now() - 1000;
    const late = view('fit');
    expect(await runCoreTool(late.r, f.rt)).toMatchObject({ ok: true });
    expect(late.progress.map((p) => p[2])).toEqual([true, false]);
  });

  it('a capture being framed, a study switch or an app dialog holds it too; once it ends, it goes on', async () => {
    const f = fakeRuntime();
    f.state.busy = 'dialog';
    let polls = 0;
    const sleep = f.rt.sleep;
    f.rt.sleep = async (ms, signal) => {
      polls += 1;
      if (polls === 3) f.state.busy = '';
      return sleep(ms, signal);
    };
    const out = await runCoreTool(view('edges', { on: true }).r, f.rt);
    expect(out.ok).toBe(true);
    expect(f.calls).toContain('edges true');
    expect(VIEW_WAIT_MS).toBe(10_000);
  });

  it('a picture never moves the camera, so it is taken while the person uses the Filters panel', async () => {
    const f = fakeRuntime();
    f.state.filters = true;
    const { r, progress } = view('picture', { size: 'medium', aspect: '16:9', with_legend: false });
    const out = await runCoreTool(r, f.rt);
    expect(out.ok).toBe(true);
    expect(progress).toEqual([]);
    expect(f.calls).toEqual(['picture 16:9 1024 false']);
  });
});

describe('core__show', () => {
  it('another project: opened as Home opens it, then waits for its ready mark; this one, already shown: nothing to do', async () => {
    const f = fakeRuntime();
    const out = await runCoreTool(show('project', { project_id: 'p2' }).r, f.rt);
    expect(f.calls).toEqual(['open p2']);
    expect(out).toMatchObject({ ok: true, result: { data: { shown: { place: 'workbench', project_id: 'p2' }, hint: "From your next step the tools are the workbench's." } } });
    f.calls.length = 0;
    expect((await runCoreTool(show('project').r, f.rt)).ok).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('Back from a workspace of this project goes through the leave guard (and reports the link job it started); the person staying is cancelled_by_person', async () => {
    const f = fakeRuntime();
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: { projectId: 'p1', plugin: 'cad', workspace: 'part', studyId: 'ps-1' } };
    f.state.job = 'gl-42';
    const out = await runCoreTool(show('project').r, f.rt);
    expect(f.calls).toEqual(['leave #/p/p1']);
    expect(out).toMatchObject({ ok: true, result: { data: { job: 'link.gl-42' } } });
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: { projectId: 'p1', plugin: 'cad', workspace: 'part', studyId: 'ps-1' } };
    vi.mocked(f.rt.leaveWorkspaceTo).mockResolvedValueOnce(false);
    expect(await runCoreTool(show('project').r, f.rt)).toMatchObject({ ok: false, code: 'cancelled_by_person' });
  });

  it('a leave that asks the person says the call waits for them meanwhile', async () => {
    const f = fakeRuntime({ leaveAsks: () => true });
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: { projectId: 'p1', plugin: 'cad', workspace: 'part', studyId: 'ps-1' } };
    const { r, progress } = show('home');
    expect((await runCoreTool(r, f.rt)).ok).toBe(true);
    expect(progress[0]).toEqual([null, 'Going Home (it may ask you first)', true]);
    expect(progress.at(-1)).toEqual([null, '', false]);
  });

  it('a geometry, study, mesh, run, results or panel: the workbench functions, by id; an unknown id is not_found; Home is no_project', async () => {
    const f = fakeRuntime();
    expect(await runCoreTool(show('study', { id: 's9' }).r, f.rt)).toMatchObject({ code: 'not_found', hint: "read_setup {what:'study'} lists them." });
    for (const [target, id] of [
      ['geometry', 'g1'],
      ['study', 's2'],
      ['mesh', 'm1'],
      ['run', 'r1'],
      ['results', 'r1'],
    ]) {
      expect((await runCoreTool(show(target, { id }).r, f.rt)).ok).toBe(true);
    }
    expect((await runCoreTool(show('panel', { panel: 'bcs' }).r, f.rt)).ok).toBe(true);
    expect(f.calls).toEqual(['geometry g1', 'study s2', 'mesh m1', 'run r1', 'results r1', 'panel bcs']);
    f.state.route = { view: 'home', projectId: null, workspace: null };
    expect(await runCoreTool(show('mesh', { id: 'm1' }).r, f.rt)).toMatchObject({ code: 'no_project' });
  });

  it("a plugin study's workspace: its route from the study's row, then its tools (or none) within 20 s", async () => {
    const f = fakeRuntime();
    f.state.tools = { scope: { project_id: 'p1', plugin: 'cad', workspace: 'part', study_id: 'ps-1' }, settled: true, taken: true, dead: false, tools: [{ name: 'sketch' }] } as unknown as PublishedTools;
    const out = await runCoreTool(show('workspace', { id: 'ps-1' }).r, f.rt);
    expect(f.calls).toEqual(['hash #/p/p1/ws/cad/part/ps-1']);
    expect(out).toMatchObject({ ok: true, result: { data: { workspace_tools: 'offered' } } });
    expect(await runCoreTool(show('workspace', { id: 'nope' }).r, f.rt)).toMatchObject({ code: 'not_found' });
  });
});

describe('core__view', () => {
  it('Home has no viewer: a picture is a drawing of the window (its size asked, said to be a drawing, never saved); a move is not_ready', async () => {
    const f = fakeRuntime();
    f.state.route = { view: 'home', projectId: null, workspace: null };
    const out = await runCoreTool(view('picture', { aspect: '16:9', size: 'medium', save: true }).r, f.rt);
    expect(f.rt.pagePicture).toHaveBeenCalledWith({ aspect: '16:9', width: 1024 });
    expect(out).toMatchObject({
      ok: true,
      result: {
        data: { picture: { width: 1024, height: 576, aspect: '16:9' }, shown: { place: 'home' }, drawn: HOME_PICTURE_NOTE, saved: false },
        images: [{ mediaType: 'image/png', data: 'iVBORw==' }],
      },
    });
    expect(HOME_PICTURE_NOTE).toMatch(/not a screenshot/);
    expect(await runCoreTool(view('fit').r, f.rt)).toMatchObject({ ok: false, code: 'not_ready' });
    // A window that can't be drawn says so.
    (f.rt.pagePicture as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await runCoreTool(view('picture').r, f.rt)).toMatchObject({ ok: false, code: 'failed', message: 'Home could not be drawn.' });
  });

  it('a picture answers the image (base64) and its size; save puts it in the Screenshots of what is shown', async () => {
    const f = fakeRuntime();
    const out = await runCoreTool(view('picture', { size: 'large', save: true }).r, f.rt);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.images).toEqual([{ mediaType: 'image/png', data: btoa(String.fromCharCode(137, 80, 78, 71)) }]);
    expect(out.result.data).toMatchObject({ picture: { width: 640, height: 400 }, saved: true, gallery_item: 'img-1' });
    expect(f.calls).toEqual(['picture view 1600 true', 'save']);
  });

  it('every move answers a small picture of what it did; faces and bodies by their ids; an id none of which is known is not_found', async () => {
    const f = fakeRuntime();
    const hid = await runCoreTool(view('hide', { target_ids: ['face 3@Body1', 'Body2', 'wing'] }).r, f.rt);
    expect(hid).toMatchObject({ ok: true, result: { data: { done: 'Hid 1 face and 1 body', unknown: ['wing'] }, summary: 'Hid 1 face and 1 body' } });
    if (hid.ok) expect(hid.result.images).toHaveLength(1);
    expect(await runCoreTool(view('show', { target_ids: ['wing'] }).r, f.rt)).toMatchObject({ code: 'not_found' });
    expect(await runCoreTool(view('normal_to', { target_ids: ['face 9@Body1'] }).r, f.rt)).toMatchObject({ code: 'not_found' });
    expect(await runCoreTool(view('normal_to').r, f.rt)).toMatchObject({ code: 'invalid_input' });
    for (const a of ['fit', 'show_all']) expect((await runCoreTool(view(a).r, f.rt)).ok).toBe(true);
    expect((await runCoreTool(view('legend', { on: true }).r, f.rt)).ok).toBe(true);
    expect(f.calls.filter((c) => !c.startsWith('picture'))).toEqual(['hide face 3@Body1,Body2,wing', 'show wing', 'normal face 9@Body1', 'fit', 'show all', 'legend true']);
    expect(f.calls.filter((c) => c.startsWith('picture'))).toEqual(Array(4).fill('picture view 640 true'));
  });

  it('a workspace covers the viewer: its own view tool', async () => {
    const f = fakeRuntime();
    f.state.route = { view: 'workbench', projectId: 'p1', workspace: { projectId: 'p1', plugin: 'cad', workspace: 'part', studyId: 'ps-1' } };
    expect(await runCoreTool(view('picture').r, f.rt)).toMatchObject({ ok: false, code: 'not_ready' });
  });
});
