/**
 * The Assistant's non-secret settings (Foundation spec 4.1):
 * `<home>/assistant/settings.json`. Node is the only writer; every save goes through one
 * queue and writes the whole object atomically.
 *
 * They are kept out of the app's local settings file and /api/prefs on purpose: that file
 * is written non-atomically by Node and by Python, POST /api/prefs is open to remote
 * visitors, and its public part feeds every page. A base URL in particular decides where
 * project data goes, so only the Assistant's own local-only routes change it.
 */
import { join } from 'node:path';
import { AGENT_ID_RE, agentIdOf, CUSTOM_ID_RE, knownAgent, modeAllowed, type AgentProviderId } from './agents/known.ts';
import { readJsonFile, writeFileAtomic } from './files.ts';
import { assistantDataDir } from './home.ts';
import { alog } from './log.ts';
import { assistantState } from './state.ts';
import type { Effort, ProviderId } from './types.ts';

export type { Effort, ProviderId } from './types.ts';
export type { AgentProviderId } from './agents/known.ts';

/** The default provider: off, an API-key provider or local server, or a coding agent (`agent:<id>`). */
export type ProviderChoice = 'off' | ProviderId | AgentProviderId;

/** Whether a provider choice is a coding agent (`agent:<id>`, any well-formed id). */
export function isAgentProvider(p: unknown): p is AgentProviderId {
  return agentIdOf(p) !== null;
}
export type PrivacyMode = 'ask' | 'allow' | 'deny';

export interface Caps {
  /** $ per turn, 0.05–100. */
  turn_usd: number;
  /** $ per day, 0.10–1000, at least turn_usd. */
  day_usd: number;
  /** Tool calls per turn, 1–200. */
  steps: number;
  /** Active minutes per turn, 1–240. */
  turn_minutes: number;
  /** Tokens per turn, 10k–50M. */
  turn_tokens: number;
}

/**
 * Other apps (MCP): whether external apps may use Magnusim's tools (coding agents use the
 * connection whatever this says), and the loopback port the connection last bound (saved
 * the first time, so a client's bridge finds it again; not secret). ask_in_client is
 * reserved and always false.
 */
export interface McpSettings {
  clients: boolean;
  port: number | null;
  ask_in_client: false;
}

/**
 * A coding agent's saved choices (phase 3 spec 5.1). `allowed` (the allow switch, with the
 * fingerprint of the command it was given for) and `lockdown_failed` (the lockdown tripwire
 * fired, with Magnusim's version) change only through setAgentAllowed() and
 * setAgentLockdownFailed(), never through a settings save.
 */
export interface AgentPrefs {
  model: string | null;
  mode: string | null;
  allowed: { fingerprint: string; at: string } | null;
  lockdown_failed: { version: string; at: string } | null;
}

/** A coding agent the person added as a command (its own routes add and remove it). */
export interface CustomAgent {
  /** custom-<6 hex>. */
  id: string;
  /** 1–40 characters, cleaned. */
  name: string;
  /** The program and its arguments: 1–32 parts, each at most 1024 characters. Never run through a shell. */
  argv: string[];
  /** At most 8 more variable names it gets (^[A-Za-z_][A-Za-z0-9_]{0,63}$). */
  keep_env: string[];
}

/** Limits for a turn on a coding agent: changes, tool calls and active minutes per message. */
export interface AgentCaps {
  changes: number;
  calls: number;
  turn_minutes: number;
}

/** One project's answer: its created_at when asked, and each destination it may go to (with when). */
export interface Consent {
  created_at: string | null;
  to: Record<string, string>;
}

export interface AssistantSettings {
  version: 1;
  /** The default provider: a turn or a conversation may name another. */
  provider: ProviderChoice;
  /** Each provider's own model, kept whatever the default is. */
  models: Record<ProviderId, string>;
  base_url: string;
  /** The non-loopback base_url the person confirmed (such a server counts as cloud). */
  base_url_confirmed_remote: string | null;
  effort: Effort;
  privacy: PrivacyMode;
  caps: Caps;
  consents: Record<string, Consent>;
  mcp: McpSettings;
  /** Each coding agent's saved choices, by agent id (known or custom). */
  agents: Record<string, AgentPrefs>;
  /** At most 8. */
  custom_agents: CustomAgent[];
  agent_caps: AgentCaps;
  /**
   * "Keep a provider log for a problem report" (Settings → Assistant), off by default: while on,
   * every model request is written to the provider log (debug-log.ts, <home>/assistant/logs).
   */
  provider_log: boolean;
}

