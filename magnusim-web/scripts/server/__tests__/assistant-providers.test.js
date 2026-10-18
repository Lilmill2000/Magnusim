// The provider adapters (Foundation spec 5, 10.1): the real adapters against the fake
// provider (e2e/support/fake-llm.mjs) in all three dialects, the guarded fetch, error
// mapping, prices and the spend estimate, the SDK loader, and the routes that list
// models and run Settings' connection test.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-providers-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) {
  if (k.startsWith('MAGNUSIM_TEST_ASSISTANT') || k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_')) delete process.env[k];
}
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { startFakeLlm, LOCAL_SERVER_ROWS } = await import('../../../e2e/support/fake-llm.mjs');
const fake = await startFakeLlm();
// Read once, at the first cloud request: both cloud adapters talk to the fake.
process.env.MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL = fake.base;

const { createAdapter, sendWithOneResend, isCloud, destinationOf, tokenElsewhereText } = await import('../assistant/providers/index.ts');
const { guardedFetch, filterHeaders, Watchdog } = await import('../assistant/providers/guarded-fetch.ts');
const { mapProviderError } = await import('../assistant/providers/errors.ts');
const { resolveTestProviderUrl, cloudBaseUrl } = await import('../assistant/providers/endpoints.ts');
const { sdkInstalled, depsStatus, setSdkSpecifierForTests, loadSdkClass, DEPS_MISSING_TEXT } = await import('../assistant/providers/load-sdk.ts');
const { anthropicClientOptions, MessageAccumulator } = await import('../assistant/providers/anthropic.ts');
const { CLOUD_WATCHDOG, LOCAL_WATCHDOG } = await import('../assistant/providers/common.ts');
const { runConnectionTest } = await import('../assistant/provider-test.ts');
const { STORAGE_NOTES, UNLOCK_NOTES, TOKEN_BLOCKED_NOTE, TOKEN_BLOCKED_TEXT, KeyError } = await import('../assistant/secrets/store.ts');
const { openAiClientOptions } = await import('../assistant/providers/openai.ts');
const { lmStudioRow, ollamaRow, serverRoot, MODEL_ROW_TTL_MS } = await import('../assistant/providers/openai-compatible.ts');
const prices = await import('../assistant/prices.ts');
const { ProviderError } = await import('../assistant/types.ts');
const { Router, dispatch } = await import('../router.ts');
const { sendJson } = await import('../http.ts');
const routes = await import('../assistant-routes.ts');
const { assistantState, resetAssistantState } = await import('../assistant/state.ts');
const { spendLedger } = await import('../assistant/ledger.ts');

const KEYS = {
  anthropic: 'sk-ant-api03-PROVIDERS-test-key-0123456789-Ab1',
  openai: 'sk-proj-PROVIDERS-test-key-0123456789-Cd2',
  openai_compatible: null,
};
/** A stand-in for the secret store's lending (the routes tests below use the real store). */
const lender = {
  status: () => ({
    anthropic: { set: true, state: 'ok' },
    openai: { set: true, state: 'ok' },
    openai_compatible: { set: false, state: 'none' },
  }),
  withKey: async (slot, use) => use(KEYS[slot]),
};

const MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: 'qwen3.8-27b' };
const DIALECT = { anthropic: 'anthropic', openai: 'openai', openai_compatible: 'compat' };
const PROVIDERS = ['anthropic', 'openai', 'openai_compatible'];

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
/** The demo workspace's tools (python/tests/fixtures/assistant-plugins/ai-demo). */
const DEMO_TOOLS = [
  { name: 'get_count', description: 'Read the counter.', schema: obj({}) },
  { name: 'add', description: 'Add to the counter.', schema: obj({ by: { type: 'integer', minimum: -100, maximum: 100, description: 'How much.' } }) },
  { name: 'slow_add', description: 'Add slowly.', schema: obj({ by: { type: 'integer', minimum: -100, maximum: 100 }, steps: { type: 'integer', minimum: 1, maximum: 50 } }, ['by']) },
  { name: 'reset', description: 'Set the counter to 0.', schema: obj({}) },
  { name: 'mystery', description: 'Does something.', schema: obj({ note: { type: 'string', maxLength: 64, title: 'Note' } }, []) },
  { name: 'snap', description: 'A picture of the counter.', schema: obj({ size: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 } }, []) },
];

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** `p`, or a failure after `ms` (for a call that, broken, would never settle). */
async function within(p, ms, what) {
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

/** A server that takes every request and never answers (a local server stuck loading). */
async function silentServer() {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

const chat = (dialect) => fake.requests().filter((r) => r.kind === 'chat' && (!dialect || r.dialect === dialect));
const lastChat = (dialect) => chat(dialect).at(-1);

function adapterFor(provider, o = {}) {
  return createAdapter({ provider, base_url: o.base_url ?? fake.compatBase }, o.lender ?? lender, o);
}

function request(provider, messages, o = {}) {
  return {
    model: o.model ?? MODELS[provider],
    system: [{ text: 'You are a test.', cache: true }],
    messages,
    tools: o.tools ?? DEMO_TOOLS,
    maxOutputTokens: 4000,
    effort: o.effort ?? 'default',
  };
}
const userText = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
const send = (provider, req, o = {}) => adapterFor(provider, o).send(req, o.signal ?? new AbortController().signal, o.onEvent ?? (() => {}));
const resultFor = (r1, text = '{"ok":true}', images = []) => ({
  role: 'user',
  parts: r1.message.parts.filter((p) => p.type === 'tool_call').map((c) => ({ type: 'tool_result', callId: c.callId, isError: false, text, images })),
});

// Console lines the code under test prints (no key may appear in one).
const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(String).join(' '));
    if (level === 'error') orig(...args);
  };
}

