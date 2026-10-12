// L3 (host API 1.6): the exit hook. Every way out of the workspace the app owns
// (its Back, browser Back or a link, another project, Home, Open in 3D) runs it
// first, so the project's geometry gets the design the user leaves with
// (authoring.md "Exit sync (1.6)"):
// - It runs the link controller (controller.ts: save, then link) with the leave's
//   signal and its progress in the app's header. Nothing changed since the last
//   link: no export, it just returns the camera.
// - The camera the user left with goes back as a ViewState (model mm, Z up, the
//   vertical fovDeg, an orthographic view's full visible height): the project's
//   viewport lands looking the same way, also when nothing was linked. The same view
//   goes on linkGeometry: after "Continue in background" the page closes before the
//   hook returns, and only the link's view lands (host 1.6).
// - No body included in the simulation: no link, and the leave goes on, with the plain
//   message ("No body is included in the simulation; Part 1 keeps its last update.") as
//   the leave's progress line in the app's header, and the leave waits NOTHING_SHOWN_MS
//   for it to be read (Cancel there keeps the Part open). No page toast: it said the same
//   twice and covered the view controls (L3 review polish 3), and it closes with the
//   workspace anyway. An empty Part that was never linked (no body at all) has nothing
//   to say: it leaves at once.
// - "Keep editing" in the app's question (cancelled), or the user stopping the leave:
//   it returns quietly; the app has ended the leave and the Part stays open.
// - A refused link (a feature that failed or was stopped, an invalid body, the app's
//   own refusals such as plugin_needed) throws CAD's message: the app asks "Couldn't
//   update the project" with it (Stay, or Leave anyway).
// - A value typed in a field and not applied stays in its field (typed: 'keep'): the
//   saved design is linked, and the app's "Leave without saving?" question after the
//   hook asks about the typed text, as it always has.
// - A save the app refused while nothing would be linked anyway (never linked, no body
//   included: `nothingLinked`) is not a failed update: the hook tells the app the page's
//   unsaved state again and returns ok, so the app asks its own "Leave without saving?"
//   with the reason, not "Couldn't update the project" (L3 review polish 1).
// - A save still on its way after SAVE_STUCK_MS (25 s): the hook gives up with its own
//   words ("Part 1 is still saving after 25 seconds."), before the app's 30 s stall
//   question would say "it did not answer" (L3 review polish 2). Stay keeps the Part, and
//   the save goes on; a later leave takes the same sync over.
// - The app's stall clock (30 s with no progress and no call) must not fire while the
//   kernel exports a large part: that progress (busy) is said again every 5 s. Waiting for
//   a save or for the app is not repeated: a save that never lands ends in the app's
//   stall question (Stay, or Leave anyway).
// - A host before 1.6 has no exit hook (bridge.onLeave null, or the call refused with
//   not_allowed): nothing is registered.
// The Part has no page-level Done: a panel's Done closes the panel; leaving is the
// app's Back. A page-level Done would call nav.back() (bridge.back) and the hook syncs.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { LeaveEvent, LeaveHandler, ViewState } from '@magnusim/workspace';
import type { Bridge } from '../lib/bridge';
import type { SavedCamera } from '../types/doc';
import type { DocService } from '../types/doc-service';
import { FOV_DEG } from '../viewport/colors';
import type { LinkController, LinkOutcome } from './controller';

/** What the hook gives back: `ok` (the leave goes on), and the camera when there is one. */
export interface LeaveResult {
  ok: true;
  view?: ViewState;
}

/** How often the last progress is said again while the hook works (the app's stall clock is 30 s). */
export const LEAVE_HEARTBEAT_MS = 5_000;

/**
 * A save still on its way this long into a leave ends the hook with CAD's own words, before the
 * app's stall clock (30 s with no progress) asks with its generic ones.
 */
export const SAVE_STUCK_MS = 25_000;

/**
 * How long the leave waits with "No body is included…" in the app's header (the app draws the
 * progress line 400 ms after the leave starts; the toast goes with the workspace).
 */
