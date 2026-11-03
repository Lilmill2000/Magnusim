/**
 * What the cloud models cost (Foundation spec 5.7), in USD per million tokens, and the
 * spend estimate made before each request.
 *
 * Each row was read from its provider's pricing page on PRICES_AS_OF (the URL is beside
 * the row). A node test pins every row, so a price change is a reviewed edit with a new
 * date. A model this table doesn't know is charged at its provider's dearest prices and
 * marked estimated; a local server costs nothing.
 *
 * Two kinds of cache write are priced: `write5m` (the first provider's 5-minute entries;
 * the second provider's only kind, its 30-minute entries) and `write1h` (the first
 * provider's 1-hour entries; the second provider has none, so it repeats write5m).
 *
 * A row's `context` is the model's context window in tokens, from the provider's model
 * reference (null where nobody read it): contextWindow() takes the provider's own models list
 * first (Anthropic's max_input_tokens), then the row, else a safe 200K.
 */
import { assistantState } from './state.ts';
import type { Attempt, ProviderId, Usage } from './types.ts';

export const PRICES_AS_OF = '2026-10-16';

export interface Rates {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

export interface PriceRow extends Rates {
  model: string;
  provider: 'anthropic' | 'openai';
  label: string;
  /** The model's context window in tokens (its provider's model reference), or null where not read. */
  context: number | null;
  /** Prompts (all input tokens of one request) above `above` tokens pay these instead. */
  long: (Rates & { above: number }) | null;
  /** Shown in Settings' model list (fallback targets are not). */
  picker: boolean;
}

const ANTHROPIC_PRICES = 'https://platform.claude.com/docs/en/about-claude/pricing';
/**
 * The 1M-token context of the Anthropic rows: "Context window sizes by model" on
 * https://platform.claude.com/docs/en/build-with-claude/context-windows (read 2026-11-02),
 * Opus 5.5, Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5 and Haiku 5.5 alike.
 */
const ONE_MILLION = 1_000_000;
const OPENAI_PRICES = 'https://developers.openai.com/api/docs/pricing';

function row(
  provider: 'anthropic' | 'openai',
  model: string,
  label: string,
  [input, write5m, write1h, read, output]: [number, number, number, number, number],
  o: { picker?: boolean; long?: [number, number, number, number, number, number]; context?: number } = {},
): PriceRow {
  const l = o.long;
  return Object.freeze({
    provider,
    model,
    label,
    context: o.context ?? null,
    input,
    write5m,
    write1h,
    read,
    output,
    long: l ? Object.freeze({ above: l[0], input: l[1], write5m: l[2], write1h: l[3], read: l[4], output: l[5] }) : null,
    picker: o.picker ?? true,
  });
}

/** [input, 5 m write, 1 h write, cache read, output]; long: [above, input, 5 m, 1 h, read, output]. */
export const PRICES: readonly PriceRow[] = Object.freeze([
  // ANTHROPIC_PRICES, read 2026-10-16. Cache reads are 0.05x input on this model.
  row('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', [4, 5, 8, 0.2, 20], { context: ONE_MILLION }),
  // ANTHROPIC_PRICES, read 2026-10-16. Cache reads $0.10 (0.05x input), not the $0.20 of the plan.
  // Read again 2026-10-29: still $0.10 there ("0.05x the base input price"); the pricing page is
  // what is billed.
  row('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', [2, 2.5, 4, 0.1, 10], { context: ONE_MILLION }),
  // ANTHROPIC_PRICES, read 2026-10-16: prompts over 100,000 tokens pay the second row.
  row('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', [0.1, 0.125, 0.2, 0.01, 0.5], { long: [100_000, 0.5, 0.625, 1, 0.05, 2.5], context: ONE_MILLION }),
  // ANTHROPIC_PRICES, read 2026-10-16. A refusal fallback target only (not in the picker).
  row('anthropic', 'claude-opus-5', 'Claude Opus 5', [5, 6.25, 10, 0.5, 25], { picker: false, context: ONE_MILLION }),
  // ANTHROPIC_PRICES, read 2026-10-16. A refusal fallback target only.
  row('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', [5, 6.25, 10, 0.5, 25], { picker: false, context: ONE_MILLION }),
  // ANTHROPIC_PRICES, read 2026-10-16. A refusal fallback target only.
  row('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', [2, 2.5, 4, 0.2, 10], { picker: false, context: ONE_MILLION }),
  // OPENAI_PRICES (Standard), read 2026-10-16: cache writes 1.25x input; over 272K tokens the long row.
  row('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', [2, 2.5, 2.5, 0.1, 10], { long: [272_000, 4, 5, 5, 0.2, 15] }),
  // OPENAI_PRICES (Standard), read 2026-10-16.
  row('openai', 'gpt-6-astra', 'GPT-6 Astra', [10, 12.5, 12.5, 1, 50], { long: [272_000, 20, 25, 25, 2, 75] }),
  // OPENAI_PRICES (Standard), read 2026-10-16 (the page now lists a long-context row for it too).
  row('openai', 'gpt-6-sol', 'GPT-6 Sol', [2, 2.5, 2.5, 0.2, 10], { long: [272_000, 4, 5, 5, 0.4, 15] }),
  // OPENAI_PRICES (Standard), read 2026-10-16.
  row('openai', 'gpt-6-luna', 'GPT-6 Luna', [0.1, 0.125, 0.125, 0.01, 0.5], { long: [272_000, 0.2, 0.25, 0.25, 0.02, 0.75] }),
]);

/** Where each provider's rows were read (status and the price test show it). */
export const PRICE_SOURCES: Readonly<Record<'anthropic' | 'openai', string>> = Object.freeze({
  anthropic: ANTHROPIC_PRICES,
  openai: OPENAI_PRICES,
});

/**
 * Models a declined request may be served by instead (the first provider's server-side
 * refusal fallback, `fallbacks: "default"`). Only these two models get it: the provider
 * has none for Haiku 5.5, and an unknown id is never sent one.
 */
export const FALLBACK_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-opus-5-5': Object.freeze(['claude-opus-5', 'claude-opus-4-8']),
  'claude-sonnet-5-5': Object.freeze(['claude-sonnet-5']),
});

