// @vitest-environment jsdom
// Edit in CAD (host API 1.7): the open flow. An empty Part on a geometry imports it
// by itself (origin recorded, not_ready waited through with its line, Stop, a 2-minute
// cap, modelling blocked meanwhile), closes the import panel when it is done, matches
// the faces and records cad_adopt (import id, save counter and design digest) only for
// the Import the stored Part holds; it never imports again (also not when another tab
// imported first), never into a design of its own, and selects the launch face unless
// the user picked something.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { CadDoc, ImportFeature } from '../../src/types/doc';
import type { CadAdopt, EditedGeometry } from '../../src/types/edit-geometry';

const started: { file: File; init: Partial<ImportFeature> }[] = [];
const runsState = createStateStore<{ runs: Record<string, { progress: unknown; error: string | null }> }>({ runs: {} });
let session: { feature: string; open: boolean; draft: Partial<ImportFeature> } | null = null;
let startOk = true;
const panelState = createStateStore<{ panel: { kind: 'feature'; feature: string } | null }>({ panel: null });
const closePanel = vi.fn();
const prepare = vi.fn();
const matchOnly = vi.fn();
const blocks: (() => string | null)[] = [];

vi.mock('../../src/features/import', () => ({
  startImport: (_s: unknown, file: File, init: Partial<ImportFeature>) => {
    started.push({ file, init });
    if (!startOk) return false;
    session = { feature: 'f_imp', open: true, draft: { ...init, brep: { rel: '', size: 0, sha256: '', occt: '' }, items: [] } };
    runsState.set({ runs: { f_imp: { progress: { stage: 'reading' }, error: null } } });
    panelState.set({ panel: { kind: 'feature', feature: 'f_imp' } });
    return true;
  },
}));
vi.mock('../../src/features/import/runs', () => ({ importRunsFor: () => ({ state: runsState }) }));
vi.mock('../../src/ui/controller', () => ({
  uiFor: () => ({
    state: panelState,
    closePanel,
    addEditBlock: (fn: () => string | null) => {
      blocks.push(fn);
      return () => blocks.splice(blocks.indexOf(fn), 1);
    },
  }),
}));
vi.mock('../../src/link/adopt', async (orig) => ({ ...(await orig<typeof import('../../src/link/adopt')>()), prepareAdoption: (...a: unknown[]) => prepare(...a), matchToGeometry: (...a: unknown[]) => matchOnly(...a) }));

const G: EditedGeometry = { id: 'g1', name: 'Vortex CFD Test', format: 'step', fileName: 'Vortex CFD Test.step', linked: false, rev: 0, bodies: 1, faces: 6 };
const IMPORTED: ImportFeature = {
  id: 'f_imp',
  type: 'import',
  name: 'Imported 1 (Vortex CFD Test.step)',
  origin: { geometryId: 'g1', sha256: 'abc' },
  brep: { rel: 'studies/s1/imports/x/healed.brep', size: 1, sha256: 'b', occt: '7.9.3' },
  items: [{ body: 'b_1', index: 0, stepName: 'Vortex', stepColor: null, kind: 'solid', valid: true }],
} as ImportFeature;
/** Another tab's Import of the same geometry. */
const THEIRS: ImportFeature = { ...IMPORTED, id: 'f_theirs' };
const record = (o: Partial<CadAdopt> = {}): CadAdopt => ({ geometryId: 'g1', importId: 'f_imp', baselineVersion: 2, baselineDigest: null, originalNames: null, matched: 6, total: 6, error: null, ...o });

type Save = { state: string; at?: string | null; message?: string };

