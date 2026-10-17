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

/** A turn's state (spec 6.1). */
export type TurnState = 'starting' | 'awaiting_consent' | 'model' | 'tools' | 'awaiting_confirmation' | 'done' | 'stopped' | 'failed' | 'capped';

/** A question the Assistant asks (a compute or destructive tool, or sending a project to a cloud provider). */
export interface GateView {
  id: string;
  kind: 'confirm' | 'privacy';
  turn: string | null;
  title: string;
  copy: string;
  yes: string;
  no: string;
  /** ≤ 6 rows, each ≤ 80 characters. */
  detail?: Array<{ label: string; value: string }>;
  risk?: 'compute' | 'destructive';
  tool?: string;
  source?: string;
  project?: { id: string; title: string };
  opened_at: string;
  expires_at: string;
}

/** One entry of a turn's log (GET /api/assistant/turns/:id), numbered by `seq`. */
export type TurnEvent = { seq: number; at: number } & (
  | { type: 'state'; state: TurnState }
  | { type: 'text'; step: number; text: string }
  | { type: 'discard'; step: number }
  | { type: 'note'; text: string }
  | { type: 'fallback'; step: number; from: string; to: string }
  | { type: 'tool_call'; step: number; call: string; tool: string; title: string; risk: 'read' | 'edit' | 'compute' | 'destructive'; source: string; input_preview: string }
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string }
  /** `hint`: how a failed call's tool says to fix it (the model has it too); `summary`: the log's line. */
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; hint?: string; summary: string; ms: number }
  | { type: 'gate'; gate: GateView }
  | { type: 'gate_closed'; gate: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' }
  | { type: 'usage'; usd: number; estimated: boolean; turn_usd: number; day_usd: number; tokens: number }
  | { type: 'end'; state: 'done' | 'stopped' | 'failed' | 'capped'; reason: string; message: string | null }
);

/** A turn as GET /api/assistant/turns/:id and its Stop answer it. */
export interface TurnSummary {
  id: string;
  conversation: string;
  state: TurnState;
  step: number;
  started_at: string;
  ended_at: string | null;
  usd: number;
  estimated: boolean;
  end_reason: string | null;
  message: string | null;
  open_gates: GateView[];
  text_so_far: string;
  tab: string | null;
  project_id: string | null;
  served_by: string | null;
}

/**
 * What the server sends the page's relay (spec 8.4) on its hub channel (kind `assistant`,
 * params {role:'relay'}): each frame is an event of the channel named by its type, with this data.
 * `linked` is always the first, and comes again (a new link) after every reconnect.
 */
export interface RelayFrameData {
  /** The channel's link token (24 hex): every relay POST carries it. */
  linked: { link: string };
  /**
   * The Assistant turns bound to this tab now, and until when the tab's link is kept after
   * the last one ended (ms since 1970 or an ISO date; null or absent: no hold).
   */
  active: { turns: number; hold_until?: number | string | null };
  /** Run a tool of the page (`tool` is the page's own name for it). */
  invoke: { call: string; turn: string; tool: string; input: unknown; timeout_s: number };
  abort: { call: string };
  /** A question to show as the app's own confirm dialog. */
  gate: { gate: GateView };
  gate_closed: { gate: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' };
  /** The server dropped this tab's registration (its plugin was turned off or replaced). */
  unregistered: { reason: string };
}

export type RelayFrameType = keyof RelayFrameData;

export type RelayFrame = { [K in RelayFrameType]: { type: K } & RelayFrameData[K] }[RelayFrameType];

/** The workspace a registration belongs to (the host's route, never the frame's word). */
export interface RelayWorkspace {
  project_id: string;
  plugin: string;
  /** Its key, as the route names it. */
  workspace: string;
  /** Its title from the host's plugin row: the texts the person reads name it so (the key without one). */
  title?: string;
  study_id: string;
}

/** A page tool as the relay registers it (the bridge's checked shape). */
export interface RelayTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: 'read' | 'edit' | 'compute' | 'destructive';
  timeoutS: number;
}

/** POST /api/assistant/relay/tools: `tools: []` unregisters. */
export interface RelayToolsBody {
  link: string;
  /** Page-wide, above every rev this page sent before. */
  rev: number;
  /** The frame's pinned epoch (absent for a fresh frame). */
  epoch?: string;
  workspace: RelayWorkspace;
  tools: RelayTool[];
  guide?: string;
}

/** Its 200 answer; refusals are 409 {code:'no_channel'|'stale_rev'|'plugin_off'|'plugin_changed'} or 400. */
export interface RelayToolsAnswer {
  ok: true;
  available: true;
  accepted: string[];
  refused: Array<{ name: string; code: string; message: string }>;
  epoch: string;
}

/** POST /api/assistant/relay/progress: `ack` first (from the invoke frame's handler), then progress. */
export interface RelayProgressBody {
  link: string;
  call: string;
  ack?: true;
  /** 0 to 1, or null when the page said none; absent only on the ack. */
  fraction?: number | null;
  label?: string;
}

/**
 * POST /api/assistant/relay/result: the call's end (images as base64). A result's `summary` is the
 * turn log's line, never the model's; an error's `hint` (how to fix it) and `detail` (plain JSON,
 * at most 4 KB) reach the model with its message.
 */
export type RelayResultBody =
  | { link: string; call: string; ok: true; result: { text?: string; data?: unknown; images?: Array<{ mediaType: string; data: string }>; summary?: string } }
  | { link: string; call: string; ok: false; error: { code: string; message: string; hint?: string; detail?: unknown } };
