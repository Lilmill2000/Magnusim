// The Assistant's questions (Foundation spec 6.4, 10.1, 10.4): held on the server; the
// first answer wins; the timeout denies; Stop withdraws; nothing allows by itself; a
// tab-bound question is shown again when its tab's link returns, and after the link has
// been gone 15 s the turn gets a note while the route still answers.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-gates-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { FakeClock, makeManager, settled, eventsOf, hostTool, until, tick } = await import('./assistant-harness.js');
const { GateBroker, GATE_UNSEEN_NOTE, GATE_TIMEOUT_MS, GATE_UNSEEN_MS, NO_PRESENTER } = await import('../assistant/gates.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const { Router, dispatch } = await import('../router.ts');
const { sendJson } = await import('../http.ts');
const routes = await import('../assistant-routes.ts');

after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const REQ = { kind: 'confirm', turn: 't-1', title: 'Allow the Assistant to reset the counter?', copy: 'Workspace demo · can’t be undone.', yes: 'Allow', no: "Don't", risk: 'destructive', tool: 'ai-demo__reset' };
const TURN = (tab = null) => ({ kind: 'turn', id: 't-1', tab });

/** A presenter that records and answers `shown` (a function of the call count). */
function presenter(shown = () => true) {
  const p = { presented: [], withdrawn: [] };
  p.present = (view, owner) => {
    p.presented.push({ view, owner });
    return shown(p.presented.length, view, owner);
  };
  p.withdraw = (view) => p.withdrawn.push(view.id);
  return p;
}

function broker(o = {}) {
  const clock = o.clock ?? new FakeClock();
  const events = [];
  const b = new GateBroker({ clock, ...o });
  b.subscribe((e) => events.push(e));
  return { b, clock, events };
}

/** Starts ask() and returns {answer: Promise, view}. */
function ask(b, events, req = REQ, owner = TURN(), signal = new AbortController().signal) {
  const answer = b.ask(req, owner, signal);
  const open = events.filter((e) => e.type === 'open').at(-1);
  return { answer, view: open.view };
}

describe('a question held on the server', { timeout: 20_000 }, () => {
  it('opens with its texts, cleaned and capped; its id, times and owner', async () => {
    const { b, events, clock } = broker();
    const detail = Array.from({ length: 9 }, (_, i) => ({ label: `Row ${i}\u0007`, value: 'v'.repeat(200) }));
    const { answer, view } = ask(b, events, { ...REQ, title: 'Allow\u202e it?', detail });
    assert.match(view.id, /^g-[0-9a-f]{16}$/);
    assert.equal(view.title, 'Allow it?');
    assert.equal(view.detail.length, 6);
    assert.ok(view.detail.every((d) => d.value.length === 80 && !d.label.includes('\u0007')));
    assert.equal(view.opened_at, new Date(clock.now()).toISOString());
    assert.equal(view.expires_at, new Date(clock.now() + GATE_TIMEOUT_MS).toISOString());
    assert.deepEqual(b.forTurn('t-1').map((v) => v.id), [view.id]);
    assert.equal(b.openCount(), 1);
    b.answer(view.id, false);
    assert.equal(await answer, 'deny');
  });

  it('the first answer wins; a second is told "already"; an unknown id "unknown"', async () => {
    const { b, events } = broker();
    const { answer, view } = ask(b, events);
    assert.equal(b.answer(view.id, true), 'ok');
    assert.equal(b.answer(view.id, false), 'already');
    assert.equal(b.answer('g-nope', true), 'unknown');
    assert.equal(await answer, 'allow');
    assert.deepEqual(b.closedAs(view.id), { answer: 'allow', by: 'user' });
    assert.deepEqual(events.filter((e) => e.type === 'closed').map((e) => [e.answer, e.by]), [['allow', 'user']]);
    assert.equal(b.openCount(), 0);
  });

  it('no answer in 10 minutes denies (timeout); nothing allows it by itself', async () => {
    const p = presenter();
    const { b, events, clock } = broker({ presenter: p });
    const { answer, view } = ask(b, events);
    let settled = null;
    answer.then((a) => (settled = a));
    clock.advance(GATE_TIMEOUT_MS - 1);
    await tick();
    assert.equal(settled, null, 'still open a moment before');
    clock.advance(1);
    assert.equal(await answer, 'deny');
    assert.deepEqual(b.closedAs(view.id), { answer: 'deny', by: 'timeout' });
    assert.deepEqual(p.withdrawn, [view.id], 'the dialog is taken down');
    assert.equal(b.answer(view.id, true), 'already', 'a late Allow changes nothing');
    // A Stop that came first: no question at all.
    const stopped = new AbortController();
    stopped.abort();
    const before = events.length;
    assert.equal(await b.ask(REQ, TURN(), stopped.signal), 'deny');
    assert.equal(events.length, before, 'never opened');
    // A presenter that throws neither answers nor breaks it.
    const { b: b2, events: e2 } = broker({ presenter: { present: () => { throw new Error('x'); }, withdraw: () => { throw new Error('y'); } } });
    const q = ask(b2, e2);
    assert.equal(b2.openCount(), 1);
    b2.answer(q.view.id, false);
    assert.equal(await q.answer, 'deny');
  });

  it('Stop withdraws it (denied, by stop) and takes the dialog down', async () => {
    const p = presenter();
    const { b, events } = broker({ presenter: p });
    const ac = new AbortController();
    const { answer, view } = ask(b, events, REQ, TURN('T1'), ac.signal);
    ac.abort();
    assert.equal(await answer, 'deny');
    assert.deepEqual(b.closedAs(view.id), { answer: 'deny', by: 'stop' });
    assert.deepEqual(p.withdrawn, [view.id]);
    assert.equal(b.answer(view.id, true), 'already');
    assert.deepEqual(b.pendingForTab('T1'), []);
  });
});

describe('a question for an app tab', { timeout: 20_000 }, () => {
  it('shown again when the tab’s link returns; no note once it was shown', async () => {
    const p = presenter((n) => n > 1);
    const { b, events, clock } = broker({ presenter: p });
    const { answer, view } = ask(b, events, REQ, TURN('T1'));
    assert.equal(p.presented.length, 1, 'tried once: no live link');
    assert.deepEqual(b.pendingForTab('T1').map((v) => v.id), [view.id]);
    b.tabLinked('T2');
    assert.equal(p.presented.length, 1, "another tab's link shows nothing");
    b.tabLinked('T1');
    assert.equal(p.presented.length, 2);
    assert.equal(p.presented[1].view.id, view.id, 'the same question again');
    clock.advance(GATE_UNSEEN_MS * 2);
    assert.equal(events.filter((e) => e.type === 'unseen').length, 0, 'it was seen in the end');
    b.answer(view.id, true);
    assert.equal(await answer, 'allow');
  });

  it('a link gone for 15 s: one note for the owner, and the question still answers', async () => {
    const p = presenter();
    const { b, events, clock } = broker({ presenter: p });
    const { answer, view } = ask(b, events, REQ, TURN('T1'));
    b.tabUnlinked('T1');
    clock.advance(GATE_UNSEEN_MS - 1);
    assert.equal(events.filter((e) => e.type === 'unseen').length, 0);
    clock.advance(1);
    const unseen = events.filter((e) => e.type === 'unseen');
    assert.deepEqual(unseen.map((e) => [e.view.id, e.text]), [[view.id, GATE_UNSEEN_NOTE]]);
    b.tabUnlinked('T1');
    clock.advance(GATE_UNSEEN_MS * 3);
    assert.equal(events.filter((e) => e.type === 'unseen').length, 1, 'once');
    assert.equal(b.answer(view.id, false), 'ok');
    assert.equal(await answer, 'deny');
    // With no presenter (this commit: the page relay comes next) a tab's question is unseen from the start.
    const n = broker({ presenter: NO_PRESENTER });
    const q = ask(n.b, n.events, REQ, TURN('T1'));
    n.clock.advance(GATE_UNSEEN_MS);
    assert.equal(n.events.filter((e) => e.type === 'unseen').length, 1);
    // A question with no tab (the terminal) never gets that note.
    const q2 = ask(n.b, n.events, REQ, TURN(null));
    n.clock.advance(GATE_UNSEEN_MS * 2);
    assert.equal(n.events.filter((e) => e.type === 'unseen' && e.view.id === q2.view.id).length, 0);
    n.b.answer(q.view.id, false);
    n.b.answer(q2.view.id, false);
    await Promise.all([q.answer, q2.answer]);
  });

  it('through a turn and the route: the note reaches the turn’s log, and POST /api/assistant/gates/:id answers (409 for a second answer)', async () => {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: { p1: { id: 'p1', title: 'Wing', created_at: null } }, hostTools: [hostTool('zap', { risk: 'destructive' })] });
    m.registry.setWorkspace('T1', 'L1', { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: [] });
    m.provider.script({ tools: [{ name: 'zap' }] }, { text: 'Done.' });
    const router = new Router();
    const handle = routes.registerAssistantRoutes(router, { turns: m.deps });
    const server = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    try {
      const started = await post('/api/assistant/turns', { text: 'Reset it', tab: 'T1' });
      assert.equal(started.status, 202);
      const t = handle.turns.get(started.json.turn);
      await until(() => t.state === 'awaiting_confirmation');
      const gate = eventsOf(t).find((e) => e.type === 'gate').gate;
      m.clock.advance(GATE_UNSEEN_MS);
      assert.ok(eventsOf(t).some((e) => e.type === 'note' && e.text === GATE_UNSEEN_NOTE), 'the note');
      const polled = await fetch(`${base}/api/assistant/turns/${t.id}?since=0`).then((r) => r.json());
      assert.deepEqual(polled.turn.open_gates.map((g) => g.id), [gate.id], 'open_gates in the summary');
      assert.deepEqual((await post(`/api/assistant/gates/${gate.id}`, { allow: 'yes' })).status, 400);
      const first = await post(`/api/assistant/gates/${gate.id}`, { allow: true });
      assert.deepEqual([first.status, first.json], [200, { ok: true }]);
      const second = await post(`/api/assistant/gates/${gate.id}`, { allow: false });
      assert.deepEqual([second.status, second.json.code, second.json.already, second.json.answer], [409, 'already', true, 'allow']);
      assert.equal((await post('/api/assistant/gates/g-0000', { allow: true })).status, 404);
      await settled(t);
      assert.equal(t.state, 'done');
      assert.deepEqual(eventsOf(t).filter((e) => e.type === 'gate_closed').map((e) => [e.answer, e.by]), [['allow', 'user']]);
    } finally {
      handle.shutdown();
      await new Promise((r) => server.close(r));
    }
  });
});
