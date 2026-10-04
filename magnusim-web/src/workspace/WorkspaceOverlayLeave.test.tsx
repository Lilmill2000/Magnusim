// gate:l3-guard, the workspace header during a leave (host API 1.6, LINK 6.4 and 6.5): nothing
// for a quick hook; after 400 ms the status line, Back disabled, Cancel and the cover (the page
// inert); "Continue in background" once the link's job is queued; "Waiting for your choice"
// with Cancel hidden while the host's question is open; and the landing's event with the way
// out, the page's camera and whether the landing shows the report.
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/project';
import { dialogBusy } from '../workbench/dialogs';
import { installWorkspaceLeaveGuard } from './leaveGuard';
import { WorkspaceOverlay } from './WorkspaceOverlay';

const SHELL = `
  <div id="app">
    <header id="top-header">
      <button type="button" id="wb-home">Home</button>
      <div class="top-right">
        <div id="queue-menu"><button type="button" id="btn-queue">Queue</button><div id="job-queue-chip" hidden></div></div>
        <button type="button" id="wb-prefs">Settings</button>
      </div>
    </header>
    <div id="workspace-overlay" hidden></div>
  </div>
  <div id="modal-confirm" class="cfd-modal" hidden><div id="cf-backdrop"></div><h2 id="cf-heading"></h2><p id="cf-copy"></p>
    <button type="button" id="cf-cancel">Cancel</button><button type="button" id="cf-confirm">OK</button></div>`;

const STUDY = { id: 'st-1', kind: 'demo', title: 'Demo 1', rev: 1, plugin: 'link-demo', plugin_name: 'Link demo', plugin_version: '1', created_at: '', updated_at: '', schema_version: 1 };
const WS_HASH = '#/p/proj/ws/link-demo/demo/st-1';
const LJOB = 'gl-mg1abc2d-0a1b2c';
const SHA_HEX = 'ab'.repeat(32);
const VIEW = { position: [400, 15, 15], target: [0, 15, 15], up: [0, 0, 1], projection: 'orthographic', height: 100 };
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

class FakeEventSource {
  static CLOSED = 2;
  static made: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) || []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close(): void {
    this.readyState = 2;
  }
}

let linkAnswer: { status: number; body: unknown } = { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true } };

beforeAll(() => {
  installWorkspaceLeaveGuard();
});

beforeEach(async () => {
  document.body.innerHTML = SHELL;
  FakeEventSource.made = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  linkAnswer = { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/plugins') {
        return json({ plugins: [{ key: 'link-demo', name: 'Link demo', status: 'enabled', workspaces: [{ key: 'demo', title: 'Demo', entry: 'workspace/index.html' }] }] });
      }
      if (url.startsWith('/api/plugin-studies/get')) return json({ study: STUDY });
      if (url.startsWith('/api/plugin-geometry/link?')) return json(linkAnswer.body, linkAnswer.status);
      if (url.startsWith('/api/plugin-geometry/status')) return json({ ok: true, job: { id: LJOB, status: 'queued', seq: 1 } });
      if (url.startsWith('/api/plugin-geometry/linked')) return json({ ok: true, linked: { geometryId: 'g1', name: 'Demo 1', rev: 1 } });
      return json({ ok: true });
    }),
  );
  window.__CFD_CONFIRM__ = vi.fn(async () => false) as unknown as typeof window.__CFD_CONFIRM__;
  window.__CFD_DIALOG_BUSY__ = () => dialogBusy();
  useProjectStore.setState({ projectId: 'proj' });
  if (location.hash !== WS_HASH) {
    const moved = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
    location.hash = WS_HASH;
    await moved;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.__CFD_CONFIRM__;
  delete window.__CFD_DIALOG_BUSY__;
});

/** The overlay with its page connected (answering the probe), the port, what the host pushed, and calls. */
async function openConnected() {
  const view = render(<WorkspaceOverlay />);
  const frame = await waitFor(() => {
    const f = document.getElementById('workspace-frame') as HTMLIFrameElement | null;
    if (!f) throw new Error('no frame yet');
    return f;
  });
  await act(async () => undefined);
  const win = frame.contentWindow as Window;
  const posted: unknown[][] = [];
  (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => {
    posted.push(a);
    const m = a[0] as { magnusim?: string; instance?: string };
    // The page answers each probe while it lives.
    if (m && m.magnusim === 'probe') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'alive', instance: m.instance }, source: win })), 0);
  };
  window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.3.0', instance: 'i1' }, source: win }));
  await waitFor(() => expect($('.ws-shell')).toHaveAttribute('data-workspace-connected', '1'));
  const port = (posted[0] as [unknown, unknown, MessagePort[]])[2][0];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const replies = new Map<number, Record<string, unknown>>();
  port.onmessage = (e: MessageEvent) => {
    const d = e.data as Record<string, unknown>;
    if (typeof d.id === 'number') replies.set(d.id, d);
    else events.push(d as { event: string; data: Record<string, unknown> });
  };
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    port.postMessage({ id, method, params });
    return () => replies.get(id);
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const got = send(method, params);
    await waitFor(() => expect(got()).toBeTruthy());
    return got() as Record<string, unknown>;
  };
  const leaveId = async () => {
    await waitFor(() => expect(events.find((e) => e.event === 'leave')).toBeTruthy());
    return String((events.find((e) => e.event === 'leave') as { data: { leave: string } }).data.leave);
  };
  return { view, frame, port, events, send, call, leaveId };
}

