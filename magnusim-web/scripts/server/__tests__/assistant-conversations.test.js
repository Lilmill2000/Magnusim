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
      'billing', 'created_at', 'dropped_turns', 'full', 'id', 'label', 'last_used_at', 'model', 'project_id', 'project_title', 'provider', 'running', 'title', 'turns',
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
