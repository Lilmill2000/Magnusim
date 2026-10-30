/**
 * The tools the Assistant may offer the model (Foundation spec 7).
 *
 * Sources: the host's own tools (host-tools.ts), the tools the open workspace page of a
 * tab registered (bridge 1.9, through the relay), and later sources a phase adds
 * (registerToolSource). Each step, toolsFor(ctx) computes the list for that turn: the
 * host tools that are available, plus only the turn's own tab's registration, and only
 * while its project matches and its link is connected. A tool result can never change
 * this list.
 *
 * - Names are provider-safe: host tools plain snake_case (no `__`), workspace tools
 *   `<plugin slug>__<name>` (`ai-demo__add`). In a workspace its tools come first, then the
 *   host's; elsewhere the host's first (core host tools spec §12.4: strict status goes in
 *   that order); each group by name. The provider definitions are memoized by content, so
 *   the bytes of the tool list stay the same from step to step (the provider's cache holds).
 * - Places (§12.1): a host tool is offered only where its `contexts` say (home, workbench,
 *   workspace); the tab's workspace tools are offered in their workspace.
 * - Caps: ≤ 32 tools and ≤ 512 KB per registration. Per request, cloud: 40 tools, the
 *   workspace's kept first, the lowest-priority host tools dropped. Local: no count cap,
 *   only a budget of tool-definition tokens (§12.2, §12.3: half the model's context, 16,384
 *   when unknown); over it the lowest-priority host tools go first, then the workspace's
 *   (their registration's priority), and pinned tools last. The step can't call a dropped tool.
 * - Fence: a registration records its plugin's epoch (foam-runner.js pluginEpoch); a
 *   plugin turned off, swapped or reset bumps it, and from then on its tools are neither
 *   offered nor available.
 * - A tool belongs to its registration: once the tab registers again (even on the same
 *   link), a tool of the earlier one, still in a step's offered list, is unavailable.
 * - An unknown risk counts as destructive.
 * - The core page (core host tools spec C7): every app tab registers its own core__show and
 *   core__view beside its workspace (setCore, `coreTabs`), with where it is (place, project,
 *   study). They are offered with the host tools to the tab's own turn in that project only,
 *   core__view not in a workspace; the same tools on the same link keep their ToolDefs as the tab
 *   moves, so a step's offered call still runs.
 */
import { createHash } from 'node:crypto';
import { pluginEpoch as foamPluginEpoch } from '../../foam-runner.js';
import { checkSchema } from './schema.ts';
import { cleanGuide, cleanText, CONFIRM_NOTE_MAX, hasControls, TEXT_CAPS } from './sanitize.ts';
import { emitSchema } from './schema.ts';
import type { GateDetail } from './gates.ts';
import type { ToolLink } from './links.ts';
import type { ImagePart, JsonSchemaObject, ProviderTool, Risk } from './types.ts';

/** Where a turn's window is (C8): Home, a project's workbench, or a plugin workspace. */
export type Place = 'home' | 'workbench' | 'workspace';
export const PLACES: readonly Place[] = Object.freeze(['home', 'workbench', 'workspace']);

export type ToolSource =
  | { kind: 'host' }
  /** `workspace`: as the person reads it (the workspace's title). */
  | { kind: 'workspace'; plugin: string; pluginName: string; workspace: string; tab: string; link: string; projectId: string; studyId: string; epoch: string }
  /** Reserved for a later phase (other plugins' tools). */
  | { kind: 'plugin'; plugin: string; method: string; epoch: string }
  /** The core page of an app tab (core host tools spec C7): `core__show`, `core__view`. */
  | { kind: 'core'; tab: string; link: string };

export interface ToolCtx {
  tab: string | null;
  projectId: string | null;
  simulationId: string | null;
  /** The turn's provider sends data off this PC. */
  cloud: boolean;
  /** The turn runs on a local server (its tools fit a token budget, not a count). */
  local: boolean;
  /** Where the turn's window is (C8): which host tools are offered. */
  place: Place;
  /** A local turn's budget of tool-definition tokens (localBudget); null for any other. */
  budgetTokens: number | null;
  /** This turn's own message (the typed-path rule, §4.11); null for MCP and coding agents. */
  prompt: string | null;
  /** The turn's provider and model (app_status reports them); absent outside a turn. */
  assistant?: { provider: string; model: string };
  /**
   * Where what a call gives goes: the turn's destination (providers/index.ts destinationOf: a cloud
   * provider, `host:<name>`, `agent:<id>`), or another app's (`mcp`), with how the person reads it.
   * chat_history asks before a saved chat goes where its words didn't go (absent: it always asks).
   */
  destination?: { key: string; label: string };
  /** The turn's conversation (attachments are bound to it); absent outside a turn. */
  conversation?: string | null;
  /** What the turn used so far of its limits, read when asked (app_status shows it, read-only); absent outside a turn. */
  used?: () => TurnUse | null;
}

/** The turn's conversation as a page's call carries it (host/common.ts conversationOf reads it the same way). */
const conversationOf = (ctx: ToolCtx): string | null => (typeof ctx.conversation === 'string' ? ctx.conversation : null);

/**
 * A turn's spend so far against its limits in force (the lower of its start's and the live
 * settings'): steps (a coding agent's: its calls), minutes of its active time, dollars (none
 * for a coding agent: its account pays), and a coding agent's changes against its change limit.
 */
export interface TurnUse {
  steps: number;
  steps_cap: number;
  minutes: number;
  minutes_cap: number;
  usd?: number;
  usd_cap?: number;
  /** The money left for its next request: the smaller of what its own limit and today's leave. */
  usd_left?: number;
  changes?: number;
  changes_cap?: number;
}

/** What an escalation found (C3): the call's risk raised to it, and what the card says. */
export interface Assessed {
  risk: 'edit' | 'compute' | 'destructive';
  note: string;
  detail: GateDetail[];
  /** What the card called each job of the call's chain, by job id (the covered call's transcript line names it). */
  labels?: Record<string, string>;
}

