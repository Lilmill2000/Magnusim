// The page relay on the server (Foundation spec 8.4, 10.1, 10.4): a real Router with the
// event hub and the Assistant's routes over http.createServer, and a page client that holds
// a tab's event stream. The channel is for this PC only and says `linked {link}` first;
// registrations go by rev; a call is invoked, acknowledged, followed and answered, and fails
// at once when its stream or channel goes, after the ack window when nothing answers, after
// the grace when the page withdrew its tools mid-call; the runner's stall window and Stop
// reach the page as `abort`; one call per tab, and tabs stay apart; a bound turn's end
// starts the hold, and a dropped link leaves a dormant registration until the hold ends.
// Races are forced (the server's cut, a fake clock, explicit answers), never slept.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-relay-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, relayServer, demoTools, DEMO_WORKSPACE, hubTab, runTool, settledNow, settled, eventsOf, until } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { TAB_HIDDEN_TEXT } = await import('../assistant/turns.ts');
const { ABORT_GRACE_MS } = await import('../assistant/runner.ts');
const { ASSISTANT_HOLD_MS, RELAY_ACK_MS, UNREGISTER_GRACE_MS, pageOutcome, resolveRelaySwitches } = await import('../assistant/relay.ts');

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const PROJECTS = { p1: { id: 'p1', title: 'Wing', created_at: null } };

async function setup(o = {}) {
  const m = makeManager({ dir: ROOT, provider: 'openai_compatible', projects: PROJECTS, ...(o.manager || {}) });
  const s = await relayServer(m, o);
  servers.push(s);
  return { m, s };
}

/** A page with its relay channel open and the demo tools registered (rev 1). */
async function linkedPage(s, tab) {
  const page = await s.page(tab);
  const link = await page.open();
  const reg = await s.register(link, 1);
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  return { page, link, reg: reg.json };
}

const ctx = (tab) => ({ tab, projectId: 'p1', simulationId: 's1', cloud: false, local: true });
const toolOf = (m, tab, localName) => m.registry.toolsFor(ctx(tab)).find((t) => t.localName === localName);
const DISCONNECTED = /^The page hosting Counter disconnected while the tool ran; it may or may not have finished\./;

