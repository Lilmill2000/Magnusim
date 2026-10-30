/**
 * The Anthropic Messages adapter (Foundation spec 5.2), on @anthropic-ai/sdk through
 * loadSdk(). One client per request, with the key, base URL and every credential option
 * explicit (no profile, environment key, token or base URL is ever read), logging off,
 * and the guarded fetch.
 *
 * Requests stream (`beta.messages.create({stream: true})`) and are accumulated here
 * rather than by the SDK's stream helper, so a tool call whose input is not valid JSON
 * becomes `inputError` (the runner answers it `invalid_input`) instead of failing the
 * whole answer, and the stored payload is exactly the blocks the API sent: thinking
 * blocks with their signatures and fallback blocks are replayed byte for byte.
 *
 * - Tools are strict, with schemas from emitSchema('anthropic'), while the request stays
 *   within the provider's limits on strict tools (STRICT_LIMITS), in the order offered;
 *   the rest go without strict (validateInput still checks every input). tool_choice is auto.
 *   A 400 that says the strict schemas can't be compiled (STRICT_REFUSED_WORDS) is sent again
 *   with fewer tools strict (the smallest kept) when its words say the set is too big, else
 *   with the workspace's tools not strict, the host's still strict; that tool set goes so
 *   from then on (CAD tools spec H8, common.ts sendStrictOrLoose).
 * - Cache breakpoints: the last tool, the last cached system block, and the last block
 *   of the last message.
 * - An answer that came back empty is never sent back: the API refuses an empty assistant
 *   message, or an empty text block, before the last message.
 * - Claude Opus 5.5 and Sonnet 5.5 ask for the server-side refusal fallback
 *   (`fallbacks: "default"` with its beta); every billed attempt is reported with its own
 *   model from `usage.iterations`, so each is priced at its own row (a decline before any
 *   output is not billed in UNBILLED_BEFORE_OUTPUT's categories). The model that served
 *   the answer is the last `fallback_message` attempt there (a turn the primary never ran
 *   in has no fallback block), else the block's target, else the top-level model. After a
 *   decline mid-answer only the declined partial's text stays before the last fallback
 *   block: its tool calls never run and, like its thinking, are not sent back.
 * - Effort other than the provider's default goes in `output_config`.
 * - Old tool results go through the provider's context editing (CONTEXT_MANAGEMENT_BETA, on
 *   every request): with `req.clearResults` (B) above 0 the request asks it to clear the oldest
 *   B results (their pictures with them) and keep the rest. The history goes as stored, so the
 *   model's earlier thinking stays valid. A 400 that names context management is sent once more
 *   without it, and that model goes without it for the rest of the process.
 * - The models list's max_input_tokens is kept per model (prices.ts noteListedContext): a
 *   conversation made after it is full at 80% of that context.
 * - Headers: only the allowlist leaves, the key only as x-api-key, never Authorization.
 */
import { alog } from '../log.ts';
import { emitSchema } from '../schema.ts';
import { FALLBACK_TARGETS, noteListedContext, priceRow } from '../prices.ts';
import { assistantState } from '../state.ts';
import {
  ProviderError,
  type AssistantPart,
  type Attempt,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type ProviderTool,
  type StopReason,
  type StreamEvent,
  type Usage,
  type UserPart,
} from '../types.ts';
import { debugCall, type DebugCall } from '../debug-log.ts';
import { newWatchdog, parseToolInput, requestMessages, SAID_MAX, schemaBytes, SDK_TIMEOUT_MS, sendStrictOrLoose, StrictRefused, tokenCount, type AdapterOptions, type StrictPlan } from './common.ts';
import { mapProviderError, providerSaid, strictSchemaRefusal } from './errors.ts';
import { envHeaderNulls, guardedFetch, type HeaderRule, type Watchdog } from './guarded-fetch.ts';
import { loadSdkClass } from './load-sdk.ts';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_VERSION = '2023-06-01';
const LABEL = 'Anthropic';

export const ANTHROPIC_HEADERS: readonly HeaderRule[] = Object.freeze([
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
  'user-agent',
  /^x-stainless-[a-z0-9-]+$/,
  'idempotency-key',
]);

type Json = Record<string, unknown>;
type RawEvent = Json & { type?: string };

