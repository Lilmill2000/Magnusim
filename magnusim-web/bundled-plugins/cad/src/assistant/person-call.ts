// The person's own use of the Assistant's read code (Daniel's rule both ways: whatever the
// Assistant has, the person has): the Find panel's selector, the Picture panel's labelled
// pictures, Measure's section plane and the Hole panel's plan run the same code the find, view,
// measure and hole tools run, with this context in place of a tool call's. No turn, no host call,
// no network: `key` is the person's own handle table ("person"), so a #f3 a Picture labels is the
// #f3 the Find panel reads. Progress and test holds are no-ops; `stop()` aborts it.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall } from '@magnusim/workspace';
import type { AppServices } from '../types/app';
import type { CallCtx } from '../types/assistant';
import type { SelectionItem } from '../types/selection';
import { BUDGETS } from './turn-info';

/** The person's handle table (find's #f3, a picture's labels). */
export const PERSON_KEY = 'person';

export interface PersonCall extends CallCtx {
  /** What the selector "selection" names: the panel's own picks, or null for the person's selection. */
  selection: readonly SelectionItem[] | null;
  /** Abort what runs on it (the panel closed, a newer query). */
  stop(): void;
}

let seq = 0;

/** A context for one of the person's uses of tool `tool` with `input`. */
export function personCall(services: AppServices, tool: string, input: Record<string, unknown>, selection: readonly SelectionItem[] | null = null): PersonCall {
  const ac = new AbortController();
  const id = `person-${++seq}`;
  const call = { call: id, turn: PERSON_KEY, tool, input, signal: ac.signal, progress: () => {} } as unknown as AssistantCall;
  return {
    services,
    selection,
    call,
    tool,
    input,
    signal: ac.signal,
    key: PERSON_KEY,
    turn: null,
    budgets: BUDGETS.cloud,
    firstOfKey: false,
    progress() {},
    hold: async () => {},
    checkAbort() {
      if (ac.signal.aborted) throw ac.signal.reason ?? new DOMException('Stopped', 'AbortError');
    },
    stop() {
      ac.abort(new DOMException('Stopped', 'AbortError'));
    },
  };
}
