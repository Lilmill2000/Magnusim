// The running footer's and the pill's words (phase 4 spec 2.9), from a turn's view.
import { describe, expect, it } from 'vitest';
import type { TurnSummary } from '../wire';
import { countersOf, footerWords } from './pill';
import { emptyTurnView, type TurnPhase, type TurnView } from './turnView';

describe('footerWords', () => {
  it('one line per phase', () => {
    const cases: Array<[TurnPhase, string]> = [
      [{ kind: 'starting' }, 'Starting…'],
      [{ kind: 'answer_below' }, 'Waiting for your answer below.'],
      [{ kind: 'thinking' }, 'Thinking…'],
      [{ kind: 'agent_working', name: 'Helper' }, 'Helper is working…'],
      [{ kind: 'reviewing', round: 1, of: 2 }, 'Checking its work (round 1 of 2)…'],
      [{ kind: 'working', title: 'Extrude', label: null }, 'Working: Extrude'],
      [{ kind: 'working', title: 'Extrude', label: '2 of 5' }, 'Working: Extrude · 2 of 5'],
      [{ kind: 'waiting', label: 'Pick a face' }, 'Waits for you in CAD: Pick a face'],
      [{ kind: 'stopping', still: false }, 'Stopping…'],
      [{ kind: 'stopping', still: true }, 'Still stopping…'],
      [{ kind: 'ended', state: 'capped' }, 'Assistant: reached a limit'],
    ];
    for (const [phase, words] of cases) expect(footerWords(phase, 'CAD')).toBe(words);
  });
});

describe('countersOf', () => {
  const used = { steps: 4, steps_cap: 120, changes: 2, changes_cap: 30, usd: 0, usd_cap: 0, active_ms: 61_000, minutes_cap: 20 };
  const withSummary = (s: Partial<TurnSummary>): TurnView => ({ ...emptyTurnView('t1'), summary: { id: 't1', ...s } as TurnView['summary'] });

  it('nothing until the summary says; steps for a model; changes and tool calls for a coding agent', () => {
    expect(countersOf(emptyTurnView('t1'))).toBe('');
    expect(countersOf(withSummary({}))).toBe('');
    expect(countersOf(withSummary({ used, billing: 'usd' }))).toBe('4 of 120 steps · 1 of 20 min');
    expect(countersOf(withSummary({ used, billing: 'agent_account' }))).toBe('2 of 30 changes · 4 of 120 tool calls · 1 of 20 min');
    expect(countersOf(withSummary({ used, agent: { id: 'a', name: 'Helper', version: null } }))).toBe('2 of 30 changes · 4 of 120 tool calls · 1 of 20 min');
  });
});