export const NOTHING_SHOWN_MS = 3_000;

const finite3 = (v: readonly number[] | undefined): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * The Part's camera as the app's ViewState: positions in model mm (the export has no
 * transform), Z up as both viewports, the vertical field of view (three.js `fov`), and the
 * orthographic view's full visible height at the target. Null when it is not a usable view.
 */
export function viewStateOf(cam: SavedCamera | null | undefined, fovDeg: number = FOV_DEG): ViewState | null {
  if (!cam || !finite3(cam.position) || !finite3(cam.target) || !finite3(cam.up)) return null;
  const d = cam.target.map((t, i) => t - cam.position[i]);
  if (Math.hypot(d[0], d[1], d[2]) <= 1e-9) return null;
  const position: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
  const target: [number, number, number] = [cam.target[0], cam.target[1], cam.target[2]];
  const up: [number, number, number] = [cam.up[0], cam.up[1], cam.up[2]];
  if (cam.projection === 'orthographic') {
    if (!(Number.isFinite(cam.orthoHeight) && cam.orthoHeight > 0)) return null;
    return { position, target, up, projection: 'orthographic', height: cam.orthoHeight };
  }
  if (!(Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180)) return null;
  return { position, target, up, projection: 'perspective', fovDeg };
}

export interface LeaveHookOptions {
  bridge: Bridge;
  doc: DocService;
  link: LinkController;
  /** The camera now (the viewport's), or null before the viewport exists. */
  camera(): SavedCamera | null;
  /** The last leave's outcome (tests read it through window.__CAD__). */
  onOutcome?(o: { reason: string; outcome: LinkOutcome | null; view: ViewState | null; error: string | null }): void;
  heartbeatMs?: number;
  /** NOTHING_SHOWN_MS by default (tests shorten it). */
  nothingShownMs?: number;
  /** SAVE_STUCK_MS by default (tests shorten it). */
  saveStuckMs?: number;
  log?(message: string, detail?: unknown): void;
}

