// The one module that talks to the host bridge (@magnusim/workspace), so host
// API churn is absorbed here. Frozen shape (scaffold); INTEGRATE adds wrappers
// when the host gains APIs (host API 1.2: ws.files, nav.setDirty, focus on
// connect).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConfirmOptions, PromptOptions, StudyRecord, UnitSystem, Workspace, WorkspaceContext } from '@magnusim/workspace';
import type { WsFilesApi } from '../types/docstore';

export type ToastKind = 'info' | 'success' | 'error';

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
    hostAtLeast: (major, minor) => versionAtLeast(ws.context.hostVersion, major, minor),
    spawnWorker: (url) => ws.spawnWorker(url),
    raw: ws,
  };
}