function services(
  o: {
    features?: CadDoc['features'];
    source?: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
    launch?: unknown;
    study?: Record<string, unknown>;
    geometry?: EditedGeometry | null;
    /** What a stored-check finds (another tab saved): the doc it reloads to. */
    storedByOtherTab?: CadDoc['features'];
    /** The save after this tab's import meets another tab's save. */
    importConflicts?: boolean;
  } = {},
) {
  const docState = createStateStore<{ status: string; doc: CadDoc; save: Save; sourceVersion: number }>({ status: 'ready', doc: { features: o.features ?? [], bodies: {} } as unknown as CadDoc, save: { state: 'saved', at: null }, sourceVersion: 1 });
  let study: Record<string, unknown> = { id: 's1', rev: 1, ...(o.study ?? {}) };
  const updates: Record<string, unknown>[] = [];
  const selection = createStateStore<{ items: unknown[]; filter: unknown[] }>({ items: [], filter: [] });
  const toasts: string[] = [];
  const reload = vi.fn(async () => {
    if (o.storedByOtherTab) docState.set((s) => ({ ...s, doc: { ...s.doc, features: o.storedByOtherTab! }, save: { state: 'saved', at: null }, sourceVersion: 5 }));
  });
  const s = {
    bridge: {
      studyId: 's1',
      toast: (m: string) => toasts.push(m),
      study: {
        get: async () => study,
        update: async (p: Record<string, unknown>, rev: number) => {
          if (rev !== study.rev) throw new Error('stale rev');
          updates.push(p);
          study = { ...study, ...p, rev: (study.rev as number) + 1 };
          return study;
        },
      },
      edit:
        o.geometry === null
          ? null
          : { geometry: o.geometry ?? G, launch: o.launch ?? null, source: o.source ?? (async () => ({ geometryId: 'g1', file: new File(['x'], 'Vortex CFD Test.step'), format: 'step', size: 1, sha256: 'abc', adopted: false })), faces: async () => ({}) },
      link: null,
    },
    doc: {
      state: docState,
      session: () => session,
      checkStored: vi.fn(async () => {
        if (o.storedByOtherTab) docState.set((st) => ({ ...st, save: { state: 'updated', at: null } }));
      }),
      reload,
      flush: vi.fn(async () => {
        // The import is committed and saved: the next save counter (or another tab saved first).
        const st = docState.get();
        if (!st.doc.features.length && session && !session.open) {
          docState.set({ ...st, doc: { ...st.doc, features: [IMPORTED] }, sourceVersion: 2, save: o.importConflicts ? { state: 'conflict', message: 'Changed in another tab' } : { state: 'saved', at: null } });
        }
      }),
    },
    selection,
    kernel: {},
  } as unknown as AppServices;
  return { s, docState, updates, selection, toasts, reload, study: () => study };
}

/** The import "finishes": stored shapes, no progress; the session is still open (the panel shows it). */
function finishImport() {
  session = { ...session!, draft: { ...session!.draft, brep: IMPORTED.brep, items: IMPORTED.items } };
  runsState.set({ runs: { f_imp: { progress: null, error: null } } });
}

beforeEach(() => {
  started.length = 0;
  blocks.length = 0;
  session = null;
  startOk = true;
  runsState.set({ runs: {} });
  panelState.set({ panel: null });
  closePanel.mockReset();
  closePanel.mockImplementation(() => {
    if (session) session = { ...session, open: false };
    panelState.set({ panel: null });
  });
  prepare.mockReset();
  prepare.mockImplementation(async (_d: unknown, o: { baselineVersion: number; baselineDigest: string | null; feature: ImportFeature }) => ({
    record: { geometryId: 'g1', importId: o.feature.id, baselineVersion: o.baselineVersion, baselineDigest: o.baselineDigest, originalNames: { rel: `studies/s1/adopt/${o.feature.id}/original_names.json`, sha256: 'e'.repeat(64) }, matched: 5, total: 6, error: null },
    faces: new Map([[3, { body: 'b_1', index: 7 }]]),
    bodies: new Map([[1, 'b_1']]),
    table: { faces: [{ index: 3, label: 'face 3@Body1' }] },
    ms: 1,
  }));
  matchOnly.mockReset();
});

const block = () => blocks.map((fn) => fn()).find(Boolean) ?? null;

