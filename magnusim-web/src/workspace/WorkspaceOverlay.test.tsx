import { act, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/project';
import { cssRules, ruleProps } from '../test/kitCss';
import { confirmAction, dialogBusy, promptName } from '../workbench/dialogs';
import { confirmLeaveWorkspace, installWorkspaceLeaveGuard, openWorkspaceRoute, workspaceDirty } from './leaveGuard';
import { frameMayTakeFocus, pluginNotReady, WorkspaceOverlay } from './WorkspaceOverlay';

describe('a workspace whose plugin is not on says why', () => {
  it('names the state Settings → Plugins shows', () => {
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'disabled' })).toMatchObject({
      title: 'Workspace demo is off.',
      retry: true,
    });
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'needs setup' }).title).toBe('Workspace demo needs setup.');
    expect(pluginNotReady('ws-demo', { key: 'ws-demo', name: 'Workspace demo', status: 'error', error: 'manifest: bad icon' })).toMatchObject({
      title: 'Workspace demo did not load.',
      detail: 'manifest: bad icon',
    });
    expect(pluginNotReady('ws-demo', null)).toMatchObject({ title: 'The ws-demo plugin is not installed.', retry: false });
    // Not installed, with the name its studies keep in the project tree.
    expect(pluginNotReady('ws-demo', null, 'Workspace demo').title).toBe('The Workspace demo plugin is not installed.');
  });
});

// The app page around a workspace: the workbench (#app) with the overlay's host, and the app's own UI.
const SHELL = `
  <div id="app">
    <header id="top-header">
      <button type="button" id="wb-home">Home</button>
      <div class="top-right">
        <div id="queue-menu"><button type="button" id="btn-queue">Queue</button><div id="job-queue-chip" hidden></div></div>
        <button type="button" id="wb-prefs">Settings</button>
      </div>
    </header>
    <nav id="toolbar"></nav>
    <div class="main-row"><div class="tree-row" tabindex="0" id="tree-row">Wing section</div></div>
    <div id="workspace-overlay" hidden></div>
  </div>
  <div id="setup-wizard" class="wiz" hidden><button type="button" id="wiz-skip">Close</button></div>
  <div id="modal-confirm" class="cfd-modal" hidden role="dialog" aria-modal="true" aria-labelledby="cf-heading">
    <div class="cfd-modal-backdrop" id="cf-backdrop"></div>
    <div class="cfd-modal-card">
      <h2 id="cf-heading">Delete?</h2>
      <p class="home-detail-desc" id="cf-copy"></p>
      <div class="np-actions">
        <button type="button" class="home-btn" id="cf-cancel">Cancel</button>
        <button type="button" class="home-btn home-btn-danger" id="cf-confirm">Delete</button>
      </div>
    </div>
  </div>
  <div id="modal-prompt" class="cfd-modal" hidden role="dialog" aria-modal="true" aria-labelledby="pm-heading">
    <div class="cfd-modal-backdrop" id="pm-backdrop"></div>
    <div class="cfd-modal-card">
      <h2 id="pm-heading">Save view</h2>
      <p class="home-detail-desc" id="pm-copy"></p>
      <label class="np-field"><span id="pm-label">Name</span><input type="text" id="pm-input" maxlength="64" autocomplete="off" /></label>
      <div class="np-actions">
        <button type="button" class="home-btn" id="pm-cancel">Cancel</button>
        <button type="button" class="home-btn home-btn-primary" id="pm-confirm">Save</button>
      </div>
    </div>
  </div>`;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
/** Long enough for the app dialogs' next turn (a new task) to have come. */
const later = () => new Promise((r) => setTimeout(r, 20));

/** Closing the tab now: whether the browser would ask first (a beforeunload listener cancelled it). */
function unloadAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('when the host gives the keyboard to the workspace frame', () => {
  let frame: HTMLIFrameElement;
  let header: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = `${SHELL}<div class="ws-shell"><header data-workspace-header="1"><button type="button" id="ws-back">Back</button></header><iframe id="workspace-frame"></iframe></div>`;
    frame = $('#workspace-frame') as HTMLIFrameElement;
    header = $('[data-workspace-header]');
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
  });

  it('with nothing of the app in front: from the page itself or the covered tree row that opened it', () => {
    expect(frameMayTakeFocus(document, frame, header)).toBe(true);
    $('#tree-row').focus();
    expect(frameMayTakeFocus(document, frame, header)).toBe(true);
  });

  it('never from an open dialog, Settings or the Queue', () => {
    for (const id of ['modal-confirm', 'modal-prompt', 'setup-wizard', 'job-queue-chip']) {
      $(`#${id}`).hidden = false;
      expect(frameMayTakeFocus(document, frame, header), id).toBe(false);
      $(`#${id}`).hidden = true;
    }
    expect(frameMayTakeFocus(document, frame, header)).toBe(true);
  });

  it('never from the workspace header (Back, rename, Queue, Settings)', () => {
    $('#ws-back').focus();
    expect(frameMayTakeFocus(document, frame, header)).toBe(false);
  });

  it('never while something else is full screen, and not without a frame', () => {
    let fullscreen: Element | null = document.body;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    expect(frameMayTakeFocus(document, frame, header)).toBe(false);
    fullscreen = frame;
    expect(frameMayTakeFocus(document, frame, header)).toBe(true);
    // Nothing full screen: only the missing frame says no.
    fullscreen = null;
    expect(frameMayTakeFocus(document, null, header)).toBe(false);
  });
});

