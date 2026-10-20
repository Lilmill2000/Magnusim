/**
 * The words of a running turn's footer and of the pill (phase 4 spec 2.9), from a turn's view.
 * Pure: the store (store.ts) builds the pill with them, and the transcript's footer can use
 * the same words, so the two never drift.
 */
import { agentCounters, agentWorking, FOOTER_ANSWER_BELOW, FOOTER_STARTING, FOOTER_STILL_STOPPING, FOOTER_STOPPING, FOOTER_THINKING, pillDone, reviewFooter, stepCounters, waitsFor, working } from './copy';
import type { TurnPhase, TurnView } from './turnView';

/** The running footer's line for a phase (an ended turn's is its pill end). */
export function footerWords(phase: TurnPhase, workspace: string): string {
  switch (phase.kind) {
    case 'starting':
      return FOOTER_STARTING;
    case 'answer_below':
      return FOOTER_ANSWER_BELOW;
    case 'thinking':
      return FOOTER_THINKING;
    case 'agent_working':
      return agentWorking(phase.name);
    case 'reviewing':
      return reviewFooter(phase.round, phase.of);
    case 'working':
      return working(phase.title, phase.label);
    case 'waiting':
      return waitsFor(workspace, phase.label);
    case 'stopping':
      return phase.still ? FOOTER_STILL_STOPPING : FOOTER_STOPPING;
    case 'ended':
      return pillDone(phase.state);
  }
}

/** A turn's counters as the footer and the pill show them ('' until its summary says). */
export function countersOf(v: TurnView): string {
  const s = v.summary;
  const used = s?.used;
  if (!s || !used) return '';
  const agent = s.billing === 'agent_account' || !!s.agent || !!v.agent;
  return agent
    ? agentCounters(used.changes, used.changes_cap, used.steps, used.steps_cap, used.active_ms, used.minutes_cap)
    : stepCounters(used.steps, used.steps_cap, used.active_ms, used.minutes_cap);
}
