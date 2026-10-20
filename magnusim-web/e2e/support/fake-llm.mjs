// A scripted fake of the Assistant's three model dialects, for node tests and e2e specs
// (Foundation spec 5.4). Plain ESM, no dependencies; the test process starts it and the
// app's real adapters talk to it:
//   cloud adapters  MAGNUSIM_TEST_ASSISTANT=1 + MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL=<base>
//   local server    Settings' base URL = <compatBase>
//
//   POST /anthropic/v1/messages        GET /anthropic/v1/models   (the Messages dialect)
//   POST /openai/v1/responses          GET /openai/v1/models      (the Responses dialect)
//   POST /compat/v1/chat/completions   GET /compat/v1/models      (the local-server dialect)
//   GET /compat/api/v0/models/<id>     POST /compat/api/show      (a local server's model row)
//
// The model rows (CAD tools spec H5) are served for models(list) entries that are rows,
// `{id, context?, max?, type?, route?: 'models' | 'show'}`, in the shapes of
// LOCAL_SERVER_ROWS: by default an LM Studio row at the first route (`context` loaded, so
// state `loaded`; `max` its maximum, alone state `not-loaded`; `type` llm | vlm |
// embeddings), with `route: 'show'` an Ollama one at the second (`context` as num_ctx, `max`
// as the model's context length, vision for vlm); anything else is 404. They take no
// failNext and no hold, and the log calls them `kind: 'model_row'`.
// textOnly(...ids) makes the local server refuse (400, TEXT_ONLY_REFUSAL) a chat request
// for one of those models that carries an image, as a server whose model can't read images
// does (CAD tools spec H6); textOnly() with no ids clears it.
//
// Each chat request takes the next scripted step (reply()) and streams it in that
// dialect's server-sent events. A step:
//   { text?, chunkMs?, thinking?, tools?: [{name, input} | {name, raw}], rawToolText?,
//     usage?: {input, output, cacheRead, cacheWrite}, stop?: 'end_turn'|'tool_use'|'max_tokens'|'refusal',
//     category?, fallback?: '<model id>', fallbackBlock?: false, declined?: {thinking?, text?, tools?, output?},
//     emptyText?, hold?: '<name>', error?: 'overloaded', drop?, end?, delayMs? }
// `hold` stops after the first chunk until release(name); `error` sends an overload error
// event there; `drop` destroys the socket there; `end` ends the answer there, cleanly but
// unfinished; `delayMs` waits before the answer's head.
// A queued step may also be a function `(body) => step` (or a promise of one): the request
// that takes it calls it with a copy of its parsed body, so a step can answer from what the
// request carries (an earlier tool result). The log keeps the step it returned. One that
// throws, or returns no step, is answered 400 "fake-llm: …" (refused, so no client retries
// it into the next step).
//
// Like the real services it answers 400 (naming the rule) when a request breaks a rule:
// - every tool call of an answer is answered in the next request, tool results first
//   (Messages: one user message right after, tool_result blocks first; Responses: a
//   function_call_output per function_call; local: a tool message per call);
// - echoed thinking blocks (signature `sig-<n>`), fallback blocks and reasoning items
//   (`enc-<n>`) are exactly as sent;
// - strict tools use no `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`,
//   `maxItems`, `pattern`, `format` or `title`; every object has additionalProperties:
//   false, and in the Responses dialect every property is required;
// - Messages: at most 20 strict tools, 24 optional and 16 union-type parameters across all
//   strict tools of a request ("Schema is too complex for compilation."); no message with
//   empty content but a final assistant one, and no empty text block;
// - Responses: a reasoning item carries `encrypted_content` only when `include` asks for
//   `reasoning.encrypted_content`, and with `store: false` a replayed one without it is
//   "not found";
// - Messages: `fallbacks` only with the `server-side-fallback-2026-07-01` beta and only for
//   claude-opus-5-5 and claude-sonnet-5-5; no forced tool_choice on those; at most 4
//   cache breakpoints; a key in x-api-key.
// A `fallback` step answers as the fallback model: a `fallback` block first (its trigger
// names `category`, cyber when the step has none; null is kept), the
// top-level model set to it, and usage.iterations with the refused primary attempt and a
// `fallback_message` attempt. With `fallbackBlock: false` it sends no block (a turn the
// primary never ran and declined in): only usage.iterations says a fallback served it.
// With `declined` the primary declines mid-answer: its partial (thinking, text, tool calls;
// `output` tokens, 40 by default) comes first, then the fallback block, then the answer.
// `emptyText` adds a text block that stays empty (an empty answer, with no other step field).
// holdModels(name, dialect?) makes the next model list wait until release(name).
// Each chat request's log entry has `userImages`: the pictures its user messages carry outside
// tool results ({media_type, data}; userImagesOf).
// strictBudget(bytes, dialect = 'anthropic') refuses (400, GRAMMAR_TOO_LARGE) a chat request
// whose strict tools' schemas come to more than `bytes` (each schema's JSON in UTF-8, all
// strict tools of the request together), as the first cloud dialect refuses a strict set too
// big to compile; strictBudget(null, dialect) clears it.
import http from 'node:http';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const STRICT_REFUSED = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'title'];
const DEFAULT_MODELS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'text-embedding-4'],
  compat: ['qwen3.8-27b', 'gemma-4-31b'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A data URL's type and base64 ({media_type, data}), or null. */
function fromDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(typeof url === 'string' ? url : '');
  return m ? { media_type: m[1], data: m[2] } : null;
}