interface Client {
  beta: { messages: { create(body: Json, opts: { signal: AbortSignal }): Promise<AsyncIterable<RawEvent>> } };
  models: { list(params: Json, opts: { signal: AbortSignal }): Promise<{ data?: Array<{ id?: unknown; display_name?: unknown; max_input_tokens?: unknown }> }> };
}
type ClientCtor = new (opts: Json) => Client;

const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

/**
 * Across every strict tool of one request, at most: strict tools, optional parameters and
 * union-type parameters (https://platform.claude.com/docs/en/build-with-claude/structured-outputs,
 * read 2026-10-16). Over any of them the request is refused ("Schema is too complex for
 * compilation").
 */
export const STRICT_LIMITS = Object.freeze({ tools: 20, optional: 24, unions: 16 });

/**
 * A 400's words when the strict tool schemas can't be compiled (CAD tools spec H8). The page
 * above quotes only "Schema is too complex for compilation."; the others (a compile that
 * timed out or grew too large, a strict limit or keyword named) are not quoted there and are
 * matched loosely. The live API also answers a big set with just "Schema is too complex."
 * (seen 2026-10-24, after "The compiled grammar is too large" for a bigger set).
 */
export const STRICT_REFUSED_WORDS = /too complex|compilation timed out|grammar is too large|strict tools?\b/i;

/**
 * Refusal categories whose decline before any output the provider does not bill
 * (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback, read
 * 2026-10-16: only bio, frontier_llm and reasoning_extraction are). A null category is not
 * billed either; any category not named here is, so a new one never makes the spend look
 * lower than the bill.
 */
export const UNBILLED_BEFORE_OUTPUT: ReadonlySet<string> = new Set(['cyber', 'general_harms']);

/** Optional and union-typed parameters of an emitted schema, at every depth. */
function strictWeight(schema: Json): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const visit = (s: unknown): void => {
    if (!s || typeof s !== 'object') return;
    const node = s as Json;
    const props = (node.properties && typeof node.properties === 'object' ? node.properties : {}) as Json;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [name, child] of Object.entries(props)) {
      if (!required.has(name)) optional += 1;
      const c = (child ?? {}) as Json;
      if (Array.isArray(c.type) || Array.isArray(c.anyOf)) unions += 1;
      visit(child);
    }
    visit(node.items);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(visit);
  };
  visit(schema);
  return { optional, unions };
}

/**
 * Which of the request's tools go strict: those strictFlags grants among the ones that may,
 * which with `loose` leaves out the workspace's tools (CAD tools spec H8). The places go group by
 * group as offered (in a workspace its tools first, each by name); among the app's own, the
 * pinned first, then the higher priority, then as offered: `wait` before a Settings tool.
 */
export function strictOf(tools: readonly ProviderTool[], schemas: readonly Json[], loose: boolean): boolean[] {
  const group = (t: ProviderTool) => (t.workspace ? 1 : 0);
  const firstAt = [0, 1].map((g) => tools.findIndex((t) => group(t) === g));
  const rank = (t: ProviderTool) => (t.workspace ? [0, 0] : [Number(!!t.pinned), t.priority ?? 0]);
  const order = tools
    .map((_, i) => i)
    .filter((i) => !(loose && tools[i].workspace))
    .sort((a, b) => {
      const [ra, rb] = [rank(tools[a]), rank(tools[b])];
      return firstAt[group(tools[a])] - firstAt[group(tools[b])] || rb[0] - ra[0] || rb[1] - ra[1] || a - b;
    });
  const granted = strictFlags(order.map((i) => schemas[i]));
  const out = tools.map(() => false);
  order.forEach((i, k) => {
    out[i] = granted[k];
  });
  return out;
}

/** Which of the tools go strict: in the order offered, each one that still fits STRICT_LIMITS. */
export function strictFlags(schemas: readonly Json[]): boolean[] {
  const used = { tools: 0, optional: 0, unions: 0 };
  return schemas.map((s) => {
    const w = strictWeight(s);
    const fits = used.tools + 1 <= STRICT_LIMITS.tools && used.optional + w.optional <= STRICT_LIMITS.optional && used.unions + w.unions <= STRICT_LIMITS.unions;
    if (fits) {
      used.tools += 1;
      used.optional += w.optional;
      used.unions += w.unions;
    }
    return fits;
  });
}

