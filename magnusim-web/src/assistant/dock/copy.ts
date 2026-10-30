/**
 * The dock's words (phase 4 spec 2, 4.5, 10.1), one export each; copy.test.ts pins them. None
 * names a provider or an agent: their names and labels reach these only as the server's data
 * (`providers_ready[id].label`, `TurnSummary.agent.name`). The server's own messages (a turn's
 * end, a refusal) are shown as they come and never rewritten here.
 */
import { REMOTE_TEXT } from '../api';
import type { TurnEvent } from '../wire';

type EndState = 'done' | 'stopped' | 'failed' | 'capped';
type RoomReason = 'messages' | 'images' | 'bytes' | 'context';
type Risk = 'read' | 'edit' | 'compute' | 'destructive';
type Billing = 'usd' | 'free' | 'agent_account';

// ---------------------------------------------------------------- header and conversations (2.1, 2.2)

export const DOCK_TITLE = 'Assistant';
export const NEW_CONVERSATION = 'New conversation';
export const ASSISTANT_SETTINGS = 'Assistant settings';
export const CLOSE_DOCK = 'Close the Assistant';
export const GROUP_HERE = 'Here';
export const GROUP_HOME = 'Home';
export const GROUP_OTHER_PROJECTS = 'Other projects';
export const CONVERSATIONS_EMPTY = 'No conversations yet. Magnusim keeps them while it runs; History keeps what they said for 31 days.';
export const FORGET = 'Forget';
export const forgetLabel = (title: string): string => `Forget ${title}`;
export const FORGET_TITLE = 'Forget this conversation?';
export const FORGET_COPY = "The Assistant forgets its messages; this can't be undone. Its saved copy stays in History, and what it changed in your projects stays.";
export const FORGET_KEEP = 'Keep';
export const FORGET_BUSY = 'A request is running in this conversation. Stop it first.';
/** A conversation row's second line: its provider and the time it was last used. */
export const conversationMeta = (label: string, hhmm: string): string => `${label} · ${hhmm}`;
export const readOnlyConversation = (projectTitle: string): string =>
  `This conversation is about project "${projectTitle}". Open that project to continue it, or start a new conversation here.`;
export const OPEN_PROJECT = 'Open project';

// ---------------------------------------------------------------- History: the saved chats (31 days)

export const HISTORY = 'History';
export const CLEAR_HISTORY = 'Clear history';
export const BACK = 'Back';
/** Over the History list: whose chats, and how long they are kept. */
export const historyOf = (home: boolean): string => (home ? 'Chats saved on Home, newest first. Kept 31 days.' : 'Chats saved in this project, newest first. Kept 31 days.');
export const HISTORY_EMPTY = 'No saved chats here in the last 31 days.';
export const HISTORY_LOADING = 'Loading the saved chats…';
export const historyMore = (n: number): string => `${n} older ${n === 1 ? 'chat is' : 'chats are'} saved but not listed.`;
/** A saved chat's day and time as History shows it: "29 Oct, 09:41". */
export const dayTime = (iso: string): string => {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${t.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getMonth()]}, ${two(t.getHours())}:${two(t.getMinutes())}`;
};
export const clearHistoryTitle = (home: boolean): string => (home ? "Clear Home's chat history?" : "Clear this project's chat history?");
export const CLEAR_HISTORY_COPY = "Magnusim deletes the chats it saved here; this can't be undone. Conversations still open stay, and what the Assistant changed in your projects stays.";
export const CLEAR_HISTORY_KEEP = 'Keep';
export const clearedChats = (n: number): string => (n ? `Cleared ${n} saved ${n === 1 ? 'chat' : 'chats'}.` : 'There were no saved chats to clear.');
/** Under a saved chat, in place of the composer. */
export const savedLine = (when: string, carry: boolean): string =>
  carry ? `A saved chat, last used ${when}. It is read only: Continue in a new chat takes up where it ended.` : `A saved chat, last used ${when}. It is read only.`;
export const SAVED_LOADING = 'Loading the saved chat…';
export const SHOW_MORE = 'Show more';
export const savedPictures = (n: number): string => `${n} ${n === 1 ? 'picture' : 'pictures'} sent (not saved)`;
/** A saved tool step: its title, and its result's line, or how it failed. */
export const savedStep = (ok: boolean | null, title: string, line: string, code: string | null): string =>
  ok === null ? `… ${title}: no answer` : ok ? `✓ ${title}${line ? `: ${line}` : ''}` : `✗ ${title}${line ? `: ${line}` : ''}${code ? ` (${code})` : ''}`;
export const stepsLeftOut = (n: number): string => `${n} more ${n === 1 ? 'step' : 'steps'} not saved`;
export const SAVED_CUT = 'Cut to fit what History keeps of one request.';

// ---------------------------------------------------------------- the person's message (2.4)

export const FROM_PROGRAM = 'From the command line or another program';
export const NEW_SHORT = 'New';
export const CONVERSATIONS_LABEL = 'Conversations';
export const WORKING_DOT = 'working';
/** A time of day as the conversation rows show it: "09:41". */
export const hhmm = (iso: string): string => {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(t.getHours())}:${two(t.getMinutes())}`;
};
export const yourPictureAlt = (i: number, n: number): string => `Your picture ${i} of ${n}`;