/**
 * The images a chat request carries in its user messages, not in tool results ({media_type,
 * data} each, in order): the person's own pictures. Messages: image blocks of a user message;
 * Responses: input_image parts of a user message; local server: image_url parts of a user
 * message that does not follow tool messages (those carry the tool results' images).
 */
export function userImagesOf(dialect, body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  if (dialect === 'anthropic') {
    for (const m of body.messages || []) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b && b.type === 'image' && b.source) out.push({ media_type: b.source.media_type, data: b.source.data });
    }
  } else if (dialect === 'openai') {
    for (const m of body.input || []) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const c of m.content) if (c && c.type === 'input_image') out.push(fromDataUrl(c.image_url));
    }
  } else {
    const msgs = body.messages || [];
    msgs.forEach((m, i) => {
      if (m.role !== 'user' || !Array.isArray(m.content) || (i > 0 && msgs[i - 1].role === 'tool')) return;
      for (const c of m.content) if (c && c.type === 'image_url') out.push(fromDataUrl(c.image_url && c.image_url.url));
    });
  }
  return out.filter(Boolean);
}

/**
 * The first cloud dialect's refusal of a strict tool set too big to compile (strictBudget()),
 * recorded from its answer to a CAD turn's 21 tools on 2026-10-20 (HTTP 400,
 * invalid_request_error).
 */
export const GRAMMAR_TOO_LARGE = 'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.';

/** Every strict tool schema of a request together, in bytes (strictBudget()). */
function strictBytes(schemas) {
  return schemas.reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s ?? null), 'utf8'), 0);
}

/**
 * The local server's refusal of an image for a model that can't read one (textOnly()). The
 * words are as users report a local server's answer to an image sent to a text-only model;
 * not recorded from a live server.
 */
export const TEXT_ONLY_REFUSAL = 'Model does not support images. Please use a model that does.';

/**
 * llama.cpp's server (llama-server) as it answers a request past its context: HTTP 400 with
 * the type `exceed_context_size_error`, in an older build's words and a newer one's (which
 * name the token counts). Read from its source (tools/server), not recorded from a running
 * server. `multimodalShow` is its answer to Ollama's show route for a model loaded with its
 * image projector, cut to its capabilities, from the same source.
 */
export const LLAMA_SERVER = Object.freeze({
  contextRefusals: [
    { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } },
    {
      error: {
        code: 400,
        message: 'request (40961 tokens) exceeds the available context size (32768 tokens), try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 40961,
        n_ctx: 32768,
      },
    },
  ],
  multimodalShow: { capabilities: ['completion', 'multimodal'] },
});

/**
 * What local servers answer about one model, the shapes the fake serves its rows in.
 * - `lmstudio`, `lmstudioLoaded`: LM Studio's `GET /api/v0/models/<id>`. The fields and the
 *   first row are its REST API v0 docs' (lmstudio.ai/docs/developer/rest/endpoints, read
 *   2026-10-17), whose example model is not loaded. `loaded_context_length` is not in those
 *   docs: the second row is a loaded model's as an LM Studio 0.3.17 user reported it. The
 *   names match the row LM Studio 0.4.24 builds (its app on this PC, read on 2026-10-17
 *   without starting it): id, object, type, publisher, arch, compatibility_type,
 *   quantization, state, max_context_length, loaded_context_length and capabilities. No
 *   answer of a running server is recorded yet: the spec asks for one (a loaded model, one
 *   not loaded, an id with / or @), and it is owed before the phase merges.
 * - `ollama`: Ollama's `POST /api/show {"model": "qwen2.5:7b"}`, recorded from Ollama 0.34.4
 *   on 2026-10-17, cut to the fields around the ones read (license, modelfile, template,
 *   system and most of model_info left out). That model sets no num_ctx, so there is no
 *   `parameters`.
 */
