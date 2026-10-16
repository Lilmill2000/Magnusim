// One event stream per tab (scripts/server/event-hub.ts): the browser opens at most 6
// connections to the app for all of its tabs, and one stream per linked geometry, per
// followed job and per plugin case stream filled them (the app froze). A tab's one stream
// carries channels it asks for: their snapshots are written before the subscribe answers,
// each channel is refused on its own as its old route refused it, a job that ended replays
// and ends its channel, and nothing is left listening once a channel or the stream ends.
// The real router and the channel kinds of link-routes.ts, plugin-cases.ts and routes.ts.
// A channel's open also learns whose it is (tab, conn, cid) and whether its stream and its
// subscribe both came from this PC; its send answers false only when a frame can never
// arrive; and a stream from elsewhere never takes a tab id a stream on this PC holds.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'magnusim-event-hub-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(root, 'projects');
mkdirSync(join(root, 'projects', 'p1'), { recursive: true });
mkdirSync(join(root, 'projects', 'p2'), { recursive: true });

const { Router, dispatch } = await import('../router.ts');
const { eventHubCounts, registerChannelKind, registerEventHubRoutes } = await import('../event-hub.ts');
const { openLinkChannel } = await import('../link-routes.ts');
const { openCaseChannel } = await import('../plugin-cases.ts');
const { openJobChannel } = await import('../routes.ts');
const { JobManager } = await import('../jobs.ts');
const { linkEventBus } = await import('../../link-store.js');
const { foamEventBus } = await import('../../foam-store.js');
const { gateClassOf } = await import('../link-gate.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new JobManager({ cacheDir: join(root, 'cache') });
/** Each channel of the test's own kind `probe`: what its open was given, and its cleanups. */
const probes = [];
const probeOf = (tab, cid) => probes.findLast((p) => p.meta?.tab === tab && p.meta?.cid === cid);
/** The server's own record of a tab's stream. */
const hubTab = (tab) => globalThis[Symbol.for('magnusim.eventHub')].tabs.get(tab);
/** Requests from elsewhere, as isLocalOperator sees them: a proxy, the tunnel, a public Host. */
const ELSEWHERE = [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { host: 'magnusim.example.org' }];
/** @type {http.Server} */
let server;
let base = '';

before(async () => {
  const router = new Router();
  registerEventHubRoutes(router);
  registerChannelKind('link', openLinkChannel);
  registerChannelKind('case', openCaseChannel);
  registerChannelKind('job', (params, send, done) => openJobChannel(jobs, params, send, done));
  registerChannelKind('probe', (params, send, done, meta) => {
    const p = { params, send, done, meta, cleaned: 0 };
    probes.push(p);
    return { ok: true, cleanup: () => void (p.cleaned += 1) };
  });
  server = await new Promise((done) => {
    const s = http.createServer(async (req, res) => {
      try {
        if (!(await dispatch(router, req, res))) {
          res.statusCode = 404;
          res.end('{}');
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    s.listen(0, '127.0.0.1', () => done(s));
  });
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

/** A tab's stream, read as it comes: its frames ({event, data}) and its `hello` conn. */
function openStream(tab, headers = {}) {
  const frames = [];
  let raw = '';
  let conn = '';
  let req;
  let incoming;
  const ready = new Promise((resolve, reject) => {
    req = http.get(`${base}/api/events?tab=${tab}`, { headers }, (res) => {
      incoming = res;
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`the stream was answered ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        let cut;
        while ((cut = raw.indexOf('\n\n')) >= 0) {
          const block = raw.slice(0, cut);
          raw = raw.slice(cut + 2);
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (!ev) {
            if (/^retry:/m.test(block)) frames.push({ event: 'retry', data: block.trim() });
            continue;
          }
          const parsed = data ? JSON.parse(data[1]) : null;
          frames.push({ event: ev[1], data: parsed });
          if (ev[1] === 'hello') {
            conn = parsed.conn;
            resolve();
          }
        }
      });
      res.on('error', () => undefined);
    });
    req.on('error', reject);
  });
  return {
    frames,
    ready,
    get conn() {
      return conn;
    },
    /** The frames of one channel: [event, payload]. */
    of: (cid) => frames.filter((f) => f.data && f.data.c === cid).map((f) => [f.event, f.data.d]),
    /** Stop reading it (the server's socket buffer fills), and read on. */
    pause: () => incoming.pause(),
    resume: () => incoming.resume(),
    close: () => req.destroy(),
  };
}

async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** A POST with its own headers (from elsewhere), as {status, body}. */
function postFrom(headers, path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** The status a GET /api/events with these headers is answered with (the request then goes). */
function streamStatus(tab, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events?tab=${tab}`, { headers }, (res) => {
      resolve(res.statusCode);
      req.destroy();
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
  });
}

/** Wait (a 5 s ceiling) for what a stream or the server does next. */
async function until(test, what) {
  const by = Date.now() + 5000;
  while (!test() && Date.now() < by) await sleep(10);
  assert.ok(test(), what);
}

let tabN = 0;
const newTab = () => `tab-${String(++tabN).padStart(4, '0')}-test`;
const link = (study, project = 'p1') => ({ kind: 'link', params: { project_id: project, plugin: 'link-demo', study_id: study } });

describe('one event stream per tab', () => {
  it('a subscribe before the stream, or for another stream, is refused as stale (409)', async () => {
    const tab = newTab();
    const early = await post('/api/events/subscribe', { tab, conn: 'x', channels: [{ cid: 'link:1', ...link('st-1') }] });
    assert.deepEqual([early.status, early.body.stale], [409, true]);
    const s = openStream(tab);
    await s.ready;
    const wrong = await post('/api/events/subscribe', { tab, conn: 'not-it', channels: [{ cid: 'link:1', ...link('st-1') }] });
    assert.equal(wrong.status, 409);
    assert.equal(s.frames[0].event, 'retry');
    assert.match(s.frames[0].data, /^retry: 1000$/);
    s.close();
  });

  it("writes a channel's snapshot before the subscribe answers, and refuses each bad channel on its own", async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    const ended = jobs.create('test-kind', { project_id: 'p2' }, 'p2');
    const r = await post('/api/events/subscribe', {
      tab,
      conn: s.conn,
      channels: [
        { cid: 'link:1', ...link('st-1') },
        { cid: 'link:2', kind: 'link', params: { project_id: 'p1', plugin: 'bad key!', study_id: 'st-1' } },
        { cid: 'link:3', kind: 'link', params: { plugin: 'link-demo', study_id: 'st-1' } },
        { cid: 'case:4', kind: 'case', params: { project_id: 'p1', plugin: 'link-demo', study_id: 'Bad Study' } },
        { cid: 'job:5', kind: 'job', params: { project_id: 'p1', job_id: 'job-none' } },
        { cid: 'job:6', kind: 'job', params: { project_id: 'p1', job_id: ended.id } },
        { cid: 'job:7', kind: 'job', params: { job_id: ended.id } },
        { cid: 'odd:8', kind: 'odd', params: {} },
        { cid: 'no cid', ...link('st-1') },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The snapshot came on the stream before this answer.
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(s.of('link:1'), [['snapshot', { jobs: [] }]]);
    const by = Object.fromEntries(r.body.results.map((x) => [x.cid, x]));
    assert.equal(by['link:1'].ok, true);
    assert.deepEqual([by['link:2'].ok, by['link:2'].status], [false, 400]);
    assert.deepEqual([by['link:3'].ok, by['link:3'].status], [false, 400]);
    assert.deepEqual([by['case:4'].ok, by['case:4'].status], [false, 400]);
    assert.deepEqual([by['job:5'].ok, by['job:5'].status, by['job:5'].error], [false, 404, 'job not found']);
    assert.deepEqual([by['job:6'].ok, by['job:6'].status, by['job:6'].error], [false, 403, 'job belongs to another project']);
    assert.deepEqual([by['job:7'].ok, by['job:7'].status], [false, 400]);
    assert.deepEqual([by['odd:8'].ok, by['odd:8'].status], [false, 400]);
    assert.deepEqual([by['no cid'].ok, by['no cid'].status], [false, 400]);
    assert.equal(eventHubCounts().channels >= 1, true);
    s.close();
  });

  it("forwards a study's link and case events to its channel only", async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    const r = await post('/api/events/subscribe', {
      tab,
      conn: s.conn,
      channels: [
        { cid: 'link:1', ...link('st-1') },
        { cid: 'link:2', ...link('st-2') },
        { cid: 'case:3', kind: 'case', params: { project_id: 'p1', plugin: 'link-demo', study_id: 'st-1' } },
      ],
    });
    assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
    linkEventBus().emit('event', { job_id: 'gl-1', seq: 4, ev: { event: 'stage', stage: 'plan' }, project_id: 'p1', plugin: 'link-demo', study_id: 'st-1' });
    linkEventBus().emit('event', { job_id: 'gl-2', seq: 1, ev: { event: 'start' }, project_id: 'p2', plugin: 'link-demo', study_id: 'st-1' });
    foamEventBus().emit('event', { job_id: 'fj-1', seq: 2, ev: { event: 'start' }, project_id: 'p1', plugin: 'link-demo', study_id: 'st-1', kind: 'foam' });
    await sleep(100);
    assert.deepEqual(s.of('link:1').slice(1), [['link', { job_id: 'gl-1', seq: 4, ev: { event: 'stage', stage: 'plan' } }]]);
    assert.deepEqual(s.of('link:2').slice(1), []);
    assert.deepEqual(s.of('case:3')[0][0], 'snapshot');
    assert.deepEqual(s.of('case:3').slice(1), [['case', { job_id: 'fj-1', seq: 2, ev: { event: 'start' } }]]);
    s.close();
  });

  it('a job that ended replays its snapshot and events, then end, then _closed; a running one ends the same way', async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    const done = jobs.create('test-kind', { project_id: 'p1' }, 'p1');
    jobs.attachChild(done.id, { pid: null });
    jobs.pushEvent(done.id, { event: 'stage', stage: 'one' });
    jobs.finish(done.id, 'failed', null, 'it broke');
    const running = jobs.create('test-kind', { project_id: 'p1' }, 'p1');
    jobs.attachChild(running.id, { pid: null });
    const r = await post('/api/events/subscribe', {
      tab,
      conn: s.conn,
      channels: [
        { cid: 'job:1', kind: 'job', params: { project_id: 'p1', job_id: done.id } },
        { cid: 'job:2', kind: 'job', params: { project_id: 'p1', job_id: running.id } },
      ],
    });
    assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
    await new Promise((d) => setImmediate(d));
    const replay = s.of('job:1');
    assert.deepEqual(
      replay.map(([e, d]) => (e === 'event' ? `event:${d.event}` : e)),
      ['snapshot', 'event:start', 'event:stage', 'event:error', 'end', '_closed'],
    );
    assert.equal(replay[4][1].status, 'failed');
    assert.equal(jobs.onEvents(done.id).listenerCount('event'), 0);
    // The running one: its events, then its end.
    jobs.pushEvent(running.id, { event: 'stage', stage: 'two' });
    jobs.finish(running.id, 'done', { ok: true });
    await sleep(50);
    assert.deepEqual(
      s.of('job:2').map(([e, d]) => (e === 'event' ? `event:${d.event}` : e)),
      ['snapshot', 'event:start', 'event:stage', 'event:result', 'end', '_closed'],
    );
    assert.equal(jobs.onEvents(running.id).listenerCount('event'), 0);
    assert.equal(jobs.onEvents(running.id).listenerCount('end'), 0);
    s.close();
  });

  it('unsubscribe ends a channel; a closed stream, or a new one of the same tab, leaves nothing listening', async () => {
    const before = { link: linkEventBus().listenerCount('event'), foam: foamEventBus().listenerCount('event') };
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    const running = jobs.create('test-kind', { project_id: 'p1' }, 'p1');
    jobs.attachChild(running.id, { pid: null });
    const sub = await post('/api/events/subscribe', {
      tab,
      conn: s.conn,
      channels: [
        { cid: 'link:1', ...link('st-1') },
        { cid: 'link:2', ...link('st-2') },
        { cid: 'case:3', kind: 'case', params: { project_id: 'p1', plugin: 'link-demo', study_id: 'st-1' } },
        { cid: 'job:4', kind: 'job', params: { project_id: 'p1', job_id: running.id } },
      ],
    });
    assert.ok(sub.body.results.every((x) => x.ok), JSON.stringify(sub.body));
    assert.equal(linkEventBus().listenerCount('event'), before.link + 2);
    assert.equal(foamEventBus().listenerCount('event'), before.foam + 1);
    assert.equal(jobs.onEvents(running.id).listenerCount('event'), 1);
    // Unsubscribe one: its events stop, the others go on.
    const un = await post('/api/events/unsubscribe', { tab, conn: s.conn, cids: ['link:1'] });
    assert.equal(un.status, 200);
    assert.equal(linkEventBus().listenerCount('event'), before.link + 1);
    linkEventBus().emit('event', { job_id: 'gl-9', seq: 1, ev: { event: 'start' }, project_id: 'p1', plugin: 'link-demo', study_id: 'st-1' });
    linkEventBus().emit('event', { job_id: 'gl-8', seq: 1, ev: { event: 'start' }, project_id: 'p1', plugin: 'link-demo', study_id: 'st-2' });
    await sleep(50);
    assert.equal(s.of('link:1').length, 1, 'only its snapshot');
    assert.equal(s.of('link:2').length, 2);
    // A second stream of the same tab replaces the first: its channels end.
    const again = openStream(tab);
    await again.ready;
    await sleep(50);
    assert.equal(linkEventBus().listenerCount('event'), before.link);
    assert.equal(foamEventBus().listenerCount('event'), before.foam);
    assert.equal(jobs.onEvents(running.id).listenerCount('event'), 0);
    assert.equal(jobs.onEvents(running.id).listenerCount('end'), 0);
    const stale = await post('/api/events/subscribe', { tab, conn: s.conn, channels: [{ cid: 'link:5', ...link('st-1') }] });
    assert.equal(stale.status, 409);
    // The new stream's channels end when it closes.
    const sub2 = await post('/api/events/subscribe', { tab, conn: again.conn, channels: [{ cid: 'link:6', ...link('st-1') }, { cid: 'job:7', kind: 'job', params: { project_id: 'p1', job_id: running.id } }] });
    assert.ok(sub2.body.results.every((x) => x.ok));
    assert.equal(linkEventBus().listenerCount('event'), before.link + 1);
    again.close();
    s.close();
    const by = Date.now() + 5000;
    while ((linkEventBus().listenerCount('event') !== before.link || eventHubCounts().tabs) && Date.now() < by) await sleep(20);
    assert.equal(linkEventBus().listenerCount('event'), before.link);
    assert.equal(jobs.onEvents(running.id).listenerCount('event'), 0);
    assert.deepEqual(eventHubCounts(), { tabs: 0, channels: 0 });
    jobs.finish(running.id, 'stopped');
  });

  it('a bad tab id is refused; the routes are reviewed by the gate census (not gated)', async () => {
    const r = await fetch(`${base}/api/events?tab=${encodeURIComponent('../x')}`);
    assert.equal(r.status, 400);
    for (const p of ['/api/events', '/api/events/subscribe', '/api/events/unsubscribe']) assert.equal(gateClassOf(p), 'reviewed', p);
  });
});

describe("what a channel knows: its tab, and whether it is this PC's", { timeout: 30_000 }, () => {
  const subscribe = (tab, conn, cids) => post('/api/events/subscribe', { tab, conn, channels: cids.map((cid) => ({ cid, kind: 'probe', params: { n: cid } })) });

  it('open gets meta {tab, conn, cid, local}: local for a stream and a subscribe from this PC', async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    const r = await subscribe(tab, s.conn, ['probe:1', 'probe:2']);
    assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
    const p = probeOf(tab, 'probe:2');
    assert.deepEqual({ ...p.meta }, { tab, conn: s.conn, cid: 'probe:2', local: true });
    assert.deepEqual(p.params, { n: 'probe:2' });
    assert.equal(Object.isFrozen(p.meta), true);
    assert.equal(probeOf(tab, 'probe:1').meta.cid, 'probe:1');
    s.close();
  });

  it('local is false when the stream, or only the subscribe, came through a proxy, the tunnel or a public Host; the existing kinds still open there', async () => {
    for (const from of ELSEWHERE) {
      const label = JSON.stringify(from);
      // A stream from elsewhere: no channel on it is local, even with a subscribe from this PC.
      const away = newTab();
      const s = openStream(away, from);
      await s.ready;
      const r = await post('/api/events/subscribe', {
        tab: away,
        conn: s.conn,
        channels: [
          { cid: 'probe:1', kind: 'probe', params: {} },
          { cid: 'link:2', ...link('st-1') },
        ],
      });
      assert.ok(r.body.results.every((x) => x.ok), `${label} ${JSON.stringify(r.body)}`);
      assert.equal(probeOf(away, 'probe:1').meta.local, false, label);
      await new Promise((d) => setImmediate(d));
      assert.deepEqual(s.of('link:2'), [['snapshot', { jobs: [] }]], label);
      // A stream from this PC with a subscribe from elsewhere: not local either.
      const here = newTab();
      const h = openStream(here);
      await h.ready;
      const r2 = await postFrom(from, '/api/events/subscribe', { tab: here, conn: h.conn, channels: [{ cid: 'probe:3', kind: 'probe', params: {} }] });
      assert.equal(r2.status, 200, label);
      assert.equal(probeOf(here, 'probe:3').meta.local, false, label);
      // The same stream, asked from this PC: local.
      await subscribe(here, h.conn, ['probe:4']);
      assert.equal(probeOf(here, 'probe:4').meta.local, true, label);
      s.close();
      h.close();
    }
  });

  it("a stream from elsewhere for a tab id this PC's stream holds gets 409 and that stream goes on; one from this PC still replaces it", async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    await subscribe(tab, s.conn, ['probe:1']);
    const p = probeOf(tab, 'probe:1');
    for (const from of ELSEWHERE) assert.equal(await streamStatus(tab, from), 409, JSON.stringify(from));
    // Nothing of this PC's stream ended: same stream, its channel sends, a subscribe on it works.
    assert.equal(hubTab(tab).conn, s.conn);
    assert.equal(p.cleaned, 0);
    assert.equal(p.send('ping', { n: 1 }), true);
    await until(() => s.of('probe:1').length === 1, 'the frame arrived');
    assert.deepEqual(s.of('probe:1'), [['ping', { n: 1 }]]);
    assert.equal((await subscribe(tab, s.conn, ['probe:2'])).status, 200);
    // A tab id a stream from elsewhere holds is replaced as before, from anywhere.
    const away = newTab();
    const a1 = openStream(away, ELSEWHERE[0]);
    await a1.ready;
    const a2 = openStream(away, ELSEWHERE[1]);
    await a2.ready;
    assert.equal(hubTab(away).conn, a2.conn);
    const a3 = openStream(away);
    await a3.ready;
    assert.equal(hubTab(away).conn, a3.conn);
    // Now this PC's: a stream from elsewhere is refused.
    assert.equal(await streamStatus(away, ELSEWHERE[0]), 409);
    // This PC's own second stream of the tab still replaces the first, and its channels end.
    const again = openStream(tab);
    await again.ready;
    assert.equal(hubTab(tab).conn, again.conn);
    assert.equal(p.cleaned, 1);
    for (const x of [s, again, a1, a2, a3]) x.close();
  });

  it('send answers false once its channel ended: unsubscribed, ended by the server, its stream replaced, closed or cut', async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    await subscribe(tab, s.conn, ['probe:1', 'probe:2', 'probe:3']);
    const [one, two, three] = ['probe:1', 'probe:2', 'probe:3'].map((cid) => probeOf(tab, cid));
    assert.deepEqual([one.send('a', 1), two.send('a', 2), three.send('a', 3)], [true, true, true]);
    // Unsubscribed.
    await post('/api/events/unsubscribe', { tab, conn: s.conn, cids: ['probe:1'] });
    assert.equal(one.cleaned, 1);
    assert.equal(one.send('b', 1), false);
    // Ended by the server (done): the page hears _closed, and nothing after it.
    two.done();
    assert.equal(two.send('b', 2), false);
    // The stream replaced by a new one of the same tab.
    const again = openStream(tab);
    await again.ready;
    assert.equal(three.cleaned, 1);
    assert.equal(three.send('b', 3), false);
    await sleep(50);
    assert.deepEqual(s.of('probe:1'), [['a', 1]]);
    assert.deepEqual(s.of('probe:2'), [['a', 2], ['_closed', undefined]]);
    assert.deepEqual(s.of('probe:3'), [['a', 3]]);
    // The stream closed by the page.
    await subscribe(tab, again.conn, ['probe:4']);
    const four = probeOf(tab, 'probe:4');
    assert.equal(four.send('a', 4), true);
    again.close();
    await until(() => four.cleaned === 1, 'the closed stream ended its channel');
    assert.equal(four.send('b', 4), false);
    // A stream cut on the server's side: false at once, before its close is heard.
    const tab2 = newTab();
    const c = openStream(tab2);
    await c.ready;
    await subscribe(tab2, c.conn, ['probe:5']);
    const five = probeOf(tab2, 'probe:5');
    hubTab(tab2).res.destroy();
    assert.equal(five.cleaned, 0);
    assert.equal(five.send('b', 5), false);
    s.close();
    c.close();
  });

  it('send of a 1 MB frame on a healthy stream answers true while the socket buffer is full (backpressure is not failure), and every frame arrives whole', async () => {
    const tab = newTab();
    const s = openStream(tab);
    await s.ready;
    await subscribe(tab, s.conn, ['probe:1']);
    const p = probeOf(tab, 'probe:1');
    s.pause();
    const big = 'x'.repeat(1024 * 1024);
    const res = hubTab(tab).res;
    let sent = 0;
    while (!res.writableNeedDrain && sent < 32) {
      assert.equal(p.send('big', { i: sent, big }), true, `frame ${sent}`);
      sent += 1;
    }
    assert.equal(res.writableNeedDrain, true, 'the socket buffer is full');
    assert.equal(p.send('small', { after: sent }), true);
    s.resume();
    await until(() => s.of('probe:1').length === sent + 1, 'every frame arrived');
    const got = s.of('probe:1');
    assert.deepEqual(
      got.map(([e, d]) => (e === 'big' ? `big:${d.i}:${d.big.length}` : `${e}:${d.after}`)),
      [...Array.from({ length: sent }, (_, i) => `big:${i}:${big.length}`), `small:${sent}`],
    );
    s.close();
  });
});
