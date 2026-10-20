// The provider debug log (MAGNUSIM_ASSISTANT_DEBUG_LOG): the real adapters against the fake
// provider (e2e/support/fake-llm.mjs) append one row per request to <folder>/provider.jsonl,
// with the whole request as sent and the provider's whole answer to a failure; never a key or
// a registered secret; image data as a marker; off when the variable is unset; a folder that
// can't be written never fails a request.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-debug-log-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) {
  if (k.startsWith('MAGNUSIM_TEST_ASSISTANT') || k.startsWith('MAGNUSIM_ASSISTANT_DEBUG') || k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_')) delete process.env[k];
}
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
const LOG_DIR = join(ROOT, 'debug');
process.env.MAGNUSIM_ASSISTANT_DEBUG_LOG = LOG_DIR;

const { startFakeLlm } = await import('../../../e2e/support/fake-llm.mjs');
const fake = await startFakeLlm();
process.env.MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL = fake.base;

const { createAdapter } = await import('../assistant/providers/index.ts');
const { STRICT_FALLBACK_NOTE } = await import('../assistant/providers/common.ts');
const { debugCall, debugLogDir, flushDebugLog, resetDebugLogForTests, withDebugScope, DEBUG_LOG_FILE, DEBUG_LOG_ENV } = await import('../assistant/debug-log.ts');
const { registerSecretForRedaction } = await import('../assistant/redact.ts');
const { resetAssistantState } = await import('../assistant/state.ts');

const FILE = join(LOG_DIR, DEBUG_LOG_FILE);
const KEYS = {
  anthropic: 'sk-ant-api03-DEBUGLOG-test-key-0123456789-Ab1',
  openai: 'sk-proj-DEBUGLOG-test-key-0123456789-Cd2',
  openai_compatible: null,
};
const lender = {
  status: () => ({ anthropic: { set: true, state: 'ok' }, openai: { set: true, state: 'ok' }, openai_compatible: { set: false, state: 'none' } }),
  withKey: async (slot, use) => use(KEYS[slot]),
};
const MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: 'qwen3.8-27b' };
const DIALECT = { anthropic: 'anthropic', openai: 'openai', openai_compatible: 'compat' };
const CLOUD = ['anthropic', 'openai'];

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const HOST = [{ name: 'app_status', description: 'The app.', schema: obj({}) }];
const WS = [
  { name: 'demo__add', description: 'Add to the counter.', schema: obj({ by: { type: 'integer', minimum: -100, maximum: 100 } }), workspace: true },
  { name: 'demo__reset', description: 'Reset it.', schema: obj({}), workspace: true },
];
const REFUSED = {
  anthropic: { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } },
  openai: {
    error: {
      message: "Invalid schema for function 'demo__add': In context=('properties', 'by'), 'minimum' is not permitted.",
      type: 'invalid_request_error',
      param: 'tools[1].parameters',
      code: 'invalid_function_parameters',
    },
  },
};

const adapterFor = (provider) => createAdapter({ provider, base_url: fake.compatBase }, lender, {});
const request = (provider, messages, tools = [...HOST, ...WS]) => ({
  model: MODELS[provider],
  system: [{ text: 'You are a test.', cache: true }],
  messages,
  tools,
  maxOutputTokens: 4000,
  effort: 'default',
});
const userText = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
const send = (provider, req) => adapterFor(provider).send(req, new AbortController().signal, () => {});

const text = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '');
const rows = () =>
  text()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
/** A logged request as it went on the wire: the beta list leaves the body as a header. */
const bodyOf = ({ betas, ...rest }) => (assert.ok(betas === undefined || Array.isArray(betas)), rest);
/** The rows `fn` added. */
async function rowsOf(fn) {
  await flushDebugLog();
  const from = rows().length;
  await fn();
  await flushDebugLog();
  return rows().slice(from);
}

