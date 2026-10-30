/**
 * One turn of the Assistant (Foundation spec 6.1, 6.2, 6.6): the steps between the
 * person's prompt and the model's last answer.
 *
 *   starting ─ privacy (cloud turns with a project: allowed, remembered, or a question);
 *     then the prompt, its reference pictures (none for a local model known not to read
 *     images), a new conversation's earlier one (Continue in a new chat: prompt.ts carryBlock,
 *     and a note says so) and the app context, as one user message
 *   for each step:
 *     the caps (minutes, tokens; then the spend estimate and the day's reservation); a full
 *       conversation (conversations.ts fullDetail) → capped (conversation_full), but for the
 *       request that sums up. A priced turn's first estimate goes on from the conversation's last
 *       request (a read while its cache is fresh and it sends the same system, tools and effort,
 *       else written again). A request not even a whole turn's money could send (past what
 *       one turn resends once the cache has expired: conversations.ts limits) ends the turn
 *       capped (conversation_full) and closes the conversation; one only today's money left
 *       can't send says what is left of it
 *     privacy again, read live (cloud turns with a project): "Always deny" ends the turn
 *       before this request, forgotten answers ask again
 *     a local server's model row (its context, kept 60 s), read before the tools are chosen:
 *       the tools fit half its context (16,384 tokens when it says none, noted once a
 *       turn), the ones left out named once with where they are offered; not even the
 *       pinned ones → failed (context); the answer gets the room the prompt leaves; too
 *       little → failed (context) before this request, and the row is read again next turn
 *     whether the model reads images (cloud: yes; a local server: its row's type, or a
 *       refusal remembered); the adapter's notes on how a request went, each once a turn
 *     model: one request with this step's tools (computed by the host, every step); it sends
 *       the conversation with its oldest tool results left out (providers/common.ts
 *       clearedResults: none until 36, then in jumps of 24, the newest 12 or more whole)
 *       refusal → failed · context → failed · max_tokens → capped · no calls → done
 *       no calls, the turn's workspace asked for review (registry.ts WorkspaceReview) and
 *         its edit or destructive tools succeeded since the turn began or the last round →
 *         a `review` event and the review prompt as the next user message, round i of n;
 *         a round with no such success, or the n-th, ends the turn done; a round counts
 *         against the caps as any step (a turn already at a cap ends done with a note)
 *     tools: each call in order, through the runner (only this step's tools resolve)
 *       a cap reached → this and every later call is answered `capped`; so is a call whose
 *         pictures could take the next request past the conversation's picture limit
 *       a call declined → every later call `skipped`
 *       Stop → every later call `stopped`
 *       a crash → the results so far kept, the rest `failed`, then t.crash
 *     one user message with every result, in call order
 *     steps cap: one more request (same tools, so the cached prefix holds) to sum up
 *     nearly full (conversations.ts nearlyFull: the next step could reach a limit): a note asks
 *       the model to sum up, one more request (same tools); its answer ends the turn capped
 *       (conversation_full) and the conversation is full from then on; calls it makes anyway
 *       are answered `capped`, never run. A review round due then is not started.
 *
 * Two invariants hold whatever happens (a property test drives random scripts):
 * 1. Stored messages are append-only (conversations.ts).
 * 2. Every tool call of an appended answer has exactly one result in the next user
 *    message: stopped, skipped and capped calls included, even when the turn ends right
 *    after (the next turn's first request carries them).
 *
 * Caps are min(the turn's snapshot, the live settings); privacy is read live.
 */
import { createHash } from 'node:crypto';
import { carryBlock, contextBlock, guideBlock, reviewText, systemPrompt } from './prompt.ts';
import { IMAGE_CAPS } from './sanitize.ts';
import { attachmentLines, type AttachmentRef } from './attachments.ts';
import { IMAGES_LEFT_OUT_NOTE } from './providers/openai-compatible.ts';
import { clearedResults, isStrictNote, sentMessages, strictNoteKey } from './providers/common.ts';
import { alog } from './log.ts';
import { debugScoped } from './debug-log.ts';
import { destinationOf, PROVIDER_LABELS, sendWithOneResend } from './providers/index.ts';
import { costOf, estimateStep, estimateTokens, modelLabel, promptTokens, requestCost, type EstimateInput } from './prices.ts';
import {
  destinationHost,
  isProjectList,
  LIST_CONSENT_KEY,
  NOTHING_MORE_SENT,
  NOTHING_SENT,
  privacyDecision,
  privacyDeclinedText,
  privacyDeniedText,
  privacyGate,
  projectListGate,
  type ProjectInfo,
} from './privacy.ts';
import { localBudget, LOCAL_BUDGET, providerTools, workspaceToolName, type CorePlace, type ToolCtx, type ToolDef, type ToolSelection, type WorkspaceRegistration, type WorkspaceReview } from './registry.ts';
import { placeOf, tabHere } from './tab-place.ts';
import { callAbortOf, errorResult, stoppedText, toolCallEvent, type RunnerTurn, type ToolRunner } from './runner.ts';
import type { Caps, AssistantSettings } from './settings.ts';
import type { SpendLedger } from './ledger.ts';
import type { Clock, GateBroker } from './gates.ts';
import { fullText, roomNumbers, type Conversation, type FullDetail } from './conversations.ts';
import {
  ProviderError,
  type Effort,
  type Message,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRequest,
  type ProviderResult,
  type ImagePart,
  type StreamEvent,
  type ToolCallPart,
  type ToolResultPart,
  type Usage,
  type UserPart,
} from './types.ts';

export type TurnState = 'starting' | 'awaiting_consent' | 'model' | 'tools' | 'awaiting_confirmation' | 'done' | 'stopped' | 'failed' | 'capped';
export type EndState = 'done' | 'stopped' | 'failed' | 'capped';

/**
 * What a model provider's turn fixed when it started (provider, model, address and effort
 * don't follow later changes): the turn's own provider, the default or the one its start
 * named (turns.ts). `kind` is optional, so settings written before it existed stay valid.
 */
export interface ModelTurnSettings {
  kind?: 'model';
  provider: ProviderId;
  model: string;
  base_url: string;
  effort: Effort;
  caps: Caps;
}

export type CapReason = 'steps' | 'turn_tokens' | 'turn_minutes' | 'turn_usd' | 'day_usd';
export interface CapHit {
  reason: CapReason | 'conversation_full';
  text: string;
}

/** The note when the next step could fill the conversation (the model sums up first). */
export const NEARLY_FULL_NOTE = 'This conversation is nearly full; asking the model to sum up.';
/** A review round was due, but the conversation is nearly full: its answer stands. */
export const REVIEW_NO_ROOM_FULL_NOTE = 'No review round: this conversation is nearly full.';

