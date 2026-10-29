// The dock's conversations (phase 4 spec 9.3, 9.7): GET /api/assistant/conversations lists this
// server's conversations, newest use first, each with its kept turns and how many are no longer
// kept, by project or Home; an ended turn is kept past its hour while it is among its
// conversation's newest 50 and that conversation lives, then for an hour from when it no longer
// is; past the 200 newest ended turns a kept turn keeps only its summary (log_dropped). Time is a
// fake clock throughout.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-conversations-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, relayServer, startTurn, settled, eventsOf, ScriptedProvider } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { TURN_LIMITS } = await import('../assistant/turns.ts');
const { Conversation, fullText, imageLimit } = await import('../assistant/conversations.ts');
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

const PROJECTS = { p1: { id: 'p1', title: 'Wing', created_at: null } };
const HOUR = 60 * 60_000;
const mk = (o = {}) => makeManager({ dir: ROOT, projects: PROJECTS, settings: { privacy: 'allow' }, ...o });

/** A turn that answers at once with `text`; settled. */
async function quickTurn(m, body) {
  const adapter = m.adapters[body.provider ?? m.state.settings.provider] ?? m.provider;
  adapter.script({ text: 'ok' });
  const r = await startTurn(m, body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await settled(r.turn);
  return r.turn;
}

describe('GET /api/assistant/conversations', () => {
  it('each conversation, newest use first, with its provider, project, title and kept turns; ?project= and home; 400 for a bad one', async () => {
    const m = mk();
    const s = await relayServer(m);
    servers.push(s);
    const first = await quickTurn(m, { text: 'Hello there\nsecond line' });
    m.clock.advance(1000);
    const second = await quickTurn(m, { text: 'And again', conversation: first.conv.id });
    m.clock.advance(1000);
    // A project conversation on the local server, running (held at its request).
    m.state.settings.models.openai_compatible = 'local-model';
    m.adapters.openai_compatible = new ScriptedProvider({ id: 'openai_compatible' }).script({ hold: 'look' });
    const held = await startTurn(m, { text: 'Look at the wing', provider: 'openai_compatible', context: { project_id: 'p1' } });
    assert.equal(held.status, 202, JSON.stringify(held.body));
    const r = await s.get('/api/assistant/conversations');
    assert.equal(r.status, 200);
    const [proj, home] = r.json.conversations;
    assert.equal(r.json.conversations.length, 2);
    assert.deepEqual(Object.keys(proj).sort(), [
      'billing', 'created_at', 'dropped_turns', 'full', 'full_text', 'id', 'label', 'last_used_at', 'model', 'project_id', 'project_title', 'provider', 'room', 'running', 'title', 'turns',
    ]);
    assert.deepEqual(
      [proj.id, proj.provider, proj.label, proj.billing, proj.project_id, proj.project_title, proj.running, proj.title, proj.full, proj.dropped_turns],
      [held.body.conversation, 'openai_compatible', PROVIDER_LABELS.openai_compatible, 'free', 'p1', 'Wing', held.body.turn, 'Look at the wing', null, 0],
    );
    assert.deepEqual(proj.turns.map((t) => [t.id, t.title, t.ended_at, t.started_by]), [[held.body.turn, 'Look at the wing', null, 'program']]);
    assert.ok(['starting', 'model'].includes(proj.turns[0].state));
    assert.deepEqual(
      [home.id, home.provider, home.label, home.billing, home.model, home.project_id, home.project_title, home.running, home.title],
      [first.conv.id, 'anthropic', PROVIDER_LABELS.anthropic, 'usd', m.state.settings.models.anthropic, null, null, null, 'Hello there'],
    );
    assert.deepEqual(
      home.turns.map((t) => [t.id, t.title, t.state, t.started_by]),
      [
        [first.id, 'Hello there', 'done', 'program'],
        [second.id, 'And again', 'done', 'program'],
      ],
      'oldest first',
    );
    assert.equal(home.turns[0].started_at, new Date(first.startedAt).toISOString());
    assert.equal(home.turns[1].ended_at, new Date(second.endedAt).toISOString());
    assert.ok(Date.parse(proj.last_used_at) > Date.parse(home.last_used_at), 'newest use first');
    assert.deepEqual((await s.get('/api/assistant/conversations?project=p1')).json.conversations.map((c) => c.id), [proj.id]);
    assert.deepEqual((await s.get('/api/assistant/conversations?project=home')).json.conversations.map((c) => c.id), [home.id]);
    assert.deepEqual((await s.get('/api/assistant/conversations?project=p2')).json.conversations, []);
    const bad = await s.get('/api/assistant/conversations?project=..%2Fx%20y');
    assert.deepEqual([bad.status, bad.json.code], [400, 'bad_project']);
    const remote = await s.get('/api/assistant/conversations', { 'x-forwarded-for': '203.0.113.9' });
    assert.deepEqual([remote.status, remote.json.reason], [403, 'remote']);
    held.turn.stop();
    await settled(held.turn);
  });

  it("a project's title is read once a minute at most; one that can't be read is null", async () => {
    let reads = 0;
    const m = mk();
    const lookup = m.deps.projects;
    m.deps.projects = async (id, o) => {
      reads += 1;
      return lookup(id, o);
    };
    const s = await relayServer(m);
    servers.push(s);
    await quickTurn(m, { text: 'a', context: { project_id: 'p1' } });
    await quickTurn(m, { text: 'b', context: { project_id: 'p9' } });
    const before = reads;
    const titles = async () => (await s.get('/api/assistant/conversations')).json.conversations.map((c) => [c.project_id, c.project_title]).sort();
    assert.deepEqual(await titles(), [['p1', 'Wing'], ['p9', null]]);
    assert.equal(reads - before, 2);
    await titles();
    assert.equal(reads - before, 2, 'kept for a minute');
    m.clock.advance(60_001);
    await titles();
    assert.equal(reads - before, 4, 'read again after it');
  });
});

describe('keeping a conversation\'s turns (spec 9.7)', () => {
  it('an ended turn is kept past its hour while its conversation lives, and goes an hour after the conversation is forgotten', async () => {
    const m = mk();
    const t = await quickTurn(m, { text: 'one' });
    m.clock.advance(HOUR + 60_000);
    assert.equal(m.manager.get(t.id), t, 'kept past the hour: its conversation lives');
    assert.equal(m.manager.forget(t.conv.id).status, 200);
    m.clock.advance(HOUR - 1);
    assert.equal(m.manager.get(t.id), t, 'kept for an hour from the forget');
    m.clock.advance(2);
    assert.equal(m.manager.get(t.id), null, 'then it goes');
  });

  it('a conversation keeps its newest 50: the 51st start releases the oldest, which goes an hour later; the list counts it', async () => {
    const m = mk();
    const s = await relayServer(m);
    servers.push(s);
    const first = await quickTurn(m, { text: 't1' });
    const conv = first.conv.id;
    m.clock.advance(HOUR + 60_000);
    const turns = [first];
    for (let i = 2; i <= 50; i += 1) turns.push(await quickTurn(m, { text: `t${i}`, conversation: conv }));
    assert.equal(m.manager.get(first.id), first, 'the oldest of 50: still kept');
    turns.push(await quickTurn(m, { text: 't51', conversation: conv }));
    assert.equal(m.manager.get(first.id), first, 'released by the 51st, kept an hour from then');
    m.clock.advance(HOUR + 1);
    assert.equal(m.manager.get(first.id), null);
    assert.equal(m.manager.get(turns[1].id), turns[1], 'the second is among the newest 50');
    const row = (await s.get('/api/assistant/conversations')).json.conversations[0];
    assert.deepEqual([row.turns.length, row.turns[0].id, row.dropped_turns], [50, turns[1].id, 1]);
  });

  it(`past the ${TURN_LIMITS.keptEnded} newest ended turns, the oldest keeps only its summary (log_dropped), its log, text and pictures gone`, async () => {
    const m = mk();
    const all = [];
    for (let i = 0; i < TURN_LIMITS.keptEnded + 1; i += 1) {
      all.push(await quickTurn(m, { text: `n${i}` }));
      m.clock.advance(10);
    }
    const [oldest] = all;
    assert.equal(m.manager.get(oldest.id), oldest, 'its record is kept (ended under an hour ago)');
    const sum = oldest.summary();
    assert.deepEqual([sum.log_dropped, sum.text_so_far, sum.title, sum.state], [true, '', 'n0', 'done']);
    assert.deepEqual(eventsOf(oldest), []);
    assert.deepEqual(oldest.eventsSince(0), []);
    assert.deepEqual(
      all.slice(1).map((t) => t.summary().log_dropped),
      Array(TURN_LIMITS.keptEnded).fill(false),
      'the newest 200 keep their logs',
    );
    assert.ok(eventsOf(all[1]).some((e) => e.type === 'end'));
  });
});

describe('which limit a full conversation reached, and how close it is (the full line and the room readout)', () => {
  const PIC = { type: 'image', mediaType: 'image/png', base64: 'AAAA', width: 640, height: 480 };
  // A model the price table doesn't know: Magnusim's own 200K of context and 100 pictures.
  const conv = (provider = 'anthropic', model = 'claude-test-9') => new Conversation('c-1', { provider, model, projectId: null }, 0);
  const pictures = (c, n) => {
    for (let i = 0; i < n; i += 1) c.append({ role: 'user', parts: [{ type: 'text', text: `p${i}` }, { ...PIC }] });
  };

  it('fullText names each limit with its numbers; fullReason still names the first reached', () => {
    const c = conv();
    assert.equal(c.fullDetail(), null);
    pictures(c, 100);
    assert.deepEqual(c.fullDetail(), { reason: 'images', used: 100, limit: 100, of: 'app' });
    assert.equal(c.fullReason(), 'images');
    assert.equal(
      fullText(c.fullDetail(), 'claude-test-9'),
      'This conversation is full: it holds 100 pictures, and Magnusim keeps at most 100 in one conversation. Start a new one.',
    );
    assert.equal(
      fullText({ reason: 'messages', used: 300, limit: 300, of: 'app' }, 'x'),
      'This conversation is full: it has 300 messages, and one conversation holds at most 300. Start a new one.',
    );
    assert.equal(
      fullText({ reason: 'bytes', used: 20.5 * 1024 * 1024, limit: 20 * 1024 * 1024, of: 'app' }, 'x'),
      'This conversation is full: it holds 20 MB of results and pictures, and Magnusim keeps at most 20 MB for one conversation. Start a new one.',
    );
    const ctx = conv();
    ctx.promptTokens = 162_000;
    assert.deepEqual(ctx.fullDetail(), { reason: 'context', used: 162_000, limit: 160_000, of: 'app', window: 200_000 });
    assert.equal(
      fullText(ctx.fullDetail(), 'claude-test-9'),
      'This conversation is full: the last request used 162,000 of the 200,000 tokens Magnusim counts for claude-test-9, and a conversation is full at 80%. Start a new one.',
    );
    // A local server that reported its model's context: the model's own.
    const local = conv('openai_compatible', 'qwen3.8-27b');
    local.contextTokens = 32_768;
    local.promptTokens = 26_300;
    assert.equal(
      fullText(local.fullDetail(), 'qwen3.8-27b'),
      "This conversation is full: the last request used 26,300 of qwen3.8-27b's 32,768-token context, and a conversation is full at 80%. Start a new one.",
    );
  });

  it('nearlyFull: the next request at the context limit, or pictures, bytes or messages within the largest step so far (2 more messages); a closed conversation is full', () => {
    const c = conv();
    assert.equal(c.nearlyFull({ promptTokens: 159_999 }), null);
    assert.deepEqual(c.nearlyFull({ promptTokens: 160_000 }), { reason: 'context', used: 0, limit: 160_000, of: 'app', window: 200_000, near: true });
    const before = c.counts();
    pictures(c, 30);
    c.noteStep(before);
    assert.deepEqual(c.largestStep, { messages: 30, images: 30, bytes: c.bytes });
    pictures(c, 39);
    assert.equal(c.nearlyFull({ promptTokens: 0 }), null, '69 + 30 < 100');
    pictures(c, 1);
    assert.deepEqual(c.nearlyFull({ promptTokens: 0 }), { reason: 'images', used: 70, limit: 100, of: 'app', near: true }, '70 + 30 >= 100');
    assert.equal(c.fullDetail(), null);
    c.closedBy = c.nearlyFull({ promptTokens: 0 });
    assert.deepEqual(c.fullDetail(), { reason: 'images', used: 70, limit: 100, of: 'app', near: true });
    assert.equal(
      fullText(c.fullDetail(), 'claude-test-9'),
      'This conversation is full: it holds 70 pictures, and Magnusim keeps at most 100 in one conversation (its next step could pass that). Start a new one.',
    );
    const msgs = conv();
    for (let i = 0; i < 297; i += 1) msgs.append({ role: 'user', parts: [{ type: 'text', text: 'x' }] });
    assert.equal(msgs.nearlyFull({ promptTokens: 0 }), null, '297 + 0 + 2 < 300');
    msgs.append({ role: 'user', parts: [{ type: 'text', text: 'x' }] });
    assert.equal(msgs.nearlyFull({ promptTokens: 0 }).reason, 'messages', 'a sum-up adds 2');
  });

  it("each model's own window (fix 4): Claude Opus 5.5 holds 300,000 tokens and is full at 800,000; 600 pictures a request on a 1M model, 100 on one Magnusim doesn't know", () => {
    const opus = conv('anthropic', 'claude-opus-5-5');
    assert.deepEqual(opus.window, { tokens: 1_000_000, known: true });
    opus.promptTokens = 300_000;
    assert.equal(opus.fullDetail(), null, 'once full at 160,000');
    opus.promptTokens = 800_000;
    assert.deepEqual(opus.fullDetail(), { reason: 'context', used: 800_000, limit: 800_000, of: 'model', window: 1_000_000 });
    assert.equal(
      fullText(opus.fullDetail(), 'Claude Opus 5.5'),
      "This conversation is full: the last request used 800,000 of Claude Opus 5.5's 1,000,000-token context, and a conversation is full at 80%. Start a new one.",
    );
    const pics = conv('anthropic', 'claude-sonnet-5-5');
    // Ten to a message (the messages' own limit is 300).
    for (let i = 0; i < 60; i += 1) pics.append({ role: 'user', parts: Array.from({ length: i === 59 ? 9 : 10 }, () => ({ ...PIC })) });
    assert.equal(pics.images, 599);
    assert.equal(pics.fullDetail(), null);
    pictures(pics, 1);
    assert.deepEqual(pics.fullDetail(), { reason: 'images', used: 600, limit: 600, of: 'model' });
    assert.equal(
      fullText(pics.fullDetail(), 'Claude Sonnet 5.5'),
      'This conversation is full: it holds 600 pictures, and Claude Sonnet 5.5 takes at most 600 in one request. Start a new one.',
    );
    const unknown = conv('anthropic', 'claude-test-9');
    assert.deepEqual(unknown.window, { tokens: 200_000, known: false });
    pictures(unknown, 100);
    assert.deepEqual(unknown.fullDetail(), { reason: 'images', used: 100, limit: 100, of: 'app' });
    unknown.promptTokens = 160_000;
    assert.equal(unknown.limits().find((l) => l.reason === 'context').limit, 160_000, 'an unknown cloud model keeps 200K');
    assert.equal(imageLimit('anthropic', 1_000_000), 600);
    assert.equal(imageLimit('anthropic', 200_000), 100);
    assert.equal(imageLimit('openai', 1_000_000), 100);
  });

  it('OpenAI and a local server count the pictures a request sends: 150 held, 20 sent, not full', () => {
    const o = conv('openai', 'gpt-6.1-sol');
    assert.deepEqual(o.window, { tokens: 200_000, known: false }, 'no OpenAI row says its context');
    o.append({ role: 'user', parts: [{ type: 'text', text: 'Build it' }] });
    for (let s = 1; s <= 140; s += 1) {
      o.append({ role: 'assistant', parts: [{ type: 'tool_call', callId: `c${s}`, name: 'snap', input: {} }], raw: { provider: 'openai', model: 'gpt-6.1-sol', payload: [] } });
      o.append({ role: 'user', parts: [{ type: 'tool_result', callId: `c${s}`, isError: false, text: '{"ok":true}', images: [{ ...PIC }, ...(s <= 10 ? [{ ...PIC }] : [])] }] });
    }
    assert.equal(o.images, 150, 'held');
    // 140 results, 139 answered: the oldest 120 left out (common.ts clearedResults), 20 sent.
    assert.equal(o.pictures(), 20);
    assert.equal(o.fullDetail(), null);
    const few = conv('openai_compatible', 'qwen3.8-27b');
    few.append({ role: 'user', parts: [{ type: 'text', text: 'x' }] });
    for (let s = 1; s <= 130; s += 1) {
      few.append({ role: 'assistant', parts: [{ type: 'tool_call', callId: `c${s}`, name: 'snap', input: {} }], raw: { provider: 'openai_compatible', model: 'qwen3.8-27b', payload: null } });
      few.append({ role: 'user', parts: [{ type: 'tool_result', callId: `c${s}`, isError: false, text: '{"ok":true}', images: s > 120 ? [{ ...PIC }] : [] }] });
    }
    assert.deepEqual([few.images, few.pictures(), few.fullReason()], [10, 10, null]);
    assert.equal(
      fullText({ reason: 'images', used: 100, limit: 100, of: 'app', sent: true }, 'GPT-6.1 Sol'),
      'This conversation is full: each request sends 100 pictures, and Magnusim sends at most 100 in one request. Start a new one.',
    );
  });

  it("the provider's models list says a model's context first: a conversation made after it uses it", async () => {
    const { noteListedContext, contextWindow } = await import('../assistant/prices.ts');
    assert.deepEqual(contextWindow('anthropic', 'claude-test-9'), { tokens: 200_000, known: false });
    noteListedContext('anthropic', 'claude-test-9', 500_000);
    noteListedContext('anthropic', 'claude-test-8', 'lots');
    assert.deepEqual(contextWindow('anthropic', 'claude-test-9'), { tokens: 500_000, known: true });
    assert.deepEqual(contextWindow('anthropic', 'claude-test-8'), { tokens: 200_000, known: false });
    assert.deepEqual(contextWindow('openai', 'claude-test-9'), { tokens: 200_000, known: false }, "another provider's model");
    assert.equal(conv('anthropic', 'claude-test-9').limits().find((l) => l.reason === 'context').limit, 400_000);
    resetAssistantState();
    assert.deepEqual(contextWindow('anthropic', 'claude-test-9'), { tokens: 200_000, known: false }, 'for this process only');
  });

  it('room: the limit it is closest to, with its numbers; none for a coding agent', () => {
    const c = conv();
    assert.deepEqual(c.room(), { reason: 'messages', used: 0, limit: 300 });
    pictures(c, 72);
    assert.deepEqual(c.room(), { reason: 'images', used: 72, limit: 100 });
    c.promptTokens = 150_000;
    assert.deepEqual(c.room(), { reason: 'context', used: 150_000, limit: 160_000 });
    assert.equal(conv('agent:helper', 'agent').room(), null);
  });

  it('the conversation row says why it is full in the same words (full_text) and how close it is (room); a start in it is refused with them', async () => {
    const m = mk();
    const s = await relayServer(m);
    servers.push(s);
    const first = await quickTurn(m, { text: 'one' });
    let row = (await s.get('/api/assistant/conversations')).json.conversations[0];
    assert.deepEqual([row.full, row.full_text], [null, null]);
    assert.equal(row.room.reason, 'messages');
    first.conv.promptTokens = 810_000;
    row = (await s.get('/api/assistant/conversations')).json.conversations[0];
    const said = "This conversation is full: the last request used 810,000 of Claude Opus 5.5's 1,000,000-token context, and a conversation is full at 80%. Start a new one.";
    assert.deepEqual([row.full, row.full_text, row.room], ['context', said, { reason: 'context', used: 810_000, limit: 800_000 }]);
    const r = await startTurn(m, { text: 'two', conversation: first.conv.id });
    assert.deepEqual([r.status, r.body.code, r.body.error], [409, 'conversation_full', said]);
  });
});
