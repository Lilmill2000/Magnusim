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
/** A provider that is a coding agent (phase 3 spec 5.1): `agent:` and a known or custom agent's id. */
export type AgentProviderId = `agent:${string}`;
export type ProviderChoice = 'off' | ProviderId | AgentProviderId;
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

/**
 * A provider's readiness in the status (`providers_ready`): a turn or the Test may name any
 * provider, whatever the default. `reason` is the code POST /turns refuses with; `detail` is
 * the one line Settings shows ("Key set, ends in …a1b2 · <model>", "No key").
 */
export interface ProviderReady {
  label: string;
  kind: 'key' | 'server' | 'agent';
  ready: boolean;
  reason: string | null;
  /** 'usd': counted by the $ meter and limits; 'free': not priced (a local server). */
  billing: 'usd' | 'free' | 'agent_account';
  detail: string;
}

/** Whether a declined request may be retried on an older model: `true`, a non-empty list, or `{on: true, targets}`. */
export type FallbackInfo = boolean | string[] | { on: boolean; targets?: string[] } | null;

/** GET /api/assistant/status. */
export interface AssistantStatus {
  ok: true;
  available: true;
  /** The default provider (a turn or a conversation may name another). */
  provider: ProviderChoice;
  /** The same as `provider`, under its newer name. */
  default_provider?: ProviderChoice;
  /** Each provider's readiness, keyed by its id (absent from an older server). */
  providers_ready?: Partial<Record<string, ProviderReady>>;
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
  /** With the model adapters: the default's model's price, null for none. */
  price?: PriceInfo | null;
  /** Each provider's model's price (null: no model chosen). */
  prices?: Partial<Record<ProviderId, PriceInfo | null>>;
  /** With the model adapters: the date the price table was read. */
  prices_as_of?: string;
  /**
   * With the model adapters: the default's provider may retry a declined request on an older
   * model. On only as `true`, a non-empty list of models, or `{on: true, targets}`.
   */
  fallback?: FallbackInfo;
  /** The same, for each provider's own model. */
  fallbacks?: Partial<Record<ProviderId, FallbackInfo>>;
  /** With the model adapters: the test provider address switch is in use. */
  test_provider?: boolean;
  /** With the model adapters: whether a turn naming no provider (the default's) could start. */
  ready?: boolean;
  ready_reason?: string | null;
  /** Limits for a turn on a coding agent (absent from a server without them in its status). */
  agent_caps?: AgentCaps;
  /** When the coding agents were last looked for (null: not since the server started). */
  agents_checked_at?: string | null;
  /** How an agent's whole tree is stopped on this PC ('best_effort': Windows PowerShell is blocked). */
  agents_tree_kill?: 'job' | 'group' | 'best_effort';
  /** Other apps (MCP) and the tool connection coding agents use (absent from a server without them). */
  mcp?: McpStatus;
}

/** The status's `mcp` (assistant-routes.ts mcpStatus). */
export interface McpStatus {
  /** Other apps may use Magnusim's tools (Settings → Assistant → Other apps (MCP)). */
  clients: boolean;
  /** The tool connection runs (other apps' and coding agents' alike). */
  running: boolean;
  /** Why it doesn't run ('deps_missing', 'bind_failed', ...); null while it runs or before it was started. */
  reason: string | null;
  /** The port it listens on, or the saved one while it doesn't run (null: none yet). */
  port: number | null;
  /** Connections now: other apps' and coding agents'. */
  connected: number;
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
  /** Answered only in the app tab that shows it, never with the turn's answer key. */
  link_only?: boolean;
  opened_at: string;
  expires_at: string;
}

/**
 * POST /api/assistant/turns' 202. `answer_key` answers the turn's questions (POST
 * /api/assistant/gates/:id {allow, answer_key}): it goes only to whoever started the turn.
 */
