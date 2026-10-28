/**
 * The app page's own tools for the Assistant (core host tools spec 5, C7): every app tab on this PC
 * offers them, with where it is, in the `core` slot of src/workspace/assistantTools.ts, and the
 * page relay (src/assistant/relay.ts) takes them to the server and runs their calls here.
 *
 * - core__show moves this window as the person's own clicks do: Home, a project (from a workspace
 *   of that project it is Back, which sends a CAD design to the simulation), a geometry, a study, a
 *   mesh, a run, a run's results, a setup panel, or a plugin study's workspace. Leave guards hold:
 *   unsaved work in a workspace asks the person (the call says it waits for them meanwhile), and a
 *   No answers `cancelled_by_person`. It answers where the window is now; the turn's tools change
 *   with the place from its next step (the server rebinds the turn, §9.4).
 * - core__view takes a picture of the viewer (picture), or moves the view: fit, normal_to a face,
 *   orbit about a face, hide and show faces or bodies, show_all, edges and the legend on or off.
 *   Every action but picture answers a small picture too, so the model sees what it did. Home has
 *   no viewer: its picture is a drawing of the window as laid out (domPicture.ts: the cards, their
 *   titles and previews, as the person sees them); the rest answer `not_ready`.
 * - The person first (§5.3): while they drag in the viewer (or did within 1.5 s), use the Filters
 *   panel, frame a capture, switch studies or answer an app dialog, every action but picture, and
 *   core__show, waits up to 10 s ("Waiting for you to finish with the view", waiting) and then
 *   answers `person_busy`: the camera never moves under their hand. A picture never moves it.
 * - core__keybinds and core__set_keybind are Settings → Keybinds' (keybindTools.ts): read any time;
 *   a change only when the person asked for it, and only on their Yes in the app's confirm.
 * - core__appearance and core__set_appearance are Settings → Appearance's (appearanceTool.ts): read
 *   any time; a change only when the person asked for it (shown at once, so no question).
 * - Where the tab is (place, project, study) is published again whenever the route, the project
 *   or the study changes; the same place again publishes nothing.
 */
import { openProject, parseHomeRoute, showHome } from '../home/controller';
import { useProjectStore } from '../store/project';
import { publishCoreTools, subscribeWorkspaceTools, withdrawCoreTools, workspaceToolsSnapshot, type CoreToolsScope, type PublishedTools } from '../workspace/assistantTools';
import type { AssistantCallOutcome, AssistantInvoke } from '../workspace/bridge';
import { confirmLeaveWorkspace, lastLeaveLinkJob, leaveNeedsWork, leaveWorkspaceTo } from '../workspace/leaveGuard';
import { workspaceHash } from '../workspace/route';
import { CORE_GUIDE, CORE_TOOLS, SHOW_TARGETS, VIEW_ACTIONS } from './coreToolDefs';
import { drawPagePicture } from './domPicture';
import { coreAppearance, coreSetAppearance, pageLookRuntime, type LookRuntime } from './appearanceTool';
import { coreKeybinds, coreSetKeybind, pageKeysRuntime, type KeysRuntime } from './keybindTools';

/** The workbench's own functions the core tools use (runtime.js window.__CFD_ASSISTANT_CORE__). */
export interface AssistantCoreApi {
  viewerPressed(): boolean;
  viewerInputAt(): number;
  /** Why the view is busy ('' when it isn't): a capture framing, a study switch, an app dialog. */
  viewBusy(): string;
  filtersInUse(): boolean;
  captureViewImage(o: { aspect: string; width: number; legend: boolean }): Promise<{ blob: Blob; width: number; height: number; type: string } | null>;
  saveAssistantPicture(pic: { blob: Blob; width: number; height: number; type: string }): Promise<{ id?: string; name?: string } | null>;
  shown(): { project_id: string; geometry_id: string; study_id: string; mesh_id: string; run_id: string; results: boolean; mesh_inspect: boolean };
  hasGeometry(id: string): boolean;
  hasStudy(id: string): boolean;
  hasMesh(id: string): boolean;
  /** Reads the study's runs again before it says no. */
  hasRun(id: string): boolean | Promise<boolean>;
  switchGeometry(id: string): Promise<unknown>;
  selectStudy(id: string): Promise<unknown>;
  showMesh(id: string): Promise<unknown>;
  showRun(id: string): Promise<unknown>;
  showResults(id: string): Promise<unknown>;
  openPanel(panel: string): boolean;
  fit(): void;
  normalTo(id: string): boolean;
  orbitAt(id: string): boolean;
  setHidden(ids: string[], hide: boolean): { faces: number; bodies: number; unknown: string[] };
  showAll(): void;
  edges(on: boolean): void;
  legend(on: boolean): void;
}

