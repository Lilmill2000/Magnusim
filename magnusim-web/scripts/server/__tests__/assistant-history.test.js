// The Assistant's chat history (Daniel: "save 31 days", history.ts): each request's end appends one
// line to <assistant home>/assistant/chats/<project>/<conversation>.jsonl with the prompt, what the
// model said, its tool steps' lines and how it ended, redacted, with no base64; files whose last
// line ended more than 31 days ago are swept; deleting a project removes its chats. The dock's
// History lists them and Clear history empties them (GET /api/assistant/history, POST …/clear),
// the AI does the same with chat_history (clear only once the person said yes), and Continue in
// a new chat carries a saved chat whose conversation is gone. Time is a fake clock in the turns.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-history-'));
const PROJECTS = join(ROOT, 'projects');
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { answerGates, hostTool, makeManager, relayServer, startTurn, settled } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { registerSecretForRedaction } = await import('../assistant/redact.ts');
const { CARRY_GONE_TEXT } = await import('../assistant/turns.ts');
const { ChatHistory, chatHistory, DATA_LEFT_OUT, historyKey, historyLine, HISTORY_LIMITS, HOME_KEY, lineDestination } = await import('../assistant/history.ts');
const { chatHistoryTool } = await import('../assistant/host/chat-history.ts');
const { createToolRegistry } = await import('../assistant/registry.ts');
const { PROVIDER_LABELS } = await import('../assistant/providers/index.ts');

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  resetAssistantState();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;
const P = { p1: { id: 'p1', title: 'Wing', created_at: null }, p2: { id: 'p2', title: 'Bracket', created_at: null } };
/** Each test its own chats folder: a ChatHistory the manager and the tool share. */
const newStore = () => new ChatHistory({ dir: mkdtempSync(join(ROOT, 'chats-')) });
const mk = (store, o = {}) => {
  // The tool reads the manager's live settings ("never send project data"), as the server's does.
  let m = null;
  const tool = chatHistoryTool({ history: () => store, settings: async () => m.state.settings });
  const registry = createToolRegistry({ hostTools: [tool, ...(o.hostTools ?? [])] });
  m = makeManager({ dir: ROOT, projects: P, settings: { privacy: 'allow' }, registry, ...o });
  // The manager reads its deps when it needs them: this store from now on (and the routes' manager's).
  m.deps.history = store;
  return m;
};
const files = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')).sort() : []);
const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** A turn that answers with `text` (after `tools`, each answered); settled, its line written. */
async function turnOf(m, store, body, { text = 'ok', tools = [] } = {}) {
  if (tools.length) m.provider.script({ tools }, { text });
  else m.provider.script({ text });
  const r = await startTurn(m, body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await settled(r.turn);
  await store.flush();
  return r.turn;
}

describe('a request saved as it ends', () => {
  it('one line per request: the prompt, all the model said, each tool step\'s line and how it ended; no base64, no key', async () => {
    const store = newStore();
    const KEY = 'cloudkey-history-CANARY-0123456789abcdef';
    registerSecretForRedaction(KEY);
    const B64 = 'iVBORw0KGgo'.repeat(40);
    const look = hostTool('look', { run: async () => ({ ok: true, data: { picture: B64 }, summary: 'Looked at the wing' }) });
    const m = mk(store, { hostTools: [look] });
    const t = await turnOf(m, store, { text: `Check the wing.\nKey: ${KEY}\ndata:image/png;base64,${B64}`, context: { project_id: 'p1' } }, {
      tools: [{ name: 'look', input: {} }],
      text: `Done. It said ${KEY} and ${B64}.`,
    });
    const file = join(store.dir, 'p1', `${t.conv.id}.jsonl`);
    assert.deepEqual(files(store.dir), [join('p1', `${t.conv.id}.jsonl`)]);
    const [line] = linesOf(file);
    assert.equal(line.v, 1);
    assert.deepEqual([line.turn, line.conversation, line.project_id, line.provider, line.title], [t.id, t.conv.id, 'p1', 'anthropic', 'Check the wing.']);
    assert.ok(line.prompt.startsWith('Check the wing.\nKey: [redacted]\n'), line.prompt);
    assert.equal(line.prompt.split('\n')[2], DATA_LEFT_OUT);
    assert.equal(line.answer, `Done. It said [redacted] and ${DATA_LEFT_OUT}.`);
    assert.deepEqual(line.steps, [{ step: 1, tool: 'look', title: 'Run look', ok: true, code: null, line: 'Looked at the wing' }]);
    assert.deepEqual(line.end, { state: 'done', reason: t.endReason, message: null });
    assert.equal(line.full, null);
    assert.equal(line.usage.steps, 1);
    assert.equal(line.started_at, new Date(t.startedAt).toISOString());
    assert.equal(line.ended_at, new Date(t.endedAt).toISOString());
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(KEY), 'no key');
    assert.ok(!raw.includes(B64.slice(0, 200)), 'no base64');
    assert.ok(!/[A-Za-z0-9+/]{200,}/.test(raw), 'no long run of base64 at all');
    // The next request of the conversation: a second line, after the first.
    m.provider.script({ text: 'Second.' });
    const r = await startTurn(m, { text: 'And again', conversation: t.conv.id, context: { project_id: 'p1' } });
    await settled(r.turn);
    await store.flush();
    assert.deepEqual(linesOf(file).map((l) => [l.prompt, l.answer, l.title]), [
      [line.prompt, line.answer, 'Check the wing.'],
      ['And again', 'Second.', 'Check the wing.'],
    ]);
  });

  it('a request on Home, and one that ends before anything is sent (privacy declined): each saved with its end', async () => {
    const store = newStore();
    const m = mk(store);
    const home = await turnOf(m, store, { text: 'Hello from Home' }, { text: 'Hi.' });
    assert.deepEqual(files(store.dir), [join(HOME_KEY, `${home.conv.id}.jsonl`)]);
    m.state.settings.privacy = 'ask';
    const r = await startTurn(m, { text: 'Read the bracket', context: { project_id: 'p2' } });
    answerGates(m, r.turn, () => false);
    await settled(r.turn);
    await store.flush();
    const [line] = linesOf(join(store.dir, 'p2', `${r.turn.conv.id}.jsonl`));
    assert.deepEqual([line.prompt, line.answer, line.end.state], ['Read the bracket', '', 'stopped']);
    assert.equal(line.end.message, r.turn.message);
  });

  it('a line is at most 64 KB: the answer, then the steps, then the prompt are cut, and `cut` says so', () => {
    const base = {
      turn: 't-1',
      conversation: 'c-1-00000000',
      project_id: null,
      provider: 'anthropic',
      label: 'Cloud',
      model: 'm',
      title: 'Big',
      prompt: 'pp '.repeat(14_000),
      pictures: 2,
      files: ['a.step'],
      answer: 'aa '.repeat(34_000) + 'THE END',
      steps: Array.from({ length: 150 }, (_, i) => ({ step: 1, tool: `tool_${i}`, title: 'T'.repeat(120), ok: true, code: null, line: 'x '.repeat(200) })),
      steps_left_out: 0,
      end: { state: 'done', reason: 'end_turn', message: null },
      full: null,
      usage: { usd: 0.1, estimated: false, tokens: 10, steps: 150, billing: 'usd' },
      started_by: 'window',
      started_at: '2026-10-20T10:00:00.000Z',
      ended_at: '2026-10-20T10:01:00.000Z',
      carried_from: null,
    };
    const text = historyLine(base);
    assert.ok(Buffer.byteLength(text) <= HISTORY_LIMITS.lineBytes, `${Buffer.byteLength(text)} bytes`);
    const l = JSON.parse(text);
    assert.ok(l.answer.endsWith('THE END'), "the answer's end stays");
    assert.ok(l.steps.length < 100 && l.steps_left_out === 150 - l.steps.length, `${l.steps.length} steps kept, ${l.steps_left_out} counted`);
    assert.ok(l.steps.every((s) => s.line.length <= HISTORY_LIMITS.stepLine));
    assert.deepEqual(l.cut, ['answer', 'prompt', 'steps']);
    // A small one is whole.
    assert.equal(JSON.parse(historyLine({ ...base, prompt: 'hi', answer: 'ok', steps: [] })).cut, undefined);
  });

  it("a project's folder is its id; Home is _home; an id that is no plain file name is a hash", () => {
    assert.equal(historyKey('wing-20261020-abc123'), 'wing-20261020-abc123');
    assert.equal(historyKey(null), HOME_KEY);
    for (const odd of ['_home', '../x', 'a:b', 'con', 'x.']) assert.match(historyKey(odd), /^x-[0-9a-f]{32}$/, odd);
  });
});