// ---------------------------------------------------------------- the transcript (5.4, 4.7, 10.4)

export const SHOW_EARLIER = 'Show earlier requests';
export const NEW_MESSAGES = 'New messages ↓';
export const ELSEWHERE = 'Elsewhere';
export const PICTURE_VIEWER = 'Picture viewer';
/** A result's Download link (spec 06 §8.6): the person saves the file; the Assistant never does. */
export const DOWNLOAD_TITLE = 'Save the file on this PC';
export const CLOSE_PICTURE = 'Close the picture';
export const PREVIOUS_PICTURE = 'Previous picture';
export const NEXT_PICTURE = 'Next picture';

// ---------------------------------------------------------------- the intro of an empty conversation (7)

export const INTRO_HOME =
  "Ask about your projects, or tell the Assistant what to simulate: it can make a project, import a geometry you attach, set up a study, mesh it and run it. It asks before anything that computes or can't be undone.";
export const INTRO_PROJECT =
  'Tell the Assistant what to set up or run in this project (studies, materials, boundary conditions, meshes, runs), or ask about its results. Open a CAD Part to have it build or change one.';
export const introCad = (workspace: string): string =>
  `Tell the Assistant what to model in ${workspace}. You can watch each step, pause or take over in the Part, and stop it here.`;
export const introWorkspace = (workspace: string): string => `Tell the Assistant what to do in ${workspace}.`;

// ---------------------------------------------------------------- the provider picker (2.3)

export const PROVIDER = 'Provider';
export const providerDefault = (label: string): string => `${label} · default`;
export const providerAgent = (label: string): string => `${label} (coding agent)`;
export const notReady = (line: string): string => (line ? `${line} · not ready` : 'not ready');
const BILLING_TAGS: Record<'usd' | 'free', string> = { usd: 'API key, $ limits apply', free: 'No cost' };
export const billingTag = (billing: Billing, name: string): string => (billing === 'agent_account' ? `Billed to your ${name} account` : BILLING_TAGS[billing]);
const AGENT_REASONS: Record<string, string> = {
  agent_not_allowed: 'Off until you allow it in Settings → Assistant',
  agent_missing: 'Not installed',
  agent_allow_changed: 'Its command changed: allow it again',
  agent_signed_out: 'Not signed in',
  mcp_unavailable: "Its tool connection isn't running",
  not_checked: 'Not looked for yet: open Settings → Assistant',
};
/** A coding agent's reason for not being ready, as the person reads it (null for a code it doesn't know). */
export const agentReason = (code: string | null): string | null => (code && Object.hasOwn(AGENT_REASONS, code) ? AGENT_REASONS[code] : null);
export const PROVIDER_LOCKED = 'A conversation keeps its provider. Start a new one to use another.';
export const SET_UP_PROVIDERS = 'Set up providers in Settings → Assistant';

// ---------------------------------------------------------------- the composer (3)

