// The one module that talks to the host bridge (@magnusim/workspace), so host
// API churn is absorbed here. Frozen shape (scaffold); INTEGRATE adds wrappers
// when the host gains APIs (host API 1.2: ws.files, nav.setDirty, focus on
// connect; 1.5: linking a geometry; 1.6: the exit hook; 1.7: ws.prefs, and
// Edit in CAD: the geometry a Part edits, its source and its faces; unreleased 1.9:
// ws.assistant, the tools the Part offers the app's Assistant, and its panel's keys, and the
// host's appearance, ws.context.appearance and its 'appearance' event; Magnusim CAD's welcome
// flag ws.context.projectLinks, false where there are no projects and no simulation).
// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  AssistantHandler,
  AssistantRegistration,
  AssistantStopAnswer,
  AssistantTool,
  AssistantTurn,
  AssistantUndoAnswer,
  AssistantUndoOffer,
  ConfirmOptions,
  LeaveHandler,
  LinkedGeometry,
  LinkOptions,
  LinkResult,
  PromptOptions,
  StudyRecord,
  UnitSystem,
  Workspace,
  WorkspaceContext,
} from '@magnusim/workspace';
import type { WsFilesApi } from '../types/docstore';
import type { EditedGeometry, EditLaunch, GeometryFaces, GeometrySource, OriginalNamesRef } from '../types/edit-geometry';

export type ToastKind = 'info' | 'success' | 'error';

/**
 * The host's appearance (unreleased 1.9: ws.context.appearance, and the 'appearance' event with
 * the same object): the theme as resolved ('system' already decided), the person's choice, and
 * the text and icon scales (Settings offers 0.9, 1, 1.15 and 1.3, and 0.85, 1, 1.25 and 1.5). The
 * SDK writes data-theme, data-theme-pref, --mg-text-scale and --mg-icon-scale on the frame's
 * <html> itself, before any listener hears a change, and the page has them from its first paint
 * (the server puts the look in it); theme.css takes color-scheme from data-theme. So the CSS
 * follows with no code; CAD never sets them.
 */
export interface Appearance {
  theme: 'light' | 'dark';
  preference: 'system' | 'light' | 'dark';
  textScale: number;
  iconScale: number;
}

/** What a host without an appearance gives: light, at scale 1. */
export const LIGHT_APPEARANCE: Readonly<Appearance> = Object.freeze({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });

/** A host's appearance object as CAD takes it: anything but a "dark" theme is light, a scale out of 0.5..3 is 1. */
export function appearanceOf(raw: unknown): Appearance {
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const theme = typeof a.theme === 'string' && /^dark$/i.test(a.theme.trim()) ? 'dark' : 'light';
  const preference = a.preference === 'system' || a.preference === 'light' || a.preference === 'dark' ? a.preference : theme;
  const scale = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 3 ? v : 1);
  return { theme, preference, textScale: scale(a.textScale), iconScale: scale(a.iconScale) };
}

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
  /** `originalNames` (1.7, Edit in CAD): the first link of a Part that edits a project geometry. */
  linkGeometry(o: LinkOptions & { originalNames?: OriginalNamesRef }): Promise<LinkResult & { adopted?: boolean }>;
  /** The geometry this study links now; null before the first link, or after the user removed it. */
  linkedGeometry(): Promise<LinkedGeometry | null>;
  /** The linked geometry was updated (this page's link or another tab's). */
  onGeometry(fn: (g: { geometryId: string; rev: number; fromRev: number | null }) => void): () => void;
}

/**
 * Edit in CAD (host API 1.7): the project geometry this Part was opened to edit. Null on an older
 * host, or when the Part edits no geometry.
 */
export interface EditApi {
  /** ws.context.geometry: what the Part edits (null when it edits none). */
  readonly geometry: EditedGeometry | null;
  /** ws.context.launch: where the user right-clicked (one-shot), or null. */
  readonly launch: EditLaunch | null;
  /** The geometry's STEP as a File (refusals: not_allowed, gone, no_source, not_ready with retryAfter). */
  source(o?: { signal?: AbortSignal; onProgress?(done: number, total: number): void }): Promise<GeometrySource>;
  /** The geometry's face table now (before adoption: the original's). */
  faces(): Promise<GeometryFaces>;
}

/**
 * The tools this page offers the app's Assistant (unreleased host API 1.9, `ws.assistant`). Null on
 * a host whose SDK has no `ws.assistant`. A call's progress goes through the call itself
 * (`call.progress(fraction, label, {waiting})`; an older host ignores `waiting`).
 */