const ZERO: Rates = Object.freeze({ input: 0, write5m: 0, write1h: 0, read: 0, output: 0 });
const RATE_KEYS = ['input', 'write5m', 'write1h', 'read', 'output'] as const;

/** A dated snapshot id ("…-2026-08-01", "…-20260801") names its model's row. */
export function canonicalModel(id: string): string {
  return String(id || '').replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

export function priceRow(model: string): PriceRow | null {
  const want = canonicalModel(model);
  return PRICES.find((r) => r.model === want) ?? null;
}

/** A cloud model's context when nothing says it: a safe 200K. */
export const CLOUD_CONTEXT_DEFAULT = 200_000;

/** What a provider's models list said of each model's context (Anthropic's max_input_tokens), for this process. */
const LISTED_CONTEXT = new Map<string, number>();
const listedKey = (provider: ProviderId, model: string) => `${assistantState().bootId} ${provider} ${model}`;

/** A provider's models list named a model's context (tokens): contextWindow() takes it first, until the server starts again. */
export function noteListedContext(provider: ProviderId, model: string, tokens: unknown): void {
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0) return;
  const boot = `${assistantState().bootId} `;
  for (const k of LISTED_CONTEXT.keys()) if (!k.startsWith(boot)) LISTED_CONTEXT.delete(k);
  LISTED_CONTEXT.set(listedKey(provider, model), tokens);
}

/**
 * A cloud model's context window: what its provider's models list said this process, else its
 * row's, else CLOUD_CONTEXT_DEFAULT (`known` false: Magnusim's own figure).
 */
export function contextWindow(provider: ProviderId, model: string): { tokens: number; known: boolean } {
  const listed = LISTED_CONTEXT.get(listedKey(provider, model));
  if (listed) return { tokens: listed, known: true };
  const r = priceRow(model);
  return r?.context && r.provider === provider ? { tokens: r.context, known: true } : { tokens: CLOUD_CONTEXT_DEFAULT, known: false };
}

/**
 * The estimate prices a prompt at or above this share of a long tier's line on the long tier: its
 * prompt is a rough count (characters / 2.5), and a request just over the line pays the long tier
 * for all of its tokens (Claude Haiku 5.5's 100K line, for one).
 */
export const LONG_TIER_MARGIN = 0.9;