export { CORE_GUIDE, CORE_SHOW_SCHEMA, CORE_TOOLS, CORE_VIEW_SCHEMA } from './coreToolDefs';

/** The words of the wait while the person uses the view. */
export const VIEW_WAIT_LABEL = 'Waiting for you to finish with the view';
/** How long a tool waits for the person to finish with the view (§5.3). */
export const VIEW_WAIT_MS = 10_000;
/** A drag or wheel this recent still counts as the person using the view. */
export const VIEW_INPUT_MS = 1500;
/** How long core__show waits for a project to open, and for a workspace's tools. */
export const PROJECT_OPEN_MS = 60_000;
export const WORKSPACE_TOOLS_MS = 20_000;
/** A call that waits for the person tells the server it is alive this often. */
const ALIVE_MS = 15_000;

const PICTURE_WIDTH: Readonly<Record<string, number>> = Object.freeze({ small: 640, medium: 1024, large: 1600 });

/** A plugin study's row (GET /api/plugin-studies). */
interface PluginStudyRow {
  id: string;
  plugin: string;
  workspace: string;
  title?: string;
  available?: boolean;
}

/** What the core tools reach in the page: injected so the tests drive them without the app. */
export interface CoreRuntime {
  route(): { view: string; projectId: string | null; workspace: { projectId: string; plugin: string; workspace: string; studyId: string } | null };
  api(): AssistantCoreApi | null;
  /** The project the workbench finished opening (window.__CFD_PROJECT_READY__). */
  projectReady(): string | null;
  /** The study the workbench shows for `projectId` ('' when it shows none of it). */
  studyOf(projectId: string): string;
  openProject(id: string): Promise<{ ok?: boolean; stayed?: boolean; error?: string } | null | undefined>;
  /** Home, as the workbench's Home button goes (asks first when a workspace has unsaved work): false when the person stayed. */
  goHome(): Promise<boolean>;
  leaveWorkspaceTo(hash: string, reason: 'back'): Promise<boolean>;
  /** A leave's question will ask the person (unsaved work, an exit hook). */
  leaveAsks(): boolean;
  lastLeaveLinkJob(): string | null;
  setHash(hash: string): void;
  pluginStudies(projectId: string, signal: AbortSignal): Promise<PluginStudyRow[]>;
  workspaceTools(): PublishedTools | null;
  subscribeWorkspaceTools(fn: () => void): () => void;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A drawing of the window where it has no viewer (Home), as laid out (domPicture.ts). */
  pagePicture(o: { aspect: string; width: number }): Promise<{ blob: Blob; width: number; height: number; type: string } | null>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The real page: the Home controller, the leave guard, the workbench (runtime.js). */
export function pageRuntime(): CoreRuntime {
  return {
    route: () => parseHomeRoute() as ReturnType<CoreRuntime['route']>,
    api: () => window.__CFD_ASSISTANT_CORE__ ?? null,
    projectReady: () => window.__CFD_PROJECT_READY__ ?? null,
    studyOf: (projectId) => {
      const st = window.__CFD_STUDY_STATE__ as { id?: unknown; project_id?: unknown } | undefined;
      if (st && String(st.project_id || '') === projectId && st.id) return String(st.id);
      const store = useProjectStore.getState();
      return store.projectId === projectId ? (store.activeSimId ?? '') : '';
    },
    openProject: (id) => openProject(id),
    goHome: async () => {
      if (!(await confirmLeaveWorkspace('home'))) return false;
      showHome();
      return true;
    },
    leaveWorkspaceTo: (hash, reason) => leaveWorkspaceTo(hash, reason),
    leaveAsks: () => leaveNeedsWork(),
    lastLeaveLinkJob: () => lastLeaveLinkJob(),
    setHash: (hash) => {
      location.hash = hash;
    },
    pluginStudies: async (projectId, signal) => {
      const r = await fetch(`/api/plugin-studies?${new URLSearchParams({ project_id: projectId })}`, { cache: 'no-store', signal });
      const j = (await r.json().catch(() => ({}))) as { studies?: unknown };
      return Array.isArray(j.studies) ? (j.studies as PluginStudyRow[]) : [];
    },
    workspaceTools: () => workspaceToolsSnapshot().current,
    subscribeWorkspaceTools,
    now: () => Date.now(),
    sleep,
    pagePicture: (o) => drawPagePicture(document.body, o),
  };
}

// ---------------------------------------------------------------- where the tab is

/** Where this tab is now (the core registration's scope): Home, or a project's workbench or workspace. */
export function scopeNow(rt: CoreRuntime): CoreToolsScope {
  const r = rt.route();
  if (r.view !== 'workbench' || !r.projectId) return { project_id: '', study_id: '', place: 'home' };
  return { project_id: r.projectId, study_id: rt.studyOf(r.projectId), place: r.workspace ? 'workspace' : 'workbench' };
}

/**
 * Publishes the core tools and where this tab is, now and whenever the route, the project or the
 * study changes (AppShell starts it with the relay). Answers how to stop it (the tools withdrawn).
 */
export function startCoreTools(rt: CoreRuntime = pageRuntime()): () => void {
  const invoke = (req: AssistantInvoke) => runCoreTool(req, rt);
  let queued = false;
  let stopped = false;
  const publish = () => {
    if (stopped) return;
    publishCoreTools(scopeNow(rt), CORE_TOOLS, CORE_GUIDE, invoke);
  };
  // Coalesced: Home's own switch resets the store before it replaces the address.
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      publish();
    });
  };
  publish();
  window.addEventListener('hashchange', soon);
  window.addEventListener('popstate', soon);
  window.addEventListener('cfd:study', soon);
  const offStore = useProjectStore.subscribe(soon);
  return () => {
    stopped = true;
    window.removeEventListener('hashchange', soon);
    window.removeEventListener('popstate', soon);
    window.removeEventListener('cfd:study', soon);
    offStore();
    withdrawCoreTools();
  };
}