describe('kept 31 days', () => {
  it('the sweep removes a file whose last line ended 32 days ago, keeps one of 30 days, and an emptied folder goes', async () => {
    const now = Date.parse('2026-10-29T12:00:00');
    const store = new ChatHistory({ dir: mkdtempSync(join(ROOT, 'sweep-')), now: () => now });
    const write = (key, id, endedMsAgo) => {
      mkdirSync(join(store.dir, key), { recursive: true });
      const at = new Date(now - endedMsAgo).toISOString();
      const line = JSON.parse(historyLine({ turn: 't', conversation: id, project_id: key, provider: 'anthropic', label: 'Cloud', model: 'm', title: 'x', prompt: 'x', pictures: 0, files: [], answer: '', steps: [], steps_left_out: 0, end: { state: 'done', reason: 'end_turn', message: null }, full: null, usage: { usd: 0, estimated: false, tokens: 0, steps: 0, billing: 'usd' }, started_by: 'window', started_at: at, ended_at: at, carried_from: null }));
      // An older first line does not count: the last one does.
      const first = { ...line, ended_at: new Date(now - 60 * DAY).toISOString() };
      writeFileSync(join(store.dir, key, `${id}.jsonl`), `${JSON.stringify(first)}\n${JSON.stringify(line)}\n`);
    };
    write('p1', 'c-old-00000001', 32 * DAY);
    write('p1', 'c-new-00000002', 30 * DAY);
    write('p9', 'c-old-00000003', 40 * DAY);
    assert.equal(await store.sweep(), 2);
    assert.deepEqual(files(store.dir), [join('p1', 'c-new-00000002.jsonl')]);
    assert.ok(!existsSync(join(store.dir, 'p9')), 'the emptied folder went');
    // Two days on, the 30-day one is past 31.
    assert.equal(await store.sweep({ later: 2 * DAY }), 1);
    assert.deepEqual(files(store.dir), []);
  });

  it('deleting a project (w16 deleteProject) removes its chats folder, and a later line of it is not written', async () => {
    const store = chatHistory();
    const id = 'hist-20261029-a1b2c3';
    mkdirSync(join(PROJECTS, id), { recursive: true });
    writeFileSync(join(PROJECTS, id, 'project.json'), JSON.stringify({ id, title: 'To delete' }));
    const m = mk(store, { projects: { ...P, [id]: { id, title: 'To delete', created_at: null } } });
    // The server's Assistant hears the delete (assistant-routes.ts).
    servers.push(await relayServer(m));
    const t = await turnOf(m, store, { text: 'Look at it', context: { project_id: id } });
    assert.deepEqual(files(store.dir).filter((f) => f.startsWith(id)), [join(id, `${t.conv.id}.jsonl`)]);
    const { deleteProject } = await import('../../w16-project-geometry.js');
    assert.equal(deleteProject(id).ok, true);
    await store.flush();
    for (let i = 0; i < 50 && existsSync(join(store.dir, id)); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(!existsSync(join(store.dir, id)), 'its chats folder went with it');
    // A request of it that ends after the delete leaves nothing behind.
    await turnOf(m, store, { text: 'Still there?', conversation: t.conv.id, context: { project_id: id } });
    assert.ok(!existsSync(join(store.dir, id)));
  });
});

describe("the dock's History and Clear history", () => {
  it('lists a project\'s saved chats newest first with their title, when and first prompt; reads one a page at a time; Clear history empties it', async () => {
    const store = chatHistory();
    await store.clearAll();
    const m = mk(store);
    const s = await relayServer(m);
    servers.push(s);
    const a = await turnOf(m, store, { text: 'Build the base\nwith fillets', context: { project_id: 'p1' } }, { text: 'Built it.' });
    m.clock.advance(60_000);
    await turnOf(m, store, { text: 'Then the lid', conversation: a.conv.id, context: { project_id: 'p1' } }, { text: 'Lid done.' });
    m.clock.advance(60_000);
    const b = await turnOf(m, store, { text: 'Another chat', context: { project_id: 'p1' } }, { text: 'Sure.' });
    await turnOf(m, store, { text: 'On Home' }, { text: 'Hi.' });
    let r = await s.get('/api/assistant/history?project=p1');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kept_days, 31);
    assert.deepEqual(
      r.json.chats.map((c) => [c.id, c.title, c.first_prompt, c.label, c.end_state]),
      [
        [b.conv.id, 'Another chat', 'Another chat', PROVIDER_LABELS.anthropic, 'done'],
        [a.conv.id, 'Build the base', 'Build the base\nwith fillets', PROVIDER_LABELS.anthropic, 'done'],
      ],
    );
    assert.equal(r.json.total, 2);
    assert.deepEqual((await s.get('/api/assistant/history?project=home')).json.chats.map((c) => c.title), ['On Home']);
    r = await s.get(`/api/assistant/history/${a.conv.id}?project=p1`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.requests.map((x) => [x.prompt, x.answer, x.end.state]), [
      ['Build the base\nwith fillets', 'Built it.', 'done'],
      ['Then the lid', 'Lid done.', 'done'],
    ]);
    assert.deepEqual([r.json.total, r.json.from, r.json.next], [2, 0, null]);
    r = await s.get(`/api/assistant/history/${a.conv.id}?project=p1&from=1`);
    assert.deepEqual(r.json.requests.map((x) => x.prompt), ['Then the lid']);
    // Another project's, or no project: not here.
    assert.equal((await s.get(`/api/assistant/history/${a.conv.id}?project=p2`)).status, 404);
    assert.deepEqual([(await s.get('/api/assistant/history')).status, (await s.get('/api/assistant/history?project=..%2Fx')).json.code], [400, 'bad_project']);
    assert.equal((await s.get('/api/assistant/history/..%2F..%2Fsecrets?project=p1')).status, 404);
    // Clear history: this project's go, Home's stay.
    r = await s.post('/api/assistant/history/clear', { project: 'p1' });
    assert.deepEqual([r.status, r.json.removed], [200, 2]);
    assert.deepEqual((await s.get('/api/assistant/history?project=p1')).json.chats, []);
    assert.equal((await s.get('/api/assistant/history?project=home')).json.chats.length, 1);
    assert.equal((await s.post('/api/assistant/history/clear', { project: 'p1' })).json.removed, 0);
    assert.equal((await s.post('/api/assistant/history/clear', {})).json.code, 'bad_project');
    const remote = await s.get('/api/assistant/history?project=p1', { 'x-forwarded-for': '203.0.113.9' });
    assert.deepEqual([remote.status, remote.json.reason], [403, 'remote']);
  });
});