export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(['anthropic', 'openai', 'openai_compatible']);
const PROVIDER_CHOICES: readonly ProviderChoice[] = Object.freeze(['off', ...PROVIDER_IDS]);

/** `v` as a provider choice these settings know: off, an API-key provider, or one of their coding agents (known or custom). */
export function providerChoiceOf(s: Pick<AssistantSettings, 'custom_agents'>, v: unknown): ProviderChoice | null {
  if (PROVIDER_CHOICES.includes(v as ProviderChoice)) return v as ProviderChoice;
  const id = agentIdOf(v);
  return id && isAgentOf(s, id) ? (v as AgentProviderId) : null;
}
const EFFORTS: readonly Effort[] = Object.freeze(['default', 'low', 'medium', 'high']);
const PRIVACY: readonly PrivacyMode[] = Object.freeze(['ask', 'allow', 'deny']);

export const CAP_BOUNDS: Readonly<Record<keyof Caps, { min: number; max: number; integer: boolean }>> = Object.freeze({
  turn_usd: { min: 0.05, max: 100, integer: false },
  day_usd: { min: 0.1, max: 1000, integer: false },
  steps: { min: 1, max: 200, integer: true },
  turn_minutes: { min: 1, max: 240, integer: true },
  turn_tokens: { min: 10_000, max: 50_000_000, integer: true },
});

export const AGENT_CAP_BOUNDS: Readonly<Record<keyof AgentCaps, { min: number; max: number }>> = Object.freeze({
  changes: { min: 1, max: 200 },
  calls: { min: 10, max: 2000 },
  turn_minutes: { min: 1, max: 240 },
});

export const CUSTOM_AGENTS_MAX = 8;
export const CUSTOM_NAME_MAX = 40;
export const CUSTOM_ARGV_MAX = 32;
export const CUSTOM_ARG_CHARS = 1024;
export const KEEP_ENV_MAX = 8;
export const KEEP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const BASE_URL_MAX = 300;

const DEFAULTS: AssistantSettings = {
  version: 1,
  provider: 'off',
  models: { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: '' },
  base_url: 'http://127.0.0.1:1234/v1',
  base_url_confirmed_remote: null,
  effort: 'default',
  privacy: 'ask',
  caps: { turn_usd: 8, day_usd: 15, steps: 120, turn_minutes: 60, turn_tokens: 10_000_000 },
  consents: {},
  mcp: { clients: false, port: null, ask_in_client: false },
  agents: {},
  custom_agents: [],
  agent_caps: { changes: 24, calls: 400, turn_minutes: 60 },
  provider_log: false,
};

/** A fresh copy of the defaults. */
export function defaultSettings(): AssistantSettings {
  return structuredClone(DEFAULTS);
}

export const DEFAULT_SETTINGS: Readonly<AssistantSettings> = Object.freeze(defaultSettings());

// ---------------------------------------------------------------- base URL

/** 127.0.0.0/8, ::1 and localhost: a server on this PC. */
export function isLoopbackHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A server address's origin (`http://127.0.0.1:1234`), or null when it is not an http(s) URL. */
export function serverOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

type UrlCheck = { ok: true; url: string; loopback: boolean } | { ok: false; error: string };

