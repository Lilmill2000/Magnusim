/**
 * Geometry actions (host API 1.7): "Edit in <workspace>" on a project geometry.
 *
 * A plugin's `[[geometry_actions]]` entry opens a study of its kind in its workspace to
 * edit a geometry. The tree's geometry nodes carry them (`edit_actions`, worker
 * `project.tree`), each with whether it is enabled and why not; the tree's right-click
 * menu, the viewport's right-click on the part and the Geometry panel show them.
 *
 * A click asks the server for the study (`POST /api/geometry-actions/open`: the study that
 * links the geometry, else the one that edits it, else a new one), then opens it at its
 * workspace's address. A viewport right-click also passes what was clicked (a face or a
 * body): the page gets it once, as `ws.context.launch`.
 */
import { workspaceHash } from './route';
import type { LaunchTarget } from '../plugin-sdk/workspace';

/** Where an action is offered. */
export type GeometryActionPlace = 'tree' | 'viewport' | 'panel';

/** One action as a geometry node carries it (`edit_actions`). */
export interface GeometryActionRow {
  plugin?: string;
  plugin_name?: string;
  study_kind?: string;
  label?: string;
  hint?: string;
  icon?: string;
  places?: string[];
  workspace?: string;
  workspace_title?: string;
  enabled?: boolean;
  reason?: string;
}

/** What a menu item or a button shows and opens. */
export interface GeometryActionEntry {
  plugin: string;
  pluginName: string;
  studyKind: string;
  label: string;
  hint: string;
  icon: string;
  workspace: string;
  workspaceTitle: string;
  enabled: boolean;
  /** Why it is disabled ('' when enabled), shown under the item. */
  reason: string;
}

/** A tree geometry node as far as the actions need it. */
export interface GeometryActionNode {
  id?: string;
  name?: string;
  edit_actions?: GeometryActionRow[] | null;
}

/** The actions a geometry node offers at a place (none while no plugin with one is on). */
export function actionsFor(node: GeometryActionNode | null | undefined, place: GeometryActionPlace): GeometryActionEntry[] {
  const rows = node && Array.isArray(node.edit_actions) ? node.edit_actions : [];
  const out: GeometryActionEntry[] = [];
  for (const a of rows) {
    if (!a || !a.plugin || !a.study_kind || !a.label) continue;
    const places = Array.isArray(a.places) ? a.places : ['tree', 'viewport', 'panel'];
    if (!places.includes(place)) continue;
    out.push({
      plugin: String(a.plugin),
      pluginName: String(a.plugin_name || a.plugin),
      studyKind: String(a.study_kind),
      label: String(a.label),
      hint: String(a.hint || ''),
      icon: String(a.icon || ''),
      workspace: String(a.workspace || ''),
      workspaceTitle: String(a.workspace_title || ''),
      enabled: a.enabled !== false && !a.reason,
      reason: a.enabled === false || a.reason ? String(a.reason || 'Not available now.') : '',
    });
  }
  return out;
}

// ---- the project's geometries, as the tree read them last ----------------------------------

interface RememberedNode extends GeometryActionNode {
  original?: { file_name?: string | null; format?: string | null; present?: boolean } | null;
}

let treeProject = '';
const treeNodes = new Map<string, RememberedNode>();
const treeListeners = new Set<() => void>();

/** Each tree read (LeftTree): the geometries' actions, for the panel and the viewport's menu. */
export function rememberTreeActions(projectId: string, geometries: unknown): void {
  treeProject = String(projectId || '');
  treeNodes.clear();
  for (const g of Array.isArray(geometries) ? (geometries as RememberedNode[]) : []) {
    if (g && g.id) treeNodes.set(String(g.id), g);
  }
  for (const fn of [...treeListeners]) {
    try {
      fn();
    } catch (e) {
      console.warn('[CFD] geometry actions listener', e);
    }
  }
}

/** The actions a geometry of the open project offers at a place, as the tree read them last. */
export function geometryActionsNow(projectId: string, geometryId: string, place: GeometryActionPlace): GeometryActionEntry[] {
  if (!projectId || projectId !== treeProject) return [];
  return actionsFor(treeNodes.get(String(geometryId)) || null, place);
}

/** What an adopted geometry was imported from (its original kept in the project), or null. */
export function geometryOriginalNow(projectId: string, geometryId: string): { fileName: string | null; present: boolean } | null {
  if (!projectId || projectId !== treeProject) return null;
  const o = treeNodes.get(String(geometryId))?.original;
  return o ? { fileName: o.file_name ? String(o.file_name) : null, present: !!o.present } : null;
}

/** Hear each tree read's actions. Returns the stop. */
export function subscribeGeometryActions(fn: () => void): () => void {
  treeListeners.add(fn);
  return () => {
    treeListeners.delete(fn);
  };
}

/**
 * "Add the original as a new geometry" (an adopted geometry, API 1.7): the file it was
 * imported from, imported again beside it. The app's import shows it as any import does.
 */