/**
 * The rates one request of `promptTokens` pays on this row (the long tier per request, past its
 * line); with `margin`, from that share of the line on (the estimate's LONG_TIER_MARGIN).
 */
export function ratesFor(r: PriceRow, promptTokens: number, margin?: number): Rates {
  if (!r.long) return r;
  return (margin === undefined ? promptTokens > r.long.above : promptTokens >= margin * r.long.above) ? r.long : r;
}

function maxRates(list: Rates[]): Rates {
  const out = { ...ZERO };
  for (const r of list) for (const k of RATE_KEYS) out[k] = Math.max(out[k], r[k]);
  return out;
}

/** The provider's dearest price for each kind of token, at this prompt size (`margin`: as ratesFor). */
export function dearestRates(provider: ProviderId, promptTokens = 0, margin?: number): Rates {
  if (provider === 'openai_compatible') return { ...ZERO };
  return maxRates(PRICES.filter((r) => r.provider === provider).map((r) => ratesFor(r, promptTokens, margin)));
}

/** All input tokens of one request (what the long tier is chosen on). */
export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** USD for `usage` at `rates`. */
export function costOf(rates: Rates, u: Usage): number {
  return (
    (u.input * rates.input + u.cacheWrite5m * rates.write5m + u.cacheWrite1h * rates.write1h + u.cacheRead * rates.read + u.output * rates.output) /
    1e6
  );
}

/**
 * What one request cost: the sum over its attempts, each at its own model's row (a
 * refusal fallback bills the fallback model at its own prices). An unknown model is
 * charged at its provider's dearest prices, `estimated`. A local server costs nothing.
 * `clearedTokens`: what the provider's context editing took out of the prompt before the
 * model read it. Which prompt picks a long tier then (the one sent, or the one read) is not
 * documented, so a request whose two sizes fall on either side of the line is `estimated`.
 */
export function requestCost(provider: ProviderId, attempts: readonly Attempt[], clearedTokens = 0): { usd: number; estimated: boolean } {
  if (provider === 'openai_compatible') return { usd: 0, estimated: false };
  let usd = 0;
  let estimated = false;
  for (const a of attempts) {
    const r = priceRow(a.model);
    const tokens = promptTokens(a.usage);
    if (!r) estimated = true;
    usd += costOf(r ? ratesFor(r, tokens) : dearestRates(provider, tokens), a.usage);
    if (!a.usage.complete) estimated = true;
    if (r?.long && clearedTokens > 0 && tokens <= r.long.above && tokens + clearedTokens > r.long.above) estimated = true;
  }
  return { usd, estimated };
}

// ---------------------------------------------------------------- the estimate before a request

/** A cached prefix is priced as a cache read only if the request that used it started this recently. */
export const CACHE_FRESH_MS = 4 * 60_000;
export const MAX_OUT_CLOUD = 32_000;
export const MAX_OUT_LOCAL = 8_192;
/** Below this many output tokens a step is not worth sending: the turn ends capped (a local server's context: failed). */
export const MIN_OUT = 2_048;
/** Tokens a local server's context keeps free beyond the prompt estimate and the answer. */
export const CONTEXT_MARGIN = 1_024;
const IMAGE_TOKENS_MAX = 5_334;
const TOOL_DEF_TOKENS = 500;

/** Tokens estimated for text of `chars` characters and these images (each by its checked header size). */
export function estimateTokens(chars: number, images: ReadonlyArray<{ width: number; height: number }>): number {
  return (
    Math.ceil((1.2 * Math.max(0, chars)) / 3) +
    images.reduce((n, im) => n + Math.min(IMAGE_TOKENS_MAX, Math.ceil((Math.max(0, im.width) * Math.max(0, im.height)) / 750)), 0)
  );
}