/** Every credential and address option, explicit, so the SDK reads none from the environment or a profile. */
export function anthropicClientOptions(key: string, baseURL: string, fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv): Json {
  return {
    apiKey: key,
    authToken: null,
    webhookKey: null,
    baseURL,
    maxRetries: 2,
    timeout: SDK_TIMEOUT_MS,
    logLevel: 'off',
    fetch,
    defaultHeaders: envHeaderNulls(env, 'ANTHROPIC_CUSTOM_HEADERS'),
  };
}

/** Whether this model asks for the server-side refusal fallback (only the rows marked so; never an unknown id). */
export function usesFallback(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(FALLBACK_TARGETS, model);
}

/**
 * Preserved thinking: a model's thinking block holds only while the system prompt, the tools
 * and every earlier message are unchanged, and accounts made on or after 2026-08-31 get a 400
 * when one comes back after a change. The app changes the tools as its window moves (the
 * place's own set, core host tools spec 12), so a turn that opened a project from Home was
 * refused (seen live, 2026-10-24). With this beta and `drop_block`, the provider drops the
 * blocks that no longer hold, and every one after them, and the request goes on without that
 * reasoning (the provider's migration guide for Claude Fable 5.1, "Breaking changes", preserved
 * thinking: https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).
 */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * Models that think adaptively when `thinking` is left out (the 5 series), so sending
 * `{type: 'adaptive'}` with the binding changes nothing else. Older models are left as they are
 * (`thinking` there would turn thinking on), and their blocks are not bound this way.
 */
export function bindsThinking(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5(?:$|[-.])/.test(model);
}

/**
 * Context editing (https://platform.claude.com/docs/en/build-with-claude/context-editing, read
 * 2026-10-29): `clear_tool_uses_20250919` clears the oldest tool results on the provider's side,
 * before the model reads the request. It never counts as an edit for the thinking binding (the
 * check compares the conversation as sent), and a picture inside a tool result goes with it.
 * The beta goes on every request, so the header stays the same through a conversation.
 */
export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

/** A 400's words when the provider takes no context editing for the request (its beta, or the field). */
export const CONTEXT_MANAGEMENT_WORDS = /context[_-]management/i;

/** Models a 400 named context management for: they go without it until the server starts again (or a test reset). */
const NO_CLEARING = new Set<string>();
const clearingKey = (model: string) => `${assistantState().bootId} ${model}`;

/** Whether requests for this model use context editing (not after a refusal of it in this process). */
export function clearsResults(model: string): boolean {
  return !NO_CLEARING.has(clearingKey(model));
}

function noClearing(model: string): void {
  const boot = `${assistantState().bootId} `;
  for (const k of NO_CLEARING) if (!k.startsWith(boot)) NO_CLEARING.delete(k);
  NO_CLEARING.add(clearingKey(model));
}

/** The request's betas: the fallback's and the thinking binding's, as each applies to the model, and context editing's (`managed`). */
export function betasOf(model: string, managed = true): string[] {
  return [
    ...(usesFallback(model) ? [FALLBACK_BETA] : []),
    ...(bindsThinking(model) ? [THINKING_BINDING_BETA] : []),
    ...(managed ? [CONTEXT_MANAGEMENT_BETA] : []),
  ];
}

/**
 * The context editing that clears the oldest `cleared` of `results` tool results: it fires once
 * more than `results - cleared` are sent (always, then) and keeps that many, so exactly
 * `cleared` go. Tool calls stay (clear_tool_inputs false), and so does thinking.
 */
export function contextManagement(results: number, cleared: number): Json | null {
  const kept = results - cleared;
  if (cleared <= 0 || kept < 0) return null;
  return {
    edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'tool_uses', value: kept }, keep: { type: 'tool_uses', value: kept } }],
  };
}

function userContent(parts: readonly UserPart[]): Json[] {
  return parts.map((p): Json => {
    if (p.type === 'tool_result') {
      const content: Json[] = [{ type: 'text', text: p.text }];
      for (const img of p.images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      return { type: 'tool_result', tool_use_id: p.callId, is_error: p.isError, content };
    }
    if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } };
    return { type: 'text', text: p.text };
  });
}

