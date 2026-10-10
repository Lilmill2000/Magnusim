// @vitest-environment node
// The link controller (LINK, host API 1.5) against a scripted host: save then
// link, the no-change skip, nothing included, and every answer of the app
// (stale, changed, superseded, cancelled, busy, unsaved, gone, plugin_needed,
// Save as new).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { LinkedGeometry, LinkOptions, LinkResult } from '@magnusim/workspace';
import { createLinkController, exportPaths, type LinkOutcome } from '../../src/link/controller';
import { createStateStore } from '../../src/lib/store';
import type { Bridge } from '../../src/lib/bridge';
import type { CadDoc } from '../../src/types/doc';
import type { DocService, DocState, EndBodies } from '../../src/types/doc-service';
import type { KernelAdapter } from '../../src/types/kernel';
import type { CadAdopt } from '../../src/types/edit-geometry';
import { designDigest } from '../../src/link/adopt';

const DOC: CadDoc = {
  schema: 2,
  units: { length: 'mm', angle: 'deg' },
  params: [],
  bodies: { b1: { name: 'Body 1', color: '#bdc9db' } },
  features: [{ id: 'f1', type: 'extrude', name: 'Extrude 1' } as unknown as CadDoc['features'][number]],
  meta: { created_at: 'x', written_by: 'test' },
};