const STUDY = {
  id: 'st-1',
  kind: 'bench_case',
  title: 'Wing section',
  schema_version: 1,
  rev: 1,
  plugin: 'ws-demo',
  plugin_name: 'Workspace demo',
  plugin_version: '0.1.0',
  created_at: '',
  updated_at: '',
};
const WS_HASH = '#/p/proj/ws/ws-demo/bench/st-1';
const LOST = 'Changes that were not saved in the workspace were lost.';

describe('the workspace overlay', () => {
  let pluginStatus = 'enabled';
  // The plugin's folder is there (false: removed, so /api/plugins does not list it).
  let installed = true;
  let studyStatus = 200;
  let fetches: string[] = [];
  let confirm: ReturnType<typeof vi.fn>;
  let answer = false;

  beforeAll(() => {
    installWorkspaceLeaveGuard();
  });

  beforeEach(async () => {
    document.body.innerHTML = SHELL;
    pluginStatus = 'enabled';
    installed = true;
    studyStatus = 200;
    fetches = [];
    answer = false;
    confirm = vi.fn(async () => answer);
    window.__CFD_CONFIRM__ = confirm as unknown as typeof window.__CFD_CONFIRM__;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetches.push(url);
        if (url === '/api/plugins' && !installed) return json({ plugins: [] });
        if (url.startsWith('/api/plugin-studies?')) {
          // The project tree's list: a study keeps its plugin's name when the plugin is gone.
          return json({
            studies: [
              { id: 'st-0', plugin: 'ws-demo', plugin_name: 'Workspace demo', title: 'Another study', available: installed },
              { id: 'st-1', plugin: 'ws-demo', plugin_name: 'Workspace demo', title: 'Wing section', available: installed, reason: installed ? '' : 'Requires the Workspace demo plugin' },
            ],
          });
        }
        if (url === '/api/plugins') {
          return json({
            plugins: [
              {
                key: 'ws-demo',
                name: 'Workspace demo',
                status: pluginStatus,
                workspaces: [{ key: 'bench', title: 'Bench', entry: 'workspace/index.html' }],
              },
            ],
          });
        }
        if (url.startsWith('/api/plugin-studies/get')) return studyStatus === 404 ? json({ error: 'no such study' }, 404) : json({ study: STUDY });
        return json({ ok: true });
      }),
    );
    useProjectStore.setState({ projectId: 'proj' });
    if (location.hash !== WS_HASH) {
      const moved = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
      location.hash = WS_HASH;
      await moved;
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__CFD_CONFIRM__;
    delete window.__CFD_PROMPT_NAME__;
    delete window.__CFD_DIALOG_BUSY__;
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
    // No app dialog a test left open holds up the next test.
    for (let i = 0; i < 20 && dialogBusy(); i++) {
      if (!$('#modal-confirm').hidden) $('#cf-cancel').click();
      if (!$('#modal-prompt').hidden) $('#pm-cancel').click();
      await later();
    }
  });

  /** The app's own dialogs, as the workbench installs them. */
  function realDialogs(): void {
    window.__CFD_CONFIRM__ = (opts) => confirmAction(opts);
    window.__CFD_PROMPT_NAME__ = (opts) => promptName(opts);
    window.__CFD_DIALOG_BUSY__ = () => dialogBusy();
  }

  async function open() {
    const view = render(<WorkspaceOverlay />);
    const frame = await waitFor(() => {
      const f = document.getElementById('workspace-frame') as HTMLIFrameElement | null;
      if (!f) throw new Error('no frame yet');
      return f;
    });
    // Its bridge is listening (the effects after the frame showed have run).
    await act(async () => undefined);
    return { view, frame };
  }

  /** The page (this load of it: `instance`) says hello; resolves with the port it is handed. */
  async function connect(frame: HTMLIFrameElement, instance = 'i1'): Promise<MessagePort> {
    const win = frame.contentWindow as Window;
    const posted: unknown[][] = [];
    (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => void posted.push(a);
    window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.1.0', instance }, source: win }));
    await waitFor(() => expect(posted.length).toBe(1));
    await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-connected', '1'));
    return (posted[0] as [unknown, unknown, MessagePort[]])[2][0];
  }

  let nextId = 1;
  function call(port: MessagePort, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve) => {
      port.onmessage = (e: MessageEvent) => {
        if ((e.data as { id?: number }).id === id) resolve(e.data as Record<string, unknown>);
      };
      port.postMessage({ id, method, params });
    });
  }

  it('covers the workbench: its controls move in, the rest is inert; closing puts the controls back before anything is usable again', async () => {
    const top = $('#top-header');
    const log: Array<[boolean, boolean]> = [];
    let inert = false;
    Object.defineProperty(top, 'inert', {
      configurable: true,
      get: () => inert,
      set: (v: boolean) => {
        inert = v;
        log.push([v, top.contains(document.getElementById('wb-prefs'))]);
      },
    });
    await open();
    expect($('.ws-header-right').contains($('#wb-prefs'))).toBe(true);
    expect($('.ws-header-right').contains($('#queue-menu'))).toBe(true);
    expect([top.inert, $('#toolbar').inert, $('#app > .main-row').inert]).toEqual([true, true, true]);
    expect($('#workspace-overlay').inert).toBeFalsy();
    // Clean: Back leaves at once.
    $('[data-ws-back]').click();
    await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
    expect(location.hash).toBe('#/p/proj');
    expect(confirm).not.toHaveBeenCalled();
    expect(top.contains($('#wb-prefs'))).toBe(true);
    expect([top.inert, $('#toolbar').inert, $('#app > .main-row').inert]).toEqual([false, false, false]);
    expect(log).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('closing leaves nothing inert even when putting the controls back fails', async () => {
    const { view } = await open();
    expect($('#toolbar').inert).toBe(true);
    vi.spyOn($('#top-header .top-right'), 'insertBefore').mockImplementation(() => {
      throw new Error('the header is gone');
    });
    // React reports the failed cleanup; that is not what this checks.
    const quiet = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', quiet);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      view.unmount();
    } catch {
      /* reported */
    } finally {
      window.removeEventListener('error', quiet);
    }
    expect([$('#top-header').inert, $('#toolbar').inert, $('#app > .main-row').inert]).toEqual([false, false, false]);
  });

  it('runs its page sandboxed as before, with full screen allowed', async () => {
    const { frame } = await open();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(frame.getAttribute('allow')).toBe('clipboard-write; fullscreen');
  });

  it("shows the page's unsaved work in its header, and Back asks while there is some", async () => {
    const { frame } = await open();
    const port = await connect(frame);
    expect(await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' })).toMatchObject({ result: { ok: true } });
    const shell = $('.ws-shell');
    await waitFor(() => expect(shell).toHaveAttribute('data-workspace-dirty', '1'));
    const dot = $('[data-ws-dirty]');
    expect(dot).toHaveClass('ws-dirty');
    expect(dot).toHaveAttribute('title', 'Chord not saved');
    expect(dot).toHaveAttribute('aria-label', 'Not saved');
    expect($('[data-ws-crumb]').contains(dot)).toBe(true);
    await call(port, 'nav.setDirty', { dirty: true });
    await waitFor(() => expect($('[data-ws-dirty]')).toHaveAttribute('title', 'Not saved'));

    // Back: Stay keeps the workspace, and its place in the history as it was.
    const push = vi.spyOn(history, 'pushState');
    $('[data-ws-back]').click();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Leave without saving?',
      copy: 'Workspace demo has changes to "Wing section" that are not saved. Leaving discards them.',
      yes: 'Leave',
      no: 'Stay',
      safe: true,
      signal: expect.any(AbortSignal),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(location.hash).toBe(WS_HASH);
    expect($('#workspace-overlay').hidden).toBe(false);
    // It asked before going anywhere: no address was changed and put back.
    expect(push).not.toHaveBeenCalled();

    // The page's own Back: Stay answers left: false.
    expect(await call(port, 'nav.back')).toMatchObject({ result: { ok: true, left: false } });

    await call(port, 'nav.setDirty', { dirty: false });
    await waitFor(() => expect(shell).not.toHaveAttribute('data-workspace-dirty'));
    expect(document.querySelector('[data-ws-dirty]')).toBeNull();
  });

  it('gives its page the keyboard when it connects, but not while Settings is open; closing Settings does', async () => {
    const { frame } = await open();
    const focus = vi.spyOn(frame, 'focus');
    $('#setup-wizard').hidden = false;
    await connect(frame);
    await nextFrame();
    await nextFrame();
    expect(focus).not.toHaveBeenCalled();
    $('#setup-wizard').hidden = true;
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  });

  it("asks the page's questions out of full screen, one at a time with the app's, dropped once the page is gone", async () => {
    const { view, frame } = await open();
    const port = await connect(frame);
    let fullscreen: Element | null = frame;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    const order: string[] = [];
    const before = document.exitFullscreen;
    document.exitFullscreen = vi.fn(async () => {
      order.push('exit');
      fullscreen = null;
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    let skipIf: (() => boolean) | undefined;
    confirm.mockImplementation(async (opts: { skipIf?: () => boolean }) => {
      order.push(`ask (full screen: ${!!document.fullscreenElement})`);
      skipIf = opts.skipIf;
      return true;
    });
    try {
      await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-fullscreen', '1'));
      const reply = await call(port, 'ui.confirm', { title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' });
      expect(reply).toMatchObject({ result: true });
      expect(order).toEqual(['exit', 'ask (full screen: false)']);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Replace the mesh?', copy: 'The old mesh is deleted.', yes: 'Replace' }));
      // A page's question is a plain one: Cancel, and Enter answers Yes.
      expect(confirm.mock.lastCall?.[0]).not.toHaveProperty('no');
      expect(confirm.mock.lastCall?.[0]).not.toHaveProperty('safe');
      document.dispatchEvent(new Event('fullscreenchange'));
      await waitFor(() => expect($('.ws-shell')).not.toHaveAttribute('data-workspace-fullscreen'));
      expect(skipIf && skipIf()).toBe(false);
      view.unmount();
      expect(skipIf && skipIf()).toBe(true);
    } finally {
      document.exitFullscreen = before;
    }
  });

  it("a link to a study whose plugin was removed names the plugin and the study as the tree does, never the key and the id", async () => {
    installed = false;
    render(<WorkspaceOverlay />);
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('The Workspace demo plugin is not installed.'));
    expect($('[data-ws-crumb]')).toHaveTextContent(/^Workspace demo\s*›\s*Wing section$/);
    expect(document.body.textContent).not.toContain('st-1');
    expect(document.getElementById('workspace-frame')).toBeNull();
    // Nothing of the study is read through its (missing) plugin.
    expect(fetches.filter((u) => u.startsWith('/api/plugin-studies/get'))).toEqual([]);
  });

  it('closes into the "is off" card when its plugin is turned off elsewhere; with unsaved work the card says it was lost', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1'));
    pluginStatus = 'disabled';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('Workspace demo is off.'));
    expect($('[data-ws-error]')).toHaveTextContent(LOST);
    expect(document.getElementById('workspace-frame')).toBeNull();
    // No page, nothing unsaved: no dot, and leaving asks nothing.
    await waitFor(() => expect($('.ws-shell')).not.toHaveAttribute('data-workspace-dirty'));
    expect(workspaceDirty()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('turned off elsewhere while clean, the card has no such line', async () => {
    const { frame } = await open();
    await connect(frame);
    pluginStatus = 'disabled';
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('Workspace demo is off.'));
    expect($('[data-ws-error]')).not.toHaveTextContent(LOST);
  });

  it('its folder removed while it is open, the card names the plugin as the header did, never by its key', async () => {
    const { frame } = await open();
    await connect(frame);
    await waitFor(() => expect($('[data-ws-crumb]')).toHaveTextContent(/^Workspace demo\s*›/));
    // /api/plugins no longer lists it: the recheck finds no row, and only the name shown so far is left.
    installed = false;
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('The Workspace demo plugin is not installed.'));
    expect($('[data-ws-error]')).not.toHaveTextContent('ws-demo');
    expect(document.getElementById('workspace-frame')).toBeNull();
  });

  it('turned off here after the user chose to discard, the card has no such line', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1'));
    answer = true;
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(true);
    pluginStatus = 'disabled';
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('Workspace demo is off.'));
    expect($('[data-ws-error]')).not.toHaveTextContent(LOST);
  });

  it('re-reads the plugins only when they changed or the tab is back in front (never polls)', async () => {
    const { frame } = await open();
    await connect(frame);
    const lists = () => fetches.filter((u) => u === '/api/plugins').length;
    const n = lists();
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
    await new Promise((r) => setTimeout(r, 20));
    expect(lists()).toBe(n);
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await waitFor(() => expect(lists()).toBe(n + 1));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(lists()).toBe(n + 2));
    expect($('[data-ws-error]')).toBeNull();
  });

  it('a study deleted while its page has unsaved work closes into the card that says so, without asking', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1'));
    studyStatus = 404;
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('This study no longer exists.'));
    expect($('[data-ws-error]')).toHaveTextContent(LOST);
    // Another sync (the tree reading again) keeps what the card said.
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
    await new Promise((r) => setTimeout(r, 20));
    expect($('[data-ws-error]')).toHaveTextContent(LOST);
    // Back needs no question.
    $('[data-ws-error-back]').click();
    await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a study deleted while its page is clean: the card has no such line', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    studyStatus = 404;
    // The page's next study call finds it gone.
    expect(await call(port, 'study.get')).toMatchObject({ error: { code: 'not_found' } });
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('This study no longer exists.'));
    expect($('[data-ws-error]')).not.toHaveTextContent(LOST);
  });

  it('a study found gone by a page call while it has unsaved work: the card says it was lost', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect(workspaceDirty()).toBe(true));
    studyStatus = 404;
    expect(await call(port, 'study.get')).toMatchObject({ error: { code: 'not_found' } });
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('This study no longer exists.'));
    expect($('[data-ws-error]')).toHaveTextContent(LOST);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('forgets its unsaved work when it closes: nothing asks, closing the tab included', async () => {
    const { view, frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect(workspaceDirty()).toBe(true));
    expect(openWorkspaceRoute()).toMatchObject({ projectId: 'proj', plugin: 'ws-demo', workspace: 'bench', studyId: 'st-1' });
    expect(unloadAsks()).toBe(true);
    view.unmount();
    expect(openWorkspaceRoute()).toBeNull();
    expect(workspaceDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
  });

  it("the page's own Back leaves a clean page at once, and says so", async () => {
    const { frame } = await open();
    const port = await connect(frame);
    expect(await call(port, 'nav.back')).toMatchObject({ result: { ok: true, left: true } });
    await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
    expect(location.hash).toBe('#/p/proj');
    expect(confirm).not.toHaveBeenCalled();
  });

  it("the page's own Back with unsaved work: Leave leaves, and says so", async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect(workspaceDirty()).toBe(true));
    answer = true;
    expect(await call(port, 'nav.back')).toMatchObject({ result: { ok: true, left: true } });
    await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
    expect(location.hash).toBe('#/p/proj');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  describe("results.openIn3D (a case's results in the project's 3D view)", () => {
    const RESOLVED = {
      ok: true,
      key: 'pf-0123456789ab',
      case_dir: 'C:\\projects\\proj\\plugins\\ws-demo\\studies\\st-1\\cases\\c2',
      times: ['0.1', '0.2', '0.3'],
      app: 'pimpleFoam',
      time_dependency: 'transient',
      frame_fields: ['U', 'p'],
    };
    let openResults: ReturnType<typeof vi.fn>;
    let resolveStatus = 200;

    beforeEach(() => {
      resolveStatus = 200;
      const base = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith('/api/plugin-cases/resolve')) {
            fetches.push(url);
            const body = resolveStatus === 200 ? RESOLVED : { ok: false, code: 'running', error: 'This case is queued or running. Open its results when it has finished.' };
            return new Response(JSON.stringify(body), { status: resolveStatus });
          }
          return base(input, init);
        }),
      );
      openResults = vi.fn(async () => ({ ok: true }));
      window.__CFD_OPEN_PLUGIN_RESULTS__ = openResults as unknown as typeof window.__CFD_OPEN_PLUGIN_RESULTS__;
    });

    afterEach(() => {
      delete window.__CFD_OPEN_PLUGIN_RESULTS__;
      delete window.__CFD_RESULTS_VIEW__;
    });

    it('with nothing shown: no question; the workspace closes to the project and then the results open', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      expect(await call(port, 'results.openIn3D', { caseRel: 'cases/c2' })).toMatchObject({ result: { opened: true } });
      expect(fetches).toContain('/api/plugin-cases/resolve?project_id=proj&plugin=ws-demo&study_id=st-1&case_rel=cases%2Fc2');
      await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
      expect(location.hash).toBe('#/p/proj');
      expect(confirm).not.toHaveBeenCalled();
      await waitFor(() => expect(openResults).toHaveBeenCalledTimes(1));
      expect(openResults).toHaveBeenCalledWith({
        key: 'pf-0123456789ab',
        projectId: 'proj',
        caseDir: RESOLVED.case_dir,
        plugin: 'ws-demo',
        pluginName: 'Workspace demo',
        studyId: 'st-1',
        studyTitle: 'Wing section',
        caseRel: 'cases/c2',
        app: 'pimpleFoam',
        timeDependency: 'transient',
        times: ['0.1', '0.2', '0.3'],
      });
    });

    it('with results shown it asks first (in turn, like a page question); Cancel keeps the workspace', async () => {
      window.__CFD_RESULTS_VIEW__ = true;
      const { frame } = await open();
      const port = await connect(frame);
      answer = false;
      expect(await call(port, 'results.openIn3D', { caseRel: 'cases/c2' })).toMatchObject({ result: { opened: false } });
      expect(confirm).toHaveBeenCalledWith({
        title: 'Open these results?',
        copy: 'This replaces the results currently shown.',
        yes: 'Open results',
        skipIf: expect.any(Function),
        signal: expect.any(AbortSignal),
      });
      await later();
      expect($('#workspace-overlay').hidden).toBe(false);
      expect(location.hash).toBe(WS_HASH);
      expect(openResults).not.toHaveBeenCalled();
      // Open results: replaces them.
      answer = true;
      expect(await call(port, 'results.openIn3D', { caseRel: 'cases/c2' })).toMatchObject({ result: { opened: true } });
      await waitFor(() => expect(openResults).toHaveBeenCalledTimes(1));
      expect(location.hash).toBe('#/p/proj');
    });

    it('with unsaved work in the page it asks the Back question; Stay keeps the workspace and opens nothing', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
      await waitFor(() => expect(workspaceDirty()).toBe(true));
      answer = false;
      expect(await call(port, 'results.openIn3D', { caseRel: 'cases/c2' })).toMatchObject({ result: { opened: false } });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Leave without saving?', yes: 'Leave', no: 'Stay' });
      await later();
      expect($('#workspace-overlay').hidden).toBe(false);
      expect(openResults).not.toHaveBeenCalled();
    });

    it("a case still queued or running: the app's code reaches the page, nothing is asked", async () => {
      window.__CFD_RESULTS_VIEW__ = true;
      resolveStatus = 409;
      const { frame } = await open();
      const port = await connect(frame);
      expect(await call(port, 'results.openIn3D', { caseRel: 'cases/c1' })).toMatchObject({
        error: { code: 'running', message: 'This case is queued or running. Open its results when it has finished.' },
      });
      expect(confirm).not.toHaveBeenCalled();
      expect($('#workspace-overlay').hidden).toBe(false);
    });
  });

  it('a new page after Try again is guarded again, whatever the one before was allowed', async () => {
    const { frame } = await open();
    const port = await connect(frame);
    await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
    await waitFor(() => expect(workspaceDirty()).toBe(true));
    // Settings → Plugins → Turn off, answered Turn off: the plugin goes off, the card shows.
    answer = true;
    expect(await confirmLeaveWorkspace('plugin-off')).toBe(true);
    pluginStatus = 'disabled';
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('Workspace demo is off.'));
    expect($('[data-ws-error]')).not.toHaveTextContent(LOST);
    // On again, and Try again: a new page in the same view.
    pluginStatus = 'enabled';
    $('[data-ws-retry]').click();
    const again = await waitFor(() => {
      const f = document.getElementById('workspace-frame') as HTMLIFrameElement | null;
      if (!f) throw new Error('no frame yet');
      return f;
    });
    await act(async () => undefined);
    const next = await connect(again, 'i2');
    await call(next, 'nav.setDirty', { dirty: true, message: 'Span not saved' });
    await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1'));
    expect(workspaceDirty()).toBe(true);
    expect(unloadAsks()).toBe(true);
    // Turned off elsewhere now: its unsaved work was lost, and the card says so.
    pluginStatus = 'disabled';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect($('[data-ws-error] h2')).toHaveTextContent('Workspace demo is off.'));
    expect($('[data-ws-error]')).toHaveTextContent(LOST);
  });

  it("asks the page's name prompt out of full screen, in turn, dropped once the page is gone", async () => {
    const { view, frame } = await open();
    const port = await connect(frame);
    let fullscreen: Element | null = frame;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    const order: string[] = [];
    const before = document.exitFullscreen;
    document.exitFullscreen = vi.fn(async () => {
      order.push('exit');
      fullscreen = null;
    });
    let skipIf: (() => boolean) | undefined;
    const prompt = vi.fn(async (opts: { skipIf?: () => boolean }) => {
      order.push(`ask (full screen: ${!!document.fullscreenElement})`);
      skipIf = opts.skipIf;
      return 'Polar 2';
    });
    window.__CFD_PROMPT_NAME__ = prompt as unknown as typeof window.__CFD_PROMPT_NAME__;
    const focus = vi.spyOn(frame, 'focus');
    try {
      const reply = await call(port, 'ui.prompt', { title: 'Name the polar', label: 'Name', value: 'Polar 1', confirmLabel: 'Save' });
      expect(reply).toMatchObject({ result: 'Polar 2' });
      expect(order).toEqual(['exit', 'ask (full screen: false)']);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'Name the polar', label: 'Name', value: 'Polar 1', yes: 'Save' }));
      // Answered: the keyboard is the page's again.
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(skipIf && skipIf()).toBe(false);
      view.unmount();
      expect(skipIf && skipIf()).toBe(true);
    } finally {
      document.exitFullscreen = before;
    }
  });

  it('gives its page the keyboard as soon as it connects when nothing of the app is in front', async () => {
    const { frame } = await open();
    const focus = vi.spyOn(frame, 'focus');
    await connect(frame);
    await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
  });

  it('gives the keyboard back when the Queue closes, and when Settings closes from its own Close button', async () => {
    const { frame } = await open();
    await connect(frame);
    await nextFrame();
    await nextFrame();
    const focus = vi.spyOn(frame, 'focus');
    const chip = $('#job-queue-chip');
    chip.hidden = false;
    (document.activeElement as HTMLElement | null)?.blur();
    await nextFrame();
    chip.hidden = true;
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    // Chromium still names the clicked Close button of the panel that just closed as the active element.
    const wizard = $('#setup-wizard');
    wizard.hidden = false;
    $('#wiz-skip').focus();
    await nextFrame();
    wizard.hidden = true;
    expect(document.activeElement).toBe($('#wiz-skip'));
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
  });

  it('takes the keyboard back only when a panel really closes: hiding one that is already hidden (as the Queue sync does) does not', async () => {
    const { frame } = await open();
    await connect(frame);
    await nextFrame();
    await nextFrame();
    const focus = vi.spyOn(frame, 'focus');
    for (const id of ['modal-confirm', 'modal-prompt', 'setup-wizard', 'job-queue-chip']) {
      const el = $(`#${id}`);
      // The user clicked the header's plain text: the keyboard is on the page body.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement, id).toBe(document.body);
      expect(el.hidden, id).toBe(true);
      el.hidden = true;
      await nextFrame();
      await nextFrame();
      await later();
      expect(focus, id).not.toHaveBeenCalled();
      expect(document.activeElement, id).toBe(document.body);
      // Shown, then closed: the keyboard goes back to the page.
      el.hidden = false;
      await nextFrame();
      el.hidden = true;
      await waitFor(() => expect(focus, id).toHaveBeenCalledTimes(1));
      focus.mockClear();
    }
  });

  it("ends the page's full screen when the page closes", async () => {
    const { view, frame } = await open();
    await connect(frame);
    let fullscreen: Element | null = frame;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    const before = document.exitFullscreen;
    const exit = vi.fn(async () => {
      fullscreen = null;
    });
    document.exitFullscreen = exit;
    try {
      view.unmount();
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      document.exitFullscreen = before;
    }
  });

  describe("the page's toast (ws.ui.toast)", () => {
    const shown = () => [...document.querySelectorAll('[data-ws-toast]')] as HTMLElement[];
    /** With setTimeout faked: let the message ports and React's scheduler (no timers) finish. */
    async function settle() {
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((r) => setImmediate(r));
        });
      }
    }
    function advance(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    }
    /** Open and connect with real timers, then fake setTimeout for the toast's own time. */
    async function openWithFakeTime() {
      const { frame } = await open();
      const port = await connect(frame);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return port;
    }
    afterEach(() => {
      vi.useRealTimers();
    });

    it('draws one kit toast inside the overlay, with the message and its kind, and sends no cfd:toast', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      const heard = vi.fn();
      window.addEventListener('cfd:toast', heard);
      try {
        expect(await call(port, 'ui.toast', { message: 'Saved the polar', kind: 'success' })).toMatchObject({ result: { ok: true } });
        await waitFor(() => expect(shown()).toHaveLength(1));
        const toast = shown()[0];
        expect($('#workspace-overlay').contains(toast)).toBe(true);
        expect(toast.parentElement).toHaveClass('ws-toast-slot');
        expect(toast.className).toBe('mgk-type mgk-toast mgk-toast--success');
        expect(toast).toHaveAttribute('role', 'status');
        expect(toast.querySelector('.mgk-toast-msg')).toHaveTextContent('Saved the polar');
        expect(toast.querySelector('button.mgk-toast-close')).toHaveAttribute('aria-label', 'Close');
        expect(document.querySelector('.ws-toast')).toBeNull();
        expect(heard).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('cfd:toast', heard);
      }
    });

    it('a second message replaces the first', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'ui.toast', { message: 'First' });
      await waitFor(() => expect(shown()).toHaveLength(1));
      expect(shown()[0]).toHaveClass('mgk-toast--info');
      await call(port, 'ui.toast', { message: 'Second', kind: 'error' });
      await waitFor(() => expect(shown()[0]).toHaveTextContent('Second'));
      expect(shown()).toHaveLength(1);
      expect(shown()[0]).toHaveClass('mgk-toast--error');
    });

    it('closes after 3.8 s', async () => {
      const port = await openWithFakeTime();
      await call(port, 'ui.toast', { message: 'Saved' });
      await settle();
      expect(shown()).toHaveLength(1);
      advance(3799);
      expect(shown()).toHaveLength(1);
      advance(1);
      expect(shown()).toHaveLength(0);
    });

    it('an error closes after 9 s', async () => {
      const port = await openWithFakeTime();
      await call(port, 'ui.toast', { message: 'Could not save', kind: 'error' });
      await settle();
      advance(8999);
      expect(shown()).toHaveLength(1);
      advance(1);
      expect(shown()).toHaveLength(0);
    });

    it('a second message starts the time again', async () => {
      const port = await openWithFakeTime();
      await call(port, 'ui.toast', { message: 'First' });
      await settle();
      advance(3000);
      await call(port, 'ui.toast', { message: 'Second' });
      await settle();
      advance(3799);
      expect(shown()[0]).toHaveTextContent('Second');
      advance(1);
      expect(shown()).toHaveLength(0);
    });

    it('a re-render while it shows (the dirty flag at 3 s) does not delay its close at 3.8 s', async () => {
      const port = await openWithFakeTime();
      await call(port, 'ui.toast', { message: 'Saved' });
      await settle();
      advance(3000);
      await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
      await settle();
      // The overlay did re-render: its header shows the unsaved work.
      expect($('.ws-shell')).toHaveAttribute('data-workspace-dirty', '1');
      expect(shown()).toHaveLength(1);
      advance(800);
      expect(shown()).toHaveLength(0);
    });

    it('× closes it', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'ui.toast', { message: 'Saved' });
      await waitFor(() => expect(shown()).toHaveLength(1));
      (shown()[0].querySelector('.mgk-toast-close') as HTMLElement).click();
      await waitFor(() => expect(shown()).toHaveLength(0));
    });

    it("keeps the old toast's place in style.css; the look is the kit's", () => {
      const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
      expect(ruleProps(appCss, '.ws-toast-slot')).toEqual({ position: 'absolute', right: '16px', bottom: '16px' });
      const old = cssRules(appCss).flatMap((r) => r.selectors).filter((s) => /\.ws-toast(?!-slot)/.test(s));
      expect(old).toEqual([]);
    });

    it('closing the overlay removes it', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'ui.toast', { message: 'Saved', kind: 'success' });
      await waitFor(() => expect(shown()).toHaveLength(1));
      $('[data-ws-back]').click();
      await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
      expect(document.querySelector('[data-ws-toast]')).toBeNull();
      expect(document.querySelector('.mgk-toast')).toBeNull();
    });
  });

  describe("with the app's own dialogs", () => {
    beforeEach(() => {
      realDialogs();
    });

    it('a page question waiting behind the leave question is dropped when the user chooses Leave', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
      await waitFor(() => expect(workspaceDirty()).toBe(true));
      $('[data-ws-back]').click();
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(false));
      expect($('#cf-heading')).toHaveTextContent('Leave without saving?');
      // Enter keeps the work: Stay has the focus.
      expect($('#cf-cancel')).toHaveTextContent('Stay');
      expect(document.activeElement).toBe($('#cf-cancel'));
      // Meanwhile the page asks something: it waits its turn.
      void call(port, 'ui.confirm', { title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' });
      await later();
      expect($('#cf-heading')).toHaveTextContent('Leave without saving?');
      $('#cf-confirm').click();
      await waitFor(() => expect($('#workspace-overlay').hidden).toBe(true));
      expect(location.hash).toBe('#/p/proj');
      await later();
      expect($('#modal-confirm').hidden).toBe(true);
      expect(dialogBusy()).toBe(false);
    });

    it("a page's question is a plain one whatever the page asks for, right after Stay too: Cancel, Yes focused, Enter answers Yes", async () => {
      const enter = () =>
        (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
      await waitFor(() => expect(workspaceDirty()).toBe(true));
      $('[data-ws-back]').click();
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(false));
      expect($('#cf-cancel')).toHaveTextContent('Stay');
      enter();
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(true));
      expect(location.hash).toBe(WS_HASH);
      expect(workspaceDirty()).toBe(true);
      // The page asks for the leave question's Stay and safe (and a notice): none of it reaches the dialog.
      const replaced = call(port, 'ui.confirm', {
        title: 'Replace the mesh?',
        message: 'The old mesh is deleted.',
        confirmLabel: 'Replace',
        safe: true,
        no: 'Stay',
        cancelLabel: 'Stay',
        notice: true,
      });
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(false));
      expect($('#cf-heading')).toHaveTextContent('Replace the mesh?');
      expect($('#cf-confirm')).toHaveTextContent('Replace');
      expect($('#cf-cancel').hidden).toBe(false);
      expect($('#cf-cancel')).toHaveTextContent('Cancel');
      expect(document.activeElement).toBe($('#cf-confirm'));
      enter();
      expect(await replaced).toMatchObject({ result: true });
      expect($('#modal-confirm').hidden).toBe(true);
    });

    it('a page question waiting behind "Turn off" is dropped while the turn-off runs (the page is still there)', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      await call(port, 'nav.setDirty', { dirty: true, message: 'Chord not saved' });
      await waitFor(() => expect(workspaceDirty()).toBe(true));
      // Settings → Plugins → Disable asks.
      const turnedOff = confirmLeaveWorkspace('plugin-off');
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(false));
      expect($('#cf-heading')).toHaveTextContent('Turn off Workspace demo?');
      const replaced = call(port, 'ui.confirm', { title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' });
      const headings: string[] = [];
      const seen = new MutationObserver(() => {
        if (!$('#modal-confirm').hidden) headings.push(String($('#cf-heading').textContent));
      });
      seen.observe($('#modal-confirm'), { attributes: true, attributeFilter: ['hidden'] });
      $('#cf-confirm').click();
      expect(await turnedOff).toBe(true);
      // The request to turn it off is on its way; the page is open and answered at once.
      expect(await replaced).toMatchObject({ result: false });
      await later();
      seen.disconnect();
      expect(headings).toEqual([]);
      expect($('#modal-confirm').hidden).toBe(true);
      expect($('#workspace-overlay').hidden).toBe(false);
    });

    it('a page question waiting behind another dialog is dropped when the page reloads (the new load did not ask it)', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      // The header's rename prompt is open.
      const renamed = promptName({ title: 'Rename study', label: 'Name', value: 'Wing section', yes: 'Rename' });
      await waitFor(() => expect($('#modal-prompt').hidden).toBe(false));
      void call(port, 'ui.confirm', { title: 'Old page question', message: 'Asked by the first load', confirmLabel: 'Replace' });
      await later();
      expect($('#modal-confirm').hidden).toBe(true);
      // The page reloads itself, and the new load connects.
      await connect(frame, 'i2');
      $('#pm-cancel').click();
      expect(await renamed).toBeNull();
      await later();
      expect($('#modal-confirm').hidden).toBe(true);
      expect(dialogBusy()).toBe(false);
    });

    it('a page question on screen closes when its page goes', async () => {
      const { frame } = await open();
      const port = await connect(frame);
      void call(port, 'ui.confirm', { title: 'Replace the mesh?', message: 'The old mesh is deleted.', confirmLabel: 'Replace' });
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(false));
      // The page reloads itself (a clean page may).
      await connect(frame, 'i2');
      await waitFor(() => expect($('#modal-confirm').hidden).toBe(true));
      await later();
      expect(dialogBusy()).toBe(false);
    });
  });
});
