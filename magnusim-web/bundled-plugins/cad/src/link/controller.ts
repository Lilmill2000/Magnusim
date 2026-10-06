// LINK (host API 1.5): bring the project's linked geometry up to date with this
// Part. "Save, then link": apply what is typed, store the model, tell the app the
// page is clean, export the saved design, write the files, call linkGeometry.
// Leaving the workspace runs it (the exit hook, host API 1.6, L3: src/link/leave.ts);
// the Part has no button of its own for it (Daniel: the sync happens on exit). The
// e2e also reaches it through window.__CAD__.link.
// - Typed text (a value typed in a field, no Enter yet): a sync of its own applies it
//   first, as Enter would. The exit hook keeps it instead (`typed: 'keep'`): the saved
//   design is linked, the text stays in its field, and the app's "Leave without
//   saving?" question after the hook asks about it as it did before L3 ("Leaving
//   discards them" stays true). The app hears "clean" only for the link, then the page's
//   unsaved state again (DocService.retellDirty).
// - The signal (the user cancelled the leave, stayed, or the hook stalled) stops it
//   between steps; it then ends as kept-editing, quietly.
// - Nothing to do when the saved design is the one the geometry was made from
//   (sourceVersion equals linkedGeometry().sourceVersion): no export at all. A
//   geometry made from a newer design (another tab's) is refused as stale at
//   once, without exporting.
// - Never a partial design (link review L1): a feature of the history that failed
//   or was stopped, or an included body the kernel calls invalid, refuses the
//   link with the reason, so the skip rule above never pins a design the Part
//   could not build whole. Except (Daniel, 2026-10-05) a broken reference Plane,
//   Axis or Point that no feature uses: it makes no body, so the design is whole
//   without it; the link goes on, the progress line says so before the export
//   ("Axis 5 is broken (not used by anything). Part 1 is updated without it.", held
//   `noteHoldMs` for the exit hook: the app's header shows it until the link's job
//   takes the header over) and the outcome's `notes` keep it. One that a feature
//   uses still refuses: that feature failed too.
// - Another tab saved a newer design while this tab has no change of its own (L3
//   review B1): this tab reads it in place (DocService.reload) and links that, or
//   skips when the geometry has it already; nothing asks. Both tabs changed it: the
//   conflict is refused with the chip's words (Reload, or Keep mine: the other tab's
//   changes are lost).
// - A removed feature type (Box, Cylinder) refuses the link with its own words
//   ("Old box is a removed feature (Box). Suppress or delete it, then leave."): the
//   "Fix, retry" of a failed feature cannot be followed for it (L3 review B2).
// - A save the app refused, when nothing would be linked anyway (never linked, no
//   included body): not a link failure (`nothingLinked`), so the exit hook leaves
//   the page dirty and the app asks "Leave without saving?" (L3 review polish 1).
// - The design linked is the one saved (L2): the saved state, the model and its
//   sourceVersion are taken together after the save, and after every wait they
//   are checked again; an edit in between goes back to the save. The app hears
//   "clean" only while the state is saved.
// - With no body included in the simulation, nothing is linked, and it says so.
// - The exit hook's camera (`view`) goes on linkGeometry too: after "Continue in
//   background" the page closes before the hook returns, and only the view given
//   with the link lands (host 1.6, authoring.md "Exit sync").
// - The app's answers (compatibility.md "1.5"):
//   stale       re-read the link; try once more only if this design is newer;
//   changed     a file changed under the call: write both again and try again;
//   superseded  a newer link of this study replaced it: nothing to do;
//   cancelled   the user kept editing (the app's question): stay, no message;
//   busy        the app is adding the last "Save as new": try again shortly
//               (only when it answers so at the call, never after the job ran);
//   unsaved     the app had not heard "clean" yet: tell it again, try again;
//   gone        the geometry was removed: link again as a first link;
//   plugin_needed and every other refusal: the app's message as it is.
//   "Save as new" resolves with created and the new geometryId:
//   linkedGeometry() names it from then on.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { LinkedGeometry, LinkResult, LinkStage, ViewState } from '@magnusim/workspace';
import type { Bridge } from '../lib/bridge';
import { commitPendingEdits, pendingEdits } from '../lib/pendingEdits';
import type { CadDoc } from '../types/doc';
import type { DocService, EndBodies } from '../types/doc-service';
import type { KernelAdapter } from '../types/kernel';
import { exportForLink, isIncluded, type LinkExport } from './export';
import { isRemovedFeature } from '../doc/features/removed';
import { REMOVED_FEATURE_TYPES } from '../types/doc';

