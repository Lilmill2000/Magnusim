/**
 * The coding agents Magnusim knows (phase 3 spec 4.2): plain data, one entry per agent, and
 * the policy of a custom command. Agent names are allowed here (the vendor-name gate allows
 * scripts/server/assistant/**); no file is named after one.
 *
 * Each entry says:
 * - where its program is found (`programs`, in order) and how it starts in its ACP mode
 *   (`args`), the npm package it comes from (`npmPackage`) and the install line shown when it
 *   is missing;
 * - its login file (only ever checked for existence, never opened: discover.ts), the
 *   variable that moves that file's folder, and whether the login may live in the OS keyring
 *   instead (a missing file is then 'unknown', not 'signed out');
 * - its own key variables and variable prefixes, the only ones of the person's environment it
 *   gets besides the system's own (process.ts agentEnv);
 * - its lockdown class (spec 4.9): 'tools_off' (Magnusim switches its own shell, file and web
 *   tools off; checked on `checked.date` for `checked.package` at `checked.minVersion`),
 *   'documented' (treated as 'none' until a live check sets `checked`) or 'none'. A class
 *   other than 'none' applies only to a program resolved through its verified package
 *   (discover.ts, the identity rule); anything else is 'none' and needs the allow switch;
 * - the modes Magnusim may use (`allowedModes`; 'initial': only the one the session starts
 *   in), which adapter-set fields mark Magnusim's own tools (`ours`, acp.ts OursMatcher), an
 *   authenticate step before session/new (`startAuth`), its session/new hook (`sessionMeta`)
 *   and the variables Magnusim adds for it (`env`).
 *
 * The coding agents are programs the person installs; Magnusim never bundles or depends on
 * one. The deprecated `claude-code-acp` program is not here: it overwrites the options that
 * switch its tools off, so installed under that name it is found only as a custom command.
 */
import { CLAUDE_CODE_SESSION, MCP_SERVER_NAME, type OursRule, type SessionMetaHook } from './acp.ts';

export type Lockdown = 'tools_off' | 'documented' | 'none';

export interface LoginSpec {
  /** The login file, relative to the home folder ('/'-separated). */
  file: string;
  /** The variable that moves the folder the login file is in. */
  dirVar?: string;
  /** The login file's name inside `$<dirVar>`. */
  fileInDir?: string;
  /** The login may live in the OS keyring instead (always, or on these platforms only). */
  keyring?: boolean | readonly NodeJS.Platform[];
}

/** What env() needs at a start (agents/session.ts fills it). */
export interface AgentEnvContext {
  /** OpenCode: the person's default agent, read at discovery; its permissions are overridden too. */
  defaultAgent?: string | null;
  /** Gemini CLI: where Magnusim wrote systemSettings() for this process. */
  systemSettingsPath?: string | null;
}

export interface KnownAgent {
  id: string;
  name: string;
  /** Program names looked up in the search folders, in order. */
  programs: readonly string[];
  /** The arguments that start its ACP mode. */
  args: readonly string[];
  /** The npm package the program comes from (the identity rule). */
  npmPackage?: string;
  /** Shown when it isn't found. */
  install: string;
  login?: LoginSpec;
  keyVars: readonly string[];
  envPrefixes: readonly string[];
  lockdown: Lockdown;
  /** The live check that made `lockdown` hold: tools_off needs it. */
  checked?: { date: string; package: string; minVersion: string };
  allowedModes: readonly string[] | 'initial';
  ours: OursRule | null;
  /** Sent between initialize and session/new when initialize advertised one of these methods. */
  startAuth?: { methods: readonly string[]; meta?: Readonly<Record<string, unknown>> };
  /** Its addition to session/new (acp.ts sessionNewParams). */
  sessionMeta: SessionMetaHook | null;
  /**
   * Whether its adapter's initialize says it takes pictures (promptCapabilities.image), as its
   * source says: the dock's first state before Magnusim has started it (absent: not known). A
   * turn goes by what the agent's own initialize says.
   */
  images?: boolean;
  /**
   * The arguments that print its version, in place of its ACP arguments (null: it prints none and
   * is never asked). Grok Build's carry --no-auto-update, as its start does: the program updates
   * itself, and a version probe must never update it (whether --version alone would is UNVERIFIED).
   */
  versionArgs: readonly string[] | null;
  /** Variables Magnusim sets for it at a start. */
  env?(ctx: AgentEnvContext): Record<string, string>;
  /** Gemini CLI: the system settings file Magnusim writes for it (its path goes in env()). */
  systemSettings?(): string;
}

