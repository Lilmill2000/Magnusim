// Edit in CAD (host API 1.7): opening a Part on a project geometry. Daniel: "if I
// import a step file into the main section, I should be able to ... right click the
// part itself and click like 'Edit in CAD' to open it up in the CAD stuff."
// The app makes (or finds) the Part and opens it with ws.context.geometry. Then:
// - A Part whose history is empty imports the geometry by itself: its STEP comes from
//   ws.project.geometrySource() (while the app answers not_ready: "Waiting for Magnusim to
//   finish storing <Geometry>", with Stop, at most 2 minutes; modelling waits meanwhile), and,
//   unless another tab imported it already (the stored Part is read first), goes to the
//   usual Import STEP (its panel shows the progress); the Imported feature records
//   `origin` {geometryId, sha256}. When the import is done the panel closes by itself
//   (as Done), and nothing of the File is kept.
// - Then the faces are matched to the geometry's (adopt.ts) and the study gets
//   `cad_adopt` {geometryId, importId, baselineVersion, baselineDigest, originalNames,
//   matched, total, error}, only for the Import the stored Part holds (two tabs: the one whose
//   save lost writes nothing, and runs again after its Reload): the link controller links
//   nothing while the saved design is still the import's, and its
//   first link sends originalNames, so the geometry is ADOPTED (updated in place,
//   boundary conditions carried by name) on the first Back with a real change.
// - A Part opened again finds its Import (by origin) and does not import again.
// - A Part with a design of its own and no such Import is never imported into.
// - ws.context.launch (the face the user right-clicked) selects that face once the
//   faces are known; on a geometry the Part already links, the face is the export's.
// - The geometry was REMOVED from the project (the study record's host-owned
//   `geometry_removed`, contract change 6; ws.context.geometry is then null): a Part that
//   never imported says "The geometry <G> this part was opened for was removed from the
//   project." and imports nothing; one that has a design notes "Its geometry <G> was removed.
//   Back asks before adding this part as a new geometry." and works as usual (the app asks
//   on Back; controller.ts). Once a link adds it as a new geometry the note goes.
// Nothing here changes the project: adoption is the link's, on Back.
// Owner: LINK (Edit in CAD).
// SPDX-License-Identifier: GPL-3.0-or-later
import './edit-open.css';
import { designDigest, importOf, matchToGeometry, prepareAdoption, readCadAdopt, unmatchedWords, unverifiedWords } from './adopt';
import { inFolderOrder, isIncluded } from './export';
import { startImport } from '../features/import';
import { createKernelAdapter } from '../kernel';
import { importRunsFor } from '../features/import/runs';
import { selectItem } from '../lib/selection';
import { createStateStore } from '../lib/store';
import { uiFor } from '../ui/controller';
import type { AppServices } from '../types/app';
import type { FeatureId, ImportFeature } from '../types/doc';
import type { CadAdopt, EditedGeometry, GeometrySource } from '../types/edit-geometry';
import type { KernelAdapter } from '../types/kernel';
import type { StateStore } from '../types/state';
import { setEditOpenState, type EditOpenState } from './edit-state';
import { readRemoved, type RemovedTarget } from './controller';

export type { EditOpenState } from './edit-state';

export interface EditOpen {
  readonly state: StateStore<EditOpenState>;
  /** Run once the Part is loaded. Never rejects. */
  start(): Promise<void>;
  /** The adoption record (after a preparation still running), or null when the Part edits no geometry. */
  ready(): Promise<CadAdopt | null>;
  /** The geometry this Part edits, or null. */
  readonly geometry: EditedGeometry | null;
  /** The geometry this Part edited or linked was removed from the project (study `geometry_removed`), or null. */
  readonly removed: RemovedTarget | null;
  /** A link went through: a note about a removed geometry no longer applies. */
  onLinked(r: { created?: boolean }): void;
  /** How long each step took (ms): source, import, adopt (tests, the big STEP's timings). */
  readonly timings: Record<string, number>;
  /** The line's Stop: ends a wait for the geometry, or its download. */
  stop(): void;
  /** The line's Try again, after an error or a Stop. */
  retry(): Promise<void>;
  /** A link's `unverified` (rows the app could not check): the note says so. */
  noteUnverified(n: number | null | undefined): void;
  dispose(): void;
}

