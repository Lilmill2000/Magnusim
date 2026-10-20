// The dock's live region (phase 4 spec 10.1): at most one message per 3 s, merged; silent when
// the tab is hidden or a question card has focus. Fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '../wire';
import { applyEvents, emptyTurnView } from './turnView';
import { createAnnouncer, LIVE_GAP_MS, LIVE_REGION_ID, liveMessagesOf, mergeLive } from './live';

let said: string[] = [];
let hidden = false;
let inCard = false;
const announcer = () => createAnnouncer({ now: () => Date.now(), hidden: () => hidden, focusInCard: () => inCard, write: (t) => said.push(t) });

beforeEach(() => {
  vi.useFakeTimers();
  said = [];
  hidden = false;
  inCard = false;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the announcer', () => {
  it('says the first at once, then at most one per gap, merging what came within it', () => {
    const a = announcer();
    a.say({ kind: 'start', text: 'The Assistant is working.' });
    expect(said).toEqual(['The Assistant is working.']);
    a.say({ kind: 'step', text: 'Add: done' });
    a.say({ kind: 'step', text: 'Add: done' });
    a.say({ kind: 'step', text: 'Reset: failed' });
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(LIVE_GAP_MS - 1);
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(['The Assistant is working.', '3 steps done.']);
    // One alone within a gap is said as it is.
    a.say({ kind: 'step', text: 'Add: done' });
    vi.advanceTimersByTime(LIVE_GAP_MS);
    expect(said[2]).toBe('Add: done');
    // After a quiet gap, at once again.
    vi.advanceTimersByTime(LIVE_GAP_MS);
    a.say({ kind: 'end', text: 'Stopped: Stopped.' });
    expect(said[3]).toBe('Stopped: Stopped.');
  });

  it('a turn\'s end within the gap goes with the steps and replaces its start and a wait', () => {
    expect(
      mergeLive([
        { kind: 'start', text: 'The Assistant is working.' },
        { kind: 'step', text: 'Add: done' },
        { kind: 'waiting', text: 'The Assistant waits for you in CAD.' },
        { kind: 'step', text: 'Add: done' },
        { kind: 'end', text: 'The Assistant finished: All set.' },
      ]),
    ).toBe('2 steps done. The Assistant finished: All set.');
    expect(mergeLive([{ kind: 'start', text: 'The Assistant is working.' }, { kind: 'waiting', text: 'The Assistant waits for you in CAD.' }])).toBe(
      'The Assistant is working. The Assistant waits for you in CAD.',
    );
  });

  it('says nothing while the tab is hidden or a card has focus, and keeps nothing for later', () => {
    const a = announcer();
    hidden = true;
    a.say({ kind: 'start', text: 'The Assistant is working.' });
    vi.advanceTimersByTime(LIVE_GAP_MS * 2);
    expect(said).toEqual([]);
    hidden = false;
    inCard = true;
    a.say({ kind: 'step', text: 'Add: done' });
    expect(said).toEqual([]);
    inCard = false;
    a.say({ kind: 'step', text: 'Reset: done' });
    expect(said).toEqual(['Reset: done']);
    // Hidden by the time the gap ends: what waited is dropped.
    a.say({ kind: 'step', text: 'Add: done' });
    hidden = true;
    vi.advanceTimersByTime(LIVE_GAP_MS);
    hidden = false;
    vi.advanceTimersByTime(LIVE_GAP_MS);
    expect(said).toEqual(['Reset: done']);
  });

  it('writes into #assistant-dock-live by default, and is silent while the document is hidden', () => {
    document.body.innerHTML = `<div id="${LIVE_REGION_ID}"></div><div data-gate="g1"><button id="no">No</button></div>`;
    const a = createAnnouncer();
    a.say({ kind: 'start', text: 'The Assistant is working.' });
    expect(document.getElementById(LIVE_REGION_ID)?.textContent).toBe('The Assistant is working.');
    vi.advanceTimersByTime(LIVE_GAP_MS);
    (document.getElementById('no') as HTMLButtonElement).focus();
    a.say({ kind: 'step', text: 'Add: done' });
    vi.advanceTimersByTime(LIVE_GAP_MS);
    expect(document.getElementById(LIVE_REGION_ID)?.textContent).toBe('The Assistant is working.');
    (document.activeElement as HTMLElement).blur();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    a.say({ kind: 'step', text: 'Add: done' });
    expect(document.getElementById(LIVE_REGION_ID)?.textContent).toBe('The Assistant is working.');
    vis.mockRestore();
    a.say({ kind: 'step', text: 'Add: done' });
    expect(document.getElementById(LIVE_REGION_ID)?.textContent).toBe('Add: done');
  });
});

describe("what a turn's new events say", () => {
  let seq = 0;
  const ev = (body: Record<string, unknown>): TurnEvent => ({ seq: ++seq, at: 0, ...body }) as TurnEvent;

  it('its start, each result, a wait that starts, and its end', () => {
    seq = 0;
    const first = [ev({ type: 'state', state: 'starting' }), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'add', title: 'Add', risk: 'edit', source: 'Demo', input_preview: '{}' })];
    const v0 = emptyTurnView('t1');
    const v1 = applyEvents(v0, first);
    expect(liveMessagesOf(v0, v1, first, 'CAD').map((m) => m.text)).toEqual(['The Assistant is working.']);
    const next = [
      ev({ type: 'tool_progress', call: 'c1', fraction: null, label: 'Keep or discard', waiting: true }),
      ev({ type: 'tool_progress', call: 'c1', fraction: null, label: 'Keep or discard', waiting: true }),
      ev({ type: 'tool_result', call: 'c1', ok: true, summary: 'Added', ms: 3 }),
      ev({ type: 'tool_call', step: 2, call: 'c2', tool: 'reset', title: 'Reset', risk: 'destructive', source: 'Demo', input_preview: '{}' }),
      ev({ type: 'tool_result', call: 'c2', ok: false, summary: 'Refused', ms: 1 }),
      ev({ type: 'text', step: 3, text: 'All set.' }),
      ev({ type: 'end', state: 'done', reason: 'done', message: null }),
    ];
    const v2 = applyEvents(v1, next);
    expect(liveMessagesOf(v1, v2, next, 'CAD').map((m) => [m.kind, m.text])).toEqual([
      ['waiting', 'The Assistant waits for you in CAD.'],
      ['step', 'Add: done'],
      ['step', 'Reset: failed'],
      ['end', 'The Assistant finished: All set.'],
    ]);
    // Replayed events say nothing again.
    expect(liveMessagesOf(v2, applyEvents(v2, next), next, 'CAD')).toEqual([]);
  });

  it('an end other than done says its label and message; a final text is cut at 200 characters', () => {
    seq = 0;
    const stop = [ev({ type: 'end', state: 'capped', reason: 'steps', message: 'The step limit is reached.' })];
    const v0 = emptyTurnView('t1');
    expect(liveMessagesOf(v0, applyEvents(v0, stop), stop, 'CAD')[0].text).toBe('Limit reached: The step limit is reached.');
    seq = 0;
    const long = [ev({ type: 'text', step: 1, text: 'x'.repeat(300) }), ev({ type: 'end', state: 'done', reason: 'done', message: null })];
    expect(liveMessagesOf(v0, applyEvents(v0, long), long, 'CAD')[0].text).toBe(`The Assistant finished: ${'x'.repeat(200)}`);
  });
});
