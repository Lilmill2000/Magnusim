import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshStatus, resetStatusStore, useAssistantStatus } from '../../assistant/status';
import type { AssistantStatus } from '../../assistant/wire';
import { AssistantStep } from './AssistantStep';
import {
  AssistantStepMcp,
  connectionLine,
  MCP_AGENTS_TEXT,
  MCP_COPIED_TEXT,
  MCP_DEPS_TEXT,
  MCP_NONE_TEXT,
  MCP_POLL_MS,
  MCP_RULES_TEXT,
  MCP_SNIPPET_INTRO,
  MCP_SWITCH_LABEL,
  mcpReasonText,
} from './AssistantStepMcp';

vi.mock('../../workbench/dialogs', () => ({ confirmAction: vi.fn(async () => false) }));

const NO_KEY = { set: false, last4: null, set_at: null, state: 'none' };
const INFO = 'C:\\Users\\me\\AppData\\Roaming\\Magnusim\\assistant\\mcp.json';
const BRIDGE = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Magnusim\\magnusim-web\\scripts\\assistant-mcp.mjs', '--info', INFO] };
const SNIPPET = JSON.stringify({ mcpServers: { 'magnusim-apps': BRIDGE } }, null, 2);

type Answer = { status: number; body: unknown };
type Request = { method: string; path: string; body: Record<string, unknown> };

let status: Record<string, unknown>;
let mcp: Record<string, unknown>;
let requests: Request[];
let settingsAnswer: Answer | null;

function baseStatus(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    available: true,
    provider: 'off',
    models: { anthropic: 'm-1', openai: 'm-2', openai_compatible: '' },
    base_url: 'http://127.0.0.1:1234/v1',
    base_url_is_local: true,
    effort: 'default',
    privacy: 'ask',
    consents: 0,
    caps: { turn_usd: 3, day_usd: 15, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 },
    keys: { anthropic: NO_KEY, openai: NO_KEY, openai_compatible: NO_KEY },
    storage: { kind: 'file', reason: null, note: '' },
    keys_notice: null,
    spent_today_usd: 0,
    test_protector: null,
    mcp: { clients: false, running: true, reason: null, port: 49152, connected: 0 },
    ...extra,
  };
}

const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s, headers: { 'Content-Type': 'application/json' } });

function mcpAnswer(): Record<string, unknown> {
  const m = status.mcp as Record<string, unknown>;
  return { ok: true, clients: m.clients, running: m.running, reason: m.reason, port: m.port, bridge: BRIDGE, snippet: SNIPPET, connections: [], ...mcp };
}

async function route(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  if (path === '/api/assistant/status') return { status: 200, body: status };
  if (path === '/api/assistant/mcp') return { status: 200, body: mcpAnswer() };
  if (path === '/api/assistant/settings') {
    if (settingsAnswer) return settingsAnswer;
    const m = { ...(status.mcp as Record<string, unknown>) };
    const patch = body.mcp as Record<string, unknown> | undefined;
    if (patch && typeof patch.clients === 'boolean') m.clients = patch.clients;
    status = { ...status, mcp: m };
    return { status: 200, body: status };
  }
  return { status: 404, body: { ok: false, error: 'not found' } };
}