describe('gate:l3-guard the workspace header while the exit hook runs', () => {
  it('nothing for 400 ms; then the status line, Back disabled, Cancel and the cover; Cancel stays with no question', async () => {
    const t = await openConnected();
    await t.call('nav.leaveHook', { on: true });
    ($('[data-ws-back]') as HTMLButtonElement).click();
    await t.leaveId();
    expect($('[data-ws-leave-status]')).toBeNull();
    expect(($('[data-ws-back]') as HTMLButtonElement).disabled).toBe(true);
    // The frame turns inert in the effect after that render.
    await waitFor(() => expect(t.frame.inert).toBe(true));
    await waitFor(() => expect($('[data-ws-leave-status]')).not.toBeNull(), { timeout: 2000 });
    expect($('[data-ws-leave-status]')?.textContent).toBe('Updating the project from Demo 1…');
    expect($('[data-ws-leave-status]')?.getAttribute('role')).toBe('status');
    expect($('[data-ws-leave-cover]')).not.toBeNull();
    expect($('[data-ws-leave-background]')).toBeNull();
    const leave = await t.leaveId();
    await t.call('nav.leaveProgress', { leave, fraction: 0.4, label: 'Exporting the design' });
    await waitFor(() => expect($('[data-ws-leave-status]')?.textContent).toBe('Exporting the design'));
    // No job yet: Cancel stops the leave and its hook.
    expect($('[data-ws-leave-cancel]')?.textContent).toBe('Cancel');
    act(() => ($('[data-ws-leave-cancel]') as HTMLButtonElement).click());
    await waitFor(() => expect($('[data-ws-leave-status]')).toBeNull());
    expect(t.events.some((e) => e.event === 'leaveAbort')).toBe(true);
    expect(($('[data-ws-back]') as HTMLButtonElement).disabled).toBe(false);
    expect(t.frame.inert).toBe(false);
    expect(window.__CFD_CONFIRM__).not.toHaveBeenCalled();
    expect(location.hash).toBe(WS_HASH);
    t.view.unmount();
  });

  it('an overwrite queued offers "Continue in background" at once; it leaves, and the landing gets the way out and the camera', async () => {
    const t = await openConnected();
    await t.call('nav.leaveHook', { on: true });
    const left: Array<Record<string, unknown>> = [];
    const onLeft = (e: Event) => left.push((e as CustomEvent).detail);
    window.addEventListener('cfd:workspace-left', onLeft);
    try {
      ($('[data-ws-back]') as HTMLButtonElement).click();
      const leave = await t.leaveId();
      t.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1, token: 'tk', view: VIEW });
      await waitFor(() => expect($('[data-ws-leave-background]')).not.toBeNull(), { timeout: 3000 });
      expect($('[data-ws-leave-status]')?.textContent).toBe('Queued (see Queue)');
      // The job goes on whatever happens: the header's other button only keeps the workspace.
      expect($('[data-ws-leave-cancel]')?.textContent).toBe('Stay here');
      act(() => ($('[data-ws-leave-background]') as HTMLButtonElement).click());
      await waitFor(() => expect(location.hash).toBe('#/p/proj'));
      t.view.unmount();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ projectId: 'proj', plugin: 'link-demo', studyId: 'st-1', reason: 'back', geometryId: 'g1', jobId: LJOB, view: VIEW, report: true, background: true });
      expect(leave).toMatch(/^leave-/);
    } finally {
      window.removeEventListener('cfd:workspace-left', onLeft);
      location.hash = WS_HASH;
    }
  });

  it("while the host's question is open: \"Waiting for your choice\" and no Cancel in the header", async () => {
    linkAnswer = {
      status: 202,
      body: {
        ok: true,
        job_id: LJOB,
        geometry_id: 'g1',
        created: false,
        queued: false,
        choosing: { geometry: { id: 'g1', name: 'Demo 1' }, study: { id: 'st-1', title: 'Demo 1' }, new_name: 'Demo 1 v2', studies: [{ id: 's1', title: 'Study 1', copy: 'ok' }], overwrite: 'ok' },
      },
    };
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="modal-link-choice" class="cfd-modal" hidden><div id="lc-backdrop"></div><h2 id="lc-heading"></h2><p id="lc-copy"></p><button id="lc-new"></button><p id="lc-new-line"></p><div id="lc-copies"></div><button id="lc-overwrite"></button><p id="lc-overwrite-line"></p><button id="lc-cancel"></button></div>',
    );
    const t = await openConnected();
    await t.call('nav.leaveHook', { on: true });
    ($('[data-ws-back]') as HTMLButtonElement).click();
    await t.leaveId();
    const linked = t.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1, token: 'tk' });
    await waitFor(() => expect($('#modal-link-choice')?.hidden).toBe(false), { timeout: 3000 });
    await waitFor(() => expect($('[data-ws-leave-status]')?.textContent).toBe('Waiting for your choice'), { timeout: 3000 });
    expect($('[data-ws-leave-cancel]')).toBeNull();
    expect($('[data-ws-leave-background]')).toBeNull();
    // Keep editing: the leave is over at once, the workspace stays, no question.
    act(() => ($('#lc-cancel') as HTMLButtonElement).click());
    await waitFor(() => expect($('[data-ws-leave-status]')).toBeNull());
    expect(($('[data-ws-back]') as HTMLButtonElement).disabled).toBe(false);
    expect(location.hash).toBe(WS_HASH);
    expect(window.__CFD_CONFIRM__).not.toHaveBeenCalled();
    expect(linked()).toBeUndefined();
    t.view.unmount();
  });
});