export interface EstimateInput {
  provider: ProviderId;
  model: string;
  cloud: boolean;
  /** adapter.fallbackTargets(model). */
  fallbackTargets: readonly string[];
  /** Characters this request adds to the conversation (new messages, the system text on the first step). */
  newChars: number;
  /** Images this request adds, by their checked header size. */
  newImages: ReadonlyArray<{ width: number; height: number }>;
  /** Tool definitions sent; counted on the first step only. */
  toolCount: number;
  firstStep: boolean;
  /** The previous request in this turn: its prompt size, when it started, and whether it read or wrote the cache. */
  prev: { promptTokens: number; startedAt: number; cacheUsed: boolean } | null;
  /**
   * More old tool results left out than in the previous request (common.ts clearedResults): the
   * tokens the previous request sent from the first newly left-out result on (no longer part of
   * the prefix), and the characters and images this request sends there instead, written to the
   * cache again.
   */
  prevDropTokens?: number;
  rewriteChars?: number;
  rewriteImages?: ReadonlyArray<{ width: number; height: number }>;
  now: number;
  /** min(turn_usd − turn spend, day_usd − (today's spend + open reservations)). */
  remainingUsd: number;
  /** The local server's context for the model (its model row), when it said; the answer fits in what the prompt leaves. */
  contextTokens?: number | null;
}

export interface Estimate {
  /** The reservation: input estimate, the fallback attempts' input, and maxOut output tokens. */
  usd: number;
  /** The request's output-token limit. */
  maxOut: number;
  /** The estimated prompt tokens (prefix + fresh). */
  promptTokens: number;
  /** USD of the input estimate alone (the model's own attempt: what an answer cut off is billed for). */
  inputUsd: number;
  /** USD of the input a refusal fallback may add: one more attempt per fallback target, each at its own row. */
  fallbackInputUsd: number;
  /** maxOut < MIN_OUT: the turn ends capped before sending. */
  capped: boolean;
  /** A local server's context leaves under MIN_OUT tokens for the answer: the turn ends failed (context) before sending. */
  noRoom: boolean;
  /** The model has no row (priced at the provider's dearest). */
  estimated: boolean;
  /** The dearest prices among the model and its fallback targets (the output's, and an attempt cut off). */
  rates: Rates;
}

/**
 * The cost of the next request, made before it is sent (spec 5.7), on a long tier from 90% of
 * its line (LONG_TIER_MARGIN). The previous request's prompt is priced as a cache read only if
 * that request used the cache and started under 4 minutes ago (an entry's 5-minute life counts
 * from the start of the request that used it); past that it is written again (the last block
 * carries a breakpoint), and a prompt that never used the cache is plain input. New text and
 * images are priced as cache writes. A refusal fallback runs the request again on another
 * model within the same request, and the declined attempt can be billed too, so each fallback
 * target adds one more input to the reservation, at its own row: the provider reprices a
 * fallback as if the conversation had been on that model all along (its cached prefix a read,
 * the rest written). When this request leaves out more old tool results than the previous
 * one, the prefix ends where the first of them was, and what it sends from there is written
 * again. The output limit is what the remaining money buys at the dearest output price (a
 * fallback model may answer), at most 32,000 (cloud) or 8,192 (local) tokens. A local server
 * costs nothing; when it reported the model's context, the answer gets what that context
 * leaves: min(the cap, context − prompt estimate − 1,024).
 */
export function estimateStep(e: EstimateInput): Estimate {
  const fresh =
    estimateTokens(e.newChars + (e.rewriteChars ?? 0), [...e.newImages, ...(e.rewriteImages ?? [])]) + (e.firstStep ? TOOL_DEF_TOKENS * Math.max(0, e.toolCount) : 0);
  const prefix = e.prev ? Math.max(0, e.prev.promptTokens - Math.max(0, e.prevDropTokens ?? 0)) : 0;
  const prompt = prefix + fresh;
  const cap = e.cloud ? MAX_OUT_CLOUD : MAX_OUT_LOCAL;
  if (e.provider === 'openai_compatible') {
    const context = e.contextTokens && e.contextTokens > 0 ? e.contextTokens : null;
    const maxOut = context === null ? cap : Math.max(0, Math.min(cap, context - prompt - CONTEXT_MARGIN));
    return { usd: 0, maxOut, promptTokens: prompt, inputUsd: 0, fallbackInputUsd: 0, capped: false, noRoom: maxOut < MIN_OUT, estimated: false, rates: { ...ZERO } };
  }
  const models = [e.model, ...e.fallbackTargets];
  const known = models.map((m) => priceRow(m));
  const estimated = known.some((r) => !r);
  const each = known.map((r) => (r ? ratesFor(r, prompt, LONG_TIER_MARGIN) : dearestRates(e.provider, prompt, LONG_TIER_MARGIN)));
  const rates = maxRates(each);
  const cached = !!e.prev && e.prev.cacheUsed && e.now - e.prev.startedAt < CACHE_FRESH_MS;
  const rewritten = !!e.prev && e.prev.cacheUsed && !cached;
  const inputOf = (r: Rates) => (prefix * (cached ? r.read : rewritten ? r.write5m : r.input) + fresh * r.write5m) / 1e6;
  const inputUsd = inputOf(each[0]);
  const fallbackInputUsd = each.slice(1).reduce((n, r) => n + inputOf(r), 0);
  const room = e.remainingUsd - inputUsd - fallbackInputUsd;
  const affordable = rates.output > 0 ? Math.floor((room / rates.output) * 1e6) : cap;
  const maxOut = Math.max(0, Math.min(cap, affordable));
  return {
    usd: inputUsd + fallbackInputUsd + (maxOut * rates.output) / 1e6,
    maxOut,
    promptTokens: prompt,
    inputUsd,
    fallbackInputUsd,
    capped: maxOut < MIN_OUT,
    noRoom: false,
    estimated,
    rates,
  };
}