// ---------------------------------------------------------------- the calls

type Outcome = AssistantCallOutcome;

const fail = (code: string, message: string, hint?: string): Outcome => ({ ok: false, code, message, ...(hint ? { hint } : {}) });

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Runs one core tool call in this page (the relay's `invoke {…, slot:'core'}`). */
export async function runCoreTool(
  req: AssistantInvoke,
  rt: CoreRuntime = pageRuntime(),
  keys: KeysRuntime = pageKeysRuntime(),
  look: LookRuntime = pageLookRuntime(),
): Promise<Outcome> {
  const input = isRecord(req.input) ? req.input : {};
  try {
    if (req.tool === 'show') return await coreShow(input, req, rt);
    if (req.tool === 'view') return await coreView(input, req, rt);
    if (req.tool === 'keybinds') return await coreKeybinds(input, keys);
    if (req.tool === 'set_keybind') return await coreSetKeybind(input, req, keys);
    if (req.tool === 'appearance') return await coreAppearance(look);
    if (req.tool === 'set_appearance') return await coreSetAppearance(input, look);
    return fail('no_tool', `No core tool named ${req.tool.slice(0, 40)}.`);
  } catch (e) {
    if (req.signal.aborted) return fail('aborted', 'It was stopped.');
    return fail('failed', e instanceof Error ? e.message.slice(0, 300) : 'The tool failed.');
  }
}

/** Why the person is using the view now ('' when they are not): §5.3. */
export function viewInUse(rt: CoreRuntime): string {
  const api = rt.api();
  if (!api) return '';
  if (api.viewerPressed() || rt.now() - api.viewerInputAt() < VIEW_INPUT_MS) return 'drag';
  if (api.filtersInUse()) return 'filters';
  return api.viewBusy();
}

/** Waits (≤ 10 s, saying so, waiting for the person) until the person is done with the view; false when they still aren't. */
async function untilViewFree(req: AssistantInvoke, rt: CoreRuntime): Promise<boolean> {
  if (!viewInUse(rt)) return true;
  req.onProgress(null, VIEW_WAIT_LABEL, { waiting: true });
  const end = rt.now() + VIEW_WAIT_MS;
  while (rt.now() < end && !req.signal.aborted) {
    await rt.sleep(200, req.signal);
    if (!viewInUse(rt)) {
      // The call no longer waits for the person (the turn's minutes run again).
      req.onProgress(null, '');
      return true;
    }
  }
  return false;
}

const PERSON_BUSY: Outcome = fail(
  'person_busy',
  'The person is using the view (dragging it, working in the Filters panel, framing a capture or answering a dialog), so it was left as it is.',
  'Try again in a moment.',
);

/** While the person is asked (a leave guard's question), the call says it waits for them, and stays alive. */
function waitingForPerson(req: AssistantInvoke, label: string): () => void {
  req.onProgress(null, label, { waiting: true });
  const t = setInterval(() => req.onAlive?.(), ALIVE_MS);
  return () => {
    clearInterval(t);
    req.onProgress(null, '');
  };
}

/** Polls `check` until it answers (not null), the time runs out or the call stops. */
async function waitFor<T>(rt: CoreRuntime, req: AssistantInvoke, ms: number, check: () => T | null): Promise<T | null> {
  const end = rt.now() + ms;
  for (;;) {
    const v = check();
    if (v !== null) return v;
    if (req.signal.aborted || rt.now() >= end) return null;
    await rt.sleep(150, req.signal);
  }
}

/** Where the window is now, as core__show answers it. */
function shownNow(rt: CoreRuntime): { place: string; project_id: string; study_id: string; workspace: string } {
  const r = rt.route();
  const s = scopeNow(rt);
  const ws = r.workspace ? `${r.workspace.plugin}/${r.workspace.workspace}/${r.workspace.studyId}` : '';
  return { place: s.place, project_id: s.project_id, study_id: r.workspace ? r.workspace.studyId : s.study_id, workspace: ws };
}

function shownOutcome(rt: CoreRuntime, summary: string, extra: Record<string, unknown> = {}): Outcome {
  const shown = shownNow(rt);
  const place = shown.place === 'home' ? 'Home' : shown.place === 'workspace' ? 'workspace' : 'workbench';
  return { ok: true, result: { data: { shown, hint: `From your next step the tools are the ${place}'s.`, ...extra }, summary: summary.slice(0, 160) } };
}

const projectHash = (id: string) => `#/p/${encodeURIComponent(id)}`;

/** Leaves the open workspace for its project's workbench (Back); false when the person stayed. */
async function backToProject(req: AssistantInvoke, rt: CoreRuntime, projectId: string): Promise<boolean> {
  const stop = rt.leaveAsks() ? waitingForPerson(req, 'Leaving the workspace (it may ask you first)') : null;
  try {
    return await rt.leaveWorkspaceTo(projectHash(projectId), 'back');
  } finally {
    stop?.();
  }
}

async function coreShow(input: Record<string, unknown>, req: AssistantInvoke, rt: CoreRuntime): Promise<Outcome> {
  const target = str(input.target);
  const id = str(input.id).trim();
  const panel = str(input.panel);
  if (!(SHOW_TARGETS as readonly string[]).includes(target)) return fail('invalid_input', `target is one of ${SHOW_TARGETS.join(', ')}.`);
  if (!(await untilViewFree(req, rt))) return PERSON_BUSY;
  const route = rt.route();
  const here = route.view === 'workbench' ? route.projectId : null;

  if (target === 'home') {
    if (route.view === 'home') return shownOutcome(rt, 'Home was shown already');
    const stop = rt.leaveAsks() ? waitingForPerson(req, 'Going Home (it may ask you first)') : null;
    let went = false;
    try {
      went = await rt.goHome();
    } finally {
      stop?.();
    }
    if (!went) return fail('cancelled_by_person', 'The person chose to stay in the workspace.');
    return shownOutcome(rt, 'Showed Home');
  }

  if (target === 'project') {
    const want = str(input.project_id).trim() || here || '';
    if (!want) return fail('no_project', 'This window shows Home: name the project.', 'Pass project_id from projects.');
    let job: string | null = null;
    if (route.workspace && route.workspace.projectId === want) {
      // Back: for a workspace that links geometry this sends its design to the simulation.
      if (!(await backToProject(req, rt, want))) return fail('cancelled_by_person', 'The person chose to stay in the workspace.');
      job = rt.lastLeaveLinkJob();
    } else if (!(here === want && rt.projectReady() === want)) {
      req.onProgress(null, 'Opening the project');
      const stop = rt.leaveAsks() ? waitingForPerson(req, 'Opening the project (the workspace may ask you first)') : null;
      let out: Awaited<ReturnType<CoreRuntime['openProject']>>;
      try {
        out = await rt.openProject(want);
      } finally {
        stop?.();
      }
      if (out && out.stayed) return fail('cancelled_by_person', 'The person chose to stay in the workspace.');
      if (out && out.ok === false) return fail('failed', out.error || 'The project could not be opened.');
    }
    const ready = await waitFor(rt, req, PROJECT_OPEN_MS, () => (rt.projectReady() === want ? true : null));
    if (!ready) return fail(req.signal.aborted ? 'aborted' : 'failed', `The project did not finish opening within ${PROJECT_OPEN_MS / 1000} s.`);
    return shownOutcome(rt, job ? 'Back to the project; the design goes to the simulation' : 'Showed the project', job ? { job: `link.${job}` } : {});
  }

  if (!here) return fail('no_project', 'This window shows Home: open a project first.', "core__show {target:'project', project_id:'<id>'}, then call this again.");

  if (target === 'workspace') return showWorkspace(id, here, req, rt);

  // The rest is the workbench's: a workspace over it goes first (Back).
  if (route.workspace) {
    if (!(await backToProject(req, rt, here))) return fail('cancelled_by_person', 'The person chose to stay in the workspace.');
    await waitFor(rt, req, 5_000, () => (rt.route().workspace ? null : true));
  }
  const api = rt.api();
  if (!api || rt.projectReady() !== here) return fail('not_ready', 'The project is still opening.', 'Try again in a moment.');
  // A geometry or study of the project; a mesh or run of the study shown (another study's: that study first).
  const need = (what: string, ok: boolean, list: string): Outcome | null => {
    if (!id) return fail('invalid_input', `id names the ${what}.`);
    if (ok) return null;
    const ofStudy = what === 'mesh' || what === 'run';
    return fail(
      'not_found',
      `No ${what} with id "${id.slice(0, 120)}" in ${ofStudy ? 'the study shown' : 'this project'}.`,
      `read_setup {what:'${list}'} lists them.${ofStudy ? " Another study's: core__show {target:'study'} first." : ''}`,
    );
  };
  switch (target) {
    case 'geometry': {
      const bad = need('geometry', api.hasGeometry(id), 'geometry');
      if (bad) return bad;
      await api.switchGeometry(id);
      return shownOutcome(rt, 'Showed the geometry', { workbench: api.shown() });
    }
    case 'study': {
      const bad = need('study', api.hasStudy(id), 'study');
      if (bad) return bad;
      const out = (await api.selectStudy(id)) as { gone?: boolean } | null | undefined;
      if (out && out.gone) return fail('not_found', 'That study was deleted.', "read_setup {what:'study'} lists the studies.");
      return shownOutcome(rt, 'Showed the study', { workbench: api.shown() });
    }
    case 'mesh': {
      const bad = need('mesh', api.hasMesh(id), 'meshes');
      if (bad) return bad;
      await api.showMesh(id);
      return shownOutcome(rt, 'Showed the mesh', { workbench: api.shown() });
    }
    case 'run':
    case 'results': {
      const bad = need('run', await api.hasRun(id), 'runs');
      if (bad) return bad;
      if (target === 'run') await api.showRun(id);
      else {
        try {
          await api.showResults(id);
        } catch (e) {
          return fail('not_ready', `The run's results could not be shown: ${e instanceof Error ? e.message.slice(0, 200) : 'no results'}.`, "read_results {kind:'status'} says whether it has results.");
        }
      }
      return shownOutcome(rt, target === 'run' ? 'Showed the run' : "Showed the run's results", { workbench: api.shown() });
    }
    case 'panel': {
      if (!panel) return fail('invalid_input', 'panel names the panel to open.');
      if (!api.openPanel(panel)) return fail('not_ready', 'That panel is not there now.');
      return shownOutcome(rt, 'Opened the panel', { panel, workbench: api.shown() });
    }
    default:
      return fail('invalid_input', `target is one of ${SHOW_TARGETS.join(', ')}.`);
  }
}

/** Opens a plugin study's workspace and waits for its tools (or that it offers none). */
async function showWorkspace(id: string, projectId: string, req: AssistantInvoke, rt: CoreRuntime): Promise<Outcome> {
  if (!id) return fail('invalid_input', 'id names the plugin study.');
  const rows = await rt.pluginStudies(projectId, req.signal);
  const row = rows.find((s) => s && s.id === id);
  if (!row) return fail('not_found', `No plugin study with id "${id.slice(0, 120)}" in this project.`, "project_summary lists the plugin studies.");
  if (row.available === false || !row.workspace) return fail('not_ready', 'Its plugin is off, or it opens in no workspace.');
  const route = rt.route();
  const open = route.workspace;
  if (!(open && open.studyId === id && open.plugin === row.plugin)) {
    const hash = workspaceHash({ projectId, plugin: row.plugin, workspace: row.workspace, studyId: id });
    if (open) {
      const stop = rt.leaveAsks() ? waitingForPerson(req, 'Leaving the workspace (it may ask you first)') : null;
      let went = false;
      try {
        went = await rt.leaveWorkspaceTo(hash, 'back');
      } finally {
        stop?.();
      }
      if (!went) return fail('cancelled_by_person', 'The person chose to stay in the workspace.');
    } else rt.setHash(hash);
  }
  req.onProgress(null, 'Opening the workspace');
  const tools = await waitFor(rt, req, WORKSPACE_TOOLS_MS, () => {
    const cur = rt.workspaceTools();
    return cur && cur.scope.study_id === id && cur.scope.plugin === row.plugin && cur.settled ? cur : null;
  });
  const offered = !!tools && tools.taken && !tools.dead && tools.tools.length > 0;
  return shownOutcome(rt, `Opened "${(row.title || id).slice(0, 80)}"`, {
    workspace_tools: offered ? 'offered' : 'none',
    ...(offered ? {} : { note: 'This workspace offers no tools to the Assistant (yet).' }),
  });
}

/** A Blob as base64 (the relay's image results). */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function picture(api: AssistantCoreApi, o: { aspect: string; size: string; legend: boolean }): Promise<{ blob: Blob; width: number; height: number; type: string } | null> {
  // A frame for what the last action drew.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return api.captureViewImage({ aspect: o.aspect || 'view', width: PICTURE_WIDTH[o.size] ?? PICTURE_WIDTH.small, legend: o.legend });
}

/** What a Home picture says it is: the model should not read it as a screenshot. */
export const HOME_PICTURE_NOTE = 'A drawing of the Home window as laid out (its boxes, text and project previews), not a screenshot.';

/** Home has no viewer: its picture is a drawing of the window, as the person sees it. */
async function homePicture(rt: CoreRuntime, o: { aspect: string; size: string; save: boolean }): Promise<Outcome> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const pic = await rt.pagePicture({ aspect: o.aspect, width: PICTURE_WIDTH[o.size] ?? PICTURE_WIDTH.small }).catch(() => null);
  if (!pic) return fail('failed', 'Home could not be drawn.');
  const images = [{ mediaType: pic.type, data: await base64Of(pic.blob) }];
  return {
    ok: true,
    result: {
      data: {
        picture: { width: pic.width, height: pic.height, aspect: o.aspect },
        shown: { place: 'home' },
        drawn: HOME_PICTURE_NOTE,
        ...(o.save ? { saved: false, note: "Home keeps no screenshots: open a project and show a run's results or a mesh, then save." } : {}),
      },
      images,
      summary: `Picture of Home ${pic.width}×${pic.height}`,
    },
  };
}

