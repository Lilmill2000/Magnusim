import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_TEXT } from './api';
import { refreshStatus, resetStatusStore, statusSnapshot, subscribeStatus, writeStatus } from './status';

/** A fetch whose answers the test hands out, in any order. */
type Pending = { url: string; method: string; body: string; answer: (status: number, body: unknown) => void };
let pending: Pending[] = [];

const tick = () => new Promise((r) => setTimeout(r, 0));

function status(extra: Record<string, unknown> = {}) {
  return { ok: true, available: true, provider: 'off', spent_today_usd: 0, ...extra };
}

function take(match: (p: Pending) => boolean): Pending {
  const i = pending.findIndex(match);
  if (i < 0) throw new Error(`no pending request (${pending.map((p) => `${p.method} ${p.url}`).join(', ')})`);
  return pending.splice(i, 1)[0];
}
const isGet = (p: Pending) => p.method === 'GET';
const isPost = (p: Pending) => p.method === 'POST';

beforeEach(() => {
  resetStatusStore();
  pending = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({
            url: String(input),
            method: init?.method || 'GET',
            body: typeof init?.body === 'string' ? init.body : '',
            answer: (s, b) => resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })),
          });
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assistant status store', () => {
  it('starts loading and shows the status once read', async () => {
    expect(statusSnapshot()).toEqual({ state: 'loading' });
    const done = refreshStatus();
    take(isGet).answer(200, status({ provider: 'anthropic' }));
    await done;
    const s = statusSnapshot();
    expect(s.state).toBe('ready');
    expect(s.state === 'ready' && s.status.provider).toBe('anthropic');
  });

  it('drops a read that answers while a change is in flight, and reads again after it', async () => {
    const read = refreshStatus();
    const write = writeStatus('/api/assistant/settings', { provider: 'openai' });
    await tick();
    // The read predates the change: its answer must not show.
    take(isGet).answer(200, status({ provider: 'off' }));
    await read;
    expect(statusSnapshot().state).toBe('loading');
    take(isPost).answer(200, status({ provider: 'openai' }));
    await write;
    const s = statusSnapshot();
    expect(s.state === 'ready' && s.status.provider).toBe('openai');
    // ...and the status is read again once the change has settled.
    await tick();
    const again = take(isGet);
    expect(again.url).toBe('/api/assistant/status');
    again.answer(200, status({ provider: 'openai', spent_today_usd: 0.5 }));
    await tick();
    await tick();
    const t = statusSnapshot();
    expect(t.state === 'ready' && t.status.spent_today_usd).toBe(0.5);
  });

  it('never lets an older change that answers late win over a newer one', async () => {
    const first = writeStatus('/api/assistant/settings', { privacy: 'allow' });
    const second = writeStatus('/api/assistant/settings', { privacy: 'deny' });
    await tick();
    const [a, b] = [take((p) => p.body.includes('allow')), take((p) => p.body.includes('deny'))];
    b.answer(200, status({ privacy: 'deny' }));
    await second;
    a.answer(200, status({ privacy: 'allow' }));
    await first;
    const s = statusSnapshot();
    expect(s.state === 'ready' && s.status.privacy).toBe('deny');
  });

  it('drops a read sent during a change that answers after it, and reads again', async () => {
    const write = writeStatus('/api/assistant/key', { provider: 'anthropic', key: 'k-0123456789abcdef' });
    // A step mounted again while the save is on its way: its read was answered from before the save.
    const read = refreshStatus();
    await tick();
    take(isPost).answer(200, status({ keys: { anthropic: { set: true, last4: 'cdef' } } }));
    await write;
    take(isGet).answer(200, status({ keys: { anthropic: { set: false, last4: null } } }));
    await read;
    const s = statusSnapshot();
    expect(s.state === 'ready' && (s.status.keys as Record<string, { set: boolean }>).anthropic.set).toBe(true);
    // ...and read again, which shows.
    await tick();
    const again = take(isGet);
    again.answer(200, status({ keys: { anthropic: { set: true, last4: 'cdef' } }, spent_today_usd: 1 }));
    await tick();
    await tick();
    const t = statusSnapshot();
    expect(t.state === 'ready' && t.status.spent_today_usd).toBe(1);
  });

  it('drops a read sent before a change that answered first', async () => {
    const read = refreshStatus();
    const write = writeStatus('/api/assistant/settings', { effort: 'high' });
    await tick();
    take(isPost).answer(200, status({ effort: 'high' }));
    await write;
    take(isGet).answer(200, status({ effort: 'default' }));
    await read;
    const s = statusSnapshot();
    expect(s.state === 'ready' && s.status.effort).toBe('high');
  });

  it('a late subscriber gets the status already read, and later changes', async () => {
    const read = refreshStatus();
    take(isGet).answer(200, status({ provider: 'anthropic' }));
    await read;
    const seen: string[] = [];
    const off = subscribeStatus(() => {
      const s = statusSnapshot();
      seen.push(s.state === 'ready' ? s.status.provider : s.state);
    });
    const now = statusSnapshot();
    expect(now.state === 'ready' && now.status.provider).toBe('anthropic');
    const write = writeStatus('/api/assistant/settings', { provider: 'off' });
    await tick();
    take(isPost).answer(200, status({ provider: 'off' }));
    await write;
    off();
    expect(seen).toEqual(['off']);
  });

  it('never holds a key: a key save keeps only the answer, and its warning stays with the save', async () => {
    const canary = 'sk-ant-canary-0123456789-abcd';
    const write = writeStatus('/api/assistant/key', { provider: 'anthropic', key: canary });
    await tick();
    const post = take(isPost);
    expect(post.body).toContain(canary);
    post.answer(200, status({ keys: { anthropic: { set: true, last4: 'abcd', set_at: 'x', state: 'ok' } }, warning: 'odd key' }));
    const r = await write;
    expect(r.ok && r.body.warning).toBe('odd key');
    const snap = statusSnapshot();
    expect(JSON.stringify(snap)).not.toContain(canary);
    expect(JSON.stringify(snap)).not.toContain('odd key');
  });

  it('a refused change keeps the status and reads it again', async () => {
    const read = refreshStatus();
    take(isGet).answer(200, status({ caps: { turn_usd: 3 } }));
    await read;
    const write = writeStatus('/api/assistant/settings', { caps: { turn_usd: 500 } });
    await tick();
    take(isPost).answer(400, { ok: false, code: 'invalid', error: 'This limit must be from $0.05 to $100.00.', field: 'caps.turn_usd' });
    const r = await write;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.status).toBe(400);
    expect(!r.ok && r.error.field).toBe('caps.turn_usd');
    expect(!r.ok && r.error.message).toBe('This limit must be from $0.05 to $100.00.');
    const s = statusSnapshot();
    expect(s.state === 'ready' && (s.status.caps as { turn_usd: number }).turn_usd).toBe(3);
    await tick();
    expect(pending.filter(isGet)).toHaveLength(1);
  });

  it('a remote answer shows the one remote sentence', async () => {
    const read = refreshStatus();
    take(isGet).answer(403, { ok: false, available: false, reason: 'remote', error: 'x' });
    await read;
    expect(statusSnapshot()).toEqual({ state: 'remote', message: REMOTE_TEXT });
  });

  it('another failure shows an error', async () => {
    const read = refreshStatus();
    take(isGet).answer(500, { ok: false, error: 'disk on fire', code: 'internal' });
    await read;
    expect(statusSnapshot()).toEqual({ state: 'error', message: 'disk on fire' });
  });
});
