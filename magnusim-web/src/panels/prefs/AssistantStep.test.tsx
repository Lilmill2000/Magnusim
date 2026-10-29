import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_TEXT } from '../../assistant/api';
import { resetStatusStore, settleStep, statusSnapshot } from '../../assistant/status';
import {
  AS_TEXT_TEXT,
  AssistantStep,
  DEFAULT_COPY,
  DEPS_TEXT,
  EFFORT_SHARED_TEXT,
  FALLBACK_TEXT,
  LOCAL_LIMITS_TEXT,
  LOCAL_PRICE_TEXT,
  LOCAL_PRIVACY_TEXT,
  NOT_USED_TEXT,
  OPEN_LOG_FOLDER,
  PRIVACY_COPY,
  PROVIDER_LOG_ENV_TEXT,
  PROVIDER_LOG_LABEL,
  PROVIDER_LOG_TEXT,
  SERVER_LIMITS_TEXT,
  SERVER_PRICE_TEXT,
  SHARED_PC_TEXT,
  TEMPLATE_TEXT,
  testLine,
  UNKNOWN_PRICE_TEXT,
  withCode,
} from './AssistantStep';

const confirmAction = vi.fn(async (_opts?: Record<string, unknown>) => false);
vi.mock('../../workbench/dialogs', () => ({
  confirmAction: (opts?: Record<string, unknown>) => confirmAction(opts),
}));

const CANARY = 'sk-ant-canary-5c1f0e7d9a2b-1234';
const NO_KEY = { set: false, last4: null, set_at: null, state: 'none' };

type Answer = { status: number; body: unknown };
type Request = { method: string; path: string; body: Record<string, unknown> };

/** The Assistant's routes as a test server: the status, and what the routes answer. */
let status: Record<string, unknown>;
let statusAnswer: Answer | null;
let modelsAnswer: Answer;
let testAnswer: Answer;
let requests: Request[];
/** Set to hold the next key save until released. */
let holdKey: { release?: () => void } | null;
/** What the server learns while it runs a Test (say, that the saved key can't be opened). */
let onTest: (() => void) | null;
/** Set to hold the next settings change until released. */
let holdSettings: { release?: () => void } | null;
/** Set: a Test never answers (until its request is aborted); each Test request's signal. */
let holdTest: boolean;
let testSignals: Array<AbortSignal | null | undefined>;

function baseStatus(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    available: true,
    provider: 'off',
    models: { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: '' },
    base_url: 'http://127.0.0.1:1234/v1',
    base_url_is_local: true,
    effort: 'default',
    privacy: 'ask',
    consents: 0,
    caps: { turn_usd: 8, day_usd: 15, steps: 120, turn_minutes: 60, turn_tokens: 10_000_000 },
    keys: { anthropic: NO_KEY, openai: NO_KEY, openai_compatible: NO_KEY },
    storage: { kind: 'dpapi', reason: null, note: 'Encrypted for your Windows account.' },
    keys_notice: null,
    spent_today_usd: 0.42,
    test_protector: null,
    ...extra,
  };
}

const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s, headers: { 'Content-Type': 'application/json' } });
const isLoopback = (url: string) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/.test(url);

function applySettings(patch: Record<string, unknown>): Answer {
  const next = { ...status };
  if ('provider' in patch) next.provider = patch.provider;
  if ('model' in patch) next.models = { ...(next.models as object), [String(next.provider)]: patch.model };
  if ('models' in patch) next.models = { ...(next.models as object), ...(patch.models as object) };
  if ('effort' in patch) next.effort = patch.effort;
  if ('privacy' in patch) next.privacy = patch.privacy;
  if ('forget_consents' in patch) next.consents = 0;
  if ('provider_log' in patch) next.provider_log = { ...(next.provider_log as object), on: patch.provider_log };
  if ('base_url' in patch) {
    const url = String(patch.base_url);
    if (!isLoopback(url) && patch.confirm_remote !== true) {
      return { status: 409, body: { ok: false, code: 'needs_confirm', error: 'That server is not on this PC.', field: 'base_url', needs_confirm: 'base_url' } };
    }
    next.base_url = url;
    next.base_url_is_local = isLoopback(url);
  }
  if ('caps' in patch) {
    const caps = { ...(next.caps as Record<string, number>), ...(patch.caps as Record<string, number>) };
    if (caps.day_usd < 0.1 || caps.day_usd > 1000) {
      return { status: 400, body: { ok: false, code: 'invalid', error: 'This limit must be from $0.10 to $1000.00.', field: 'caps.day_usd' } };
    }
    if (caps.steps < 1 || caps.steps > 200) {
      return { status: 400, body: { ok: false, code: 'invalid', error: 'This limit must be a whole number from 1 to 200.', field: 'caps.steps' } };
    }
    next.caps = caps;
  }
  status = next;
  return { status: 200, body: status };
}

async function route(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  if (path === '/api/assistant/status') return statusAnswer || { status: 200, body: status };
  if (path === '/api/assistant/settings') {
    if (holdSettings) await new Promise<void>((r) => (holdSettings!.release = r));
    return applySettings(body);
  }
  if (path === '/api/assistant/key') {
    if (holdKey) await new Promise<void>((r) => (holdKey!.release = r));
    const key = String(body.key);
    status = { ...status, keys: { ...(status.keys as object), [String(body.provider)]: { set: true, last4: key.slice(-4), set_at: 'now', state: 'ok' } } };
    const odd = body.provider === 'anthropic' && !key.startsWith('sk-ant-');
    return { status: 200, body: { ...status, ...(odd ? { warning: "This doesn't look like an Anthropic key." } : {}) } };
  }
  if (path === '/api/assistant/key/remove') {
    status = { ...status, keys: { ...(status.keys as object), [String(body.provider)]: NO_KEY } };
    return { status: 200, body: status };
  }
  if (path === '/api/assistant/log-folder/open') return { status: 200, body: { ok: true, folder: 'D:/Magnusim home/assistant/logs' } };
  if (path.startsWith('/api/assistant/models')) return modelsAnswer;
  if (path === '/api/assistant/test') {
    onTest?.();
    return testAnswer;
  }
  return { status: 404, body: { ok: false, error: 'not found' } };
}

beforeEach(() => {
  resetStatusStore();
  confirmAction.mockReset();
  confirmAction.mockResolvedValue(false);
  status = baseStatus();
  statusAnswer = null;
  modelsAnswer = { status: 404, body: { ok: false, error: 'not found' } };
  testAnswer = { status: 404, body: { ok: false, error: 'not found' } };
  requests = [];
  holdKey = null;
  onTest = null;
  holdSettings = null;
  holdTest = false;
  testSignals = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      requests.push({ method, path: url, body });
      if (url === '/api/assistant/test') {
        testSignals.push(init?.signal);
        if (holdTest) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          });
        }
      }
      const a = await route(method, url.split('?')[0] === '/api/assistant/models' ? url : url.split('?')[0], body);
      return json(a.status, a.body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);
const step = () => document.querySelector('[data-assistant-step]') as HTMLElement;
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function ready(extra: Record<string, unknown> = {}) {
  status = baseStatus(extra);
  render(<AssistantStep panelId="wiz-assistant" />);
  await waitFor(() => expect(step()).toBeTruthy());
}

