// gate:l3-guard (host API 1.6, LINK proposal 6.3 and 6.4): the exit hook through the leave
// guard's one gate. The page's hook here is a fake with the bridge's shape (probe, run with
// its activity, the geometry's name); the bridge's own side is in bridge.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaveActivity, LeaveHookOutcome } from './bridge';
import {
  LEAVE_APPROVAL_MS,
  LEAVE_BACKGROUND_MS,
  LEAVE_NAME_MS,
  LEAVE_PROGRESS_MS,
  LEAVE_STALL_MS,
  cancelLeave,
  confirmLeaveWorkspace,
  continueLeaveInBackground,
  installWorkspaceLeaveGuard,
  lastLeaveInBackground,
  lastLeaveReason,
  leaveApproved,
  leaveInProgress,
  leaveNeedsWork,
  leaveWorkspaceTo,
  registerOpenWorkspace,
  setWorkspaceDirty,
  subscribeLeaveProgress,
  type GuardedWorkspace,
  type LeaveProgress,
  type LeaveReason,
} from './leaveGuard';

const ROUTE = { projectId: 'proj', plugin: 'link-demo', workspace: 'demo', studyId: 'st-1' };
const BASE = 'http://localhost:3000/';
const WS_URL = `${BASE}#/p/proj/ws/link-demo/demo/st-1`;
const PROJECT_URL = `${BASE}#/p/proj`;

interface FakeHook {
  on: boolean;
  alive: boolean;
  order: string[];
  runs: Array<{ reason: LeaveReason; interactive: boolean }>;
  activity: (a: LeaveActivity) => void;
  signal: AbortSignal | null;
  finish: (o: LeaveHookOutcome) => void;
  ws: GuardedWorkspace;
}

let hook: FakeHook;
let unregister: () => void = () => undefined;
let confirm: ReturnType<typeof vi.fn>;
let answers: boolean[] = [];
let progress: LeaveProgress[] = [];
let stopProgress: () => void = () => undefined;
let dialogOpen = false;

function makeHook(): FakeHook {
  const frame = document.getElementById('workspace-frame') as HTMLIFrameElement;
  const h: FakeHook = {
    on: true,
    alive: true,
    order: [],
    runs: [],
    activity: () => undefined,
    signal: null,
    finish: () => undefined,
    ws: null as unknown as GuardedWorkspace,
  };
  h.ws = {
    route: ROUTE,
    pluginName: () => 'Link demo',
    studyTitle: () => 'Demo 1',
    frame: () => frame,
    hook: {
      on: () => h.on,
      probe: async () => {
        h.order.push('probe');
        return h.alive;
      },
      run: (reason, o) => {
        h.order.push(`hook:${reason}`);
        h.runs.push({ reason, interactive: o.interactive });
        h.activity = o.activity;
        h.signal = o.signal;
        return new Promise<LeaveHookOutcome>((resolve) => (h.finish = resolve));
      },
      geometryName: async () => 'Demo 1',
    },
  };
  return h;
}

/** Let promise chains and the guard's clocks move by `ms` (fake timers). */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const lastProgress = () => progress[progress.length - 1];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  installWorkspaceLeaveGuard();
  document.body.innerHTML =
    '<div class="ws-shell"><header data-workspace-header="1"><button id="ws-back">Back</button></header>' +
    '<iframe id="workspace-frame"></iframe></div>';
  answers = [];
  dialogOpen = false;
  confirm = vi.fn(async (q: { title: string }) => {
    hook.order.push(`ask:${q.title}`);
    return answers.length ? (answers.shift() as boolean) : false;
  });
  window.__CFD_CONFIRM__ = confirm as unknown as typeof window.__CFD_CONFIRM__;
  window.__CFD_DIALOG_BUSY__ = () => dialogOpen;
  hook = makeHook();
  unregister = registerOpenWorkspace(hook.ws);
  progress = [];
  stopProgress = subscribeLeaveProgress((p) => progress.push(p));
});

