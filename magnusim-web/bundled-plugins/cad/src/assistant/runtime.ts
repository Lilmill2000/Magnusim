// The Assistant's state in this page, one per Part (made by installAssistant): the chip's store,
// the turns the host told of, the call keys, the revision, the hold points, the call ledger and
// what the tools remember between calls. Tools reach it through runtimeOf(ctx.services).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { AssistantUiState } from '../types/assistant';
import type { FeatureId } from '../types/doc';
import type { StateStore } from '../types/state';
import type { RevTracker } from './rev';
import type { SessionKeys } from './session-key';
import type { CallRecord, HoldPoints } from './testing';
import type { TurnInfo } from './turn-info';

export interface AssistantRuntime {
  readonly services: AppServices;
  readonly store: StateStore<AssistantUiState>;
  readonly turns: TurnInfo;
  readonly keys: SessionKeys;
  readonly rev: RevTracker;
  readonly holds: HoldPoints;
  /** Every call answered, oldest first (at most CALLS_KEPT). */
  readonly calls: CallRecord[];
  /** Features this page's Assistant made (get_model's `by: "assistant"`); the edit tools add to it. */
  readonly madeBy: Set<FeatureId>;
  /** Keys that had a call already (CallCtx.firstOfKey). */
  readonly seenKeys: Set<string>;
  /** Keys whose get_model gave the pointer to `help guide` already (it goes once per key). */
  readonly guideNoted: Set<string>;
  /** The Part's title (the study record's, kept up to date). */
  title(): string;
  /** Whether a tool answers in this build (the others answer not_ready "not in this build yet"). */
  isBuilt(name: string): boolean;
  /**
   * The host passes a page error's hint and detail to the model (H2). True with the host's turn
   * events (H3 came after H2); without them the hint goes into the message.
   */
  readonly hostKeepsHints: boolean;
}

/** The newest calls the ledger keeps. */
export const CALLS_KEPT = 500;

const runtimes = new WeakMap<AppServices, AssistantRuntime>();

/** The Assistant's state in this page, or null before installAssistant (and after its uninstall). */
export function runtimeOf(services: AppServices): AssistantRuntime | null {
  return runtimes.get(services) ?? null;
}

export function setRuntime(services: AppServices, rt: AssistantRuntime | null): void {
  if (rt) runtimes.set(services, rt);
  else runtimes.delete(services);
}