/** An agent id: a known one or `custom-<6 hex>` (settings keys, `agent:<id>` providers). */
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const CUSTOM_ID_RE = /^custom-[0-9a-f]{6}$/;

/** A provider that is a coding agent: `agent:<id>`. */
export type AgentProviderId = `agent:${string}`;

/** The agent id of an `agent:<id>` provider, or null. */
export function agentIdOf(provider: unknown): string | null {
  if (typeof provider !== 'string' || !provider.startsWith('agent:')) return null;
  const id = provider.slice('agent:'.length);
  return AGENT_ID_RE.test(id) ? id : null;
}

/** OpenCode's permission keys, each denied (`edit` covers edit, write and patch; there is no `list`). */
const OPENCODE_DENY: Readonly<Record<string, 'deny'>> = Object.freeze({
  bash: 'deny',
  edit: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  task: 'deny',
  skill: 'deny',
  lsp: 'deny',
  external_directory: 'deny',
});

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * OpenCode's config override (OPENCODE_CONFIG_CONTENT, applied after the person's own configs):
 * every own tool denied at the top and again under each agent it may run as (agent-level
 * permissions win), the person's default agent included.
 */
export function openCodeConfig(defaultAgent?: string | null): string {
  const agent: Record<string, { permission: Record<string, 'deny'> }> = {};
  const names = ['build', 'plan'];
  if (defaultAgent && AGENT_NAME_RE.test(defaultAgent) && !names.includes(defaultAgent)) names.push(defaultAgent);
  for (const n of names) Object.defineProperty(agent, n, { value: { permission: { ...OPENCODE_DENY } }, enumerable: true, writable: true, configurable: true });
  return JSON.stringify({ permission: { ...OPENCODE_DENY }, agent });
}

/** Gemini CLI's system settings (they take precedence over the person's): no built-in tools, no YOLO, only Magnusim's server. */
export function geminiSystemSettings(): string {
  return JSON.stringify({ tools: { core: [] }, security: { disableYoloMode: true }, mcp: { allowed: [MCP_SERVER_NAME] } });
}