export const MESSAGE_LABEL = 'Message to the Assistant';
export const placeholderWorkspace = (workspace: string): string => `Tell the Assistant what to do in ${workspace}…`;
export const PLACEHOLDER_PROJECT = 'Ask about this project…';
export const PLACEHOLDER_HOME = 'Ask the Assistant…';
export const COMPOSER_HINT = 'Enter sends · Shift+Enter for a new line';
export const charCount = (n: number): string => `${n.toLocaleString('en-US')} of 20,000 characters`;
export const SEND = 'Send';
export const WORKING_ON_IT = 'The Assistant is working on your last message.';
export const providerNotReady = (label: string, detail: string): string => `${label}: ${detail}. Settings → Assistant can fix it.`;
export const tabBusy = (workspace: string): string => `A request is already working in ${workspace}. Wait for it, or stop it.`;
export const STOP_THAT_REQUEST = 'Stop that request';
/** A full conversation whose row names no limit (an older server); the server's own words otherwise (full_text). */
export const CONVERSATION_FULL = 'This conversation is full. Start a new one.';
/** A full conversation's second way on: a new one that carries what this one did (carry_from). */
export const CONTINUE_IN_NEW_CHAT = 'Continue in a new chat';
/** Over the box of a new conversation that continues an earlier one: what goes with its first message. */
export const CARRY_LINE = 'Continuing the earlier chat: your earlier prompts, its last answer and how it ended go with this message.';
// Pictures (3.2) and files (core host tools spec 13.1). A line that names what can be attached
// names drawings only while the dock offers them (drawings.ts): the caller says which.
export const ATTACH_LABEL = 'Attach pictures or files';
export const ATTACH = 'Attach';
export const dropPictures = (drawings: boolean): string => (drawings ? 'Drop pictures, geometry files or drawings to attach' : 'Drop pictures or geometry files to attach');
export const ONLY_IMAGES = 'Only PNG, JPEG and WebP pictures can be attached.';
export const shrunkTo = (w: number, h: number): string => `Shrunk to ${w} × ${h} px to fit`;
export const tooLargeAfterShrinking = (name: string): string => `${name} is larger than 1.5 MB even after shrinking it.`;
export const pictureChip = (name: string, w: number, h: number): string => `${name} · ${w} × ${h}`;
export const removePicture = (name: string): string => `Remove ${name}`;
export const AT_MOST_FOUR = 'At most 4 pictures per message.';
export const PICTURES_GO = 'Pictures go to the provider with your message.';
/** A coding agent's conversation: the agent gets them, and its own service under the person's account. */
export const picturesGoToAgent = (name: string): string => `Pictures go to ${name} with your message, and on to its own service.`;
export const noPictures = (name: string): string => `${name} doesn't take pictures. Send the message without them.`;
/** A coding agent that said it takes no pictures: files (drawings among them while the dock offers them), not pictures. */
export const attachFilesOnly = (name: string, drawings: boolean): string =>
  drawings ? `Attach geometry files or drawings (${name} doesn't take pictures)` : `Attach geometry files (${name} doesn't take pictures)`;
export const dropFiles = (drawings: boolean): string => (drawings ? 'Drop geometry files or drawings to attach' : 'Drop geometry files to attach');
/** Any other file, refused before anything is sent: the kinds the dock takes. */
export const onlyFiles = (drawings: boolean): string =>
  drawings ? 'Only pictures, geometry files (STEP, IGES, BREP, STL, OBJ, PLY) and drawings (SVG, DXF) can be attached.' : 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.';
