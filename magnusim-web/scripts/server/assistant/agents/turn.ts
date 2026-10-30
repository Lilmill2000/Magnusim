/**
 * An Assistant turn on a coding agent (phase 3 spec 4.7, 4.8, 4.10, 4.11, 4.14): the agent
 * gets the person's message, works with Magnusim's tools through the MCP connection its
 * session was given, and the turn's log, questions, limits and Stop are Magnusim's own.
 *
 *   starting ─ the project's row (with a project), then privacy for destination agent:<id>
 *              BEFORE the session starts, so the agent never lists the project's tools without
 *              consent (Ask: a question only the Magnusim window answers; Never send: stopped)
 *   the conversation's agent session (kept between messages, else started: "agent" event)
 *   the person's pictures: only for an agent whose initialize said it takes them
 *              (promptCapabilities.image), else failed/bad_images before the prompt
 *   its tools listed: the prompt waits (AGENT_TOOLS_MS at most, else failed/agent_no_tools)
 *              until the agent's Magnusim MCP server has listed them
 *   the prompt: [the agent note and the workspace notes, on the first prompt the session gets
 *                (a kept session whose earlier turn ended before its prompt too); the message;
 *                the attached files' lines; the person's pictures; the app context]
 *   model ─ while it runs:
 *     the agent's updates go to the log (text, plan, its own tools, its mode and model; our
 *       own tools' updates are not logged: the runner's tool_call / tool_result are their record);
 *       a compaction that ended (the agent shortened its memory of the chat: session.ts, in either
 *       form, never its own tool nor the tripwire) is a note, as are those that ended between
 *       prompts, at the next turn's start; its usage (the context it uses, of its size) is kept on
 *       the conversation (agentContext), for the conversation list
 *     its MCP calls run here (AgentTurnRun.run): the turn's owner, tab, caps, log and signal; a
 *       call that arrived before this prompt went out (an earlier message's) answers `stopped`;
 *       one still open when the turn ends, however it ends, logs its result before the end
 *     its permission requests: ours auto-allowed (allow_once only, a tool in the list served
 *       now); ours otherwise (a tool that left that list) answered no at once with a note, never
 *       asked as its own tool; its own a question in the Magnusim window (4 minutes;
 *       AGENT_UNANSWERED_MAX in a row unanswered end the turn capped/unanswered), a tools-off
 *       agent's own one the lockdown tripwire (a tool of Magnusim's server, served now or not,
 *       never is)
 *     the state follows what is open (questions may overlap): syncState
 *   the stop reason gives the end (the table of spec 4.7)
 *
 * "Ours" comes only from fields the agent's adapter sets (acp.ts OursMatcher), never from a
 * title the model writes.
 *
 * Limits (min of the turn's snapshot and the live settings): 24 changes (later change calls are
 * answered `capped`, reads go on), 400 calls (then every call `capped`, and 5 more end the turn
 * capped/agent_calls), 60 active minutes (Turn.onMinutesUp: it fires whether or not a call is
 * open). Its tab's page hears its calls and changes against the first two as they are in force
 * (Turn.setUsed, read at each call): with each call's result, or at once for a call refused
 * before it ran (no result of it is logged), so a workspace can tell its model what is left.
 * As in a loop turn, questions and a call's waits for the person (its progress `waiting`, for
 * 20 minutes of one call's waits: runner.ts WAIT_PAUSE_MAX_MS, said in the log) are not
 * active. $ limits, tokens and the day's ledger don't apply: the agent bills its own account.
 *
 * Stop (and a limit, the minutes, the allow switch going off): a call still open stops as that
 * end reads, every open permission request is answered `cancelled`, then session/cancel; when
 * the agent hasn't answered in 3 s (AGENT_CANCEL_MS) it is tree-killed and the turn ends anyway.
 * A crash, a mode outside the allowed ones or the tripwire ends the agent at once. Whatever ends
 * the turn with the prompt still out, the same cancel and kill follow (the finally).
 */
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { capText as loopCapText } from '../loop.ts';
import { contextBlock, guideBlock } from '../prompt.ts';
import { attachmentLines, type AttachmentRef } from '../attachments.ts';
import { destinationOf } from '../providers/index.ts';
import {
  agentPrivacyGate,
  agentProjectListGate,
  isProjectList,
  LIST_CONSENT_KEY,
  NOTHING_MORE_SENT,
  NOTHING_SENT,
  privacyDecision,
  privacyDeclinedText,
  type ProjectInfo,
} from '../privacy.ts';
import { redact } from '../redact.ts';
import { abortedResult, callAbortOf, errorResult, gateInputText, riskOf, STOPPED_BEFORE, type CallAbort, type RunnerEvent, type RunnerTurn, type RunResult, type ToolRunner } from '../runner.ts';
import { cleanText } from '../sanitize.ts';
import type { AgentCaps, AssistantSettings } from '../settings.ts';
import type { Clock, GateBroker, GateEvent, GateOwner, GateRequest } from '../gates.ts';
import type { Conversation } from '../conversations.ts';
import type { CorePlace, ToolCtx, ToolDef, WorkspaceRegistration } from '../registry.ts';
import { placeOf, tabHere } from '../tab-place.ts';
import { bindingServes, notePromptSent, type AgentDispatch } from '../mcp/sessions.ts';
import type { EndState, PageLimits, TurnState } from '../loop.ts';
import type { ImagePart, StreamEvent, ToolCallPart } from '../types.ts';
import { noteBlock, noteInSystemPrompt, OursMatcher, pickOption, REJECT_KINDS, type AgentUpdate, type CompactionView, type PermissionView } from './acp.ts';
import type { AgentProviderId, KnownAgent } from './known.ts';
import { policyOf } from './known.ts';
import { AGENTS_BUSY_TEXT, NOTHING_RUNS_TEXT, RESTARTED_TEXT, type AgentHost, type AgentTimings } from './host.ts';
import { AGENT_TOOLS_MS, AgentRunError, agentErrorOf, exitedText, LOCKDOWN_TEXT, MODE_TEXT, type AgentSession, type FoundAgent } from './session.ts';
import { RpcExited } from './rpc.ts';

/** What an agent turn fixed when it started (turns.ts TurnSettings). */
export interface AgentTurnSettings {
  kind: 'agent';
  provider: AgentProviderId;
  agent: FoundAgent;
  caps: AgentCaps;
  /** The agent's saved model id ('' for its own default). */
  model: string;
  /** How long its questions wait. */
  gateTimeoutMs: number;
}

