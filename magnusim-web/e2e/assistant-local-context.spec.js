// A local server's word on its model (CAD tools spec H5), end to end: the scripted model
// (support/fake-llm.mjs, the local-server dialect) answers its model row the way LM Studio's
// GET /api/v0/models/<id> does, and the person runs turns from the terminal client
// (scripts/assistant-run.mjs) against the app's server.
// - A model loaded with too small a context: the terminal says so, with the number and the
//   fix, and nothing is sent to the model. Loaded again with room, the person's next try
//   goes through at once (the failed turn made the server forget the row it kept).
// - Loaded with room: each answer may run to 8192 tokens, and the conversation is full at 80%
//   of the model's own context, not of the 128K assumed for a server that reports none (the
//   next turn is refused, and the terminal says so).
// Its own server with the Assistant's test switch (a test home, never this PC's keys). The
// server keeps a row 60 s; the test reset before each test forgets it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost, WEB_ROOT } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

/** The scripted local model's id (support/assistant.js). */
const MODEL = 'qwen3.8-27b';
const SMALL_TEXT =
  "The local model's context (3,072 tokens) is too small for this conversation: load it with a longer context in the local server, or start a new conversation.";
const FULL_TEXT = 'This conversation is full. Start a new one.';

let host;
let fake;

const chats = () => fake.requests().filter((r) => r.kind === 'chat');
const rowReads = () => fake.requests().filter((r) => r.kind === 'model_row');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({ name: 'assistant-local-context', env: { MAGNUSIM_TEST_ASSISTANT: '1' } });
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request }) => {
  // No turn or conversation of an earlier test, and no model row the server kept.
  const r = await request.post(`${host.base}/api/test/assistant/reset`, { data: {} });
  expect(r.status()).toBe(200);
  expect((await useScriptedModel(request, host.base, fake, 'local')).model).toBe(MODEL);
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

/** One turn in the terminal client: its exit code and what the person reads (stdout and stderr). */
async function terminal(args) {
  const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), ...args], {
    cwd: WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  cli.stdout.on('data', (b) => (out += b));
  cli.stderr.on('data', (b) => (out += b));
  let timer;
  const ceiling = new Promise((done) => {
    timer = setTimeout(() => done('still running after 120 s'), 120_000);
  });
  try {
    const code = await Promise.race([new Promise((done) => cli.once('exit', done)), ceiling]);
    return { code, out };
  } finally {
    clearTimeout(timer);
    cli.kill();
  }
}

test('a local model loaded with a 3K context: the terminal says the context is too small, with the fix, and nothing reaches the model; loaded again with 32K, the next try goes through at once', async () => {
  fake.models([{ id: MODEL, context: 3072, type: 'llm' }], 'compat');
  const before = chats().length;
  const from = rowReads().length;
  let { code, out } = await terminal(['How do I start a bracket?']);
  expect(code, out).toBe(1);
  expect(out).toContain(`[failed] ${SMALL_TEXT}\n`);
  expect(chats().length, 'nothing sent to the model').toBe(before);
  expect(rowReads().slice(from).map((r) => `${r.method} ${r.path}`)).toEqual([`GET /compat/api/v0/models/${MODEL}`]);

  // The person loads the model again with a longer context and asks again, well within the
  // minute the server keeps a row: the server asks the local server again, and the answer comes.
  fake.models([{ id: MODEL, context: 32768, type: 'llm' }], 'compat');
  fake.reply({ text: 'Start with a plate, then cut the holes.' });
  ({ code, out } = await terminal(['How do I start a bracket?']));
  expect(code, out).toBe(0);
  expect(out).toContain('Start with a plate, then cut the holes.');
  expect(out).not.toContain(SMALL_TEXT);
  expect(chats().slice(before).map((r) => r.body.max_tokens)).toEqual([8192]);
  expect(rowReads().slice(from).map((r) => `${r.method} ${r.path}`)).toEqual([`GET /compat/api/v0/models/${MODEL}`, `GET /compat/api/v0/models/${MODEL}`]);
});

test("loaded with room: the answer may run to 8192 tokens, and the conversation is full at 80% of the model's context", async () => {
  fake.models([{ id: MODEL, context: 32768, type: 'llm' }], 'compat');
  // 26,300 prompt tokens: past 80% of 32,768, far under 80% of 128K.
  fake.reply({ text: 'Start with a plate, then cut the holes.', usage: { input: 26_300, output: 40 } });
  const before = chats().length;
  let { code, out } = await terminal(['How do I start a bracket?']);
  expect(code, out).toBe(0);
  expect(out).toContain('Start with a plate, then cut the holes.');
  expect(chats().slice(before).map((r) => r.body.max_tokens)).toEqual([8192]);
  const conversation = /continue it with --conversation (c-[0-9a-z]+-[0-9a-f]{8})/.exec(out)?.[1];
  expect(conversation, out).toBeTruthy();

  ({ code, out } = await terminal(['--conversation', conversation, 'And then?']));
  expect(code, out).toBe(1);
  expect(out).toContain(FULL_TEXT);
  expect(chats().length, 'the refused turn sent nothing').toBe(before + 1);
});
