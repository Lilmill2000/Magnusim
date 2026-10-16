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
 *   `<plugin slug>__<name>` (`ai-demo__add`). Host tools come first, then workspace
 *   tools, each by name, and the provider definitions are memoized by content, so the
 *   bytes of the tool list stay the same from step to step (the provider's cache holds).
 * - Caps: ≤ 32 tools and ≤ 512 KB per registration; per request 40 tools (cloud) or 24
 *   (local), workspace tools kept first; over the cap the lowest-priority host tools go,
 *   and the step can't call them.
 * - Fence: a registration records its plugin's epoch (foam-runner.js pluginEpoch); a
 *   plugin turned off, swapped or reset bumps it, and from then on its tools are neither
 *   offered nor available.
 * - An unknown risk counts as destructive.
 */
import { createHash } from 'node:crypto';
import { pluginEpoch as foamPluginEpoch } from '../../foam-runner.js';
import { checkSchema } from './schema.ts';
import { cleanText, TEXT_CAPS } from './sanitize.ts';
import type { ImagePart, JsonSchemaObject, ProviderTool, Risk } from './types.ts';

export type ToolSource =
  | { kind: 'host' }
  | { kind: 'workspace'; plugin: string; pluginName: string; workspace: string; tab: string; link: string; projectId: string; studyId: string; epoch: string }
  /** Reserved for a later phase (other plugins' tools). */
  | { kind: 'plugin'; plugin: string; method: string; epoch: string };

export interface ToolCtx {
  tab: string | null;
  projectId: string | null;
  simulationId: string | null;
  /** The turn's provider sends data off this PC. */
  cloud: boolean;
  /** The turn runs on a local server (the smaller per-request tool cap). */
  local: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  text?: string;
  images?: ImagePart[];
  error?: { code: string; message: string; hint?: string };
  /** One line for the turn log. */
  summary: string;
}

export interface ToolRunContext {
  signal: AbortSignal;
  ctx: ToolCtx;
  turn: string | null;
  progress(fraction: number | null, label: string): void;
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
   * turn_minutes cap bounds the whole call. Host default 30 s; workspace timeoutS 1–600
   * (default 60).
   */
  stallMs: number;
  workerBacked: boolean;
  /** Higher stays when a request is over the tool cap (host tools; workspace tools always go first). */
  priority?: number;
  available(ctx: ToolCtx): true | string;
  describe?(input: Record<string, unknown>): { line: string; detail?: Array<{ label: string; value: string }> };
  run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome>;
}

/** What a workspace page registered (after the relay's checks), with the call that reaches it. */
export interface WorkspaceRegistration {
  plugin: string;
  pluginName: string;
  workspace: string;
  projectId: string;
  studyId: string;
  /** The plugin's epoch the registration belongs to; pluginEpoch(plugin) now when left out. */
  epoch?: string;
  tools: unknown[];
  guide?: string;
  /** Runs one call in the page (the relay); a registration without it can't run anything. */
  invoke?(call: { tool: string; input: Record<string, unknown>; timeoutS: number; signal: AbortSignal; turn: string | null; progress(f: number | null, label: string): void }): Promise<ToolOutcome>;
}

export interface Refusal {
  name: string;
  code: string;
  message: string;
}

export interface ToolRegistry {
  toolsFor(ctx: ToolCtx): ToolDef[];
  /** Diagnostics and /tabs; the runner resolves only in the step's offered list. */
  lookup(ctx: ToolCtx, name: string): ToolDef | null;
  setWorkspace(tab: string, link: string, reg: WorkspaceRegistration | null): { accepted: string[]; refused: Refusal[] };
  registerToolSource(fn: (ctx: ToolCtx) => ToolDef[]): () => void;
}

export const REGISTRATION_MAX_TOOLS = 32;
export const REGISTRATION_MAX_BYTES = 512 * 1024;
export const REQUEST_MAX_TOOLS = Object.freeze({ cloud: 40, local: 24 });
export const GUIDE_MAX = 4000;
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

/** The memo of provider definitions: equal content gives the same object, so the same bytes. */
const definitions = new Map<string, ProviderTool>();

/** The provider definitions of `tools`, memoized by content. */
export function providerTools(tools: readonly ToolDef[]): ProviderTool[] {
  return tools.map((t) => {
    const def: ProviderTool = { name: t.name, description: t.description, schema: t.schema };
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

interface TabEntry {
  tab: string;
  link: string;
  reg: WorkspaceRegistration;
  epoch: string;
  tools: ToolDef[];
  refused: Refusal[];
  guide: string;
  connected: boolean;
}

export interface RegistryOptions {
  hostTools?: readonly ToolDef[];
  /** foam-runner.js pluginEpoch (tests pass their own). */
  pluginEpoch?: (key: string) => string;
}

const byName = (a: ToolDef, b: ToolDef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class Registry implements ToolRegistry {
  private readonly host: ToolDef[];
  private readonly epochOf: (key: string) => string;
  private readonly tabs = new Map<string, TabEntry>();
  private readonly sources = new Set<(ctx: ToolCtx) => ToolDef[]>();

  constructor(o: RegistryOptions = {}) {
    this.epochOf = o.pluginEpoch ?? ((key: string) => String(foamPluginEpoch(key)));
    this.host = [];
    for (const t of o.hostTools ?? []) this.addHostTool(t);
  }

  /** A host tool (plain snake_case, no `__`). */
  addHostTool(t: ToolDef): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name) || t.name.includes('__')) throw new Error(`bad host tool name: ${t.name}`);
    if (this.host.some((h) => h.name === t.name)) throw new Error(`duplicate host tool: ${t.name}`);
    this.host.push(t);
  }

  registerToolSource(fn: (ctx: ToolCtx) => ToolDef[]): () => void {
    this.sources.add(fn);
    return () => {
      this.sources.delete(fn);
    };
  }

  /** A registration's fence: its plugin's epoch is still the one it was made under. */
  fenced(source: ToolSource): boolean {
    if (source.kind === 'host') return false;
    return this.epochOf(source.plugin) !== source.epoch;
  }

  setWorkspace(tab: string, link: string, reg: WorkspaceRegistration | null): { accepted: string[]; refused: Refusal[] } {
    if (!reg) {
      this.tabs.delete(tab);
      return { accepted: [], refused: [] };
    }
    const epoch = reg.epoch ?? this.epochOf(reg.plugin);
    const pluginName = cleanText(reg.pluginName || reg.plugin, TEXT_CAPS.name);
    const workspace = cleanText(reg.workspace, TEXT_CAPS.name);
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
      size = Buffer.byteLength(JSON.stringify({ tools: list, guide: reg.guide ?? '' }), 'utf8');
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
    this.tabs.set(tab, { tab, link, reg, epoch, tools, refused, guide: cleanText(reg.guide ?? '', GUIDE_MAX), connected: true });
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
    const schema = raw.inputSchema;
    const check = checkSchema(schema);
    if (!check.ok) return refuse('bad_schema', check.error);
    const risk: Risk = RISKS.includes(raw.risk as Risk) ? (raw.risk as Risk) : 'destructive';
    const t = Number(raw.timeoutS);
    const timeoutS = Number.isFinite(t) ? Math.min(WORKSPACE_TIMEOUT_S.max, Math.max(WORKSPACE_TIMEOUT_S.min, Math.round(t))) : WORKSPACE_TIMEOUT_S.default;
    const localName = raw.name;
    const fullName = workspaceToolName(source.plugin, localName);
    const registry = this;
    return {
      name: fullName,
      localName,
      title: cleanText(typeof raw.title === 'string' && raw.title ? raw.title : localName, TEXT_CAPS.name),
      description,
      schema: structuredClone(schema) as JsonSchemaObject,
      risk,
      source,
      projectData: true,
      stallMs: timeoutS * 1000,
      workerBacked: false,
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
        return reg.invoke({ tool: localName, input, timeoutS, signal: rt.signal, turn: rt.turn, progress: rt.progress });
      },
    };
  }

  /** Whether a workspace tool may run for `ctx` now (true), else why not. */
  workspaceAvailable(source: ToolSource, ctx: ToolCtx): true | string {
    if (source.kind !== 'workspace') return true;
    if (this.fenced(source)) return `${source.pluginName} was turned off or replaced.`;
    const entry = this.tabs.get(source.tab);
    if (!entry || entry.link !== source.link) return `${source.workspace} is no longer open.`;
    if (!entry.connected) return `The page hosting ${source.workspace} isn't connected.`;
    if (ctx.tab !== source.tab) return 'That tool belongs to another tab.';
    if ((ctx.projectId ?? '') !== source.projectId) return 'That tool belongs to another project.';
    return true;
  }

  /** The relay's link for `tab` came or went (a dormant registration offers nothing). */
  setConnected(tab: string, link: string, connected: boolean): void {
    const e = this.tabs.get(tab);
    if (!e) return;
    if (connected) {
      e.link = link;
      e.connected = true;
      for (const t of e.tools) if (t.source.kind === 'workspace') t.source.link = link;
    } else if (e.link === link) e.connected = false;
  }

  /** What a tab registered (for /tabs and diagnostics). */
  workspaceOf(tab: string): { link: string; connected: boolean; reg: WorkspaceRegistration; epoch: string; tools: string[]; refused: Refusal[]; guide: string } | null {
    const e = this.tabs.get(tab);
    if (!e) return null;
    return { link: e.link, connected: e.connected, reg: e.reg, epoch: e.epoch, tools: e.tools.map((t) => t.name), refused: e.refused, guide: e.guide };
  }

  tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  /** Every tool that may be offered for `ctx`, before the per-request cap. */
  private candidates(ctx: ToolCtx): { host: ToolDef[]; workspace: ToolDef[]; other: ToolDef[] } {
    const host = this.host.filter((t) => t.available(ctx) === true).sort(byName);
    const entry = ctx.tab ? this.tabs.get(ctx.tab) : undefined;
    const workspace = entry ? entry.tools.filter((t) => this.workspaceAvailable(t.source, ctx) === true) : [];
    const other: ToolDef[] = [];
    for (const fn of this.sources) {
      for (const t of fn(ctx)) if (!this.fenced(t.source) && t.available(ctx) === true) other.push(t);
    }
    other.sort(byName);
    return { host, workspace, other };
  }

  /**
   * This step's tools, and the host tools the per-request cap left out (the loop notes
   * them). Workspace (and other plugin) tools are kept first; then host tools by
   * priority. The result is ordered host tools first, then the rest, each by name.
   */
  selectTools(ctx: ToolCtx): { tools: ToolDef[]; dropped: string[] } {
    const cap = ctx.local ? REQUEST_MAX_TOOLS.local : REQUEST_MAX_TOOLS.cloud;
    const { host, workspace, other } = this.candidates(ctx);
    const rest = [...workspace, ...other].slice(0, cap);
    const room = Math.max(0, cap - rest.length);
    const keptHost = [...host].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || byName(a, b)).slice(0, room);
    const keep = new Set(keptHost.map((t) => t.name));
    const dropped = [...host.filter((t) => !keep.has(t.name)), ...[...workspace, ...other].slice(cap)].map((t) => t.name);
    return { tools: [...host.filter((t) => keep.has(t.name)), ...rest], dropped };
  }

  toolsFor(ctx: ToolCtx): ToolDef[] {
    return this.selectTools(ctx).tools;
  }

  lookup(ctx: ToolCtx, name: string): ToolDef | null {
    const { host, workspace, other } = this.candidates(ctx);
    return [...host, ...workspace, ...other].find((t) => t.name === name) ?? null;
  }
}

function nameOf(raw: unknown): string {
  return isRecord(raw) && typeof raw.name === 'string' ? cleanText(raw.name, 64) : '';
}

export function createToolRegistry(o: RegistryOptions = {}): Registry {
  return new Registry(o);
}
