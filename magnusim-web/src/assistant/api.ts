/**
 * The page's calls to the Assistant's routes. Every route is for this PC only: over remote
 * access each answers 403 `{reason:'remote'}`, which becomes a RemoteError here so the
 * callers can show the one remote sentence. Any other refusal is an AssistantApiError with
 * the server's status, code, field and text (never the key: the key routes don't echo it).
 */
import type { AgentRow, AgentsAnswer, AgentTestAnswer, ModelView, ModeView, RefusalBody, SignInMethodView, SignInView } from './wire';

/** What Settings says over remote access (the server's REMOTE_MESSAGE). */
export const REMOTE_TEXT =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

export class AssistantApiError extends Error {
  /** HTTP status; 0 when the server didn't answer. */
  status: number;
  code: string;
  field: string | null;
  body: RefusalBody | Record<string, unknown>;
  constructor(status: number, body: RefusalBody | Record<string, unknown>, message: string) {
    super(message);
    this.status = status;
    const b = body as RefusalBody;
    this.code = typeof b.code === 'string' ? b.code : status ? `http_${status}` : 'network';
    this.field = typeof b.field === 'string' ? b.field : null;
    this.body = body;
  }
}

/** A 403 `{reason:'remote'}`: this page is not on the PC running Magnusim. */
export class RemoteError extends AssistantApiError {}

async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      cache: 'no-store',
      signal,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new AssistantApiError(0, {}, "Magnusim's server didn't answer.");
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 403 && j.reason === 'remote') throw new RemoteError(403, j, REMOTE_TEXT);
  if (!r.ok) {
    const text = typeof j.error === 'string' && j.error ? j.error : `HTTP ${r.status}`;
    throw new AssistantApiError(r.status, j, text);
  }
  return j as T;
}

export function assistantGet<T = Record<string, unknown>>(
  path: string,
  query?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') params.set(k, v);
  const qs = params.toString();
  return call<T>('GET', qs ? `${path}?${qs}` : path, undefined, signal);
}

export function assistantPost<T = Record<string, unknown>>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return call<T>('POST', path, body, signal);
}

/** Runs `use` with this tab's live relay link (null without one); `avoid` is a link the server just refused. */
export type AssistantLinkSource = <T>(use: (link: string | null) => Promise<T>, avoid?: string | null) => Promise<T>;

let linkSource: AssistantLinkSource | null = null;

/** The page relay (src/assistant/relay.ts) hands out this tab's link from here once it runs; null again when it stops. */
export function setAssistantLinkSource(fn: AssistantLinkSource | null): void {
  linkSource = fn;
}

/**
 * POST from this window: the body carries this tab's live relay link (`link`), the proof the
 * server asks for beside the app's origin before a coding agent's Test, connect and sign-in, a
 * custom agent added and an allow switch turned on (403 launch_proof without it). Phase 4's
 * dock sends an agent turn's start through here too, from any page. A link the channel lost
 * between here and the server is refused: sent once more with the new one. Without the relay
 * (a test, another PC) the request goes without a link.
 */
export async function windowPost<T = Record<string, unknown>>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let refused: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let sentWith: string | null = null;
    const send = (link: string | null): Promise<T> => {
      sentWith = link;
      return assistantPost<T>(path, link ? { ...body, link } : body, signal);
    };
    try {
      return await (linkSource ? linkSource(send, refused) : send(null));
    } catch (err) {
      const stale = err instanceof AssistantApiError && err.status === 403 && err.code === 'launch_proof' && sentWith !== null;
      if (attempt > 0 || !stale) throw err;
      refused = sentWith;
    }
  }
}

/** A route this server doesn't have (its router's 404 carries no code). */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof AssistantApiError && err.status === 404 && err.code === 'http_404';
}

// ---------------------------------------------------------------- coding agents (phase 3 spec 4.9, 4.12, 4.13, 5.3)
//
// The rows, the Test's answer and the sign-in ways are read tolerantly: a field of the wrong
// type is left out (or read as "not known"), so an older or newer server never breaks the step.
// Ids and values stay as the server sent them (they go back exactly); names are shown as text.

