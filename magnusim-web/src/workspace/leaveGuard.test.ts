import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVE_APPROVAL_MS,
  confirmLeaveWorkspace,
  exitFrameFullscreen,
  installWorkspaceLeaveGuard,
  leaveApproved,
  leaveWorkspaceTo,
  openWorkspaceRoute,
  registerOpenWorkspace,
  setWorkspaceDirty,
  subscribeWorkspaceDirty,
  withdrawLeaveApproval,
  workspaceDirty,
  type GuardedWorkspace,
} from './leaveGuard';

const ROUTE = { projectId: 'proj', plugin: 'ws-demo', workspace: 'bench', studyId: 'st-1' };
const BASE = 'http://localhost:3000/';
const WS_URL = `${BASE}#/p/proj/ws/ws-demo/bench/st-1`;
const PROJECT_URL = `${BASE}#/p/x`;
const LEAVE = 'Leave without saving?';

let frame: HTMLIFrameElement;
let workspace: GuardedWorkspace;
let unregister: () => void = () => undefined;
let answer = false;
let confirm: ReturnType<typeof vi.fn>;
let listeners: Array<(e: Event) => void> = [];

/** A hashchange listener added after the guard (as the router and the home controller are). */
function later(): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  listeners.push(fn);
  window.addEventListener('hashchange', fn);
  return fn;
}

function hashChange(oldURL: string, newURL: string): void {
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * The question as the app's dialog gets it (with the signal that closes it along with the
 * workspace). safe: Enter keeps the work, only a click on Yes discards it.
 */
const asked = (q: { title: string; copy: string; yes: string; no: string; safe: boolean }) => ({ ...q, signal: expect.any(AbortSignal) });

/** Closing the tab now: whether the browser would ask first (a beforeunload listener cancelled it). */
function unloadAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Go to `hash` in this document and wait for its hashchange. */
async function goTo(hash: string): Promise<void> {
  if (location.hash === hash) return;
  const moved = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
  location.hash = hash;
  await moved;
}

beforeEach(() => {
  installWorkspaceLeaveGuard();
  document.body.innerHTML =
    '<div class="ws-shell"><header data-workspace-header="1"><button id="ws-back">Back</button></header>' +
    '<iframe id="workspace-frame"></iframe></div>';
  frame = document.getElementById('workspace-frame') as HTMLIFrameElement;
  answer = false;
  confirm = vi.fn(async () => answer);
  window.__CFD_CONFIRM__ = confirm as unknown as typeof window.__CFD_CONFIRM__;
  window.__CFD_DIALOG_BUSY__ = undefined;
  workspace = { route: ROUTE, pluginName: () => 'Workspace demo', studyTitle: () => 'Wing section', frame: () => frame };
  unregister = registerOpenWorkspace(workspace);
});

