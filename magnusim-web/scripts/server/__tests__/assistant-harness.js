// Shared helpers for the Assistant's loop, gate, CLI and relay tests (not a test file
// itself): a fake clock, ScriptedProvider (a ProviderAdapter whose answers a test scripts)
// and a TurnManager built on them with an in-memory settings object, a fake key store, a
// real spend ledger in a temp folder and a real tool registry; and, for the page relay, a
// server wired as index.ts wires one (the event hub and the Assistant's routes) with a
// page client that holds a tab's event stream and speaks the relay.
//
// A test sets its temp roots first and then imports this file dynamically: the app
// modules below load only then.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const { ProviderError } = await import('../assistant/types.ts');
const { createTurnManager } = await import('../assistant/turns.ts');
const { createToolRegistry } = await import('../assistant/registry.ts');
const { SpendLedger } = await import('../assistant/ledger.ts');
const { defaultSettings, withConsent } = await import('../assistant/settings.ts');
const { HOST_STALL_MS } = await import('../assistant/registry.ts');

export { ProviderError };

/** Time and timers that move only when a test moves them. */
export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 16, 12, 0, 0)) {
    this.t = start;
    this.timers = new Map();
    this.n = 0;
  }

  now() {
    return this.t;
  }

  date() {
    return new Date(this.t);
  }

  setTimeout(fn, ms) {
    const id = ++this.n;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(h) {
    this.timers.delete(h);
  }

  /** Moves time on by `ms`, firing every timer that falls due, in order. */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }

  /**
   * As advance, but promise callbacks run after each timer, as Node runs them between two
   * timer callbacks (so code that a timer's callback lets go on runs before the next timer).
   */
  async advanceAsync(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await tick();
    }
    this.t = end;
  }

  pending() {
    return this.timers.size;
  }
}

export const tick = () => new Promise((r) => setImmediate(r));

/** Waits (in real time) until `fn()` is truthy. */
export async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const emptyUsage = () => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, complete: true });

/**
 * A ProviderAdapter whose answers are scripted. A step:
 *   { text?, tools?: [{name, input?, id?, inputError?}], stop?, usage?, category?,
 *     hold?: '<name>' (after the text, until release(name) or abort), error?: '<code>',
 *     streamed?: bool (with error), fallback?: '<model>', throws?: Error }
 * or a function (req, provider) => step. Every request is recorded (a deep copy, plus the
 * objects it carried).
 */
export class ScriptedProvider {
  constructor({ id = 'anthropic', cloud, fallbackTargets = [] } = {}) {
    this.id = id;
    this.label = 'Scripted';
    this.cloud = cloud ?? id !== 'openai_compatible';
    this.destination = id === 'openai_compatible' ? 'host:127.0.0.1' : id;
    this.steps = [];
    this.requests = [];
    this.holds = new Map();
    this.fallbacks = fallbackTargets;
    this.calls = 0;
  }

  script(...steps) {
    this.steps.push(...steps);
    return this;
  }

  fallbackTargets() {
    return [...this.fallbacks];
  }

  async listModels() {
    return [];
  }

  hold(name) {
    let h = this.holds.get(name);
    if (!h) {
      h = { released: false, waiters: [], reached: false, reachedWaiters: [] };
      this.holds.set(name, h);
    }
    return h;
  }

  release(name) {
    const h = this.hold(name);
    h.released = true;
    for (const w of h.waiters.splice(0)) w();
  }

  /** Resolves once a request is waiting at hold `name`. */
  reached(name) {
    const h = this.hold(name);
    if (h.reached) return Promise.resolve();
    return new Promise((r) => h.reachedWaiters.push(r));
  }

