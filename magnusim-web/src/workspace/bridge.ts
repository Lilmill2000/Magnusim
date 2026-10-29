/**
 * The workspace bridge, host side (API 1.3).
 *
 * A plugin workspace runs in a sandboxed frame with an opaque origin. It says
 * hello (window.postMessage, only accepted from this frame's window) and gets
 * its context plus a private MessageChannel port; every call comes over that
 * port and is checked against the allowlist below, scoped to this plugin,
 * project and study. Anything else is refused ("not allowed") and logged.
 *
 * Files in the plugin's folder of the project go to /api/plugin-files as raw
 * bytes: the frame hands over Blobs and ArrayBuffers, never JSON-encoded data.
 *
 * After every frame load the host asks the document it talks to whether it is
 * still there (probe/alive); a new document that has not connected (a reload,
 * a navigation) ends the old channel, the job streams and the uploads it opened.
 *
 * The page has unsaved work while it says so (nav.setDirty) or while one of its
 * uploads is open; the host hears of every change (hooks.setDirty) and asks
 * before any way out. A closed channel is clean again.
 *
 * Plugin OpenFOAM cases (1.3): compute.* submits a case the page wrote in its
 * study's folder, and follows, stops and lists the study's cases. One event
 * stream per channel carries every followed case; a reconnect's snapshot
 * catches each case up (its end, or its start and the live points the frame has
 * not had), and an event the frame already has (by seq) is dropped.
 * Every stream the bridge follows (a job's, the cases', the link's) is a channel on
 * the tab's one event stream (src/api/eventHub.ts): the browser's connections to the
 * app are few, and the host page's streams share them with every tab. A hidden tab
 * lets that stream go unless a channel is pinned: a job's always are, the cases'
 * while a followed case has not ended, the link's while the page waits for a link.
 *
 * Linked geometries (1.5): project.linkGeometry sends the study's saved design to
 * /api/plugin-geometry/link and stays pending until the job it started ends, following
 * it on this study's /api/plugin-geometry/events stream (its stages go to the page as
 * `linkProgress`). Link job ids sit in a follow-only set, never in `jobs`: nothing a
 * page can call stops an update. The same stream tells the page when this study's
 * geometry changed (`geometry`), and no other study's page hears it.
 *
 * Exit sync (1.6): a page registers its exit hook (nav.leaveHook); the leave guard runs it
 * through runLeave on each way out the host owns: the event `leave {leave, reason}`, then
 * the page's nav.leaveProgress and nav.leaveDone (with its camera), or `leaveAbort` when
 * the user cancels or the hook stalls. While it runs, the bridge tells the guard what
 * happens (calls in flight, the link's stages, the host's question, the job accepted).
 *
 * Editing a project geometry (1.7): the context carries the geometry the study edits
 * (`geometry`, /api/plugin-geometry/target) and, once, what the user right-clicked to open
 * it (`launch`); project.geometrySource streams its STEP file to the page as a Blob (its
 * progress goes to the page as `sourceProgress`), project.geometryFaces answers its face
 * table, and project.linkGeometry passes `originalNames` for the link that adopts it.
 *
 * Tools for the app's assistant (unreleased, next minor 1.9; HOST_API_VERSION stays 1.8 until it
 * ships): the page offers tools with assistant.register; the host checks their shape and hands
 * them to hooks.assistantTools, which answers the app's verdict (bounded at 5 s: past that the
 * page hears `not_connected` and that list is abandoned). invokeTool runs one call at a time: the
 * event `assistantInvoke`, then the page's assistant.progress (each resets the call's stall
 * window, as do the page's calls in flight, which the caller hears as onAlive so that its own
 * window waits too; `waiting: true` goes on to the caller: the call waits for the person, and
 * the turn's minutes stop meanwhile) and its assistant.result, checked and capped here (images
 * read to base64 in this page). `assistantAbort` stops it: on Stop (the page's answer is
 * awaited for 2 s), on a stall, when a leave begins (`leaving`) and when the channel ends
 * (`closed`, after which hooks.assistantTools(null) withdraws the tools). The assistant's turns
 * bound to this tab reach the page as the event `assistantTurn` (assistantTurn(), from the page
 * relay), and the page's assistant.stop {turn} goes to hooks.assistantStop, which stops only a
 * turn told to this tab.
 *
 * Undo from the app's Assistant panel (the dock; unreleased, 1.9): the page says which turn's
 * changes it can undo now as one step (assistant.undoable {turn, label|null}; only a turn told to
 * this page; hooks.assistantUndoable hears each offer and its withdrawal, and every offer goes with
 * the channel). assistantUndo(turn) asks the page (the event `assistantUndo {req, turn}`, answered
 * by assistant.undone {req, undone, reason?}) only for a turn it offers, while no turn told to it
 * runs and no tool call runs, one at a time. The welcome's `assistantDock` says the host has the
 * panel (hooks.assistantDocked), and the page's Ctrl+/ comes as assistant.dock (hooks.assistantDockKey).
 *
 * The welcome's `appearance` is the app's look (hooks.appearance; 1.9, unreleased), and each change
 * of it the window hears (APPEARANCE_EVENT) goes to the page as the `appearance` event, once per
 * look: the SDK shows it on the page's <html>.
 */
import type {
  Appearance,
  AssistantRegistration,
  AssistantRisk,
  AssistantStopAnswer,
  AssistantTurn,
  AssistantUndoAnswer,
  AssistantUndoOffer,
  ComputeJob,
  EditedGeometry,
  FileInfo,
  FileWriteResult,
  GeometryFaces,
  JobEvent,
  LaunchTarget,
  LinkedGeometry,
  LinkResult,
  StudyRecord,
  ThemeInfo,
  UnitSystem,
  ViewState,
  WorkspaceContext,
} from '../plugin-sdk/workspace';
import { openChannel, type ChannelHandle } from '../api/eventHub';
import { isCad } from '../app/edition';
import { ASSISTANT_KEYS_EVENT } from '../keybinds/appKeys';
import { APPEARANCE_EVENT } from '../theme/appearance';
import type { LeaveReason } from './leaveGuard';
import { sendLinkChoice, type LinkChoice, type LinkCopyOutcome, type LinkQuestion } from './linkChoice';
import { linkTouchesSetup, setupOf, type LinkSetup } from './linkReport';
import { announcePref, PREFS_CHANNEL } from './prefsChannel';

export const HOST_SDK_MAJOR = 1;
export const HOST_API_VERSION = '1.8';
/** A link job's id (gl-<time>-<hex>, scripts/link-store.js LINK_JOB_RE). */
const LINK_JOB_ID = /^gl-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
/**
 * How long a link waits for its channel to be on the server before it is sent anyway (the
 * channel's snapshot and the job's status still settle it; only progress could be missed).
 */
const LINK_CHANNEL_WAIT_MS = 5000;
const PROBE_MS = 1500;
const METHOD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** The longest unsaved-work message the host shows (after cleaning). */
export const DIRTY_MESSAGE_MAX = 200;
/**
 * What the host shows while a write of the page to its own folder is open and the page gave no
 * message of its own. Leaving stops that write; the project's geometries and simulations are
 * not touched by it (the leave question adds nothing about discarding).
 */
export const UPLOAD_OPEN = 'It is still writing a file in its own folder of the project. Leaving stops that write; nothing else in the project changes.';
// C0, DEL and C1 (\p{Cc}), line and paragraph separators, and bidi controls.
const DIRTY_MESSAGE_CONTROLS = /[\p{Cc}\u{2028}\u{2029}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** A page's unsaved-work message as plain text on one line: no controls, single spaces, at most 200 characters. */
export function cleanDirtyMessage(raw: unknown): string {
  let text = '';
  try {
    text = String(raw ?? '');
  } catch {
    // Not text at all (an object whose toString is no function): no message.
  }
  return text
    .replace(DIRTY_MESSAGE_CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIRTY_MESSAGE_MAX);
}

/**
 * A camera the page sent (linkGeometry's `view`, or the exit hook's), checked (LINK 6.6):
 * null when a number is not finite, the position equals the target, `up` lies along the
 * view direction, the projection is unknown, or the angle or height is out of range.
 */
export function viewState(raw: unknown): ViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const vec = (x: unknown): [number, number, number] | null =>
    Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [x[0], x[1], x[2]] : null;
  const position = vec(v.position);
  const target = vec(v.target);
  const up = vec(v.up);
  if (!position || !target || !up) return null;
  if (v.projection !== 'perspective' && v.projection !== 'orthographic') return null;
  const d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const dLen = Math.hypot(d[0], d[1], d[2]);
  const upLen = Math.hypot(up[0], up[1], up[2]);
  if (!(dLen > 1e-9) || !(upLen > 1e-9)) return null;
  const cross = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  if (Math.hypot(cross[0], cross[1], cross[2]) <= 1e-6 * dLen * upLen) return null;
  const out: ViewState = { position, target, up, projection: v.projection };
  if (v.fovDeg !== undefined && v.fovDeg !== null) {
    if (typeof v.fovDeg !== 'number' || !Number.isFinite(v.fovDeg) || v.fovDeg <= 0 || v.fovDeg >= 180) return null;
    out.fovDeg = v.fovDeg;
  }
  if (v.height !== undefined && v.height !== null) {
    if (typeof v.height !== 'number' || !Number.isFinite(v.height) || v.height <= 0) return null;
    out.height = v.height;
  }
  return out;
}

/** What happens while the page's exit hook runs (API 1.6), as the bridge tells the leave guard. */
export type LeaveActivity =
  /** The page's own progress (nav.leaveProgress). */
  | { kind: 'progress'; fraction: number | null; label: string }
  /** Bridge calls of the page now in flight (uploads, the link): the hook is busy, not stalled. */
  | { kind: 'calls'; inFlight: number }
  /**
   * The link job's stage (queued with the jobs ahead of it, reading, waiting, ...). For
   * `queued`, `waiting` false says it starts at once (nothing holds the slot or the study).
   */
  | { kind: 'link'; stage: string; ahead: number | null; label: string; waiting?: boolean }
  /**
   * The server took the link: a job (`jobId`; `create` for a first link or "Save as new",
   * which take no queue row; `queued` for an overwrite in the Queue), or nothing to do (null).
   */
  | { kind: 'accepted'; jobId: string | null; create: boolean; queued: boolean }
  /** The host's question is on screen (open), or answered or dropped. */
  | { kind: 'choosing'; open: boolean }
  /** The user chose "Keep editing" in the host's question: the leave ends, the workspace stays. */
  | { kind: 'kept' }
  /**
   * A link of this leave's hook ended: it went through (`ok`, with its change; `none`
   * changed nothing) or it was refused or dropped (the project is as it was).
   */
  | { kind: 'linked'; ok: boolean; change: string };

/** How the page's exit hook ended. */
export interface LeaveHookOutcome {
  ok: boolean;
  /** Why not (the page's message, a refused link's, or "its page closed"). */
  message?: string;
}

/** One leave the page's exit hook runs. */
interface LeaveRun {
  id: string;
  activity: (a: LeaveActivity) => void;
  done: (out: LeaveHookOutcome) => void;
  /** The last link of this leave was refused: its message (cleared by a link that went through). */
  linkError: string | null;
  /** Calls of the page that began during this leave and are not answered yet (its stall timer). */
  inFlight: number;
}

/** A tool call of the app's assistant that the page runs (1.9, unreleased), as the bridge tells it what happens. */
interface InvokeRun {
  /** The id the page has (`ai-<n>`). */
  id: string;
  /** Calls of the page that began during this call and are not answered yet: its stall window waits for them. */
  inFlight: number;
  /** The page said how far it is (assistant.progress; `waiting`: it waits for the person), or its calls in flight changed. */
  activity(a: { kind: 'progress'; fraction: number | null; label: string; waiting?: boolean } | { kind: 'calls' }): void;
  /** The page's answer (assistant.result), checked. */
  done(out: AssistantCallOutcome): void;
  /** End it now with this code (the page is told `assistantAbort`). */
  cancel(code: string, message: string): void;
  /** Reads a file attached in the call's conversation (the caller's AssistantInvoke.attachment); null: the caller reads none. */
  attachment: ((id: string, signal: AbortSignal) => Promise<AssistantAttachmentRead>) | null;
  /** Aborted as the call ends: its attachment reads stop. */
  reads: AbortController;
}

/**
 * Calls that are no work of a running hook: the leave's own messages, and the page's own
 * ways out (its Done, Open in 3D), which wait on a leave themselves (inside a hook they
 * answer at once).
 */
const NOT_HOOK_WORK = new Set([
  'nav.leaveProgress',
  'nav.leaveDone',
  'nav.leaveHook',
  'nav.back',
  'results.openIn3D',
  // The assistant's own messages (1.9, unreleased): no work of a leave's hook, nor of a tool call.
  'assistant.register',
  'assistant.progress',
  'assistant.result',
  'assistant.stop',
  'assistant.undoable',
  'assistant.undone',
  'assistant.dock',
]);

/** Link refusals that are no error of the hook: "Keep editing", the Queue's remove, a newer link. */
const QUIET_LINK_ENDS = new Set(['cancelled', 'superseded', 'not_now']);

export interface BridgeScope {
  plugin: string;
  pluginName: string;
  workspace: string;
  projectId: string;
  projectTitle: string;
  studyId: string;
}

export interface BridgeHooks {
  /** Leave the workspace for the project; false when the user chose to stay. */
  back(): Promise<boolean>;
  /** The page's unsaved-work state changed (message is '' when clean). */
  setDirty(dirty: boolean, message: string): void;
  connected(): void;
  studyChanged(study: StudyRecord): void;
  /** The study is not in the project any more (deleted in another tab). */
  studyGone(): void;
  toast(message: string, kind: 'info' | 'success' | 'error'): void;
  /**
   * guard (a deliberate click on Yes only) and safe (Enter answers Cancel) come from the page's
   * ui.confirm when it asks for them (the CAD Part's Assistant keybind changes: unreleased 1.9).
   */
  confirm(opts: { title: string; copy: string; yes: string; guard?: boolean; safe?: boolean }): Promise<boolean>;
  prompt(opts: { title: string; label: string; value: string; yes: string }): Promise<string | null>;
  units(): UnitSystem;
  log(message: string, detail?: unknown): void;
  /**
   * results.openIn3D: show a case's saved frames in the project's viewer. True
   * once the workspace is closing for it; false when the user cancelled or stayed.
   */
  openResults(caseRel: string): Promise<boolean>;
  /**
   * A link this page made committed: its result and what of it touches the user's setup
   * (5.14; the hook decides whether that is worth a dialog, a toast or nothing).
   */
  linkReport?(result: LinkResult, setup: LinkSetup): void;
  /**
   * A link this page started (its job, or its answer at once): the host lands on that
   * geometry when the workspace closes (showLinkedGeometry, LINK 6.5).
   */
  linkStarted?(link: { geometryId: string; jobId: string | null; created: boolean }): void;
  /**
   * The host's question (API 1.5, LINK 5.0): the shape changed under simulation setup.
   * The answer, or null when it was dropped (the page is going away, or the job ended
   * another way): the question then stays open and the geometry's row offers "Choose…".
   */
  linkChoice?(question: LinkQuestion, signal: AbortSignal): Promise<LinkChoice | null>;
  /** "Save as new" landed: the new geometry and what its copies came to (the host's report). */
  linkSavedAsNew?(info: { newName: string; oldName: string; copies: LinkCopyOutcome[] | null }): void;
  /** The camera the page wants the project's viewport to land with (API 1.6, LINK 6.6): the last one wins. */
  linkView?(view: ViewState): void;
  /**
   * The page's tools for the app's assistant (1.9, unreleased), checked here, or null when the
   * page went away (its channel ended). Answers the app's verdict; the bridge waits for it
   * ASSISTANT_REGISTER_MS and then calls `abandon()`: that list must never reach the assistant,
   * and is withdrawn if its verdict comes late. No hook: the page hears `no_assistant`.
   */
  assistantTools?(reg: CheckedAssistantTools | null): AssistantPublication;
  /**
   * The page's assistant.stop (1.9, unreleased): stop that turn of the app's assistant, only when
   * it was told to this tab (else `not_this_tab`). No hook: the page hears `no_assistant`.
   */
  assistantStop?(turn: string): Promise<AssistantStopAnswer>;
  /**
   * The page offers to undo a turn's changes as one step (`label` names it), or no longer does
   * (null; also for each offer when its channel ends) (1.9, unreleased). Only a turn told to this
   * page reaches it. No hook: the page hears `no_assistant`.
   */
  assistantUndoable?(turn: string, label: string | null): void;
  /** Whether the host shows its Assistant panel (the welcome's `assistantDock`; 1.9, unreleased). */
  assistantDocked?(): boolean;
  /** The page's Ctrl+/ (assistant.dock; 1.9, unreleased): true when the panel took it. */
  assistantDockKey?(): boolean;
  /**
   * The panel's keys the person chose (the welcome's `assistantKeys`, again as the `assistantKeys`
   * event when the window hears ASSISTANT_KEYS_EVENT), or null for its default (1.9, unreleased).
   */
  assistantKeys?(): string[] | null;
  /**
   * The app's look as the page gets it (the welcome's `appearance`, again as the `appearance` event
   * when the window hears APPEARANCE_EVENT; 1.9, unreleased): the theme on screen, never a light
   * swap of html for one task. No hook: the welcome has none, and the page stays light.
   */
  appearance?(): Appearance;
}

