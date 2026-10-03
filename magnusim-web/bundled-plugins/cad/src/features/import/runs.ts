// The import panel's work, outside React: one run per Imported feature being
// edited (a new import, or Heal all on an existing one). It drives the
// pipeline, publishes progress for the panel, applies the outcome to the
// panel's session (one undo step for the whole session), and cleans up:
//   - closing a panel stops a run on its way (an upload stops at once; a
//     kernel step in progress stops the kernel worker, which starts again and
//     rebuilds the Part: KernelCallOptions.signal);
//   - the shapes as read (kept for Heal all) are released when the panel closes;
//   - files this panel stored that the Part does not use once it closes (a
//     discarded new import, a BREP replaced by a later Heal all) are deleted.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { FeatureId, ImportFeature } from '../../types/doc';
import type { EditSession } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { ImportedShape, ShapeId } from '../../types/kernel-protocol';
import type { StateStore } from '../../types/state';
import { filesFor, type CadFileTransfer } from '../../files/transfer';
import { isAbort, plainFileReason } from '../../files/words';
import { rememberBrep } from './feature';
import { healAgain, healKey, itemsOf, LARGE_STEP_BYTES, problemRows, readAndHeal, runImport, storeBrep, summaryOf, type HealOutcome, type ImportOutcome, type PipelineDeps, type StageProgress } from './pipeline';

export interface ImportRun {
  feature: FeatureId;
  fileName: string;
  size: number;
  /** The step running now, or null. */
  progress: StageProgress | null;
  /** Why the last action failed ("Import failed: ..."), or null. */
  error: string | null;
  /** The last import or heal of this panel (problem details live only here). */
  outcome: ImportOutcome | null;
}

interface Live {
  session: EditSession;
  abort: AbortController | null;
  raw: ShapeId[] | null;
  rawShapes: ImportedShape[];
  created: Set<string>;
}

export interface ImportRuns {
  readonly state: StateStore<{ runs: Record<FeatureId, ImportRun> }>;
  /** Start importing `file` into the new feature of `session`. */
  start(session: EditSession, file: File): void;
  /** Heal the feature of `session` again with this tolerance (and knit). */
  healAll(session: EditSession, tolerance: number, sew: boolean): Promise<void>;
  /** Stop what runs for this feature (the panel's Cancel). */
  stop(feature: FeatureId): void;
  dispose(): void;
}

const all = new WeakMap<AppServices, ImportRuns>();

export function importRunsFor(services: AppServices): ImportRuns {
  let r = all.get(services);
  if (!r) {
    r = createImportRuns(services, () => ({ kernel: services.kernel, files: filesFor(services), studyId: services.bridge.studyId }));
    all.set(services, r);
  }
  return r;
}

const errWords = (action: string, err: unknown) => {
  const k = (err as KernelCallError | null)?.kind;
  if (k === 'watchdog') return `${action} failed: the kernel was stopped after ${((err as KernelCallError).seconds ?? 0).toFixed(0)} s`;
  const m = err instanceof Error ? err.message : String(err);
  return `${action} failed: ${m.startsWith('Not stored:') ? m : plainFileReason(err).replace(/;\s*the body is unchanged\.?$/i, '')}`;
};