export const KNOWN_AGENTS: readonly KnownAgent[] = Object.freeze([
  Object.freeze<KnownAgent>({
    id: 'claude',
    name: 'Claude Code',
    programs: ['claude-agent-acp'],
    args: [],
    npmPackage: '@agentclientprotocol/claude-agent-acp',
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    // Its own login file (the adapter reads CLAUDE_CONFIG_DIR); on macOS the login is in the keychain.
    login: { file: '.claude/.credentials.json', dirVar: 'CLAUDE_CONFIG_DIR', fileInDir: '.credentials.json', keyring: ['darwin'] },
    keyVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    envPrefixes: ['CLAUDE_', 'ANTHROPIC_'],
    lockdown: 'tools_off',
    // Its session options are spread after the adapter's own defaults from this version on.
    checked: { date: '2026-10-17', package: '@agentclientprotocol/claude-agent-acp', minVersion: '0.85.1' },
    allowedModes: ['default'],
    ours: 'tool_name_meta',
    sessionMeta: CLAUDE_CODE_SESSION,
    images: true,
    versionArgs: ['--version'],
  }),
  Object.freeze<KnownAgent>({
    id: 'codex',
    name: 'Codex',
    programs: ['codex-acp'],
    args: [],
    npmPackage: '@agentclientprotocol/codex-acp',
    install: 'npm install -g @agentclientprotocol/codex-acp',
    // The login may be in the OS keyring (cli_auth_credentials_store): a missing file is unknown.
    login: { file: '.codex/auth.json', dirVar: 'CODEX_HOME', fileInDir: 'auth.json', keyring: true },
    keyVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    envPrefixes: ['CODEX_', 'OPENAI_'],
    lockdown: 'none',
    // Its default mode reviews and approves its own actions: read-only makes edits ask.
    allowedModes: ['read-only'],
    ours: 'mcp_call_flag',
    sessionMeta: null,
    images: true,
    versionArgs: ['--version'],
    env: () => ({
      INITIAL_AGENT_MODE: 'read-only',
      CODEX_CONFIG: JSON.stringify({ web_search: 'disabled', features: { shell_tool: false } }),
      // Else it drops a client-given server whose name is in the person's own config.
      DISABLE_MCP_CONFIG_FILTERING: 'true',
    }),
  }),
  Object.freeze<KnownAgent>({
    id: 'opencode',
    name: 'OpenCode',
    programs: ['opencode'],
    args: ['acp'],
    npmPackage: 'opencode-ai',
    install: 'npm install -g opencode-ai',
    login: { file: '.local/share/opencode/auth.json' },
    keyVars: [],
    envPrefixes: ['OPENCODE_'],
    lockdown: 'documented',
    allowedModes: 'initial',
    ours: null,
    sessionMeta: null,
    images: true,
    versionArgs: ['--version'],
    env: (ctx) => ({ OPENCODE_CONFIG_CONTENT: openCodeConfig(ctx.defaultAgent) }),
  }),
  Object.freeze<KnownAgent>({
    id: 'grok',
    name: 'Grok Build',
    programs: ['grok'],
    args: ['--no-auto-update', 'agent', 'stdio'],
    npmPackage: '@xai-official/grok',
    install: 'Install Grok Build (docs.x.ai/build), then run grok login',
    login: { file: '.grok/auth.json' },
    keyVars: ['XAI_API_KEY'],
    envPrefixes: ['XAI_', 'GROK_'],
    lockdown: 'none',
    allowedModes: 'initial',
    ours: null,
    startAuth: { methods: ['xai.api_key', 'cached_token'], meta: { headless: true } },
    sessionMeta: null,
    versionArgs: ['--no-auto-update', '--version'],
  }),
  Object.freeze<KnownAgent>({
    id: 'gemini',
    name: 'Gemini CLI',
    programs: ['gemini'],
    args: ['--acp'],
    npmPackage: '@google/gemini-cli',
    install: 'npm install -g @google/gemini-cli',
    login: { file: '.gemini/oauth_creds.json' },
    keyVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    envPrefixes: ['GEMINI_', 'GOOGLE_'],
    lockdown: 'documented',
    allowedModes: ['default'],
    ours: null,
    sessionMeta: null,
    images: true,
    versionArgs: ['--version'],
    env: (ctx): Record<string, string> => (ctx.systemSettingsPath ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: ctx.systemSettingsPath } : {}),
    systemSettings: geminiSystemSettings,
  }),
]);

/** The catalogue entry of a known agent id (own entries only), or null. */
export function knownAgent(id: unknown): KnownAgent | null {
  return KNOWN_AGENTS.find((a) => a.id === id) ?? null;
}

/** What a coding agent may do as Magnusim runs it, known or custom. */
export interface AgentPolicy {
  allowedModes: readonly string[] | 'initial';
  ours: OursRule | null;
  sessionMeta: SessionMetaHook | null;
  startAuth: KnownAgent['startAuth'] | null;
}

/** A custom command's policy: only the mode it starts in, every permission request a question, no hooks. */
export const CUSTOM_POLICY: AgentPolicy = Object.freeze({ allowedModes: 'initial', ours: null, sessionMeta: null, startAuth: null });

export function policyOf(known: KnownAgent | null): AgentPolicy {
  if (!known) return CUSTOM_POLICY;
  return { allowedModes: known.allowedModes, ours: known.ours, sessionMeta: known.sessionMeta, startAuth: known.startAuth ?? null };
}

/** Whether `mode` may be chosen for this agent (a custom command: none). */
export function modeAllowed(known: KnownAgent | null, mode: string): boolean {
  const allowed = policyOf(known).allowedModes;
  return allowed !== 'initial' && allowed.includes(mode);
}