export type LinkOutcome =
  /** The geometry already shows this saved design: nothing was exported. */
  | { outcome: 'unchanged'; sourceVersion: number; geometryId: string }
  /** `notes`: what the design left out on the way (a broken reference no feature uses). */
  | { outcome: 'linked'; sourceVersion: number; result: LinkResult; notes?: string[] }
  /** The user answered "Keep editing" (or removed the update from the Queue). */
  | { outcome: 'kept-editing'; sourceVersion: number }
  /** A newer link of this study replaced this one. */
  | { outcome: 'superseded'; sourceVersion: number }
  /**
   * No body is included in the simulation. `empty`: the Part has no body at all; `linked`: a
   * geometry exists (it keeps its last update).
   */
  | { outcome: 'nothing'; message: string; empty: boolean; linked: boolean }
  /**
   * `brief`: the reason alone, without what became of the geometry, for the app's own
   * question after an exit ("Couldn't update the project"), which says that itself.
   */
  | {
      outcome: 'failed';
      code: string;
      message: string;
      brief?: string;
      /**
       * A save the app refused while nothing would be linked anyway (the Part was never linked and
       * no body is included): the exit is not a failed update, only unsaved work.
       */
      nothingLinked?: boolean;
    }
  /** The app cannot link (host API before 1.5). */
  | { outcome: 'unavailable'; message: string };

export interface LinkProgress {
  /** 0..1, or null while it cannot say. */
  fraction: number | null;
  label: string;
  /**
   * The Part works on its own (the export in the kernel: no call to the app is in flight), so an
   * exit hook says it again now and then for the app's stall clock. Not while it waits for the
   * app or for a save: a save that never lands must still end in the app's stall question.
   */
  busy?: boolean;
  /** Waiting for the model's save (the exit hook gives up with its own words after SAVE_STUCK_MS). */
  saving?: boolean;
}

export interface SyncOptions {
  signal?: AbortSignal;
  onProgress?(p: LinkProgress): void;
  /** Show the outcome's message as a toast (default true; an exit hook hands it to the app instead). */
  notify?: boolean;
  /**
   * A value typed in a field and not applied: 'apply' it first, as Enter would (default), or
   * 'keep' it in its field and link the saved design without it (the exit hook: the app then
   * asks about the typed text, as its leave question always has).
   */
  typed?: 'apply' | 'keep';
  /**
   * The camera the project's viewport lands with, sent with the link (host 1.6). The exit hook
   * returns it too; after "Continue in background" the page closes before the hook returns, so
   * only the view given here lands.
   */
  view?: ViewState;
  /**
   * A broken reference that nothing uses is left out (`notes`): the progress line says so
   * before the export, held this long so it can be read (the exit hook; the app's header shows
   * the page's line only until the link's job takes over the header).
   */
  noteHoldMs?: number;
}

export interface LinkController {
  /**
   * Bring the linked geometry up to date. One at a time: a second call with the
   * same options while one runs gets the same answer; one with other options
   * (its own signal, progress or notify) runs after it.
   */
  sync(opts?: SyncOptions): Promise<LinkOutcome>;
  /** A sync is running. */
  readonly running: boolean;
  /** The last outcome (tests). */
  readonly last: LinkOutcome | null;
}

export interface LinkControllerOptions {
  bridge: Bridge;
  doc: DocService;
  kernel: KernelAdapter;
  /** Pause before trying again after `busy` (ms). */
  busyWaitMs?: number;
  log?(message: string, detail?: unknown): void;
}

/** Where the export goes in the plugin's folder: beside the study's model. */
export function exportPaths(studyId: string): { shape: string; faceNames: string } {
  return { shape: `studies/${studyId}/export/part.bbrep`, faceNames: `studies/${studyId}/export/face_names.json` };
}

const STAGE_WORDS: Record<LinkStage, string> = {
  queued: 'Waiting for the compute slot',
  reading: 'The app is reading the part',
  meshing: 'The app is preparing the part',
  naming: 'The app is matching the faces',
  matching: 'The app is matching the faces',
  waiting: 'Waiting for your choice',
  saving: 'The app is saving the update',
  finishing: 'Finishing',
};

