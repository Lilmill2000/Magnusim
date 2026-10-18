/**
 * Settings → Assistant → Coding agents (phase 3 spec 4.9, 4.12, 4.13, 5.6, 5.7): the coding
 * agents on this PC, each a provider beside the API-key ones (D-A), with the person's own
 * account and login.
 *
 * - The list comes from GET /api/assistant/agents, read when the block opens and on Refresh
 *   (which asks every version again); after each answer the status is read again, so the
 *   Default choice offers the agents found. A server without the route shows no block.
 * - One row per agent (`data-assistant-agent`, `data-assistant-agent-state`): missing (the
 *   install line, Copy for a command), signed_out (the Sign in block), needs_allow and
 *   allow_changed (the switch, off), ready (its line, Test, Model and Mode once a Test or
 *   connect listed them, the modes only those Magnusim uses with it, the billing line),
 *   testing, and error (the last check's error, an alert, with the Sign in block when the
 *   agent asked to sign in).
 * - Signed in or not: the login file (the row's `signed_in`), unless the agent itself said
 *   more: a Test it answered, its own auth status on a connect (signed in, or not: that wins over
 *   the file), or its auth_required (here, or the server's `sign_in` from the last one, which shows
 *   the Sign in block until a check gets through). A connect it said nothing on proves only that
 *   it starts: with no login file the row says Magnusim can't tell, and offers Test. The server
 *   keeps the agent's word (the row's `auth_word`) and its readiness follows it, so the line, the
 *   dot and the Default choice agree, also when the step opens again.
 * - Privacy changed in this step (Never send project data, or back): the list is read again, so
 *   a row whose agent's own tools stay on says it stays off (or not), its dot with it.
 * - The allow switch (D-B, spec 4.9) shows on every agent whose own tools Magnusim can't switch
 *   off, off by default, with its warning beside it always. On asks first (No focused: Enter
 *   and Escape answer Don't), then POSTs the fingerprint of the command the row shows; off
 *   needs no question. One save at a time: off asked while Allow saves goes right after it.
 *   A command or program changed since it was allowed asks again; an allow the server still
 *   keeps then (or for an agent gone or broken) has Turn off, the kill switch.
 * - Sign in (spec 4.12): Magnusim never takes an agent's key. A terminal command shows with
 *   Copy only when the server gave its line (its safety rules) and the agent's own tools are
 *   off or its switch is on; an agent method is a button; a variable is a line of text; "I've
 *   signed in: connect again" runs the connect check, which sends no message.
 * - Test (spec 4.13) starts the agent and sends it one short message; its result is announced.
 * - Custom agents: Add a custom agent… (name, command, the variables to pass) and Remove; the
 *   POSTs carry the page's Origin (the routes are for this window only).
 * A route a server doesn't have yet (the Test, sign-in) says so plainly; nothing else changes.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  addCustomAgent,
  allowAgent,
  AssistantApiError,
  checkAgent,
  isMissingRoute,
  listAgents,
  removeCustomAgent,
  rowOfAnswer,
  signInAgent,
} from '../../assistant/api';
import { refreshStatus, stepChange, writeStatus } from '../../assistant/status';
import type { AgentRow, AgentTestAnswer, AssistantStatus, ModeView, SignInMethodView } from '../../assistant/wire';
import { confirmAction } from '../../workbench/dialogs';
import { MCP_DEPS_TEXT, mcpDownReason } from './AssistantStepMcp';

const SETTINGS = '/api/assistant/settings';

// ---------------------------------------------------------------- copy (spec 5.7)

export const AGENTS_INTRO =
  "Use a coding agent you already have, signed in with your own account. Magnusim starts it on this PC and gives it Magnusim's tools; you need no API key here. What it does is billed to your account with that agent.";
export const AGENTS_CHECKING_TEXT = 'Looking for coding agents on this PC…';
export const TREE_KILL_TEXT =
  'Windows PowerShell is blocked on this PC, so stopping an agent may leave programs it started running. Check Task Manager after you stop one.';

export const LOGIN_YES = 'Signed in (its login file is on this PC).';
export const loginKeyText = (variable: string) => `Uses ${variable} from your environment.`;
export const LOGIN_UNKNOWN = "Magnusim can't tell whether it is signed in; Test will say.";
export const LOGIN_NO = 'Not signed in.';
export const OWN_TOOLS_OFF = 'Its own shell, file and web tools are off while it works for Magnusim.';
export const OWN_TOOLS_ON = 'Its own tools stay on: it can run commands and change files on this PC by its own rules.';
export const billingText = (name: string) => `Billed to your ${name} account; Magnusim's $ limits don't apply to it. The limits under Coding agents do.`;
/** The Default choice's billing line (spec 4.15). */
export const defaultBillingText = (name: string) => `Billed to your ${name} account; Magnusim's $ limits don't apply to it.`;
export const notInstalledText = (name: string) => `${name} · not installed.`;
export const INSTALL_WITH = 'Install it with:';

export const signInHeading = (name: string) => `Sign in to ${name}`;
export const SIGNIN_TERMINAL_TEXT = 'Run this in a terminal, sign in there, then come back:';
export const SIGNIN_AGENT_NOTE = 'It opens your browser or asks in its own window.';
export const signInVarText = (variable: string) => `Or set ${variable} in your environment and restart Magnusim.`;
export const signInFooter = (name: string) => `Magnusim has no field for ${name}'s key on purpose: the agent keeps its own login.`;
export const signInDocsText = (name: string) => `Sign in to ${name} the way its own documentation says.`;
export const CONNECT_AGAIN = "I've signed in: connect again";
export const connectNote = (name: string) => `Connect again starts ${name} without sending it a message.`;

export const ALLOW_LABEL = 'Allow this agent';
export const allowWarning = (name: string) =>
  `${name}'s own tools can't be switched off from Magnusim. Once allowed, it can run commands and change files on this PC by its own rules, as it does in a terminal. It can also read your Magnusim projects, whatever the privacy setting says. Magnusim's questions cover only Magnusim's tools. Anyone else signed in to this PC can reach Magnusim's settings too; allow agents only on a PC whose other accounts you trust.`;
export const allowTitle = (name: string) => `Allow ${name} to work for the Assistant?`;
export const allowCopy = (name: string) =>
  `${name} can run commands, read your projects and change files on this PC by its own rules, and Magnusim can't stop that. Allow it only if you trust it as you do in a terminal.`;
