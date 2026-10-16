/**
 * The local-server adapter (Foundation spec 5.2): Chat Completions, as LM Studio and
 * Ollama serve it, on the openai SDK through loadSdk(). The address is the one saved in
 * Settings (loopback, or a remote server the person confirmed); the optional server token
 * is sent as a bearer token ('local' when none is saved, as these servers want one).
 *
 * - No retries (a local server that fails will fail again), a longer first-byte wait (a
 *   model may be loading).
 * - Tools without `strict`, `tool_choice` or `reasoning_effort` (servers differ on all
 *   three), schemas as validated (emitSchema('openai_compatible')).
 * - The stream: `delta.content` is text, `delta.reasoning_content` is thinking (shown,
 *   never sent back), `delta.tool_calls[]` are put together by `index` (`call_<n>` when a
 *   server sends no id). A model that writes a tool call as text instead is flagged
 *   (`toolCallAsText`): its chat template doesn't do tools.
 * - Tool results go back as `tool` messages; images from them follow in one user message
 *   as data: URLs (a tool message holds text only).
 * - It costs nothing.
 */
import { emitSchema } from '../schema.ts';
import {
  ProviderError,
  type AssistantPart,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../types.ts';
import { dataUrl, emptyUsage, looksLikeToolCallText, newWatchdog, parseToolInput, requestMessages, tokenCount, type AdapterOptions } from './common.ts';
import { mapProviderError } from './errors.ts';
import { guardedFetch, type HeaderRule, type Watchdog } from './guarded-fetch.ts';
import { loadSdkClass } from './load-sdk.ts';
import { OPENAI_HEADERS, openAiClientOptions, type OpenAiCtor } from './openai.ts';

const LABEL = 'The local server';

export const COMPAT_HEADERS: readonly HeaderRule[] = OPENAI_HEADERS;

type Json = Record<string, unknown>;
type Chunk = Json & { choices?: Json[]; usage?: Json | null; model?: unknown };

interface Client {
  chat: { completions: { create(body: Json, opts: { signal: AbortSignal }): Promise<AsyncIterable<Chunk>> } };
  models: { list(params: Json, opts: { signal: AbortSignal }): Promise<{ data?: Array<{ id?: unknown }> }> };
}

function toMessages(req: ProviderRequest): Json[] {
  const out: Json[] = [];
  const system = req.system
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of requestMessages(req.messages)) {
    if (m.role === 'assistant') {
      if (m.raw.provider === 'openai_compatible' && m.raw.payload && typeof m.raw.payload === 'object') out.push(m.raw.payload as Json);
      else out.push(assistantMessage(m.parts));
      continue;
    }
    const images: Json[] = [];
    const content: Json[] = [];
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.callId, content: p.text });
        for (const img of p.images) images.push({ type: 'image_url', image_url: { url: dataUrl(img) } });
      } else if (p.type === 'text') content.push({ type: 'text', text: p.text });
      else content.push({ type: 'image_url', image_url: { url: dataUrl(p) } });
    }
    if (images.length) content.unshift({ type: 'text', text: 'Images from the tool results above:' }, ...images);
    if (content.length) out.push({ role: 'user', content: content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n\n') : content });
  }
  return out;
}

