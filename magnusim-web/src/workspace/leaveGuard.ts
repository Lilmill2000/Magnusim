/**
 * Unsaved work in the open plugin workspace, and a question before any way out.
 *
 * The workspace's page says when it has unsaved work (nav.setDirty over the
 * bridge). While it does, every way out asks first with the app's own dialog:
 * Back, the page's own Back, browser Back/Forward and typed links (a hashchange
 * guard), Home and the folder chip, opening another project, and turning the
 * plugin off. Closing or reloading the tab gets the browser's own prompt.
 * On these questions Enter (and Escape) keep the work: Leave and Turn off take a click.
 *
 * The hashchange guard must be the first hashchange listener on window: in
 * Chromium, window listeners run in registration order even with capture, so
 * main.tsx installs it before anything else runs.
 */
import { cleanDirtyMessage } from './bridge';
import { parseWorkspaceHash, type WorkspaceRoute } from './route';

export type LeaveReason = 'back' | 'frame-back' | 'history' | 'project' | 'home' | 'plugin-off';

/** The open workspace, as the guard needs it. */
export interface GuardedWorkspace {
  route: WorkspaceRoute;
  pluginName(): string;
  studyTitle(): string;
  frame(): HTMLIFrameElement | null;
}

/**
 * An approved leave lets everything through until the workspace closes, or this
 * long at most. An approved turn-off holds until it ends (or is withdrawn).
 */
export const LEAVE_APPROVAL_MS = 10000;

/** The longest plugin or study name the question shows (as long as a study title may be). */
const NAME_MAX = 120;

type DirtyState = { dirty: boolean; message: string };

let installed = false;
let open: GuardedWorkspace | null = null;
// Ends when the open workspace closes: a question about it still on screen closes too.
let openEnds: AbortController | null = null;
let state: DirtyState = { dirty: false, message: '' };
// The user chose Leave (or Turn off): nothing asks again while this workspace is open.
let approved = false;
let approvalTimer: ReturnType<typeof setTimeout> | null = null;
// A leave question is on screen.
let asking = false;
let unloadArmed = false;
const subscribers = new Set<(s: DirtyState) => void>();

function sameRoute(a: WorkspaceRoute, b: WorkspaceRoute): boolean {
  return a.projectId === b.projectId && a.plugin === b.plugin && a.workspace === b.workspace && a.studyId === b.studyId;
}

function routeOf(url: string): WorkspaceRoute | null {
  try {
    return parseWorkspaceHash(new URL(url).hash);
  } catch {
    return null;
  }
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = '';
}

/** The beforeunload listener exists only while leaving would lose work (a clean page stays bfcache-friendly). */
function syncUnload(): void {
  const want = workspaceDirty();
  if (want === unloadArmed) return;
  unloadArmed = want;
  if (want) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}

function notify(): void {
  const s = { ...state };
  for (const fn of Array.from(subscribers)) {
    try {
      fn(s);
    } catch (err) {
      console.warn('[workspace] unsaved-work listener failed', err);
    }
  }
}

function clearApproval(): void {
  approved = false;
  if (approvalTimer) clearTimeout(approvalTimer);
  approvalTimer = null;
}

/** `timed`: the approval also ends after LEAVE_APPROVAL_MS if the workspace is somehow still open. */
function approve(timed: boolean): void {
  clearApproval();
  approved = true;
  if (timed) {
    approvalTimer = setTimeout(() => {
      approvalTimer = null;
      approved = false;
      syncUnload();
    }, LEAVE_APPROVAL_MS);
  }
  syncUnload();
}

function reset(): void {
  state = { dirty: false, message: '' };
  clearApproval();
  syncUnload();
  notify();
}

/**
 * Whether the host may give the keyboard to the workspace frame now: never away
 * from its own dialogs, Settings, the Queue or the workspace header, and never
 * while something else is full screen.
 */
export function frameMayTakeFocus(doc: Document, frame: HTMLIFrameElement | null, header: Element | null): boolean {
  if (!frame) return false;
  const shown = (el: Element | null): boolean => !!el && !el.closest('[hidden]');
  if (Array.from(doc.querySelectorAll('.cfd-modal, #setup-wizard')).some(shown)) return false;
  if (shown(doc.getElementById('job-queue-chip'))) return false;
  const active = doc.activeElement;
  if (header && active && header.contains(active)) return false;
  if (doc.fullscreenElement && doc.fullscreenElement !== frame) return false;
  return true;
}

function refocus(ws: GuardedWorkspace): void {
  const frame = ws.frame();
  if (!frame) return;
  const header = frame.closest('.ws-shell')?.querySelector('[data-workspace-header]') ?? null;
  if (frameMayTakeFocus(document, frame, header)) frame.focus({ preventScroll: true });
}

/**
 * A name from the plugin or its page (its manifest, a title it saved) as plain
 * text on one line, so it cannot reorder the question's own words; the
 * route's own when it cleans to nothing.
 */
function plainName(raw: string, fallback: string): string {
  const name = cleanDirtyMessage(raw) || cleanDirtyMessage(fallback);
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
}

/** safe: Yes discards the work, so Enter (like Escape) keeps it and Yes takes a click. */
type LeaveQuestion = { title: string; copy: string; yes: string; no: string; safe: true };

