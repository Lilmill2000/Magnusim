// What the Assistant is doing in this Part, as the person sees it (CAD tools spec §8.3): one store
// the dock chip and `.cad-app[data-assistant]` read. Its `phase` follows from the rest:
//   off       the tools are not offered;
//   working   a call runs (waiting and approve come with the edit tools and watch mode);
//   paused    the Assistant is paused in this Part (whatever else runs: review, "Ask each step"
//             left a pause showing "working");
//   thinking  a turn bound to this tab runs with no call (the host's turn events), or for a short
//             while after a call on a host without them;
//   ended     the turn ended: for ENDED_MS, or until the Part changes or the next turn starts;
//   idle      otherwise.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { AssistantPhase, AssistantUiState } from '../types/assistant';
import type { StateStore } from '../types/state';
import { createStateStore } from '../lib/store';

/** How long the chip shows a turn's end. */
export const ENDED_MS = 120_000;
/** On a host without turn events: how long the chip stays after the last call. */
export const LINGER_MS = 10_000;

export const INITIAL_STATE: AssistantUiState = Object.freeze({ phase: 'off', registration: 'pending', reason: null, turn: null, call: null, note: null }) as AssistantUiState;

export function createAssistantStore(): StateStore<AssistantUiState> {
  return createStateStore<AssistantUiState>({ ...INITIAL_STATE });
}

/**
 * The phase from the state's facts. `running`: a turn bound to this tab runs (the host said so);
 * `lingering`: on a host without turn events, within LINGER_MS of the last call; `paused`: the
 * pause is on (busy.ts).
 */
export function phaseOf(s: Omit<AssistantUiState, 'phase'> & { phase?: AssistantPhase }, running: boolean, lingering: boolean, paused = false): AssistantPhase {
  if (s.registration !== 'on') return 'off';
  // The edit tools set these while a call waits for the person; they hold until the call says otherwise.
  if (s.phase === 'waiting' || s.phase === 'approve') return s.phase;
  if (paused) return 'paused';
  if (s.call) return 'working';
  if (running || lingering) return 'thinking';
  if (s.turn?.end) return 'ended';
  return 'idle';
}

/** `.cad-app[data-assistant]`: the phase, 'off' when no Assistant module runs. */
export function useAssistantPhase(services: AppServices): AssistantPhase {
  const api = useStateStore(services.apis, (a) => a.assistant ?? null);
  return useStateStore(api?.state ?? NO_STATE, (s) => s.phase);
}

const NO_STATE = createStateStore<AssistantUiState>({ ...INITIAL_STATE });