afterEach(async () => {
  // A leave a test left running ends (the guard's clocks with it).
  cancelLeave();
  await tick(0);
  stopProgress();
  unregister();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.__CFD_CONFIRM__;
  delete window.__CFD_DIALOG_BUSY__;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe('gate:l3-guard the order of a leave with an exit hook', () => {
  it('leaves full screen, probes, runs the hook, asks about unsaved work only if the page is still dirty, then approves', async () => {
    let full: Element | null = document.getElementById('workspace-frame');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
    document.exitFullscreen = vi.fn(async () => {
      hook.order.push('fullscreen');
      full = null;
    });
    setWorkspaceDirty(true, 'Design v2 is not saved');
    answers = [true];
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    expect(hook.order).toEqual(['fullscreen', 'probe', 'hook:back']);
    expect(leaveInProgress()).toBe(true);
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    expect(hook.order).toEqual(['fullscreen', 'probe', 'hook:back', 'ask:Leave without saving?']);
    expect(leaveApproved()).toBe(true);
    expect(lastLeaveReason(hook.ws)).toBe('back');
  });

  it('a hook that saved (the page is clean) leaves with no question', async () => {
    setWorkspaceDirty(true, 'Design v2 is not saved');
    const p = confirmLeaveWorkspace('frame-back');
    await tick(0);
    setWorkspaceDirty(false);
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(leaveApproved()).toBe(true);
  });

  it('a clean page with a hook needs work before it may go; without a hook (or off) it goes at once', async () => {
    expect(leaveNeedsWork()).toBe(true);
    hook.on = false;
    expect(leaveNeedsWork()).toBe(false);
    expect(await confirmLeaveWorkspace('back')).toBe(true);
    expect(hook.runs).toEqual([]);
    expect(leaveApproved()).toBe(false);
  });

  it('the 10 s approval window starts after the hook, however long the hook took', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    // A long export, with progress every 10 s (no stall).
    for (let i = 0; i < 6; i++) {
      hook.activity({ kind: 'progress', fraction: i / 6, label: 'Exporting' });
      await tick(10_000);
    }
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    await tick(LEAVE_APPROVAL_MS - 100);
    expect(leaveApproved()).toBe(true);
    await tick(200);
    expect(leaveApproved()).toBe(false);
  });

  it('runs for every way out the host owns with its reason; turning the plugin off runs no hook (D11)', async () => {
    for (const reason of ['back', 'frame-back', 'history', 'project', 'home', 'results'] as LeaveReason[]) {
      const p = confirmLeaveWorkspace(reason);
      await tick(0);
      hook.finish({ ok: true });
      expect(await p).toBe(true);
      unregister();
      unregister = registerOpenWorkspace(hook.ws);
    }
    expect(hook.runs.map((r) => r.reason)).toEqual(['back', 'frame-back', 'history', 'project', 'home', 'results']);
    // plugin-off: no hook; a clean page goes at once, a dirty one gets today's question only.
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(true);
    setWorkspaceDirty(true, 'Design v2 is not saved');
    answers = [false];
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Turn off Link demo?' });
    expect(hook.runs).toHaveLength(6);
  });

  it('a page that does not answer the probe runs no hook: the geometry keeps its last update', async () => {
    hook.alive = false;
    expect(await confirmLeaveWorkspace('back')).toBe(true);
    expect(hook.order).toEqual(['probe']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Back via leaveWorkspaceTo goes to the project once the hook is done', async () => {
    location.hash = '#/p/proj/ws/link-demo/demo/st-1';
    const p = leaveWorkspaceTo('#/p/proj', 'back');
    await tick(0);
    expect(location.hash).toBe('#/p/proj/ws/link-demo/demo/st-1');
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    expect(location.hash).toBe('#/p/proj');
  });
});

describe('gate:l3-guard re-entry: one leave at a time', () => {
  it('a second Back, Home, a project or nav.back during a leave answers false; the hash guard puts the address back', async () => {
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    const first = confirmLeaveWorkspace('back');
    await tick(0);
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    expect(await confirmLeaveWorkspace('home')).toBe(false);
    expect(await confirmLeaveWorkspace('frame-back')).toBe(false);
    expect(await confirmLeaveWorkspace('project', { interactive: false })).toBe(false);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: WS_URL, newURL: PROJECT_URL }));
    expect(push).toHaveBeenCalledWith(history.state, '', WS_URL);
    await tick(0);
    expect(hook.runs).toHaveLength(1);
    hook.finish({ ok: true });
    expect(await first).toBe(true);
  });
});

