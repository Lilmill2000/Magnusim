/**
 * The OpenAI Responses adapter (Foundation spec 5.2), on the openai SDK through
 * loadSdk(). One client per request, with the key, base URL and every credential option
 * explicit (no environment key, admin key, organization, project or base URL is ever
 * read), logging off, and the guarded fetch.
 *
 * - `store: false` is the privacy choice: nothing is kept at the provider and
 *   `previous_response_id` is never used. The conversation is replayed instead: every
 *   output item of each earlier answer, verbatim, including reasoning items with the
 *   `encrypted_content` that `include: ['reasoning.encrypted_content']` asks for.
 * - Tools are strict, with schemas from emitSchema('openai') (every field required,
 *   optional ones nullable); tool_choice auto, parallel calls allowed. A 400 that refuses
 *   a strict schema (STRICT_REFUSED_WORDS, or code invalid_function_parameters) is sent again
 *   with fewer tools strict (the smallest kept) when its words say the set is too big, else
 *   with the workspace's tools `strict: false`, the host's still strict; that tool set goes
 *   so from then on (CAD tools spec H8, common.ts sendStrictOrLoose).
 * - Tool results go back as `function_call_output` items, with images as input_image
 *   parts; the oldest `req.clearResults` of them as a short note with no images
 *   (common.ts sentMessages: only their output changes, the reasoning items go as they came).
 * - Requests stream and are accumulated here; each output item is taken from its
 *   `response.output_item.done` event (the `added` copy may be incomplete).
 * - Headers: only the allowlist leaves, the key only as Authorization.
 */
import { emitSchema } from '../schema.ts';
import { priceRow } from '../prices.ts';
import {
  ProviderError,
  type AssistantPart,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../types.ts';
import { debugCall, type DebugCall } from '../debug-log.ts';
import { dataUrl, emptyUsage, newWatchdog, parseToolInput, requestMessages, SAID_MAX, schemaBytes, SDK_TIMEOUT_MS, sendStrictOrLoose, StrictRefused, tokenCount, type AdapterOptions, type StrictPlan } from './common.ts';
import { mapProviderError, providerSaid, strictSchemaRefusal } from './errors.ts';
import { envHeaderNulls, guardedFetch, type HeaderRule, type Watchdog } from './guarded-fetch.ts';
import { loadSdkClass } from './load-sdk.ts';

const LABEL = 'OpenAI';

/**
 * A 400's words (and its code) when a strict tool schema is refused (CAD tools spec H8):
 * "Invalid schema for function '<name>': …", code invalid_function_parameters.
 */
export const STRICT_REFUSED_WORDS = /invalid schema for function/i;
export const STRICT_REFUSED_CODES: readonly string[] = Object.freeze(['invalid_function_parameters']);

export const OPENAI_HEADERS: readonly HeaderRule[] = Object.freeze([
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  /^x-stainless-[a-z0-9-]+$/,
  'idempotency-key',
]);

type Json = Record<string, unknown>;
type RawEvent = Json & { type?: string };

interface Client {
  responses: { create(body: Json, opts: { signal: AbortSignal }): Promise<AsyncIterable<RawEvent>> };
  /** This SDK takes only the request options here (no params first): `list({signal})`. */
  models: { list(opts: { signal: AbortSignal }): Promise<{ data?: Array<{ id?: unknown }> }> };
}
export type OpenAiCtor = new (opts: Json) => Client;

/** Every credential and address option, explicit, so the SDK reads none from the environment. */
export function openAiClientOptions(key: string, baseURL: string, fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv, maxRetries: number): Json {
  return {
    apiKey: key,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL,
    maxRetries,
    timeout: SDK_TIMEOUT_MS,
    logLevel: 'off',
    fetch,
    defaultHeaders: envHeaderNulls(env, 'OPENAI_CUSTOM_HEADERS'),
  };
}

function toInput(messages: readonly Message[], cleared: number): Json[] {
  const out: Json[] = [];
  for (const m of requestMessages(messages, cleared)) {
    if (m.role === 'assistant') {
      if (m.raw.provider === 'openai' && Array.isArray(m.raw.payload)) out.push(...(m.raw.payload as Json[]));
      else {
        for (const p of m.parts) {
          if (p.type === 'text' && p.text) out.push({ role: 'assistant', content: p.text });
          if (p.type === 'tool_call') out.push({ type: 'function_call', call_id: p.callId, name: p.name, arguments: JSON.stringify(p.input) });
        }
      }
      continue;
    }
    const content: Json[] = [];
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        const output = p.images.length
          ? [{ type: 'input_text', text: p.text }, ...p.images.map((img) => ({ type: 'input_image', image_url: dataUrl(img), detail: 'auto' }))]
          : p.text;
        out.push({ type: 'function_call_output', call_id: p.callId, output });
      } else if (p.type === 'text') content.push({ type: 'input_text', text: p.text });
      else content.push({ type: 'input_image', image_url: dataUrl(p), detail: 'auto' });
    }
    if (content.length) out.push({ role: 'user', content });
  }
  return out;
}