export const allowChangedText = (name: string) => `${name}'s command or program changed since you allowed it. Allow it again to use it.`;
export const TURN_OFF_LABEL = 'Turn off';
export const turnOffNote = (name: string) => `Anything ${name} started while it was allowed may still be running. Turn off stops it and clears its switch.`;

export const testNote = (name: string) => `Test starts ${name} and sends it one short message.`;
export const testingText = (name: string) => `Testing: starting ${name} and sending it one short message…`;
export const connectingText = (name: string) => `Connecting to ${name}…`;
export const signingInText = (name: string) => `Waiting for ${name} to finish signing in…`;
export const NO_AGENT_TEST_TEXT = "This copy of Magnusim can't test coding agents yet.";
export const NO_SIGN_IN_TEXT = "This copy of Magnusim can't sign in to coding agents yet.";
export const signedInDoneText = (name: string) => `${name} finished signing in. Connect again to check.`;
/** A connect that got through to an agent that says it isn't signed in (`<Name> <version>`). */
export const connectedSignedOutText = (nameVersion: string) => `Connected to ${nameVersion}, but it says it isn't signed in.`;
/** A connect that got through, the agent saying nothing of its login, with no login file. */
export const connectedUnsureText = (nameVersion: string) => `Connected to ${nameVersion}. ${LOGIN_UNKNOWN}`;

export const CUSTOM_HELP =
  'The program and its arguments, for example C:\\Tools\\my-agent.exe --acp. Magnusim starts it directly, never through a command shell. It must speak the agent protocol (ACP) on its input and output.';
export const VARS_HELP = "It gets only basic environment variables (PATH, your folders, proxies). List any others it needs, such as its own key's variable.";
/** At most this many variables to pass (spec 5.1 keep_env). */
export const KEEP_ENV_MAX = 8;
export const COPIED_TEXT = 'Copied.';
export const COPY_FAILED_TEXT = "Couldn't copy it: select the text and copy it.";
export const removeTitle = (name: string) => `Remove ${name}?`;
export const removeCopy = (name: string) => `Magnusim forgets ${name}'s command, its switch and its choices. You can add it again.`;
export const MODEL_DEFAULT = "The agent's own choice";
export const MODE_DEFAULT = 'The mode it starts in';
/** No mode chosen when Magnusim sets one at every start (spec 4.6 step 6): the mode it sets. */
export const magnusimModeText = (name: string) => `${name} (Magnusim's choice)`;
export const MCP_UNAVAILABLE_TEXT = "Magnusim couldn't open the connection its tools use. Restart Magnusim; if it keeps happening, see Other apps (MCP) below.";
/** Under "Never send project data" a turn on an agent whose own tools stay on is refused, even from Home (spec 4.14). */
export const privacyDeniedText = (name: string) =>
  `${name} can read your project files with its own tools, so it stays off while Project data (below) is set to Never send project data.`;

/** Why the row's tool connection can't run: a package missing needs Setup again, not a restart. */
export function mcpUnavailableText(status: AssistantStatus): string {
  return mcpDownReason(status) === 'deps_missing' ? MCP_DEPS_TEXT : MCP_UNAVAILABLE_TEXT;
}

const secs = (ms: number) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
const withVersion = (name: string, version: string | null | undefined) => (version ? `${name} ${version}` : name);

export function loginLine(row: Pick<AgentRow, 'signed_in' | 'key_var'>): string {
  if (row.signed_in === 'yes') return LOGIN_YES;
  if (row.signed_in === 'key') return row.key_var ? loginKeyText(row.key_var) : LOGIN_UNKNOWN;
  if (row.signed_in === 'no') return LOGIN_NO;
  return LOGIN_UNKNOWN;
}

export function ownToolsLine(ownTools: 'off' | 'on'): string {
  return ownTools === 'off' ? OWN_TOOLS_OFF : OWN_TOOLS_ON;
}

/**
 * Whether the agent itself said, in a connect's answer, that it isn't signed in (spec 4.3: its
 * `_auth/status_update` with kind 'none', the answer's `auth_status`), whatever its login file
 * says. An agent that answered the Test's message is signed in, whatever it said.
 */
export function agentSaidSignedOut(a: AgentTestAnswer): boolean {
  return a.ok && a.tools === null && a.auth_status === 'none';
}

/**
 * What a check says of the row's sign-in (null: nothing). 'connected': the agent answered the
 * Test's message, said it is signed in, or a connect got through where the login file (as the
 * server read it for the check: the answer's `signed_in`) doesn't say no. 'signed_out': it said
 * it isn't (its auth status, or its auth_required). 'unsure': a connect got through but the
 * agent said nothing and its login file isn't there, so nothing shows it is signed in (the Test
 * will say).
 */
export function checkLogin(a: AgentTestAnswer): AgentDone['login'] {
  if (!a.ok) return a.code === 'agent_signin' ? 'signed_out' : null;
  if (agentSaidSignedOut(a)) return 'signed_out';
  if (a.tools !== null || a.auth_status === 'signed_in') return 'connected';
  return a.signed_in === 'no' ? 'unsure' : 'connected';
}

/** A Test's or connect's result line (spec 5.7) and whether everything works. */
export function agentTestLine(a: AgentTestAnswer, row: Pick<AgentRow, 'name' | 'version' | 'own_tools' | 'signed_in'>, message: boolean): { ok: boolean; text: string } {
  if (!a.ok) return { ok: false, text: a.error };
  const version = a.version ?? row.version;
  if (agentSaidSignedOut(a)) return { ok: false, text: connectedSignedOutText(withVersion(row.name, version)) };
  if (!message) return { ok: true, text: checkLogin(a) === 'unsure' ? connectedUnsureText(withVersion(row.name, version)) : `Connected to ${withVersion(row.name, version)}.` };
  if (a.tools === 'not_used') {
    return {
      ok: false,
      text: `${row.name} answered in ${secs(a.ms)} s but didn't call Magnusim's test tool, so it may not use Magnusim's tools. Test again, or check the agent's own settings.`,
    };
  }
  if (a.tools === 'works') return { ok: true, text: `${withVersion(row.name, version)} answered in ${secs(a.ms)} s and called Magnusim's test tool. ${ownToolsLine(a.own_tools)}` };
  return { ok: true, text: `${withVersion(row.name, version)} answered in ${secs(a.ms)} s.` };
}