describe('gate:l3-guard progress, Cancel and "Continue in background"', () => {
  it('draws nothing for a quick hook; after 400 ms the status line shows the page label, then the stages', async () => {
    const quick = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS - 100);
    hook.finish({ ok: true });
    expect(await quick).toBe(true);
    expect(progress.some((p) => p.shown)).toBe(false);
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    progress = [];
    const slow = confirmLeaveWorkspace('back');
    await tick(0);
    expect(lastProgress()).toMatchObject({ running: true, shown: false });
    await tick(LEAVE_PROGRESS_MS + 300);
    expect(lastProgress()).toMatchObject({ running: true, shown: true, label: 'Updating the project from Demo 1…', choosing: false, background: false });
    hook.activity({ kind: 'progress', fraction: 0.2, label: 'Exporting the design' });
    expect(lastProgress().label).toBe('Exporting the design');
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: true });
    hook.activity({ kind: 'link', stage: 'queued', ahead: 2, label: '' });
    expect(lastProgress().label).toBe('Queued behind 2 jobs (see Queue)');
    hook.activity({ kind: 'link', stage: 'waiting', ahead: null, label: 'Waiting for another program to release Demo 1’s files' });
    expect(lastProgress().label).toBe('Waiting for another program to release Demo 1’s files');
    hook.finish({ ok: true });
    expect(await slow).toBe(true);
    expect(lastProgress()).toMatchObject({ running: false, shown: false });
  });

  it('a create waiting for its study says so (no queue place)', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: true, queued: false });
    hook.activity({ kind: 'link', stage: 'queued', ahead: 0, label: '' });
    expect(lastProgress().label).toBe('Waiting for the last update of Demo 1 to finish');
    hook.finish({ ok: true });
    await p;
  });

  it('Cancel aborts the hook and stays, with no question', async () => {
    setWorkspaceDirty(true, 'Design v2 is not saved');
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    cancelLeave();
    expect(await p).toBe(false);
    expect(hook.signal?.aborted).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(leaveApproved()).toBe(false);
  });

  it('"Continue in background" is not offered before the job exists; 5 s after it, or at once when queued; it leaves', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    // Uploading (a call in flight): no job yet.
    hook.activity({ kind: 'calls', inFlight: 1 });
    await tick(20_000);
    expect(lastProgress().background).toBe(false);
    continueLeaveInBackground();
    await tick(0);
    expect(leaveInProgress()).toBe(true);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    await tick(LEAVE_BACKGROUND_MS - 500);
    expect(lastProgress().background).toBe(false);
    await tick(1000);
    expect(lastProgress().background).toBe(true);
    continueLeaveInBackground();
    expect(await p).toBe(true);
    expect(leaveApproved()).toBe(true);
    // The hook was not aborted: the job goes on.
    expect(hook.signal?.aborted).toBe(false);
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    const q = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0d', create: false, queued: true });
    await tick(300);
    expect(lastProgress().background).toBe(true);
    continueLeaveInBackground();
    expect(await q).toBe(true);
  });
});

describe("gate:l3-guard the host's question inside a leave", () => {
  it('"Waiting for your choice", Cancel hidden, never "Continue in background", and no stall while it is open', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'calls', inFlight: 0 });
    hook.activity({ kind: 'choosing', open: true });
    expect(lastProgress()).toMatchObject({ label: 'Waiting for your choice', choosing: true, background: false });
    // The dialog is an app dialog too; even without it the open question pauses the clock.
    await tick(LEAVE_STALL_MS * 3);
    expect(leaveInProgress()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    hook.activity({ kind: 'choosing', open: false });
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: true, queued: false });
    hook.finish({ ok: true });
    expect(await p).toBe(true);
  });

  it('"Keep editing" aborts the leave signal and the guard answers false at once, with no safe question', async () => {
    setWorkspaceDirty(true, 'Design v2 is not saved');
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    hook.activity({ kind: 'choosing', open: true });
    hook.activity({ kind: 'choosing', open: false });
    hook.activity({ kind: 'kept' });
    expect(await p).toBe(false);
    expect(hook.signal?.aborted).toBe(true);
    // Whatever the handler then returns is ignored.
    hook.finish({ ok: false, message: 'cancelled' });
    await tick(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(leaveApproved()).toBe(false);
    expect(leaveInProgress()).toBe(false);
  });
});