function linked(rev: number, sourceVersion: number, geometryId = 'g1'): LinkedGeometry {
  return { geometryId, name: 'Part 1', rev, sourceVersion, shapeSha256: 'a'.repeat(64), namesSha256: null, syncedAt: 'now', state: 'ok', error: null, lostFaces: 0 };
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

function setup(opts: { version?: number; linked?: LinkedGeometry | null; answers?: (LinkResult | Error)[]; afterStale?: LinkedGeometry | null; bodies?: CadDoc['bodies']; end?: Partial<EndBodies>; progress?: boolean; adopt?: CadAdopt | null } = {}) {
  const doc0: CadDoc = { ...DOC, bodies: opts.bodies ?? DOC.bodies };
  const state = createStateStore<DocState>({
    status: 'ready',
    error: null,
    doc: doc0,
    view: { rollback: null, hiddenBodies: [], expanded: [] },
    rebuild: { status: 'done', seq: 1, features: {}, bodies: [], outputs: {}, ms: 1, message: null },
    save: { state: 'saved', at: 'now' },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    session: null,
    sourceVersion: opts.version ?? 4,
  });
  const end: EndBodies = { bodies: [{ id: 'b1', shape: 7, valid: true, feature: 'f1', names: { faces: ['F:f1:end', 'F:f1:start', 'F:f1:side:a', 'F:f1:side:b', 'F:f1:side:c', 'F:f1:side:d'] }, name: 'Body 1', color: '#bdc9db' }], failed: [], ...opts.end };
  const doc = { state, flush: vi.fn(async () => {}), bodiesAtEnd: vi.fn(async () => end) } as unknown as DocService;
  const kernel = {
    call: vi.fn(async () => ({
      result: { bytes: 3, occt: '7.9.3', format_version: 4, solids: [{ src: 0, piece: 1, faces: 6 }], empty: [], visit_body: [1, 1, 1, 1, 1, 1], visit_face: [0, 1, 2, 3, 4, 5], timings: {} },
      buffers: { brep: new Uint8Array([1, 2, 3]).buffer },
    })),
  } as unknown as KernelAdapter;
  const answers = [...(opts.answers ?? [result()])];
  let linkedNow: LinkedGeometry | null = opts.linked ?? null;
  let staleSeen = false;
  const calls: LinkOptions[] = [];
  const writes: string[] = [];
  const toasts: [string, string][] = [];
  const dirty: boolean[] = [];
  const bridge = {
    studyId: 's1',
    context: { study: { title: 'Part 1' } },
    files: {
      write: vi.fn(async (rel: string) => {
        writes.push(rel);
        return { rel, size: 1, mtime: 'x', etag: 'e', sha256: rel.endsWith('.json') ? 'b'.repeat(64) : 'c'.repeat(64) };
      }),
    },
    setDirtyNow: vi.fn(async (d: boolean) => {
      dirty.push(d);
    }),
    toast: (m: string, k: string) => toasts.push([m, k]),
    link: {
      linkGeometry: vi.fn(async (o: LinkOptions) => {
        calls.push(o);
        // The app took the job and said so before it ended (a "busy" after this is the job's end).
        if (opts.progress) o.onProgress?.({ stage: 'reading', fraction: null } as Parameters<NonNullable<LinkOptions['onProgress']>>[0]);
        const a = answers.shift();
        if (!a) throw refused('failed', 'no answer scripted');
        if (a instanceof Error) {
          if ((a as { code?: string }).code === 'stale' && !staleSeen) {
            staleSeen = true;
            if (opts.afterStale !== undefined) linkedNow = opts.afterStale;
          }
          throw a;
        }
        linkedNow = linked(a.rev, o.sourceVersion, a.geometryId);
        return a;
      }),
      linkedGeometry: vi.fn(async () => linkedNow),
      onGeometry: () => () => {},
    },
  } as unknown as Bridge;
  const ready = vi.fn(async () => opts.adopt ?? null);
  const unverified: number[] = [];
  const ctl = createLinkController({ bridge, doc, kernel, busyWaitMs: 1, notReadyWaitMs: 1, log: () => {}, ...(opts.adopt !== undefined ? { adopt: { ready, geometryName: () => 'Vortex CFD Test', noteUnverified: (n: number) => void unverified.push(n) } } : {}) });
  return { ctl, calls, writes, toasts, dirty, kernel, doc, state, bridge, ready, unverified };
}

describe('link controller: save, then link', () => {
  it('a first link: flushes, tells the app the page is clean, exports the end of the history, writes both files, links with their sha256', async () => {
    const t = setup({ version: 4 });
    const r = await t.ctl.sync();
    expect(r.outcome).toBe('linked');
    expect(t.doc.flush).toHaveBeenCalled();
    expect(t.dirty).toEqual([false]);
    expect(t.doc.bodiesAtEnd).toHaveBeenCalled();
    expect(t.writes).toEqual([exportPaths('s1').shape, exportPaths('s1').faceNames]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      shape: { rel: 'studies/s1/export/part.bbrep', format: 'brep', sha256: 'c'.repeat(64) },
      faceNames: { rel: 'studies/s1/export/face_names.json', sha256: 'b'.repeat(64) },
      sourceVersion: 4,
      basedOnRev: null,
    });
    expect(typeof t.calls[0].onProgress).toBe('function');
    expect(t.toasts).toEqual([]);
  });

  it('no change: the saved design is the linked one, so nothing is exported or written', async () => {
    const t = setup({ version: 4, linked: linked(2, 4) });
    const r = await t.ctl.sync();
    expect(r).toEqual({ outcome: 'unchanged', sourceVersion: 4, geometryId: 'g1' });
    expect(t.kernel.call).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('the camera given to sync goes on linkGeometry (host 1.6); a sync without one sends no view', async () => {
    const view = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], projection: 'perspective' as const, fovDeg: 30 };
    const t = setup({ version: 4 });
    expect((await t.ctl.sync({ view })).outcome).toBe('linked');
    expect(t.calls[0].view).toEqual(view);
    const u = setup({ version: 4 });
    expect((await u.ctl.sync()).outcome).toBe('linked');
    expect(u.calls[0]).not.toHaveProperty('view');
  });

  it('an update passes the geometry rev it read as basedOnRev', async () => {
    const t = setup({ version: 5, linked: linked(2, 4), answers: [result({ created: false, rev: 3, fromRev: 2 })] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls[0]).toMatchObject({ sourceVersion: 5, basedOnRev: 2 });
  });

  it('with no body included it links nothing and says so plainly', async () => {
    const t = setup({ version: 5, linked: linked(2, 4), bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } });
    const r = await t.ctl.sync();
    expect(r).toEqual({ outcome: 'nothing', message: 'No body is included in the simulation; Part 1 keeps its last update.', empty: false, linked: true });
    expect(t.calls).toEqual([]);
    expect(t.toasts).toEqual([['No body is included in the simulation; Part 1 keeps its last update.', 'info']]);
    const first = setup({ bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } });
    expect(await first.ctl.sync()).toEqual({ outcome: 'nothing', message: 'No body is included in the simulation; Nothing was added to the project.', empty: false, linked: false });
  });

  it('a change that is not saved stops it with the reason; the brief does not name the Part (the app question names the geometry next)', async () => {
    const t = setup({ linked: linked(2, 3) });
    t.state.set({ save: { state: 'error', message: 'the disk is full' } });
    const r = await t.ctl.sync();
    expect(r).toEqual({ outcome: 'failed', code: 'unsaved', message: 'Changes to Part 1 are not saved: the disk is full.', brief: 'Saving failed: the disk is full.' });
    expect(t.calls).toEqual([]);
    // Never linked, but a body the rebuild shows is included: the save would be linked, so it is a failure too.
    const body = setup();
    body.state.set({ save: { state: 'error', message: 'the disk is full' }, rebuild: { ...body.state.get().rebuild, bodies: [{ id: 'b1', solids: 1 } as DocState['rebuild']['bodies'][number]] } });
    expect(await body.ctl.sync()).not.toHaveProperty('nothingLinked');
  });

  it('a refused save when nothing would be linked (never linked, no body included) says so: nothingLinked (L3 review polish 1)', async () => {
    const t = setup({ bodies: {} });
    t.state.set({ save: { state: 'error', message: 'the disk is full' } });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'unsaved', message: 'Changes to Part 1 are not saved: the disk is full.', brief: 'Saving failed: the disk is full.', nothingLinked: true });
    const left = setup({ bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } });
    left.state.set({ save: { state: 'error', message: 'the disk is full' }, rebuild: { ...left.state.get().rebuild, bodies: [{ id: 'b1', solids: 1 } as DocState['rebuild']['bodies'][number]] } });
    expect(await left.ctl.sync()).toMatchObject({ nothingLinked: true });
  });

  it('both tabs changed it (conflict): refused with the chip words, and what each choice loses (L3 review B1)', async () => {
    const t = setup();
    t.state.set({ save: { state: 'conflict', message: 'Changed in another tab' } });
    expect(await t.ctl.sync()).toEqual({
      outcome: 'failed',
      code: 'unsaved',
      message: "Part 1 was also changed in another tab, so the project was not updated. Choose Reload (this tab's changes are lost) or Keep mine (the other tab's changes are lost) first.",
      brief: "Part 1 was also changed in another tab. Choose Reload (this tab's changes are lost) or Keep mine (the other tab's changes are lost), then leave.",
    });
  });

  it('a clean tab another tab saved over: it reads the newer design in place and links that, or skips when the geometry has it; nothing asks (L3 review B1)', async () => {
    const newer: CadDoc = { ...DOC, features: [...DOC.features, { id: 'f2', type: 'extrude', name: 'Extrude 2' } as unknown as CadDoc['features'][number]] };
    const tab = (linkedNow: LinkedGeometry | null) => {
      const t = setup({ version: 4, linked: linkedNow });
      const checkStored = vi.fn(async () => {
        if (t.state.get().sourceVersion === 4) t.state.set({ save: { state: 'updated', message: 'Updated in another tab' } });
      });
      const reload = vi.fn(async () => {
        t.state.set({ doc: newer, sourceVersion: 7, save: { state: 'saved', at: 'now' } });
      });
      Object.assign(t.doc, { checkStored, reload });
      return { ...t, checkStored, reload };
    };
    const links = tab(linked(2, 5));
    const r = await links.ctl.sync({ notify: false });
    expect(r).toMatchObject({ outcome: 'linked', sourceVersion: 7 });
    expect(links.reload).toHaveBeenCalledTimes(1);
    expect(links.calls.map((c) => c.sourceVersion)).toEqual([7]);
    // The other tab linked it already: nothing to do.
    const skips = tab(linked(3, 7));
    expect(await skips.ctl.sync({ notify: false })).toEqual({ outcome: 'unchanged', sourceVersion: 7, geometryId: 'g1' });
    expect(skips.calls).toEqual([]);
    expect(skips.writes).toEqual([]);
  });

  it('a removed feature (Box, Cylinder) refuses the link with its own words, not "Fix, retry" (L3 review B2)', async () => {
    const box = { id: 'f_box', type: 'box', name: 'Old box' } as unknown as CadDoc['features'][number];
    const cyl = { id: 'f_cyl', type: 'cylinder', name: 'Old cylinder' } as unknown as CadDoc['features'][number];
    const one = setup({ linked: linked(1, 2), end: { failed: ['Old box'] } });
    one.state.set({ doc: { ...DOC, features: [box, ...DOC.features] } });
    expect(await one.ctl.sync({ notify: false })).toEqual({
      outcome: 'failed',
      code: 'not_built',
      message: 'Old box is a removed feature (Box), so Part 1 keeps its last update. Suppress or delete it first.',
      brief: 'Old box is a removed feature (Box). Suppress or delete it, then leave.',
    });
    const two = setup({ end: { failed: ['Old box', 'Old cylinder', 'Split 1'] } });
    two.state.set({ doc: { ...DOC, features: [box, cyl, ...DOC.features] } });
    expect(await two.ctl.sync({ notify: false })).toMatchObject({
      brief: 'Old box and Old cylinder are removed features (Box, Cylinder). Suppress or delete them, then leave. Split 1 failed to build. Fix, retry or suppress it first.',
    });
    // Suppressed: not in the way any more.
    const off = setup({ end: { failed: [] } });
    off.state.set({ doc: { ...DOC, features: [{ ...box, suppressed: true } as CadDoc['features'][number], ...DOC.features] } });
    expect((await off.ctl.sync({ notify: false })).outcome).toBe('linked');
  });
});