describe('gate:l3-guard the workspace header and landing: review fixes', () => {
  it('a hook that linked nothing: the landing still gets the way out and its camera, with no geometry and no report', async () => {
    const t = await openConnected();
    await t.call('nav.leaveHook', { on: true });
    const left: Array<Record<string, unknown>> = [];
    const onLeft = (e: Event) => left.push((e as CustomEvent).detail);
    window.addEventListener('cfd:workspace-left', onLeft);
    try {
      ($('[data-ws-back]') as HTMLButtonElement).click();
      const leave = await t.leaveId();
      await t.call('nav.leaveDone', { leave, ok: true, view: VIEW });
      await waitFor(() => expect(location.hash).toBe('#/p/proj'));
      t.view.unmount();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ projectId: 'proj', plugin: 'link-demo', studyId: 'st-1', reason: 'back', view: VIEW, report: false, background: false });
      expect(left[0].geometryId).toBeUndefined();
      expect(left[0].jobId).toBeUndefined();
    } finally {
      window.removeEventListener('cfd:workspace-left', onLeft);
      location.hash = WS_HASH;
    }
  });

  it('the link went through, then the hook failed: the question says so, and on Stay the report held back shows', async () => {
    linkAnswer = { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false } };
    const asked: Array<{ title: string; copy: string }> = [];
    window.__CFD_CONFIRM__ = vi.fn(async (q: { title: string; copy: string }) => {
      asked.push({ title: q.title, copy: q.copy });
      return false;
    }) as unknown as typeof window.__CFD_CONFIRM__;
    const t = await openConnected();
    await t.call('nav.leaveHook', { on: true });
    ($('[data-ws-back]') as HTMLButtonElement).click();
    const leave = await t.leaveId();
    const linked = t.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1, token: 'tk' });
    const es = await waitFor(() => {
      const found = FakeEventSource.made.find((e) => e.url.startsWith('/api/plugin-geometry/events'));
      if (!found) throw new Error('no link stream yet');
      return found;
    });
    await waitFor(() => expect($('[data-ws-leave-cancel]')?.textContent).toBe('Stay here'), { timeout: 3000 });
    expect($('[data-ws-leave-cancel]')?.getAttribute('title')).toBe('The update goes on; the workspace stays open');
    es.emit('link', {
      job_id: LJOB,
      seq: 3,
      ev: {
        event: 'end',
        status: 'done',
        result: { geometryId: 'g1', name: 'Demo 1', rev: 2, change: 'shape', lost: [], returned: [], claimedTwice: [], match: { byName: 1, byShape: 0, split: 1, merged: 0, movedFar: 0 } },
        // A record's face split: worth the report.
        setup: { movedFar: [], split: [{ studyId: 's1', studyTitle: 'Study 1', kind: 'bc', item: 'Wall', field: 'faces', old: 'face 12@Body1', name: 'F:box:+y', label: 'Box +y', faces: 2 }], merged: [], stale: [] },
      },
    });
    await waitFor(() => expect(linked()).toBeTruthy());
    // Inside the leave the report waits.
    expect(asked).toEqual([]);
    await t.call('nav.leaveDone', { leave, ok: false, message: 'The thumbnail failed' });
    await waitFor(() => expect(asked.length).toBe(2));
    expect(asked[0]).toEqual({ title: "Couldn't update the project", copy: 'Link demo: The thumbnail failed. Demo 1 was updated.' });
    expect(asked[1].title).toBe('Demo 1 updated');
    expect(location.hash).toBe(WS_HASH);
    t.view.unmount();
  });
});