/** A tool's refusal before any question (ToolDef.refuse). */
export interface ToolRefusal {
  code: string;
  message: string;
  hint?: string;
}

export interface AssessContext {
  ctx: ToolCtx;
  signal: AbortSignal;
  turn: string | null;
}

export interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  text?: string;
  images?: ImagePart[];
  /** `hint`: how to fix it; `detail`: plain JSON about it (both reach the model with the message). */
  error?: { code: string; message: string; hint?: string; detail?: unknown };
  /** One line for the turn log (never sent to the model). */
  summary: string;
  /** Links for the person under the step (a Download; links.ts): on the log only, never sent to the model. */
  links?: ToolLink[];
}

/** What else a progress says: the call waits for the person (the turn's minutes stop meanwhile). */
export interface ProgressOptions {
  waiting?: boolean;
}

/**
 * Where a call stands in its step (one answer of the model): the step's number in its turn, how
 * many calls of that answer come after it, and how many of those are the turn's workspace's edit
 * or destructive tools. Only a turn's own calls have it (not another app's over MCP, nor a coding
 * agent's).
 */
export interface StepInfo {
  n: number;
  callsLeft: number;
  editsLeft: number;
}

export interface ToolRunContext {
  signal: AbortSignal;
  ctx: ToolCtx;
  /** The turn that makes the call; another app's call (MCP) has `mcp:<connection id>` (RunOptions.callTurn). */
  turn: string | null;
  /** Its place in its step (a turn's own calls only). */
  step?: StepInfo;
  progress(fraction: number | null, label: string, opts?: ProgressOptions): void;
  /** Aborts when the runner stops waiting for this call (it was aborted and its grace ran out). */
  released?: AbortSignal;
}

export interface ToolDef {
  name: string;
  localName: string;
  title: string;
  description: string;
  schema: JsonSchemaObject;
  risk: Risk;
  source: ToolSource;
  projectData: boolean;
  /**
   * A STALL window: the call fails `stalled` after this long with no progress and no page
   * call in flight. No absolute limit while progress keeps arriving; the turn's
   * turn_minutes cap bounds the whole call (its waits for the person count past
   * WAIT_PAUSE_MAX_MS, runner.ts). Host default 30 s; workspace timeoutS 1–600 (default 60).
   */
  stallMs: number;
  workerBacked: boolean;
  /**
   * Higher stays when a request is over its cap or budget: host tools 0-100; a workspace tool's
   * comes from its registration (0-100, default 50).
   */
  priority?: number;
  /** Never dropped by a local budget while anything else fits (core__show: how the model reaches another place). */
  pinned?: boolean;
  /** Where the tool is offered (C8). Workspace tools: ['workspace'], set by the registry. Left out: everywhere. */
  contexts?: readonly Place[];
  /**
   * What the confirm question says a destructive call does, in place of "can't be undone"
   * (a workspace tool's `confirm`, cleaned, at most CONFIRM_NOTE_MAX characters; CAD tools spec H10).
   */
  confirmNote?: string;
  available(ctx: ToolCtx): true | string;
  describe?(input: Record<string, unknown>): { line: string; detail?: Array<{ label: string; value: string }> };
  /**
   * Raise-only risk per call (C3): the runner uses the higher of `risk` and the answer's. One
   * that throws or takes longer than ESCALATE_MAX_MS (runner.ts) counts as destructive.
   */
  escalate?(input: Record<string, unknown>, rt: AssessContext): Promise<Assessed | null>;
  /**
   * A refusal the tool can tell from the input alone, before any question is asked (import_file:
   * an attached drawing): the call fails with it, unasked and unrun. null lets it go on. One that
   * throws counts as null (the tool's own run still checks).
   */
  refuse?(input: Record<string, unknown>, ctx: ToolCtx): ToolRefusal | null | Promise<ToolRefusal | null>;
  /** Plain-English card title and copy for compute and destructive calls (§14), in place of the generic one. */
  gateText?(input: Record<string, unknown>, a: Assessed | null): { title: string; copy: string; detail?: GateDetail[] };
  /** The project this call reads or writes, for the per-call privacy check (C5). null = no project data. */
  projectOf?(input: Record<string, unknown>, ctx: ToolCtx): string | null;
  /** The job this call starts, for chain grants (C3): e.g. "mesh.m-1"; null when it starts none. */
  chainKey?(input: Record<string, unknown>): string | null;
  run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome>;
}

/** A tool a request left out, with where it is offered as the person reads it ("Home", "Magnusim CAD Part"). */
export interface DroppedTool {
  name: string;
  contexts: string[];
}

/** One step's tools (selectTools). */
export interface ToolSelection {
  tools: ToolDef[];
  /** What the cap or budget left out, in the order dropped. */
  dropped: DroppedTool[];
  /** The local budget the selection fitted (tokens); null for a cloud request. */
  budget: number | null;
  /** A local budget too small for even the pinned tools: nothing may be offered (the turn fails `context`). */
  tooSmall: boolean;
}

/**
 * Review rounds a workspace asked for (loop.ts): when the model ends its answer after at least one
 * of this workspace's edit or destructive tools succeeded, the turn goes on with `prompt`, at most
 * `rounds` times. Cleaned here (cleanGuide), so the prompt keeps its lines.
 */
export interface WorkspaceReview {
  rounds: number;
  prompt: string;
}