/** A geometry with at least this many faces gets extra kernels for its fingerprints (adopt.ts). */
export const HELPER_MIN_FACES = 2000;

/**
 * How many extra kernels the CPU would take for a part of `faces` faces: one per ~1,000 faces,
 * at most 12, and never more than the machine's cores less two (the page and the Part's kernel).
 * The memory budget (helperBudget) usually allows fewer.
 */
export function helperCount(faces: number, cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4): number {
  if (faces < HELPER_MIN_FACES) return 0;
  return Math.max(0, Math.min(12, cores - 2, Math.ceil(faces / 1000)));
}

/**
 * A helper kernel's memory (measured 2026-10-09 in the Node kernel on a fresh worker): an empty
 * kernel is 64 MiB; reading the 113 MB part's healed BREP (68.3 MB) and the fingerprints of all
 * its 11,776 faces took it to 206.8 MiB (2.1 bytes per BREP byte), and the BREP's own copy is in
 * flight in the worker while it is read (1 more). The Vortex (0.1 MB BREP) never left 64 MiB.
 */
export const HELPER_BASE_BYTES = 64 * 2 ** 20;
export const HELPER_BYTES_PER_BREP_BYTE = 3.1;
/** Margin on that estimate. */
export const HELPER_MARGIN = 1.5;
/** A healed BREP was 0.60 of its STEP (113.1 MB -> 68.3 MB); before the BREP exists it is taken as 0.75. */
export const BREP_PER_STEP_BYTE = 0.75;
/** At most this share of the device's memory goes to helpers, all of them together. */
export const HELPER_MEMORY_SHARE = 0.4;
/** A part over this size (its STEP) never gets more than HELPER_BIG_PART_MAX helpers. */
export const HELPER_BIG_PART_BYTES = 50 * 1e6;
export const HELPER_BIG_PART_MAX = 4;
/** What the device's memory is taken to be when the browser does not say (navigator.deviceMemory): small. */
export const UNKNOWN_DEVICE_GB = 2;

/** One helper's peak for a BREP of `brepBytes`, with the margin. */
export function helperPeakBytes(brepBytes: number): number {
  return (HELPER_BASE_BYTES + HELPER_BYTES_PER_BREP_BYTE * Math.max(0, brepBytes)) * HELPER_MARGIN;
}

/**
 * How many helper kernels a part may have: the CPU's count (helperCount), within
 * HELPER_MEMORY_SHARE of the device's memory (navigator.deviceMemory, which Chrome reports up to
 * 8; unknown: UNKNOWN_DEVICE_GB), and at most HELPER_BIG_PART_MAX for a part over
 * HELPER_BIG_PART_BYTES. When unsure, fewer. (performance.measureUserAgentSpecificMemory needs a
 * cross-origin isolated page, which a plugin frame is not; performance.memory is the page's own JS
 * heap only, not its workers': neither is used.)
 */
export function helperBudget(o: { faces: number; partBytes: number; brepBytes: number; cores?: number; deviceMemoryGB?: number | null }): number {
  const cpu = helperCount(o.faces, o.cores);
  if (!cpu) return 0;
  const gb = typeof o.deviceMemoryGB === 'number' && o.deviceMemoryGB > 0 ? o.deviceMemoryGB : UNKNOWN_DEVICE_GB;
  const byMemory = Math.floor((HELPER_MEMORY_SHARE * gb * 2 ** 30) / helperPeakBytes(o.brepBytes));
  const cap = o.partBytes > HELPER_BIG_PART_BYTES ? HELPER_BIG_PART_MAX : 12;
  return Math.max(0, Math.min(cpu, byMemory, cap));
}

/** The machine as the page sees it. */
function machine(): { cores?: number; deviceMemoryGB?: number | null } {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : null;
  return { cores: nav?.hardwareConcurrency || undefined, deviceMemoryGB: nav?.deviceMemory ?? null };
}