describe('AssistantStep views', () => {
  it('says it is checking while the status is read, then shows the Default choice with Off chosen and every provider card', async () => {
    let release!: () => void;
    statusAnswer = null;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return inner(input, init);
    });
    render(<AssistantStep panelId="wiz-assistant" />);
    expect(screen.getByText('Checking the Assistant…')).toBeInTheDocument();
    release();
    await waitFor(() => expect(step()).toBeTruthy());
    const group = screen.getByRole('radiogroup', { name: 'Default provider' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['off', 'openai_compatible', 'anthropic', 'openai']);
    expect(group).toHaveTextContent('Local server');
    expect(group).toHaveTextContent('Anthropic (API key)');
    expect(group).toHaveTextContent('OpenAI (API key)');
    expect(q<HTMLInputElement>('[data-assistant-default-option="off"] input')!.checked).toBe(true);
    expect(q('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'off');
    expect(q('[data-assistant-default-copy]')!.textContent).toBe(DEFAULT_COPY);
    // Every provider's card is listed, whatever the default; with none, every card starts closed.
    const cards = [...document.querySelectorAll('[data-assistant-card]')];
    expect(cards.map((c) => c.getAttribute('data-assistant-card'))).toEqual(['openai_compatible', 'anthropic', 'openai']);
    for (const c of cards) {
      expect(c).toHaveAttribute('data-open', '0');
      expect(within(c as HTMLElement).getByRole('button', { name: 'Set up' })).toHaveAttribute('aria-expanded', 'false');
    }
    expect(q('[data-assistant-key]')).toBeNull();
    expect(q('[data-assistant-model]')).toBeNull();
    expect(requests.some((r) => r.path.startsWith('/api/assistant/models'))).toBe(false);
    // Privacy and the limits hold for any provider a conversation uses.
    expect(q('[data-assistant-privacy]')).toBeTruthy();
    expect(q('[data-assistant-limits]')).toBeTruthy();
    // Set up opens a card with its own blocks and line.
    fireEvent.click(q('[data-assistant-card-toggle="anthropic"]')!);
    expect(q('[data-assistant-card="anthropic"]')).toHaveAttribute('data-open', '1');
    expect(q('[data-assistant-card-copy="anthropic"]')).toHaveTextContent('Claude models with your API key. Project data you ask about goes to Anthropic.');
    expect(q('[data-assistant-card="anthropic"] [data-assistant-key="anthropic"]')).toBeTruthy();
    await waitFor(() => expect(requests.some((r) => r.path === '/api/assistant/models?provider=anthropic')).toBe(true));
    fireEvent.click(q('[data-assistant-card-toggle="openai_compatible"]')!);
    expect(q('[data-assistant-card-copy="openai_compatible"]')).toHaveTextContent('LM Studio or Ollama on this PC. Project data stays here.');
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    expect(q('[data-assistant-card-copy="openai"]')).toHaveTextContent('GPT models with your API key. Project data you ask about goes to OpenAI.');
  });

  it('over remote access shows only the remote sentence', async () => {
    statusAnswer = { status: 403, body: { ok: false, available: false, reason: 'remote', error: 'x' } };
    render(<AssistantStep panelId="wiz-assistant" />);
    const only = await waitFor(() => {
      const el = q('[data-assistant-local-only]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(only).toHaveTextContent(REMOTE_TEXT);
    expect(only.textContent).toBe(
      'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.',
    );
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(q('[data-assistant-step]')).toBeNull();
  });

  it("another failure says it couldn't read the settings, and Retry reads them again", async () => {
    statusAnswer = { status: 500, body: { ok: false, error: 'settings.json is locked', code: 'internal' } };
    render(<AssistantStep panelId="wiz-assistant" />);
    const err = await waitFor(() => {
      const el = q('[data-assistant-error]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(err).toHaveTextContent("Couldn't read the Assistant's settings: settings.json is locked");
    statusAnswer = null;
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(step()).toBeTruthy());
  });

  it('choosing the default saves it at once and opens its card, marked Default', async () => {
    await ready();
    fireEvent.click(q('[data-assistant-default-option="anthropic"] input')!);
    await waitFor(() => expect(q('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'anthropic'));
    expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([{ provider: 'anthropic' }]);
    expect(q('[data-assistant-card="anthropic"]')).toHaveAttribute('data-open', '1');
    expect(q('[data-assistant-card="anthropic"] [data-assistant-card-default]')).toHaveTextContent('Default');
    expect(document.querySelectorAll('[data-assistant-card-default]')).toHaveLength(1);
  });

  it('the Default radiogroup keeps every card, and switching the default never removes a key block or anything a card holds (D-A)', async () => {
    const withKey = { set: true, last4: 'a1b2', set_at: 'x', state: 'ok' };
    await ready({ provider: 'anthropic', keys: { anthropic: withKey, openai: NO_KEY, openai_compatible: NO_KEY } });
    const card = (id: string) => q(`[data-assistant-card="${id}"]`)!;
    expect(within(card('anthropic')).getByText('Key set, ends in …a1b2')).toBeTruthy();
    // A key pasted into a non-default card stays there through the default's change.
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    const pasted = card('openai').querySelector<HTMLInputElement>('[data-assistant-key-input]')!;
    pasted.value = 'sk-proj-pasted-0000';
    for (const next of ['openai_compatible', 'off', 'openai', 'anthropic']) {
      fireEvent.click(q(`[data-assistant-default-option="${next}"] input`)!);
      await waitFor(() => expect(q('[data-assistant-default]')).toHaveAttribute('data-assistant-default', next));
      expect(document.querySelectorAll('[data-assistant-card]')).toHaveLength(3);
      expect(within(card('anthropic')).getByText('Key set, ends in …a1b2')).toBeTruthy();
      expect(card('anthropic').querySelector('[data-assistant-key-remove]')).toBeTruthy();
      expect(card('openai').querySelector<HTMLInputElement>('[data-assistant-key-input]')).toBe(pasted);
      expect(pasted.value).toBe('sk-proj-pasted-0000');
    }
    expect(posts('/api/assistant/key/remove')).toHaveLength(0);
    expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([
      { provider: 'openai_compatible' },
      { provider: 'off' },
      { provider: 'openai' },
      { provider: 'anthropic' },
    ]);
    // Hide keeps what the card holds: leaving the step still saves the pasted key.
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    expect(card('openai')).toHaveAttribute('data-open', '0');
    expect(card('openai').querySelector('.wiz-assistant-card-body')).toHaveAttribute('hidden');
    const left = settleStep();
    expect(left).not.toBe(true);
    await expect(left).resolves.toBe(true);
    expect(posts('/api/assistant/key').map((r) => r.body)).toEqual([{ provider: 'openai', key: 'sk-proj-pasted-0000' }]);
  });

  it("each option and card shows its provider's line and ready dot from providers_ready", async () => {
    const providers_ready = {
      openai_compatible: { label: 'Local server', kind: 'server', ready: true, reason: null, billing: 'free', detail: '127.0.0.1:1234 · qwen3.8-27b' },
      anthropic: { label: 'Anthropic', kind: 'key', ready: true, reason: null, billing: 'usd', detail: 'Key set, ends in …a1b2 · claude-opus-5-5' },
      openai: { label: 'OpenAI', kind: 'key', ready: false, reason: 'no_key', billing: 'usd', detail: 'No key' },
    };
    await ready({ provider: 'anthropic', providers_ready });
    for (const [id, row] of Object.entries(providers_ready)) {
      const option = q(`[data-assistant-default-option="${id}"]`)!;
      expect(option).toHaveTextContent(row.detail);
      expect(option.querySelector('[data-assistant-dot]')).toHaveAttribute('data-assistant-dot', row.ready ? 'ready' : 'not-ready');
      const card = q(`[data-assistant-card="${id}"]`)!;
      expect(card).toHaveAttribute('data-ready', row.ready ? '1' : '0');
      expect(card.querySelector('[data-assistant-card-state]')).toHaveTextContent(row.detail);
    }
    expect(q('[data-assistant-default-option="off"] [data-assistant-dot]')).toBeNull();
  });

  it("shows the packages line and the test switches when the status has them", async () => {
    await ready({ deps: 'missing', test_protector: 'blocked', test_provider: true });
    expect(q('[data-assistant-deps]')).toHaveTextContent(DEPS_TEXT);
    expect(q('[data-assistant-test-provider]')).toHaveTextContent('Test switches in use: key protector (blocked), test provider address.');
  });

  it('a status without the model adapters shows no packages line and no switch line', async () => {
    await ready({ provider: 'anthropic' });
    expect(q('[data-assistant-deps]')).toBeNull();
    expect(q('[data-assistant-test-provider]')).toBeNull();
    expect(q('[data-assistant-price]')).toBeNull();
    expect(q('[data-assistant-fallback-note]')).toBeNull();
  });
});

describe('AssistantStep key', () => {
  it('pins the key field: off for autocomplete, ignored by password managers, no name or id, outside any form', async () => {
    await ready({ provider: 'anthropic' });
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(input).toHaveAttribute('data-bwignore');
    expect(input).toHaveAttribute('data-form-type', 'other');
    expect(input.hasAttribute('name')).toBe(false);
    expect(input.hasAttribute('id')).toBe(false);
    expect(input.closest('form')).toBeNull();
    // This DOM has no -webkit-text-security: the password field instead.
    expect(input.type).toBe('password');
    expect(input.hasAttribute('value')).toBe(false);
  });

  it('where text security is supported the field is plain text drawn as discs', async () => {
    vi.stubGlobal('CSS', { supports: (p: string, v: string) => p === '-webkit-text-security' && v === 'disc' });
    await ready({ provider: 'anthropic' });
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    expect(input.type).toBe('text');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('data-1p-ignore');
  });

  it('clears the field before the save is sent, and the key is never in the page or the store', async () => {
    await ready({ provider: 'anthropic' });
    holdKey = {};
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    fireEvent.change(input, { target: { value: CANARY } });
    input.value = CANARY;
    fireEvent.click(q('[data-assistant-key-save]')!);
    // The save is still on its way, and the field is already empty.
    await waitFor(() => expect(posts('/api/assistant/key')).toHaveLength(1));
    expect(holdKey.release).toBeTypeOf('function');
    expect(input.value).toBe('');
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(JSON.stringify(statusSnapshot())).not.toContain(CANARY);
    expect(posts('/api/assistant/key')[0].body).toEqual({ provider: 'anthropic', key: CANARY });
    act(() => holdKey!.release!());
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …1234'));
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(JSON.stringify(statusSnapshot())).not.toContain(CANARY);
    expect(input.value).toBe('');
  });

  it('Enter in the field saves; an empty field says so without sending; a warning shows under the status', async () => {
    await ready({ provider: 'anthropic' });
    fireEvent.click(q('[data-assistant-key-save]')!);
    expect(await screen.findByText('Paste the key first.')).toBeInTheDocument();
    expect(posts('/api/assistant/key')).toHaveLength(0);
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    input.value = 'not-a-usual-key-9876';
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …9876'));
    expect(q('[data-assistant-key-warning]')).toHaveTextContent("This doesn't look like an Anthropic key.");
  });

  it('shows each key state', async () => {
    await ready({
      provider: 'anthropic',
      keys: { anthropic: { set: true, last4: null, set_at: 'x', state: 'ok' }, openai: { set: true, last4: 'x9Qa', set_at: 'x', state: 'unreadable' }, openai_compatible: NO_KEY },
    });
    expect(q('[data-assistant-key-status]')).toHaveTextContent(/^Key set$/);
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    await waitFor(() => expect(q('[data-assistant-key="openai"]')).toBeTruthy());
    expect(q('[data-assistant-key="openai"] [data-assistant-key-status]')).toHaveTextContent("Your saved key can't be decrypted on this Windows account. Enter it again.");
    expect(q('[data-assistant-key="openai"] [data-assistant-storage]')).toHaveTextContent('Encrypted for your Windows account.');
    expect(q('[data-assistant-key="anthropic"] [data-assistant-key-status]')).toHaveTextContent(/^Key set$/);
  });

  it('Remove asks first with the safe answer focused, and removes only on yes', async () => {
    await ready({ provider: 'anthropic', keys: { anthropic: { set: true, last4: 'abcd', set_at: 'x', state: 'ok' }, openai: NO_KEY, openai_compatible: NO_KEY } });
    fireEvent.click(q('[data-assistant-key-remove]')!);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ safe: true });
    await Promise.resolve();
    expect(posts('/api/assistant/key/remove')).toHaveLength(0);
    confirmAction.mockResolvedValueOnce(true);
    fireEvent.click(q('[data-assistant-key-remove]')!);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('No key'));
    expect(posts('/api/assistant/key/remove').map((r) => r.body)).toEqual([{ provider: 'anthropic' }]);
    expect(q('[data-assistant-key-remove]')).toBeNull();
  });

  it("when Windows blocks key storage there is no key field, the reason shows, and the local server is still offered", async () => {
    const blocked = { kind: 'unavailable', reason: 'blocked', note: "Windows blocked the helper Magnusim uses to encrypt keys, so keys can't be saved on this PC. A local server still works." };
    await ready({ provider: 'anthropic', storage: blocked });
    expect(q('[data-assistant-key-input]')).toBeNull();
    expect(q('[data-assistant-key-save]')).toBeNull();
    expect(q('[data-assistant-storage]')).toHaveTextContent("keys can't be saved on this PC");
    // No empty row of controls left behind (it would still take a gap).
    expect(q('[data-assistant-key="anthropic"] .wiz-assistant-row')).toBeNull();
    const local = q<HTMLInputElement>('[data-assistant-default-option="openai_compatible"] input')!;
    expect(local.disabled).toBe(false);
    fireEvent.click(local);
    await waitFor(() => expect(q('[data-assistant-endpoint]')).toBeTruthy());
    expect(q('[data-assistant-card="openai_compatible"]')).toHaveAttribute('data-open', '1');
  });

  it('when key storage is blocked, a key saved before can still be removed', async () => {
    const blocked = { kind: 'unavailable', reason: 'blocked', note: "Windows blocked the helper Magnusim uses to encrypt keys, so keys can't be saved on this PC. A local server still works." };
    await ready({ provider: 'anthropic', storage: blocked, keys: { anthropic: { set: true, last4: 'abcd', set_at: 'x', state: 'ok' }, openai: NO_KEY, openai_compatible: NO_KEY } });
    expect(q('[data-assistant-key-input]')).toBeNull();
    const row = q('[data-assistant-key="anthropic"] .wiz-assistant-row')!;
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.querySelector('[data-assistant-key-remove]')).toHaveTextContent('Remove key');
  });

  it('a local server offers an optional token', async () => {
    await ready({ provider: 'openai_compatible' });
    expect(q('[data-assistant-key="openai_compatible"]')).toHaveTextContent('Server token (optional)');
    expect(q('[data-assistant-key-status]')).toHaveTextContent('No token');
    expect(q('[data-assistant-key-save]')).toHaveTextContent('Save token');
  });
});

describe('AssistantStep local server', () => {
  it('saves the endpoint on Enter, and a server outside this PC asks first (Cancel keeps the old one)', async () => {
    await ready({ provider: 'openai_compatible' });
    const field = () => q<HTMLInputElement>('[data-assistant-endpoint]')!;
    expect(field().value).toBe('http://127.0.0.1:1234/v1');
    fireEvent.change(field(), { target: { value: 'http://192.168.1.50:1234/v1' } });
    fireEvent.blur(field());
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ safe: true });
    await waitFor(() => expect(field().value).toBe('http://127.0.0.1:1234/v1'));
    expect(status.base_url).toBe('http://127.0.0.1:1234/v1');
    expect(posts('/api/assistant/settings').some((r) => r.body.confirm_remote === true)).toBe(false);
    // Yes this time: saved, and project data is now asked about.
    confirmAction.mockResolvedValueOnce(true);
    fireEvent.change(field(), { target: { value: 'http://192.168.1.50:1234/v1' } });
    fireEvent.blur(field());
    await waitFor(() => expect(field().value).toBe('http://192.168.1.50:1234/v1'));
    expect(posts('/api/assistant/settings').at(-1)!.body).toEqual({ base_url: 'http://192.168.1.50:1234/v1', confirm_remote: true });
    expect(q('[data-assistant-privacy]')).toBeTruthy();
    expect(q('[data-assistant-privacy-local]')).toBeNull();
  });

  it('a loopback endpoint saves without asking; the Ollama preset shows the context hint', async () => {
    await ready({ provider: 'openai_compatible' });
    expect(q('[data-assistant-ollama-hint]')).toBeNull();
    fireEvent.click(q('[data-assistant-endpoint-preset="ollama"]')!);
    await waitFor(() => expect(q<HTMLInputElement>('[data-assistant-endpoint]')!.value).toBe('http://127.0.0.1:11434/v1'));
    expect(confirmAction).not.toHaveBeenCalled();
    expect(q('[data-assistant-ollama-hint]')).toBeTruthy();
  });

  it('on this PC: no cost and data stays here, in its card; the limits say a local server costs nothing and keep the $ ones for the cloud', async () => {
    await ready({ provider: 'openai_compatible' });
    const card = q('[data-assistant-card="openai_compatible"]')!;
    expect(card.querySelector('[data-assistant-price]')).toHaveTextContent(LOCAL_PRICE_TEXT);
    expect(card.querySelector('[data-assistant-privacy-local]')).toHaveTextContent(LOCAL_PRIVACY_TEXT);
    expect(card.querySelector('[data-assistant-effort]')).toBeNull();
    expect(q('[data-assistant-local-limits]')).toHaveTextContent(LOCAL_LIMITS_TEXT);
    // A conversation may still use a cloud provider: its $ limits and spend stay in reach.
    expect(q('[data-assistant-cap-turn-usd]')).toBeTruthy();
    expect(q('[data-assistant-cap-steps]')).toBeTruthy();
    expect(q('[data-assistant-cap-minutes]')).toBeTruthy();
    expect(q('[data-assistant-spent]')).toBeTruthy();
    expect(q('[data-assistant-shared-pc]')).toHaveTextContent(SHARED_PC_TEXT);
    expect(q('[data-assistant-privacy]')).toBeTruthy();
  });
});

describe('AssistantStep cloud', () => {
  it('shows the price, effort, privacy, spend, the shared-PC line and the fallback note', async () => {
    await ready({
      provider: 'anthropic',
      price: { model: 'claude-opus-5-5', known: true, input: 4, output: 20, cache_read: 0.2 },
      prices_as_of: '2026-10-16',
      fallback: true,
      consents: 2,
    });
    expect(q('[data-assistant-price]')).toHaveTextContent('$4.00 in · $20.00 out per million tokens (prices of 2026-10-16).');
    expect(q('[data-assistant-fallback-note]')).toHaveTextContent(FALLBACK_TEXT);
    expect(q('[data-assistant-shared-pc]')).toHaveTextContent(SHARED_PC_TEXT);
    expect(q('[data-assistant-spent]')).toHaveTextContent('Spent today (API keys): $0.42 of $15.00');
    expect(step()).toHaveTextContent('Limits are checked before each step; one step can go a little over.');
    const privacy = q('[data-assistant-privacy]')!;
    expect(within(privacy).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['ask', 'allow', 'deny']);
    expect(privacy).toHaveTextContent('Ask once per project');
    expect(privacy).toHaveTextContent('Always allow');
    expect(privacy).toHaveTextContent('Never send project data');
    fireEvent.click(q('[data-assistant-privacy-option="deny"] input')!);
    await waitFor(() => expect(q('[data-assistant-privacy]')).toHaveAttribute('data-assistant-privacy', 'deny'));
    fireEvent.click(screen.getByRole('button', { name: 'Forget project answers (2)' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget project answers (0)' })).toBeDisabled());
    expect(posts('/api/assistant/settings').at(-1)!.body).toEqual({ forget_consents: true });
    fireEvent.change(q('[data-assistant-effort]')!, { target: { value: 'high' } });
    await waitFor(() => expect(q('[data-assistant-effort]')).toHaveAttribute('data-assistant-effort', 'high'));
  });

  it('Effort is one setting for both cloud providers: shown once, outside every card, and says so (the cards keep their own settings)', async () => {
    await ready({ provider: 'anthropic' });
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    await waitFor(() => expect(q('[data-assistant-card="openai"]')).toHaveAttribute('data-open', '1'));
    expect(document.querySelectorAll('[data-assistant-effort]')).toHaveLength(1);
    expect(q('[data-assistant-card] [data-assistant-effort]')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Effort (Anthropic and OpenAI)' })).toBe(q('[data-assistant-effort]'));
    expect(q('[data-assistant-effort-shared]')!.textContent).toBe(EFFORT_SHARED_TEXT);
    expect(EFFORT_SHARED_TEXT).toBe("One setting for both cloud providers: Anthropic and OpenAI turns both use it. A local server doesn't.");
    fireEvent.change(q('[data-assistant-effort]')!, { target: { value: 'high' } });
    await waitFor(() => expect(q('[data-assistant-effort]')).toHaveAttribute('data-assistant-effort', 'high'));
    expect(posts('/api/assistant/settings').at(-1)!.body).toEqual({ effort: 'high' });
    cleanup();
    resetStatusStore();
    // With no card open (the default Off), it is there all the same.
    await ready();
    expect(document.querySelectorAll('[data-assistant-effort]')).toHaveLength(1);
  });

  it("says when Magnusim doesn't know the model's price; no fallback note without the status saying so", async () => {
    await ready({ provider: 'openai', price: { model: 'gpt-x', known: false }, prices_as_of: '2026-10-16', fallback: false });
    expect(q('[data-assistant-price]')).toHaveTextContent(UNKNOWN_PRICE_TEXT);
    expect(q('[data-assistant-fallback-note]')).toBeNull();
  });

  it.each([
    ['true', true, true],
    ['a list of models', ['claude-opus-5', 'claude-opus-4-8'], true],
    ['{on: true, targets}', { on: true, targets: ['claude-opus-5', 'claude-opus-4-8'] }, true],
    ['{on: false, targets: []}', { on: false, targets: [] }, false],
    ['an object without on', { targets: ['claude-opus-5'] }, false],
    ['false', false, false],
    ['an empty list', [], false],
    ['null', null, false],
    ['a string', 'yes', false],
  ])('the fallback note shows only when the status says it is on: %s', async (_name, fallback, shown) => {
    await ready({ provider: 'anthropic', fallback });
    expect(q('[data-assistant-fallback-note]') !== null).toBe(shown);
  });

  it.each([
    [0.4213, 'Spent today (API keys): $0.42 of $15.00'],
    [0, 'Spent today (API keys): $0.00 of $15.00'],
    [0.0021, 'Spent today (API keys): under $0.01 of $15.00'],
    [0.006, 'Spent today (API keys): $0.01 of $15.00'],
    [12.5, 'Spent today (API keys): $12.50 of $15.00'],
  ])("today's spend is in dollars and cents: %s", async (spent, text) => {
    await ready({ provider: 'anthropic', spent_today_usd: spent });
    expect(q('[data-assistant-spent]')!.textContent).toBe(text);
  });

  it('a limit saves on Enter; an invalid one shows its error and keeps what was typed', async () => {
    await ready({ provider: 'anthropic' });
    const turn = q<HTMLInputElement>('[data-assistant-cap-turn-usd]')!;
    expect(turn.value).toBe('8.00');
    expect(q<HTMLInputElement>('[data-assistant-cap-steps]')!.value).toBe('120');
    expect(q<HTMLInputElement>('[data-assistant-cap-minutes]')!.value).toBe('60');
    fireEvent.change(turn, { target: { value: '2.5' } });
    fireEvent.blur(turn);
    await waitFor(() => expect(q<HTMLInputElement>('[data-assistant-cap-turn-usd]')!.value).toBe('2.50'));
    expect(posts('/api/assistant/settings').at(-1)!.body).toEqual({ caps: { turn_usd: 2.5 } });
    const day = q<HTMLInputElement>('[data-assistant-cap-day-usd]')!;
    fireEvent.change(day, { target: { value: '0.01' } });
    fireEvent.blur(day);
    await waitFor(() => expect(q('[data-assistant-cap-error="day_usd"]')).toHaveTextContent('This limit must be from $0.10 to $1000.00.'));
    expect(q<HTMLInputElement>('[data-assistant-cap-day-usd]')!.value).toBe('0.01');
    expect((status.caps as { day_usd: number }).day_usd).toBe(15);
  });
});

describe('AssistantStep models and Test', () => {
  it('lists the models from the server, and takes another model id', async () => {
    modelsAnswer = { status: 200, body: { ok: true, source: 'curated', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', priced: true }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', priced: true }] } };
    await ready({ provider: 'anthropic' });
    const select = q<HTMLSelectElement>('[data-assistant-model]')!;
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Claude Sonnet 5.5' })).toBeTruthy());
    expect(requests.some((r) => r.path === '/api/assistant/models?provider=anthropic')).toBe(true);
    expect(select.value).toBe('claude-opus-5-5');
    fireEvent.change(select, { target: { value: 'claude-sonnet-5-5' } });
    await waitFor(() => expect(q('[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-sonnet-5-5'));
    fireEvent.change(q('[data-assistant-model]')!, { target: { value: '(other model id)' } });
    const other = await waitFor(() => {
      const el = q<HTMLInputElement>('[data-assistant-model-other]');
      if (!el) throw new Error('no field');
      return el;
    });
    fireEvent.change(other, { target: { value: 'claude-custom-1' } });
    fireEvent.keyDown(other, { key: 'Enter' });
    fireEvent.blur(other);
    await waitFor(() => expect(q('[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-custom-1'));
    expect(q('[data-assistant-model-other]')).toBeNull();
    expect(within(q('[data-assistant-model]')!).getByRole('option', { name: 'claude-custom-1' })).toBeTruthy();
    // Each saved as the card's own provider's model, never the bare (default's) model.
    expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([{ models: { anthropic: 'claude-sonnet-5-5' } }, { models: { anthropic: 'claude-custom-1' } }]);
  });

  it("a non-default card's model save posts its own provider's model, and the default's model is unchanged", async () => {
    modelsAnswer = { status: 200, body: { ok: true, source: 'curated', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', priced: true }, { id: 'gpt-6-luna', label: 'GPT-6 Luna', priced: true }] } };
    await ready({ provider: 'anthropic' });
    fireEvent.click(q('[data-assistant-card-toggle="openai"]')!);
    const select = () => q<HTMLSelectElement>('[data-assistant-card="openai"] [data-assistant-model]')!;
    await waitFor(() => expect(within(select()).getByRole('option', { name: 'GPT-6 Luna' })).toBeTruthy());
    fireEvent.change(select(), { target: { value: 'gpt-6-luna' } });
    await waitFor(() => expect(select()).toHaveAttribute('data-assistant-model', 'gpt-6-luna'));
    expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([{ models: { openai: 'gpt-6-luna' } }]);
    expect(status.models).toEqual({ anthropic: 'claude-opus-5-5', openai: 'gpt-6-luna', openai_compatible: '' });
    expect(q('[data-assistant-card="anthropic"] [data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-opus-5-5');
    // Its Test is its own provider's.
    fireEvent.click(q('[data-assistant-card="openai"] [data-assistant-test]')!);
    await waitFor(() => expect(posts('/api/assistant/test')).toHaveLength(1));
    expect(posts('/api/assistant/test')[0].body).toEqual({ provider: 'openai' });
  });

  it("each card's price and fallback note are its own provider's (prices, fallbacks)", async () => {
    await ready({
      provider: 'openai',
      price: { model: 'gpt-6.1-sol', known: true, input: 2, output: 8 },
      prices: { anthropic: { model: 'claude-opus-5-5', known: true, input: 4, output: 20 }, openai: { model: 'gpt-6.1-sol', known: true, input: 2, output: 8 }, openai_compatible: null },
      prices_as_of: '2026-10-16',
      fallback: { on: false, targets: [] },
      fallbacks: { anthropic: { on: true, targets: ['claude-opus-5'] }, openai: { on: false, targets: [] }, openai_compatible: { on: false, targets: [] } },
    });
    fireEvent.click(q('[data-assistant-card-toggle="anthropic"]')!);
    expect(q('[data-assistant-card="openai"] [data-assistant-price]')).toHaveTextContent('$2.00 in · $8.00 out per million tokens (prices of 2026-10-16).');
    expect(q('[data-assistant-card="anthropic"] [data-assistant-price]')).toHaveTextContent('$4.00 in · $20.00 out per million tokens (prices of 2026-10-16).');
    expect(q('[data-assistant-card="anthropic"] [data-assistant-fallback-note]')).toHaveTextContent(FALLBACK_TEXT);
    expect(q('[data-assistant-card="openai"] [data-assistant-fallback-note]')).toBeNull();
  });

  it('without the models route: the chosen model stays, with no error', async () => {
    await ready({ provider: 'anthropic' });
    await waitFor(() => expect(q('[data-assistant-models-refresh]')).toHaveTextContent('Refresh list'));
    expect(q<HTMLSelectElement>('[data-assistant-model]')!.value).toBe('claude-opus-5-5');
    expect(q('[data-assistant-models-error]')).toBeNull();
  });

  it('a server that does not answer says why the list is missing', async () => {
    modelsAnswer = { status: 502, body: { ok: false, code: 'unreachable', error: 'Nothing answered at http://127.0.0.1:1234/v1.' } };
    await ready({ provider: 'openai_compatible' });
    await waitFor(() => expect(q('[data-assistant-models-error]')).toHaveTextContent("Couldn't list the models: Nothing answered at http://127.0.0.1:1234/v1."));
    expect(q<HTMLSelectElement>('[data-assistant-model]')!.value).toBe('');
    expect(screen.getByRole('option', { name: 'Choose a model' })).toBeDisabled();
  });

  it('a listing the provider refused still offers the models the server sent, and says why', async () => {
    modelsAnswer = {
      status: 502,
      body: {
        ok: false,
        code: 'auth',
        error: 'Anthropic refused the key.',
        models: [
          { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', priced: true },
          { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', priced: true },
        ],
      },
    };
    await ready({ provider: 'anthropic' });
    await waitFor(() => expect(q('[data-assistant-models-error]')).toHaveTextContent("Couldn't list the models: Anthropic refused the key."));
    const select = q<HTMLSelectElement>('[data-assistant-model]')!;
    expect(within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      '(other model id)',
    ]);
    expect(select.value).toBe('claude-opus-5-5');
    fireEvent.change(select, { target: { value: 'claude-sonnet-5-5' } });
    await waitFor(() => expect(q('[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-sonnet-5-5'));
  });

  it.each([
    ['works', 'openai_compatible', true, 'Tool calling works.'],
    ['ok', 'anthropic', true, 'Tool calling works.'],
    [true, 'openai', true, 'Tool calling works.'],
    ['as_text', 'openai_compatible', false, AS_TEXT_TEXT],
    ['not_used', 'openai_compatible', false, TEMPLATE_TEXT],
    [false, 'openai_compatible', false, TEMPLATE_TEXT],
    ['not_used', 'anthropic', false, NOT_USED_TEXT],
    ['not_used', 'openai', false, NOT_USED_TEXT],
  ])('the Test reads the tool verdict %s from %s', (tools, provider, works, sentence) => {
    const line = testLine({ ok: true, model: 'm-1', ms: 1000, tools: tools as 'works' }, provider as 'anthropic');
    expect(line.ok).toBe(works);
    expect(line.text).toBe(`Connected to m-1 in 1.0 s. ${sentence}`);
  });

  it('only a local model is told about chat templates; a model that wrote the call as text is told so', () => {
    const asText = testLine({ ok: true, model: 'qwen', ms: 2000, tools: 'as_text' }, 'openai_compatible').text;
    expect(asText).toContain('wrote the tool call as text');
    expect(asText).toContain("its chat template doesn't support tool calls");
    const cloud = testLine({ ok: true, model: 'claude-opus-5-5', ms: 2000, tools: 'not_used' }, 'anthropic').text;
    expect(cloud).not.toContain('template');
    expect(cloud).not.toContain('LM Studio');
  });

  it.each([
    [0.0021, false, '($0.0021)'],
    [0.00002, false, '(under $0.0001)'],
    [0.0021, true, '(about $0.0021)'],
  ])('the Test cost %s (estimated %s) reads %s', (cost, estimated, shown) => {
    const line = testLine({ ok: true, model: 'm-1', ms: 1400, tools: 'works', cost_usd: cost, estimated } as never, 'anthropic');
    expect(line.text).toBe(`Connected to m-1 in 1.4 s ${shown}. Tool calling works.`);
  });

  it('shows a command in a server sentence as code, and text with a lone backtick as it came', () => {
    const { container } = render(<p>{withCode('Ollama: `ollama serve` and test again.')}</p>);
    expect(container.querySelector('code')).toHaveTextContent(/^ollama serve$/);
    expect(container).toHaveTextContent('Ollama: ollama serve and test again.');
    cleanup();
    const lone = render(<p>{withCode('a ` b')}</p>);
    expect(lone.container.querySelector('code')).toBeNull();
    expect(lone.container).toHaveTextContent('a ` b');
  });

  it('a verdict the page does not know claims neither way', () => {
    const line = testLine({ ok: true, model: 'm-1', ms: 1000, tools: 'maybe' as 'works' });
    expect(line).toEqual({ ok: true, text: 'Connected to m-1 in 1.0 s.' });
  });

  it('Test shows the connection, its time and cost, and reads the spend again', async () => {
    testAnswer = { status: 200, body: { ok: true, model: 'claude-opus-5-5', served_by: 'claude-opus-5-5', ms: 1432, tools: 'works', cost_usd: 0.0021 } };
    await ready({ provider: 'anthropic' });
    const gets = () => requests.filter((r) => r.path === '/api/assistant/status').length;
    const before = gets();
    status = { ...status, spent_today_usd: 0.4221 };
    fireEvent.click(q('[data-assistant-test]')!);
    const result = q('[data-assistant-test-result]')!;
    expect(result).toHaveAttribute('role', 'status');
    await waitFor(() => expect(result).toHaveTextContent('Connected to claude-opus-5-5 in 1.4 s ($0.0021). Tool calling works.'));
    expect(result).toHaveAttribute('data-assistant-test-result', 'ok');
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(q('[data-assistant-spent]')).toHaveTextContent('Spent today (API keys): $0.42 of $15.00'));
  });

  it('Test says when the model did not call the tool, and shows an error as it came', async () => {
    testAnswer = { status: 200, body: { ok: true, model: 'qwen3.8-27b', ms: 2100, tools: 'not_used', cost_usd: 0 } };
    await ready({ provider: 'openai_compatible', models: { anthropic: 'a', openai: 'b', openai_compatible: 'qwen3.8-27b' } });
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(q('[data-assistant-test-result]')).toHaveTextContent(/^Connected to qwen3\.8-27b in 2\.1 s\. But the model didn't call the test tool/));
    expect(q('[data-assistant-test-result]')).toHaveTextContent('chat template');
    testAnswer = { status: 502, body: { ok: false, code: 'unreachable', error: 'Nothing answered at http://127.0.0.1:1234/v1.' } };
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(q('[data-assistant-test-result]')).toHaveTextContent('Nothing answered at http://127.0.0.1:1234/v1.'));
    expect(q('[data-assistant-test-result]')).toHaveAttribute('data-assistant-test-result', 'failed');
  });

  it("a local server that doesn't answer: the sentence as the server wrote it, its command shown as code", async () => {
    const nothing =
      'Nothing answered at http://127.0.0.1:1234/v1. Start the server (LM Studio: Developer → Start server; Ollama: `ollama serve`) and test again.';
    testAnswer = { status: 200, body: { ok: false, code: 'unreachable', error: nothing, cost_usd: 0 } };
    modelsAnswer = { status: 502, body: { ok: false, code: 'unreachable', error: nothing, models: [] } };
    await ready({ provider: 'openai_compatible', models: { anthropic: 'a', openai: 'b', openai_compatible: 'qwen3.8-27b' } });
    await waitFor(() => expect(q('[data-assistant-models-error]')).toBeTruthy());
    expect(q('[data-assistant-models-error]')!.textContent).toBe(`Couldn't list the models: ${nothing.replace(/`/g, '')}`);
    expect(q('[data-assistant-models-error] code')).toHaveTextContent(/^ollama serve$/);
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(q('[data-assistant-test-result]')).toHaveAttribute('data-assistant-test-result', 'failed'));
    const result = q('[data-assistant-test-result]')!;
    expect(result.textContent).toBe(
      'Nothing answered at http://127.0.0.1:1234/v1. Start the server (LM Studio: Developer → Start server; Ollama: ollama serve) and test again.',
    );
    expect(result.querySelector('code')).toHaveTextContent(/^ollama serve$/);
    expect(result.innerHTML).not.toContain('`');
  });

  it('a key saved or removed reads the model list again (with a key the provider lists its own)', async () => {
    modelsAnswer = { status: 200, body: { ok: true, source: 'curated', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', priced: true }] } };
    await ready({ provider: 'anthropic' });
    const lists = () => requests.filter((r) => r.path === '/api/assistant/models?provider=anthropic').length;
    await waitFor(() => expect(lists()).toBe(1));
    modelsAnswer = {
      status: 200,
      body: {
        ok: true,
        source: 'provider',
        models: [
          { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', priced: true },
          { id: 'claude-next-1', label: 'claude-next-1', priced: false },
        ],
      },
    };
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    input.value = 'sk-ant-e2e-0123456789-abcd';
    fireEvent.click(q('[data-assistant-key-save]')!);
    await waitFor(() => expect(lists()).toBe(2));
    await waitFor(() => expect(within(q('[data-assistant-model]')!).getByRole('option', { name: 'claude-next-1' })).toBeTruthy());
    // Another provider's key, arriving with another change's answer, changes nothing here.
    status = { ...status, keys: { ...(status.keys as object), openai: { set: true, last4: 'zzzz', set_at: 'later', state: 'ok' } } };
    fireEvent.change(q('[data-assistant-effort]')!, { target: { value: 'low' } });
    await waitFor(() => expect(q('[data-assistant-effort]')).toHaveAttribute('data-assistant-effort', 'low'));
    await Promise.resolve();
    expect(lists()).toBe(2);
    confirmAction.mockResolvedValueOnce(true);
    fireEvent.click(q('[data-assistant-key-remove]')!);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('No key'));
    await waitFor(() => expect(lists()).toBe(3));
  });

  it('a Test result goes when the model, the address or the key changes; it stays while nothing did', async () => {
    testAnswer = { status: 200, body: { ok: true, model: 'qwen3.8-27b', served_by: 'qwen3.8-27b', ms: 900, tools: 'works', cost_usd: 0 } };
    modelsAnswer = { status: 200, body: { ok: true, source: 'server', models: [{ id: 'qwen3.8-27b', label: 'qwen3.8-27b', priced: true }, { id: 'gemma-4-31b', label: 'gemma-4-31b', priced: true }] } };
    await ready({ provider: 'openai_compatible', models: { anthropic: 'a', openai: 'b', openai_compatible: 'qwen3.8-27b' } });
    const result = () => q('[data-assistant-test-result]')!;
    const tested = async () => {
      fireEvent.click(q('[data-assistant-test]')!);
      await waitFor(() => expect(result()).toHaveTextContent('Connected to qwen3.8-27b in 0.9 s. Tool calling works.'));
    };
    await tested();
    // Another setting (privacy here is local, so a limit) leaves it.
    const steps = q<HTMLInputElement>('[data-assistant-cap-steps]')!;
    fireEvent.change(steps, { target: { value: '20' } });
    fireEvent.blur(steps);
    await waitFor(() => expect(q<HTMLInputElement>('[data-assistant-cap-steps]')!.value).toBe('20'));
    expect(result()).toHaveTextContent('Tool calling works.');

    await waitFor(() => expect(within(q('[data-assistant-model]')!).getByRole('option', { name: 'gemma-4-31b' })).toBeTruthy());
    fireEvent.change(q('[data-assistant-model]')!, { target: { value: 'gemma-4-31b' } });
    await waitFor(() => expect(q('[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'gemma-4-31b'));
    expect(result()).toHaveAttribute('data-assistant-test-result', 'idle');
    expect(result().textContent).toBe('');

    await tested();
    fireEvent.click(q('[data-assistant-endpoint-preset="ollama"]')!);
    await waitFor(() => expect(q<HTMLInputElement>('[data-assistant-endpoint]')!.value).toBe('http://127.0.0.1:11434/v1'));
    expect(result()).toHaveAttribute('data-assistant-test-result', 'idle');

    await tested();
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    input.value = 'server-token-1';
    fireEvent.click(q('[data-assistant-key-save]')!);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Token set'));
    expect(result()).toHaveAttribute('data-assistant-test-result', 'idle');
  });

  it("a Test that finds the saved key can't be opened keeps saying so; a key saved again starts afresh", async () => {
    const refusal = "The saved key can't be decrypted on this account. Enter it again.";
    const saved = { set: true, last4: 'abcd', set_at: '2026-10-16T09:00:00.000Z' };
    testAnswer = { status: 400, body: { ok: false, code: 'no_key', error: refusal } };
    await ready({ provider: 'anthropic', keys: { anthropic: { ...saved, state: 'ok' }, openai: NO_KEY, openai_compatible: NO_KEY } });
    // The server learns that the key can't be opened only when it tries it: here, on the Test.
    onTest = () => {
      status = { ...status, keys: { ...(status.keys as object), anthropic: { ...saved, state: 'unreadable' } } };
    };
    const reads = () => requests.filter((r) => r.path === '/api/assistant/status').length;
    const before = reads();
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent("Your saved key can't be decrypted"));
    const result = () => q('[data-assistant-test-result]')!;
    expect(result()).toHaveAttribute('data-assistant-test-result', 'failed');
    expect(result()).toHaveTextContent(refusal);

    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    input.value = 'sk-ant-e2e-0123456789-wxyz';
    fireEvent.click(q('[data-assistant-key-save]')!);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …wxyz'));
    expect(result()).toHaveAttribute('data-assistant-test-result', 'idle');
    expect(result().textContent).toBe('');
  });

  it('a server without the Test route says so plainly', async () => {
    await ready({ provider: 'anthropic' });
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(q('[data-assistant-test-result]')).toHaveTextContent("This copy of Magnusim can't test the connection yet."));
  });
});

describe('AssistantStep leaving the step', () => {
  it('a key pasted but not saved is saved when the step is left, and the leave waits for it', async () => {
    await ready({ provider: 'anthropic' });
    // Nothing held, nothing on its way: the step may go at once.
    expect(settleStep()).toBe(true);
    holdKey = {};
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    input.value = CANARY;
    const settled = settleStep();
    expect(settled).not.toBe(true);
    // Sent as Save sends it: read and cleared before the save is on its way.
    expect(input.value).toBe('');
    await waitFor(() => expect(posts('/api/assistant/key')).toHaveLength(1));
    expect(posts('/api/assistant/key')[0].body).toEqual({ provider: 'anthropic', key: CANARY });
    let left: boolean | null = null;
    void (settled as Promise<boolean>).then((ok) => (left = ok));
    await act(async () => {
      await Promise.resolve();
    });
    expect(left).toBeNull();
    act(() => holdKey!.release!());
    expect(await settled).toBe(true);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …1234'));
    expect(document.body.innerHTML).not.toContain(CANARY);
  });

  it('a change on its way is waited for; refused, it keeps the step with its reason, and the next leave goes', async () => {
    await ready({ provider: 'anthropic' });
    holdSettings = {};
    const steps = q<HTMLInputElement>('[data-assistant-cap-steps]')!;
    fireEvent.change(steps, { target: { value: '500' } });
    // Pressing Next blurs the field first: its save starts, then the leave asks.
    fireEvent.blur(steps);
    const settled = settleStep();
    expect(settled).not.toBe(true);
    await waitFor(() => expect(holdSettings!.release).toBeTypeOf('function'));
    act(() => holdSettings!.release!());
    expect(await settled).toBe(false);
    await waitFor(() => expect(q('[data-assistant-cap-error="steps"]')).toHaveTextContent('This limit must be a whole number from 1 to 200.'));
    expect(q<HTMLInputElement>('[data-assistant-cap-steps]')!.value).toBe('500');
    // Pressed again: the refusal is on screen and nothing is on its way.
    expect(settleStep()).toBe(true);
  });

  it('a key saved with a warning keeps the step with the warning (sent by the leave, or a Save on its way), and the next leave goes', async () => {
    await ready({ provider: 'anthropic' });
    const input = q<HTMLInputElement>('[data-assistant-key-input]')!;
    // Pasted, not saved: the leave sends it, the server saves it and warns.
    input.value = 'sk-proj-thisisanopenaikey00009999';
    const settled = settleStep();
    expect(settled).not.toBe(true);
    expect(await settled).toBe(false);
    await waitFor(() => expect(q('[data-assistant-key-warning]')).toHaveTextContent("This doesn't look like an Anthropic key."));
    expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …9999');
    expect(posts('/api/assistant/key')).toHaveLength(1);
    // Pressed again: the warning is on screen and nothing is on its way.
    expect(settleStep()).toBe(true);
    expect(q('[data-assistant-key-warning]')).toHaveTextContent("This doesn't look like an Anthropic key.");

    // Save pressed, and the leave asks while it is on its way.
    holdKey = {};
    input.value = 'sk-proj-anotheropenaikey00008888';
    fireEvent.click(q('[data-assistant-key-save]')!);
    const again = settleStep();
    expect(again).not.toBe(true);
    await waitFor(() => expect(holdKey!.release).toBeTypeOf('function'));
    act(() => holdKey!.release!());
    expect(await again).toBe(false);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('Key set, ends in …8888'));
    expect(q('[data-assistant-key-warning]')).toHaveTextContent("This doesn't look like an Anthropic key.");
    expect(posts('/api/assistant/key')).toHaveLength(2);
    expect(settleStep()).toBe(true);
  });

  it('a server on another computer: the leave waits for the question and the save its answer makes', async () => {
    await ready({ provider: 'openai_compatible' });
    let answer!: (yes: boolean) => void;
    confirmAction.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    const field = q<HTMLInputElement>('[data-assistant-endpoint]')!;
    fireEvent.change(field, { target: { value: 'http://192.168.1.50:1234/v1' } });
    fireEvent.blur(field);
    const settled = settleStep();
    expect(settled).not.toBe(true);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    answer(true);
    expect(await settled).toBe(true);
    expect(posts('/api/assistant/settings').at(-1)!.body).toEqual({ base_url: 'http://192.168.1.50:1234/v1', confirm_remote: true });
    expect(status.base_url).toBe('http://192.168.1.50:1234/v1');
  });
});

describe('AssistantStep keyboard and screen readers', () => {
  /** The app's dialog: it takes focus, and closing it leaves focus nowhere. */
  const dialog = (yes: boolean) => async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await Promise.resolve();
    button.remove();
    return yes;
  };

  it('after the question about a server on another computer, focus is back on the address', async () => {
    await ready({ provider: 'openai_compatible' });
    confirmAction.mockImplementationOnce(dialog(false));
    const field = q<HTMLInputElement>('[data-assistant-endpoint]')!;
    field.focus();
    fireEvent.change(field, { target: { value: 'http://192.168.1.50:1234/v1' } });
    // Enter saves (the field blurs, and its save asks).
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(q<HTMLInputElement>('[data-assistant-endpoint]')!.value).toBe('http://127.0.0.1:1234/v1'));
    expect(document.activeElement).toBe(q('[data-assistant-endpoint]'));
  });

  it('after Remove key, focus is on the key field (the Remove button went with the key)', async () => {
    await ready({ provider: 'anthropic', keys: { anthropic: { set: true, last4: 'abcd', set_at: 'x', state: 'ok' }, openai: NO_KEY, openai_compatible: NO_KEY } });
    confirmAction.mockImplementationOnce(dialog(true));
    const remove = q<HTMLButtonElement>('[data-assistant-key-remove]')!;
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(q('[data-assistant-key-status]')).toHaveTextContent('No key'));
    expect(q('[data-assistant-key-remove]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-assistant-key-input]'));
  });

  it('Cancel on Remove key puts focus back on Remove', async () => {
    await ready({ provider: 'anthropic', keys: { anthropic: { set: true, last4: 'abcd', set_at: 'x', state: 'ok' }, openai: NO_KEY, openai_compatible: NO_KEY } });
    confirmAction.mockImplementationOnce(dialog(false));
    const remove = q<HTMLButtonElement>('[data-assistant-key-remove]')!;
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement).toBe(remove));
  });

  it("each field with a refusal is invalid and described by the refusal's line", async () => {
    await ready({ provider: 'anthropic' });
    const key = q<HTMLInputElement>('[data-assistant-key-input]')!;
    expect(key).not.toHaveAttribute('aria-invalid');
    fireEvent.click(q('[data-assistant-key-save]')!);
    await waitFor(() => expect(q('[data-assistant-key-error]')).toHaveTextContent('Paste the key first.'));
    expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)).toBe(q('[data-assistant-key-error]'));

    const day = q<HTMLInputElement>('[data-assistant-cap-day-usd]')!;
    fireEvent.change(day, { target: { value: '0.01' } });
    fireEvent.blur(day);
    await waitFor(() => expect(q('[data-assistant-cap-error="day_usd"]')).toBeTruthy());
    const dayNow = q<HTMLInputElement>('[data-assistant-cap-day-usd]')!;
    expect(dayNow).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(dayNow.getAttribute('aria-describedby')!)).toBe(q('[data-assistant-cap-error="day_usd"]'));

    cleanup();
    await ready({ provider: 'openai_compatible' });
    const field = q<HTMLInputElement>('[data-assistant-endpoint]')!;
    // The server refuses the address outright.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/assistant/settings'
        ? json(400, { ok: false, code: 'invalid', error: 'The address must start with http:// or https://.', field: 'base_url' })
        : inner(input, init),
    );
    fireEvent.change(field, { target: { value: 'ftp://127.0.0.1/v1' } });
    fireEvent.blur(field);
    await waitFor(() => expect(q('[data-assistant-endpoint-error]')).toHaveTextContent('The address must start with http:// or https://.'));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)).toBe(q('[data-assistant-endpoint-error]'));
  });
});

describe('AssistantStep limits as saved', () => {
  const caps = { turn_usd: 0.125, day_usd: 0.125, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 };

  it('a $ limit with a third decimal shows as it is enforced, and tabbing through the limits saves nothing', async () => {
    await ready({ provider: 'anthropic', caps, spent_today_usd: 0.1 });
    const turn = q<HTMLInputElement>('[data-assistant-cap-turn-usd]')!;
    const day = q<HTMLInputElement>('[data-assistant-cap-day-usd]')!;
    expect(turn.value).toBe('0.125');
    expect(day.value).toBe('0.125');
    expect(q('[data-assistant-spent]')!.textContent).toBe('Spent today (API keys): $0.10 of $0.125');
    for (const el of [turn, day, q<HTMLInputElement>('[data-assistant-cap-steps]')!, q<HTMLInputElement>('[data-assistant-cap-minutes]')!]) {
      fireEvent.focus(el);
      fireEvent.blur(el);
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts('/api/assistant/settings')).toEqual([]);
    expect(document.querySelector('[data-assistant-cap-error]')).toBeNull();
    expect((status.caps as typeof caps).turn_usd).toBe(0.125);
  });
});

describe('AssistantStep a local-server address on another computer', () => {
  it("says where the server is, claims no cost, and says the $ limits don't apply to it", async () => {
    await ready({ provider: 'openai_compatible', base_url: 'https://llm.example.net/v1', base_url_is_local: false });
    const card = q('[data-assistant-card="openai_compatible"]')!;
    expect(card).toHaveTextContent('Local server');
    expect(q('[data-assistant-card-copy="openai_compatible"]')!.textContent).toBe('Your server at llm.example.net, not on this PC. Project data you ask about goes there.');
    expect(card).not.toHaveTextContent('Project data stays here');
    expect(card.querySelector('[data-assistant-privacy-local]')).toBeNull();
    expect(q('[data-assistant-price]')!.textContent).toBe(SERVER_PRICE_TEXT);
    expect(q('[data-assistant-server-limits]')!.textContent).toBe(SERVER_LIMITS_TEXT);
    expect(q('[data-assistant-local-limits]')).toBeNull();
    expect(step()).not.toHaveTextContent(/No cost|cost nothing/);
    // Project data is asked about, and the line says all of what goes there and to whom.
    expect(q('[data-assistant-privacy]')).toBeTruthy();
    expect(q('[data-assistant-privacy-copy]')!.textContent).toBe(PRIVACY_COPY);
    expect(PRIVACY_COPY).toContain("a local server that isn't on this PC");
    expect(PRIVACY_COPY).toContain('(names, settings, results and pictures of the open workspace)');
    // On this PC again: the plain lines.
    cleanup();
    await ready({ provider: 'openai_compatible' });
    expect(q('[data-assistant-card-copy="openai_compatible"]')).toHaveTextContent('LM Studio or Ollama on this PC. Project data stays here.');
    expect(q('[data-assistant-price]')!.textContent).toBe(LOCAL_PRICE_TEXT);
    expect(q('[data-assistant-local-limits]')!.textContent).toBe(LOCAL_LIMITS_TEXT);
    expect(q('[data-assistant-server-limits]')).toBeNull();
  });
});

describe('AssistantStep a Test nobody waits for', () => {
  it('is let go when the Test block starts afresh for another model, and when the step goes', async () => {
    modelsAnswer = {
      status: 200,
      body: {
        ok: true,
        source: 'curated',
        models: [
          { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', priced: true },
          { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', priced: true },
        ],
      },
    };
    await ready({ provider: 'anthropic' });
    holdTest = true;
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(testSignals).toHaveLength(1));
    expect(q('[data-assistant-test-result]')).toHaveAttribute('data-assistant-test-result', 'running');
    expect(testSignals[0]?.aborted).toBe(false);
    // Another model: the block starts afresh, and the old Test is let go.
    await waitFor(() => expect(within(q('[data-assistant-model]')!).getByRole('option', { name: 'Claude Sonnet 5.5' })).toBeTruthy());
    fireEvent.change(q('[data-assistant-model]')!, { target: { value: 'claude-sonnet-5-5' } });
    await waitFor(() => expect(q('[data-assistant-model]')).toHaveAttribute('data-assistant-model', 'claude-sonnet-5-5'));
    expect(testSignals[0]?.aborted).toBe(true);
    expect(q('[data-assistant-test-result]')).toHaveAttribute('data-assistant-test-result', 'idle');
    // The step goes (Next, Back, Close, a reload).
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(testSignals).toHaveLength(2));
    expect(testSignals[1]?.aborted).toBe(false);
    cleanup();
    expect(testSignals[1]?.aborted).toBe(true);
  });
});

describe('AssistantStep problem report', () => {
  const LOG = { on: false, env: false, folder: 'D:/Magnusim home/assistant/logs' };

  it('the provider log switch: off by default with what it keeps, saved at once; Open log folder asks the server to show it', async () => {
    await ready({ provider_log: LOG });
    const block = q('[data-assistant-provider-log]')!;
    expect(block.getAttribute('data-assistant-provider-log')).toBe('off');
    expect(within(block).getByText(PROVIDER_LOG_LABEL)).toBeTruthy();
    expect(block.textContent).toContain(PROVIDER_LOG_TEXT);
    expect(q('[data-assistant-log-folder-path]')!.textContent).toBe(`Kept in ${LOG.folder}`);
    expect(q('[data-assistant-provider-log-env]')).toBeNull();
    const sw = q<HTMLInputElement>('[data-assistant-provider-log-switch]')!;
    expect(sw.checked).toBe(false);
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([{ provider_log: true }]));
    await waitFor(() => expect(q('[data-assistant-provider-log]')!.getAttribute('data-assistant-provider-log')).toBe('on'));
    await act(async () => {
      fireEvent.click(within(q('[data-assistant-provider-log]')!).getByRole('button', { name: OPEN_LOG_FOLDER }));
    });
    await waitFor(() => expect(posts('/api/assistant/log-folder/open')).toHaveLength(1));
    expect(q('[data-assistant-provider-log-error]')).toBeNull();
  });

  it('MAGNUSIM_ASSISTANT_DEBUG_LOG set: the step says the log is on whatever the switch says; an older server shows no block', async () => {
    await ready({ provider_log: { ...LOG, env: true } });
    expect(q('[data-assistant-provider-log-env]')!.textContent).toBe(PROVIDER_LOG_ENV_TEXT);
    cleanup();
    resetStatusStore();
    await ready();
    expect(q('[data-assistant-provider-log]')).toBeNull();
  });
});
