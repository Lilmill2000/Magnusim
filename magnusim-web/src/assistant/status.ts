/**
 * The Assistant's status as the page knows it (Foundation spec 4.4): one module store,
 * read with useSyncExternalStore, that Settings → Assistant renders and changes. A publish
 * replaces the snapshot.
 *
 * Answers can come back in any order, and a step can unmount and mount again while a save
 * is on its way (the save outlives the component that started it). So:
 * - every request takes the next sequence number;
 * - a change's answer (each POST answers with the whole status) applies when it is newer
 *   than the answer shown; an older one is not shown, and the status is read again once the
 *   last change has settled (the newer answer may predate the older change on the server);
 * - a read's answer is dropped while any change is in flight (it may predate the change),
 *   and the status is read again once the last change has settled;
 * - so is a read sent while a change was in flight that answers after it settled: the
 *   server may have read the status before the change landed. It is read again at once.
 *
 * The store never holds a key: the key routes take one in their body and answer the
 * status, which shows only whether a key is set and its last 4 characters.
 */
import { useSyncExternalStore } from 'react';
import { AssistantApiError, assistantGet, assistantPost, listAgents, RemoteError, REMOTE_TEXT } from './api';
import type { AgentCaps, AgentProviderId, AssistantStatus, ProviderReady } from './wire';

export type StatusSnapshot =
  | { state: 'loading' }
  | { state: 'remote'; message: string }
  | { state: 'ready'; status: AssistantStatus }
  | { state: 'error'; message: string };

export type WriteResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: AssistantApiError };

const STATUS_PATH = '/api/assistant/status';

let snap: StatusSnapshot = { state: 'loading' };
let issued = 0;
let applied = 0;
let writesInFlight = 0;
let refetchAfterWrites = false;
const listeners = new Set<() => void>();

function publish(next: StatusSnapshot): void {
  snap = next;
  for (const fn of [...listeners]) fn();
}

/** The status part of an answer (a key save adds `warning`, which belongs to that save only). */
function readyFrom(body: Record<string, unknown>): StatusSnapshot {
  const status = { ...body } as Record<string, unknown>;
  delete status.warning;
  return { state: 'ready', status: status as unknown as AssistantStatus };
}

function asApiError(err: unknown): AssistantApiError {
  if (err instanceof AssistantApiError) return err;
  return new AssistantApiError(0, {}, err instanceof Error ? err.message : String(err));
}

export function statusSnapshot(): StatusSnapshot {
  return snap;
}

export function subscribeStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useAssistantStatus(): StatusSnapshot {
  return useSyncExternalStore(subscribeStatus, statusSnapshot, statusSnapshot);
}

/** Reads the status again. Its answer is dropped when a change was sent meanwhile. */
export async function refreshStatus(): Promise<void> {
  const seq = ++issued;
  const sentDuringWrite = writesInFlight > 0;
  let next: StatusSnapshot;
  try {
    next = readyFrom(await assistantGet<Record<string, unknown>>(STATUS_PATH));
  } catch (err) {
    const e = asApiError(err);
    next = e instanceof RemoteError ? { state: 'remote', message: REMOTE_TEXT } : { state: 'error', message: e.message };
  }
  if (writesInFlight > 0) {
    refetchAfterWrites = true;
    return;
  }
  if (seq <= applied) return;
  if (sentDuringWrite) {
    void refreshStatus();
    return;
  }
  applied = seq;
  publish(next);
}

let agentsAsked = false;

/**
 * Looks for the coding agents once a page when the status has never had them: the server
 * looks only when asked (Settings → Assistant, or a turn's start), so after the app started
 * the dock's picker could not offer Claude Code until Settings had been opened (seen live).
 * A refusal (another PC's window may not ask) leaves it to the next opening.
 */
export async function listAgentsOnce(): Promise<void> {
  if (agentsAsked || snap.state !== 'ready' || snap.status.agents_checked_at) return;
  agentsAsked = true;
  try {
    await listAgents(false);
  } catch {
    agentsAsked = false;
    return;
  }
  await refreshStatus();
}

/** Shows "loading" and reads the status again (Retry). */
export function retryStatus(): Promise<void> {
  publish({ state: 'loading' });
  return refreshStatus();
}

/**
 * POSTs a change whose answer is the whole status, and shows that answer unless a newer
 * one is already shown. A refusal leaves the status as it is (and reads it again once
 * nothing else is in flight); the caller shows the refusal where it belongs.
 */
export async function writeStatus(path: string, body: unknown): Promise<WriteResult> {
  const seq = ++issued;
  writesInFlight += 1;
  try {
    const answer = await assistantPost<Record<string, unknown>>(path, body);
    if (seq > applied) {
      applied = seq;
      publish(readyFrom(answer));
    } else {
      // A newer change answered first, maybe from before this one landed (a key save
      // waits for the key to be encrypted): read the status again once nothing is in flight.
      refetchAfterWrites = true;
    }
    return { ok: true, body: answer };
  } catch (err) {
    const e = asApiError(err);
    if (e instanceof RemoteError) {
      if (seq > applied) {
        applied = seq;
        publish({ state: 'remote', message: REMOTE_TEXT });
      }
    } else {
      refetchAfterWrites = true;
    }
    return { ok: false, error: e };
  } finally {
    writesInFlight -= 1;
    if (writesInFlight === 0 && refetchAfterWrites) {
      refetchAfterWrites = false;
      void refreshStatus();
    }
  }
}

// ---------------------------------------------------------------- each provider's readiness

const KINDS: ReadonlySet<unknown> = new Set(['key', 'server', 'agent']);
const BILLING: ReadonlySet<unknown> = new Set(['usd', 'free', 'agent_account']);

