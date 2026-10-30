// The section view's one state and who changes it. The view keeps it (ViewportHandle.state
// .section: plane, frame, offset, flip); everything that sets it goes through setSectionView here
// (INSPECT > Section view's panel and its arrow, the Assistant's workspace section; sectionOn for the
// view tools' button and the command), or straight to the view for an origin plane (the view tools'
// popover) and for off, so there is never a second state.
// bindSection (installed with the module) keeps it true to the Part:
//   Follows    after each rebuild, a construction plane's or a face's frame is found again and the
//              cut moves with it (an edit moved the plane; a face of a body that grew).
//   Gone       a construction plane deleted, or a plane or face not built while nothing holds it back
//              (no panel editing an earlier feature, the rollback bar at the end): the section turns
//              off and back to Front (so the next cut has a plane to start on), with a note (a toast,
//              and the panel's note) saying why. While something holds it back (a panel edits an
//              earlier feature, the bar is rolled back) the cut stays where it last was and the note
//              says so (rolled back, when the bar is above it); it follows again once the plane builds.
//   Kept       the Part keeps it in its view (CadView.section: saved, not undoable), written when it
//              changes (once a drag of the arrow ends), and put back when the Part opens (after its
//              first rebuild, so a construction plane or a face can be found). Held back as the Part
//              opens (the bar above its plane): off for now and still kept, with a note; it comes back
//              once the plane builds, unless the person sets another cut first.
//   Notes      a note says why until the cut changes: turned off (by anyone), on again or on another
//              plane, what it said is about another cut and it goes.
// sectionOn turns the cut on where its plane is now (the view tools' button, INSPECT > Section view).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import type { StateStore } from '../../types/state';
import type { AppServices } from '../../types/app';
import type { SavedSection } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';
import type { SectionState, ViewportHandle } from '../../types/viewport';
import { DEFAULT_SECTION, originFrame, startOffset } from '../../viewport/section';
import { findSectionFrame, sameFrame, sectionPlaneKey, sectionPlaneWords } from './plane';

/** What the section module says beside the view's state: a note about the plane, and whether the arrow is being dragged. */
export interface SectionNotes {
  /** Why the section turned off, or why the cut stays where it last was; null when there is nothing to say. */
  note: string | null;
  /** The arrow in the view is held: the offset changes with every move (written to the Part once it is let go). */
  dragging: boolean;
  /** The Part's saved section waits for its plane to build (rolled back as the Part opened): INSPECT > Section view opens without cutting. */
  waiting: boolean;
}

const stores = new WeakMap<object, StateStore<SectionNotes>>();

/** The section module's notes for this Part. */
export function sectionNotes(services: Pick<AppServices, 'doc'>): StateStore<SectionNotes> {
  let s = stores.get(services.doc);
  if (!s) stores.set(services.doc, (s = createStateStore<SectionNotes>({ note: null, dragging: false, waiting: false })));
  return s;
}

/** What setSectionView changes: the plane, the offset, the side, on or off. */
export interface SectionChoice {
  plane?: PlaneRef;
  /** mm along the plane's normal; 'middle': through the middle of the shown bodies; 'start': where a cut that comes on starts (startOffset). */
  offset?: number | 'middle' | 'start';
  flip?: boolean;
  on?: boolean;
}

export type SectionSet = { ok: true; section: SectionState } | { ok: false; reason: string };

/** The middle of the shown bodies along a frame's normal (its offset from the frame's origin), 0 with none. */
export function middleOffset(h: Pick<ViewportHandle, 'sectionRange'>, frame: SectionState['frame']): number {
  const r = h.sectionRange(frame);
  return r ? (r[0] + r[1]) / 2 : 0;
}

/**
 * Change the section view (on, unless `on` is false): a new plane is found first (a construction plane
 * built, a flat face found by its reference), and so is the plane it had when the cut comes back on
 * (it may have moved while the cut was off); refused in words when it cannot be, except that a plane
 * held back (rolled back, a panel open on an earlier feature) comes back on where it last was. The
 * person's panel, its arrow, the view tools' button and the Assistant's workspace section set it here.
 */
