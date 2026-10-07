// @vitest-environment node
// L3 (host API 1.6): the exit hook over the real link controller and a scripted
// host. What the app gets back from each leave: the camera (ViewState), the
// skip when nothing changed, nothing included (a toast, the leave goes on),
// Keep editing (quiet), a refused link (a throw: the app's "Couldn't update the
// project" with CAD's message), the signal, typed text kept for the app's own
// question, the stall heartbeat, and registration on 1.6 / 1.5 hosts.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeaveEvent, LeaveHandler, LinkedGeometry, LinkOptions, LinkResult } from '@magnusim/workspace';
import { createLinkController } from '../../src/link/controller';
import { createLeaveHandler, installLeaveHook, SAVE_STUCK_MS, viewStateOf } from '../../src/link/leave';
import { createBridge, type Bridge } from '../../src/lib/bridge';
import { createStateStore } from '../../src/lib/store';
import { pendingEditsChanged, registerPendingEdit } from '../../src/lib/pendingEdits';
import type { CadDoc, SavedCamera } from '../../src/types/doc';
import type { DocService, DocState, EndBodies } from '../../src/types/doc-service';
import type { KernelAdapter } from '../../src/types/kernel';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

const DOC: CadDoc = {
  schema: 2,
  units: { length: 'mm', angle: 'deg' },
  params: [],
  bodies: { b1: { name: 'Body 1', color: '#bdc9db' } },
  features: [{ id: 'f1', type: 'extrude', name: 'Extrude 1' } as unknown as CadDoc['features'][number]],
  meta: { created_at: 'x', written_by: 'test' },
};

const CAM: SavedCamera = { position: [120, -340, 90], target: [10, 5, 7], up: [0, 0, 1], orthoHeight: 88, projection: 'perspective' };

function linked(rev: number, sourceVersion: number): LinkedGeometry {
  return { geometryId: 'g1', name: 'Part 1', rev, sourceVersion, shapeSha256: 'a'.repeat(64), namesSha256: null, syncedAt: 'now', state: 'ok', error: null, lostFaces: 0 };
}

function result(over: Partial<LinkResult> = {}): LinkResult {
  return {
    geometryId: 'g1',
    name: 'Part 1',
    rev: 1,
    fromRev: null,
    created: true,
    change: 'shape',
    bodies: 1,
    faces: 6,
    named: 6,
    match: { byName: 0, byShape: 0, split: 0, merged: 0, movedFar: 0 },
    lost: [],
    returned: [],
    stillLost: 0,
    claimedTwice: [],
    outOfDate: { meshes: [], runs: 0 },
    seconds: 0.1,
    ...over,
  };
}

const refused = (code: string, message = `refused ${code}`) => Object.assign(new Error(message), { code });

interface Setup {
  version?: number;
  linked?: LinkedGeometry | null;
  answers?: (LinkResult | Error)[];
  bodies?: CadDoc['bodies'];
  end?: Partial<EndBodies>;
  status?: DocState['status'];
  camera?: SavedCamera | null;
  /** Wait inside bodiesAtEnd (ms). */
  slowExport?: number;
  /** How long the no-body message holds the leave (ms; 30 by default here). */
  nothingMs?: number;
  /** When a save on its way ends the hook (ms; SAVE_STUCK_MS by default). */
  stuckMs?: number;
  onLink?(o: LinkOptions): void;
}