/**
 * A provider's readiness as the status says it (its row of `providers_ready`, each field
 * checked), or null when the status has no row for it. A server older than per-provider
 * readiness says it only for the default (`ready`, `ready_reason`), with no line to show.
 */
export function providerReady(status: AssistantStatus, id: string): ProviderReady | null {
  const rows = status.providers_ready;
  if (rows && typeof rows === 'object') {
    const r = Object.hasOwn(rows, id) ? (rows[id] as Partial<ProviderReady> | undefined) : undefined;
    if (!r || typeof r !== 'object') return null;
    const kind = KINDS.has(r.kind) ? (r.kind as ProviderReady['kind']) : 'key';
    return {
      label: typeof r.label === 'string' && r.label ? r.label : id,
      kind,
      ready: r.ready === true,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : null,
      billing: BILLING.has(r.billing) ? (r.billing as ProviderReady['billing']) : 'usd',
      detail: typeof r.detail === 'string' ? r.detail : '',
      // A coding agent's word on pictures (a server older than it says nothing: not known).
      ...(kind === 'agent' ? { images: typeof r.images === 'boolean' ? r.images : null } : {}),
    };
  }
  if (id !== status.provider || typeof status.ready !== 'boolean') return null;
  const server = id === 'openai_compatible';
  return { label: id, kind: server ? 'server' : 'key', ready: status.ready, reason: status.ready_reason ?? null, billing: server ? 'free' : 'usd', detail: '' };
}

// ---------------------------------------------------------------- coding agents

const AGENT_PROVIDER_RE = /^agent:[a-z][a-z0-9-]{0,39}$/;

/** Whether a provider is a coding agent (`agent:<id>`). */
export function isAgentProvider(p: unknown): p is AgentProviderId {
  return typeof p === 'string' && AGENT_PROVIDER_RE.test(p);
}

/** A coding agent the Default choice offers (phase 3 spec 5.6). */
export interface AgentChoice {
  id: AgentProviderId;
  name: string;
  ready: boolean;
  detail: string;
}

/**
 * The coding agents the Default choice offers: each `agent:<id>` row of `providers_ready`
 * (every found known agent and every custom agent, after the agents were looked for), in the
 * server's order. The saved default is always among them: the server sends a row for it when
 * it isn't found now (its name, and why it can't run); a server that sends none gets it by id.
 */
export function agentChoices(status: AssistantStatus): AgentChoice[] {
  const out: AgentChoice[] = [];
  const rows = status.providers_ready;
  if (rows && typeof rows === 'object') {
    for (const id of Object.keys(rows)) {
      if (!isAgentProvider(id)) continue;
      const r = providerReady(status, id);
      if (r && r.kind === 'agent') out.push({ id, name: r.label === id ? id.slice('agent:'.length) : r.label, ready: r.ready, detail: r.detail });
    }
  }
  const saved = status.provider;
  if (isAgentProvider(saved) && !out.some((c) => c.id === saved)) out.push({ id: saved, name: saved.slice('agent:'.length), ready: false, detail: '' });
  return out;
}

const AGENT_CAP_KEYS: ReadonlyArray<keyof AgentCaps> = ['changes', 'calls', 'turn_minutes'];

/** The limits for agent turns as the status says them, or null when it has none (an older server). */
export function agentCapsOf(status: AssistantStatus): AgentCaps | null {
  const c = (status as { agent_caps?: unknown }).agent_caps;
  if (!c || typeof c !== 'object') return null;
  const caps = c as Record<string, unknown>;
  if (!AGENT_CAP_KEYS.every((k) => typeof caps[k] === 'number' && Number.isFinite(caps[k]))) return null;
  return { changes: caps.changes as number, calls: caps.calls as number, turn_minutes: caps.turn_minutes as number };
}

// ---------------------------------------------------------------- leaving the step

/**
 * The step's changes on their way (each true once saved, false when refused or saved with a
 * warning) and the fields holding what they haven't sent (a pasted key). The wizard settles
 * the step before it leaves it (src/wizard/controller.ts): what a field holds is sent and
 * every change waited for, so a refusal or a warning shows under its field instead of
 * reaching a step that is gone.
 */
const changes = new Set<Promise<boolean>>();
const holders = new Set<() => void>();

/** Counts `change` (true once saved) among the step's changes on their way. */
export function stepChange(change: Promise<boolean>): Promise<boolean> {
  const tracked = change.then(
    (ok) => ok,
    () => false,
  );
  changes.add(tracked);
  void tracked.then(() => changes.delete(tracked));
  return tracked;
}

/** A field that holds what it hasn't sent: `send` sends it when the step is left. */
export function stepHolder(send: () => void): () => void {
  holders.add(send);
  return () => {
    holders.delete(send);
  };
}

/**
 * Before the step is left: sends what its fields hold, then waits for every change on its
 * way. `true` at once when there is none (the wizard moves on in the same click), else
 * whether every one was saved.
 */
export function settleStep(): true | Promise<boolean> {
  for (const send of [...holders]) send();
  if (!changes.size) return true;
  return (async () => {
    let ok = true;
    // A change can start while another is waited for (a question's answer saves again).
    while (changes.size) {
      if ((await Promise.all([...changes])).includes(false)) ok = false;
    }
    return ok;
  })();
}

/** Tests only: forget everything (a fresh page). */
export function resetStatusStore(): void {
  snap = { state: 'loading' };
  issued = 0;
  applied = 0;
  writesInFlight = 0;
  refetchAfterWrites = false;
  agentsAsked = false;
  changes.clear();
  holders.clear();
}
