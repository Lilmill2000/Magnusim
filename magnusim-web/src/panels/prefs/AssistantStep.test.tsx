import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_TEXT } from '../../assistant/api';
import { resetStatusStore, statusSnapshot } from '../../assistant/status';
import {
  AssistantStep,
  DEPS_TEXT,
  FALLBACK_TEXT,
  LOCAL_LIMITS_TEXT,
  LOCAL_PRICE_TEXT,
  LOCAL_PRIVACY_TEXT,
  SHARED_PC_TEXT,
  testLine,
  UNKNOWN_PRICE_TEXT,
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
    caps: { turn_usd: 3, day_usd: 15, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 },
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
  if ('effort' in patch) next.effort = patch.effort;
  if ('privacy' in patch) next.privacy = patch.privacy;
  if ('forget_consents' in patch) next.consents = 0;
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
    next.caps = caps;
  }
  status = next;
  return { status: 200, body: status };
}

async function route(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  if (path === '/api/assistant/status') return statusAnswer || { status: 200, body: status };
  if (path === '/api/assistant/settings') return applySettings(body);
  if (path === '/api/assistant/key') {
    if (holdKey) await new Promise<void>((r) => (holdKey!.release = r));
    const key = String(body.key);
    status = { ...status, keys: { ...(status.keys as object), [String(body.provider)]: { set: true, last4: key.slice(-4), set_at: 'now', state: 'ok' } } };
    return { status: 200, body: { ...status, ...(key.startsWith('sk-ant-') ? {} : { warning: "This doesn't look like an Anthropic key." }) } };
  }
  if (path === '/api/assistant/key/remove') {
    status = { ...status, keys: { ...(status.keys as object), [String(body.provider)]: NO_KEY } };
    return { status: 200, body: status };
  }
  if (path.startsWith('/api/assistant/models')) return modelsAnswer;
  if (path === '/api/assistant/test') return testAnswer;
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      requests.push({ method, path: url, body });
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
  it('says it is checking while the status is read, then shows the providers with Off chosen', async () => {
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
    const group = screen.getByRole('radiogroup', { name: 'Assistant provider' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(q<HTMLInputElement>('[data-assistant-provider-option="off"] input')!.checked).toBe(true);
    expect(group).toHaveTextContent('LM Studio or Ollama on this PC. Project data stays here.');
    expect(group).toHaveTextContent('Claude models with your API key. Project data you ask about goes to Anthropic.');
    expect(group).toHaveTextContent('GPT models with your API key. Project data you ask about goes to OpenAI.');
    // Off: nothing else to set.
    expect(q('[data-assistant-key]')).toBeNull();
    expect(q('[data-assistant-model]')).toBeNull();
    expect(q('[data-assistant-test]')).toBeNull();
    expect(q('[data-assistant-limits]')).toBeNull();
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

  it('choosing a provider saves it at once', async () => {
    await ready();
    fireEvent.click(q('[data-assistant-provider-option="anthropic"] input')!);
    await waitFor(() => expect(q('[data-assistant-provider]')).toHaveAttribute('data-assistant-provider', 'anthropic'));
    expect(posts('/api/assistant/settings').map((r) => r.body)).toEqual([{ provider: 'anthropic' }]);
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
    fireEvent.click(q('[data-assistant-provider-option="openai"] input')!);
    await waitFor(() => expect(q('[data-assistant-key="openai"]')).toBeTruthy());
    expect(q('[data-assistant-key-status]')).toHaveTextContent("Your saved key can't be decrypted on this Windows account. Enter it again.");
    expect(q('[data-assistant-storage]')).toHaveTextContent('Encrypted for your Windows account.');
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
    const local = q<HTMLInputElement>('[data-assistant-provider-option="openai_compatible"] input')!;
    expect(local.disabled).toBe(false);
    fireEvent.click(local);
    await waitFor(() => expect(q('[data-assistant-endpoint]')).toBeTruthy());
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

  it('on this PC: no cost, data stays here, and only the step and time limits', async () => {
    await ready({ provider: 'openai_compatible' });
    expect(q('[data-assistant-price]')).toHaveTextContent(LOCAL_PRICE_TEXT);
    expect(q('[data-assistant-privacy-local]')).toHaveTextContent(LOCAL_PRIVACY_TEXT);
    expect(q('[data-assistant-local-limits]')).toHaveTextContent(LOCAL_LIMITS_TEXT);
    expect(q('[data-assistant-cap-turn-usd]')).toBeNull();
    expect(q('[data-assistant-cap-steps]')).toBeTruthy();
    expect(q('[data-assistant-cap-minutes]')).toBeTruthy();
    expect(q('[data-assistant-spent]')).toBeNull();
    expect(q('[data-assistant-shared-pc]')).toBeNull();
    expect(q('[data-assistant-effort]')).toBeNull();
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
    expect(q('[data-assistant-spent]')).toHaveTextContent('Spent today: $0.42 of $15.00');
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
    [0.4213, 'Spent today: $0.42 of $15.00'],
    [0, 'Spent today: $0.00 of $15.00'],
    [0.0021, 'Spent today: under $0.01 of $15.00'],
    [0.006, 'Spent today: $0.01 of $15.00'],
    [12.5, 'Spent today: $12.50 of $15.00'],
  ])("today's spend is in dollars and cents: %s", async (spent, text) => {
    await ready({ provider: 'anthropic', spent_today_usd: spent });
    expect(q('[data-assistant-spent]')!.textContent).toBe(text);
  });

  it('a limit saves on Enter; an invalid one shows its error and keeps what was typed', async () => {
    await ready({ provider: 'anthropic' });
    const turn = q<HTMLInputElement>('[data-assistant-cap-turn-usd]')!;
    expect(turn.value).toBe('3.00');
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
    expect(posts('/api/assistant/settings').filter((r) => 'model' in r.body)).toHaveLength(2);
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
    ['works', true, 'Tool calling works.'],
    ['ok', true, 'Tool calling works.'],
    [true, true, 'Tool calling works.'],
    ['not_used', false, "But the model didn't call the test tool"],
    ['as_text', false, "But the model didn't call the test tool"],
    [false, false, "But the model didn't call the test tool"],
  ])('the Test reads the tool verdict %s', (tools, works, sentence) => {
    const line = testLine({ ok: true, model: 'm-1', ms: 1000, tools: tools as 'works' });
    expect(line.ok).toBe(works);
    expect(line.text.startsWith('Connected to m-1 in 1.0 s. ')).toBe(true);
    expect(line.text).toContain(sentence);
    expect(line.text.includes('Tool calling works.')).toBe(works);
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
    await waitFor(() => expect(q('[data-assistant-spent]')).toHaveTextContent('Spent today: $0.42 of $15.00'));
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

  it('a server without the Test route says so plainly', async () => {
    await ready({ provider: 'anthropic' });
    fireEvent.click(q('[data-assistant-test]')!);
    await waitFor(() => expect(q('[data-assistant-test-result]')).toHaveTextContent("This copy of Magnusim can't test the connection yet."));
  });
});