after(async () => {
  await fake.stop();
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

describe('the adapters against the fake, in every dialect', () => {
  it('text, thinking, split tool calls, usage and the stop reasons', async () => {
    for (const provider of PROVIDERS) {
      fake.reply({ thinking: 'Let me see.', text: 'Adding two now.', tools: [{ name: 'add', input: { by: 2 } }, { name: 'get_count', input: {} }], usage: { input: 900, output: 40, cacheRead: 300 } });
      const events = [];
      const r = await send(provider, request(provider, [userText('add two')]), { onEvent: (e) => events.push(e) });
      assert.equal(r.stop, 'tool_use', provider);
      const calls = r.message.parts.filter((p) => p.type === 'tool_call');
      assert.deepEqual(
        calls.map((c) => [c.name, c.input]),
        [
          ['add', { by: 2 }],
          ['get_count', {}],
        ],
        provider,
      );
      assert.equal(r.message.parts.filter((p) => p.type === 'text').map((p) => p.text).join(''), 'Adding two now.', provider);
      assert.equal(events.filter((e) => e.kind === 'text').map((e) => e.text).join(''), 'Adding two now.', provider);
      assert.deepEqual(events.filter((e) => e.kind === 'tool_call').map((e) => e.name), ['add', 'get_count'], provider);
      assert.ok(events.some((e) => e.kind === 'thinking'), `${provider} shows thinking`);
      assert.equal(events.at(-1).kind, 'usage', provider);
      assert.equal(r.usage.output, 40, provider);
      assert.equal(r.usage.cacheRead, 300, provider);
      assert.equal(r.usage.input, 900, provider);
      assert.equal(r.usage.complete, true, provider);
      assert.equal(r.message.raw.provider, provider);
      assert.deepEqual(r.attempts, [{ model: r.servedBy, usage: r.usage, fallback: false }], provider);

      fake.reply({ text: 'Ran out', stop: 'max_tokens' });
      assert.equal((await send(provider, request(provider, [userText('long')]))).stop, 'max_tokens', provider);
      fake.reply({ text: 'All done.' });
      assert.equal((await send(provider, request(provider, [userText('end')]))).stop, 'end_turn', provider);
    }
  });

  it('refusals: the category and the explanation', async () => {
    fake.reply({ stop: 'refusal', category: 'cyber' });
    const a = await send('anthropic', request('anthropic', [userText('no')]));
    assert.equal(a.stop, 'refusal');
    assert.deepEqual(a.refusal, { category: 'cyber', explanation: 'The fake declined.' });
    fake.reply({ stop: 'refusal', text: 'I can’t help with that.' });
    const o = await send('openai', request('openai', [userText('no')]));
    assert.equal(o.stop, 'refusal');
    assert.equal(o.refusal.explanation, 'I can’t help with that.');
    fake.reply({ text: 'filtered', stop: 'refusal' });
    assert.equal((await send('openai_compatible', request('openai_compatible', [userText('no')]))).stop, 'refusal');
  });

  it('opaque parts go back byte for byte (thinking signatures, encrypted reasoning), and a changed one is refused', async () => {
    for (const provider of ['anthropic', 'openai']) {
      fake.reply({ thinking: 'Plan: add one.', tools: [{ name: 'add', input: { by: 1 } }] }, { text: 'Done.' });
      const first = [userText('add one')];
      const r1 = await send(provider, request(provider, first));
      const r2 = await send(provider, request(provider, [...first, r1.message, resultFor(r1)]));
      assert.equal(r2.stop, 'end_turn', provider);
      const body = lastChat(DIALECT[provider]).body;
      if (provider === 'anthropic') {
        const echoed = body.messages[1].content.find((b) => b.type === 'thinking');
        assert.match(echoed.signature, /^sig-\d+$/);
        assert.equal(echoed.thinking, 'Plan: add one.');
        // The stored payload, changed, is refused by the fake as by the real API.
        const changed = structuredClone(r1.message);
        changed.raw.payload.find((b) => b.type === 'thinking').thinking = 'Plan: add two.';
        const pending = fake.pending();
        await assert.rejects(send(provider, request(provider, [...first, changed, resultFor(r1)])), (e) => e.code === 'bad_request');
        assert.equal(fake.pending(), pending, 'the refused request took no step');
      } else {
        const echoed = body.input.find((it) => it.type === 'reasoning');
        assert.match(echoed.encrypted_content, /^enc-\d+$/);
        assert.deepEqual(body.include, ['reasoning.encrypted_content']);
        assert.equal(body.store, false);
        assert.equal(body.previous_response_id, undefined);
      }
    }
  });

  it('first dialect: an empty answer (no content, or one empty text block) is kept but never sent back, so the conversation goes on', async () => {
    for (const empty of [{}, { emptyText: true }, { fallback: 'claude-opus-5' }]) {
      const what = JSON.stringify(empty);
      fake.reply({ tools: [{ name: 'add', input: { by: 1 } }] }, empty, { text: 'Next answer.' });
      const first = [userText('add one')];
      const r1 = await send('anthropic', request('anthropic', first));
      const history = [...first, r1.message, resultFor(r1)];
      const r2 = await send('anthropic', request('anthropic', history));
      assert.deepEqual([r2.stop, r2.message.parts], ['end_turn', []], what);
      assert.equal(r2.message.raw.payload.length, empty.emptyText || empty.fallback ? 1 : 0, `${what}: stored as it came`);
      const r3 = await send('anthropic', request('anthropic', [...history, r2.message, userText('and now?')]));
      assert.equal(r3.stop, 'end_turn', what);
      const sent = lastChat('anthropic').body.messages;
      assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user'], what);
      assert.deepEqual(sent[2].content.map((b) => b.type), ['tool_result', 'text'], what);
    }
    // Self-test: the fake refuses both shapes mid-conversation, as the provider does.
    for (const content of [[], [{ type: 'text', text: '' }]]) {
      const res = await fetch(`${fake.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content }, { role: 'user', content: 'y' }] }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /non-empty/);
    }
  });

  it('a tool call with unreadable JSON is kept, with inputError, not lost', async () => {
    for (const provider of PROVIDERS) {
      fake.reply({ tools: [{ name: 'add', raw: '{"by": 2' }] });
      const r = await send(provider, request(provider, [userText('x')]));
      const call = r.message.parts.find((p) => p.type === 'tool_call');
      assert.equal(call.name, 'add', provider);
      assert.deepEqual(call.input, {}, provider);
      assert.match(call.inputError, /not valid JSON/, provider);
    }
  });

  it('fake self-test: a scripted step may be a function of the request, so it answers from an earlier result; one that fails is refused, never retried into the next step', async () => {
    for (const provider of PROVIDERS) {
      const seen = [];
      fake.reply({ tools: [{ name: 'get_count', input: {} }] }, (body) => {
        seen.push(body);
        const count = Number(JSON.stringify(body).match(/The count is (\d+)\./)?.[1]);
        return { tools: [{ name: 'add', input: { by: count * 2 } }] };
      });
      const first = [userText('double the counter')];
      const r1 = await send(provider, request(provider, first));
      const r2 = await send(provider, request(provider, [...first, r1.message, resultFor(r1, 'The count is 21.')]));
      assert.deepEqual(r2.message.parts.filter((p) => p.type === 'tool_call').map((c) => [c.name, c.input]), [['add', { by: 42 }]], provider);
      const req = lastChat(DIALECT[provider]);
      assert.deepEqual(seen, [req.body], `${provider}: called once, with the request's body`);
      assert.deepEqual(req.step, { tools: [{ name: 'add', input: { by: 42 } }] }, `${provider}: the log keeps the step it returned`);
      assert.equal(req.refused, undefined, provider);
    }
    // A promise of a step is awaited.
    fake.reply(async (body) => ({ text: `Asked: ${body.messages.at(-1).content}` }));
    const r = await send('openai_compatible', request('openai_compatible', [userText('count them')]));
    assert.equal(r.message.parts.map((p) => p.text).join(''), 'Asked: count them');
    // A function that throws, rejects or returns no step: 400, refused by name; the next step
    // stays queued for the next request.
    const failing = [
      [
        'throws',
        () => {
          throw new Error('no count in the request');
        },
        /a scripted step failed: no count in the request/,
      ],
      ['rejects', async () => Promise.reject(new Error('nothing to read')), /a scripted step failed: nothing to read/],
      ['returns nothing', () => undefined, /a scripted step returned no step/],
    ];
    for (const [what, fn, refusal] of failing) {
      fake.reply(fn, { text: 'The next step.' });
      await assert.rejects(send('anthropic', request('anthropic', [userText('x')])), (e) => e.code === 'bad_request', what);
      assert.match(lastChat('anthropic').refused, refusal, what);
      assert.equal(fake.pending(), 1, `${what}: only the failing step was taken`);
      assert.equal((await send('anthropic', request('anthropic', [userText('y')]))).message.parts[0].text, 'The next step.', what);
    }
  });

  it('tool results with images reach each dialect as images', async () => {
    const img = { type: 'image', mediaType: 'image/png', base64: PNG_1x1, width: 1, height: 1 };
    for (const provider of PROVIDERS) {
      fake.reply({ tools: [{ name: 'snap', input: {} }] }, { text: 'I see it.' });
      const first = [userText('look')];
      const r1 = await send(provider, request(provider, first));
      await send(provider, request(provider, [...first, r1.message, resultFor(r1, '{"tool":"snap","ok":true}', [img])]));
      const body = lastChat(DIALECT[provider]).body;
      if (provider === 'anthropic') {
        const tr = body.messages[2].content[0];
        assert.equal(tr.type, 'tool_result');
        assert.deepEqual(tr.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1 } });
      } else if (provider === 'openai') {
        const out = body.input.find((it) => it.type === 'function_call_output');
        assert.deepEqual(out.output[1], { type: 'input_image', image_url: `data:image/png;base64,${PNG_1x1}`, detail: 'auto' });
      } else {
        const toolMsg = body.messages.find((m) => m.role === 'tool');
        assert.equal(typeof toolMsg.content, 'string', 'a tool message holds text only');
        const user = body.messages.at(-1);
        assert.equal(user.role, 'user');
        assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1}` } });
      }
    }
  });

  it('a request is built with tool results first, cache breakpoints, effort, and no forced tool choice', async () => {
    fake.reply({ text: 'ok' });
    await send('anthropic', request('anthropic', [userText('a'), userText('b')], { effort: 'high' }));
    const body = lastChat('anthropic').body;
    assert.equal(body.messages.length, 1, 'consecutive user messages are merged');
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.tools.at(-1).cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system.at(-1).cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
    assert.ok(body.tools.every((t) => t.strict === true));
    fake.reply({ text: 'ok' });
    await send('openai', request('openai', [userText('a')], { effort: 'low' }));
    const o = lastChat('openai').body;
    assert.deepEqual(o.reasoning, { effort: 'low' });
    assert.equal(o.tool_choice, 'auto');
    assert.equal(o.parallel_tool_calls, true);
    assert.equal(o.max_output_tokens, 4000);
    fake.reply({ text: 'ok' });
    await send('openai_compatible', request('openai_compatible', [userText('a')], { effort: 'high' }));
    const c = lastChat('compat').body;
    assert.equal(c.tool_choice, undefined);
    assert.equal(c.reasoning_effort, undefined);
    assert.ok(c.tools.every((t) => t.function.strict === undefined));
    assert.deepEqual(c.stream_options, { include_usage: true });
    assert.equal(c.max_tokens, 4000);
  });
});

describe('strict schemas', () => {
  it('the demo schemas reach both strict dialects with no refused keyword, their limits in words', async () => {
    for (const provider of ['anthropic', 'openai']) {
      fake.reply({ text: 'ok' });
      await send(provider, request(provider, [userText('tools')]));
      const req = lastChat(DIALECT[provider]);
      assert.equal(req.refused, undefined, provider);
      const tools = req.body.tools;
      const add = tools.find((t) => t.name === 'add');
      const schema = provider === 'anthropic' ? add.input_schema : add.parameters;
      assert.equal(schema.properties.by.description, 'How much. (integer from -100 to 100)', provider);
      assert.equal(JSON.stringify(tools).match(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|pattern|format|title)"/), null, provider);
    }
  });

  it('the first dialect: at most 20 strict tools and 24 optional parameters per request, in the order offered; the rest go without strict', async () => {
    const tool = (name, schema) => ({ name, description: 'A tool.', schema });
    const twoOptional = obj({ id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['id']);
    // 25 tools with nothing optional: the first 20 are strict.
    fake.reply({ text: 'ok' });
    const r = await send('anthropic', request('anthropic', [userText('x')], { tools: Array.from({ length: 25 }, (_, i) => tool(`t${i}`, obj({}))) }));
    assert.equal(r.stop, 'end_turn');
    let body = lastChat('anthropic').body;
    assert.deepEqual(body.tools.map((t) => t.strict === true), [...Array(20).fill(true), ...Array(5).fill(false)]);
    assert.deepEqual(body.tools.at(-1).cache_control, { type: 'ephemeral' });
    // Two optional each: 12 tools use the 24; the 13th goes without, and a later one with none optional still fits.
    fake.reply({ text: 'ok' });
    await send('anthropic', request('anthropic', [userText('x')], { tools: [...Array.from({ length: 13 }, (_, i) => tool(`h${i}`, twoOptional)), tool('last', obj({}))] }));
    body = lastChat('anthropic').body;
    assert.deepEqual(body.tools.map((t) => t.strict === true), [...Array(12).fill(true), false, true]);
    // A tool sent without strict has the same schema (validateInput checks its input before it runs).
    assert.deepEqual(body.tools[12].input_schema, body.tools[0].input_schema);
    // Self-test: over either limit the fake refuses, as the provider does.
    for (const tools of [Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, input_schema: obj({}), strict: true })), Array.from({ length: 13 }, (_, i) => ({ name: `h${i}`, input_schema: twoOptional, strict: true }))]) {
      const res = await fetch(`${fake.base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /^Schema is too complex for compilation\./);
    }
  });

  it('self-test: a strict tool that leaks a limit keyword gets the fake 400 naming it', async () => {
    const leaked = { type: 'object', properties: { by: { type: 'integer', minimum: 1 } }, required: ['by'], additionalProperties: false };
    const a = await fetch(`${fake.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', input_schema: leaked, strict: true }] }),
    });
    assert.equal(a.status, 400);
    assert.match((await a.json()).error.message, /"minimum"/);
    const o = await fetch(`${fake.base}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'x', tools: [{ type: 'function', name: 't', parameters: leaked, strict: true }] }),
    });
    assert.equal(o.status, 400);
    assert.match((await o.json()).error.message, /"minimum"/);
  });
});

/** The reasoning items a raw Responses stream sent, from its output_item.done events. */
function doneItems(sse) {
  return sse
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
    .filter((e) => e.type === 'response.output_item.done')
    .map((e) => e.item);
}

describe('the Responses replay', () => {
  it('self-test: without include, no encrypted reasoning, and replaying it under store:false is "not found"', async () => {
    fake.reply({ thinking: 'hidden', text: 'hi' });
    const r = await fetch(`${fake.base}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'x', store: false, stream: true }),
    });
    const items = doneItems(await r.text());
    const reasoning = items.find((i) => i.type === 'reasoning');
    assert.equal(reasoning.encrypted_content, undefined);
    const replay = await fetch(`${fake.base}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', store: false, input: [{ role: 'user', content: 'x' }, ...items, { role: 'user', content: 'again' }] }),
    });
    assert.equal(replay.status, 404);
    assert.match((await replay.json()).error.message, /not found/);
  });
});

