/**
 * What the three adapters share: how a conversation is cut into requests (which old tool
 * results go without their content: clearedResults), the watchdog defaults, the options every
 * adapter is built with (providers/index.ts builds them), and the cloud adapters' fallback for
 * strict tools their provider can't compile.
 */
import { createHash } from 'node:crypto';
import { alog } from '../log.ts';
import { assistantState } from '../state.ts';
import type { ImagePart, Message, ProviderError, ProviderId, ProviderRequest, ProviderResult, ProviderTool, ToolResultPart, Usage, UserMessage, UserPart } from '../types.ts';
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
 * Which tool results a request sends whole: at least the newest `keep`, and the older ones
 * left out in jumps of `jump`, so what a request sends changes about once every `jump` results
 * (each change rewrites the prompt cache from the first result it leaves out).
 */
export const RESULT_WINDOW = Object.freeze({ keep: 12, jump: 24 });

/** What a left-out result says to the model. */
export const CLEARED_NOTE = 'An older result, no longer sent. Call a read tool to see the current state.';

/** A left-out result's text: the same bytes every time, so the requests after it share their prefix. */
export function clearedText(isError: boolean): string {
  return JSON.stringify({ ok: !isError, left_out: CLEARED_NOTE });
}

/**
 * How many of the oldest tool results a request of this conversation leaves out (B): none
 * while it has fewer than keep + jump; then the most whole jumps that leave at least `keep`,
 * and never a result the model has not answered yet (those after the last answer: the step
 * that just ran, however many calls it made). The messages are append-only, so B never goes down.
 */
export function clearedResults(messages: readonly Message[]): number {
  let total = 0;
  let answered = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      answered = total;
      continue;
    }
    for (const p of m.parts) if (p.type === 'tool_result') total += 1;
  }
  const { keep, jump } = RESULT_WINDOW;
  const room = Math.min(total - keep, answered);
  return room >= jump ? Math.floor(room / jump) * jump : 0;
}

/**
 * The messages as a request sends them: the same list, with the oldest `cleared` tool results
 * (in stored order) as a short note (clearedText) and no pictures. Nothing else changes, and a
 * message with no such result is the stored object itself. The stored messages stay as they are.
 */
export function sentMessages(messages: readonly Message[], cleared: number): Message[] {
  if (cleared <= 0) return [...messages];
  let left = cleared;
  return messages.map((m): Message => {
    if (left <= 0 || m.role !== 'user' || !m.parts.some((p) => p.type === 'tool_result')) return m;
    const parts = m.parts.map((p): UserPart => {
      if (p.type !== 'tool_result' || left <= 0) return p;
      left -= 1;
      return { ...p, text: clearedText(p.isError), images: [] };
    });
    return { role: 'user', parts };
  });
}

/**
 * The conversation as requests carry it: consecutive user messages merged into one, and
 * in each user message every tool result first, in call order, then text and images; the
 * oldest `cleared` tool results left out (sentMessages).
 * Stored messages are never changed (they are append-only); this builds a new list.
 */