/** What a workspace page registered (after the relay's checks), with the call that reaches it. */
export interface WorkspaceRegistration {
  plugin: string;
  pluginName: string;
  /** The workspace's key, as the page's route names it. */
  workspace: string;
  /** How the person reads it (its title); the key when left out. */
  workspaceName?: string;
  projectId: string;
  studyId: string;
  /** The plugin's epoch the registration belongs to; pluginEpoch(plugin) now when left out. */
  epoch?: string;
  tools: unknown[];
  guide?: string;
  /** The review rounds it asked for (the relay checked their shape): see WorkspaceReview. */
  review?: WorkspaceReview | null;
  /** Runs one call in the page (the relay); a registration without it can't run anything. */
  invoke?(call: {
    tool: string;
    input: Record<string, unknown>;
    timeoutS: number;
    signal: AbortSignal;
    released?: AbortSignal;
    turn: string | null;
    /** The turn's conversation (the page may read its attachments while the call runs); null for an MCP call. */
    conversation: string | null;
    /** Its place in its step (a turn's own calls only). */
    step?: StepInfo;
    progress(f: number | null, label: string, opts?: ProgressOptions): void;
  }): Promise<ToolOutcome>;
  /** Whether its tools may be offered and run now (true), else why not (the relay's own checks). */
  ready?(): true | string;
}

export interface Refusal {
  name: string;
  code: string;
  message: string;
}

/** Where an app tab is (core host tools spec C7, C8): Home, a project's workbench, or a workspace over it. */
export type CorePlace = Place;

/**
 * What the core page of an app tab registered (C7): where the tab is, the core tools, and the
 * call that reaches the page. Every app tab on this PC registers it, so a turn binds to its
 * window from Home and the workbench too.
 */
export interface CoreRegistration {
  /** The project the tab shows ('' = Home). */
  projectId: string;
  /** The study the tab shows ('' = none). */
  studyId: string;
  place: CorePlace;
  tools: unknown[];
  guide?: string;
  invoke?: WorkspaceRegistration['invoke'];
  ready?(): true | string;
  /**
   * Raise-only risk per call (C3, §5.1): leaving a workspace that sends its design to the
   * simulation is a computation. The relay gives it (it knows the open workspace's plugin).
   */
  escalate?(tool: string, input: Record<string, unknown>): CoreEscalation | null | Promise<CoreEscalation | null>;
}

/** What a core call's escalation found (core__show leaving a workspace that sends its design): its card. */
export interface CoreEscalation {
  risk: 'compute';
  note: string;
  title: string;
  copy: string;
  detail?: GateDetail[];
}

/** The core tools a core page may register, each with its risk (the page can't claim another) and priority (§15). */
export const CORE_TOOLS: Readonly<Record<string, { risk: Risk; priority: number; contexts: readonly Place[]; pinned?: boolean }>> = Object.freeze({
  // How the model reaches another place: never dropped by a budget while anything else fits (§12.3).
  show: { risk: 'edit', priority: 80, contexts: PLACES, pinned: true },
  // A workspace has its own view tool, and the core viewer is under its overlay.
  view: { risk: 'read', priority: 52, contexts: Object.freeze(['home', 'workbench'] as Place[]) },
  // Settings → Keybinds: every plugin's keys (a change asks the person in the page). Not in a
  // workspace: one that has keys has its own keybind tools (the CAD Part's keybind_*), and the
  // Part's tools fit a local model's budget only without these.
  keybinds: { risk: 'read', priority: 30, contexts: Object.freeze(['home', 'workbench'] as Place[]) },
  set_keybind: { risk: 'edit', priority: 28, contexts: Object.freeze(['home', 'workbench'] as Place[]) },
  // Settings → Appearance (a change only when the person asked; shown at once). In a workspace too:
  // its Settings button is in the workspace's header. Small, and last for a tight budget to keep.
  appearance: { risk: 'read', priority: 26, contexts: PLACES },
  set_appearance: { risk: 'edit', priority: 25, contexts: PLACES },
});

export interface ToolRegistry {
  toolsFor(ctx: ToolCtx): ToolDef[];
  /** Diagnostics and /tabs; the runner resolves only in the step's offered list. */
  lookup(ctx: ToolCtx, name: string): ToolDef | null;
  setWorkspace(tab: string, link: string, reg: WorkspaceRegistration | null): { accepted: string[]; refused: Refusal[] };
  registerToolSource(fn: (ctx: ToolCtx) => ToolDef[]): () => void;
}

export const REGISTRATION_MAX_TOOLS = 32;
export const REGISTRATION_MAX_BYTES = 512 * 1024;
/** Per request with a cloud provider (the providers' own limit). A local server has no count cap: LOCAL_BUDGET. */
export const REQUEST_MAX_TOOLS = Object.freeze({ cloud: 40 });
/**
 * A local request's tool definitions take at most `share` of the model's context (tokens), and
 * `unknown` when its server doesn't say (half of a 32K context). A tool's tokens: its definition
 * as sent, in characters, divided by `charsPerToken` (calibrated on CAD's tools: 3.5 to 3.8, so
 * this over-counts a little, the safe side).
 */
export const LOCAL_BUDGET = Object.freeze({ share: 0.5, unknown: 16_384, charsPerToken: 3.5 });
/** A workspace tool's priority when its registration gives none. */
export const WORKSPACE_PRIORITY_DEFAULT = 50;
export const GUIDE_MAX = 4000;
/** A review's most rounds and its prompt's most characters. */
export const REVIEW_ROUNDS_MAX = 5;
export const REVIEW_PROMPT_MAX = 1500;
export const HOST_STALL_MS = 30_000;
export const WORKSPACE_TIMEOUT_S = Object.freeze({ min: 1, max: 600, default: 60 });

const RISKS: readonly Risk[] = ['read', 'edit', 'compute', 'destructive'];
const LOCAL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const SLUG_MAX = 24;
/** The longest workspace tool name: a 24-character slug, `__`, a 32-character name. */
export const TOOL_NAME_MAX = SLUG_MAX + 2 + 32;
/** What every provider accepts as a tool name. */
export const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A plugin key as a tool-name prefix: lower case, `[^a-z0-9_-]` as `_`, no `__`. A key
 * that needed any change, or is longer than 24, becomes its first 19 characters, `_` and
 * 4 hex of its SHA-256, so two keys never share a slug.
 */
export function pluginSlug(key: string): string {
  const raw = String(key ?? '');
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_');
  if (slug === raw && slug.length <= SLUG_MAX && slug.length > 0) return slug;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 4);
  return `${slug.slice(0, SLUG_MAX - 5).replace(/_+$/, '')}_${hash}`;
}