export const fileTooLarge = (name: string): string => `${name} is larger than 500 MB. Import it with + Add geometry.`;
export const drawingTooLarge = (name: string): string => `${name} is larger than 20 MB, the limit for a drawing.`;
export const AT_MOST_FOUR_FILES = 'At most 4 files per message.';
/** "4.2 MB", "12 KB", "512 bytes" (1024-based, as the server's line to the model). */
export function fileSize(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
export const fileChip = (name: string, bytes: number): string => `${name} · ${fileSize(bytes)}`;
/** The person's message's files in the transcript (their list's name). */
export const ATTACHED_FILES = 'Attached files';
export const FILES_STAY = 'Files stay on this PC. The Assistant gets their names and can import them into the project open here. A workspace tool may read one, and what it reports goes to the provider.';
/** The same, with a drawing among them (so only while the dock offers drawings): import_file never takes one. */
export const DRAWINGS_STAY = 'Files stay on this PC. The Assistant gets their names. It can import geometry files into the project open here, and drawings in a workspace that imports them. A workspace tool may read one, and what it reports goes to the provider.';
export const uploadingLabel = (name: string): string => `Uploading ${name}`;
export const waitingForUpload = (name: string): string => `Waiting for ${name} to finish uploading…`;
export const uploadLost = (name: string): string => `${name} didn't reach Magnusim's server. Attach it again.`;
// Context (3.3).
export const CONTEXT_HOME = 'Home · no project';
export const contextProject = (title: string): string => `Project: ${title}`;
export const contextWorkspace = (workspace: string, project: string): string => `${workspace} in ${project}`;
export const contextConnecting = (workspace: string): string => `${workspace} · connecting…`;
export const waitingForTools = (workspace: string): string => `Waiting for ${workspace} to offer its tools…`;
export const contextLate = (workspace: string): string => `${workspace} offers no tools now · the Assistant can read the project only`;
export const contextNoTools = (workspace: string, project: string): string => `${workspace} offers no tools · Project: ${project}`;

// ---------------------------------------------------------------- tool steps (2.6)

const RISK_BADGES: Record<Risk, string> = { read: 'Reads', edit: 'Changes', compute: 'Runs a computation', destructive: "Can't be undone" };
export const riskBadge = (risk: Risk): string => RISK_BADGES[risk];
export const WHAT_IT_SENT = 'What it sent';
/** A call's milliseconds as the step shows them: "0.8 s", "12 s", "2 min 5 s". */
export const seconds = (ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
};
export const resultOk = (summary: string, ms: number): string => `✓ ${summary} · ${seconds(ms)}`;
export const resultFailed = (summary: string): string => `✗ ${summary}`;
export const howToFix = (hint: string): string => `How to fix: ${hint}`;
/** A call that waits for the person: in a workspace, said so; on Home or in the workbench (a core page tool), its own words. */
export const waitsFor = (workspace: string, label: string): string => (workspace ? `Waits for you in ${workspace}: ${label}` : label || 'Waits for you');
export const pictureAlt = (i: number, n: number, title: string): string => `Picture ${i} of ${n} from ${title}`;
export const PICTURE_GONE = 'Picture no longer kept';

/** What a call changed, as the step's "Updated" line names each kind (phase 5, C2). */
const UPDATED_KINDS: Record<string, { label: string; record: string }> = {
  project: { label: 'Project', record: 'project' },
  geometry: { label: 'Geometry', record: 'geometry' },
  study: { label: 'Study', record: 'study' },
  materials: { label: 'Materials', record: 'material' },
  bcs: { label: 'Boundary conditions', record: 'bc' },
  bc_defaults: { label: 'Boundary condition defaults', record: '' },
  mesh: { label: 'Mesh', record: 'mesh' },
  refinements: { label: 'Mesh refinements', record: 'refinement' },
  runs: { label: 'Runs', record: 'run' },
  plugin_studies: { label: 'Studies', record: 'plugin_study' },
};

/**
 * "Updated: Boundary conditions (Inlet); Mesh (Mesh 1)": each kind a call changed, with the
 * names of its records when the call gave them. `active` and `tree` are how the window follows,
 * not something changed: they are left out. Empty when nothing is left to name.
 */
export const updatedLine = (kinds: readonly string[], ids: Record<string, readonly string[]>, names: Record<string, string>): string => {
  const parts: string[] = [];
  for (const kind of kinds) {
    const k = Object.hasOwn(UPDATED_KINDS, kind) ? UPDATED_KINDS[kind] : null;
    if (!k) continue;
    const named = (k.record && ids[k.record] ? ids[k.record] : []).map((id) => names[id]).filter((n): n is string => !!n);
    parts.push(named.length ? `${k.label} (${[...new Set(named)].join(', ')})` : k.label);
  }
  return parts.length ? `Updated: ${parts.join('; ')}` : '';
};

// ---------------------------------------------------------------- a coding agent's events (2.7)

export const agentLine = (name: string, version: string | null, ownTools: 'off' | 'on'): string =>
  `${version ? `${name} ${version}` : name}${
    ownTools === 'off' ? ' · its own tools are off' : ' · its own tools are on: it can run commands and change files on this PC by its own rules.'
  }`;
export const PLAN_HEADING = 'Its plan';
export const OWN_TOOLS_HEADING = 'Its own tools';
export const agentToolLine = (title: string, kind: string): string => (kind ? `${title} · ${kind}` : title);

type Permission = Extract<TurnEvent, { type: 'agent_permission' }>;
export const agentPermissionLine = (title: string, outcome: Permission['outcome'], by: Permission['by']): string => {
  if (outcome === 'auto_allowed') return `Auto-allowed: ${title}. Magnusim asks you itself when one of its tools needs it.`;
  if (outcome === 'cancelled') return `Withdrawn: ${title}`;
  if (by === 'timeout') return `Not answered in time, so declined: ${title}`;
  if (outcome === 'allowed') return `You allowed: ${title}`;
  return by === 'user' ? `You declined: ${title}` : `Declined: ${title}`;
};
export const agentModeLine = (label: string): string => `Mode: ${label}`;
export const agentModelLine = (label: string): string => `Model: ${label}`;

// ---------------------------------------------------------------- review rounds, notes, fallback (2.8)

export const reviewDivider = (round: number, of: number): string => `Checking its work · round ${round} of ${of}`;
export const fallbackLine = (from: string, to: string): string => `Answered by ${to} after ${from} declined the request.`;

// ---------------------------------------------------------------- the running footer (2.9)

export const FOOTER_STARTING = 'Starting…';
export const FOOTER_ANSWER_BELOW = 'Waiting for your answer below.';
export const FOOTER_THINKING = 'Thinking…';
export const agentWorking = (name: string): string => `${name} is working…`;
export const reviewFooter = (round: number, of: number): string => `Checking its work (round ${round} of ${of})…`;
export const working = (title: string, label?: string | null): string => (label ? `Working: ${title} · ${label}` : `Working: ${title}`);
export const FOOTER_STOPPING = 'Stopping…';
export const FOOTER_STILL_STOPPING = 'Still stopping…';

// ---------------------------------------------------------------- counters and the spend meter (2.9)

const minutes = (ms: number): number => Math.floor(Math.max(0, ms) / 60000);
const usd = (n: number): string => `$${n.toFixed(2)}`;
/** API key or local server: "<steps> of <cap> steps · <min> of <cap> min". */
export const stepCounters = (steps: number, stepsCap: number, activeMs: number, minutesCap: number): string =>
  `${steps} of ${stepsCap} steps · ${minutes(activeMs)} of ${minutesCap} min`;
/** A coding agent: changes, tool calls and minutes. */
export const agentCounters = (changes: number, changesCap: number, calls: number, callsCap: number, activeMs: number, minutesCap: number): string =>
  `${changes} of ${changesCap} changes · ${calls} of ${callsCap} tool calls · ${minutes(activeMs)} of ${minutesCap} min`;
export const meterUsd = (turnUsd: number, turnCap: number, estimated: boolean, dayUsd: number, dayCap: number): string =>
  `This request: ${estimated ? 'about ' : ''}${usd(turnUsd)} of ${usd(turnCap)} · Today: ${usd(dayUsd)} of ${usd(dayCap)}`;
/** From 80% of today's limit: what was spent, and what spends less (no price is compared). */
export const dayNear = (dayUsd: number, dayCap: number): string => `Today: ${usd(dayUsd)} of ${usd(dayCap)}. A cheaper model or a lower Effort costs less.`;
const grouped = (n: number): string => Math.round(n).toLocaleString('en-US');
const megabytes = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return String(mb < 10 ? Math.floor(mb * 10) / 10 : Math.floor(mb));
};
const ROOM_NUMBERS: Record<RoomReason, (used: number, limit: number) => string> = {
  messages: (u, l) => `messages ${grouped(u)} of ${grouped(l)}`,
  images: (u, l) => `pictures ${grouped(u)} of ${grouped(l)}`,
  bytes: (u, l) => `results and pictures ${megabytes(u)} of ${megabytes(l)} MB`,
  context: (u, l) => `context ${grouped(u)} of ${grouped(l)} tokens`,
};
/**
 * How full the conversation is, by the limit it is closest to: "Conversation: 72% full (pictures 72
 * of 100)". `perTurn`: the context's limit is what that much per turn can resend once the cache expires.
 */
