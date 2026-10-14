/**
 * One event stream per tab, for everything the tab follows.
 *
 * The app is served over plain HTTP/1.1, where the browser opens at most 6 connections to
 * it for all of its tabs together, and an event stream holds its connection for as long as
 * it is open. One stream per linked geometry, per followed job and per plugin case stream
 * filled those 6 (two tabs on a project with three linked geometries did), and every other
 * request of every tab then waited for a connection that never freed. So a tab opens one
 * stream and asks for channels on it:
 *
 *   GET  /api/events?tab=<id>   (SSE) `retry: 1000`, then `hello {conn}`, a heartbeat every
 *        15 s, and each channel's frames as `event: <type>` with data {c: <cid>, d: <payload>}.
 *        A second stream of the same tab replaces the first (its channels end).
 *   POST /api/events/subscribe   {tab, conn, channels: [{cid, kind, params}]}
 *        200 {ok, results: [{cid, ok: true} | {cid, ok: false, status, error}]}; 409 {stale}
 *        when the tab has no stream or `conn` is not its stream's (the page waits for the
 *        next hello, which asks for every channel again). A channel's snapshot is written
 *        before this answers; a cid the tab already has is replaced.
 *   POST /api/events/unsubscribe {tab, conn, cids}: those channels end.
 *
 * A channel kind is registered by the module whose events it carries (registerChannelKind):
 * `link` (link-routes.ts), `case` (plugin-cases.ts) and `job` (routes.ts). Its open(params,
 * send, done) checks the params as its own route does and answers the refusal, or starts
 * sending and returns its cleanup; done() ends a channel from the server's side (a job that
 * ended), which the page hears as `_closed {c}`.
 *
 * The state is on globalThis, so a Vite re-import of this module shares it. Not gated
 * (link-gate.js): nothing here reads or writes a record itself.
 *
 * MAGNUSIM_TEST_EVENT_HUB=1 (read once, when this module loads) also registers, for the
 * browser tests (the server's own count of what each tab holds, not the browser's):
 *   GET  /api/test/event-hub   {ok, tabs: {<tab>: {channels, kinds: {<kind>: n}}}}: the streams
 *        open now and the channels each carries;
 *   POST /api/test/event-hub/drop {tab?}  {ok, dropped}: that tab's stream (every one, without
 *        a tab) is cut as a restart or a lost connection cuts it; its channels end, and the
 *        page's EventSource connects again.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Router } from './router.ts';
import { writeSse } from './jobs.ts';

export type ChannelSend = (event: string, payload: unknown) => void;
export type ChannelOpened = { ok: true; cleanup: () => void } | { ok: false; status: number; error: string };
export type ChannelOpen = (params: Record<string, unknown>, send: ChannelSend, done: () => void) => ChannelOpened;

interface Tab {
  res: ServerResponse;
  conn: string;
  /** What ends each channel (unsubscribe, a new stream, the stream closed), by cid. */
  channels: Map<string, () => void>;
  beat: ReturnType<typeof setInterval>;
}

interface HubState {
  tabs: Map<string, Tab>;
  kinds: Map<string, ChannelOpen>;
}

const TEST_ROUTES = process.env.MAGNUSIM_TEST_EVENT_HUB === '1';
const HEARTBEAT_MS = 15_000;
const TAB_RE = /^[A-Za-z0-9-]{8,64}$/;
const CID_RE = /^[a-z]{1,16}:[0-9]{1,12}$/;
/** At most this many channels in one subscribe call. */
const MAX_BATCH = 500;
const KEY = Symbol.for('magnusim.eventHub');

function hub(): HubState {
  const g = globalThis as unknown as Record<symbol, HubState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { tabs: new Map(), kinds: new Map() };
    g[KEY] = s;
  }
  return s;
}

/** The module that carries a kind of events says how a channel of it opens. */
export function registerChannelKind(kind: string, open: ChannelOpen): void {
  hub().kinds.set(kind, open);
}

function endChannels(tab: Tab): void {
  const ends = [...tab.channels.values()];
  tab.channels.clear();
  for (const end of ends) {
    try {
      end();
    } catch (e) {
      console.warn('[events] channel cleanup', e);
    }
  }
}

function dropTab(tabId: string, tab: Tab): void {
  clearInterval(tab.beat);
  endChannels(tab);
  const s = hub();
  if (s.tabs.get(tabId) === tab) s.tabs.delete(tabId);
}

/** Open one channel on a tab's stream; its result for the subscribe answer. */
function openChannel(tabId: string, tab: Tab, spec: Record<string, unknown>): Record<string, unknown> {
  const s = hub();
  const cid = String(spec.cid || '');
  if (!CID_RE.test(cid)) return { cid, ok: false, status: 400, error: 'invalid channel id' };
  const open = s.kinds.get(String(spec.kind || ''));
  if (!open) return { cid, ok: false, status: 400, error: 'unknown channel kind' };
  const params = spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? (spec.params as Record<string, unknown>) : {};
  const prev = tab.channels.get(cid);
  if (prev) {
    tab.channels.delete(cid);
    prev();
  }
  const live = () => s.tabs.get(tabId) === tab;
  let ended = false;
  let cleanup: (() => void) | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    cleanup?.();
  };
  const send: ChannelSend = (event, payload) => {
    if (!ended && live()) writeSse(tab.res, event, { c: cid, d: payload });
  };
  // The server ends it (a job that ended): the page hears `_closed`.
  const done = () => {
    if (ended) return;
    if (tab.channels.get(cid) === end) tab.channels.delete(cid);
    end();
    if (live()) writeSse(tab.res, '_closed', { c: cid });
  };
  let out: ChannelOpened;
  try {
    out = open(params, send, done);
  } catch (e) {
    console.warn('[events] channel open', e);
    out = { ok: false, status: 500, error: 'The channel could not be opened' };
  }
  if (!out.ok) {
    ended = true;
    return { cid, ok: false, status: out.status, error: out.error };
  }
  cleanup = out.cleanup;
  // Ended while it opened (a job that had ended): nothing to keep.
  if (ended) cleanup();
  else tab.channels.set(cid, end);
  return { cid, ok: true };
}