function assistantContent(m: Extract<Message, { role: 'assistant' }>): Json[] {
  // An empty text block is refused when sent back (the API documents empty end_turn answers).
  if (m.raw.provider === 'anthropic' && Array.isArray(m.raw.payload)) return (m.raw.payload as Json[]).filter((b) => !(b && b.type === 'text' && !b.text));
  // Never in practice (a conversation keeps its provider): the visible parts, without thinking.
  const out: Json[] = [];
  for (const p of m.parts) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    if (p.type === 'tool_call') out.push({ type: 'tool_use', id: p.callId, name: p.name, input: p.input });
  }
  return out;
}

/**
 * The request body (without `stream`), as sent; with `loose` the workspace's tools go without
 * strict, with `strict` exactly those tools go strict (H8); `managed` false: no context editing.
 */
export function anthropicBody(req: ProviderRequest, o: { loose?: boolean; strict?: readonly boolean[]; managed?: boolean } = {}): Json {
  const managed = o.managed ?? true;
  const fallback = usesFallback(req.model);
  const sys = req.system.filter((s) => s.text);
  let lastCached = -1;
  sys.forEach((s, i) => {
    if (s.cache) lastCached = i;
  });
  const system = sys.map((s, i): Json => ({ type: 'text', text: s.text, ...(i === lastCached ? { cache_control: EPHEMERAL } : {}) }));
  // An answer with nothing to send back (no content, or only fallback markers) is left out;
  // the user messages around it are then merged into one.
  const replayed = req.messages.filter((m) => m.role === 'user' || assistantContent(m).some((b) => b && b.type !== 'fallback'));
  const messages = requestMessages(replayed).map((m): Json =>
    m.role === 'assistant' ? { role: 'assistant', content: assistantContent(m) } : { role: 'user', content: userContent(m.parts) },
  );
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const content = [...(last.content as Json[])];
    if (content.length) {
      content[content.length - 1] = { ...content[content.length - 1], cache_control: EPHEMERAL };
      messages[messages.length - 1] = { ...last, content };
    }
  }
  const schemas = req.tools.map((t) => emitSchema('anthropic', t.schema));
  const strict = o.strict ?? strictOf(req.tools, schemas, !!o.loose);
  const tools = req.tools.map(
    (t, i): Json => ({
      name: t.name,
      description: t.description,
      input_schema: schemas[i],
      ...(strict[i] ? { strict: true } : {}),
      ...(i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }),
  );
  const betas = betasOf(req.model, managed);
  const results = messages.reduce((n, m) => n + (m.content as Json[]).filter((b) => b && b.type === 'tool_result').length, 0);
  const editing = managed ? contextManagement(results, req.clearResults ?? 0) : null;
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(bindsThinking(req.model) ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
    ...(editing ? { context_management: editing } : {}),
    ...(req.effort !== 'default' ? { output_config: { effort: req.effort } } : {}),
    ...(fallback ? { fallbacks: 'default' } : {}),
    ...(betas.length ? { betas } : {}),
  };
}

