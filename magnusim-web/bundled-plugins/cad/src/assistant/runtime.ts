// The Assistant's state in this page, one per Part (made by installAssistant): the chip's store,
// the turns the host told of, the call keys, the revision, the hold points, the call ledger and
// what the tools remember between calls (the edits' undo ledger, pause, pace and the person's
// input). Tools reach it through runtimeOf(ctx.services).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { AssistantUiState } from '../types/assistant';
import type { FeatureId } from '../types/doc';
import type { StateStore } from '../types/state';
import type { Approvals, AskEach } from './approval';
import type { PauseState, SoftInput } from './busy';
import type { CameraLatch } from './camera';
import type { Ledger } from './ledger';
import type { PaceControl } from './pace';
import type { PicturesControl } from './pictures';
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
  /** Features a kept structural edit of the Assistant's turned red (get_model's `broken_by_you` while they fail). */
  readonly brokenBy: Set<FeatureId>;
  /** Each key's edit calls with the point before each (the undo tool, get_model's undo.your_steps). */
  readonly ledger: Ledger;
  /** Paused in this Part (the chip, a take-over, the person's undo): edits wait. */
  readonly pause: PauseState;
  /** The person's pace (watch or fast) and each call's waits. */
  readonly pace: PaceControl;
  /** The person's pointer and keys in the frame (the soft wait). */
  readonly soft: SoftInput;
  /** The camera latch: the Assistant's automatic camera moves, per key (camera.ts). */
  readonly camera: CameraLatch;
  /** "Ask each step", the person's choice, and the step waiting for their answer (approval.ts). */
  readonly askEach: AskEach;
  readonly approvals: Approvals;
  /** A picture of the Part after each edit, the person's choice (pictures.ts). */
  readonly pictures: PicturesControl;
  /** Keys whose step said "see this step's last edit" and had no picture yet (pictures.ts stepPicture). */
  readonly picturesOwed: Set<string>;
  /** The calls running now, by call id: their key and turn, and the chip's Stop of each. */
  readonly active: Map<string, ActiveCall>;
  /** Keys the person stopped from the chip: every later call of them answers busy stopped. */
  readonly stopped: Set<string>;
  /** The key of the newest call (the chip's Pause on a host without the turn events). */
  lastKey: string | null;
  /** How long each edit call waited at its pace points (ms), by call id, until call.ts records it. */
  readonly paced: Map<string, number>;
  /** The longest an edit waits for the person (EDIT_WAIT_MS; tests shorten it). */
  waitCapMs: number;
  /** Keys that had a call already (CallCtx.firstOfKey). */
  readonly seenKeys: Set<string>;
  /** Keys whose get_model gave the pointer to `help guide` already (it goes once per key). */
  readonly guideNoted: Set<string>;
  /** The Part's title (the study record's, kept up to date). */
  title(): string;
  /** Whether a tool answers in this build (the others answer not_ready "not in this build yet"). */
  isBuilt(name: string): boolean;
  /**
   * The tools the page offers now, by name: all 18, or the eval's core set (testing.ts
   * setToolset). The guide registered and help's guide and features topics follow it.
   */
  offered: readonly string[];
  /** The registration asks for review rounds (review.ts CAD_REVIEW); the eval may turn them off (testing.ts setReview). */
  review: boolean;
  /**
   * The host passes a page error's hint and detail to the model (H2). True with the host's turn
   * events (H3 came after H2); without them the hint goes into the message.
   */
  readonly hostKeepsHints: boolean;
}

/** A call running now (call.ts keeps them for the chip's Stop and the camera's gate). */
export interface ActiveCall {
  key: string;
  /** The SDK's turn id ("" for an outside client). */
  turn: string;
  /** Abort the call here (its step reverts at once); the reason is what it answers. */
  stop(reason: unknown): void;
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