describe('the channel', { timeout: 30_000 }, () => {
  it('from this PC only and for the relay role: a remote stream or subscribe 403, another role 400; `linked {link}` comes first, new at each open; an unknown link 409 no_channel', async () => {
    const { s } = await setup();
    const page = await s.page();
    const r = await page.subscribe('assistant:1');
    assert.equal(r.ok, true);
    const first = await until(() => page.frames.find((f) => f.c === 'assistant:1'));
    assert.equal(first.event, 'linked', 'the first frame');
    assert.match(first.d.link, /^[0-9a-f]{24}$/);
    const link1 = first.d.link;
    // The same channel opened again: a new link, and the old one is gone.
    const link2 = await page.open('assistant:1');
    assert.notEqual(link2, link1);
    const stale = await s.register(link1, 1);
    assert.deepEqual([stale.status, stale.json.code], [409, 'no_channel']);
    assert.equal((await s.register(link2, 1)).status, 200);
    // Another role.
    const role = await page.subscribe('assistant:2', { role: 'dock' });
    assert.deepEqual([role.ok, role.status], [false, 400]);
    assert.deepEqual(page.of('linked', 'assistant:2'), []);
    // A subscribe from elsewhere on this PC's stream, and a stream from elsewhere.
    const fwd = await page.subscribe('assistant:3', { role: 'relay' }, { 'x-forwarded-for': '203.0.113.9' });
    assert.deepEqual([fwd.ok, fwd.status], [false, 403]);
    const remote = await s.page(undefined, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(remote.status, 200, 'the hub itself serves the stream');
    const rr = await remote.subscribe('assistant:1');
    assert.deepEqual([rr.ok, rr.status], [false, 403]);
    assert.deepEqual(remote.frames, [], 'no frame reached it');
    assert.deepEqual(page.of('linked', 'assistant:3'), []);
    // Unknown links, on every relay POST.
    const unknown = 'f'.repeat(24);
    for (const [path, body] of [
      ['tools', { link: unknown, rev: 1, workspace: DEMO_WORKSPACE, tools: [] }],
      ['progress', { link: unknown, call: 'rc-1-abc', ack: true }],
      ['result', { link: unknown, call: 'rc-1-abc', ok: true }],
      ['tools', { link: 'not-a-link', rev: 1, workspace: DEMO_WORKSPACE, tools: demoTools() }],
    ]) {
      const x = await s.post(`/api/assistant/relay/${path}`, body);
      assert.deepEqual([x.status, x.json.code], [409, 'no_channel'], path);
    }
    // The relay's POSTs are for this PC only, as every Assistant route.
    const far = await s.post('/api/assistant/relay/tools', { link: link2, rev: 2, workspace: DEMO_WORKSPACE, tools: [] }, { 'x-forwarded-for': '203.0.113.9' });
    assert.deepEqual([far.status, far.json.reason], [403, 'remote']);
    assert.equal((await s.tabs()).length, 1, 'the remote withdrawal changed nothing');
  });

  it('bodies it can’t read: 400; JSON only (415); over the body limits 413', async () => {
    const { s } = await setup();
    const page = await s.page();
    const link = await page.open();
    for (const [what, body] of [
      ['no rev', { link, workspace: DEMO_WORKSPACE, tools: demoTools() }],
      ['rev 0', { link, rev: 0, workspace: DEMO_WORKSPACE, tools: demoTools() }],
      ['rev not whole', { link, rev: 1.5, workspace: DEMO_WORKSPACE, tools: demoTools() }],
      ['tools not a list', { link, rev: 1, workspace: DEMO_WORKSPACE, tools: {} }],
      ['no workspace', { link, rev: 1, tools: demoTools() }],
      ['a bad plugin key', { link, rev: 1, workspace: { ...DEMO_WORKSPACE, plugin: '../x' }, tools: demoTools() }],
      ['a bad project id', { link, rev: 1, workspace: { ...DEMO_WORKSPACE, project_id: 'a b' }, tools: demoTools() }],
      ['no workspace name', { link, rev: 1, workspace: { ...DEMO_WORKSPACE, workspace: '' }, tools: demoTools() }],
      ['a guide that is not text', { link, rev: 1, workspace: DEMO_WORKSPACE, tools: demoTools(), guide: 5 }],
      ['an epoch that is not a token', { link, rev: 1, workspace: DEMO_WORKSPACE, tools: demoTools(), epoch: 'x' }],
      ['a link that is not text', { link: 5, rev: 1, workspace: DEMO_WORKSPACE, tools: demoTools() }],
    ]) {
      const r = await s.post('/api/assistant/relay/tools', body);
      assert.equal(r.status, 400, what);
    }
    assert.equal((await s.post('/api/assistant/relay/progress', { link })).status, 400);
    assert.equal((await s.post('/api/assistant/relay/result', { link, call: 'a b' })).status, 400);
    assert.deepEqual(await s.tabs(), [], 'nothing registered');
    const text = await fetch(`${s.base}/api/assistant/relay/tools`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ link, rev: 1, workspace: DEMO_WORKSPACE, tools: demoTools() }) });
    assert.equal(text.status, 415);
    const bigTools = await s.register(link, 1, [{ name: 'a', description: 'x'.repeat(513 * 1024), inputSchema: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read' }]);
    assert.equal(bigTools.status, 413);
    const bigResult = await s.result(link, 'rc-1-abc', { ok: true, result: { text: 'x'.repeat(10 * 1024 * 1024) } });
    assert.equal(bigResult.status, 413);
  });
});

describe('registrations', { timeout: 30_000 }, () => {
  it('accepted and refused tools and the epoch token; /tabs shows it (connected, since, workspace, tools, refused, active turns, hold); tools [] withdraws it', async () => {
    const { m, s } = await setup();
    const page = await s.page();
    const link = await page.open();
    const bad = { name: 'Bad', description: 'x', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read' };
    const r = await s.register(link, 1, [...demoTools(), bad], { guide: 'Counter notes.' });
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.deepEqual(r.json.accepted, ['add', 'get_count', 'reset', 'slow_add']);
    assert.deepEqual(r.json.refused.map((x) => [x.name, x.code]), [['Bad', 'bad_name']]);
    assert.match(r.json.epoch, /^[0-9a-f]{16}:[0-9]+\.[0-9]+:[0-9a-f]{8}$/);
    const [tab] = await s.tabs();
    assert.deepEqual(tab, {
      tab: page.tab,
      connected: true,
      since: m.clock.now(),
      workspace: { project_id: 'p1', plugin: 'ai-demo', plugin_name: 'Workspace demo', workspace: 'Counter', study_id: 's1' },
      tools: ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__reset', 'ai-demo__slow_add'],
      refused: r.json.refused,
      active_turns: 0,
      hold_until: null,
    });
    assert.equal(m.registry.workspaceOf(page.tab).guide, 'Counter notes.');
    const off = await s.register(link, 2, []);
    assert.deepEqual([off.status, off.json.accepted, off.json.refused], [200, [], []]);
    assert.deepEqual(await s.tabs(), []);
    assert.equal(m.registry.toolsFor(ctx(page.tab)).length, 0);
  });

  it('revs only go up: rev 2, then rev 1 is 409 stale_rev and rev 2 is kept; the same rev again (a re-POST) is taken', async () => {
    const { s } = await setup();
    const page = await s.page();
    const link = await page.open();
    const two = await s.register(link, 2, demoTools().slice(0, 2));
    assert.equal(two.status, 200);
    const one = await s.register(link, 1, demoTools());
    assert.deepEqual([one.status, one.json.code, one.json.rev], [409, 'stale_rev', 2]);
    assert.deepEqual((await s.tabs())[0].tools, ['ai-demo__add', 'ai-demo__get_count'], 'rev 2 kept');
    const oldWithdrawal = await s.register(link, 1, []);
    assert.deepEqual([oldWithdrawal.status, oldWithdrawal.json.code], [409, 'stale_rev']);
    assert.equal((await s.tabs()).length, 1, 'an older withdrawal changes nothing');
    const again = await s.register(link, 2, demoTools().slice(0, 3), { epoch: two.json.epoch });
    assert.equal(again.status, 200);
    assert.deepEqual((await s.tabs())[0].tools, ['ai-demo__add', 'ai-demo__get_count', 'ai-demo__slow_add']);
  });

  it('a tool of an earlier registration never runs once the same link registered another: unavailable, nothing sent to the page, no question asked', async () => {
    const { m, s } = await setup();
    const page = await s.page();
    const link = await page.open();
    assert.equal((await s.register(link, 1)).status, 200);
    // A step was offered rev 1's tools (project p1; add is an edit, asked nothing).
    const offered = new Map(m.registry.toolsFor(ctx(page.tab)).map((d) => [d.name, d]));
    const old = offered.get('ai-demo__add');
    assert.equal(old.risk, 'edit');
    // The same link registers another workspace: another project, and its add can't be undone.
    const other = demoTools().map((t) => (t.name === 'add' ? { ...t, risk: 'destructive' } : t));
    const two = await s.register(link, 2, other, { workspace: { ...DEMO_WORKSPACE, project_id: 'p2', workspace: 'Other counter' } });
    assert.equal(two.status, 200);
    assert.notEqual(old.available(ctx(page.tab)), true, "rev 1's tool is no longer available");
    const run = await s.handle.turns.runner.run(
      { type: 'tool_call', callId: 'k1', name: 'ai-demo__add', input: { by: 1 } },
      { owner: { kind: 'turn', id: 't-x', tab: page.tab }, ctx: ctx(page.tab), signal: new AbortController().signal, offered },
    );
    assert.deepEqual([run.ok, run.code], [false, 'unavailable']);
    const direct = await runTool(old, { by: 1 }, ctx(page.tab)).promise;
    assert.deepEqual([direct.ok, direct.error.code], [false, 'unavailable']);
    assert.deepEqual(page.of('invoke'), [], 'nothing reached the page');
    assert.deepEqual([page.of('gate'), s.handle.turns.gates.pendingForTab(page.tab)], [[], []], 'no question asked');
    // Rev 2's own tools are the ones offered now (its project's).
    const p2 = { ...ctx(page.tab), projectId: 'p2' };
    assert.equal(m.registry.toolsFor(p2).find((t) => t.name === 'ai-demo__add').risk, 'destructive');
    assert.deepEqual(m.registry.toolsFor(ctx(page.tab)), []);
  });
});

describe('a call', { timeout: 30_000 }, () => {
  it('invoke → ack → progress → result, in a turn bound to the tab: `active` while it runs, the result reaches the next request, a second answer is stale', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    m.provider.script({ tools: [{ name: 'ai-demo__add', input: { by: 2 } }] }, { text: 'Done.' });
    const started = await s.post('/api/assistant/turns', { text: 'Add 2', tab: page.tab });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    const t = s.handle.turns.get(started.json.turn);
    assert.deepEqual(await page.frame('active', 1), { turns: 1, hold_until: null });
    const inv = await page.frame('invoke', 0);
    assert.match(inv.call, /^rc-[0-9a-z]+-[0-9a-f]{6}$/);
    assert.deepEqual({ ...inv, call: null }, { call: null, turn: t.id, tool: 'add', input: { by: 2 }, timeout_s: 60 });
    assert.deepEqual((await s.progress(link, inv.call, { ack: true })).json, { ok: true });
    assert.deepEqual((await s.progress(link, inv.call, { fraction: 2, label: 'Adding\u0007' })).json, { ok: true });
    assert.ok(eventsOf(t).some((e) => e.type === 'tool_progress' && e.fraction === 1 && e.label === 'Adding'), 'clamped and cleaned');
    assert.deepEqual((await s.result(link, inv.call, { ok: true, result: { text: 'Now 2', data: { count: 2 } } })).json, { ok: true });
    await settled(t);
    assert.equal(t.state, 'done');
    const part = m.provider.requests[1].req.messages.at(-1).parts.find((p) => p.type === 'tool_result');
    assert.deepEqual(JSON.parse(part.text), { tool: 'ai-demo__add', ok: true, data: { count: 2 }, text: 'Now 2' });
    assert.deepEqual((await s.result(link, inv.call, { ok: true })).json, { ok: true, stale: true });
    assert.deepEqual((await s.progress(link, inv.call, { ack: true })).json, { ok: true, stale: true });
    assert.deepEqual(await page.frame('active', 2), { turns: 0, hold_until: t.endedAt + ASSISTANT_HOLD_MS }, 'the hold after its last bound turn');
  });

  it('the page’s answer is checked: its error codes from the known lists, else failed; results capped as the bridge caps them', () => {
    assert.deepEqual(pageOutcome({ ok: false, error: { code: 'not_ready', message: 'Open a case first.' } }).error, { code: 'not_ready', message: 'Open a case first.' });
    assert.equal(pageOutcome({ ok: false, error: { code: 'plugin_off', message: 'x' } }).error.code, 'failed', 'a server code is not the page’s to give');
    assert.equal(pageOutcome({ ok: 'yes' }).error.code, 'bad_result');
    assert.equal(pageOutcome({ ok: true, result: 5 }).error.code, 'bad_result');
    assert.equal(pageOutcome({ ok: true, result: { text: 'x'.repeat(64 * 1024 + 1) } }).error.code, 'too_large');
    assert.equal(pageOutcome({ ok: true, result: { data: { s: 'x'.repeat(256 * 1024) } } }).error.code, 'too_large');
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    assert.equal(pageOutcome({ ok: true, result: { images: Array(5).fill({ mediaType: 'image/png', data: png }) } }).error.code, 'too_large');
    assert.equal(pageOutcome({ ok: true, result: { images: [{ mediaType: 'image/gif', data: png }] } }).error.code, 'bad_result');
    const img = pageOutcome({ ok: true, result: { images: [{ mediaType: 'image/png', data: png }] } });
    assert.deepEqual([img.ok, img.images[0].base64, img.summary], [true, png, 'Done (1 image)']);
    assert.deepEqual(pageOutcome({ ok: true, result: 'plain' }), { ok: true, text: 'plain', summary: 'Done' });
    assert.deepEqual(pageOutcome({ ok: true }), { ok: true, summary: 'Done' });
  });

  it('a stream dropped mid-call fails it at once (tab_disconnected), before any later event; the registration goes dormant', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const call = runTool(toolOf(m, page.tab, 'add'), { by: 1 }, ctx(page.tab));
    const inv = await page.frame('invoke');
    await s.progress(link, inv.call, { ack: true });
    const at = m.clock.now();
    const t0 = Date.now();
    page.serverDrop();
    const out = await call.promise;
    assert.ok(Date.now() - t0 < 2000, 'within the 2 s ceiling');
    assert.equal(m.clock.now(), at, 'no timer decided it');
    assert.deepEqual([out.ok, out.error.code], [false, 'tab_disconnected']);
    assert.match(out.error.message, DISCONNECTED);
    const [tab] = await s.tabs();
    assert.deepEqual([tab.connected, tab.since, tab.tools.length], [false, at, 4]);
    assert.equal(m.registry.toolsFor(ctx(page.tab)).length, 0, 'a dormant registration offers nothing');
    assert.equal((await s.result(link, inv.call, { ok: true })).status, 409, 'its link went with it');
  });

  it('send false (the stream ended, its cleanup not run yet): the call fails at once and never reached the page', async () => {
    const { m, s } = await setup();
    const { page } = await linkedPage(s);
    const add = toolOf(m, page.tab, 'add');
    hubTab(page.tab).res.destroy();
    // The hub hears the stream close only later: the relay's link is still open, and its send says false.
    const call = runTool(add, { by: 1 }, ctx(page.tab));
    const out = await call.promise;
    assert.deepEqual([out.error.code, out.error.message], ['tab_disconnected', "The page hosting Counter isn't connected, so the tool did not run."]);
    assert.deepEqual(page.of('invoke'), []);
  });

  it('no ack within the window: tab_disconnected (a half-open connection), and the link counts as silent (not connected: nothing offered or sent, a turn on it 409 tab_hidden, its questions not shown) until the page is heard on it again; an ack in time keeps the call going; a silent link that ends leaves the registration for the hold', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const add = toolOf(m, page.tab, 'add');
    const call = runTool(add, { by: 1 }, ctx(page.tab));
    const inv = await page.frame('invoke');
    m.clock.advance(RELAY_ACK_MS - 1);
    assert.equal(await settledNow(call.promise), false);
    m.clock.advance(1);
    const out = await call.promise;
    assert.deepEqual([out.error.code], ['tab_disconnected']);
    assert.match(out.error.message, DISCONNECTED);
    // Silent: no later call waits out the window again.
    const [quiet] = await s.tabs();
    assert.deepEqual([quiet.connected, quiet.since, quiet.tools.length], [false, m.clock.now(), 4]);
    assert.deepEqual(m.registry.toolsFor(ctx(page.tab)), [], 'offered to nobody');
    const again = await runTool(add, { by: 1 }, ctx(page.tab)).promise;
    assert.deepEqual([again.ok, again.error.code], [false, 'unavailable']);
    assert.equal(page.of('invoke').length, 1, 'nothing more was sent');
    const hidden = await s.post('/api/assistant/turns', { text: 'Again', tab: page.tab });
    assert.deepEqual([hidden.status, hidden.json.code], [409, 'tab_hidden']);
    const owner = { kind: 'turn', id: 't-x', tab: page.tab };
    assert.equal(s.relay.presenter.present({ id: 'g-1' }, owner), false, 'a question counts as not shown');
    // The page answers late (it was busy, not gone): heard on its link, it is connected again.
    m.clock.advance(5);
    assert.deepEqual((await s.result(link, inv.call, { ok: true })).json, { ok: true, stale: true });
    const [heard] = await s.tabs();
    assert.deepEqual([heard.connected, heard.since, heard.tools.length], [true, m.clock.now(), 4]);
    assert.equal(s.relay.presenter.present({ id: 'g-2' }, owner), true);
    const next = runTool(toolOf(m, page.tab, 'add'), { by: 1 }, ctx(page.tab));
    const inv2 = await page.frame('invoke', 1);
    await s.progress(link, inv2.call, { ack: true });
    m.clock.advance(RELAY_ACK_MS * 3);
    assert.equal(await settledNow(next.promise), false, 'acknowledged: the ack window no longer applies');
    await s.result(link, inv2.call, { ok: true, result: 'added' });
    assert.deepEqual(await next.promise, { ok: true, text: 'added', summary: 'Done' });
    // Silent again, and then its stream ends: the registration stays for the hold, then goes.
    const last = runTool(toolOf(m, page.tab, 'add'), { by: 1 }, ctx(page.tab));
    await page.frame('invoke', 2);
    m.clock.advance(RELAY_ACK_MS);
    assert.equal((await last.promise).error.code, 'tab_disconnected');
    m.clock.advance(ASSISTANT_HOLD_MS);
    assert.equal((await s.tabs()).length, 1, 'kept while its link is open');
    page.serverDrop();
    await until(() => !hubTab(page.tab), 5000, 'the stream to end');
    m.clock.advance(ASSISTANT_HOLD_MS - 1);
    assert.equal((await s.tabs()).length, 1);
    m.clock.advance(1);
    assert.deepEqual(await s.tabs(), []);
  });

  it('tools [] while a call runs: its result still counts (the page’s own closed); with none, closed after the 2 s grace; a channel that ends after the withdrawal: closed at once', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const run = async (rev) => {
      assert.equal((await s.register(link, rev)).status, 200);
      const c = runTool(toolOf(m, page.tab, 'slow_add'), { by: 1 }, ctx(page.tab));
      const inv = await page.frame('invoke', page.of('invoke').length);
      await s.progress(link, inv.call, { ack: true });
      return { c, inv };
    };
    // 1. The result comes 100 ms after the withdrawal.
    const a = await run(2);
    assert.equal((await s.register(link, 3, [])).status, 200);
    assert.deepEqual(await s.tabs(), [], 'the tools are gone at once');
    m.clock.advance(100);
    assert.equal(await settledNow(a.c.promise), false);
    assert.deepEqual((await s.result(link, a.inv.call, { ok: false, error: { code: 'closed', message: 'its page closed before it finished' } })).json, { ok: true });
    const o1 = await a.c.promise;
    assert.deepEqual([o1.error.code, o1.error.message], ['closed', 'its page closed before it finished']);
    // 2. No result: closed after the grace.
    const b = await run(4);
    await s.register(link, 5, []);
    m.clock.advance(UNREGISTER_GRACE_MS - 1);
    assert.equal(await settledNow(b.c.promise), false);
    m.clock.advance(1);
    const o2 = await b.c.promise;
    assert.equal(o2.error.code, 'closed');
    assert.match(o2.error.message, /its page closed before the tool finished; it may or may not have finished/);
    // 3. The withdrawal, then the channel closes (the page's order when its result could not be sent): closed at once.
    const c = await run(6);
    await s.register(link, 7, []);
    await page.unsubscribe();
    const o3 = await c.c.promise;
    assert.equal(o3.error.code, 'closed');
  });

  it('one call at a time per tab (busy); tabs stay apart: another tab’s link answering is stale, and a turn bound to A reaches only A', async () => {
    const { m, s } = await setup();
    const A = await linkedPage(s);
    const B = await linkedPage(s);
    const a1 = runTool(toolOf(m, A.page.tab, 'add'), { by: 1 }, ctx(A.page.tab));
    const invA = await A.page.frame('invoke');
    const busy = await runTool(toolOf(m, A.page.tab, 'get_count'), {}, ctx(A.page.tab)).promise;
    assert.deepEqual([busy.error.code, busy.error.message], ['busy', 'Counter is already running a tool call; wait for its result, then call again.']);
    const b1 = runTool(toolOf(m, B.page.tab, 'get_count'), {}, ctx(B.page.tab));
    const invB = await B.page.frame('invoke');
    assert.deepEqual((await s.result(B.link, invA.call, { ok: true, result: 'from B' })).json, { ok: true, stale: true });
    assert.equal(await settledNow(a1.promise), false, "B's link can't answer A's call");
    await s.result(A.link, invA.call, { ok: true, result: 'A' });
    await s.result(B.link, invB.call, { ok: true, result: 'B' });
    assert.deepEqual([(await a1.promise).text, (await b1.promise).text], ['A', 'B']);
    // Each tab's context offers its own tools only.
    assert.ok(m.registry.toolsFor(ctx(A.page.tab)).every((t) => t.source.tab === A.page.tab));
    // A turn bound to A: the invoke reaches A, never B.
    m.provider.script({ tools: [{ name: 'ai-demo__get_count' }] }, { text: 'Done.' });
    const started = await s.post('/api/assistant/turns', { text: 'Count', tab: A.page.tab });
    const t = s.handle.turns.get(started.json.turn);
    const inv = await A.page.frame('invoke', 1);
    await s.result(A.link, inv.call, { ok: true, result: '3' });
    await settled(t);
    assert.equal(t.state, 'done');
    assert.equal(B.page.of('invoke').length, 1);
    assert.deepEqual(B.page.of('active'), [{ turns: 0, hold_until: null }], "B's page never heard of A's turn (only its own open's)");
  });

  it('a stall: the runner’s window (timeoutS + 10 s, reset by progress) sends abort {call}; the page’s last answer ends it as stalled', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const offered = new Map(m.registry.toolsFor(ctx(page.tab)).map((d) => [d.name, d]));
    const ac = new AbortController();
    const run = s.handle.turns.runner.run(
      { type: 'tool_call', callId: 'k1', name: 'ai-demo__slow_add', input: { by: 1 } },
      { owner: { kind: 'turn', id: 't-x', tab: page.tab }, ctx: ctx(page.tab), signal: ac.signal, offered },
    );
    const inv = await page.frame('invoke');
    assert.equal(inv.timeout_s, 30);
    await s.progress(link, inv.call, { ack: true });
    m.clock.advance(39_999);
    await s.progress(link, inv.call, { fraction: 0.1, label: 'Step 1' });
    m.clock.advance(39_999);
    assert.deepEqual(page.of('abort'), [], 'progress restarted the window');
    m.clock.advance(1);
    assert.deepEqual(await page.frame('abort'), { call: inv.call });
    assert.deepEqual((await s.result(link, inv.call, { ok: false, error: { code: 'aborted', message: 'stopped' } })).json, { ok: true });
    const out = await run;
    assert.equal(out.code, 'stalled');
    assert.deepEqual((await s.result(link, inv.call, { ok: true })).json, { ok: true, stale: true });
  });

  it('Stop: abort {call} goes to the page; its last answer within 2 s ends the call, else the tab is free after 2 s', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const offered = new Map(m.registry.toolsFor(ctx(page.tab)).map((d) => [d.name, d]));
    const start = (id) => {
      const ac = new AbortController();
      const done = s.handle.turns.runner.run(
        { type: 'tool_call', callId: id, name: 'ai-demo__slow_add', input: { by: 1 } },
        { owner: { kind: 'turn', id: 't-x', tab: page.tab }, ctx: ctx(page.tab), signal: ac.signal, offered },
      );
      return { ac, done };
    };
    const one = start('k1');
    const inv = await page.frame('invoke');
    await s.progress(link, inv.call, { ack: true });
    one.ac.abort({ code: 'stopped' });
    assert.deepEqual(await page.frame('abort'), { call: inv.call });
    await s.result(link, inv.call, { ok: false, error: { code: 'aborted', message: 'stopped' } });
    assert.equal((await one.done).code, 'stopped');
    const two = start('k2');
    const inv2 = await page.frame('invoke', 1);
    await s.progress(link, inv2.call, { ack: true });
    two.ac.abort({ code: 'stopped' });
    await page.frame('abort', 1);
    m.clock.advance(ABORT_GRACE_MS);
    assert.equal((await two.done).code, 'stopped');
    const three = runTool(toolOf(m, page.tab, 'get_count'), {}, ctx(page.tab));
    const inv3 = await page.frame('invoke', 2);
    assert.notEqual(inv3.call, inv2.call, 'not busy: the silent call was let go');
    await s.result(link, inv3.call, { ok: true, result: '1' });
    assert.equal((await three.promise).ok, true);
  });

  it('the runner gives up on a page that gave no last answer (a stall, or Stop): the tab is free at once for the next call, which the loop starts as soon as the first one’s result is in', async () => {
    const { m, s } = await setup();
    const { page, link } = await linkedPage(s);
    const offered = new Map(m.registry.toolsFor(ctx(page.tab)).map((d) => [d.name, d]));
    const run = (id, name, signal) =>
      s.handle.turns.runner.run({ type: 'tool_call', callId: id, name, input: name === 'ai-demo__get_count' ? {} : { by: 1 } }, { owner: { kind: 'turn', id: 't-x', tab: page.tab }, ctx: ctx(page.tab), signal, offered });
    for (const [n, why] of [
      [0, { code: 'stalled' }],
      [1, { code: 'stopped' }],
    ]) {
      const ac = new AbortController();
      const first = run(`k${n}a`, 'ai-demo__slow_add', ac.signal);
      const inv = await page.frame('invoke', 2 * n);
      await s.progress(link, inv.call, { ack: true });
      // The next call of the step, started from the first one's result with only promise callbacks between.
      let second = null;
      const next = first.then(() => run(`k${n}b`, 'ai-demo__get_count', new AbortController().signal)).then((r) => (second = r));
      ac.abort(why);
      await page.frame('abort', n);
      // Node runs promise callbacks between two timers that fall due together.
      await m.clock.advanceAsync(ABORT_GRACE_MS);
      assert.equal((await first).code, why.code);
      await until(() => second || page.of('invoke')[2 * n + 1], 5000, 'the next call to end or reach the page');
      assert.equal(second, null, `not refused: ${second && second.summary}`);
      const inv2 = page.of('invoke')[2 * n + 1];
      assert.equal(inv2.tool, 'get_count');
      await s.result(link, inv2.call, { ok: true, result: '1' });
      await next;
      assert.deepEqual([second.ok, second.code], [true, null]);
    }
  });
});

