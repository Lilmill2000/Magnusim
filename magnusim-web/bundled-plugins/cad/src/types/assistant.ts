// The Assistant's page API inside the Part (published as services.apis.assistant by the
// Assistant module, src/features/assistant + src/assistant; null or absent without it), and the
// types its tools share. One writer: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall, AssistantImage, AssistantProgressOptions } from '@magnusim/workspace';
import type { AppServices } from './app';
import type { ReadonlyStateStore } from './state';

/**
 * The automatic camera moves that ask first (each passes `auto: true` to the viewport, so
 * ViewportHandle.userCameraMoves does not count it):
 *   'sketch-entry'    sketch mode turns the view to look straight at the sketch's plane;
 *   'sketch-reframe'  a reopened sketch frames again once the later features are rolled back;
 *   'extrude-iso'     a new Extrude seen along its direction turns the view to Isometric.
 */
export type AutoCameraReason = 'sketch-entry' | 'sketch-reframe' | 'extrude-iso';

export interface AssistantPageApi {
  /**
   * Whether an automatic camera move for this edit session may run now. True for every session
   * the Assistant does not own, so the person's own sketches and extrudes turn the view as they
   * always did. For the Assistant's own sessions it says no once the person has moved the camera
   * during the turn, while the window is hidden, or when the pace is fast.
   */
  autoCamera(reason: AutoCameraReason, sessionId: string | null): boolean;
  /**
   * Whether the view may frame what a change of `owner`'s brings (the first bodies, a size
   * change, bodies or a finished sketch past the view) now. True for the person's own changes
   * (owner null). For an Assistant step's: not once the person moved the camera during its
   * request (the latch: "it leaves your view alone"), nor while the window is hidden or covered.
   */
  autoFrame?(owner: string | null): boolean;
  /** What the Assistant is doing in this Part (the dock chip and `.cad-app[data-assistant]` read it). */
  readonly state?: ReadonlyStateStore<AssistantUiState>;
  /** What the chip's buttons do (watch mode). */
  readonly actions?: AssistantActions;
}

/** The chip's buttons (CAD tools spec §8.3). */
export interface AssistantActions {
  /** Pause the Assistant's edits in this Part: they wait (reads still run) until Resume or the turn's end. */
  pause(): void;
  resume(): void;
  /**
   * Stop the running turn: its call reverts at once, any later call of it answers busy stopped, and
   * the host ends the turn (only with the host's turn events).
   */
  stop(): void;
  /** "Ask each step": the waiting step is kept, or discarded (reverted). */
  keep(): void;
  discard(): void;
  /** Undo the ended turn's changes: its undo group, while that is the newest step (one Ctrl+Z). */
  undo(): void;
  /** The person's pace (ws.prefs). */
  setPace(pace: 'watch' | 'fast'): void;
  /** "Ask each step" on or off (ws.prefs). */
  setAskEach(on: boolean): void;
  /** A picture of the Part after each edit ('each') or none ('off') (ws.prefs). */
  setPictures(v: 'each' | 'off'): void;
}

/**
 * The Assistant in this Part, as the person sees it:
 *   'off'       no tools offered (an older host, a remote viewer, no Assistant in the app);
 *   'idle'      tools offered, nothing running;
 *   'thinking'  a turn bound to this tab runs and no call is running;
 *   'working'   a call runs;
 *   'waiting'   an edit waits for the person (a panel of theirs, the rollback bar, a pause);
 *   'approve'   "Ask each step": an edit waits for Keep or Discard;
 *   'paused'    the person paused the Assistant, took over, or undid its steps;
 *   'ended'     the turn ended (for a while after, or until the next change of the Part).
 */
export type AssistantPhase = 'off' | 'idle' | 'thinking' | 'working' | 'waiting' | 'approve' | 'paused' | 'ended';

/** How a turn ended (the host's turn event). */
export type AssistantTurnEnd = 'done' | 'stopped' | 'failed' | 'capped';

