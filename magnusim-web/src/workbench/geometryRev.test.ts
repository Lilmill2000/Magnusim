import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindGeometryRevHost,
  canPickInto,
  fetchLinkedSave,
  linkJobOf,
  linkedWorkerRpc,
  noteTreeGeometries,
  resetGeometryRevForTests,
  shownGeometryRev,
  stampRecords,
  subscribeLinkedGeometries,
  withGeometryRev,
} from './geometryRev';

const confirmAction = vi.fn(async () => true);
vi.mock('./dialogs', () => ({ confirmAction: (o: unknown) => confirmAction(o as never) }));

class FakeEventSource {
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

const SRC = { plugin: 'link-demo', study_id: 'st-1', workspace: 'demo' };

beforeEach(() => {
  resetGeometryRevForTests();
  confirmAction.mockClear();
  FakeEventSource.made = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the rev a tab shows, and the stamp on its saves', () => {
  it('stamps a save with the record\'s own rev, else the shown rev; nothing for a geometry no link made', () => {
    bindGeometryRevHost({ activeGeometryId: () => 'g1' });
    expect(withGeometryRev({ a: 1 })).toEqual({ a: 1 });
    noteTreeGeometries('p1', [{ id: 'g1', rev: 3, names8: 'abcd1234', source: SRC }, { id: 'g2', name: 'Plate' }]);
    expect(shownGeometryRev()).toBe(3);
    expect(shownGeometryRev('g2')).toBeNull();
    expect(withGeometryRev({ a: 1 })).toEqual({ a: 1, geometry_rev: 3 });
    expect(withGeometryRev({ a: 1 }, { geometry_rev: 2 })).toEqual({ a: 1, geometry_rev: 2 });
    expect(withGeometryRev({ a: 1 }, null, 'g2')).toEqual({ a: 1 });
    expect(stampRecords([{ id: 'x' }, { id: 'y', geometry_rev: 2 }])).toEqual([
      { id: 'x', geometry_rev: 3 },
      { id: 'y', geometry_rev: 2 },
    ]);
  });

  it('picks into a record only at the shown rev (no stamp counts as shown)', () => {
    bindGeometryRevHost({ activeGeometryId: () => 'g1' });
    noteTreeGeometries('p1', [{ id: 'g1', rev: 3, source: SRC }]);
    expect(canPickInto({ geometry_rev: 3 })).toBe(true);
    expect(canPickInto({})).toBe(true);
    expect(canPickInto({ geometry_rev: 2 })).toBe(false);
    expect(canPickInto(null)).toBe(true);
  });

  it('a second tab: a changed rev or names loads the geometry again once, and only then is it shown at the new rev', async () => {
    let release: () => void = () => undefined;
    const reload = vi.fn(() => new Promise<void>((r) => (release = r)));
    bindGeometryRevHost({ activeGeometryId: () => 'g1', reloadGeometry: reload });
    noteTreeGeometries('p1', [{ id: 'g1', rev: 1, names8: 'aaaa', source: SRC }]);
    expect(reload).not.toHaveBeenCalled();
    noteTreeGeometries('p1', [{ id: 'g1', rev: 2, names8: 'bbbb', source: SRC }]);
    noteTreeGeometries('p1', [{ id: 'g1', rev: 2, names8: 'bbbb', source: SRC }]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('g1', '1-aaaa');
    // Saves made while it reloads are still drawn at rev 1 (the server refuses them).
    expect(shownGeometryRev('g1')).toBe(1);
    release();
    await vi.waitFor(() => expect(shownGeometryRev('g1')).toBe(2));
    // A names-only update (same rev) reloads too; a fence that ends does.
    noteTreeGeometries('p1', [{ id: 'g1', rev: 2, names8: 'cccc', source: SRC }]);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("follows each linked geometry's study on its link events: the row's job state, and a tree read when one ends", () => {
    const changes = vi.fn();
    subscribeLinkedGeometries(changes);
    const sync = vi.fn();
    window.addEventListener('cfd:tree-sync', sync);
    try {
      noteTreeGeometries('p1', [{ id: 'g1', rev: 1, source: SRC }, { id: 'g0', rev: 4, unlinked: true, source: SRC }]);
      expect(FakeEventSource.made.map((e) => e.url)).toEqual(['/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1']);
      const es = FakeEventSource.made[0];
      es.emit('link', { job_id: 'gl-x', seq: 1, ev: { event: 'queued', ahead: 1 } });
      expect(linkJobOf('g1')).toEqual({ status: 'queued', stage: null, label: null, jobId: 'gl-x', adding: null });
      es.emit('link', { job_id: 'gl-x', seq: 2, ev: { event: 'stage', stage: 'waiting', label: "Waiting for another program to release Demo 1's files" } });
      expect(linkJobOf('g1')?.label).toBe("Waiting for another program to release Demo 1's files");
      es.emit('link', { job_id: 'gl-x', seq: 3, ev: { event: 'end', status: 'done' } });
      expect(linkJobOf('g1')).toBeNull();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(changes).toHaveBeenCalled();
      // Another project: the streams of the last one close.
      noteTreeGeometries('p2', []);
      expect(es.readyState).toBe(2);
    } finally {
      window.removeEventListener('cfd:tree-sync', sync);
    }
  });

  it("a page opened while an update is queued or running shows it from the stream's snapshot; a question waiting shows as choosing", () => {
    noteTreeGeometries('p1', [{ id: 'g1', rev: 1, source: SRC }]);
    const es = FakeEventSource.made[0];
    es.emit('snapshot', { jobs: [{ id: 'gl-old', status: 'done' }, { id: 'gl-q', status: 'queued', stage: null }] });
    expect(linkJobOf('g1')).toEqual({ status: 'queued', stage: null, label: null, jobId: 'gl-q', adding: null });
    es.emit('snapshot', { jobs: [{ id: 'gl-r', status: 'running', stage: 'meshing' }] });
    expect(linkJobOf('g1')).toMatchObject({ status: 'running', stage: 'meshing', jobId: 'gl-r' });
    es.emit('snapshot', { jobs: [{ id: 'gl-n', status: 'running', stage: 'saving', saveAsNew: true, geometryName: 'Demo 1 v2' }] });
    expect(linkJobOf('g1')).toMatchObject({ status: 'running', adding: 'Demo 1 v2' });
    const question = { geometry: { id: 'g1', name: 'Demo 1' }, study: { id: 'st-1', title: 'Demo 1' }, new_name: 'Demo 1 v2', studies: [], overwrite: 'ok' };
    es.emit('snapshot', { jobs: [{ id: 'gl-c', status: 'choosing', choosing: question }] });
    expect(linkJobOf('g1')).toMatchObject({ status: 'choosing', jobId: 'gl-c' });
    es.emit('snapshot', { jobs: [{ id: 'gl-old', status: 'done' }] });
    expect(linkJobOf('g1')).toBeNull();
  });

  it('a fenced geometry: its recovery\'s event, and a snapshot while it is shown updating (a stream back after a restart), read the tree again', () => {
    const sync = vi.fn();
    window.addEventListener('cfd:tree-sync', sync);
    try {
      noteTreeGeometries('p1', [{ id: 'g1', rev: 1, source: SRC }]);
      const es = FakeEventSource.made[0];
      es.emit('snapshot', { jobs: [] });
      expect(sync).not.toHaveBeenCalled();
      noteTreeGeometries('p1', [{ id: 'g1', rev: 1, updating: true, source: SRC }]);
      es.emit('snapshot', { jobs: [{ id: 'gl-f', status: 'failed' }] });
      expect(sync).toHaveBeenCalledTimes(1);
      es.emit('link', { job_id: 'gl-f', seq: 9, ev: { event: 'recovered', geometry_id: 'g1' } });
      expect(sync).toHaveBeenCalledTimes(2);
      expect(linkJobOf('g1')).toBeNull();
    } finally {
      window.removeEventListener('cfd:tree-sync', sync);
    }
  });
});

describe('the refusals of a save', () => {
  it('waits Retry-After on 503 geometry_updating and sends once more', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'geometry_updating', error: 'Updating Demo 1. Try again in a moment.' }), { status: 503, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchLinkedSave('/api/bcs', { method: 'POST', body: '{}' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await p).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("a 503 geometry_updating again after the wait is not saved, and says so in the server's words (fetch and worker paths)", async () => {
    vi.useFakeTimers();
    const updating = () =>
      new Response(JSON.stringify({ ok: false, code: 'geometry_updating', error: 'Updating Demo 1. Try again in a moment.' }), { status: 503, headers: { 'Retry-After': '2' } });
    const fetchMock = vi.fn(async () => updating());
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchLinkedSave('/api/bcs', { method: 'POST', body: '{}' });
    await vi.advanceTimersByTimeAsync(2001);
    expect((await p).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not saved', copy: 'Updating Demo 1. Try again in a moment.', notice: true }));
    const w = linkedWorkerRpc('bcs.set', { project_id: 'p1' });
    const failed = expect(w).rejects.toMatchObject({ code: 'geometry_updating' });
    await vi.advanceTimersByTimeAsync(2001);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(confirmAction).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Not saved', copy: 'Updating Demo 1. Try again in a moment.', notice: true }));
  });

  it('says "<Geometry> was updated. This change was not saved." on 409 geometry_changed, and loads the geometry again', async () => {
    const reload = vi.fn(async () => undefined);
    bindGeometryRevHost({ activeGeometryId: () => 'g1', reloadGeometry: reload });
    noteTreeGeometries('p1', [{ id: 'g1', rev: 1, source: SRC }]);
    const body = { ok: false, code: 'geometry_changed', error: 'Demo 1 was updated. This change was not saved.' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })));
    const r = await fetchLinkedSave('/api/materials', { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ copy: 'Demo 1 was updated. This change was not saved.', notice: true }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith('g1', '1-'));
    // The worker path (bcs.set and materials.set) says the same and rejects with the code.
    await expect(linkedWorkerRpc('bcs.set', { project_id: 'p1' })).rejects.toMatchObject({ code: 'geometry_changed' });
    expect(confirmAction).toHaveBeenCalledTimes(2);
  });
});