/** The person reads what a new conversation carried to the model (Continue in a new chat), with its first request. */
export function carriedNote(prompts: number): string {
  const which = prompts === 1 ? 'your earlier prompt' : prompts > 1 ? `your ${prompts} earlier prompts` : 'no earlier prompt';
  return `Continued from an earlier conversation: ${which}, its last answer and how it ended went to the model with this message.`;
}

/** What the model is told when the next step could fill the conversation (after the step's results). */
export function nearlyFullText(d: FullDetail): string {
  return `This conversation is nearly full (${roomNumbers(d)}). Don't call tools now: say what is done and what is left.`;
}

/**
 * The limits a turn's tab's page hears (turns.ts TurnPageView.used), as they are in force: its
 * steps (a coding agent's: its tool calls), its dollars (0: none counted) and a coding agent's
 * changes (0: no such limit). `usdLeft`, when dollars are counted: the money left for its next
 * request, the smaller of what its own limit and today's leave.
 */
export interface PageLimits {
  steps: number;
  usd: number;
  changes: number;
  usdLeft?: number;
}

/** The turn as the loop drives it (turns.ts). */
export interface LoopTurn extends RunnerTurn {
  readonly prompt: string;
  /** The person's reference pictures with the prompt (checked at the start; the first user message carries them). */
  readonly promptImages: readonly ImagePart[];
  /** The files the person attached (core host tools spec 13.2): one line each after the prompt. */
  readonly attachments?: readonly AttachmentRef[];
  readonly tab: string | null;
  /** The tab that shows its questions: the window that started it, else its bound tab (phase 4 spec 9.1). */
  readonly showTab: string | null;
  readonly projectId: string | null;
  readonly simulationId: string | null;
  /** Its tab is somewhere else now (core host tools spec §9.4): true when the project changed (the conversation moved). */
  follow(projectId: string | null, simulationId: string | null, title?: string | null): boolean;
  readonly settings: ModelTurnSettings;
  readonly conv: Conversation;
  readonly signal: AbortSignal;
  readonly ended: boolean;
  step: number;
  calls: number;
  tokens: number;
  usd: number;
  estimated: boolean;
  servedBy: string | null;
  /** The local server's context for the turn's model, once its model row said (tokens). */
  contextTokens: number | null;
  /** Whether the turn's model reads images: true for cloud models; a local one's once its row or its server said (null until then). */
  images: boolean | null;
  /** Sets what the app learned of the turn's model; its tab's page hears a change. */
  setModelFacts(f: { contextTokens?: number | null; images?: boolean | null }): void;
  /** The limits in force for this step: its tab's page hears them with the step's next result. */
  setUsed(limits: PageLimits): void;
  setState(s: TurnState): void;
  /** A review round starts: logged (`review`) and its tab's page hears it. */
  setReview(round: number, of: number): void;
  end(state: EndState, reason: string, message: string | null): void;
  note(text: string): void;
  onStream(step: number, e: StreamEvent): void;
  discard(step: number): void;
  usage(u: { usd: number; estimated: boolean; dayUsd: number }): void;
  /** A signal for one tool call: Stop and the minutes cap abort it. */
  callSignal(): AbortSignal;
  callDone(): void;
  /** (Re)arms the minutes timer for this limit of active time. */
  armMinutes(limitMs: number, text: string): void;
  activeMs(): number;
  /** How a Stop ends this turn (Stop, a key change, the server stopping). */
  stopEnd(): { state: EndState; reason: string; message: string | null };
}

export interface LoopRegistry {
  selectTools(ctx: ToolCtx): ToolSelection;
  workspaceOf(tab: string): { connected: boolean; reg: WorkspaceRegistration; guide: string; review?: WorkspaceReview | null; tools?: string[] } | null;
  /** The tab's core page registration (C7): where the window is now (the turn follows its tab). */
  coreOf?(tab: string): { connected: boolean; projectId: string; studyId: string; place: CorePlace } | null;
}