describe('Edit in CAD: the open flow', () => {
  it('an empty Part imports the geometry by itself, closes the panel when done, then records cad_adopt (import id, save counter, design digest)', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ launch: { face: 'face 3@Body1' } });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].file.name).toBe('Vortex CFD Test.step');
    expect(started[0].init).toEqual({ origin: { geometryId: 'g1', sha256: 'abc' } });
    expect(e.state.get().phase).toBe('importing');
    // Modelling waits while the import runs.
    expect(block()).toBe('Vortex CFD Test is being imported');
    // A link right now (the import still running) does not wait for the import.
    expect(await Promise.race([e.ready(), new Promise((r) => setTimeout(() => r('waiting'), 20))])).toBeNull();
    finishImport();
    await run;
    expect(block()).toBeNull();
    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][1]).toMatchObject({ baselineVersion: 2, studyId: 's1', baselineDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const rec = record({ baselineDigest: prepare.mock.calls[0][1].baselineDigest, originalNames: { rel: 'studies/s1/adopt/f_imp/original_names.json', sha256: 'e'.repeat(64) }, matched: 5 });
    expect(t.updates).toEqual([{ cad_adopt: rec }]);
    expect(await e.ready()).toEqual(rec);
    expect(e.state.get()).toMatchObject({ phase: 'ready', line: null, note: '1 face of Vortex CFD Test could not be matched; their boundary conditions follow by shape only.' });
    // The launch face: host face 3 is CAD's face 7 of b_1.
    expect(t.selection.get().items).toEqual([{ kind: 'face', body: 'b_1', index: 7 }]);
    expect(e.state.get().launched).toEqual({ face: 'face 3@Body1', selected: true });
    expect(Object.keys(e.timings).sort()).toEqual(['adopt', 'import', 'source']);
  });

  it('the user selected something while the faces were matched: the launch face does not replace it (review N6)', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ launch: { face: 'face 3@Body1' } });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    t.selection.set({ items: [{ kind: 'body', body: 'b_9' }], filter: [] });
    finishImport();
    await run;
    expect(t.selection.get().items).toEqual([{ kind: 'body', body: 'b_9' }]);
    expect(e.state.get().launched).toEqual({ face: 'face 3@Body1', selected: false });
  });

  it('not_ready: "Waiting for Magnusim to finish storing <Geometry>" with Stop, modelling blocked, then again; an IGES comes as STEP', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    let tries = 0;
    const lines: string[] = [];
    const seenBlocks: (string | null)[] = [];
    const t = services({
      source: async () => {
        tries++;
        if (tries < 3) throw Object.assign(new Error('still storing'), { code: 'not_ready', retryAfter: 2 });
        return { geometryId: 'g1', file: new File(['x'], 'part.igs'), format: 'step', size: 1, sha256: 'abc', adopted: false };
      },
    });
    const sleeps: number[] = [];
    const e = createEditOpen(t.s, {
      sleep: async (ms) => {
        sleeps.push(ms);
        seenBlocks.push(block());
        expect(e.state.get().action).toBe('stop');
      },
    });
    e.state.subscribe(() => {
      const l = e.state.get().line;
      if (l && !lines.includes(l)) lines.push(l);
    });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(lines).toEqual(['Opening Vortex CFD Test from the project', 'Waiting for Magnusim to finish storing Vortex CFD Test']);
    expect(sleeps).toEqual([2000, 2000]);
    expect(seenBlocks).toEqual(['Opening Vortex CFD Test from the project', 'Opening Vortex CFD Test from the project']);
    expect(started[0].file.name).toBe('part.step');
    finishImport();
    await run;
  });

  it('Stop ends the wait: nothing imported, the line says so with Try again; Try again opens it', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    let ready = false;
    const t = services({
      source: async (opts) => {
        if (ready) return { geometryId: 'g1', file: new File(['x'], 'Vortex CFD Test.step'), format: 'step', size: 1, sha256: 'abc', adopted: false };
        return new Promise((_r, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      },
    });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(e.state.get().phase).toBe('loading'));
    expect(e.state.get().action).toBe('stop');
    e.stop();
    await run;
    expect(started).toEqual([]);
    expect(e.state.get()).toMatchObject({ phase: 'error', line: 'Stopped opening Vortex CFD Test. Nothing was imported.', action: 'retry' });
    expect(block()).toBeNull();
    ready = true;
    const again = e.retry();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    finishImport();
    await again;
    expect(e.state.get().phase).toBe('ready');
  });

  it('a wait longer than its cap ends with what to do; another refusal says why, once (the line, no toast too: review N1)', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const t = services({ source: async () => Promise.reject(Object.assign(new Error('updating'), { code: 'not_ready', retryAfter: 5 })) });
      const e = createEditOpen(t.s, { waitMs: 120_000, sleep: async (ms) => void (clock += ms) });
      await e.start();
      expect(started).toEqual([]);
      expect(e.state.get()).toMatchObject({ phase: 'error', action: 'retry', line: 'Vortex CFD Test is still not ready after 2 minutes. Try again in a moment, or go back and choose Edit in CAD again later.' });
      expect(clock).toBe(120_000);
    } finally {
      now.mockRestore();
    }
    const u = services({ source: async () => Promise.reject(Object.assign(new Error('The source file of Vortex CFD Test is missing.'), { code: 'no_source' })) });
    const f = createEditOpen(u.s, { sleep: async () => {} });
    await f.start();
    expect(started).toEqual([]);
    expect(f.state.get()).toMatchObject({ phase: 'error', line: 'Vortex CFD Test could not be opened in CAD: The source file of Vortex CFD Test is missing.', action: 'retry' });
    expect(u.toasts).toEqual([]);
  });

  it('opened again: the Import is there (origin), so nothing is imported; its record is read; the launch face is matched again, nothing written', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const rec = record();
    matchOnly.mockResolvedValue({ table: { faces: [{ index: 4, label: 'face 4@Body1' }] }, faces: new Map([[4, { body: 'b_1', index: 2 }]]), bodies: new Map() });
    const t = services({ features: [IMPORTED], study: { cad_adopt: rec }, launch: { face: 'face 4@Body1' } });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    await e.start();
    expect(started).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(t.updates).toEqual([]);
    expect(await e.ready()).toEqual(rec);
    expect(t.selection.get().items).toEqual([{ kind: 'face', body: 'b_1', index: 2 }]);
    expect(e.state.get().phase).toBe('ready');
  });

  it('two tabs (review B1): another tab imported first, so this one reads it and imports nothing; the record is for that Import', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ storedByOtherTab: [THEIRS] });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    await e.start();
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(started).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][1].feature.id).toBe('f_theirs');
    expect(t.updates).toEqual([{ cad_adopt: expect.objectContaining({ importId: 'f_theirs', originalNames: { rel: 'studies/s1/adopt/f_theirs/original_names.json', sha256: 'e'.repeat(64) } }) }]);
  });

  it('two tabs (review B1): this tab imported but the other tab saved first: nothing recorded; after Reload it matches the stored Import', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ importConflicts: true });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    finishImport();
    await run;
    expect(prepare).not.toHaveBeenCalled();
    expect(t.updates).toEqual([]);
    // The user picks Reload: the stored Part is the other tab's.
    t.docState.set((s) => ({ ...s, doc: { ...s.doc, features: [THEIRS] }, save: { state: 'saved', at: null }, sourceVersion: 3 }));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls[0][1]).toMatchObject({ feature: expect.objectContaining({ id: 'f_theirs' }), baselineVersion: 3 });
    await vi.waitFor(() => expect(t.updates).toHaveLength(1));
    expect((t.updates[0].cad_adopt as CadAdopt).importId).toBe('f_theirs');
  });

  it('a record for another Import than the saved one (another tab\'s) is made again before a link uses it', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ features: [IMPORTED], study: { cad_adopt: record({ importId: 'f_old' }) } });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    await e.start();
    // Opened again on a record of another import: matched now, for the stored one.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await e.ready())?.importId).toBe('f_imp');
    prepare.mockClear();
    // A record replaced behind its back (the study now names another import): ready() matches again.
    const u = services({ features: [IMPORTED], study: { cad_adopt: record() } });
    const f = createEditOpen(u.s, { sleep: async () => {} });
    await f.start();
    expect(prepare).not.toHaveBeenCalled();
    u.docState.set((s) => ({ ...s, doc: { ...s.doc, features: [THEIRS] } }));
    const r = await f.ready();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(r?.importId).toBe('f_theirs');
  });

  it('a Part with a design of its own is never imported into; a Part that edits no geometry does nothing', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const own = services({ features: [{ id: 'f_x', type: 'extrude', name: 'Extrude 1' } as unknown as CadDoc['features'][number]] });
    const e = createEditOpen(own.s, { sleep: async () => {} });
    await e.start();
    expect(started).toEqual([]);
    expect(await e.ready()).toBeNull();
    const none = services({ geometry: null });
    const f = createEditOpen(none.s);
    expect(f.geometry).toBeNull();
    await f.start();
    expect(started).toEqual([]);
  });

  it('the import failed or was cancelled: no adoption, the panel stays with its reason', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services();
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    runsState.set({ runs: { f_imp: { progress: null, error: 'Import failed: the file is not STEP' } } });
    await run;
    expect(closePanel).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(e.state.get().phase).toBe('idle');
  });

  it('the matching failed: a record without names and with the reason, and the note says the matching failed (review S5)', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    prepare.mockRejectedValue(new Error('the app did not answer'));
    const t = services();
    const e = createEditOpen(t.s, { sleep: async () => {} });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    finishImport();
    await run;
    expect(t.updates).toEqual([{ cad_adopt: record({ baselineDigest: expect.any(String) as unknown as string, matched: 0, error: 'the app did not answer' }) }]);
    expect(e.state.get().note).toBe('Face matching failed: the app did not answer. Boundary conditions will follow by shape only.');
  });

  it('the app had not read the faces yet (not_ready): matched once more after its retryAfter', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const first = prepare.getMockImplementation()!;
    prepare.mockImplementationOnce(async () => Promise.reject(Object.assign(new Error('not read yet'), { code: 'not_ready', retryAfter: 3 })));
    prepare.mockImplementation(first);
    const sleeps: number[] = [];
    const t = services();
    const e = createEditOpen(t.s, { sleep: async (ms) => void sleeps.push(ms) });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    finishImport();
    await run;
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(3000);
    expect((t.updates[0].cad_adopt as CadAdopt).error).toBeNull();
  });

  it('a link that the app could not fully check: the note says how many faces', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const t = services({ features: [IMPORTED], study: { cad_adopt: record() } });
    const e = createEditOpen(t.s, { sleep: async () => {} });
    await e.start();
    e.noteUnverified(0);
    expect(e.state.get().note).toBeNull();
    e.noteUnverified(3);
    expect(e.state.get().note).toBe('3 faces of Vortex CFD Test could not be checked; their boundary conditions follow by shape only.');
  });
});

