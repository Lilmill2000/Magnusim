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

// ---------------------------------------------------------------- the project list (core host tools spec §9.3)
// The `projects` tool sends every project's title, folder and dates. It is asked about once per
// destination, remembered in `consents` under a reserved key (no project id holds a `*`), and
// "Forget project answers" clears it with the rest. A local, on-PC model is never asked.

/** The reserved consent key of the project list. */
export const LIST_CONSENT_KEY = '*projects';

/** Whether a "project" a tool names (projectOf) is the project list. */
export function isProjectList(projectId: string | null): boolean {
  return projectId === LIST_CONSENT_KEY;
}

/** The project list's question for the Assistant's own provider. */
export function projectListGate(o: { turn: string; provider: ProviderId; host: string }): GateRequest {
  const where =
    o.provider === 'openai_compatible'
      ? `${o.host}, a server that isn't on this PC. A server on this PC keeps them here.`
      : `${o.host}, a cloud provider. A local server keeps them on this PC.`;
  return {
    kind: 'privacy',
    turn: o.turn,
    title: 'Let the Assistant read your project list?',
    copy: `The Assistant is about to send the names, folders and dates of all your projects to ${where} Settings → Assistant can change this.`,
    yes: 'Send',
    no: "Don't send",
  };
}

/** The project list's question for other apps on this PC (one answer for every app). */
export function mcpProjectListGate(o: { client: string }): GateRequest {
  return {
    kind: 'privacy',
    turn: null,
    title: 'Let other apps read your project list?',
    copy: `${mcpAppText(o.client)} is about to read the names, folders and dates of all your projects. It may send them to its own AI service. This answer covers every app using Magnusim's tools. Settings → Assistant can change this.`,
    yes: 'Allow',
    no: "Don't allow",
  };
}

/** The project list's question for a coding agent: answered only in the Magnusim window. */
export function agentProjectListGate(o: { turn: string; name: string }): GateRequest {
  const name = cleanText(o.name, 64).replace(QUOTES, "'") || 'the coding agent';
  return {
    kind: 'privacy',
    turn: o.turn,
    title: `Send your project list to ${name}?`,
    copy: `The Assistant's coding agent, ${name}, is about to read the names, folders and dates of all your projects and send them to its own service under your account. Settings → Assistant can change this.`,
    yes: 'Send',
    no: "Don't send",
    link_only: true,
  };
}

/**
 * A call refused because the person chose not to send another project, or the project list (the
 * turn goes on). It names the project by the id the call gave, never its title: the title is
 * that project's data, which the person just chose not to send.
 */
export function privacyDeclinedText(projectId: string | null): string {
  return projectId === null ? 'The person chose not to send the project list.' : `The person chose not to send project ${cleanText(projectId, 128)}.`;
}

// ---------------------------------------------------------------- coding agents
// A coding agent counts as off this PC: it sends what it reads to its own service under the
// person's account (phase 3 spec 4.14). Its destination is `agent:<id>` (providers/index.ts
// destinationOf), so a consent for one agent never covers another.

/** "Never send" with a project in the turn: refused at the start. */
export function agentPrivacyDeniedText(name: string): string {
  const who = cleanText(name, 64) || 'The coding agent';
  return `Settings → Assistant is set to never send project data off this PC, and ${who} sends what it reads to its own service. Ask from Home, use a local server, or change the setting.`;
}

/** "Never send" and an agent whose own tools are on: refused at the start, even from Home. */
export function agentOwnToolsDeniedText(name: string): string {
  const who = cleanText(name, 64) || 'The coding agent';
  return `${who} can read your project files with its own tools, and Settings → Assistant is set to never send project data off this PC.`;
}

/**
 * The question before a coding agent reads a project's data (spec 5.7). Answered only in the
 * Magnusim window that shows it (link_only): the agent, or a program on this PC, could
 * otherwise answer it with the turn's answer key.
 */
export function agentPrivacyGate(o: { turn: string; project: ProjectInfo; name: string }): GateRequest {
  const title = quotedTitle(o.project.title, o.project.id);
  const name = cleanText(o.name, 64).replace(QUOTES, "'") || 'the coding agent';
  return {
    kind: 'privacy',
    turn: o.turn,
    title: `Send project "${title}" to ${name}?`,
    copy: `The Assistant's coding agent, ${name}, is about to read this project's names, settings, results and pictures of the open workspace and send them to its own service under your account. Settings → Assistant can change this.`,
    yes: 'Send',
    no: "Don't send",
    project: { id: o.project.id, title },
    link_only: true,
  };
}

// ---------------------------------------------------------------- other apps (MCP)

/**
 * Other apps on this PC (MCP clients) count as off-PC: Magnusim can't know where a client
 * sends what it reads (phase 3 spec 3.6). They share one destination, so one answer covers
 * every app using Magnusim's tools, and the question says so.
 */
export const MCP_DESTINATION = 'mcp';
export const MCP_PRIVACY_DENIED_TEXT =
  "Settings → Assistant is set to never send project data off this PC. Other apps (MCP) can't read this project.";

/**
 * Who asks, in an app's questions: `client` is the name the app gives itself (self-declared,
 * cleaned and quoted like a title); without one the words leave it out.
 */
export function mcpAppText(client: string): string {
  const name = cleanText(client, 64).replace(QUOTES, "'");
  return name ? `An app on this PC using Magnusim's tools ("${name}", as it calls itself)` : "An app on this PC using Magnusim's tools";
}

/** The question before an app on this PC reads a project's data. */
export function mcpPrivacyGate(o: { project: ProjectInfo; client: string }): GateRequest {
  const title = quotedTitle(o.project.title, o.project.id);
  const who = mcpAppText(o.client);
  return {
    kind: 'privacy',
    turn: null,
    title: `Let other apps read project "${title}"?`,
    copy: `${who} is about to read this project's names, settings, results and pictures of the open workspace. It may send them to its own AI service. This answer covers every app using Magnusim's tools. Settings → Assistant can change this.`,
    yes: 'Allow',
    no: "Don't allow",
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