describe("link controller: the app's answers", () => {
  it('stale: re-reads, and tries once more only when this design is newer', async () => {
    const newer = setup({ version: 6, linked: linked(2, 4), answers: [refused('stale'), result({ rev: 4, created: false })], afterStale: linked(3, 5) });
    expect((await newer.ctl.sync()).outcome).toBe('linked');
    expect(newer.calls.map((c) => c.basedOnRev)).toEqual([2, 3]);
    const older = setup({ version: 6, linked: linked(2, 4), answers: [refused('stale', 'Part 1 changed in another tab. Reload to continue.'), result()], afterStale: linked(3, 7) });
    const r = await older.ctl.sync();
    expect(r).toEqual({ outcome: 'failed', code: 'stale', message: 'Part 1 changed in another tab. Reload to continue.' });
    expect(older.calls).toHaveLength(1);
    expect(older.toasts).toEqual([['Part 1 changed in another tab. Reload to continue.', 'error']]);
  });

  it('stale twice: no third try', async () => {
    const t = setup({ version: 6, linked: linked(2, 4), answers: [refused('stale'), refused('stale', 'still stale')], afterStale: linked(3, 5) });
    expect(await t.ctl.sync()).toMatchObject({ outcome: 'failed', code: 'stale', message: 'still stale' });
    expect(t.calls).toHaveLength(2);
  });

  it('changed: writes both files again and tries again', async () => {
    const t = setup({ answers: [refused('changed'), result()] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.writes).toHaveLength(4);
    expect(t.calls).toHaveLength(2);
  });

  it('superseded and cancelled (Keep editing) end quietly', async () => {
    const s = setup({ answers: [refused('superseded')] });
    expect(await s.ctl.sync()).toEqual({ outcome: 'superseded', sourceVersion: 4 });
    expect(s.toasts).toEqual([]);
    const c = setup({ answers: [refused('cancelled', 'You kept editing. Nothing changed.')] });
    expect(await c.ctl.sync()).toEqual({ outcome: 'kept-editing', sourceVersion: 4 });
    expect(c.toasts).toEqual([]);
  });

  it('busy: tries again shortly, a few times', async () => {
    const t = setup({ answers: [refused('busy', 'Adding Part 1 v2. Choose again when it is done.'), refused('busy'), result()] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls).toHaveLength(3);
    const never = setup({ answers: Array.from({ length: 6 }, () => refused('busy', 'Adding Part 1 v2. Choose again when it is done.')) });
    expect(await never.ctl.sync()).toMatchObject({ outcome: 'failed', code: 'busy' });
    expect(never.calls).toHaveLength(5);
  });

  it('unsaved: tells the app again that the page is clean, once', async () => {
    const t = setup({ answers: [refused('unsaved'), result()] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.dirty).toEqual([false, false]);
  });

  it('gone: the geometry was removed, so it links again as a first link', async () => {
    const t = setup({ version: 6, linked: linked(2, 4), answers: [refused('gone'), result()] });
    // The removal: linkedGeometry() answers null from now on.
    (t.bridge.link!.linkedGeometry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(linked(2, 4)).mockResolvedValue(null);
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls.map((c) => c.basedOnRev)).toEqual([2, null]);
  });

  it("plugin_needed: the app's message as it is", async () => {
    const msg = 'Records of Demo porous come from a plugin that is off or not installed: Study 1 › Porous. Turn it on or install it, or delete those records, to update Part 1.';
    const t = setup({ answers: [refused('plugin_needed', msg)] });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'plugin_needed', message: msg });
    expect(t.toasts).toEqual([[msg, 'error']]);
  });

  it('Save as new: the result with created and the new geometry id is accepted', async () => {
    const t = setup({ version: 7, linked: linked(3, 6), answers: [result({ created: true, geometryId: 'g2', name: 'Part 1 v2', rev: 1 })] });
    const r = (await t.ctl.sync()) as Extract<LinkOutcome, { outcome: 'linked' }>;
    expect([r.outcome, r.result.created, r.result.geometryId]).toEqual(['linked', true, 'g2']);
    expect((await t.bridge.link!.linkedGeometry())?.geometryId).toBe('g2');
    // Linked: the next sync with the same design does nothing.
    expect((await t.ctl.sync()).outcome).toBe('unchanged');
  });

  it('one sync at a time: a second call while one runs gets the same answer', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.ctl.sync(), t.ctl.sync()]);
    expect(a).toBe(b);
    expect(t.calls).toHaveLength(1);
  });

  it('an app without host API 1.5 cannot link, and says so', async () => {
    const t = setup();
    (t.bridge as { link: unknown }).link = null;
    expect(await t.ctl.sync()).toEqual({ outcome: 'unavailable', message: 'This version of Magnusim cannot add a Part to the project: it needs Magnusim with host API 1.5.' });
  });
});