/** An install line that is a command to paste (the others are instructions, shown as text). */
export function isInstallCommand(line: string): boolean {
  return /^npm (install|i) \S/.test(line) && !/[\r\n&|;<>`$]/.test(line);
}

/** Whether a terminal sign-in command may be shown at all: never for an agent whose own tools stay on until it is allowed (spec 4.12, rule 1). */
export function mayShowSignInCommand(row: Pick<AgentRow, 'lockdown' | 'allowed'>): boolean {
  return row.lockdown !== 'none' || row.allowed;
}

/**
 * An allow the server still keeps that no longer counts: the command or program changed, or
 * the agent can't be found or started now. What started under it may still run, so its row
 * offers Turn off (spec 4.9: off is always taken, and stops the agent).
 */
export function holdsOldAllow(row: Pick<AgentRow, 'found' | 'error' | 'allowed' | 'allow_changed'>): boolean {
  return row.allow_changed || ((!row.found || !!row.error) && row.allowed);
}

/** A command line the page shows and copies: one line, of a sane length. */
function plainLine(line: string | null): string | null {
  return line && line.length <= 600 && !/[\r\n]/.test(line) ? line : null;
}

export type AgentRowState = 'checking' | 'missing' | 'signed_out' | 'needs_allow' | 'allow_changed' | 'ready' | 'testing' | 'error';

/** What runs now for a row (one thing at a time). */
export type AgentBusy = 'testing' | 'connecting' | 'signing_in' | null;

/** The last Test, connect or sign-in run for a row on this page. */
export interface AgentDone {
  /** A Test or connect check, or a sign-in (which leaves the row as it was: Connect again checks it). */
  kind: 'check' | 'sign_in';
  /** The agent answered (false: it failed or was refused, or this server can't run the check). */
  answered: boolean;
  /** Everything works (an agent that answered a Test without calling the test tool doesn't). */
  good: boolean;
  text: string;
  code: string | null;
  auth: SignInMethodView[] | null;
  /** What it says of the sign-in, over the login file (checkLogin); null: nothing (a sign-in, or a failed check). */
  login: 'connected' | 'signed_out' | 'unsure' | null;
}

/**
 * Whether the row is signed in as the page says it: the newest word from a check run here
 * (checkLogin), until the row read after it says it too; else the agent's word the server keeps
 * (the sign-in block from its last auth_required or 'none', its `auth_word`), as its readiness
 * reads it; else the login file (the row's `signed_in`).
 */
function loginOf(row: AgentRow, done: AgentDone | null): 'connected' | 'signed_out' | 'unsure' | 'file' {
  // A connect it said nothing on counts only while its login file says no: once the file is there, the file decides.
  if (done?.kind === 'check' && done.login && (done.login !== 'unsure' || row.signed_in === 'no')) return done.login;
  if (row.sign_in || row.auth_word === 'none') return 'signed_out';
  if (row.auth_word === 'signed_in') return 'connected';
  if (row.auth_word === 'silent' && row.signed_in === 'no') return 'unsure';
  return 'file';
}

/** What the server says of the row's sign-in (a newer one than a check run here, once it changes). */
const loginKey = (row: AgentRow) => `${row.signed_in}:${row.auth_word ?? ''}:${row.sign_in ? 1 : 0}`;

/** A row's state (spec 5.6) apart from a check running now. */
function baseState(row: AgentRow, done: AgentDone | null): Exclude<AgentRowState, 'testing' | 'checking'> {
  if (!row.found) return 'missing';
  if (row.error) return 'error';
  if (row.needs_allow && !row.allowed) return row.allow_changed ? 'allow_changed' : 'needs_allow';
  if (done && done.kind === 'check' && !done.answered) return 'error';
  const login = loginOf(row, done);
  // Unsure: Test is offered, and it will say.
  if (login === 'connected' || login === 'unsure') return 'ready';
  if (login === 'signed_out' || row.signed_in === 'no') return 'signed_out';
  return 'ready';
}

/** A row's state (spec 5.6), from what the server says and the checks run on this page. */
export function agentRowState(row: AgentRow, busy: AgentBusy = null, done: AgentDone | null = null): AgentRowState {
  return busy ? 'testing' : baseState(row, done);
}

/**
 * Focus after one of the app's questions (its dialog doesn't give focus back): where it was,
 * else the first of `fallbacks` still shown.
 */
function refocus(before: Element | null, ...fallbacks: Array<HTMLElement | null | undefined>): void {
  const shown = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && el !== document.body && el.isConnected && !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled;
  [before, ...fallbacks].find(shown)?.focus();
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Copy with its announced result. */
function useCopy(): [state: 'ok' | 'failed' | null, copy: (text: string) => Promise<void>] {
  const [state, setState] = useState<'ok' | 'failed' | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setState('ok');
    } catch {
      if (mounted.current) setState('failed');
    }
  };
  return [state, copy];
}

function CopiedLine({ state, hook }: { state: 'ok' | 'failed' | null; hook: Record<string, string> }) {
  return (
    <span className="wiz-assistant-meta" aria-live="polite" {...hook}>
      {state === 'ok' ? COPIED_TEXT : state === 'failed' ? COPY_FAILED_TEXT : ''}
    </span>
  );
}

function ReadyDot({ ready }: { ready: boolean }) {
  return <span className={`wiz-assistant-dot${ready ? ' is-ready' : ''}`} aria-hidden="true" data-assistant-dot={ready ? 'ready' : 'not-ready'} />;
}

// ---------------------------------------------------------------- the block

type ListView = { state: 'loading' } | { state: 'none' } | { state: 'error'; message: string } | { state: 'ok'; rows: AgentRow[] };

export function AssistantStepAgents({ status }: { status: AssistantStatus }) {
  const [list, setList] = useState<ListView>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState('');
  /** A read that failed while rows are shown (they stay, as last read). */
  const [readError, setReadError] = useState('');
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const reads = useRef(0);
  const mounted = useRef(true);
  const addButton = useRef<HTMLButtonElement>(null);
  const formId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Reads the list (Refresh: every version asked again); only the newest read is shown. */
  const load = useCallback(async (refresh: boolean) => {
    const seq = ++reads.current;
    if (refresh) setRefreshing(true);
    try {
      const a = await listAgents(refresh);
      if (!mounted.current || seq !== reads.current) return;
      setList({ state: 'ok', rows: a.agents });
      setReadError('');
      // The status lists the agents found (the Default choice offers them).
      void refreshStatus();
    } catch (err) {
      if (!mounted.current || seq !== reads.current) return;
      if (isMissingRoute(err)) setList({ state: 'none' });
      else {
        setList((l) => (l.state === 'ok' ? l : { state: 'error', message: errorText(err) }));
        setReadError(errorText(err));
      }
    } finally {
      if (mounted.current && seq === reads.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Privacy changed (its save answered): the rows' readiness changes with it (an agent whose own
  // tools stay on is off under Never send project data), so the list is read again.
  const privacy = status.privacy;
  const privacyBefore = useRef(privacy);
  useEffect(() => {
    if (privacyBefore.current === privacy) return;
    privacyBefore.current = privacy;
    void load(false);
  }, [privacy, load]);

  /** A row an action answered with: shown at once; a list read on its way is older, so it is dropped. */
  const putRow = useCallback((row: AgentRow) => {
    reads.current += 1;
    setRefreshing(false);
    setList((l) => {
      if (l.state !== 'ok') return { state: 'ok', rows: [row] };
      const i = l.rows.findIndex((r) => r.id === row.id);
      return { state: 'ok', rows: i >= 0 ? l.rows.map((r) => (r.id === row.id ? row : r)) : [...l.rows, row] };
    });
    void refreshStatus();
  }, []);

  const dropRow = useCallback((id: string) => {
    reads.current += 1;
    setRefreshing(false);
    setList((l) => (l.state === 'ok' ? { state: 'ok', rows: l.rows.filter((r) => r.id !== id) } : l));
    void refreshStatus();
  }, []);

  // A row just added takes the focus (once it is shown).
  useEffect(() => {
    if (!focusRow) return;
    const el = [...document.querySelectorAll<HTMLElement>('[data-assistant-agent]')].find((x) => x.getAttribute('data-assistant-agent') === focusRow);
    if (el) {
      el.focus();
      setFocusRow(null);
    }
  }, [focusRow, list]);

  if (list.state === 'none') return null;
  const rows = list.state === 'ok' ? list.rows : [];
  const known = rows.filter((r) => r.kind === 'known');
  const custom = rows.filter((r) => r.kind === 'custom');

  return (
    <div className="wiz-assistant-block" data-assistant-agents="1" aria-busy={list.state === 'loading' || refreshing}>
      <h3 className="wiz-assistant-h">Coding agents</h3>
      <p className="wiz-assistant-meta" data-assistant-agents-intro="1">
        {AGENTS_INTRO}
      </p>
      {status.agents_tree_kill === 'best_effort' ? (
        <p className="wiz-assistant-warn" data-assistant-agents-tree-kill="1">
          {TREE_KILL_TEXT}
        </p>
      ) : null}
      {list.state === 'loading' ? (
        <p className="wiz-assistant-meta" data-assistant-agents-checking="1">
          {AGENTS_CHECKING_TEXT}
        </p>
      ) : null}
      {list.state === 'error' ? (
        <div className="wiz-assistant-error-box" role="alert" data-assistant-agents-error="1">
          <span>Couldn't look for coding agents: {list.message}</span>
          <button type="button" className="home-btn" onClick={() => void load(false)}>
            Retry
          </button>
        </div>
      ) : null}
      {rows.length ? (
        <ul className="wiz-assistant-agents" aria-label="Coding agents">
          {[...known, ...custom].map((row) => (
            <AgentRowView
              key={row.id}
              row={row}
              status={status}
              onRow={putRow}
              onReload={() => void load(false)}
              onRemoved={(r) => {
                dropRow(r.id);
                setNotice(`${r.name} was removed.`);
                addButton.current?.focus();
              }}
            />
          ))}
        </ul>
      ) : null}
      {list.state === 'ok' && readError ? (
        <p className="wiz-assistant-error" role="alert" data-assistant-agents-read-error="1">
          Couldn't look for coding agents again: {readError}
        </p>
      ) : null}
      <div className="wiz-assistant-row">
        <button type="button" className="home-btn" data-assistant-agents-refresh="1" aria-disabled={refreshing || undefined} onClick={() => !refreshing && void load(true)}>
          {refreshing ? 'Looking…' : 'Refresh'}
        </button>
        <button
          ref={addButton}
          type="button"
          className="home-btn"
          data-assistant-agent-add-open="1"
          aria-expanded={formOpen}
          aria-controls={formOpen ? formId : undefined}
          onClick={() => {
            setNotice('');
            setFormOpen((o) => !o);
          }}
        >
          Add a custom agent…
        </button>
      </div>
      {formOpen ? (
        <CustomAgentForm
          id={formId}
          onCancel={() => {
            setFormOpen(false);
            addButton.current?.focus();
          }}
          onAdded={(row) => {
            setFormOpen(false);
            putRow(row);
            setNotice(`${row.name} was added. It stays off until you allow it.`);
            setFocusRow(row.id);
          }}
        />
      ) : null}
      <p className="wiz-assistant-meta" role="status" data-assistant-agents-notice={notice ? '1' : ''}>
        {notice}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- one agent

function AgentRowView({
  row,
  status,
  onRow,
  onReload,
  onRemoved,
}: {
  row: AgentRow;
  status: AssistantStatus;
  onRow: (row: AgentRow) => void;
  onReload: () => void;
  onRemoved: (row: AgentRow) => void;
}) {
  const [busy, setBusy] = useState<AgentBusy>(null);
  const [done, setDone] = useState<AgentDone | null>(null);
  /** Checks done here (a new failure is a new alert, even with the same text). */
  const [runs, setRuns] = useState(0);
  const running = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  /** Focus was in the row when a check started: kept in it when what had it goes. */
  const keepFocus = useRef(false);
  const [removeError, setRemoveError] = useState('');
  const noteId = useId();
  // A check nobody waits for any more (the step went) is let go: the server stops it when its request closes.
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (busy || !keepFocus.current) return;
    keepFocus.current = false;
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) (testButton.current ?? rowRef.current)?.focus();
  }, [busy, done]);
  // The last check was of the program and switch it ran with: another one, or the switch turned, starts afresh.
  const checked = `${row.fingerprint ?? ''}:${row.allowed}`;
  const lastChecked = useRef(checked);
  useEffect(() => {
    if (lastChecked.current === checked) return;
    lastChecked.current = checked;
    if (!running.current) setDone(null);
  }, [checked]);
  // The server's word on the sign-in changed (the row read after a check, or since): it is the
  // newest, so a check's own word no longer decides (its line stays).
  const login = loginKey(row);
  const lastLogin = useRef(login);
  useEffect(() => {
    if (lastLogin.current === login) return;
    lastLogin.current = login;
    if (!running.current) setDone((d) => (d && d.login ? { ...d, login: null } : d));
  }, [login]);

  const base = baseState(row, done);
  const state: AgentRowState = busy ? 'testing' : base;
  const name = row.name;
  const isDefault = status.provider === `agent:${row.id}`;

  /** Runs one check at a time for the row; one let go (the step went) changes nothing. */
  const runCheck = async (kind: Exclude<AgentBusy, null>, work: (signal: AbortSignal) => Promise<AgentDone>) => {
    if (running.current) return;
    running.current = true;
    keepFocus.current = !!rowRef.current?.contains(document.activeElement);
    const ac = new AbortController();
    pending.current = ac;
    setBusy(kind);
    try {
      const next = await work(ac.signal);
      if (ac.signal.aborted) return;
      setDone(next);
      setRuns((n) => n + 1);
      setBusy(null);
      // Its row now carries what the check listed (modes, models) or its ways to sign in.
      onReload();
    } finally {
      running.current = false;
      if (pending.current === ac) pending.current = null;
    }
  };

  /** The Test (one short message) or the connect check (none). */
  const check = (message: boolean) =>
    runCheck(message ? 'testing' : 'connecting', async (signal) => {
      try {
        const a = await checkAgent(row.id, message, signal);
        const line = agentTestLine(a, row, message);
        return { kind: 'check', answered: a.ok, good: line.ok, text: line.text, code: a.ok ? null : a.code, auth: a.auth ?? null, login: checkLogin(a) };
      } catch (err) {
        return { kind: 'check', answered: false, good: false, text: isMissingRoute(err) ? NO_AGENT_TEST_TEXT : errorText(err), code: null, auth: null, login: null };
      }
    });

  const signIn = (method: SignInMethodView) =>
    runCheck('signing_in', async (signal) => {
      const was = { auth: null, login: null };
      try {
        const r = await signInAgent(row.id, method.id, signal);
        if (r.ok) return { kind: 'sign_in', answered: true, good: true, text: signedInDoneText(name), code: null, ...was };
        return { kind: 'sign_in', answered: false, good: false, text: r.error, code: r.code, ...was };
      } catch (err) {
        return { kind: 'sign_in', answered: false, good: false, text: isMissingRoute(err) ? NO_SIGN_IN_TEXT : errorText(err), code: null, ...was };
      }
    });

  const remove = async (): Promise<boolean> => {
    setRemoveError('');
    const before = document.activeElement;
    const yes = await confirmAction({ title: removeTitle(name), copy: removeCopy(name), yes: 'Remove', no: "Don't", safe: true });
    if (!yes) {
      refocus(before, removeButton.current);
      return true;
    }
    try {
      await removeCustomAgent(row.id);
    } catch (err) {
      setRemoveError(errorText(err));
      refocus(before, removeButton.current);
      return false;
    }
    onRemoved(row);
    return true;
  };

  // The ways to sign in: from the last check here, else from the server's last auth_required.
  const methods = done?.auth ?? row.sign_in?.methods ?? [];
  // A failed check shows the block when the agent asked to sign in now or at its last auth_required.
  const showSignIn = base === 'signed_out' || (base === 'error' && !row.error && (done?.login === 'signed_out' || !!row.sign_in));
  const canCheck = base === 'ready' || (base === 'error' && !row.error);
  // A failed check is an alert (spec 5.6); a check running or done well is announced politely.
  const failed = !busy && !!done && !done.good ? done : null;
  const resultText =
    busy === 'testing' ? testingText(name) : busy === 'connecting' ? connectingText(name) : busy === 'signing_in' ? signingInText(name) : failed ? '' : (done?.text ?? '');

  return (
    <li
      ref={rowRef}
      className="wiz-assistant-agent"
      data-assistant-agent={row.id}
      data-assistant-agent-state={state}
      data-assistant-agent-kind={row.kind}
      data-ready={row.ready ? '1' : '0'}
      tabIndex={-1}
      aria-label={name}
    >
      <div className="wiz-assistant-card-head">
        <span className="wiz-assistant-card-title">
          <strong>{name}</strong>
          {row.kind === 'custom' ? <span className="wiz-assistant-badge">Custom</span> : null}
          {isDefault ? (
            <span className="wiz-assistant-badge" data-assistant-agent-default="1">
              Default
            </span>
          ) : null}
        </span>
        <span className="wiz-assistant-state">
          <ReadyDot ready={row.ready} />
          <span data-assistant-agent-line="1">{headline(row, base, done)}</span>
        </span>
      </div>
      {base === 'missing' ? <MissingBlock row={row} /> : null}
      {row.found && row.program ? (
        <p className="wiz-assistant-meta wiz-assistant-agent-program" data-assistant-agent-program="1">
          Program: {row.program}
          {row.script ? ` · script: ${row.script}` : ''}
        </p>
      ) : null}
      {row.found && row.error ? (
        <p className="wiz-assistant-error" role="alert" data-assistant-agent-error="1">
          {row.error}
        </p>
      ) : null}
      {base === 'allow_changed' ? (
        <p className="wiz-assistant-warn" data-assistant-agent-allow-changed="1">
          {allowChangedText(name)}
        </p>
      ) : null}
      {holdsOldAllow(row) ? (
        <TurnOff
          row={row}
          onRow={onRow}
          onReload={onReload}
          onDone={() => refocus(null, rowRef.current?.querySelector<HTMLElement>('[data-assistant-agent-allow]'), rowRef.current)}
        />
      ) : null}
      {row.found && !row.error && row.needs_allow ? <AllowSwitch row={row} onRow={onRow} /> : null}
      {showSignIn ? <SignInBlock row={row} methods={methods} busy={!!busy} onConnect={() => void check(false)} onSignIn={(m) => void signIn(m)} /> : null}
      {canCheck ? (
        <div className="wiz-assistant-row">
          <button
            ref={testButton}
            type="button"
            className="home-btn"
            data-assistant-agent-test={row.id}
            aria-disabled={busy ? true : undefined}
            aria-describedby={noteId}
            onClick={() => void check(true)}
          >
            {busy === 'testing' ? 'Testing…' : 'Test'}
          </button>
          <span id={noteId} className="wiz-assistant-meta">
            {testNote(name)}
          </span>
        </div>
      ) : null}
      <p role="status" className="wiz-assistant-agent-result wiz-assistant-meta" {...(failed ? {} : { 'data-assistant-agent-result': busy ? 'running' : done ? 'ok' : '' })}>
        {resultText}
      </p>
      {failed ? (
        <p key={runs} role="alert" className="wiz-assistant-agent-result wiz-assistant-error" data-assistant-agent-result="failed">
          {failed.text}
        </p>
      ) : null}
      {base === 'ready' || base === 'error' ? <ChoiceBlock row={row} onReload={onReload} /> : null}
      {row.reason === 'mcp_unavailable' ? (
        <p className="wiz-assistant-warn" data-assistant-agent-mcp="1">
          {mcpUnavailableText(status)}
        </p>
      ) : null}
      {row.reason === 'privacy_denied' ? (
        <p className="wiz-assistant-warn" data-assistant-agent-privacy="1">
          {privacyDeniedText(name)}
        </p>
      ) : null}
      {row.found ? (
        <p className="wiz-assistant-meta" data-assistant-agent-billing="1">
          {billingText(name)}
        </p>
      ) : null}
      {row.kind === 'custom' ? (
        <div className="wiz-assistant-row">
          <button ref={removeButton} type="button" className="home-btn" data-assistant-agent-remove={row.id} onClick={() => void stepChange(remove())}>
            Remove
          </button>
          {removeError ? (
            <span className="wiz-assistant-error" role="alert" data-assistant-agent-remove-error="1">
              {removeError}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The row's one line: "<Name> <version> · <login line> · <own-tools line>" (spec 5.6). */
function headline(row: AgentRow, state: AgentRowState, done: AgentDone | null): string {
  if (state === 'missing') return row.kind === 'known' ? notInstalledText(row.name) : `${row.name} · ${row.error ?? 'not found.'}`;
  const parts = [withVersion(row.name, row.version)];
  // The agent's own word says more than its login file: signed in, its "sign in first", or a connect it said nothing on.
  const login = loginOf(row, done);
  if (login === 'signed_out') parts.push(LOGIN_NO);
  else if (login === 'unsure') parts.push(LOGIN_UNKNOWN);
  else if (!(login === 'connected' && row.signed_in === 'no')) parts.push(loginLine(row));
  if ((state === 'ready' || state === 'signed_out' || (state === 'error' && !row.error)) && (row.own_tools === 'off' || row.allowed)) parts.push(ownToolsLine(row.own_tools));
  return parts.join(' · ');
}

function MissingBlock({ row }: { row: AgentRow }) {
  const [copied, copy] = useCopy();
  if (row.kind === 'custom' || !row.install) return null;
  if (!isInstallCommand(row.install)) {
    return (
      <p className="wiz-assistant-meta" data-assistant-agent-install={row.install}>
        {row.install}
      </p>
    );
  }
  return (
    <div className="wiz-assistant-row">
      <span className="wiz-assistant-meta">{INSTALL_WITH}</span>
      <code data-assistant-agent-install={row.install}>{row.install}</code>
      <button type="button" className="home-btn" data-assistant-agent-install-copy={row.id} aria-label={`Copy the install command for ${row.name}`} onClick={() => void copy(row.install as string)}>
        Copy
      </button>
      <CopiedLine state={copied} hook={{ 'data-assistant-agent-install-copied': copied ?? '' }} />
    </div>
  );
}

// ---------------------------------------------------------------- the allow switch (spec 4.9)

function AllowSwitch({ row, onRow }: { row: AgentRow; onRow: (row: AgentRow) => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const warnId = useId();
  const errorId = useId();
  const name = row.name;
  const shown = pending ?? row.allowed;

  /** A save runs, or its question is open: the switch starts no second save meanwhile. */
  const saving = useRef(false);
  /** Off asked while Allow was saving: sent as soon as Allow has answered (the kill switch is never dropped). */
  const offAfter = useRef(false);

  /** One POST of the switch, its row shown. False when refused. */
  const send = async (on: boolean): Promise<boolean> => {
    try {
      const next = await allowAgent(row.id, on, on ? row.fingerprint : null);
      if (next) onRow(next);
      return true;
    } catch (err) {
      // A refusal may bring the row as it is now (its command changed: look at it again).
      const fresh = err instanceof AssistantApiError ? rowOfAnswer(err.body) : null;
      if (fresh) onRow(fresh);
      setError(errorText(err));
      return false;
    }
  };

  /**
   * Saves the switch: on only after the question (No focused), off at once. One save at a time,
   * so the answers can't cross: off asked while Allow saves is sent once Allow has answered;
   * on asked while a save runs is dropped (it would need its question). False when refused.
   */
  const toggle = async (on: boolean): Promise<boolean> => {
    if (saving.current) {
      if (!on) {
        offAfter.current = true;
        setPending(false);
      }
      return true;
    }
    saving.current = true;
    offAfter.current = false;
    setError('');
    try {
      if (on) {
        const before = document.activeElement;
        const yes = await confirmAction({ title: allowTitle(name), copy: allowCopy(name), yes: 'Allow', no: "Don't", safe: true });
        refocus(before, input.current);
        if (!yes) return true;
      }
      setPending(on);
      let ok = await send(on);
      if (on && offAfter.current) {
        offAfter.current = false;
        setPending(false);
        ok = (await send(false)) && ok;
      }
      return ok;
    } finally {
      saving.current = false;
      offAfter.current = false;
      setPending(null);
    }
  };

  return (
    <div className="wiz-assistant-allow" data-assistant-agent-allow-block={row.id}>
      <label className="wiz-assistant-switch">
        <span className="switch">
          <input
            ref={input}
            type="checkbox"
            role="switch"
            checked={shown}
            aria-checked={shown}
            aria-describedby={error ? `${warnId} ${errorId}` : warnId}
            data-assistant-agent-allow={row.id}
            onChange={(e) => void stepChange(toggle(e.currentTarget.checked))}
          />
          <span className="slider" aria-hidden="true" />
        </span>
        <span>{ALLOW_LABEL}</span>
      </label>
      <p id={warnId} className="wiz-assistant-warn" role="note" data-assistant-agent-allow-warning="1">
        {allowWarning(name)}
      </p>
      {error ? (
        <p id={errorId} className="wiz-assistant-error" role="alert" data-assistant-agent-allow-error="1">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Turn off an allow that no longer counts (holdsOldAllow): POST {id, allow: false}, no question. */
function TurnOff({ row, onRow, onReload, onDone }: { row: AgentRow; onRow: (row: AgentRow) => void; onReload: () => void; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const noteId = useId();

  const turnOff = async (): Promise<boolean> => {
    if (saving.current) return true;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      const next = await allowAgent(row.id, false, null);
      if (next) onRow(next);
      else onReload();
      onDone();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <div className="wiz-assistant-row" data-assistant-agent-turn-off-block={row.id}>
      <button type="button" className="home-btn" data-assistant-agent-turn-off={row.id} aria-describedby={noteId} aria-disabled={pending || undefined} onClick={() => void stepChange(turnOff())}>
        {pending ? 'Turning off…' : TURN_OFF_LABEL}
      </button>
      <span id={noteId} className="wiz-assistant-meta">
        {turnOffNote(row.name)}
      </span>
      {error ? (
        <span className="wiz-assistant-error" role="alert" data-assistant-agent-turn-off-error="1">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- sign in (spec 4.12)

function SignInBlock({
  row,
  methods,
  busy,
  onConnect,
  onSignIn,
}: {
  row: AgentRow;
  methods: SignInMethodView[];
  busy: boolean;
  onConnect: () => void;
  onSignIn: (m: SignInMethodView) => void;
}) {
  const headingId = useId();
  const noteId = useId();
  const name = row.name;
  const allowed = mayShowSignInCommand(row);
  const terminal = methods.filter((m) => m.type === 'terminal');
  const commands = allowed ? terminal.map((m) => ({ m, line: plainLine(m.command) })).filter((x): x is { m: SignInMethodView; line: string } => !!x.line) : [];
  const agentMethods = methods.filter((m) => m.type === 'agent');
  const vars = [...new Set(methods.flatMap((m) => m.vars))];
  return (
    <div className="wiz-assistant-signin" role="group" aria-labelledby={headingId} data-assistant-agent-signin={row.id}>
      <h4 id={headingId} className="wiz-assistant-subh">
        {signInHeading(name)}
      </h4>
      {commands.map(({ m, line }) => (
        <SignInCommand key={m.id} line={line} methodId={m.id} />
      ))}
      {/* A terminal way whose command Magnusim may not show, or no way here at all: its own documentation. */}
      {terminal.length > commands.length || (!commands.length && !agentMethods.length) ? (
        <p className="wiz-assistant-meta" data-assistant-agent-signin-docs="1">
          {signInDocsText(name)}
        </p>
      ) : null}
      {agentMethods.map((m) => (
        <div key={m.id} className="wiz-assistant-row">
          <button type="button" className="home-btn" data-assistant-agent-signin-method={m.id} aria-disabled={busy || undefined} onClick={() => !busy && onSignIn(m)}>
            {m.name}
          </button>
          <span className="wiz-assistant-meta">{SIGNIN_AGENT_NOTE}</span>
        </div>
      ))}
      {vars.map((v) => (
        <p key={v} className="wiz-assistant-meta" data-assistant-agent-signin-var={v}>
          {signInVarText(v)}
        </p>
      ))}
      <p className="wiz-assistant-meta" data-assistant-agent-signin-footer="1">
        {signInFooter(name)}
      </p>
      <div className="wiz-assistant-row">
        <button type="button" className="home-btn" data-assistant-agent-connect={row.id} aria-disabled={busy || undefined} aria-describedby={noteId} onClick={() => !busy && onConnect()}>
          {CONNECT_AGAIN}
        </button>
        <span id={noteId} className="wiz-assistant-meta">
          {connectNote(name)}
        </span>
      </div>
    </div>
  );
}

function SignInCommand({ line, methodId }: { line: string; methodId: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="wiz-assistant-signin-command">
      <p className="wiz-assistant-meta">{SIGNIN_TERMINAL_TEXT}</p>
      <div className="wiz-assistant-row">
        <code data-assistant-agent-signin-command={methodId}>{line}</code>
        <button type="button" className="home-btn" data-assistant-agent-signin-copy={methodId} onClick={() => void copy(line)}>
          Copy
        </button>
        <CopiedLine state={copied} hook={{ 'data-assistant-agent-signin-copied': copied ?? '' }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- model and mode (once listed)

/**
 * The modes the Mode select offers (spec 4.2): those the agent listed that Magnusim uses with it.
 * None for an agent kept in the mode it starts in ('initial'), or when the server doesn't say.
 */
export function offeredModes(row: Pick<AgentRow, 'last' | 'allowed_modes'>): ModeView[] {
  const allowed = row.allowed_modes;
  if (!Array.isArray(allowed)) return [];
  return (row.last?.modes ?? []).filter((m) => allowed.includes(m.id));
}

/**
 * The Mode select, or null when there is nothing to choose. With no mode chosen Magnusim sets the
 * first mode it uses with the agent at every start (over the person's own default; spec 4.6 step
 * 6), so that is what "none" says; when the agent didn't list that one, nothing is set and it
 * stays in the mode it starts in. Only that one mode offered (and none other saved): no select.
 */
export function modeChoice(row: Pick<AgentRow, 'last' | 'allowed_modes' | 'mode'>): { own: string; modes: ModeView[] } | null {
  const modes = offeredModes(row);
  const allowed = row.allowed_modes;
  if (!modes.length || !Array.isArray(allowed)) return null;
  const firstId = allowed[0];
  const first = modes.find((m) => m.id === firstId) ?? null;
  if (first && modes.length === 1 && (row.mode === null || row.mode === first.id)) return null;
  return { own: first ? magnusimModeText(first.name || first.id) : MODE_DEFAULT, modes };
}

function ChoiceBlock({ row, onReload }: { row: AgentRow; onReload: () => void }) {
  const models = row.last?.models ?? [];
  const modeView = modeChoice(row);
  const modes = modeView?.modes ?? [];
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ model?: string | null; mode?: string | null }>({});
  const errorId = useId();
  if (!models.length && !modes.length) return null;

  const save = async (key: 'model' | 'mode', value: string | null): Promise<boolean> => {
    setError('');
    setPending((p) => ({ ...p, [key]: value }));
    const r = await writeStatus(SETTINGS, { agents: { [row.id]: { [key]: value } } });
    setPending((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    if (!r.ok) setError(r.error.message);
    else onReload();
    return r.ok;
  };

  const model = pending.model !== undefined ? pending.model : row.model;
  const mode = pending.mode !== undefined ? pending.mode : row.mode;
  const select = (key: 'model' | 'mode', label: string, own: string, list: Array<{ id: string; name: string }>, value: string | null) => (
    <label className="wiz-assistant-row">
      <span className="wiz-assistant-h">{label}</span>
      <select
        className="wiz-assistant-input wiz-assistant-wide"
        value={value ?? ''}
        {...{ [`data-assistant-agent-${key}`]: value ?? '' }}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
        onChange={(e) => void stepChange(save(key, e.target.value || null))}
      >
        <option value="">{own}</option>
        {value && !list.some((x) => x.id === value) ? <option value={value}>{value}</option> : null}
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name || x.id}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="wiz-assistant-agent-choices">
      {models.length ? select('model', 'Model', MODEL_DEFAULT, models, model) : null}
      {modeView ? select('mode', 'Mode', modeView.own, modes, mode) : null}
      {error ? (
        <p id={errorId} className="wiz-assistant-error" role="alert" data-assistant-agent-choice-error="1">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- a custom agent

function CustomAgentForm({ id, onCancel, onAdded }: { id: string; onCancel: () => void; onAdded: (row: AgentRow) => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const [error, setError] = useState<{ text: string; field: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const commandField = useRef<HTMLInputElement>(null);
  const varsBlock = useRef<HTMLFieldSetElement>(null);
  const addVar = useRef<HTMLButtonElement>(null);
  const [focusVar, setFocusVar] = useState<number | null>(null);
  const helpId = useId();
  const varsHelpId = useId();
  const errorId = useId();
  const headingId = useId();

  useEffect(() => {
    nameField.current?.focus();
  }, []);
  useEffect(() => {
    if (focusVar === null) return;
    varsBlock.current?.querySelector<HTMLInputElement>(`[data-assistant-agent-custom-var="${focusVar}"]`)?.focus();
    setFocusVar(null);
  }, [focusVar, vars]);

  const invalid = (field: string) => (error && error.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const keep = vars.map((v) => v.trim()).filter(Boolean);
    if (!name.trim()) {
      setError({ text: 'Give the agent a name.', field: 'name' });
      nameField.current?.focus();
      return;
    }
    if (!command.trim()) {
      setError({ text: 'Enter the command that starts the agent.', field: 'command' });
      commandField.current?.focus();
      return;
    }
    setBusy(true);
    let ok = false;
    const done = stepChange(
      (async () => {
        try {
          const row = await addCustomAgent(name.trim(), command.trim(), keep);
          if (!row) throw new AssistantApiError(0, {}, "The agent was added, but Magnusim couldn't show it. Press Refresh.");
          ok = true;
          onAdded(row);
          return true;
        } catch (err) {
          const field = err instanceof AssistantApiError ? err.field : null;
          setError({ text: errorText(err), field });
          if (field === 'name') nameField.current?.focus();
          else if (field === 'command') commandField.current?.focus();
          else if (field === 'keep_env') varsBlock.current?.querySelector<HTMLInputElement>('input')?.focus();
          return false;
        }
      })(),
    );
    await done;
    if (!ok) setBusy(false);
  };

  return (
    <form id={id} className="wiz-assistant-custom" data-assistant-agent-custom-form="1" aria-labelledby={headingId} onSubmit={(e) => void submit(e)} noValidate>
      <h4 id={headingId} className="wiz-assistant-subh">
        Add a custom agent
      </h4>
      <label className="wiz-assistant-field">
        <span>Name</span>
        <input
          ref={nameField}
          className="wiz-assistant-input"
          type="text"
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          value={name}
          data-assistant-agent-custom-name="1"
          {...invalid('name')}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="wiz-assistant-field">
        <span>Command</span>
        <input
          ref={commandField}
          className="wiz-assistant-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={command}
          data-assistant-agent-custom-command="1"
          aria-describedby={error?.field === 'command' ? `${helpId} ${errorId}` : helpId}
          {...(error?.field === 'command' ? { 'aria-invalid': true } : {})}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <p id={helpId} className="wiz-assistant-meta" data-assistant-agent-custom-help="1">
        {CUSTOM_HELP}
      </p>
      <fieldset ref={varsBlock} className="wiz-assistant-vars" aria-describedby={varsHelpId} data-assistant-agent-custom-vars="1">
        <legend>Variables to pass (optional)</legend>
        <p id={varsHelpId} className="wiz-assistant-meta">
          {VARS_HELP}
        </p>
        {vars.map((v, i) => (
          <div key={i} className="wiz-assistant-row">
            <input
              className="wiz-assistant-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label={`Variable ${i + 1}`}
              placeholder="VARIABLE_NAME"
              value={v}
              data-assistant-agent-custom-var={i}
              {...invalid('keep_env')}
              onChange={(e) => setVars((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className="home-btn"
              data-assistant-agent-custom-var-remove={i}
              aria-label={`Remove variable ${i + 1}${v.trim() ? ` (${v.trim()})` : ''}`}
              onClick={() => {
                setVars((list) => list.filter((_, j) => j !== i));
                // Focus stays among the variables: the one now in this place, else the one before, else Add a variable.
                if (vars.length > 1) setFocusVar(Math.min(i, vars.length - 2));
                else addVar.current?.focus();
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          ref={addVar}
          type="button"
          className="home-btn"
          data-assistant-agent-custom-var-add="1"
          aria-disabled={vars.length >= KEEP_ENV_MAX || undefined}
          onClick={() => {
            if (vars.length >= KEEP_ENV_MAX) return;
            setVars((list) => [...list, '']);
            setFocusVar(vars.length);
          }}
        >
          Add a variable
        </button>
        {vars.length >= KEEP_ENV_MAX ? <p className="wiz-assistant-meta">{`At most ${KEEP_ENV_MAX} variables.`}</p> : null}
      </fieldset>
      {error ? (
        <p id={errorId} className="wiz-assistant-error" role="alert" data-assistant-agent-custom-error={error.field ?? '1'}>
          {error.text}
        </p>
      ) : null}
      <div className="wiz-assistant-row">
        <button type="submit" className="home-btn" data-assistant-agent-custom-add="1" aria-disabled={busy || undefined}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="home-btn" data-assistant-agent-custom-cancel="1" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