export interface LoopDeps {
  createAdapter(s: ModelTurnSettings): ProviderAdapter | Promise<ProviderAdapter>;
  /** The live settings (caps are min'd with the turn's, privacy is read from them). */
  settings(): Promise<AssistantSettings>;
  ledger(): Promise<SpendLedger>;
  registry: LoopRegistry;
  runner: ToolRunner;
  gates: GateBroker;
  /** The project's row (title, created_at), or null when it is not in the projects list. */
  projects(id: string, o: { signal: AbortSignal; turn: string }): Promise<ProjectInfo | null>;
  /** Remembers "Send" for a project and destination. */
  remember(projectId: string, createdAt: string | null, destination: string): Promise<void>;
  clock: Clock;
  /** The wait before the one resend after an overload (tests shorten it). */
  resendDelayMs?: number;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** A cap's words; `dayLeft`: what today's limit leaves, when only the next step's estimate can't fit in it. */
export function capText(reason: CapReason, caps: Caps, dayLeft?: number): string {
  switch (reason) {
    case 'steps':
      return `This turn reached its ${caps.steps}-step limit (Settings → Assistant).`;
    case 'turn_tokens':
      return 'This turn used its token limit.';
    case 'turn_minutes':
      return `Stopped after ${caps.turn_minutes} minute${caps.turn_minutes === 1 ? '' : 's'} of work.`;
    case 'turn_usd':
      return `The next step could go over this turn's ${money(caps.turn_usd)} limit.`;
    case 'day_usd':
      return dayLeft !== undefined && dayLeft >= 0.005
        ? `The next step could go over today's ${money(caps.day_usd)} limit (${money(dayLeft)} left); it resets at midnight.`
        : `Today's ${money(caps.day_usd)} limit is reached; it resets at midnight.`;
  }
}

const grouped = (tokens: number) => String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Where a model turn's requests go, as the person reads it ("Local server at 127.0.0.1"). */
export function destinationLabel(s: Pick<ModelTurnSettings, 'provider' | 'base_url'>): string {
  const label = PROVIDER_LABELS[s.provider] ?? s.provider;
  return s.provider === 'openai_compatible' ? `${label} at ${destinationHost(s.provider, s.base_url)}` : label;
}

/** A local model's context leaves too little room for an answer (the turn ends failed, `context`). */
export function contextText(tokens: number): string {
  return `The local model's context (${grouped(tokens)} tokens) is too small for this conversation: load it with a longer context in the local server, or start a new conversation.`;
}

/** A local server that doesn't say its model's context: the tools fit the unknown budget (noted once a turn). */
export const UNKNOWN_CONTEXT_NOTE = `Magnusim doesn't know this model's context length, so it offers tools up to ${grouped(LOCAL_BUDGET.unknown)} tokens of definitions.`;

/** Not even the pinned tools fit a local model's budget (the turn ends failed, `context`, before its first request). */
export function toolsTooBigText(tokens: number | null): string {
  return tokens
    ? `This model's context (${grouped(tokens)} tokens) is too small for Magnusim's tools. Load it with a longer context.`
    : `Magnusim's tools need more than ${grouped(LOCAL_BUDGET.unknown)} tokens, and this model's context is not known. Load it with a longer context.`;
}

/**
 * The note naming the tools a request left out: a local budget's, with where each is offered
 * (§12.3), or the cloud cap's. Where is said once for each run of tools offered in the same places
 * ("a, b (Home, Workbench); c (Magnusim CAD Part)"), so the note stays within a turn note's 500.
 */
export function droppedNote(sel: ToolSelection, local: boolean, contextTokens: number | null): string {
  if (!local) return `More tools than one request may carry; left out: ${sel.dropped.map((d) => d.name).join(', ')}.`;
  const runs: Array<{ names: string[]; where: string }> = [];
  for (const d of sel.dropped) {
    const where = d.contexts.join(', ');
    const last = runs[runs.length - 1];
    if (last && last.where === where) last.names.push(d.name);
    else runs.push({ names: [d.name], where });
  }
  const list = runs.map((r) => (r.where ? `${r.names.join(', ')} (${r.where})` : r.names.join(', '))).join('; ');
  const fit = contextTokens ? `To fit this model's context (${grouped(contextTokens)} tokens)` : `To fit ${grouped(sel.budget ?? LOCAL_BUDGET.unknown)} tokens of tool definitions`;
  return `${fit}, these tools were left out: ${list}. Load the model with a longer context to have them.`;
}

/** An overload's resend that no longer fits the money left: the turn ends capped. */
class ResendCapped extends Error {
  readonly reason: CapReason;
  constructor(reason: CapReason) {
    super(reason);
    this.reason = reason;
  }
}

/** The caps in force: the lower of the turn's snapshot and the live settings. */
export function effectiveCaps(snapshot: Caps, live: Caps): Caps {
  return {
    turn_usd: Math.min(snapshot.turn_usd, live.turn_usd),
    day_usd: Math.min(snapshot.day_usd, live.day_usd),
    steps: Math.min(snapshot.steps, live.steps),
    turn_minutes: Math.min(snapshot.turn_minutes, live.turn_minutes),
    turn_tokens: Math.min(snapshot.turn_tokens, live.turn_tokens),
  };
}

/** Minutes and tokens, before a step. */
function stepCap(t: LoopTurn, caps: Caps): CapHit | null {
  if (t.activeMs() >= caps.turn_minutes * 60_000) return { reason: 'turn_minutes', text: capText('turn_minutes', caps) };
  if (t.tokens >= caps.turn_tokens) return { reason: 'turn_tokens', text: capText('turn_tokens', caps) };
  return null;
}

/** Steps, minutes and tokens, before a call. */
function callCap(t: LoopTurn, caps: Caps): CapHit | null {
  if (t.calls >= caps.steps) return { reason: 'steps', text: capText('steps', caps) };
  return stepCap(t, caps);
}

/** The request for this step (maxOutputTokens is set from the estimate); its oldest tool results left out (clearedResults). */
export function buildRequest(conv: Conversation, tools: readonly ToolDef[], s: ModelTurnSettings): ProviderRequest {
  const system = [{ text: systemPrompt(), cache: true }];
  if (conv.guide) system.push({ text: guideBlock(conv.guide.text, conv.guide.pluginName), cache: true });
  return {
    model: s.model,
    system,
    messages: [...conv.messages],
    tools: providerTools(tools),
    maxOutputTokens: 0,
    effort: s.effort,
    clearResults: clearedResults(conv.messages),
  };
}

/** The index of the message that holds the tool result at `k` (0: the first), or the list's length past the last. */
function messageOfResult(messages: readonly Message[], k: number): number {
  let seen = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    for (const p of m.parts) {
      if (p.type !== 'tool_result') continue;
      if (seen === k) return i;
      seen += 1;
    }
  }
  return messages.length;
}

/** Characters and images of messages a request adds (for the estimate). */
function freshOf(messages: readonly Message[]): { chars: number; images: Array<{ width: number; height: number }> } {
  let chars = 0;
  const images: Array<{ width: number; height: number }> = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      try {
        chars += JSON.stringify(m.raw.payload ?? m.parts).length;
      } catch {
        chars += 1000;
      }
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'text') chars += p.text.length;
      else if (p.type === 'image') images.push({ width: p.width, height: p.height });
      else if (p.type === 'tool_result') {
        chars += p.text.length;
        for (const im of p.images) images.push({ width: im.width, height: im.height });
      }
    }
  }
  return { chars, images };
}

const isCall = (p: { type: string }): p is ToolCallPart => p.type === 'tool_call';

/** A tool of the turn's own tab's workspace that changes something (edit or destructive): what review rounds count. */
function isWorkspaceEdit(def: ToolDef | undefined, tab: string | null): boolean {
  return !!def && !!tab && def.source.kind === 'workspace' && def.source.tab === tab && (def.risk === 'edit' || def.risk === 'destructive');
}

/** A review round was due, but the turn had reached a limit (its tool calls, minutes or tokens). */
export const REVIEW_NO_ROOM_NOTE = 'No review round: this turn has reached its limits.';

/**
 * The review a turn's workspace asks for: only while its link is connected, and while the window
 * still shows it (a turn that left it with core__show, its Back, has no rounds of its read tools:
 * the window's core page says where it is before the workspace's own link goes).
 */
function reviewAsk(ws: { connected: boolean; review?: WorkspaceReview | null } | null, core: { place: CorePlace } | null = null): WorkspaceReview | null {
  if (core && core.place !== 'workspace') return null;
  return ws && ws.connected && ws.review ? ws.review : null;
}

export const CRASH_DURING = 'The Assistant hit an error while handling this call; it may or may not have run.';
export const CRASH_BEFORE = 'Not run: the Assistant hit an error before this call.';

/**
 * Something threw mid-batch: the calls that ran keep their results, the one in hand may
 * or may not have run, and the rest did not (conv.repair() stays the last resort).
 */
function answerAfterCrash(conv: Conversation, calls: readonly ToolCallPart[], results: readonly ToolResultPart[], inHand: number): void {
  const parts = [...results];
  for (let i = results.length; i < calls.length; i += 1) {
    parts.push(errorResult(calls[i], 'failed', i === inHand ? CRASH_DURING : CRASH_BEFORE).part);
  }
  try {
    conv.append({ role: 'user', parts });
  } catch {
    /* repair() answers them when the turn settles */
  }
}

