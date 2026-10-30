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
  /**
   * A coding agent's row only: whether it takes the person's pictures, as its last start said
   * (else as its catalogue entry says; null: not known until it starts). A turn with pictures on
   * one that turns out to take none ends bad_images before anything is sent to it.
   */
  images?: boolean | null;
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
  /**
   * The provider log for a problem report (Settings → Assistant): `on` the switch as saved, `env`
   * MAGNUSIM_ASSISTANT_DEBUG_LOG keeps it on whatever the switch says, `folder` where it is kept
   * (absent from an older server), `server_log` the server's own log's file name when that folder
   * holds it too (Magnusim CAD's server.log; null otherwise, absent from an older server).
   */
  provider_log?: { on: boolean; env: boolean; folder: string; server_log?: string | null };
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
 * POST /api/assistant/turns' body as a window sends it (phase 4): `link` is this tab's live relay
 * link (always, from the dock): the turn's questions show in this tab and it is started_by
 * 'window' (409 no_channel when the link is no longer live: get a fresh one and send again).
 * `tab: 'link'` binds the turn to this tab's workspace (409 no_channel, 400 bad_tab, 409
 * tab_hidden, 409 tab_busy as for a tab id); else `context` names the project and study.
 * `provider` only before a conversation's first message (it keeps its provider). `carry_from`
 * (Continue in a new chat, never with `conversation`): an earlier conversation of the same
 * provider and project, whose prompts, last answer and end go with the new one's first message
 * (400 bad_carry, carry_agent; 404 unknown_conversation; 409 conversation_changed, conversation_busy).
 */
export interface TurnStartBody {
  text: string;
  conversation?: string;
  carry_from?: string;
  provider?: string;
  link?: string;
  /** 'link' (this window's workspace), an app tab's id, or 'auto' (the only connected one: the CLI). */
  tab?: string;
  context?: { project_id?: string; simulation_id?: string };
}

/**
 * POST /api/assistant/turns/:id/show {link, answer_key}: the window that started a turn (it kept
 * the 202's answer_key) shows the turn's open questions again on its new live link after a
 * reload; they come as relay `gate` frames on that link and are answered through /relay/gate.
 * 200 {ok, turn}; 403 answer_key, 409 no_channel, 404 unknown_turn, 409 ended, 409
 * shown_elsewhere ("Its questions show in another window.": the window showing them is still there).
 */
export interface TurnShowBody {
  link: string;
  answer_key: string;
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
  /** `waiting`: the call waits for the person in its workspace (its page said so), e.g. CAD's Pause or Keep/Discard. */
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string; waiting?: true }
  /**
   * `hint`: how a failed call's tool says to fix it (the model has it too); `summary`: the log's
   * line; `images`: the result's pictures the turn keeps for the window (refs; the bytes from
   * GET /api/assistant/turns/:id/images/:n); `links`: files the person may save (a finished
   * export's Download), the app's own addresses only, never sent to the model.
   */
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; hint?: string; summary: string; ms: number; images?: ImageRef[]; links?: ToolLink[] }
  | { type: 'gate'; gate: GateView }
  | { type: 'gate_closed'; gate: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' }
  | { type: 'usage'; usd: number; estimated: boolean; turn_usd: number; day_usd: number; tokens: number }
  | { type: 'end'; state: 'done' | 'stopped' | 'failed' | 'capped'; reason: string; message: string | null }
  /** A review round after the model's last answer while edits happened (`round` of `of`). */
  | { type: 'review'; round: number; of: number }
  /**
   * A call wrote to the project and the open windows reload it (phase 5, C2): `call` is the call
   * that wrote (absent when none was open), `kinds` what it changed, `ids` the records by kind
   * ({bc: ['bc-7']}), `names` their names by id ({'bc-7': 'Inlet'}).
   */
  | { type: 'ui_sync'; call?: string; project_id: string; kinds: string[]; ids: Record<string, string[]>; names?: Record<string, string> }
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
  /** The person's request, as stored (phase 4; absent from an older server). */
  prompt?: string;
  /** Its first line, cleaned, at most 60 characters (as RelayTurnFrame.title). */
  title?: string;
  /** Started from a Magnusim window (with its live relay link), or by a program (the CLI, a script). */
  started_by?: 'window' | 'program';
  /** What it used of its limits (the same numbers RelayTurnFrame.used carries), its active time and its minutes. */
  used?: TurnUsed;
  /** The person's own pictures sent with the request ("p1".."p4"; [] without any). */
  prompt_images?: ImageRef[];
  /** The files the person attached to the request (core host tools spec 13.2; absent from an older server; kind absent before drawings). */
  attachments?: Array<{ id: string; name: string; bytes: number; kind?: 'geometry' | 'drawing' }>;
  /** Its log and pictures are no longer kept (past the server's 200 newest ended turns): this summary is all there is. */
  log_dropped?: boolean;
}

