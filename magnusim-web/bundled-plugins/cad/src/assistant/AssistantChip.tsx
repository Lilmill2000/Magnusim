// The Assistant's chip in the dock (CAD tools spec §8.3): `[data-chip="assistant"]` with
// `data-assistant-state` the phase, its words in `[data-assistant-text]` ("Assistant · thinking ·
// 12 of 120 steps", "Assistant · Sketch Plate sketch · 12 of 120 steps", "Assistant waits for you:
// close the Fillet 2 panel", "Assistant: Extrude Boss · keep it?", "Assistant paused · you took
// over", "Assistant: <request> · done"), and its buttons (`data-assistant-action`):
//   thinking  Pause, Stop, Ask each step
//   working   Pause, Stop, Fast (or Watch), Ask each step
//   waiting   Pause, Stop
//   approve   Keep, Discard
//   paused    Resume, Stop
//   ended     Undo, while the turn's undo group is the newest step
// Stop shows only with the host's turn events. An ended turn also shows the Part's health
// (health.ts: "· Fillet 1 fails", "· 1 sketch under-defined"; `data-assistant-health` ok, warn or
// error, the chip amber or red when not ok), and a click on those words selects the first such
// tree row. Nothing shows while the Assistant is off or idle.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { selectItem } from '../lib/selection';
import { createStateStore, useStateStore } from '../lib/store';
import type { AssistantActions, AssistantUiState } from '../types/assistant';
import type { DocState } from '../types/doc-service';
import { healthOf } from './health';
import { INITIAL_STATE } from './state';

const NONE = createStateStore<AssistantUiState>({ ...INITIAL_STATE });
const NO_DOC = createStateStore<{ doc: DocState | null }>({ doc: null });

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

export interface ChipButton {
  id: 'pause' | 'resume' | 'stop' | 'pace' | 'ask' | 'keep' | 'discard' | 'undo';
  label: string;
  title: string;
  pressed?: boolean;
}

/** The chip's buttons in a phase (`undo`: the ended turn's group is the newest step). */
export function chipButtons(s: AssistantUiState, undo: boolean): ChipButton[] {
  const stop: ChipButton[] = s.canStop ? [{ id: 'stop', label: 'Stop', title: 'Stop the request: the step it is on now is not kept' }] : [];
  const pause: ChipButton = { id: 'pause', label: 'Pause', title: 'Pause: its edits wait until you resume (it can still read the Part)' };
  const ask: ChipButton = { id: 'ask', label: 'Ask each step', title: s.askEach ? 'Stop asking before each step is kept' : 'Ask before each step is kept (Keep or Discard)', pressed: !!s.askEach };
  const pace: ChipButton = s.pace === 'fast' ? { id: 'pace', label: 'Watch', title: 'Watch each step being made' } : { id: 'pace', label: 'Fast', title: 'Make each step at once, without waits' };
  switch (s.phase) {
    case 'thinking':
      return [pause, ...stop, ask];
    case 'working':
      return [pause, ...stop, pace, ask];
    case 'waiting':
      return [pause, ...stop];
    case 'approve':
      return [
        { id: 'keep', label: 'Keep', title: 'Keep this step' },
        { id: 'discard', label: 'Discard', title: 'Discard this step: the Part goes back to before it' },
      ];
    case 'paused':
      return [{ id: 'resume', label: 'Resume', title: 'Let the Assistant edit the Part again' }, ...stop];
    case 'ended':
      return undo ? [{ id: 'undo', label: 'Undo', title: "Undo the Assistant's changes of this request (one Ctrl+Z)" }] : [];
    default:
      return [];
  }
}

function run(actions: AssistantActions | undefined, b: ChipButton, s: AssistantUiState) {
  if (!actions) return;
  switch (b.id) {
    case 'pause':
      actions.pause();
      break;
    case 'resume':
      actions.resume();
      break;
    case 'stop':
      actions.stop();
      break;
    case 'pace':
      actions.setPace(s.pace === 'fast' ? 'watch' : 'fast');
      break;
    case 'ask':
      actions.setAskEach(!s.askEach);
      break;
    case 'keep':
      actions.keep();
      break;
    case 'discard':
      actions.discard();
      break;
    case 'undo':
      actions.undo();
      break;
  }
}

export function AssistantChip() {
  const services = useServices();
  const api = useStateStore(services.apis, (a) => a.assistant ?? null);
  const s = useStateStore(api?.state ?? NONE);
  const ended = s.phase === 'ended' && !!s.turn;
  const turnId = s.turn?.id ?? null;
  // The Part's health and the turn's Undo, read once the turn ended.
  const docState = services.doc?.state ?? null;
  const end = useStateStore<DocState | { doc: DocState | null }, { health: 'ok' | 'warn' | 'error'; words: string; first: string | null; undo: boolean }>(docState ?? NO_DOC, (x) => {
    const d = docState ? (x as DocState) : null;
    if (!ended || !d) return { health: 'ok', words: '', first: null, undo: false };
    const h = healthOf(d);
    const top = services.doc.assistant?.topGroup?.() ?? null;
    return { health: h.health, words: h.words.join(' · '), first: h.first, undo: !!top && top.tag === `turn:${turnId}` };
  });
  const text = chipText(s);
  if (!text) return null;
  const busy = s.phase === 'working' || s.phase === 'thinking';
  const buttons = chipButtons(s, end.undo);
  const cls = ['cad-chip', 'cad-assistant-chip', ended && end.health === 'error' ? 'is-error' : '', ended && end.health === 'warn' ? 'is-warning' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-chip="assistant" data-assistant-state={s.phase} data-assistant-health={ended ? end.health : undefined} role="status" aria-busy={busy || undefined}>
      {busy ? <span className="tree-spin cad-chip-spin" aria-hidden="true" /> : null}
      <span className="cad-chip-v" data-assistant-text="">
        {text}
      </span>
      {ended && end.words ? (
        <button
          type="button"
          className="cad-chip-link cad-assistant-health"
          data-assistant-health-text=""
          title="Show it in the tree"
          onClick={() => {
            if (end.first) selectItem(services.selection, { kind: 'feature', feature: end.first }, false);
          }}
        >
          · {end.words}
        </button>
      ) : null}
      {buttons.map((b) => (
        <button key={b.id} type="button" className="cad-chip-link" data-assistant-action={b.id} title={b.title} aria-pressed={b.pressed === undefined ? undefined : b.pressed} onClick={() => run(api?.actions, b, s)}>
          {b.pressed ? `${b.label} ✓` : b.label}
        </button>
      ))}
    </div>
  );
}
