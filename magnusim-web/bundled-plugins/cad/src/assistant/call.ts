// One call of a Part tool, as the app's bridge hands it (CAD tools spec §2.1 call.ts): its key,
// its context, the tool's code from tools/index.ts (a tool not in this build answers not_ready
// "not in this build yet"), the reply's revision and the person's changes since the key's last
// call, or the conversation's when its turn names it (worked out as the call answers: what they
// did while it ran is told too), an honest error
// with its reason, hint and detail, the turn log's summary, and the chip
// and the test ledger kept up to date. The call's signal is the SDK's merged with the chip's
// Stop (a call of a key the person stopped answers busy stopped at once); the camera latch takes
// the key's baseline at its first call when the host told of no turn.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall, AssistantResult } from '@magnusim/workspace';
import type { CallCtx, ToolImpl, ToolReply } from '../types/assistant';
import { asToolError, sdkError, ToolError } from './errors';
import { oneLine } from './numbers';
import { editPicture, owePicture, PICTURE_LATER, PICTURE_NEXT, picturesOn, placeOf, stepPicture, wantsPicture } from './pictures';
import { CALLS_KEPT, type AssistantRuntime } from './runtime';
import { toolNamed, TOOL_NAMES } from './schemas';
import * as BUILT from './tools';

/** A reply's text and summary, on one line. */
export const TEXT_MAX = 200;
export const SUMMARY_MAX = 160;

const TOOLS = BUILT as unknown as Readonly<Record<string, ToolImpl | undefined>>;

/** The person stopped the Assistant from the chip: what the call answers. */
export const STOPPED_WORDS = 'The person stopped the Assistant in this Part. End your turn now.';

/** One signal that aborts when either does (with the first one's reason); `off` drops the listeners. */
function bothSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; off(): void } {
  if (a.aborted) return { signal: a, off: () => undefined };
  if (b.aborted) return { signal: b, off: () => undefined };
  const c = new AbortController();
  const fa = () => c.abort(a.reason);
  const fb = () => c.abort(b.reason);
  a.addEventListener('abort', fa, { once: true });
  b.addEventListener('abort', fb, { once: true });
  return {
    signal: c.signal,
    off() {
      a.removeEventListener('abort', fa);
      b.removeEventListener('abort', fb);
    },
  };
}

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
    // What the person changed: from the conversation's last call when the turn names it.
    rt.rev.begin(key, turn?.conversation ?? null);
    // The chip's Stop aborts this one here, at once (its step reverts synchronously).
    const local = new AbortController();
    const merged = bothSignals(call.signal, local.signal);
    const signal = merged.signal;
    rt.active.set(call.call, { key, turn: call.turn, stop: (reason) => local.abort(reason) });
    rt.lastKey = key;
    rt.camera.callStarts(key);
    rt.services.bus.emit('assistant:call', { turn: call.turn, call: call.call, tool: call.tool, phase: 'start' });
    rt.store.set({ call: { tool: call.tool, label } });
    const ctx: CallCtx = {
      services: rt.services,
      call,
      tool: call.tool,
      input: call.input ?? {},
      signal,
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
      hold: (point) => rt.holds.at(point, signal),
      checkAbort: () => {
        if (signal.aborted) throw new ToolError('stopped', 'The call was stopped.');
      },
    };
    let ok = false;
    let error: ToolError | null = null;
    let images = 0;
    // Its place in the model's step, when the host says it: one picture per step (pictures.ts).
    const place = placeOf(call);
    // An owed picture is the conversation's when the turn names one: its next request brings it.
    const owedKey = turn?.conversation ? `conv:${turn.conversation}` : key;
    try {
      if (!spec || !TOOL_NAMES.includes(call.tool)) throw new ToolError('bad_input', `No Part tool is called ${call.tool}.`);
      if (rt.stopped.has(key)) throw new ToolError('stopped', STOPPED_WORDS);
      const impl = Object.prototype.hasOwnProperty.call(tools, call.tool) ? tools[call.tool] : undefined;
      if (!impl) throw new ToolError('not_built', `${call.tool} is not in this build yet.`, { detail: { tool: call.tool } });
      const reply: ToolReply = await impl.run(ctx);
      ok = true;
      // An edit that answered ok: one picture of the Part as it is now (pictures.ts); never a failure.
      // A reply that changed no model (undo_step false: the workspace tool's view state) gets none.
      // With the host's place: the call after which no edit of the step follows brings it (stepPicture).
      const pics = rt.pictures.get();
      const own = !!reply.images?.length;
      const editsLeft = place?.editsLeft ?? null;
      const when = stepPicture({ editsLeft, edits: !own && reply.data.undo_step !== false && wantsPicture(ctx, pics), owed: rt.picturesOwed.has(owedKey), on: !own && picturesOn(ctx, pics) });
      if (when === 'later') {
        owePicture(rt.picturesOwed, owedKey);
        reply.data = { ...reply.data, picture: PICTURE_LATER };
      } else {
        if (editsLeft === 0 || when === 'now') rt.picturesOwed.delete(owedKey);
        const pic = when === 'now' ? await editPicture(ctx) : null;
        if (pic && 'image' in pic) {
          reply.images = [pic.image];
          reply.data = { ...reply.data, picture: pic.caption };
        } else if (pic) reply.data = { ...reply.data, picture_note: pic.note };
      }
      images = reply.images?.length ?? 0;
      const data: Record<string, unknown> = { rev: rt.rev.current(), ...reply.data };
      // Now, not when the call began: an edit waits for the person, who may change the Part meanwhile.
      const changes = rt.rev.changesFor(key);
      if (changes.length) data.user_changes = changes;
      return {
        text: oneLine(reply.text, TEXT_MAX),
        data,
        summary: oneLine(reply.summary ?? reply.text, SUMMARY_MAX),
        ...(reply.images?.length ? { images: reply.images } : {}),
      };
    } catch (e) {
      error = signal.aborted && !(e instanceof ToolError) ? new ToolError('stopped', 'The call was stopped.') : asToolError(e);
      const changes = rt.rev.changesFor(key);
      if (changes.length) error.detail.user_changes = changes;
      // The step's last call failed with an earlier edit's picture owed: the next step brings it.
      if (place?.callsLeft === 0 && rt.picturesOwed.has(owedKey)) error.detail.picture = PICTURE_NEXT;
      throw sdkError(error, rt.hostKeepsHints);
    } finally {
      merged.off();
      rt.active.delete(call.call);
      rt.keys.ended(key);
      rt.rev.seen(key);
      const paced = rt.paced.get(call.call);
      rt.paced.delete(call.call);
      rt.calls.push({ call: call.call, turn: call.turn, key, tool: call.tool, ok, ...(error ? { code: error.code, reason: error.reason } : {}), ms: Date.now() - t0, ...(paced !== undefined ? { paced } : {}), ...(images ? { images } : {}) });
      if (rt.calls.length > CALLS_KEPT) rt.calls.splice(0, rt.calls.length - CALLS_KEPT);
      rt.store.set({ call: null });
      rt.services.bus.emit('assistant:call', { turn: call.turn, call: call.call, tool: call.tool, phase: 'end', ok });
    }
  };
}
