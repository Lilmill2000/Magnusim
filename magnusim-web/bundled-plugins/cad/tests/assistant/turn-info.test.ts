// @vitest-environment node
// The turns the host tells this page of (turn-info.ts, CAD tools spec H3): facts kept per turn id
// (title, local, context, images, used, end); an ended turn stays ended; the newest 16 ended turns
// are kept; listeners hear each event; odd or missing fields read as unknown.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantTurn } from '@magnusim/workspace';
import { describe, expect, it } from 'vitest';
import { createTurnInfo, factsOf } from '../../src/assistant/turn-info';

const turn = (over: Partial<AssistantTurn> & { id: string }): AssistantTurn => ({
  state: 'running',
  title: 'Plate with four holes',
  local: false,
  contextTokens: null,
  images: true,
  used: { steps: 2, stepsCap: 120, changes: 0, changesCap: 0, usd: 0.12, usdCap: 8 },
  ...over,
});

describe('turn info', () => {
  it('keeps each turn by id, the running ones, and how one ended', () => {
    const t = createTurnInfo();
    const heard: string[] = [];
    t.subscribe((f) => heard.push(`${f.id}:${f.state}`));
    t.take(turn({ id: 't-1' }));
    expect(t.running().map((f) => f.id)).toEqual(['t-1']);
    expect(t.forKey('turn:t-1')).toMatchObject({ title: 'Plate with four holes', local: false, images: true, used: { steps: 2, stepsCap: 120 } });
    expect(t.forKey('ext:1')).toBeNull();
    t.take(turn({ id: 't-1', used: { steps: 5, stepsCap: 120, changes: 0, changesCap: 0, usd: 0.3, usdCap: 8 } }));
    expect(t.get('t-1')?.used.steps).toBe(5);
    t.take(turn({ id: 't-1', state: 'ended', end: { state: 'done', reason: 'done' } }));
    expect(t.running()).toEqual([]);
    expect(t.get('t-1')).toMatchObject({ state: 'ended', end: { state: 'done', reason: 'done' } });
    // A late running event of an ended turn changes nothing.
    t.take(turn({ id: 't-1' }));
    expect(t.get('t-1')?.state).toBe('ended');
    expect(heard).toEqual(['t-1:running', 't-1:running', 't-1:ended']);
  });

  it("keeps a coding agent's turn's changes of its change limit (a workspace tells its model what is left)", () => {
    const t = createTurnInfo();
    t.take(turn({ id: 't-agent', images: null, used: { steps: 5, stepsCap: 400, changes: 3, changesCap: 24, usd: 0, usdCap: 0 } }));
    expect(t.forKey('turn:t-agent')?.used).toEqual({ steps: 5, stepsCap: 400, changes: 3, changesCap: 24, usd: 0, usdCap: 0 });
  });

  it('keeps the newest 16 ended turns and every running one', () => {
    const t = createTurnInfo();
    for (let i = 0; i < 20; i++) t.take(turn({ id: `t-${i}`, state: 'ended' }));
    t.take(turn({ id: 't-run' }));
    expect(t.all().map((f) => f.id)).toEqual([...Array.from({ length: 16 }, (_, i) => `t-${i + 4}`), 't-run']);
  });

  it('reads odd or missing fields as unknown', () => {
    const f = factsOf({ id: 't-x', state: 'ended', title: 7, used: null, contextTokens: 'big', images: 'yes', end: { state: 'gone' } } as unknown as AssistantTurn);
    expect(f).toEqual({ id: 't-x', state: 'ended', title: '', local: false, contextTokens: null, images: null, used: { steps: 0, stepsCap: 0, changes: 0, changesCap: 0, usd: 0, usdCap: 0 }, end: null });
    const t = createTurnInfo();
    t.take({} as AssistantTurn);
    expect(t.all()).toEqual([]);
  });
});
