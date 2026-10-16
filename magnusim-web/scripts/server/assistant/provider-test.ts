/**
 * Settings' Test button (Foundation spec 4.3, 9.2): at most two model calls with one
 * test tool, `connection_check {word: "ok"}`, which no turn is ever offered.
 *
 * 1. The model is asked to call connection_check. A call means tool calling works; a
 *    local model that writes the call as text instead has a chat template without
 *    tools ("as_text"); a model that just answers didn't use the tool ("not_used").
 * 2. After a call, the tool's result goes back and the model answers once more (the
 *    whole round trip a turn makes).
 *
 * Each request reserves its estimate against today's limit first and settles its real
 * cost after, like a turn's (the Test counts toward the day). Errors come back as
 * {ok:false, code, error} with the adapter's plain text.
 */
import type { SpendLedger } from './ledger.ts';
import { estimateStep, requestCost } from './prices.ts';
import { ProviderError, type JsonSchemaObject, type Message, type ProviderAdapter, type ProviderRequest, type ProviderResult, type ProviderTool } from './types.ts';
import type { Effort, ProviderId } from './types.ts';

export const CONNECTION_CHECK_SCHEMA: JsonSchemaObject = Object.freeze({
  type: 'object',
  properties: { word: { type: 'string', enum: ['ok'], description: 'Always "ok".' } },
  required: ['word'],
  additionalProperties: false,
}) as JsonSchemaObject;

export const CONNECTION_CHECK: ProviderTool = Object.freeze({
  name: 'connection_check',
  description: 'Confirms that Magnusim can reach you and that tool calls work. Call it with word "ok".',
  schema: CONNECTION_CHECK_SCHEMA,
});

const SYSTEM = 'You are checking that Magnusim can reach you. When asked, call the connection_check tool once with word "ok", then answer in one short sentence.';
const PROMPT = 'Connection test: call the connection_check tool with word "ok", then reply "Connected."';
const TOOL_RESULT = JSON.stringify({ tool: 'connection_check', ok: true, data: { word: 'ok' } });

/** Output tokens each test request may use. */
export const TEST_MAX_OUT = 4_096;

export type ToolsVerdict = 'works' | 'not_used' | 'as_text';

export type ConnectionTestResult =
  | { ok: true; model: string; served_by: string; ms: number; tools: ToolsVerdict; cost_usd: number; estimated: boolean; requests: number }
  | { ok: false; code: string; error: string; cost_usd: number };

export interface ConnectionTestOptions {
  adapter: ProviderAdapter;
  provider: ProviderId;
  model: string;
  effort: Effort;
  ledger: SpendLedger;
  /** Today's limit, for cloud providers (a local server costs nothing). */
  dayCapUsd: number | null;
  signal: AbortSignal;
  now?: () => number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Today's limit leaves no room for a test request. */
class DayCapReached extends Error {}

export async function runConnectionTest(o: ConnectionTestOptions): Promise<ConnectionTestResult> {
  const now = o.now ?? Date.now;
  const started = now();
  let cost = 0;
  let estimated = false;
  let requests = 0;
  let prev: { promptTokens: number; startedAt: number; cacheUsed: boolean } | null = null;

  const send = async (messages: Message[], newChars: number): Promise<ProviderResult> => {
    const req: ProviderRequest = {
      model: o.model,
      system: [{ text: SYSTEM, cache: false }],
      messages,
      tools: [CONNECTION_CHECK],
      maxOutputTokens: TEST_MAX_OUT,
      effort: o.effort,
    };
    const remaining = o.dayCapUsd === null ? Number.POSITIVE_INFINITY : o.dayCapUsd - (o.ledger.spentToday() + o.ledger.reservedToday());
    const est = estimateStep({
      provider: o.provider,
      model: o.model,
      cloud: o.adapter.cloud,
      fallbackTargets: o.adapter.fallbackTargets(o.model),
      newChars,
      newImages: [],
      toolCount: 1,
      firstStep: !prev,
      prev,
      now: now(),
      remainingUsd: remaining,
    });
    const maxOut = Math.min(TEST_MAX_OUT, est.maxOut);
    if (o.dayCapUsd !== null && maxOut < 1_024) throw new DayCapReached(`Today's ${usd(o.dayCapUsd)} limit is reached; it resets at midnight.`);
    const reserveUsd = est.inputUsd + (maxOut * est.rates.output) / 1e6;
    const reservation = o.dayCapUsd === null ? null : await o.ledger.reserve(reserveUsd, { dayCapUsd: o.dayCapUsd });
    if (o.dayCapUsd !== null && !reservation) throw new DayCapReached(`Today's ${usd(o.dayCapUsd)} limit is reached; it resets at midnight.`);
    const startedAt = now();
    requests += 1;
    let spent = 0;
    try {
      const result = await o.adapter.send({ ...req, maxOutputTokens: maxOut }, o.signal, () => {});
      const c = requestCost(o.provider, result.attempts);
      spent = c.usd;
      estimated ||= c.estimated;
      const u = result.usage;
      prev = { promptTokens: u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h, startedAt, cacheUsed: u.cacheRead + u.cacheWrite5m + u.cacheWrite1h > 0 };
      return result;
    } catch (err) {
      // A request that failed after streaming was billed for some of it: count what was reserved.
      if (err instanceof ProviderError && err.streamed) {
        spent = reserveUsd;
        estimated = true;
      }
      throw err;
    } finally {
      cost += spent;
      if (reservation) await o.ledger.settle(reservation, spent);
    }
  };

  const fail = (err: unknown): ConnectionTestResult => {
    if (err instanceof DayCapReached) return { ok: false, code: 'cap_day', error: err.message, cost_usd: cost };
    if (err instanceof ProviderError) return { ok: false, code: err.code, error: err.message, cost_usd: cost };
    return { ok: false, code: 'other', error: 'The test failed with an unexpected error.', cost_usd: cost };
  };

  const first: Message[] = [{ role: 'user', parts: [{ type: 'text', text: PROMPT }] }];
  let r1: ProviderResult;
  try {
    r1 = await send(first, SYSTEM.length + PROMPT.length + JSON.stringify(CONNECTION_CHECK).length);
  } catch (err) {
    return fail(err);
  }
  if (r1.stop === 'refusal') return { ok: false, code: 'refusal', error: 'The model declined the test request.', cost_usd: cost };
  const calls = r1.message.parts.filter((p) => p.type === 'tool_call');
  const checked = calls.find((p) => p.type === 'tool_call' && p.name === CONNECTION_CHECK.name);
  let tools: ToolsVerdict = 'not_used';
  let servedBy = r1.servedBy;
  if (r1.toolCallAsText) tools = 'as_text';
  if (checked && r1.stop === 'tool_use') {
    tools = 'works';
    // Every call gets its answer (only connection_check is offered, but a model may call twice).
    const results = calls.map((c) => ({
      type: 'tool_result' as const,
      callId: c.type === 'tool_call' ? c.callId : '',
      isError: false,
      text: TOOL_RESULT,
      images: [],
    }));
    try {
      const r2 = await send([...first, r1.message, { role: 'user', parts: results }], TOOL_RESULT.length * results.length);
      if (r2.stop === 'refusal') return { ok: false, code: 'refusal', error: 'The model declined the test request.', cost_usd: cost };
      servedBy = r2.servedBy;
    } catch (err) {
      return fail(err);
    }
  }
  return { ok: true, model: o.model, served_by: servedBy, ms: Math.max(0, now() - started), tools, cost_usd: Math.round(cost * 1e6) / 1e6, estimated, requests };
}