describe('gate:l3-guard the stall timer', () => {
  it('30 s with no progress and no call in flight: the hook is aborted and one safe question asks', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_STALL_MS - 1000);
    expect(confirm).not.toHaveBeenCalled();
    await tick(1500);
    expect(hook.signal?.aborted).toBe(true);
    await tick(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: "Couldn't update the project",
      copy: 'Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.',
      yes: 'Leave anyway',
      no: 'Stay',
      safe: true,
    });
    expect(await p).toBe(false);
  });

  it('progress, a call in flight, a queued job and an open app dialog each hold it off', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(20_000);
    hook.activity({ kind: 'progress', fraction: null, label: 'Exporting' });
    await tick(20_000);
    hook.activity({ kind: 'calls', inFlight: 1 });
    await tick(LEAVE_STALL_MS * 2);
    hook.activity({ kind: 'calls', inFlight: 0 });
    await tick(20_000);
    hook.activity({ kind: 'link', stage: 'queued', ahead: 1, label: '' });
    await tick(LEAVE_STALL_MS * 2);
    hook.activity({ kind: 'link', stage: 'reading', ahead: null, label: '' });
    await tick(20_000);
    dialogOpen = true;
    await tick(LEAVE_STALL_MS * 2);
    dialogOpen = false;
    await tick(20_000);
    expect(confirm).not.toHaveBeenCalled();
    expect(hook.signal?.aborted).toBe(false);
    await tick(15_000);
    expect(hook.signal?.aborted).toBe(true);
    await p;
  });
});

describe('gate:l3-guard a hook that fails: one question', () => {
  it('a throw, ok:false or a refused link: "Couldn\'t update the project"; Stay stays, Leave anyway goes', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    hook.finish({ ok: false, message: 'The export failed' });
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: The export failed. Demo 1 keeps its last update.');
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    answers = [true];
    const q = confirmLeaveWorkspace('back');
    await tick(0);
    hook.finish({ ok: false, message: 'Save the design before linking it: the page has unsaved work.' });
    expect(await q).toBe(true);
    expect(leaveApproved()).toBe(true);
  });

  it('merges the unsaved-work question into it: one question when the page is still dirty', async () => {
    setWorkspaceDirty(true, 'Design v2 is not saved');
    answers = [true];
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    hook.finish({ ok: false, message: 'Save the design before linking it: the page has unsaved work.' });
    expect(await p).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].copy).toBe(
      'Link demo: Save the design before linking it: the page has unsaved work. Demo 1 keeps its last update. Its changes are not saved. Leaving discards them.',
    );
  });
});

