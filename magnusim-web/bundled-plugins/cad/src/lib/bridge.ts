// The one module that talks to the host bridge (@magnusim/workspace), so host
// API churn is absorbed here. Frozen shape (scaffold); INTEGRATE adds wrappers
// when the host gains APIs (host API 1.2: ws.files, nav.setDirty, focus on
// connect; 1.5: linking a geometry; 1.6: the exit hook; 1.7: ws.prefs).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConfirmOptions, LeaveHandler, LinkedGeometry, LinkOptions, LinkResult, PromptOptions, StudyRecord, UnitSystem, Workspace, WorkspaceContext } from '@magnusim/workspace';
import type { WsFilesApi } from '../types/docstore';

export type ToastKind = 'info' | 'success' | 'error';

/**
 * The plugin's preferences for the user, the same in every project (`ws.prefs`, host API 1.7:
 * small JSON values such as the toolbar layout). onChange hears a change made in another tab or
 * window, not this page's own.
 */
export interface PrefsApi {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  onChange(fn: (key: string, value: unknown) => void): () => void;
}

/** Host API 1.5, a study kind with `links_geometry`: the study's design as a project geometry. */
export interface LinkApi {
  linkGeometry(o: LinkOptions): Promise<LinkResult>;
  /** The geometry this study links now; null before the first link, or after the user removed it. */
  linkedGeometry(): Promise<LinkedGeometry | null>;
  /** The linked geometry was updated (this page's link or another tab's). */
  onGeometry(fn: (g: { geometryId: string; rev: number; fromRev: number | null }) => void): () => void;
}

export interface Bridge {
  readonly context: WorkspaceContext;
  readonly studyId: string;
  /** The app's unit system right now (updated by the host's `units` event). */
  units(): UnitSystem;
  onUnits(fn: (u: UnitSystem) => void): () => void;
  /** The study record changed (renamed in the header, or a save echoed back). */
  onStudy(fn: (s: StudyRecord) => void): () => void;
  study: {
    get(): Promise<StudyRecord>;
    update(patch: Record<string, unknown>, rev: number): Promise<StudyRecord>;
  };
  data: {
    read<T = unknown>(rel: string): Promise<T | null>;
    write(rel: string, doc: unknown): Promise<void>;
  };
  /**
   * The plugin's files in the project (host API 1.2, `ws.files`: etags and
   * conditional writes); null on an older host, which has only `data`.
   */
  files: WsFilesApi | null;
  /**
   * The plugin's preferences for the user, in every project (host API 1.7, `ws.prefs`); null on an
   * older host, whose SDK has no `prefs` (a 1.6 host keeps per-project data only).
   */
  prefs: PrefsApi | null;
  /** The host's toast (bottom-right of the workspace). Never throws. */
  toast(message: string, kind?: ToastKind): void;
  /** Destructive confirms only: the host's button is always red. */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  prompt(opts: PromptOptions): Promise<string | null>;
  /** Close the workspace; false when the user chose to stay (host 1.2 asks while the page is dirty). */
  back(): Promise<boolean>;
  /**
   * Tell the host the page has unsaved work (host 1.2 `nav.setDirty`): while it
   * does, every way out of the workspace asks "Leave without saving?" with this
   * message. A no-op on an older host. Never throws.
   */
  setDirty(dirty: boolean, message?: string): void;
  /** As setDirty, and resolves once the host has heard it (a link right after it must not meet "unsaved"). */
  setDirtyNow(dirty: boolean, message?: string): Promise<void>;
  /** Linking a geometry (host API 1.5); null on an older host. */
  link: LinkApi | null;
  /**
   * Register the exit hook (host API 1.6, `ws.nav.onLeave`; null clears it). Null on an
   * older host, which has no exit hook (a 1.5 host also refuses the call with `not_allowed`).
   */
  onLeave: ((handler: LeaveHandler | null) => Promise<void>) | null;
  /** The host's bridge API is at least `major.minor` (`hostVersion`, compared as numbers). */
  hostAtLeast(major: number, minor: number): boolean;
  spawnWorker(url: string | URL): Worker;
  /** The raw bridge, for tests and for calls not wrapped yet. */
  readonly raw: Workspace;
}