describe('the refusal fallback (first cloud dialect)', () => {
  it('a fallback step: the event, each attempt at its own model and price, the block replayed byte for byte', async () => {
    // bio: a category whose decline before any output is billed.
    fake.reply({ fallback: 'claude-opus-5', category: 'bio', text: 'Answered by the fallback.', usage: { input: 1000, output: 200 } }, { text: 'Next.' });
    const events = [];
    const first = [userText('please')];
    const r1 = await send('anthropic', request('anthropic', first), { onEvent: (e) => events.push(e) });
    assert.deepEqual(events.find((e) => e.kind === 'fallback'), { kind: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' });
    assert.equal(r1.servedBy, 'claude-opus-5');
    assert.deepEqual(
      r1.attempts.map((a) => [a.model, a.fallback, a.usage.input, a.usage.output]),
      [
        ['claude-opus-5-5', false, 1000, 0],
        ['claude-opus-5', true, 1000, 200],
      ],
    );
    const cost = prices.requestCost('anthropic', r1.attempts);
    assert.equal(cost.estimated, false);
    assert.ok(Math.abs(cost.usd - ((1000 * 4) / 1e6 + (1000 * 5 + 200 * 25) / 1e6)) < 1e-12, String(cost.usd));
    assert.equal(r1.message.raw.payload[0].type, 'fallback');
    const r2 = await send('anthropic', request('anthropic', [...first, r1.message, userText('and then?')]));
    assert.equal(r2.stop, 'end_turn');
    assert.deepEqual(lastChat('anthropic').body.messages[1].content[0], r1.message.raw.payload[0]);
    // A changed fallback block is refused.
    const changed = structuredClone(r1.message);
    changed.raw.payload[0].to.model = 'claude-sonnet-5';
    await assert.rejects(send('anthropic', request('anthropic', [...first, changed, userText('x')])), (e) => e.code === 'bad_request');
  });

  it('a fallback with no block: usage.iterations alone says who served it, and the event still comes', async () => {
    fake.reply({ fallback: 'claude-opus-5', fallbackBlock: false, text: 'Answered by the fallback.', usage: { input: 900, output: 100 } });
    const events = [];
    const r = await send('anthropic', request('anthropic', [userText('please')]), { onEvent: (e) => events.push(e) });
    assert.ok(!r.message.raw.payload.some((b) => b.type === 'fallback'), 'the fake sent no block');
    assert.deepEqual(events.filter((e) => e.kind === 'fallback'), [{ kind: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' }]);
    assert.deepEqual([r.servedBy, r.message.raw.model], ['claude-opus-5', 'claude-opus-5']);
    assert.deepEqual(r.attempts.map((a) => [a.model, a.fallback]), [
      ['claude-opus-5-5', false],
      ['claude-opus-5', true],
    ]);
    // The top-level model may still name the requested one: the iterations decide.
    const seen = [];
    const acc = new MessageAccumulator((e) => seen.push(e));
    acc.add({ type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } });
    acc.add({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    acc.add({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
    acc.add({ type: 'content_block_stop', index: 0 });
    acc.add({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        iterations: [
          { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 0 },
          { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5 },
        ],
      },
    });
    acc.add({ type: 'message_stop' });
    const res = acc.result('claude-sonnet-5-5');
    assert.deepEqual([res.servedBy, res.message.raw.model], ['claude-sonnet-5', 'claude-sonnet-5']);
    assert.deepEqual(seen.filter((e) => e.kind === 'fallback'), [{ kind: 'fallback', from: 'claude-sonnet-5-5', to: 'claude-sonnet-5' }]);
  });

  it('a decline before any output is billed only in the categories the provider bills (bio, frontier_llm, reasoning_extraction)', async () => {
    const served = (1000 * 5 + 200 * 25) / 1e6;
    const declined = (1000 * 4) / 1e6;
    // An unknown category is billed: a new one may be, and the spend is never under-counted.
    for (const [category, billed] of [
      ['cyber', false],
      ['general_harms', false],
      [null, false],
      ['bio', true],
      ['frontier_llm', true],
      ['reasoning_extraction', true],
      ['some_new_category', true],
    ]) {
      fake.reply({ fallback: 'claude-opus-5', category, text: 'Served.', usage: { input: 1000, output: 200 } });
      const r = await send('anthropic', request('anthropic', [userText('please')]));
      assert.deepEqual(r.attempts.map((a) => [a.model, a.fallback]), [...(billed ? [['claude-opus-5-5', false]] : []), ['claude-opus-5', true]], String(category));
      const cost = prices.requestCost('anthropic', r.attempts);
      assert.ok(Math.abs(cost.usd - (served + (billed ? declined : 0))) < 1e-12, `${category}: ${cost.usd}`);
      assert.equal(cost.estimated, false);
    }
    // The whole request declined before any output (no fallback, or the fallback declined too): the same rule.
    for (const [category, attempts] of [
      ['cyber', 0],
      ['bio', 1],
    ]) {
      fake.reply({ stop: 'refusal', category, usage: { input: 1000, output: 0 } });
      const r = await send('anthropic', request('anthropic', [userText('no')], { model: 'claude-haiku-5-5' }));
      assert.equal(r.stop, 'refusal');
      assert.equal(r.attempts.length, attempts, category);
      fake.reply({ fallback: 'claude-opus-5', category, stop: 'refusal', usage: { input: 1000, output: 0 } });
      const f = await send('anthropic', request('anthropic', [userText('no')]));
      assert.equal(f.attempts.length, 2 * attempts, `${category}, fallback declined too`);
    }
    // A decline after the answer had begun is billed whatever its category.
    fake.reply({ fallback: 'claude-opus-5', declined: { text: 'Partly.' }, text: 'Served.', usage: { input: 1000, output: 200 } });
    const mid = await send('anthropic', request('anthropic', [userText('please')]));
    assert.deepEqual(mid.attempts.map((a) => [a.model, a.usage.output]), [['claude-opus-5-5', 40], ['claude-opus-5', 200]]);
  });

  it('a decline mid-answer: the declined partial’s tool calls and thinking are neither run nor sent back; its text stays', async () => {
    fake.reply(
      {
        declined: { thinking: 'Plan: reset.', text: 'Resetting first.', tools: [{ name: 'reset', input: {} }] },
        fallback: 'claude-opus-5',
        tools: [{ name: 'get_count', input: {} }],
        usage: { input: 1000, output: 50 },
      },
      { text: 'Done.' },
    );
    const events = [];
    const first = [userText('reset, then read')];
    const r1 = await send('anthropic', request('anthropic', first), { onEvent: (e) => events.push(e) });
    assert.equal(r1.stop, 'tool_use');
    assert.equal(r1.servedBy, 'claude-opus-5');
    assert.deepEqual(r1.message.parts.map((p) => (p.type === 'tool_call' ? `call:${p.name}` : p.type)), ['text', 'call:get_count']);
    assert.deepEqual(r1.message.raw.payload.map((b) => b.type), ['text', 'fallback', 'tool_use']);
    assert.deepEqual(events.filter((e) => e.kind === 'fallback'), [{ kind: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' }]);
    const r2 = await send('anthropic', request('anthropic', [...first, r1.message, resultFor(r1)]));
    assert.equal(r2.stop, 'end_turn');
    const body = lastChat('anthropic').body;
    assert.deepEqual(body.messages[1].content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)), ['text', 'fallback', 'tool_use:get_count']);
    assert.deepEqual(body.messages[2].content.map((b) => b.type), ['tool_result']);
  });

  it('`fallbacks` and its beta only for Opus 5.5 and Sonnet 5.5, never Haiku 5.5 or an unknown id', async () => {
    for (const [model, on] of [
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', false],
      ['claude-unknown-9', false],
    ]) {
      fake.reply({ text: 'ok' });
      await send('anthropic', request('anthropic', [userText('x')], { model }));
      const req = lastChat('anthropic');
      assert.equal(req.body.fallbacks, on ? 'default' : undefined, model);
      assert.equal(req.body.betas, undefined, 'betas travel as a header');
      assert.equal(req.headers['anthropic-beta'], on ? 'server-side-fallback-2026-07-01' : undefined, model);
      assert.deepEqual(adapterFor('anthropic').fallbackTargets(model), on ? [...prices.FALLBACK_TARGETS[model]] : [], model);
    }
  });
});

describe('stop, overload, watchdog', () => {
  it('Stop mid-stream: aborted, the socket closes, and no request follows', async () => {
    fake.reply({ text: 'A long answer that never finishes', hold: 'stop-me' });
    const ctl = new AbortController();
    const before = chat().length;
    const drops = fake.disconnects();
    const events = [];
    const p = send('anthropic', request('anthropic', [userText('go')]), { signal: ctl.signal, onEvent: (e) => events.push(e) });
    await until(() => events.some((e) => e.kind === 'text'), 5000, 'the first text');
    const t0 = Date.now();
    ctl.abort();
    await assert.rejects(p, (e) => e instanceof ProviderError && e.code === 'aborted' && e.message === 'Stopped.' && e.streamed === true);
    await until(() => fake.disconnects() === drops + 1, 5000, 'the fake to see the socket close');
    assert.ok(Date.now() - t0 < 5000);
    await sleep(300);
    assert.equal(chat().length, before + 1, 'no request after Stop');
    fake.release('stop-me');
  });

  it('a mid-stream overload is sent once more; a second overload fails', async () => {
    for (const provider of PROVIDERS) {
      fake.reply({ text: 'partial answer', error: 'overloaded' }, { text: 'Second time lucky.' });
      const resends = [];
      const r = await sendWithOneResend(adapterFor(provider), request(provider, [userText('x')]), new AbortController().signal, () => {}, {
        delayMs: 20,
        onResend: (e) => resends.push(e.code),
      });
      assert.equal(r.message.parts[0].text, 'Second time lucky.', provider);
      assert.deepEqual(resends, ['overloaded'], provider);
      fake.reply({ text: 'partial', error: 'overloaded' }, { text: 'partial', error: 'overloaded' });
      await assert.rejects(
        sendWithOneResend(adapterFor(provider), request(provider, [userText('x')]), new AbortController().signal, () => {}, { delayMs: 20 }),
        (e) => e.code === 'overloaded' && e.streamed === true,
        provider,
      );
    }
    // A limit that runs out during the wait before the resend is reported as that limit, not as a Stop.
    fake.reply({ text: 'partial', error: 'overloaded' });
    const limit = new AbortController();
    await assert.rejects(
      sendWithOneResend(adapterFor('anthropic'), request('anthropic', [userText('x')]), limit.signal, () => {}, {
        delayMs: 30_000,
        onResend: () => setTimeout(() => limit.abort(new ProviderError('timeout', 'Out of time.')), 20),
      }),
      (e) => e.code === 'timeout' && e.message === 'Out of time.',
    );
  });

  it('the watchdog: no first byte, or a stream gone quiet, ends with timeout', async () => {
    const watchdog = { firstByteMs: 1000, idleMs: 1000 };
    fake.reply({ text: 'too late', delayMs: 8000 });
    const t0 = Date.now();
    await assert.rejects(send('anthropic', request('anthropic', [userText('x')]), { watchdog }), (e) => e.code === 'timeout' && e.message === 'No answer for 1 s.');
    assert.ok(Date.now() - t0 < 6000);
    fake.reply({ text: 'then silence for a long while', hold: 'quiet' });
    await assert.rejects(send('openai_compatible', request('openai_compatible', [userText('x')]), { watchdog }), (e) => e.code === 'timeout' && /No answer for 1 s\. A local model/.test(e.message));
    fake.release('quiet');
  });

  it('the watchdog: every chunk restarts the idle wait, so a long, steady answer is never cut off', async () => {
    // 16 chunks 150 ms apart: about 2.4 s in all, three times the 800 ms idle wait.
    const text = 'steady words '.repeat(13).slice(0, 160);
    fake.reply({ text, chunkMs: 150 });
    const r = await send('anthropic', request('anthropic', [userText('x')]), { watchdog: { firstByteMs: 2000, idleMs: 800 } });
    assert.equal(r.message.parts[0].text, text);
  });

  it('an answer that just stops before its end: ended early, nothing partial kept', async () => {
    for (const provider of PROVIDERS) {
      fake.reply({ text: 'half an answer and then nothing', end: true });
      const label = { anthropic: 'Anthropic', openai: 'OpenAI', openai_compatible: 'The local server' }[provider];
      await assert.rejects(send(provider, request(provider, [userText('x')])), (e) => e.code === 'server' && e.message === `${label} ended the answer early.`, provider);
    }
  });

  it('a dropped connection mid-answer: the answer ended early', async () => {
    fake.reply({ text: 'half an answer', drop: true });
    await assert.rejects(send('openai', request('openai', [userText('x')])), (e) => e.code === 'server' && e.message === 'OpenAI ended the answer early.' && e.streamed);
  });
});

describe('error mapping', () => {
  const noRetry = { 'x-should-retry': 'false' };
  const cases = [
    [{ status: 401 }, 'auth', 'Anthropic refused the key. Check it in Settings → Assistant.'],
    [{ status: 403 }, 'auth', 'Anthropic refused the key. Check it in Settings → Assistant.'],
    [{ status: 404 }, 'model', "The model claude-opus-5-5 isn't available to this key or server."],
    [{ status: 429, headers: { 'retry-after': '7' } }, 'rate_limit', 'Anthropic is limiting requests; try again in 7 s.'],
    [{ status: 529 }, 'overloaded', 'Anthropic is overloaded right now; try again shortly.'],
    [{ status: 500 }, 'server', 'Anthropic had an error (HTTP 500).'],
    [{ status: 400 }, 'bad_request', 'Anthropic refused the request (HTTP 400).'],
    [{ status: 413 }, 'bad_request', 'Anthropic refused the request (HTTP 413).'],
    [
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens > 1000000 maximum' } } },
      'context',
      'This conversation is too long for claude-opus-5-5. Start a new one.',
    ],
  ];
  for (const [fail, code, message] of cases) {
    it(`HTTP ${fail.status} → ${code}`, async () => {
      fake.failNext({ ...fail, headers: { ...noRetry, ...(fail.headers || {}) }, dialect: 'anthropic' });
      await assert.rejects(send('anthropic', request('anthropic', [userText('x')])), (e) => {
        assert.equal(e.code, code);
        assert.equal(e.message, message);
        assert.equal(e.status, fail.status);
        return true;
      });
    });
  }

  it('the provider text goes only to the log, redacted; a key in it never reaches the message or the log', async () => {
    const leaked = 'sk-ant-api03-LEAKED-in-an-error-body-0123456789';
    fake.failNext({ status: 401, headers: noRetry, dialect: 'openai', body: { error: { message: `invalid key ${leaked} and ${KEYS.openai}`, type: 'invalid_request_error' } } });
    const from = logged.length;
    await assert.rejects(send('openai', request('openai', [userText('x')])), (e) => e.code === 'auth' && e.message === 'OpenAI refused the key. Check it in Settings → Assistant.' && !e.message.includes(leaked));
    const lines = logged.slice(from).join('\n');
    assert.match(lines, /provider request failed/);
    assert.match(lines, /\[redacted\]/);
    assert.ok(!lines.includes(leaked) && !lines.includes(KEYS.openai));
  });

  it('a local server that is not running: "Nothing answered at …"', async () => {
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${closed.address().port}/v1`;
    await new Promise((r) => closed.close(r));
    await assert.rejects(send('openai_compatible', request('openai_compatible', [userText('x')]), { base_url: url }), (e) => {
      assert.equal(e.code, 'unreachable');
      assert.equal(e.message, `Nothing answered at ${url}. Start the server (LM Studio: Developer → Start server; Ollama: \`ollama serve\`) and test again.`);
      return true;
    });
  });

  it('a missing key is reported as no_key, before any request', async () => {
    const before = chat().length;
    const noKeys = { status: () => ({}), withKey: async () => Promise.reject(new ProviderError('no_key', 'No key is saved for this provider. Add one in Settings → Assistant.')) };
    await assert.rejects(send('anthropic', request('anthropic', [userText('x')]), { lender: noKeys }), (e) => e.code === 'no_key');
    assert.equal(chat().length, before);
  });

  it('a key the secret store can’t unlock right now: storage_unavailable with the store’s words, before any request', async () => {
    const before = fake.requests().length;
    const stuck = { status: lender.status, withKey: async () => Promise.reject(new KeyError(409, 'storage_unavailable', STORAGE_NOTES.timeout)) };
    for (const provider of ['anthropic', 'openai']) {
      await assert.rejects(
        send(provider, request(provider, [userText('x')]), { lender: stuck }),
        (e) => e instanceof ProviderError && e.code === 'storage_unavailable' && e.message === STORAGE_NOTES.timeout,
        provider,
      );
      await assert.rejects(adapterFor(provider, { lender: stuck }).listModels(new AbortController().signal), (e) => e instanceof ProviderError && e.code === 'storage_unavailable', provider);
    }
    assert.equal(fake.requests().length, before);
  });

  it('a server token with no address recorded, or for another address, is sent nowhere', async () => {
    const before = fake.requests().length;
    for (const origin of [null, undefined, 'http://127.0.0.1:1']) {
      const tokenFor = { status: () => ({ ...lender.status(), openai_compatible: { set: true, state: 'ok', origin } }), withKey: async (slot, use) => use('token-0001') };
      await assert.rejects(
        adapterFor('openai_compatible', { lender: tokenFor }).listModels(new AbortController().signal),
        (e) => e instanceof ProviderError && e.code === 'no_key' && e.message === tokenElsewhereText(origin ?? null),
        String(origin),
      );
    }
    assert.equal(fake.requests().length, before);
  });

  it('mapProviderError: connection codes, timeouts, aborts and our own errors', () => {
    const ctx = { provider: 'openai_compatible', label: 'The local server', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1', local: true };
    const conn = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    assert.equal(mapProviderError(conn, ctx).code, 'unreachable');
    assert.equal(mapProviderError(conn, { ...ctx, provider: 'openai', label: 'OpenAI', local: false }).message, "Couldn't reach OpenAI. Check this PC's internet connection.");
    const hdr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    assert.equal(mapProviderError(hdr, ctx).code, 'timeout');
    assert.equal(mapProviderError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }), ctx).code, 'aborted');
    const fired = { fired: 'idle', waitedS: 180 };
    assert.equal(mapProviderError(new ProviderError('aborted', 'Stopped.'), { ...ctx, watchdog: fired }).message, 'No answer for 180 s. A local model can take a while to load; try again, or choose a smaller model.');
    const ours = new ProviderError('blocked_origin', 'Blocked.');
    assert.equal(mapProviderError(Object.assign(new Error('Connection error.'), { cause: ours }), ctx), ours);
    const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    assert.equal(mapProviderError(redirect, ctx).code, 'blocked_origin');
    // A caller that aborts with a reason of its own (a time limit) is reported with it; a plain abort is a Stop.
    const limit = new AbortController();
    limit.abort(new ProviderError('timeout', 'The test took longer than 20 minutes.'));
    const byLimit = mapProviderError(new ProviderError('aborted', 'Stopped.'), { ...ctx, signal: limit.signal, streamed: true });
    assert.deepEqual([byLimit.code, byLimit.message, byLimit.streamed], ['timeout', 'The test took longer than 20 minutes.', true]);
    const stop = new AbortController();
    stop.abort();
    const byStop = mapProviderError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }), { ...ctx, signal: stop.signal, streamed: true });
    assert.deepEqual([byStop.code, byStop.message, byStop.streamed], ['aborted', 'Stopped.', true]);
  });
});

describe('the guarded fetch', () => {
  it('refuses any other origin before anything is sent', async () => {
    const before = fake.requests().length;
    const f = guardedFetch({ origin: `${fake.base}/anthropic`, allowHeaders: ['content-type'], label: 't' });
    for (const url of ['http://127.0.0.1:9/v1/messages', `${fake.base.replace('http:', 'https:')}/anthropic/v1/messages`, 'http://localhost.example.com/x']) {
      await assert.rejects(f(url, { method: 'POST' }), (e) => e instanceof ProviderError && e.code === 'blocked_origin', url);
    }
    assert.equal(fake.requests().length, before);
  });

  it('never follows a redirect', async () => {
    const trap = await startFakeLlm();
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { location: `${trap.base}/anthropic/v1/models` });
      res.end();
    });
    await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      const origin = `http://127.0.0.1:${redirector.address().port}`;
      const f = guardedFetch({ origin, allowHeaders: ['x-api-key'], label: 't' });
      const err = await f(`${origin}/v1/models`, { headers: { 'x-api-key': 'k' } }).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, 'the redirect failed the request');
      assert.equal(mapProviderError(err, { provider: 'anthropic', label: 'Anthropic', model: '', baseUrl: origin, local: false }).code, 'blocked_origin');
      assert.equal(trap.requests().length, 0);
    } finally {
      await new Promise((r) => redirector.close(r));
      await trap.stop();
    }
  });

  it('only the allowlist leaves, and the pins have the last word', () => {
    const h = filterHeaders(
      { 'X-Api-Key': 'env', Authorization: 'Bearer env', 'x-stainless-os': 'Windows', 'x-trap': '1', 'anthropic-beta': 'env-beta', 'content-type': 'application/json' },
      { allowHeaders: ['x-api-key', 'anthropic-beta', 'content-type', /^x-stainless-[a-z0-9-]+$/], pin: { 'x-api-key': 'ours', 'anthropic-beta': null, authorization: null } },
    );
    assert.deepEqual(Object.fromEntries(h.entries()), { 'content-type': 'application/json', 'x-api-key': 'ours', 'x-stainless-os': 'Windows' });
  });

  it('the watchdog fires once, for the wait that ran out', async () => {
    const wd = new Watchdog({ firstByteMs: 30, idleMs: 30 });
    wd.request();
    await until(() => wd.signal.aborted, 2000, 'the watchdog');
    assert.equal(wd.fired, 'first_byte');
    wd.done();
  });
});

