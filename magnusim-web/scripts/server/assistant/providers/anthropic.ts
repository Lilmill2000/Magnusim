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
 * - Tools are strict, with schemas from emitSchema('anthropic'); tool_choice is auto.
 * - Cache breakpoints: the last tool, the last cached system block, and the last block
 *   of the last message.
 * - Claude Opus 5.5 and Sonnet 5.5 ask for the server-side refusal fallback
 *   (`fallbacks: "default"` with its beta); every attempt is reported with its own model
 *   from `usage.iterations`, so each is priced at its own row.
 * - Effort other than the provider's default goes in `output_config`.
 * - Headers: only the allowlist leaves, the key only as x-api-key, never Authorization.
 */
import { emitSchema } from '../schema.ts';
import { FALLBACK_TARGETS, priceRow } from '../prices.ts';
import {
  ProviderError,
  type AssistantPart,
  type Attempt,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type StopReason,
  type StreamEvent,
  type Usage,
  type UserPart,
} from '../types.ts';
import { newWatchdog, parseToolInput, requestMessages, SDK_TIMEOUT_MS, tokenCount, type AdapterOptions } from './common.ts';
import { mapProviderError } from './errors.ts';
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
  models: { list(params: Json, opts: { signal: AbortSignal }): Promise<{ data?: Array<{ id?: unknown; display_name?: unknown }> }> };
}
type ClientCtor = new (opts: Json) => Client;

const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

/** Every credential and address option, explicit, so the SDK reads none from the environment or a profile. */
export function anthropicClientOptions(key: string, baseURL: string, fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv): Json {
  return {
    apiKey: key,
    authToken: null,
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
  if (m.raw.provider === 'anthropic' && Array.isArray(m.raw.payload)) return m.raw.payload as Json[];
  // Never in practice (a conversation keeps its provider): the visible parts, without thinking.
  const out: Json[] = [];
  for (const p of m.parts) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    if (p.type === 'tool_call') out.push({ type: 'tool_use', id: p.callId, name: p.name, input: p.input });
  }
  return out;
}

/** The request body (without `stream`), as sent. */
export function anthropicBody(req: ProviderRequest): Json {
  const fallback = usesFallback(req.model);
  const sys = req.system.filter((s) => s.text);
  let lastCached = -1;
  sys.forEach((s, i) => {
    if (s.cache) lastCached = i;
  });
  const system = sys.map((s, i): Json => ({ type: 'text', text: s.text, ...(i === lastCached ? { cache_control: EPHEMERAL } : {}) }));
  const messages = requestMessages(req.messages).map((m): Json =>
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
  const tools = req.tools.map(
    (t, i): Json => ({
      name: t.name,
      description: t.description,
      input_schema: emitSchema('anthropic', t.schema),
      strict: true,
      ...(i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }),
  );
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(req.effort !== 'default' ? { output_config: { effort: req.effort } } : {}),
    ...(fallback ? { fallbacks: 'default', betas: [FALLBACK_BETA] } : {}),
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
  private blocks: Json[] = [];
  private json = new Map<number, string>();
  private inputErrors = new Map<number, string>();
  private usage: Json = {};
  private stop: string | null = null;
  private stopDetails: Json | null = null;
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
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
      default:
        break;
    }
  }

  result(requested: string): ProviderResult {
    if (!this.done) throw new ProviderError('server', `${LABEL} ended the answer early.`, { streamed: this.started });
    const blocks = this.blocks.filter(Boolean);
    const parts: AssistantPart[] = [];
    this.blocks.forEach((b, index) => {
      if (!b) return;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') {
        const err = this.inputErrors.get(index);
        parts.push({ type: 'tool_call', callId: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, ...(err ? { inputError: err } : {}) });
      }
    });
    const usage = toUsage(this.usage, true);
    const servedBy = this.model || requested;
    const iterations = Array.isArray(this.usage.iterations) ? (this.usage.iterations as Json[]) : [];
    const billed = iterations.filter((it) => it && (it.type === 'message' || it.type === 'fallback_message'));
    const attempts: Attempt[] = billed.length
      ? billed.map((it, i) => ({
          model: typeof it.model === 'string' && it.model ? it.model : i === 0 ? requested : servedBy,
          usage: toUsage(it, true),
          fallback: it.type === 'fallback_message',
        }))
      : [{ model: servedBy, usage, fallback: false }];
    const stop = STOP[String(this.stop)] ?? 'other';
    const details = this.stopDetails ?? {};
    return {
      message: { role: 'assistant', parts, raw: { provider: 'anthropic', model: servedBy, payload: blocks } },
      stop,
      usage,
      attempts,
      servedBy,
      ...(stop === 'refusal'
        ? { refusal: { category: typeof details.category === 'string' ? details.category : null, explanation: typeof details.explanation === 'string' ? details.explanation : '' } }
        : {}),
    };
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

  async function client(key: string, wd: Watchdog, beta: string | null): Promise<Client> {
    const Ctor = await loadSdkClass<ClientCtor>('@anthropic-ai/sdk', 'Anthropic');
    const fetch = guardedFetch({
      origin: o.baseURL,
      allowHeaders: ANTHROPIC_HEADERS,
      pin: { 'x-api-key': key, authorization: null, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': beta },
      watchdog: wd,
      label: LABEL,
    });
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
      const body = anthropicBody(req);
      return o.borrowKey(async (key) => {
        const wd = newWatchdog(o, false);
        const sig = AbortSignal.any([signal, wd.signal]);
        const acc = new MessageAccumulator(onEvent);
        try {
          const c = await client(String(key), wd, usesFallback(req.model) ? FALLBACK_BETA : null);
          const stream = await c.beta.messages.create({ ...body, stream: true }, { signal: sig });
          for await (const ev of stream) {
            acc.add(ev);
            if (sig.aborted) break;
          }
          // The SDK ends the iteration quietly on an abort: never return a partial answer.
          if (sig.aborted) throw new ProviderError('aborted', 'Stopped.');
          const result = acc.result(req.model);
          onEvent({ kind: 'usage', usage: result.usage });
          return result;
        } catch (err) {
          throw mapProviderError(err, ctx(req.model, wd, signal, acc.started));
        } finally {
          wd.done();
        }
      });
    },
  };
}