describe('link review fixes (L1, L2, polish)', () => {
  // L1: a design with a failed or stopped feature is never linked.
  it('a failed or stopped feature refuses the link with a plain reason; nothing is exported or written', async () => {
    const t = setup({ version: 5, linked: linked(2, 4), end: { failed: ['Combine 1'] } });
    const r = await t.ctl.sync();
    expect(r).toEqual({ outcome: 'failed', code: 'not_built', message: 'Combine 1 failed to build, so Part 1 keeps its last update. Fix, retry or suppress it first.', brief: 'Combine 1 failed to build. Fix, retry or suppress it first.' });
    expect(t.kernel.call).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.toasts).toEqual([['Combine 1 failed to build, so Part 1 keeps its last update. Fix, retry or suppress it first.', 'error']]);
    const first = setup({ end: { failed: ['Split 1', 'Combine 1'] } });
    expect(await first.ctl.sync()).toMatchObject({ outcome: 'failed', message: 'Split 1 and Combine 1 failed to build, so nothing was added to the project. Fix, retry or suppress them first.' });
  });

  it('a broken reference Plane / Axis / Point that nothing uses does not stop the link: it is named in the notes; one a feature uses still refuses (Daniel, 2026-10-05)', async () => {
    const axis = { id: 'f_ax', type: 'ref_axis', name: 'Axis 5' } as unknown as CadDoc['features'][number];
    const plane = { id: 'f_pl', type: 'ref_plane', name: 'Plane 1' } as unknown as CadDoc['features'][number];
    const sketch = { id: 'f_sk', type: 'sketch', name: 'Sketch 3', uses: ['f_pl'] } as unknown as CadDoc['features'][number];
    const registry = { get: () => ({ parents: (f: { uses?: string[] }) => f.uses ?? [] }) };
    const unused = setup({ version: 5, linked: linked(2, 4), end: { failed: ['Axis 5'] } });
    (unused.doc as { features: unknown }).features = registry;
    unused.state.set({ doc: { ...DOC, features: [...DOC.features, axis] } });
    const r = await unused.ctl.sync();
    expect(r).toMatchObject({ outcome: 'linked', notes: ['Axis 5 is broken (not used by anything).'] });
    expect(unused.calls).toHaveLength(1);
    expect(unused.toasts).toEqual([['Part 1 updated. Axis 5 is broken (not used by anything).', 'info']]);
    // A plane a sketch lies on: the sketch failed too, and the link is refused as before.
    const used = setup({ version: 5, linked: linked(2, 4), end: { failed: ['Plane 1', 'Sketch 3'] } });
    (used.doc as { features: unknown }).features = registry;
    used.state.set({ doc: { ...DOC, features: [...DOC.features, plane, sketch] } });
    expect(await used.ctl.sync({ notify: false })).toMatchObject({ outcome: 'failed', code: 'not_built', brief: 'Plane 1 and Sketch 3 failed to build. Fix, retry or suppress them first.' });
    expect(used.calls).toEqual([]);
    // The user suppressed the sketch: the plane is used by nothing any more.
    const off = setup({ version: 5, linked: linked(2, 4), end: { failed: ['Plane 1'] } });
    (off.doc as { features: unknown }).features = registry;
    off.state.set({ doc: { ...DOC, features: [...DOC.features, plane, { ...sketch, suppressed: true } as CadDoc['features'][number]] } });
    expect(await off.ctl.sync({ notify: false })).toMatchObject({ outcome: 'linked', notes: ['Plane 1 is broken (not used by anything).'] });
  });

  it('an included body the kernel calls invalid refuses the link; left out of the simulation, it does not', async () => {
    const bad = { bodies: [{ id: 'b1', shape: 7, valid: false, feature: 'f1', names: null, name: 'Body 1', color: '#bdc9db' }] };
    const t = setup({ version: 5, linked: linked(2, 4), end: bad });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'not_built', message: 'Body 1 is not a valid solid, so Part 1 keeps its last update. Repair it, or leave it out of the simulation, first.', brief: 'Body 1 is not a valid solid. Repair it, or leave it out of the simulation, first.' });
    expect(t.calls).toEqual([]);
    const out = setup({ version: 5, linked: linked(2, 4), end: bad, bodies: { b1: { name: 'Body 1', color: '#bdc9db', simulation: false } } });
    expect((await out.ctl.sync()).outcome).toBe('nothing');
  });

  it('the skip rule never pins a partial design: refused while a feature is stopped, linked once it builds, with the same sourceVersion', async () => {
    const t = setup({ version: 5, linked: linked(2, 4), answers: [result({ created: false, rev: 3, fromRev: 2 })] });
    const end = { bodies: [{ id: 'b1', shape: 7, valid: true, feature: 'f1', names: null, name: 'Body 1', color: '#bdc9db' }], failed: ['Extrude 1'] } as EndBodies;
    (t.doc.bodiesAtEnd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(end);
    expect(await t.ctl.sync()).toMatchObject({ outcome: 'failed', code: 'not_built' });
    expect(t.calls).toEqual([]);
    // Retried and built (the design did not change: still sourceVersion 5): now it links.
    const r = await t.ctl.sync();
    expect(r.outcome).toBe('linked');
    expect(t.calls.map((c) => c.sourceVersion)).toEqual([5]);
    expect((await t.ctl.sync()).outcome).toBe('unchanged');
  });

  // L2 (ported from the review's race.test.ts): an edit during the linkedGeometry() round trip.
  it('an edit while the link reads the geometry goes back to the save: the edited design is exported under its own sourceVersion', async () => {
    const t = setup({ version: 4, linked: linked(1, 3) });
    const edited: CadDoc = { ...DOC, features: [{ id: 'f1', type: 'extrude', name: 'Extrude 1', edited: true } as unknown as CadDoc['features'][number]] };
    let exported: unknown = null;
    (t.doc.bodiesAtEnd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      exported = t.state.get().doc;
      return { bodies: [{ id: 'b1', shape: 7, valid: true, feature: 'f1', names: null, name: 'Body 1', color: '#bdc9db' }], failed: [] };
    });
    // The flush stores what is pending: the counter goes up.
    (t.doc.flush as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const s = t.state.get();
      if (s.save.state === 'pending') t.state.set({ save: { state: 'saved', at: 'now' }, sourceVersion: s.sourceVersion + 1 });
    });
    const saves: string[] = [];
    (t.bridge.setDirtyNow as ReturnType<typeof vi.fn>).mockImplementation(async (d: boolean) => {
      saves.push(`${d}:${t.state.get().save.state}`);
    });
    let once = true;
    (t.bridge.link!.linkedGeometry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // The user edits while this round trip is in flight: the model changes, the save waits, the counter is still 4.
      if (once) {
        once = false;
        t.state.set({ doc: edited, save: { state: 'pending' } });
      }
      return linked(1, 3);
    });
    const r = await t.ctl.sync({ notify: false });
    expect(r.outcome).toBe('linked');
    expect(exported).toBe(edited);
    expect(t.calls[0].sourceVersion).toBe(5);
    // "Clean" was said only while saved.
    expect(saves).toEqual(['false:saved']);
  });

  it('an edit while the app hears "clean", or while the part is built for the export, also goes back to the save', async () => {
    for (const when of ['dirty', 'export'] as const) {
      const t = setup({ version: 4, linked: linked(1, 3) });
      const edited: CadDoc = { ...DOC, params: [{ name: 'w', expr: '2 mm' }] as CadDoc['params'] };
      (t.doc.flush as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const s = t.state.get();
        if (s.save.state === 'pending') t.state.set({ save: { state: 'saved', at: 'now' }, sourceVersion: s.sourceVersion + 1 });
      });
      let once = true;
      const edit = () => {
        if (!once) return;
        once = false;
        t.state.set({ doc: edited, save: { state: 'pending' } });
      };
      const saves: string[] = [];
      (t.bridge.setDirtyNow as ReturnType<typeof vi.fn>).mockImplementation(async (d: boolean) => {
        saves.push(`${d}:${t.state.get().save.state}`);
        if (when === 'dirty') edit();
      });
      const first = (t.doc.bodiesAtEnd as ReturnType<typeof vi.fn>).getMockImplementation() as () => Promise<EndBodies>;
      (t.doc.bodiesAtEnd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const out = await first();
        if (when === 'export') edit();
        return out;
      });
      const r = await t.ctl.sync({ notify: false });
      expect(r.outcome, when).toBe('linked');
      expect(t.calls.map((c) => c.sourceVersion), when).toEqual([5]);
      expect(saves.every((x) => x === 'false:saved'), when).toBe(true);
      expect(t.state.get().doc, when).toBe(edited);
    }
  });

  it('a Part that never stops changing is not linked, and says so; the app never hears "clean" while it is not saved', async () => {
    const t = setup({ version: 4, linked: linked(1, 3) });
    let n = 0;
    (t.doc.flush as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const s = t.state.get();
      if (s.save.state === 'pending') t.state.set({ save: { state: 'saved', at: 'now' }, sourceVersion: s.sourceVersion + 1 });
    });
    (t.bridge.link!.linkedGeometry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      t.state.set({ doc: { ...DOC, params: [{ name: `p${n++}`, expr: '1' }] as CadDoc['params'] }, save: { state: 'pending' } });
      return linked(1, 3);
    });
    const r = await t.ctl.sync({ notify: false });
    expect(r).toEqual({ outcome: 'failed', code: 'unsaved', message: 'Part 1 kept changing while it was being added to the project. Try again.' });
    expect(t.dirty).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('a geometry made from a newer design is refused as stale at once, without exporting', async () => {
    const t = setup({ version: 4, linked: linked(3, 6) });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'stale', message: 'Part 1 changed in another tab. Reload to continue.' });
    expect(t.kernel.call).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.dirty).toEqual([]);
  });

  it('busy after the app took the job (it said a stage) is not tried again', async () => {
    const t = setup({ progress: true, answers: [refused('busy', 'Part 1 is busy: try again when the mesh is done.'), result()] });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'busy', message: 'Part 1 is busy: try again when the mesh is done.' });
    expect(t.calls).toHaveLength(1);
  });

  it('calls with other options do not share the running one: each gets its own progress and its own toast', async () => {
    const t = setup({ answers: [result()] });
    const seen: string[] = [];
    const a = t.ctl.sync({ notify: false, onProgress: (p) => seen.push(`a:${p.label}`) });
    const b = t.ctl.sync({ onProgress: (p) => seen.push(`b:${p.label}`) });
    expect(t.ctl.sync({ notify: false, onProgress: undefined })).not.toBe(a);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe('linked');
    // The second ran after the first: the same design is linked now.
    expect(rb.outcome).toBe('unchanged');
    expect(seen.some((x) => x.startsWith('a:'))).toBe(true);
    expect(seen.some((x) => x.startsWith('b:'))).toBe(true);
    expect(t.calls).toHaveLength(1);
  });
});