/** What hooks.assistantTools answers: the verdict to come, and how to drop a list it was too late for. */
export type AssistantPublication = Promise<AssistantRegistration> & { abandon?(): void };

/** A tool of the page as the host passes it on (1.9, unreleased): its shape checked, its texts cleaned. */
export interface CheckedTool {
  /** The page's own name for it (the app checks its spelling). */
  name: string;
  /** For the user ('' when the page gave none), cleaned, at most 200 characters. */
  title: string;
  /** For the model, cleaned, at most 1024 characters. */
  description: string;
  /** Plain JSON data; the app checks it against its schema subset. */
  inputSchema: Record<string, unknown>;
  /** The page's claim; an unknown one is `destructive`. */
  risk: AssistantRisk;
  /** The call's stall window in seconds (1 to 600, default 60). */
  timeoutS: number;
  /** What the app's question before a destructive call says it does, cleaned, at most 120 characters (absent when the page gave none). */
  confirm?: string;
  /** Which tools a local model's budget keeps first: 0 to 100, higher stays (absent when the page gave none: 50). */
  priority?: number;
}

/** Review rounds as the host passes them on (1.9, unreleased): 1 to 5 rounds, the prompt cleaned (its lines kept), at most 1500 characters. */
export interface CheckedReview {
  rounds: number;
  prompt: string;
}

/** assistant.register's params as the host passes them on: `review` absent when the page asked for none. */
export interface CheckedAssistantTools {
  tools: CheckedTool[];
  guide: string;
  review?: CheckedReview;
}

/** A tool call's result as it leaves the page (1.9, unreleased): images as base64. */
export interface AssistantCallResult {
  text?: string;
  data?: unknown;
  images?: Array<{ mediaType: string; data: string }>;
  /** One line for the turn's log, never for the model (at most 160 characters). */
  summary?: string;
}

/**
 * How a tool call ended (1.9, unreleased): the page's result, or a code with its message, and
 * from the page's own error how to fix it (`hint`) and plain JSON about it (`detail`).
 */
export type AssistantCallOutcome = { ok: true; result: AssistantCallResult } | { ok: false; code: string; message: string; hint?: string; detail?: unknown };

/** One call of a page's tool (WorkspaceBridge.invokeTool). */
export interface AssistantInvoke {
  /** The caller's id for this call (the page gets the bridge's own, `ai-<n>`). */
  call: string;
  /** The assistant's turn: the page groups its calls by it. */
  turn: string;
  tool: string;
  input: unknown;
  /** Its stall window in seconds (1 to 600; else the tool's own). */
  timeoutS: number;
  signal: AbortSignal;
  /**
   * Its place in its step (one answer of the model; a turn's own calls only): the step's number in
   * the turn, how many calls of that answer come after it, and how many of those are the turn's
   * workspace's edit or destructive tools. The page's AssistantCall carries them.
   */
  step?: number;
  callsLeftInStep?: number;
  editsLeftInStep?: number;
  /** `opts.waiting`: the call waits for the person (the page said so; absent otherwise). */
  onProgress(fraction: number | null, label: string, opts?: { waiting?: boolean }): void;
  /**
   * The call is alive though its page sends no progress: a call of the page (a host read, a
   * link, a file) started or ended, and every ASSISTANT_ALIVE_MS while one is in flight. Such a
   * call holds this bridge's stall window open; a caller with a window of its own holds it too.
   */
  onAlive?(): void;
  /**
   * Reads a file attached in the conversation of the call's turn, for the page's
   * assistant.attachment while the call runs (`signal` aborts as it ends). A refusal throws an
   * error whose `code` says why (not_found, not_allowed, bad_request; anything else reads failed).
   * Absent: the page can read none (a core call, a caller with no conversation).
   */
  attachment?(id: string, signal: AbortSignal): Promise<AssistantAttachmentRead>;
}

/** An attached file as a call's caller read it (AssistantInvoke.attachment). */
export interface AssistantAttachmentRead {
  blob: Blob;
  /** The name the person's file had. */
  fileName: string;
  /** Its SHA-256, as hex ('' when the server gave none). */
  sha256: string;
}

/** An attachment's id, as the server makes them. */
const ATTACHMENT_ID = /^att-[0-9a-f]{16}$/;
/** The codes a refused attachment read keeps; any other reads failed. */
const ATTACHMENT_CODES: ReadonlySet<string> = new Set(['not_found', 'not_allowed', 'bad_request']);

export class BridgeError extends Error {
  code: string;
  /** Seconds to wait before asking again (a `not_ready` refusal, API 1.7). */
  retryAfter?: number;
  constructor(message: string, code = 'failed', retryAfter?: number) {
    super(message);
    this.code = code;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) this.retryAfter = retryAfter;
  }
}

const notAllowed = (what: string) => new BridgeError(`not allowed: ${what}`, 'not_allowed');

/**
 * Magnusim CAD has no project geometries: a page's design never becomes one. Its host refuses
 * the link calls (not_allowed: "this host links nothing"). The exit hook stays: it still holds
 * a save on its way at Back and says when work is unsaved (CAD: link/leave.ts, controller.ts).
 */
const NOT_IN_CAD_EDITION = new Set(['project.linkGeometry', 'project.linkedGeometry', 'project.followGeometry']);
const badParam = (what: string) => new BridgeError(`bad parameter: ${what}`, 'bad_request');
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** How long assistant.register waits for the app's verdict before the page hears `not_connected`. */
export const ASSISTANT_REGISTER_MS = 5000;
/** How long a stopped tool call waits for the page's last answer. */
export const ASSISTANT_ABORT_WAIT_MS = 2000;
/**
 * While a call of the page is in flight during a tool call, the caller hears the call is alive
 * this often (onAlive): the server's own stall window (timeoutS + 10 s) waits too.
 */
export const ASSISTANT_ALIVE_MS = 5000;
/** The most tools a page offers, and the most bytes they (and the guide) take as JSON. */
export const ASSISTANT_TOOLS_MAX = 32;
export const ASSISTANT_TOOLS_BYTES = 512 * 1024;
/** A tool call's stall window: the default and the longest, in seconds. */
export const ASSISTANT_TIMEOUT_S = 60;
export const ASSISTANT_TIMEOUT_MAX_S = 600;
/** A result's caps: its text, its data as JSON (UTF-8 bytes), and its images. */
export const ASSISTANT_TEXT_BYTES = 64 * 1024;
export const ASSISTANT_DATA_BYTES = 256 * 1024;
export const ASSISTANT_IMAGES_MAX = 4;
export const ASSISTANT_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** A page error's hint (characters) and detail (as JSON, UTF-8 bytes), and a result's summary (characters). */
export const ASSISTANT_HINT_MAX = 500;
export const ASSISTANT_DETAIL_BYTES = 4 * 1024;
export const ASSISTANT_SUMMARY_MAX = 160;
/** How long assistantUndo waits for the page's answer (the SDK answers no_answer itself after 10 s). */
export const ASSISTANT_UNDO_WAIT_MS = 12_000;
/** The most undo offers a page keeps (the oldest goes first). */
export const ASSISTANT_UNDO_OFFERS_MAX = 16;
/** The most turns told to a page that the bridge remembers (an offered one always stays). */
const ASSISTANT_TOLD_MAX = 64;
/** An undo offer's label (characters). */
export const ASSISTANT_UNDO_LABEL_MAX = 120;
/** A tool's confirm note (characters): what the question before a destructive call says it does. */
export const ASSISTANT_CONFIRM_MAX = 120;
/** A page error's message, at most this many characters (a note on a dropped detail included). */
const ASSISTANT_MESSAGE_MAX = 2000;
const ASSISTANT_GUIDE_MAX = 4000;
/** A review's most rounds, and its prompt's most characters. */
export const ASSISTANT_REVIEW_ROUNDS_MAX = 5;
export const ASSISTANT_REVIEW_PROMPT_MAX = 1500;
const ASSISTANT_RISKS = new Set<string>(['read', 'edit', 'compute', 'destructive']);
const ASSISTANT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/**
 * The codes a page's own error keeps: its handler's (invalid_input, busy, not_ready, failed) and
 * no_tool, which the SDK answers for a tool it holds no handler for. Any other reads "failed".
 */
const ASSISTANT_PAGE_CODES = new Set(['invalid_input', 'busy', 'not_ready', 'failed', 'no_tool']);
const notConnected = (): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason: 'not_connected' });

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Text from the page on one line: no controls, single spaces, at most `max` characters. */
function cleanLine(raw: unknown, max: number): string {
  let text = '';
  try {
    text = String(raw ?? '');
  } catch {
    // Not text at all: none.
  }
  return text.replace(DIRTY_MESSAGE_CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects (undefined is left out), not too deep. */
function isJsonData(v: unknown, depth = 32): boolean {
  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || depth <= 0) return false;
  if (Array.isArray(v)) return v.every((x) => isJsonData(x, depth - 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as Record<string, unknown>).every((x) => isJsonData(x, depth - 1));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** A tool call's stall window in seconds: a number is rounded into 1 to 600; anything else is the default. */
function assistantTimeoutS(v: unknown, fallback = ASSISTANT_TIMEOUT_S): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(ASSISTANT_TIMEOUT_MAX_S, Math.max(1, Math.round(v)));
}

/**
 * assistant.register's params checked (1.9, unreleased): `bad_request` for a list that is not one,
 * more than 32 tools, a tool that is not `{name, description, inputSchema, ...}` or an input schema
 * that is not plain JSON, a title, confirm note or guide that is not text, a review that is not
 * `{rounds: 1 to 5, prompt: text}` (its prompt not empty once cleaned); `too_large` past 512 KB.
 * Texts are cleaned and capped, an unknown risk is `destructive`. Names and schemas are the app's
 * to judge (its verdict refuses a tool with the reason).
 */
export function checkAssistantTools(params: Record<string, unknown>): CheckedAssistantTools {
  const list = params.tools;
  if (!Array.isArray(list) || list.length > ASSISTANT_TOOLS_MAX) throw badParam(`tools (a list of at most ${ASSISTANT_TOOLS_MAX} tools)`);
  const tools = list.map((raw: unknown, i): CheckedTool => {
    const what = `tools[${i}]`;
    if (!isPlainObject(raw)) throw badParam(`${what} (a tool: {name, description, inputSchema, risk})`);
    const name = raw.name;
    if (typeof name !== 'string' || !name || name.length > 64) throw badParam(`${what}.name (text of 1 to 64 characters)`);
    if (typeof raw.description !== 'string') throw badParam(`${what}.description (text)`);
    if (raw.title !== undefined && raw.title !== null && typeof raw.title !== 'string') throw badParam(`${what}.title (text)`);
    if (raw.confirm !== undefined && raw.confirm !== null && typeof raw.confirm !== 'string') throw badParam(`${what}.confirm (text)`);
    if (raw.priority !== undefined && raw.priority !== null && (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority))) throw badParam(`${what}.priority (a number from 0 to 100)`);
    if (!isPlainObject(raw.inputSchema) || !isJsonData(raw.inputSchema)) throw badParam(`${what}.inputSchema (a JSON schema object)`);
    const risk = typeof raw.risk === 'string' && ASSISTANT_RISKS.has(raw.risk) ? (raw.risk as AssistantRisk) : 'destructive';
    const confirm = cleanLine(raw.confirm, ASSISTANT_CONFIRM_MAX);
    return {
      name,
      title: cleanLine(raw.title, 200),
      description: cleanLine(raw.description, 1024),
      inputSchema: raw.inputSchema,
      risk,
      timeoutS: assistantTimeoutS(raw.timeoutS),
      ...(confirm ? { confirm } : {}),
      ...(typeof raw.priority === 'number' ? { priority: Math.min(100, Math.max(0, Math.round(raw.priority))) } : {}),
    };
  });
  const g = params.guide;
  if (g !== undefined && g !== null && typeof g !== 'string') throw badParam('guide (text)');
  // The guide keeps its lines; other controls go.
  const guide = keepLines(g, ASSISTANT_GUIDE_MAX);
  const review = checkReview(params.review);
  if (utf8Bytes(JSON.stringify({ tools, guide, review })) > ASSISTANT_TOOLS_BYTES) {
    throw new BridgeError(`The tools take more than ${ASSISTANT_TOOLS_BYTES / 1024} KB: offer fewer, or shorter ones.`, 'too_large');
  }
  return review ? { tools, guide, review } : { tools, guide };
}

/** Text that keeps its lines (CR LF and CR as LF) and tabs, other controls as spaces, trimmed, at most `max` characters. */
function keepLines(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(DIRTY_MESSAGE_CONTROLS, (c) => (c === '\n' || c === '\t' ? c : ' '))
    .trim()
    .slice(0, max);
}

/** assistant.register's `review`: absent (undefined or null) for none, else `{rounds: 1 to 5, prompt}`, or `bad_request`. */
function checkReview(raw: unknown): CheckedReview | undefined {
  if (raw === undefined || raw === null) return undefined;
  const what = `review ({rounds: 1 to ${ASSISTANT_REVIEW_ROUNDS_MAX}, prompt: text of at most ${ASSISTANT_REVIEW_PROMPT_MAX} characters})`;
  if (!isPlainObject(raw)) throw badParam(what);
  const rounds = raw.rounds;
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > ASSISTANT_REVIEW_ROUNDS_MAX) throw badParam(what);
  if (typeof raw.prompt !== 'string' || raw.prompt.length > ASSISTANT_REVIEW_PROMPT_MAX) throw badParam(what);
  const prompt = keepLines(raw.prompt, ASSISTANT_REVIEW_PROMPT_MAX);
  if (!prompt) throw badParam(what);
  return { rounds, prompt };
}

/** The app's verdict as the page gets it: only names the page offered, texts cleaned. */
function assistantVerdict(raw: unknown, offered: Set<string>): AssistantRegistration {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const available = r.available === true;
  const accepted = available && Array.isArray(r.accepted) ? [...new Set(r.accepted.filter((n): n is string => typeof n === 'string' && offered.has(n)))] : [];
  const refused = (Array.isArray(r.refused) ? r.refused : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ name: cleanLine(x.name, 64), code: cleanLine(x.code, 64) || 'refused', message: cleanLine(x.message, 2000) }));
  const out: AssistantRegistration = { available, accepted, refused };
  if (typeof r.reason === 'string' && r.reason) out.reason = cleanLine(r.reason, 64);
  return out;
}