export const roomLine = (reason: RoomReason, used: number, limit: number, perTurn?: number): string =>
  `Conversation: ${Math.min(100, Math.floor((Math.max(0, used) / Math.max(1, limit)) * 100))}% full (${
    reason === 'context' && perTurn !== undefined ? `context ${grouped(used)} of the ${grouped(limit)} tokens ${usd(perTurn)} per turn can resend` : ROOM_NUMBERS[reason](used, limit)
  })`;
/** A coding agent's chat: how much of its own context it uses (it shortens its memory itself when it fills). */
export const agentContextLine = (used: number, size: number): string =>
  `Context: ${grouped(used)} of ${grouped(size)} tokens (${Math.min(100, Math.floor((Math.max(0, used) / Math.max(1, size)) * 100))}%)`;
export const METER_FREE = 'Local server · no cost';
export const meterAgent = (name: string): string => `Billed to your ${name} account (Magnusim can't see the cost)`;

// ---------------------------------------------------------------- the pill (2.9)

export const pillRunning = (footer: string, counters: string): string => (counters ? `Assistant · ${footer} · ${counters}` : `Assistant · ${footer}`);
/** The question's title, cut to 40 characters (and "…") when longer. */
export const pillQuestion = (title: string): string => {
  const chars = [...title];
  return `Assistant asks: ${chars.length > 40 ? `${chars.slice(0, 40).join('').trimEnd()}…` : title}`;
};
const PILL_ENDS: Record<EndState, string> = { done: 'Assistant: done', stopped: 'Assistant: stopped', capped: 'Assistant: reached a limit', failed: "Assistant: didn't finish" };
export const pillDone = (state: EndState): string => PILL_ENDS[state];
export const STOP = 'Stop';
export const STOP_LABEL = 'Stop the Assistant';
/** A Stop that didn't reach Magnusim's server (the request goes on). */
export const STOP_FAILED = "The Stop didn't reach Magnusim's server, so the request goes on. Try Stop again.";