describe('the AI: chat_history', () => {
  /** A turn whose model calls chat_history with `input`, then says `text`; the tool's result as the model got it. */
  async function call(m, store, input, { answer = null, context = { project_id: 'p1' } } = {}) {
    m.provider.script({ tools: [{ name: 'chat_history', input: { action: 'list', id: '', from: 0, ...input } }] }, { text: 'ok' });
    const r = await startTurn(m, { text: `chat_history ${input.action}`, ...(context ? { context } : {}) });
    const asked = [];
    answerGates(m, r.turn, (g) => {
      asked.push(g);
      return answer;
    });
    await settled(r.turn);
    await store.flush();
    const res = m.provider.requests.at(-1).req.messages.at(-1).parts.find((p) => p.type === 'tool_result');
    return { result: JSON.parse(res.text), asked, turn: r.turn };
  }

  it('list and read this project\'s saved chats (never another project\'s); clear only once the person said yes', async () => {
    const store = newStore();
    const m = mk(store);
    const a = await turnOf(m, store, { text: 'Make the hinge', context: { project_id: 'p1' } }, { text: 'Hinge made.' });
    await turnOf(m, store, { text: 'Other project', context: { project_id: 'p2' } }, { text: 'Yes.' });
    let { result, asked } = await call(m, store, { action: 'list' });
    assert.deepEqual(asked, [], 'a read asks nothing');
    assert.equal(result.ok, true);
    assert.equal(result.data.of, 'this project');
    assert.deepEqual(result.data.chats.map((c) => [c.id, c.title, c.first_prompt]), [[a.conv.id, 'Make the hinge', 'Make the hinge']]);
    ({ result } = await call(m, store, { action: 'read', id: a.conv.id }));
    assert.deepEqual(result.data.requests.map((x) => [x.prompt, x.answer, x.end.state]), [['Make the hinge', 'Hinge made.', 'done']]);
    assert.equal(result.data.next, null);
    ({ result } = await call(m, store, { action: 'read', id: 'c-zzz-00000000' }));
    assert.equal(result.error.code, 'not_found');
    // Clear: asked first; No leaves them.
    const before = files(store.dir).filter((f) => f.startsWith('p1'));
    ({ result, asked } = await call(m, store, { action: 'clear' }, { answer: false }));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Allow the Assistant to clear the chat history of this project?');
    assert.match(asked[0].copy, /saved chats of this project go from History/);
    assert.equal(result.error.code, 'declined');
    // The declined call's own request was saved too: the project's chats only grew.
    assert.ok(files(store.dir).filter((f) => f.startsWith('p1')).length >= before.length);
    ({ result, asked } = await call(m, store, { action: 'clear' }, { answer: true }));
    assert.equal(asked.length, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.data.done, /^Cleared \d+ saved chats? of this project\./);
    // Only this request's own line is there now (it ended after the clear); p2's stayed.
    assert.equal(files(store.dir).filter((f) => f.startsWith('p1')).length, 1);
    assert.equal(files(store.dir).filter((f) => f.startsWith('p2')).length, 1);
  });

  /** A saved request of `conversation` in `project` (null: Home), its words having gone to `destination`. */
  const saveLine = (store, project, conversation, o = {}) =>
    store.append({
      turn: `t-${conversation}`,
      conversation,
      project_id: project,
      provider: o.provider ?? 'openai_compatible',
      ...(o.destination === null ? {} : { destination: o.destination ?? 'host:127.0.0.1' }),
      label: o.label ?? 'Local server',
      model: 'qwen3.8-27b',
      title: 'Bracket loads',
      prompt: 'my private note on the bracket',
      pictures: 0,
      files: [],
      answer: 'Wing (p1): SECRET lift 4321 N',
      steps: [{ step: 1, tool: 'read_results', title: 'Read results', ok: true, code: null, line: 'Wing: lift 4321 N' }],
      steps_left_out: 0,
      end: { state: 'done', reason: 'end_turn', message: null },
      full: null,
      usage: { usd: 0, estimated: false, tokens: 10, steps: 1, billing: 'free' },
      started_by: 'window',
      started_at: '2026-10-16T12:00:00.000Z',
      ended_at: '2026-10-16T12:01:00.000Z',
      carried_from: null,
    });
  /** Everything the provider was sent in the last request, as text. */
  const sentText = (m) => JSON.stringify(m.provider.requests.at(-1).req.messages);

  it("each saved line keeps where its words went (the turn's destination); a line from before that by its provider, a local server's as not known", async () => {
    const store = newStore();
    const m = mk(store);
    const a = await turnOf(m, store, { text: 'Hello' }, { text: 'Hi.' });
    const [line] = linesOf(join(store.dir, HOME_KEY, `${a.conv.id}.jsonl`));
    assert.equal(line.destination, 'anthropic');
    assert.deepEqual((await store.list(null)).chats.map((c) => c.destinations), [['anthropic']]);
    assert.deepEqual(
      [lineDestination({ provider: 'anthropic' }), lineDestination({ provider: 'agent:claude' }), lineDestination({ provider: 'openai_compatible' }), lineDestination({ provider: 'openai_compatible', destination: 'host:10.0.0.2' })],
      ['anthropic', 'agent:claude', '', 'host:10.0.0.2'],
    );
  });

  it("a chat whose words went to another provider or server: listed without them; a read asks the person first, naming where they went and where they would go (Don't: nothing of it is sent)", async () => {
    const store = newStore();
    const m = mk(store);
    const own = await turnOf(m, store, { text: 'A Home chat' }, { text: 'Hi.' });
    const local = 'c-local-0000abcd';
    await saveLine(store, null, local);
    let { result, asked } = await call(m, store, { action: 'list' }, { context: null });
    assert.deepEqual(asked, []);
    const byId = Object.fromEntries(result.data.chats.map((c) => [c.id, c]));
    assert.equal(byId[own.conv.id].title, 'A Home chat');
    assert.deepEqual(byId[local], { id: local, provider: 'Local server', went_to: 'Local server at 127.0.0.1', elsewhere: true, started_at: '2026-10-16T12:00:00.000Z', ended_at: '2026-10-16T12:01:00.000Z', last_end: 'done' });
    assert.ok(!sentText(m).includes('my private note') && !sentText(m).includes('Bracket loads'), 'its words never reach the provider in a list');
    // Read: the person is asked; Don't sends nothing of it.
    ({ result, asked } = await call(m, store, { action: 'read', id: local }, { context: null, answer: false }));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Allow the Assistant to read a saved chat that went to Local server at 127.0.0.1?');
    assert.equal(asked[0].copy, "Its prompts and answers went only to Local server at 127.0.0.1. Read here, they go to Anthropic, and that can't be undone.");
    assert.equal(asked[0].risk, 'destructive');
    assert.deepEqual(asked[0].detail, [
      { label: 'Chat', value: 'Bracket loads' },
      { label: 'Went to', value: 'Local server at 127.0.0.1' },
      { label: 'Would go to', value: 'Anthropic' },
    ]);
    assert.equal(result.error.code, 'declined');
    assert.ok(!sentText(m).includes('SECRET') && !sentText(m).includes('Wing: lift'), 'nothing of it was sent');
    // Allow: read.
    ({ result, asked } = await call(m, store, { action: 'read', id: local }, { context: null, answer: true }));
    assert.equal(asked.length, 1);
    assert.deepEqual(result.data.requests.map((x) => [x.prompt, x.answer, x.steps[0].line]), [['my private note on the bracket', 'Wing (p1): SECRET lift 4321 N', 'Wing: lift 4321 N']]);
    // Its own provider's chat: nothing asked.
    ({ result, asked } = await call(m, store, { action: 'read', id: own.conv.id }, { context: null }));
    assert.deepEqual([asked, result.ok], [[], true]);
    // A chat saved before lines said where they went: a local server's is asked about as elsewhere.
    await saveLine(store, null, 'c-older-0000abcd', { destination: null });
    ({ asked } = await call(m, store, { action: 'read', id: 'c-older-0000abcd' }, { context: null, answer: false }));
    assert.equal(asked[0].title, 'Allow the Assistant to read a saved chat that went to Local server?');
    // Another cloud provider's, in a project: asked too.
    await saveLine(store, 'p1', 'c-openai-0000abcd', { provider: 'openai', destination: 'openai', label: 'OpenAI' });
    ({ result, asked } = await call(m, store, { action: 'read', id: 'c-openai-0000abcd' }, { answer: false }));
    assert.deepEqual([asked.length, asked[0].title, result.error.code], [1, 'Allow the Assistant to read a saved chat that went to OpenAI?', 'declined']);
  });

  it('"never send project data" (Settings): a cloud turn on Home does not read a chat whose words went elsewhere at all, and asks nothing', async () => {
    const store = newStore();
    const m = mk(store, { settings: { privacy: 'deny' } });
    const local = 'c-local-0000abcd';
    await saveLine(store, null, local);
    const { result, asked } = await call(m, store, { action: 'read', id: local }, { context: null });
    assert.deepEqual(asked, []);
    assert.equal(result.error.code, 'privacy_denied');
    assert.equal(result.error.message, "Settings → Assistant is set to never send project data off this PC, and this chat's words went only to Local server at 127.0.0.1, so it isn't read here.");
    assert.ok(!sentText(m).includes('SECRET') && !sentText(m).includes('my private note'));
  });

  it("another app (MCP) and a coding agent: an app's call meets every saved chat as elsewhere; an agent reads its own chats and is asked about the rest", async () => {
    const store = newStore();
    const tool = chatHistoryTool({ history: () => store });
    await saveLine(store, null, 'c-local-0000abcd');
    await saveLine(store, null, 'c-agent-0000abcd', { provider: 'agent:helper', destination: 'agent:helper', label: 'Helper' });
    const home = { tab: null, projectId: null, simulationId: null, cloud: true, local: false, place: 'home', budgetTokens: null, prompt: null };
    const app = { ...home, destination: { key: 'mcp', label: 'the app that asks' } };
    const list = await tool.run({ action: 'list', id: '', from: 0 }, { ctx: app, signal: new AbortController().signal });
    assert.ok(list.data.chats.every((c) => c.elsewhere === true && !('first_prompt' in c)));
    const asked = await tool.escalate({ action: 'read', id: 'c-agent-0000abcd', from: 0 }, { ctx: app, signal: new AbortController().signal, turn: null });
    assert.equal(asked.risk, 'destructive');
    assert.equal(asked.note, "Its prompts and answers went only to Helper. Read here, they go to the app that asks, and that can't be undone.");
    const agent = { ...home, destination: { key: 'agent:helper', label: 'Helper' } };
    assert.equal(await tool.escalate({ action: 'read', id: 'c-agent-0000abcd', from: 0 }, { ctx: agent, signal: new AbortController().signal, turn: null }), null, 'its own chat');
    assert.notEqual(await tool.escalate({ action: 'read', id: 'c-local-0000abcd', from: 0 }, { ctx: agent, signal: new AbortController().signal, turn: null }), null);
    // A read the person was never asked about (no escalate ran for this input): nothing of it.
    const unasked = await tool.run({ action: 'read', id: 'c-local-0000abcd', from: 0 }, { ctx: agent, signal: new AbortController().signal });
    assert.equal(unasked.error.code, 'not_allowed');
    // A caller that names no destination is asked about every chat.
    assert.notEqual(await tool.escalate({ action: 'read', id: 'c-agent-0000abcd', from: 0 }, { ctx: home, signal: new AbortController().signal, turn: null }), null);
  });

  it('on Home it reads Home\'s chats', async () => {
    const store = newStore();
    const m = mk(store);
    await turnOf(m, store, { text: 'A Home chat' }, { text: 'Hi.' });
    await turnOf(m, store, { text: 'A project chat', context: { project_id: 'p1' } });
    const { result } = await call(m, store, { action: 'list' }, { context: null });
    assert.equal(result.data.of, 'Home');
    assert.ok(result.data.chats.some((c) => c.title === 'A Home chat'));
    assert.ok(!result.data.chats.some((c) => c.title === 'A project chat'));
  });
});