  async send(req, signal, onEvent) {
    this.calls += 1;
    this.requests.push({ req: JSON.parse(JSON.stringify(req)), messages: req.messages, tools: req.tools, aborted: false });
    const rec = this.requests[this.requests.length - 1];
    let step = this.steps.shift();
    if (typeof step === 'function') step = step(req, this);
    if (!step) throw new Error('ScriptedProvider: no step queued');
    const aborted = () => {
      rec.aborted = true;
      return new ProviderError('aborted', 'Stopped.', { streamed: true });
    };
    if (signal.aborted) throw aborted();
    if (step.throws) throw step.throws;
    if (step.text) onEvent({ kind: 'text', text: step.text });
    if (step.fallback) onEvent({ kind: 'fallback', from: req.model, to: step.fallback });
    if (step.hold) {
      const h = this.hold(step.hold);
      h.reached = true;
      for (const w of h.reachedWaiters.splice(0)) w();
      if (!h.released) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(aborted());
          h.waiters.push(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          });
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
    if (signal.aborted) throw aborted();
    if (step.error) throw new ProviderError(step.error, `scripted ${step.error}`, { streamed: !!step.streamed });
    const parts = [];
    if (step.text) parts.push({ type: 'text', text: step.text });
    (step.tools || []).forEach((t, i) => {
      parts.push({
        type: 'tool_call',
        callId: t.id ?? `call-${this.calls}-${i + 1}`,
        name: t.name,
        input: t.input ?? {},
        ...(t.inputError ? { inputError: t.inputError } : {}),
      });
    });
    const usage = { ...emptyUsage(), ...(typeof step.usage === 'function' ? step.usage(req) : step.usage || {}) };
    const stop = step.stop ?? ((step.tools || []).length ? 'tool_use' : 'end_turn');
    const model = step.fallback ?? req.model;
    return {
      message: { role: 'assistant', parts, raw: { provider: this.id, model, payload: { content: parts.map((p) => ({ ...p })) } } },
      stop,
      usage,
      attempts: [{ model, usage, fallback: !!step.fallback }],
      servedBy: model,
      ...(stop === 'refusal' ? { refusal: { category: step.category ?? null, explanation: '' } } : {}),
    };
  }
}

const EMPTY = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

/** A host tool for tests: `run(input, rt)` gives its outcome. */
export function hostTool(name, { risk = 'read', run, schema = EMPTY, title, projectData = false, available = () => true, priority = 0, stallMs = HOST_STALL_MS } = {}) {
  return {
    name,
    localName: name,
    title: title ?? `Run ${name}`,
    description: `Test tool ${name}.`,
    schema,
    risk,
    source: { kind: 'host' },
    projectData,
    stallMs,
    workerBacked: false,
    priority,
    available,
    run: run ?? (async () => ({ ok: true, data: { tool: name }, summary: `${name} ran` })),
  };
}

/**
 * A TurnManager on a ScriptedProvider and a fake clock. Returns the pieces a test steers:
 * {manager, provider, clock, settings, keys, ledger, registry, projects, consents, dir}.
 */