export function requestMessages(messages: readonly Message[], cleared = 0): Message[] {
  const out: Message[] = [];
  for (const m of cleared > 0 ? sentMessages(messages, cleared) : messages) {
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

/** The note when a cloud request went with the workspace's tools not strict (CAD tools spec H8). */
export const STRICT_FALLBACK_NOTE = 'The cloud provider could not compile these tools strictly; they are sent unchecked by the provider; the app still checks every input.';

/** The longest part of the provider's words a note keeps. */
export const SAID_MAX = 600;

/** The note for a loose request: STRICT_FALLBACK_NOTE, and the provider's words when it gave any. */
export function strictFallbackNote(said: string): string {
  return said ? `${STRICT_FALLBACK_NOTE} The provider said: ${said}` : STRICT_FALLBACK_NOTE;
}

/** The reduced note's start (strictReducedNote), for telling a strict note from the adapter's others. */
export const STRICT_REDUCED_START = "The cloud provider can't check the inputs of all ";

/**
 * A note about how the conversation's tools go to the provider (reduced or loose): it stays
 * true for every later request, so the loop shows it once a conversation; the adapter's other
 * notes (pictures left out) are about one request and come once a turn.
 */
export function isStrictNote(text: string): boolean {
  return text.startsWith(STRICT_REDUCED_START) || text.startsWith(STRICT_FALLBACK_NOTE);
}

/**
 * What a strict note is shown once by: its kind, not its numbers. A later request's other tools
 * (a workspace opened) change the counts, and the person needs it once (seen live: twice).
 */
export function strictNoteKey(text: string): string {
  return text.startsWith(STRICT_REDUCED_START) ? STRICT_REDUCED_START : STRICT_FALLBACK_NOTE;
}

/**
 * The note for a request sent with fewer tools strict, in the person's words: the provider
 * checks only some of the tools' inputs itself, and the app checks the others (named, in the
 * order offered). The provider's own words go to the log (the warn line), not the note.
 */
export function strictReducedNote(count: number, of: number, unchecked: readonly string[]): string {
  return `${STRICT_REDUCED_START}${of} of Magnusim's tools at once, so Magnusim checks ${of - count} of them itself (${unchecked.join(', ')}). The Assistant can still use every tool.`;
}

/**
 * A strict refusal in these words says the strict set is too big (a grammar too large or too
 * complex, a compile that timed out, too many strict tools), not that one schema is wrong:
 * a smaller strict set may still compile.
 */
export const STRICT_SIZE_WORDS = /too (large|complex|many)|timed out|number of strict/i;

/** At most this many requests for one answer: the first, the smaller strict sets, and the loose one. */
export const STRICT_MAX_ATTEMPTS = 6;

/**
 * What the provider said about a tool set: `k` of its strict tools compiled (the smallest)
 * and `refused` of them did not, or (`k` null) only the loose request goes; with the
 * provider's words.
 */
interface StrictMemo {
  k: number | null;
  refused: number;
  said: string;
}

/**
 * Tool sets by boot id, dialect and the tools' hash: for the process (a test reset or a
 * server start forgets them).
 */
const MEMO = new Map<string, StrictMemo>();
const MEMO_MAX = 200;

function memoKey(dialect: ProviderId, tools: readonly ProviderTool[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(tools.map((t) => [t.name, t.description, t.schema, !!t.workspace])))
    .digest('hex');
  return [assistantState().bootId, dialect, hash].join(' ');
}

/**
 * Across tool sets, by boot id and dialect: the most strict schema bytes one request carried
 * that compiled (`ok`), and the fewest a too-big refusal refused (`refused`). A tool set seen
 * for the first time starts with as many of its smallest strict tools as fit under both, so
 * another place in the app (another tool set) doesn't pay a refused request, and its wait, to
 * learn what an earlier one did.
 */
interface SizeMemo {
  ok: number;
  refused: number;
}
const SIZE_MEMO = new Map<string, SizeMemo>();

function sizeKey(dialect: ProviderId): string {
  return `${assistantState().bootId} ${dialect}`;
}

function noteSize(dialect: ProviderId, bytes: number, accepted: boolean): void {
  const key = sizeKey(dialect);
  const boot = `${assistantState().bootId} `;
  for (const k of SIZE_MEMO.keys()) if (!k.startsWith(boot)) SIZE_MEMO.delete(k);
  const m = SIZE_MEMO.get(key) ?? { ok: 0, refused: Infinity };
  if (accepted) m.ok = Math.max(m.ok, bytes);
  else m.refused = Math.min(m.refused, bytes);
  SIZE_MEMO.set(key, m);
}

/**
 * How many of the smallest strict tools (`prefix`: their bytes summed, smallest first) a
 * request may start with after what `size` learned: once a set too big was refused, those
 * that fit in the most that compiled (else in fewer bytes than the fewest refused); at least
 * one. Nothing refused yet: all of them (what compiled says nothing about a bigger set).
 */
export function strictCountThatFits(prefix: readonly number[], size: { ok: number; refused: number } | undefined): number {
  if (!size || !prefix.length || size.refused === Infinity) return prefix.length;
  let k = 0;
  while (k < prefix.length && prefix[k] < size.refused && (size.ok === 0 || prefix[k] <= size.ok)) k++;
  return Math.max(1, k);
}

function remember(key: string, m: StrictMemo): void {
  const boot = `${assistantState().bootId} `;
  for (const k of MEMO.keys()) if (!k.startsWith(boot)) MEMO.delete(k);
  if (MEMO.size >= MEMO_MAX && !MEMO.has(key)) MEMO.clear();
  MEMO.set(key, m);
}

/**
 * A cloud provider refused the request's strict tool schemas, before anything streamed.
 * `said`: the provider's own words (errors.ts providerSaid: redacted and capped).
 */
export class StrictRefused extends Error {
  readonly mapped: ProviderError;
  readonly said: string;
  constructor(mapped: ProviderError, said = '') {
    super(mapped.message);
    this.mapped = mapped;
    this.said = said;
  }
}

/**
 * Why an attempt goes as it does: null (the first try); `strict_reduced` (fewer tools strict,
 * after a refusal just now), `strict_reduced_earlier` (the smaller set remembered);
 * `strict_refused` (the workspace's tools not strict, after a refusal just now),
 * `strict_refused_earlier` (a loose set remembered).
 */
export type StrictReason = 'strict_reduced' | 'strict_reduced_earlier' | 'strict_refused' | 'strict_refused_earlier' | null;

/** One attempt's tools: which go strict, by index of the request's tools. */
export interface StrictPlan {
  /** strict (the first try), reduced (the `count` smallest of the first try's strict tools), loose (the workspace's not strict). */
  kind: 'strict' | 'reduced' | 'loose';
  reason: StrictReason;
  strict: boolean[];
  /** How many tools go strict, of `of` the request offers. */
  count: number;
  of: number;
}

/** The request's tools as an adapter sends them. */
export interface StrictSets {
  /** The first try's strict tools (within the provider's own limits). */
  strict: readonly boolean[];
  /** The loose request's: the workspace's tools not strict. */
  loose: readonly boolean[];
  /** Each tool's schema as sent, in bytes. */
  bytes: readonly number[];
}

/** A schema's size as sent: its JSON's UTF-8 bytes. */
export function schemaBytes(schema: unknown): number {
  return Buffer.byteLength(JSON.stringify(schema ?? null), 'utf8');
}

/**
 * The strict count the next try sends after `hi` strict tools were refused, with `left` tries
 * still to go before the loose one: what is below `hi` split evenly by the tries left, the
 * largest first. An accepted try is the answer (and is billed), so the search only goes down;
 * with one try left it halves. Null: no try left, or nothing smaller to try.
 */
export function nextStrictCount(hi: number, left: number): number | null {
  if (left < 1 || hi < 2) return null;
  return Math.max(1, Math.floor((hi * left) / (left + 1)));
}

/**
 * The first try's strict tools, smallest schema first (ties in the order offered): a reduced
 * try keeps the first k of them strict.
 */
export function strictOrder(sets: StrictSets): number[] {
  return sets.strict
    .map((on, i) => (on ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => sets.bytes[a] - sets.bytes[b] || a - b);
}

/**
 * One cloud request whose strict tools the provider may refuse to compile (CAD tools spec
 * H8). `attempt(plan)` sends it with `plan.strict` and throws StrictRefused for that refusal
 * (before anything streamed: no output, and no step).
 * - Refused in words that say the set is too big (STRICT_SIZE_WORDS), it goes again with only
 *   the k smallest of the first try's strict tools strict (the host's counted like any
 *   other), k from nextStrictCount, lower after each refusal until one is accepted. In other
 *   words, or once STRICT_MAX_ATTEMPTS - 1 requests were refused, it goes loose
 *   (`sets.loose`: the workspace's tools not strict).
 * - The accepted k (with the smallest refused) is remembered for the tool set, and a loose set
 *   too, so a later request with it goes straight there (one warn line per refusal); a
 *   remembered k refused again searches below it.
 * - A reduced answer carries strictReducedNote, a loose one strictFallbackNote, each with the
 *   provider's words. A refused loose request is the error, and so is a refusal when no
 *   smaller strict set differs (no workspace tool strict, one strict tool or none).
 */
export async function sendStrictOrLoose(
  dialect: ProviderId,
  req: ProviderRequest,
  sets: StrictSets,
  attempt: (plan: StrictPlan) => Promise<ProviderResult>,
): Promise<ProviderResult> {
  const of = req.tools.length;
  const order = strictOrder(sets);
  const top = order.length;
  const canLoosen = sets.strict.some((on, i) => on && !sets.loose[i]);
  const canReduce = top >= 2;
  const plan = (kind: StrictPlan['kind'], reason: StrictReason, k = 0): StrictPlan => {
    let strict: boolean[];
    if (kind === 'strict') strict = [...sets.strict];
    else if (kind === 'loose') strict = [...sets.loose];
    else {
      const keep = new Set(order.slice(0, k));
      strict = sets.strict.map((_, i) => keep.has(i));
    }
    return { kind, reason, strict, count: strict.filter(Boolean).length, of };
  };
  // Every reduced or loose answer carries its note; the loop shows a strict note once a
  // conversation (isStrictNote, loop.ts), so the person reads it once, and a new conversation
  // (the evaluation's probe, a test) still hears how its tools went.
  const noted = (r: ProviderResult, p: StrictPlan, said: string): ProviderResult => {
    if (p.kind === 'strict') return r;
    const unchecked = req.tools.filter((_, i) => !p.strict[i]).map((t) => t.name);
    const note = p.kind === 'loose' ? strictFallbackNote(said) : strictReducedNote(p.count, of, unchecked);
    return { ...r, notes: [...(r.notes ?? []), note] };
  };
  const bytesOf = (p: StrictPlan) => p.strict.reduce((n, on, i) => (on ? n + sets.bytes[i] : n), 0);
  const prefix: number[] = [];
  for (const i of order) prefix.push((prefix.length ? prefix[prefix.length - 1] : 0) + sets.bytes[i]);
  const key = canLoosen || canReduce ? memoKey(dialect, req.tools) : '';
  const memo = key ? MEMO.get(key) : undefined;
  let hi = memo ? memo.refused : top;
  let said = memo?.said ?? '';
  let p: StrictPlan;
  if (!memo) {
    // A tool set seen for the first time starts within what another set learned (SIZE_MEMO).
    const fits = canReduce ? strictCountThatFits(prefix, SIZE_MEMO.get(sizeKey(dialect))) : top;
    p = fits < top ? plan('reduced', 'strict_reduced_earlier', fits) : plan('strict', null);
  } else if (memo.k === null) p = plan('loose', 'strict_refused_earlier');
  else p = plan('reduced', 'strict_reduced_earlier', memo.k);
  for (let tries = 1; ; tries++) {
    try {
      const r = await attempt(p);
      if (p.kind !== 'loose' && p.count > 0) noteSize(dialect, bytesOf(p), true);
      if (p.kind === 'reduced' && (p.reason === 'strict_reduced' || !memo)) remember(key, { k: p.count, refused: hi, said });
      return noted(r, p, said);
    } catch (err) {
      if (!(err instanceof StrictRefused)) throw err;
      if (p.kind === 'loose' || !key) throw err.mapped;
      said = err.said;
      hi = p.kind === 'strict' ? top : p.count;
      if (STRICT_SIZE_WORDS.test(err.said)) noteSize(dialect, bytesOf(p), false);
      const k = canReduce && STRICT_SIZE_WORDS.test(err.said) ? nextStrictCount(hi, STRICT_MAX_ATTEMPTS - tries - 1) : null;
      if (k !== null) {
        alog('warn', 'the provider refused the strict tools; sending them again with fewer strict', { provider: dialect, refused: hi, strict: k, said });
        p = plan('reduced', 'strict_reduced', k);
        continue;
      }
      if (!canLoosen) throw err.mapped;
      alog('warn', 'the provider refused the strict tools; sending them again unchecked by the provider', { provider: dialect, said });
      remember(key, { k: null, refused: hi, said });
      p = plan('loose', 'strict_refused');
    }
  }
}
