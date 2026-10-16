/**
 * What the three adapters share: how a conversation is cut into requests, the watchdog
 * defaults, and the options every adapter is built with (providers/index.ts builds them).
 */
import type { ImagePart, Message, ToolResultPart, Usage, UserMessage, UserPart } from '../types.ts';
import { Watchdog, type WatchdogOptions } from './guarded-fetch.ts';

/** The SDK's whole-request limit; the watchdog ends a stalled one long before. */
export const SDK_TIMEOUT_MS = 600_000;

export const CLOUD_WATCHDOG: WatchdogOptions = Object.freeze({ firstByteMs: 120_000, idleMs: 180_000 });
export const LOCAL_WATCHDOG: WatchdogOptions = Object.freeze({ firstByteMs: 290_000, idleMs: 180_000 });

export interface AdapterOptions {
  /**
   * Lends the provider key for one request (secrets/store.ts withKey, through
   * providers/index.ts only). The local server's token may be null.
   */
  borrowKey<T>(use: (key: string | null) => Promise<T>): Promise<T>;
  baseURL: string;
  /** Tests: shorter watchdog waits. */
  watchdog?: WatchdogOptions;
  /** Where the SDKs' custom-header variables are read from (process.env). */
  env?: NodeJS.ProcessEnv;
}

export function newWatchdog(o: AdapterOptions, local: boolean): Watchdog {
  return new Watchdog(o.watchdog ?? (local ? LOCAL_WATCHDOG : CLOUD_WATCHDOG));
}

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, complete: false };
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
export { n as tokenCount };

/**
 * The conversation as requests carry it: consecutive user messages merged into one, and
 * in each user message every tool result first, in call order, then text and images.
 * Stored messages are never changed (they are append-only); this builds a new list.
 */
export function requestMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === 'user' && last && last.role === 'user') {
      out[out.length - 1] = { role: 'user', parts: [...last.parts, ...m.parts] };
    } else {
      out.push(m.role === 'user' ? { role: 'user', parts: [...m.parts] } : m);
    }
  }
  return out.map((m) => (m.role === 'user' ? orderUserParts(m) : m));
}

function orderUserParts(m: UserMessage): UserMessage {
  const results = m.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
  const rest = m.parts.filter((p): p is Exclude<UserPart, ToolResultPart> => p.type !== 'tool_result' && !(p.type === 'text' && !p.text));
  return { role: 'user', parts: [...results, ...rest] };
}

export function dataUrl(img: ImagePart): string {
  return `data:${img.mediaType};base64,${img.base64}`;
}

/** Text a local model wrote instead of calling a tool: a tool-call wrapper, or JSON naming one of the tools. */
export function looksLikeToolCallText(text: string, toolNames: readonly string[]): boolean {
  if (!text) return false;
  if (/<\/?tool_call>|<\|tool_call|\[TOOL_CALLS\]|<function=/i.test(text)) return true;
  if (!/"(name|function)"\s*:/.test(text)) return false;
  return toolNames.some((name) => text.includes(`"${name}"`));
}

/** JSON text parsed as a tool's input: an object, else the reason it is not one. */
export function parseToolInput(raw: string): { input: Record<string, unknown>; error?: string } {
  const text = raw.trim();
  if (!text) return { input: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { input: v as Record<string, unknown> };
    return { input: {}, error: 'The tool input was not a JSON object.' };
  } catch {
    return { input: {}, error: 'The tool input was not valid JSON.' };
  }
}
