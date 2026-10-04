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
 *
 * Exit sync (host API 1.6, LINK proposal 6.3 and 6.4): a page with an exit hook
 * (nav.onLeave) has it run on every way out the host owns but turning the plugin off,
 * through this one gate, in order: leave full screen, probe the page, run the hook (the
 * host's link question shows inside it), ask about unsaved work only if the page is still
 * dirty, approve (the 10 s window starts here), go. After 400 ms the workspace header
 * shows what the hook does, with Cancel, and "Continue in background" once the link's
 * job exists; a hook that stalls (30 s with no progress and no call in flight, the timer
 * paused while an app dialog is open), throws, fails, has its link refused or loses its
 * page ends in one safe question. One leave at a time.
 */
import { cleanDirtyMessage, type LeaveActivity, type LeaveHookOutcome } from './bridge';
import { parseWorkspaceHash, type WorkspaceRoute } from './route';

/** Why the user leaves; 'results' (the page opens a case's results in 3D) asks the 'back' question. */
export type LeaveReason = 'back' | 'frame-back' | 'history' | 'project' | 'home' | 'plugin-off' | 'results';

/** The page's exit hook (API 1.6), as the overlay gives it to the guard (through its bridge). */
export interface LeaveHook {
  /** The page registered a hook and is connected. */
  on(): boolean;
  /** The page still answers (a crashed or hung page runs no hook). */
  probe(): Promise<boolean>;
  /** Run it for this leave; what happens meanwhile goes to `activity`. */
  run(reason: LeaveReason, o: { signal: AbortSignal; interactive: boolean; activity: (a: LeaveActivity) => void }): Promise<LeaveHookOutcome>;
  /** The name of the geometry the study links ('' before the first link). */
  geometryName(): Promise<string>;
  /** That name as last known here, at once (when the app is too slow to say). */
  lastGeometryName?(): string;
  /**
   * What a stalled hook was waiting for: whether the page still answers, and whether a save
   * of the page's through the app (a file commit, a data write) is still on its way.
   */
  stallCause?(): Promise<{ answers: boolean; saving: boolean }>;
}

/** The open workspace, as the guard needs it. */
export interface GuardedWorkspace {
  route: WorkspaceRoute;
  pluginName(): string;
  studyTitle(): string;
  frame(): HTMLIFrameElement | null;
  /** Its page's exit hook, when the page can have one (API 1.6). */
  hook?: LeaveHook;
  /** A leave that ran the hook ended and the workspace stays (Stay, Cancel, Keep editing). */
  stayed?(): void;
}

/** What the workspace header shows while a leave runs the page's hook. */
export interface LeaveProgress {
  /** A leave is running the hook. */
  running: boolean;
  /** Drawn: the hook has run longer than LEAVE_PROGRESS_MS. */
  shown: boolean;
  /** The status line. */
  label: string;
  /** The host's question is open: the header's Cancel is hidden (its "Keep editing" is the way out). */
  choosing: boolean;
  /** "Continue in background" is offered. */
  background: boolean;
  /**
   * The link's job exists: it goes on whatever the user does, so the header's Cancel reads
   * "Stay here" (the workspace stays; the update is not stopped).
   */
  started: boolean;
}

/** Nothing is drawn for a hook quicker than this. */
export const LEAVE_PROGRESS_MS = 400;
/** A hook with no progress and no call in flight this long has stalled. */
export const LEAVE_STALL_MS = 30000;
/** "Continue in background" waits this long after the link's job exists (at once when it is queued). */
export const LEAVE_BACKGROUND_MS = 5000;
/** How often the running leave looks at its clocks. */
const LEAVE_TICK_MS = 250;
/** How long a failed leave's question waits for the geometry's name before it uses the last one known. */
export const LEAVE_NAME_MS = 1500;

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
// A leave is running the page's hook (one at a time).
let leaving = false;
// The way out the user last chose and the guard let through, for the overlay's landing;
// `background`: the leave went on while the link's job ran on ("Continue in background").
let lastReason: { ws: GuardedWorkspace; reason: LeaveReason; background: boolean } | null = null;
const IDLE: LeaveProgress = { running: false, shown: false, label: '', choosing: false, background: false, started: false };
let progress: LeaveProgress = IDLE;
const progressSubscribers = new Set<(p: LeaveProgress) => void>();
// The header's Cancel and "Continue in background" for the running leave.
let leaveControls: { cancel: () => void; background: () => void } | null = null;
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

/**
 * The page's message inside the "Turn off" question's parentheses: without its own
 * last ".", "!" or "?". A run of them ("...", "?!") stays as typed.
 */
function inParentheses(msg: string): string {
  return msg.replace(/\s*(?<![.!?])[.!?]$/, '');
}

/**
 * The page's message as a sentence of the "Leave" question: it ends with ".", "!",
 * "?" or an ellipsis, maybe followed by closing quotes or brackets.
 */
function asSentence(msg: string): string {
  return /[.!?\u{2026}]["'\u{201D}\u{2019})\]]*$/u.test(msg) ? msg : `${msg}.`;
}

function leaveQuestion(reason: LeaveReason, ws: GuardedWorkspace): LeaveQuestion {
  const who = plainName(ws.pluginName(), ws.route.plugin);
  const msg = state.message;
  if (reason === 'plugin-off') {
    const note = inParentheses(msg);
    return {
      title: `Turn off ${who}?`,
      copy: `Its workspace is open with changes that are not saved${note ? ` (${note})` : ''}. Turning it off closes the workspace and discards them.`,
      yes: 'Turn off',
      no: 'Cancel',
      safe: true,
    };
  }
  const what = msg ? `${who}: ${asSentence(msg)}` : `${who} has changes to "${plainName(ws.studyTitle(), ws.route.studyId)}" that are not saved.`;
  return { title: 'Leave without saving?', copy: `${what} Leaving discards them.`, yes: 'Leave', no: 'Stay', safe: true };
}

/**
 * What became of the hook's link in this leave: nothing reached the server ('none'), the
 * server took it and its job goes on ('running'), or it went through ('done').
 */
type LeaveUpdate = 'none' | 'running' | 'done';

/**
 * The one question after a hook that did not finish (a stall, a throw, ok:false, a refused
 * link, its page gone): Stay has the focus, "Leave anyway" takes a click. When the page is
 * still dirty it says so too (one question, not two). It says what became of the link: a
 * job the server took goes on whatever the page does, and one that went through updated
 * the geometry.
 */
function hookFailedQuestion(ws: GuardedWorkspace, message: string, geometry: string, update: LeaveUpdate, own = false): LeaveQuestion {
  const who = plainName(ws.pluginName(), ws.route.plugin);
  const msg = cleanDirtyMessage(message) || 'it could not update the project';
  const name = geometry ? plainName(geometry, geometry) : '';
  const kept =
    update === 'done'
      ? `${name || 'The project'} was updated.`
      : update === 'running'
        ? `The update of ${name || 'the project'} goes on.`
        : name
          ? `${name} keeps its last update.`
          : 'The project is unchanged.';
  const lost = state.dirty ? ' Its changes are not saved. Leaving discards them.' : '';
  // `own`: the message says what waited itself (the app's save), not the plugin.
  const what = own ? asSentence(msg) : `${who}: ${asSentence(msg)}`;
  return { title: "Couldn't update the project", copy: `${what} ${kept}${lost}`, yes: 'Leave anyway', no: 'Stay', safe: true };
}

/**
 * What a stall's question says waited (LINK 6.4): the page's save through the app when one
 * is still on its way ("The save of <Study> did not finish in 30 seconds", the app's file
 * commit, not the plugin); a page that no longer answers; else the plugin's hook.
 */
function stallMessage(ws: GuardedWorkspace, cause: { answers: boolean; saving: boolean } | null): { message: string; own: boolean } {
  const secs = Math.round(LEAVE_STALL_MS / 1000);
  if (cause && cause.saving) return { message: `The save of ${plainName(ws.studyTitle(), ws.route.studyId)} did not finish in ${secs} seconds`, own: true };
  if (cause && !cause.answers) return { message: `its page did not answer for ${secs} seconds`, own: false };
  return { message: `it did not answer for ${secs} seconds`, own: false };
}

/** The status line's words for a link stage (LINK 6.4). */
function stageText(stage: string, ahead: number | null, label: string, create: boolean, study: string): string {
  if (stage === 'queued') {
    if (create) return `Waiting for the last update of ${study} to finish`;
    const n = ahead ?? 0;
    // Nothing waits before it: the job that runs now holds the slot.
    return n > 0 ? `Queued behind ${n} job${n === 1 ? '' : 's'} (see Queue)` : 'Queued (see Queue)';
  }
  if (stage === 'waiting' && label) return label;
  // What the finishing work still waits for, as the server says (LINK 6.4's honest progress).
  if (stage === 'finishing' && label) return label;
  const words: Record<string, string> = {
    reading: 'Reading the design',
    meshing: 'Building the part',
    naming: 'Naming the faces',
    matching: 'Matching faces',
    saving: 'Saving the project',
    finishing: 'Finishing',
  };
  return words[stage] || label || '';
}

function publishProgress(next: LeaveProgress): void {
  progress = next;
  for (const fn of Array.from(progressSubscribers)) {
    try {
      fn({ ...next });
    } catch (err) {
      console.warn('[workspace] leave progress listener failed', err);
    }
  }
}

/** How the hook's run ended for the guard. */
type HookEnd =
  | { kind: 'done' }
  /** `stall`: nothing happened for LEAVE_STALL_MS (the question says what waited). */
  | { kind: 'failed'; message: string; update: LeaveUpdate; stall?: boolean }
  /** "Keep editing" in the host's question, or the header's Cancel: stay, no question. */
  | { kind: 'stay' }
  /** "Continue in background", or a caller that cannot ask once the server took the link. */
  | { kind: 'go' };

/**
 * Run the page's hook (LINK 6.4 step 3): the progress the header shows, the stall timer,
 * Cancel and "Continue in background". `interactive: false` goes on once the server has
 * taken the link (the job then runs on), and never asks.
 */
function runHook(ws: GuardedWorkspace, hook: LeaveHook, reason: LeaveReason, interactive: boolean): Promise<HookEnd> {
  const study = plainName(ws.studyTitle(), ws.route.studyId);
  const ctl = new AbortController();
  const started = Date.now();
  let lastActivity = started;
  let inFlight = 0;
  let pageLabel = '';
  let stage = '';
  let ahead: number | null = null;
  let stageLabel = '';
  let choosing = false;
  let create = false;
  let jobAt: number | null = null;
  let update: LeaveUpdate = 'none';
  return new Promise<HookEnd>((resolve) => {
    let settled = false;
    const label = () => {
      if (choosing) return 'Waiting for your choice';
      return stageText(stage, ahead, stageLabel, create, study) || pageLabel || `Updating the project from ${study}…`;
    };
    const draw = () => {
      if (settled) return;
      const now = Date.now();
      const shown = now - started >= LEAVE_PROGRESS_MS;
      // Only once the link's job exists (the page's uploads are over), never while the user chooses.
      const background = !choosing && jobAt !== null && (stage === 'queued' || now - jobAt >= LEAVE_BACKGROUND_MS);
      publishProgress({ running: true, shown, label: label(), choosing, background, started: jobAt !== null });
    };
    const finish = (end: HookEnd, abort: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      leaveControls = null;
      if (abort) ctl.abort();
      resolve(end);
    };
    const busy = () => typeof window.__CFD_DIALOG_BUSY__ === 'function' && window.__CFD_DIALOG_BUSY__() === true;
    const tick = setInterval(() => {
      const now = Date.now();
      // The stall timer waits while an app dialog is open, the user chooses, a call is in
      // flight (an upload, the link) or the link's job waits in the queue.
      if (choosing || inFlight > 0 || stage === 'queued' || busy()) lastActivity = now;
      if (now - lastActivity >= LEAVE_STALL_MS) {
        finish({ kind: 'failed', message: `it did not answer for ${Math.round(LEAVE_STALL_MS / 1000)} seconds`, update, stall: true }, true);
        return;
      }
      draw();
    }, LEAVE_TICK_MS);
    leaveControls = {
      cancel: () => finish({ kind: 'stay' }, true),
      background: () => {
        if (progress.background) finish({ kind: 'go' }, false);
      },
    };
    const activity = (a: LeaveActivity) => {
      if (settled) return;
      lastActivity = Date.now();
      if (a.kind === 'progress') pageLabel = a.label;
      else if (a.kind === 'calls') inFlight = a.inFlight;
      else if (a.kind === 'link') {
        // A job that starts at once is never shown as queued (no flash of "Queued").
        if (!(a.stage === 'queued' && a.waiting === false)) {
          stage = a.stage;
          ahead = a.ahead;
          stageLabel = a.label;
        }
      } else if (a.kind === 'choosing') choosing = a.open;
      else if (a.kind === 'kept') {
        finish({ kind: 'stay' }, true);
        return;
      } else if (a.kind === 'linked') {
        if (!a.ok) update = 'none';
        else if (a.change && a.change !== 'none') update = 'done';
      } else if (a.kind === 'accepted') {
        create = a.create;
        if (a.jobId) {
          jobAt = Date.now();
          if (update !== 'done') update = 'running';
        }
        if (a.queued) stage = 'queued';
        // A caller that cannot ask waits only until the server has the link (LINK 6.4).
        if (!interactive) {
          finish({ kind: 'go' }, false);
          return;
        }
      }
      draw();
    };
    draw();
    hook.run(reason, { signal: ctl.signal, interactive, activity }).then(
      (out) => finish(out.ok ? { kind: 'done' } : { kind: 'failed', message: out.message || '', update }, false),
      (err) => finish({ kind: 'failed', message: err instanceof Error ? err.message : String(err), update }, false),
    );
  });
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

/**
 * Browser Back/Forward or a typed link away from a workspace that needs work first
 * (unsaved work, or an exit hook to run): hold it and ask (or run the hook). During a
 * leave the address is only put back.
 */
function onHash(e: HashChangeEvent): void {
  const ws = open;
  if (!ws || !leaveNeedsWork()) return;
  const from = routeOf(e.oldURL);
  if (!from || !sameRoute(from, ws.route)) return;
  // The same workspace spelled another way (%2D for "-") is not a way out.
  const to = routeOf(e.newURL);
  if (to && sameRoute(to, ws.route)) return;
  // Nothing else hears of this change, and the address is the workspace's again.
  e.stopImmediatePropagation();
  history.pushState(history.state, '', e.oldURL);
  // One leave at a time: the running one decides.
  if (leaving || asking) return;
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

/**
 * Leaving needs work first (LINK 6.4): the page has unsaved work, or an exit hook to run,
 * and the user has not chosen to leave already. A running leave counts.
 */
export function leaveNeedsWork(): boolean {
  if (!open || approved) return false;
  if (leaving) return true;
  return state.dirty || !!(open.hook && open.hook.on());
}

/** A leave is running the page's exit hook. */
export function leaveInProgress(): boolean {
  return leaving;
}

/** The way out the guard last let through for this workspace (the landing's reason), or null. */
export function lastLeaveReason(ws: GuardedWorkspace): LeaveReason | null {
  return lastReason && lastReason.ws === ws ? lastReason.reason : null;
}

/**
 * That leave went on while the link's job still ran ("Continue in background", or a caller
 * that cannot ask): its landing comes later, while the user works.
 */
export function lastLeaveInBackground(ws: GuardedWorkspace): boolean {
  return !!lastReason && lastReason.ws === ws && lastReason.background;
}

/** Hear what the workspace header shows while a leave runs the page's hook. */
export function subscribeLeaveProgress(fn: (p: LeaveProgress) => void): () => void {
  progressSubscribers.add(fn);
  fn({ ...progress });
  return () => {
    progressSubscribers.delete(fn);
  };
}

/** The header's Cancel: the hook is aborted and the workspace stays (no question). */
export function cancelLeave(): void {
  leaveControls?.cancel();
}

/** "Continue in background": the leave goes on now; the link's job runs on in the app. */
export function continueLeaveInBackground(): void {
  leaveControls?.background();
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
 * The geometry's name for a failed leave's question: the app's answer, or after
 * LEAVE_NAME_MS the last one known (the app may be busy behind a long call).
 */
async function geometryNameSoon(hook: LeaveHook): Promise<string> {
  const last = () => {
    try {
      return hook.lastGeometryName ? hook.lastGeometryName() : '';
    } catch {
      return '';
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(last()), LEAVE_NAME_MS);
  });
  try {
    return await Promise.race([hook.geometryName().catch(() => last()), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What a stall waited for, as the bridge knows it (LEAVE_NAME_MS at most; null when it cannot say). */
async function stallCauseSoon(hook: LeaveHook): Promise<{ answers: boolean; saving: boolean } | null> {
  if (!hook.stallCause) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LEAVE_NAME_MS);
  });
  try {
    return await Promise.race([hook.stallCause().catch(() => null), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The guard let this way out through: the overlay's landing reads why (and whether the job ran on). */
function noteReason(ws: GuardedWorkspace | null, reason: LeaveReason, background = false): void {
  if (ws) lastReason = { ws, reason, background };
}

/**
 * May the user leave the open workspace? True at once when nothing would be lost and the
 * page has no exit hook; otherwise, in order (LINK 6.4): leave full screen, probe the
 * page, run its hook (not for turning the plugin off), ask about unsaved work only if the
 * page is still dirty (merged into the one question when the hook failed), approve, go.
 * Questions wait their turn behind another app dialog (one at a time). False when the
 * user stays, cancels or keeps editing, while another leave or question is running, when
 * it must not ask (interactive: false) and would have to, and when the workspace closed
 * meanwhile (a question about it closes with it).
 */
export async function confirmLeaveWorkspace(reason: LeaveReason, opts: { interactive?: boolean } = {}): Promise<boolean> {
  const ws = open;
  const ends = openEnds;
  const run = { ran: false };
  const ok = await confirmLeave(reason, opts, run);
  // The hook ran and the user stays in this workspace (still open): it hears so.
  if (!ok && run.ran && ws && open === ws && openEnds === ends) {
    try {
      ws.stayed?.();
    } catch (err) {
      console.warn('[workspace] stay listener failed', err);
    }
  }
  return ok;
}

async function confirmLeave(reason: LeaveReason, opts: { interactive?: boolean }, run: { ran: boolean }): Promise<boolean> {
  if (leaving || asking) return false;
  const ws = open;
  if (!ws || !leaveNeedsWork()) {
    noteReason(ws, reason);
    return true;
  }
  const ends = openEnds;
  const interactive = opts.interactive !== false;
  // Turning the plugin off runs no hook (D11): today's question about unsaved work only.
  const hook = reason !== 'plugin-off' && ws.hook && ws.hook.on() ? ws.hook : null;
  let failed: { message: string; update: LeaveUpdate; stall: boolean } | null = null;
  if (hook) {
    leaving = true;
    try {
      await exitFrameFullscreen();
      const alive = await hook.probe();
      if (openEnds !== ends) return false;
      // A crashed or hung page runs no hook: the geometry keeps its last update.
      if (alive) {
        run.ran = true;
        const end = await runHook(ws, hook, reason, interactive);
        if (openEnds !== ends) return false;
        if (end.kind === 'stay') {
          refocus(ws);
          return false;
        }
        if (end.kind === 'go') {
          // The job goes on in the app; the page's unsaved work (if any) is the caller's to ask about.
          if (!interactive && state.dirty) return false;
          approve(true);
          noteReason(ws, reason, true);
          return true;
        }
        if (end.kind === 'failed') failed = { message: end.message, update: end.update, stall: !!end.stall };
      }
      if (failed !== null) {
        // A caller that cannot ask stays.
        if (!interactive) return false;
        // The question comes next: the header offers nothing meanwhile (no Cancel with
        // nothing left to cancel), and a slow app holds it up for LEAVE_NAME_MS at most.
        publishProgress({ ...progress, choosing: true, background: false });
        const [geometry, cause] = await Promise.all([geometryNameSoon(hook), failed.stall ? stallCauseSoon(hook) : Promise.resolve(null)]);
        if (openEnds !== ends) return false;
        publishProgress(IDLE);
        const said = failed.stall ? stallMessage(ws, cause) : { message: failed.message, own: false };
        asking = true;
        let ok = false;
        try {
          ok = await ask(hookFailedQuestion(ws, said.message, geometry, failed.update, said.own), ends ? ends.signal : undefined);
        } finally {
          asking = false;
        }
        if (openEnds !== ends) return false;
        if (!ok) {
          refocus(ws);
          return false;
        }
        approve(true);
        noteReason(ws, reason);
        return true;
      }
    } finally {
      leaving = false;
      publishProgress(IDLE);
    }
  }
  if (!state.dirty) {
    // Nothing is unsaved. After the hook the approval window starts now (LINK 6.4).
    if (hook) approve(true);
    noteReason(ws, reason);
    return true;
  }
  if (!interactive) return false;
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
  noteReason(ws, reason);
  return true;
}

/** Go to `hash` if the user may leave the open workspace; false when they chose to stay. */
export async function leaveWorkspaceTo(hash: string, reason: LeaveReason): Promise<boolean> {
  if (!(await confirmLeaveWorkspace(reason))) return false;
  location.hash = hash;
  return true;
}