/** A Blob's bytes as base64. */
async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * A page error as the call's outcome (1.9, unreleased): its code from the page's list, or the
 * SDK's own `no_tool` (else `failed`); its message cleaned (at most 2000 characters); its hint
 * cleaned (at most 500); its detail when it is plain JSON of at most 4 KB. A detail it can't
 * keep is dropped, and the message says so: " (detail too large)", " (detail not plain JSON)".
 */
function assistantPageError(raw: unknown): AssistantCallOutcome {
  const e = isPlainObject(raw) ? raw : {};
  const code = typeof e.code === 'string' && ASSISTANT_PAGE_CODES.has(e.code) ? e.code : 'failed';
  let note = '';
  let detail: unknown;
  if (e.detail !== undefined && e.detail !== null) {
    const json = isJsonData(e.detail) ? JSON.stringify(e.detail) : undefined;
    if (json === undefined) note = ' (detail not plain JSON)';
    else if (utf8Bytes(json) > ASSISTANT_DETAIL_BYTES) note = ' (detail too large)';
    else detail = JSON.parse(json);
  }
  const message = `${cleanLine(e.message, ASSISTANT_MESSAGE_MAX - note.length) || 'The tool failed.'}${note}`;
  const hint = typeof e.hint === 'string' ? cleanLine(e.hint, ASSISTANT_HINT_MAX) : '';
  return { ok: false, code, message, ...(hint ? { hint } : {}), ...(detail !== undefined ? { detail } : {}) };
}

/**
 * The page's assistant.result as the call's outcome (1.9, unreleased): its error (above); its
 * result checked (`bad_result`: not `{text?, data?, images?, summary?}` with text, plain JSON
 * data, PNG, JPEG or WebP Blobs and a text summary) and capped (`too_large`: text over 64 KB,
 * data over 256 KB as JSON, more than 4 images or one over 1.5 MB), its images read to base64,
 * its summary cleaned and cut to 160 characters.
 */
export async function assistantCallOutcome(params: Record<string, unknown>): Promise<AssistantCallOutcome> {
  const bad = (why: string): AssistantCallOutcome => ({ ok: false, code: 'bad_result', message: `The tool's result was refused: ${why}.` });
  const big = (why: string): AssistantCallOutcome => ({ ok: false, code: 'too_large', message: `The tool's result is too large: ${why}.` });
  if (params.ok === false) return assistantPageError(params.error);
  if (params.ok !== true) return bad('it says neither ok nor not ok');
  const raw = params.result;
  if (raw === undefined || raw === null) return { ok: true, result: {} };
  if (!isPlainObject(raw)) return bad('it is not text or {text, data, images}');
  const result: AssistantCallResult = {};
  if (raw.text !== undefined && raw.text !== null) {
    if (typeof raw.text !== 'string') return bad('its text is not text');
    if (utf8Bytes(raw.text) > ASSISTANT_TEXT_BYTES) return big('its text is over 64 KB');
    result.text = raw.text;
  }
  if (raw.summary !== undefined && raw.summary !== null) {
    if (typeof raw.summary !== 'string') return bad('its summary is not text');
    const summary = cleanLine(raw.summary, ASSISTANT_SUMMARY_MAX);
    if (summary) result.summary = summary;
  }
  if (raw.data !== undefined) {
    if (!isJsonData(raw.data)) return bad('its data is not plain JSON');
    const json = JSON.stringify(raw.data);
    if (json !== undefined && utf8Bytes(json) > ASSISTANT_DATA_BYTES) return big('its data is over 256 KB as JSON');
    if (json !== undefined) result.data = JSON.parse(json);
  }
  if (raw.images !== undefined && raw.images !== null) {
    if (!Array.isArray(raw.images)) return bad('its images are not a list');
    if (raw.images.length > ASSISTANT_IMAGES_MAX) return big(`it has more than ${ASSISTANT_IMAGES_MAX} images`);
    const images: Array<{ mediaType: string; blob: Blob }> = [];
    for (const im of raw.images as unknown[]) {
      const m = (im && typeof im === 'object' ? im : {}) as { mediaType?: unknown; data?: unknown };
      if (typeof m.mediaType !== 'string' || !ASSISTANT_IMAGE_TYPES.has(m.mediaType) || !(m.data instanceof Blob)) {
        return bad('each image is {mediaType: image/png, image/jpeg or image/webp, data: a Blob}');
      }
      if (m.data.size > ASSISTANT_IMAGE_BYTES) return big('an image is over 1.5 MB');
      images.push({ mediaType: m.mediaType, blob: m.data });
    }
    try {
      result.images = await Promise.all(images.map(async (im) => ({ mediaType: im.mediaType, data: await blobBase64(im.blob) })));
    } catch {
      return bad('an image could not be read');
    }
  }
  return { ok: true, result };
}

/** A plugin case's id (fc-<time>-<6 hex>). */
const CASE_JOB_ID = /^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
const CASE_DONE = new Set(['done', 'failed', 'stopped', 'lost']);

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v || v.length > max) throw badParam(what);
  return v;
}

function caseJobId(v: unknown): string {
  if (typeof v !== 'string' || !CASE_JOB_ID.test(v)) throw badParam('jobId');
  return v;
}

function texts(v: unknown, what: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw badParam(what);
  for (const x of v) if (typeof x !== 'string' || !x || x.length > maxLength) throw badParam(what);
  return [...(v as string[])];
}

/** compute.submitOpenFOAM's params as the app's submit body (§9.1 shapes; anything else is dropped). */
export function caseSubmitBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { case_rel: text(params.caseRel, 'caseRel', 240), app: text(params.app, 'app', 64) };
  if (params.nProcs !== undefined && params.nProcs !== null) {
    const n = params.nProcs;
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 64) throw badParam('nProcs (a whole number from 1 to 64)');
    body.n_procs = n;
  }
  if (params.pre !== undefined && params.pre !== null) {
    if (!Array.isArray(params.pre) || params.pre.length > 16) throw badParam('pre (at most 16 steps)');
    body.pre = params.pre.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badParam('pre (each step an object)');
      const step = raw as Record<string, unknown>;
      const out: Record<string, unknown> = { tool: text(step.tool, 'pre tool', 32) };
      if (step.args !== undefined && step.args !== null) out.args = texts(step.args, 'pre args (at most 4, each at most 120 characters)', 4, 120);
      if (step.parallel !== undefined && step.parallel !== null) {
        if (typeof step.parallel !== 'boolean') throw badParam('pre parallel (true or false)');
        out.parallel = step.parallel;
      }
      return out;
    });
  }
  const res = params.results;
  if (!res || typeof res !== 'object' || Array.isArray(res)) throw badParam('results');
  const r = res as Record<string, unknown>;
  const results: Record<string, unknown> = { kinematicFields: texts(r.kinematicFields, 'results.kinematicFields', 16, 64) };
  if (r.rho !== undefined && r.rho !== null) {
    if (typeof r.rho !== 'number' || !Number.isFinite(r.rho) || r.rho <= 0) throw badParam('results.rho (a number above 0)');
    results.rho = r.rho;
  }
  if (r.frameFields !== undefined && r.frameFields !== null) results.frameFields = texts(r.frameFields, 'results.frameFields', 16, 64);
  body.results = results;
  return body;
}

/** A case's result in the frame's shape (ComputeJob.result), whether the app sent it as the record or the job has it. */
function caseResult(raw: unknown): ComputeJob['result'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (r[camel] !== undefined ? r[camel] : r[snake]);
  const saved = pick('savedTimes', 'saved_times');
  const phases = r.phases;
  const last = Number(pick('lastSaved', 'last_saved') ?? NaN);
  const format = pick('writeFormat', 'write_format');
  return {
    savedTimes: Array.isArray(saved) ? (saved as unknown[]).map((t) => Number(t)).filter((t) => Number.isFinite(t)) : [],
    lastSaved: Number.isFinite(last) ? last : null,
    phases: phases && typeof phases === 'object' ? (phases as Record<string, number>) : {},
    writeFormat: typeof format === 'string' ? format : null,
  };
}

/** A case as the frame gets it from compute.status and compute.list. */
function caseJob(job: ComputeJob): ComputeJob {
  return { ...job, result: caseResult(job.result) };
}

/** A link file's fields as the link route takes them (`bad_request` for anything else). */
function linkFileBody(v: unknown, what: string): { rel: string; sha256?: string; etag?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badParam(`${what} ({rel, sha256} or {rel, etag})`);
  const f = v as Record<string, unknown>;
  const out: { rel: string; sha256?: string; etag?: string } = { rel: text(f.rel, `${what}.rel`, 240) };
  if (f.sha256 !== undefined && f.sha256 !== null) {
    if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) throw badParam(`${what}.sha256 (64 hex digits)`);
    out.sha256 = f.sha256.toLowerCase();
  }
  if (f.etag !== undefined && f.etag !== null) out.etag = text(f.etag, `${what}.etag`, 200);
  if (!!out.sha256 === !!out.etag) throw badParam(`${what} (exactly one of sha256 and etag)`);
  return out;
}

/** project.linkGeometry's params as the link route's body (scope added by the caller). */
export function linkBody(params: Record<string, unknown>): Record<string, unknown> {
  const shape = linkFileBody(params.shape, 'shape');
  const format = (params.shape as Record<string, unknown>).format;
  const body: Record<string, unknown> = { shape: { ...shape, format: typeof format === 'string' ? format : '' } };
  body.face_names = params.faceNames === undefined || params.faceNames === null ? null : linkFileBody(params.faceNames, 'faceNames');
  // API 1.7: the original's face names, for the link that adopts the geometry the study edits.
  if (params.originalNames !== undefined && params.originalNames !== null) body.original_names = linkFileBody(params.originalNames, 'originalNames');
  if (!isCount(params.sourceVersion)) throw badParam('sourceVersion (a whole number)');
  body.source_version = params.sourceVersion;
  const based = params.basedOnRev;
  if (based !== null && based !== undefined && !isCount(based)) throw badParam('basedOnRev (a whole number or null)');
  body.based_on_rev = based ?? null;
  if (params.name !== undefined && params.name !== null) body.name = text(params.name, 'name', 120);
  // API 1.7: this host asks its question when the study's geometry was removed (else 409 target_removed).
  body.ask_removed = true;
  return body;
}

/** A finished link's result for the page: the job's own, else the minimal one an older record kept. */
function linkResultOf(raw: unknown): LinkResult {
  return raw as LinkResult;
}

/**
 * Something in a link the user must be told (proposal 5.14): a record whose face was lost,
 * came back, split, merged, was claimed twice or moved far, or a record saved for an older
 * version. Faces no record refers to are never worth a report.
 */
export function linkNeedsReport(r: LinkResult | null | undefined, setup?: LinkSetup | null): boolean {
  return linkTouchesSetup(r, setup);
}

/** A link this page is waiting for: where its progress goes, and how it ends. */
interface LinkWait {
  token: string;
  done: (r: LinkResult) => void;
  fail: (e: BridgeError) => void;
  seq: number;
  /** The host's question while it is on screen: aborted when the job ends another way. */
  ask?: AbortController | null;
  /** "Save as new": the old geometry's name, for the report. */
  oldName?: string;
}

/**
 * A followed case: the last seq the frame was given; `held` keeps its events until it is
 * caught up. `started` and `lastT` (the time of the last progress point given) are what a
 * reconnect's snapshot catches the frame up from.
 */
interface FollowedCase {
  seq: number;
  endSent: boolean;
  held: Array<{ seq: number; ev: JobEvent }> | null;
  started: boolean;
  lastT: number | null;
}

/** The time of a progress point (its `t`), or null when it has none. */
function pointTime(p: unknown): number | null {
  const t = p && typeof p === 'object' ? Number((p as { t?: unknown }).t) : NaN;
  return Number.isFinite(t) ? t : null;
}

export const THEME: ThemeInfo = { name: 'light', stylesheet: '/plugin-sdk/theme.css' };

/** A refused answer as a BridgeError: the app's own code when it names one, else one from the status. */
async function refusal(r: Response): Promise<BridgeError> {
  const j = (await r.json().catch(() => ({}))) as { error?: string; code?: unknown; retryAfter?: unknown };
  const code = typeof j.code === 'string' && j.code ? j.code : r.status === 409 ? 'conflict' : r.status === 404 ? 'not_found' : 'failed';
  const wait = Number(j.retryAfter ?? r.headers.get('Retry-After'));
  return new BridgeError(String(j.error || `the app answered ${r.status}`), code, code === 'not_ready' && wait > 0 ? wait : undefined);
}

/** The one-shot launch target a geometry action left for this page (API 1.7). */
export interface LaunchSource {
  get(): LaunchTarget | null;
  /** The page got it: a reload of the page gets none. */
  drop(): void;
}

/** How often a geometrySource read tells the page how far it is. */
const SOURCE_PROGRESS_MS = 100;