// ---------------------------------------------------------------- dock states and turn ends (2.10)

export const STATE_LOADING = 'Loading the Assistant…';
export const STATE_ERROR = "Magnusim's server didn't answer.";
export const TRY_AGAIN = 'Try again';
/** Over remote access: the server's own sentence, as Settings shows it. */
export { REMOTE_TEXT };
export const STATE_OFF = 'The Assistant is off. Choose a provider in Settings → Assistant.';
export const OPEN_SETTINGS = 'Open Settings';
const END_LABELS: Record<EndState, string | null> = { done: null, stopped: 'Stopped', capped: 'Limit reached', failed: "Didn't finish" };
/** An ended turn's label (none for done). */
export const endLabel = (state: EndState): string | null => END_LABELS[state];
/**
 * An ended turn's body: the server's message, and for a limit the way on. Today's limit is
 * raised in Settings (another message is refused until then, or midnight); a full conversation
 * goes on in a new one (the composer offers it); any other limit, with another message.
 */
export const endBody = (state: EndState, message: string | null, reason: string | null = null): string => {
  const m = message ?? '';
  if (state === 'capped' && reason === 'day_usd') return m ? `${m} Raise it in Settings → Assistant.` : 'Raise it in Settings → Assistant.';
  if (state === 'capped' && reason === 'conversation_full') return m;
  if (state === 'capped') return m ? `${m} Send another message to carry on.` : 'Send another message to carry on.';
  return m;
};
/** A done turn's usage line. */
export const usageLine = (steps: number, billing: Billing, turnUsd: number, agentName: string | null): string => {
  const what = billing === 'free' ? 'no cost' : billing === 'agent_account' ? `billed to your ${agentName ?? ''} account` : usd(turnUsd);
  return `${steps} ${steps === 1 ? 'step' : 'steps'} · ${what}`;
};
export const RECORD_GONE = "This request's record is gone: Magnusim keeps it while its conversation lives.";
export const LOG_DROPPED = "This request's details are no longer kept.";
/** A request of another window: where its questions show. */
export const QUESTIONS_ELSEWHERE = 'Its questions show in the window that started it.';
export const QUESTION_ELSEWHERE = 'Its question shows in the window that started it.';

