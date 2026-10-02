import { useEffect, useState } from 'react';
import type { PluginStudyKind } from '../chrome/treeModel';
import { newPluginStudy, type CreateAnswer } from '../chrome/studyName';
import { workspaceHash } from './route';

/**
 * Start actions (manifest `[[start_actions]]`, API 1.4): buttons a plugin declares that
 * create a study of one of its kinds and open it in its workspace. The host draws them
 * in four places; every plugin gets the same caps, order and overflow rules.
 *
 * Inside a project the header, the empty project, the Workspaces menu and STUDIES read
 * the tree's kind rows (`plugin_study_kinds[].start_action`), so they never disagree.
 * Home and the New Project dialog have no project: they read the store below
 * (`/api/plugins`, `start_actions` of each plugin that is on).
 */

export type StartPlace = 'empty_project' | 'header' | 'new_project' | 'home';

export const START_PLACES: readonly StartPlace[] = ['empty_project', 'header', 'new_project', 'home'];

/** At most this many actions are drawn in a place; the New Project dialog lists them all. */
export const START_CAPS: Readonly<Record<StartPlace, number>> = {
  empty_project: 3,
  header: 3,
  new_project: Infinity,
  home: 3,
};

/** One start action as the catalog row and the tree's kind row publish it. */
export interface StartAction {
  study_kind: string;
  kind_title: string;
  workspace: string;
  workspace_title: string;
  label: string;
  /** Home's text ("" means `label`). */
  home_label: string;
  /** The header button's text ("" means the workspace title). */
  header_label: string;
  hint: string;
  icon: string;
  places: string[];
}

/** A start action and the plugin that declares it. */
export interface StartEntry {
  plugin: string;
  plugin_name: string;
  action: StartAction;
}

/** `<plugin>:<kind>`: one start action (a kind has at most one). */
export function startKey(entry: { plugin: string; action: { study_kind: string } }): string {
  return `${entry.plugin}:${entry.action.study_kind}`;
}

export function kindKey(kind: { plugin: string; key: string }): string {
  return `${kind.plugin}:${kind.key}`;
}

/** The header button's text: its `header_label`, else the workspace title. */
export function headerLabel(entry: StartEntry): string {
  return entry.action.header_label || entry.action.workspace_title || entry.action.kind_title;
}

/** Home's text: its `home_label`, else its `label`. */
export function homeLabel(entry: StartEntry): string {
  return entry.action.home_label || entry.action.label;
}

/** The tree's kind rows (plugin load order, then manifest order) as start entries. */
export function entriesFromKinds(kinds: readonly PluginStudyKind[] | null | undefined): StartEntry[] {
  return (kinds || [])
    .filter((k) => !!k.start_action && !!k.workspace)
    .map((k) => ({ plugin: k.plugin, plugin_name: k.plugin_name, action: k.start_action as StartAction }));
}

/** A row of `/api/plugins`, as far as start actions go. */
export interface CatalogStartRow {
  key: string;
  name?: string;
  status?: string;
  start_actions?: StartAction[];
}

/** The catalog's rows (plugin load order) as start entries: only plugins that are on. */
export function entriesFromCatalog(rows: readonly CatalogStartRow[] | null | undefined): StartEntry[] {
  const out: StartEntry[] = [];
  for (const row of rows || []) {
    if (row.status !== 'enabled') continue;
    for (const action of row.start_actions || []) {
      if (action && action.workspace) out.push({ plugin: row.key, plugin_name: String(row.name || row.key), action });
    }
  }
  return out;
}

/**
 * The actions each place shows: the entries in the order given (plugin load order, then
 * manifest order), each place cut at its cap. "Has a header action" always means "is in
 * `header` here", so a kind whose header action was cut stays in the Workspaces menu.
 */
export function shownStartActions(entries: readonly StartEntry[]): Record<StartPlace, StartEntry[]> {
  const out: Record<StartPlace, StartEntry[]> = { empty_project: [], header: [], new_project: [], home: [] };
  for (const entry of entries) {
    for (const place of START_PLACES) {
      if (entry.action.places.includes(place) && out[place].length < START_CAPS[place]) out[place].push(entry);
    }
  }
  return out;
}

/** The kinds shown as header buttons (`<plugin>:<kind>`), from the tree's kind rows. */
export function headerKinds(kinds: readonly PluginStudyKind[] | null | undefined): Set<string> {
  return new Set(shownStartActions(entriesFromKinds(kinds)).header.map(startKey));
}

// ---------------------------------------------------------------------------
// The store for Home and the New Project dialog (no project open).
// ---------------------------------------------------------------------------

let entries: StartEntry[] | null = null;
let inflight: Promise<StartEntry[]> | null = null;
let readSerial = 0;
const listeners = new Set<(list: StartEntry[]) => void>();
let listening = false;
// A read that failed is tried again while something shows the store (Home is always
// mounted): after 1 s, then twice as long each time, at most 30 s apart.
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;

