/**
 * What Magnusim CAD's page has in place of the simulation workbench (src/workbench/runtime.js,
 * which it never loads): the hooks Home and the workspace overlay call on window.
 *
 * - The app's dialogs (src/workbench/dialogs.ts, the workbench's own).
 * - New Project: Home's dialog (#modal-new-project, filled by src/home's controller); Create
 *   makes the project, then the Part its "Start from" names, and opens it.
 * - Opening a project: the project page (ProjectPage.tsx) in place of the workbench, with the
 *   project in the store, so a Part's workspace opens over it.
 */
import { confirmAction, dialogBusy, promptName } from '../workbench/dialogs';
import { parseHomeRoute, prepareCreateModal, submitProjectModal } from '../home/controller';
import { loadStartActions, startStudy, type StartEntry } from '../workspace/startActions';
import { workspaceHash } from '../workspace/route';
import { useProjectStore } from '../store/project';

export interface CadProject {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  units?: string;
  folder?: string;
  [key: string]: unknown;
}

type W = Window & {
  __CFD_CONFIRM__?: typeof confirmAction;
  __CFD_PROMPT_NAME__?: typeof promptName;
  __CFD_DIALOG_BUSY__?: () => boolean;
  __CFD_OPEN_NEW_PROJECT_MODAL__?: (existing: CadProject | null, opts?: unknown) => void;
  __CFD_HYDRATE_PROJECT__?: (id: string, opts?: { show?: boolean }) => Promise<unknown>;
  __CFD_LEAVE_WORKBENCH__?: () => void;
  __CFD_PROJECT_READY__?: string;
  __CFD_W16__?: { project?: CadProject };
  __CFD_HOME__?: { open?: (id: string, opts?: { reloadIfNeeded?: boolean }) => Promise<unknown> };
};

const w = window as W;
const $ = (id: string) => document.getElementById(id);

/** The open project, for the project page (it re-renders on the event). */
export function openProjectNow(): CadProject | null {
  return w.__CFD_W16__?.project || null;
}

function setOpenProject(project: CadProject | null): void {
  w.__CFD_W16__ = { ...(w.__CFD_W16__ || {}), project: project || undefined };
  w.__CFD_PROJECT_READY__ = project ? project.id : undefined;
  window.dispatchEvent(new CustomEvent('cad:project', { detail: project }));
}

/** Read the project and make it the open one: what the workbench's hydrate is for Magnusim. */
export async function hydrateProject(id: string): Promise<CadProject | null> {
  const r = await fetch(`/api/project?${new URLSearchParams({ id })}`, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as { project?: CadProject; error?: string };
  if (!r.ok || !j.project) throw new Error(j.error || 'Could not open the project');
  const project = { ...j.project, id };
  useProjectStore.getState().setHydrate(id, { project });
  setOpenProject(project);
  return project;
}

function closeNewProjectModal(): void {
  const modal = $('modal-new-project');
  if (modal) modal.hidden = true;
}

function openNewProjectModal(existing: CadProject | null, opts?: unknown): void {
  const modal = $('modal-new-project');
  if (!modal) return;
  const edit = existing && existing.id ? existing : undefined;
  void prepareCreateModal(edit, opts).finally(() => {
    modal.hidden = false;
    const title = $('np-title') as HTMLInputElement | null;
    title?.focus();
    if (title && opts && (opts as { start?: unknown }).start) title.select();
  });
}

async function createProject(fields: Record<string, unknown>): Promise<string | null> {
  const r = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      title: fields.title,
      description: fields.description || '',
      category: fields.category || 'Other',
      units: fields.units || 'Metric',
      folder: fields.folder,
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !j.id) {
    await confirmAction({ title: 'Could not create the project', copy: j.error || `The app answered ${r.status}.`, yes: 'OK', notice: true });
    return null;
  }
  return j.id;
}

/** Create in New Project: the project, then its first Part when "Start from" names one. */
export async function createFromProjectModal(): Promise<void> {
  const got = (await submitProjectModal()) as { ok: boolean; mode?: string; fields?: Record<string, unknown>; start?: { plugin: string; kind: string } | null };
  if (!got || !got.ok) return;
  closeNewProjectModal();
  if (got.mode === 'edit' || !got.fields) return;
  const id = await createProject(got.fields);
  if (!id) return;
  let opened = '';
  let refused: { title: string; copy: string } | null = null;
  if (got.start) {
    const all = await loadStartActions().catch(() => [] as StartEntry[]);
    const entry =
      all.find((e) => e.plugin === got.start?.plugin && e.action.study_kind === got.start?.kind) ||
      ({ plugin: got.start.plugin, plugin_name: got.start.plugin, action: { study_kind: got.start.kind, kind_title: got.start.kind } } as StartEntry);
    await startStudy(entry, {
      projectId: id,
      titles: [],
      notice: (title, copy) => {
        refused = { title, copy };
        return Promise.resolve();
      },
      where: () => id,
      open: (workspace, studyId) => {
        opened = workspaceHash({ projectId: id, plugin: entry.plugin, workspace, studyId });
      },
      sync: () => undefined,
    });
  }
  if (opened) location.hash = opened;
  if (w.__CFD_HOME__?.open) await w.__CFD_HOME__.open(id, { reloadIfNeeded: false }).catch((e) => console.error('[CAD] open created', e));
  else location.hash = `#/p/${encodeURIComponent(id)}`;
  const shown = refused as { title: string; copy: string } | null;
  if (shown) await confirmAction({ title: shown.title, copy: shown.copy, yes: 'OK', notice: true });
}

/**
 * The page started on a project's address (a link, a reload, a Part's workspace): Home shows the
 * workbench's place and tells the server; the workbench read the project then, so this does.
 */
export function openHashProjectAtStart(): void {
  const route = parseHomeRoute() as { view: string; projectId?: string | null };
  if (route.view !== 'workbench' || !route.projectId || openProjectNow()?.id === route.projectId) return;
  void w.__CFD_HYDRATE_PROJECT__?.(route.projectId, { show: true });
}

let installed = false;

export function installCadShell(): void {
  if (installed) return;
  installed = true;
  w.__CFD_CONFIRM__ = (opts) => confirmAction(opts);
  w.__CFD_PROMPT_NAME__ = (opts) => promptName(opts);
  w.__CFD_DIALOG_BUSY__ = () => dialogBusy();
  w.__CFD_OPEN_NEW_PROJECT_MODAL__ = openNewProjectModal;
  w.__CFD_HYDRATE_PROJECT__ = (id) =>
    hydrateProject(id).catch(async (e) => {
      await confirmAction({ title: 'Could not open the project', copy: String(e instanceof Error ? e.message : e), yes: 'OK', notice: true });
      location.hash = '#/';
      return null;
    });
  w.__CFD_LEAVE_WORKBENCH__ = () => {
    useProjectStore.getState().resetScope();
    setOpenProject(null);
  };
  $('np-cancel')?.addEventListener('click', closeNewProjectModal);
  $('np-backdrop')?.addEventListener('click', closeNewProjectModal);
  document.addEventListener('keydown', (e) => {
    const modal = $('modal-new-project');
    if (e.key !== 'Escape' || !modal || modal.hidden) return;
    e.preventDefault();
    closeNewProjectModal();
  });
  // Disabled from the click until it is done, so a double click makes one project.
  $('np-create')?.addEventListener('click', () => {
    const btn = $('np-create') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    createFromProjectModal()
      .catch((e) => console.error('[CAD] create', e))
      .finally(() => {
        btn.disabled = false;
      });
  });
}