export const AGENTS_PATH = '/api/assistant/agents';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);

function choices(v: unknown): ModeView[] | ModelView[] {
  if (!Array.isArray(v)) return [];
  const out: ModeView[] = [];
  for (const raw of v.slice(0, 200)) {
    if (!isObj(raw)) continue;
    const id = str(raw.id) ?? str(raw.modelId) ?? str(raw.value);
    if (!id) continue;
    out.push({ id, name: str(raw.name) || id, description: str(raw.description) ?? '' });
  }
  return out;
}

/**
 * One sign-in way as the server sent it: the terminal line as `command` (a string, or the
 * server's {line} object), else `line`; the variables as `vars` (or one `var`).
 */
function readSignInMethod(raw: unknown): SignInMethodView | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const type = oneOf(raw.type, ['terminal', 'agent', 'env_var'] as const, 'agent');
  const cmd = raw.command;
  const line = typeof cmd === 'string' ? cmd : isObj(cmd) ? str(cmd.line) : str(raw.line);
  const vars = [...strs(raw.vars, 16), ...(typeof raw.var === 'string' ? [raw.var] : [])];
  return { id, name: str(raw.name) || id, description: str(raw.description) ?? '', type, command: type === 'terminal' && line ? line : null, vars };
}

/** The sign-in ways from a row's `sign_in` ({methods} or a bare list) or a Test's `auth`. */
export function readSignInMethods(v: unknown): SignInMethodView[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.methods) ? v.methods : [];
  return list.slice(0, 32).map(readSignInMethod).filter((m): m is SignInMethodView => !!m);
}

/** A row of GET /api/assistant/agents (or of an action's answer), or null when it has no id or name. */
export function readAgentRow(raw: unknown): AgentRow | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const last = isObj(raw.last) ? { modes: choices(raw.last.modes), models: choices(raw.last.models), at: str(raw.last.at) ?? '' } : null;
  const signIn: SignInView | null = raw.sign_in == null ? null : { methods: readSignInMethods(raw.sign_in) };
  return {
    id,
    name,
    kind: raw.kind === 'custom' ? 'custom' : 'known',
    found: raw.found === true,
    install: str(raw.install),
    program: str(raw.program),
    script: str(raw.script),
    version: str(raw.version),
    verified_package: raw.verified_package === true,
    signed_in: oneOf(raw.signed_in, ['yes', 'key', 'no', 'unknown'] as const, 'unknown'),
    key_var: str(raw.key_var),
    lockdown: oneOf(raw.lockdown, ['tools_off', 'documented', 'none'] as const, 'none'),
    // Off only when the server says so: anything else is the honest "on".
    own_tools: raw.own_tools === 'off' ? 'off' : 'on',
    needs_allow: raw.needs_allow !== false,
    allowed: raw.allowed === true,
    allow_changed: raw.allow_changed === true,
    fingerprint: str(raw.fingerprint),
    model: str(raw.model),
    mode: str(raw.mode),
    allowed_modes: raw.allowed_modes === 'initial' ? 'initial' : Array.isArray(raw.allowed_modes) ? strs(raw.allowed_modes, 32) : null,
    last,
    sign_in: signIn,
    auth_word: raw.auth_word === 'none' || raw.auth_word === 'signed_in' || raw.auth_word === 'silent' ? raw.auth_word : null,
    ready: raw.ready === true,
    reason: str(raw.reason),
    error: str(raw.error),
  };
}

/** GET /api/assistant/agents (?refresh=1 asks every version again). Throws AssistantApiError. */
export async function listAgents(refresh: boolean, signal?: AbortSignal): Promise<AgentsAnswer> {
  const j = await assistantGet<Obj>(AGENTS_PATH, { refresh: refresh ? '1' : undefined }, signal);
  const rows = Array.isArray(j.agents) ? j.agents.map(readAgentRow).filter((r): r is AgentRow => !!r) : [];
  return { ok: true, checked_at: str(j.checked_at) ?? '', took_ms: typeof j.took_ms === 'number' ? j.took_ms : 0, agents: rows };
}