function scheduleRetry(): void {
  if (retryTimer || !listeners.size) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void loadStartActions({ force: true }).catch(() => undefined);
  }, retryDelay);
}

function publish(list: StartEntry[]): void {
  entries = list;
  for (const fn of [...listeners]) fn(list);
}

async function readCatalog(): Promise<StartEntry[]> {
  const r = await fetch('/api/plugins', { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as { plugins?: CatalogStartRow[] };
  if (!r.ok) throw new Error('plugins.list failed');
  return entriesFromCatalog(j.plugins);
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // A plugin turned on or off in Settings: read again (its buttons come and go at once).
  window.addEventListener('cfd:tree-sync', (e) => {
    const detail = (e as CustomEvent<{ plugins?: boolean } | null>).detail;
    if (detail && detail.plugins) void loadStartActions({ force: true }).catch(() => undefined);
  });
}

/**
 * Every start action of the plugins that are on, from `/api/plugins` (read once; reads
 * asked for while one is out share it). `force` reads again. A failed read is tried
 * again on its own while the store is shown (scheduleRetry).
 */
export function loadStartActions({ force = false }: { force?: boolean } = {}): Promise<StartEntry[]> {
  listen();
  if (entries && !force && !inflight) return Promise.resolve(entries);
  if (inflight && !force) return inflight;
  const serial = ++readSerial;
  const p = readCatalog().then(
    (list) => {
      // A later read (a plugin turned on meanwhile) wins over an earlier one.
      if (serial === readSerial) {
        retryDelay = 0;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        publish(list);
      }
      return entries || list;
    },
    (err: unknown) => {
      if (serial === readSerial) {
        inflight = null;
        scheduleRetry();
      }
      throw err;
    },
  );
  inflight = p;
  void p.finally(() => {
    if (inflight === p) inflight = null;
  }).catch(() => undefined);
  return p;
}

/** The store's last answer (null before the first read). */
export function startActionsNow(): StartEntry[] | null {
  return entries;
}

export function subscribeStartActions(fn: (list: StartEntry[]) => void): () => void {
  listen();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React: the store's entries, read on first use and after every plugin change. */
export function useStartActions(): StartEntry[] {
  const [list, setList] = useState<StartEntry[]>(() => entries || []);
  useEffect(() => {
    const stop = subscribeStartActions(setList);
    void loadStartActions()
      .then(setList)
      .catch(() => undefined);
    return stop;
  }, []);
  return list;
}

/** Tests only: forget the store. */
export function resetStartActionsForTests(): void {
  entries = null;
  inflight = null;
  readSerial = 0;
  listeners.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 0;
}

// ---------------------------------------------------------------------------
// Making the study.
// ---------------------------------------------------------------------------

export interface StartStudyOptions {
  projectId: string;
  /** Titles the new study may not take (takenStudyTitles of the project's tree). */
  titles: readonly unknown[];
  /** The app's notice; resolves when the user closed it. */
  notice: (title: string, copy: string) => Promise<unknown>;
  /** Where the user is now; the study opens only if this has not changed (default: project + hash). */
  where?: () => string;
  /** Opens the study (default: its workspace's address). */
  open?: (workspace: string, studyId: string) => void;
  /** Reloads the tree (default: cfd:tree-sync). */
  sync?: () => void;
}

/**
 * A start action's click: a study named with the first free "<Kind> N" (no prompt), made
 * and opened in its workspace. Resolves when the route opened or the notice was closed,
 * so the button that started it stays disabled until then (one click, one result).
 */
export async function startStudy(entry: StartEntry, opts: StartStudyOptions): Promise<void> {
  const projectId = opts.projectId;
  const plugin = entry.plugin;
  await newPluginStudy(
    { kind: entry.action.study_kind, title: entry.action.kind_title, titles: [...opts.titles], open: true },
    {
      shownTitles: () => [],
      create: async (body: { kind: string; title: string }): Promise<CreateAnswer> => {
        try {
          const r = await fetch('/api/plugin-studies/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ project_id: projectId, plugin, ...body }),
          });
          return { json: (await r.json().catch(() => ({}))) as CreateAnswer['json'] };
        } catch (e) {
          return { json: { ok: false, error: e instanceof Error ? e.message : String(e) } };
        }
      },
      notice: opts.notice,
      sync: opts.sync || (() => window.dispatchEvent(new CustomEvent('cfd:tree-sync'))),
      where: opts.where || (() => `${projectId} ${location.hash}`),
      open:
        opts.open ||
        ((workspace, studyId) => {
          location.hash = workspaceHash({ projectId, plugin, workspace, studyId });
        }),
    },
    { ask: false },
  );
}

/** The app's notice dialog (runtime.js), for a refused create. */
export function appNotice(title: string, copy: string): Promise<unknown> {
  const confirm = window.__CFD_CONFIRM__;
  if (typeof confirm === 'function') return confirm({ title, copy, yes: 'OK', notice: true });
  window.alert(`${title}\n\n${copy}`);
  return Promise.resolve();
}
