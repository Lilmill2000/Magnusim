/**
 * One turn of the Assistant (Foundation spec 6.1, 6.2, 6.6): the steps between the
 * person's prompt and the model's last answer.
 *
 *   starting ─ privacy (cloud turns with a project: allowed, remembered, or a question)
 *   for each step:
 *     the caps (minutes, tokens; then the spend estimate and the day's reservation)
 *     privacy again, read live (cloud turns with a project): "Always deny" ends the turn
 *       before this request, forgotten answers ask again
 *     a local server's model row (its context, kept 60 s): the answer gets the room the
 *       prompt leaves; too little → failed (context) before this request, and the row
 *       is read again next turn
 *     whether the model reads images (cloud: yes; a local server: its row's type, or a
 *       refusal remembered); the adapter's notes on how a request went, each once a turn
 *     model: one request with this step's tools (computed by the host, every step)
 *       refusal → failed · context → failed · max_tokens → capped · no calls → done
 *     tools: each call in order, through the runner (only this step's tools resolve)
 *       a cap reached → this and every later call is answered `capped`
 *       a call declined → every later call `skipped`
 *       Stop → every later call `stopped`
 *       a crash → the results so far kept, the rest `failed`, then t.crash
 *     one user message with every result, in call order
 *     steps cap: one more request (same tools, so the cached prefix holds) to sum up
 *
 * Two invariants hold whatever happens (a property test drives random scripts):
 * 1. Stored messages are append-only (conversations.ts).
 * 2. Every tool call of an appended answer has exactly one result in the next user
 *    message: stopped, skipped and capped calls included, even when the turn ends right
 *    after (the next turn's first request carries them).
 *
 * Caps are min(the turn's snapshot, the live settings); privacy is read live.
 */
import { contextBlock, guideBlock, SYSTEM_PROMPT } from './prompt.ts';
import { debugScoped } from './debug-log.ts';
import { destinationOf, sendWithOneResend } from './providers/index.ts';
import { costOf, estimateStep, promptTokens, requestCost, type EstimateInput } from './prices.ts';
import { destinationHost, NOTHING_MORE_SENT, NOTHING_SENT, privacyDecision, privacyGate, type ProjectInfo } from './privacy.ts';
import { providerTools, type ToolCtx, type ToolDef, type WorkspaceRegistration } from './registry.ts';
import { callAbortOf, errorResult, stoppedText, toolCallEvent, type RunnerTurn, type ToolRunner } from './runner.ts';
import type { Caps, AssistantSettings } from './settings.ts';
import type { SpendLedger } from './ledger.ts';
import type { Clock, GateBroker } from './gates.ts';
import type { Conversation } from './conversations.ts';
import { FULL_TEXT } from './conversations.ts';
import {
  ProviderError,
  type Effort,
  type Message,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRequest,
  type ProviderResult,
  type StreamEvent,
  type ToolCallPart,
  type ToolResultPart,
  type Usage,
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
  reason: CapReason;
  text: string;
}

/**
 * The limits a turn's tab's page hears (turns.ts TurnPageView.used), as they are in force: its
 * steps (a coding agent's: its tool calls), its dollars (0: none counted) and a coding agent's
 * changes (0: no such limit).
 */
export interface PageLimits {
  steps: number;
  usd: number;
  changes: number;
}

/** The turn as the loop drives it (turns.ts). */
export interface LoopTurn extends RunnerTurn {
  readonly prompt: string;
  readonly tab: string | null;
  readonly projectId: string | null;
  readonly simulationId: string | null;
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
  selectTools(ctx: ToolCtx): { tools: ToolDef[]; dropped: string[] };
  workspaceOf(tab: string): { connected: boolean; reg: WorkspaceRegistration; guide: string } | null;
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

export function capText(reason: CapReason, caps: Caps): string {
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
      return `Today's ${money(caps.day_usd)} limit is reached; it resets at midnight.`;
  }
}