/** GET /api/assistant/turns/:id?since&wait_ms: the long-poll's answer. */
export interface TurnPollAnswer {
  ok: true;
  turn: TurnSummary;
  events: TurnEvent[];
  next: number;
  ended: boolean;
}

/** A turn's summary as the turn channel's `summary` frames carry it: without text_so_far and prompt. */
export type SlimTurnSummary = Omit<TurnSummary, 'text_so_far' | 'prompt'>;

/**
 * A window following a turn on its tab's event stream: hub kind `assistant`, params
 * {role:'turn', turn, since} (openChannel('/api/assistant/events?role=turn&turn=<id>&since=<seq>')).
 * Refused 403 (not this PC), 400 (a bad turn id or since), 404 (not kept), 429 (a ninth of the
 * tab). Each frame is an event of the channel named by its type, with this data; after the turn's
 * `end` event went out comes a last `summary`, then the server ends the channel (`_closed`); an
 * ended turn's channel ends right after its snapshot.
 */
export interface TurnChannelFrameData {
  /**
   * First: the full summary, the events after `since` (at most 500; more:true when `events`
   * frames follow at once); upto: the seq they reach together, which its text_so_far covers.
   */
  snapshot: { turn: TurnSummary; events: TurnEvent[]; next: number; ended: boolean; more: boolean; upto?: number };
  /** Events logged since (at most 500 a frame, at most every 100 ms); `next` is the last one's seq. */
  events: { events: TurnEvent[]; next: number };
  /** The turn changed as its tab's page hears it (at most once a second), and once after its end. */
  summary: { turn: SlimTurnSummary };
}

/**
 * GET /api/assistant/history?project=<id>|home: the dock's History, the chats saved for a project
 * (or Home), newest end first, kept 31 days (scripts/server/assistant/history.ts).
 */
export interface HistoryAnswer {
  ok: true;
  kept_days: number;
  chats: HistoryChat[];
  /** Saved chats in all (at most 200 are listed). */
  total: number;
}

export interface HistoryChat {
  /** Its conversation's id (Continue in a new chat sends it as carry_from). */
  id: string;
  title: string;
  provider: string;
  /** How the person reads its provider: its label, or the coding agent's name (server data). */
  label: string;
  model: string;
  started_at: string;
  ended_at: string;
  first_prompt: string;
  end_state: string;
  /** Its conversation was full after its last request. */
  full: boolean;
}

/** One saved request: never a picture or a result's data. */
export interface HistoryRequest {
  turn: string;
  conversation: string;
  prompt: string;
  /** The person's pictures sent with it (their number only). */
  pictures: number;
  files: string[];
  /** Everything the model said in it (its end kept when cut). */
  answer: string;
  steps: Array<{ step: number; tool: string; title: string; ok: boolean | null; code: string | null; line: string }>;
  steps_left_out: number;
  end: { state: string; reason: string; message: string | null };
  full: string | null;
  usage: { usd: number; estimated: boolean; tokens: number; steps: number; billing: string };
  started_by: string;
  started_at: string;
  ended_at: string;
  /** The fields cut to fit the saved line. */
  cut?: string[];
}

/** GET /api/assistant/history/:id?project=&from=: a page of one saved chat. */
export interface HistoryPageAnswer {
  ok: true;
  chat: HistoryChat;
  total: number;
  from: number;
  next: number | null;
  requests: HistoryRequest[];
}

/**
 * GET /api/assistant/conversations[?project=<id>|home]: the conversations this server holds
 * (memory only: a restart clears them; History keeps what they said), newest use first.
 */
export interface ConversationsAnswer {
  ok: true;
  conversations: ConversationRow[];
}