/** Runs the turn to its end. Errors other than the provider's reach the caller (TurnManager: t.crash). */
export async function runTurn(t: LoopTurn, d: LoopDeps): Promise<void> {
  try {
    await steps(t, d);
  } catch (err) {
    if (t.ended) return;
    if (t.signal.aborted) {
      const s = t.stopEnd();
      t.end(s.state, s.reason, s.message);
      return;
    }
    if (err instanceof ProviderError) {
      t.end('failed', err.code, err.message);
      return;
    }
    throw err;
  }
}

/** Ends the turn as its Stop says, when it was stopped; true then. */
function stoppedNow(t: LoopTurn): boolean {
  if (t.ended) return true;
  if (!t.signal.aborted) return false;
  const s = t.stopEnd();
  t.end(s.state, s.reason, s.message);
  return true;
}

/**
 * Whether the next request may carry the project's data, under the live settings: allowed,
 * remembered, or a question (Send is remembered). Else the turn ends stopped. `first`: no
 * request of this turn has gone yet.
 */
async function requirePrivacy(t: LoopTurn, d: LoopDeps, adapter: ProviderAdapter, project: ProjectInfo, live: AssistantSettings, first: boolean): Promise<boolean> {
  const destination = destinationOf(t.settings);
  const nothing = first ? NOTHING_SENT : NOTHING_MORE_SENT;
  const verdict = privacyDecision(live, { cloud: adapter.cloud, destination, projectId: project.id, createdAt: project.created_at });
  if (verdict === 'allow') return true;
  if (verdict === 'deny') {
    t.end('stopped', 'privacy', nothing);
    return false;
  }
  t.setState('awaiting_consent');
  t.pause();
  let answer: 'allow' | 'deny';
  try {
    answer = await d.gates.ask(
      privacyGate({ turn: t.id, project, provider: t.settings.provider, host: destinationHost(t.settings.provider, t.settings.base_url) }),
      { kind: 'turn', id: t.id, tab: t.showTab },
      t.signal,
    );
  } finally {
    t.resume();
  }
  if (answer !== 'allow' || t.signal.aborted) {
    t.end('stopped', 'privacy', nothing);
    return false;
  }
  // "Always deny" chosen while the question was open wins over its Send.
  if ((await d.settings()).privacy === 'deny') {
    t.end('stopped', 'privacy', nothing);
    return false;
  }
  await d.remember(project.id, project.created_at, destination);
  if (first) t.setState('starting');
  return true;
}

/**
 * Another project's data, or the project list, in one call (core host tools spec C5, §9.2, §9.3):
 * that project's consent for this turn's destination, as requirePrivacy asks for the turn's own.
 * Send is remembered; Don't send answers the call `privacy_declined` and the turn goes on; Always
 * deny is `privacy_denied`. A local, on-PC model is never asked (privacyDecision).
 */
export async function otherProjectPrivacy(
  t: LoopTurn,
  d: LoopDeps,
  cloud: boolean,
  projectId: string,
  signal: AbortSignal,
): Promise<{ code: string; message: string } | null> {
  const destination = destinationOf(t.settings);
  const host = destinationHost(t.settings.provider, t.settings.base_url);
  const list = isProjectList(projectId);
  let project: ProjectInfo | null = null;
  const live = await d.settings();
  if (!cloud || live.privacy === 'allow') return null;
  if (live.privacy === 'deny') return { code: 'privacy_denied', message: privacyDeniedText(t.settings.provider, host) };
  if (!list) {
    try {
      project = await d.projects(projectId, { signal, turn: t.id });
    } catch (err) {
      return { code: 'project_unreadable', message: `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}` };
    }
    if (!project) return { code: 'not_found', message: 'No project has that id. The projects tool lists them.' };
  }
  const key = list ? LIST_CONSENT_KEY : projectId;
  const createdAt = project?.created_at ?? null;
  const verdict = privacyDecision(live, { cloud, destination, projectId: key, createdAt });
  if (verdict === 'allow') return null;
  if (verdict === 'deny') return { code: 'privacy_denied', message: privacyDeniedText(t.settings.provider, host) };
  const gate = project ? privacyGate({ turn: t.id, project, provider: t.settings.provider, host }) : projectListGate({ turn: t.id, provider: t.settings.provider, host });
  t.setState('awaiting_consent');
  t.pause();
  let answer: 'allow' | 'deny';
  try {
    answer = await d.gates.ask(gate, { kind: 'turn', id: t.id, tab: t.showTab }, signal);
  } finally {
    t.resume();
    t.setState('tools');
  }
  if (signal.aborted) return { code: 'stopped', message: 'Stopped by the user before this ran.' };
  if (answer !== 'allow') return { code: 'privacy_declined', message: privacyDeclinedText(project ? project.id : null) };
  // "Always deny" chosen while the question was open wins over its Send.
  if ((await d.settings()).privacy === 'deny') return { code: 'privacy_denied', message: privacyDeniedText(t.settings.provider, host) };
  await d.remember(key, createdAt, destination);
  return null;
}

/**
 * Freezes the tab's guide into a conversation that has sent nothing yet (its system blocks). A
 * guide met later (the window moved to another workspace, often by the model's own core__show)
 * goes once into the next user message instead: appended, so the cached prefix and the model's
 * earlier thinking stay valid. Seen live: from Home the model opened CAD and was told only
 * "start a new conversation". Returns that message text, or null.
 */
function syncGuide(t: LoopTurn, ws: { reg: WorkspaceRegistration; guide: string } | null, fixed: boolean): string | null {
  const conv = t.conv;
  const guide = ws?.guide ?? '';
  const pluginName = ws?.reg.pluginName || ws?.reg.plugin || '';
  if (!fixed && !conv.guide && guide) {
    conv.guide = { text: guide, pluginName };
    return null;
  }
  if (!guide || guide === conv.guide?.text || conv.guidesNoted.has(guide)) return null;
  conv.guidesNoted.add(guide);
  return guideBlock(guide, pluginName);
}

/** A user message's parts with a later guide's text after them (syncGuide). */
function withGuide(parts: UserPart[], guide: string | null): UserPart[] {
  return guide ? [...parts, { type: 'text', text: guide }] : parts;
}

