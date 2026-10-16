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
import { readJsonFile, writeFileAtomic } from './files.ts';
import { assistantDataDir } from './home.ts';
import { alog } from './log.ts';
import { assistantState } from './state.ts';
import type { Effort, ProviderId } from './types.ts';

export type { Effort, ProviderId } from './types.ts';

export type ProviderChoice = 'off' | ProviderId;
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

/** One project's answer: its created_at when asked, and each destination it may go to (with when). */
export interface Consent {
  created_at: string | null;
  to: Record<string, string>;
}

export interface AssistantSettings {
  version: 1;
  provider: ProviderChoice;
  models: Record<ProviderId, string>;
  base_url: string;
  /** The non-loopback base_url the person confirmed (such a server counts as cloud). */
  base_url_confirmed_remote: string | null;
  effort: Effort;
  privacy: PrivacyMode;
  caps: Caps;
  consents: Record<string, Consent>;
}

export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(['anthropic', 'openai', 'openai_compatible']);
const PROVIDER_CHOICES: readonly ProviderChoice[] = Object.freeze(['off', ...PROVIDER_IDS]);
const EFFORTS: readonly Effort[] = Object.freeze(['default', 'low', 'medium', 'high']);
const PRIVACY: readonly PrivacyMode[] = Object.freeze(['ask', 'allow', 'deny']);

export const CAP_BOUNDS: Readonly<Record<keyof Caps, { min: number; max: number; integer: boolean }>> = Object.freeze({
  turn_usd: { min: 0.05, max: 100, integer: false },
  day_usd: { min: 0.1, max: 1000, integer: false },
  steps: { min: 1, max: 200, integer: true },
  turn_minutes: { min: 1, max: 240, integer: true },
  turn_tokens: { min: 10_000, max: 50_000_000, integer: true },
});

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
  caps: { turn_usd: 3, day_usd: 15, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 },
  consents: {},
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

/** A settings file as read: each field that is missing or invalid takes its default. */
export function normalizeSettings(raw: unknown): AssistantSettings {
  const s = defaultSettings();
  if (!isRecord(raw)) return s;
  if (PROVIDER_CHOICES.includes(raw.provider as ProviderChoice)) s.provider = raw.provider as ProviderChoice;
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
  return s;
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

const PATCH_KEYS = new Set(['provider', 'model', 'base_url', 'confirm_remote', 'effort', 'privacy', 'caps', 'forget_consents']);

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
    if (!PROVIDER_CHOICES.includes(patch.provider as ProviderChoice)) return refuse('Unknown provider.', 'provider');
    next.provider = patch.provider as ProviderChoice;
  }
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || !MODEL_RE.test(patch.model)) {
      return refuse('A model id is 1–128 letters, digits and . _ : / -.', 'model');
    }
    if (next.provider === 'off') return refuse('Choose a provider before a model.', 'model');
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
  return { ok: true, settings: next };
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

/** How many projects have an answer remembered ("Forget project answers (N)"). */
export function consentCount(s: AssistantSettings): number {
  return Object.keys(s.consents).length;
}
