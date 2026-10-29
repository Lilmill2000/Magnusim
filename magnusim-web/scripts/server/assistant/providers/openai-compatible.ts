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
 *   as data: URLs (a tool message holds text only). The oldest `req.clearResults` of them go
 *   as a short note with no images (common.ts sentMessages).
 * - It costs nothing.
 * - The model's row, best effort (modelRow): LM Studio's `GET <root>/api/v0/models/<id>`
 *   (`<root>` is the base URL without `/v1`), else Ollama's `POST <root>/api/show {model}`.
 *   It gives the context the model was loaded with (else its maximum) and its type; kept
 *   60 s per base URL and model, a miss too (a test reset or a server start forgets it).
 *   A row whose state says the model is not loaded yet is read again each time (its first
 *   request loads it, often with less than its maximum); forgetRow() and a context error
 *   from the server drop a kept row, so a model loaded anew is read again at once.
 * - Images only for a model that reads them (CAD tools spec H6). A row whose type is `llm`
 *   (or `embeddings`) means it doesn't: each image goes as IMAGE_LEFT_OUT instead. With no
 *   such word, images go; a refusal of a request that carries them (a 400 or a server
 *   error whose words name images, never the context or tokens: refusedImages) is sent
 *   once more without them, and when that one is
 *   answered the base URL and model are remembered as text-only (a test reset or a server
 *   start forgets it). Either way the result carries a note for the person.
 */
import { assistantState } from '../state.ts';
import { emitSchema } from '../schema.ts';
import {
  ProviderError,
  type AssistantPart,
  type ModelInfo,
  type ModelRow,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../types.ts';
import { debugCall, type DebugCall } from '../debug-log.ts';
import { dataUrl, emptyUsage, looksLikeToolCallText, newWatchdog, parseToolInput, requestMessages, sentMessages, tokenCount, type AdapterOptions } from './common.ts';
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
  /** This SDK takes only the request options here (no params first): `list({signal})`. */
  models: { list(opts: { signal: AbortSignal }): Promise<{ data?: Array<{ id?: unknown }> }> };
}

/** What a local server gets in place of each image its model doesn't read. */
export const IMAGE_LEFT_OUT = '[An image was left out: the local server does not accept images.]';
/** The note when the server refused a request for its images and the one sent without them was answered. */
export const IMAGES_REFUSED_NOTE = 'The local server refused the images, so the request went again without them; this model gets none from now on.';
/** The note when images were left out from the start (the model's row, or a refusal remembered). */
export const IMAGES_LEFT_OUT_NOTE = "The local model doesn't read images: they are left out of its requests.";

/** Whether any message as sent carries an image (in a tool result or on its own; a left-out result has none). */
function carriesImages(req: ProviderRequest): boolean {
  return sentMessages(req.messages, req.clearResults ?? 0).some(
    (m) => m.role === 'user' && m.parts.some((p) => p.type === 'image' || (p.type === 'tool_result' && p.images.length > 0)),
  );
}

function toMessages(req: ProviderRequest, withImages = true): Json[] {
  const out: Json[] = [];
  const leftOut: Json = { type: 'text', text: IMAGE_LEFT_OUT };
  const system = req.system
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of requestMessages(req.messages, req.clearResults ?? 0)) {
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
        for (const img of p.images) images.push(withImages ? { type: 'image_url', image_url: { url: dataUrl(img) } } : leftOut);
      } else if (p.type === 'text') content.push({ type: 'text', text: p.text });
      else content.push(withImages ? { type: 'image_url', image_url: { url: dataUrl(p) } } : leftOut);
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