export function workspaceToolName(pluginKey: string, localName: string): string {
  return `${pluginSlug(pluginKey)}__${localName}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A registration's review, cleaned: null when it asked for none, or for one out of shape (1 to 5 rounds, a prompt). */
export function reviewOf(raw: unknown): WorkspaceReview | null {
  if (!isRecord(raw)) return null;
  const rounds = raw.rounds;
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > REVIEW_ROUNDS_MAX) return null;
  const prompt = cleanGuide(raw.prompt, REVIEW_PROMPT_MAX);
  return prompt ? { rounds, prompt } : null;
}

/** The memo of provider definitions: equal content gives the same object, so the same bytes. */
const definitions = new Map<string, ProviderTool>();

/** The provider definitions of `tools`, memoized by content. */
export function providerTools(tools: readonly ToolDef[]): ProviderTool[] {
  return tools.map((t) => {
    const def: ProviderTool = {
      name: t.name,
      description: t.description,
      schema: t.schema,
      ...(t.source.kind === 'workspace' ? { workspace: true } : { ...(t.pinned ? { pinned: true } : {}), ...(typeof t.priority === 'number' ? { priority: t.priority } : {}) }),
    };
    const key = createHash('sha256').update(JSON.stringify(def)).digest('hex');
    let memo = definitions.get(key);
    if (!memo) {
      memo = Object.freeze(def);
      if (definitions.size > 2000) definitions.clear();
      definitions.set(key, memo);
    }
    return memo;
  });
}

/** Tokens by provider definition (they are memoized, so one count per content). */
const tokenCounts = new WeakMap<ProviderTool, number>();

/**
 * A tool's size in a local request (§12.3): its definition as the local server is sent it, in
 * characters, divided by LOCAL_BUDGET.charsPerToken, rounded up.
 */
export function toolTokens(def: ToolDef): number {
  const [p] = providerTools([def]);
  let n = tokenCounts.get(p);
  if (n === undefined) {
    const chars = JSON.stringify({ type: 'function', function: { name: p.name, description: p.description, parameters: emitSchema('openai_compatible', p.schema) } }).length;
    n = Math.ceil(chars / LOCAL_BUDGET.charsPerToken);
    tokenCounts.set(p, n);
  }
  return n;
}

/** A local request's budget of tool-definition tokens for a model of `contextTokens` (null: not known). */
export function localBudget(contextTokens: number | null | undefined): number {
  return typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(LOCAL_BUDGET.share * contextTokens) : LOCAL_BUDGET.unknown;
}

/**
 * Where a turn's window is, from its tab's workspace registration and its project (§11.3): a
 * connected registration of the same project is a workspace; else a project is its workbench;
 * else Home.
 */
export function placeFor(ws: { connected: boolean; reg: { projectId: string } } | null | undefined, projectId: string | null | undefined): Place {
  if (ws && ws.connected && (projectId ?? '') === ws.reg.projectId) return 'workspace';
  return projectId ? 'workbench' : 'home';
}

const PLACE_LABEL: Readonly<Record<Place, string>> = Object.freeze({ home: 'Home', workbench: 'Workbench', workspace: 'Workspaces' });

/** Where a tool is offered, as the person reads it (the left-out note). */
export function contextsLabel(t: ToolDef): string[] {
  if (t.source.kind === 'workspace') return [cleanText(`${t.source.pluginName} ${t.source.workspace}`, TEXT_CAPS.name)];
  return (t.contexts ?? PLACES).map((p) => PLACE_LABEL[p]);
}

interface TabEntry {
  tab: string;
  link: string;
  /** This registration's own source: its tools carry it, and only they belong to it. */
  source: ToolSource;
  reg: WorkspaceRegistration;
  epoch: string;
  tools: ToolDef[];
  refused: Refusal[];
  guide: string;
  review: WorkspaceReview | null;
  connected: boolean;
}

interface CoreEntry {
  tab: string;
  link: string;
  source: ToolSource & { kind: 'core' };
  /** The newest registration: its place and project change without new tools (a step's tools still run). */
  reg: CoreRegistration;
  /** Its tools' and guide's JSON: the same on the same link keeps the tools (and their source). */
  key: string;
  tools: ToolDef[];
  refused: Refusal[];
  guide: string;
  connected: boolean;
}

/**
 * An edition's tools (Magnusim CAD: assistant-routes.ts CAD_EDITION_TOOLS): a host or core page
 * tool as the edition offers it (its enums and words narrowed), or null when it has none.
 * Never asked about a workspace's tools: those are the plugin's, the same in every edition.
 */
export type EditionFilter = (def: ToolDef) => ToolDef | null;

export interface RegistryOptions {
  hostTools?: readonly ToolDef[];
  /** Left out: every host and core tool as it is (Magnusim). */
  edition?: EditionFilter;
  /** foam-runner.js pluginEpoch (tests pass their own). */
  pluginEpoch?: (key: string) => string;
}

const byName = (a: ToolDef, b: ToolDef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const WORKSPACE_ONLY: readonly Place[] = Object.freeze(['workspace']);
/** Which goes first when a budget is tight: the lowest priority, then the later name. */
const dropOrder = (a: ToolDef, b: ToolDef) => (a.priority ?? 0) - (b.priority ?? 0) || byName(b, a);

export class Registry implements ToolRegistry {
  private readonly host: ToolDef[];
  private readonly epochOf: (key: string) => string;
  private readonly edition: EditionFilter | null;
  private readonly tabs = new Map<string, TabEntry>();
  /** Each app tab's core page registration (C7), beside its workspace one. */
  private readonly coreTabs = new Map<string, CoreEntry>();
  private readonly sources = new Set<(ctx: ToolCtx) => ToolDef[]>();
  private readonly changeListeners = new Set<(tab: string) => void>();

  constructor(o: RegistryOptions = {}) {
    this.epochOf = o.pluginEpoch ?? ((key: string) => String(foamPluginEpoch(key)));
    this.edition = o.edition ?? null;
    this.host = [];
    for (const t of o.hostTools ?? []) this.addHostTool(t);
  }

  /**
   * Hears each change of what may be offered (phase 3 spec 3.4: MCP connections send
   * list_changed): a tab's registration set or dropped, connected or dormant (`tab`), a host
   * tool or a tool source added or removed ('*'). A plugin turned off, swapped or reset comes
   * through the relay, which drops its registrations. Sources are pure functions of the
   * context, so a change inside one is not heard: MCP recomputes its list around each call.
   * Listeners run synchronously, inside the change: defer any work that reads the registry
   * or the relay back.
   */
  onChange(fn: (tab: string) => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private changed(tab: string): void {
    for (const fn of [...this.changeListeners]) {
      try {
        fn(tab);
      } catch {
        /* a listener's failure never blocks a registration */
      }
    }
  }

  /** A host tool (plain snake_case, no `__`). */
  addHostTool(t: ToolDef): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name) || t.name.includes('__')) throw new Error(`bad host tool name: ${t.name}`);
    if (this.host.some((h) => h.name === t.name)) throw new Error(`duplicate host tool: ${t.name}`);
    // An edition without this tool leaves it out; one that narrows it keeps its narrowed copy.
    const offered = this.edition ? this.edition(t) : t;
    if (!offered) return;
    this.host.push(offered);
    this.changed('*');
  }

  registerToolSource(fn: (ctx: ToolCtx) => ToolDef[]): () => void {
    this.sources.add(fn);
    this.changed('*');
    return () => {
      if (this.sources.delete(fn)) this.changed('*');
    };
  }

  /** A plugin's epoch now (the relay pins a page's registrations to it). */
  currentEpoch(key: string): string {
    return this.epochOf(key);
  }

  /** A registration's fence: its plugin's epoch is still the one it was made under. */
  fenced(source: ToolSource): boolean {
    if (source.kind === 'host' || source.kind === 'core') return false;
    return this.epochOf(source.plugin) !== source.epoch;
  }

  setWorkspace(tab: string, link: string, reg: WorkspaceRegistration | null): { accepted: string[]; refused: Refusal[] } {
    if (!reg) {
      if (this.tabs.delete(tab)) this.changed(tab);
      return { accepted: [], refused: [] };
    }
    const epoch = reg.epoch ?? this.epochOf(reg.plugin);
    const pluginName = cleanText(reg.pluginName || reg.plugin, TEXT_CAPS.name);
    const workspace = cleanText(reg.workspaceName || reg.workspace, TEXT_CAPS.name);
    const source: ToolSource = {
      kind: 'workspace',
      plugin: reg.plugin,
      pluginName,
      workspace,
      tab,
      link,
      projectId: reg.projectId,
      studyId: reg.studyId,
      epoch,
    };
    const refused: Refusal[] = [];
    const tools: ToolDef[] = [];
    const list = Array.isArray(reg.tools) ? reg.tools : [];
    let size = Infinity;
    try {
      size = Buffer.byteLength(JSON.stringify({ tools: list, guide: reg.guide ?? '', review: reg.review ?? null }), 'utf8');
    } catch {
      /* not JSON: refused below */
    }
    if (size > REGISTRATION_MAX_BYTES) {
      for (const t of list) refused.push({ name: nameOf(t), code: 'too_large', message: `A registration is at most ${REGISTRATION_MAX_BYTES / 1024} KB.` });
    } else {
      const seen = new Set<string>();
      for (const raw of list) {
        const r = this.checkTool(raw, source, reg, seen, tools.length);
        if ('code' in r) refused.push(r);
        else tools.push(r);
      }
    }
    tools.sort(byName);
    this.tabs.set(tab, { tab, link, source, reg, epoch, tools, refused, guide: cleanGuide(reg.guide ?? '', GUIDE_MAX), review: reviewOf(reg.review), connected: true });
    this.changed(tab);
    return { accepted: tools.map((t) => t.localName), refused };
  }

  private checkTool(raw: unknown, source: ToolSource & { kind: 'workspace' }, reg: WorkspaceRegistration, seen: Set<string>, count: number): ToolDef | Refusal {
    const name = nameOf(raw);
    const refuse = (code: string, message: string): Refusal => ({ name, code, message });
    if (!isRecord(raw)) return refuse('bad_tool', 'A tool must be an object.');
    if (typeof raw.name !== 'string' || !LOCAL_NAME.test(raw.name) || raw.name.includes('__')) {
      return refuse('bad_name', 'A tool name is a lower-case letter, then up to 31 lower-case letters, digits or single underscores.');
    }
    if (seen.has(raw.name)) return refuse('duplicate', `Another tool on this page is already called "${raw.name}".`);
    seen.add(raw.name);
    if (count >= REGISTRATION_MAX_TOOLS) return refuse('too_many', `A page may offer at most ${REGISTRATION_MAX_TOOLS} tools.`);
    const description = cleanText(raw.description, TEXT_CAPS.description);
    if (!description) return refuse('bad_description', 'A tool needs a description.');
    const check = checkSchema(raw.inputSchema);
    if (!check.ok) return refuse('bad_schema', check.error);
    const cleaned = cleanSchemaText(raw.inputSchema, '');
    if (typeof cleaned === 'string') return refuse('bad_schema', cleaned);
    const schema = cleaned as unknown as JsonSchemaObject;
    const risk: Risk = RISKS.includes(raw.risk as Risk) ? (raw.risk as Risk) : 'destructive';
    const t = Number(raw.timeoutS);
    const timeoutS = Number.isFinite(t) ? Math.min(WORKSPACE_TIMEOUT_S.max, Math.max(WORKSPACE_TIMEOUT_S.min, Math.round(t))) : WORKSPACE_TIMEOUT_S.default;
    const localName = raw.name;
    const fullName = workspaceToolName(source.plugin, localName);
    const confirmNote = cleanText(typeof raw.confirm === 'string' ? raw.confirm : '', CONFIRM_NOTE_MAX);
    // Which of the page's tools a tight local budget keeps first (bridge 1.9: 0-100, default 50).
    const p = raw.priority;
    const priority = typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 100 ? p : WORKSPACE_PRIORITY_DEFAULT;
    const registry = this;
    return {
      name: fullName,
      localName,
      title: cleanText(typeof raw.title === 'string' && raw.title ? raw.title : localName, TEXT_CAPS.name),
      description,
      schema,
      risk,
      source,
      projectData: true,
      stallMs: timeoutS * 1000,
      workerBacked: false,
      priority,
      contexts: WORKSPACE_ONLY,
      ...(confirmNote ? { confirmNote } : {}),
      available(ctx: ToolCtx): true | string {
        return registry.workspaceAvailable(source, ctx);
      },
      async run(input, rt) {
        const why = registry.workspaceAvailable(source, rt.ctx);
        if (why !== true) return { ok: false, error: { code: registry.fenced(source) ? 'plugin_off' : 'unavailable', message: why }, summary: why };
        if (!reg.invoke) {
          const message = `The page hosting ${source.workspace} isn't connected.`;
          return { ok: false, error: { code: 'tab_disconnected', message }, summary: message };
        }
        return reg.invoke({
          tool: localName,
          input,
          timeoutS,
          signal: rt.signal,
          released: rt.released,
          turn: rt.turn,
          conversation: conversationOf(rt.ctx),
          ...(rt.step ? { step: rt.step } : {}),
          progress: rt.progress,
        });
      },
    };
  }

  /** Whether a workspace tool may run for `ctx` now (true), else why not. */
  workspaceAvailable(source: ToolSource, ctx: ToolCtx): true | string {
    if (source.kind !== 'workspace') return true;
    if (this.fenced(source)) return `${source.pluginName} was turned off or replaced.`;
    const entry = this.tabs.get(source.tab);
    if (!entry || entry.link !== source.link) return `${source.workspace} is no longer open.`;
    // The tab registered again since this tool was offered: only the new list's tools run.
    if (entry.source !== source) return `${source.workspace} changed its tools since they were offered; use the tools offered now.`;
    if (!entry.connected) return `The page hosting ${source.workspace} isn't connected.`;
    if (ctx.tab !== source.tab) return 'That tool belongs to another tab.';
    if ((ctx.projectId ?? '') !== source.projectId) return 'That tool belongs to another project.';
    return entry.reg.ready?.() ?? true;
  }

  /**
   * The relay's link for `tab` came or went (a dormant registration offers nothing). Only
   * the registration's own link brings it back: on a new link the page registers again
   * (the re-POST checks its rev and epoch, spec 8.4) and setWorkspace replaces the entry.
   */
  setConnected(tab: string, link: string, connected: boolean): void {
    const e = this.tabs.get(tab);
    if (!e || e.link !== link || e.connected === connected) return;
    e.connected = connected;
    this.changed(tab);
  }

  /** What a tab registered (for /tabs and diagnostics). */
  workspaceOf(tab: string): { link: string; connected: boolean; reg: WorkspaceRegistration; epoch: string; tools: string[]; refused: Refusal[]; guide: string; review: WorkspaceReview | null } | null {
    const e = this.tabs.get(tab);
    if (!e) return null;
    return { link: e.link, connected: e.connected, reg: e.reg, epoch: e.epoch, tools: e.tools.map((t) => t.name), refused: e.refused, guide: e.guide, review: e.review };
  }

  tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  // ------------------------------------------------------------ the core page (C7)

  /**
   * The core page of `tab` registered (null: it withdrew, or its link went for good). Its tools
   * are only those of CORE_TOOLS, at their own risk. Where the tab is (place, project, study)
   * changes with every registration; the same tools on the same link keep their ToolDefs, so a
   * step's offered core tool still runs after the tab moved within a project.
   */
  setCore(tab: string, link: string, reg: CoreRegistration | null): { accepted: string[]; refused: Refusal[] } {
    if (!reg) {
      if (this.coreTabs.delete(tab)) this.changed(tab);
      return { accepted: [], refused: [] };
    }
    const list = Array.isArray(reg.tools) ? reg.tools : [];
    let key = '';
    try {
      key = JSON.stringify({ tools: list, guide: reg.guide ?? '' });
    } catch {
      key = '';
    }
    const prev = this.coreTabs.get(tab);
    if (prev && key && prev.link === link && prev.key === key) {
      prev.reg = reg;
      prev.connected = true;
      this.changed(tab);
      return { accepted: prev.tools.map((t) => t.localName), refused: prev.refused };
    }
    const source = { kind: 'core' as const, tab, link };
    const refused: Refusal[] = [];
    const tools: ToolDef[] = [];
    if (!key || Buffer.byteLength(key, 'utf8') > REGISTRATION_MAX_BYTES) {
      for (const t of list) refused.push({ name: nameOf(t), code: 'too_large', message: `A registration is at most ${REGISTRATION_MAX_BYTES / 1024} KB.` });
    } else {
      const seen = new Set<string>();
      for (const raw of list) {
        const r = this.checkCoreTool(raw, source, seen);
        if ('code' in r) {
          refused.push(r);
          continue;
        }
        const offered = this.edition ? this.edition(r) : r;
        if (offered) tools.push(offered);
        else refused.push({ name: r.localName, code: 'not_in_edition', message: `${r.name} is not in this edition of the app.` });
      }
    }
    tools.sort(byName);
    this.coreTabs.set(tab, { tab, link, source, reg, key, tools, refused, guide: cleanGuide(reg.guide ?? '', GUIDE_MAX), connected: true });
    this.changed(tab);
    return { accepted: tools.map((t) => t.localName), refused };
  }

  /** A core tool as a workspace tool is checked (name, description, schema), with its fixed risk and priority. */
  private checkCoreTool(raw: unknown, source: ToolSource & { kind: 'core' }, seen: Set<string>): ToolDef | Refusal {
    const cardTitles = new WeakMap<Record<string, unknown>, string>();
    const fixed = isRecord(raw) && typeof raw.name === 'string' && Object.hasOwn(CORE_TOOLS, raw.name) ? CORE_TOOLS[raw.name] : null;
    if (!fixed) return { name: nameOf(raw), code: 'bad_name', message: `The core page offers only ${Object.keys(CORE_TOOLS).join(', ')}.` };
    // The shape checks of a workspace tool, under the `core` slug; its risk is the core table's.
    const shape: ToolSource & { kind: 'workspace' } = { kind: 'workspace', plugin: 'core', pluginName: 'Magnusim', workspace: 'app', tab: source.tab, link: source.link, projectId: '', studyId: '', epoch: 'core' };
    const checked = this.checkTool({ ...(raw as Record<string, unknown>), risk: fixed.risk }, shape, { plugin: 'core', pluginName: 'Magnusim', workspace: 'app', projectId: '', studyId: '', tools: [] }, seen, 0);
    if ('code' in checked) return checked;
    const registry = this;
    const localName = checked.localName;
    const timeoutS = Math.round(checked.stallMs / 1000);
    const def: ToolDef = {
      ...checked,
      source,
      priority: fixed.priority,
      contexts: fixed.contexts,
      ...(fixed.pinned ? { pinned: true } : {}),
      available(ctx: ToolCtx): true | string {
        return registry.coreAvailable(source, localName, ctx);
      },
      async run(input, rt) {
        const why = registry.coreAvailable(source, localName, rt.ctx);
        if (why !== true) return { ok: false, error: { code: 'unavailable', message: why }, summary: why };
        const invoke = registry.coreTabs.get(source.tab)?.reg.invoke;
        if (!invoke) {
          const message = "This window isn't connected.";
          return { ok: false, error: { code: 'tab_disconnected', message }, summary: message };
        }
        return invoke({
          tool: localName,
          input,
          timeoutS,
          signal: rt.signal,
          released: rt.released,
          turn: rt.turn,
          conversation: conversationOf(rt.ctx),
          ...(rt.step ? { step: rt.step } : {}),
          progress: rt.progress,
        });
      },
      // Raise-only risk per call and its card (C3, §2.1): the core page's own rule, from its newest registration.
      // The runner keeps only an escalation's risk, note and rows: the card's copy goes as its
      // note (whole, as gateText words the card), its title by the call's input (the runner asks
      // gateText with the input it assessed).
      async escalate(input) {
        const up = (await registry.coreTabs.get(source.tab)?.reg.escalate?.(localName, input)) ?? null;
        if (!up) return null;
        cardTitles.set(input, up.title);
        return { risk: up.risk, note: up.copy || up.note, detail: up.detail ?? [] };
      },
      gateText(input, a) {
        const title = cardTitles.get(input) ?? `Allow the Assistant to ${localName === 'show' ? 'move this window' : 'use the view'}?`;
        return { title, copy: a?.note ?? '', ...(a?.detail.length ? { detail: a.detail } : {}) };
      },
    };
    return def;
  }

  /** Whether a core tool may run for `ctx` now (true), else why not. */
  coreAvailable(source: ToolSource, localName: string, ctx: ToolCtx): true | string {
    if (source.kind !== 'core') return true;
    const e = this.coreTabs.get(source.tab);
    if (!e || e.link !== source.link) return 'This Magnusim window is no longer open.';
    if (e.source !== source) return 'This window changed its tools since they were offered; use the tools offered now.';
    if (!e.connected) return "This Magnusim window isn't connected.";
    if (ctx.tab !== source.tab) return 'That tool belongs to another window.';
    // A project opened since this step began: its tools (and its privacy) come with the next step.
    if ((ctx.projectId ?? '') !== e.reg.projectId) return 'This window opened another project; its tools are offered again from the next step.';
    if (localName === 'view' && e.reg.place === 'workspace') return "core__view works on Home and in the workbench; in a workspace, use the workspace's own view tool.";
    return e.reg.ready?.() ?? true;
  }

  /** The core tools of the turn's own tab (none without a tab: a tab-less MCP client). */
  private coreToolsOf(ctx: ToolCtx): ToolDef[] {
    const e = ctx.tab ? this.coreTabs.get(ctx.tab) : undefined;
    return e ? e.tools : [];
  }

  /** The core page's link came or went (as setConnected for a workspace registration). */
  setCoreConnected(tab: string, link: string, connected: boolean): void {
    const e = this.coreTabs.get(tab);
    if (!e || e.link !== link || e.connected === connected) return;
    e.connected = connected;
    this.changed(tab);
  }

  /** Where an app tab's core page says it is (resolveTab, the turn following its tab), or null. */
  coreOf(tab: string): { link: string; connected: boolean; projectId: string; studyId: string; place: CorePlace; tools: string[]; refused: Refusal[]; guide: string } | null {
    const e = this.coreTabs.get(tab);
    if (!e) return null;
    return { link: e.link, connected: e.connected, projectId: e.reg.projectId, studyId: e.reg.studyId, place: e.reg.place, tools: e.tools.map((t) => t.name), refused: e.refused, guide: e.guide };
  }

  coreTabIds(): string[] {
    return [...this.coreTabs.keys()];
  }

  /**
   * Where `tab`'s window is (§11.3): a connected workspace registration of the project → workspace;
   * else its core page's place when it shows that project (C7); else the project's workbench or Home.
   */
  placeOf(tab: string | null, projectId: string | null): Place {
    const ws = tab ? this.tabs.get(tab) : null;
    if (ws && ws.connected && (projectId ?? '') === ws.reg.projectId) return 'workspace';
    const core = tab ? this.coreTabs.get(tab) : null;
    if (core && core.reg.projectId === (projectId ?? '')) return core.reg.place;
    return placeFor(null, projectId);
  }

  /** The context's place: its own, or (a caller that predates places) the tab's. */
  private placeIn(ctx: ToolCtx): Place {
    return PLACES.includes(ctx.place) ? ctx.place : this.placeOf(ctx.tab, ctx.projectId);
  }

  /** Every tool that may be offered for `ctx`, before the per-request cap or budget: host and other tools only in their places. */
  private candidates(ctx: ToolCtx): { host: ToolDef[]; workspace: ToolDef[]; other: ToolDef[] } {
    const place = this.placeIn(ctx);
    const here = (t: ToolDef) => !t.contexts || t.contexts.includes(place);
    // The tab's core page tools go with the host's (C7).
    const host = [...this.host, ...this.coreToolsOf(ctx)].filter((t) => here(t) && t.available(ctx) === true).sort(byName);
    const entry = ctx.tab ? this.tabs.get(ctx.tab) : undefined;
    const workspace = entry ? entry.tools.filter((t) => this.workspaceAvailable(t.source, ctx) === true) : [];
    const other: ToolDef[] = [];
    for (const fn of this.sources) {
      for (const t of fn(ctx)) if (!this.fenced(t.source) && here(t) && t.available(ctx) === true) other.push(t);
    }
    other.sort(byName);
    return { host, workspace, other };
  }

  /**
   * This step's tools, and what the cap or budget left out (the loop notes them).
   * - Cloud: at most REQUEST_MAX_TOOLS.cloud. Workspace (and other plugin) tools are kept
   *   first; then host tools by priority (pinned ones first).
   * - Local: no count cap. When the tools' tokens (toolTokens) are over ctx.budgetTokens
   *   (LOCAL_BUDGET.unknown when not given), tools are dropped until they fit: host tools by
   *   priority (the lowest first, then the later name), then workspace and other tools by
   *   theirs, pinned tools last. Nothing left of a non-empty set: `tooSmall`.
   * The result is ordered by place (§12.4): in a workspace its tools first, then the host's;
   * elsewhere the host's first. Each group by name, so the bytes are a function of the set.
   */
  selectTools(ctx: ToolCtx): ToolSelection {
    const place = this.placeIn(ctx);
    const { host, workspace, other } = this.candidates(ctx);
    const rest = [...workspace, ...other];
    let keep: Set<ToolDef>;
    let dropped: ToolDef[];
    let budget: number | null = null;
    if (!ctx.local) {
      const cap = REQUEST_MAX_TOOLS.cloud;
      const keptRest = rest.slice(0, cap);
      const room = Math.max(0, cap - keptRest.length);
      const keptHost = [...host].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || (b.priority ?? 0) - (a.priority ?? 0) || byName(a, b)).slice(0, room);
      keep = new Set([...keptHost, ...keptRest]);
      dropped = [...host.filter((t) => !keep.has(t)), ...rest.slice(cap)];
    } else {
      budget = typeof ctx.budgetTokens === 'number' && Number.isFinite(ctx.budgetTokens) && ctx.budgetTokens >= 0 ? ctx.budgetTokens : LOCAL_BUDGET.unknown;
      const all = [...host, ...rest];
      let total = all.reduce((n, t) => n + toolTokens(t), 0);
      const order = [...host.filter((t) => !t.pinned).sort(dropOrder), ...rest.filter((t) => !t.pinned).sort(dropOrder), ...all.filter((t) => t.pinned).sort(dropOrder)];
      dropped = [];
      for (const t of order) {
        if (total <= budget) break;
        dropped.push(t);
        total -= toolTokens(t);
      }
      const gone = new Set(dropped);
      keep = new Set(all.filter((t) => !gone.has(t)));
    }
    const keptHost = host.filter((t) => keep.has(t));
    const keptRest = rest.filter((t) => keep.has(t));
    const tools = place === 'workspace' ? [...keptRest, ...keptHost] : [...keptHost, ...keptRest];
    const total = host.length + rest.length;
    return { tools, dropped: dropped.map((t) => ({ name: t.name, contexts: contextsLabel(t) })), budget, tooSmall: total > 0 && tools.length === 0 };
  }

  toolsFor(ctx: ToolCtx): ToolDef[] {
    return this.selectTools(ctx).tools;
  }

  lookup(ctx: ToolCtx, name: string): ToolDef | null {
    const { host, workspace, other } = this.candidates(ctx);
    return [...host, ...workspace, ...other].find((t) => t.name === name) ?? null;
  }
}

