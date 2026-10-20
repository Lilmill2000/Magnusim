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