export async function importOriginal(projectId: string, geometryId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch('/api/geometry/original/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ project_id: projectId, geometry_id: geometryId }),
      cache: 'no-store',
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || j.ok === false) return { ok: false, message: String(j.error || `The app answered ${r.status}.`) };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- the one-shot launch target -----------------------------------------------------------

const launches = new Map<string, { launch: LaunchTarget; at: number }>();
/** How long a click waits for the app to pick or make the study. */
export const OPEN_TIMEOUT_MS = 15_000;

/** A launch not picked up by the page this long after the click is dropped. */
const LAUNCH_TTL_MS = 120_000;

function launchKey(projectId: string, plugin: string, studyId: string): string {
  return `${projectId}|${plugin}|${studyId}`;
}

/** A face or body label as the page may get it, or undefined. */
function cleanTarget(raw: unknown, re: RegExp): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s && s.length <= 64 && re.test(s) ? s : undefined;
}

/** What the page of that study gets as `ws.context.launch` (once), or null. */
export function launchFor(projectId: string, plugin: string, studyId: string): LaunchTarget | null {
  const key = launchKey(projectId, plugin, studyId);
  const hit = launches.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LAUNCH_TTL_MS) {
    launches.delete(key);
    return null;
  }
  return { ...hit.launch };
}

/** The page had it: the next page load of that study gets none. */
export function dropLaunch(projectId: string, plugin: string, studyId: string): void {
  launches.delete(launchKey(projectId, plugin, studyId));
}

// ---- the click --------------------------------------------------------------------------------

export interface OpenAnswer {
  ok: boolean;
  /** Why not, for the app's notice (empty when it opened). */
  title?: string;
  message?: string;
  studyId?: string;
  created?: boolean;
}

export interface OpenOptions {
  /** A face ("face 3@Body1") or a body ("Body1") the user right-clicked, for the page. */
  launch?: LaunchTarget | null;
  /** Opens the study (default: its workspace's address). */
  open?: (hash: string) => void;
  /** Reloads the tree when a study was made (default: cfd:tree-sync). */
  sync?: () => void;
}

/**
 * Open a geometry action: the server picks or makes the study, then its workspace opens.
 * Resolves once the route changed or the refusal is known (the caller shows it), so the
 * item or button that started it stays disabled until then.
 */
export async function openGeometryAction(
  projectId: string,
  geometryId: string,
  entry: Pick<GeometryActionEntry, 'plugin' | 'studyKind' | 'label' | 'workspaceTitle' | 'pluginName'>,
  opts: OpenOptions = {},
): Promise<OpenAnswer> {
  let status = 0;
  let body: { ok?: boolean; study_id?: string; workspace?: string; created?: boolean; error?: string; code?: string } = {};
  try {
    const r = await fetch('/api/geometry-actions/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ project_id: projectId, geometry_id: geometryId, plugin: entry.plugin, study_kind: entry.studyKind }),
      cache: 'no-store',
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
    status = r.status;
    body = (await r.json().catch(() => ({}))) as typeof body;
  } catch (e) {
    const late = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false,
      title: `Couldn't open ${entry.workspaceTitle || entry.pluginName}`,
      message: late ? `The app did not answer within ${OPEN_TIMEOUT_MS / 1000} seconds. Try again in a moment.` : e instanceof Error ? e.message : String(e),
    };
  }
  if (status !== 200 || !body.ok || !body.study_id || !body.workspace) {
    const what = entry.workspaceTitle || entry.pluginName || 'the workspace';
    const message =
      body.code === 'plugin_off'
        ? `${entry.pluginName || 'The plugin'} is off. Turn it on in Settings > Plugins.`
        : String(body.error || `The app answered ${status}.`);
    return { ok: false, title: body.code === 'not_editable' ? `Can't ${entry.label.charAt(0).toLowerCase()}${entry.label.slice(1)}` : `Couldn't open ${what}`, message };
  }
  const studyId = String(body.study_id);
  const launch = opts.launch || null;
  const face = launch ? cleanTarget(launch.face, /^face\s*\d+(@Body\d+)?$/i) : undefined;
  const bodyRef = launch ? cleanTarget(launch.body, /^Body\d+$/) : undefined;
  if (face || bodyRef) {
    launches.set(launchKey(projectId, entry.plugin, studyId), { launch: { ...(face ? { face } : {}), ...(bodyRef ? { body: bodyRef } : {}) }, at: Date.now() });
  }
  if (body.created) (opts.sync || (() => window.dispatchEvent(new CustomEvent('cfd:tree-sync'))))();
  const hash = workspaceHash({ projectId, plugin: entry.plugin, workspace: String(body.workspace), studyId });
  (opts.open || ((h: string) => (location.hash = h)))(hash);
  return { ok: true, studyId, created: !!body.created };
}

/** The app's notice dialog for a refused action (runtime.js), else an alert. */
export function geometryActionNotice(title: string, copy: string): Promise<unknown> {
  const confirm = (window as unknown as { __CFD_CONFIRM__?: (o: Record<string, unknown>) => Promise<unknown> }).__CFD_CONFIRM__;
  if (typeof confirm === 'function') return confirm({ title, copy, yes: 'OK', notice: true });
  window.alert(`${title}\n\n${copy}`);
  return Promise.resolve();
}

/** Tests: forget the launches and the tree. */
export function resetGeometryActionsForTests(): void {
  launches.clear();
  treeNodes.clear();
  treeListeners.clear();
  treeProject = '';
}
