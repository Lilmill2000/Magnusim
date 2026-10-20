// The Assistant's questions (Foundation spec 6.4, 10.1, 10.4): held on the server; the
// first answer wins; the timeout denies; Stop withdraws; nothing allows by itself; a
// tab-bound question is shown again when its tab's link returns, and after the link has
// been gone 15 s the turn gets a note while the route still answers. Through the page
// relay (a real hub and page): a gate frame in the bound tab, sent again when the tab
// links again, and gate_closed for each way it closes.
import { after, afterEach, describe, it } from 'node:test';
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

const { FakeClock, makeManager, settled, eventsOf, hostTool, until, tick, relayServer, runTool, settledNow } = await import('./assistant-harness.js');
const { RELAY_ACK_MS } = await import('../assistant/relay.ts');
const { GateBroker, GATE_UNSEEN_NOTE, GATE_UNSEEN_WINDOW_NOTE, GATE_TIMEOUT_MS, GATE_UNSEEN_MS, NO_PRESENTER } = await import('../assistant/gates.ts');
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
    // With no presenter (no page relay) a tab's question is unseen from the start.
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

  it('a window-only question (link_only) unseen for 15 s: its note says to show the window, never to answer here (the answer key can’t)', async () => {
    const { b, events, clock } = broker({ presenter: NO_PRESENTER });
    const own = ask(b, events, { ...REQ, link_only: true }, TURN('T1'));
    assert.equal(own.view.link_only, true);
    const keyed = ask(b, events, { ...REQ, turn: 't-2' }, { kind: 'turn', id: 't-2', tab: 'T1' });
    clock.advance(GATE_UNSEEN_MS);
    const notes = Object.fromEntries(events.filter((e) => e.type === 'unseen').map((e) => [e.view.id, e.text]));
    assert.deepEqual(notes, { [own.view.id]: GATE_UNSEEN_WINDOW_NOTE, [keyed.view.id]: GATE_UNSEEN_NOTE });
    assert.equal(GATE_UNSEEN_WINDOW_NOTE, 'The Magnusim window that should show this question is in the background or closed. Show it to answer.');
    assert.doesNotMatch(GATE_UNSEEN_WINDOW_NOTE, /answer here/i);
    b.answer(own.view.id, false);
    b.answer(keyed.view.id, false);
    await Promise.all([own.answer, keyed.answer]);
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
      const key = started.json.answer_key;
      assert.deepEqual((await post(`/api/assistant/gates/${gate.id}`, { allow: 'yes', answer_key: key })).status, 400);
      const first = await post(`/api/assistant/gates/${gate.id}`, { allow: true, answer_key: key });
      assert.deepEqual([first.status, first.json], [200, { ok: true }]);
      const second = await post(`/api/assistant/gates/${gate.id}`, { allow: false, answer_key: key });
      assert.deepEqual([second.status, second.json.code, second.json.already, second.json.answer], [409, 'already', true, 'allow']);
      assert.equal((await post('/api/assistant/gates/g-0000', { allow: true, answer_key: key })).status, 404);
      await settled(t);
      assert.equal(t.state, 'done');
      assert.deepEqual(eventsOf(t).filter((e) => e.type === 'gate_closed').map((e) => [e.answer, e.by]), [['allow', 'user']]);
    } finally {
      handle.shutdown();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('the page relay shows a tab-bound question in its tab', { timeout: 30_000 }, () => {
  const servers = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  /** A turn bound to a linked tab whose model calls the destructive host tool `zap`. */
  async function zapTurn() {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: { p1: { id: 'p1', title: 'Wing', created_at: null } }, hostTools: [hostTool('zap', { risk: 'destructive' })] });
    const s = await relayServer(m);
    servers.push(s);
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    m.provider.script({ tools: [{ name: 'zap' }] }, { text: 'Done.' });
    const started = await s.post('/api/assistant/turns', { text: 'Zap it', tab: page.tab });
    assert.equal(started.status, 202);
    const t = s.handle.turns.get(started.json.turn);
    const shown = (await page.frame('gate')).gate;
    return { m, s, page, t, shown };
  }

  it('a gate frame on the tab’s live link; the link gone 15 s: a note; sent again when the tab links again; the route still answers with the answer key, and the page hears gate_closed', async () => {
    const { m, s, page, t, shown } = await zapTurn();
    const logged = eventsOf(t).find((e) => e.type === 'gate').gate;
    assert.deepEqual(shown, logged, 'the turn’s own question');
    assert.equal(shown.tool, 'zap');
    page.serverDrop();
    await until(() => s.relay.snapshot()[page.tab]?.connected === false, 5000, 'the link to go');
    m.clock.advance(GATE_UNSEEN_MS - 1);
    assert.equal(eventsOf(t).filter((e) => e.type === 'note' && e.text === GATE_UNSEEN_NOTE).length, 0);
    m.clock.advance(1);
    assert.equal(eventsOf(t).filter((e) => e.type === 'note' && e.text === GATE_UNSEEN_NOTE).length, 1, 'the note after 15 s');
    // The same tab links again: the question comes again, after `linked`.
    const back = await s.page(page.tab);
    await back.open();
    const again = (await back.frame('gate')).gate;
    assert.equal(again.id, shown.id);
    assert.equal(back.frames.find((f) => f.c === 'assistant:1').event, 'linked');
    // Still answerable through the route; the page's dialog is told to go.
    const r = await s.post(`/api/assistant/gates/${shown.id}`, { allow: true, answer_key: t.answerKey });
    assert.equal(r.status, 200);
    assert.deepEqual(await back.frame('gate_closed'), { gate: shown.id, answer: 'allow', by: 'user' });
    await settled(t);
    assert.equal(t.state, 'done');
  });

  it('gate_closed also when the question times out, and when Stop withdraws it', async () => {
    const timed = await zapTurn();
    timed.m.clock.advance(GATE_TIMEOUT_MS);
    assert.deepEqual(await timed.page.frame('gate_closed'), { gate: timed.shown.id, answer: 'deny', by: 'timeout' });
    await settled(timed.t);
    assert.equal(timed.t.state, 'done', 'declined: the model went on');
    const stopped = await zapTurn();
    const r = await stopped.s.post(`/api/assistant/turns/${stopped.t.id}/stop`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(await stopped.page.frame('gate_closed'), { gate: stopped.shown.id, answer: 'deny', by: 'stop' });
    await settled(stopped.t);
    assert.equal(stopped.t.state, 'stopped');
  });
});

describe('who may answer a question (P2): the program that started the turn, or the tab that shows it', { timeout: 30_000 }, () => {
  const servers = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  /** A linked tab whose turn's model calls the destructive host tool `zap`: its question is open. */
  async function openQuestion() {
    const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: { p1: { id: 'p1', title: 'Wing', created_at: null } }, hostTools: [hostTool('zap', { risk: 'destructive' })] });
    const s = await relayServer(m);
    servers.push(s);
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    m.provider.script({ tools: [{ name: 'zap' }] }, { text: 'Done.' });
    const started = await s.post('/api/assistant/turns', { text: 'Zap it', tab: page.tab });
    assert.equal(started.status, 202);
    const t = s.handle.turns.get(started.json.turn);
    const shown = (await page.frame('gate')).gate;
    return { m, s, page, link, t, shown, started };
  }

  it("the 202 carries the turn's answer key (32 hex), never its summary, log, poll or the tabs", async () => {
    const { s, t, started } = await openQuestion();
    assert.match(started.json.answer_key, /^[0-9a-f]{32}$/);
    assert.equal(started.json.answer_key, t.answerKey);
    const polled = await s.get(`/api/assistant/turns/${t.id}?since=0`);
    assert.equal(polled.status, 200);
    assert.ok(!JSON.stringify(polled.json).includes(t.answerKey), 'not in the poll');
    assert.ok(!JSON.stringify(t.summary()).includes(t.answerKey), 'not in the summary');
    assert.ok(!JSON.stringify(eventsOf(t)).includes(t.answerKey), 'not in the log');
    assert.ok(!JSON.stringify((await s.get('/api/assistant/tabs')).json).includes(t.answerKey), 'not in the tabs');
    await s.post(`/api/assistant/turns/${t.id}/stop`, {});
  });

  it('POST /gates/:id: without the answer key, with a wrong one or another turn’s, 403 answer_key and still open; with it, ok', async () => {
    const { s, t, shown } = await openQuestion();
    const other = await openQuestion();
    for (const answer_key of [undefined, '', 'x', 'f'.repeat(32), other.t.answerKey, `${t.answerKey} `, t.answerKey.toUpperCase(), 7, [t.answerKey], 'é'.repeat(32)]) {
      const r = await s.post(`/api/assistant/gates/${shown.id}`, { allow: true, ...(answer_key === undefined ? {} : { answer_key }) });
      assert.deepEqual([r.status, r.json.code], [403, 'answer_key'], JSON.stringify(answer_key));
    }
    assert.deepEqual(t.summary().open_gates.map((g) => g.id), [shown.id], 'still open');
    assert.equal(t.state, 'awaiting_confirmation');
    assert.equal((await s.post('/api/assistant/gates/g-0000000000000000', { allow: true })).status, 404);
    const ok = await s.post(`/api/assistant/gates/${shown.id}`, { allow: true, answer_key: t.answerKey });
    assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
    // Answered: a second answer with the key is told so; without it, refused as before.
    const again = await s.post(`/api/assistant/gates/${shown.id}`, { allow: false, answer_key: t.answerKey });
    assert.deepEqual([again.status, again.json.code, again.json.answer], [409, 'already', 'allow']);
    assert.equal((await s.post(`/api/assistant/gates/${shown.id}`, { allow: false })).status, 403);
    await settled(t);
    assert.equal(t.state, 'done');
    await other.s.post(`/api/assistant/turns/${other.t.id}/stop`, {});
  });

  it('POST /relay/gate: the showing link answers; another tab’s link and a link that is not live are refused', async () => {
    const { s, page, link, t, shown } = await openQuestion();
    // Another tab of the app: its own live link, never sent this question.
    const otherPage = await s.page();
    const otherLink = await otherPage.open();
    let r = await s.post('/api/assistant/relay/gate', { link: otherLink, gate: shown.id, allow: true });
    assert.deepEqual([r.status, r.json.code], [403, 'not_shown']);
    r = await s.post('/api/assistant/relay/gate', { link: 'f'.repeat(24), gate: shown.id, allow: true });
    assert.deepEqual([r.status, r.json.code], [409, 'no_channel']);
    for (const body of [{ link, gate: shown.id }, { link, gate: shown.id, allow: 'yes' }, { link, allow: true }, { gate: shown.id, allow: true }]) {
      r = await s.post('/api/assistant/relay/gate', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    // The manager takes a link proof only for the gate's own tab.
    assert.equal(s.handle.turns.answerGate(shown.id, true, { kind: 'link', tab: otherPage.tab }).status, 403);
    // A link is no proof on the answer key's route.
    r = await s.post(`/api/assistant/gates/${shown.id}`, { allow: true, link, kind: 'link', tab: page.tab });
    assert.deepEqual([r.status, r.json.code], [403, 'answer_key']);
    assert.equal(t.state, 'awaiting_confirmation');
    r = await s.post('/api/assistant/relay/gate', { link, gate: shown.id, allow: true });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.deepEqual(await page.frame('gate_closed'), { gate: shown.id, answer: 'allow', by: 'user' });
    r = await s.post('/api/assistant/relay/gate', { link, gate: shown.id, allow: false });
    assert.deepEqual([r.status, r.json.code, r.json.answer], [409, 'already', 'allow']);
    await settled(t);
    assert.equal(t.state, 'done');
  });

  it('after the tab reconnects the old link answers nothing; the new one, sent the question again, does', async () => {
    const { s, page, link, t, shown } = await openQuestion();
    page.serverDrop();
    await until(() => s.relay.snapshot()[page.tab]?.connected === false, 5000, 'the link to go');
    let r = await s.post('/api/assistant/relay/gate', { link, gate: shown.id, allow: true });
    assert.deepEqual([r.status, r.json.code], [409, 'no_channel']);
    const back = await s.page(page.tab);
    const newLink = await back.open();
    assert.equal((await back.frame('gate')).gate.id, shown.id);
    r = await s.post('/api/assistant/relay/gate', { link: newLink, gate: shown.id, allow: false });
    assert.equal(r.status, 200);
    await settled(t);
    assert.deepEqual(eventsOf(t).filter((e) => e.type === 'gate_closed').map((e) => [e.answer, e.by]), [['deny', 'user']]);
  });

  it('a silent link answers only a question it was sent: one opened while it was silent is refused (not_shown) and stays open, though the POST shows the page is there and sends it; then that link answers it', async () => {
    const { m, s, page, link, t, shown } = await openQuestion();
    // The tab goes silent: a workspace call its page never acknowledges.
    const ctx = { tab: page.tab, projectId: 'p1', simulationId: 's1', cloud: false, local: true };
    const call = runTool(m.registry.toolsFor(ctx).find((d) => d.localName === 'add'), { by: 1 }, ctx);
    await page.frame('invoke');
    m.clock.advance(RELAY_ACK_MS);
    assert.equal((await call.promise).error.code, 'tab_disconnected');
    assert.equal(s.relay.snapshot()[page.tab].connected, false, 'silent');
    // A second question of the turn, opened now: not sent on the silent link.
    const gates = s.handle.turns.gates;
    const opened = [];
    const off = gates.subscribe((e) => e.type === 'open' && opened.push(e.view));
    const ac = new AbortController();
    const asked = gates.ask({ ...REQ, turn: t.id }, { kind: 'turn', id: t.id, tab: page.tab }, ac.signal);
    const unseen = await until(() => opened[0]);
    off();
    assert.deepEqual(page.of('gate').map((d) => d.gate.id), [shown.id], 'only the first question was sent');
    // Its id posted on that link: refused, and still open.
    let r = await s.post('/api/assistant/relay/gate', { link, gate: unseen.id, allow: true });
    assert.deepEqual([r.status, r.json.code], [403, 'not_shown']);
    assert.equal(await settledNow(asked), false, 'still open');
    assert.equal(t.state, 'awaiting_confirmation');
    // The POST was heard: the link is connected again and the question is sent on it; now it answers.
    assert.equal(s.relay.snapshot()[page.tab].connected, true, 'heard');
    await until(() => page.of('gate').some((d) => d.gate.id === unseen.id), 5000, 'the question sent');
    r = await s.post('/api/assistant/relay/gate', { link, gate: unseen.id, allow: true });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.equal(await asked, 'allow');
    await s.post(`/api/assistant/gates/${shown.id}`, { allow: false, answer_key: t.answerKey });
    await settled(t);
  });

  it('a link_only question takes only the tab’s link, never the answer key; an MCP client’s question takes no answer key', async () => {
    const { s, page, link, t, shown } = await openQuestion();
    const gates = s.handle.turns.gates;
    const opened = [];
    const off = gates.subscribe((e) => e.type === 'open' && opened.push(e.view));
    // A question for the window only, of the same turn and tab (as a coding agent's own tool asks).
    const ac = new AbortController();
    const asked = gates.ask({ ...REQ, turn: t.id, link_only: true }, { kind: 'turn', id: t.id, tab: page.tab }, ac.signal);
    const only = (await page.frame('gate', 1)).gate;
    assert.deepEqual([only.id, only.link_only], [opened[0].id, true]);
    let r = await s.post(`/api/assistant/gates/${only.id}`, { allow: true, answer_key: t.answerKey });
    assert.deepEqual([r.status, r.json.code, r.json.error], [403, 'not_shown', 'Answer it in the Magnusim window.']);
    r = await s.post('/api/assistant/relay/gate', { link, gate: only.id, allow: true });
    assert.equal(r.status, 200);
    assert.equal(await asked, 'allow');
    // An MCP client's question (no turn): no answer key answers it, nor a tab it was never sent to.
    const mcp = gates.ask(REQ, { kind: 'mcp', session: 's-1' }, ac.signal);
    off();
    const mcpView = opened[1];
    r = await s.post(`/api/assistant/gates/${mcpView.id}`, { allow: true, answer_key: t.answerKey });
    assert.deepEqual([r.status, r.json.code], [403, 'answer_key']);
    r = await s.post('/api/assistant/relay/gate', { link, gate: mcpView.id, allow: true });
    assert.deepEqual([r.status, r.json.code], [403, 'not_shown']);
    assert.equal(s.handle.turns.answerGate(mcpView.id, true, { kind: 'link', tab: page.tab }).status, 403);
    ac.abort();
    assert.equal(await mcp, 'deny');
    assert.equal(shown.link_only, undefined, 'a confirm question is not link_only');
    await s.post(`/api/assistant/gates/${shown.id}`, { allow: false, answer_key: t.answerKey });
    await settled(t);
  });
});

describe('retarget (phase 4 spec 9.6)', () => {
  it("moves a turn's open questions to another tab: shown there, closed there, answered only there; other turns' stay", async () => {
    const p = presenter();
    const withdrawnTo = [];
    p.withdraw = (view, owner) => withdrawnTo.push([view.id, owner.tab]);
    const { b, events } = broker({ presenter: p });
    const mine = ask(b, events, REQ, TURN('tab-a'));
    const other = ask(b, events, { ...REQ, turn: 't-2' }, { kind: 'turn', id: 't-2', tab: 'tab-a' });
    assert.equal(b.retarget('t-1', 'tab-b'), 1);
    assert.deepEqual(p.presented.slice(-1).map((x) => [x.view.id, x.owner.tab]), [[mine.view.id, 'tab-b']]);
    assert.equal(b.lookup(mine.view.id).owner.tab, 'tab-b');
    assert.equal(b.lookup(other.view.id).owner.tab, 'tab-a');
    assert.equal(b.answer(mine.view.id, true), 'ok');
    assert.equal(await mine.answer, 'allow');
    assert.deepEqual(withdrawnTo, [[mine.view.id, 'tab-b']], 'taken down where it shows now');
    assert.equal(events.filter((e) => e.type === 'closed').at(-1).owner.tab, 'tab-b');
    assert.equal(b.lookup(mine.view.id).owner.tab, 'tab-b', 'remembered as answered there');
    b.answer(other.view.id, false);
    await other.answer;
  });
});