describe('gate:l3-guard a caller that cannot ask (askToLeave:false)', () => {
  it('runs the hook non-interactively and goes on once the server has the link, never waiting for the job', async () => {
    const p = confirmLeaveWorkspace('project', { interactive: false });
    await tick(0);
    expect(hook.runs).toEqual([{ reason: 'project', interactive: false }]);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: true });
    expect(await p).toBe(true);
    expect(leaveApproved()).toBe(true);
    expect(hook.signal?.aborted).toBe(false);
  });

  it('a hook with nothing to link that ends clean goes; one that fails, or leaves the page dirty, stays with no question', async () => {
    let p = confirmLeaveWorkspace('project', { interactive: false });
    await tick(0);
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    p = confirmLeaveWorkspace('project', { interactive: false });
    await tick(0);
    hook.finish({ ok: false, message: 'The export failed' });
    expect(await p).toBe(false);
    setWorkspaceDirty(true, 'Design v2 is not saved');
    p = confirmLeaveWorkspace('project', { interactive: false });
    await tick(0);
    hook.finish({ ok: true });
    expect(await p).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('gate:l3-guard review fixes: what the leave says and offers', () => {
  it('a caller that cannot ask stays when the server took the link but the page is still dirty: no question, no approval', async () => {
    setWorkspaceDirty(true, 'Design v2 is not saved');
    const p = confirmLeaveWorkspace('project', { interactive: false });
    await tick(0);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: true });
    expect(await p).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(leaveApproved()).toBe(false);
  });

  it("the status line names the link job's stages", async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    const words: string[] = [];
    for (const stage of ['reading', 'meshing', 'naming', 'matching', 'saving', 'finishing']) {
      hook.activity({ kind: 'link', stage, ahead: null, label: '' });
      words.push(lastProgress().label);
    }
    expect(words).toEqual(['Reading the design', 'Building the part', 'Naming the faces', 'Matching faces', 'Saving the project', 'Finishing']);
    hook.finish({ ok: true });
    await p;
  });

  it('once the link job exists the header\'s Cancel only keeps the workspace: "started" (Stay here)', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    expect(lastProgress().started).toBe(false);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: true });
    expect(lastProgress()).toMatchObject({ started: true, label: 'Queued (see Queue)' });
    cancelLeave();
    expect(await p).toBe(false);
    expect(lastProgress()).toMatchObject({ running: false, started: false });
  });

  it('a stall after the server took the link: "The update of Demo 1 goes on."', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(1000);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    hook.activity({ kind: 'link', stage: 'reading', ahead: null, label: '' });
    await tick(LEAVE_STALL_MS + 1000);
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: it did not answer for 30 seconds. The update of Demo 1 goes on.');
  });

  it('a stall after the link went through: "Demo 1 was updated."; on Stay the workspace hears it stays', async () => {
    const stayed = vi.fn();
    hook.ws.stayed = stayed;
    const p = confirmLeaveWorkspace('back');
    await tick(1000);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    hook.activity({ kind: 'linked', ok: true, change: 'shape' });
    await tick(LEAVE_STALL_MS + 1000);
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: it did not answer for 30 seconds. Demo 1 was updated.');
    expect(stayed).toHaveBeenCalledTimes(1);
    // A link that changed nothing, or was refused: the geometry keeps its last update.
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    const q = confirmLeaveWorkspace('back');
    await tick(0);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    hook.activity({ kind: 'linked', ok: false, change: '' });
    hook.finish({ ok: false, message: 'The link was refused' });
    expect(await q).toBe(false);
    expect(confirm.mock.calls[1][0].copy).toBe('Link demo: The link was refused. Demo 1 keeps its last update.');
    // Leave anyway: the workspace goes, it does not hear "stayed".
    stayed.mockClear();
    answers = [true];
    const r = confirmLeaveWorkspace('back');
    await tick(0);
    hook.finish({ ok: false, message: 'The export failed' });
    expect(await r).toBe(true);
    expect(stayed).not.toHaveBeenCalled();
  });

  it('a page that went away after the server took its link: the question says the update goes on', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(0);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: true });
    hook.finish({ ok: false, message: 'its page closed before it finished' });
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: its page closed before it finished. The update of Demo 1 goes on.');
  });

  it("a slow app does not hold up the failed hook's question: Cancel goes at once, the last name known after 1.5 s", async () => {
    hook.ws.hook = { ...hook.ws.hook!, geometryName: () => new Promise<string>(() => undefined), lastGeometryName: () => 'Demo 1' };
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.finish({ ok: false, message: 'The export failed' });
    await tick(0);
    // Nothing to cancel any more: the header offers no Cancel while the question comes.
    expect(lastProgress()).toMatchObject({ running: true, choosing: true, background: false });
    expect(confirm).not.toHaveBeenCalled();
    await tick(LEAVE_NAME_MS + 100);
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: The export failed. Demo 1 keeps its last update.');
  });
});