describe('Edit in CAD: extra kernels for a large part', () => {
  it('none under 2,000 faces; one per ~1,000 faces, at most 12, never more than the cores less two', async () => {
    const { helperCount } = await import('../../src/link/edit-open');
    expect(helperCount(1999, 32)).toBe(0);
    expect(helperCount(2000, 32)).toBe(2);
    expect(helperCount(11_776, 32)).toBe(12);
    expect(helperCount(11_776, 8)).toBe(6);
    expect(helperCount(50_000, 64)).toBe(12);
    expect(helperCount(11_776, 2)).toBe(0);
  });
});

describe('Edit in CAD: helper kernels within a memory budget', () => {
  it('the budget: within 40 % of the device memory, at most 4 for a part over 50 MB, few when the browser does not say', async () => {
    const { helperBudget, helperPeakBytes } = await import('../../src/link/edit-open');
    const big = { faces: 11_776, partBytes: 113.1e6, brepBytes: 68.3e6 };
    // One helper on the 113 MB part: about 420 MB with the margin.
    expect(Math.round(helperPeakBytes(big.brepBytes) / 1e6)).toBe(418);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: 8 })).toBe(4);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: 4 })).toBe(4);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: 2 })).toBe(2);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: null })).toBe(2);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: 1 })).toBe(1);
    expect(helperBudget({ ...big, cores: 32, deviceMemoryGB: 0.5 })).toBe(0);
    expect(helperBudget({ ...big, cores: 4, deviceMemoryGB: 8 })).toBe(2);
    // A 20 MB part of 5,000 faces: the CPU's count (memory allows more).
    expect(helperBudget({ faces: 5000, partBytes: 20e6, brepBytes: 12e6, cores: 32, deviceMemoryGB: 8 })).toBe(5);
    expect(helperBudget({ faces: 1500, partBytes: 20e6, brepBytes: 12e6, cores: 32, deviceMemoryGB: 8 })).toBe(0);
  });

  it('warmed while the import runs, trimmed to the real BREP budget, all stopped when one fails or the matching ends', async () => {
    const { createEditOpen } = await import('../../src/link/edit-open');
    const made: { disposed: boolean }[] = [];
    const helper = () => {
      const h = { disposed: false };
      made.push(h);
      return { start: async () => ({}), dispose: () => void (h.disposed = true) } as unknown as import('../../src/types/kernel').KernelAdapter;
    };
    const step = new File(['x'], 'big.step');
    Object.defineProperty(step, 'size', { value: 113.1e6 });
    const t = services({ geometry: { ...G, faces: 11_776 }, source: async () => ({ geometryId: 'g1', file: step, format: 'step', size: step.size, sha256: 'abc', adopted: false }) });
    let kept = -1;
    let afterDrop: boolean[] = [];
    prepare.mockImplementation(async (d: { helpers(b: number): Promise<unknown[]>; dropHelpers(): void }, o: { baselineVersion: number }) => {
      // A BREP far bigger than the STEP suggested: one helper fits.
      kept = (await d.helpers(500e6)).length;
      d.dropHelpers();
      await new Promise((r) => setTimeout(r, 0));
      afterDrop = made.map((h) => h.disposed);
      return { record: { geometryId: 'g1', baselineVersion: o.baselineVersion, originalNames: null, matched: 0, total: 0 }, faces: new Map(), bodies: new Map(), table: { faces: [] }, ms: 1 };
    });
    const e = createEditOpen(t.s, { sleep: async () => {}, helper, machine: () => ({ cores: 32, deviceMemoryGB: 8 }) });
    const run = e.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    // Warmed at the import's start: 4 (the cap for a part over 50 MB).
    expect(made).toHaveLength(4);
    finishImport();
    await run;
    expect(kept).toBe(1);
    expect(afterDrop).toEqual([true, true, true, true]);
    expect(made.every((h) => h.disposed)).toBe(true);
  });
});