/**
 * A copy of a checked schema with the text inside it cleaned and capped like the tool's
 * own (descriptions 1024, titles 200): the provider sees every nested description. Values
 * validation compares exactly (enum, const) and property names are refused, not
 * rewritten, when they hold a control character. Returns the reason when refused.
 */
function cleanSchemaText(node: unknown, path: string): Record<string, unknown> | string {
  const at = path || '(root)';
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(n)) {
    let value: unknown = v;
    if (key === 'description') value = cleanText(v, TEXT_CAPS.description);
    else if (key === 'title') value = cleanText(v, TEXT_CAPS.name);
    else if (key === 'enum' || key === 'const') {
      for (const x of key === 'enum' ? (v as unknown[]) : [v]) {
        if (typeof x === 'string' && hasControls(x)) return `${at}: "${key}" values may not hold control characters.`;
      }
      value = structuredClone(v);
    } else if (key === 'properties') {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(v as Record<string, unknown>)) {
        if (hasControls(name)) return `${at}: property names may not hold control characters.`;
        const c = cleanSchemaText(child, path ? `${path}.${name}` : name);
        if (typeof c === 'string') return c;
        Object.defineProperty(props, name, { value: c, enumerable: true, writable: true, configurable: true });
      }
      value = props;
    } else if (key === 'items') {
      const c = cleanSchemaText(v, `${path}[]`);
      if (typeof c === 'string') return c;
      value = c;
    } else value = structuredClone(v);
    out[key] = value;
  }
  return out;
}

function nameOf(raw: unknown): string {
  return isRecord(raw) && typeof raw.name === 'string' ? cleanText(raw.name, 64) : '';
}

export function createToolRegistry(o: RegistryOptions = {}): Registry {
  return new Registry(o);
}