function setup(opts: Setup = {}) {
  const state = createStateStore<DocState>({
    status: opts.status ?? 'ready',
    error: null,
    doc: { ...DOC, bodies: opts.bodies ?? DOC.bodies },
    view: { rollback: null, hiddenBodies: [], expanded: [] },
    rebuild: { status: 'done', seq: 1, features: {}, bodies: [], outputs: {}, ms: 1, message: null },
    save: { state: 'saved', at: 'now' },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    session: null,
    sourceVersion: opts.version ?? 4,
  });
  const end: EndBodies = { bodies: [{ id: 'b1', shape: 7, valid: true, feature: 'f1', names: { faces: ['F:f1:end', 'F:f1:start', 'F:f1:side:a', 'F:f1:side:b', 'F:f1:side:c', 'F:f1:side:d'] }, name: 'Body 1', color: '#bdc9db' }], failed: [], ...opts.end };
  const dirty: { dirty: boolean; message?: string }[] = [];
  const retold = vi.fn(async () => {});
  const doc = {
    state,
    flush: vi.fn(async () => {}),
    bodiesAtEnd: vi.fn(async () => {
      if (opts.slowExport) await new Promise((r) => setTimeout(r, opts.slowExport));
      return end;
    }),
    retellDirty: retold,
  } as unknown as DocService;
  const kernel = {
    call: vi.fn(async () => ({
      result: { bytes: 3, occt: '7.9.3', format_version: 4, solids: [{ src: 0, piece: 1, faces: 6 }], empty: [], visit_body: [1, 1, 1, 1, 1, 1], visit_face: [0, 1, 2, 3, 4, 5], timings: {} },
      buffers: { brep: new Uint8Array([1, 2, 3]).buffer },
    })),
  } as unknown as KernelAdapter;
  const answers = [...(opts.answers ?? [result()])];
  let linkedNow: LinkedGeometry | null = opts.linked ?? null;
  const calls: LinkOptions[] = [];
  const writes: string[] = [];
  const toasts: [string, string][] = [];
  const bridge = {
    studyId: 's1',
    context: { study: { title: 'Part 1' } },
    files: {
      write: vi.fn(async (rel: string) => {
        writes.push(rel);
        return { rel, size: 1, mtime: 'x', etag: 'e', sha256: rel.endsWith('.json') ? 'b'.repeat(64) : 'c'.repeat(64) };
      }),
    },
    setDirtyNow: vi.fn(async (d: boolean, m?: string) => {
      dirty.push({ dirty: d, ...(m ? { message: m } : {}) });
    }),
    toast: (m: string, k: string) => toasts.push([m, k]),
    link: {
      linkGeometry: vi.fn(async (o: LinkOptions) => {
        calls.push(o);
        o.onProgress?.({ stage: 'reading', fraction: 0.5 } as Parameters<NonNullable<LinkOptions['onProgress']>>[0]);
        opts.onLink?.(o);
        const a = answers.shift();
        if (!a) throw refused('failed', 'no answer scripted');
        if (a instanceof Error) throw a;
        linkedNow = linked(a.rev, o.sourceVersion);
        return a;
      }),
      linkedGeometry: vi.fn(async () => linkedNow),
      onGeometry: () => () => {},
    },
    onLeave: null,
  } as unknown as Bridge;
  const link = createLinkController({ bridge, doc, kernel, busyWaitMs: 1, log: () => {} });
  const outcomes: unknown[] = [];
  const handler = createLeaveHandler({
    bridge,
    doc,
    link,
    camera: () => (opts.camera === undefined ? CAM : opts.camera),
    onOutcome: (o) => outcomes.push(o),
    heartbeatMs: 20,
    nothingShownMs: opts.nothingMs ?? 30,
    ...(opts.stuckMs ? { saveStuckMs: opts.stuckMs } : {}),
    log: () => {},
  });
  const progress: [number | null, string | undefined][] = [];
  const ctl = new AbortController();
  const leave = (over: Partial<LeaveEvent> = {}) =>
    handler({
      reason: 'back',
      signal: ctl.signal,
      progress: (f, l) => {
        progress.push([f, l]);
      },
      ...over,
    });
  return { leave, handler, ctl, calls, writes, toasts, dirty, retold, progress, outcomes, doc, state, link, kernel };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('viewStateOf: the Part camera as the app reads it', () => {
  it('perspective: model mm, Z up, the vertical fovDeg (30)', () => {
    expect(viewStateOf(CAM)).toEqual({ position: [120, -340, 90], target: [10, 5, 7], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 });
  });
  it('orthographic: the full visible height at the target, no fovDeg', () => {
    expect(viewStateOf({ ...CAM, projection: 'orthographic' })).toEqual({ position: [120, -340, 90], target: [10, 5, 7], up: [0, 0, 1], projection: 'orthographic', height: 88 });
  });
  it('no view from a camera that is not one: none yet, NaN, the position on the target, no height', () => {
    expect(viewStateOf(null)).toBeNull();
    expect(viewStateOf({ ...CAM, position: [Number.NaN, 0, 0] })).toBeNull();
    expect(viewStateOf({ ...CAM, position: [10, 5, 7] })).toBeNull();
    expect(viewStateOf({ ...CAM, projection: 'orthographic', orthoHeight: 0 })).toBeNull();
  });
});

describe('the exit hook', () => {
  it('a first exit: saves, links with the typed text kept, reports progress, and returns ok with the camera', async () => {
    const t = setup();
    const out = await t.leave();
    expect(out).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].sourceVersion).toBe(4);
    // The same camera goes with the link: after "Continue in background" only this one lands.
    expect(t.calls[0].view).toEqual(viewStateOf(CAM));
    expect(t.progress.map((p) => p[1])).toEqual(expect.arrayContaining(['Saving Part 1', 'Exporting Part 1', 'Writing Part 1 for the project', 'The app is reading the part']));
    expect(t.progress).toContainEqual([0.5, 'The app is reading the part']);
    // The app heard "clean" for the link, then the page's own state again.
    expect(t.dirty[0]).toEqual({ dirty: false });
    expect(t.retold).toHaveBeenCalledTimes(1);
    expect(t.toasts).toEqual([]);
  });

  it('nothing changed: no export, no write, no link; it returns the camera', async () => {
    const t = setup({ version: 4, linked: linked(2, 4) });
    expect(await t.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(t.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.doc.bodiesAtEnd).not.toHaveBeenCalled();
    expect(t.kernel.call).not.toHaveBeenCalled();
  });

  it('no body included: no link; the plain message as the header line only (no page toast), held to be read; then the leave goes on (with the camera)', async () => {
    const t = setup({ bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } as CadDoc['bodies'], linked: linked(1, 2) });
    const t0 = performance.now();
    expect(await t.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(24); // a timer may land a fraction of a ms early on this clock
    expect(t.calls).toEqual([]);
    // L3 review polish 3: the toast said it a second time and covered the view controls.
    expect(t.toasts).toEqual([]);
    expect(t.progress.at(-1)).toEqual([null, 'No body is included in the simulation; Part 1 keeps its last update.']);
  });

  it('a broken Axis nothing uses: the header says it is left out before the export, held to be read, then the Part is linked (Daniel, 2026-10-05)', async () => {
    const t = setup({ version: 5, linked: linked(2, 4), end: { failed: ['Axis 5'] } });
    (t.doc as { features: unknown }).features = { get: () => ({ parents: () => [] }) };
    t.state.set({ doc: { ...DOC, features: [...DOC.features, { id: 'f_ax', type: 'ref_axis', name: 'Axis 5' } as unknown as CadDoc['features'][number]] } });
    const t0 = performance.now();
    expect(await t.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(24); // a timer may land a fraction of a ms early on this clock
    expect(t.calls).toHaveLength(1);
    const labels = t.progress.map((p) => p[1]);
    const at = labels.indexOf('Axis 5 is broken (not used by anything). Part 1 is updated without it.');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(labels.indexOf('Exporting Part 1') < 0 ? labels.length : labels.lastIndexOf('Writing Part 1 for the project'));
    expect(t.toasts).toEqual([]);
  });

  it('an empty Part never linked: nothing to say, it leaves at once', async () => {
    const t = setup({ end: { bodies: [] } });
    expect(await t.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(t.toasts).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('Cancel while the no-body message shows: the Part stays (no camera)', async () => {
    const t = setup({ nothingMs: 10_000, bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } as CadDoc['bodies'], linked: linked(1, 2) });
    const p = t.leave();
    await vi.waitFor(() => expect(t.progress.at(-1)?.[1]).toBe('No body is included in the simulation; Part 1 keeps its last update.'));
    t.ctl.abort();
    expect(await p).toEqual({ ok: true });
    expect(t.toasts).toEqual([]);
  });

  it('a refused save when nothing would be linked: ok, and the page is dirty again, so the app asks its own "Leave without saving?" (L3 review polish 1)', async () => {
    const t = setup({ bodies: {} });
    t.state.set({ save: { state: 'error', message: 'the disk is full' } });
    expect(await t.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(t.retold).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual([]);
    expect(t.toasts).toEqual([]);
    // A linked Part: the app's "Couldn't update the project", with the reason alone.
    const linkedPart = setup({ linked: linked(1, 2) });
    linkedPart.state.set({ save: { state: 'error', message: 'the disk is full' } });
    await expect(linkedPart.leave()).rejects.toThrow(/^Saving failed: the disk is full\.$/);
  });

  it('a save that does not land: CAD gives up with its own words at SAVE_STUCK_MS, before the app stall question (L3 review polish 2)', async () => {
    expect(SAVE_STUCK_MS).toBe(25_000);
    const t = setup({ stuckMs: 2_000 });
    let land!: () => void;
    (t.doc.flush as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (land = r)));
    const t0 = performance.now();
    await expect(t.leave()).rejects.toThrow(/^Part 1 is still saving after 2 seconds\.$/);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_899);
    expect(t.outcomes.at(-1)).toMatchObject({ error: 'Part 1 is still saving after 2 seconds.' });
    // A save that lands in time never meets it.
    const quick = setup({ stuckMs: 2_000 });
    expect(await quick.leave()).toEqual({ ok: true, view: viewStateOf(CAM) });
    land();
  });

  it('Keep editing in the app question (cancelled): returns quietly, no camera, no toast, no throw', async () => {
    const t = setup({ answers: [refused('cancelled', 'You kept editing. Nothing changed.')] });
    expect(await t.leave()).toEqual({ ok: true });
    expect(t.toasts).toEqual([]);
  });

  it('a refused link throws CAD message (the app asks "Couldn\'t update the project" with it)', async () => {
    const failed = setup({ end: { failed: ['Combine 1'] }, linked: linked(1, 2) });
    // The reason alone: the app adds "Part 1 keeps its last update." to its question itself.
    await expect(failed.leave()).rejects.toThrow(/^Combine 1 failed to build\. Fix, retry or suppress it first\.$/);
    expect(failed.calls).toEqual([]);
    const plugin = setup({ answers: [refused('plugin_needed', 'Records of Demo porous come from a plugin that is off or not installed.')] });
    await expect(plugin.leave()).rejects.toThrow('Records of Demo porous come from a plugin that is off or not installed.');
    expect(plugin.toasts).toEqual([]);
  });

  it('the signal: aborted before it starts, nothing is done; aborted during the link, it returns quietly', async () => {
    const before = setup();
    before.ctl.abort();
    expect(await before.leave()).toEqual({ ok: true });
    expect(before.calls).toEqual([]);
    expect(before.doc.flush).not.toHaveBeenCalled();
    const during = setup({ slowExport: 30 });
    const p = during.leave();
    await new Promise((r) => setTimeout(r, 5));
    during.ctl.abort();
    expect(await p).toEqual({ ok: true });
    expect(during.calls).toEqual([]);
    expect(during.writes).toEqual([]);
  });

  it('typed text not applied stays in its field: the saved design is linked, and the page is dirty again for the app question', async () => {
    let text = '15';
    const commit = vi.fn(() => {
      text = '';
    });
    const off = registerPendingEdit({ label: 'Distance', pending: () => text !== '', error: () => null, commit, commitQuiet: commit });
    try {
      const t = setup();
      const out = await t.leave();
      expect(out.ok).toBe(true);
      expect(commit).not.toHaveBeenCalled();
      expect(text).toBe('15');
      expect(t.calls).toHaveLength(1);
      expect(t.retold).toHaveBeenCalledTimes(1);
      // A sync of its own (no leave) still applies it first, as Enter would.
      const own = setup({ version: 5, linked: linked(1, 4) });
      await own.link.sync({ notify: false });
      expect(commit).toHaveBeenCalled();
    } finally {
      off();
      pendingEditsChanged();
    }
  });

  it('a slow export says its last progress again (the app stall clock never sees 30 s of silence); a save that waits is not repeated', async () => {
    const t = setup({ slowExport: 120 });
    await t.leave();
    const exporting = t.progress.filter((p) => p[1] === 'Exporting Part 1');
    expect(exporting.length).toBeGreaterThan(2);
    // A save on its way: "Saving Part 1" once, so a save that never lands still meets the app's stall question.
    const saving = setup();
    let land!: () => void;
    (saving.doc.flush as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (land = r)));
    const p = saving.leave();
    await new Promise((r) => setTimeout(r, 120));
    expect(saving.progress.filter((x) => x[1] === 'Saving Part 1')).toHaveLength(1);
    land();
    await p;
  });

  it('a leave cancelled while its save waits, then another leave: the second takes the sync over (the header says "Saving Part 1" again) and links once', async () => {
    const t = setup();
    let land!: () => void;
    (t.doc.flush as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((r) => (land = r)));
    const first = t.leave();
    await vi.waitFor(() => expect(t.progress).toContainEqual([null, 'Saving Part 1']));
    t.ctl.abort();
    const ctl2 = new AbortController();
    const said: (string | undefined)[] = [];
    const second = t.handler({ reason: 'home', signal: ctl2.signal, progress: (_f, l) => void said.push(l) });
    await vi.waitFor(() => expect(said).toEqual(['Saving Part 1']));
    land();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true, view: viewStateOf(CAM) });
    expect(t.calls).toHaveLength(1);
    // The second leave's camera goes with the link it took over.
    expect(t.calls[0].view).toEqual(viewStateOf(CAM));
  });

  it('a Part that never loaded: nothing to sync, the leave goes on at once', async () => {
    const t = setup({ status: 'loading' });
    expect(await t.leave()).toEqual({ ok: true });
    expect(t.doc.flush).not.toHaveBeenCalled();
    expect(t.calls).toEqual([]);
  });

  it('no viewport yet: ok without a camera', async () => {
    const t = setup({ camera: null, linked: linked(1, 4) });
    expect(await t.leave()).toEqual({ ok: true });
  });

  it('no viewport yet, with a design to link: it links with no view (the app keeps its own camera)', async () => {
    const t = setup({ camera: null });
    expect(await t.leave()).toEqual({ ok: true });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).not.toHaveProperty('view');
  });

  it('an orthographic camera goes on the link as the full visible height', async () => {
    const t = setup({ camera: { ...CAM, projection: 'orthographic' } });
    const out = await t.leave();
    expect(out.view).toEqual({ position: [120, -340, 90], target: [10, 5, 7], up: [0, 0, 1], projection: 'orthographic', height: 88 });
    expect(t.calls[0].view).toEqual(out.view);
  });
});