export async function setSectionView(services: Pick<AppServices, 'doc' | 'kernel' | 'viewport'>, c: SectionChoice): Promise<SectionSet> {
  const h = services.viewport.get().handle;
  if (!h) return { ok: false, reason: 'The view is not shown now' };
  const cur = sectionIn(h);
  if (!cur) return { ok: false, reason: 'The view has no section view' };
  const on = c.on ?? true;
  const plane = c.plane ?? cur.plane;
  let frame = cur.frame;
  if (c.plane?.kind === 'origin') frame = originFrame(c.plane.plane);
  else if (plane.kind !== 'origin' && (c.plane || (on && !cur.on))) {
    const r = await findSectionFrame(services, plane);
    const s = services.doc.state.get();
    if (r.ok) frame = r.frame;
    else if (c.plane || !heldBack(s) || !inPart(s, plane)) return { ok: false, reason: goneWords(s, plane, r.message) };
  }
  // The view may have gone while the plane was found.
  const now = services.viewport.get().handle;
  if (now !== h) return { ok: false, reason: 'The view is not shown now' };
  const offset = c.offset === 'middle' ? middleOffset(h, frame) : c.offset === 'start' ? startOffset(h, { plane, frame }) : c.offset;
  sectionNotes(services).set({ note: null });
  h.setSection({ on, ...(c.plane ? { plane: c.plane, frame } : frame !== cur.frame ? { frame } : {}), ...(offset !== undefined ? { offset } : {}), ...(c.flip !== undefined ? { flip: c.flip } : {}) });
  return { ok: true, section: sectionIn(h) ?? cur };
}

/**
 * Turn the cut on (the view tools' section button, INSPECT > Section view): on the plane it had, found
 * where it is now, from where a new cut starts (startOffset: at a construction plane, else through the
 * middle of the shown bodies). A plane that is gone (deleted, or not built while nothing holds it
 * back) gives way to Front, and the panel's note says why.
 */
export async function sectionOn(services: Pick<AppServices, 'doc' | 'kernel' | 'viewport'>): Promise<SectionSet> {
  const r = await setSectionView(services, { on: true, offset: 'start' });
  const h = services.viewport.get().handle;
  if (r.ok || !h || !sectionIn(h)) return r;
  const front = await setSectionView(services, { plane: DEFAULT_SECTION.plane, offset: 'start' });
  if (front.ok) sectionNotes(services).set({ note: `${r.reason}: the section view cuts on Front.` });
  return front;
}

/** The view's section state, or null for a view without one (a test's stand-in). */
function sectionIn(h: Pick<ViewportHandle, 'state'>): SectionState | null {
  return (h.state.get() as { section?: SectionState }).section ?? null;
}

/** The section as the Part keeps it (null: off). */
export function savedOf(s: SectionState): SavedSection | null {
  return s.on ? { plane: s.plane, offset: s.offset, flip: s.flip } : null;
}

/** Whether something holds a plane back from building now: a panel editing a feature (the later ones wait), or the rollback bar above the end. */
function heldBack(s: DocState): boolean {
  return s.session !== null || s.view.rollback !== null;
}

/** The plane is still in the Part (a deleted construction plane is not). */
function inPart(s: Pick<DocState, 'doc'>, p: PlaneRef): boolean {
  return p.kind !== 'feature' || s.doc.features.some((f) => f.id === p.feature);
}

/** The rollback bar is above the plane: its construction plane, or the feature that made its face, comes after the bar. */
function rolledBack(s: Pick<DocState, 'doc' | 'view'>, p: PlaneRef): boolean {
  const bar = s.view.rollback;
  if (bar === null || p.kind === 'origin') return false;
  const id = p.kind === 'feature' ? p.feature : /^F:([^:|]+):/.exec(p.ref.name)?.[1];
  const at = id ? s.doc.features.findIndex((f) => f.id === id) : -1;
  return at >= 0 && at >= bar;
}

/** Why a held-back plane is not built now, in words: rolled back, or what the panels say. */
function heldWords(s: DocState, p: PlaneRef, words: string, message: string): string {
  return rolledBack(s, p) ? `${words} is rolled back` : `${words} is not built now (${message})`;
}