/** A local model's context leaves too little room for an answer (the turn ends failed, `context`). */
export function contextText(tokens: number): string {
  const n = String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `The local model's context (${n} tokens) is too small for this conversation: load it with a longer context in the local server, or start a new conversation.`;
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

/** The request for this step (maxOutputTokens is set from the estimate). */
export function buildRequest(conv: Conversation, tools: readonly ToolDef[], s: ModelTurnSettings): ProviderRequest {
  const system = [{ text: SYSTEM_PROMPT, cache: true }];
  if (conv.guide) system.push({ text: guideBlock(conv.guide.text, conv.guide.pluginName), cache: true });
  return { model: s.model, system, messages: [...conv.messages], tools: providerTools(tools), maxOutputTokens: 0, effort: s.effort };
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
      { kind: 'turn', id: t.id, tab: t.tab },
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

export const GUIDE_CHANGED_NOTE = "The workspace's notes changed; start a new conversation to use them.";

/** Freezes the tab's guide into a conversation that has sent nothing yet; later changes only get a note. */
function syncGuide(t: LoopTurn, ws: { reg: WorkspaceRegistration; guide: string } | null, fixed: boolean): void {
  const conv = t.conv;
  const guide = ws?.guide ?? '';
  if (!fixed && !conv.guide && guide) {
    conv.guide = { text: guide, pluginName: ws?.reg.pluginName || ws?.reg.plugin || '' };
    return;
  }
  if (!guide || guide === conv.guide?.text || conv.guidesNoted.has(guide)) return;
  conv.guidesNoted.add(guide);
  t.note(GUIDE_CHANGED_NOTE);
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
  syncGuide(t, ws, fixed);
  conv.append({
    role: 'user',
    parts: [
      { type: 'text', text: t.prompt },
      {
        type: 'text',
        text: contextBlock({
          projectId: t.projectId,
          projectTitle: project?.title ?? null,
          simulationId: t.simulationId,
          workspace: ws ? { plugin: ws.reg.plugin, pluginName: ws.reg.pluginName, workspace: ws.reg.workspace } : null,
        }),
      },
    ],
  });

  const priced = adapter.id !== 'openai_compatible';
  const model = t.settings.model;
  let finalStep = false;
  let lastTools: ToolDef[] | null = null;
  let prev: EstimateInput['prev'] = null;
  let counted = 0;
  const notedDrops = new Set<string>();
  const notedByAdapter = new Set<string>();
  // Cloud models read images; a local server's model as its adapter knows (null: not known yet).
  const learnImages = () => {
    const known = adapter.id === 'openai_compatible' ? (adapter.readsImages?.(model) ?? null) : true;
    if (known !== null) t.setModelFacts({ images: known });
  };

  for (let step = 1; ; step += 1) {
    if (stoppedNow(t)) return;
    t.step = step;
    const live = await d.settings();
    const caps = effectiveCaps(t.settings.caps, live.caps);
    t.armMinutes(caps.turn_minutes * 60_000, capText('turn_minutes', caps));
    t.setUsed({ steps: caps.steps, usd: caps.turn_usd, changes: 0 });
    const hit = stepCap(t, caps);
    if (hit) return t.end('capped', hit.reason, hit.text);
    const full = conv.fullReason();
    if (full && full !== 'context') return t.end('failed', 'conversation_full', FULL_TEXT);
    // Privacy is read live: a change made during the turn holds from this request on.
    if (adapter.cloud && project) {
      if (!(await requirePrivacy(t, d, adapter, project, live, step === 1))) return;
      if (stoppedNow(t)) return;
    }
    if (step > 1) syncGuide(t, workspaceNow(), true);

    const ctx: ToolCtx = {
      tab: t.tab,
      projectId: t.projectId,
      simulationId: t.simulationId,
      cloud: adapter.cloud,
      local: adapter.id === 'openai_compatible',
      // app_status reports the turn's own provider and model, not the default's.
      assistant: { provider: t.settings.provider, model: t.settings.model },
    };
    let tools: ToolDef[];
    if (finalStep && lastTools) {
      // The summing-up request keeps the tool list, so the cached prefix holds.
      tools = lastTools;
    } else {
      const sel = d.registry.selectTools(ctx);
      tools = sel.tools;
      const key = sel.dropped.join(',');
      if (key && !notedDrops.has(key)) {
        notedDrops.add(key);
        t.note(`More tools than one request may carry; left out: ${sel.dropped.join(', ')}.`);
      }
    }
    lastTools = tools;
    const offered = new Map(tools.map((x) => [x.name, x] as const));
    const req = buildRequest(conv, tools, t.settings);

    // A local server's word on the model's context (cached 60 s): the turn knows it from now on.
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

    // The spend estimate and the day's reservation (cloud only; a local server costs nothing).
    const fresh = freshOf(conv.messages.slice(counted));
    counted = conv.messages.length;
    const systemChars = step === 1 ? req.system.reduce((n, s) => n + s.text.length, 0) : 0;
    const ledger = priced ? await d.ledger() : null;
    const turnRoom = caps.turn_usd - t.usd;
    const dayRoom = ledger ? caps.day_usd - (ledger.spentToday() + ledger.reservedToday()) : Number.POSITIVE_INFINITY;
    const estimate = (remainingUsd: number) =>
      estimateStep({
        provider: adapter.id,
        model,
        cloud: adapter.cloud,
        fallbackTargets: adapter.fallbackTargets(model),
        newChars: fresh.chars + systemChars,
        // Images a model doesn't read are left out of its request (each as a line of text).
        newImages: t.images === false ? [] : fresh.images,
        toolCount: tools.length,
        firstStep: step === 1,
        prev,
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
      const reason: CapReason = turnRoom <= dayRoom ? 'turn_usd' : 'day_usd';
      return t.end('capped', reason, capText(reason, caps));
    }
    let reservation = ledger ? await ledger.reserve(est.usd, { dayCapUsd: caps.day_usd }) : null;
    if (ledger && !reservation) return t.end('capped', 'day_usd', capText('day_usd', caps));
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
        const c = requestCost(adapter.id, out.attempts);
        cost = resentCost + c.usd;
        costEstimated = c.estimated || resentCost > 0;
      }
      // This request's tokens count before its usage event is logged.
      const used = promptTokens(out.usage);
      conv.promptTokens = used;
      t.tokens += used + out.usage.output;
      prev = { promptTokens: used, startedAt, cacheUsed: out.usage.cacheRead + out.usage.cacheWrite5m + out.usage.cacheWrite1h > 0 };
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
    }

    if (!out) {
      // Only an overload whose resend no longer fits the money left gets here.
      if (stoppedNow(t)) return;
      const reason = capEnd ?? 'turn_usd';
      return t.end('capped', reason, capText(reason, caps));
    }
    t.servedBy = out.servedBy || t.servedBy;
    for (const text of out.notes ?? []) {
      if (notedByAdapter.has(text)) continue;
      notedByAdapter.add(text);
      t.note(text);
    }
    // A server that refused this request's images: the model is text-only from now on.
    learnImages();

    if (out.stop === 'refusal') {
      t.discard(step);
      return t.end('failed', `refusal:${out.refusal?.category ?? 'none'}`, 'The model declined this request.');
    }
    if (out.stop === 'context') return t.end('failed', 'context', 'This conversation is too long for the model. Start a new one.');
    if (out.stop === 'max_tokens') return t.end('capped', 'max_tokens', 'The model ran out of room mid-answer.');

    const calls = out.message.parts.filter(isCall);
    conv.append(out.message);
    if (!calls.length) {
      if (finalStep) return t.end('capped', 'steps', capText('steps', caps));
      return t.end('done', 'end_turn', null);
    }

    const results: ToolResultPart[] = [];
    /** The call the runner has in hand (until its result is kept), for a crash. */
    let inHand = -1;
    let declined = false;
    let capped: CapHit | null = finalStep ? { reason: 'steps', text: capText('steps', caps) } : null;
    const notRun = (call: ToolCallPart, code: string, message: string) => {
      t.emit(toolCallEvent(call, offered.get(call.name) ?? null, step));
      const r = errorResult(call, code, message);
      t.emit({ type: 'tool_result', call: call.callId, ok: false, code, summary: r.summary, ms: 0 });
      results.push(r.part);
    };
    try {
      t.setState('tools');
      for (const call of calls) {
        if (t.signal.aborted) {
          notRun(call, 'stopped', stoppedText(false, t.stopEnd().reason === 'shutdown'));
          continue;
        }
        if (!capped) capped = callCap(t, caps);
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
          r = await d.runner.run(call, { owner: { kind: 'turn', id: t.id, tab: t.tab }, ctx, signal, turn: t, offered });
        } finally {
          t.callDone();
        }
        if (r.code === 'declined') declined = true;
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
    conv.append({ role: 'user', parts: results });
    if (stoppedNow(t)) return;
    if (capped) {
      if (capped.reason === 'steps' && !finalStep) {
        finalStep = true;
        t.note('Tool limit reached; asking the model to sum up.');
        continue;
      }
      return t.end('capped', capped.reason, capped.text);
    }
  }
}