export interface CadAssistantBridge {
  /**
   * Offer the tools (register([], null) withdraws them). An older host that refuses the call answers
   * {available: false, reason: 'not_allowed'} instead of rejecting.
   */
  register(tools: readonly AssistantTool[], handler: AssistantHandler | null, opts?: { guide?: string; review?: { rounds: number; prompt: string } }): Promise<AssistantRegistration>;
  /** Hear this tab's turns (start, change, end); null on a host without turn events. */
  onTurn: ((fn: (turn: AssistantTurn) => void) => () => void) | null;
  /** Stop a turn this page was told of; null on a host without turn events. */
  stop: ((turn: string) => Promise<AssistantStopAnswer>) | null;
  /** The app shows its own Assistant panel with Stop and "Undo these changes": the chip leaves its own out. */
  docked: boolean;
  /** Offer (label) or withdraw (null) the undo of a turn's changes in the app's panel; null on a host without it. */
  setUndo: ((turn: string, label: string | null) => Promise<AssistantUndoOffer>) | null;
  /** Undo a turn's changes when the app's panel asks; null on a host without it. */
  onUndo: ((fn: ((turn: string) => AssistantUndoAnswer | Promise<AssistantUndoAnswer>) | null) => () => void) | null;
}

export interface Bridge {
  readonly context: WorkspaceContext;
  readonly studyId: string;
  /** The app's unit system right now (updated by the host's `units` event). */
  units(): UnitSystem;
  onUnits(fn: (u: UnitSystem) => void): () => void;
  /**
   * The host's appearance now (unreleased: ws.context.appearance, updated by its 'appearance'
   * event). A host without it (feature detection: the context has no `appearance`) gives
   * LIGHT_APPEARANCE, and the Part stays light.
   */
  appearance(): Appearance;
  /** The resolved theme now: 'light' on a host without an appearance. */
  theme(): 'light' | 'dark';
  /** Each change of the host's appearance (never on a host without one). Returns unsubscribe. */
  onAppearance(fn: (a: Appearance) => void): () => void;
  /** The study record changed (renamed in the header, or a save echoed back). */
  onStudy(fn: (s: StudyRecord) => void): () => void;
  /**
   * The host has projects to link the Part into, and so a simulation: true in Magnusim. Magnusim
   * CAD (the desktop edition: no projects, no simulations) says false in its welcome
   * (ws.context.projectLinks, unreleased 1.9); absent, as on Magnusim and older hosts,
   * it is true. Read once. False: the Part shows no simulation control and the Assistant offers
   * none; a body's stored choice stays in the document.
   */
  projectLinks(): boolean;
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
  /**
   * Destructive confirms only: the host's button is always red. `guard`: Yes takes a deliberate
   * click only (disabled at first, never Enter); `safe`: Enter answers Cancel. Hosts before the
   * unreleased 1.9 ignore both (a plain confirm).
   */
  confirm(opts: ConfirmOptions & { guard?: boolean; safe?: boolean }): Promise<boolean>;
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
  /** Edit in CAD (host API 1.7); null on an older host (its SDK has no geometrySource). */
  edit: EditApi | null;
  /**
   * Register the exit hook (host API 1.6, `ws.nav.onLeave`; null clears it). Null on an
   * older host, which has no exit hook (a 1.5 host also refuses the call with `not_allowed`).
   */
  onLeave: ((handler: LeaveHandler | null) => Promise<void>) | null;
  /** The app's Assistant (unreleased 1.9, `ws.assistant`); null on a host whose SDK has none. */
  assistant: CadAssistantBridge | null;
  /**
   * The keys of the app's Assistant panel the person chose in Settings → Keybinds (unreleased 1.9,
   * ws.context.assistantKeys): their combos as the host sent them, [] when they left it no key;
   * null for its default (Ctrl+/ by the character "/"), and on an older host. Read live.
   */
  assistantKeys(): readonly string[] | null;
  /** Hear the person change them (the host's `assistantKeys` event); a no-op on an older host. */
  onAssistantKeys(fn: (keys: readonly string[] | null) => void): () => void;
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

/**
 * `ws.assistant` when the SDK the host served has it (unreleased 1.9). Not gated on hostVersion:
 * the host reports 1.8 until 1.9 is released, and the SDK it serves has `assistant` exactly when
 * its bridge answers the calls. Its turn events (onTurn, stop) are feature-detected apart.
 */
export function assistantOf(ws: Workspace): CadAssistantBridge | null {
  const a = (ws as unknown as { assistant?: Partial<NonNullable<Workspace['assistant']>> }).assistant;
  if (!a || typeof a.register !== 'function') return null;
  const register = a.register.bind(a);
  const onTurn = typeof a.onTurn === 'function' ? a.onTurn.bind(a) : null;
  const stop = typeof a.stop === 'function' ? a.stop.bind(a) : null;
  // Undo from the app's panel (the dock), feature-detected apart as well.
  const setUndo = typeof a.setUndo === 'function' ? a.setUndo.bind(a) : null;
  const onUndo = typeof a.onUndo === 'function' ? a.onUndo.bind(a) : null;
  return {
    async register(tools, handler, opts) {
      try {
        return await register([...tools], handler, opts);
      } catch (e) {
        // A host whose bridge has no assistant.register refuses it.
        if ((e as { code?: unknown } | null)?.code === 'not_allowed') return { available: false, accepted: [], refused: [], reason: 'not_allowed' };
        throw e;
      }
    },
    onTurn: onTurn ? (fn) => onTurn(fn) : null,
    stop: stop ? (turn) => stop(turn) : null,
    docked: a.docked === true,
    setUndo: setUndo ? (turn, label) => setUndo(turn, label) : null,
    onUndo: onUndo ? (fn) => onUndo(fn) : null,
  };
}

/**
 * The Assistant panel's keys as the SDK reads what the host sent (its assistantKeysOf): the text
 * ones of a list (each once), or null for the default. Kept as sent: the SDK forwards a press by
 * these very strings, and the host writes them as CAD stores a combo ("Ctrl+KeyK").
 */
export function assistantKeysOf(v: unknown): readonly string[] | null {
  return Array.isArray(v) ? Object.freeze([...new Set(v.filter((k): k is string => typeof k === 'string'))]) : null;
}

export function createBridge(ws: Workspace): Bridge {
  let units: UnitSystem = ws.context.units;
  ws.on('units', (u) => {
    units = u;
  });
  // The Assistant panel's keys (unreleased 1.9): the welcome's context.assistantKeys, then each
  // change the host sends (the `assistantKeys` event). A host whose welcome has no assistantKeys
  // has no such keys and sends no event: the default, as before.
  let assistantKeys = assistantKeysOf(ws.context.assistantKeys);
  const keyListeners = new Set<(keys: readonly string[] | null) => void>();
  if ('assistantKeys' in ws.context) {
    try {
      ws.on('assistantKeys', (keys) => {
        assistantKeys = assistantKeysOf(keys);
        for (const fn of [...keyListeners]) fn(assistantKeys);
      });
    } catch (err) {
      console.warn('[cad] the assistantKeys event is not heard; the keys the Part opened with apply', err);
    }
  }
  // Feature detection (unreleased 1.9: the host's appearance): the context has `appearance`, and
  // the SDK sends each change as 'appearance'. An older host has neither: light, scale 1.
  const withAppearance = ws.context as typeof ws.context & { appearance?: unknown };
  const hasAppearance = !!withAppearance.appearance && typeof withAppearance.appearance === 'object';
  let appearance: Appearance = hasAppearance ? appearanceOf(withAppearance.appearance) : { ...LIGHT_APPEARANCE };
  const appearanceListeners = new Set<(a: Appearance) => void>();
  const hearAppearance = (raw: unknown) => {
    appearance = appearanceOf(raw);
    for (const fn of [...appearanceListeners]) {
      try {
        fn(appearance);
      } catch (err) {
        console.error('[cad] appearance listener failed', err);
      }
    }
  };
  if (hasAppearance) (ws as unknown as { on(e: 'appearance', fn: (a: unknown) => void): () => void }).on('appearance', hearAppearance);
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
  // Feature detection (compatibility.md 1.7, Edit in CAD): the host says 1.7 or newer, and its SDK
  // has the calls.
  const editProject = project as unknown as { geometrySource?: unknown; geometryFaces?: unknown } | undefined;
  const ctx = ws.context as typeof ws.context & { geometry?: EditedGeometry | null; launch?: EditLaunch | null };
  const edit: EditApi | null =
    versionAtLeast(ws.context.hostVersion, 1, 7) && editProject && typeof editProject.geometrySource === 'function' && typeof editProject.geometryFaces === 'function'
      ? {
          geometry: ctx.geometry ?? null,
          launch: ctx.launch ?? null,
          source: (o) => (editProject.geometrySource as EditApi['source']).call(project, o),
          faces: () => (editProject.geometryFaces as EditApi['faces']).call(project),
        }
      : null;
  // Magnusim CAD's welcome flag (ws.context.projectLinks === false): absent means projects.
  const projectLinks = ws.context.projectLinks !== false;
  const bridge: Bridge = {
    context: ws.context,
    projectLinks: () => projectLinks,
    assistant: assistantOf(ws),
    assistantKeys: () => assistantKeys,
    onAssistantKeys(fn) {
      keyListeners.add(fn);
      return () => {
        keyListeners.delete(fn);
      };
    },
    studyId: ws.context.study.id,
    units: () => units,
    onUnits: (fn) => ws.on('units', fn),
    appearance: () => appearance,
    theme: () => appearance.theme,
    onAppearance(fn) {
      appearanceListeners.add(fn);
      return () => {
        appearanceListeners.delete(fn);
      };
    },
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
    confirm: (opts) => ws.ui.confirm(opts as ConfirmOptions),
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
    edit,
    onLeave,
    hostAtLeast: (major, minor) => versionAtLeast(ws.context.hostVersion, major, minor),
    spawnWorker: (url) => ws.spawnWorker(url),
    raw: ws,
  };
  return bridge;
}