/**
 * The request body (without `stream`), as sent; with `loose` the workspace's tools go
 * `strict: false`, with `strict` exactly those tools go strict (H8).
 */
export function responsesBody(req: ProviderRequest, o: { loose?: boolean; strict?: readonly boolean[] } = {}): Json {
  const instructions = req.system
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  const tools = req.tools.map((t, i): Json => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: emitSchema('openai', t.schema),
    strict: o.strict ? !!o.strict[i] : !(o.loose && t.workspace),
  }));
  return {
    model: req.model,
    ...(instructions ? { instructions } : {}),
    input: toInput(req.messages, req.clearResults ?? 0),
    ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: req.maxOutputTokens,
    ...(req.effort !== 'default' ? { reasoning: { effort: req.effort } } : {}),
  };
}

function toUsage(u: unknown): Usage {
  const r = (u && typeof u === 'object' ? u : null) as Json | null;
  if (!r) return emptyUsage();
  const inDetails = (r.input_tokens_details ?? {}) as Json;
  const outDetails = (r.output_tokens_details ?? {}) as Json;
  const read = tokenCount(inDetails.cached_tokens);
  const write = tokenCount(inDetails.cache_write_tokens);
  return {
    input: Math.max(0, tokenCount(r.input_tokens) - read - write),
    cacheRead: read,
    cacheWrite5m: write,
    cacheWrite1h: 0,
    output: tokenCount(r.output_tokens),
    reasoning: tokenCount(outDetails.reasoning_tokens),
    complete: true,
  };
}

class ResponseAccumulator {
  model = '';
  started = false;
  private items = new Map<number, Json>();
  private final: Json | null = null;
  private incomplete: string | null = null;
  private readonly onEvent: (e: StreamEvent) => void;

  constructor(onEvent: (e: StreamEvent) => void) {
    this.onEvent = onEvent;
  }

  add(ev: RawEvent): void {
    const type = String(ev.type ?? '');
    if (type === 'response.created' || type === 'response.in_progress') {
      this.started = true;
      const r = (ev.response ?? {}) as Json;
      if (typeof r.model === 'string') this.model = r.model;
    } else if (type === 'response.output_item.added') {
      const item = (ev.item ?? {}) as Json;
      if (item.type === 'function_call') this.onEvent({ kind: 'tool_call', callId: String(item.call_id), name: String(item.name) });
    } else if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      if (ev.delta) this.onEvent({ kind: 'text', text: ev.delta });
    } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof ev.delta === 'string') {
      if (ev.delta) this.onEvent({ kind: 'thinking', text: ev.delta });
    } else if (type === 'response.output_item.done') {
      this.items.set(Number(ev.output_index), { ...((ev.item as Json) ?? {}) });
    } else if (type === 'response.completed') {
      this.final = (ev.response ?? {}) as Json;
    } else if (type === 'response.incomplete') {
      this.final = (ev.response ?? {}) as Json;
      this.incomplete = String(((this.final.incomplete_details as Json) ?? {}).reason ?? 'other');
    } else if (type === 'response.failed') {
      const r = (ev.response ?? {}) as Json;
      const e = (r.error ?? {}) as Json;
      // Mapped like an HTTP error with this code (rate_limit_exceeded, server_error, …).
      throw Object.assign(new Error(String(e.message ?? 'The response failed.')), { error: e, type: e.code });
    }
  }

  result(requested: string): ProviderResult {
    if (!this.final) throw new ProviderError('server', `${LABEL} ended the answer early.`, { streamed: this.started });
    const fromDone = [...this.items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    const items = fromDone.length ? fromDone : Array.isArray(this.final.output) ? (this.final.output as Json[]) : [];
    const parts: AssistantPart[] = [];
    let refusal = '';
    let calls = 0;
    for (const item of items) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content as Json[]) {
          if (c.type === 'output_text' && typeof c.text === 'string' && c.text) parts.push({ type: 'text', text: c.text });
          if (c.type === 'refusal' && typeof c.refusal === 'string') refusal += c.refusal;
        }
      } else if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary) ? (item.summary as Json[]).map((s) => String(s.text ?? '')).join('\n') : '';
        if (summary) parts.push({ type: 'thinking', text: summary });
      } else if (item.type === 'function_call') {
        calls += 1;
        const parsed = parseToolInput(String(item.arguments ?? ''));
        parts.push({ type: 'tool_call', callId: String(item.call_id), name: String(item.name), input: parsed.input, ...(parsed.error ? { inputError: parsed.error } : {}) });
      }
    }
    const usage = toUsage(this.final.usage);
    const servedBy = typeof this.final.model === 'string' && this.final.model ? this.final.model : this.model || requested;
    let stop: StopReason;
    let category: string | null = null;
    if (refusal) stop = 'refusal';
    else if (this.incomplete === 'max_output_tokens') stop = 'max_tokens';
    else if (this.incomplete === 'content_filter') {
      stop = 'refusal';
      category = 'content_filter';
    } else if (this.incomplete) stop = 'other';
    else stop = calls ? 'tool_use' : 'end_turn';
    return {
      message: { role: 'assistant', parts, raw: { provider: 'openai', model: servedBy, payload: items } },
      stop,
      usage,
      attempts: [{ model: servedBy, usage, fallback: false }],
      servedBy,
      ...(stop === 'refusal' ? { refusal: { category, explanation: refusal } } : {}),
    };
  }
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|tts|transcribe|image|embedding|search|moderation|dall-e|whisper)/;