export function makeManager(o = {}) {
  const clock = o.clock ?? new FakeClock();
  const settings = defaultSettings();
  settings.provider = o.provider ?? 'anthropic';
  if (o.model) settings.models[settings.provider] = o.model;
  if (settings.provider === 'openai_compatible' && !settings.models.openai_compatible) settings.models.openai_compatible = 'local-model';
  Object.assign(settings, o.settings || {});
  if (o.caps) settings.caps = { ...settings.caps, ...o.caps };
  const state = { settings };
  const keyListeners = new Set();
  const keys = {
    anthropic: { set: true, last4: null, set_at: null, state: 'ok' },
    openai: { set: true, last4: null, set_at: null, state: 'ok' },
    openai_compatible: { set: false, last4: null, set_at: null, state: 'none' },
  };
  const secrets = {
    load: async () => {},
    storage: () => state.storage ?? { kind: 'file', reason: null, note: '' },
    status: () => structuredClone(keys),
    onKeyChanged: (fn) => {
      keyListeners.add(fn);
      return () => keyListeners.delete(fn);
    },
  };
  const ledger = new SpendLedger({ file: join(o.dir, `spend-${Math.random().toString(36).slice(2)}.json`), clock: () => clock.date() });
  const registry = o.registry ?? createToolRegistry({ hostTools: o.hostTools ?? [], ...(o.pluginEpoch ? { pluginEpoch: o.pluginEpoch } : {}) });
  const provider = o.adapter ?? new ScriptedProvider({ id: settings.provider });
  const projects = new Map(Object.entries(o.projects ?? {}));
  const consents = [];
  const deps = {
    settings: async () => structuredClone(state.settings),
    secrets: () => secrets,
    deps: async () => o.deps ?? 'ok',
    ledger: async () => {
      await ledger.load();
      return ledger;
    },
    createAdapter: o.createAdapter ?? (async () => provider),
    registry,
    projects: async (id) => (projects.has(id) ? { ...projects.get(id) } : null),
    remember: async (projectId, createdAt, destination) => {
      consents.push({ projectId, createdAt, destination });
      state.settings = withConsent(state.settings, projectId, createdAt, destination);
    },
    clock,
    resendDelayMs: 0,
    ...(o.presenter ? { presenter: o.presenter } : {}),
    ...(o.gateTimeoutMs ? { gateTimeoutMs: o.gateTimeoutMs } : {}),
    ...(o.abortGraceMs !== undefined ? { abortGraceMs: o.abortGraceMs } : {}),
  };
  const manager = createTurnManager(deps);
  return {
    manager,
    /** The TurnManager's deps (registerAssistantRoutes takes them as `turns`). */
    deps,
    provider,
    clock,
    state,
    keys,
    ledger,
    registry,
    projects,
    consents,
    /** A key saved or removed for `slot` (the store's listeners run). */
    keyChanged(slot) {
      for (const fn of [...keyListeners]) fn(slot);
    },
  };
}

/** Starts a turn through the manager; returns {status, body, turn} (turn: the Turn object). */
export async function startTurn(m, body) {
  const r = await m.manager.start(typeof body === 'string' ? { text: body } : body);
  return { ...r, turn: r.body.turn ? m.manager.get(r.body.turn) : null };
}

/** Waits until the turn's loop has fully ended (its conversation is free again). */
export function settled(turn, ms = 5000) {
  return until(() => turn.settled, ms, `turn ${turn.id} to settle`);
}

/** Every event of a turn so far, without marking them read. */
export function eventsOf(turn) {
  return turn.log.map((e) => ({ ...e }));
}

/** Answers each gate as it opens: `answer(view)` gives true/false, 'timeout' or null (leave it). */
export function answerGates(m, turn, answer) {
  return turn.subscribe((e) => {
    if (e.type !== 'gate') return;
    const a = answer(e.gate);
    if (a === null || a === undefined) return;
    queueMicrotask(() => {
      if (a === 'timeout') m.clock.advance(10 * 60_000 + 1);
      else m.manager.answerGate(e.gate.id, a === true);
    });
  });
}

/**
 * Both invariants of spec 6.2 over a conversation and the requests a provider saw:
 * 1. append-only: each request's messages extend the previous one's, unchanged, and the
 *    conversation still starts with the last request's messages;
 * 2. complete exchanges: every tool call of an assistant message has exactly one result
 *    in the next user message, in call order.
 */
export function checkInvariants(assert, conv, requests, label = '') {
  const json = (m) => JSON.stringify(m);
  const finalMsgs = conv.messages.map(json);
  let prev = [];
  for (const [i, r] of requests.entries()) {
    const msgs = r.req.messages.map(json);
    assert.ok(msgs.length >= prev.length, `${label} request ${i} shrank the conversation`);
    for (let k = 0; k < prev.length; k += 1) assert.equal(msgs[k], prev[k], `${label} request ${i} changed message ${k}`);
    prev = msgs;
  }
  for (let k = 0; k < prev.length; k += 1) assert.equal(finalMsgs[k], prev[k], `${label} the stored message ${k} changed after it was sent`);
  const list = conv.messages;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (m.role !== 'assistant') continue;
    const calls = m.parts.filter((p) => p.type === 'tool_call').map((p) => p.callId);
    if (!calls.length) continue;
    const next = list[i + 1];
    assert.ok(next && next.role === 'user', `${label} the calls of message ${i} have a user message after them`);
    const results = next.parts.filter((p) => p.type === 'tool_result').map((p) => p.callId);
    assert.deepEqual(results, calls, `${label} message ${i + 1} answers every call of message ${i} once, in order`);
  }
}