function leaveQuestion(reason: LeaveReason, ws: GuardedWorkspace): LeaveQuestion {
  const who = plainName(ws.pluginName(), ws.route.plugin);
  const msg = state.message;
  if (reason === 'plugin-off') {
    return {
      title: `Turn off ${who}?`,
      copy: `Its workspace is open with changes that are not saved${msg ? ` (${msg})` : ''}. Turning it off closes the workspace and discards them.`,
      yes: 'Turn off',
      no: 'Cancel',
      safe: true,
    };
  }
  const what = msg ? `${who}: ${msg}` : `${who} has changes to "${plainName(ws.studyTitle(), ws.route.studyId)}" that are not saved.`;
  return { title: 'Leave without saving?', copy: `${what} Leaving discards them.`, yes: 'Leave', no: 'Stay', safe: true };
}

async function ask(q: LeaveQuestion, signal?: AbortSignal): Promise<boolean> {
  try {
    const confirm = window.__CFD_CONFIRM__;
    if (confirm) return (await confirm({ ...q, signal })) === true;
    // Only when the app's own dialog is missing (the workbench did not load).
    return window.confirm(`${q.title}\n\n${q.copy}`);
  } catch (err) {
    console.warn('[workspace] leave question failed', err);
    return false;
  }
}

/** Browser Back/Forward or a typed link away from the dirty workspace: hold it and ask. */
function onHash(e: HashChangeEvent): void {
  const ws = open;
  if (!ws || !workspaceDirty()) return;
  const from = routeOf(e.oldURL);
  if (!from || !sameRoute(from, ws.route)) return;
  // The same workspace spelled another way (%2D for "-") is not a way out.
  const to = routeOf(e.newURL);
  if (to && sameRoute(to, ws.route)) return;
  // Nothing else hears of this change, and the address is the workspace's again.
  e.stopImmediatePropagation();
  history.pushState(history.state, '', e.oldURL);
  void confirmLeaveWorkspace('history').then((ok) => {
    // The entry the user was going to is under the restored one; the approval lets it through.
    if (ok) history.back();
  });
}

/** Install the hashchange guard (once). Call it before anything else adds a hashchange listener. */
export function installWorkspaceLeaveGuard(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('hashchange', onHash, { capture: true });
}

/**
 * The workspace now open (one at a time), clean. The returned function forgets
 * it, and closes a question about it that is still on screen.
 */
export function registerOpenWorkspace(ws: GuardedWorkspace): () => void {
  if (!installed) console.warn('[workspace] the leave guard is not installed: browser Back and links will not ask');
  openEnds?.abort();
  const ends = new AbortController();
  open = ws;
  openEnds = ends;
  reset();
  return () => {
    if (openEnds !== ends) return;
    open = null;
    openEnds = null;
    ends.abort();
    reset();
  };
}

/** The open workspace's page has unsaved work (or not). Only changes are acted on. */
export function setWorkspaceDirty(dirty: boolean, message?: string): void {
  if (!open) return;
  const next = { dirty: dirty === true, message: dirty === true ? cleanDirtyMessage(message) : '' };
  if (next.dirty === state.dirty && next.message === state.message) return;
  state = next;
  syncUnload();
  notify();
}

/** Leaving the open workspace now would lose work (and the user has not chosen to). */
export function workspaceDirty(): boolean {
  return !!open && state.dirty && !approved;
}

/** The user chose to leave the open workspace (or turn its plugin off): its page's own questions are not shown any more. */
export function leaveApproved(): boolean {
  return !!open && approved;
}

/** The approved leave did not happen (turning the plugin off failed): the open workspace's unsaved work is guarded again. */
export function withdrawLeaveApproval(): void {
  clearApproval();
  syncUnload();
}

export function openWorkspaceRoute(): WorkspaceRoute | null {
  return open ? open.route : null;
}

/** Hear every change of the open workspace's unsaved-work state. */
export function subscribeWorkspaceDirty(fn: (s: DirtyState) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Leave full screen when the workspace frame has it (before the app shows a dialog). */
export async function exitFrameFullscreen(): Promise<void> {
  const frame = open ? open.frame() : null;
  if (!frame || document.fullscreenElement !== frame) return;
  try {
    await document.exitFullscreen();
  } catch {
    /* already out */
  }
}

/**
 * May the user leave the open workspace? True at once when nothing would be
 * lost; otherwise the app asks. The question waits its turn behind another app
 * dialog (one at a time), and never gets lost in the moment between two of them.
 * False without a question when it must not ask (interactive: false) or a leave
 * question is already open, and false when the workspace closed while the
 * question was open (the question closes with it).
 */
export async function confirmLeaveWorkspace(reason: LeaveReason, opts: { interactive?: boolean } = {}): Promise<boolean> {
  if (!workspaceDirty()) return true;
  const ws = open as GuardedWorkspace;
  const ends = openEnds;
  if (opts.interactive === false || asking) return false;
  asking = true;
  let ok = false;
  try {
    await exitFrameFullscreen();
    ok = await ask(leaveQuestion(reason, ws), ends ? ends.signal : undefined);
  } finally {
    asking = false;
  }
  // Closed meanwhile: the user is elsewhere already, and there is nothing to approve.
  if (openEnds !== ends) return false;
  if (!ok) {
    refocus(ws);
    return false;
  }
  // A turn-off holds until it ends (PluginsStep withdraws it when the request fails):
  // the disable and the registry reload wait on the worker, maybe longer than LEAVE_APPROVAL_MS.
  approve(reason !== 'plugin-off');
  return true;
}

/** Go to `hash` if the user may leave the open workspace; false when they chose to stay. */
export async function leaveWorkspaceTo(hash: string, reason: LeaveReason): Promise<boolean> {
  if (!(await confirmLeaveWorkspace(reason))) return false;
  location.hash = hash;
  return true;
}