describe('the environment and the profiles are never read', () => {
  it('provider variables, workload identity and CLI profiles all point at a trap that gets nothing', async () => {
    const trap = await startFakeLlm();
    const home = mkdtempSync(join(ROOT, 'profile-'));
    for (const dir of [join(home, '.config', 'anthropic', 'configs'), join(home, 'AppData', 'Roaming', 'anthropic', 'configs'), join(home, 'anthropic-config', 'configs')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'default.json'), JSON.stringify({ base_url: `${trap.base}/anthropic`, api_key: 'sk-ant-TRAP-profile-key-000000000000' }));
    }
    const tokenFile = join(home, 'identity.jwt');
    writeFileSync(tokenFile, 'trap.jwt.token');
    const poison = {
      ANTHROPIC_API_KEY: 'sk-ant-TRAP-env-key-000000000000000',
      ANTHROPIC_AUTH_TOKEN: 'TRAP-auth-token-00000000000',
      ANTHROPIC_BASE_URL: `${trap.base}/anthropic`,
      ANTHROPIC_PROFILE: 'default',
      ANTHROPIC_CONFIG_DIR: join(home, 'anthropic-config'),
      ANTHROPIC_CUSTOM_HEADERS: 'x-trap: 1\nx-stainless-trap: 2\nx-api-key: sk-ant-TRAP-header-0000000000\nanthropic-beta: trap-beta\nauthorization: Bearer TRAP',
      ANTHROPIC_LOG: 'debug',
      ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_trap',
      ANTHROPIC_ORGANIZATION_ID: 'org-trap',
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_trap',
      ANTHROPIC_IDENTITY_TOKEN: 'trap.jwt.token',
      ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
      ANTHROPIC_WORKSPACE_ID: 'wrkspc_trap',
      ANTHROPIC_SCOPE: 'trap',
      OPENAI_API_KEY: 'sk-TRAP-env-key-0000000000000000',
      OPENAI_ADMIN_KEY: 'sk-admin-TRAP-key-000000000000',
      OPENAI_BASE_URL: `${trap.base}/openai/v1`,
      OPENAI_ORG_ID: 'org-trap',
      OPENAI_PROJECT_ID: 'proj_trap',
      OPENAI_CUSTOM_HEADERS: 'x-trap: 1\nauthorization: Bearer TRAP\nopenai-organization: org-trap\nx-stainless-trap: 2',
      OPENAI_LOG: 'debug',
      OPENAI_WEBHOOK_SECRET: 'whsec_trap',
      ANTHROPIC_WEBHOOK_SIGNING_KEY: 'whsec_trap_anthropic',
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    };
    const saved = {};
    for (const k of Object.keys(poison)) saved[k] = process.env[k];
    Object.assign(process.env, poison);
    const from = fake.requests().length;
    const logFrom = logged.length;
    let trapped;
    try {
      // The SDK clients as the adapters build them: every credential and address explicit.
      const Anthropic = await loadSdkClass('@anthropic-ai/sdk', 'Anthropic');
      const a = new Anthropic(anthropicClientOptions(KEYS.anthropic, `${fake.base}/anthropic`, fetch, process.env));
      assert.deepEqual([a.apiKey, a.authToken, a.webhookKey, a.baseURL, a.logLevel], [KEYS.anthropic, null, null, `${fake.base}/anthropic`, 'off']);
      const OpenAI = await loadSdkClass('openai', 'OpenAI');
      const o = new OpenAI(openAiClientOptions(KEYS.openai, `${fake.base}/openai/v1`, fetch, process.env, 2));
      assert.deepEqual(
        [o.apiKey, o.adminAPIKey, o.organization, o.project, o.webhookSecret, o.baseURL, o.logLevel],
        [KEYS.openai, null, null, null, null, `${fake.base}/openai/v1`, 'off'],
      );
      for (const provider of PROVIDERS) {
        fake.reply({ text: 'ok' });
        await send(provider, request(provider, [userText('x')], { model: provider === 'anthropic' ? 'claude-haiku-5-5' : undefined }));
        await adapterFor(provider).listModels(new AbortController().signal);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      trapped = trap.requests().length;
      await trap.stop();
    }
    assert.equal(trapped, 0, 'the trap got nothing');
    const seen = fake.requests().slice(from);
    assert.equal(seen.length, 6);
    for (const r of seen) {
      const h = r.headers;
      assert.equal(h['x-trap'], undefined, r.path);
      assert.equal(h['x-stainless-trap'], undefined, r.path);
      assert.equal(h['openai-organization'], undefined, r.path);
      assert.equal(h['openai-project'], undefined, r.path);
      if (r.dialect === 'anthropic') {
        assert.equal(h['x-api-key'], KEYS.anthropic);
        assert.equal(h.authorization, undefined, 'no Authorization on the first cloud dialect');
        assert.equal(h['anthropic-beta'], undefined, 'Haiku asks for no beta, whatever the environment says');
        assert.equal(h['anthropic-version'], '2023-06-01');
      } else if (r.dialect === 'openai') {
        assert.equal(h.authorization, `Bearer ${KEYS.openai}`);
        assert.equal(h['x-api-key'], undefined);
      } else {
        assert.equal(h.authorization, 'Bearer local');
      }
    }
    const lines = logged.slice(logFrom).join('\n');
    for (const key of [KEYS.anthropic, KEYS.openai]) assert.ok(!lines.includes(key), 'no SDK logging of the request');
  });
});