// ---------------------------------------------------------------- the page relay

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
const BY_SCHEMA = Object.freeze({
  type: 'object',
  properties: { by: { type: 'integer', minimum: -100, maximum: 100 } },
  required: ['by'],
  additionalProperties: false,
});

/** The demo workspace's tools as its page registers them (the e2e fixture's, less the image). */
export function demoTools() {
  return [
    { name: 'get_count', description: 'Reads the counter.', inputSchema: EMPTY_SCHEMA, risk: 'read' },
    { name: 'add', title: 'Add to the counter', description: 'Adds to the counter.', inputSchema: BY_SCHEMA, risk: 'edit' },
    { name: 'slow_add', title: 'Add slowly', description: 'Adds, slowly.', inputSchema: BY_SCHEMA, risk: 'edit', timeoutS: 30 },
    { name: 'reset', title: 'Reset the counter', description: 'Sets the counter to 0.', inputSchema: EMPTY_SCHEMA, risk: 'destructive' },
  ];
}

/** The scope the host gives a demo frame: its route's key, and its title from the plugin's row. */
export const DEMO_WORKSPACE = Object.freeze({ project_id: 'p1', plugin: 'ai-demo', workspace: 'counter', title: 'Counter', study_id: 's1' });

/**
 * pluginLoaded for the relay: the demo plugin is on while `state.on`. Its row is one object
 * per live registry read (`state.doc`), as registry-defaults.js gives the same row until the
 * registry is read again; `state.doc === null`: no live registry is loaded.
 */
export function demoLoaded(state = { on: true }) {
  const rows = new WeakMap();
  return (key) => {
    if (!state.on || key !== 'ai-demo' || state.doc === null) return null;
    const doc = state.doc ?? state;
    let row = rows.get(doc);
    if (!row) rows.set(doc, (row = { key, name: 'Workspace demo' }));
    return row;
  };
}

export const newTabId = () => `tab-${randomBytes(6).toString('hex')}`;

async function requestJson(base, method, path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}

/** The server's own record of a tab's stream (event-hub.ts state). */
export function hubTab(tab) {
  return globalThis[Symbol.for('magnusim.eventHub')]?.tabs.get(tab) ?? null;
}

/**
 * A tab of the app: its event stream (GET /api/events), read frame by frame, and the
 * relay's channel on it. Frames: {event, c, d} (`hello` has no c).
 */
export async function relayPage(base, tab = newTabId(), { headers = {} } = {}) {
  const page = { tab, frames: [], conn: null, status: 0, ended: false, req: null };
  let raw = '';
  await new Promise((resolve) => {
    page.req = http.get(`${base}/api/events?tab=${tab}`, { headers, agent: false }, (res) => {
      page.status = res.statusCode;
      if (res.statusCode !== 200) {
        res.resume();
        resolve();
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
          if (!ev) continue;
          const parsed = data ? JSON.parse(data[1]) : null;
          if (ev[1] === 'hello') {
            page.conn = parsed.conn;
            resolve();
            continue;
          }
          page.frames.push({ event: ev[1], c: parsed?.c ?? null, d: parsed?.d ?? null });
        }
      });
      res.on('close', () => {
        page.ended = true;
        resolve();
      });
      res.on('error', () => undefined);
    });
    page.req.on('error', () => {
      page.ended = true;
      resolve();
    });
  });
  /** Subscribes a relay channel (cid `assistant:N`); its result row. */
  page.subscribe = async (cid = 'assistant:1', params = { role: 'relay' }, h = {}) => {
    const r = await requestJson(base, 'POST', '/api/events/subscribe', { tab, conn: page.conn, channels: [{ cid, kind: 'assistant', params }] }, h);
    return r.json?.results?.[0] ?? r;
  };
  page.unsubscribe = (cid = 'assistant:1') => requestJson(base, 'POST', '/api/events/unsubscribe', { tab, conn: page.conn, cids: [cid] });
  /** The payloads of a channel's frames of one type so far. */
  page.of = (event, cid = 'assistant:1') => page.frames.filter((f) => f.c === cid && f.event === event).map((f) => f.d);
  /** Waits for the n-th (0-based) frame of a type on a channel and returns its payload. */
  page.frame = (event, n = 0, cid = 'assistant:1', ms = 5000) => until(() => page.of(event, cid)[n], ms, `${event} #${n} on ${cid}`);
  /** Subscribes and waits for its `linked` frame: the link. */
  page.open = async (cid = 'assistant:1') => {
    const before = page.of('linked', cid).length;
    const r = await page.subscribe(cid);
    if (!r.ok) throw new Error(`the relay channel was refused: ${r.status} ${r.error}`);
    return (await page.frame('linked', before, cid)).link;
  };
  /** The server cuts the tab's stream (as a lost connection does); its channels end. */
  page.serverDrop = () => hubTab(tab)?.res.destroy();
  page.close = () => page.req.destroy();
  return page;
}

