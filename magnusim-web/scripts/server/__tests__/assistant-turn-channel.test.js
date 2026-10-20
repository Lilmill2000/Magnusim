// A window follows a turn on its event stream (phase 4 spec 5.1, 9.2): the hub channel kind
// `assistant` with {role:'turn', turn, since}. The snapshot from `since`, in frames of 500;
// streamed text merged over the 100 ms flush; `summary` when the turn's page would hear it
// changed, and once after its end, then done; a send that can't arrive ends the loop; this PC
// only, and at most 8 per tab; two windows on one turn each get every event; and through the
// real hub and relay. A fake clock drives the flush and the once-a-second rule; nothing sleeps.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-turn-channel-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { makeManager, relayServer, startTurn, settled, until, tick } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { openTurnChannel, turnChannelsOpen, TURN_CHANNEL, NO_TURN_TEXT } = await import('../assistant/turn-channel.ts');
const { REMOTE_MESSAGE } = await import('../assistant/access.ts');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  resetAssistantState();
});
after(() => {
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

const LOCAL = { headers: { host: '127.0.0.1:8082' }, socket: { remoteAddress: '127.0.0.1' } };
const REMOTE = { headers: { host: '127.0.0.1:8082', 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
let cids = 0;

/** A channel as the hub opens one: frames kept, done() ending it, cleanup once. */
function channel(m, params, { tab = 'tab-a', streamReq = LOCAL, req = LOCAL } = {}) {
  const ch = { frames: [], closed: false, sendOk: true, cleanups: 0 };
  let cleanup = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    ch.closed = true;
    if (cleanup) {
      ch.cleanups += 1;
      cleanup();
    }
  };
  const send = (event, d) => {
    if (ended || !ch.sendOk) return false;
    ch.frames.push({ event, d: structuredClone(d) });
    return true;
  };
  const meta = Object.freeze({ tab, conn: 'conn-1', cid: `assistant:${++cids}`, local: true, streamReq, req });
  ch.result = openTurnChannel(m.manager, params, send, end, meta);
  if (ch.result.ok) {
    cleanup = ch.result.cleanup;
    if (ended) {
      ch.cleanups += 1;
      cleanup();
    }
  }
  ch.close = end;
  ch.of = (event) => ch.frames.filter((f) => f.event === event).map((f) => f.d);
  /** Every event the channel carried, in order. */
  ch.events = () => ch.frames.flatMap((f) => (f.event === 'snapshot' || f.event === 'events' ? f.d.events : []));
  cleanups.push(() => end());
  return ch;
}

/** A turn held at its first request until Stop. */
async function heldTurn(m, text = 'Build a bracket') {
  m.provider.script({ hold: 'h' });
  const r = await startTurn(m, text);
  await m.provider.reached('h');
  cleanups.push(async () => {
    r.turn.stop();
    await settled(r.turn);
  });
  return r.turn;
}

/** Lets the channel's loop run: its wake, then the flush on the fake clock. */
async function flush(m) {
  await tick();
  m.clock.advance(TURN_CHANNEL.flushMs);
  await tick();
}

const mk = () => makeManager({ dir: ROOT });

describe('the turn channel', () => {
  it('the snapshot: the summary with its prompt and text so far, the events after since, next and ended', async () => {
    const m = mk();
    const t = await heldTurn(m, 'Build a bracket\nwith two holes');
    t.onStream(1, { kind: 'text', text: 'Sketching.' });
    t.note('one');
    const seqs = t.eventsSince(0).map((e) => e.seq);
    const ch = channel(m, { role: 'turn', turn: t.id, since: String(seqs[1]) });
    assert.equal(ch.result.ok, true);
    const [snap] = ch.of('snapshot');
    assert.deepEqual(
      [snap.turn.id, snap.turn.prompt, snap.turn.title, snap.turn.text_so_far, snap.ended, snap.more],
      [t.id, 'Build a bracket\nwith two holes', 'Build a bracket', 'Sketching.', false, false],
    );
    assert.deepEqual(
      snap.events.map((e) => e.seq),
      seqs.slice(2),
    );
    assert.equal(snap.next, seqs.at(-1));
    assert.equal(ch.frames.length, 1, 'nothing else yet');
  });

  it('1,200 events go as frames of 500, 500 and 200, the snapshot saying more', async () => {
    const m = mk();
    const t = await heldTurn(m);
    while (t.lastSeq() < 1200) t.note(`n${t.lastSeq()}`);
    const ch = channel(m, { role: 'turn', turn: t.id, since: 0 });
    assert.deepEqual(
      ch.frames.map((f) => [f.event, f.d.events.length, f.d.next]),
      [
        ['snapshot', 500, 500],
        ['events', 500, 1000],
        ['events', 200, 1200],
      ],
    );
    assert.equal(ch.of('snapshot')[0].more, true);
    assert.deepEqual(
      ch.events().map((e) => e.seq),
      Array.from({ length: 1200 }, (_, i) => i + 1),
    );
  });

  it('100 text chunks within 100 ms arrive as at most 3 frames, the text merged', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const ch = channel(m, { role: 'turn', turn: t.id, since: t.lastSeq() });
    for (let i = 0; i < 100; i += 1) {
      t.onStream(1, { kind: 'text', text: `${i % 10}` });
      m.clock.advance(1);
      await tick();
    }
    await flush(m);
    const frames = ch.of('events');
    assert.ok(frames.length >= 1 && frames.length <= 3, `${frames.length} frames`);
    const texts = frames.flatMap((f) => f.events).filter((e) => e.type === 'text');
    assert.ok(texts.length <= 3, `${texts.length} text events`);
    assert.equal(texts.map((e) => e.text).join(''), '0123456789'.repeat(10));
  });

  it('`summary` as the page hears the turn change, at most once a second, without text_so_far and prompt', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const ch = channel(m, { role: 'turn', turn: t.id, since: t.lastSeq() });
    for (let i = 1; i <= 5; i += 1) t.setModelFacts({ contextTokens: 1000 * i });
    assert.equal(ch.of('summary').length, 1, 'the first change at once');
    m.clock.advance(999);
    assert.equal(ch.of('summary').length, 1, 'the rest wait for the second');
    m.clock.advance(1);
    assert.equal(ch.of('summary').length, 2);
    const [s] = ch.of('summary');
    assert.equal('text_so_far' in s.turn || 'prompt' in s.turn, false);
    assert.equal(s.turn.id, t.id);
    assert.ok('used' in s.turn && 'title' in s.turn);
  });

  it('the end: its events, then a last summary, then done (the hub ends the channel); an ended turn closes at once after its snapshot', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const ch = channel(m, { role: 'turn', turn: t.id, since: t.lastSeq() });
    t.stop();
    await settled(t);
    await until(() => ch.closed, 2000, 'the channel to be done');
    assert.deepEqual(ch.frames.map((f) => f.event).slice(-2), ['events', 'summary']);
    assert.equal(ch.events().at(-1).type, 'end');
    assert.equal(ch.of('summary').at(-1).turn.state, 'stopped');
    assert.equal(ch.cleanups, 1);
    assert.equal(turnChannelsOpen()['tab-a'], undefined, 'its place is free');
    const late = channel(m, { role: 'turn', turn: t.id, since: '0' });
    assert.equal(late.closed, true, 'closed in the subscribe itself');
    assert.deepEqual(late.frames.map((f) => f.event), ['snapshot', 'summary']);
    assert.equal(late.of('snapshot')[0].ended, true);
    assert.equal(late.events().at(-1).type, 'end');
    assert.equal(late.cleanups, 1);
  });

  it('a send that answers false ends the loop: nothing more is sent, its place is free', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const ch = channel(m, { role: 'turn', turn: t.id, since: t.lastSeq() });
    assert.equal(turnChannelsOpen()['tab-a'], 1);
    ch.sendOk = false;
    t.note('lost');
    await flush(m);
    assert.equal(turnChannelsOpen()['tab-a'], undefined);
    ch.sendOk = true;
    t.note('after');
    await flush(m);
    assert.deepEqual(ch.of('events'), []);
  });

  it('refused: 403 remote (the stream or the subscribe), 400 a bad turn id or since, 404 an unknown turn, 429 the ninth of a tab', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const refusal = (ch) => (ch.result.ok ? 'ok' : [ch.result.status, ch.result.error]);
    assert.deepEqual(refusal(channel(m, { role: 'turn', turn: t.id }, { streamReq: REMOTE })), [403, REMOTE_MESSAGE]);
    assert.deepEqual(refusal(channel(m, { role: 'turn', turn: t.id }, { req: REMOTE })), [403, REMOTE_MESSAGE]);
    for (const since of ['x', -1, 1.5, '1.5', '-1', {}, '1e3']) assert.equal(refusal(channel(m, { role: 'turn', turn: t.id, since }))[0], 400, JSON.stringify(since));
    for (const turn of [undefined, '', 'a b', 'x'.repeat(129), 7]) assert.equal(refusal(channel(m, { role: 'turn', turn }))[0], 400, JSON.stringify(turn));
    assert.deepEqual(refusal(channel(m, { role: 'turn', turn: 't-nope-00000000' })), [404, NO_TURN_TEXT]);
    const eight = Array.from({ length: TURN_CHANNEL.perTab }, () => channel(m, { role: 'turn', turn: t.id }));
    assert.ok(eight.every((ch) => ch.result.ok));
    assert.equal(refusal(channel(m, { role: 'turn', turn: t.id }))[0], 429, 'the ninth of the tab');
    assert.equal(refusal(channel(m, { role: 'turn', turn: t.id }, { tab: 'tab-b' })), 'ok', 'another tab has its own eight');
    eight[0].close();
    assert.equal(refusal(channel(m, { role: 'turn', turn: t.id })), 'ok', 'one closed: room again');
  });

  it('two windows on one turn each get every event', async () => {
    const m = mk();
    const t = await heldTurn(m);
    const a = channel(m, { role: 'turn', turn: t.id, since: 0 });
    const b = channel(m, { role: 'turn', turn: t.id, since: 0 }, { tab: 'tab-b' });
    t.note('one');
    t.onStream(1, { kind: 'text', text: 'Hello' });
    await flush(m);
    t.note('two');
    await flush(m);
    t.stop();
    await settled(t);
    await until(() => a.closed && b.closed, 2000, 'both done');
    const all = t.eventsSince(0).map((e) => [e.seq, e.type]);
    assert.deepEqual(a.events().map((e) => [e.seq, e.type]), all);
    assert.deepEqual(b.events().map((e) => [e.seq, e.type]), all);
  });

  it("a review round reaches the window as {type:'review', round, of} (the dock's turnView reads that shape)", async () => {
    const m = mk();
    const t = await heldTurn(m);
    const ch = channel(m, { role: 'turn', turn: t.id, since: t.lastSeq() });
    t.setReview(1, 3);
    await flush(m);
    t.setReview(2, 3);
    await flush(m);
    const reviews = ch.events().filter((e) => e.type === 'review');
    assert.deepEqual(
      reviews.map(({ seq, at, ...rest }) => (assert.equal(typeof seq, 'number'), assert.equal(typeof at, 'number'), rest)),
      [
        { type: 'review', round: 1, of: 3 },
        { type: 'review', round: 2, of: 3 },
      ],
    );
  });

  it("a request's own pictures are on its snapshot's summary (prompt_images p1..), for the window's transcript", async () => {
    const m = mk();
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    m.provider.script({ hold: 'h' });
    const r = await startTurn(m, { text: 'Like this', images: [{ media_type: 'image/png', data: PNG }] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const t = r.turn;
    await m.provider.reached('h');
    cleanups.push(async () => {
      t.stop();
      await settled(t);
    });
    const ch = channel(m, { role: 'turn', turn: t.id, since: 0 });
    const [snap] = ch.of('snapshot');
    assert.deepEqual(snap.turn.prompt_images, [{ n: 'p1', media_type: 'image/png', width: 1, height: 1 }]);
  });

  it('through the hub and the relay: role turn on the `assistant` kind, for this PC only; another role 400', async () => {
    const m = mk();
    const s = await relayServer(m);
    cleanups.push(() => s.close());
    const t = await heldTurn(m);
    const page = await s.page();
    const r = await page.subscribe('assistant:7', { role: 'turn', turn: t.id, since: '0' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const snap = await page.frame('snapshot', 0, 'assistant:7');
    assert.equal(snap.turn.id, t.id);
    t.note('heard');
    const ev = await until(
      () => {
        m.clock.advance(TURN_CHANNEL.flushMs);
        return page.of('events', 'assistant:7').flatMap((f) => f.events).find((e) => e.type === 'note');
      },
      2000,
      'the note',
    );
    assert.equal(ev.text, 'heard');
    assert.deepEqual([(await page.subscribe('assistant:8', { role: 'nope' })).status], [400]);
    const remote = await s.page(undefined, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    if (remote.conn) assert.equal((await remote.subscribe('assistant:1', { role: 'turn', turn: t.id }, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
    page.close();
    remote.close();
  });
});
