/**
 * What the dock says in its live region (phase 4 spec 10.1): one `role="status"` element
 * (#assistant-dock-live); the transcript itself is `aria-live="off"`, so streamed text never
 * announces chunk by chunk.
 *
 * - At most one message per LIVE_GAP_MS. What comes within the gap waits and is said as one at
 *   its end: several steps as "3 steps done", and a turn's end in place of its start or a wait.
 * - Nothing is said (nor kept for later) while the tab is hidden, or while focus is in a
 *   question card (its own `alertdialog` is read).
 * - What a turn's new events say: its start ("The Assistant is working."), each result
 *   ("<title>: done" / "failed"), a call that starts waiting for the person, and its end.
 */
import { endLabel, LIVE_A_STEP, LIVE_WORKING, liveEnded, liveFinished, liveStepsDone, liveToolDone, liveToolFailed, liveWaiting } from './copy';
import { finalText, type TurnView } from './turnView';
import type { TurnEvent } from '../wire';

export const LIVE_GAP_MS = 3000;
export const LIVE_REGION_ID = 'assistant-dock-live';

export type LiveKind = 'start' | 'step' | 'waiting' | 'end';
export interface LiveMessage {
  kind: LiveKind;
  text: string;
}

/** What the announcer needs from the page (tests hand their own). */
export interface LiveDeps {
  now(): number;
  hidden(): boolean;
  focusInCard(): boolean;
  write(text: string): void;
}

const defaultDeps: LiveDeps = {
  now: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  focusInCard: () => {
    if (typeof document === 'undefined') return false;
    const el = document.activeElement;
    return !!(el && typeof el.closest === 'function' && el.closest('[data-gate]'));
  },
  write: (text) => {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(LIVE_REGION_ID);
    if (el) el.textContent = text;
  },
};

/** Messages said within one gap, as one. */
export function mergeLive(list: readonly LiveMessage[]): string {
  if (!list.length) return '';
  if (list.length === 1) return list[0].text;
  const steps = list.filter((m) => m.kind === 'step');
  const end = [...list].reverse().find((m) => m.kind === 'end');
  const parts: string[] = [];
  if (!end) {
    const start = list.find((m) => m.kind === 'start');
    if (start) parts.push(start.text);
  }
  if (steps.length === 1) parts.push(steps[0].text);
  else if (steps.length > 1) parts.push(liveStepsDone(steps.length));
  if (end) parts.push(end.text);
  else {
    const waiting = [...list].reverse().find((m) => m.kind === 'waiting');
    if (waiting) parts.push(waiting.text);
  }
  return parts.map((p) => (/[.!?…:]$/.test(p) ? p : `${p}.`)).join(' ');
}

export interface Announcer {
  say(m: LiveMessage): void;
  /** Drops what waits, and its timer. */
  dispose(): void;
}

export function createAnnouncer(deps: Partial<LiveDeps> = {}): Announcer {
  const d: LiveDeps = { ...defaultDeps, ...deps };
  let lastAt = -Infinity;
  let pending: LiveMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const silent = () => d.hidden() || d.focusInCard();
  const speak = (text: string) => {
    lastAt = d.now();
    d.write(text);
  };
  const flush = () => {
    timer = null;
    const list = pending;
    pending = [];
    if (!list.length || silent()) return;
    speak(mergeLive(list));
  };
  return {
    say(m) {
      if (silent()) return;
      const wait = lastAt + LIVE_GAP_MS - d.now();
      if (wait <= 0 && !timer) {
        speak(m.text);
        return;
      }
      pending.push(m);
      if (!timer) timer = setTimeout(flush, Math.max(0, wait));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}

/**
 * What a turn's new events say. `before`: the view before them (a call's earlier progress);
 * `after`: with them (titles, the final text); `workspace`: the name the waits say.
 */
export function liveMessagesOf(before: TurnView, after: TurnView, events: readonly TurnEvent[], workspace: string): LiveMessage[] {
  const out: LiveMessage[] = [];
  const fresh = events.filter((e) => e.seq > before.lastSeq).sort((a, b) => a.seq - b.seq);
  const tools = new Map<string, { title: string; waiting: boolean }>();
  for (const it of before.items) if (it.kind === 'tool') tools.set(it.call, { title: it.title, waiting: !!it.progress?.waiting });
  for (const it of after.items) if (it.kind === 'tool' && !tools.has(it.call)) tools.set(it.call, { title: it.title, waiting: false });
  for (const e of fresh) {
    if (e.type === 'state' && e.state === 'starting') out.push({ kind: 'start', text: LIVE_WORKING });
    else if (e.type === 'tool_result') {
      const title = tools.get(e.call)?.title || LIVE_A_STEP;
      out.push({ kind: 'step', text: e.ok ? liveToolDone(title) : liveToolFailed(title) });
    } else if (e.type === 'tool_progress') {
      const t = tools.get(e.call);
      const waiting = e.waiting === true;
      if (waiting && t && !t.waiting) out.push({ kind: 'waiting', text: liveWaiting(workspace) });
      if (t) t.waiting = waiting;
    } else if (e.type === 'end') {
      const label = endLabel(e.state);
      out.push({ kind: 'end', text: label ? liveEnded(label, e.message ?? null) : liveFinished(finalText(after)) });
    }
  }
  return out;
}
