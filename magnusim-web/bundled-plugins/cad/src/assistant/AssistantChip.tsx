// The Assistant's chip in the dock (CAD tools spec §8.3): `[data-chip="assistant"]` with
// `data-assistant-state` the phase. "Assistant · thinking · 12 of 120 steps", "Assistant · Read
// the Part · 12 of 120 steps", "Assistant: <request> · done". Nothing while the Assistant is off
// or idle. Pause, Stop, Undo, Ask each step and the Part's health at the end come with watch mode.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import type { AssistantUiState } from '../types/assistant';
import { INITIAL_STATE } from './state';
import { createStateStore } from '../lib/store';

const NONE = createStateStore<AssistantUiState>({ ...INITIAL_STATE });

const END_WORDS: Record<string, string> = { done: 'done', stopped: 'stopped', failed: 'failed', capped: 'stopped at its limits', ended: 'ended' };

/** What the chip says, or null when it shows nothing. */
export function chipText(s: AssistantUiState): string | null {
  const steps = s.turn && s.turn.steps !== null && s.turn.stepsCap ? ` · ${s.turn.steps} of ${s.turn.stepsCap} steps` : '';
  switch (s.phase) {
    case 'thinking':
      return `Assistant · thinking${steps}`;
    case 'working':
      return `Assistant · ${s.call?.label ?? 'working'}${steps}`;
    case 'waiting':
      return `Assistant waits for you${s.note ? `: ${s.note}` : ''}`;
    case 'approve':
      return `Assistant: ${s.call?.label ?? 'this step'} · keep it?`;
    case 'paused':
      return `Assistant paused${s.note ? ` · ${s.note}` : ''}`;
    case 'ended':
      return s.turn ? `Assistant: ${s.turn.title || 'request'} · ${END_WORDS[s.turn.end ?? 'ended'] ?? 'ended'}` : null;
    default:
      return null;
  }
}

export function AssistantChip() {
  const services = useServices();
  const api = useStateStore(services.apis, (a) => a.assistant ?? null);
  const s = useStateStore(api?.state ?? NONE);
  const text = chipText(s);
  if (!text) return null;
  const busy = s.phase === 'working' || s.phase === 'thinking';
  return (
    <div className="cad-chip" data-chip="assistant" data-assistant-state={s.phase} role="status" aria-busy={busy || undefined}>
      {busy ? <span className="tree-spin cad-chip-spin" aria-hidden="true" /> : null}
      <span className="cad-chip-v" data-assistant-text="">
        {text}
      </span>
    </div>
  );
}