afterEach(() => {
  unregister();
  for (const fn of listeners) window.removeEventListener('hashchange', fn);
  listeners = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.__CFD_CONFIRM__;
  delete window.__CFD_DIALOG_BUSY__;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe('browser Back, Forward and typed links away from a dirty workspace', () => {
  it('are held by the guard (installed first): nothing else hears of them, the address goes back, and the app asks', async () => {
    const after = later();
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    setWorkspaceDirty(true, 'Chord not saved');

    hashChange(WS_URL, PROJECT_URL);
    expect(after).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(history.state, '', WS_URL);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      asked({ title: LEAVE, copy: 'Workspace demo: Chord not saved Leaving discards them.', yes: 'Leave', no: 'Stay', safe: true }),
    );
    // Stay: nothing more.
    expect(back).not.toHaveBeenCalled();
    expect(workspaceDirty()).toBe(true);

    // Leave: back to the entry the user was going to, and that change gets through.
    answer = true;
    hashChange(WS_URL, PROJECT_URL);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(back).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    hashChange(WS_URL, PROJECT_URL);
    expect(after).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('pass without a question when nothing would be lost or the workspace is not left', () => {
    const after = later();
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    // Clean.
    hashChange(WS_URL, PROJECT_URL);
    setWorkspaceDirty(true, 'Chord not saved');
    // From another workspace (not the open one).
    hashChange(`${BASE}#/p/proj/ws/ws-demo/bench/st-2`, PROJECT_URL);
    // From somewhere that is no workspace at all.
    hashChange(`${BASE}#/p/proj`, PROJECT_URL);
    // To the same workspace spelled another way (%2D for "-").
    hashChange(WS_URL, `${BASE}#/p/proj/ws/ws%2Ddemo/bench/st-1`);
    // Nothing open.
    unregister();
    hashChange(WS_URL, PROJECT_URL);
    expect(after).toHaveBeenCalledTimes(5);
    expect(push).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('are held when they go to another workspace or plugin of the same study; one from there passes', async () => {
    const after = later();
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    vi.spyOn(history, 'back').mockImplementation(() => undefined);
    setWorkspaceDirty(true, 'Chord not saved');
    // Another workspace of its plugin, and another plugin's workspace, for the same study.
    const others = [`${BASE}#/p/proj/ws/ws-demo/silent/st-1`, `${BASE}#/p/proj/ws/other-plugin/bench/st-1`];
    for (const elsewhere of others) {
      hashChange(WS_URL, elsewhere);
      await settle();
      hashChange(elsewhere, PROJECT_URL);
    }
    expect(push).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(after.mock.calls.map(([e]) => (e as HashChangeEvent).oldURL)).toEqual(others);
  });

  it('while a question is open, a second one is refused without a dialog and its address restored', async () => {
    const after = later();
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    let reply: (ok: boolean) => void = () => undefined;
    confirm.mockImplementation(() => new Promise<boolean>((r) => (reply = r)));
    setWorkspaceDirty(true, 'Chord not saved');
    hashChange(WS_URL, PROJECT_URL);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    hashChange(WS_URL, `${BASE}#/p/other`);
    expect(push).toHaveBeenCalledTimes(2);
    expect(after).not.toHaveBeenCalled();
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    reply(false);
    await settle();
    expect(back).not.toHaveBeenCalled();
  });

  it('Leave on a question whose workspace closed meanwhile does not go back again', async () => {
    vi.spyOn(history, 'pushState').mockImplementation(() => undefined);
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    let reply: (ok: boolean) => void = () => undefined;
    confirm.mockImplementation(() => new Promise<boolean>((r) => (reply = r)));
    setWorkspaceDirty(true, 'Chord not saved');
    hashChange(WS_URL, PROJECT_URL);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    // The page saves while the question is open; the user's next Back passes and the workspace closes.
    setWorkspaceDirty(false);
    hashChange(WS_URL, PROJECT_URL);
    unregister();
    reply(true);
    await settle();
    expect(back).not.toHaveBeenCalled();
  });
});

describe('the leave question', () => {
  it('is not asked when nothing would be lost, and refused without a dialog when it must not ask', async () => {
    expect(await confirmLeaveWorkspace('home')).toBe(true);
    setWorkspaceDirty(true, 'Chord not saved');
    expect(await confirmLeaveWorkspace('project', { interactive: false })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    await confirmLeaveWorkspace('home');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('is still asked while another app dialog is open or just closing (it waits its turn in their queue)', async () => {
    // A Home click right after Cancel on the last question once did nothing at all.
    setWorkspaceDirty(true, 'Chord not saved');
    window.__CFD_DIALOG_BUSY__ = () => true;
    answer = true;
    expect(await confirmLeaveWorkspace('home')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('names the plugin and the page message, or the study when there is none; Enter keeps the work (Stay, Cancel)', async () => {
    setWorkspaceDirty(true, '');
    await confirmLeaveWorkspace('back');
    expect(confirm).toHaveBeenLastCalledWith(
      asked({
        title: LEAVE,
        copy: 'Workspace demo has changes to "Wing section" that are not saved. Leaving discards them.',
        yes: 'Leave',
        no: 'Stay',
        safe: true,
      }),
    );
    await confirmLeaveWorkspace('plugin-off');
    expect(confirm).toHaveBeenLastCalledWith(
      asked({
        title: 'Turn off Workspace demo?',
        copy: 'Its workspace is open with changes that are not saved. Turning it off closes the workspace and discards them.',
        yes: 'Turn off',
        no: 'Cancel',
        safe: true,
      }),
    );
    setWorkspaceDirty(true, 'Chord not saved');
    await confirmLeaveWorkspace('plugin-off');
    expect(confirm).toHaveBeenLastCalledWith(
      asked({
        title: 'Turn off Workspace demo?',
        copy: 'Its workspace is open with changes that are not saved (Chord not saved). Turning it off closes the workspace and discards them.',
        yes: 'Turn off',
        no: 'Cancel',
        safe: true,
      }),
    );
  });

  it('shows the plugin and study names as plain text that cannot reorder its words, the title at most 120 characters', async () => {
    // A title the page saved with study.update, and a plugin name from its manifest.
    const title = `Wing section\u{202e}${' .ecalp ni devas era segnahc llA'.repeat(8)}`;
    unregister();
    unregister = registerOpenWorkspace({ ...workspace, pluginName: () => 'Work\u{2066}space\ndemo', studyTitle: () => title });
    setWorkspaceDirty(true, '');
    await confirmLeaveWorkspace('back');
    const copy = String(confirm.mock.calls[0][0].copy);
    expect(copy).not.toMatch(/[\p{Cc}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u);
    expect(copy.startsWith('Work space demo has changes to "Wing section .ecalp ni devas era')).toBe(true);
    expect(copy.endsWith('…" that are not saved. Leaving discards them.')).toBe(true);
    expect(copy.slice(copy.indexOf('"') + 1, copy.lastIndexOf('"')).length).toBeLessThanOrEqual(120);
    await confirmLeaveWorkspace('plugin-off');
    expect(confirm.mock.calls[1][0].title).toBe('Turn off Work space demo?');
    // Names that clean to nothing: the route's own.
    unregister();
    unregister = registerOpenWorkspace({ ...workspace, pluginName: () => '\u{202e}', studyTitle: () => ' \n' });
    setWorkspaceDirty(true, 'Chord\u{202e} not\nsaved');
    await confirmLeaveWorkspace('back');
    expect(confirm.mock.calls[2][0].copy).toBe('ws-demo: Chord not saved Leaving discards them.');
    setWorkspaceDirty(true, '');
    await confirmLeaveWorkspace('back');
    expect(confirm.mock.calls[3][0].copy).toBe('ws-demo has changes to "st-1" that are not saved. Leaving discards them.');
  });

  it('Stay gives the keyboard back to the frame, unless the app has something else open', async () => {
    const focus = vi.spyOn(frame, 'focus');
    setWorkspaceDirty(true, 'Chord not saved');
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockClear();
    document.body.insertAdjacentHTML('beforeend', '<div id="setup-wizard"></div>');
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('leaves the frame full screen first', async () => {
    let fullscreen: Element | null = frame;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    const order: string[] = [];
    const exit = vi.fn(async () => {
      order.push('exit');
      fullscreen = null;
    });
    const before = document.exitFullscreen;
    document.exitFullscreen = exit;
    confirm.mockImplementation(async () => {
      order.push(`ask (full screen: ${!!document.fullscreenElement})`);
      return false;
    });
    try {
      setWorkspaceDirty(true, 'Chord not saved');
      await confirmLeaveWorkspace('back');
      expect(order).toEqual(['exit', 'ask (full screen: false)']);
      // Something else full screen is not the frame's to end.
      fullscreen = document.body;
      await exitFrameFullscreen();
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      document.exitFullscreen = before;
    }
  });

  it('Leave lets everything through until the workspace closes (at most LEAVE_APPROVAL_MS)', async () => {
    expect(LEAVE_APPROVAL_MS).toBe(10000);
    vi.useFakeTimers();
    setWorkspaceDirty(true, 'Chord not saved');
    expect(unloadAsks()).toBe(true);
    answer = true;
    expect(await confirmLeaveWorkspace('back')).toBe(true);
    expect(workspaceDirty()).toBe(false);
    expect(leaveApproved()).toBe(true);
    // Leaving closes the tab's own question too.
    expect(unloadAsks()).toBe(false);
    // The page cannot arm the guard again in the middle of the leave.
    setWorkspaceDirty(false);
    setWorkspaceDirty(true, 'Still not saved');
    expect(workspaceDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
    expect(await confirmLeaveWorkspace('home')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LEAVE_APPROVAL_MS - 1);
    expect(workspaceDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
    vi.advanceTimersByTime(1);
    // Still open with its work: every way out asks again, closing the tab too.
    expect(workspaceDirty()).toBe(true);
    expect(leaveApproved()).toBe(false);
    expect(unloadAsks()).toBe(true);
    // Closing the workspace ends the approval: the next one starts clean and asks again.
    answer = true;
    await confirmLeaveWorkspace('back');
    unregister();
    unregister = registerOpenWorkspace(workspace);
    expect(workspaceDirty()).toBe(false);
    setWorkspaceDirty(true, 'Chord not saved');
    expect(workspaceDirty()).toBe(true);
  });

  it('Turn off holds while the turn-off runs, however long; one that failed is withdrawn', async () => {
    vi.useFakeTimers();
    setWorkspaceDirty(true, 'Chord not saved');
    answer = true;
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(true);
    // The disable and the registry reload wait their turn on the worker.
    vi.advanceTimersByTime(LEAVE_APPROVAL_MS * 3);
    expect(workspaceDirty()).toBe(false);
    expect(leaveApproved()).toBe(true);
    expect(unloadAsks()).toBe(false);
    expect(await confirmLeaveWorkspace('back')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    // It failed: the plugin is on, and the page is still open with its work.
    withdrawLeaveApproval();
    expect(workspaceDirty()).toBe(true);
    expect(leaveApproved()).toBe(false);
    expect(unloadAsks()).toBe(true);
    answer = false;
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('Stay approves nothing', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    expect(leaveApproved()).toBe(false);
    expect(workspaceDirty()).toBe(true);
  });

  it('a workspace closed while its question is open closes the question, which then approves nothing', async () => {
    let reply: (ok: boolean) => void = () => undefined;
    confirm.mockImplementation(() => new Promise<boolean>((r) => (reply = r)));
    setWorkspaceDirty(true, 'Chord not saved');
    const answered = confirmLeaveWorkspace('back');
    await settle();
    const { signal } = confirm.mock.calls[0][0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    unregister();
    expect(signal.aborted).toBe(true);
    // Another workspace (another view) opens meanwhile.
    unregister = registerOpenWorkspace({ ...workspace });
    reply(true);
    expect(await answered).toBe(false);
    expect(leaveApproved()).toBe(false);
    setWorkspaceDirty(true, 'Chord not saved');
    expect(workspaceDirty()).toBe(true);
  });
});

describe('leaveWorkspaceTo', () => {
  it('goes to the hash when the user may leave, and stays when they choose to', async () => {
    await goTo('#/p/proj/ws/ws-demo/bench/st-1');
    setWorkspaceDirty(true, 'Chord not saved');
    expect(await leaveWorkspaceTo('#/p/proj', 'back')).toBe(false);
    expect(location.hash).toBe('#/p/proj/ws/ws-demo/bench/st-1');
    const arrived = new Promise<HashChangeEvent>((r) => window.addEventListener('hashchange', (e) => r(e), { once: true }));
    const after = later();
    answer = true;
    expect(await leaveWorkspaceTo('#/p/proj', 'back')).toBe(true);
    expect(location.hash).toBe('#/p/proj');
    await arrived;
    // The change it made got through the guard.
    expect(after).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('goes nowhere when the workspace closed while its question was open', async () => {
    await goTo('#/p/proj/ws/ws-demo/bench/st-1');
    let reply: (ok: boolean) => void = () => undefined;
    confirm.mockImplementation(() => new Promise<boolean>((r) => (reply = r)));
    setWorkspaceDirty(true, 'Chord not saved');
    const left = leaveWorkspaceTo('#/p/proj', 'back');
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    // The page saves while the question is open; the user goes Home with a typed link, and the workspace closes.
    setWorkspaceDirty(false);
    await goTo('#/');
    unregister();
    reply(true);
    expect(await left).toBe(false);
    await settle();
    expect(location.hash).toBe('#/');
  });
});

describe('the open workspace and its state', () => {
  it('starts clean, tells subscribers of every change, and forgets it all when it closes', () => {
    const seen: Array<{ dirty: boolean; message: string }> = [];
    const stop = subscribeWorkspaceDirty((s) => seen.push(s));
    expect(openWorkspaceRoute()).toBe(ROUTE);
    setWorkspaceDirty(true, 'Chord not saved');
    setWorkspaceDirty(true, 'Chord not saved');
    setWorkspaceDirty(true, 'Span not saved');
    setWorkspaceDirty(false, 'ignored while clean');
    unregister();
    expect(openWorkspaceRoute()).toBeNull();
    // Nothing open: nothing to mark.
    setWorkspaceDirty(true, 'nobody');
    expect(workspaceDirty()).toBe(false);
    stop();
    expect(seen).toEqual([
      { dirty: true, message: 'Chord not saved' },
      { dirty: true, message: 'Span not saved' },
      { dirty: false, message: '' },
      { dirty: false, message: '' },
    ]);
  });

  it('closing or reloading the tab asks only while dirty (a beforeunload listener exists only then)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const unloads = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'beforeunload');
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    setWorkspaceDirty(true, 'Chord not saved');
    setWorkspaceDirty(true, 'Span not saved');
    expect(unloads(add)).toHaveLength(1);
    expect(unload()).toBe(true);
    const handler = unloads(add)[0][1] as (e: BeforeUnloadEvent) => void;
    const e = { preventDefault: vi.fn(), returnValue: 'x' };
    handler(e as unknown as BeforeUnloadEvent);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.returnValue).toBe('');
    setWorkspaceDirty(false);
    expect(unloads(remove)).toEqual([['beforeunload', handler]]);
    expect(unload()).toBe(false);
    setWorkspaceDirty(true, 'Chord not saved');
    unregister();
    expect(unloads(remove)).toHaveLength(2);
    expect(unload()).toBe(false);
  });

  it('warns when a workspace opens before the guard is installed', async () => {
    vi.resetModules();
    const fresh = await import('./leaveGuard');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const off = fresh.registerOpenWorkspace(workspace);
    expect(warn).toHaveBeenCalledTimes(1);
    off();
    fresh.installWorkspaceLeaveGuard();
    fresh.registerOpenWorkspace(workspace)();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
