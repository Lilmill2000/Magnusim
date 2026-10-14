// One event stream per tab (scripts/server/event-hub.ts): the browser opens at most 6
// connections to the app for all of its tabs, and one stream per linked geometry, per
// followed job and per plugin case stream filled them (the app froze). A tab's one stream
// carries channels it asks for: their snapshots are written before the subscribe answers,
// each channel is refused on its own as its old route refused it, a job that ended replays
// and ends its channel, and nothing is left listening once a channel or the stream ends.
// The real router and the channel kinds of link-routes.ts, plugin-cases.ts and routes.ts.
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
/** @type {http.Server} */
let server;
let base = '';

before(async () => {
  const router = new Router();
  registerEventHubRoutes(router);
  registerChannelKind('link', openLinkChannel);
  registerChannelKind('case', openCaseChannel);
  registerChannelKind('job', (params, send, done) => openJobChannel(jobs, params, send, done));
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
function openStream(tab) {
  const frames = [];
  let raw = '';
  let conn = '';
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get(`${base}/api/events?tab=${tab}`, (res) => {
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
    close: () => req.destroy(),
  };
}

async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
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