export const LOCAL_SERVER_ROWS = Object.freeze({
  lmstudio: {
    id: 'qwen2-vl-7b-instruct',
    object: 'model',
    type: 'vlm',
    publisher: 'mlx-community',
    arch: 'qwen2_vl',
    compatibility_type: 'mlx',
    quantization: '4bit',
    state: 'not-loaded',
    max_context_length: 32768,
  },
  lmstudioLoaded: {
    id: 'devstral-small-2505-mlx',
    object: 'model',
    type: 'llm',
    publisher: 'lmstudio-community',
    arch: 'mistral',
    compatibility_type: 'mlx',
    quantization: '6bit',
    state: 'loading',
    max_context_length: 131072,
    loaded_context_length: 4096,
  },
  ollama: {
    details: { parent_model: '', format: 'gguf', family: 'qwen2', families: ['qwen2'], parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
    model_info: {
      'general.architecture': 'qwen2',
      'general.basename': 'Qwen2.5',
      'general.finetune': 'Instruct',
      'general.parameter_count': 7615616512,
      'general.size_label': '7B',
      'general.type': 'model',
      'qwen2.attention.head_count': 28,
      'qwen2.block_count': 28,
      'qwen2.context_length': 32768,
      'qwen2.embedding_length': 3584,
    },
    capabilities: ['completion', 'tools'],
    modified_at: '2026-08-27T20:34:33.7397493-05:00',
  },
});

/** A models(list) row as LM Studio's model route answers it. */
function lmStudioRowOf(r) {
  const max = r.max ?? r.context;
  return {
    id: r.id,
    object: 'model',
    type: r.type ?? 'llm',
    publisher: 'fake',
    arch: 'fake',
    compatibility_type: 'gguf',
    quantization: 'Q4_K_M',
    state: r.context ? 'loaded' : 'not-loaded',
    ...(max ? { max_context_length: max } : {}),
    ...(r.context ? { loaded_context_length: r.context } : {}),
  };
}

/** A models(list) row as Ollama's show route answers it. */
function ollamaShowOf(r) {
  const rec = structuredClone(LOCAL_SERVER_ROWS.ollama);
  const max = r.max ?? r.context;
  delete rec.model_info['qwen2.context_length'];
  return {
    ...rec,
    ...(r.context ? { parameters: `num_ctx                        ${r.context}\nstop                           "<|im_end|>"` } : {}),
    model_info: { ...rec.model_info, ...(max ? { 'qwen2.context_length': max } : {}) },
    capabilities: r.type === 'vlm' ? ['completion', 'tools', 'vision'] : r.type === 'embeddings' ? ['embedding'] : ['completion', 'tools'],
  };
}

/** JSON with sorted keys: two blocks are "the same" when these match. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function chunks(text, size = 10) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

class Refusal extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/** Every keyword a strict tool schema may not use, and objects without additionalProperties:false. */
function strictProblems(schema, path, { allRequired }) {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  for (const k of STRICT_REFUSED) if (Object.prototype.hasOwnProperty.call(schema, k)) out.push(`${path}: strict tools do not support "${k}"`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (allRequired) {
      const req = new Set(Array.isArray(schema.required) ? schema.required : []);
      for (const name of Object.keys(props)) if (!req.has(name)) out.push(`${path}: required must include every key in properties: missing "${name}"`);
    }
    for (const [name, sub] of Object.entries(props)) out.push(...strictProblems(sub, `${path}.${name}`, { allRequired }));
  }
  if (schema.items) out.push(...strictProblems(schema.items, `${path}.items`, { allRequired }));
  return out;
}

/** The Messages dialect's limits across every strict tool of one request. */
const STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 };

/** Optional and union-typed (a list of types, or anyOf) parameters of a schema, at every depth. */
function strictWeight(schema) {
  let optional = 0;
  let unions = 0;
  const visit = (s) => {
    if (!s || typeof s !== 'object') return;
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    const req = new Set(Array.isArray(s.required) ? s.required : []);
    for (const [name, sub] of Object.entries(props)) {
      if (!req.has(name)) optional += 1;
      if (sub && typeof sub === 'object' && (Array.isArray(sub.type) || Array.isArray(sub.anyOf))) unions += 1;
      visit(sub);
    }
    if (s.items) visit(s.items);
    if (Array.isArray(s.anyOf)) s.anyOf.forEach(visit);
  };
  visit(schema);
  return { optional, unions };
}

