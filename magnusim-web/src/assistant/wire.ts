/**
 * What the Assistant's routes answer (Foundation spec 9.2), as the page reads it. Types
 * only: nothing here runs. The server's own types live in scripts/server/assistant; these
 * mirror the answers, never the server code, so the page never imports a server file.
 *
 * Settings → Assistant reads the status. The fields marked "with the model adapters" come
 * with the commit that brings the providers (models, Test, prices, packages, readiness);
 * until then they are absent and the step shows nothing for them.
 */

export type ProviderId = 'anthropic' | 'openai' | 'openai_compatible';
export type ProviderChoice = 'off' | ProviderId;
export type Effort = 'default' | 'low' | 'medium' | 'high';
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

/** A saved key as the page may see it: set or not, and its last 4 characters (keys of 16 or more). */
export interface KeyStatus {
  set: boolean;
  last4: string | null;
  set_at: string | null;
  state: 'none' | 'ok' | 'unreadable';
}

/** Where keys are kept, and the sentence Settings shows for it. */
export interface StorageStatus {
  kind: 'dpapi' | 'file' | 'unavailable';
  reason: 'blocked' | 'timeout' | 'failed' | null;
  note: string;
}

/** A model the provider offers (GET /api/assistant/models). */
export interface ModelInfo {
  id: string;
  label: string;
  /** False when Magnusim has no price for it. */
  priced: boolean;
}

/** The chosen model's price (USD per million tokens), with the model adapters. */
export interface PriceInfo {
  model?: string;
  /** False (or `estimated`) when Magnusim doesn't know this model's price. */
  known?: boolean;
  estimated?: boolean;
  input?: number;
  output?: number;
  cache_read?: number;
}

/** GET /api/assistant/status. */
export interface AssistantStatus {
  ok: true;
  available: true;
  provider: ProviderChoice;
  /** The chosen model of each provider ('' for a local server not set yet). */
  models: Record<ProviderId, string>;
  base_url: string;
  base_url_is_local: boolean;
  effort: Effort;
  privacy: PrivacyMode;
  /** How many projects have an answer remembered ("Forget project answers (N)"). */
  consents: number;
  caps: Caps;
  keys: Record<ProviderId, KeyStatus>;
  storage: StorageStatus;
  /** The saved keys could not be read and were set aside. */
  keys_notice?: string | null;
  spent_today_usd: number;
  /** The key protector test switch in use, or null. */
  test_protector: string | null;
  /** With the model adapters: 'missing' when the provider packages aren't installed. */
  deps?: 'ok' | 'missing';
  /** With the model adapters. */
  providers?: unknown;
  /** With the model adapters: the chosen model's price, null for none. */
  price?: PriceInfo | null;
  /** With the model adapters: the date the price table was read. */
  prices_as_of?: string;
  /**
   * With the model adapters: the provider may retry a declined request on an older model.
   * On only as `true`, a non-empty list of models, or `{on: true, targets}`.
   */
  fallback?: boolean | string[] | { on: boolean; targets?: string[] } | null;
  /** With the model adapters: the test provider address switch is in use. */
  test_provider?: boolean;
  /** With the model adapters. */
  ready?: boolean;
  ready_reason?: string | null;
}

/** GET /api/assistant/models?provider=. */
export interface ModelsAnswer {
  ok: true;
  models: ModelInfo[];
  source?: string;
}

/**
 * How the Test's model handled the test tool: 'works' (it called it), 'not_used' (it just
 * answered) or 'as_text' (it wrote the call as text: a chat template without tools). The
 * page also reads 'ok' and true as working, and false as not.
 */
export type ToolsVerdict = 'works' | 'not_used' | 'as_text' | 'ok' | boolean;

/** POST /api/assistant/test. */
export type TestAnswer =
  | { ok: true; model: string; served_by?: string | null; ms: number; tools: ToolsVerdict | string; cost_usd?: number | null }
  | { ok: false; code?: string; error: string };

/** A refused change (400 {error, field}, or 409 {needs_confirm}). */
export interface RefusalBody {
  ok: false;
  code?: string;
  error?: string;
  field?: string | null;
  needs_confirm?: 'base_url';
  reason?: string;
  storage?: StorageStatus;
}