// ---------------------------------------------------------------- the question card (4.3, 4.6)

export const ANSWER_HERE_ONLY = 'Answer here only';
export const PROJECT_DATA = 'Project data';
export const PRIVACY_SETTINGS = 'Privacy settings';
export const askedOutside = (title: string): string => `Asked by a request started outside this window: "${title}"`;
export const ASKED_BY_APP = 'Asked by another app on this PC.';
export const closesIn = (minutes: number): string => (minutes < 1 ? 'Closes in under a minute' : `Closes in ${minutes} min`);
export const gateHelp = (no: string, yes: string): string => `Enter or Escape answers “${no}”. “${yes}” takes a click, or Tab then Space.`;

// ---------------------------------------------------------------- Undo these changes (8.3)

export const UNDO_CHANGES = 'Undo these changes';
export const undoTitle = (workspace: string): string => `Undo the Assistant's changes of this request in ${workspace} (one step)`;
export const UNDO_WAIT = 'Wait for the running request to end.';
/** While the workspace is asked to undo (up to its 10 s answer). */
export const undoAsking = (workspace: string): string => `Asking ${workspace} to undo them…`;
export const undone = (workspace: string): string => `Undone. Redo (Ctrl+Y) in ${workspace} brings them back.`;
export const undoNotNewest = (workspace: string): string =>
  `Something changed after this request, so its changes can't be undone as one step here. Use Undo in ${workspace}.`;
export const undoBusy = (workspace: string): string => `${workspace} is busy; try again in a moment.`;
export const undoNoAnswer = (workspace: string): string => `${workspace} didn't answer. Its own Undo still works.`;
export const UNDO_WHILE_OPEN = 'Undo lasts while the Part stays open.';

// ---------------------------------------------------------------- questions in the transcript (4.5)

export const gateAsked = (title: string): string => `Asked: ${title}`;
export const gateClosedLine = (answer: 'allow' | 'deny', by: 'user' | 'timeout' | 'stop', yes: string, no: string, title: string): string => {
  if (by === 'stop') return `Withdrawn: ${title}`;
  if (by === 'timeout') return `No answer in time, so “${no}”: ${title}`;
  return answer === 'allow' ? `You chose “${yes}”: ${title}` : `You chose “${no}”: ${title}`;
};

// ---------------------------------------------------------------- the live region (10.1)

export const LIVE_WORKING = 'The Assistant is working.';
export const liveToolDone = (title: string): string => `${title}: done`;
export const liveToolFailed = (title: string): string => `${title}: failed`;
export const liveWaiting = (workspace: string): string => `The Assistant waits for you in ${workspace}.`;
/** The end of a done turn: the first 200 characters of its final text. */
export const liveFinished = (text: string): string => {
  const chars = [...text.trim()];
  return chars.length ? `The Assistant finished: ${chars.slice(0, 200).join('')}` : 'The Assistant finished.';
};
export const liveEnded = (label: string, message: string | null): string => (message ? `${label}: ${message}` : `${label}.`);
export const liveStepsDone = (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'} done`;
/** A step whose call the log no longer has, or a wait whose workspace has no name. */
export const LIVE_A_STEP = 'A step';
export const LIVE_ITS_WORKSPACE = 'its workspace';