beforeEach(() => {
  resetStatusStore();
  status = baseStatus();
  mcp = {};
  requests = [];
  settingsAnswer = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      requests.push({ method, path: url, body });
      const a = await route(method, url.split('?')[0], body);
      return json(a.status, a.body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const reads = () => requests.filter((r) => r.method === 'GET' && r.path === '/api/assistant/mcp').length;
const block = () => q('[data-assistant-mcp]')!;
const toggle = () => q<HTMLInputElement>('[data-assistant-mcp-switch]')!;

/** The block on the step's status store, as the step shows it: every save's answer shows. */
function Live() {
  const snap = useAssistantStatus();
  useEffect(() => {
    void refreshStatus();
  }, []);
  return snap.state === 'ready' ? <AssistantStepMcp status={snap.status} /> : null;
}

async function renderBlock(extra: Record<string, unknown> = {}) {
  status = baseStatus(extra);
  const view = render(<Live />);
  await waitFor(() => expect(q('[data-assistant-mcp]')).toBeTruthy());
  return view;
}

describe('Settings → Assistant → Other apps (MCP)', () => {
  it('is mounted in the step, after the provider cards and before privacy', async () => {
    render(<AssistantStep panelId="wiz-assistant" />);
    await waitFor(() => expect(q('[data-assistant-step]')).toBeTruthy());
    const blocks = [...document.querySelectorAll('[data-assistant-cards], [data-assistant-mcp], [data-assistant-privacy]')].map((el) =>
      el.hasAttribute('data-assistant-cards') ? 'cards' : el.hasAttribute('data-assistant-mcp') ? 'mcp' : 'privacy',
    );
    expect(blocks).toEqual(['cards', 'mcp', 'privacy']);
  });

  it('a server without Other apps (no mcp in its status) shows no block', () => {
    const s = baseStatus();
    delete s.mcp;
    status = s;
    render(<AssistantStepMcp status={s as unknown as AssistantStatus} />);
    expect(q('[data-assistant-mcp]')).toBeNull();
  });

  it('the switch is off by default: its label, no config and no connections, and the coding-agents line always', async () => {
    await renderBlock();
    expect(screen.getByText('Other apps (MCP)')).toBeInTheDocument();
    const sw = screen.getByRole('switch', { name: MCP_SWITCH_LABEL });
    expect(sw).not.toBeChecked();
    expect(block()).toHaveAttribute('data-assistant-mcp-clients', 'off');
    expect(q('[data-assistant-mcp-snippet]')).toBeNull();
    expect(q('[data-assistant-mcp-copy]')).toBeNull();
    expect(q('[data-assistant-mcp-none]')).toBeNull();
    expect(screen.queryByText(MCP_SNIPPET_INTRO)).toBeNull();
    expect(q('[data-assistant-mcp-agents]')!.textContent).toBe(MCP_AGENTS_TEXT);
    expect(MCP_SWITCH_LABEL).toBe("Let other AI apps on this PC use Magnusim's tools");
    expect(MCP_AGENTS_TEXT).toBe('Coding agents above use this connection whatever this switch says.');
    expect(q('[data-assistant-mcp-reason]')).toBeNull();
  });

  it('turned on, it saves mcp.clients and shows the config to paste (key magnusim-apps, always --info, as the server gives it: no token), the rules and "None connected."; turned off, it saves that and hides them', async () => {
    await renderBlock();
    fireEvent.click(toggle());
    await waitFor(() => expect(q('[data-assistant-mcp-snippet]')!.textContent).toBe(SNIPPET));
    expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/assistant/settings').map((r) => r.body)).toEqual([{ mcp: { clients: true } }]);
    expect(toggle()).toBeChecked();
    expect(screen.getByText(MCP_SNIPPET_INTRO)).toBeInTheDocument();
    const shown = JSON.parse(q('[data-assistant-mcp-snippet]')!.textContent!);
    expect(Object.keys(shown.mcpServers)).toEqual(['magnusim-apps']);
    expect(shown.mcpServers['magnusim-apps'].args.slice(-2)).toEqual(['--info', INFO]);
    expect(q('[data-assistant-mcp-rules]')!.textContent).toBe(MCP_RULES_TEXT);
    expect(MCP_RULES_TEXT).toBe('They get the same tools, questions and privacy rules as the Assistant. Magnusim must be running.');
    expect(screen.getByText('Connected now:')).toBeInTheDocument();
    expect(q('[data-assistant-mcp-none]')!.textContent).toBe(MCP_NONE_TEXT);
    fireEvent.click(toggle());
    await waitFor(() => expect(q('[data-assistant-mcp-snippet]')).toBeNull());
    expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/assistant/settings').map((r) => r.body)).toEqual([
      { mcp: { clients: true } },
      { mcp: { clients: false } },
    ]);
    expect(toggle()).not.toBeChecked();
    expect(q('[data-assistant-mcp-agents]')).toBeTruthy();
  });

  it('a refused save says why, and the switch shows what is saved', async () => {
    settingsAnswer = { status: 500, body: { ok: false, error: "The settings couldn't be saved." } };
    await renderBlock();
    fireEvent.click(toggle());
    await waitFor(() => expect(q('[data-assistant-mcp-error]')).toHaveTextContent("The settings couldn't be saved."));
    expect(toggle()).not.toBeChecked();
    expect(q('[data-assistant-mcp-snippet]')).toBeNull();
  });

  it('Copy puts the config on the clipboard exactly as shown', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderBlock({ mcp: { clients: true, running: true, reason: null, port: 49152, connected: 0 } });
    await waitFor(() => expect(q('[data-assistant-mcp-snippet]')!.textContent).toBe(SNIPPET));
    fireEvent.click(q('[data-assistant-mcp-copy]')!);
    await waitFor(() => expect(q('[data-assistant-mcp-copied]')).toHaveTextContent(MCP_COPIED_TEXT));
    expect(writeText).toHaveBeenCalledWith(SNIPPET);
  });

  it('connected now: each other app as it calls itself, since when and its calls; coding agents are not listed here', async () => {
    const since = new Date(2026, 9, 17, 14, 2, 30).toISOString();
    mcp = {
      connections: [
        { id: 'm-1-aaaaaaaa', kind: 'external', name: 'Desk App', since, calls: 3 },
        { id: 'm-2-bbbbbbbb', kind: 'agent', name: 'some agent', since, calls: 9 },
        { id: 'm-3-cccccccc', kind: 'external', name: '', since, calls: 1 },
      ],
    };
    await renderBlock({ mcp: { clients: true, running: true, reason: null, port: 49152, connected: 3 } });
    await waitFor(() => expect(q('[data-assistant-mcp-connections]')).toBeTruthy());
    const rows = [...document.querySelectorAll('[data-assistant-mcp-connection]')].map((li) => [li.getAttribute('data-assistant-mcp-connection'), li.textContent]);
    expect(rows).toEqual([
      ['m-1-aaaaaaaa', 'Desk App · since 14:02 · 3 calls'],
      ['m-3-cccccccc', 'An app with no name · since 14:02 · 1 call'],
    ]);
    expect(q('[data-assistant-mcp-none]')).toBeNull();
    expect(connectionLine({ id: 'x', kind: 'external', name: 'App', since: 'not a time', calls: 0 })).toBe('App · 0 calls');
  });

  it('while on, the connections are read again every few seconds (an app that connects shows), and no more once the step is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await renderBlock({ mcp: { clients: true, running: true, reason: null, port: 49152, connected: 0 } });
    await waitFor(() => expect(q('[data-assistant-mcp-none]')).toBeTruthy());
    const before = reads();
    mcp = { connections: [{ id: 'm-9-dddddddd', kind: 'external', name: 'Late App', since: new Date().toISOString(), calls: 0 }] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MCP_POLL_MS);
    });
    await waitFor(() => expect(q('[data-assistant-mcp-connection="m-9-dddddddd"]')).toBeTruthy());
    expect(reads()).toBe(before + 1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MCP_POLL_MS * 3);
    });
    expect(reads()).toBe(before + 1);
  });

  it('while off, nothing is read again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderBlock();
    await waitFor(() => expect(reads()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MCP_POLL_MS * 3);
    });
    expect(reads()).toBe(1);
  });

  it("when the connection can't run, the reason shows whatever the switch says: the package missing, or the port", async () => {
    await renderBlock({ mcp: { clients: false, running: false, reason: 'deps_missing', port: null, connected: 0 } });
    expect(q('[data-assistant-mcp-reason]')).toHaveAttribute('data-assistant-mcp-reason', 'deps_missing');
    expect(q('[data-assistant-mcp-reason]')!.textContent).toBe(MCP_DEPS_TEXT);
    expect(MCP_DEPS_TEXT).toBe("Magnusim's tool-connection package isn't installed. Run Setup.bat again.");
    cleanup();
    resetStatusStore();
    await renderBlock({ mcp: { clients: true, running: false, reason: 'bind_failed', port: 49152, connected: 0 } });
    expect(q('[data-assistant-mcp-reason]')!.textContent).toBe(
      "Magnusim couldn't open the connection its tools use (bind_failed). Restart Magnusim; if it keeps happening, another program may hold port 49152.",
    );
    expect(mcpReasonText('file_failed', null)).toBe(
      "Magnusim couldn't open the connection its tools use (file_failed). Restart Magnusim; if it keeps happening, another program may hold its port.",
    );
    cleanup();
    resetStatusStore();
    // Not running for no reason (the server started before the Assistant was used): nothing to say.
    await renderBlock({ mcp: { clients: false, running: false, reason: null, port: null, connected: 0 } });
    expect(q('[data-assistant-mcp-reason]')).toBeNull();
  });
});
