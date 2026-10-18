// One call of a Part tool, as the app's bridge hands it (CAD tools spec §2.1 call.ts): its key,
// its context, the tool's code from tools/index.ts (a tool not in this build answers not_ready
// "not in this build yet"), the reply's revision and the person's changes since the key's last
// call, an honest error with its reason, hint and detail, the turn log's summary, and the chip
// and the test ledger kept up to date.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall, AssistantResult } from '@magnusim/workspace';
import type { CallCtx, ToolImpl, ToolReply } from '../types/assistant';
import { asToolError, sdkError, ToolError } from './errors';
import { oneLine } from './numbers';
import { CALLS_KEPT, type AssistantRuntime } from './runtime';
import { toolNamed, TOOL_NAMES } from './schemas';
import * as BUILT from './tools';

/** A reply's text and summary, on one line. */
export const TEXT_MAX = 200;
export const SUMMARY_MAX = 160;

const TOOLS = BUILT as unknown as Readonly<Record<string, ToolImpl | undefined>>;

/** Whether `name` answers in this build. */
export function isBuilt(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOLS, name) && !!TOOLS[name];
}

/**
 * The page's tool handler (ws.assistant.register's): one call at a time, as the bridge sends them.
 * `tools` is the build's table (tests pass their own).
 */
export function createCallHandler(rt: AssistantRuntime, tools: Readonly<Record<string, ToolImpl | undefined>> = TOOLS): (call: AssistantCall) => Promise<AssistantResult> {
  return async (call) => {
    const t0 = Date.now();
    const key = rt.keys.keyOf(call.turn);
    const turn = rt.turns.forKey(key);
    const firstOfKey = !rt.seenKeys.has(key);
    rt.seenKeys.add(key);
    const spec = toolNamed(call.tool);
    const label = spec?.title ?? call.tool;
    const changes = rt.rev.changesFor(key);
    rt.services.bus.emit('assistant:call', { turn: call.turn, call: call.call, tool: call.tool, phase: 'start' });
    rt.store.set({ call: { tool: call.tool, label } });
    const ctx: CallCtx = {
      services: rt.services,
      call,
      tool: call.tool,
      input: call.input ?? {},
      signal: call.signal,
      key,
      turn,
      budgets: rt.turns.budgets(key),
      firstOfKey,
      progress: (fraction, text, opts) => {
        try {
          call.progress(fraction, text, opts);
        } catch {
          // A progress that could not go out changes nothing of the call.
        }
      },
      hold: (point) => rt.holds.at(point, call.signal),
      checkAbort: () => {
        if (call.signal.aborted) throw new ToolError('stopped', 'The call was stopped.');
      },
    };
    let ok = false;
    let error: ToolError | null = null;
    try {
      if (!spec || !TOOL_NAMES.includes(call.tool)) throw new ToolError('bad_input', `No Part tool is called ${call.tool}.`);
      const impl = Object.prototype.hasOwnProperty.call(tools, call.tool) ? tools[call.tool] : undefined;
      if (!impl) throw new ToolError('not_built', `${call.tool} is not in this build yet.`, { detail: { tool: call.tool } });
      const reply: ToolReply = await impl.run(ctx);
      ok = true;
      const data: Record<string, unknown> = { rev: rt.rev.current(), ...reply.data };
      if (changes.length) data.user_changes = changes;
      return {
        text: oneLine(reply.text, TEXT_MAX),
        data,
        summary: oneLine(reply.summary ?? reply.text, SUMMARY_MAX),
        ...(reply.images?.length ? { images: reply.images } : {}),
      };
    } catch (e) {
      error = call.signal.aborted && !(e instanceof ToolError) ? new ToolError('stopped', 'The call was stopped.') : asToolError(e);
      if (changes.length) error.detail.user_changes = changes;
      throw sdkError(error, rt.hostKeepsHints);
    } finally {
      rt.keys.ended(key);
      rt.rev.seen(key);
      rt.calls.push({ call: call.call, turn: call.turn, key, tool: call.tool, ok, ...(error ? { code: error.code, reason: error.reason } : {}), ms: Date.now() - t0 });
      if (rt.calls.length > CALLS_KEPT) rt.calls.splice(0, rt.calls.length - CALLS_KEPT);
      rt.store.set({ call: null });
      rt.services.bus.emit('assistant:call', { turn: call.turn, call: call.call, tool: call.tool, phase: 'end', ok });
    }
  };
}