// Exit-sync fixes (the CAD review of 2026-10-04).
describe('exit-sync fixes: what the leave says', () => {
  it('a stall while a save of the page is still on its way names the save, not the plugin', async () => {
    hook.ws.hook = { ...hook.ws.hook!, stallCause: async () => ({ answers: true, saving: true }) };
    setWorkspaceDirty(true, 'Design v2 is not saved');
    const p = confirmLeaveWorkspace('back');
    hook.activity({ kind: 'progress', fraction: 0.1, label: 'Saving Demo 1' });
    await tick(LEAVE_STALL_MS + 1000);
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: "Couldn't update the project",
      copy: 'The save of Demo 1 did not finish in 30 seconds. Demo 1 keeps its last update. Its changes are not saved. Leaving discards them.',
    });
  });

  it('a stall of a page that no longer answers says so; one that answers with nothing of the app on its way is the plugin\'s', async () => {
    hook.ws.hook = { ...hook.ws.hook!, stallCause: async () => ({ answers: false, saving: false }) };
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_STALL_MS + 1000);
    expect(await p).toBe(false);
    expect(confirm.mock.calls[0][0].copy).toBe('Link demo: its page did not answer for 30 seconds. Demo 1 keeps its last update.');
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    hook.ws.hook = { ...hook.ws.hook!, stallCause: async () => ({ answers: true, saving: false }) };
    const q = confirmLeaveWorkspace('back');
    await tick(LEAVE_STALL_MS + 1000);
    expect(await q).toBe(false);
    expect(confirm.mock.calls[1][0].copy).toBe('Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.');
  });

  it('a job that starts at once never shows "Queued" (nor "Continue in background" at once); one that waits does', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'progress', fraction: 0.5, label: 'Writing Demo 1 for the project' });
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    hook.activity({ kind: 'link', stage: 'queued', ahead: 0, label: '', waiting: false });
    await tick(300);
    expect(progress.some((x) => /Queued/.test(x.label))).toBe(false);
    expect(lastProgress()).toMatchObject({ label: 'Writing Demo 1 for the project', background: false });
    hook.activity({ kind: 'link', stage: 'meshing', ahead: null, label: '' });
    expect(lastProgress().label).toBe('Building the part');
    hook.finish({ ok: true });
    expect(await p).toBe(true);
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    progress = [];
    const q = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0d', create: false, queued: false });
    hook.activity({ kind: 'link', stage: 'queued', ahead: 0, label: '', waiting: true });
    await tick(300);
    expect(lastProgress()).toMatchObject({ label: 'Queued (see Queue)', background: true });
    hook.finish({ ok: true });
    await q;
  });

  it('Finishing says what it still waits for when the server tells (on a large part the centre of mass takes many seconds)', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    hook.activity({ kind: 'link', stage: 'finishing', ahead: null, label: '' });
    expect(lastProgress().label).toBe('Finishing');
    hook.activity({ kind: 'link', stage: 'finishing', ahead: null, label: 'Finishing: the centre of mass, the thumbnail and the project file' });
    expect(lastProgress().label).toBe('Finishing: the centre of mass, the thumbnail and the project file');
    hook.activity({ kind: 'link', stage: 'finishing', ahead: null, label: 'Finishing: the centre of mass (2 of 3 done)' });
    expect(lastProgress().label).toBe('Finishing: the centre of mass (2 of 3 done)');
    hook.finish({ ok: true });
    await p;
  });

  it('the landing hears whether the leave went on while the job ran ("Continue in background")', async () => {
    const p = confirmLeaveWorkspace('back');
    await tick(LEAVE_PROGRESS_MS + 300);
    hook.activity({ kind: 'accepted', jobId: 'gl-abcdef12-0a0b0c', create: false, queued: false });
    await tick(LEAVE_BACKGROUND_MS + 300);
    continueLeaveInBackground();
    expect(await p).toBe(true);
    expect([lastLeaveReason(hook.ws), lastLeaveInBackground(hook.ws)]).toEqual(['back', true]);
    unregister();
    unregister = registerOpenWorkspace(hook.ws);
    const q = confirmLeaveWorkspace('back');
    await tick(0);
    hook.finish({ ok: true });
    expect(await q).toBe(true);
    expect([lastLeaveReason(hook.ws), lastLeaveInBackground(hook.ws)]).toEqual(['back', false]);
  });
});