export interface EditOpenOptions {
  /** Start one extra kernel (tests replace it); default: a kernel worker like the Part's. */
  helper?(): KernelAdapter;
  /** The machine (tests): cores and navigator.deviceMemory. */
  machine?(): { cores?: number; deviceMemoryGB?: number | null };
  /** How long it waits for a geometry the app answers not_ready for (default 2 minutes). */
  waitMs?: number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The longest wait for a geometry the app is still updating (review S7). */
export const WAIT_MS = 120_000;

const codeOf = (e: unknown) => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'failed');
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e ?? '')).replace(/^Error:\s*/, '').trim() || 'the app did not answer';
const stopped = () => Object.assign(new Error('stopped'), { code: 'stopped' });

/** A STEP name startImport takes ("part.igs" from the app's normalized STEP -> "part.step"). */
function asStep(src: GeometrySource, g: EditedGeometry): File {
  const name = src.file.name || g.fileName || `${g.name}.step`;
  if (/\.(step|stp)$/i.test(name)) return src.file;
  return new File([src.file], `${name.replace(/\.[^.\\/]*$/, '') || g.name}.step`, { type: src.file.type || 'application/step' });
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(stopped());
      },
      { once: true },
    );
  });

export function createEditOpen(services: AppServices, opts: EditOpenOptions = {}): EditOpen {
  const { bridge, doc } = services;
  const geometry = bridge.edit?.geometry ?? null;
  let removed = readRemoved((bridge.context?.study as unknown as Record<string, unknown> | undefined)?.geometry_removed);
  const sleep = opts.sleep ?? defaultSleep;
  const state = createStateStore<EditOpenState>({ phase: 'idle', line: null, fraction: null, note: null, geometryName: geometry?.name ?? null, launched: null, action: null });
  setEditOpenState(services, state);
  const timings: Record<string, number> = {};
  let pending: Promise<void> | null = null;
  // The face matching and its record (what the link waits for; never the import itself).
  let adopting: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let record: CadAdopt | null = null;
  // Stop (the waiting line's button): ends a wait or a download of the source.
  let stopCtl: AbortController | null = null;
  // The import this tab started is running (modelling waits for it).
  let importing = false;
  // This tab's import met another tab's save (Changed in another tab): run again after the Reload.
  let rerunAfterReload = false;
  /** A link waits from now until the adoption is recorded (or will not be). */
  const hold = () => {
    if (release) return;
    adopting = new Promise<void>((r) => {
      release = () => {
        release = null;
        r();
      };
    });
  };
  const ui = uiFor(services);
  const set = (p: Partial<EditOpenState>) => {
    state.set((s) => ({ ...s, ...p }));
    // The toolbar reads the edit block when it draws, and draws again when the selection store
    // changes: the same items and filter, the filter as a new array (the store skips an equal state),
    // so the block's start and end show at once.
    if ('phase' in p) services.selection.set((s) => ({ ...s, filter: [...s.filter] }));
  };
  // While the Part is being opened on the geometry, modelling waits (review S7): a sketch made now
  // would go before the import, and Import STEP would collide with it.
  const offBlock = geometry
    ? ui.addEditBlock(() => {
        const ph = state.get().phase;
        if (ph === 'loading' || ph === 'waiting') return `Opening ${geometry.name} from the project`;
        if (ph === 'importing' && importing) return `${geometry.name} is being imported`;
        return null;
      })
    : () => {};

  // Extra kernels for a large part's fingerprints: started while the import runs (their start-up
  // is then not waited for), as many as the memory budget allows for the STEP's estimated BREP;
  // trimmed to the real BREP's budget when the matching starts; stopped once the faces are matched,
  // or at once when one fails.
  let pool: Promise<KernelAdapter[]> | null = null;
  let poolFor: { faces: number; partBytes: number } | null = null;
  const budget = (faces: number, partBytes: number, brepBytes: number) => helperBudget({ faces, partBytes, brepBytes, ...(opts.machine ?? machine)() });
  const warmPool = (faces: number, partBytes: number, brepBytes = partBytes * BREP_PER_STEP_BYTE) => {
    if (pool) return;
    const n = budget(faces, partBytes, brepBytes);
    if (!n) return;
    poolFor = { faces, partBytes };
    const make = opts.helper ?? (() => createKernelAdapter({ spawn: (url) => bridge.spawnWorker(url) }));
    pool = Promise.allSettled(
      Array.from({ length: n }, async () => {
        const k = make();
        try {
          await k.start();
          return k;
        } catch (e) {
          k.dispose();
          throw e;
        }
      }),
    ).then((rs) => rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
  };
  const stopPool = async () => {
    const p = pool;
    pool = null;
    if (p) for (const k of await p.catch(() => [])) k.dispose();
  };
  /** The helpers the real BREP's budget allows (the others are stopped now). */
  const helpersFor = async (brepBytes: number): Promise<KernelAdapter[]> => {
    if (!pool || !poolFor) return [];
    const all = await pool.catch(() => [] as KernelAdapter[]);
    const n = budget(poolFor.faces, poolFor.partBytes, brepBytes);
    for (const k of all.slice(n)) k.dispose();
    const kept = all.slice(0, n);
    pool = Promise.resolve(kept);
    return kept;
  };
  const deps = () => ({ bridge, kernel: services.kernel, doc: () => doc.state.get().doc, helpers: helpersFor, dropHelpers: () => void stopPool() });

  async function studyPatch(patch: Record<string, unknown>) {
    for (let i = 0; ; i++) {
      const s = await bridge.study.get();
      try {
        await bridge.study.update(patch, s.rev);
        return;
      } catch (e) {
        if (i >= 4 || !/stale|rev/i.test(`${codeOf(e)} ${messageOf(e)}`)) throw e;
        await sleep(100 * (i + 1));
      }
    }
  }

  /**
   * The geometry's STEP. While the app answers not_ready (the geometry is updating, or its faces
   * are not read yet) it waits, at most WAIT_MS, with Stop on the line (review S7). Null when it
   * cannot (the line says why, with Try again: one message, not a toast too, review N1).
   */
  async function source(g: EditedGeometry): Promise<GeometrySource | null> {
    const edit = bridge.edit!;
    const t0 = performance.now();
    const ctl = new AbortController();
    stopCtl = ctl;
    const limit = opts.waitMs ?? WAIT_MS;
    try {
      for (;;) {
        set({ phase: 'loading', line: `Opening ${g.name} from the project`, fraction: null, action: 'stop' });
        try {
          const src = await edit.source({ signal: ctl.signal, onProgress: (done, total) => set({ fraction: total > 0 ? Math.min(1, done / total) : null }) });
          timings.source = performance.now() - t0;
          return src;
        } catch (e) {
          if (ctl.signal.aborted || codeOf(e) === 'stopped') throw stopped();
          if (codeOf(e) !== 'not_ready') throw e;
          const left = limit - (performance.now() - t0);
          if (left <= 0) {
            set({ phase: 'error', line: `${g.name} is still not ready after ${Math.round(limit / 60_000)} minutes. Try again in a moment, or go back and choose Edit in CAD again later.`, fraction: null, action: 'retry' });
            return null;
          }
          const after = Number((e as { retryAfter?: unknown }).retryAfter);
          set({ phase: 'waiting', line: `Waiting for Magnusim to finish storing ${g.name}`, fraction: null, action: 'stop' });
          await sleep(Math.min(left, Math.min(10, Math.max(1, Number.isFinite(after) ? after : 2)) * 1000), ctl.signal);
        }
      }
    } catch (e) {
      if (codeOf(e) === 'stopped') {
        set({ phase: 'error', line: `Stopped opening ${g.name}. Nothing was imported.`, fraction: null, action: 'retry' });
        return null;
      }
      set({ phase: 'error', line: `${g.name} could not be opened in CAD: ${messageOf(e).replace(/\.$/, '')}.`, fraction: null, action: 'retry' });
      return null;
    } finally {
      if (stopCtl === ctl) stopCtl = null;
    }
  }

  /** Until the import of `feature` ends: 'done' (built, its panel open or closed), 'failed', 'gone'. */
  function importEnded(feature: FeatureId): Promise<'done' | 'failed' | 'gone'> {
    const runs = importRunsFor(services);
    return new Promise((resolve) => {
      const look = () => {
        const run = runs.state.get().runs[feature];
        const s = doc.session();
        const open = s && s.open && s.feature === feature ? (s.draft as ImportFeature) : null;
        const stored = doc.state.get().doc.features.find((f) => f.id === feature) as ImportFeature | undefined;
        if (run?.error) return 'failed';
        if (open) return open.brep?.rel && open.items?.length && !run?.progress ? 'done' : null;
        if (stored?.brep?.rel && stored.items?.length) return 'done';
        // The panel closed with no import (Cancel, Delete).
        return run?.progress ? null : 'gone';
      };
      const check = () => {
        const r = look();
        if (!r) return;
        off1();
        off2();
        resolve(r);
      };
      const off1 = runs.state.subscribe(check);
      const off2 = doc.state.subscribe(check);
      queueMicrotask(check);
    });
  }

  /** This tab's Import is the one the stored Part holds, and nothing of it is unsaved or conflicting. */
  const savedHolds = (id: FeatureId) => {
    const s = doc.state.get();
    return s.status === 'ready' && s.save.state === 'saved' && s.doc.features.some((f) => f.id === id);
  };

  async function autoImport(g: EditedGeometry): Promise<ImportFeature | null> {
    let src = await source(g);
    if (!src) return null;
    // Another tab may have imported meanwhile (two tabs chose Edit in CAD at once, review B1): read
    // what is stored before importing; its Import is used, never a second one.
    await doc.checkStored?.().catch(() => {});
    if (doc.state.get().save.state === 'updated') await doc.reload().catch(() => {});
    const now = doc.state.get().doc;
    const theirs = importOf(now, g.id);
    if (theirs || now.features.length) {
      src = null;
      set({ phase: 'idle', line: null, action: null });
      return theirs;
    }
    const t0 = performance.now();
    let file: File | null = asStep(src, g);
    const origin = { geometryId: g.id, sha256: src.sha256 };
    // Nothing of the source is kept here: the import stores its own copy (plan risk 6, 113 MB).
    src = null;
    set({ phase: 'importing', line: null, fraction: null, action: null });
    warmPool(g.faces, file.size);
    const ok = startImport(services, file, { origin } as Partial<ImportFeature>);
    file = null;
    const id = ok ? doc.session()?.feature : undefined;
    if (!id) {
      // startImport's toast says why.
      set({ phase: 'idle', line: null });
      return null;
    }
    importing = true;
    set({ phase: 'importing' });
    let end: 'done' | 'failed' | 'gone';
    try {
      end = await importEnded(id);
    } finally {
      importing = false;
    }
    if (end !== 'done') {
      // The import panel says why (or the user cancelled it): nothing more here.
      set({ phase: 'idle', line: null });
      return null;
    }
    // From the commit on, a link waits for the faces to be matched (a Back right now must adopt the
    // geometry, never make a new one).
    hold();
    const p = ui.state.get().panel;
    if (p?.kind === 'feature' && p.feature === id) ui.closePanel();
    await doc.flush().catch(() => {});
    timings.import = performance.now() - t0;
    if (!savedHolds(id)) {
      // Another tab saved first: the chip offers Reload; this tab records nothing for an import that
      // is not the stored one, and runs again on what the Reload reads.
      rerunAfterReload = true;
      set({ phase: 'idle', line: null });
      return null;
    }
    return (doc.state.get().doc.features.find((f) => f.id === id) as ImportFeature | undefined) ?? null;
  }

  function selectLaunch(o: { table: { faces: { index: number; label: string }[] } } | null, map: { face(index: number): { body: string; index: number } | null; body(index: number): string | null }) {
    const launch = bridge.edit?.launch;
    if (!launch || (!launch.face && !launch.body)) return;
    // The user picked something while the faces were matched: theirs stays (review N6).
    if (services.selection.get().items.length) return set({ launched: { ...launch, selected: false } });
    let selected = false;
    if (launch.face) {
      const byLabel = o?.table.faces.find((f) => f.label === launch.face)?.index;
      const n = byLabel ?? Number(/^\s*face\s*(\d+)/i.exec(launch.face)?.[1]);
      const hit = Number.isFinite(n) ? map.face(n) : null;
      if (hit) {
        selectItem(services.selection, { kind: 'face', body: hit.body, index: hit.index }, false);
        selected = true;
      }
    } else if (launch.body) {
      const n = Number(/(\d+)\s*$/.exec(launch.body)?.[1]);
      const body = Number.isFinite(n) ? map.body(n) : null;
      if (body) {
        selectItem(services.selection, { kind: 'body', body }, false);
        selected = true;
      }
    }
    set({ launched: { ...launch, selected } });
  }

  /** The launch face on a geometry the Part links: the export's visit order (when it is up to date). */
  async function selectLinkedLaunch() {
    const launch = bridge.edit?.launch;
    if (!launch || (!launch.face && !launch.body) || !bridge.link) return;
    try {
      const linked = await bridge.link.linkedGeometry();
      const s = doc.state.get();
      if (!linked || linked.sourceVersion !== s.sourceVersion) return set({ launched: { ...launch, selected: false } });
      const end = await doc.bodiesAtEnd();
      const included = inFolderOrder(s.doc, end.bodies).filter((b) => isIncluded(s.doc, b.id));
      const r = (await services.kernel.call('link_export', { ids: included.map((b) => b.shape) })).result;
      selectLaunch(null, {
        face: (n) => (n >= 1 && n <= r.visit_body.length ? { body: included[r.solids[r.visit_body[n - 1] - 1].src].id, index: r.visit_face[n - 1] } : null),
        body: (n) => (n >= 1 && n <= r.solids.length ? included[r.solids[n - 1].src].id : null),
      });
    } catch (e) {
      console.warn('[cad] selecting the launch face failed', e);
    }
  }

  async function adopt(g: EditedGeometry, f: ImportFeature, baselineVersion: number, baselineDigest: string | null): Promise<void> {
    hold();
    try {
      await adoptNow(g, f, baselineVersion, baselineDigest);
    } finally {
      release?.();
    }
  }

  async function adoptNow(g: EditedGeometry, f: ImportFeature, baselineVersion: number, baselineDigest: string | null) {
    const t0 = performance.now();
    let outcome: Awaited<ReturnType<typeof prepareAdoption>> | null = null;
    let made: CadAdopt;
    set({ phase: 'matching', line: `Matching the faces of ${g.name}`, fraction: null, action: null });
    warmPool(g.faces, f.source?.size ?? 0, f.brep?.size ?? 0);
    try {
      try {
        outcome = await prepareAdoption(deps(), { geometry: g, feature: f, baselineVersion, baselineDigest, studyId: bridge.studyId });
      } catch (e) {
        // The app had not read the geometry's faces yet: once more after its retryAfter.
        if (codeOf(e) !== 'not_ready') throw e;
        const after = Number((e as { retryAfter?: unknown }).retryAfter);
        await sleep(Math.min(10, Math.max(1, Number.isFinite(after) ? after : 2)) * 1000);
        outcome = await prepareAdoption(deps(), { geometry: g, feature: f, baselineVersion, baselineDigest, studyId: bridge.studyId });
      }
      made = outcome.record;
    } catch (e) {
      // No sidecar: Back still updates the geometry in place, its faces matched by shape only. The
      // note says the matching failed, and why (review S5), not that faces "could not be matched".
      console.warn('[cad] matching the faces failed', e);
      made = { geometryId: g.id, importId: f.id, baselineVersion, baselineDigest, originalNames: null, matched: 0, total: g.faces, error: messageOf(e) };
    }
    // Only for the Import the stored Part holds (another tab's save may have come in meanwhile).
    if (savedHolds(f.id)) {
      record = made;
      await studyPatch({ cad_adopt: made }).catch((e: unknown) => console.warn('[cad] recording the adoption failed', e));
    } else {
      rerunAfterReload = true;
    }
    timings.adopt = performance.now() - t0;
    for (const [k, v] of Object.entries(outcome?.prof ?? {})) timings[`adopt_${k}`] = v;
    set({ phase: 'ready', line: null, note: unmatchedWords(made, g.name) });
    const o = outcome;
    selectLaunch(o, { face: (n) => o?.faces.get(n) ?? null, body: (n) => o?.bodies.get(n) ?? null });
  }

  /** The baseline of an import just saved alone: its save counter and its design. */
  async function baselineOf(): Promise<[number, string | null]> {
    const s = doc.state.get();
    const only = s.doc.features.length === 1 && s.save.state === 'saved';
    return only ? [s.sourceVersion, await designDigest(s.doc)] : [-1, null];
  }

  /** The geometry was removed: say so (nothing is imported), or note what Back will ask. */
  function runRemoved(r: RemovedTarget) {
    if (!doc.state.get().doc.features.length) set({ phase: 'removed', line: `The geometry ${r.name} this part was opened for was removed from the project.`, action: null });
    else set({ phase: 'ready', note: `Its geometry ${r.name} was removed. Back asks before adding this part as a new geometry.` });
  }

  async function run() {
    if (doc.state.get().status !== 'ready') return;
    if (removed) return runRemoved(removed);
    const g = geometry;
    if (!g || !bridge.edit) return;
    if (g.linked) {
      await selectLinkedLaunch();
      set({ phase: 'ready' });
      return;
    }
    let f = importOf(doc.state.get().doc, g.id);
    const fresh = !f;
    if (!f) {
      // A design of its own (no Import of this geometry): never imported into.
      if (doc.state.get().doc.features.length) return;
      f = await autoImport(g);
      if (!f) return;
    }
    const known = readCadAdopt((await bridge.study.get().catch(() => null))?.cad_adopt);
    if (known && known.geometryId === g.id && known.importId === f.id && !fresh) {
      record = known;
      set({ note: unmatchedWords(known, g.name) });
      if (bridge.edit.launch && (bridge.edit.launch.face || bridge.edit.launch.body)) await adoptLaunchOnly(f);
      set({ phase: 'ready' });
      return;
    }
    // The baseline: the save counter and the design with only the import saved. A Part edited since
    // (an adoption never recorded, or another tab's import) has none: its first Back links.
    const [v, digest] = await baselineOf();
    await adopt(g, f, v, digest);
  }

  /** Reopened with a launch face: match again (nothing written) to find it. */
  async function adoptLaunchOnly(f: ImportFeature) {
    warmPool(geometry?.faces ?? 0, f.source?.size ?? 0, f.brep?.size ?? 0);
    const o = await matchToGeometry(deps(), f).catch((e: unknown) => {
      console.warn('[cad] matching the faces for the launch face failed', e);
      return null;
    });
    selectLaunch(o, { face: (n) => o?.faces.get(n) ?? null, body: (n) => o?.bodies.get(n) ?? null });
  }

  function begin(): Promise<void> {
    pending = run()
      .catch((e: unknown) => {
        console.warn('[cad] opening the geometry failed', e);
        set({ phase: 'error', line: `${geometry?.name ?? 'The geometry'} could not be opened in CAD: ${messageOf(e)}`, action: 'retry' });
      })
      .finally(() => {
        release?.();
        void stopPool();
      });
    return pending;
  }

  // After this tab's import lost to another tab's save, the user's Reload reads the stored Part:
  // run again on it (it finds that Import and its record, or matches it).
  const offReload = doc.state.subscribe(() => {
    const s = doc.state.get();
    if (!rerunAfterReload || s.status !== 'ready' || s.save.state !== 'saved') return;
    rerunAfterReload = false;
    void (pending ?? Promise.resolve()).then(() => begin());
  });

  return {
    state,
    geometry,
    get removed() {
      return removed;
    },
    onLinked(r) {
      if (!removed || !r.created) return;
      removed = null;
      const st = state.get();
      set({ note: null, ...(st.phase === 'removed' ? { phase: 'ready', line: null } : {}) });
    },
    timings,
    start() {
      return pending ?? begin();
    },
    stop() {
      stopCtl?.abort();
    },
    retry() {
      if (state.get().phase !== 'error') return Promise.resolve();
      set({ phase: 'idle', line: null, action: null });
      return (pending ?? Promise.resolve()).then(() => begin());
    },
    async ready() {
      if (adopting) await adopting;
      let r = record ?? readCadAdopt((await bridge.study.get().catch(() => null))?.cad_adopt);
      // The record must describe the Import the saved Part holds; another tab's (or an older) record
      // is made again for it before anything is linked (review B1).
      const g = geometry;
      const f = g ? importOf(doc.state.get().doc, g.id) : null;
      if (g && f && r && r.importId !== f.id && savedHolds(f.id)) {
        await adopt(g, f, -1, null);
        r = record;
      }
      return r;
    },
    noteUnverified(n) {
      const words = unverifiedWords(n, geometry?.name ?? 'the geometry');
      if (words) set({ note: words });
    },
    dispose() {
      offBlock();
      offReload();
      stopCtl?.abort();
      void stopPool();
    },
  };
}