export function createImportRuns(services: AppServices, deps: () => PipelineDeps & { files: CadFileTransfer }): ImportRuns {
  const state = createStateStore<{ runs: Record<FeatureId, ImportRun> }>({ runs: {} });
  const live = new Map<FeatureId, Live>();

  const patch = (id: FeatureId, p: Partial<ImportRun>) =>
    state.set((s) => {
      const cur = s.runs[id];
      if (!cur) return s;
      return { runs: { ...s.runs, [id]: { ...cur, ...p } } };
    });

  const referenced = (rel: string) =>
    services.doc.state
      .get()
      .doc.features.some((f) => f.type === 'import' && ((f as ImportFeature).brep.rel === rel || (f as ImportFeature).source.rel === rel));

  async function finish(id: FeatureId) {
    const l = live.get(id);
    if (!l) return;
    live.delete(id);
    l.abort?.abort();
    if (l.raw?.length) await services.kernel.call('release', { ids: l.raw }).catch(() => {});
    const gone = [...l.created].filter((rel) => !referenced(rel));
    if (gone.length) await deps().files.remove(gone);
    state.set((s) => {
      const runs = { ...s.runs };
      delete runs[id];
      return { runs };
    });
  }

  // A session the document closed (Done, Delete, Undo, another panel) ends its run.
  const off = services.doc.state.subscribe(() => {
    for (const [id, l] of live) if (!l.session.open) void finish(id);
  });

  function begin(session: EditSession, fileName: string, size: number): Live {
    let l = live.get(session.feature);
    if (!l || l.session !== session) {
      l = { session, abort: null, raw: null, rawShapes: [], created: new Set() };
      live.set(session.feature, l);
    }
    state.set((s) => ({ runs: { ...s.runs, [session.feature]: { feature: session.feature, fileName, size, progress: null, error: null, outcome: s.runs[session.feature]?.outcome ?? null } } }));
    return l;
  }

  function apply(l: Live, outcome: ImportOutcome, brepBytes: ArrayBuffer) {
    for (const rel of outcome.created) l.created.add(rel);
    if (!l.session.open) return false;
    rememberBrep(outcome.brep.sha256, brepBytes);
    l.raw = outcome.raw;
    l.rawShapes = outcome.rawShapes;
    l.session.update({ source: outcome.source, brep: outcome.brep, heal: outcome.heal, items: outcome.items, diagnostics: outcome.diagnostics } as Partial<ImportFeature>);
    patch(l.session.feature, { outcome: { ...outcome, raw: null, created: [] }, progress: null, error: null });
    return true;
  }

  return {
    state,
    start(session, file) {
      const l = begin(session, file.name, file.size);
      const abort = new AbortController();
      l.abort = abort;
      const id = session.feature;
      void runImport(deps(), file, {
        fileName: file.name,
        tolerance: (session.draft as ImportFeature).heal?.tolerance ?? 0.001,
        sew: (session.draft as ImportFeature).heal?.sew ?? false,
        signal: abort.signal,
        onStage: (p) => patch(id, { progress: p }),
      }).then(
        async ({ outcome, brepBytes }) => {
          if (!apply(l, outcome, brepBytes)) {
            // Closed meanwhile: nothing of it stays.
            if (outcome.raw?.length) await services.kernel.call('release', { ids: outcome.raw }).catch(() => {});
            const gone = outcome.created.filter((rel) => !referenced(rel));
            if (gone.length) await deps().files.remove(gone);
          }
        },
        (err: unknown) => {
          if (isAbort(err) || !l.session.open) return;
          patch(id, { progress: null, error: errWords('Import', err) });
        },
      );
    },
    async healAll(session, tolerance, sew) {
      const f = session.draft as ImportFeature;
      const l = begin(session, f.source.fileName, f.source.size);
      const abort = new AbortController();
      l.abort = abort;
      const id = session.feature;
      const d = deps();
      const onStage = (p: StageProgress) => patch(id, { progress: p });
      const prev = state.get().runs[id]?.outcome ?? null;
      try {
        let h: HealOutcome | null = null;
        if (l.raw?.length) {
          try {
            h = await healAgain(d, l.raw, new Map(l.rawShapes.map((s) => [s.id, s] as const)), tolerance, sew, abort.signal, onStage);
          } catch (err) {
            // The shapes as read died with a kernel restart: read the stored source again.
            if ((err as KernelCallError).kind !== 'input') throw err;
            l.raw = null;
          }
        }
        if (!h) {
          const since = performance.now();
          onStage({ stage: 'loading', done: 0, total: f.source.size, since });
          const bytes = await d.files.read(f.source, { signal: abort.signal, onProgress: (p) => onStage({ stage: 'loading', done: p.done, total: p.total, since }) });
          if (!bytes) throw new Error(`its source STEP (${f.source.rel}) is not in the project any more`);
          h = await readAndHeal(d, { bytes, fileName: f.source.fileName, tolerance, sew, large: f.source.size > LARGE_STEP_BYTES }, abort.signal, onStage);
          if (h.raw) {
            if (l.raw?.length) await services.kernel.call('release', { ids: l.raw }).catch(() => {});
            l.raw = h.raw;
            l.rawShapes = h.read;
          }
        }
        const healedIds = h.healed.map((s) => s.id);
        try {
          const stored = await storeBrep(d, healedIds, f.source.sha256, healKey(tolerance, sew), abort.signal, onStage);
          if (stored.created) l.created.add(stored.brep.rel);
          if (!session.open) return;
          rememberBrep(stored.brep.sha256, stored.bytes);
          const names = new Map<ShapeId, string>(h.healed.map((s) => [s.id, s.name || 'Body']));
          const summary = summaryOf(h);
          // "Before" is the file as read: kept from the first read when the shapes were healed again.
          if (!h.before && f.diagnostics) summary.problemsBefore = f.diagnostics.problemsBefore;
          const items = itemsOf(h.healed, f.items);
          session.update({ brep: stored.brep, heal: { tolerance, sew }, items, diagnostics: summary } as Partial<ImportFeature>);
          patch(id, {
            progress: null,
            error: null,
            outcome: {
              source: f.source,
              brep: stored.brep,
              heal: { tolerance, sew },
              items,
              diagnostics: summary,
              problemsBefore: h.before ? problemRows(h.before, new Map(l.rawShapes.map((s) => [s.id, s.name] as const))) : (prev?.problemsBefore ?? []),
              problemsAfter: problemRows(h.after, names),
              looseFaces: prev?.looseFaces ?? h.looseFaces,
              healedOnRead: h.healedOnRead,
              raw: null,
              rawShapes: [],
              created: [],
            },
          });
        } finally {
          await services.kernel.call('release', { ids: healedIds }).catch(() => {});
        }
      } catch (err) {
        if (isAbort(err) || !session.open) return;
        patch(id, { progress: null, error: errWords('Heal all', err) });
      } finally {
        if (l.abort === abort) l.abort = null;
      }
    },
    stop(feature) {
      const l = live.get(feature);
      l?.abort?.abort();
      patch(feature, { progress: null });
    },
    dispose() {
      off();
      for (const id of [...live.keys()]) void finish(id);
    },
  };
}