export async function startFakeLlm({ port = 0, host = '127.0.0.1' } = {}) {
  const queue = [];
  const log = [];
  const failures = [];
  const holds = new Map();
  const modelHolds = [];
  const modelLists = { anthropic: [...DEFAULT_MODELS.anthropic], openai: [...DEFAULT_MODELS.openai], compat: [...DEFAULT_MODELS.compat] };
  /** The local server's model rows, by id (models() entries that are rows). */
  const modelRows = new Map();
  /** Local-server models that can't read images (textOnly()). */
  const textOnlyModels = new Set();
  /** Strict schema bytes a request may carry, by dialect (strictBudget()). */
  const strictBudgets = new Map();
  const emitted = { thinking: new Map(), fallback: new Set(), reasoning: new Map() };
  let disconnects = 0;
  let n = 0;
  const next = () => ++n;

  function hold(name) {
    let h = holds.get(name);
    if (!h) {
      h = { released: false, waiters: [] };
      holds.set(name, h);
    }
    return h;
  }

  async function readBody(req) {
    const parts = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024 * 1024) throw new Refusal('request too large', 413);
      parts.push(c);
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Refusal('the body is not JSON');
    }
  }

  function errorBody(dialect, status, message, type) {
    if (dialect === 'anthropic') return { type: 'error', error: { type: type || (status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : 'invalid_request_error'), message } };
    return { error: { message, type: type || 'invalid_request_error', param: null, code: null } };
  }

  // ---------------------------------------------------------------- the rules

  function checkAnthropic(body, headers) {
    if (!headers['x-api-key']) throw new Refusal('x-api-key header is required', 401, 'authentication_error');
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || typeof body.max_tokens !== 'number') {
      throw new Refusal('model, max_tokens and messages are required');
    }
    const betas = String(headers['anthropic-beta'] || '').split(',').map((s) => s.trim());
    if (body.fallbacks !== undefined) {
      if (!betas.includes(FALLBACK_BETA)) throw new Refusal(`fallbacks: requires the ${FALLBACK_BETA} beta`);
      if (!FALLBACK_MODELS.has(body.model)) throw new Refusal(`fallbacks: ${body.model} has no server-side fallback`);
      if (body.fallbacks !== 'default' && !Array.isArray(body.fallbacks)) throw new Refusal('fallbacks: must be "default" or a list');
    }
    if (body.tool_choice && ['any', 'tool'].includes(body.tool_choice.type) && FALLBACK_MODELS.has(body.model)) {
      throw new Refusal(`tool_choice: ${body.tool_choice.type} is not supported with ${body.model}`);
    }
    let breakpoints = 0;
    const countCache = (b) => {
      if (b && typeof b === 'object' && b.cache_control) breakpoints += 1;
    };
    (body.tools || []).forEach(countCache);
    if (Array.isArray(body.system)) body.system.forEach(countCache);
    for (const m of body.messages) if (Array.isArray(m.content)) m.content.forEach(countCache);
    if (breakpoints > 4) throw new Refusal(`A maximum of 4 blocks with cache_control may be provided. Found ${breakpoints}.`);
    const strict = { tools: 0, optional: 0, unions: 0 };
    (body.tools || []).forEach((t, i) => {
      if (t.strict) {
        const p = strictProblems(t.input_schema, `tools.${i}.input_schema`, { allRequired: false });
        if (p.length) throw new Refusal(p[0]);
        const w = strictWeight(t.input_schema);
        strict.tools += 1;
        strict.optional += w.optional;
        strict.unions += w.unions;
      }
    });
    const budget = strictBudgets.get('anthropic');
    if (budget !== undefined && strictBytes((body.tools || []).filter((t) => t.strict).map((t) => t.input_schema)) > budget) throw new Refusal(GRAMMAR_TOO_LARGE);
    if (Object.keys(STRICT_LIMITS).some((k) => strict[k] > STRICT_LIMITS[k])) {
      throw new Refusal(
        `Schema is too complex for compilation. (${strict.tools} strict tools, ${strict.optional} optional and ${strict.unions} union-type parameters; at most ${STRICT_LIMITS.tools}, ${STRICT_LIMITS.optional} and ${STRICT_LIMITS.unions})`,
      );
    }
    body.messages.forEach((m, i) => {
      const content = Array.isArray(m.content) ? m.content : [];
      const empty = typeof m.content === 'string' ? !m.content : !content.length;
      if (empty && !(m.role === 'assistant' && i === body.messages.length - 1)) {
        throw new Refusal(`messages.${i}: all messages must have non-empty content except for the optional final assistant message`);
      }
      if (content.some((b) => b && b.type === 'text' && !b.text)) throw new Refusal(`messages.${i}: text content blocks must be non-empty`);
      if (m.role === 'assistant') {
        for (const b of content) {
          if (b.type === 'thinking') {
            const sent = emitted.thinking.get(b.signature);
            if (!sent || sent !== canonical(b)) throw new Refusal(`messages.${i}: thinking blocks in the latest assistant turn must be passed back unchanged`);
          }
          if (b.type === 'fallback' && !emitted.fallback.has(canonical(b))) throw new Refusal(`messages.${i}: a fallback block was changed`);
        }
        const ids = content.filter((b) => b.type === 'tool_use').map((b) => b.id);
        if (ids.length) {
          const nextMsg = body.messages[i + 1];
          const nextContent = nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content) ? nextMsg.content : [];
          const lead = [];
          for (const b of nextContent) {
            if (b.type !== 'tool_result') break;
            lead.push(b.tool_use_id);
          }
          const missing = ids.filter((id) => !lead.includes(id));
          if (missing.length) {
            throw new Refusal(`messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${missing.join(', ')}`);
          }
          if (nextContent.slice(lead.length).some((b) => b.type === 'tool_result')) throw new Refusal(`messages.${i + 1}: tool_result blocks must come first`);
        }
      } else if (m.role === 'user') {
        const prev = body.messages[i - 1];
        const known = new Set(prev && prev.role === 'assistant' && Array.isArray(prev.content) ? prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : []);
        for (const b of content) {
          if (b.type === 'tool_result' && !known.has(b.tool_use_id)) throw new Refusal(`messages.${i}: unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}`);
        }
      }
    });
  }

  function checkResponses(body, headers) {
    if (!/^Bearer \S+/.test(String(headers.authorization || ''))) throw new Refusal('Missing bearer authentication in header', 401, 'invalid_api_key');
    if (!body || typeof body.model !== 'string') throw new Refusal('model is required');
    (body.tools || []).forEach((t, i) => {
      if (t.type === 'function' && t.strict) {
        const p = strictProblems(t.parameters, `tools[${i}].parameters`, { allRequired: true });
        if (p.length) throw new Refusal(`Invalid schema for function '${t.name}': ${p[0]}`);
      }
    });
    const budget = strictBudgets.get('openai');
    if (budget !== undefined && strictBytes((body.tools || []).filter((t) => t.type === 'function' && t.strict).map((t) => t.parameters)) > budget) throw new Refusal(GRAMMAR_TOO_LARGE);
    const input = Array.isArray(body.input) ? body.input : [];
    const outputs = new Set(input.filter((it) => it && it.type === 'function_call_output').map((it) => it.call_id));
    const calls = new Set();
    for (const it of input) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'function_call') {
        calls.add(it.call_id);
        if (!outputs.has(it.call_id)) throw new Refusal(`No tool output found for function call ${it.call_id}.`);
      }
      if (it.type === 'function_call_output' && !calls.has(it.call_id)) throw new Refusal(`No tool call found for function call output with call_id ${it.call_id}.`);
      if (it.type === 'reasoning') {
        if (!it.encrypted_content) {
          if (body.store === false) throw new Refusal(`Item with id '${it.id}' not found. Items are not persisted when \`store\` is set to false.`, 404);
        } else if (emitted.reasoning.get(it.id) !== canonical(it)) {
          throw new Refusal(`The reasoning item ${it.id} was changed.`);
        }
      }
    }
  }

  function checkCompat(body) {
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) throw new Refusal('model and messages are required');
    if (textOnlyModels.has(body.model) && body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === 'image_url'))) {
      throw new Refusal(TEXT_ONLY_REFUSAL);
    }
    body.messages.forEach((m, i) => {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const answered = [];
        for (const later of body.messages.slice(i + 1)) {
          if (later.role !== 'tool') break;
          answered.push(later.tool_call_id);
        }
        const missing = m.tool_calls.map((c) => c.id).filter((id) => !answered.includes(id));
        if (missing.length) throw new Refusal(`messages.${i}: tool calls without a tool message right after: ${missing.join(', ')}`);
      }
      if (m.role === 'tool' && typeof m.content !== 'string' && !(Array.isArray(m.content) && m.content.every((c) => c.type === 'text'))) {
        throw new Refusal(`messages.${i}: a tool message holds text only`);
      }
    });
  }

  // ---------------------------------------------------------------- streaming

  /** Runs the step's interruption at the first chunk: 'go' to carry on, 'stop' when the answer ended there. */
  async function checkpoint(step, res, closed, onError) {
    if (step.hold) {
      const h = hold(step.hold);
      if (!h.released) await Promise.race([new Promise((r) => h.waiters.push(r)), closed]);
    }
    if (res.destroyed || res.writableEnded) return 'stop';
    if (step.drop) {
      // Let what was written reach the client first, so the answer had begun.
      await new Promise((r) => res.write('', () => r()));
      await sleep(50);
      res.socket?.destroy();
      return 'stop';
    }
    if (step.end) {
      res.end();
      return 'stop';
    }
    if (step.error === 'overloaded') {
      onError();
      res.end();
      return 'stop';
    }
    return 'go';
  }

  function usageOf(step) {
    const u = step.usage || {};
    return { input: u.input ?? 120, output: u.output ?? 30, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
  }

  async function streamAnthropic(step, body, res, closed) {
    const u = usageOf(step);
    const write = (event, data) => {
      if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const id = `msg_fake_${next()}`;
    const declined = step.fallback && step.declined ? step.declined : null;
    write('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        // A decline mid-answer comes after the start, which named the requested model.
        model: declined ? body.model : step.fallback || body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
      },
    });
    write('ping', { type: 'ping' });
    let index = 0;
    let checked = false;
    const firstChunk = async () => {
      if (checked) return 'go';
      checked = true;
      return checkpoint(step, res, closed, () => write('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    };
    if (declined) {
      // The requested model's partial answer, before it declined.
      if (typeof declined.thinking === 'string') {
        const signature = `sig-${next()}`;
        emitted.thinking.set(signature, canonical({ type: 'thinking', thinking: declined.thinking, signature }));
        write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: declined.thinking } });
        write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
        write('content_block_stop', { type: 'content_block_stop', index });
        index += 1;
      }
      if (declined.text) {
        write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: declined.text } });
        write('content_block_stop', { type: 'content_block_stop', index });
        index += 1;
      }
      for (const t of declined.tools || []) {
        write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fake_${next()}`, name: t.name, input: {} } });
        write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input ?? {}) } });
        write('content_block_stop', { type: 'content_block_stop', index });
        index += 1;
      }
    }
    if (step.emptyText) {
      write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      write('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    if (step.fallback && step.fallbackBlock !== false) {
      const block = { type: 'fallback', from: { model: body.model }, to: { model: step.fallback }, trigger: { type: 'refusal', category: 'category' in step ? step.category : 'cyber' } };
      emitted.fallback.add(canonical(block));
      write('content_block_start', { type: 'content_block_start', index, content_block: block });
      write('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    if (typeof step.thinking === 'string') {
      const signature = `sig-${next()}`;
      emitted.thinking.set(signature, canonical({ type: 'thinking', thinking: step.thinking, signature }));
      write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const piece of chunks(step.thinking)) write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } });
      write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
      write('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    if (step.text || step.rawToolText) {
      const text = `${step.text || ''}${step.rawToolText || ''}`;
      write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of chunks(text)) {
        write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
        if ((await firstChunk()) === 'stop') return;
        if (step.chunkMs) await sleep(step.chunkMs);
      }
      write('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    if ((await firstChunk()) === 'stop') return;
    for (const t of step.tools || []) {
      const json = t.raw !== undefined ? String(t.raw) : JSON.stringify(t.input ?? {});
      write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fake_${next()}`, name: t.name, input: {} } });
      for (const piece of chunks(json, 7)) write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
      write('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    const stop = step.stop || ((step.tools || []).length ? 'tool_use' : 'end_turn');
    const stopDetails =
      stop === 'refusal'
        ? { type: 'refusal', category: step.category ?? null, explanation: 'The fake declined.', fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null }
        : null;
    const usage = { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite };
    if (step.fallback) {
      usage.iterations = [
        { type: 'message', model: body.model, input_tokens: u.input, output_tokens: declined ? (declined.output ?? 40) : 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        { type: 'fallback_message', model: step.fallback, ...usage, cache_creation: null },
      ];
    }
    write('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, stop_details: stopDetails }, usage });
    write('message_stop', { type: 'message_stop' });
    res.end();
  }

  async function streamResponses(step, body, res, closed) {
    const u = usageOf(step);
    let seq = 0;
    const write = (data) => {
      if (!res.destroyed && !res.writableEnded) res.write(`event: ${data.type}\ndata: ${JSON.stringify({ ...data, sequence_number: seq++ })}\n\n`);
    };
    const include = Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
    const response = { id: `resp_fake_${next()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, output: [], usage: null };
    write({ type: 'response.created', response: { ...response, status: 'in_progress' } });
    const items = [];
    let checked = false;
    const firstChunk = async () => {
      if (checked) return 'go';
      checked = true;
      return checkpoint(step, res, closed, () => write({ type: 'error', code: 'server_is_overloaded', message: 'The server is overloaded.', param: null }));
    };
    if (typeof step.thinking === 'string') {
      const id = `rs_fake_${next()}`;
      const output_index = items.length;
      write({ type: 'response.output_item.added', output_index, item: { type: 'reasoning', id, summary: [] } });
      for (const piece of chunks(step.thinking)) write({ type: 'response.reasoning_summary_text.delta', item_id: id, output_index, summary_index: 0, delta: piece });
      const item = { type: 'reasoning', id, summary: [{ type: 'summary_text', text: step.thinking }], ...(include ? { encrypted_content: `enc-${next()}` } : {}) };
      emitted.reasoning.set(id, canonical(item));
      write({ type: 'response.output_item.done', output_index, item });
      items.push(item);
    }
    const refusal = step.stop === 'refusal';
    if (step.text || refusal) {
      const id = `msg_fake_${next()}`;
      const output_index = items.length;
      const text = step.text || 'I can’t help with that.';
      write({ type: 'response.output_item.added', output_index, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } });
      const part = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
      write({ type: 'response.content_part.added', item_id: id, output_index, content_index: 0, part });
      for (const piece of chunks(text)) {
        write({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: id, output_index, content_index: 0, delta: piece });
        if ((await firstChunk()) === 'stop') return;
        if (step.chunkMs) await sleep(step.chunkMs);
      }
      const done = refusal ? { type: 'refusal', refusal: text } : { type: 'output_text', text, annotations: [] };
      write({ type: refusal ? 'response.refusal.done' : 'response.output_text.done', item_id: id, output_index, content_index: 0, ...(refusal ? { refusal: text } : { text }) });
      write({ type: 'response.content_part.done', item_id: id, output_index, content_index: 0, part: done });
      const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [done] };
      write({ type: 'response.output_item.done', output_index, item });
      items.push(item);
    }
    if ((await firstChunk()) === 'stop') return;
    for (const t of step.tools || []) {
      const id = `fc_fake_${next()}`;
      const call_id = `call_fake_${next()}`;
      const output_index = items.length;
      const args = t.raw !== undefined ? String(t.raw) : JSON.stringify(t.input ?? {});
      write({ type: 'response.output_item.added', output_index, item: { type: 'function_call', id, call_id, name: t.name, arguments: '', status: 'in_progress' } });
      for (const piece of chunks(args, 7)) write({ type: 'response.function_call_arguments.delta', item_id: id, output_index, delta: piece });
      write({ type: 'response.function_call_arguments.done', item_id: id, output_index, arguments: args });
      const item = { type: 'function_call', id, call_id, name: t.name, arguments: args, status: 'completed' };
      write({ type: 'response.output_item.done', output_index, item });
      items.push(item);
    }
    const usage = {
      input_tokens: u.input + u.cacheRead + u.cacheWrite,
      input_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
      output_tokens: u.output,
      output_tokens_details: { reasoning_tokens: typeof step.thinking === 'string' ? Math.min(u.output, 10) : 0 },
      total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
    };
    if (step.stop === 'max_tokens') {
      write({ type: 'response.incomplete', response: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: items, usage } });
    } else {
      write({ type: 'response.completed', response: { ...response, status: 'completed', output: items, usage } });
    }
    res.end();
  }

  async function streamCompat(step, body, res, closed) {
    const u = usageOf(step);
    const id = `chatcmpl-fake-${next()}`;
    const write = (data) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    write(chunk({ role: 'assistant', content: '' }));
    let checked = false;
    const firstChunk = async () => {
      if (checked) return 'go';
      checked = true;
      return checkpoint(step, res, closed, () => write({ error: { message: 'Overloaded', type: 'overloaded_error', code: 'server_is_overloaded' } }));
    };
    if (typeof step.thinking === 'string') for (const piece of chunks(step.thinking)) write(chunk({ reasoning_content: piece }));
    const text = `${step.text || ''}${step.rawToolText || ''}`;
    if (text) {
      for (const piece of chunks(text)) {
        write(chunk({ content: piece }));
        if ((await firstChunk()) === 'stop') return;
        if (step.chunkMs) await sleep(step.chunkMs);
      }
    }
    if ((await firstChunk()) === 'stop') return;
    (step.tools || []).forEach((t, i) => {
      const args = t.raw !== undefined ? String(t.raw) : JSON.stringify(t.input ?? {});
      write(chunk({ tool_calls: [{ index: i, id: `call_fake_${next()}`, type: 'function', function: { name: t.name, arguments: '' } }] }));
      for (const piece of chunks(args, 7)) write(chunk({ tool_calls: [{ index: i, function: { arguments: piece } }] }));
    });
    const stop = step.stop || ((step.tools || []).length ? 'tool_use' : 'end_turn');
    const finish = { tool_use: 'tool_calls', end_turn: 'stop', max_tokens: 'length', refusal: 'content_filter' }[stop] || 'stop';
    write(chunk({}, finish));
    if (body.stream_options && body.stream_options.include_usage) {
      write({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: u.input + u.cacheRead, completion_tokens: u.output, total_tokens: u.input + u.cacheRead + u.output, prompt_tokens_details: { cached_tokens: u.cacheRead } } });
    }
    if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
    res.end();
  }

  // ---------------------------------------------------------------- the server

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const dialect = url.pathname.startsWith('/anthropic/') ? 'anthropic' : url.pathname.startsWith('/openai/') ? 'openai' : url.pathname.startsWith('/compat/') ? 'compat' : null;
    const entry = { dialect, method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers }, body: null, at: Date.now() };
    log.push(entry);
    const json = (status, body, headers = {}) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      entry.body = await readBody(req);
      const lmRoute = url.pathname.startsWith('/compat/api/v0/models/');
      if ((lmRoute && req.method === 'GET') || (url.pathname === '/compat/api/show' && req.method === 'POST')) {
        entry.kind = 'model_row';
        let id = '';
        try {
          id = lmRoute ? decodeURIComponent(url.pathname.slice('/compat/api/v0/models/'.length)) : String(entry.body?.model ?? '');
        } catch {
          /* not an id */
        }
        const row = modelRows.get(id);
        if (!row || (row.route ?? 'models') !== (lmRoute ? 'models' : 'show')) return json(404, { error: `model '${id}' not found` });
        return json(200, lmRoute ? lmStudioRowOf(row) : ollamaShowOf(row));
      }
      if (req.method === 'GET' && /\/v1\/models$/.test(url.pathname) && dialect) {
        if (dialect === 'anthropic' && !req.headers['x-api-key']) throw new Refusal('x-api-key header is required', 401, 'authentication_error');
        const held = modelHolds.findIndex((m) => !m.dialect || m.dialect === dialect);
        if (held >= 0) {
          const h = hold(modelHolds.splice(held, 1)[0].name);
          if (!h.released) await Promise.race([new Promise((r) => h.waiters.push(r)), new Promise((r) => res.on('close', r))]);
          if (res.destroyed) return;
        }
        const fail = takeFailure(dialect);
        if (fail) return json(fail.status, fail.body ?? errorBody(dialect, fail.status, `fake failure ${fail.status}`), fail.headers);
        const ids = modelLists[dialect];
        if (dialect === 'anthropic') {
          return json(200, { data: ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: ids[0] ?? null, last_id: ids[ids.length - 1] ?? null });
        }
        return json(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) });
      }
      const route =
        req.method === 'POST' &&
        ((dialect === 'anthropic' && url.pathname === '/anthropic/v1/messages') ||
          (dialect === 'openai' && url.pathname === '/openai/v1/responses') ||
          (dialect === 'compat' && url.pathname === '/compat/v1/chat/completions'));
      if (!route) return json(404, errorBody(dialect || 'openai', 404, `fake-llm: no route ${req.method} ${url.pathname}`));
      entry.kind = 'chat';
      // The person's own pictures, as this request carries them (userImagesOf).
      entry.userImages = userImagesOf(dialect, entry.body);
      const fail = takeFailure(dialect);
      if (fail) return json(fail.status, fail.body ?? errorBody(dialect, fail.status, `fake failure ${fail.status}`), fail.headers);
      if (dialect === 'anthropic') checkAnthropic(entry.body, req.headers);
      else if (dialect === 'openai') checkResponses(entry.body, req.headers);
      else checkCompat(entry.body);
      const queued = queue.shift();
      if (!queued) return json(500, errorBody(dialect, 500, 'fake-llm: no reply queued', 'api_error'));
      const step = typeof queued === 'function' ? await stepFrom(queued, entry.body) : queued;
      entry.step = step;
      let closedResolve;
      const closed = new Promise((r) => (closedResolve = r));
      res.on('close', () => {
        if (!res.writableEnded) disconnects += 1;
        closedResolve();
      });
      if (step.delayMs) await Promise.race([sleep(step.delayMs), closed]);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (dialect === 'anthropic') await streamAnthropic(step, entry.body, res, closed);
      else if (dialect === 'openai') await streamResponses(step, entry.body, res, closed);
      else await streamCompat(step, entry.body, res, closed);
    } catch (err) {
      if (err instanceof Refusal) {
        entry.refused = err.message;
        return json(err.status, errorBody(dialect || 'openai', err.status, err.message, err.type));
      }
      json(500, errorBody(dialect || 'openai', 500, `fake-llm: ${err && err.message}`, 'api_error'));
    }
  });

  /** What a function step answers to `body`: the step it returns; a refusal when it throws or returns none. */
  async function stepFrom(fn, body) {
    let step;
    try {
      step = await fn(structuredClone(body));
    } catch (err) {
      throw new Refusal(`fake-llm: a scripted step failed: ${err && err.message}`);
    }
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Refusal('fake-llm: a scripted step returned no step');
    return step;
  }

  function takeFailure(dialect) {
    const i = failures.findIndex((f) => !f.dialect || f.dialect === dialect);
    if (i < 0) return null;
    const f = failures[i];
    f.times -= 1;
    if (f.times <= 0) failures.splice(i, 1);
    return f;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const base = `http://${host}:${server.address().port}`;

  return {
    base,
    compatBase: `${base}/compat/v1`,
    /** Queues the answers the next chat requests get, in order: steps, or functions `(body) => step`. */
    reply(...steps) {
      queue.push(...steps);
    },
    /**
     * The model ids the models routes list (every dialect, or one: 'anthropic' | 'openai' |
     * 'compat'). An entry may be a row, `{id, context?, max?, type?, route?}`: the local
     * server's model routes answer for it (see the top), and a later list replaces the rows.
     */
    models(list, dialect) {
      const ids = list.map((m) => (m && typeof m === 'object' ? m.id : m));
      for (const d of dialect ? [dialect] : Object.keys(modelLists)) modelLists[d] = [...ids];
      if (!dialect || dialect === 'compat') {
        modelRows.clear();
        for (const m of list) if (m && typeof m === 'object') modelRows.set(m.id, { ...m });
      }
    },
    /** Local-server models that can't read images: a chat request for one that carries an image is refused 400 (none: clears). */
    textOnly(...ids) {
      textOnlyModels.clear();
      for (const id of ids) textOnlyModels.add(id);
    },
    /** Refuses (400, GRAMMAR_TOO_LARGE) a chat request of `dialect` whose strict schemas pass `bytes` in all; null clears it. */
    strictBudget(bytes, dialect = 'anthropic') {
      if (bytes === null || bytes === undefined) strictBudgets.delete(dialect);
      else strictBudgets.set(dialect, bytes);
    },
    /** The next model list (of a dialect, or any) waits until release(name), or until the client closes. */
    holdModels(name, dialect) {
      modelHolds.push({ name, dialect });
    },
    /** The next request (of a dialect, or any) gets this answer instead; `times` requests in a row. */
    failNext({ status = 500, body, headers = {}, times = 1, dialect } = {}) {
      failures.push({ status, body, headers, times, dialect });
    },
    /** Lets a step held under `name` go on (now, or as soon as it gets there). */
    release(name) {
      const h = hold(name);
      h.released = true;
      for (const w of h.waiters.splice(0)) w();
    },
    /** Every request so far: {dialect, kind? ('chat' | 'model_row'), method, path, headers, body, userImages? (a chat's, userImagesOf), step?, refused?, at}. */
    requests() {
      return log.map((e) => ({ ...e }));
    },
    /** Answers whose connection the client closed before the fake finished. */
    disconnects() {
      return disconnects;
    },
    /** Steps not yet used. */
    pending() {
      return queue.length;
    },
    async stop() {
      for (const h of holds.values()) for (const w of h.waiters.splice(0)) w();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