/** An agent turn's log events (turns.ts TurnEvent gains them; the CLI and the later dock read them). */
export type AgentEvent =
  | { type: 'agent'; name: string; version: string | null; own_tools: 'off' | 'on' }
  | { type: 'plan'; entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }> }
  | { type: 'agent_tool'; call: string; title: string; kind: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
  | { type: 'agent_permission'; title: string; outcome: 'auto_allowed' | 'allowed' | 'declined' | 'cancelled'; by: 'magnusim' | 'user' | 'timeout' | 'stop' }
  | { type: 'agent_mode'; mode: string; label: string }
  | { type: 'agent_model'; model: string; label: string };

interface EndInfo {
  state: EndState;
  reason: string;
  message: string | null;
}

/** The turn as the agent runner drives it (turns.ts Turn, narrowed by agentTurn()). */
export interface AgentRunTurn extends RunnerTurn {
  readonly prompt: string;
  /** The files the person attached (core host tools spec 13.3): one line each after the prompt. */
  readonly attachments?: readonly AttachmentRef[];
  /** The person's pictures sent with the request (sanitize.ts checkPromptImages), until its end. */
  readonly promptImages?: readonly ImagePart[];
  readonly tab: string | null;
  /** The tab that shows its questions: the window that started it, else its bound tab (phase 4 spec 9.1). */
  readonly showTab: string | null;
  readonly projectId: string | null;
  readonly simulationId: string | null;
  /** Its tab is somewhere else now (core host tools spec §9.4): true when the project changed (the conversation moved). */
  follow(projectId: string | null, simulationId: string | null, title?: string | null): boolean;
  readonly settings: AgentTurnSettings;
  readonly conv: Conversation;
  readonly signal: AbortSignal;
  readonly ended: boolean;
  readonly state: TurnState;
  step: number;
  calls: number;
  emit(e: RunnerEvent | AgentEvent): void;
  setState(s: TurnState): void;
  end(state: EndState, reason: string, message: string | null): void;
  note(text: string): void;
  onStream(step: number, e: StreamEvent): void;
  callSignal(): AbortSignal;
  callDone(): void;
  /** The turn is to end for `reason`: a call still open stops now, as that end reads. */
  abortCallFor(reason: string): void;
  armMinutes(limitMs: number, text: string): void;
  /** What its tab's page hears of its limits and of its calls and changes against them (`tell`: now). */
  setUsed(limits: PageLimits, agent: { calls: number; changes: number }, tell: boolean): void;
  /** Hears the minutes cap fire, whether or not a call is open. */
  onMinutesUp(fn: () => void): () => void;
  /** Hears the turn end, before `end` is logged, with how its calls now read (a call still open logs its result then). */
  onEnding(fn: (why: CallAbort) => void): () => void;
  stopEnd(): EndInfo;
}

export interface AgentTurnDeps {
  host: AgentHost;
  /** The TurnManager (server lifetime) the session is tagged with. */
  manager: object;
  known: KnownAgent | null;
  registry: {
    workspaceOf(tab: string): { connected: boolean; reg: WorkspaceRegistration; guide: string } | null;
    /** The tab's core page (C7): where the window is now (the turn follows its tab). */
    coreOf?(tab: string): { connected: boolean; projectId: string; studyId: string; place: CorePlace } | null;
  };
  runner: ToolRunner;
  gates: GateBroker;
  /** The live settings (caps are min'd with the turn's, privacy is read from them). */
  settings(): Promise<AssistantSettings>;
  projects(id: string, o: { signal: AbortSignal; turn: string }): Promise<ProjectInfo | null>;
  remember(projectId: string, createdAt: string | null, destination: string): Promise<void>;
  clock: Clock;
  /** Magnusim's version (clientInfo; the tripwire's record). */
  version(): Promise<string>;
  /** The lockdown tripwire fired for this agent: it needs its switch until Magnusim's next update (settings.ts setAgentLockdownFailed). */
  lockdownFailed(id: string, version: string): Promise<unknown>;
  /** The sign-in block from an auth_required (discover.ts rememberAgentSignIn). */
  rememberSignIn?(id: string, session: AgentSession | null, err: AgentRunError): void;
  /** Whether a session started for this turn said it takes pictures (discover.ts rememberAgentImages). */
  rememberImages?(id: string, fingerprint: string | null, images: boolean): void;
}

/** The caps in force: the lower of the turn's snapshot and the live settings. */
export function effectiveAgentCaps(snapshot: AgentCaps, live: AgentCaps): AgentCaps {
  return { changes: Math.min(snapshot.changes, live.changes), calls: Math.min(snapshot.calls, live.calls), turn_minutes: Math.min(snapshot.turn_minutes, live.turn_minutes) };
}

/** An agent turn's limits as its tab's page hears them: its calls are its steps, and no dollars. */
export function agentPageLimits(caps: AgentCaps): PageLimits {
  return { steps: caps.calls, usd: 0, changes: caps.changes };
}

export function changesCapText(n: number): string {
  return `This message reached its ${n}-change limit. Stop and tell the person what is left; they can send another message to carry on.`;
}

/** The change limit's refusal says reads go on, so the agent can still look before it stops. */
export const CHANGES_CAP_HINT = 'Your change limit for this message is used: tools that only read still work. Tell the person what is left; they can send another message to carry on.';

export function callsCapText(n: number): string {
  return `This message reached its ${n}-call limit. Stop and tell the person what is left; they can send another message to carry on.`;
}

export const AGENT_CALLS_END_TEXT = (n: number) => `The agent went on calling tools past this message's ${n}-call limit, so Magnusim stopped it.`;
/** A request with pictures on an agent whose initialize said it takes none (nothing was sent to it). */
export const AGENT_IMAGES_TEXT = (name: string): string => `${name} doesn't take pictures. Send the message without them.`;
export const PICTURE_NOTE = '(The agent showed a picture; the chat will show it.)';
/** The agent shortened its memory of this chat (a compaction that completed). */
export const COMPACTED_NOTE = (name: string) => `${name} shortened its memory of this chat to make room.`;
/** One that failed, with its own words when it gave any (their last full stop is the note's). */
export const COMPACTION_FAILED_NOTE = (name: string, error: string | null) => {
  const why = (error ?? '').replace(/[\s.]+$/, '');
  return `${name} tried to shorten its memory of this chat and couldn't${why ? `: ${why}` : ''}.`;
};
export const HOME_OWN_TOOL_NOTE = (name: string) => `${name} asked to use its own tool; answer such questions in a project's Magnusim window.`;
/** A permission request for a tool of Magnusim's server that isn't allowed without asking now (it left the list served to the agent). */
export const NOT_OFFERED_NOTE = (name: string) =>
  `${name} asked to use a Magnusim tool that doesn't match one offered to it now (they change when a window's link drops or a workspace closes), so Magnusim said no.`;
/** The agent's Magnusim MCP server never listed its tools before the prompt's wait ran out. */
export const AGENT_NO_TOOLS_TEXT = (name: string, ms: number) =>
  `${name} didn't connect to Magnusim's tools within ${Math.round(ms / 1000)} s, so this message wasn't sent to it. Send it again; if this keeps happening, run its Test in Settings → Assistant.`;
/** Own-tool questions in a row that nobody answered before the turn ends (the person is away). */
export const AGENT_UNANSWERED_MAX = 2;
export const AGENT_UNANSWERED_TEXT = (name: string, n: number) =>
  `Nobody answered ${name}'s last ${n} questions, so Magnusim stopped this message. Send another message to carry on.`;
export const AGENT_PRIVACY_DENIED_CALL_TEXT = 'Settings → Assistant is set to never send project data off this PC now, so this tool did not run. Nothing more was sent.';
export const AGENT_PRIVACY_DECLINED_TEXT = "The person didn't allow this project's data to be sent, so the tool did not run. Nothing more was sent.";
/** A turn with no app tab can't ask (only the Magnusim window answers an agent's privacy question). */
export const AGENT_PRIVACY_NO_WINDOW_TEXT = (name: string, nothing: string) =>
  `Sending this project to ${name} needs your answer in the Magnusim window, so ask from the project's window. ${nothing}`;

/** The stop reason's end (spec 4.7). */
export function stopReasonEnd(reason: string | null, name: string): EndInfo {
  switch (reason) {
    case 'end_turn':
      return { state: 'done', reason: 'end_turn', message: null };
    case 'max_tokens':
      return { state: 'capped', reason: 'max_tokens', message: 'The agent ran out of room mid-answer.' };
    case 'max_turn_requests':
      return { state: 'capped', reason: 'agent_limit', message: 'The agent reached its own limit of requests for one message.' };
    case 'refusal':
      return { state: 'failed', reason: 'refusal', message: 'The agent declined this request.' };
    case 'cancelled':
      return { state: 'stopped', reason: 'agent', message: 'The agent stopped this message.' };
    case 'error':
      return { state: 'failed', reason: 'agent_error', message: `${name} stopped with an error.` };
    default:
      return { state: 'failed', reason: 'agent_error', message: `${name} ended this message in a way Magnusim doesn't know.` };
  }
}

/** The agent's own-tool question (spec 5.7): only the Magnusim window answers it. */
export function ownToolGate(o: { turn: string; name: string; view: PermissionView }): GateRequest {
  const name = cleanText(o.name, 64) || 'The coding agent';
  const kind = cleanText(o.view.kind ?? '', 40) || 'other';
  const title = cleanText(redact(o.view.title), 80) || '(no description)';
  let sent: string;
  try {
    const raw = o.view.rawInput;
    sent = raw && typeof raw === 'object' && !Array.isArray(raw) ? gateInputText(undefined, raw as Record<string, unknown>) : cleanText(JSON.stringify(raw ?? null) ?? 'null', 400);
  } catch {
    sent = '(unreadable)';
  }
  return {
    kind: 'confirm',
    turn: o.turn,
    title: `Let ${name} use its own tool (${kind})?`,
    copy: `${name} asks to use one of its own tools. Magnusim can't see or check what it does on this PC. As the agent describes it: ${title}. What it sent: ${cleanText(redact(sent), 1500)}. Nothing runs until you choose.`,
    yes: 'Allow once',
    no: "Don't",
    risk: 'destructive',
    tool: cleanText(redact(o.view.title), 64) || kind,
    source: `${name} (its own tool)`,
    link_only: true,
  };
}

const TOOL_STATUS = new Set(['pending', 'in_progress', 'completed', 'failed']);
/** Codes of a call the runner answered without running its tool (it doesn't count toward the change limit). */
const NOT_RUN = new Set(['no_tool', 'invalid_input', 'unavailable', 'plugin_off', 'declined', 'capped']);

/** The frozen guide of each session (its first prompt carried it). */
const sessionGuides = new WeakMap<AgentSession, string>();

class AgentTurnRun implements AgentDispatch {
  private readonly t: AgentRunTurn;
  private readonly d: AgentTurnDeps;
  private readonly timings: AgentTimings;
  private readonly name: string;
  private session: AgentSession | null = null;
  private matcher: OursMatcher;
  private project: ProjectInfo | null = null;
  private promptPending = false;
  /** How the turn ends once the prompt is over or given up ('stop': as its Stop says). */
  private pendingEnd: EndInfo | 'stop' | null = null;
  private wake: (() => void) | null = null;
  private readonly halted: Promise<'halted'>;
  private cancelTimer: unknown = null;
  private readonly asks = new Set<AbortController>();
  private changes = 0;
  private callsSeen = 0;
  private overCalls = 0;
  private closed = false;
  private pictureNoted = false;
  private tripped = false;
  private readonly toolStatus = new Map<string, string>();
  private lastMode: string | null = null;
  private lastModel: string | null = null;
  /** The binding's prompt count once this turn's prompt went out (null before): its calls carry it. */
  private promptSeq: number | null = null;
  /** What is open now, which the turn's state follows (syncState). */
  private prompted = false;
  private consents = 0;
  private questions = 0;
  private callsOpen = 0;
  /** Own-tool questions in a row nobody answered (they timed out). */
  private unanswered = 0;
  /** NOT_OFFERED_NOTE was said in this turn. */
  private notOfferedNoted = false;

  constructor(t: AgentRunTurn, d: AgentTurnDeps, timings: AgentTimings) {
    this.t = t;
    this.d = d;
    this.timings = timings;
    this.name = t.settings.agent.name;
    this.matcher = new OursMatcher(policyOf(d.known).ours, () => false);
    this.halted = new Promise((resolve) => {
      this.wake = () => resolve('halted');
    });
  }

  /** Who asks its questions: this turn, shown in the tab that shows them now (it may move: /show). */
  private get owner(): GateOwner {
    return { kind: 'turn', id: this.t.id, tab: this.t.showTab };
  }

  // ------------------------------------------------------------ the binding's dispatch

  ctx(): ToolCtx {
    const t = this.t;
    // Where its tab is now: its next call follows it there (followTab), so the tools listed to the
    // agent are already that place's. Seen live: right after core__show moved the window into a
    // project, the list served from the turn's old place dropped core__show (the page's tools
    // now named the new project) and Claude Code gave up on opening the part.
    const here = t.tab ? tabHere(this.d.registry, t.tab) : null;
    const moved = !!here && (here.projectId || null) !== (t.projectId ?? null);
    const projectId = moved ? here.projectId || null : t.projectId;
    return {
      tab: t.tab,
      projectId,
      simulationId: moved ? here.studyId || null : t.simulationId,
      cloud: true,
      local: false,
      place: placeOf(this.d.registry, t.tab, projectId),
      budgetTokens: null,
      // A coding agent's calls carry no message of the person's (the typed-path rule refuses a path).
      prompt: null,
      // import_file takes the files the person attached to this conversation (Attach works for agents too).
      conversation: t.conv.id,
      used: () => t.toolUse?.() ?? null,
      assistant: { provider: t.settings.provider, model: t.settings.model },
      // Its answers go to the agent (chat_history asks before a saved chat's words go anywhere else).
      destination: { key: destinationOf({ provider: t.settings.provider, base_url: '' }), label: t.settings.agent.name },
    };
  }

  owns(owner: GateOwner): boolean {
    return owner.kind === 'turn' && owner.id === this.t.id;
  }

  /** One MCP call of the agent, inside this turn (spec 4.7 "MCP calls inside the turn"). */
  async run(
    call: ToolCallPart,
    o: { offered: ReadonlyMap<string, ToolDef>; signal: AbortSignal; prompts?: number; onProgress?: (fraction: number | null, label: string) => void },
  ): Promise<RunResult> {
    const t = this.t;
    if (this.closed) return errorResult(call, 'stopped', NOTHING_RUNS_TEXT);
    // A call that arrived before this turn's prompt went out (one that waited behind a call of
    // an earlier, stopped message) is that message's: it never runs in this one.
    if (o.prompts !== undefined && o.prompts !== this.promptSeq) return errorResult(call, 'stopped', NOTHING_RUNS_TEXT);
    if (t.ended || t.signal.aborted || this.pendingEnd) return errorResult(call, 'stopped', STOPPED_BEFORE);
    this.callsSeen += 1;
    const caps = effectiveAgentCaps(t.settings.caps, (await this.d.settings()).agent_caps);
    // Its tab's page hears each call: with its result, or now when it is refused here (no result
    // of it is logged).
    const refused = (r: RunResult): RunResult => {
      this.tellUsed(caps, true);
      return r;
    };
    if (this.callsSeen > caps.calls) {
      this.overCalls += 1;
      const r = refused(errorResult(call, 'capped', callsCapText(caps.calls)));
      if (this.overCalls > 5) this.halt({ state: 'capped', reason: 'agent_calls', message: AGENT_CALLS_END_TEXT(caps.calls) }, false);
      return r;
    }
    const def = o.offered.get(call.name) ?? null;
    const risk = riskOf(def);
    if (risk !== 'read' && this.changes >= caps.changes) return refused(errorResult(call, 'capped', changesCapText(caps.changes), CHANGES_CAP_HINT));
    // The turn follows its tab (§9.4): a project opened there since its last call is this call's,
    // and its privacy is asked below before any of it goes to the agent.
    const unreadable = await this.followTab();
    if (unreadable) return refused(errorResult(call, 'project_unreadable', unreadable));
    if (t.ended || t.signal.aborted || this.pendingEnd) return refused(errorResult(call, 'stopped', STOPPED_BEFORE));
    // A call is a request of the turn: privacy is read live before a tool that reads project data.
    if (def?.projectData && t.projectId && this.project) {
      const no = await this.privacyForCall(call);
      if (no) return refused(no);
      if (t.ended || t.signal.aborted || this.pendingEnd) return refused(errorResult(call, 'stopped', STOPPED_BEFORE));
    }
    this.tellUsed(caps, false);
    // A change counts once its result comes (one that ran, or may have), before the page hears it.
    let counted = false;
    const countChange = (ok: boolean, code: string | null | undefined) => {
      if (counted || risk === 'read' || (!ok && NOT_RUN.has(String(code)))) return;
      counted = true;
      this.changes += 1;
      this.tellUsed(caps, false);
    };
    t.step = 1 + t.calls;
    t.calls += 1;
    this.callsOpen += 1;
    this.syncState();
    const signal = AbortSignal.any([t.callSignal(), o.signal]);
    // The runner's own question for this call (its confirm gate) counts with the agent's own
    // questions, which may be open beside it.
    let asking = false;
    // Its result is in the log (the runner's, or the one logged as the turn ended).
    let logged = false;
    const turn: RunnerTurn = {
      id: t.id,
      get step() {
        return t.step;
      },
      emit: (e) => {
        if (e.type === 'tool_result' && e.call === call.callId) {
          countChange(e.ok, e.code);
          if (logged) return;
          logged = true;
        }
        t.emit(e);
      },
      setState: (s) => {
        if (s === 'awaiting_confirmation' && !asking) {
          asking = true;
          this.questions += 1;
        } else if (s !== 'awaiting_confirmation' && asking) {
          asking = false;
          this.questions -= 1;
        }
        this.syncState();
      },
      pause: () => t.pause(),
      resume: () => t.resume(),
      // The runner's lines for the turn's log (a call that waited its 20 minutes for the person).
      note: (text) => t.note(text),
      // Its result's pictures, kept for the window (the dock shows them in the call's step).
      keepImages: (images) => t.keepImages?.(images) ?? [],
    };
    // The turn may end while this call is open (its agent exited, Stop on an agent that answered
    // the cancel without waiting for its call, the server stopping, Magnusim ending its agent),
    // the call aborted with it. Its result is then logged at once, before the turn's `end`: the
    // runner's own would come once the tool answers its abort, after the end, when nothing is
    // logged any more. It reads as the runner gives it for that abort ("before this ran" while
    // its question was open).
    const started = this.d.clock.now();
    const offEnding = t.onEnding((why) => {
      if (logged) return;
      logged = true;
      const ended = abortedResult(call, callAbortOf(signal) ?? why, !asking);
      t.emit({ type: 'tool_result', call: call.callId, ok: ended.ok, ...(ended.code ? { code: ended.code } : {}), summary: ended.summary, ms: Math.max(0, this.d.clock.now() - started) });
    });
    let r: RunResult;
    try {
      r = await this.d.runner.run(call, {
        owner: this.owner,
        ctx: this.ctx(),
        signal,
        turn,
        offered: o.offered,
        gateTimeoutMs: this.timings.gateMs,
        // Another project's data, or the project list: that consent first (§9.2, §9.3).
        privacyFor: (projectId, callSignal) => this.otherPrivacy(projectId, callSignal),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      });
    } finally {
      offEnding();
      t.callDone();
      if (asking) this.questions -= 1;
      this.callsOpen -= 1;
      this.syncState();
    }
    countChange(r.ok, r.code);
    return r;
  }

  /** Its tab's page hears its calls and changes against `caps` (its next result tells it; `tell`: now). */
  private tellUsed(caps: AgentCaps, tell: boolean): void {
    const counts = { calls: Math.min(this.callsSeen, caps.calls), changes: Math.min(this.changes, caps.changes) };
    this.t.setUsed(agentPageLimits(caps), counts, tell);
  }

  // ------------------------------------------------------------ following the tab

  /**
   * Where the turn's tab is now (§9.4): another project (or Home) there moves the turn and its
   * conversation, and its row is read for the privacy that follows. Null when it went well, else
   * why the new project can't be read.
   */
  private async followTab(): Promise<string | null> {
    const t = this.t;
    const here = t.tab ? tabHere(this.d.registry, t.tab) : null;
    if (!here) return null;
    const projectId = here.projectId || null;
    const studyId = here.studyId || null;
    if (projectId === (t.projectId ?? null)) {
      if (studyId !== (t.simulationId ?? null)) t.follow(projectId, studyId);
      return null;
    }
    let next: ProjectInfo | null = null;
    if (projectId) {
      try {
        next = await this.d.projects(projectId, { signal: t.signal, turn: t.id });
      } catch (err) {
        return `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}`;
      }
      if (!next) return 'That project is not in the projects list.';
    }
    t.follow(projectId, studyId, next?.title ?? null);
    this.project = next;
    return null;
  }

  // ------------------------------------------------------------ privacy

  /**
   * Another project's data, or the project list, in one call (§9.2, §9.3): that consent for this
   * agent, asked only in the Magnusim window (link_only). Don't send answers the call
   * `privacy_declined` and the turn goes on; Never send is `privacy_denied`.
   */
  private async otherPrivacy(projectId: string, signal: AbortSignal): Promise<{ code: string; message: string } | null> {
    const t = this.t;
    const destination = destinationOf({ provider: t.settings.provider, base_url: '' });
    const list = isProjectList(projectId);
    let project: ProjectInfo | null = null;
    if (!list) {
      try {
        project = await this.d.projects(projectId, { signal, turn: t.id });
      } catch (err) {
        return { code: 'project_unreadable', message: `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}` };
      }
      if (!project) return { code: 'not_found', message: 'No project has that id. The projects tool lists them.' };
    }
    const key = list ? LIST_CONSENT_KEY : projectId;
    const createdAt = project?.created_at ?? null;
    const verdict = privacyDecision(await this.d.settings(), { cloud: true, destination, projectId: key, createdAt });
    if (verdict === 'allow') return null;
    if (verdict === 'deny') return { code: 'privacy_denied', message: AGENT_PRIVACY_DENIED_CALL_TEXT };
    if (!t.showTab) return { code: 'privacy_declined', message: AGENT_PRIVACY_NO_WINDOW_TEXT(this.name, NOTHING_MORE_SENT) };
    this.consents += 1;
    this.syncState();
    t.pause();
    let answer: 'allow' | 'deny';
    try {
      const gate = project ? agentPrivacyGate({ turn: t.id, project, name: this.name }) : agentProjectListGate({ turn: t.id, name: this.name });
      answer = await this.d.gates.ask(gate, this.owner, AbortSignal.any([t.signal, signal]), { timeoutMs: this.timings.gateMs });
    } finally {
      t.resume();
      this.consents -= 1;
      this.syncState();
    }
    if (signal.aborted || t.signal.aborted) return { code: 'stopped', message: STOPPED_BEFORE };
    if (answer !== 'allow') return { code: 'privacy_declined', message: privacyDeclinedText(project ? project.id : null) };
    // "Always deny" chosen while the question was open wins over its Send.
    if ((await this.d.settings()).privacy === 'deny') return { code: 'privacy_denied', message: AGENT_PRIVACY_DENIED_CALL_TEXT };
    await this.d.remember(key, createdAt, destination);
    return null;
  }

  /**
   * Whether the agent may read the project now (spec 4.14), read live: allowed or remembered; a
   * question only the Magnusim window answers; Never send ends the turn. `first`: before the
   * session (nothing went to the agent yet).
   */
  private async requirePrivacy(first: boolean): Promise<boolean> {
    const t = this.t;
    const project = this.project as ProjectInfo;
    const destination = destinationOf({ provider: t.settings.provider, base_url: '' });
    const nothing = first ? NOTHING_SENT : NOTHING_MORE_SENT;
    const live = await this.d.settings();
    const verdict = privacyDecision(live, { cloud: true, destination, projectId: project.id, createdAt: project.created_at });
    if (verdict === 'allow') return true;
    if (verdict === 'deny') {
      this.endOrHalt(first, { state: 'stopped', reason: 'privacy', message: nothing });
      return false;
    }
    // The question is link_only: with no window to show it nobody could see or answer it (a Home
    // turn the CLI started that names a project, its --project), so it isn't asked.
    if (!t.showTab) {
      this.endOrHalt(first, { state: 'stopped', reason: 'privacy', message: AGENT_PRIVACY_NO_WINDOW_TEXT(this.name, nothing) });
      return false;
    }
    this.consents += 1;
    this.syncState();
    t.pause();
    const ac = new AbortController();
    this.asks.add(ac);
    let answer: 'allow' | 'deny';
    try {
      answer = await this.d.gates.ask(agentPrivacyGate({ turn: t.id, project, name: this.name }), this.owner, AbortSignal.any([t.signal, ac.signal]), { timeoutMs: this.timings.gateMs });
    } finally {
      this.asks.delete(ac);
      t.resume();
      this.consents -= 1;
      this.syncState();
    }
    if (answer !== 'allow' || t.signal.aborted || this.pendingEnd) {
      if (!t.signal.aborted && !this.pendingEnd) this.endOrHalt(first, { state: 'stopped', reason: 'privacy', message: nothing });
      return false;
    }
    // "Always deny" chosen while the question was open wins over its Send.
    if ((await this.d.settings()).privacy === 'deny') {
      this.endOrHalt(first, { state: 'stopped', reason: 'privacy', message: nothing });
      return false;
    }
    await this.d.remember(project.id, project.created_at, destination);
    return true;
  }

  private endOrHalt(first: boolean, end: EndInfo): void {
    if (first && !this.promptPending) this.t.end(end.state, end.reason, end.message);
    else this.halt(end, false);
  }

  /** A project-data call mid-turn: null when it may run, else its answer (and the turn ends after it). */
  private async privacyForCall(call: ToolCallPart): Promise<RunResult | null> {
    const live = await this.d.settings();
    const project = this.project as ProjectInfo;
    const destination = destinationOf({ provider: this.t.settings.provider, base_url: '' });
    const verdict = privacyDecision(live, { cloud: true, destination, projectId: project.id, createdAt: project.created_at });
    if (verdict === 'allow') return null;
    if (verdict === 'deny') {
      this.halt({ state: 'stopped', reason: 'privacy', message: NOTHING_MORE_SENT }, false);
      return errorResult(call, 'privacy_denied', AGENT_PRIVACY_DENIED_CALL_TEXT);
    }
    // An answer forgotten mid-turn asks again (in the window; with no tab the turn ends).
    if (await this.requirePrivacy(false)) return null;
    return errorResult(call, 'declined', this.t.showTab ? AGENT_PRIVACY_DECLINED_TEXT : AGENT_PRIVACY_NO_WINDOW_TEXT(this.name, NOTHING_MORE_SENT));
  }

  // ------------------------------------------------------------ ending early

  /**
   * The turn is to end before the agent's answer (Stop, a limit, the tripwire, a mode): a call
   * still open stops now, as that end reads (Stop and the minutes stopped it already), open
   * permission requests are answered `cancelled`, then session/cancel; with `kill`, or when the
   * agent hasn't answered after AGENT_CANCEL_MS, it is tree-killed. The first reason wins.
   */
  halt(end: EndInfo | 'stop', kill: boolean): void {
    if (!this.pendingEnd) this.pendingEnd = end;
    // Before the kill: its closing of the call's MCP connection would read "The server stopped…".
    if (this.pendingEnd !== 'stop') this.t.abortCallFor(this.pendingEnd.reason);
    for (const ac of [...this.asks]) ac.abort();
    const s = this.session;
    if (s && this.promptPending) s.cancel();
    if (kill) {
      if (s) void this.d.host.endSession(this.t.conv.id, s, 'halted');
      this.wake?.();
      return;
    }
    if (!this.promptPending) {
      this.wake?.();
      return;
    }
    if (this.cancelTimer === null) {
      this.cancelTimer = this.d.clock.setTimeout(() => {
        this.cancelTimer = null;
        if (!this.promptPending) return;
        // It didn't answer the cancel in time: the tree kill, and the turn ends anyway.
        if (this.session) void this.d.host.endSession(this.t.conv.id, this.session, 'cancel_timeout');
        this.wake?.();
      }, this.timings.cancelMs);
    }
  }

  private tripwire(): void {
    if (this.tripped) return;
    this.tripped = true;
    const id = this.t.settings.agent.id;
    void this.d
      .version()
      .then((v) => this.d.lockdownFailed(id, v))
      .catch(() => {});
    this.halt({ state: 'failed', reason: 'agent_lockdown', message: LOCKDOWN_TEXT(this.name) }, true);
  }

  // ------------------------------------------------------------ what the agent sends

  private onUpdate(u: AgentUpdate): void {
    const t = this.t;
    if (t.ended) {
      // The turn is over but its prompt is still out (a crash of the turn, the cancel wait):
      // nothing more is logged, but the agent is still checked.
      if (u.kind === 'tool') {
        if (this.matcher.tool(u) === null && t.settings.agent.lockdown === 'tools_off') this.tripwire();
      } else if (u.kind === 'mode') this.modeSeen(u.mode);
      else if (u.kind === 'config' && u.mode !== null) this.modeSeen(u.mode);
      return;
    }
    switch (u.kind) {
      case 'text':
        t.onStream(1 + t.calls, { kind: 'text', text: u.text });
        return;
      case 'content':
        if (!this.pictureNoted) {
          this.pictureNoted = true;
          t.note(PICTURE_NOTE);
        }
        return;
      case 'thought':
        return;
      case 'usage':
        if (Number.isFinite(u.used) && Number.isFinite(u.size) && u.size > 0) t.conv.agentContext = { used: Math.max(0, u.used), size: u.size };
        return;
      case 'compaction':
        this.compactionNote(u);
        return;
      case 'tool': {
        if (this.matcher.tool(u) !== null) return;
        if (this.t.settings.agent.lockdown === 'tools_off') {
          this.tripwire();
          return;
        }
        const status = u.status ?? (u.isNew ? 'pending' : null);
        if (!status || !TOOL_STATUS.has(status) || this.toolStatus.get(u.id) === status) return;
        this.toolStatus.set(u.id, status);
        t.emit({
          type: 'agent_tool',
          call: cleanText(u.id, 128),
          title: cleanText(redact(u.title ?? ''), 200),
          kind: cleanText(u.toolKind ?? '', 64) || 'other',
          status: status as 'pending' | 'in_progress' | 'completed' | 'failed',
        });
        return;
      }
      case 'plan':
        t.emit({ type: 'plan', entries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) });
        return;
      case 'mode':
        this.modeSeen(u.mode);
        return;
      case 'model':
        this.modelSeen(u.model);
        return;
      case 'config':
        if (u.mode !== null) this.modeSeen(u.mode);
        if (u.model !== null) this.modelSeen(u.model);
        return;
    }
  }

  /** A compaction that ended (session.ts says each once): a note. */
  private compactionNote(c: CompactionView): void {
    if (c.status === 'completed') this.t.note(COMPACTED_NOTE(this.name));
    else if (c.status === 'failed') this.t.note(COMPACTION_FAILED_NOTE(this.name, c.error ? cleanText(redact(c.error), 200) || null : null));
  }

  /** A mode the agent reports: one outside the allowed ones stops the turn and ends the agent. */
  private modeSeen(mode: string): void {
    const s = this.session;
    if (!s) return;
    if (!s.modeAllowed(mode)) {
      this.halt({ state: 'failed', reason: 'agent_mode', message: MODE_TEXT(this.name) }, true);
      return;
    }
    if (mode === this.lastMode) return;
    this.lastMode = mode;
    const label = s.modes?.available.find((m) => m.id === mode)?.name ?? s.config.find((o) => o.category === 'mode')?.options.find((x) => x.value === mode)?.name ?? cleanText(mode, 64);
    this.t.emit({ type: 'agent_mode', mode: cleanText(mode, 64), label: cleanText(label, 64) });
  }

  private modelSeen(model: string): void {
    const s = this.session;
    if (!s || model === this.lastModel) return;
    this.lastModel = model;
    const label = s.config.find((o) => o.category === 'model')?.options.find((x) => x.value === model)?.name ?? s.models?.available.find((m) => m.id === model)?.name ?? cleanText(model, 64);
    this.t.emit({ type: 'agent_model', model: cleanText(model, 128), label: cleanText(label, 64) });
  }

  /** A permission request (spec 4.8): the option to pick, or null (cancelled). */
  private async onPermission(view: PermissionView): Promise<string | null> {
    const t = this.t;
    const title = cleanText(redact(view.title), 200) || cleanText(view.kind ?? '', 64) || 'a tool';
    // Magnusim's tool, served now or not, is never the tripwire (a list that changed under the
    // agent); only one served now is allowed without asking.
    const ourTool = this.matcher.ourRequest(view);
    const ours = this.matcher.permission(view);
    if (!ourTool && t.settings.agent.lockdown === 'tools_off') {
      // The tripwire, stopping or not: answered at once (before the tree kill answers it `cancelled`).
      const reject = pickOption(view.options, ['reject_once']);
      this.session?.answerNow(view, reject);
      this.tripwire();
      return reject;
    }
    if (t.ended || t.signal.aborted || this.pendingEnd) {
      if (!t.ended) t.emit({ type: 'agent_permission', title, outcome: 'cancelled', by: 'stop' });
      return null;
    }
    if (ours) {
      const allow = pickOption(view.options, ['allow_once']);
      if (allow) {
        t.emit({ type: 'agent_permission', title: cleanText(ours, 64), outcome: 'auto_allowed', by: 'magnusim' });
        return allow;
      }
      // No allow_once: never allow_always (it would allow the tool for good inside the agent). A question.
    } else if (ourTool) {
      // Magnusim's tool, but not one it may allow without asking now (it left the list served to
      // the agent, whose MCP server refuses its call anyway; or the request doesn't name it):
      // answered no at once. It isn't the agent's own tool, so it is never asked as one (nor
      // counted as a question nobody answered).
      if (!this.notOfferedNoted) {
        this.notOfferedNoted = true;
        t.note(NOT_OFFERED_NOTE(this.name));
      }
      t.emit({ type: 'agent_permission', title, outcome: 'declined', by: 'magnusim' });
      return pickOption(view.options, REJECT_KINDS);
    }
    // No window shows its questions (a tab-less turn the CLI started): answered no, with a note.
    // A Home turn started from a window asks there (link_only, answered on its live link).
    if (!t.showTab) {
      t.note(HOME_OWN_TOOL_NOTE(this.name));
      t.emit({ type: 'agent_permission', title, outcome: 'declined', by: 'magnusim' });
      return pickOption(view.options, REJECT_KINDS);
    }
    return this.askPerson(view, title);
  }

  /** The agent's own tool (or ours without allow_once): a question only the Magnusim window answers, 4 minutes. */
  private async askPerson(view: PermissionView, title: string): Promise<string | null> {
    const t = this.t;
    const s = this.session as AgentSession;
    const allowOption = pickOption(view.options, ['allow_once']);
    const rejectOption = pickOption(view.options, REJECT_KINDS);
    const owner: GateOwner = this.owner;
    let gateId: string | null = null;
    // The answer goes to the agent the moment the question closes (before a session/cancel that
    // follows in the same tick: the first answer wins).
    const off = this.d.gates.subscribe((e: GateEvent) => {
      if (e.type === 'open' && e.owner === owner) gateId = e.view.id;
      else if (e.type === 'closed' && e.view.id === gateId) {
        if (e.answer === 'allow') s.answerNow(view, allowOption);
        else if (e.by !== 'stop') s.answerNow(view, rejectOption);
      }
    });
    const ac = new AbortController();
    this.asks.add(ac);
    // Several may be open at once (and a call's own question beside them): counted, not a saved state.
    this.questions += 1;
    this.syncState();
    t.pause();
    let answer: 'allow' | 'deny';
    try {
      answer = await this.d.gates.ask(ownToolGate({ turn: t.id, name: this.name, view }), owner, AbortSignal.any([t.signal, ac.signal]), { timeoutMs: this.timings.gateMs });
    } finally {
      off();
      this.asks.delete(ac);
      t.resume();
      this.questions -= 1;
      this.syncState();
    }
    const by = (gateId ? this.d.gates.closedAs(gateId)?.by : null) ?? 'stop';
    if (!t.ended) {
      if (answer === 'allow') t.emit({ type: 'agent_permission', title, outcome: 'allowed', by: 'user' });
      else if (by === 'stop') t.emit({ type: 'agent_permission', title, outcome: 'cancelled', by: 'stop' });
      else t.emit({ type: 'agent_permission', title, outcome: 'declined', by: by === 'timeout' ? 'timeout' : 'user' });
    }
    // Questions nobody answers (the person is away) never keep the turn, and its agent slot,
    // going for hours: their waits don't count toward the minutes, so a few in a row end it.
    if (by === 'timeout') {
      this.unanswered += 1;
      if (this.unanswered >= AGENT_UNANSWERED_MAX && !t.ended) {
        this.halt({ state: 'capped', reason: 'unanswered', message: AGENT_UNANSWERED_TEXT(this.name, this.unanswered) }, false);
      }
    } else if (by === 'user') this.unanswered = 0;
    if (answer === 'allow') return allowOption;
    return by === 'stop' ? null : rejectOption;
  }

  /**
   * The turn's state from what is open now: a privacy question, else a question (several may be
   * open at once: the agent's own, a call's confirm), else a call running, else the model
   * (before the prompt: starting).
   */
  private syncState(): void {
    const t = this.t;
    if (t.ended || this.pendingEnd) return;
    t.setState(this.consents > 0 ? 'awaiting_consent' : this.questions > 0 ? 'awaiting_confirmation' : !this.prompted ? 'starting' : this.callsOpen > 0 ? 'tools' : 'model');
  }

  // ------------------------------------------------------------ the turn

  private stoppedNow(): boolean {
    const t = this.t;
    if (t.ended) return true;
    if (!t.signal.aborted) return false;
    const s = t.stopEnd();
    t.end(s.state, s.reason, s.message);
    return true;
  }

  private endWith(e: EndInfo | 'stop'): void {
    const t = this.t;
    if (t.ended) return;
    const end = e === 'stop' ? t.stopEnd() : e;
    t.end(end.state, end.reason, end.message);
  }

  async main(): Promise<void> {
    const t = this.t;
    const d = this.d;
    t.setState('starting');
    if (this.stoppedNow()) return;
    // The project's row, as the loop reads it.
    if (t.projectId) {
      try {
        this.project = await d.projects(t.projectId, { signal: t.signal, turn: t.id });
      } catch (err) {
        if (this.stoppedNow()) return;
        t.end('failed', 'project_unreadable', `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}`);
        return;
      }
      if (this.stoppedNow()) return;
      if (!this.project) {
        t.end('failed', 'bad_project', 'That project is not in the projects list.');
        return;
      }
      // Before the session: the agent never lists the project's tools without consent.
      if (!(await this.requirePrivacy(true))) {
        // Stop, or the allow switch going off, while it asked: as that stop says.
        this.stoppedNow();
        return;
      }
      if (this.stoppedNow()) return;
    }

    try {
      const agentId = t.settings.agent.id;
      const got = await d.host.acquire({
        conversation: t.conv.id,
        agent: t.settings.agent,
        known: d.known,
        prefs: { model: t.settings.model || null, mode: (await d.settings()).agents[agentId]?.mode ?? null },
        version: await d.version(),
        manager: d.manager,
        clock: d.clock,
        dispatch: this,
        signal: t.signal,
        // The tripwire between prompts is recorded as the turn's own is.
        onLockdownFailed: () => {
          void d
            .version()
            .then((v) => d.lockdownFailed(agentId, v))
            .catch(() => {});
        },
      });
      this.session = got.session;
      // What its initialize said of pictures: the dock's next state for this agent.
      if (got.fresh) d.rememberImages?.(agentId, t.settings.agent.fingerprint, got.session.info.images);
      if (got.fresh) for (const n of got.session.notes) t.note(n);
      if (got.restarted) t.note(RESTARTED_TEXT(this.name));
      // Why the earlier agent was ended between messages.
      if (got.offence) t.note(got.offence === 'agent_lockdown' ? LOCKDOWN_TEXT(this.name) : MODE_TEXT(this.name));
      // What it did between messages: compactions that ended then, and the context it uses (a new
      // session's none yet).
      for (const c of got.session.takeCompactions()) this.compactionNote(c);
      t.conv.agentContext = got.session.usage ? { ...got.session.usage } : null;
    } catch (err) {
      if (this.stoppedNow()) return;
      if ((err as { code?: unknown } | null)?.code === 'agents_busy') {
        t.end('failed', 'agents_busy', AGENTS_BUSY_TEXT);
        return;
      }
      const e = agentErrorOf(err, this.name, null);
      if (e instanceof AgentRunError) {
        if (e.code === 'agent_signin') d.rememberSignIn?.(t.settings.agent.id, null, e);
        t.end('failed', e.code, e.message);
        return;
      }
      throw e;
    }
    const session = this.session as AgentSession;
    this.matcher = new OursMatcher(policyOf(d.known).ours, (name) => this.served(name));
    this.lastMode = session.mode;
    this.lastModel = session.model;
    t.emit({ type: 'agent', name: this.name, version: session.info.version, own_tools: t.settings.agent.ownTools });
    if (this.stoppedNow()) return;
    // The person's pictures go only to an agent whose initialize said it takes them (a kept
    // session's said so at its start); otherwise the turn ends before its prompt, nothing sent.
    if (t.promptImages?.length && !session.info.images) {
      t.end('failed', 'bad_images', AGENT_IMAGES_TEXT(this.name));
      return;
    }
    // An agent may answer session/new before its MCP servers are up (its bridge connects
    // meanwhile): the prompt waits, bounded, until Magnusim's tools were listed to it, so a
    // message is never answered without them.
    if ((await session.waitForTools({ signal: t.signal, clock: d.clock, ms: AGENT_TOOLS_MS })) === 'timeout') {
      if (this.stoppedNow()) return;
      t.end('failed', 'agent_no_tools', AGENT_NO_TOOLS_TEXT(this.name, AGENT_TOOLS_MS));
      return;
    }
    if (this.stoppedNow()) return;

    // The minutes cap counts active time (questions waiting don't count), and fires with no call open.
    const caps = effectiveAgentCaps(t.settings.caps, (await d.settings()).agent_caps);
    this.tellUsed(caps, false);
    const minutesText = loopCapText('turn_minutes', { turn_usd: 0, day_usd: 0, steps: 0, turn_tokens: 0, turn_minutes: caps.turn_minutes });
    t.armMinutes(caps.turn_minutes * 60_000, minutesText);
    const offMinutes = t.onMinutesUp(() => this.halt({ state: 'capped', reason: 'turn_minutes', message: minutesText }, false));
    const onStop = () => this.halt('stop', false);
    t.signal.addEventListener('abort', onStop, { once: true });
    let promptP: Promise<{ r: string | null } | { e: unknown }> | null = null;
    try {
      if (this.stoppedNow()) return;
      // What it did since its last prompt (or its start): checked after the last await, so nothing
      // lands between this and the prompt's handlers.
      const offence = session.offence?.code ?? (session.alive && !session.modeAllowed(session.mode) ? 'agent_mode' : null);
      if (offence) {
        session.offenceTold = true;
        void d.host.endSession(t.conv.id, session, offence);
        t.end('failed', offence, offence === 'agent_lockdown' ? LOCKDOWN_TEXT(this.name) : MODE_TEXT(this.name));
        return;
      }
      // Its first prompt: the session's (one kept from a turn that ended before its prompt too).
      const blocks = this.blocks(session, session.promptsSent === 0);
      this.prompted = true;
      this.syncState();
      // Its calls from now on are this message's (a call that arrived before is an earlier one's).
      this.promptSeq = notePromptSent(session.binding.id);
      this.promptPending = true;
      promptP = session
        .prompt(blocks, { onUpdate: (u) => this.onUpdate(u), onPermission: (v) => this.onPermission(v) })
        .then(
          (r) => ({ r }),
          (e: unknown) => ({ e }),
        )
        .finally(() => {
          this.promptPending = false;
        });
      const outcome = await Promise.race([promptP, this.halted]);
      if (outcome === 'halted') {
        // Given up on (killed, or no answer to the cancel in time).
        this.endWith(this.pendingEnd ?? 'stop');
        return;
      }
      if (this.pendingEnd) {
        this.endWith(this.pendingEnd);
        return;
      }
      if (t.signal.aborted) {
        this.endWith('stop');
        return;
      }
      if ('e' in outcome) {
        const e = agentErrorOf(outcome.e, this.name, session.info.auth);
        if (outcome.e instanceof RpcExited) {
          // Crashed: the session ends (its tree kill), and the next message starts it again.
          void d.host.endSession(t.conv.id, session, 'exited');
          t.end('failed', 'agent_exited', exitedText(this.name, outcome.e.tail));
          return;
        }
        if (e instanceof AgentRunError) {
          if (e.code === 'agent_signin') d.rememberSignIn?.(t.settings.agent.id, session, e);
          t.end('failed', e.code, e.message);
          return;
        }
        throw e;
      }
      const end = stopReasonEnd(outcome.r, this.name);
      t.end(end.state, end.reason, end.message);
    } finally {
      offMinutes();
      t.signal.removeEventListener('abort', onStop);
      if (this.promptPending) {
        // The turn ends with the prompt still out (a throw): cancel, and the tree kill unless it answers in time.
        session.cancel();
        const timer = d.clock.setTimeout(() => {
          if (this.promptPending) void d.host.endSession(t.conv.id, session, 'cancel_timeout');
        }, this.timings.cancelMs);
        void promptP?.finally(() => d.clock.clearTimeout(timer));
      }
      if (this.cancelTimer !== null && !this.promptPending) {
        d.clock.clearTimeout(this.cancelTimer);
        this.cancelTimer = null;
      }
    }
  }

  /** Whether `name` (an MCP name) was in the list last served to this session's agent. */
  private served(name: string): boolean {
    const s = this.session;
    return !!s && bindingServes(s.binding.id, name);
  }

  /** The prompt's blocks (spec 4.7 step 5); `first`: the session was never prompted. */
  private blocks(session: AgentSession, first: boolean): ContentBlock[] {
    const t = this.t;
    const ws = t.tab ? this.d.registry.workspaceOf(t.tab) : null;
    const out: ContentBlock[] = [];
    if (first) {
      if (!noteInSystemPrompt({ sessionMeta: policyOf(this.d.known).sessionMeta })) out.push(noteBlock());
      if (ws?.guide) {
        sessionGuides.set(session, ws.guide);
        out.push({ type: 'text', text: guideBlock(ws.guide, ws.reg.pluginName || ws.reg.plugin) });
      }
    } else {
      const frozen = sessionGuides.get(session);
      // A workspace met later gives its notes once, ahead of the prompt (as the first one did).
      if (ws?.guide && ws.guide !== frozen && !t.conv.guidesNoted.has(ws.guide)) {
        t.conv.guidesNoted.add(ws.guide);
        out.push({ type: 'text', text: guideBlock(ws.guide, ws.reg.pluginName || ws.reg.plugin) });
      }
    }
    out.push({ type: 'text', text: t.prompt });
    if (t.attachments?.length) out.push({ type: 'text', text: attachmentLines(t.attachments) });
    // The person's pictures, after the words they go with (main() sends none to an agent that takes none).
    for (const p of t.promptImages ?? []) out.push({ type: 'image', mimeType: p.mediaType, data: p.base64 });
    out.push({
      type: 'text',
      text: contextBlock({
        projectId: t.projectId,
        projectTitle: this.project?.title ?? null,
        simulationId: t.simulationId,
        workspace: ws ? { plugin: ws.reg.plugin, pluginName: ws.reg.pluginName, workspace: ws.reg.workspace } : null,
      }),
    });
    return out;
  }

  close(): void {
    this.closed = true;
    for (const ac of [...this.asks]) ac.abort();
  }
}

/** Runs an agent turn to its end. Errors other than the agent's reach the caller (TurnManager: t.crash). */
export async function runAgentTurn(t: AgentRunTurn, d: AgentTurnDeps): Promise<void> {
  const run = new AgentTurnRun(t, d, d.host.timings());
  try {
    await run.main();
    // A turn stopped on a path that returned without ending it ends as its Stop says (never
    // "ended without an answer").
    if (!t.ended && t.signal.aborted) {
      const s = t.stopEnd();
      t.end(s.state, s.reason, s.message);
    }
  } finally {
    run.close();
    d.host.release(t.conv.id, run);
  }
}