describe('the hold and dormant registrations', { timeout: 30_000 }, () => {
  it('after a bound turn ends `active` carries hold_until; a dropped link leaves the registration dormant for the hold (a turn on it: 409 tab_hidden); the same tab linking again registers again; past the hold it is gone (400 bad_tab)', async () => {
    const { m, s } = await setup();
    const first = await linkedPage(s);
    const tab = first.page.tab;
    m.provider.script({ text: 'Hello.' });
    const st = await s.post('/api/assistant/turns', { text: 'Hi', tab });
    assert.equal(st.status, 202);
    const t = s.handle.turns.get(st.json.turn);
    await settled(t);
    const holdUntil = t.endedAt + ASSISTANT_HOLD_MS;
    await first.page.frame('active', 2);
    assert.deepEqual(first.page.of('active'), [
      { turns: 0, hold_until: null },
      { turns: 1, hold_until: null },
      { turns: 0, hold_until: holdUntil },
    ]);
    assert.equal((await s.tabs())[0].hold_until, holdUntil);
    // The link drops (a covered window's stream let go, a lost connection).
    first.page.serverDrop();
    await until(async () => (await s.tabs())[0]?.connected === false, 5000, 'the dormant registration');
    m.clock.advance(60_000);
    const hidden = await s.post('/api/assistant/turns', { text: 'Again', tab });
    assert.deepEqual([hidden.status, hidden.json.code, hidden.json.error], [409, 'tab_hidden', TAB_HIDDEN_TEXT]);
    // The same tab comes back: a new link, the hold told again, then its re-POST (same rev, its pinned epoch).
    const page = await s.page(tab);
    const link = await page.open();
    assert.notEqual(link, first.link);
    assert.deepEqual(page.frames.filter((f) => f.c === 'assistant:1').map((f) => f.event).slice(0, 2), ['linked', 'active']);
    assert.deepEqual(page.of('active'), [{ turns: 0, hold_until: holdUntil }]);
    const again = await s.register(link, 1, demoTools(), { epoch: first.reg.epoch });
    assert.deepEqual([again.status, again.json.epoch], [200, first.reg.epoch]);
    const [back] = await s.tabs();
    assert.deepEqual([back.connected, back.since, back.tools.length], [true, m.clock.now(), 4]);
    // Dropped again; the hold time passes: gone.
    page.serverDrop();
    await until(async () => (await s.tabs())[0]?.connected === false, 5000, 'dormant again');
    m.clock.advance(ASSISTANT_HOLD_MS - 1);
    assert.equal((await s.tabs()).length, 1);
    m.clock.advance(1);
    assert.deepEqual(await s.tabs(), []);
    const gone = await s.post('/api/assistant/turns', { text: 'Again', tab });
    assert.deepEqual([gone.status, gone.json.code], [400, 'bad_tab']);
  });

  it('`active` is always a channel’s second frame, none running and no hold too: a page that last heard of a bound turn learns, after a drop longer than the hold, that none run', async () => {
    const { m, s } = await setup();
    const first = await linkedPage(s);
    const tab = first.page.tab;
    const events = (p) => p.frames.filter((f) => f.c === 'assistant:1').map((f) => f.event);
    assert.deepEqual(events(first.page).slice(0, 2), ['linked', 'active']);
    assert.deepEqual(first.page.of('active'), [{ turns: 0, hold_until: null }]);
    m.provider.script({ tools: [{ name: 'ai-demo__add', input: { by: 1 } }] }, { text: 'Done.' });
    const st = await s.post('/api/assistant/turns', { text: 'Add', tab });
    assert.equal(st.status, 202);
    const t = s.handle.turns.get(st.json.turn);
    assert.deepEqual(await first.page.frame('active', 1), { turns: 1, hold_until: null }, 'the page pins its channel');
    await first.page.frame('invoke');
    // The link drops while the turn runs; the turn ends unheard, and the hold passes.
    first.page.serverDrop();
    await settled(t);
    assert.equal(first.page.of('active').length, 2, 'the end never reached that page');
    m.clock.advance(ASSISTANT_HOLD_MS + 1);
    const page = await s.page(tab);
    await page.open();
    await page.frame('active', 0, 'assistant:1', 2000);
    assert.deepEqual(events(page).slice(0, 2), ['linked', 'active']);
    assert.deepEqual(page.of('active'), [{ turns: 0, hold_until: null }], 'none run, no hold: the page lets its channel go');
  });

  it('the hold and ack test switches: honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home, as whole milliseconds', () => {
    const home = { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h') };
    const sw = { MAGNUSIM_TEST_ASSISTANT_HOLD_MS: '2000', MAGNUSIM_TEST_ASSISTANT_ACK_MS: '500' };
    assert.deepEqual(resolveRelaySwitches({ ...home, ...sw, MAGNUSIM_TEST_ASSISTANT: '1' }), { holdMs: 2000, ackMs: 500, ignored: [] });
    const off = resolveRelaySwitches({ ...home, ...sw });
    assert.deepEqual([off.holdMs, off.ackMs, off.ignored.length], [null, null, 2]);
    const real = resolveRelaySwitches({ ...sw, MAGNUSIM_TEST_ASSISTANT: '1' });
    assert.deepEqual([real.holdMs, real.ackMs], [null, null], 'not in this PC’s real home');
    for (const v of ['0', '1.5', 'abc', '3600001', '-5']) {
      assert.equal(resolveRelaySwitches({ ...home, MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_HOLD_MS: v }).holdMs, null, v);
    }
    assert.deepEqual(resolveRelaySwitches({ ...home, MAGNUSIM_TEST_ASSISTANT: '1' }), { holdMs: null, ackMs: null, ignored: [] });
  });

  it('the server stopping: a call still out fails, and no channel opens any more', async () => {
    const { m, s } = await setup();
    const { page } = await linkedPage(s);
    const call = runTool(toolOf(m, page.tab, 'add'), { by: 1 }, ctx(page.tab));
    await page.frame('invoke');
    s.relay.shutdown();
    assert.equal((await call.promise).error.code, 'tab_disconnected');
    const r = await page.subscribe('assistant:2');
    assert.deepEqual([r.ok, r.status], [false, 503]);
  });
});