export interface ConversationRow {
  id: string;
  /** Its provider for good: an API-key provider's id, or agent:<id>. */
  provider: string;
  /** How the person reads it: the provider's label, or the coding agent's name (server data). */
  label: string;
  billing: 'usd' | 'free' | 'agent_account';
  model: string;
  project_id: string | null;
  /** The project's title, when it could be read (null for Home, or when it couldn't). */
  project_title: string | null;
  created_at: string;
  last_used_at: string;
  /** The turn running in it, or null. */
  running: string | null;
  /** Why no more turns fit ('messages', 'images', 'bytes', 'context'), or null. */
  full: string | null;
  /** That limit with its numbers, in the person's words (null while more turns fit; absent from an older server). */
  full_text?: string | null;
  /**
   * The limit it is closest to: `used` of `limit`, full at `used >= limit` (the context's limit is
   * 80% of the model's); null for a coding agent's (absent from an older server).
   */
  room?: ConversationRoom | null;
  /**
   * A coding agent's: the context its agent uses, of its size (tokens), as the agent last said;
   * null before it said, and for any other conversation (absent from an older server).
   */
  context?: AgentContext | null;
  /** Its first turn's title ('' before any). */
  title: string;
  /** Its turns the server still keeps, oldest first (a turn's events: GET /api/assistant/turns/:id or the turn channel). */
  turns: ConversationTurn[];
  /** Its turns no longer kept (older than its newest 50 once an hour passed, or past 200). */
  dropped_turns: number;
}

/** How much of its own context a coding agent uses: `used` of `size` tokens. */
export interface AgentContext {
  used: number;
  size: number;
}

export interface ConversationRoom {
  reason: 'messages' | 'images' | 'bytes' | 'context';
  used: number;
  limit: number;
  /**
   * The context's limit is what this much money per turn (Settings → Assistant) can resend once the
   * cache has expired, lower than 80% of the model's context (absent otherwise, and from an older server).
   */
  usd?: number;
}

export interface ConversationTurn {
  id: string;
  title: string;
  state: TurnState;
  started_at: string;
  ended_at: string | null;
  started_by: 'window' | 'program';
}

/**
 * A picture a turn keeps for the window: GET /api/assistant/turns/:id/images/:n serves its bytes
 * while it is kept (404 {code:'image_gone'} after: a turn keeps at most 64 pictures and 24 MB,
 * and the oldest ended turns' pictures go first past 96 MB in all).
 */
/** A file a tool result offers the person (spec 06 §8.6): the dock shows a Download link. */
export interface ToolLink {
  label: string;
  href: string;
}

export interface ImageRef {
  /** Its id in the turn: "1", "2", ... for tool results; "p1".."p4" for the person's own. */
  n: string;
  media_type: string;
  width: number;
  height: number;
}

/**
 * A turn's counters (TurnSummary.used): RelayTurnFrame's `used` in the server's names, plus
 * active_ms (questions and a call's waits for the person don't count) and minutes_cap (its
 * minutes per message in force). An agent turn's steps are its tool calls; its usd and usd_cap 0.
 */
export interface TurnUsed {
  steps: number;
  steps_cap: number;
  changes: number;
  changes_cap: number;
  usd: number;
  usd_cap: number;
  /** When dollars are counted: what is left for its next request, the smaller of its own limit's room and today's. */
  usd_left?: number;
  active_ms: number;
  minutes_cap: number;
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
  /**
   * `slot: 'core'`: a core page tool (core host tools spec C7), run in this page; else the workspace's.
   * `step`, `calls_left_in_step`, `edits_left_in_step`: the call's place in its step (one answer of
   * the model): the step's number in its turn, how many calls of that answer come after it, and how
   * many of those are the turn's workspace's edit or destructive tools. A turn's own calls only.
   */
  invoke: {
    call: string;
    turn: string;
    tool: string;
    input: unknown;
    timeout_s: number;
    slot?: 'core';
    step?: number;
    calls_left_in_step?: number;
    edits_left_in_step?: number;
  };
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
  /** The conversation it runs in (absent from an older server). */
  conversation?: string | null;
  local: boolean;
  context_tokens: number | null;
  images: boolean | null;
  /** `usd_left` when dollars are counted: what is left for its next request, the smaller of its own limit's room and today's. */
  used: { steps: number; steps_cap: number; changes: number; changes_cap: number; usd: number; usd_cap: number; usd_left?: number };
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
  /** Which tools a local model's budget keeps first (0-100, higher stays; absent: 50). */
  priority?: number;
}

/** POST /api/assistant/relay/tools: `tools: []` unregisters. */
export interface RelayToolsBody {
  link: string;
  /** Page-wide, above every rev this page sent before. */
  rev: number;
  /** The frame's pinned epoch (absent for a fresh frame). */
  epoch?: string;
  /** 'core': the app page's own registration (core host tools spec C7); absent: the workspace's. */
  slot?: 'workspace' | 'core';
  workspace: RelayWorkspace;
  /** Where the tab is (slot 'core' only). */
  place?: 'home' | 'workbench' | 'workspace';
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