/** The request body (without `stream`), as sent; with `images: false` each image is IMAGE_LEFT_OUT. */
export function compatBody(req: ProviderRequest, o: { images?: boolean } = {}): Json {
  const tools = req.tools.map((t): Json => ({ type: 'function', function: { name: t.name, description: t.description, parameters: emitSchema('openai_compatible', t.schema) } }));
  return {
    model: req.model,
    messages: toMessages(req, o.images ?? true),
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

// ---------------------------------------------------------------- the model's row

/** How long a model row (or a server's lack of one) is kept, per base URL and model. */
export const MODEL_ROW_TTL_MS = 60_000;
/** The longest a row read may take (the adapter's first-byte wait when that is shorter). */
export const MODEL_ROW_TIMEOUT_MS = 5_000;
const MODEL_ROW_MAX_BYTES = 1024 * 1024;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** A context length worth believing, in tokens. */
const contextOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 256 && v <= 100_000_000 ? v : null);

/** The server's root: the base URL without its `/v1` (`http://127.0.0.1:1234/v1` → `http://127.0.0.1:1234`). */
export function serverRoot(baseURL: string): string {
  return String(baseURL).replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** An LM Studio-style row (`GET <root>/api/v0/models/<id>`): `loaded_context_length`, else `max_context_length`, and `type`. */
export function lmStudioRow(j: unknown): ModelRow | null {
  if (!isObj(j)) return null;
  const context = contextOf(j.loaded_context_length) ?? contextOf(j.max_context_length);
  const type = typeof j.type === 'string' && /^[a-z0-9_-]{1,32}$/i.test(j.type) ? j.type.toLowerCase() : null;
  return context === null && type === null ? null : { context, type };
}

/**
 * Whether an LM Studio-style row's context is the one the model runs with: its `state` is
 * `loaded`, or it names no state. A model not loaded yet gives only its maximum, and its first
 * request loads it, often with less.
 */
export function lmStudioSettled(j: unknown): boolean {
  return !isObj(j) || j.state === undefined || j.state === 'loaded';
}

/**
 * An Ollama-style row (`POST <root>/api/show {model}`): `num_ctx` from its parameters (what
 * the model runs with), else the model's own `<architecture>.context_length` (its maximum;
 * the server's default may be smaller); `vlm` when its capabilities list vision (or
 * multimodal: llama.cpp's server answers this route too, with ["completion", "multimodal"]
 * for a model loaded with its image projector).
 */
export function ollamaRow(j: unknown): ModelRow | null {
  if (!isObj(j)) return null;
  const info = isObj(j.model_info) ? j.model_info : null;
  const arch = info && typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
  const numCtx = typeof j.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(j.parameters)?.[1] : undefined;
  const context = (numCtx ? contextOf(Number(numCtx)) : null) ?? (info && arch ? contextOf(info[`${arch}.context_length`]) : null);
  const caps = Array.isArray(j.capabilities) ? j.capabilities.filter((c): c is string => typeof c === 'string') : null;
  const type = !caps ? null : caps.includes('vision') || caps.includes('multimodal') ? 'vlm' : caps.includes('completion') ? 'llm' : caps.includes('embedding') ? 'embeddings' : null;
  return context === null && type === null ? null : { context, type };
}

/** A model id as a URL path (its `/` kept; `:` and `@` are allowed in a path); null for an id no path can carry. */
function idPath(model: string): string | null {
  const segments = model.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) return null;
  return segments.map((s) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@')).join('/');
}

/** A response's JSON, or null (not 2xx, too big, not JSON). */
async function jsonOf(res: Response): Promise<unknown> {
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MODEL_ROW_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Rows read, by boot id, base URL and model (a test reset or a server start begins afresh).
 * `settled`: the row's context is the loaded one (or there is no row); an unsettled row is
 * kept only for its type and read again by the next modelRow().
 */
const ROWS = new Map<string, { at: number; row: ModelRow | null; settled: boolean }>();
/** Models whose server refused their images, by the same key: for the process (a test reset or a server start forgets them). */
const TEXT_ONLY = new Set<string>();

/** What a row's type says of images: `vlm` reads them, `llm` and `embeddings` don't; anything else doesn't say. */
export function imagesOfType(type: string | null): boolean | null {
  return type === 'vlm' ? true : type === 'llm' || type === 'embeddings' ? false : null;
}

/** A refusal's words that name images (a model that reads none, or loaded without its image projector). */
const IMAGE_WORDS = /\b(images?|image_url|vision|mmproj|multi-?modal)\b/i;
/** A refusal's words about the request's size: the images are not why it was refused. */
const SIZE_WORDS = /\b(context|tokens?)\b/i;

/**
 * A refusal of a request for its images: a 400 or a server error whose words name images and
 * not the context or tokens. Any other 400 is not one: a request past the context (in words
 * the context check missed) would fit once its images were words, and the model would be
 * taken for one that reads none.
 */
function refusedImages(err: unknown, mapped: ProviderError): boolean {
  const words = err instanceof Error ? err.message : '';
  if (!IMAGE_WORDS.test(words) || SIZE_WORDS.test(words)) return false;
  return (mapped.code === 'bad_request' && mapped.status === 400) || (mapped.code === 'server' && mapped.status !== null);
}

/** A request refused for its images, before anything streamed: sent once more without them. */
class ImagesRefused extends Error {
  readonly mapped: ProviderError;
  constructor(mapped: ProviderError) {
    super(mapped.message);
    this.mapped = mapped;
  }
}

export function openAiCompatibleAdapter(o: AdapterOptions & { cloud: boolean; destination: string; now?: () => number }): ProviderAdapter {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const keyOf = (model: string) => `${assistantState().bootId}\n${o.baseURL}\n${model}`;
  function readsImages(model: string): boolean | null {
    const key = keyOf(model);
    if (TEXT_ONLY.has(key)) return false;
    const kept = ROWS.get(key);
    const t = now();
    return imagesOfType(kept && t - kept.at < MODEL_ROW_TTL_MS && t >= kept.at ? (kept.row?.type ?? null) : null);
  }
  function rememberTextOnly(model: string): void {
    const boot = `${assistantState().bootId}\n`;
    for (const k of TEXT_ONLY) if (!k.startsWith(boot)) TEXT_ONLY.delete(k);
    TEXT_ONLY.add(keyOf(model));
  }
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

  async function client(token: string | null, wd: Watchdog, dbg: DebugCall | null = null): Promise<Client> {
    const Ctor = await loadSdkClass<OpenAiCtor>('openai', 'OpenAI');
    const key = token || 'local';
    const guarded = guardedFetch({ origin: o.baseURL, allowHeaders: COMPAT_HEADERS, pin: { authorization: `Bearer ${key}` }, watchdog: wd, label: LABEL });
    const fetch = dbg ? dbg.fetch(guarded) : guarded;
    return new Ctor(openAiClientOptions(key, o.baseURL, fetch, env, 0)) as unknown as Client;
  }

  /**
   * The row from the server: LM Studio's route first, then Ollama's; null when neither answers
   * with one. `settled` is false for a row of a model not loaded yet.
   */
  async function readRow(token: string | null, model: string, signal: AbortSignal): Promise<{ row: ModelRow | null; settled: boolean }> {
    const fetch = guardedFetch({ origin: o.baseURL, allowHeaders: COMPAT_HEADERS, pin: { authorization: `Bearer ${token || 'local'}` }, label: LABEL });
    const root = serverRoot(o.baseURL);
    const path = idPath(model);
    if (path) {
      const j = await jsonOf(await fetch(`${root}/api/v0/models/${path}`, { headers: { accept: 'application/json' }, signal }));
      const row = lmStudioRow(j);
      if (row) return { row, settled: lmStudioSettled(j) };
    }
    const show = await fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    return { row: ollamaRow(await jsonOf(show)), settled: true };
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
          const page = await c.models.list({ signal: sig });
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
      const toolNames = req.tools.map((t) => t.name);
      const pictures = carriesImages(req);
      const leaveOut = pictures && readsImages(req.model) === false;
      const attempt = (withImages: boolean, reason: string | null) =>
        o.borrowKey(async (token) => {
          const body = { ...compatBody(req, { images: withImages }), stream: true };
          const wd = newWatchdog(o, true);
          const sig = AbortSignal.any([signal, wd.signal]);
          const acc = new ChunkAccumulator(onEvent);
          const dbg = debugCall({ dialect: 'openai_compatible', model: req.model, attempt: !pictures ? 'no_images' : withImages ? 'with_images' : 'without_images', reason, body });
          try {
            const c = await client(token, wd, dbg);
            const stream = await c.chat.completions.create(body, { signal: sig });
            for await (const chunk of stream) {
              acc.add(chunk);
              if (sig.aborted) break;
            }
            if (sig.aborted) throw new ProviderError('aborted', 'Stopped.');
            const result = acc.result(req.model, toolNames);
            dbg?.done(result);
            onEvent({ kind: 'usage', usage: result.usage });
            return result;
          } catch (err) {
            const mapped = mapProviderError(err, ctx(req.model, wd, signal, acc.started));
            dbg?.failed(err, mapped);
            // The server's own context is smaller than the kept row said: the next turn reads it again.
            if (mapped.code === 'context') ROWS.delete(keyOf(req.model));
            if (withImages && pictures && !acc.started && !signal.aborted && refusedImages(err, mapped)) throw new ImagesRefused(mapped);
            throw mapped;
          } finally {
            wd.done();
          }
        });
      try {
        const result = await attempt(!leaveOut, leaveOut ? 'images_left_out' : null);
        return leaveOut ? { ...result, notes: [IMAGES_LEFT_OUT_NOTE] } : result;
      } catch (err) {
        if (!(err instanceof ImagesRefused)) throw err;
      }
      // Once more, each image as words; answered, this model is text-only from now on.
      const result = await attempt(false, 'images_refused');
      rememberTextOnly(req.model);
      return { ...result, notes: [IMAGES_REFUSED_NOTE] };
    },

    async modelRow(model, signal) {
      const t = now();
      for (const [k, v] of ROWS) if (t - v.at >= MODEL_ROW_TTL_MS || t < v.at) ROWS.delete(k);
      const key = keyOf(model);
      const kept = ROWS.get(key);
      if (kept?.settled) return kept.row;
      const timeoutMs = Math.min(MODEL_ROW_TIMEOUT_MS, o.watchdog?.firstByteMs ?? MODEL_ROW_TIMEOUT_MS);
      let read: { row: ModelRow | null; settled: boolean } = { row: null, settled: true };
      try {
        read = await o.borrowKey((token) => readRow(token, model, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])));
      } catch {
        // Unreachable, refused, too slow, a token kept for another address: no row.
        read = { row: null, settled: true };
      }
      // A turn stopped mid-read learns nothing about the server.
      if (!signal.aborted) ROWS.set(key, { at: now(), ...read });
      return read.row;
    },

    forgetRow(model) {
      ROWS.delete(keyOf(model));
    },

    readsImages,
  };
}
