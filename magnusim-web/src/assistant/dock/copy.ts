/**
 * The dock's words (phase 4 spec 2, 4.5, 10.1), one export each; copy.test.ts pins them. None
 * names a provider or an agent: their names and labels reach these only as the server's data
 * (`providers_ready[id].label`, `TurnSummary.agent.name`). The server's own messages (a turn's
 * end, a refusal) are shown as they come and never rewritten here.
 */
import { REMOTE_TEXT } from '../api';
import type { TurnEvent } from '../wire';

type EndState = 'done' | 'stopped' | 'failed' | 'capped';
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
export const CONVERSATIONS_EMPTY = 'No conversations yet. Magnusim keeps them while it runs; a restart clears them.';
export const FORGET = 'Forget';
export const forgetLabel = (title: string): string => `Forget ${title}`;
export const FORGET_TITLE = 'Forget this conversation?';
export const FORGET_COPY = "The Assistant forgets its messages; this can't be undone. What it changed in your projects stays.";
export const FORGET_KEEP = 'Keep';
export const FORGET_BUSY = 'A request is running in this conversation. Stop it first.';
/** A conversation row's second line: its provider and the time it was last used. */
export const conversationMeta = (label: string, hhmm: string): string => `${label} · ${hhmm}`;
export const readOnlyConversation = (projectTitle: string): string =>
  `This conversation is about project "${projectTitle}". Open that project to continue it, or start a new conversation here.`;
export const OPEN_PROJECT = 'Open project';

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
export const CLOSE_PICTURE = 'Close the picture';
export const PREVIOUS_PICTURE = 'Previous picture';
export const NEXT_PICTURE = 'Next picture';

// ---------------------------------------------------------------- the intro of an empty conversation (7)

export const INTRO_HOME = 'Ask about Magnusim and your projects. To have the Assistant build a part, open a project and a CAD Part, then ask here.';
export const INTRO_PROJECT = 'The Assistant can read this project. Open a CAD Part to have it build or change one.';
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
export const CONVERSATION_FULL = 'This conversation is full. Start a new one.';
// Pictures (3.2).
export const ATTACH_LABEL = 'Attach pictures (up to 4)';
export const ATTACH = 'Attach';
export const DROP_PICTURES = 'Drop pictures to attach (up to 4)';
export const ONLY_IMAGES = 'Only PNG, JPEG and WebP pictures can be attached.';
export const shrunkTo = (w: number, h: number): string => `Shrunk to ${w} × ${h} px to fit`;
export const tooLargeAfterShrinking = (name: string): string => `${name} is larger than 1.5 MB even after shrinking it.`;
export const pictureChip = (name: string, w: number, h: number): string => `${name} · ${w} × ${h}`;
export const removePicture = (name: string): string => `Remove ${name}`;
export const AT_MOST_FOUR = 'At most 4 pictures per message.';
export const PICTURES_GO = 'Pictures go to the provider with your message.';
export const noPictures = (name: string): string => `${name} doesn't take pictures. Send the message without them.`;
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
export const waitsFor = (workspace: string, label: string): string => `Waits for you in ${workspace}: ${label}`;
export const pictureAlt = (i: number, n: number, title: string): string => `Picture ${i} of ${n} from ${title}`;
export const PICTURE_GONE = 'Picture no longer kept';

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
/** An ended turn's body: the server's message, and for a limit the way on. */
export const endBody = (state: EndState, message: string | null): string => {
  const m = message ?? '';
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