before(() => resetAssistantState());
after(async () => {
  await fake.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('the provider debug log', () => {
  it('a strict refusal, then the loose resend: two rows, the refused one with the whole request, its status, request id and the whole error body, the resend with its reason and the result', async () => {
    for (const provider of CLOUD) {
      fake.failNext({ status: 400, body: REFUSED[provider], headers: { 'request-id': `req-${provider}-1` }, dialect: DIALECT[provider] });
      fake.reply({ text: 'All set.', tools: [{ name: 'demo__reset', input: {} }] });
      let r;
      const added = await rowsOf(async () => {
        r = await withDebugScope({ turn: `turn-${provider}`, step: 1 }, () => send(provider, request(provider, [userText('go')])));
      });
      assert.equal(r.notes.length, 1);
      assert.ok(r.notes[0].startsWith(`${STRICT_FALLBACK_NOTE} The provider said: `), provider);
      assert.equal(added.length, 2, provider);
      const [refused, resent] = added;
      const sent = fake.requests().filter((q) => q.kind === 'chat' && q.dialect === DIALECT[provider]).slice(-2);

      assert.equal(refused.dialect, provider);
      assert.equal(refused.model, MODELS[provider]);
      assert.equal(refused.turn, `turn-${provider}`);
      assert.equal(refused.step, 1);
      assert.equal(refused.attempt, 'strict');
      assert.equal(refused.reason, null);
      assert.equal(refused.ok, false);
      assert.ok(Number.isFinite(Date.parse(refused.time)));
      assert.ok(refused.ms >= 0);
      // The request exactly as the provider got it: tools with their schemas and strict flags, system,
      // messages (the SDK sends the body's beta list as a header).
      assert.deepEqual(bodyOf(refused.request), sent[0].body, provider);
      assert.equal(refused.http.length, 1);
      assert.equal(refused.http[0].status, 400);
      assert.equal(refused.http[0].request_id, `req-${provider}-1`);
      assert.deepEqual(JSON.parse(refused.http[0].body), REFUSED[provider], provider);
      assert.equal(refused.mapped.code, 'bad_request');
      assert.equal(refused.error.status, 400);

      assert.equal(resent.attempt, 'loose');
      assert.equal(resent.reason, 'strict_refused');
      assert.equal(resent.turn, `turn-${provider}`);
      assert.equal(resent.ok, true);
      assert.deepEqual(bodyOf(resent.request), sent[1].body, provider);
      assert.equal(resent.http[0].status, 200);
      assert.equal(resent.result.stop, 'tool_use');
      assert.equal(resent.result.served_by, MODELS[provider]);
      assert.ok(resent.result.usage.complete);
      assert.deepEqual(
        resent.result.blocks.map((b) => (b.type === 'tool_call' ? { type: b.type, name: b.name, input: b.input } : b)),
        [
          { type: 'text', text: 'All set.' },
          { type: 'tool_call', name: 'demo__reset', input: {} },
        ],
        provider,
      );
      // The set remembered: the next request goes loose at once, and says why.
      fake.reply({ text: 'again' });
      const [again] = await rowsOf(() => send(provider, request(provider, [userText('again')])));
      assert.equal(again.attempt, 'loose');
      assert.equal(again.reason, 'strict_refused_earlier');
      assert.equal(again.turn, null);
    }
  });

  it('a failure the request is not sent again for: one row with the status and the whole body', async () => {
    const body = { error: { message: 'The model is busy elsewhere.', type: 'invalid_request_error', code: 'busy' } };
    fake.failNext({ status: 422, body, dialect: 'openai' });
    const added = await rowsOf(() => assert.rejects(send('openai', request('openai', [userText('x')], HOST)), (e) => e.code === 'bad_request'));
    assert.equal(added.length, 1);
    assert.equal(added[0].ok, false);
    assert.equal(added[0].http[0].status, 422);
    assert.deepEqual(JSON.parse(added[0].http[0].body), body);
  });

  it('the local server dialect: its rows too, and an image as a marker with its size', async () => {
    const base64 = 'A'.repeat(40_000);
    fake.reply({ text: 'A picture.' });
    const added = await rowsOf(() =>
      send('openai_compatible', request('openai_compatible', [{ role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', base64 }] }], HOST)),
    );
    assert.equal(added.length, 1);
    assert.equal(added[0].dialect, 'openai_compatible');
    assert.equal(added[0].attempt, 'with_images');
    assert.equal(added[0].result.blocks[0].text, 'A picture.');
    const line = JSON.stringify(added[0]);
    assert.ok(!line.includes(base64.slice(0, 5000)), 'the image data is not kept');
    assert.ok(line.includes('[base64 data, 30000 bytes]'), line.slice(0, 2000));
    // A request with no image says so.
    fake.reply({ text: 'Words.' });
    const [plain] = await rowsOf(() => send('openai_compatible', request('openai_compatible', [userText('words')], HOST)));
    assert.equal(plain.attempt, 'no_images');
  });

  it('never a key, and never a registered secret, even one a message carries', async () => {
    const secret = 'zq-DEBUGLOG-registered-secret-9f8e7d';
    registerSecretForRedaction(secret);
    for (const provider of ['anthropic', 'openai', 'openai_compatible']) {
      fake.failNext({ status: 400, body: { error: { message: `echo ${secret}`, type: 'invalid_request_error' } }, dialect: DIALECT[provider] });
      await rowsOf(() => assert.rejects(send(provider, request(provider, [userText(`the secret is ${secret}`)], HOST))));
      fake.reply({ text: `echo ${secret}` });
      await rowsOf(() => send(provider, request(provider, [userText(`the secret is ${secret}`)], HOST)));
    }
    const all = text();
    assert.ok(all.length > 0);
    assert.ok(!all.includes(secret), 'the registered secret');
    for (const key of Object.values(KEYS).filter(Boolean)) assert.ok(!all.includes(key), 'a provider key');
    assert.ok(!/x-api-key|authorization/i.test(all), 'no request header');
    assert.ok(all.includes('[redacted]'));
  });

  it('off when the variable is unset: no row, debugCall gives null; a folder that cannot be written never fails a request', async () => {
    const before = text();
    delete process.env[DEBUG_LOG_ENV];
    resetDebugLogForTests();
    try {
      assert.equal(debugLogDir(), null);
      assert.equal(debugCall({ dialect: 'openai', model: 'm', attempt: 'strict', body: {} }), null);
      fake.reply({ text: 'quiet' });
      const r = await send('openai', request('openai', [userText('quiet')], HOST));
      assert.equal(r.stop, 'end_turn');
      await flushDebugLog();
      assert.equal(text(), before);

      // A file where the folder should be: the request still answers.
      const blocked = join(ROOT, 'not-a-folder');
      writeFileSync(blocked, 'x');
      process.env[DEBUG_LOG_ENV] = join(blocked, 'debug');
      resetDebugLogForTests();
      fake.reply({ text: 'still' });
      const r2 = await send('openai', request('openai', [userText('still')], HOST));
      assert.equal(r2.stop, 'end_turn');
      await flushDebugLog();
      assert.equal(text(), before);
    } finally {
      process.env[DEBUG_LOG_ENV] = LOG_DIR;
      resetDebugLogForTests();
    }
  });
});