export function openAiAdapter(o: AdapterOptions): ProviderAdapter {
  const env = o.env ?? process.env;
  const ctx = (model: string, wd: Watchdog | null, signal: AbortSignal | null, streamed = false) => ({
    provider: 'openai' as const,
    label: LABEL,
    model,
    baseUrl: o.baseURL,
    local: false,
    watchdog: wd,
    signal,
    streamed,
  });

  async function client(key: string, wd: Watchdog, dbg: DebugCall | null = null): Promise<Client> {
    const Ctor = await loadSdkClass<OpenAiCtor>('openai', 'OpenAI');
    const guarded = guardedFetch({
      origin: o.baseURL,
      allowHeaders: OPENAI_HEADERS,
      pin: { authorization: `Bearer ${key}`, 'openai-organization': null, 'openai-project': null },
      watchdog: wd,
      label: LABEL,
    });
    const fetch = dbg ? dbg.fetch(guarded) : guarded;
    return new Ctor(openAiClientOptions(key, o.baseURL, fetch, env, 2));
  }

  return {
    id: 'openai',
    label: LABEL,
    cloud: true,
    destination: 'openai',
    fallbackTargets: () => [],

    async listModels(signal) {
      await loadSdkClass('openai', 'OpenAI');
      return o.borrowKey(async (key) => {
        const wd = newWatchdog(o, false);
        const sig = AbortSignal.any([signal, wd.signal]);
        try {
          const c = await client(String(key), wd);
          const page = await c.models.list({ signal: sig });
          return (page.data ?? [])
            .map((m) => String(m.id ?? ''))
            .filter((id) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id))
            .sort()
            .map((id): ModelInfo => ({ id, label: priceRow(id)?.label ?? id, priced: !!priceRow(id) }));
        } catch (err) {
          throw mapProviderError(err, ctx('', wd, signal));
        } finally {
          wd.done();
        }
      });
    },

    async send(req, signal, onEvent) {
      await loadSdkClass('openai', 'OpenAI');
      // Every tool goes strict on the first try; a loose one leaves the workspace's out (H8).
      const sets = {
        strict: req.tools.map(() => true),
        loose: req.tools.map((t) => !t.workspace),
        bytes: req.tools.map((t) => schemaBytes(emitSchema('openai', t.schema))),
      };
      const attempt = (plan: StrictPlan) =>
        o.borrowKey(async (key) => {
          const body = { ...responsesBody(req, { strict: plan.strict }), stream: true };
          const wd = newWatchdog(o, false);
          const sig = AbortSignal.any([signal, wd.signal]);
          const acc = new ResponseAccumulator(onEvent);
          const dbg = debugCall({ dialect: 'openai', model: req.model, attempt: plan.kind, reason: plan.reason, strict: { count: plan.count, of: plan.of }, body });
          try {
            const c = await client(String(key), wd, dbg);
            const stream = await c.responses.create(body, { signal: sig });
            for await (const ev of stream) {
              acc.add(ev);
              if (sig.aborted) break;
            }
            if (sig.aborted) throw new ProviderError('aborted', 'Stopped.');
            const result = acc.result(req.model);
            dbg?.done(result);
            onEvent({ kind: 'usage', usage: result.usage });
            return result;
          } catch (err) {
            const mapped = mapProviderError(err, ctx(req.model, wd, signal, acc.started));
            dbg?.failed(err, mapped);
            if (plan.kind !== 'loose' && plan.count > 0 && !acc.started && !signal.aborted && mapped.code === 'bad_request' && strictSchemaRefusal(err, STRICT_REFUSED_WORDS, STRICT_REFUSED_CODES)) {
              throw new StrictRefused(mapped, providerSaid(err, SAID_MAX));
            }
            throw mapped;
          } finally {
            wd.done();
          }
        });
      return sendStrictOrLoose('openai', req, sets, attempt);
    },
  };
}