/** GET /api/events, POST /api/events/subscribe and /api/events/unsubscribe. */
export function registerEventHubRoutes(router: Router): void {
  router.add(['GET'], '/api/events', (ctx) => {
    const tabId = String(ctx.url.searchParams.get('tab') || '');
    if (!TAB_RE.test(tabId)) return ctx.sendJson(400, { ok: false, error: 'invalid tab id' });
    const s = hub();
    const old = s.tabs.get(tabId);
    if (old) {
      dropTab(tabId, old);
      try {
        old.res.end();
      } catch {
        /* closed */
      }
    }
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    const conn = randomBytes(8).toString('hex');
    res.write('retry: 1000\n\n');
    writeSse(res, 'hello', { conn });
    const beat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* closed */
      }
    }, HEARTBEAT_MS);
    beat.unref();
    const tab: Tab = { res, conn, channels: new Map(), beat };
    s.tabs.set(tabId, tab);
    const closed = () => {
      res.off('close', closed);
      clearInterval(beat);
      if (s.tabs.get(tabId) === tab) dropTab(tabId, tab);
    };
    res.on('close', closed);
  });

  router.post('/api/events/subscribe', async (ctx) => {
    let body: Record<string, unknown>;
    try {
      body = (await ctx.readJsonBody()) || {};
    } catch {
      return ctx.sendJson(400, { ok: false, error: 'invalid JSON body' });
    }
    const tabId = String(body.tab || '');
    const tab = hub().tabs.get(tabId);
    if (!TAB_RE.test(tabId) || !tab || tab.conn !== String(body.conn || '')) {
      return ctx.sendJson(409, { ok: false, stale: true, error: 'no such event stream' });
    }
    const list = Array.isArray(body.channels) ? body.channels : null;
    if (!list || list.length > MAX_BATCH) return ctx.sendJson(400, { ok: false, error: 'channels must be a list' });
    const results = list.map((spec) =>
      spec && typeof spec === 'object' ? openChannel(tabId, tab, spec as Record<string, unknown>) : { cid: '', ok: false, status: 400, error: 'invalid channel' },
    );
    ctx.sendJson(200, { ok: true, results });
  });

  router.post('/api/events/unsubscribe', async (ctx) => {
    let body: Record<string, unknown>;
    try {
      body = (await ctx.readJsonBody()) || {};
    } catch {
      return ctx.sendJson(400, { ok: false, error: 'invalid JSON body' });
    }
    const tab = hub().tabs.get(String(body.tab || ''));
    if (!tab || tab.conn !== String(body.conn || '')) return ctx.sendJson(409, { ok: false, stale: true, error: 'no such event stream' });
    for (const cid of Array.isArray(body.cids) ? body.cids : []) {
      const end = tab.channels.get(String(cid));
      if (!end) continue;
      tab.channels.delete(String(cid));
      end();
    }
    ctx.sendJson(200, { ok: true });
  });

  if (TEST_ROUTES) registerTestRoutes(router);
}

/** MAGNUSIM_TEST_EVENT_HUB=1 only (see the header): what each tab's stream carries, and a cut. */
function registerTestRoutes(router: Router): void {
  router.get('/api/test/event-hub', (ctx) => {
    const tabs: Record<string, { channels: number; kinds: Record<string, number> }> = {};
    for (const [tabId, tab] of hub().tabs) {
      const kinds: Record<string, number> = {};
      for (const cid of tab.channels.keys()) {
        const kind = cid.split(':')[0];
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
      tabs[tabId] = { channels: tab.channels.size, kinds };
    }
    ctx.sendJson(200, { ok: true, tabs });
  });

  router.post('/api/test/event-hub/drop', async (ctx) => {
    let body: Record<string, unknown>;
    try {
      body = (await ctx.readJsonBody()) || {};
    } catch {
      body = {};
    }
    const only = String(body.tab || '');
    let dropped = 0;
    for (const [tabId, tab] of [...hub().tabs]) {
      if (only && tabId !== only) continue;
      dropped += 1;
      dropTab(tabId, tab);
      try {
        tab.res.destroy();
      } catch {
        /* closed */
      }
    }
    ctx.sendJson(200, { ok: true, dropped });
  });
}

/** Tests: how many streams are open and how many channels they carry. */
export function eventHubCounts(): { tabs: number; channels: number } {
  let channels = 0;
  for (const tab of hub().tabs.values()) channels += tab.channels.size;
  return { tabs: hub().tabs.size, channels };
}