/** What a local server is sent back for an answer: its text and tool calls (never its reasoning). */
function assistantMessage(parts: readonly AssistantPart[]): Json {
  const text = parts
    .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const calls = parts.filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call');
  return {
    role: 'assistant',
    content: text || null,
    ...(calls.length
      ? { tool_calls: calls.map((c) => ({ id: c.callId, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
      : {}),
  };
}

/** The request body (without `stream`), as sent. */
export function compatBody(req: ProviderRequest): Json {
  const tools = req.tools.map((t): Json => ({ type: 'function', function: { name: t.name, description: t.description, parameters: emitSchema('openai_compatible', t.schema) } }));
  return {
    model: req.model,
    messages: toMessages(req),
    ...(tools.length ? { tools } : {}),
    stream_options: { include_usage: true },
    max_tokens: req.maxOutputTokens,
  };
}

function toUsage(u: unknown): Usage {
  const r = (u && typeof u === 'object' ? u : null) as Json | null;
  if (!r) return emptyUsage();
  const details = (r.prompt_tokens_details ?? {}) as Json;
  const read = tokenCount(details.cached_tokens);
  const outDetails = (r.completion_tokens_details ?? {}) as Json;
  return {
    input: Math.max(0, tokenCount(r.prompt_tokens) - read),
    cacheRead: read,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: tokenCount(r.completion_tokens),
    reasoning: tokenCount(outDetails.reasoning_tokens),
    complete: true,
  };
}

const FINISH: Record<string, StopReason> = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

class ChunkAccumulator {
  model = '';
  started = false;
  text = '';
  private calls: Array<{ id: string; name: string; args: string; announced: boolean }> = [];
  private finish: string | null = null;
  private usage: Json | null = null;
  private readonly onEvent: (e: StreamEvent) => void;

  constructor(onEvent: (e: StreamEvent) => void) {
    this.onEvent = onEvent;
  }

  add(chunk: Chunk): void {
    this.started = true;
    if (typeof chunk.model === 'string' && chunk.model) this.model = chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      if (Number(choice.index ?? 0) !== 0) continue;
      const d = (choice.delta ?? {}) as Json;
      if (typeof d.content === 'string' && d.content) {
        this.text += d.content;
        this.onEvent({ kind: 'text', text: d.content });
      }
      // Not in the SDK's types: LM Studio's (and others') separate reasoning field. Shown, never sent back.
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) this.onEvent({ kind: 'thinking', text: d.reasoning_content });
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls as Json[]) {
          const index = Number(tc.index ?? this.calls.length);
          const fn = (tc.function ?? {}) as Json;
          const call = (this.calls[index] ??= { id: '', name: '', args: '', announced: false });
          if (typeof tc.id === 'string' && tc.id && !call.id) call.id = tc.id;
          if (typeof fn.name === 'string' && fn.name && !call.name) call.name = fn.name;
          if (typeof fn.arguments === 'string') call.args += fn.arguments;
          if (call.name && !call.announced) {
            call.announced = true;
            if (!call.id) call.id = `call_${index}`;
            this.onEvent({ kind: 'tool_call', callId: call.id, name: call.name });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) this.finish = choice.finish_reason;
    }
  }

  result(requested: string, toolNames: readonly string[]): ProviderResult {
    if (!this.finish) throw new ProviderError('server', `${LABEL} ended the answer early.`, { streamed: this.started });
    const calls = this.calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    const parts: AssistantPart[] = [];
    if (this.text) parts.push({ type: 'text', text: this.text });
    for (const c of calls) {
      const parsed = parseToolInput(c.args);
      parts.push({ type: 'tool_call', callId: c.id, name: c.name, input: parsed.input, ...(parsed.error ? { inputError: parsed.error } : {}) });
    }
    let stop = FINISH[this.finish] ?? 'other';
    if (calls.length && stop === 'end_turn') stop = 'tool_use';
    const usage = toUsage(this.usage);
    if (!this.usage) usage.complete = false;
    const servedBy = this.model || requested;
    const payload: Json = {
      role: 'assistant',
      content: this.text || null,
      ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
    };
    return {
      message: { role: 'assistant', parts, raw: { provider: 'openai_compatible', model: servedBy, payload } },
      stop,
      usage,
      attempts: [{ model: servedBy, usage, fallback: false }],
      servedBy,
      ...(stop === 'refusal' ? { refusal: { category: 'content_filter', explanation: '' } } : {}),
      ...(!calls.length && looksLikeToolCallText(this.text, toolNames) ? { toolCallAsText: true } : {}),
    };
  }
}

export function openAiCompatibleAdapter(o: AdapterOptions & { cloud: boolean; destination: string }): ProviderAdapter {
  const env = o.env ?? process.env;
  const ctx = (model: string, wd: Watchdog | null, signal: AbortSignal | null, streamed = false) => ({
    provider: 'openai_compatible' as const,
    label: LABEL,
    model,
    baseUrl: o.baseURL,
    local: true,
    watchdog: wd,
    signal,
    streamed,
  });

  async function client(token: string | null, wd: Watchdog): Promise<Client> {
    const Ctor = await loadSdkClass<OpenAiCtor>('openai', 'OpenAI');
    const key = token || 'local';
    const fetch = guardedFetch({ origin: o.baseURL, allowHeaders: COMPAT_HEADERS, pin: { authorization: `Bearer ${key}` }, watchdog: wd, label: LABEL });
    return new Ctor(openAiClientOptions(key, o.baseURL, fetch, env, 0)) as unknown as Client;
  }

  return {
    id: 'openai_compatible',
    label: LABEL,
    cloud: o.cloud,
    destination: o.destination,
    fallbackTargets: () => [],

    async listModels(signal) {
      await loadSdkClass('openai', 'OpenAI');
      return o.borrowKey(async (token) => {
        const wd = newWatchdog(o, true);
        const sig = AbortSignal.any([signal, wd.signal]);
        try {
          const c = await client(token, wd);
          const page = await c.models.list({}, { signal: sig });
          return (page.data ?? [])
            .map((m) => String(m.id ?? ''))
            .filter(Boolean)
            .map((id): ModelInfo => ({ id, label: id, priced: true }));
        } catch (err) {
          throw mapProviderError(err, ctx('', wd, signal));
        } finally {
          wd.done();
        }
      });
    },

    async send(req, signal, onEvent) {
      await loadSdkClass('openai', 'OpenAI');
      const body = compatBody(req);
      const toolNames = req.tools.map((t) => t.name);
      return o.borrowKey(async (token) => {
        const wd = newWatchdog(o, true);
        const sig = AbortSignal.any([signal, wd.signal]);
        const acc = new ChunkAccumulator(onEvent);
        try {
          const c = await client(token, wd);
          const stream = await c.chat.completions.create({ ...body, stream: true }, { signal: sig });
          for await (const chunk of stream) {
            acc.add(chunk);
            if (sig.aborted) break;
          }
          if (sig.aborted) throw new ProviderError('aborted', 'Stopped.');
          const result = acc.result(req.model, toolNames);
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