/** Why a plane cannot be cut on now, in words ("Plane 1 did not build", not "Plane 1: Plane 1 did not build"). */
function goneWords(s: DocState, p: PlaneRef, message: string): string {
  if (!inPart(s, p)) return 'The plane the cut was on was deleted';
  const words = sectionPlaneWords(s, p);
  return message.startsWith(words) ? message : `${words}: ${message}`;
}

/** Keep the section view true to the Part (follow, gone, kept: see the head of this file). Returns stop. */
export function bindSection(services: AppServices): () => void {
  const { doc } = services;
  const notes = sectionNotes(services);
  let handle: ViewportHandle | null = null;
  let offState: (() => void) | null = null;
  /** The Part's saved section waits to be put back (after its first rebuild). */
  let restoring = true;
  /** The Part's saved section, held back as the Part opened (the bar above its plane): off for now, put back once the plane builds. */
  let pending: SavedSection | null = null;
  /** Bumped by every look-up: an older answer is dropped. */
  let token = 0;
  /** The plane's words when it was last found (a deleted plane has no name to read any more). */
  let lastWords: string | null = null;
  let stopped = false;

  const say = (note: string | null, toast = false) => {
    notes.set({ note });
    if (note && toast) services.bridge.toast(note, 'info');
  };

  /** The saved section waits for its plane (or no longer does). */
  const wait = (p: SavedSection | null) => {
    pending = p;
    if (notes.get().waiting !== !!p) notes.set({ waiting: !!p });
  };

  const persist = () => {
    const sec = handle ? sectionIn(handle) : null;
    if (!sec || restoring || notes.get().dragging) return;
    // A cut set while the saved one waited for its plane: this one is kept.
    wait(null);
    doc.setSection(savedOf(sec));
  };

  /** Off, and back to Front for the next cut (the view tools' button cuts again), saying why: the plane is gone. */
  const gone = (h: ViewportHandle, note: string) => {
    h.setSection({ ...DEFAULT_SECTION });
    say(note, true);
  };

  /** Find the plane again where it is now (after a rebuild, or as the section comes on). */
  const follow = async () => {
    const h = handle;
    if (!h || restoring) return;
    const sec = sectionIn(h);
    if (!sec || !sec.on || sec.plane.kind === 'origin') return;
    if (doc.state.get().rebuild.status === 'running') return;
    const my = ++token;
    const key = sectionPlaneKey(sec.plane);
    const s0 = doc.state.get();
    if (inPart(s0, sec.plane)) lastWords = sectionPlaneWords(s0, sec.plane);
    const r = await findSectionFrame(services, sec.plane);
    if (stopped || my !== token || handle !== h) return;
    const now = sectionIn(h);
    if (!now || !now.on || sectionPlaneKey(now.plane) !== key) return;
    if (r.ok) {
      if (!sameFrame(r.frame, now.frame)) h.setSection({ frame: r.frame });
      say(r.warning ? `${r.warning}: the cut follows it` : null);
      return;
    }
    const s = doc.state.get();
    const words = lastWords ?? 'The plane';
    if (!inPart(s, now.plane)) return gone(h, `The section view is off: ${words} was deleted.`);
    if (heldBack(s)) {
      say(`${heldWords(s, now.plane, words, r.message)}: the cut stays where it last was until it builds again.`);
      return;
    }
    gone(h, `The section view is off: ${r.message}.`);
  };

  /** Put back the Part's saved section once its first rebuild is drawn. */
  const restore = async (s: DocState) => {
    const h = handle;
    if (!h || !restoring || s.status !== 'ready' || s.rebuild.seq === 0 || s.rebuild.status === 'running') return;
    const saved = s.view.section ?? null;
    const my = ++token;
    if (!saved) {
      restoring = false;
      if (sectionIn(h)?.on) h.setSection({ on: false });
      return;
    }
    const r = saved.plane.kind === 'origin' ? { ok: true as const, frame: originFrame(saved.plane.plane) } : await findSectionFrame(services, saved.plane);
    if (stopped || my !== token || handle !== h) return;
    if (r.ok) {
      restoring = false;
      lastWords = sectionPlaneWords(doc.state.get(), saved.plane);
      h.setSection({ on: true, plane: saved.plane, frame: r.frame, offset: saved.offset, flip: saved.flip });
      return;
    }
    const s1 = doc.state.get();
    const held = heldBack(s1) && inPart(s1, saved.plane);
    // Off for now (still restoring: nothing is written); a plane that is gone leaves Front for the next cut.
    if (!held) h.setSection({ ...DEFAULT_SECTION });
    else if (sectionIn(h)?.on) h.setSection({ on: false });
    restoring = false;
    if (held) {
      // Rolled back as the Part opens (or a panel holds it): the Part keeps it, and it comes back once the plane builds.
      wait(saved);
      lastWords = sectionPlaneWords(s1, saved.plane);
      say(`${heldWords(s1, saved.plane, lastWords, r.message)}: the section view comes back when it builds.`, true);
      return;
    }
    // Saved on a plane that is not there now: off, and the Part keeps it off.
    doc.setSection(null);
    say(`The section view is off: ${r.message}.`, true);
  };

  /** The saved section that waited for its plane (held back as the Part opened): on again once the plane builds, dropped when it is gone. */
  const retry = async () => {
    const h = handle;
    const p = pending;
    if (!h || !p || restoring || doc.state.get().rebuild.status === 'running') return;
    const my = ++token;
    const r = p.plane.kind === 'origin' ? { ok: true as const, frame: originFrame(p.plane.plane) } : await findSectionFrame(services, p.plane);
    if (stopped || my !== token || handle !== h || pending !== p) return;
    const s = doc.state.get();
    if (r.ok) {
      wait(null);
      lastWords = sectionPlaneWords(s, p.plane);
      h.setSection({ on: true, plane: p.plane, frame: r.frame, offset: p.offset, flip: p.flip });
      return;
    }
    if (heldBack(s) && inPart(s, p.plane)) {
      say(`${heldWords(s, p.plane, lastWords ?? sectionPlaneWords(s, p.plane), r.message)}: the section view comes back when it builds.`);
      return;
    }
    wait(null);
    doc.setSection(null);
    say(inPart(s, p.plane) ? `The section view is off: ${r.message}.` : `The section view is off: ${lastWords ?? 'The plane'} was deleted.`, true);
  };

  const attach = (h: ViewportHandle | null) => {
    if (h === handle) return;
    offState?.();
    offState = null;
    handle = h;
    if (!h) return;
    offState = h.state.subscribe((v, prev) => {
      if (!v.section || !prev.section || v.section === prev.section) return;
      const turned = v.section.on !== prev.section.on;
      const newPlane = sectionPlaneKey(v.section.plane) !== sectionPlaneKey(prev.section.plane);
      if (turned || newPlane) {
        // The cut turned off (by anyone), came back on or moved to another plane: what the note said is about another cut.
        if (notes.get().note) notes.set({ note: null });
        if (v.section.on && v.section.plane.kind !== 'origin') void follow();
      }
      persist();
    });
    void restore(doc.state.get());
  };

  attach(services.viewport.get().handle);
  const offs = [
    services.viewport.subscribe((v) => attach(v.handle)),
    doc.state.subscribe((s, prev) => {
      // Loaded again (Reload after a conflict): its saved section applies again.
      if (s.status === 'loading' && prev.status !== 'loading') {
        restoring = true;
        wait(null);
      }
      if (restoring) {
        void restore(s);
        return;
      }
      if (s.rebuild.seq !== prev.rebuild.seq || (s.rebuild.status !== 'running' && prev.rebuild.status === 'running')) {
        void follow();
        void retry();
      }
    }),
    // A drag of the arrow ends: what it set is written now.
    notes.subscribe((n, prev) => {
      if (prev.dragging && !n.dragging) persist();
    }),
  ];
  return () => {
    stopped = true;
    offState?.();
    for (const off of offs) off();
  };
}
