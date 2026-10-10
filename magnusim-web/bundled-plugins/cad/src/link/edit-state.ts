// Edit in CAD: what the open flow (edit-open.ts) shows, per app, for the views that
// read it (the line over the viewport, the Imported panel's note). Kept apart from
// edit-open.ts so a panel can read it without importing the import feature back.
// Owner: LINK (Edit in CAD).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { StateStore } from '../types/state';

export interface EditOpenState {
  /**
   * idle: nothing to do (no geometry, or done); loading: the STEP comes from the app; waiting:
   * the app is still storing it; importing: the import panel shows it; matching: the faces are
   * matched; ready: the Part is open on it (imported, matched, or linked already); error: `line` says why.
   */
  phase: 'idle' | 'loading' | 'waiting' | 'importing' | 'matching' | 'ready' | 'error';
  /** The line shown over the viewport, or null. */
  line: string | null;
  /** 0..1 while the STEP comes from the app, else null. */
  fraction: number | null;
  /** "N faces of <Geometry> could not be matched; ..." until closed, or null. */
  note: string | null;
  /** The geometry's name (the Imported panel's "From the project" line), or null. */
  geometryName: string | null;
  /** The launch face or body was selected (tests). */
  launched: { face?: string; body?: string; selected: boolean } | null;
  /** The line's button: Stop (a wait or a download), Try again (after an error), or none. */
  action: 'stop' | 'retry' | null;
}

const stores = new WeakMap<AppServices, StateStore<EditOpenState>>();

export function setEditOpenState(services: AppServices, store: StateStore<EditOpenState>): void {
  stores.set(services, store);
}

/** The open flow's state, or null when the app made none. */
export function editOpenState(services: AppServices): StateStore<EditOpenState> | null {
  return stores.get(services) ?? null;
}