function toUsage(u: unknown, complete: boolean): Usage {
  const r = (u && typeof u === 'object' ? u : {}) as Json;
  const cc = (r.cache_creation && typeof r.cache_creation === 'object' ? r.cache_creation : null) as Json | null;
  const w5 = cc ? tokenCount(cc.ephemeral_5m_input_tokens) : tokenCount(r.cache_creation_input_tokens);
  const w1 = cc ? tokenCount(cc.ephemeral_1h_input_tokens) : 0;
  const details = (r.output_tokens_details && typeof r.output_tokens_details === 'object' ? r.output_tokens_details : {}) as Json;
  return {
    input: tokenCount(r.input_tokens),
    cacheRead: tokenCount(r.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    output: tokenCount(r.output_tokens),
    reasoning: tokenCount(details.thinking_tokens),
    complete,
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  model_context_window_exceeded: 'context',
};

/** Builds the answer from the raw stream events. */
export class MessageAccumulator {
  model = '';
  started = false;
  done = false;
  /** A fallback block announced the switch (the event went out with it). */
  private announced = false;
  private blocks: Json[] = [];
  private json = new Map<number, string>();
  private inputErrors = new Map<number, string>();
  private usage: Json = {};
  private stop: string | null = null;
  private stopDetails: Json | null = null;
  /** What context editing cleared (its applied edits, from the last message_delta). */
  private cleared: { results: number; tokens: number } | null = null;
  private readonly onEvent: (e: StreamEvent) => void;

  constructor(onEvent: (e: StreamEvent) => void) {
    this.onEvent = onEvent;
  }

  add(ev: RawEvent): void {
    switch (ev.type) {
      case 'message_start': {
        const msg = (ev.message ?? {}) as Json;
        this.started = true;
        this.model = String(msg.model ?? '');
        this.usage = { ...((msg.usage as Json) ?? {}) };
        break;
      }
      case 'content_block_start': {
        const index = Number(ev.index);
        const block = { ...((ev.content_block as Json) ?? {}) };
        this.blocks[index] = block;
        if (block.type === 'tool_use') {
          this.json.set(index, '');
          this.onEvent({ kind: 'tool_call', callId: String(block.id), name: String(block.name) });
        } else if (block.type === 'fallback') {
          const from = String(((block.from as Json) ?? {}).model ?? '');
          const to = String(((block.to as Json) ?? {}).model ?? '');
          if (to) this.model = to;
          this.announced = true;
          this.onEvent({ kind: 'fallback', from, to });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(ev.index);
        const block = this.blocks[index];
        const d = (ev.delta ?? {}) as Json;
        if (!block) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          block.text = String(block.text ?? '') + d.text;
          if (d.text) this.onEvent({ kind: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          block.thinking = String(block.thinking ?? '') + d.thinking;
          if (d.thinking) this.onEvent({ kind: 'thinking', text: d.thinking });
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          block.signature = d.signature;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          this.json.set(index, (this.json.get(index) ?? '') + d.partial_json);
        } else if (d.type === 'citations_delta') {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), d.citation];
        }
        break;
      }
      case 'content_block_stop': {
        const index = Number(ev.index);
        const block = this.blocks[index];
        if (block && block.type === 'tool_use' && this.json.has(index)) {
          const parsed = parseToolInput(this.json.get(index) ?? '');
          block.input = parsed.input;
          if (parsed.error) this.inputErrors.set(index, parsed.error);
        }
        break;
      }
      case 'message_delta': {
        const d = (ev.delta ?? {}) as Json;
        if (d.stop_reason !== undefined) this.stop = (d.stop_reason as string | null) ?? null;
        if (d.stop_details !== undefined) this.stopDetails = (d.stop_details as Json | null) ?? null;
        // Cumulative counters: each present one replaces the last.
        for (const [k, v] of Object.entries((ev.usage as Json) ?? {})) if (v !== null && v !== undefined) this.usage[k] = v;
        this.noteCleared(ev.context_management);
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
      default:
        break;
    }
  }

  /** The applied edits of context editing (the final message_delta carries them): what clear_tool_uses cleared. */
  private noteCleared(raw: unknown): void {
    const edits = raw && typeof raw === 'object' ? (raw as Json).applied_edits : null;
    if (!Array.isArray(edits)) return;
    let results = 0;
    let tokens = 0;
    for (const e of edits as Json[]) {
      if (!e || e.type !== 'clear_tool_uses_20250919') continue;
      results += tokenCount(e.cleared_tool_uses);
      tokens += tokenCount(e.cleared_input_tokens);
    }
    this.cleared = { results, tokens };
  }

  result(requested: string): ProviderResult {
    if (!this.done) throw new ProviderError('server', `${LABEL} ended the answer early.`, { streamed: this.started });
    const all = this.blocks.flatMap((b, index) => (b ? [{ b, index }] : []));
    // After a decline mid-answer the fallback model went on from the partial's text alone:
    // whatever else came before the last fallback block (the declined model's tool calls and
    // thinking) is neither run nor sent back.
    const boundary = all.map((x) => x.b.type).lastIndexOf('fallback');
    const kept = all.filter((x, i) => i >= boundary || x.b.type === 'text' || x.b.type === 'fallback');
    const blocks = kept.map((x) => x.b);
    const parts: AssistantPart[] = [];
    for (const { b, index } of kept) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') {
        const err = this.inputErrors.get(index);
        parts.push({ type: 'tool_call', callId: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, ...(err ? { inputError: err } : {}) });
      }
    }
    const usage = toUsage(this.usage, true);
    const iterations = Array.isArray(this.usage.iterations) ? (this.usage.iterations as Json[]) : [];
    // Who served it: the last fallback attempt in usage.iterations when there is one (a
    // turn the primary never ran in carries no fallback block), else the block or the top level.
    const lastFallback = iterations.filter((it) => it && it.type === 'fallback_message' && typeof it.model === 'string' && it.model).at(-1);
    const servedBy = (lastFallback?.model as string | undefined) || this.model || requested;
    if (lastFallback && !this.announced && servedBy !== requested) {
      this.announced = true;
      this.onEvent({ kind: 'fallback', from: requested, to: servedBy });
    }
    const stop = STOP[String(this.stop)] ?? 'other';
    const details = this.stopDetails ?? {};
    // The category an attempt declined in: the fallback block it handed over with, or, for
    // the last one, the refusal's details (undefined: it did not decline, or nobody says why).
    const declinedIn = (model: string, last: boolean): string | null | undefined => {
      if (last) {
        if (stop !== 'refusal' || !this.stopDetails) return undefined;
        return typeof details.category === 'string' ? details.category : null;
      }
      const fb = all.find((x) => x.b.type === 'fallback' && ((x.b.from as Json) ?? {}).model === model);
      const trigger = (fb?.b.trigger ?? null) as Json | null;
      if (!trigger || trigger.type !== 'refusal') return undefined;
      return typeof trigger.category === 'string' ? trigger.category : null;
    };
    // A decline before any output is billed only in some categories (UNBILLED_BEFORE_OUTPUT).
    const billed = (u: Usage, category: string | null | undefined) =>
      !(u.output === 0 && category !== undefined && (category === null || UNBILLED_BEFORE_OUTPUT.has(category)));
    const ran = iterations.filter((it) => it && (it.type === 'message' || it.type === 'fallback_message'));
    const attempts: Attempt[] = [];
    ran.forEach((it, i) => {
      const model = typeof it.model === 'string' && it.model ? it.model : i === 0 ? requested : servedBy;
      const u = toUsage(it, true);
      if (billed(u, declinedIn(model, i === ran.length - 1))) attempts.push({ model, usage: u, fallback: it.type === 'fallback_message' });
    });
    if (!ran.length && billed(usage, declinedIn(servedBy, true))) attempts.push({ model: servedBy, usage, fallback: false });
    return {
      message: { role: 'assistant', parts, raw: { provider: 'anthropic', model: servedBy, payload: blocks } },
      stop,
      usage,
      attempts,
      servedBy,
      ...(stop === 'refusal'
        ? { refusal: { category: typeof details.category === 'string' ? details.category : null, explanation: typeof details.explanation === 'string' ? details.explanation : '' } }
        : {}),
      ...(this.cleared ? { cleared: { ...this.cleared } } : {}),
    };
  }
}

/** A 400 that named context management, before anything streamed. */
class ClearingRefused extends Error {
  readonly said: string;
  constructor(said: string) {
    super(said);
    this.said = said;
  }
}

export function anthropicAdapter(o: AdapterOptions): ProviderAdapter {
  const env = o.env ?? process.env;
  const ctx = (model: string, wd: Watchdog | null, signal: AbortSignal | null, streamed = false) => ({
    provider: 'anthropic' as const,
    label: LABEL,
    model,
    baseUrl: o.baseURL,
    local: false,
    watchdog: wd,
    signal,
    streamed,
  });

  async function client(key: string, wd: Watchdog, beta: string | null, dbg: DebugCall | null = null): Promise<Client> {
    const Ctor = await loadSdkClass<ClientCtor>('@anthropic-ai/sdk', 'Anthropic');
    const guarded = guardedFetch({
      origin: o.baseURL,
      allowHeaders: ANTHROPIC_HEADERS,
      pin: { 'x-api-key': key, authorization: null, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': beta },
      watchdog: wd,
      label: LABEL,
    });
    const fetch = dbg ? dbg.fetch(guarded) : guarded;
    return new Ctor(anthropicClientOptions(key, o.baseURL, fetch, env));
  }

  return {
    id: 'anthropic',
    label: LABEL,
    cloud: true,
    destination: 'anthropic',
    fallbackTargets: (model) => [...(FALLBACK_TARGETS[model] ?? [])],

    async listModels(signal) {
      await loadSdkClass('@anthropic-ai/sdk', 'Anthropic');
      return o.borrowKey(async (key) => {
        const wd = newWatchdog(o, false);
        const sig = AbortSignal.any([signal, wd.signal]);
        try {
          const c = await client(String(key), wd, null);
          const page = await c.models.list({ limit: 100 }, { signal: sig });
          // Each model's context as the provider says it (conversations made from now on use it).
          for (const m of page.data ?? []) if (typeof m.id === 'string' && m.id) noteListedContext('anthropic', m.id, m.max_input_tokens);
          return (page.data ?? [])
            .filter((m) => typeof m.id === 'string' && m.id)
            .map((m): ModelInfo => ({ id: String(m.id), label: typeof m.display_name === 'string' && m.display_name ? m.display_name : String(m.id), priced: !!priceRow(String(m.id)) }));
        } catch (err) {
          throw mapProviderError(err, ctx('', wd, signal));
        } finally {
          wd.done();
        }
      });
    },

    async send(req, signal, onEvent) {
      await loadSdkClass('@anthropic-ai/sdk', 'Anthropic');
      const schemas = req.tools.map((t) => emitSchema('anthropic', t.schema));
      const sets = { strict: strictOf(req.tools, schemas, false), loose: strictOf(req.tools, schemas, true), bytes: schemas.map(schemaBytes) };
      // One request; with context editing (`managed`) a 400 that names it throws ClearingRefused.
      const once = async (key: string, plan: StrictPlan, managed: boolean): Promise<ProviderResult> => {
        const body = { ...anthropicBody(req, { strict: plan.strict, managed }), stream: true };
        const wd = newWatchdog(o, false);
        const sig = AbortSignal.any([signal, wd.signal]);
        const acc = new MessageAccumulator(onEvent);
        const dbg = debugCall({ dialect: 'anthropic', model: req.model, attempt: plan.kind, reason: plan.reason, strict: { count: plan.count, of: plan.of }, body });
        try {
          const c = await client(key, wd, betasOf(req.model, managed).join(',') || null, dbg);
          const stream = await c.beta.messages.create(body, { signal: sig });
          for await (const ev of stream) {
            acc.add(ev);
            if (sig.aborted) break;
          }
          // The SDK ends the iteration quietly on an abort: never return a partial answer.
          if (sig.aborted) throw new ProviderError('aborted', 'Stopped.');
          const result = acc.result(req.model);
          dbg?.done(result);
          onEvent({ kind: 'usage', usage: result.usage });
          return result;
        } catch (err) {
          const mapped = mapProviderError(err, ctx(req.model, wd, signal, acc.started));
          dbg?.failed(err, mapped);
          const before = !acc.started && !signal.aborted && mapped.code === 'bad_request';
          if (managed && before && strictSchemaRefusal(err, CONTEXT_MANAGEMENT_WORDS)) throw new ClearingRefused(providerSaid(err, SAID_MAX));
          if (plan.kind !== 'loose' && plan.count > 0 && before && strictSchemaRefusal(err, STRICT_REFUSED_WORDS)) {
            throw new StrictRefused(mapped, providerSaid(err, SAID_MAX));
          }
          throw mapped;
        } finally {
          wd.done();
        }
      };
      const attempt = (plan: StrictPlan) =>
        o.borrowKey(async (key) => {
          const managed = clearsResults(req.model);
          try {
            return await once(String(key), plan, managed);
          } catch (err) {
            if (!(err instanceof ClearingRefused)) throw err;
            // Nothing reached the model: the same request goes once more, without context editing.
            noClearing(req.model);
            alog('warn', 'the provider refused context editing; this model goes without it until the server starts again', { provider: 'anthropic', model: req.model, said: err.said });
            return once(String(key), plan, false);
          }
        });
      return sendStrictOrLoose('anthropic', req, sets, attempt);
    },
  };
}