async function steps(t: LoopTurn, d: LoopDeps): Promise<void> {
  if (stoppedNow(t)) return;
  const adapter = await d.createAdapter(t.settings);
  if (stoppedNow(t)) return;
  const conv = t.conv;
  // A turn that crashed or was cut off left calls open: they are answered before anything else.
  conv.repair();
  const workspaceNow = () => (t.tab ? d.registry.workspaceOf(t.tab) : null);

  let project: ProjectInfo | null = null;
  if (t.projectId) {
    try {
      project = await d.projects(t.projectId, { signal: t.signal, turn: t.id });
    } catch (err) {
      if (stoppedNow(t)) return;
      t.end('failed', 'project_unreadable', `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}`);
      return;
    }
    if (stoppedNow(t)) return;
    if (!project) {
      t.end('failed', 'bad_project', 'That project is not in the projects list.');
      return;
    }
  }
  if (adapter.cloud && t.projectId && project) {
    if (!(await requirePrivacy(t, d, adapter, project, await d.settings(), true))) return;
    if (stoppedNow(t)) return;
  }

  const ws = workspaceNow();
  // The conversation's system blocks are fixed by its first request.
  const fixed = conv.messages.length > 0;
  const lateGuide = syncGuide(t, ws, fixed);
  // The adapter's notes once a turn; its strict notes once a conversation (they stay true for
  // every later request: isStrictNote).
  const notedByAdapter = new Set<string>();
  // The person's reference pictures go after the prompt, only once privacy allowed the turn. A
  // local model known not to read images gets none (the adapter's note says so, once a turn).
  let pictures: readonly ImagePart[] = t.promptImages ?? [];
  if (pictures.length && adapter.id === 'openai_compatible' && adapter.readsImages?.(t.settings.model) === false) {
    pictures = [];
    notedByAdapter.add(IMAGES_LEFT_OUT_NOTE);
    t.note(IMAGES_LEFT_OUT_NOTE);
  }
  // Continue in a new chat: the earlier conversation goes after the prompt, once (its first message).
  const carry = fixed ? null : conv.carry;
  let carried: string | null = null;
  if (carry) {
    const getModel = ws ? workspaceToolName(ws.reg.plugin, 'get_model') : null;
    const readTool = getModel && ws?.tools?.includes(getModel) ? getModel : null;
    carried = carryBlock(carry, ws ? 'workspace' : t.projectId ? 'project' : 'home', readTool);
    t.note(carriedNote(carry.prompts.length));
  }
  conv.append({
    role: 'user',
    parts: withGuide([
      { type: 'text', text: t.prompt },
      ...(t.attachments?.length ? [{ type: 'text' as const, text: attachmentLines(t.attachments) }] : []),
      ...pictures.map((p) => ({ ...p })),
      ...(carried ? [{ type: 'text' as const, text: carried }] : []),
      {
        type: 'text',
        text: contextBlock({
          projectId: t.projectId,
          projectTitle: project?.title ?? null,
          simulationId: t.simulationId,
          workspace: ws ? { plugin: ws.reg.plugin, pluginName: ws.reg.pluginName, workspace: ws.reg.workspace } : null,
        }),
      },
    ], lateGuide),
  });

  const priced = adapter.id !== 'openai_compatible';
  const model = t.settings.model;
  let finalStep = false;
  // Why the summing-up request goes: the conversation nearly full (null: the steps cap).
  let finalReason: FullDetail | null = null;
  const label = modelLabel(model);
  let lastTools: ToolDef[] | null = null;
  let prev: EstimateInput['prev'] = null;
  let counted = 0;
  // The tool results the previous request of this turn left out, and whether a request cleared
  // another number than asked (logged once a turn).
  let sentCleared = 0;
  let warnedCleared = false;
  const notedDrops = new Set<string>();
  let notedUnknown = false;
  // Review rounds (the turn's workspace asked for them): its edit tools that succeeded since the
  // turn began or the last round started, and the rounds started (`of` fixed by the first).
  let editedSinceReview = false;
  let reviewRound = 0;
  let reviewOf = 0;
  // Cloud models read images; a local server's model as its adapter knows (null: not known yet).
  const learnImages = () => {
    const known = adapter.id === 'openai_compatible' ? (adapter.readsImages?.(model) ?? null) : true;
    if (known !== null) t.setModelFacts({ images: known });
  };
  // Whether the next step could fill the conversation: the next request's prompt is the last
  // one's and what was added since, as it would be sent (images a model doesn't read left out);
  // its context as far as one turn's money (`turnUsd`) resends it once the cache has expired.
  const nearNow = (turnUsd: number): FullDetail | null => {
    const added = freshOf(sentMessages(conv.messages, clearedResults(conv.messages)).slice(counted));
    return conv.nearlyFull({ promptTokens: conv.promptTokens + estimateTokens(added.chars, t.images === false ? [] : added.images) }, t.settings.base_url, turnUsd);
  };
  // A turn that ends the conversation full: logged with its numbers, and the conversation keeps it.
  const endFull = (d: FullDetail) => {
    if (d.near) conv.closedBy = d;
    alog('info', 'conversation full', { turn: t.id, conversation: conv.id, reason: d.reason, used: d.used, limit: d.limit, near: !!d.near });
    t.end('capped', 'conversation_full', fullText(d, label));
  };
  // Any other limit that ends the turn once the model was asked to sum up: the conversation is
  // full all the same (no later message is taken), and the end says both.
  const endCapped = (reason: string, text: string) => {
    if (!finalReason) return t.end('capped', reason, text);
    alog('info', 'conversation full', { turn: t.id, conversation: conv.id, reason: finalReason.reason, used: finalReason.used, limit: finalReason.limit, near: true, ended_by: reason });
    t.end('capped', 'conversation_full', `${text} ${fullText(finalReason, label)}`);
  };

  for (let step = 1; ; step += 1) {
    if (stoppedNow(t)) return;
    t.step = step;
    const live = await d.settings();
    const caps = effectiveCaps(t.settings.caps, live.caps);
    t.armMinutes(caps.turn_minutes * 60_000, capText('turn_minutes', caps));
    const ledger = priced ? await d.ledger() : null;
    // The money left: the turn's own, and today's (others' requests reserve from it too).
    const turnRoomNow = () => caps.turn_usd - t.usd;
    const dayRoomNow = () => (ledger ? caps.day_usd - (ledger.spentToday() + ledger.reservedToday()) : Number.POSITIVE_INFINITY);
    // What the workspace and app_status hear is left: the smaller of the two, as Settings' limits say.
    const limitsNow = (): PageLimits => ({
      steps: caps.steps,
      usd: caps.turn_usd,
      changes: 0,
      ...(priced ? { usdLeft: Math.max(0, Math.min(turnRoomNow(), dayRoomNow())) } : {}),
    });
    t.setUsed(limitsNow());
    const hit = stepCap(t, caps);
    if (hit) return endCapped(hit.reason, hit.text);
    // A full conversation sends nothing more, but for the request that sums up (it stays within
    // every provider's limits: a step's calls stop before their pictures could pass one).
    // A context counts only for the server that reported it (the turn's address).
    const full = conv.fullDetail(t.settings.base_url, caps.turn_usd);
    if (full && !finalStep) return endFull(full);
    // The turn follows its tab (§9.4): a project opened there since the last step (core__show, or
    // the person) is this step's, and its privacy is asked before this request carries any of it.
    const at = step > 1 && t.tab ? tabHere(d.registry, t.tab) : null;
    const here = at ? { projectId: at.projectId || null, studyId: at.studyId || null } : null;
    if (here && here.projectId !== (t.projectId ?? null)) {
      let next: ProjectInfo | null = null;
      if (here.projectId) {
        try {
          next = await d.projects(here.projectId, { signal: t.signal, turn: t.id });
        } catch (err) {
          if (stoppedNow(t)) return;
          return t.end('failed', 'project_unreadable', `The project could not be read: ${err instanceof Error ? err.message : 'no answer'}`);
        }
        if (stoppedNow(t)) return;
        if (!next) return t.end('failed', 'bad_project', 'That project is not in the projects list.');
      }
      t.follow(here.projectId, here.studyId, next?.title ?? null);
      project = next;
    } else if (here && here.studyId !== (t.simulationId ?? null)) {
      t.follow(here.projectId, here.studyId);
    }
    // Privacy is read live: a change made during the turn holds from this request on.
    if (adapter.cloud && project) {
      if (!(await requirePrivacy(t, d, adapter, project, live, step === 1))) return;
      if (stoppedNow(t)) return;
    }

    // A local server's word on the model's context (cached 60 s), before the tools are chosen:
    // they fit its budget. The turn knows it from now on.
    const row = adapter.modelRow ? await adapter.modelRow(model, t.signal) : null;
    if (stoppedNow(t)) return;
    // What the conversation knew counts only for the server that said it (the address may have changed).
    const contextTokens = row?.context ?? t.contextTokens ?? conv.contextAt(t.settings.base_url);
    if (contextTokens) {
      t.setModelFacts({ contextTokens });
      conv.contextTokens = contextTokens;
      conv.contextBaseUrl = t.settings.base_url;
    }
    learnImages();

    const local = adapter.id === 'openai_compatible';
    const ctx: ToolCtx = {
      tab: t.tab,
      projectId: t.projectId,
      simulationId: t.simulationId,
      cloud: adapter.cloud,
      local,
      // Where the turn's tab is (core host tools spec 11.3): its workspace, else its core page.
      place: placeOf(d.registry, t.tab, t.projectId),
      budgetTokens: local ? localBudget(contextTokens) : null,
      prompt: t.prompt,
      // import_file takes only the files attached to this conversation.
      conversation: conv.id,
      // app_status shows what the turn used so far (read when asked; the AI never changes a limit).
      used: () => t.toolUse?.() ?? null,
      // app_status reports the turn's own provider and model, not the default's.
      assistant: { provider: t.settings.provider, model: t.settings.model },
      // Where what a tool gives goes (chat_history asks before a saved chat goes somewhere else).
      destination: { key: destinationOf(t.settings), label: destinationLabel(t.settings) },
    };
    let tools: ToolDef[];
    if (finalStep && lastTools) {
      // The summing-up request keeps the tool list, so the cached prefix holds.
      tools = lastTools;
    } else {
      if (local && !contextTokens && !notedUnknown) {
        notedUnknown = true;
        t.note(UNKNOWN_CONTEXT_NOTE);
      }
      const sel = d.registry.selectTools(ctx);
      if (sel.tooSmall) {
        // The person may load the model with a longer context: the next turn asks the server again.
        adapter.forgetRow?.(model);
        conv.contextTokens = null;
        return t.end('failed', 'context', toolsTooBigText(contextTokens));
      }
      tools = sel.tools;
      const key = sel.dropped.map((x) => x.name).join(',');
      if (key && !notedDrops.has(key)) {
        notedDrops.add(key);
        t.note(droppedNote(sel, local, contextTokens));
      }
    }
    lastTools = tools;
    const offered = new Map(tools.map((x) => [x.name, x] as const));
    const req = buildRequest(conv, tools, t.settings);
    // What a cached prefix rests on: its system, its tools and the effort (a change rewrites it all).
    const key = createHash('sha256').update(JSON.stringify([req.system, req.tools, req.effort])).digest('hex');
    // A priced turn's first request goes on from the conversation's last one, as many tokens as that
    // sent: a read while its cache is fresh, else written again (prices.ts estimateStep), and written
    // again too when this one sends another system, other tools or another effort (taken as the
    // same size). A local server's room is still its estimate of everything sent (CAD tools spec H5).
    const last = step === 1 && priced ? conv.lastRequest : null;
    if (last) {
      prev = { promptTokens: last.promptTokens, startedAt: last.key === key ? last.startedAt : Number.NEGATIVE_INFINITY, cacheUsed: last.cacheUsed };
      counted = last.messages;
      sentCleared = last.cleared;
    }
    // Nothing of it was sent before: its system and tool definitions are written too.
    const whole = !prev;

    // The spend estimate and the day's reservation (cloud only; a local server costs nothing), on
    // the messages as this request sends them.
    const cleared = req.clearResults ?? 0;
    const sent = sentMessages(conv.messages, cleared);
    const fresh = freshOf(sent.slice(counted));
    // Images a model doesn't read are left out of its request (each as a line of text).
    const seen = (images: Array<{ width: number; height: number }>) => (t.images === false ? [] : images);
    // More results left out than in the previous request: from the first newly left out on, the
    // previous request's prefix no longer holds, and this request writes that part again.
    let jump: { drop: number; rewrite: ReturnType<typeof freshOf> } | null = null;
    if (prev && cleared > sentCleared) {
      const first = messageOfResult(conv.messages, sentCleared);
      const before = freshOf(sentMessages(conv.messages, sentCleared).slice(first, counted));
      jump = { drop: estimateTokens(before.chars, seen(before.images)), rewrite: freshOf(sent.slice(first, counted)) };
    }
    counted = conv.messages.length;
    sentCleared = cleared;
    const systemChars = whole ? req.system.reduce((n, s) => n + s.text.length, 0) : 0;
    const turnRoom = turnRoomNow();
    const dayRoom = dayRoomNow();
    const estimate = (remainingUsd: number) =>
      estimateStep({
        provider: adapter.id,
        model,
        cloud: adapter.cloud,
        fallbackTargets: adapter.fallbackTargets(model),
        newChars: fresh.chars + systemChars,
        newImages: seen(fresh.images),
        toolCount: tools.length,
        firstStep: whole,
        prev,
        ...(jump ? { prevDropTokens: jump.drop, rewriteChars: jump.rewrite.chars, rewriteImages: seen(jump.rewrite.images) } : {}),
        now: d.clock.now(),
        remainingUsd: priced ? remainingUsd : Number.POSITIVE_INFINITY,
        contextTokens: t.contextTokens,
      });
    let est = estimate(Math.min(turnRoom, dayRoom));
    if (est.noRoom && t.contextTokens) {
      // The person may load the model with a longer context: the next turn asks the server again.
      adapter.forgetRow?.(model);
      conv.contextTokens = null;
      return t.end('failed', 'context', contextText(t.contextTokens));
    }
    if (priced && est.capped) {
      // Not even a whole turn's money could send it (the conversation past what one turn resends
      // once its cache has expired): the conversation is full, and goes on in a new one.
      const size = !finalReason && estimate(caps.turn_usd).capped ? conv.nearlyFull({ promptTokens: est.promptTokens }, t.settings.base_url, caps.turn_usd) : null;
      if (size) return endFull(size);
      const reason: CapReason = turnRoom <= dayRoom ? 'turn_usd' : 'day_usd';
      return endCapped(reason, capText(reason, caps, dayRoom));
    }
    let reservation = ledger ? await ledger.reserve(est.usd, { dayCapUsd: caps.day_usd }) : null;
    if (ledger && !reservation) return endCapped('day_usd', capText('day_usd', caps, dayRoomNow()));
    if (t.signal.aborted) {
      if (ledger && reservation) await ledger.settle(reservation, 0);
      stoppedNow(t);
      return;
    }

    t.setState('model');
    const startedAt = d.clock.now();
    let out: ProviderResult | null = null;
    let streamed = false;
    let known: Usage | null = null;
    // An attempt is out (not while waiting to resend after an overload).
    let inFlight = true;
    // Billed for what was sent: the input known so far (else the estimate) and the output reserved.
    const partialCost = () => {
      const k = known as Usage | null;
      return (k ? costOf(est.rates, { ...k, output: 0 }) : est.inputUsd) + (est.maxOut * est.rates.output) / 1e6;
    };
    // The attempt an overload cut short before the one resend: a streamed one was billed.
    let resentCost = 0;
    // What of `cost` the day's ledger already has (the cut attempt, settled before the resend).
    let settled = 0;
    let capEnd: CapReason | null = null;
    let cost = 0;
    let costEstimated = false;
    try {
      out = await sendWithOneResend(
        // The provider debug log's rows name the turn and the step.
        debugScoped(adapter, { turn: t.id, step }),
        { ...req, maxOutputTokens: est.maxOut },
        t.signal,
        (e) => {
          streamed = true;
          if (e.kind === 'usage') known = e.usage;
          t.onStream(step, e);
        },
        {
          onResend: (err) => {
            if (priced && (streamed || err.streamed)) resentCost = partialCost();
            streamed = false;
            known = null;
            inFlight = false;
            t.discard(step);
          },
          // The resend is another request: the cut attempt is settled and what is left is
          // reserved again, so the two together never pass the turn's or the day's limit.
          resendRequest: async (r) => {
            if (priced) {
              if (ledger && reservation) await ledger.settle(reservation, resentCost);
              reservation = null;
              settled = resentCost;
              const turnLeft = caps.turn_usd - t.usd - resentCost;
              const dayLeft = ledger ? caps.day_usd - (ledger.spentToday() + ledger.reservedToday()) : Number.POSITIVE_INFINITY;
              est = estimate(Math.min(turnLeft, dayLeft));
              if (est.capped) throw new ResendCapped(turnLeft <= dayLeft ? 'turn_usd' : 'day_usd');
              reservation = ledger ? await ledger.reserve(est.usd, { dayCapUsd: caps.day_usd }) : null;
              if (ledger && !reservation) throw new ResendCapped('day_usd');
            }
            // Stopped during the ledger writes: the resend is neither sent nor billed.
            if (t.signal.aborted) throw new ProviderError('aborted', 'Stopped.');
            inFlight = true;
            return { ...r, maxOutputTokens: est.maxOut };
          },
          ...(d.resendDelayMs !== undefined ? { delayMs: d.resendDelayMs } : {}),
        },
      );
      if (priced) {
        const c = requestCost(adapter.id, out.attempts, out.cleared?.tokens ?? 0);
        cost = resentCost + c.usd;
        costEstimated = c.estimated || resentCost > 0;
      }
      // This request's tokens count before its usage event is logged.
      const used = promptTokens(out.usage);
      conv.promptTokens = used;
      // The estimate counts on the provider clearing exactly what was asked (its context editing).
      const got = out.cleared?.results ?? 0;
      if (adapter.id === 'anthropic' && got !== cleared && !warnedCleared) {
        warnedCleared = true;
        alog('warn', 'the provider cleared another number of old tool results than asked', { turn: t.id, step, asked: cleared, cleared: got, tokens: out.cleared?.tokens ?? 0 });
      }
      t.tokens += used + out.usage.output;
      prev = { promptTokens: used, startedAt, cacheUsed: out.usage.cacheRead + out.usage.cacheWrite5m + out.usage.cacheWrite1h > 0 };
      conv.lastRequest = { ...prev, messages: counted, cleared, key };
    } catch (err) {
      const aborted = t.signal.aborted || (err instanceof ProviderError && err.code === 'aborted');
      cost = resentCost;
      costEstimated = resentCost > 0;
      if (priced && inFlight && (aborted || streamed || (err instanceof ProviderError && err.streamed))) {
        cost += partialCost();
        costEstimated = true;
      }
      if (aborted || streamed) t.discard(step);
      if (!(err instanceof ResendCapped)) throw err;
      capEnd = err.reason;
    } finally {
      if (ledger && reservation) await ledger.settle(reservation, cost - settled);
      if (cost > 0 || out) {
        t.usd += cost;
        t.estimated ||= costEstimated;
        t.usage({ usd: cost, estimated: costEstimated, dayUsd: ledger ? ledger.spentToday() : 0 });
      }
      t.setUsed(limitsNow());
    }

    if (!out) {
      // Only an overload whose resend no longer fits the money left gets here.
      if (stoppedNow(t)) return;
      const reason = capEnd ?? 'turn_usd';
      return endCapped(reason, capText(reason, caps, dayRoomNow()));
    }
    t.servedBy = out.servedBy || t.servedBy;
    for (const text of out.notes ?? []) {
      const strict = isStrictNote(text);
      const seen = strict ? conv.notesShown : notedByAdapter;
      const key = strict ? strictNoteKey(text) : text;
      if (seen.has(key)) continue;
      seen.add(key);
      t.note(text);
    }
    // A server that refused this request's images: the model is text-only from now on.
    learnImages();

    if (out.stop === 'refusal') {
      t.discard(step);
      return t.end('failed', `refusal:${out.refusal?.category ?? 'none'}`, 'The model declined this request.');
    }
    if (out.stop === 'context') return t.end('failed', 'context', 'This conversation is too long for the model. Start a new one.');
    if (out.stop === 'max_tokens') return endCapped('max_tokens', 'The model ran out of room mid-answer.');

    const calls = out.message.parts.filter(isCall);
    // What this step adds (its answer, its results or a review prompt): nearlyFull's margin.
    const before = conv.counts();
    conv.append(out.message);
    if (!calls.length) {
      if (finalStep) return finalReason ? endFull(finalReason) : t.end('capped', 'steps', capText('steps', caps));
      // The turn's workspace asked for review and its edits went through since the last round:
      // the next round (within the turn's usual caps, checked at the next step).
      const ask = editedSinceReview ? reviewAsk(workspaceNow(), t.tab ? (d.registry.coreOf?.(t.tab) ?? null) : null) : null;
      if (ask && reviewRound < (reviewOf || ask.rounds)) {
        if (stoppedNow(t)) return;
        // A turn already at its limits ends with the answer it has: a round could only be cut short.
        if (callCap(t, caps)) {
          t.note(REVIEW_NO_ROOM_NOTE);
          return t.end('done', 'end_turn', null);
        }
        // Nor in a conversation the round could fill: the answer stands, and the conversation ends here.
        const near = nearNow(caps.turn_usd);
        if (near) {
          t.note(REVIEW_NO_ROOM_FULL_NOTE);
          return endFull(near);
        }
        reviewOf ||= ask.rounds;
        reviewRound += 1;
        editedSinceReview = false;
        t.setReview(reviewRound, reviewOf);
        conv.append({
          role: 'user',
          parts: withGuide([{ type: 'text', text: reviewText(reviewRound, reviewOf, ask.prompt, t.images === false ? 0 : pictures.length) }], syncGuide(t, workspaceNow(), true)),
        });
        conv.noteStep(before);
        continue;
      }
      return t.end('done', 'end_turn', null);
    }

    const results: ToolResultPart[] = [];
    /** The call the runner has in hand (until its result is kept), for a crash. */
    let inHand = -1;
    let declined = false;
    let capped: CapHit | null = finalStep
      ? finalReason
        ? { reason: 'conversation_full', text: fullText(finalReason, label) }
        : { reason: 'steps', text: capText('steps', caps) }
      : null;
    // The pictures the next request would carry, past the conversation's picture limit with one
    // more result's (at most IMAGE_CAPS.perResult): this call and the later ones don't run.
    let roomStop: FullDetail | null = null;
    const pictureRoom = (): FullDetail | null => {
      const lim = conv.limits(t.settings.base_url).find((l) => l.reason === 'images');
      if (!lim) return null;
      const pending = results.reduce((n, p) => n + p.images.length, 0);
      return lim.used + pending + IMAGE_CAPS.perResult > lim.limit ? { ...lim, used: lim.used + pending, near: true } : null;
    };
    const notRun = (call: ToolCallPart, code: string, message: string) => {
      t.emit(toolCallEvent(call, offered.get(call.name) ?? null, step));
      const r = errorResult(call, code, message);
      t.emit({ type: 'tool_result', call: call.callId, ok: false, code, summary: r.summary, ms: 0 });
      results.push(r.part);
    };
    // How many of this answer's calls come after each, and how many of those change the turn's
    // workspace (its edit or destructive tools): the workspace hears it with each call.
    const editsAfter = calls.map(() => 0);
    for (let i = calls.length - 2; i >= 0; i -= 1) editsAfter[i] = editsAfter[i + 1] + (isWorkspaceEdit(offered.get(calls[i + 1].name), t.tab) ? 1 : 0);
    try {
      t.setState('tools');
      for (const [index, call] of calls.entries()) {
        if (t.signal.aborted) {
          notRun(call, 'stopped', stoppedText(false, t.stopEnd().reason === 'shutdown'));
          continue;
        }
        if (!capped) capped = callCap(t, caps);
        if (!capped && (roomStop = pictureRoom())) capped = { reason: 'conversation_full', text: nearlyFullText(roomStop) };
        if (capped) {
          notRun(call, 'capped', `Not run: ${capped.text}`);
          continue;
        }
        if (declined) {
          notRun(call, 'skipped', 'Skipped: an earlier call in this step was declined.');
          continue;
        }
        t.calls += 1;
        inHand = results.length;
        const signal = t.callSignal();
        let r;
        try {
          // Its questions show where the turn shows them; its tools are still only its bound tab's (ctx).
          r = await d.runner.run(call, {
            owner: { kind: 'turn', id: t.id, tab: t.showTab },
            ctx,
            signal,
            turn: t,
            offered,
            step: { n: step, callsLeft: calls.length - 1 - index, editsLeft: editsAfter[index] },
            // Another project's data, or the project list: that consent first (§9.2, §9.3).
            privacyFor: (projectId, callSignal) => otherProjectPrivacy(t, d, adapter.cloud, projectId, callSignal),
          });
        } finally {
          t.callDone();
        }
        if (r.code === 'declined') declined = true;
        if (r.ok && isWorkspaceEdit(offered.get(call.name), t.tab)) editedSinceReview = true;
        // The minutes timer aborted this call (the step it used doesn't make this the steps cap).
        if (callAbortOf(signal)?.code === 'capped') capped = { reason: 'turn_minutes', text: capText('turn_minutes', caps) };
        results.push(r.part);
        inHand = -1;
      }
    } catch (err) {
      answerAfterCrash(conv, calls, results, inHand);
      throw err;
    }
    // Every call answered exactly once, in call order: capped, skipped and stopped ones too.
    // A workspace the calls opened gives its notes with their results (syncGuide).
    conv.append({ role: 'user', parts: withGuide(results, syncGuide(t, workspaceNow(), true)) });
    conv.noteStep(before);
    if (stoppedNow(t)) return;
    if (capped && !(roomStop && !finalStep)) {
      if (capped.reason === 'steps' && !finalStep) {
        finalStep = true;
        t.note('Tool limit reached; asking the model to sum up.');
        continue;
      }
      if (finalReason) return endFull(finalReason);
      return t.end('capped', capped.reason, capped.text);
    }
    // The next step could fill the conversation: the model sums up first, in one more request
    // with the same tools (the cached prefix holds), told so after this step's results. The
    // conversation is full from now on, however this turn ends (a cap, Stop): no later turn
    // starts after the note.
    const near = finalStep ? null : (roomStop ?? nearNow(caps.turn_usd));
    if (near) {
      conv.append({ role: 'user', parts: [{ type: 'text', text: nearlyFullText(near) }] });
      conv.closedBy = near;
      finalStep = true;
      finalReason = near;
      t.note(NEARLY_FULL_NOTE);
    }
  }
}
