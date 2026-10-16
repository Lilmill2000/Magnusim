// Shared helpers for the Assistant's loop, gate and CLI tests (not a test file itself):
// a fake clock, ScriptedProvider (a ProviderAdapter whose answers a test scripts) and a
// TurnManager built on them with an in-memory settings object, a fake key store, a real
// spend ledger in a temp folder and a real tool registry.
//
// A test sets its temp roots first and then imports this file dynamically: the app
// modules below load only then.
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