/** The exit hook's handler (exported for the unit tests; installLeaveHook registers it). */
export function createLeaveHandler(o: LeaveHookOptions): (leave: LeaveEvent) => Promise<LeaveResult> {
  const { bridge, doc, link } = o;
  const log = o.log ?? ((m: string, d?: unknown) => console.warn(`[cad] ${m}`, d ?? ''));
  return async ({ reason, signal, progress }) => {
    // The camera the user leaves with (taken before anything else can move it).
    let view: ViewState | null = null;
    try {
      view = viewStateOf(o.camera());
    } catch (e) {
      log('reading the camera failed', e);
    }
    const withView = (): LeaveResult => (view ? { ok: true, view } : { ok: true });
    const report = (outcome: LinkOutcome | null, error: string | null) => {
      try {
        o.onOutcome?.({ reason, outcome, view, error });
      } catch {
        // tests only
      }
    };
    // The Part never loaded (still loading, or it could not be read): nothing of it can be
    // newer than the geometry's design, and nothing is lost by leaving.
    if (doc.state.get().status !== 'ready') {
      report(null, null);
      return { ok: true };
    }
    let last: { fraction: number | null; label: string; busy: boolean } | null = null;
    // A save that does not land: CAD's own words at SAVE_STUCK_MS, before the app's stall question.
    let stuckTimer: ReturnType<typeof setTimeout> | null = null;
    let stuck!: (e: Error) => void;
    const stuckP = new Promise<never>((_resolve, reject) => {
      stuck = reject;
    });
    stuckP.catch(() => {});
    const say = (fraction: number | null, label: string, busy: boolean, saving: boolean) => {
      last = { fraction, label, busy };
      if (saving) {
        if (!stuckTimer) {
          stuckTimer = setTimeout(() => {
            const s = Math.round((o.saveStuckMs ?? SAVE_STUCK_MS) / 1000);
            const title = String(bridge.context.study?.title ?? '').trim() || 'The Part';
            stuck(new Error(`${title} is still saving after ${s} seconds.`));
          }, o.saveStuckMs ?? SAVE_STUCK_MS);
        }
      } else if (stuckTimer) {
        clearTimeout(stuckTimer);
        stuckTimer = null;
      }
      if (!signal.aborted) progress(fraction, label);
    };
    const beat = setInterval(() => {
      if (last && last.busy && !signal.aborted) progress(last.fraction, last.label);
    }, o.heartbeatMs ?? LEAVE_HEARTBEAT_MS);
    let r: LinkOutcome;
    try {
      r = await Promise.race([
        // A broken reference nothing uses (Daniel, 2026-10-05): the header says it is left out, long enough to read.
        link.sync({ signal, notify: false, typed: 'keep', noteHoldMs: o.nothingShownMs ?? NOTHING_SHOWN_MS, ...(view ? { view } : {}), onProgress: (p) => say(p.fraction, p.label, p.busy === true, p.saving === true) }),
        stuckP,
      ]);
    } catch (e) {
      // Only the stuck save rejects here (the controller answers with outcomes): the app asks
      // "Couldn't update the project" with these words; Stay keeps the Part and its save going.
      const message = e instanceof Error ? e.message : String(e);
      report(null, message);
      throw new Error(message);
    } finally {
      clearInterval(beat);
      if (stuckTimer) clearTimeout(stuckTimer);
    }
    // The user stopped the leave (Cancel, Stay, or the app's stall question): nothing more to say.
    if (signal.aborted) {
      report(r, null);
      return { ok: true };
    }
    // A line in the app's header the user gets time to read before the workspace closes (the
    // header's line only: no page toast, it said the same twice; L3 review polish 3).
    const showFor = async (line: string) => {
      progress(null, line);
      const wait = o.nothingShownMs ?? NOTHING_SHOWN_MS;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    };
    switch (r.outcome) {
      case 'linked':
      case 'unchanged':
      case 'superseded':
      // Not now (the removed target's question, contract change 6): nothing linked, the leave goes on.
      case 'not-now':
        report(r, null);
        return withView();
      case 'nothing': {
        // Not a failure: the geometry keeps its last update (or none is made), and the leave goes
        // on once the user could read why. An empty Part never linked: nothing to say.
        if (!(r.empty && !r.linked)) {
          await showFor(r.message);
          if (signal.aborted) {
            report(r, null);
            return { ok: true };
          }
        }
        report(r, null);
        return withView();
      }
      case 'kept-editing':
        // "Keep editing": the app has ended the leave; the Part stays open as it is.
        report(r, null);
        return { ok: true };
      case 'failed':
      case 'unavailable':
      default: {
        if (r.outcome === 'failed' && r.nothingLinked) {
          // Nothing was ever linked and nothing would be: only unsaved work. The app hears it again
          // and asks its own "Leave without saving?" with the reason (L3 review polish 1).
          await doc.retellDirty?.().catch((e: unknown) => log('telling the app about unsaved work failed', e));
          report(r, null);
          return withView();
        }
        // The reason alone: the app's question adds what became of the geometry itself.
        const message = (r.outcome === 'failed' ? r.brief || r.message : 'message' in r ? r.message : '') || 'The Part could not be added to the project.';
        report(r, message);
        throw new Error(message);
      }
    }
  };
}

/**
 * Register the exit hook once the page is connected. Resolves 'on' when the app runs it from
 * now on, 'unavailable' on a host before 1.6 (nothing registered).
 */
export async function installLeaveHook(o: LeaveHookOptions): Promise<'on' | 'unavailable'> {
  const register = o.bridge.onLeave;
  if (!register) return 'unavailable';
  const handler = createLeaveHandler(o);
  try {
    await register(handler as LeaveHandler);
    return 'on';
  } catch (e) {
    const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
    if (code !== 'not_allowed') (o.log ?? ((m: string, d?: unknown) => console.warn(`[cad] ${m}`, d ?? '')))('the exit hook could not be registered', e);
    return 'unavailable';
  }
}