describe('link controller: Edit in CAD (host API 1.7)', () => {
  const ADOPT: CadAdopt = { geometryId: 'g-vortex', importId: 'f_imp', baselineVersion: 4, baselineDigest: null, originalNames: { rel: 'studies/s1/adopt/f_imp/original_names.json', sha256: 'd'.repeat(64) }, matched: 6, total: 6, error: null };

  it('Undo back to the import (a later save counter, the same design as the baseline): unchanged, no link (review B2)', async () => {
    const digest = await designDigest(DOC);
    const t = setup({ version: 7, adopt: { ...ADOPT, baselineDigest: digest } });
    expect(await t.ctl.sync()).toEqual({ outcome: 'unchanged', sourceVersion: 7, geometryId: 'g-vortex' });
    expect(t.calls).toEqual([]);
    expect(t.writes).toEqual([]);
    // Another design at that later counter: linked, with the names.
    const u = setup({ version: 7, adopt: { ...ADOPT, baselineDigest: 'f'.repeat(64) } });
    expect((await u.ctl.sync()).outcome).toBe('linked');
    expect(u.calls[0]).toHaveProperty('originalNames');
  });

  it('the app could not check some rows (unverified): the outcome notes it, and the Part is told', async () => {
    const t = setup({ version: 5, adopt: ADOPT, answers: [result({ geometryId: 'g-vortex', created: false, rev: 1, fromRev: 0, ...({ adopted: true, unverified: 2 } as object) })] });
    const r = await t.ctl.sync();
    expect(r).toMatchObject({ outcome: 'linked', notes: ['2 faces of Vortex CFD Test could not be checked; their boundary conditions follow by shape only.'] });
    expect(t.unverified).toEqual([2]);
  });

  it('Back at the version the import was saved at links nothing: unchanged, on the geometry it edits, nothing exported', async () => {
    const t = setup({ version: 4, adopt: ADOPT });
    expect(await t.ctl.sync()).toEqual({ outcome: 'unchanged', sourceVersion: 4, geometryId: 'g-vortex' });
    expect(t.ready).toHaveBeenCalledTimes(1);
    expect(t.kernel.call).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.dirty).toEqual([]);
  });

  it('the first link after a change sends originalNames (the app adopts the geometry); a later one does not', async () => {
    const t = setup({ version: 5, adopt: ADOPT, answers: [result({ geometryId: 'g-vortex', created: false, rev: 1, fromRev: 0 }), result({ geometryId: 'g-vortex', created: false, rev: 2, fromRev: 1 })] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls[0]).toMatchObject({ sourceVersion: 5, basedOnRev: null, originalNames: ADOPT.originalNames });
    // Linked now: the link pointer holds the association, no names again.
    t.state.set({ sourceVersion: 6 });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls[1]).toMatchObject({ sourceVersion: 6, basedOnRev: 1 });
    expect(t.calls[1]).not.toHaveProperty('originalNames');
  });

  it('no sidecar (the matching failed): the first link adopts without names', async () => {
    const t = setup({ version: 5, adopt: { ...ADOPT, originalNames: null, matched: 0 } });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls[0]).not.toHaveProperty('originalNames');
  });

  it('gone (the geometry was removed meanwhile): linked again as a new geometry, without the names', async () => {
    const t = setup({ version: 5, adopt: ADOPT, answers: [refused('gone', 'Vortex CFD Test was removed'), result()] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]).toHaveProperty('originalNames');
    expect(t.calls[1]).not.toHaveProperty('originalNames');
  });

  it('not_ready: tried once more after retryAfter; a second not_ready is the app message', async () => {
    const t = setup({ version: 5, adopt: ADOPT, answers: [Object.assign(refused('not_ready', 'Vortex CFD Test is still being stored'), { retryAfter: 0.001 }), result()] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.calls).toHaveLength(2);
    const u = setup({ version: 5, adopt: ADOPT, answers: [refused('not_ready', 'still storing'), refused('not_ready', 'Vortex CFD Test is still being stored.')] });
    expect(await u.ctl.sync()).toEqual({ outcome: 'failed', code: 'not_ready', message: 'Vortex CFD Test is still being stored.' });
  });

  it('adopted (another Part edits that geometry now): the app message as it is', async () => {
    const t = setup({ version: 5, adopt: ADOPT, answers: [refused('adopted', 'Vortex CFD Test is already edited in Vortex CFD Test (2).')] });
    expect(await t.ctl.sync()).toEqual({ outcome: 'failed', code: 'adopted', message: 'Vortex CFD Test is already edited in Vortex CFD Test (2).' });
    expect(t.toasts).toEqual([['Vortex CFD Test is already edited in Vortex CFD Test (2).', 'error']]);
  });

  it('a Part that links its geometry already never reads the adoption', async () => {
    const t = setup({ version: 5, linked: linked(1, 4, 'g-vortex'), adopt: ADOPT, answers: [result({ geometryId: 'g-vortex', created: false, rev: 2, fromRev: 1 })] });
    expect((await t.ctl.sync()).outcome).toBe('linked');
    expect(t.ready).not.toHaveBeenCalled();
    expect(t.calls[0]).not.toHaveProperty('originalNames');
  });

  it('a failed build says the geometry it edits was not changed', async () => {
    const t = setup({ version: 5, adopt: ADOPT, end: { failed: ['Press-pull 1'] } });
    const r = await t.ctl.sync();
    expect(r).toMatchObject({ outcome: 'failed', code: 'not_built', message: 'Press-pull 1 failed to build, so Vortex CFD Test was not changed. Fix, retry or suppress it first.' });
  });
});