export interface TurnStarted {
  ok: true;
  conversation: string;
  turn: string;
  answer_key: string;
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
  // A turn on a coding agent (phase 3): the agent once it is ready, its plan, its own tools, its
  // permission requests (ours auto-allowed; its own asked in the window), its mode and model.
  | { type: 'agent'; name: string; version: string | null; own_tools: 'off' | 'on' }
  | { type: 'plan'; entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }> }
  | { type: 'agent_tool'; call: string; title: string; kind: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
  | { type: 'agent_permission'; title: string; outcome: 'auto_allowed' | 'allowed' | 'declined' | 'cancelled'; by: 'magnusim' | 'user' | 'timeout' | 'stop' }
  | { type: 'agent_mode'; mode: string; label: string }
  | { type: 'agent_model'; model: string; label: string }
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
  /** The turn's provider (an API-key provider's id, or agent:<id>); absent from an older server. */
  provider?: string;
  /** 'agent_account': billed to the person's own coding-agent account (no usage events; Magnusim's $ limits don't apply). */
  billing?: 'usd' | 'free' | 'agent_account';
  /** The coding agent the turn runs on (null for an API-key provider). */
  agent?: { id: string; name: string; version: string | null } | null;
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
  /**
   * A turn bound to this tab: 'running' as it starts and after each change (at most once a
   * second), 'ended' once with how it ended. Each running one comes again right after `active`
   * on a new link, as many as its `turns`.
   */
  turn: RelayTurnFrame;
  /** Run a tool of the page (`tool` is the page's own name for it). */
  invoke: { call: string; turn: string; tool: string; input: unknown; timeout_s: number };
  abort: { call: string };
  /** A question to show as the app's own confirm dialog. */
  gate: { gate: GateView };
  gate_closed: { gate: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' };
  /** The server dropped this tab's registration (its plugin was turned off or replaced). */
  unregistered: { reason: string };
}

/**
 * A turn bound to this tab, as the server tells the page (CAD tools spec H3): its title is the
 * first line of the person's request (at most 60 characters), `local` says it runs on a local
 * server, `used.steps` counts its tool calls. context_tokens and images: null while unknown. A
 * turn on a coding agent counts its tool calls against its call cap, its changes against its
 * change cap and no dollars (usd and usd_cap 0: the agent bills the person's own account); its
 * images are not known (null). Any other turn has no change cap (changes and changes_cap 0). The
 * caps are those in force (the lower of the turn's and the app's settings now).
 */
export interface RelayTurnFrame {
  id: string;
  state: 'running' | 'ended';
  title: string;
  local: boolean;
  context_tokens: number | null;
  images: boolean | null;
  used: { steps: number; steps_cap: number; changes: number; changes_cap: number; usd: number; usd_cap: number };
  end?: { state: 'done' | 'stopped' | 'failed' | 'capped'; reason: string };
  /** The review round it is in (the workspace's review at registration); absent before its first. */
  review?: { round: number; of: number };
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
  /** What the question before a destructive call says it does (CAD tools spec H10; absent when none). */
  confirm?: string;
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
  /** The review rounds the workspace asked for (1 to 5, a prompt of at most 1500 characters). */
  review?: { rounds: number; prompt: string };
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
  /** The call waits for the person (only then): the turn's minutes stop until a progress without it. */
  waiting?: true;
}

/**
 * POST /api/assistant/relay/result: the call's end (images as base64). A result's `summary` is the
 * turn log's line, never the model's; an error's `hint` (how to fix it) and `detail` (plain JSON,
 * at most 4 KB) reach the model with its message.
 */
export type RelayResultBody =
  | { link: string; call: string; ok: true; result: { text?: string; data?: unknown; images?: Array<{ mediaType: string; data: string }>; summary?: string } }
  | { link: string; call: string; ok: false; error: { code: string; message: string; hint?: string; detail?: unknown } };

/**
 * POST /api/assistant/relay/gate: the person's answer to a question this tab showed, on the
 * link it was shown on. Refusals: 409 no_channel (the link went), 403 not_shown (never sent on
 * this link, or another tab's), 409 {already}.
 */
export interface RelayGateBody {
  link: string;
  gate: string;
  allow: boolean;
}

// ---------------------------------------------------------------- coding agents (phase 3 spec 4.12, 4.13, 5.4)

/** Limits for a turn on a coding agent (spec 4.10): changes, tool calls and active minutes per message. */
export interface AgentCaps {
  /** Changes per message, 1–200. */
  changes: number;
  /** Tool calls per message, 10–2000. */
  calls: number;
  /** Active minutes per message, 1–240. */
  turn_minutes: number;
}

/** A mode a coding agent listed at its last Test or connect: its raw id (sent back as is) and its cleaned name. */
export interface ModeView {
  id: string;
  name: string;
  description: string;
}

/** A model a coding agent listed at its last Test or connect. */
export interface ModelView {
  id: string;
  name: string;
  description: string;
}

/**
 * One way to sign in to a coding agent (spec 4.12), from its last connect's `auth_required`.
 * - terminal: `command` is the line to show and copy, exactly; null when it must not be shown
 *   (the server's four conditions: the page then says to sign in as the agent's documentation says);
 * - agent: the agent signs in by itself (POST /api/assistant/agents/sign-in {id, method: id});
 * - env_var: `vars`, the variables the person may set instead.
 */
export interface SignInMethodView {
  id: string;
  name: string;
  description: string;
  type: 'terminal' | 'agent' | 'env_var';
  command: string | null;
  vars: string[];
}

/** An agent's sign-in block (`AgentRow.sign_in`): its ways to sign in. */
export interface SignInView {
  methods: SignInMethodView[];
}

/** A coding agent as Settings shows it (GET /api/assistant/agents; spec 5.4). */
export interface AgentRow {
  id: string;
  name: string;
  kind: 'known' | 'custom';
  found: boolean;
  /** The install line when it isn't found. */
  install: string | null;
  /** The resolved program and script (shown in every row). */
  program: string | null;
  script: string | null;
  version: string | null;
  /** Resolved through the catalogue's own package at its checked version (the identity rule). */
  verified_package: boolean;
  /** From the login file's existence only ('key': one of its key variables is set). */
  signed_in: 'yes' | 'key' | 'no' | 'unknown';
  key_var: string | null;
  lockdown: 'tools_off' | 'documented' | 'none';
  own_tools: 'off' | 'on';
  /** Its own tools can't be switched off: it works only once allowed (the allow switch, spec 4.9). */
  needs_allow: boolean;
  allowed: boolean;
  /** Allowed for another command or program: asked again. */
  allow_changed: boolean;
  /** What POST /agents/allow {allow: true} must name: the command the row shows. */
  fingerprint: string | null;
  /** The saved choices (null: the agent's own). */
  model: string | null;
  mode: string | null;
  /**
   * The modes Magnusim uses with it (the catalogue's allowedModes, spec 4.2): their ids, or
   * 'initial' (only the mode it starts in: no Mode select). Null when the server doesn't say,
   * and then the page offers no mode either.
   */
  allowed_modes: string[] | 'initial' | null;
  /** What its last Test or connect listed (memory only). */
  last: { modes: ModeView[]; models: ModelView[]; at: string } | null;
  /** The sign-in block from its last `auth_required`, or from a connect it said 'none' to. */
  sign_in: SignInView | null;
  /**
   * What the agent itself said of its login at its last check that got through (or its last
   * auth_required: 'none'), since the server started: 'none', 'signed_in' (it said so, or it
   * answered a Test), 'silent' (a connect it said nothing on), or null (no word: its login file
   * decides). Its readiness (`ready`, the dot) follows it, as the row's line does.
   */
  auth_word: 'none' | 'signed_in' | 'silent' | null;
  ready: boolean;
  /** The code a turn on it is refused with now (agent_missing, agent_not_allowed, ...). */
  reason: string | null;
  /** Why it can't be started, as the person reads it. */
  error: string | null;
}

/** GET /api/assistant/agents. */
export interface AgentsAnswer {
  ok: true;
  checked_at: string;
  took_ms: number;
  agents: AgentRow[];
}

/**
 * POST /api/assistant/agents/test {id, message}: the agent Test (message: true, one short
 * message) or the connect check (message: false, none). Its refusals (409 busy,
 * agent_not_allowed, ...) carry the same {ok: false, code, error}.
 */
export type AgentTestAnswer =
  | {
      ok: true;
      agent: string;
      version: string | null;
      ms: number;
      /** The login file's (the row's own `signed_in`). */
      signed_in: AgentRow['signed_in'];
      /**
       * What the agent itself said of its login during the check (its auth status): 'none' (not
       * signed in), 'signed_in', or null when it said nothing.
       */
      auth_status: 'none' | 'signed_in' | null;
      own_tools: 'off' | 'on';
      images: boolean;
      modes: ModeView[];
      models: ModelView[];
      /** 'works': it called the test tool; 'not_used': it answered without; null: no message was sent. */
      tools: 'works' | 'not_used' | null;
      auth?: SignInMethodView[];
    }
  | { ok: false; code: string; error: string; auth?: SignInMethodView[] };