async function api<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const r = await fetch(url, {
    method: init?.method || (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  if (!r.ok) throw await refusal(r);
  return (await r.json().catch(() => ({}))) as T;
}

/** An upload this workspace began: where it writes, and how far it has got. */
interface OpenUpload {
  rel: string;
  size: number;
  chunkBytes: number;
  received: number;
  /** A chunk or the commit is on its way (one at a time). */
  busy: boolean;
}

/**
 * The allowlist: what a workspace may ask the host for, each call scoped to
 * this plugin, project and study. Returns what the frame gets back.
 */
export class WorkspaceCalls {
  readonly scope: BridgeScope;
  /** Who this page is in a pref change's announcement: its own change is not news to it. */
  readonly prefsFrom = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly hooks: BridgeHooks;
  /** Jobs this workspace started (the only ones it may follow or stop). */
  readonly jobs = new Set<string>();
  /** Link jobs this page started: followed only, never stoppable (API 1.5). */
  readonly linkJobs = new Set<string>();
  /** Links this page waits for, by job id; the study's link stream and whether the page wants `geometry`. */
  private readonly linkWaits = new Map<string, LinkWait>();
  /**
   * False for a caller that cannot ask (L3's scripted exit, askToLeave:false): the host's
   * question is answered "Overwrite" at once, revision 6's update (LINK 5.0, 6.4).
   */
  private interactive = true;
  /** The page registered an exit hook (nav.leaveHook, API 1.6). */
  leaveHookOn = false;
  /** The leave the page's hook is running, or null. */
  private leave: LeaveRun | null = null;
  /** The name of the geometry this study links, as the last link or question said. */
  private linkedName = '';
  private linkStream: ChannelHandle | null = null;
  /** Link calls on their way to the server (their channel is pinned meanwhile). */
  private linkCalls = 0;
  private wantsGeometry = false;
  /** Link jobs whose end the page was told of (`geometry` once per job). */
  private readonly linkEnds = new Set<string>();
  private readonly streams = new Map<string, ChannelHandle>();
  /** The study's plugin cases the frame follows (compute.events), and their one stream. */
  private readonly cases = new Map<string, FollowedCase>();
  private caseStream: ChannelHandle | null = null;
  /** Uploads this workspace began (the only ones it may send to, commit or abort). */
  private readonly uploads = new Map<string, OpenUpload>();
  /** Bumped by close(): an upload begun before it is aborted when its answer comes. */
  private epoch = 0;
  /** What the page last said with nav.setDirty (the message only counts while dirty). */
  private frameDirty = false;
  private frameMessage = '';
  /** The unsaved-work state the host was last told. */
  private told = { dirty: false, message: '' };
  private push: (msg: Record<string, unknown>) => void = () => undefined;
  /** What the user right-clicked to open this study (API 1.7), given once with the context. */
  private readonly launch: LaunchSource | null;
  /** project.geometrySource reads in flight, by the page's token (API 1.7). */
  private readonly sourceReads = new Map<string, AbortController>();
  /** The page's tools the app's assistant accepted, by name (1.9, unreleased); null before any. */
  private assistantTools: Map<string, CheckedTool> | null = null;
  /** The tool call the page runs (one at a time), and the last call id given (`ai-<n>`). */
  private invoke: InvokeRun | null = null;
  private invokeSerial = 0;
  /** The last assistant.register (only its verdict is kept), its lists still waiting for one, and whether any went to the hook. */
  private assistantSerial = 0;
  private readonly assistantWaiting = new Set<AssistantPublication>();
  private assistantOffered = false;
  /** The turns told to this channel's page (assistantTurn), by id: their title and whether they run (the newest last). */
  private readonly toldTurns = new Map<string, { title: string; running: boolean }>();
  /** The turns whose changes the page offers to undo now, with the label (the oldest first). */
  private readonly undoOffers = new Map<string, string>();
  /** The undo the page was asked for and has not answered (one at a time): its id and how to settle it. */
  private undoWait: { req: string; done: (a: AssistantUndoAnswer) => void } | null = null;

  constructor(scope: BridgeScope, hooks: BridgeHooks, launch: LaunchSource | null = null) {
    this.scope = scope;
    this.hooks = hooks;
    this.launch = launch;
  }

  setPush(push: (msg: Record<string, unknown>) => void): void {
    this.push = push;
  }

  /** Whether a link of this page may show the host's question (false: answer "Overwrite"). */
  setInteractive(on: boolean): void {
    this.interactive = !!on;
  }

  /** A leave starts running the page's hook: what happens goes to `run.activity` until it ends. */
  beginLeave(run: { id: string; activity: (a: LeaveActivity) => void; done: (out: LeaveHookOutcome) => void; interactive: boolean }): void {
    // A tool call of the app's assistant stops first: the page is about to close (1.9, unreleased).
    // It ran until now, so its page may have done some or all of it.
    this.invoke?.cancel('leaving', 'its page is closing (the user is leaving the workspace) and it was stopped; it may or may not have finished');
    this.leave = { id: run.id, activity: run.activity, done: run.done, linkError: null, inFlight: 0 };
    this.setInteractive(run.interactive);
    this.note({ kind: 'calls', inFlight: 0 });
  }

  /** The leave ended (its hook returned, or the leave was cancelled or went on without it). */
  endLeave(id: string): void {
    if (!this.leave || this.leave.id !== id) return;
    this.leave = null;
    this.setInteractive(true);
  }

  /** A leave runs the page's exit hook now (a tool call is refused `leaving` meanwhile). */
  leaving(): boolean {
    return this.leave !== null;
  }

  /** The page's tool the app's assistant accepted by that name (1.9, unreleased), or null. */
  assistantTool(name: string): CheckedTool | null {
    return this.assistantTools?.get(name) ?? null;
  }

  /** A tool call runs in the page now (one at a time). */
  invoking(): boolean {
    return this.invoke !== null;
  }

  /** A tool call starts: the page gets the returned id, and what it does goes to `run` until it ends. */
  beginInvoke(run: Omit<InvokeRun, 'id' | 'inFlight'>): InvokeRun {
    const inv: InvokeRun = { ...run, id: `ai-${++this.invokeSerial}`, inFlight: 0 };
    this.invoke = inv;
    return inv;
  }

  /** That tool call ended. */
  endInvoke(id: string): void {
    if (this.invoke && this.invoke.id === id) this.invoke = null;
  }

  /** Tell the running leave (if any) what happened; a listener's failure stays here. */
  private note(a: LeaveActivity): void {
    const run = this.leave;
    if (!run) return;
    try {
      run.activity(a);
    } catch (e) {
      this.hooks.log('leave activity listener failed', e);
    }
  }

  /**
   * A call of the page came in; the returned function says it was answered. Only a call
   * that began during the running leave counts for its stall timer: one begun before it
   * (the page's Done or Open in 3D, which wait on this very leave, or a call of a leave the
   * user cancelled that is still waiting) is no work of this hook.
   */
  callStart(method: string): () => void {
    if (NOT_HOOK_WORK.has(method)) return () => undefined;
    this.calls.set(method, (this.calls.get(method) || 0) + 1);
    const run = this.leave;
    if (run) {
      run.inFlight += 1;
      this.note({ kind: 'calls', inFlight: run.inFlight });
    }
    // A tool call's stall window waits for the calls the page makes while it runs (1.9, unreleased).
    const inv = this.invoke;
    if (inv) {
      inv.inFlight += 1;
      inv.activity({ kind: 'calls' });
    }
    let answered = false;
    return () => {
      if (answered) return;
      answered = true;
      const left = (this.calls.get(method) || 1) - 1;
      if (left > 0) this.calls.set(method, left);
      else this.calls.delete(method);
      if (inv) {
        inv.inFlight = Math.max(0, inv.inFlight - 1);
        if (this.invoke === inv) inv.activity({ kind: 'calls' });
      }
      if (!run) return;
      run.inFlight = Math.max(0, run.inFlight - 1);
      if (this.leave === run) this.note({ kind: 'calls', inFlight: run.inFlight });
    };
  }

  /** That name as this page last heard it (no call to the app). */
  lastGeometryName(): string {
    return this.linkedName;
  }

  /** The name of the geometry this study links ('' before the first link). */
  async geometryName(): Promise<string> {
    try {
      const r = await api<{ linked: LinkedGeometry | null }>(
        `/api/plugin-geometry/linked?${this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId })}`,
      );
      if (r.linked && r.linked.name) this.linkedName = r.linked.name;
    } catch {
      /* the last one known */
    }
    return this.linkedName;
  }

  private q(extra: Record<string, string> = {}): string {
    return new URLSearchParams({ project_id: this.scope.projectId, ...extra }).toString();
  }

  /**
   * Tell the host when the unsaved-work state changes: dirty while the page
   * says so or an upload is open; the page's own message first, else the upload's.
   * Synchronous, so the host sees it before the page's next call.
   */
  private report(): void {
    const uploading = this.uploads.size > 0;
    const dirty = this.frameDirty || uploading;
    const message = this.frameDirty && this.frameMessage ? this.frameMessage : uploading ? UPLOAD_OPEN : '';
    if (dirty === this.told.dirty && message === this.told.message) return;
    this.told = { dirty, message };
    this.hooks.setDirty(dirty, message);
  }

  async study(): Promise<StudyRecord> {
    const r = await this.onStudy(() =>
      api<{ study: StudyRecord }>(`/api/plugin-studies/get?${this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId })}`),
    );
    return r.study;
  }

  /** A study call that finds no study tells the host (it closes the frame). */
  private async onStudy<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'not_found') this.hooks.studyGone();
      throw err;
    }
  }

  async context(): Promise<WorkspaceContext> {
    const [study, geometry] = await Promise.all([this.study(), this.editedGeometry()]);
    let launch: LaunchTarget | null = null;
    try {
      launch = this.launch ? this.launch.get() : null;
      this.launch?.drop();
    } catch {
      launch = null;
    }
    const appearance = this.hooks.appearance?.();
    return {
      plugin: this.scope.plugin,
      workspace: this.scope.workspace,
      project: { id: this.scope.projectId, title: this.scope.projectTitle },
      study,
      units: this.hooks.units(),
      theme: THEME,
      hostVersion: HOST_API_VERSION,
      geometry,
      launch,
      assistantDock: this.hooks.assistantDocked?.() === true,
      assistantKeys: this.hooks.assistantKeys?.() ?? null,
      ...(appearance ? { appearance } : {}),
      // Magnusim CAD refuses the link calls (NOT_IN_CAD_EDITION): the page hears so at once, to
      // leave out what only matters to a simulation (1.9, unreleased). Absent where links work.
      ...(isCad() ? { projectLinks: false } : {}),
    };
  }

  /** The project geometry this study edits (API 1.7), or null (also when the app cannot say). */
  private async editedGeometry(): Promise<EditedGeometry | null> {
    try {
      const r = await api<{ geometry?: EditedGeometry | null }>(
        `/api/plugin-geometry/target?${this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId })}`,
      );
      return r.geometry || null;
    } catch {
      return null;
    }
  }

  /**
   * project.geometrySource (API 1.7): the STEP file of the geometry this study edits, read
   * in chunks (the page hears how far: `sourceProgress`) and handed over as one Blob.
   */
  private async geometrySource(token: string): Promise<Record<string, unknown>> {
    const s = this.scope;
    const ctl = new AbortController();
    if (token) this.sourceReads.get(token)?.abort();
    if (token) this.sourceReads.set(token, ctl);
    try {
      const r = await fetch(`/api/plugin-geometry/source?${this.q({ plugin: s.plugin, study_id: s.studyId, format: 'step' })}`, {
        cache: 'no-store',
        signal: ctl.signal,
      });
      if (!r.ok) throw await refusal(r);
      const total = Number(r.headers.get('Content-Length')) || 0;
      const tell = (done: number) => {
        if (token) this.push({ event: 'sourceProgress', data: { token, done, total: total || done } });
      };
      let blob: Blob;
      const reader = r.body ? r.body.getReader() : null;
      if (!reader) {
        blob = await r.blob();
        tell(blob.size);
      } else {
        const parts: BlobPart[] = [];
        let done = 0;
        let last = 0;
        tell(0);
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (!value) continue;
          parts.push(value);
          done += value.byteLength;
          const now = Date.now();
          if (now - last >= SOURCE_PROGRESS_MS) {
            last = now;
            tell(done);
          }
        }
        tell(done);
        blob = new Blob(parts, { type: 'application/step' });
      }
      if (total && blob.size !== total) throw new BridgeError('The file did not arrive whole. Try again.', 'failed');
      let fileName = 'source.step';
      try {
        fileName = decodeURIComponent(r.headers.get('X-File-Name') || '') || fileName;
      } catch {
        /* the default name */
      }
      return {
        geometryId: String(r.headers.get('X-Geometry-Id') || ''),
        blob,
        fileName,
        format: 'step',
        size: blob.size,
        sha256: String(r.headers.get('X-Sha256') || ''),
        adopted: r.headers.get('X-Adopted') === '1',
      };
    } catch (e) {
      if (ctl.signal.aborted) throw new BridgeError('The read was stopped.', 'aborted');
      throw e;
    } finally {
      if (token && this.sourceReads.get(token) === ctl) this.sourceReads.delete(token);
    }
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.scope;
    if (NOT_IN_CAD_EDITION.has(method) && isCad()) throw notAllowed(`${method} in Magnusim CAD`);
    switch (method) {
      case 'service.call': {
        const name = String(params.method || '');
        if (params.plugin != null && params.plugin !== s.plugin) throw notAllowed("another plugin's service");
        if (!METHOD_NAME.test(name) || name.split('/').includes('..')) throw notAllowed(`service method ${JSON.stringify(name)}`);
        const body = params.params && typeof params.params === 'object' ? (params.params as Record<string, unknown>) : {};
        return api(`/api/plugin/${encodeURIComponent(s.plugin)}/${name}?${this.q()}`, { body: { ...body, project_id: s.projectId } });
      }
      case 'jobs.start': {
        const kind = String(params.kind || '');
        const jobParams = params.params && typeof params.params === 'object' ? (params.params as Record<string, unknown>) : {};
        const r = await api<{ job: { id: string } }>('/api/jobs', {
          body: { kind, plugin: s.plugin, params: { ...jobParams, project_id: s.projectId } },
        });
        this.jobs.add(r.job.id);
        return { id: r.job.id };
      }
      case 'jobs.events': {
        const jobId = String(params.jobId || '');
        if (!this.jobs.has(jobId)) throw notAllowed('a job this workspace did not start');
        this.follow(jobId);
        return { ok: true };
      }
      case 'jobs.stop': {
        const jobId = String(params.jobId || '');
        if (!this.jobs.has(jobId)) throw notAllowed('a job this workspace did not start');
        await api(`/api/jobs/${encodeURIComponent(jobId)}/stop?${this.q()}`, { method: 'POST', body: {} });
        return { ok: true };
      }
      case 'study.get':
        return this.study();
      case 'study.update': {
        const r = await this.onStudy(() =>
          api<{ study: StudyRecord }>('/api/plugin-studies/update', {
            body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, rev: params.rev, patch: params.patch },
          }),
        );
        this.hooks.studyChanged(r.study);
        return r.study;
      }
      case 'data.read': {
        const r = await api<{ doc: unknown }>('/api/plugin-data/read', {
          body: { project_id: s.projectId, plugin: s.plugin, rel: String(params.rel || '') },
        });
        return r.doc ?? null;
      }
      case 'data.write':
        await api('/api/plugin-data/write', {
          body: { project_id: s.projectId, plugin: s.plugin, rel: String(params.rel || ''), doc: params.doc ?? null },
        });
        return { ok: true };
      case 'files.stat':
      case 'files.list':
      case 'files.read':
      case 'files.write.begin':
      case 'files.write.chunk':
      case 'files.write.commit':
      case 'files.write.abort':
      case 'files.delete':
        if (params.plugin != null && params.plugin !== s.plugin) throw notAllowed("another plugin's files");
        return this.files(method, params);
      case 'project.info':
        return { id: s.projectId, title: s.projectTitle, units: this.hooks.units() };
      case 'project.linkGeometry':
        return this.linkGeometry(params);
      case 'project.linkedGeometry': {
        const r = await api<{ linked: LinkedGeometry | null }>(
          `/api/plugin-geometry/linked?${this.q({ plugin: s.plugin, study_id: s.studyId })}`,
        );
        return r.linked ?? null;
      }
      case 'project.followGeometry':
        this.wantsGeometry = true;
        this.openLinkStream();
        return { ok: true };
      // Editing a project geometry (API 1.7): its STEP file and its face table.
      case 'project.geometrySource': {
        const formats = Array.isArray(params.formats) ? params.formats.map(String) : ['step'];
        if (!formats.includes('step')) {
          throw new BridgeError("This app serves a project geometry only as 'step'.", 'unsupported_format');
        }
        return this.geometrySource(typeof params.token === 'string' ? params.token.slice(0, 64) : '');
      }
      case 'project.geometrySourceAbort': {
        const token = typeof params.token === 'string' ? params.token.slice(0, 64) : '';
        this.sourceReads.get(token)?.abort();
        return { ok: true };
      }
      case 'project.geometryFaces': {
        const r = await api<GeometryFaces & { ok?: boolean }>(
          `/api/plugin-geometry/faces?${this.q({ plugin: s.plugin, study_id: s.studyId })}`,
        );
        const { ok: _ok, ...faces } = r;
        return faces;
      }
      case 'prefs.units':
        return this.hooks.units();
      // The plugin's own prefs for this user, in every project (API 1.7). The plugin is
      // this frame's, never one the page names.
      case 'prefs.get': {
        const r = await api<{ value: unknown }>('/api/plugin-prefs/get', { body: { plugin: s.plugin, key: params.key } });
        return r.value ?? null;
      }
      case 'prefs.set':
      case 'prefs.remove': {
        const value = method === 'prefs.set' ? (params.value ?? null) : null;
        await api(`/api/plugin-prefs/${method === 'prefs.set' ? 'set' : 'remove'}`, { body: { plugin: s.plugin, key: params.key, value } });
        announcePref(s.plugin, String(params.key), value, this.prefsFrom);
        return { ok: true };
      }
      case 'theme':
        return THEME;
      case 'ui.toast': {
        const kind = params.kind === 'success' || params.kind === 'error' ? params.kind : 'info';
        this.hooks.toast(String(params.message || '').slice(0, 300), kind);
        return { ok: true };
      }
      case 'ui.confirm':
        return this.hooks.confirm({
          title: String(params.title || 'Are you sure?'),
          copy: String(params.message || ''),
          yes: String(params.confirmLabel || 'OK'),
          // A Yes that must be a deliberate click, and Enter answering Cancel, when the page asks.
          ...(params.guard === true ? { guard: true } : {}),
          ...(params.safe === true ? { safe: true } : {}),
        });
      case 'ui.prompt':
        return this.hooks.prompt({
          title: String(params.title || 'Name'),
          label: String(params.label || 'Name'),
          value: String(params.value || ''),
          yes: String(params.confirmLabel || 'Save'),
        });
      case 'nav.back':
        return { ok: true, left: (await this.hooks.back()) === true };
      case 'nav.setDirty': {
        // Both worked out before either is kept.
        const dirty = params.dirty === true;
        const message = dirty ? cleanDirtyMessage(params.message) : '';
        this.frameDirty = dirty;
        this.frameMessage = message;
        this.report();
        return { ok: true };
      }
      case 'nav.leaveHook':
        // The page's exit hook (1.6): every way out the host owns runs it from now on.
        this.leaveHookOn = params.on === true;
        return { ok: true };
      case 'nav.leaveProgress': {
        const run = this.leave;
        if (run && params.leave === run.id) {
          const f = params.fraction;
          const fraction = typeof f === 'number' && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : null;
          this.note({ kind: 'progress', fraction, label: cleanDirtyMessage(params.label) });
        }
        return { ok: true };
      }
      case 'nav.leaveDone': {
        const run = this.leave;
        // A leave that already ended (cancelled, kept editing, gone on without it): nothing to do.
        if (!run || params.leave !== run.id) return { ok: true };
        const view = viewState(params.view);
        if (view) this.hooks.linkView?.(view);
        const message = cleanDirtyMessage(params.message);
        if (params.ok === true) run.done(run.linkError ? { ok: false, message: run.linkError } : { ok: true });
        else run.done({ ok: false, message });
        return { ok: true };
      }
      case 'compute.submitOpenFOAM': {
        const body = caseSubmitBody(params);
        const r = await api<{ job: ComputeJob; ahead?: number | null; existing?: boolean }>(`/api/plugin-cases/submit?${this.q()}`, {
          body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, ...body },
        });
        return { id: r.job.id, ahead: typeof r.ahead === 'number' ? r.ahead : 0, existing: r.existing === true };
      }
      case 'compute.events': {
        const jobId = caseJobId(params.jobId);
        await this.followCase(jobId);
        return { ok: true };
      }
      case 'compute.stop': {
        const jobId = caseJobId(params.jobId);
        const r = await api<{ job: ComputeJob }>(`/api/plugin-cases/stop?${this.q()}`, {
          body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, job_id: jobId, force: params.force === true },
        });
        return { status: r.job.status, stopping: r.job.stopping === true };
      }
      case 'compute.status':
        return caseJob(await this.caseStatus(caseJobId(params.jobId)));
      case 'compute.list': {
        const r = await api<{ jobs: ComputeJob[] }>(`/api/plugin-cases?${this.caseQuery()}`);
        return (r.jobs || []).map(caseJob);
      }
      case 'results.openIn3D': {
        const caseRel = text(params.caseRel, 'caseRel', 240);
        return { opened: (await this.hooks.openResults(caseRel)) === true };
      }
      // Tools for the app's assistant (1.9, unreleased): the page's list, then each call's progress and end.
      case 'assistant.register':
        return this.registerAssistantTools(params);
      case 'assistant.progress': {
        const inv = this.invoke;
        // A call that already ended (stopped, stalled, another one): nothing to do.
        if (inv && params.call === inv.id) {
          const f = params.fraction;
          const fraction = typeof f === 'number' && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : null;
          inv.activity({ kind: 'progress', fraction, label: cleanDirtyMessage(params.label), ...(params.waiting === true ? { waiting: true } : {}) });
        }
        return { ok: true };
      }
      case 'assistant.result': {
        const inv = this.invoke;
        if (!inv || params.call !== inv.id) return { ok: true };
        inv.done(await assistantCallOutcome(params));
        return { ok: true };
      }
      // Not in NOT_HOOK_WORK: the read is the running call's own work, so its stall window waits for it.
      case 'assistant.attachment':
        return this.readAttachment(params);
      case 'assistant.stop':
        return this.stopAssistantTurn(params.turn);
      // Undo from the app's Assistant panel (1.9, unreleased): the page's offers and its answers.
      case 'assistant.undoable':
        return this.offerUndo(params.turn, params.label);
      case 'assistant.undone': {
        const w = this.undoWait;
        if (w && typeof params.req === 'string' && params.req === w.req) {
          w.done(params.undone === true ? { undone: true } : { undone: false, reason: cleanLine(params.reason, 64) || 'failed' });
        }
        return { ok: true };
      }
      case 'assistant.dock': {
        let took = false;
        try {
          took = this.hooks.assistantDockKey?.() === true;
        } catch (e) {
          this.hooks.log('assistant dock: the key was not taken', e);
        }
        return { ok: took };
      }
      default:
        throw notAllowed(method ? JSON.stringify(method) : 'an unnamed call');
    }
  }

  /**
   * assistant.attachment {call, id} (1.9, unreleased): a file attached in the conversation of the
   * running tool call's turn, for that call only (`call` is its `ai-<n>`) and only while it runs,
   * as {blob, fileName, size, sha256}. not_allowed for any other call, one that ended (a read
   * still going when it ends stops), or a call whose caller reads no attachment; bad_request for
   * an id that is not one; not_found when the conversation has no such file.
   */
  private async readAttachment(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const inv = this.invoke;
    if (!inv || params.call !== inv.id) throw notAllowed('an attachment read outside its running tool call');
    const id = params.id;
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw new BridgeError('id is an attachment id ("att-" and 16 hex digits).', 'bad_request');
    if (!inv.attachment) throw notAllowed('an attachment read in this call (no conversation reaches it)');
    const signal = inv.reads.signal;
    const ended = () => new BridgeError('the tool call ended before the file was read', 'not_allowed');
    let a: AssistantAttachmentRead;
    try {
      a = await inv.attachment(id, signal);
    } catch (e) {
      if (signal.aborted) throw ended();
      const err = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown };
      const code = typeof err.code === 'string' && ATTACHMENT_CODES.has(err.code) ? err.code : 'failed';
      throw new BridgeError(cleanDirtyMessage(err.message) || 'The file could not be read.', code);
    }
    if (signal.aborted) throw ended();
    return { blob: a.blob, fileName: a.fileName, size: a.blob.size, sha256: a.sha256 };
  }

  /**
   * assistant.register (1.9, unreleased): the page's tools, checked, go to the app (hooks.assistantTools)
   * and the page gets its verdict, or `not_connected` when none came within ASSISTANT_REGISTER_MS (that
   * list is abandoned then). Only the verdict of the page's last register, in this channel, is kept.
   */
  private async registerAssistantTools(params: Record<string, unknown>): Promise<AssistantRegistration> {
    // Every register the page sent is its last one, even one refused here: the SDK counts each one
    // that left the page, so an earlier list's verdict is kept on both sides or on neither.
    const serial = ++this.assistantSerial;
    const epoch = this.epoch;
    const reg = checkAssistantTools(params);
    if (!this.hooks.assistantTools) return { available: false, accepted: [], refused: [], reason: 'no_assistant' };
    let pub: AssistantPublication;
    try {
      pub = this.hooks.assistantTools(reg);
    } catch (e) {
      this.hooks.log('assistant tools: the app did not take them', e);
      return notConnected();
    }
    this.assistantOffered = true;
    this.assistantWaiting.add(pub);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((done) => {
      timer = setTimeout(() => done('late'), ASSISTANT_REGISTER_MS);
    });
    let answer: unknown;
    try {
      answer = await Promise.race([Promise.resolve(pub), late]);
    } catch (e) {
      this.hooks.log('assistant tools: the app did not take them', e);
      answer = 'late';
    } finally {
      clearTimeout(timer);
      this.assistantWaiting.delete(pub);
    }
    if (answer === 'late') {
      // Never sent on after this, and withdrawn if its verdict comes after all (close() abandoned it already).
      try {
        if (epoch === this.epoch) pub.abandon?.();
      } catch (e) {
        this.hooks.log('assistant tools: abandon failed', e);
      }
      return notConnected();
    }
    const verdict = assistantVerdict(answer, new Set(reg.tools.map((t) => t.name)));
    if (verdict.available && serial === this.assistantSerial && epoch === this.epoch) {
      const accepted = new Map<string, CheckedTool>();
      for (const t of reg.tools) if (verdict.accepted.includes(t.name) && !accepted.has(t.name)) accepted.set(t.name, t);
      this.assistantTools = accepted;
    }
    return verdict;
  }

  /**
   * assistant.stop {turn} (1.9, unreleased): the app stops that turn of its assistant when it was
   * told to this tab (hooks.assistantStop). `bad_request` for a turn that is not an id; the answer
   * is always {stopped, reason?}.
   */
  private async stopAssistantTurn(turn: unknown): Promise<AssistantStopAnswer> {
    if (typeof turn !== 'string' || !turn || turn.length > 128) throw badParam('turn (the id of a turn this page was told of)');
    if (!this.hooks.assistantStop) return { stopped: false, reason: 'no_assistant' };
    let answer: AssistantStopAnswer;
    try {
      answer = await this.hooks.assistantStop(turn);
    } catch (e) {
      this.hooks.log('assistant stop: the app did not take it', e);
      return { stopped: false, reason: 'failed' };
    }
    if (answer?.stopped === true) return { stopped: true };
    return { stopped: false, reason: cleanLine(answer?.reason, 64) || 'failed' };
  }

  /**
   * A turn of the app's assistant was told to this channel's page (1.9, unreleased): only such a
   * turn may be offered for undo, and none is undone while one of them runs.
   */
  noteTurn(turn: AssistantTurn): void {
    const id = typeof turn?.id === 'string' ? turn.id : '';
    if (!id) return;
    this.toldTurns.delete(id);
    this.toldTurns.set(id, { title: cleanLine(turn.title, 60), running: turn.state === 'running' });
    // The oldest go, except one still offered (at most ASSISTANT_UNDO_OFFERS_MAX of those).
    for (const old of [...this.toldTurns.keys()]) {
      if (this.toldTurns.size <= ASSISTANT_TOLD_MAX) break;
      if (!this.undoOffers.has(old)) this.toldTurns.delete(old);
    }
  }

  /** Tell the hook of an offer or its withdrawal; a hook that fails stays here. */
  private tellUndo(turn: string, label: string | null): void {
    try {
      this.hooks.assistantUndoable?.(turn, label);
    } catch (e) {
      this.hooks.log('assistant undo: the app did not take the offer', e);
    }
  }

  /**
   * assistant.undoable {turn, label} (1.9, unreleased): the page can undo that turn's changes now
   * as one step (label null: no longer). Only a turn told to this page; `bad_request` for a turn
   * that is not an id or a label that is not text. A label that cleans to nothing reads
   * "Assistant: <title>".
   */
  private offerUndo(turn: unknown, label: unknown): AssistantUndoOffer {
    if (typeof turn !== 'string' || !turn || turn.length > 128) throw badParam('turn (the id of a turn this page was told of)');
    if (label !== null && label !== undefined && typeof label !== 'string') throw badParam('label (text, or null to withdraw the offer)');
    if (label === null || label === undefined) {
      if (this.undoOffers.delete(turn)) this.tellUndo(turn, null);
      return { offered: false };
    }
    if (!this.hooks.assistantUndoable) return { offered: false, reason: 'no_assistant' };
    const told = this.toldTurns.get(turn);
    if (!told) return { offered: false, reason: 'not_this_tab' };
    const name = cleanLine(label, ASSISTANT_UNDO_LABEL_MAX) || cleanLine(`Assistant: ${told.title || 'request'}`, ASSISTANT_UNDO_LABEL_MAX);
    this.undoOffers.delete(turn);
    this.undoOffers.set(turn, name);
    this.tellUndo(turn, name);
    for (const old of [...this.undoOffers.keys()]) {
      if (this.undoOffers.size <= ASSISTANT_UNDO_OFFERS_MAX) break;
      this.undoOffers.delete(old);
      this.tellUndo(old, null);
    }
    return { offered: true };
  }

  /** The page's offer for that turn (its label), or null. */
  undoOffer(turn: string): string | null {
    return this.undoOffers.get(turn) ?? null;
  }

  /**
   * Why the page can't be asked to undo that turn now, or null when it can: `not_offered` (it offers
   * no undo of it), `leaving` (its exit hook runs), `busy` (a tool call runs, a turn told to it
   * runs, or another undo waits for its answer).
   */
  undoRefusal(turn: string): string | null {
    if (!this.undoOffers.has(turn)) return 'not_offered';
    if (this.leave) return 'leaving';
    if (this.invoke || this.undoWait) return 'busy';
    for (const t of this.toldTurns.values()) if (t.running) return 'busy';
    return null;
  }

  /** An undo the page is asked for: settles with its answer, `no_answer` after ASSISTANT_UNDO_WAIT_MS, or `closed` with the channel. */
  beginUndo(req: string, turn: string): Promise<AssistantUndoAnswer> {
    return new Promise<AssistantUndoAnswer>((resolve) => {
      const w = {
        req,
        done: (a: AssistantUndoAnswer) => {
          if (this.undoWait !== w) return;
          this.undoWait = null;
          clearTimeout(timer);
          // Undone: the offer is spent (the page offers it again after a redo).
          if (a.undone && this.undoOffers.delete(turn)) this.tellUndo(turn, null);
          resolve(a);
        },
      };
      const timer = setTimeout(() => w.done({ undone: false, reason: 'no_answer' }), ASSISTANT_UNDO_WAIT_MS);
      this.undoWait = w;
    });
  }

  /** Settle the undo asked for under that id (its page could not be told). */
  endUndo(req: string, a: AssistantUndoAnswer): void {
    if (this.undoWait && this.undoWait.req === req) this.undoWait.done(a);
  }

  /**
   * project.linkGeometry: refused `unsaved` while the page says it has unsaved work (the
   * geometry only ever shows a saved design); else the link route, then the job it
   * started, followed to its end.
   */
  private async linkGeometry(params: Record<string, unknown>): Promise<LinkResult> {
    const run = this.leave;
    try {
      const result = await this.linkGeometryNow(params);
      if (run && this.leave === run) {
        run.linkError = null;
        // The leave's question (if its hook then fails) says the project was updated.
        this.note({ kind: 'linked', ok: true, change: String(result.change || '') });
      }
      return result;
    } catch (e) {
      // A refused link inside a leave fails the leave (one question), whatever the hook then returns.
      const code = e instanceof BridgeError ? e.code : 'failed';
      if (run && this.leave === run) {
        if (!QUIET_LINK_ENDS.has(code)) run.linkError = cleanDirtyMessage((e as Error).message) || 'the link was refused';
        this.note({ kind: 'linked', ok: false, change: '' });
      }
      throw e;
    }
  }

  private async linkGeometryNow(params: Record<string, unknown>): Promise<LinkResult> {
    const s = this.scope;
    if (this.frameDirty) throw new BridgeError('Save the design before linking it: the page has unsaved work.', 'unsaved');
    // The camera to land with stays in this page (LINK 6.6); a bad one is dropped.
    if (params.view !== undefined && params.view !== null) {
      const view = viewState(params.view);
      if (view) this.hooks.linkView?.(view);
    }
    const token = typeof params.token === 'string' ? params.token.slice(0, 64) : '';
    const body = { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, ...linkBody(params) };
    // The study's link channel is on the server before the link is sent, so the events of the
    // job it starts reach this page (its channel on the tab's one stream is asked for in a
    // batch, after this call would have gone). Pinned meanwhile: a hidden tab opens it too.
    this.openLinkStream();
    const epoch = this.epoch;
    this.linkCalls += 1;
    this.pinLinkStream();
    let answer: { result?: LinkResult; job_id?: string; geometry_id?: string; created?: boolean; choosing?: LinkQuestion };
    try {
      await this.linkChannelReady();
      answer = await api<{ result?: LinkResult; job_id?: string; geometry_id?: string; created?: boolean; choosing?: LinkQuestion }>(
        `/api/plugin-geometry/link?${this.q()}`,
        { body },
      );
    } finally {
      this.linkCalls -= 1;
      this.pinLinkStream();
    }
    if (answer.result) {
      const done = linkResultOf(answer.result);
      if (done.name) this.linkedName = done.name;
      if (done.geometryId) this.hooks.linkStarted?.({ geometryId: done.geometryId, jobId: null, created: false });
      this.note({ kind: 'accepted', jobId: null, create: false, queued: false });
      // Nothing changed, but the link recorded the design's version: the geometry's row
      // reads the tree again ("Not up to date" goes), as it does when a job ends.
      window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { link: true } }));
      return done;
    }
    const jobId = String(answer.job_id || '');
    if (!LINK_JOB_ID.test(jobId)) throw new BridgeError('The app did not start the link', 'failed');
    if (answer.geometry_id && !answer.choosing) this.hooks.linkStarted?.({ geometryId: String(answer.geometry_id), jobId, created: !!answer.created });
    // "Queued" only for a job that waits (the server says `waiting`); one that starts at once is not.
    const queued = !!(answer as { queued?: boolean }).queued && (answer as { waiting?: boolean }).waiting !== false;
    if (!answer.choosing) this.note({ kind: 'accepted', jobId, create: !!answer.created, queued });
    // A page that closed before the answer came does not ask: the question stays open.
    if (epoch !== this.epoch) throw new BridgeError('the workspace closed', 'failed');
    this.linkJobs.add(jobId);
    const ending = new Promise<LinkResult>((done, fail) => {
      // The same design again joins the job already running (a leave cancelled, then Back
      // again): the earlier call waits for the same end, so both are answered.
      const prev = this.linkWaits.get(jobId);
      this.linkWaits.set(jobId, {
        token,
        done: prev
          ? (r) => {
              prev.done(r);
              done(r);
            }
          : done,
        fail: prev
          ? (e) => {
              prev.fail(e);
              fail(e);
            }
          : fail,
        seq: prev ? prev.seq : 0,
        ask: prev ? prev.ask : null,
        oldName: prev ? prev.oldName : undefined,
      });
      this.pinLinkStream();
      // It may have ended before the stream heard of it: its status says.
      void api<{ job?: { status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number } }>(
        `/api/plugin-geometry/status?${this.q({ plugin: s.plugin, study_id: s.studyId, job_id: jobId })}`,
      )
        .then((r) => {
          if (r.job) this.onLinkJob(jobId, r.job);
        })
        .catch(() => undefined);
    });
    // The job may end while the question is still being answered ("Keep editing" ends it
    // cancelled on the stream before the choose request returns): its rejection is
    // awaited below, so it is not an uncaught error meanwhile.
    ending.catch(() => undefined);
    if (answer.choosing) await this.answerLinkQuestion(jobId, answer.choosing);
    const result = await ending;
    if (result && result.name) this.linkedName = result.name;
    // Two calls that joined one job: its report shows once.
    if (this.reportedJobs.has(jobId)) return result;
    this.reportedJobs.add(jobId);
    const wait = this.saved.get(jobId);
    this.saved.delete(jobId);
    if (wait && result.created && wait.oldName) {
      try {
        this.hooks.linkSavedAsNew?.({ newName: result.name, oldName: wait.oldName, copies: wait.copies });
      } catch (e) {
        this.hooks.log('link report failed', e);
      }
      return result;
    }
    const setup = this.setups.get(jobId) || setupOf(null);
    this.setups.delete(jobId);
    try {
      this.hooks.linkReport?.(result, setup);
    } catch (e) {
      this.hooks.log('link report failed', e);
    }
    return result;
  }

  /** Link jobs whose report this page load has had (once per job). */
  private readonly reportedJobs = new Set<string>();

  /** What of each ended link job touches the user's setup (its end event's `setup`), until reported. */
  private readonly setups = new Map<string, LinkSetup>();

  /**
   * Calls of the page now in flight by method, whenever they began (a running leave's
   * stall timer counts only its own: callStart). A stall names what it waited for by these.
   */
  private readonly calls = new Map<string, number>();

  /** The page's saves now in flight through the app (a file or data write, the study's update). */
  savesInFlight(): number {
    let n = 0;
    for (const [m, c] of this.calls) if (/^(files\.write|files\.delete|data\.write|study\.update)/.test(m)) n += c;
    return n;
  }

  /** "Save as new" jobs this page waits for: the old geometry's name and the copies' outcome, for the report. */
  private readonly saved = new Map<string, { oldName: string; copies: LinkCopyOutcome[] | null }>();

  /**
   * The host's question for a link this page made (LINK 5.0): the dialog over the
   * workspace (or "Overwrite" at once for a caller that cannot ask), then the answer to
   * the choose route, which only the host calls. "Keep editing" ends the job `cancelled`,
   * which rejects linkGeometry with that code. A dialog dropped unanswered (the page went
   * away, or the job ended another way) sends nothing: the question stays open and the
   * geometry's row offers "Choose…".
   */
  private async answerLinkQuestion(jobId: string, question: LinkQuestion): Promise<void> {
    const s = this.scope;
    const wait = this.linkWaits.get(jobId);
    const ask = new AbortController();
    if (wait) {
      wait.ask = ask;
      wait.oldName = question.geometry.name;
    }
    if (question.geometry && question.geometry.name) this.linkedName = question.geometry.name;
    let picked: LinkChoice | null;
    const removed = question.kind === 'removed';
    // A caller that cannot ask: "Overwrite", or "Not now" when the geometry was removed (nothing is added).
    if (!this.interactive || !this.hooks.linkChoice) picked = removed ? { choice: 'not_now' } : { choice: 'overwrite' };
    else {
      // Inside a leave: "Waiting for your choice", and the stall timer waits too (LINK 6.4).
      this.note({ kind: 'choosing', open: true });
      try {
        picked = await this.hooks.linkChoice(question, ask.signal);
      } finally {
        this.note({ kind: 'choosing', open: false });
      }
    }
    if (wait) wait.ask = null;
    if (!picked || !this.linkWaits.has(jobId)) return;
    // "Keep editing" inside a leave: the leave ends at once and the workspace stays (no question).
    if (picked.choice === 'cancel') this.note({ kind: 'kept' });
    try {
      const chosen = await sendLinkChoice({ projectId: s.projectId, plugin: s.plugin, studyId: s.studyId, jobId }, picked);
      // "Add as new geometry" after a removal reports as a first link does (no old geometry kept).
      if (picked.choice === 'new' && !removed) this.saved.set(jobId, { oldName: question.geometry.name, copies: null });
      const goes = picked.choice !== 'cancel' && picked.choice !== 'not_now';
      if (chosen.geometry_id && goes) {
        this.hooks.linkStarted?.({ geometryId: String(chosen.geometry_id), jobId, created: !!chosen.created });
      }
      if (goes) this.note({ kind: 'accepted', jobId, create: picked.choice === 'new', queued: !!chosen.queued && chosen.waiting !== false });
    } catch (e) {
      const code = String((e as { code?: unknown })?.code || 'failed');
      // Answered in another tab or from the geometry's row: the job's end settles the call.
      if (code === 'not_choosing') return;
      const w = this.linkWaits.get(jobId);
      this.linkWaits.delete(jobId);
      this.linkJobs.delete(jobId);
      this.pinLinkStream();
      w?.fail(new BridgeError((e as Error).message || 'The answer was refused', code));
    }
  }

  /** This study's link stream: one per channel, for the links this page waits for and `geometry`. */
  private openLinkStream(): void {
    if (this.linkStream) return;
    const s = this.scope;
    const es = openChannel(`/api/plugin-geometry/events?${this.q({ plugin: s.plugin, study_id: s.studyId })}`);
    this.linkStream = es;
    es.addEventListener('snapshot', (e) => {
      try {
        const snap = JSON.parse((e as MessageEvent).data) as { jobs?: Array<{ id: string; status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number }> };
        for (const job of snap.jobs || []) if (job && job.id) this.onLinkJob(job.id, job);
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('link', (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as { job_id?: string; seq?: number; ev?: Record<string, unknown> };
        if (typeof m.job_id === 'string' && m.ev && typeof m.ev === 'object') this.onLinkEvent(m.job_id, Number(m.seq) || 0, m.ev);
      } catch {
        /* not JSON: skip */
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && this.linkStream === es) this.linkStream = null;
    };
    this.pinLinkStream();
  }

  /**
   * A link this page waits for, or is sending, keeps the tab's event stream while the tab is
   * hidden (its end settles the page's call, CAD's exit-hook link among them); a page that
   * only follows `geometry` catches up from the snapshot when the tab is shown again.
   */
  private pinLinkStream(): void {
    this.linkStream?.pin(this.linkWaits.size > 0 || this.linkCalls > 0);
  }

  /** The link channel is on the server, or LINK_CHANNEL_WAIT_MS went by (it is sent anyway). */
  private async linkChannelReady(): Promise<void> {
    const es = this.linkStream;
    if (!es || typeof es.ready !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((done) => {
      timer = setTimeout(done, LINK_CHANNEL_WAIT_MS);
    });
    try {
      await Promise.race([es.ready(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A link job's state as the snapshot or its status has it: an ended one settles. */
  private onLinkJob(jobId: string, job: { status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number; copies?: unknown; setup?: unknown }): void {
    const status = String(job.status || '');
    if (['queued', 'running', 'choosing'].includes(status)) return;
    this.onLinkEvent(
      jobId,
      Number(job.seq) || 0,
      { event: 'end', status, result: job.result ?? null, error: job.error ?? null, code: job.code ?? null, copies: job.copies ?? null, setup: job.setup ?? null },
      true,
    );
  }

  private onLinkEvent(jobId: string, seq: number, ev: Record<string, unknown>, snapshot = false): void {
    const wait = this.linkWaits.get(jobId);
    if (wait && !snapshot) {
      if (seq && seq <= wait.seq) return;
      if (seq) wait.seq = seq;
    }
    const kind = String(ev.event || '');
    if (kind === 'stage' || kind === 'queued') {
      if (wait) {
        this.note({
          kind: 'link',
          stage: kind === 'queued' ? 'queued' : String(ev.stage || ''),
          ahead: typeof ev.ahead === 'number' ? ev.ahead : null,
          label: typeof ev.label === 'string' ? ev.label : '',
          ...(kind === 'queued' && typeof ev.waiting === 'boolean' ? { waiting: ev.waiting } : {}),
        });
      }
      if (wait && wait.token) {
        const stage = kind === 'queued' ? 'queued' : String(ev.stage || '');
        if (stage) {
          this.push({
            event: 'linkProgress',
            data: {
              token: wait.token,
              stage,
              fraction: typeof ev.fraction === 'number' ? ev.fraction : null,
              ...(typeof ev.label === 'string' ? { label: ev.label } : {}),
              ...(typeof ev.ahead === 'number' ? { ahead: ev.ahead } : {}),
            },
          });
        }
      }
      return;
    }
    if (kind !== 'end') return;
    // The question on screen goes when its job ends another way (superseded, answered elsewhere).
    wait?.ask?.abort();
    const status = String(ev.status || '');
    const result = (ev.result || null) as LinkResult | null;
    const kept = this.saved.get(jobId);
    if (kept && Array.isArray(ev.copies)) kept.copies = ev.copies as LinkCopyOutcome[];
    if (ev.setup && typeof ev.setup === 'object' && this.linkWaits.has(jobId)) this.setups.set(jobId, setupOf(ev.setup));
    if (status === 'done' && result && result.change && result.change !== 'none' && !this.linkEnds.has(jobId)) {
      this.linkEnds.add(jobId);
      if (this.wantsGeometry) {
        this.push({ event: 'geometry', data: { geometryId: result.geometryId, rev: result.rev, fromRev: result.fromRev ?? null } });
      }
    }
    if (!wait) return;
    this.linkWaits.delete(jobId);
    this.linkJobs.delete(jobId);
    this.pinLinkStream();
    if (status === 'done' && result) wait.done(linkResultOf(result));
    else wait.fail(new BridgeError(String(ev.error || `The link ended ${status || 'without a result'}`), String(ev.code || status || 'failed')));
  }

  /** Files in this plugin's folder of the project; the app checks every path. */
  private async files(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.scope;
    const rel = String(params.rel || '');
    switch (method) {
      case 'files.stat':
        return this.stat(rel);
      case 'files.list': {
        const prefix = String(params.prefix || '');
        const r = await api<{ files: FileInfo[]; truncated?: boolean }>(`/api/plugin-files/list?${this.q({ plugin: s.plugin, prefix })}`);
        if (r.truncated) {
          throw new BridgeError(
            `more than ${r.files.length} files under ${prefix || "the plugin's folder"}: list a smaller folder`,
            'too_many',
          );
        }
        return r.files;
      }
      case 'files.read':
        return this.read(rel, params);
      case 'files.write.begin': {
        const { size, ifMatch } = params;
        if (!isCount(size)) throw badParam('size');
        if (ifMatch !== undefined && ifMatch !== null && typeof ifMatch !== 'string') throw badParam('ifMatch');
        const epoch = this.epoch;
        const r = await this.onFile(rel, () =>
          api<{ upload: string; chunk_bytes: number }>('/api/plugin-files/uploads', {
            body: { project_id: s.projectId, plugin: s.plugin, rel, size, ...(ifMatch !== undefined ? { if_match: ifMatch } : {}) },
          }),
        );
        if (epoch !== this.epoch) {
          this.dropUpload(r.upload);
          throw new BridgeError('the workspace closed', 'failed');
        }
        this.uploads.set(r.upload, { rel, size, chunkBytes: r.chunk_bytes, received: 0, busy: false });
        this.report();
        return { upload: r.upload, chunkBytes: r.chunk_bytes };
      }
      case 'files.write.chunk': {
        const [id, up] = this.ownUpload(params.upload);
        const { offset, data } = params;
        if (!(data instanceof ArrayBuffer) && !(data instanceof Blob)) throw badParam('data (an ArrayBuffer or a Blob)');
        if (!Number.isSafeInteger(offset)) throw badParam('offset');
        if (up.busy) throw new BridgeError('the last chunk of this upload is still on its way', 'busy');
        if (offset !== up.received) throw new BridgeError(`the next chunk starts at byte ${up.received}`, 'offset');
        const n = data instanceof Blob ? data.size : data.byteLength;
        const room = Math.min(up.chunkBytes, up.size - up.received);
        if (n > room) throw new BridgeError(`this chunk may hold at most ${room} bytes`, 'too_large');
        return this.onUpload(up, async () => {
          const r = await fetch(
            `/api/plugin-files/uploads/${encodeURIComponent(id)}?${this.q({ plugin: s.plugin, offset: String(up.received) })}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: data,
              cache: 'no-store',
            },
          );
          if (!r.ok) throw await refusal(r);
          const j = (await r.json()) as { received: number };
          up.received = j.received;
          return { received: j.received };
        });
      }
      case 'files.write.commit': {
        const [id, up] = this.ownUpload(params.upload);
        const sha = params.sha256;
        if (sha != null && !(typeof sha === 'string' && SHA256_HEX.test(sha))) throw badParam('sha256 (64 hex digits)');
        if (up.busy) throw new BridgeError('the last chunk of this upload is still on its way', 'busy');
        const r = await this.onUpload(up, () =>
          this.onFile(up.rel, () =>
            api<{ file: FileWriteResult }>(`/api/plugin-files/uploads/${encodeURIComponent(id)}/commit`, {
              body: { project_id: s.projectId, plugin: s.plugin, ...(typeof sha === 'string' ? { sha256: sha.toLowerCase() } : {}) },
            }),
          ),
        );
        this.uploads.delete(id);
        this.report();
        return r.file;
      }
      case 'files.write.abort': {
        const [id] = this.ownUpload(params.upload);
        this.uploads.delete(id);
        this.report();
        await api(`/api/plugin-files/uploads/${encodeURIComponent(id)}/abort`, { body: { project_id: s.projectId, plugin: s.plugin } });
        return { ok: true };
      }
      case 'files.delete': {
        const r = await this.onFile(rel, () =>
          api<{ deleted: number }>('/api/plugin-files/delete', {
            body: { project_id: s.projectId, plugin: s.plugin, rel, recursive: params.recursive === true },
          }),
        );
        return { deleted: r.deleted };
      }
      default:
        throw notAllowed(JSON.stringify(method));
    }
  }

  private async stat(rel: string): Promise<FileInfo | null> {
    const r = await api<{ file: FileInfo | null }>(`/api/plugin-files/stat?${this.q({ plugin: this.scope.plugin, rel })}`);
    return r.file ?? null;
  }

  /** A file's bytes (or a range of them) as a Blob, its whole size and its etag; null when it is not there. */
  private async read(rel: string, params: Record<string, unknown>): Promise<{ blob: Blob; size: number; etag: string } | null> {
    const { offset, length, ifMatch } = params;
    if (offset !== undefined && !isCount(offset)) throw badParam('offset');
    if (length !== undefined && !isCount(length)) throw badParam('length');
    if (ifMatch != null && typeof ifMatch !== 'string') throw badParam('ifMatch');
    const from = offset ?? 0;
    if (length === 0) {
      // No byte range asks for nothing: answer from the file's stat.
      const info = await this.stat(rel);
      if (!info) return null;
      if (typeof ifMatch === 'string' && ifMatch !== info.etag) throw new BridgeError(`${rel} changed since it was read`, 'changed');
      return { blob: new Blob([]), size: info.size, etag: info.etag };
    }
    const headers: Record<string, string> = {};
    if (length !== undefined) headers.Range = `bytes=${from}-${from + length - 1}`;
    else if (from > 0) headers.Range = `bytes=${from}-`;
    if (typeof ifMatch === 'string') headers['If-Match'] = ifMatch;
    const r = await fetch(`/api/plugin-files/read?${this.q({ plugin: this.scope.plugin, rel })}`, { headers, cache: 'no-store' });
    // No byte range fits an empty file: from its start, that is all of it (as without a range).
    if (r.status === 416 && from === 0 && r.headers.get('X-Magnusim-File-Size') === '0') {
      return { blob: new Blob([]), size: 0, etag: r.headers.get('ETag') || '' };
    }
    if (!r.ok) {
      const err = await refusal(r);
      if (err.code === 'not_found') return null;
      throw err;
    }
    const blob = await r.blob();
    const size = Number(r.headers.get('X-Magnusim-File-Size') ?? NaN);
    return { blob, size: Number.isFinite(size) ? size : blob.size, etag: r.headers.get('ETag') || '' };
  }

  private ownUpload(upload: unknown): [string, OpenUpload] {
    const id = typeof upload === 'string' ? upload : '';
    const up = this.uploads.get(id);
    if (!up) throw notAllowed('an upload this workspace did not begin');
    return [id, up];
  }

  /**
   * One call at a time per upload. A failed one keeps the upload listed until
   * the frame aborts it (or the channel ends), so that abort is not refused.
   */
  private async onUpload<T>(up: OpenUpload, run: () => Promise<T>): Promise<T> {
    up.busy = true;
    try {
      return await run();
    } finally {
      up.busy = false;
    }
  }

  /** A file call under this study's folder that finds the study gone tells the host (it closes the frame). */
  private async onFile<T>(rel: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'study_not_found' && this.underStudy(rel)) this.hooks.studyGone();
      throw err;
    }
  }

  private underStudy(rel: string): boolean {
    const parts = rel
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((p) => p.replace(/[ .]+$/, '').toLowerCase())
      .filter(Boolean);
    return parts.length >= 3 && parts[0] === 'studies' && parts[1] === this.scope.studyId.toLowerCase();
  }

  /** Abort an upload without waiting (keepalive: it still goes when the page is closing). */
  private dropUpload(id: string): void {
    void fetch(`/api/plugin-files/uploads/${encodeURIComponent(id)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: this.scope.projectId, plugin: this.scope.plugin }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => undefined);
  }

  /** Forward a job's events to the frame until it ends (one stream per job). */
  private follow(jobId: string): void {
    if (this.streams.has(jobId)) return;
    const es = openChannel(`/api/jobs/${encodeURIComponent(jobId)}/events?${this.q()}`);
    this.streams.set(jobId, es);
    es.addEventListener('event', (e) => {
      try {
        this.push({ event: 'job', jobId, data: JSON.parse((e as MessageEvent).data) });
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('end', (e) => {
      try {
        const rec = JSON.parse((e as MessageEvent).data) as { status?: string; error?: string | null };
        this.push({ event: 'job', jobId, data: { event: 'end', status: rec.status, error: rec.error ?? null } });
      } catch {
        this.push({ event: 'job', jobId, data: { event: 'end' } });
      }
      es.close();
      this.streams.delete(jobId);
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) this.streams.delete(jobId);
    };
  }

  /** This study's scope for the plugin-case routes. */
  private caseQuery(extra: Record<string, string> = {}): string {
    return this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId, ...extra });
  }

  /** A case of this study (not_found for any other). */
  private async caseStatus(jobId: string): Promise<ComputeJob> {
    const r = await api<{ job: ComputeJob }>(`/api/plugin-cases/status?${this.caseQuery({ job_id: jobId })}`);
    return r.job;
  }

  /**
   * Follow a case of this study: its events reach the frame from now on, after
   * one catch-up (queued, start and the live points, or end) from the stream's
   * snapshot or from its status, whichever comes first.
   */
  private async followCase(jobId: string): Promise<void> {
    const epoch = this.epoch;
    const known = this.cases.get(jobId);
    if (!known) this.cases.set(jobId, { seq: 0, endSent: false, held: [], started: false, lastT: null });
    this.openCaseStream();
    this.pinCaseStream();
    let job: ComputeJob;
    try {
      job = await this.caseStatus(jobId);
    } catch (err) {
      // Not a case of this study: it is not followed.
      const c = this.cases.get(jobId);
      if (!known && c && c.held) this.cases.delete(jobId);
      this.pinCaseStream();
      throw err;
    }
    if (epoch !== this.epoch) return;
    const c = this.cases.get(jobId);
    if (c && c.held) this.catchUp(jobId, c, job, null);
  }

  /**
   * A followed case that has not ended keeps the tab's event stream while the tab is hidden
   * (src/api/eventHub.ts lets an unpinned one go after a few seconds): every event of a
   * running case reaches the page, as a job's do (a plot of its residuals has no gap).
   */
  private pinCaseStream(): void {
    let live = false;
    for (const c of this.cases.values()) {
      if (!c.endSent) {
        live = true;
        break;
      }
    }
    this.caseStream?.pin(live);
  }

  /** One stream per channel for every followed case of this study. */
  private openCaseStream(): void {
    if (this.caseStream) return;
    const es = openChannel(`/api/plugin-cases/events?${this.caseQuery()}`);
    this.caseStream = es;
    es.addEventListener('snapshot', (e) => {
      try {
        this.onSnapshot(JSON.parse((e as MessageEvent).data));
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('case', (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as { job_id?: unknown; seq?: unknown; ev?: unknown };
        if (typeof m.job_id === 'string' && typeof m.seq === 'number' && m.ev && typeof m.ev === 'object') {
          this.onCaseEvent(m.job_id, m.seq, m.ev as JobEvent);
        }
      } catch {
        /* not JSON: skip */
      }
    });
    es.onerror = () => {
      // The browser reconnects by itself (and the next snapshot catches up); a closed stream is opened again by the next compute.events.
      if (es.readyState === EventSource.CLOSED && this.caseStream === es) this.caseStream = null;
    };
    this.pinCaseStream();
  }

  private onSnapshot(snap: { jobs?: ComputeJob[]; live?: { job_id?: string; points?: unknown[] } | null }): void {
    for (const job of Array.isArray(snap.jobs) ? snap.jobs : []) {
      const c = job && this.cases.get(job.id);
      if (!c) continue;
      if (c.held) {
        this.catchUp(job.id, c, job, snap.live || null);
        continue;
      }
      // Seen before (a reconnect, or the status caught it up first): what the frame has not
      // had. An end; for a case running now, its start (it heard it queued) and the live
      // points newer than the last it was given (the events meanwhile are not sent again).
      if (CASE_DONE.has(job.status)) {
        if (!c.endSent) {
          c.endSent = true;
          this.pushCase(job.id, { event: 'end', status: job.status, error: job.error ?? null, code: job.code ?? null, result: caseResult(job.result) });
        }
      } else if (job.status === 'running' && !c.endSent) {
        if (!c.started) this.pushCase(job.id, { event: 'start' });
        const live = snap.live && snap.live.job_id === job.id && Array.isArray(snap.live.points) ? snap.live.points : [];
        const last = c.lastT;
        const newer =
          last == null
            ? live
            : live.filter((p) => {
                const t = pointTime(p);
                return t != null && t > last;
              });
        if (newer.length) this.pushCase(job.id, { event: 'progress', points: newer });
      }
      c.seq = Math.max(c.seq, Number(job.seq) || 0);
    }
    this.pinCaseStream();
  }

  /** The frame's first view of a followed case, then the events that came meanwhile (newer ones only). */
  private catchUp(jobId: string, c: FollowedCase, job: ComputeJob, live: { job_id?: string; points?: unknown[] } | null): void {
    const held = c.held || [];
    c.held = null;
    c.seq = Number(job.seq) || 0;
    if (job.status === 'queued') this.pushCase(jobId, { event: 'queued', ahead: job.ahead });
    else if (job.status === 'running') {
      this.pushCase(jobId, { event: 'start' });
      if (live && live.job_id === jobId && Array.isArray(live.points) && live.points.length) {
        this.pushCase(jobId, { event: 'progress', points: live.points });
      }
    } else if (CASE_DONE.has(job.status)) {
      c.endSent = true;
      this.pushCase(jobId, { event: 'end', status: job.status, error: job.error ?? null, code: job.code ?? null, result: caseResult(job.result) });
    }
    for (const h of held.sort((a, b) => a.seq - b.seq)) this.onCaseEvent(jobId, h.seq, h.ev);
    this.pinCaseStream();
  }

  private onCaseEvent(jobId: string, seq: number, ev: JobEvent): void {
    const c = this.cases.get(jobId);
    if (!c) return;
    if (c.held) {
      c.held.push({ seq, ev });
      return;
    }
    if (seq <= c.seq) return;
    c.seq = seq;
    if (ev.event === 'end') {
      if (c.endSent) return;
      c.endSent = true;
      this.pushCase(jobId, { ...ev, result: caseResult(ev.result) });
      this.pinCaseStream();
      return;
    }
    this.pushCase(jobId, ev);
  }

  private pushCase(jobId: string, data: JobEvent): void {
    const c = this.cases.get(jobId);
    if (c && data.event === 'start') c.started = true;
    if (c && data.event === 'progress' && Array.isArray(data.points)) {
      for (const p of data.points) {
        const t = pointTime(p);
        if (t != null && (c.lastT == null || t > c.lastT)) c.lastT = t;
      }
    }
    this.push({ event: 'job', jobId, data });
  }

  /** Close every job stream, abort every open upload and forget unsaved work (the channel ended). */
  close(): void {
    // A leave whose page went away (a reload, a crash): the hook did not finish.
    const run = this.leave;
    this.leave = null;
    this.leaveHookOn = false;
    this.setInteractive(true);
    run?.done({ ok: false, message: 'its page closed before it finished' });
    // A tool call of the app's assistant ends `closed` first, then the page's tools go (1.9, unreleased):
    // a list still waiting for its verdict is abandoned, and the app hears null.
    // The same words as the server's when the page's answer misses its grace: it may have run.
    this.invoke?.cancel('closed', 'its page closed before the tool finished; it may or may not have finished');
    this.invoke = null;
    this.assistantTools = null;
    for (const pub of this.assistantWaiting) {
      try {
        pub.abandon?.();
      } catch (e) {
        this.hooks.log('assistant tools: abandon failed', e);
      }
    }
    this.assistantWaiting.clear();
    // Undo from the app's panel (1.9, unreleased): an undo asked for ends `closed`, and the offers go.
    this.undoWait?.done({ undone: false, reason: 'closed' });
    this.undoWait = null;
    for (const turn of [...this.undoOffers.keys()]) {
      this.undoOffers.delete(turn);
      this.tellUndo(turn, null);
    }
    this.toldTurns.clear();
    if (this.assistantOffered) {
      this.assistantOffered = false;
      try {
        void Promise.resolve(this.hooks.assistantTools?.(null)).catch(() => undefined);
      } catch (e) {
        this.hooks.log('assistant tools: withdrawing them failed', e);
      }
    }
    for (const es of this.streams.values()) es.close();
    this.streams.clear();
    this.linkStream?.close();
    this.linkStream = null;
    this.wantsGeometry = false;
    // A link the server accepted goes on (the next page sees it in linkedGeometry);
    // this page load no longer waits for it.
    for (const w of this.linkWaits.values()) {
      w.ask?.abort();
      w.fail(new BridgeError('the workspace closed', 'failed'));
    }
    this.linkWaits.clear();
    this.saved.clear();
    this.linkJobs.clear();
    this.caseStream?.close();
    this.caseStream = null;
    this.cases.clear();
    for (const ctl of this.sourceReads.values()) ctl.abort();
    this.sourceReads.clear();
    for (const id of this.uploads.keys()) this.dropUpload(id);
    this.uploads.clear();
    this.epoch++;
    this.frameDirty = false;
    this.frameMessage = '';
    this.report();
  }
}

/** The frame's data attribute (data-ws-hello) that says a bridge welcomed its page. */
const HELLO_SEEN = 'wsHello';

/** Connects one workspace frame to the host: handshake, channel, probe after each load. */
export class WorkspaceBridge {
  private readonly frame: HTMLIFrameElement;
  private readonly calls: WorkspaceCalls;
  private readonly hooks: BridgeHooks;
  // `welcomed` once the frame has its context and port (until then it has not connected);
  // `ended` aborts when the channel ends.
  /** `look`: the app's look the page has (the welcome's, then each one sent), as JSON. */
  private channel: { port: MessagePort; instance: string; welcomed: boolean; ended: AbortController; look: string } | null = null;
  private alive = '';
  /** Probes waiting for the page's answer. */
  private readonly aliveWaiters = new Set<(instance: string) => void>();
  private leaveSerial = 0;
  private undoSerial = 0;

  constructor(frame: HTMLIFrameElement, calls: WorkspaceCalls, hooks: BridgeHooks) {
    this.frame = frame;
    this.calls = calls;
    this.hooks = hooks;
  }

  attach(): () => void {
    window.addEventListener('message', this.onMessage);
    this.frame.addEventListener('load', this.onLoad);
    window.addEventListener('cfd:units', this.onUnits);
    window.addEventListener(ASSISTANT_KEYS_EVENT, this.onAssistantKeys);
    window.addEventListener(APPEARANCE_EVENT, this.onAppearance);
    const prefs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PREFS_CHANNEL);
    if (prefs) prefs.onmessage = (e: MessageEvent) => this.onPref(e.data);
    // A page that already said hello to an earlier bridge never says it again by itself.
    // That happens when the dev server hot-swaps the host's code under an open
    // workspace: the frame stays, the host's effects run again. The page loads again
    // and says hello to this bridge, instead of the host waiting 5 s for nothing.
    if (this.frame.dataset[HELLO_SEEN] === '1') {
      delete this.frame.dataset[HELLO_SEEN];
      const src = this.frame.getAttribute('src');
      if (src) this.frame.setAttribute('src', src);
    }
    return () => {
      window.removeEventListener('message', this.onMessage);
      this.frame.removeEventListener('load', this.onLoad);
      window.removeEventListener('cfd:units', this.onUnits);
      window.removeEventListener(ASSISTANT_KEYS_EVENT, this.onAssistantKeys);
      window.removeEventListener(APPEARANCE_EVENT, this.onAppearance);
      prefs?.close();
      this.closeChannel();
    };
  }

  /** Another tab, another bridge or Settings changed a pref of this page's plugin. */
  private onPref(data: unknown): void {
    const m = (data || {}) as { plugin?: unknown; key?: unknown; value?: unknown; from?: unknown };
    if (m.plugin !== this.calls.scope.plugin || typeof m.key !== 'string' || m.from === this.calls.prefsFrom) return;
    this.channel?.port.postMessage({ event: 'prefs', data: { key: m.key, value: m.value ?? null } });
  }

  connected(): boolean {
    return !!this.channel && this.channel.welcomed;
  }

  /**
   * Ends with the current channel (a new hello, a failed probe, detach): what
   * that page load asked for, a dialog of its own, is moot then. Null when there is none.
   */
  channelSignal(): AbortSignal | null {
    return this.channel ? this.channel.ended.signal : null;
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame.contentWindow) return;
    const data = event.data as { magnusim?: string; sdkVersion?: string; instance?: string } | null;
    if (!data || typeof data !== 'object') return;
    if (data.magnusim === 'hello') void this.hello(data);
    else if (data.magnusim === 'alive' && typeof data.instance === 'string') {
      this.alive = data.instance;
      for (const fn of [...this.aliveWaiters]) fn(data.instance);
    }
  };

  /** The page registered an exit hook and its channel is up (API 1.6). */
  hookOn(): boolean {
    return this.connected() && this.calls.leaveHookOn;
  }

  /** The name of the geometry this study links ('' before the first link), for the leave's question. */
  geometryName(): Promise<string> {
    return this.calls.geometryName();
  }

  /** That name as this page last heard it, at once. */
  lastGeometryName(): string {
    return this.calls.lastGeometryName();
  }

  /** Whether the page still answers (the leave's step 2): its `alive` within PROBE_MS. */
  probe(): Promise<boolean> {
    const ch = this.channel;
    const win = this.frame.contentWindow;
    if (!ch || !ch.welcomed || !win) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const fn = (instance: string) => {
        if (instance !== ch.instance) return;
        clearTimeout(timer);
        this.aliveWaiters.delete(fn);
        resolve(this.channel === ch);
      };
      const timer = setTimeout(() => {
        this.aliveWaiters.delete(fn);
        resolve(false);
      }, PROBE_MS);
      this.aliveWaiters.add(fn);
      win.postMessage({ magnusim: 'probe', instance: ch.instance }, '*');
    });
  }

  /**
   * What a stalled leave was waiting for (API 1.6, LINK 6.4): whether the page still
   * answers the probe, and whether a save of the page's through the app (a file commit,
   * a data write, the study's update) is still on its way, begun before the leave or in it.
   */
  async stallCause(): Promise<{ answers: boolean; saving: boolean }> {
    const saving = this.calls.savesInFlight() > 0;
    const answers = await this.probe();
    return { answers, saving: saving || this.calls.savesInFlight() > 0 };
  }

  /**
   * Run the page's exit hook for one leave (API 1.6): the event `leave`, then the page's
   * nav.leaveDone. Aborting `signal` sends `leaveAbort` and ends it; a page that goes away
   * meanwhile ends it as not done. What happens meanwhile goes to `activity`.
   */
  runLeave(reason: LeaveReason, o: { signal: AbortSignal; interactive: boolean; activity: (a: LeaveActivity) => void }): Promise<LeaveHookOutcome> {
    const ch = this.channel;
    if (!ch || !ch.welcomed || !this.calls.leaveHookOn) return Promise.resolve({ ok: true });
    const id = `leave-${++this.leaveSerial}`;
    return new Promise<LeaveHookOutcome>((resolve) => {
      let settled = false;
      const end = (out: LeaveHookOutcome) => {
        if (settled) return;
        settled = true;
        o.signal.removeEventListener('abort', onAbort);
        this.calls.endLeave(id);
        resolve(out);
      };
      const onAbort = () => {
        try {
          ch.port.postMessage({ event: 'leaveAbort', data: { leave: id } });
        } catch {
          /* the channel is gone */
        }
        end({ ok: false, message: 'cancelled' });
      };
      if (o.signal.aborted) {
        end({ ok: false, message: 'cancelled' });
        return;
      }
      o.signal.addEventListener('abort', onAbort);
      this.calls.beginLeave({ id, activity: o.activity, interactive: o.interactive, done: end });
      ch.port.postMessage({ event: 'leave', data: { leave: id, reason } });
    });
  }

  /**
   * Run one call of the page's tool for the app's assistant (1.9, unreleased): the event
   * `assistantInvoke`, then the page's assistant.result. Refused at once with `closed` (no page),
   * `leaving` (its exit hook runs), `busy` (the frame is covered, or a call runs: one at a time),
   * `no_tool` (no such tool accepted) or `aborted`. It fails `stalled` after `timeoutS` with no
   * progress and no call of the page in flight (no total limit while progress comes); while one
   * is in flight the caller hears `onAlive` (as it starts and ends, and every ASSISTANT_ALIVE_MS).
   * Aborting `signal` sends `assistantAbort` and waits ASSISTANT_ABORT_WAIT_MS for the page's
   * result (a result that came means it finished), else ends `aborted`. A call that ran ends as
   * `stalled`, `leaving` or `closed` saying it may or may not have finished. While it runs the
   * page may read files attached in its conversation through `req.attachment`
   * (assistant.attachment), each read a call in flight; the reads stop when it ends.
   */
  invokeTool(req: AssistantInvoke): Promise<AssistantCallOutcome> {
    const refuse = (code: string, message: string) => Promise.resolve<AssistantCallOutcome>({ ok: false, code, message });
    const ch = this.channel;
    if (!ch || !ch.welcomed) return refuse('closed', 'its page is not open');
    if (this.calls.leaving()) return refuse('leaving', 'its page is closing: the user is leaving the workspace');
    if (this.frame.inert || this.calls.invoking()) return refuse('busy', 'the workspace is busy with another call or a question; try again in a moment');
    const tool = this.calls.assistantTool(String(req.tool));
    if (!tool) return refuse('no_tool', `the workspace has no tool named ${JSON.stringify(String(req.tool))}`);
    if (req.signal.aborted) return refuse('aborted', 'it was stopped before it started');
    const stallS = assistantTimeoutS(req.timeoutS, tool.timeoutS);
    return new Promise<AssistantCallOutcome>((resolve) => {
      let settled = false;
      let stopping = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let aliveTimer: ReturnType<typeof setTimeout> | undefined;
      const tell = (event: string, data: Record<string, unknown>): boolean => {
        try {
          ch.port.postMessage({ event, data });
          return true;
        } catch (e) {
          this.hooks.log('assistant call: the page could not be told', e);
          return false;
        }
      };
      const stopped = (): AssistantCallOutcome => ({ ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' });
      const end = (out: AssistantCallOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        clearTimeout(stopTimer);
        clearTimeout(aliveTimer);
        req.signal.removeEventListener('abort', onAbort);
        inv.reads.abort();
        this.calls.endInvoke(inv.id);
        resolve(out);
      };
      // The stall window restarts with each sign of life, and waits while a call of the page is in flight.
      const arm = () => {
        clearTimeout(stallTimer);
        stallTimer = undefined;
        if (settled || stopping || inv.inFlight > 0) return;
        stallTimer = setTimeout(() => {
          const hint = typeof document !== 'undefined' && document.hidden ? ' (its tab is in the background)' : '';
          tell('assistantAbort', { call: inv.id });
          end({ ok: false, code: 'stalled', message: `it sent no progress for ${stallS} s and was stopped${hint}; it may or may not have finished` });
        }, stallS * 1000);
      };
      // A call of the page in flight holds the window above, and the caller's own (the server's):
      // it hears the call is alive as one starts or ends, and every ASSISTANT_ALIVE_MS meanwhile.
      const alive = () => {
        if (settled || stopping) return;
        try {
          req.onAlive?.();
        } catch (e) {
          this.hooks.log('assistant call: alive listener failed', e);
        }
      };
      const keepAlive = () => {
        clearTimeout(aliveTimer);
        aliveTimer = undefined;
        if (settled || stopping || inv.inFlight === 0) return;
        aliveTimer = setTimeout(() => {
          alive();
          keepAlive();
        }, ASSISTANT_ALIVE_MS);
      };
      const onAbort = () => {
        if (settled || stopping) return;
        stopping = true;
        clearTimeout(stallTimer);
        clearTimeout(aliveTimer);
        tell('assistantAbort', { call: inv.id });
        stopTimer = setTimeout(() => end(stopped()), ASSISTANT_ABORT_WAIT_MS);
      };
      const readAttachment = req.attachment;
      const inv = this.calls.beginInvoke({
        activity: (a) => {
          if (settled) return;
          if (a.kind === 'progress' && !stopping) {
            try {
              if (a.waiting) req.onProgress(a.fraction, a.label, { waiting: true });
              else req.onProgress(a.fraction, a.label);
            } catch (e) {
              this.hooks.log('assistant call: progress listener failed', e);
            }
          }
          if (a.kind === 'calls') {
            alive();
            keepAlive();
          }
          arm();
        },
        // Once stopped, only a finished result counts: anything else is the stop.
        done: (out) => end(stopping && !out.ok ? stopped() : out),
        cancel: (code, message) => {
          if (settled) return;
          tell('assistantAbort', { call: inv.id });
          end(stopping ? stopped() : { ok: false, code, message });
        },
        attachment: readAttachment ? (id, signal) => readAttachment.call(req, id, signal) : null,
        reads: new AbortController(),
      });
      req.signal.addEventListener('abort', onAbort);
      const place =
        typeof req.step === 'number' && typeof req.callsLeftInStep === 'number' && typeof req.editsLeftInStep === 'number'
          ? { step: req.step, calls_left_in_step: req.callsLeftInStep, edits_left_in_step: req.editsLeftInStep }
          : {};
      if (!tell('assistantInvoke', { call: inv.id, turn: String(req.turn ?? ''), tool: tool.name, input: req.input, ...place })) {
        end({ ok: false, code: 'closed', message: 'its page could not be reached' });
        return;
      }
      arm();
    });
  }

  private async hello(data: { sdkVersion?: string; instance?: string }): Promise<void> {
    const major = Number(String(data.sdkVersion || '').split('.')[0]);
    if (major !== HOST_SDK_MAJOR || typeof data.instance !== 'string' || !data.instance) {
      this.hooks.log('workspace hello refused (SDK version)', data);
      return;
    }
    this.closeChannel();
    const mc = new MessageChannel();
    const instance = data.instance;
    const channel = { port: mc.port1, instance, welcomed: false, ended: new AbortController(), look: '' };
    this.channel = channel;
    mc.port1.onmessage = (e) => void this.request(mc.port1, e.data);
    this.calls.setPush((msg) => mc.port1.postMessage(msg));
    let context: WorkspaceContext;
    try {
      context = await this.calls.context();
    } catch (err) {
      this.hooks.log('workspace context failed', err);
      this.closeChannel();
      return;
    }
    const win = this.frame.contentWindow;
    if (!win || this.channel !== channel) return;
    // The look as it is now, with no await before the welcome goes: a change heard while the context
    // was read is in it (none is sent before the welcome), and each later one goes once.
    const look = this.hooks.appearance?.();
    if (look) {
      context = { ...context, appearance: look };
      channel.look = JSON.stringify(look);
    }
    // The frame's origin is opaque, so no target origin names it; only this window gets the port.
    win.postMessage({ magnusim: 'welcome', instance, context }, '*', [mc.port2]);
    channel.welcomed = true;
    // On the element, not in this module: a hot swap of this module keeps the frame.
    this.frame.dataset[HELLO_SEEN] = '1';
    this.hooks.connected();
  }

  private async request(port: MessagePort, msg: unknown): Promise<void> {
    const m = (msg || {}) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof m.id !== 'number') return;
    const method = String(m.method || '');
    const params = m.params && typeof m.params === 'object' ? (m.params as Record<string, unknown>) : {};
    // Calls in flight count as work for a running leave's stall timer.
    const answered = this.calls.callStart(method);
    try {
      port.postMessage({ id: m.id, result: await this.calls.handle(method, params) });
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err));
      if (e.code === 'not_allowed') this.hooks.log(`workspace ${this.calls.scope.plugin}: ${e.message}`, params);
      port.postMessage({ id: m.id, error: { message: e.message, code: e.code, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) } });
    } finally {
      answered();
    }
  }

  private onLoad = (): void => {
    const current = this.channel;
    // Not welcomed yet: this load is the document that just said hello (its load event can
    // come a moment after its hello), and the SDK answers probes only once it is welcomed.
    // A real reload sends a new hello, which replaces the channel.
    if (!current || !current.welcomed) return;
    this.alive = '';
    this.frame.contentWindow?.postMessage({ magnusim: 'probe', instance: current.instance }, '*');
    setTimeout(() => {
      if (this.channel === current && this.alive !== current.instance) this.closeChannel();
    }, PROBE_MS);
  };

  /**
   * A turn of the app's assistant bound to this tab started, changed or ended (1.9, unreleased):
   * the page hears it as the event `assistantTurn` (nothing while its page is not connected).
   */
  assistantTurn(turn: AssistantTurn): void {
    const ch = this.channel;
    if (!ch || !ch.welcomed) return;
    try {
      ch.port.postMessage({ event: 'assistantTurn', data: turn });
    } catch (e) {
      this.hooks.log('assistant turn: the page could not be told', e);
      return;
    }
    this.calls.noteTurn(turn);
  }

  /**
   * The app's Assistant panel asks the page to undo a turn's changes (1.9, unreleased): the event
   * `assistantUndo {req, turn}`, then the page's assistant.undone. Refused at once, with nothing
   * sent, when there is no page (`closed`) or calls.undoRefusal says why (`not_offered`, `leaving`,
   * `busy`), and `busy` while the frame is covered (the app's dialog over it: the page may be in
   * the middle of something); `no_answer` after ASSISTANT_UNDO_WAIT_MS, `closed` when the channel
   * ends first.
   */
  assistantUndo(turn: string): Promise<AssistantUndoAnswer> {
    const ch = this.channel;
    if (!ch || !ch.welcomed) return Promise.resolve({ undone: false, reason: 'closed' });
    const id = String(turn);
    const why = this.calls.undoRefusal(id) ?? (this.frame.inert ? 'busy' : null);
    if (why) return Promise.resolve({ undone: false, reason: why });
    const req = `undo-${++this.undoSerial}`;
    const answer = this.calls.beginUndo(req, id);
    try {
      ch.port.postMessage({ event: 'assistantUndo', data: { req, turn: id } });
    } catch (e) {
      this.hooks.log('assistant undo: the page could not be told', e);
      this.calls.endUndo(req, { undone: false, reason: 'closed' });
    }
    return answer;
  }

  /**
   * The study as the host now has it (a rename in the header, a save): the frame
   * keeps saving with its current rev instead of being refused as stale.
   */
  pushStudy(study: StudyRecord): void {
    this.channel?.port.postMessage({ event: 'study', data: study });
  }

  private onUnits = (): void => {
    this.channel?.port.postMessage({ event: 'units', data: this.hooks.units() });
  };

  private onAssistantKeys = (): void => {
    if (!this.hooks.assistantKeys) return;
    this.channel?.port.postMessage({ event: 'assistantKeys', data: this.hooks.assistantKeys() });
  };

  /** The app's look changed (or was shown again): the page hears it once per look, after its welcome (which has the look then). */
  private onAppearance = (): void => {
    const channel = this.channel;
    const look = channel?.welcomed && this.hooks.appearance?.();
    if (!channel || !look) return;
    const text = JSON.stringify(look);
    if (text === channel.look) return;
    channel.look = text;
    channel.port.postMessage({ event: 'appearance', data: look });
  };

  /** End the channel (a new hello, a failed probe, detach): its streams and uploads go, and a dirty page is clean again. */
  private closeChannel(): void {
    const channel = this.channel;
    if (!channel) return;
    try {
      channel.port.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.calls.close();
    channel.ended.abort();
  }
}