function codeOf(e: unknown): string {
  const c = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return typeof c === 'string' && c ? c : 'failed';
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? '');
  return m.replace(/^Error:\s*/, '').trim() || 'the app did not answer';
}

/** "A", "A and B", "A, B and C". */
/** Reference geometry (CONSTRUCT): makes no body. */
const REFERENCE_TYPES = new Set(['ref_plane', 'ref_axis', 'ref_point']);

function listWords(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Rounds of save-then-check before it gives up on a Part that keeps changing. */
const SAVE_ROUNDS = 4;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      },
      { once: true },
    );
  });

export function createLinkController(o: LinkControllerOptions): LinkController {
  const { bridge, doc, kernel } = o;
  const log = o.log ?? ((m: string, d?: unknown) => console.warn(`[cad] ${m}`, d ?? ''));
  const busyWait = o.busyWaitMs ?? 1500;
  // The running sync. Its options live in a holder: a sync whose signal was aborted (a leave the
  // user cancelled) while it still waits (for a save on its way) is taken over by the next call.
  type Holder = { opts: SyncOptions; last: LinkProgress | null };
  let current: { p: Promise<LinkOutcome>; holder: Holder } | null = null;
  let last: LinkOutcome | null = null;

  const partTitle = () => String(bridge.context.study?.title ?? '').trim() || 'this Part';

  async function run(holder: Holder): Promise<LinkOutcome> {
    const told = { clean: false };
    try {
      return await runOnce(holder, told);
    } finally {
      // The app heard "clean" for the link: tell it the page's own state again (typed text
      // kept in a field is unsaved work; an edit made meanwhile is too).
      if (told.clean) await doc.retellDirty?.().catch((e: unknown) => log('telling the app about unsaved work failed', e));
    }
  }

  async function runOnce(holder: Holder, told: { clean: boolean }): Promise<LinkOutcome> {
    // Read at each use: a caller may take this sync over (see sync()).
    const opts = {
      get signal() {
        return holder.opts.signal;
      },
      get typed() {
        return holder.opts.typed;
      },
      get view() {
        return holder.opts.view;
      },
      get noteHoldMs() {
        return holder.opts.noteHoldMs;
      },
    };
    const link = bridge.link;
    const files = bridge.files;
    const progress = (fraction: number | null, label: string, busy = false, saving = false) => {
      try {
        holder.last = { fraction, label, ...(busy ? { busy: true } : {}), ...(saving ? { saving: true } : {}) };
        holder.opts.onProgress?.(holder.last);
      } catch (e) {
        log('a link progress listener failed', e);
      }
    };
    if (!link || !files) return { outcome: 'unavailable', message: 'This version of Magnusim cannot add a Part to the project: it needs Magnusim with host API 1.5.' };

    const keepTyped = opts.typed === 'keep';
    const stopped = (): LinkOutcome | null => (opts.signal?.aborted ? { outcome: 'kept-editing', sourceVersion: doc.state.get().sourceVersion } : null);
    if (stopped()) return stopped()!;

    // Nothing would go to the project even if the save landed: never linked, and no body the
    // rebuild shows is included (a sketch-only Part, or every body left out).
    const nothingToLink = async (): Promise<boolean> => {
      const s = doc.state.get();
      if (s.status !== 'ready' || s.view.rollback != null || s.rebuild.status !== 'done') return false;
      if (s.rebuild.bodies.some((b) => isIncluded(s.doc, b.id) && b.solids !== 0)) return false;
      return (await link.linkedGeometry().catch(() => undefined)) === null;
    };
    // Another tab's newer save is read in place at most once per sync.
    let reloaded = false;
    // Save, then link: what is typed is applied, and the model is stored.
    const saveNow = async (): Promise<LinkOutcome | null> => {
      progress(null, `Saving ${partTitle()}`, false, true);
      for (let pass = 0; ; pass++) {
        if (!keepTyped) commitPendingEdits();
        const typed = pendingEdits();
        if (!keepTyped && typed.refused) return { outcome: 'failed', code: 'unsaved', message: `The value typed in ${typed.refused.label} is not applied: ${typed.refused.error.replace(/\.$/, '')}.` };
        await doc.flush();
        let s = doc.state.get();
        if (s.status !== 'ready') return { outcome: 'failed', code: 'failed', message: s.error ?? `${partTitle()} is still loading.` };
        if (s.save.state === 'conflict')
          return {
            outcome: 'failed',
            code: 'unsaved',
            message: `${partTitle()} was also changed in another tab, so the project was not updated. Choose Reload (this tab's changes are lost) or Keep mine (the other tab's changes are lost) first.`,
            brief: `${partTitle()} was also changed in another tab. Choose Reload (this tab's changes are lost) or Keep mine (the other tab's changes are lost), then leave.`,
          };
        if (s.save.state === 'error') {
          const why = s.save.message.replace(/\.$/, '');
          // The geometry's name follows in the app's question ("Part 1 keeps its last update"): not here too.
          return { outcome: 'failed', code: 'unsaved', message: `Changes to ${partTitle()} are not saved: ${why}.`, brief: `Saving failed: ${why}.`, ...((await nothingToLink()) ? { nothingLinked: true } : {}) };
        }
        // Another tab saved a newer design and this tab has nothing of its own: take it (L3 review
        // B1). Not with text typed in a field (a reload would drop it without a word).
        if (s.save.state === 'saved' && !pendingEdits().pending && !reloaded) {
          await doc.checkStored?.();
          s = doc.state.get();
        }
        if (s.save.state === 'updated') {
          if (reloaded || pendingEdits().pending || typeof doc.reload !== 'function') return { outcome: 'failed', code: 'stale', message: `${partTitle()} changed in another tab. Reload to continue.` };
          reloaded = true;
          progress(null, `Reading ${partTitle()} as another tab saved it`);
          await doc.reload();
          const stop = stopped();
          if (stop) return stop;
          continue;
        }
        if (s.save.state === 'saved' && (keepTyped || !pendingEdits().pending)) return null;
        if (pass >= 3) return { outcome: 'failed', code: 'unsaved', message: `Changes to ${partTitle()} are not saved yet. Try again in a moment.` };
      }
    };

    // The saved design, taken together with its counter right after the save. Every
    // await below may let an edit in: then it goes back to the save (L2).
    let sourceVersion = 0;
    let docAt: CadDoc | null = null;
    let linked: LinkedGeometry | null = null;
    let end: EndBodies | null = null;
    for (let round = 0; !end || !docAt; round++) {
      if (round >= SAVE_ROUNDS) return { outcome: 'failed', code: 'unsaved', message: `${partTitle()} kept changing while it was being added to the project. Try again.` };
      const stop = (await saveNow()) ?? stopped();
      if (stop) return stop;
      const s0 = doc.state.get();
      const at = s0.doc;
      const version = s0.sourceVersion;
      // Still the saved design taken above: saved, the same model, the same counter, nothing typed.
      const same = () => {
        const s = doc.state.get();
        return s.status === 'ready' && s.save.state === 'saved' && s.doc === at && s.sourceVersion === version && (keepTyped || !pendingEdits().pending);
      };
      linked = await link.linkedGeometry();
      if (!same()) continue;
      if (linked && linked.sourceVersion === version) return { outcome: 'unchanged', sourceVersion: version, geometryId: linked.geometryId };
      // The geometry has a newer design (another tab's): the app would refuse this one as stale.
      if (linked && linked.sourceVersion > version) return { outcome: 'failed', code: 'stale', message: `${partTitle()} changed in another tab. Reload to continue.` };
      // The app refuses a link while the page says it has unsaved work. Said only while the
      // state is saved (checked just above, with no wait since): an edit after it tells the
      // app "unsaved" again by itself.
      told.clean = true;
      await bridge.setDirtyNow(false);
      if (!same()) continue;
      if (stopped()) return stopped()!;
      // Export the saved design: the bodies at the end of the history.
      progress(null, `Exporting ${partTitle()}`, true);
      const built = await doc.bodiesAtEnd();
      if (!same()) continue;
      sourceVersion = version;
      docAt = at;
      end = built;
    }

    // Never a partial design (L1): what failed or was stopped, and invalid bodies, are fixed first.
    const where = linked ? `${linked.name} keeps its last update` : 'nothing was added to the project';
    // A removed type (Box, Cylinder) cannot be fixed or retried: it is suppressed or deleted (B2).
    const gone = docAt.features.filter((f) => !f.suppressed && isRemovedFeature(f));
    const goneNames = new Set(gone.map((f) => f.name));
    const failedAll = end.failed.filter((n) => !goneNames.has(n));
    // A broken reference Plane / Axis / Point that no feature uses does not stop the link (Daniel,
    // 2026-10-05): it makes no body. A feature that uses one names it among its parents.
    const savedFeatures = docAt.features;
    const usedBy = (id: string) =>
      savedFeatures.some((g) => {
        if (g.suppressed || g.id === id) return false;
        try {
          return (doc.features.get(g.type)?.parents(g as never) ?? []).includes(id);
        } catch {
          return true;
        }
      });
    const unusedBroken = failedAll.filter((n) => {
      const f = savedFeatures.find((g) => g.name === n);
      return !!f && REFERENCE_TYPES.has(f.type) && !usedBy(f.id);
    });
    const failedNow = failedAll.filter((n) => !unusedBroken.includes(n));
    const notes = unusedBroken.length ? [`${listWords(unusedBroken)} ${unusedBroken.length === 1 ? 'is' : 'are'} broken (not used by anything).`] : [];
    if (gone.length || failedNow.length) {
      const words: string[] = [];
      const briefs: string[] = [];
      if (gone.length) {
        const one = gone.length === 1;
        const types = [...new Set(gone.map((f) => REMOVED_FEATURE_TYPES[f.type] ?? f.type))].join(', ');
        const what = `${listWords(gone.map((f) => f.name))} ${one ? 'is a removed feature' : 'are removed features'} (${types})`;
        const fix = `Suppress or delete ${one ? 'it' : 'them'}`;
        words.push(`${what}, so ${where}. ${fix} first.`);
        briefs.push(`${what}. ${fix}, then leave.`);
      }
      if (failedNow.length) {
        const one = failedNow.length === 1;
        const fix = `Fix, retry or suppress ${one ? 'it' : 'them'} first.`;
        words.push(`${listWords(failedNow)} failed to build, so ${where}. ${fix}`);
        briefs.push(`${listWords(failedNow)} failed to build. ${fix}`);
      }
      return { outcome: 'failed', code: 'not_built', message: words.join(' '), brief: briefs.join(' ') };
    }
    const savedDoc = docAt;
    if (notes.length) {
      progress(null, `${notes.join(' ')} ${partTitle()} is updated without ${unusedBroken.length === 1 ? 'it' : 'them'}.`);
      if (opts.noteHoldMs) await sleep(opts.noteHoldMs, opts.signal).catch(() => {});
      if (stopped()) return stopped()!;
    }
    const invalid = end.bodies.filter((b) => !b.valid && isIncluded(savedDoc, b.id)).map((b) => b.name);
    if (invalid.length) {
      const one = invalid.length === 1;
      const what = `${listWords(invalid)} ${one ? 'is not a valid solid' : 'are not valid solids'}`;
      const fix = `Repair ${one ? 'it' : 'them'}, or leave ${one ? 'it' : 'them'} out of the simulation, first.`;
      return { outcome: 'failed', code: 'not_built', message: `${what}, so ${where}. ${fix}`, brief: `${what}. ${fix}` };
    }
    if (stopped()) return stopped()!;
    const ex = await exportForLink(kernel, docAt, end, { signal: opts.signal });
    if ('nothing' in ex) {
      const left = linked ? `${linked.name} keeps its last update.` : 'Nothing was added to the project.';
      const why = ex.surfaces.length && !ex.excluded.length ? 'No solid body is included in the simulation (surface bodies are never sent)' : 'No body is included in the simulation';
      return { outcome: 'nothing', message: `${why}; ${left}`, empty: end.bodies.length === 0, linked: !!linked };
    }

    const paths = exportPaths(bridge.studyId);
    const write = async (x: LinkExport) => {
      progress(null, `Writing ${partTitle()} for the project`);
      const shape = await files.write(paths.shape, x.brep, { signal: opts.signal });
      const names = await files.write(paths.faceNames, x.faceNames, { signal: opts.signal });
      return {
        shape: { rel: paths.shape, format: 'brep' as const, sha256: (shape.sha256 ?? x.shapeSha256).toLowerCase() },
        faceNames: { rel: paths.faceNames, sha256: String(names.sha256 ?? '').toLowerCase() || undefined },
      };
    };
    if (stopped()) return stopped()!;
    let refs = await write(ex);
    if (stopped()) return stopped()!;
    if (!refs.faceNames.sha256) throw Object.assign(new Error('the app did not give the face names file a checksum'), { code: 'failed' });

    let basedOnRev: number | null = linked ? linked.rev : null;
    let staleTried = false;
    let changedTries = 0;
    let busyTries = 0;
    let unsavedTried = false;
    let goneTried = false;
    for (;;) {
      // The app said something about this try (a stage): it took the job, so a "busy" after it
      // is how the job ended, not the app's answer at the call, and it is not tried again.
      let heard = false;
      try {
        const view = opts.view;
        const result = await link.linkGeometry({
          shape: refs.shape,
          faceNames: { rel: refs.faceNames.rel, sha256: refs.faceNames.sha256! },
          sourceVersion,
          basedOnRev,
          ...(view ? { view } : {}),
          onProgress: (p) => {
            heard = true;
            progress(p.fraction, p.stage === 'queued' && p.ahead ? `Queued behind ${p.ahead} ${p.ahead === 1 ? 'job' : 'jobs'} (see Queue)` : (p.label ?? STAGE_WORDS[p.stage] ?? 'Updating the project'));
          },
        });
        return { outcome: 'linked', sourceVersion, result, ...(notes.length ? { notes } : {}) };
      } catch (e) {
        const code = codeOf(e);
        if (code === 'cancelled') return { outcome: 'kept-editing', sourceVersion };
        if (code === 'superseded') return { outcome: 'superseded', sourceVersion };
        if (code === 'stale' && !staleTried) {
          staleTried = true;
          linked = await link.linkedGeometry();
          // Only a design newer than the one the geometry has goes over it.
          if (!linked || sourceVersion > linked.sourceVersion) {
            basedOnRev = linked ? linked.rev : null;
            continue;
          }
        } else if (code === 'changed' && changedTries < 2) {
          changedTries++;
          refs = await write(ex);
          continue;
        } else if (code === 'busy' && !heard && busyTries < 4) {
          busyTries++;
          progress(null, 'Waiting for the app to finish adding the geometry');
          await sleep(busyWait * busyTries, opts.signal);
          continue;
        } else if (code === 'unsaved' && !unsavedTried) {
          unsavedTried = true;
          told.clean = true;
          await bridge.setDirtyNow(false);
          continue;
        } else if (code === 'gone' && !goneTried) {
          goneTried = true;
          linked = await link.linkedGeometry();
          basedOnRev = linked ? linked.rev : null;
          continue;
        }
        return { outcome: 'failed', code, message: messageOf(e) };
      }
    }
  }

  function tell(r: LinkOutcome) {
    if (r.outcome === 'linked' && r.notes?.length) bridge.toast(`${partTitle()} updated. ${r.notes.join(' ')}`, 'info');
    if (r.outcome === 'nothing') bridge.toast(r.message, 'info');
    else if (r.outcome === 'failed' || r.outcome === 'unavailable') bridge.toast(r.message, 'error');
  }

  const sameOptions = (a: SyncOptions, b: SyncOptions) => a.signal === b.signal && a.onProgress === b.onProgress && (a.notify !== false) === (b.notify !== false);

  function sync(opts: SyncOptions = {}): Promise<LinkOutcome> {
    if (current) {
      // The same call again: the same answer.
      if (sameOptions(current.holder.opts, opts)) return current.p;
      // The running one was stopped by its signal (its leave cancelled) and still waits (a save on
      // its way): this call takes it over, with what it says now.
      const h = current.holder;
      if (h.opts.signal?.aborted && !opts.signal?.aborted) {
        h.opts = opts;
        if (h.last) {
          try {
            opts.onProgress?.(h.last);
          } catch (e) {
            log('a link progress listener failed', e);
          }
        }
        return current.p;
      }
      // Other options: after the running one.
      return current.p.then(
        () => sync(opts),
        () => sync(opts),
      );
    }
    const holder: Holder = { opts, last: null };
    const p: Promise<LinkOutcome> = run(holder)
      .catch((e: unknown): LinkOutcome => {
        const code = codeOf(e);
        // Stopped by the signal (whatever the call it stopped says): quietly, as kept-editing.
        if (holder.opts.signal?.aborted) return { outcome: 'kept-editing', sourceVersion: doc.state.get().sourceVersion };
        log('updating the project failed', e);
        return { outcome: 'failed', code, message: `Updating the project from ${partTitle()} failed: ${messageOf(e)}` };
      })
      .then((r) => {
        last = r;
        if (holder.opts.notify !== false) tell(r);
        return r;
      })
      .finally(() => {
        if (current?.p === p) current = null;
      });
    current = { p, holder };
    return p;
  }

  return {
    sync,
    get running() {
      return current !== null;
    },
    get last() {
      return last;
    },
  };
}