/** The row an action answered with ({ok, agent}), or on a refusal its body's (409 fingerprint_changed brings the new row). */
export function rowOfAnswer(body: unknown): AgentRow | null {
  return isObj(body) ? readAgentRow(body.agent) : null;
}

/** POST /api/assistant/agents/custom {name, command, keep_env, link} (windowPost): the new row. Throws AssistantApiError (400 with its field). */
export async function addCustomAgent(name: string, command: string, keepEnv: string[]): Promise<AgentRow | null> {
  return rowOfAnswer(await windowPost<Obj>(`${AGENTS_PATH}/custom`, { name, command, keep_env: keepEnv }));
}

/** POST /api/assistant/agents/custom/remove {id}. Throws AssistantApiError. */
export async function removeCustomAgent(id: string): Promise<void> {
  await assistantPost<Obj>(`${AGENTS_PATH}/custom/remove`, { id });
}

/**
 * POST /api/assistant/agents/allow {id, allow, fingerprint}: the allow switch (from this page
 * only: the browser sends its Origin, and on carries this tab's link). Answers the agent's row.
 * Throws AssistantApiError.
 */
export async function allowAgent(id: string, allow: boolean, fingerprint: string | null): Promise<AgentRow | null> {
  // On carries the window's proof (windowPost); off, the kill switch, needs none.
  return rowOfAnswer(allow ? await windowPost<Obj>(`${AGENTS_PATH}/allow`, { id, allow, fingerprint }) : await assistantPost<Obj>(`${AGENTS_PATH}/allow`, { id, allow }));
}

/** A Test or connect answer, read tolerantly. */
export function readAgentTest(j: unknown): AgentTestAnswer {
  const o = isObj(j) ? j : {};
  const auth = o.auth === undefined ? undefined : readSignInMethods(o.auth);
  if (o.ok !== true) {
    return { ok: false, code: str(o.code) ?? 'failed', error: str(o.error) || 'The check failed.', ...(auth ? { auth } : {}) };
  }
  return {
    ok: true,
    agent: str(o.agent) ?? '',
    version: str(o.version),
    ms: typeof o.ms === 'number' && Number.isFinite(o.ms) ? o.ms : 0,
    signed_in: oneOf(o.signed_in, ['yes', 'key', 'no', 'unknown'] as const, 'unknown'),
    auth_status: o.auth_status === 'none' || o.auth_status === 'signed_in' ? o.auth_status : null,
    own_tools: o.own_tools === 'off' ? 'off' : 'on',
    images: o.images === true,
    modes: choices(o.modes),
    models: choices(o.models),
    tools: o.tools === 'works' || o.tools === 'not_used' ? o.tools : null,
    ...(auth ? { auth } : {}),
  };
}

/**
 * POST /api/assistant/agents/test {id, message}: the Test (message: true) or the connect check
 * (false). A refusal with a code (409 busy, agent_not_allowed, ...) is answered as {ok: false};
 * a missing route, remote access or no answer throws (AssistantApiError), as does an abort.
 */
export async function checkAgent(id: string, message: boolean, signal?: AbortSignal): Promise<AgentTestAnswer> {
  try {
    return readAgentTest(await windowPost<Obj>(`${AGENTS_PATH}/test`, { id, message }, signal));
  } catch (err) {
    if (err instanceof AssistantApiError && !(err instanceof RemoteError) && err.status && !isMissingRoute(err)) return readAgentTest({ ...err.body, ok: false, error: err.message });
    throw err;
  }
}

/** POST /api/assistant/agents/sign-in {id, method}: the agent signs in by itself. Refusals as checkAgent's. */
export async function signInAgent(id: string, method: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  let j: Obj;
  try {
    j = await windowPost<Obj>(`${AGENTS_PATH}/sign-in`, { id, method }, signal);
  } catch (err) {
    if (err instanceof AssistantApiError && !(err instanceof RemoteError) && err.status && !isMissingRoute(err)) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
  return j.ok === true ? { ok: true } : { ok: false, code: str(j.code) ?? 'failed', error: str(j.error) || 'Signing in failed.' };
}