// Exit-sync fixes (the CAD review of 2026-10-04): an update that touched none of the user's
// setup shows no dialog; one that only put a mesh out of date is a toast.
describe('exit-sync fixes: the report of a link the page makes while it stays open', () => {
  it('no record touched: no dialog; a mesh out of date: a toast in the workspace; a record touched: the dialog names it', async () => {
    linkAnswer = { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true, waiting: false } };
    const asked: Array<{ title: string; copy: string }> = [];
    window.__CFD_CONFIRM__ = vi.fn(async (q: { title: string; copy: string }) => {
      asked.push({ title: q.title, copy: q.copy });
      return true;
    }) as unknown as typeof window.__CFD_CONFIRM__;
    const t = await openConnected();
    const base = { geometryId: 'g1', name: 'Demo 1', rev: 2, change: 'shape', lost: [], returned: [], claimedTwice: [], match: { byName: 21, byShape: 0, split: 0, merged: 0, movedFar: 6 } };
    const none = { movedFar: [], split: [], merged: [], stale: [] };
    const linkOnce = async (seq: number, result: Record<string, unknown>, setup: Record<string, unknown>) => {
      const linked = t.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: seq, basedOnRev: 1, token: `tk${seq}` });
      const es = await waitFor(() => {
        const found = FakeEventSource.made.find((e) => e.url.startsWith('/api/plugin-geometry/events'));
        if (!found) throw new Error('no link stream yet');
        return found;
      });
      await waitFor(() => expect(fetchedLinks()).toBeGreaterThanOrEqual(seq - 1));
      es.emit('link', { job_id: LJOB, seq: seq * 10, ev: { event: 'end', status: 'done', result, setup } });
      await waitFor(() => expect(linked()).toBeTruthy());
    };
    await linkOnce(2, base, none);
    await act(async () => undefined);
    expect(asked).toEqual([]);
    expect($('[data-ws-toast]')).toBeNull();
    t.view.unmount();
    // Again on a fresh page: a mesh out of date is said quietly.
    const t2 = await openConnected();
    const meshes = { ...base, outOfDate: { meshes: [{ studyId: 's1', studyTitle: 'Study 1', meshId: 'm1', meshName: 'Mesh 1' }], runs: 0 } };
    const linked = t2.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 3, basedOnRev: 1, token: 'tk3' });
    // This page's own link stream (the first page's went with it).
    const es2 = await waitFor(() => {
      const all = FakeEventSource.made.filter((e) => e.url.startsWith('/api/plugin-geometry/events'));
      if (all.length < 2) throw new Error('no link stream yet');
      return all[all.length - 1];
    });
    await waitFor(() => expect(fetchedLinks()).toBeGreaterThanOrEqual(2));
    es2.emit('link', { job_id: LJOB, seq: 30, ev: { event: 'end', status: 'done', result: meshes, setup: none } });
    await waitFor(() => expect(linked()).toBeTruthy());
    await waitFor(() => expect($('[data-ws-toast]')?.textContent).toContain('Demo 1 updated. Out of date: Mesh 1. Generate it again before you run.'));
    expect(asked).toEqual([]);
    // A record's face moved far: the dialog, naming the record and the face.
    const wall = { studyId: 's1', studyTitle: 'Study 1', kind: 'bc', item: 'Side wall', field: 'faces', old: 'face 15@Body1', name: 'F:boss:end', label: 'Boss end' };
    const job3 = 'gl-mg1abc2d-0a1b2d';
    linkAnswer = { status: 202, body: { ok: true, job_id: job3, geometry_id: 'g1', created: false, queued: true, waiting: false } };
    const linked3 = t2.send('project.linkGeometry', { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 4, basedOnRev: 2, token: 'tk4' });
    await waitFor(() => expect(fetchedLinks()).toBeGreaterThanOrEqual(3));
    es2.emit('link', { job_id: job3, seq: 40, ev: { event: 'end', status: 'done', result: { ...base, rev: 3 }, setup: { ...none, movedFar: [wall] } } });
    await waitFor(() => expect(linked3()).toBeTruthy());
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toEqual({
      title: 'Demo 1 updated',
      copy: "Boundary conditions, refinements and monitors kept their faces by name.\nKept by name but moved far: Study 1 › Side wall ('Boss end'). Check it.",
    });
    t2.view.unmount();
  });
});

function fetchedLinks(): number {
  const f = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return f.mock.calls.filter((c) => String(c[0]).startsWith('/api/plugin-geometry/link?')).length;
}