/** http/https, no user info, query or fragment, at most 300 characters, no trailing slash (removed). */
export function checkBaseUrl(input: unknown): UrlCheck {
  if (typeof input !== 'string') return { ok: false, error: 'The server address must be text.' };
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return { ok: false, error: 'Enter the server address.' };
  if (text.length > BASE_URL_MAX) return { ok: false, error: `The server address is longer than ${BASE_URL_MAX} characters.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'The server address is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The server address must start with http:// or https://.' };
  if (url.username || url.password) return { ok: false, error: 'The server address must not hold a user name or password.' };
  if (text.includes('?') || text.includes('#')) return { ok: false, error: 'The server address must not hold a query or a fragment.' };
  if (!url.hostname) return { ok: false, error: 'The server address has no host.' };
  return { ok: true, url: text, loopback: isLoopbackHost(url.hostname) };
}

// ---------------------------------------------------------------- loading

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function capValid(key: keyof Caps, v: unknown): v is number {
  const b = CAP_BOUNDS[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= b.min && v <= b.max && (!b.integer || Number.isInteger(v));
}

// Consents are keyed by project id and destination, which come from project files: any
// name, "__proto__" and "constructor" included. So they are read as own properties only,
// and written as own properties (never through the __proto__ setter).

function ownValue<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function normalizeConsents(raw: unknown): Record<string, Consent> {
  const out: Record<string, Consent> = {};
  if (!isRecord(raw)) return out;
  for (const [pid, c] of Object.entries(raw)) {
    if (!pid || !isRecord(c) || !isRecord(c.to)) continue;
    const to: Record<string, string> = {};
    for (const [dest, at] of Object.entries(c.to)) if (dest && typeof at === 'string') setOwn(to, dest, at);
    setOwn(out, pid, { created_at: typeof c.created_at === 'string' ? c.created_at : null, to });
  }
  return out;
}

function shortText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Whether `name` may be a custom agent's name: 1–40 characters, counted as cleanText counts
 * them (code points, so an emoji is one), with no control character.
 */
export function customNameValid(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false;
  return [...name].length <= CUSTOM_NAME_MAX && !/\p{Cc}/u.test(name);
}

/** A custom agent as stored, or null when it breaks a rule. */
export function normalizeCustomAgent(raw: unknown): CustomAgent | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !CUSTOM_ID_RE.test(raw.id)) return null;
  if (!customNameValid(raw.name)) return null;
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > CUSTOM_ARGV_MAX) return null;
  if (!argv.every((a) => typeof a === 'string' && a.length <= CUSTOM_ARG_CHARS && !a.includes('\0')) || !argv[0]) return null;
  const keep = Array.isArray(raw.keep_env) ? raw.keep_env : [];
  if (keep.length > KEEP_ENV_MAX || !keep.every((k) => typeof k === 'string' && KEEP_ENV_RE.test(k))) return null;
  return { id: raw.id, name: raw.name, argv: [...(argv as string[])], keep_env: [...new Set(keep as string[])] };
}

/**
 * An agent's saved choices as read. A mode is kept only when Magnusim may use it for that agent
 * now (its allowedModes; a custom command: none), so a mode written by hand or kept from an
 * older catalogue never reaches a session.
 */
function normalizeAgentPrefs(id: string, raw: unknown): AgentPrefs {
  const p: AgentPrefs = { model: null, mode: null, allowed: null, lockdown_failed: null };
  if (!isRecord(raw)) return p;
  if (typeof raw.model === 'string' && MODEL_RE.test(raw.model)) p.model = raw.model;
  if (typeof raw.mode === 'string' && MODEL_RE.test(raw.mode) && modeAllowed(knownAgent(id), raw.mode)) p.mode = raw.mode;
  const a = raw.allowed;
  if (isRecord(a) && typeof a.fingerprint === 'string' && FINGERPRINT_RE.test(a.fingerprint) && shortText(a.at, 40)) p.allowed = { fingerprint: a.fingerprint, at: a.at };
  const l = raw.lockdown_failed;
  if (isRecord(l) && typeof l.version === 'string' && l.version.length <= 40 && shortText(l.at, 40)) p.lockdown_failed = { version: l.version, at: l.at };
  return p;
}

/** Whether `id` is a coding agent of these settings: a known one, or one of its custom agents. */
export function isAgentOf(s: Pick<AssistantSettings, 'custom_agents'>, id: unknown): id is string {
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return false;
  return !!knownAgent(id) || s.custom_agents.some((c) => c.id === id);
}

/** That agent's saved choices (the defaults when none were saved). */
export function agentPrefs(s: Pick<AssistantSettings, 'agents'>, id: string): AgentPrefs {
  return structuredClone(ownValue(s.agents, id) ?? { model: null, mode: null, allowed: null, lockdown_failed: null });
}

/** A settings file as read: each field that is missing or invalid takes its default. */
export function normalizeSettings(raw: unknown): AssistantSettings {
  const s = defaultSettings();
  if (!isRecord(raw)) return s;
  if (isRecord(raw.models)) {
    for (const id of PROVIDER_IDS) {
      const m = raw.models[id];
      if (typeof m === 'string' && (MODEL_RE.test(m) || (m === '' && id === 'openai_compatible'))) s.models[id] = m;
    }
  }
  const url = checkBaseUrl(raw.base_url);
  if (url.ok) {
    const confirmed = typeof raw.base_url_confirmed_remote === 'string' ? raw.base_url_confirmed_remote : null;
    // A remote server nobody confirmed here never becomes the destination.
    if (url.loopback) s.base_url = url.url;
    else if (confirmed === url.url) {
      s.base_url = url.url;
      s.base_url_confirmed_remote = url.url;
    }
  }
  if (EFFORTS.includes(raw.effort as Effort)) s.effort = raw.effort as Effort;
  if (PRIVACY.includes(raw.privacy as PrivacyMode)) s.privacy = raw.privacy as PrivacyMode;
  if (isRecord(raw.caps)) {
    const caps = { ...s.caps };
    for (const key of Object.keys(CAP_BOUNDS) as Array<keyof Caps>) {
      const v = raw.caps[key];
      if (capValid(key, v)) caps[key] = v;
    }
    if (caps.day_usd >= caps.turn_usd) s.caps = caps;
  }
  s.consents = normalizeConsents(raw.consents);
  if (isRecord(raw.mcp)) {
    if (typeof raw.mcp.clients === 'boolean') s.mcp.clients = raw.mcp.clients;
    if (isPort(raw.mcp.port)) s.mcp.port = raw.mcp.port;
  }
  if (Array.isArray(raw.custom_agents)) {
    for (const c of raw.custom_agents) {
      const agent = normalizeCustomAgent(c);
      if (agent && s.custom_agents.length < CUSTOM_AGENTS_MAX && !s.custom_agents.some((x) => x.id === agent.id)) s.custom_agents.push(agent);
    }
  }
  // After the custom agents: a default that is one of them must still be one.
  s.provider = providerChoiceOf(s, raw.provider) ?? s.provider;
  // Agent ids come from the file: own properties only, and only agents these settings know.
  if (isRecord(raw.agents)) {
    for (const [id, p] of Object.entries(raw.agents)) if (isAgentOf(s, id)) setOwn(s.agents, id, normalizeAgentPrefs(id, p));
  }
  if (isRecord(raw.agent_caps)) {
    for (const key of Object.keys(AGENT_CAP_BOUNDS) as Array<keyof AgentCaps>) {
      const v = raw.agent_caps[key];
      if (agentCapValid(key, v)) s.agent_caps[key] = v;
    }
  }
  if (typeof raw.provider_log === 'boolean') s.provider_log = raw.provider_log;
  return s;
}

function agentCapValid(key: keyof AgentCaps, v: unknown): v is number {
  const b = AGENT_CAP_BOUNDS[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max;
}

/** A TCP port a listener may bind (1–65535). */
export function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65_535;
}

function settingsPath(): string {
  const st = assistantState().settings;
  if (!st.path) st.path = join(assistantDataDir(), 'settings.json');
  return st.path;
}

/** The current settings (read once from disk, then kept in memory). A copy: changing it changes nothing. */
export async function loadSettings(): Promise<AssistantSettings> {
  const st = assistantState().settings;
  if (!st.cache) {
    const path = settingsPath();
    const r = await readJsonFile(path);
    if (r.state === 'bad') alog('warn', 'settings.json could not be read; using the defaults', { error: r.error });
    const doc = normalizeSettings(r.state === 'ok' ? r.value : null);
    // A save that ran meanwhile wins over this read.
    if (!st.cache) st.cache = doc;
  }
  return structuredClone(st.cache);
}

// ---------------------------------------------------------------- saving

export type PatchResult =
  | { ok: true; settings: AssistantSettings }
  | { ok: false; status: 400 | 409; error: string; field?: string; needs_confirm?: 'base_url' };

const PATCH_KEYS = new Set(['provider', 'model', 'models', 'base_url', 'confirm_remote', 'effort', 'privacy', 'caps', 'forget_consents', 'mcp', 'agents', 'agent_caps', 'custom_agents', 'provider_log']);

const MODEL_TEXT = 'A model id is 1–128 letters, digits and . _ : / -.';

function refuse(error: string, field: string): PatchResult {
  return { ok: false, status: 400, error, field };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * `current` with a page's partial change applied, or why not: 400 {error, field} for an
 * unknown key or a value out of range, 409 {needs_confirm:'base_url'} for a server
 * outside this PC that nobody confirmed. Pure: writes nothing.
 */
export function validatePatch(current: AssistantSettings, patch: unknown): PatchResult {
  if (!isRecord(patch)) return refuse('Settings must be an object.', '');
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) return refuse(`Unknown setting "${key.slice(0, 40)}".`, key.slice(0, 40));
  }
  const next = structuredClone(current);
  if ('provider' in patch) {
    // A coding agent may be the default whether or not it is installed or allowed: readiness says why it can't run.
    const choice = providerChoiceOf(next, patch.provider);
    if (!choice) return refuse('Unknown provider.', 'provider');
    next.provider = choice;
  }
  // Each provider keeps its own model, whatever the default: Settings' cards each save their own.
  if ('models' in patch) {
    if (!isRecord(patch.models)) return refuse('models must be an object of provider and model id.', 'models');
    for (const [id, m] of Object.entries(patch.models)) {
      // Own names only: "constructor" or "__proto__" is no provider.
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) return refuse(`Unknown provider "${id.slice(0, 40)}".`, `models.${id.slice(0, 40)}`);
      if (typeof m !== 'string' || !MODEL_RE.test(m)) return refuse(MODEL_TEXT, `models.${id}`);
      next.models[id as ProviderId] = m;
    }
  }
  // The bare `model` (older pages) is the default's: refused while the default is Off.
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || !MODEL_RE.test(patch.model)) return refuse(MODEL_TEXT, 'model');
    if (next.provider === 'off') return refuse('Choose a provider before a model.', 'model');
    if (isAgentProvider(next.provider)) return refuse("A coding agent's model is saved with its own choices (agents.<id>.model).", 'model');
    next.models[next.provider] = patch.model;
  }
  if ('confirm_remote' in patch && typeof patch.confirm_remote !== 'boolean') return refuse('confirm_remote must be true or false.', 'confirm_remote');
  if ('base_url' in patch) {
    const url = checkBaseUrl(patch.base_url);
    if (!url.ok) return refuse(url.error, 'base_url');
    if (url.loopback) {
      next.base_url_confirmed_remote = null;
    } else if (patch.confirm_remote === true || current.base_url_confirmed_remote === url.url) {
      next.base_url_confirmed_remote = url.url;
    } else {
      return {
        ok: false,
        status: 409,
        error: 'That server is not on this PC: project data you ask about would go to it. Confirm to use it.',
        field: 'base_url',
        needs_confirm: 'base_url',
      };
    }
    next.base_url = url.url;
  }
  if ('effort' in patch) {
    if (!EFFORTS.includes(patch.effort as Effort)) return refuse('Effort is default, low, medium or high.', 'effort');
    next.effort = patch.effort as Effort;
  }
  if ('privacy' in patch) {
    if (!PRIVACY.includes(patch.privacy as PrivacyMode)) return refuse('Privacy is ask, allow or deny.', 'privacy');
    next.privacy = patch.privacy as PrivacyMode;
  }
  if ('caps' in patch) {
    if (!isRecord(patch.caps)) return refuse('Limits must be an object.', 'caps');
    for (const [key, v] of Object.entries(patch.caps)) {
      // Own names only: "constructor" or "__proto__" is no limit.
      if (!Object.hasOwn(CAP_BOUNDS, key)) return refuse(`Unknown limit "${key.slice(0, 40)}".`, `caps.${key.slice(0, 40)}`);
      const k = key as keyof Caps;
      const b = CAP_BOUNDS[k];
      if (!capValid(k, v)) {
        const range = b.integer ? `a whole number from ${b.min.toLocaleString('en-US')} to ${b.max.toLocaleString('en-US')}` : `from ${usd(b.min)} to ${usd(b.max)}`;
        return refuse(`This limit must be ${range}.`, `caps.${k}`);
      }
      next.caps[k] = v;
    }
    if (next.caps.day_usd < next.caps.turn_usd) return refuse('The daily limit must be at least the per-turn limit.', 'caps.day_usd');
  }
  if ('forget_consents' in patch) {
    if (typeof patch.forget_consents !== 'boolean') return refuse('forget_consents must be true or false.', 'forget_consents');
    if (patch.forget_consents) next.consents = {};
  }
  if ('mcp' in patch) {
    // Only the switch: the port is the listener's own, ask_in_client is reserved.
    if (!isRecord(patch.mcp)) return refuse('Other apps (MCP) settings must be an object.', 'mcp');
    for (const key of Object.keys(patch.mcp)) {
      if (key !== 'clients') return refuse(`Unknown setting "mcp.${key.slice(0, 40)}".`, `mcp.${key.slice(0, 40)}`);
    }
    if ('clients' in patch.mcp) {
      if (typeof patch.mcp.clients !== 'boolean') return refuse('mcp.clients must be true or false.', 'mcp.clients');
      next.mcp.clients = patch.mcp.clients;
    }
  }
  if ('provider_log' in patch) {
    if (typeof patch.provider_log !== 'boolean') return refuse('provider_log must be true or false.', 'provider_log');
    next.provider_log = patch.provider_log;
  }
  if ('custom_agents' in patch) return refuse('Custom agents are added and removed in Settings → Assistant, one at a time.', 'custom_agents');
  if ('agents' in patch) {
    const r = applyAgentsPatch(next, patch.agents);
    if (r) return r;
  }
  if ('agent_caps' in patch) {
    if (!isRecord(patch.agent_caps)) return refuse('Coding agent limits must be an object.', 'agent_caps');
    for (const [key, v] of Object.entries(patch.agent_caps)) {
      if (!Object.hasOwn(AGENT_CAP_BOUNDS, key)) return refuse(`Unknown limit "${key.slice(0, 40)}".`, `agent_caps.${key.slice(0, 40)}`);
      const k = key as keyof AgentCaps;
      const b = AGENT_CAP_BOUNDS[k];
      if (!agentCapValid(k, v)) return refuse(`This limit must be a whole number from ${b.min.toLocaleString('en-US')} to ${b.max.toLocaleString('en-US')}.`, `agent_caps.${k}`);
      next.agent_caps[k] = v;
    }
  }
  return { ok: true, settings: next };
}

/**
 * `agents: {<id>: {model?, mode?}}` applied to `next`, or the refusal. The allow switch and the
 * lockdown record are never a settings field (spec 4.9): any `allowed` or `lockdown_failed`
 * is refused, whatever else the patch holds. A mode must be one the agent may use.
 */
function applyAgentsPatch(next: AssistantSettings, raw: unknown): PatchResult | null {
  if (!isRecord(raw)) return refuse('agents must be an object of agent id and its choices.', 'agents');
  const entries = Object.entries(raw);
  for (const [, p] of entries) {
    if (!isRecord(p)) continue;
    if (Object.hasOwn(p, 'allowed')) return refuse('An agent is allowed only with its own switch in Settings → Assistant, in the Magnusim window.', 'agents.allowed');
    if (Object.hasOwn(p, 'lockdown_failed')) return refuse('That record is kept by Magnusim itself.', 'agents.lockdown_failed');
  }
  for (const [id, p] of entries) {
    const shown = id.slice(0, 40);
    if (!isAgentOf(next, id)) return refuse(`Unknown coding agent "${shown}".`, `agents.${shown}`);
    if (!isRecord(p)) return refuse("An agent's choices must be an object.", `agents.${shown}`);
    const prefs = agentPrefs(next, id);
    for (const [key, v] of Object.entries(p)) {
      if (key === 'model') {
        if (v !== null && (typeof v !== 'string' || !MODEL_RE.test(v))) return refuse(MODEL_TEXT, 'agents.model');
        prefs.model = v as string | null;
      } else if (key === 'mode') {
        if (v !== null && (typeof v !== 'string' || !modeAllowed(knownAgent(id), v))) return refuse('Magnusim does not use that mode for this agent.', 'agents.mode');
        prefs.mode = v as string | null;
      } else {
        return refuse(`Unknown setting "agents.${key.slice(0, 40)}".`, `agents.${key.slice(0, 40)}`);
      }
    }
    setOwn(next.agents, id, prefs);
  }
  return null;
}

/** Runs `op` after every save queued before it (one queue, so no save is lost). */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const st = assistantState().settings;
  const run = st.queue.then(op, op);
  st.queue = run.catch(() => {});
  return run;
}

async function write(next: AssistantSettings): Promise<void> {
  const st = assistantState().settings;
  await writeFileAtomic(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  st.cache = structuredClone(next);
}

/** Applies a page's change on top of the latest settings and writes them (nothing on a refusal). A write error throws. */
export function saveSettings(patch: unknown): Promise<PatchResult> {
  return enqueue(async () => {
    const result = validatePatch(await loadSettings(), patch);
    if (result.ok) await write(result.settings);
    return result;
  });
}

// ---------------------------------------------------------------- coding agents (their own routes)

/**
 * The allow switch (spec 4.9): `{fingerprint}` turns it on for the command with that
 * fingerprint; null turns it off. Only the allow route calls this.
 */
export function setAgentAllowed(id: string, allowed: { fingerprint: string; at?: string } | null): Promise<AssistantSettings> {
  return updateSettings((s) => {
    if (!isAgentOf(s, id)) return s;
    const p = agentPrefs(s, id);
    p.allowed = allowed ? { fingerprint: allowed.fingerprint, at: allowed.at ?? new Date().toISOString() } : null;
    setOwn(s.agents, id, p);
    return s;
  });
}

/** The lockdown tripwire fired (spec 4.7) under Magnusim `version`; null clears it. */
export function setAgentLockdownFailed(id: string, version: string | null): Promise<AssistantSettings> {
  return updateSettings((s) => {
    if (!isAgentOf(s, id)) return s;
    const p = agentPrefs(s, id);
    p.lockdown_failed = version === null ? null : { version: version.slice(0, 40), at: new Date().toISOString() };
    setOwn(s.agents, id, p);
    return s;
  });
}

/** Adds a custom agent (checked by normalizeCustomAgent), or says why not. */
export function addCustomAgent(agent: CustomAgent): Promise<{ ok: true; settings: AssistantSettings } | { ok: false; code: 'too_many' | 'bad_command' }> {
  return enqueue(async () => {
    const s = await loadSettings();
    const c = normalizeCustomAgent(agent);
    if (!c || s.custom_agents.some((x) => x.id === c.id)) return { ok: false as const, code: 'bad_command' as const };
    if (s.custom_agents.length >= CUSTOM_AGENTS_MAX) return { ok: false as const, code: 'too_many' as const };
    s.custom_agents.push(c);
    const next = normalizeSettings(s);
    await write(next);
    return { ok: true as const, settings: structuredClone(next) };
  });
}

/** Removes a custom agent and its saved choices; false when there is none with that id. */
export function removeCustomAgent(id: string): Promise<boolean> {
  return enqueue(async () => {
    const s = await loadSettings();
    if (!s.custom_agents.some((c) => c.id === id)) return false;
    s.custom_agents = s.custom_agents.filter((c) => c.id !== id);
    if (Object.hasOwn(s.agents, id)) delete s.agents[id];
    await write(normalizeSettings(s));
    return true;
  });
}

/** Applies `fn` to the latest settings and writes the result. */
export function updateSettings(fn: (s: AssistantSettings) => AssistantSettings): Promise<AssistantSettings> {
  return enqueue(async () => {
    const next = normalizeSettings(fn(await loadSettings()));
    await write(next);
    return structuredClone(next);
  });
}

// ---------------------------------------------------------------- consent (per project and destination)

/** True when this project, as it is now (its created_at), may go to `destination`. */
export function hasConsent(s: AssistantSettings, projectId: string, createdAt: string | null, destination: string): boolean {
  const c = ownValue(s.consents, projectId);
  if (!c || !isRecord(c.to) || !ownValue(c.to, destination)) return false;
  return c.created_at === createdAt;
}

/** `s` with "Send" remembered for this project and destination. A changed created_at starts the project's answers afresh. */
export function withConsent(
  s: AssistantSettings,
  projectId: string,
  createdAt: string | null,
  destination: string,
  at: Date = new Date(),
): AssistantSettings {
  const next = structuredClone(s);
  const prev = ownValue(next.consents, projectId);
  const to: Record<string, string> = prev && prev.created_at === createdAt ? { ...prev.to } : {};
  setOwn(to, destination, at.toISOString());
  setOwn(next.consents, projectId, { created_at: createdAt, to });
  return next;
}

/** Remembers "Send" and writes it. */
export function rememberConsent(projectId: string, createdAt: string | null, destination: string): Promise<AssistantSettings> {
  return updateSettings((s) => withConsent(s, projectId, createdAt, destination));
}

/** How many projects have an answer remembered ("Forget project answers (N)"): the project list's (`*projects`) is not a project. */
export function consentCount(s: AssistantSettings): number {
  return Object.keys(s.consents).filter((k) => k !== '*projects').length;
}