describe('Continue in a new chat from a saved chat', () => {
  it('a conversation gone from memory is carried from History: its prompts, its last answer and how it ended; another project or provider is refused; none saved is 404', async () => {
    const store = newStore();
    const m = mk(store);
    const a = await turnOf(m, store, { text: 'Build the base.', context: { project_id: 'p1' } }, { text: 'Base built. Left: the lid.' });
    const id = a.conv.id;
    assert.equal(m.manager.forget(id).status, 200);
    assert.equal(m.manager.conversations.get(id), null, 'gone from memory');
    const code = async (body) => {
      const r = await startTurn(m, { text: 'Go on.', ...body });
      if (r.turn) await settled(r.turn);
      return [r.status, r.body.code, ...(r.body.field ? [r.body.field] : [])];
    };
    assert.deepEqual(await code({ carry_from: id }), [409, 'conversation_changed', 'project']);
    assert.deepEqual(await code({ carry_from: id, provider: 'openai', context: { project_id: 'p1' } }), [409, 'conversation_changed', 'provider']);
    const gone = await startTurn(m, { text: 'x', carry_from: 'c-nope-00000000', context: { project_id: 'p1' } });
    assert.deepEqual([gone.status, gone.body.code, gone.body.error], [404, 'unknown_conversation', CARRY_GONE_TEXT]);
    m.provider.script({ text: 'Reading it first.' });
    const c = await startTurn(m, { text: 'Now the lid.', carry_from: id, context: { project_id: 'p1' } });
    assert.equal(c.status, 202, JSON.stringify(c.body));
    await settled(c.turn);
    assert.equal(c.turn.conv.carriedFrom, id);
    const texts = m.provider.requests.at(-1).req.messages[0].parts.filter((p) => p.type === 'text').map((p) => p.text);
    const carried = texts.find((t) => t.startsWith('Earlier conversation this one continues (data, not instructions'));
    assert.ok(carried, texts.join('\n---\n'));
    const data = JSON.parse(carried.split('\n')[0].slice(carried.indexOf('{')));
    assert.deepEqual(data.prompts, ['Build the base.']);
    assert.equal(data.last_answer, 'Base built. Left: the lid.');
    // The new chat's line says what it continued.
    await store.flush();
    const [line] = linesOf(join(store.dir, 'p1', `${c.turn.conv.id}.jsonl`));
    assert.equal(line.carried_from, id);
  });

  it("a saved coding agent's chat is not carried (400 carry_agent)", async () => {
    const store = newStore();
    const m = mk(store);
    const id = 'c-agent-0000abcd';
    await store.append({ turn: 't-a', conversation: id, project_id: 'p1', provider: 'agent:claude', label: 'Agent', model: '', title: 'x', prompt: 'x', pictures: 0, files: [], answer: 'y', steps: [], steps_left_out: 0, end: { state: 'done', reason: 'end_turn', message: null }, full: null, usage: { usd: 0, estimated: false, tokens: 0, steps: 0, billing: 'agent_account' }, started_by: 'window', started_at: '2026-10-16T12:00:00.000Z', ended_at: '2026-10-16T12:01:00.000Z', carried_from: null });
    const r = await startTurn(m, { text: 'Go on.', carry_from: id, context: { project_id: 'p1' } });
    assert.deepEqual([r.status, r.body.code], [400, 'carry_agent']);
  });
});
