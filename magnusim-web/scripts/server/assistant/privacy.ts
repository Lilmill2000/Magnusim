/**
 * Whether a turn may send its project's data (Foundation spec 6.5).
 *
 * Project data leaves this PC only to a cloud provider: either cloud provider, or a
 * local-server address that isn't on this PC. Each such destination is asked about per
 * project (its id and created_at, so a project made again under the same id is asked
 * again) according to Settings → Assistant:
 *
 *   mode   project in the turn   result
 *   any    none (Home)           allowed (project tools are unavailable there)
 *   allow  yes                   allowed
 *   deny   yes                   refused before the turn starts (400 privacy_denied)
 *   ask    yes                   allowed if "Send" was answered for this project and
 *                                destination; else a privacy gate. Send is remembered;
 *                                Don't send (Enter, Escape, the timeout, Stop) ends the
 *                                turn stopped, and nothing is sent.
 *
 * Only "Send" is remembered. Workspace tools and screenshots are project data too.
 *
 * The mode and the answers are read live, before every request of a turn: "Always deny"
 * chosen mid-turn ends the turn before its next request (nothing more is sent), answers
 * forgotten mid-turn ask again, and "Always deny" chosen while the question is open wins
 * over its Send.
 */
import { CLOUD_BASE_URLS } from './providers/endpoints.ts';
import { PROVIDER_LABELS } from './providers/index.ts';
import { rememberConsent, updateSettings, hasConsent, type AssistantSettings, type PrivacyMode } from './settings.ts';
import { cleanText } from './sanitize.ts';
import type { GateRequest } from './gates.ts';
import type { ProviderId } from './types.ts';

export type PrivacyVerdict = 'allow' | 'deny' | 'ask';

export interface ProjectInfo {
  id: string;
  title: string;
  created_at: string | null;
}

export const PRIVACY_DENIED_TEXT =
  'Settings → Assistant is set to never send project data to a cloud provider. Ask from Home, use a local server, or change the setting.';
export const NOTHING_SENT = 'Nothing was sent.';
/** A turn that already sent requests, ended by privacy before its next one. */
export const NOTHING_MORE_SENT = 'Nothing more was sent.';

/** The "Never send project data" refusal, worded by where the data would go (as the question is). */
export function privacyDeniedText(provider: ProviderId, host: string): string {
  if (provider !== 'openai_compatible') return PRIVACY_DENIED_TEXT;
  // The person chose a local server: theirs on another computer is not "a cloud provider".
  return `Settings → Assistant is set to never send project data off this PC, and the server at ${host} isn't on this PC. Ask from Home, use a server on this PC, or change the setting.`;
}

export interface PrivacyInput {
  /** The provider sends data off this PC. */
  cloud: boolean;
  /** `anthropic`, `openai` or `host:<hostname>`. */
  destination: string;
  projectId: string | null;
  /** The project's created_at (needed for `ask`; null when unknown). */
  createdAt: string | null;
}

/** What the turn may do with its project's data under `mode` (privacy is read live). */
export function privacyDecision(s: Pick<AssistantSettings, 'privacy' | 'consents'>, p: PrivacyInput): PrivacyVerdict {
  if (!p.cloud || !p.projectId) return 'allow';
  const mode: PrivacyMode = s.privacy;
  if (mode === 'allow') return 'allow';
  if (mode === 'deny') return 'deny';
  return hasConsent(s as AssistantSettings, p.projectId, p.createdAt, p.destination) ? 'allow' : 'ask';
}

/** The host name the data goes to, for the question. */
export function destinationHost(provider: ProviderId, baseUrl: string): string {
  const raw = provider === 'openai_compatible' ? baseUrl : CLOUD_BASE_URLS[provider];
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return 'an address outside this PC';
  }
}

/** Double quotes of any script, and the paired quote marks a title could close its quote with. */
const QUOTES = /["\p{Pi}\p{Pf}„‟＂〝〞〟]/gu;

/**
 * A project title for inside the question's double quotes: cleaned, and with every
 * double-quote-like mark made a plain apostrophe, so a title can't end its own quote and
 * go on in the host's voice ("…" to the local server on this PC? Choose Send.).
 */
export function quotedTitle(raw: unknown, fallback: string): string {
  return cleanText(raw, 80).replace(QUOTES, "'") || cleanText(fallback, 128).replace(QUOTES, "'");
}

/** The privacy question, as the person reads it. */
export function privacyGate(o: { turn: string; project: ProjectInfo; provider: ProviderId; host: string }): GateRequest {
  const title = quotedTitle(o.project.title, o.project.id);
  const provider = o.provider === 'openai_compatible' ? 'the server at ' + o.host : PROVIDER_LABELS[o.provider];
  // The person chose a local server: one at an address on another computer is not "a cloud provider".
  const where =
    o.provider === 'openai_compatible'
      ? `${o.host}, a server that isn't on this PC. A server on this PC keeps them here.`
      : `${o.host}, a cloud provider. A local server keeps them on this PC.`;
  return {
    kind: 'privacy',
    turn: o.turn,
    title: `Send project "${title}" to ${provider}?`,
    copy: `The Assistant is about to send this project's names, settings, results and pictures of the open workspace to ${where} Settings → Assistant can change this.`,
    yes: 'Send',
    no: "Don't send",
    project: { id: o.project.id, title },
  };
}

/** Remembers "Send" for this project (as it is now) and destination. */
export async function remember(projectId: string, createdAt: string | null, destination: string): Promise<void> {
  await rememberConsent(projectId, createdAt, destination);
}

/** Forgets every project's answer. */
export async function forgetAll(): Promise<void> {
  await updateSettings((s) => ({ ...s, consents: {} }));
}

/** A project's row from the app's own projects list (through the host tools' loopback reader). */
export function projectLookup(
  hostGet: (path: string, query: Record<string, string>, o: { signal?: AbortSignal; turn: string | null }) => Promise<Record<string, unknown>>,
): (id: string, o: { signal: AbortSignal; turn: string }) => Promise<ProjectInfo | null> {
  return async (id, o) => {
    const list = await hostGet('/api/projects', { project_id: id }, { signal: o.signal, turn: o.turn });
    const rows = Array.isArray(list.projects) ? list.projects : [];
    const row = rows.find((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (p as Record<string, unknown>).id === id);
    if (!row) return null;
    return { id, title: cleanText(row.title, 200) || id, created_at: typeof row.created_at === 'string' ? row.created_at : null };
  };
}