describe('the endpoints and the SDK loader', () => {
  it('the test URL is honoured only with the switch, in a test home, for http on this PC', () => {
    const home = { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h') };
    const T = { MAGNUSIM_TEST_ASSISTANT: '1', ...home };
    assert.deepEqual(resolveTestProviderUrl({ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://127.0.0.1:5000/' }), { url: 'http://127.0.0.1:5000', ignored: null });
    assert.equal(resolveTestProviderUrl({ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://[::1]:5000' }).url, 'http://[::1]:5000');
    assert.equal(resolveTestProviderUrl({ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://localhost:5000' }).url, 'http://localhost:5000');
    for (const [env, why] of [
      [{ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://example.com:5000' }, /on this PC/],
      [{ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'https://127.0.0.1:5000' }, /http address/],
      [{ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://127.0.0.1.example.com:5000' }, /on this PC/],
      [{ ...home, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://127.0.0.1:5000' }, /MAGNUSIM_TEST_ASSISTANT=1/],
      [{ MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://127.0.0.1:5000' }, /test home/],
      [{ ...T, MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: 'http://user:pw@127.0.0.1:5000' }, /plain address/],
    ]) {
      const r = resolveTestProviderUrl(env);
      assert.equal(r.url, null, env.MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL);
      assert.match(r.ignored, why);
    }
    assert.equal(cloudBaseUrl('anthropic'), `${fake.base}/anthropic`);
    assert.equal(cloudBaseUrl('openai'), `${fake.base}/openai/v1`);
  });

  it('sdkInstalled finds both pinned packages by folder', async () => {
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
    assert.equal(await sdkInstalled('@anthropic-ai/sdk'), pkg.dependencies['@anthropic-ai/sdk']);
    assert.equal(await sdkInstalled('openai'), pkg.dependencies.openai);
    assert.equal(await sdkInstalled('surely-not-installed-anywhere-xyz'), null);
    assert.equal((await depsStatus()).state, 'ok');
  });

  it('a missing SDK gives deps_missing, and the status says so', async () => {
    setSdkSpecifierForTests('@anthropic-ai/sdk', 'surely-not-installed-anywhere-xyz');
    try {
      await assert.rejects(send('anthropic', request('anthropic', [userText('x')])), (e) => e.code === 'deps_missing' && e.message === DEPS_MISSING_TEXT);
      await assert.rejects(adapterFor('anthropic').listModels(new AbortController().signal), (e) => e.code === 'deps_missing');
      assert.equal((await depsStatus()).state, 'missing');
    } finally {
      setSdkSpecifierForTests('@anthropic-ai/sdk', null);
    }
    assert.equal((await depsStatus()).state, 'ok');
  });

  it('isCloud and destinationOf', () => {
    assert.equal(isCloud({ provider: 'anthropic', base_url: 'http://127.0.0.1:1234/v1' }), true);
    assert.equal(isCloud({ provider: 'openai_compatible', base_url: 'http://127.0.0.1:1234/v1' }), false);
    assert.equal(isCloud({ provider: 'openai_compatible', base_url: 'https://gpu.example.com/v1' }), true);
    assert.equal(isCloud({ provider: 'off', base_url: 'http://127.0.0.1:1234/v1' }), false);
    assert.equal(destinationOf({ provider: 'openai', base_url: '' }), 'openai');
    assert.equal(destinationOf({ provider: 'openai_compatible', base_url: 'https://GPU.example.com/v1' }), 'host:gpu.example.com');
  });
});

describe('model lists', () => {
  it('each dialect lists its models; the second cloud dialect keeps only chat models', async () => {
    const a = await adapterFor('anthropic').listModels(new AbortController().signal);
    assert.deepEqual(a.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.ok(a.every((m) => m.priced));
    const o = await adapterFor('openai').listModels(new AbortController().signal);
    assert.deepEqual(o.map((m) => m.id), ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']);
    const c = await adapterFor('openai_compatible').listModels(new AbortController().signal);
    assert.deepEqual(c.map((m) => m.id), ['qwen3.8-27b', 'gemma-4-31b']);
  });

  it('a list that never comes: the watchdog ends it with timeout, and Stop ends it at once', async () => {
    const lists = () => fake.requests().filter((r) => r.path.endsWith('/v1/models')).length;
    for (const provider of PROVIDERS) {
      fake.holdModels(`list-quiet-${provider}`, DIALECT[provider]);
      let t0 = Date.now();
      const quiet = adapterFor(provider, { watchdog: { firstByteMs: 1000, idleMs: 1000 } }).listModels(new AbortController().signal);
      await within(
        assert.rejects(quiet, (e) => e.code === 'timeout' && e.message.startsWith('No answer for 1 s.'), provider),
        8000,
        `${provider}: the watchdog`,
      );
      assert.ok(Date.now() - t0 < 8000);
      fake.release(`list-quiet-${provider}`);
      fake.holdModels(`list-stop-${provider}`, DIALECT[provider]);
      const n = lists();
      const ctl = new AbortController();
      const stopped = adapterFor(provider).listModels(ctl.signal);
      await until(() => lists() > n, 5000, 'the list request');
      t0 = Date.now();
      ctl.abort();
      await within(assert.rejects(stopped, (e) => e.code === 'aborted', provider), 5000, `${provider}: Stop`);
      assert.ok(Date.now() - t0 < 5000, `${provider}: Stop ends it at once`);
      fake.release(`list-stop-${provider}`);
    }
  });
});

describe("a local server's model row (CAD tools spec H5)", () => {
  const sig = () => new AbortController().signal;
  const rowReads = () => fake.requests().filter((r) => r.kind === 'model_row');

  it("the recorded rows give the context and the type: LM Studio's loaded context, else its maximum; Ollama's num_ctx, else the model's own length", () => {
    assert.deepEqual(lmStudioRow(LOCAL_SERVER_ROWS.lmstudio), { context: 32768, type: 'vlm' }, 'the docs: not loaded, its maximum');
    assert.deepEqual(lmStudioRow(LOCAL_SERVER_ROWS.lmstudioLoaded), { context: 4096, type: 'llm' }, 'loaded with less than its maximum');
    assert.deepEqual(ollamaRow(LOCAL_SERVER_ROWS.ollama), { context: 32768, type: 'llm' }, 'recorded: no num_ctx, the model length');
    const tuned = { ...LOCAL_SERVER_ROWS.ollama, parameters: 'stop                           "<|im_end|>"\nnum_ctx                        8192', capabilities: ['completion', 'tools', 'vision'] };
    assert.deepEqual(ollamaRow(tuned), { context: 8192, type: 'vlm' });
    for (const j of [null, [], 'text', {}, { error: "model 'x' not found" }, { max_context_length: 12 }, { max_context_length: '32768' }, { type: 'not a type!' }]) {
      assert.equal(lmStudioRow(j), null, JSON.stringify(j));
    }
    for (const j of [null, {}, { error: 'not found' }, { model_info: { 'general.architecture': 'qwen2' } }, { model_info: { 'qwen2.context_length': 4096 } }]) {
      assert.equal(ollamaRow(j), null, JSON.stringify(j));
    }
    assert.deepEqual(
      ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/', 'http://127.0.0.1:11434', 'http://127.0.0.1:9/compat/v1'].map(serverRoot),
      ['http://127.0.0.1:1234', 'http://127.0.0.1:1234', 'http://127.0.0.1:11434', 'http://127.0.0.1:9/compat'],
    );
  });

  it("the adapter asks the server: LM Studio's route first, then Ollama's; an id with / and : in the path; the server token only; a server with neither gives null", async () => {
    fake.models([{ id: 'lab/qwen3:8b', context: 16384, type: 'vlm' }, { id: 'ol-model', max: 40960, server: 'ollama' }, 'plain-model'], 'compat');
    try {
      const from = fake.requests().length;
      const a = adapterFor('openai_compatible');
      assert.deepEqual(await a.modelRow('lab/qwen3:8b', sig()), { context: 16384, type: 'vlm' });
      assert.deepEqual(await a.modelRow('ol-model', sig()), { context: 40960, type: 'llm' });
      assert.equal(await a.modelRow('plain-model', sig()), null);
      const seen = fake.requests().slice(from);
      assert.deepEqual(
        seen.map((r) => [r.kind, r.method, r.path, r.body]),
        [
          ['model_row', 'GET', '/compat/api/v0/models/lab/qwen3:8b', null],
          ['model_row', 'GET', '/compat/api/v0/models/ol-model', null],
          ['model_row', 'POST', '/compat/api/show', { model: 'ol-model' }],
          ['model_row', 'GET', '/compat/api/v0/models/plain-model', null],
          ['model_row', 'POST', '/compat/api/show', { model: 'plain-model' }],
        ],
      );
      for (const r of seen) assert.equal(r.headers.authorization, 'Bearer local');
      for (const provider of ['anthropic', 'openai']) assert.equal(adapterFor(provider).modelRow, undefined, provider);
    } finally {
      fake.models(['qwen3.8-27b', 'gemma-4-31b'], 'compat');
    }
  });

  it('a row (or its absence) is kept 60 s per base URL and model, for every adapter on that server; a test reset forgets it', async () => {
    let now = 5_000_000;
    const clock = { now: () => now };
    fake.models([{ id: 'kept-model', context: 8192 }], 'compat');
    try {
      const a = adapterFor('openai_compatible', clock);
      let n = rowReads().length;
      assert.deepEqual(await a.modelRow('kept-model', sig()), { context: 8192, type: 'llm' });
      assert.equal(rowReads().length, n + 1);
      fake.models([{ id: 'kept-model', context: 65536 }], 'compat');
      now += MODEL_ROW_TTL_MS - 1;
      // Each turn makes its own adapter: the next one still uses the kept row.
      assert.deepEqual(await adapterFor('openai_compatible', clock).modelRow('kept-model', sig()), { context: 8192, type: 'llm' });
      assert.equal(rowReads().length, n + 1, 'kept');
      assert.equal(await a.modelRow('missing-model', sig()), null);
      n = rowReads().length;
      assert.equal(await a.modelRow('missing-model', sig()), null);
      assert.equal(rowReads().length, n, 'a server without a row is not asked again either');
      now += 1;
      assert.deepEqual(await a.modelRow('kept-model', sig()), { context: 65536, type: 'llm' }, 'read again after 60 s');
      fake.models([{ id: 'kept-model', context: 4096 }], 'compat');
      resetAssistantState();
      assert.deepEqual(await a.modelRow('kept-model', sig()), { context: 4096, type: 'llm' }, 'a reset forgets');
    } finally {
      fake.models(['qwen3.8-27b', 'gemma-4-31b'], 'compat');
    }
  });

  it('no row from a page, a body over 1 MB or a server that never answers (within the row wait); a Stop mid-read gives null at once and keeps nothing', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      if (req.url.startsWith('/page/')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Server</title>');
      } else if (req.url.startsWith('/big/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'llm', max_context_length: 32768, pad: 'x'.repeat(1_100_000) }));
      }
      // Anything else is never answered.
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const root = `http://127.0.0.1:${server.address().port}`;
    const quick = { watchdog: { firstByteMs: 300, idleMs: 300 } };
    try {
      assert.equal(await adapterFor('openai_compatible', { base_url: `${root}/page/v1` }).modelRow('m', sig()), null);
      assert.equal(hits, 2, 'both routes asked');
      assert.equal(await adapterFor('openai_compatible', { base_url: `${root}/big/v1` }).modelRow('m', sig()), null);
      let t0 = Date.now();
      assert.equal(await within(adapterFor('openai_compatible', { base_url: `${root}/v1`, ...quick }).modelRow('quiet', sig()), 8000, 'the row wait'), null);
      assert.ok(Date.now() - t0 < 8000);
      const ctl = new AbortController();
      const n = hits;
      const reading = adapterFor('openai_compatible', { base_url: `${root}/v1` }).modelRow('stopped', ctl.signal);
      await until(() => hits > n, 5000, 'the row request');
      t0 = Date.now();
      ctl.abort();
      assert.equal(await within(reading, 4000, 'Stop mid-read'), null);
      assert.ok(Date.now() - t0 < 4000, 'at once, not after the 5 s row wait');
      const m = hits;
      assert.equal(await adapterFor('openai_compatible', { base_url: `${root}/v1`, ...quick }).modelRow('stopped', sig()), null);
      assert.ok(hits > m, 'the stopped read was not kept: the server is asked again');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('prices (as of 2026-10-16) and the spend estimate', () => {
  // [model, input, 5 m write, 1 h write, cache read, output, long: [above, input, 5 m, 1 h, read, output] | null, picker]
  const TABLE = [
    ['claude-opus-5-5', 4, 5, 8, 0.2, 20, null, true],
    ['claude-sonnet-5-5', 2, 2.5, 4, 0.1, 10, null, true],
    ['claude-haiku-5-5', 0.1, 0.125, 0.2, 0.01, 0.5, [100_000, 0.5, 0.625, 1, 0.05, 2.5], true],
    ['claude-opus-5', 5, 6.25, 10, 0.5, 25, null, false],
    ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25, null, false],
    ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10, null, false],
    ['gpt-6.1-sol', 2, 2.5, 2.5, 0.1, 10, [272_000, 4, 5, 5, 0.2, 15], true],
    ['gpt-6-astra', 10, 12.5, 12.5, 1, 50, [272_000, 20, 25, 25, 2, 75], true],
    ['gpt-6-sol', 2, 2.5, 2.5, 0.2, 10, [272_000, 4, 5, 5, 0.4, 15], true],
    ['gpt-6-luna', 0.1, 0.125, 0.125, 0.01, 0.5, [272_000, 0.2, 0.25, 0.25, 0.02, 0.75], true],
  ];

  it('every row is pinned, with its date', () => {
    assert.equal(prices.PRICES_AS_OF, '2026-10-16');
    assert.deepEqual(
      prices.PRICES.map((r) => [r.model, r.input, r.write5m, r.write1h, r.read, r.output, r.long && [r.long.above, r.long.input, r.long.write5m, r.long.write1h, r.long.read, r.long.output], r.picker]),
      TABLE,
    );
    const src = readFileSync(join(WEB, 'scripts', 'server', 'assistant', 'prices.ts'), 'utf8');
    assert.equal(src.match(/read 2026-10-16/g).length, TABLE.length, 'each row says where and when it was read');
    assert.deepEqual(prices.FALLBACK_TARGETS, { 'claude-opus-5-5': ['claude-opus-5', 'claude-opus-4-8'], 'claude-sonnet-5-5': ['claude-sonnet-5'] });
  });

  const usage = (o) => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, complete: true, ...o });

  it('costOf, the long tier per request, dated ids, unknown models at the dearest, local free', () => {
    const opus = prices.priceRow('claude-opus-5-5');
    assert.ok(Math.abs(prices.costOf(opus, usage({ input: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 })) - (4 + 5 + 8 + 0.2 + 20)) < 1e-9);
    const haiku = prices.priceRow('claude-haiku-5-5');
    assert.equal(prices.ratesFor(haiku, 100_000).input, 0.1);
    assert.equal(prices.ratesFor(haiku, 100_001).input, 0.5);
    assert.equal(prices.priceRow('gpt-6.1-sol-2026-08-01').model, 'gpt-6.1-sol');
    assert.equal(prices.priceRow('claude-opus-5-5-20261001').model, 'claude-opus-5-5');
    assert.equal(prices.priceRow('claude-opus-5-55'), null);
    const unknown = prices.requestCost('anthropic', [{ model: 'claude-future-9', usage: usage({ input: 1e6, output: 1e6 }), fallback: false }]);
    assert.deepEqual(unknown, { usd: 5 + 25, estimated: true });
    const longHaiku = prices.requestCost('anthropic', [{ model: 'claude-haiku-5-5', usage: usage({ input: 50_000, cacheRead: 60_000, output: 1000 }), fallback: false }]);
    assert.ok(Math.abs(longHaiku.usd - (50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
    assert.deepEqual(prices.requestCost('openai_compatible', [{ model: 'x', usage: usage({ input: 1e9 }), fallback: false }]), { usd: 0, estimated: false });
    assert.equal(prices.requestCost('anthropic', [{ model: 'claude-opus-5-5', usage: usage({ input: 1, complete: false }), fallback: false }]).estimated, true);
  });

  const base = {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    cloud: true,
    fallbackTargets: [],
    newChars: 3000,
    newImages: [],
    toolCount: 4,
    firstStep: false,
    prev: null,
    now: 1_000_000,
    remainingUsd: 100,
  };

  it('estimateStep: fresh text, images and tools as cache writes; the prefix read only within 4 minutes of its start', () => {
    const e = prices.estimateStep({ ...base, firstStep: true, newImages: [{ width: 1000, height: 750 }, { width: 8000, height: 8000 }] });
    const fresh = Math.ceil((1.2 * 3000) / 3) + 1000 + 5334 + 4 * 500;
    assert.equal(e.promptTokens, fresh);
    assert.ok(Math.abs(e.inputUsd - (fresh * 0.125) / 1e6) < 1e-12);
    assert.equal(e.maxOut, 32_000);
    const prev = { promptTokens: 50_000, startedAt: base.now - 239_000, cacheUsed: true };
    const warm = prices.estimateStep({ ...base, prev });
    assert.ok(Math.abs(warm.inputUsd - (50_000 * 0.01 + 1200 * 0.125) / 1e6) < 1e-12, 'read under 4 minutes');
    const cold = prices.estimateStep({ ...base, prev: { ...prev, startedAt: base.now - 241_000 } });
    assert.ok(Math.abs(cold.inputUsd - (50_000 * 0.1 + 1200 * 0.125) / 1e6) < 1e-12, 'input after 4 minutes');
    const uncached = prices.estimateStep({ ...base, prev: { ...prev, cacheUsed: false } });
    assert.equal(uncached.inputUsd, cold.inputUsd);
  });

  it('estimateStep: the output limit is what the money left buys; under 2048 tokens the turn is capped', () => {
    const e = prices.estimateStep({ ...base, model: 'claude-opus-5-5', remainingUsd: 0.1 });
    const input = (1200 * 5) / 1e6;
    assert.equal(e.maxOut, Math.floor(((0.1 - input) / 20) * 1e6));
    assert.ok(e.usd <= 0.1 + 1e-12);
    assert.equal(e.capped, false);
    const tight = prices.estimateStep({ ...base, model: 'claude-opus-5-5', remainingUsd: 0.04 });
    assert.equal(tight.capped, true);
    const local = prices.estimateStep({ ...base, provider: 'openai_compatible', cloud: false, remainingUsd: 0 });
    assert.deepEqual([local.usd, local.maxOut, local.capped, local.noRoom], [0, 8192, false, false]);
  });

  it("estimateStep: a local server answers up to 8192 tokens, within the room its reported context leaves (CAD tools spec H5)", () => {
    const local = { ...base, provider: 'openai_compatible', cloud: false, remainingUsd: Number.POSITIVE_INFINITY, firstStep: true, toolCount: 21, newChars: 30_000 };
    const prompt = Math.ceil((1.2 * 30_000) / 3) + 21 * 500;
    assert.deepEqual([prices.MAX_OUT_LOCAL, prices.MIN_OUT, prices.CONTEXT_MARGIN], [8192, 2048, 1024]);
    let e = prices.estimateStep(local);
    assert.deepEqual([e.maxOut, e.noRoom, e.capped, e.usd, e.promptTokens], [8192, false, false, 0, prompt], 'no context known: the cap');
    e = prices.estimateStep({ ...local, contextTokens: 65_536 });
    assert.deepEqual([e.maxOut, e.noRoom], [8192, false]);
    e = prices.estimateStep({ ...local, contextTokens: 28_000 });
    assert.deepEqual([e.maxOut, e.noRoom], [28_000 - prompt - 1024, false]);
    e = prices.estimateStep({ ...local, contextTokens: prompt + 1024 + 2048 });
    assert.deepEqual([e.maxOut, e.noRoom], [2048, false], 'MIN_OUT left is enough');
    e = prices.estimateStep({ ...local, contextTokens: prompt + 1024 + 2047 });
    assert.deepEqual([e.maxOut, e.noRoom, e.capped], [2047, true, false]);
    e = prices.estimateStep({ ...local, contextTokens: 16_384 });
    assert.deepEqual([e.maxOut, e.noRoom], [0, true], 'a 16K context under a 22.5K prompt');
    // A later step: the previous request's prompt plus what this one adds.
    e = prices.estimateStep({ ...local, firstStep: false, newChars: 3000, prev: { promptTokens: 20_000, startedAt: base.now, cacheUsed: false }, contextTokens: 28_000 });
    assert.equal(e.maxOut, 28_000 - (20_000 + 1200) - 1024);
    // A local server elsewhere (project data leaves this PC) keeps the larger cap, in its room.
    assert.equal(prices.estimateStep({ ...local, cloud: true, contextTokens: 200_000 }).maxOut, 32_000);
    assert.equal(prices.estimateStep({ ...local, cloud: true, contextTokens: 40_000 }).maxOut, 40_000 - prompt - 1024);
    // A cloud provider's context is not the local rule's.
    e = prices.estimateStep({ ...base, contextTokens: 1000 });
    assert.deepEqual([e.maxOut, e.noRoom], [32_000, false]);
  });

  it('estimateStep: a fallback-capable request is priced at the dearest of its rows; an unknown model at the provider’s dearest', () => {
    const e = prices.estimateStep({ ...base, model: 'claude-opus-5-5', fallbackTargets: ['claude-opus-5', 'claude-opus-4-8'], remainingUsd: 1 });
    assert.deepEqual(e.rates, { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 });
    const u = prices.estimateStep({ ...base, model: 'claude-mystery', remainingUsd: 1 });
    assert.equal(u.estimated, true);
    assert.equal(u.rates.output, 25);
  });

  it('estimateStep: a fallback-capable request reserves one input for each model that may run (the declined attempt is billed too)', () => {
    const targets = ['claude-opus-5', 'claude-opus-4-8'];
    const e = prices.estimateStep({ ...base, model: 'claude-opus-5-5', fallbackTargets: targets, remainingUsd: 100 });
    const input = (1200 * 6.25) / 1e6;
    assert.ok(Math.abs(e.inputUsd - input) < 1e-12, 'one attempt’s input (what a cut-off answer is billed)');
    assert.ok(Math.abs(e.fallbackInputUsd - 2 * input) < 1e-12);
    assert.ok(Math.abs(e.usd - (3 * input + (32_000 * 25) / 1e6)) < 1e-12, String(e.usd));
    // The output limit is what is left once every attempt's input is reserved.
    const tight = prices.estimateStep({ ...base, model: 'claude-opus-5-5', fallbackTargets: targets, remainingUsd: 0.5 });
    assert.equal(tight.maxOut, Math.floor(((0.5 - 3 * input) / 25) * 1e6));
    assert.ok(tight.usd <= 0.5 + 1e-12);
    const none = prices.estimateStep({ ...base, model: 'claude-haiku-5-5', remainingUsd: 100 });
    assert.equal(none.fallbackInputUsd, 0);
  });

  it('priceInfo for Settings', () => {
    assert.deepEqual(
      (({ known, local, input, output, cache_read }) => ({ known, local, input, output, cache_read }))(prices.priceInfo('anthropic', 'claude-sonnet-5-5')),
      { known: true, local: false, input: 2, output: 10, cache_read: 0.1 },
    );
    const u = prices.priceInfo('openai', 'gpt-7-preview');
    assert.equal(u.known, false);
    assert.equal(u.output, 50);
    assert.equal(prices.priceInfo('openai_compatible', 'qwen').local, true);
    assert.deepEqual(prices.curatedModels('anthropic').map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.deepEqual(prices.curatedModels('openai').map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
  });
});

describe('the routes: status, models and the connection test', () => {
  let server;
  let handle;
  let port;
  before(async () => {
    const router = new Router();
    handle = routes.registerAssistantRoutes(router, { port: () => port });
    server = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => {
    handle?.shutdown();
    await new Promise((r) => server.close(r));
  });

  const api = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: await r.json() };
  };

  it('status: packages, providers, price, fallback, the test switch and readiness', async () => {
    let s = (await api('GET', '/api/assistant/status')).json;
    assert.equal(s.deps, 'ok');
    assert.deepEqual(s.providers.map((p) => [p.id, p.label, p.cloud, p.destination, p.key]), [
      ['anthropic', 'Anthropic', true, 'anthropic', 'required'],
      ['openai', 'OpenAI', true, 'openai', 'required'],
      ['openai_compatible', 'Local server', false, 'host:127.0.0.1', 'optional'],
    ]);
    assert.equal(s.price, null);
    assert.equal(s.prices_as_of, '2026-10-16');
    assert.deepEqual(s.fallback, { on: false, targets: [] });
    assert.equal(s.test_provider, true);
    assert.deepEqual([s.ready, s.ready_reason], [false, 'provider_off']);
    s = (await api('POST', '/api/assistant/settings', { provider: 'anthropic' })).json;
    assert.deepEqual([s.ready, s.ready_reason], [false, 'no_key']);
    assert.equal(s.price.input, 4);
    assert.deepEqual(s.fallback, { on: true, targets: ['claude-opus-5', 'claude-opus-4-8'] });
    s = (await api('POST', '/api/assistant/key', { provider: 'anthropic', key: KEYS.anthropic })).json;
    assert.deepEqual([s.ready, s.ready_reason], [true, null]);
    s = (await api('POST', '/api/assistant/settings', { model: 'claude-future-9' })).json;
    assert.equal(s.price.known, false);
    assert.equal(s.price.output, 25);
    assert.deepEqual(s.fallback, { on: false, targets: [] });
    s = (await api('POST', '/api/assistant/settings', { model: 'claude-opus-5-5' })).json;
    assert.ok(!JSON.stringify(s).includes(KEYS.anthropic));
  });

  it('models: the curated list without a key, merged with the provider’s list with one, the local server’s own, 400 and 502', async () => {
    let r = await api('GET', '/api/assistant/models?provider=openai');
    assert.deepEqual([r.status, r.json.source], [200, 'curated']);
    assert.deepEqual(r.json.models.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
    fake.models(['claude-sonnet-5-5', 'claude-extra-2', 'claude-extra-1'], 'anthropic');
    r = await api('GET', '/api/assistant/models?provider=anthropic');
    assert.deepEqual([r.status, r.json.source], [200, 'provider']);
    assert.deepEqual(r.json.models.map((m) => [m.id, m.priced]), [
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', true],
      ['claude-extra-1', false],
      ['claude-extra-2', false],
    ]);
    const listed = fake.requests().filter((q) => q.path === '/anthropic/v1/models').at(-1);
    assert.equal(listed.headers['x-api-key'], KEYS.anthropic);
    await api('POST', '/api/assistant/settings', { base_url: fake.compatBase });
    r = await api('GET', '/api/assistant/models?provider=openai_compatible');
    assert.deepEqual([r.status, r.json.source, r.json.models.map((m) => m.id)], [200, 'server', ['qwen3.8-27b', 'gemma-4-31b']]);
    r = await api('GET', '/api/assistant/models?provider=bogus');
    assert.deepEqual([r.status, r.json.code], [400, 'bad_provider']);
    fake.failNext({ status: 401, headers: { 'x-should-retry': 'false' }, dialect: 'anthropic' });
    r = await api('GET', '/api/assistant/models?provider=anthropic');
    assert.deepEqual([r.status, r.json.code, r.json.error], [502, 'auth', 'Anthropic refused the key. Check it in Settings → Assistant.']);
    assert.equal(r.json.models.length, 3, 'the curated list still comes back');
  });

  it('the test: tool calling works, two requests, priced and counted in today’s spend', async () => {
    await api('POST', '/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5' });
    fake.reply({ tools: [{ name: 'connection_check', input: { word: 'ok' } }], usage: { input: 700, output: 40 } }, { text: 'Connected.', usage: { input: 760, output: 5 } });
    const before = chat('anthropic').length;
    const r = await api('POST', '/api/assistant/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.deepEqual([r.json.model, r.json.served_by, r.json.tools, r.json.requests], ['claude-opus-5-5', 'claude-opus-5-5', 'works', 2]);
    const expected = (700 * 4 + 40 * 20 + 760 * 4 + 5 * 20) / 1e6;
    assert.ok(Math.abs(r.json.cost_usd - expected) < 1e-9, String(r.json.cost_usd));
    assert.ok(r.json.spent_today_usd > 0);
    assert.ok((await api('GET', '/api/assistant/status')).json.spent_today_usd > 0);
    const sent = chat('anthropic').slice(before);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body.tools.map((t) => t.name), ['connection_check']);
    assert.equal(sent[1].body.messages[2].content[0].type, 'tool_result');
    assert.equal((await spendLedger()).openCount(), 0, 'every reservation settled');
  });

  it('the test: a model that ignores the tool, a local template that writes the call as text, a refused key', async () => {
    fake.reply({ text: 'Connected.' });
    let r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.json.ok, r.json.tools, r.json.requests], [true, 'not_used', 1]);
    fake.failNext({ status: 401, headers: { 'x-should-retry': 'false' }, dialect: 'anthropic' });
    r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.status, r.json.ok, r.json.code, r.json.error], [200, false, 'auth', 'Anthropic refused the key. Check it in Settings → Assistant.']);
    await api('POST', '/api/assistant/settings', { provider: 'openai_compatible', model: 'qwen3.8-27b' });
    fake.reply({ rawToolText: '<tool_call>{"name": "connection_check", "arguments": {"word": "ok"}}</tool_call>' });
    r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.json.ok, r.json.tools, r.json.cost_usd], [true, 'as_text', 0]);
  });

  it('the routes’ time limits: above what the watchdog allows, and running out reads timeout, not Stopped', async () => {
    for (const provider of PROVIDERS) {
      const wd = provider === 'openai_compatible' ? LOCAL_WATCHDOG : CLOUD_WATCHDOG;
      // Two requests, each allowed its whole first-byte wait and then time to answer.
      assert.ok(routes.testBoundMs(provider) >= 2 * (wd.firstByteMs + 60_000), provider);
    }
    const silent = await silentServer();
    try {
      const adapter = createAdapter({ provider: 'openai_compatible', base_url: silent.url }, lender, { watchdog: { firstByteMs: 30_000, idleMs: 30_000 } });
      const bound = routes.boundedSignal(300, () => routes.testTimeoutError('openai_compatible', 300));
      const t0 = Date.now();
      let r;
      try {
        r = await within(
          runConnectionTest({ adapter, provider: 'openai_compatible', model: 'qwen3.8-27b', effort: 'default', ledger: await spendLedger(), dayCapUsd: null, signal: bound.signal }),
          8000,
          'the test',
        );
      } finally {
        bound.done();
      }
      assert.ok(Date.now() - t0 < 8000);
      assert.deepEqual([r.ok, r.code], [false, 'timeout'], JSON.stringify(r));
      assert.match(r.error, /^The test took longer than .*A local model can take a while to load/);
      // The model list's limit, the same way.
      const lb = routes.boundedSignal(300, () => routes.modelsTimeoutError(300));
      try {
        await within(assert.rejects(adapter.listModels(lb.signal), (e) => e.code === 'timeout' && e.message === 'No answer for 0.3 s.'), 8000, 'the list');
      } finally {
        lb.done();
      }
    } finally {
      await silent.stop();
    }
  });

  it('the test right after a restart, when the key helper fails: storage_unavailable, never an unexpected error', async () => {
    await api('POST', '/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5', caps: { turn_usd: 3, day_usd: 15 } });
    assert.equal((await api('GET', '/api/assistant/status')).json.keys.anthropic.set, true);
    // A restart: nothing cached, and the helper that unlocks the saved key times out.
    resetAssistantState();
    process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'timeout';
    const before = chat().length;
    try {
      let r = await api('POST', '/api/assistant/test', {});
      assert.deepEqual([r.status, r.json.ok, r.json.code, r.json.error], [200, false, 'storage_unavailable', UNLOCK_NOTES.timeout]);
      assert.equal((await spendLedger()).openCount(), 0, 'the reservation was settled');
      // Nothing to wait for: the status is not held back, and a Test at once tries the helper again.
      assert.equal((await api('GET', '/api/assistant/status')).json.storage.reason, null);
      r = await api('POST', '/api/assistant/test', {});
      assert.deepEqual([r.status, r.json.ok, r.json.code, r.json.error], [200, false, 'storage_unavailable', UNLOCK_NOTES.timeout]);
      r = await api('GET', '/api/assistant/models?provider=anthropic');
      assert.deepEqual([r.status, r.json.code, r.json.error], [502, 'storage_unavailable', UNLOCK_NOTES.timeout]);
      assert.equal(chat().length, before, 'nothing was sent');
    } finally {
      process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
      resetAssistantState();
    }
  });

  it('a test nobody waits for stops when its request closes, and the next one runs at once (no 409)', async () => {
    await api('POST', '/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5', caps: { turn_usd: 3, day_usd: 15 } });
    await api('POST', '/api/assistant/key', { provider: 'anthropic', key: KEYS.anthropic });
    fake.reply({ text: 'slow', hold: 'test-gone' });
    const before = { chats: chat('anthropic').length, closed: fake.disconnects() };
    // The page's request, which the page lets go (a reload, Settings left) while the model answers.
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/assistant/test', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end('{}');
    // The stopped test winds down only once its spend is settled: held here, so the next
    // test can't be let in by the old one having finished.
    const ledger = await spendLedger();
    let releaseSettle = () => {};
    const settled = new Promise((r) => (releaseSettle = r));
    ledger.settle = async (...args) => {
      delete ledger.settle;
      await settled;
      return ledger.settle(...args);
    };
    try {
      await until(() => chat('anthropic').length > before.chats && chat('anthropic').at(-1)?.step?.hold === 'test-gone', 5000, 'the test reaching the provider');
      assert.ok(assistantState().test, 'a test runs');
      req.destroy();
      // The server lets the provider's request go: the test stopped ...
      await until(() => fake.disconnects() > before.closed, 5000, 'the provider request closing');
      // ... and the next test may start at once, while the stopped one still winds down.
      assert.equal(assistantState().test, null);
      fake.reply({ tools: [{ name: 'connection_check', input: { word: 'ok' } }] }, { text: 'Connected.' });
      const r = await api('POST', '/api/assistant/test', {});
      assert.deepEqual([r.status, r.json.ok, r.json.tools], [200, true, 'works'], JSON.stringify(r.json));
      releaseSettle();
      await until(() => ledger.openCount() === 0, 5000, 'every reservation settled');
    } finally {
      releaseSettle();
      delete ledger.settle;
      req.destroy();
      fake.release('test-gone');
    }
  });

  it('the test can’t start: off, no key, one already running (409), today’s limit', async () => {
    await api('POST', '/api/assistant/settings', { provider: 'off' });
    let r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.status, r.json.code], [400, 'provider_off']);
    await api('POST', '/api/assistant/settings', { provider: 'openai' });
    r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.status, r.json.code, r.json.error], [400, 'no_key', 'No key is saved for OpenAI. Add one first.']);
    await api('POST', '/api/assistant/settings', { provider: 'anthropic' });
    fake.reply({ text: 'slow', hold: 'test-busy' });
    const first = api('POST', '/api/assistant/test', {});
    await until(() => chat('anthropic').at(-1)?.step?.hold === 'test-busy', 5000, 'the first test');
    r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.status, r.json.code], [409, 'busy']);
    fake.release('test-busy');
    assert.equal((await first).json.ok, true);
    // Today's limit: the room left can't hold a test request.
    await api('POST', '/api/assistant/settings', { caps: { turn_usd: 0.05, day_usd: 0.1 } });
    const ledger = await spendLedger();
    const held = await ledger.reserve(Math.max(0, 0.1 - ledger.spentToday() - 0.001));
    const before = chat().length;
    r = await api('POST', '/api/assistant/test', {});
    assert.deepEqual([r.status, r.json.ok, r.json.code], [200, false, 'cap_day']);
    assert.match(r.json.error, /Today's \$0\.10 limit is reached/);
    assert.equal(chat().length, before, 'nothing was sent');
    await ledger.settle(held, 0);
  });

  it('a saved server token goes only to the server it was saved for; the status says when it is for another or can’t be unlocked', async () => {
    const TOKEN = 'local-server-token-0123456789';
    // Two local servers that list one model and note the token each request carries.
    const seen = [];
    const servers = [];
    for (const n of [0, 1]) {
      const srv = http.createServer((req, res) => {
        seen.push({ server: n, path: req.url, auth: req.headers.authorization ?? null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model', object: 'model', created: 0, owned_by: 'me' }] }));
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      servers.push(srv);
    }
    const origin = (n) => `http://127.0.0.1:${servers[n].address().port}`;
    const base = (n) => `${origin(n)}/v1`;
    try {
      await api('POST', '/api/assistant/settings', { provider: 'openai_compatible', base_url: base(0), model: 'local-model' });
      let r = await api('POST', '/api/assistant/key', { provider: 'openai_compatible', key: TOKEN });
      assert.equal(r.status, 200);
      assert.equal(r.json.warning, undefined);
      assert.equal(r.json.keys.openai_compatible.origin, origin(0));
      assert.deepEqual([r.json.ready, r.json.ready_reason], [true, null]);
      r = await api('GET', '/api/assistant/models?provider=openai_compatible');
      assert.deepEqual([r.status, r.json.source], [200, 'server']);
      assert.deepEqual(seen.splice(0), [{ server: 0, path: '/v1/models', auth: `Bearer ${TOKEN}` }]);

      // Another address: the token is not sent there, and the status and each use say why.
      let s = (await api('POST', '/api/assistant/settings', { base_url: base(1) })).json;
      assert.deepEqual([s.ready, s.ready_reason], [false, 'token_other_server']);
      r = await api('GET', '/api/assistant/models?provider=openai_compatible');
      assert.deepEqual([r.status, r.json.code, r.json.error], [502, 'no_key', tokenElsewhereText(origin(0))]);
      r = await api('POST', '/api/assistant/test', {});
      assert.deepEqual([r.json.ok, r.json.code, r.json.error], [false, 'no_key', tokenElsewhereText(origin(0))]);
      assert.deepEqual(seen, [], 'nothing reached the other server');

      // Saved for a server off this PC on plain http: kept, with a warning (nothing is sent).
      await api('POST', '/api/assistant/settings', { base_url: 'http://192.168.1.20:1234/v1', confirm_remote: true });
      r = await api('POST', '/api/assistant/key', { provider: 'openai_compatible', key: TOKEN });
      assert.equal(r.status, 200);
      assert.equal(r.json.warning, 'http://192.168.1.20:1234 is not on this PC and its address starts with http://, so the token travels to it unencrypted.');

      // Saved again for the second server, it goes there.
      await api('POST', '/api/assistant/settings', { base_url: base(1) });
      r = await api('POST', '/api/assistant/key', { provider: 'openai_compatible', key: TOKEN });
      assert.deepEqual([r.json.ready, r.json.keys.openai_compatible.origin, r.json.warning], [true, origin(1), undefined]);
      r = await api('GET', '/api/assistant/models?provider=openai_compatible');
      assert.equal(r.status, 200);
      assert.deepEqual(seen.splice(0), [{ server: 1, path: '/v1/models', auth: `Bearer ${TOKEN}` }]);

      // After a restart Windows blocks the key helper: the token can't be unlocked, and Settings says so before any use.
      process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'blocked';
      resetAssistantState();
      s = (await api('GET', '/api/assistant/status')).json;
      assert.deepEqual([s.ready, s.ready_reason, s.keys.openai_compatible.set], [false, 'token_locked', true]);
      assert.deepEqual(s.storage, { kind: 'unavailable', reason: 'blocked', note: TOKEN_BLOCKED_NOTE });
      r = await api('GET', '/api/assistant/models?provider=openai_compatible');
      assert.deepEqual([r.status, r.json.code, r.json.error], [502, 'storage_unavailable', TOKEN_BLOCKED_TEXT]);
      assert.deepEqual(seen, []);
      // Removing it is the way out: the server is used without a token.
      r = await api('POST', '/api/assistant/key/remove', { provider: 'openai_compatible' });
      assert.deepEqual([r.json.ready, r.json.ready_reason, r.json.storage.note], [true, null, STORAGE_NOTES.blocked]);
      r = await api('GET', '/api/assistant/models?provider=openai_compatible');
      assert.equal(r.status, 200);
      assert.deepEqual(seen.splice(0), [{ server: 1, path: '/v1/models', auth: 'Bearer local' }]);
    } finally {
      process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
      resetAssistantState();
      await api('POST', '/api/assistant/key/remove', { provider: 'openai_compatible' });
      for (const srv of servers) {
        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(r));
      }
    }
  });
});
