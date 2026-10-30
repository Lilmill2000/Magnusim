// The section view's one state and who changes it. The view keeps it (ViewportHandle.state
// .section: plane, frame, offset, flip); everything that sets it goes through setSectionView here
// (INSPECT > Section view's panel and its arrow, the Assistant's workspace section), or straight
// to the view for an origin plane (the view tools' popover), so there is never a second state.
// bindSection (installed with the module) keeps it true to the Part:
//   Follows    after each rebuild, a construction plane's or a face's frame is found again and the
//              cut moves with it (an edit moved the plane; a face of a body that grew).
//   Gone       a construction plane deleted, or a plane or face not built while nothing holds it back
//              (no panel editing an earlier feature, the rollback bar at the end): the section turns
//              off, with a note (a toast, and the panel's note) saying why. While something holds it
//              back (a panel edits an earlier feature, the bar is rolled back) the cut stays where it
//              last was and the note says so; it follows again once the plane builds.
//   Kept       the Part keeps it in its view (CadView.section: saved, not undoable), written when it
//              changes (once a drag of the arrow ends), and put back when the Part opens (after its
//              first rebuild, so a construction plane or a face can be found).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import type { StateStore } from '../../types/state';
import type { AppServices } from '../../types/app';
import type { SavedSection } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';
import type { SectionState, ViewportHandle } from '../../types/viewport';
import { originFrame } from '../../viewport/section';
import { findSectionFrame, sameFrame, sectionPlaneKey, sectionPlaneWords } from './plane';

/** What the section module says beside the view's state: a note about the plane, and whether the arrow is being dragged. */
export interface SectionNotes {
  /** Why the section turned off, or why the cut stays where it last was; null when there is nothing to say. */
  note: string | null;
  /** The arrow in the view is held: the offset changes with every move (written to the Part once it is let go). */
  dragging: boolean;
}

const stores = new WeakMap<object, StateStore<SectionNotes>>();

/** The section module's notes for this Part. */
export function sectionNotes(services: Pick<AppServices, 'doc'>): StateStore<SectionNotes> {
  let s = stores.get(services.doc);
  if (!s) stores.set(services.doc, (s = createStateStore<SectionNotes>({ note: null, dragging: false })));
  return s;
}

/** What setSectionView changes: the plane, the offset (mm; 'middle': through the middle of the shown bodies along the plane's normal), the side, on or off. */
export interface SectionChoice {
  plane?: PlaneRef;
  offset?: number | 'middle';
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
 * built, a flat face found by its reference); refused in words when it cannot be. The person's panel,
 * its arrow and the Assistant's workspace section all set it here.
 */
export async function setSectionView(services: Pick<AppServices, 'doc' | 'kernel' | 'viewport'>, c: SectionChoice): Promise<SectionSet> {
  const h = services.viewport.get().handle;
  if (!h) return { ok: false, reason: 'The view is not shown now' };
  const cur = sectionIn(h);
  if (!cur) return { ok: false, reason: 'The view has no section view' };
  let frame = cur.frame;
  if (c.plane) {
    if (c.plane.kind === 'origin') frame = originFrame(c.plane.plane);
    else {
      const r = await findSectionFrame(services, c.plane);
      if (!r.ok) return { ok: false, reason: `${sectionPlaneWords(services.doc.state.get(), c.plane)}: ${r.message}` };
      frame = r.frame;
    }
  }
  // The view may have gone while the plane was found.
  const now = services.viewport.get().handle;
  if (now !== h) return { ok: false, reason: 'The view is not shown now' };
  const offset = c.offset === 'middle' ? middleOffset(h, frame) : c.offset;
  sectionNotes(services).set({ note: null });
  h.setSection({ on: c.on ?? true, ...(c.plane ? { plane: c.plane, frame } : {}), ...(offset !== undefined ? { offset } : {}), ...(c.flip !== undefined ? { flip: c.flip } : {}) });
  return { ok: true, section: sectionIn(h) ?? cur };
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

/** Keep the section view true to the Part (follow, gone, kept: see the head of this file). Returns stop. */
export function bindSection(services: AppServices): () => void {
  const { doc } = services;
  const notes = sectionNotes(services);
  let handle: ViewportHandle | null = null;
  let offState: (() => void) | null = null;
  /** The Part's saved section waits to be put back (after its first rebuild). */
  let restoring = true;
  /** Bumped by every look-up: an older answer is dropped. */
  let token = 0;
  /** The plane's words when it was last found (a deleted plane has no name to read any more). */
  let lastWords: string | null = null;
  let stopped = false;

  const say = (note: string | null, toast = false) => {
    notes.set({ note });
    if (note && toast) services.bridge.toast(note, 'info');
  };

  const persist = () => {
    const sec = handle ? sectionIn(handle) : null;
    if (!sec || restoring || notes.get().dragging) return;
    doc.setSection(savedOf(sec));
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
    if (sec.plane.kind !== 'feature' || s0.doc.features.some((f) => f.id === (sec.plane as { feature: string }).feature)) lastWords = sectionPlaneWords(s0, sec.plane);
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
    if (now.plane.kind === 'feature' && !s.doc.features.some((f) => f.id === (now.plane as { feature: string }).feature)) {
      h.setSection({ on: false });
      say(`The section view is off: ${words} was deleted.`, true);
      return;
    }
    if (heldBack(s)) {
      say(`${words} is not built now (${r.message}): the cut stays where it last was until it builds again.`);
      return;
    }
    h.setSection({ on: false });
    say(`The section view is off: ${r.message}.`, true);
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
    restoring = false;
    if (r.ok) {
      lastWords = sectionPlaneWords(doc.state.get(), saved.plane);
      h.setSection({ on: true, plane: saved.plane, frame: r.frame, offset: saved.offset, flip: saved.flip });
      return;
    }
    // Saved on a plane that is not there now: off, and the Part keeps it off.
    if (sectionIn(h)?.on) h.setSection({ on: false });
    doc.setSection(null);
    say(`The section view is off: ${r.message}.`, true);
  };

  const attach = (h: ViewportHandle | null) => {
    if (h === handle) return;
    offState?.();
    offState = null;
    handle = h;
    if (!h) return;
    offState = h.state.subscribe((v, prev) => {
      if (!v.section || !prev.section || v.section === prev.section) return;
      const turnedOn = v.section.on && !prev.section.on;
      const newPlane = sectionPlaneKey(v.section.plane) !== sectionPlaneKey(prev.section.plane);
      if (turnedOn || newPlane) {
        // A plane changed or the cut came back on: what the note said is about another cut.
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
      if (s.status === 'loading' && prev.status !== 'loading') restoring = true;
      if (restoring) {
        void restore(s);
        return;
      }
      if (s.rebuild.seq !== prev.rebuild.seq || (s.rebuild.status !== 'running' && prev.rebuild.status === 'running')) void follow();
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