/** The refusal-fallback targets a request of `model` carries (the first provider's only: providers/anthropic.ts). */
export function fallbackTargetsOf(provider: ProviderId | string, model: string): readonly string[] {
  return provider === 'anthropic' ? (FALLBACK_TARGETS[model] ?? []) : [];
}

/** The search's ceiling: a line past it is as good as none. */
const COLD_LINE_MAX = 1 << 30;

/**
 * The largest prompt (tokens) one request can send with nothing cached and still keep MIN_OUT
 * tokens for its answer within `usd`, as estimateStep prices it: written to the cache by the
 * model and by each refusal-fallback target at its own row. What one turn's money can resend
 * of a conversation whose cache has expired (conversations.ts limits). Null for a local server.
 */
export function coldLine(provider: ProviderId | string, model: string, fallbackTargets: readonly string[], usd: number): number | null {
  if (provider !== 'anthropic' && provider !== 'openai') return null;
  const capped = (tokens: number) =>
    estimateStep({
      provider,
      model,
      cloud: true,
      fallbackTargets,
      newChars: 0,
      newImages: [],
      toolCount: 0,
      firstStep: false,
      prev: { promptTokens: tokens, startedAt: 0, cacheUsed: true },
      now: CACHE_FRESH_MS,
      remainingUsd: usd,
    }).capped;
  if (capped(0)) return 0;
  // Each price only rises with the prompt (a long tier from its line on): the last size that fits.
  let lo = 0;
  let hi = 1 << 20;
  while (!capped(hi)) {
    if (hi >= COLD_LINE_MAX) return COLD_LINE_MAX;
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (capped(mid)) hi = mid;
    else lo = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- what Settings shows

export interface CuratedModel { id: string; label: string; priced: true }

/** The models Settings offers first for a cloud provider, the default first. */
export function curatedModels(provider: ProviderId): CuratedModel[] {
  return PRICES.filter((r) => r.provider === provider && r.picker).map((r) => ({ id: r.model, label: r.label, priced: true as const }));
}

export function modelLabel(model: string): string {
  return priceRow(model)?.label ?? model;
}

export interface PriceInfo {
  model: string;
  label: string;
  /** False: this table doesn't know the model; the prices shown are the provider's dearest. */
  known: boolean;
  local: boolean;
  /** USD per million tokens. */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  long: { above: number; input: number; output: number } | null;
  as_of: string;
  source: string | null;
}

/** The price line for Settings: the model's row, the provider's dearest, or nothing for a local server. */
export function priceInfo(provider: ProviderId, model: string): PriceInfo {
  if (provider === 'openai_compatible') {
    return { model, label: model, known: true, local: true, input: 0, output: 0, cache_read: 0, cache_write: 0, long: null, as_of: PRICES_AS_OF, source: null };
  }
  const r = priceRow(model);
  const rates = r ?? dearestRates(provider);
  return {
    model,
    label: r?.label ?? model,
    known: !!r,
    local: false,
    input: rates.input,
    output: rates.output,
    cache_read: rates.read,
    cache_write: rates.write5m,
    long: r?.long ? { above: r.long.above, input: r.long.input, output: r.long.output } : null,
    as_of: PRICES_AS_OF,
    source: PRICE_SOURCES[provider],
  };
}