describe('registering the exit hook', () => {
  const services = (hostVersion: string) => {
    const ws = createFakeWorkspace({ hostVersion });
    const bridge = createBridge(ws);
    const doc = { state: createStateStore({ status: 'loading' }) } as unknown as DocService;
    const link = { sync: vi.fn(), running: false, last: null };
    return { ws, bridge, doc, link };
  };

  it('a 1.6 host: registered once connected; the app runs the handler', async () => {
    const s = services('1.6');
    expect(s.bridge.onLeave).not.toBeNull();
    expect(await installLeaveHook({ bridge: s.bridge, doc: s.doc, link: s.link, camera: () => null })).toBe('on');
    expect(typeof s.ws.leaveHook).toBe('function');
    const ctl = new AbortController();
    await expect((s.ws.leaveHook as LeaveHandler)({ reason: 'back', signal: ctl.signal, progress: () => {} })).resolves.toEqual({ ok: true });
  });

  it('a 1.5 host: nothing registered (no call, and the refusal not_allowed is quiet)', async () => {
    const s = services('1.5');
    expect(s.bridge.onLeave).toBeNull();
    expect(await installLeaveHook({ bridge: s.bridge, doc: s.doc, link: s.link, camera: () => null })).toBe('unavailable');
    expect(s.ws.leaveHook).toBeNull();
    // A host that says 1.6 but refuses (not_allowed): nothing registered, nothing logged.
    const log = vi.fn();
    const refusing = { ...s.bridge, onLeave: async () => Promise.reject(Object.assign(new Error('no'), { code: 'not_allowed' })) } as unknown as Bridge;
    expect(await installLeaveHook({ bridge: refusing, doc: s.doc, link: s.link, camera: () => null, log })).toBe('unavailable');
    expect(log).not.toHaveBeenCalled();
  });
});