export interface AssistantUiState {
  phase: AssistantPhase;
  /** The tools' registration: pending until the app answered, 'on', or 'off' with `reason`. */
  registration: 'pending' | 'on' | 'off';
  /** Why the tools are not offered ("not_connected", "remote", "no_assistant", "not_allowed", ...), or null. */
  reason: string | null;
  /**
   * The turn the chip speaks of: the running one, or the one that just ended. `changes` and
   * `changesCap`: a coding agent's turn's changes of its change limit (null for any other turn).
   * `review`: the review round it is in, absent before the first.
   */
  turn: {
    id: string;
    title: string;
    steps: number | null;
    stepsCap: number | null;
    changes: number | null;
    changesCap: number | null;
    end: AssistantTurnEnd | 'ended' | null;
    review?: { round: number; of: number };
  } | null;
  /** The call running now: its tool and what it does ("Read the Part"). */
  call: { tool: string; label: string } | null;
  /** What the chip says while waiting or paused ("close the Fillet 2 panel"), or null. */
  note: string | null;
  /** The person's pace (the chip's Fast / Watch). */
  pace?: 'watch' | 'fast';
  /** "Ask each step" is on. */
  askEach?: boolean;
  /** A picture of the Part after each edit (the chip's Pictures): 'each' or 'off'. */
  pictures?: 'each' | 'off';
  /** The host can stop a turn from this page (its turn events): the chip offers Stop. */
  canStop?: boolean;
  /** The app shows its own Assistant panel (the dock), which offers Stop and Undo: the chip leaves them out. */
  docked?: boolean;
}

/** The facts the host tells of a turn bound to this tab (ws.assistant.onTurn), kept per turn id. */
export interface TurnFacts {
  id: string;
  state: 'running' | 'ended';
  /** The first line of the person's request (at most 60 characters). */
  title: string;
  /** It runs on a local server: smaller replies (reply budgets). */
  local: boolean;
  contextTokens: number | null;
  images: boolean | null;
  /** Its limits as they are in force; `changesCap` 0: no change limit (only a coding agent's turn has one). */
  used: { steps: number; stepsCap: number; changes: number; changesCap: number; usd: number; usdCap: number };
  end: { state: AssistantTurnEnd; reason: string } | null;
  /** The review round it is in (the host's turn events), absent before the first. */
  review?: { round: number; of: number };
  /** The conversation it runs in (AssistantTurn.conversation, unreleased 1.9), or null when the host names none. */
  conversation: string | null;
}

/** Reply budgets for one call (bytes of `data` as JSON), by turn kind (CAD tools spec §3.1). */
export interface ReplyBudgets {
  kind: 'cloud' | 'local';
  /** get_model brief: the size it aims at, and how many features stay before the older ones collapse. */
  brief: number;
  briefCollapse: number;
  /** get_model full (and one feature that is not a sketch). */
  full: number;
  /** get_model of one sketch. */
  sketch: number;
  /** The largest picture view may return. */
  viewSize: 'small' | 'large';
}

/** One tool call as a tool's code gets it (src/assistant/call.ts builds it). */
export interface CallCtx {
  readonly services: AppServices;
  /** The SDK's call (its id, turn, tool, input, signal and progress). */
  readonly call: AssistantCall;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** Aborted when the turn is stopped, the call stalls, or the Part closes. */
  readonly signal: AbortSignal;
  /** The undo group, handle table and ledger key: "turn:<id>", "ext:<n>", or "mcp:<session>" (then "mcp:<session>#<n>"). */
  readonly key: string;
  /** The turn's facts from the host, when it told them (null on a host without turn events, and for external calls). */
  readonly turn: TurnFacts | null;
  readonly budgets: ReplyBudgets;
  /** The first call under this key (the guide pointer of get_model goes once per key). */
  readonly firstOfKey: boolean;
  /** Progress (each call resets the host's stall window); `waiting` while the call waits for the person. */
  progress(fraction: number | null, label?: string, opts?: AssistantProgressOptions): void;
  /** A test hold point (src/assistant/testing.ts): resolves at once unless a test holds `point`. */
  hold(point: string): Promise<void>;
  /** Throws the call's stop when its signal aborted. */
  checkAbort(): void;
}

/** What a tool returns: one line of text, compact data (rev and user_changes are added for it), the log's line. */
export interface ToolReply {
  /** One line, at most 200 characters. */
  text: string;
  data: Record<string, unknown>;
  /** The turn log's line (at most 160 characters); the model never gets it. */
  summary?: string;
  images?: AssistantImage[];
}

/** A tool's code: `read` tools never open a session or wait for the person; `edit` tools run as one Assistant step. */
export interface ToolImpl {
  kind: 'read' | 'edit';
  run(ctx: CallCtx): Promise<ToolReply>;
}

/**
 * What every edit tool's data holds (§7.5): the step's outcome and what changed. Built by the
 * edit tools' judge (src/assistant/judge.ts); the type is here so every tool returns the same shape.
 */
export interface EditData {
  rev: number;
  step: number;
  /** `note`: the feature's note (FeatureStatus.note), only when it has one. */
  feature: { name: string; type: string; state: string; message: string | null; note?: string } | null;
  resolved: Record<string, string>;
  bodies: {
    created: Record<string, unknown>[];
    changed: Record<string, unknown>[];
    removed: string[];
  };
  created: string[];
  warnings: string[];
  broke: { feature: string; message: string }[];
  fixed: string[];
  user_changes?: string[];
}