/** "1.2" -> [1, 2]; anything that is not two numbers -> null. */
export function parseHostVersion(v: unknown): [number, number] | null {
  const m = /^\s*(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `hostVersion` is at least major.minor, compared as numbers ("1.10" is newer than "1.9"). */
export function versionAtLeast(v: unknown, major: number, minor: number): boolean {
  const p = parseHostVersion(v);
  if (!p) return false;
  return p[0] > major || (p[0] === major && p[1] >= minor);
}

export function createBridge(ws: Workspace): Bridge {
  let units: UnitSystem = ws.context.units;
  ws.on('units', (u) => {
    units = u;
  });
  const host12 = versionAtLeast(ws.context.hostVersion, 1, 2);
  const maybeFiles = (ws as unknown as { files?: Partial<WsFilesApi> }).files;
  // Feature detection (compatibility.md 1.2): the host says 1.2 or newer, and the
  // SDK it served has the calls. A host that still refuses them ("not_allowed")
  // is caught where the store is opened (doc/store/open.ts).
  const files: WsFilesApi | null =
    host12 && maybeFiles && typeof maybeFiles.read === 'function' && typeof maybeFiles.write === 'function' && typeof maybeFiles.stat === 'function' && typeof maybeFiles.list === 'function' && typeof maybeFiles.delete === 'function'
      ? (maybeFiles as WsFilesApi)
      : null;
  const nav = ws.nav as Workspace['nav'] & { setDirty?: (dirty: boolean, message?: string) => Promise<void> };
  const canSetDirty = host12 && typeof nav.setDirty === 'function';
  const project = (ws as unknown as { project?: Partial<LinkApi> & { linkGeometry?: unknown; linkedGeometry?: unknown } }).project;
  // Feature detection (compatibility.md 1.5): the host says 1.5 or newer, and its SDK has the calls.
  const link: LinkApi | null =
    versionAtLeast(ws.context.hostVersion, 1, 5) && project && typeof project.linkGeometry === 'function' && typeof project.linkedGeometry === 'function'
      ? {
          linkGeometry: (o) => (project.linkGeometry as LinkApi['linkGeometry'])(o),
          linkedGeometry: () => (project.linkedGeometry as LinkApi['linkedGeometry'])(),
          onGeometry: (fn) => (ws as unknown as { on(e: 'geometry', f: typeof fn): () => void }).on('geometry', fn),
        }
      : null;
  // Feature detection (compatibility.md 1.6): the host says 1.6 or newer, and its SDK has the call.
  const navLeave = (ws.nav as unknown as { onLeave?: unknown }).onLeave;
  const onLeave =
    versionAtLeast(ws.context.hostVersion, 1, 6) && typeof navLeave === 'function'
      ? (handler: LeaveHandler | null) => (navLeave as (h: LeaveHandler | null) => Promise<void>).call(ws.nav, handler)
      : null;
  // Feature detection (compatibility.md, 1.7 `ws.prefs`): the SDK the host served has the calls.
  // Not gated on hostVersion: the host reports 1.6 until 1.7 is released, and the SDK it serves
  // has `prefs` exactly when its bridge answers the calls.
  const maybePrefs = (ws as unknown as { prefs?: Partial<PrefsApi> }).prefs;
  const prefs: PrefsApi | null =
    maybePrefs && typeof maybePrefs.get === 'function' && typeof maybePrefs.set === 'function' && typeof maybePrefs.remove === 'function' && typeof maybePrefs.onChange === 'function'
      ? (maybePrefs as PrefsApi)
      : null;
  return {
    context: ws.context,
    studyId: ws.context.study.id,
    units: () => units,
    onUnits: (fn) => ws.on('units', fn),
    onStudy: (fn) => ws.on('study', fn),
    study: {
      get: () => ws.study.get(),
      update: (patch, rev) => ws.study.update(patch, rev),
    },
    data: {
      read: <T>(rel: string) => ws.data.read<T>(rel),
      write: (rel, doc) => ws.data.write(rel, doc),
    },
    files,
    prefs,
    toast(message, kind = 'info') {
      ws.ui.toast(message, { kind }).catch((err: unknown) => console.warn('[cad] toast failed', err));
    },
    confirm: (opts) => ws.ui.confirm(opts),
    prompt: (opts) => ws.ui.prompt(opts),
    back: async () => (await ws.nav.back()) !== false,
    setDirty(dirty, message) {
      if (!canSetDirty) return;
      nav.setDirty!(dirty, message).catch((err: unknown) => console.warn('[cad] setDirty failed', err));
    },
    async setDirtyNow(dirty, message) {
      if (!canSetDirty) return;
      await nav.setDirty!(dirty, message);
    },
    link,
    onLeave,
    hostAtLeast: (major, minor) => versionAtLeast(ws.context.hostVersion, major, minor),
    spawnWorker: (url) => ws.spawnWorker(url),
    raw: ws,
  };
}