async function coreView(input: Record<string, unknown>, req: AssistantInvoke, rt: CoreRuntime): Promise<Outcome> {
  const action = str(input.action);
  if (!(VIEW_ACTIONS as readonly string[]).includes(action)) return fail('invalid_input', `action is one of ${VIEW_ACTIONS.join(', ')}.`);
  const ids = Array.isArray(input.target_ids) ? input.target_ids.filter((x): x is string => typeof x === 'string' && !!x) : [];
  const aspect = str(input.aspect) || 'view';
  const size = str(input.size) || 'small';
  const legend = input.with_legend !== false;
  const route = rt.route();
  const api = rt.api();
  if (route.view !== 'workbench' || !route.projectId) {
    if (action === 'picture') return homePicture(rt, { aspect, size, save: input.save === true });
    return fail('not_ready', 'Home has no 3D view.', "Open a project first: core__show {target:'project', project_id:'<id>'}.");
  }
  if (route.workspace) return fail('not_ready', "A workspace covers the viewer; use the workspace's own view tool.");
  if (!api) return fail('not_ready', 'The viewer is not ready yet.', 'Try again in a moment.');

  let done = '';
  let extra: Record<string, unknown> = {};
  if (action !== 'picture') {
    if (!(await untilViewFree(req, rt))) return PERSON_BUSY;
    switch (action) {
      case 'fit':
        api.fit();
        done = 'Fitted the view';
        break;
      case 'normal_to':
      case 'orbit': {
        const face = ids[0];
        if (!face) return fail('invalid_input', 'target_ids names the face (e.g. "face 3@Body1").');
        const ok = action === 'normal_to' ? api.normalTo(face) : api.orbitAt(face);
        if (!ok) return fail('not_found', action === 'normal_to' ? `"${face.slice(0, 40)}" is not a flat face of the shown geometry.` : `No face "${face.slice(0, 40)}" in the shown geometry.`, "read_setup {what:'faces'} lists them.");
        done = action === 'normal_to' ? `Looked normal to ${face}` : `Orbits about ${face}`;
        break;
      }
      case 'hide':
      case 'show': {
        if (!ids.length) return fail('invalid_input', 'target_ids names the faces or bodies.');
        const r = api.setHidden(ids, action === 'hide');
        if (!r.faces && !r.bodies) return fail('not_found', `None of these is a face or body of the shown geometry: ${r.unknown.slice(0, 8).join(', ')}.`, "read_setup {what:'faces'} and {what:'bodies'} list them.");
        done = `${action === 'hide' ? 'Hid' : 'Showed'} ${r.faces} face${r.faces === 1 ? '' : 's'} and ${r.bodies} bod${r.bodies === 1 ? 'y' : 'ies'}`;
        if (r.unknown.length) extra = { unknown: r.unknown };
        break;
      }
      case 'show_all':
        api.showAll();
        done = 'Showed every face and body';
        break;
      case 'edges':
        api.edges(input.on === true);
        done = input.on === true ? 'Edges shown' : 'Edges hidden';
        break;
      case 'legend':
        api.legend(input.on === true);
        done = input.on === true ? 'Legend shown' : 'Legend hidden';
        break;
      default:
        break;
    }
  }
  // Every action answers a picture: what was asked for, or a small one of what it did.
  const pic = await picture(api, action === 'picture' ? { aspect, size, legend } : { aspect: 'view', size: 'small', legend: true });
  if (!pic) {
    if (action === 'picture') return fail('failed', 'The view could not be drawn.');
    return { ok: true, result: { data: { done, ...extra }, summary: done } };
  }
  const images = [{ mediaType: pic.type, data: await base64Of(pic.blob) }];
  if (action !== 'picture') return { ok: true, result: { data: { done, picture: { width: pic.width, height: pic.height }, ...extra }, images, summary: done } };
  let saved: Record<string, unknown> = {};
  if (input.save === true) {
    const item = await api.saveAssistantPicture(pic).catch(() => null);
    saved = item
      ? { saved: true, gallery_item: item.id ?? item.name ?? '' }
      : { saved: false, note: "Nothing on screen keeps screenshots: show a run's results or a mesh, then save." };
  }
  return { ok: true, result: { data: { picture: { width: pic.width, height: pic.height, aspect }, shown: api.shown(), ...saved }, images, summary: `Picture ${pic.width}×${pic.height}` } };
}