/**
 * A server as index.ts wires the relay: the same-origin check and the Assistant's prefix
 * guard, then a real Router with the event hub and the Assistant's routes, over
 * http.createServer. `m` is a makeManager() (its clock drives the relay's timers too);
 * `o.loaded` is the demo plugin's state for pluginLoaded ({on, doc}: doc is the live registry
 * read in place, null when none is loaded); `o.relay` more relay options. registryChanged()
 * is the worker's 'registry-changed' (a registry-changing call answered; the live registry is
 * read again after it) and registryRead() that read landing.
 */
export async function relayServer(m, o = {}) {
  const { Router, dispatch } = await import('../router.ts');
  const { registerEventHubRoutes } = await import('../event-hub.ts');
  const { assertSameOrigin, sendJson } = await import('../http.ts');
  const { assistantGuard } = await import('../assistant/access.ts');
  const routes = await import('../assistant-routes.ts');
  const router = new Router();
  registerEventHubRoutes(router);
  const loaded = o.loaded ?? { on: true, doc: {} };
  const changed = new Set();
  const relay = {
    pluginLoaded: demoLoaded(loaded),
    liveRegistry: () => loaded.doc ?? null,
    onRegistryChanged: (fn) => {
      changed.add(fn);
      return () => changed.delete(fn);
    },
    ...(o.relay || {}),
  };
  const handle = routes.registerAssistantRoutes(router, { turns: m.deps, relay });
  const server = http.createServer(async (req, res) => {
    try {
      assertSameOrigin(req);
      if (assistantGuard(req, res)) return;
      if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, err?.status || 500, { error: String(err?.message || err) });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers) => requestJson(base, 'POST', path, body, headers);
  const get = (path, headers) => requestJson(base, 'GET', path, undefined, headers);
  return {
    base,
    handle,
    relay: handle.relay,
    loaded,
    registryChanged: () => {
      for (const fn of [...changed]) fn();
    },
    registryRead: () => {
      loaded.doc = {};
    },
    post,
    get,
    page: (tab, opts) => relayPage(base, tab, opts),
    /** POST /relay/tools for the demo workspace. */
    register: (link, rev, tools = demoTools(), extra = {}) => post('/api/assistant/relay/tools', { link, rev, workspace: { ...DEMO_WORKSPACE }, tools, ...extra }),
    progress: (link, call, extra = {}) => post('/api/assistant/relay/progress', { link, call, ...extra }),
    result: (link, call, extra = { ok: true }) => post('/api/assistant/relay/result', { link, call, ...extra }),
    tabs: async () => (await get('/api/assistant/tabs')).json.tabs,
    async close() {
      handle.shutdown();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A workspace tool's run as the runner calls it: {promise, abort}. */
export function runTool(def, input, ctx, { turn = 't-test', progress = () => {} } = {}) {
  const ac = new AbortController();
  const promise = def.run(input, { signal: ac.signal, ctx, turn, progress });
  return { promise, abort: (reason) => ac.abort(reason) };
}

/** Whether a promise has settled by now (after its microtasks and one turn of the event loop). */
export async function settledNow(promise) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await tick();
  return done;
}
