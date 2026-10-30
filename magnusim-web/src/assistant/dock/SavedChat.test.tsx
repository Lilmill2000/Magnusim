// A saved chat read in the dock (History): its prompts, tool step lines, the model's words and how
// each request ended; read only, with Continue in a new chat (not for a coding agent's) and New.
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryChat, HistoryRequest } from '../wire';
import { SavedBar, SavedChat } from './SavedChat';
import { dockStoreSnapshot, resetDockStoreForTests, type DockSaved } from './store';

const chat: HistoryChat = {
  id: 'c-old',
  title: 'The clock',
  provider: 'anthropic',
  label: 'Cloud A',
  model: 'm',
  started_at: '2026-10-28T09:00:00',
  ended_at: '2026-10-28T09:05:00',
  first_prompt: 'Build the frame',
  end_state: 'capped',
  full: true,
};
const request = (more: Partial<HistoryRequest> = {}): HistoryRequest => ({
  turn: 't1',
  conversation: 'c-old',
  prompt: 'Build the frame',
  pictures: 0,
  files: [],
  answer: 'Built it.',
  steps: [],
  steps_left_out: 0,
  end: { state: 'done', reason: 'end_turn', message: null },
  full: null,
  usage: { usd: 0.0123, estimated: false, tokens: 10, steps: 2, billing: 'usd' },
  started_by: 'window',
  started_at: '2026-10-28T09:00:00',
  ended_at: '2026-10-28T09:01:00',
  ...more,
});
const saved = (requests: HistoryRequest[], more: Partial<DockSaved> = {}): DockSaved => ({ project: 'p1', id: 'c-old', state: 'ready', chat, requests, total: requests.length, next: null, error: null, ...more });

beforeEach(() => {
  resetDockStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDockStoreForTests();
});

describe('a saved chat', () => {
  it("each request: the prompt, its pictures' count and files, its tool step lines, the model's words and its end", () => {
    const { container } = render(
      <SavedChat
        saved={saved([
          request({
            pictures: 2,
            files: ['frame.step'],
            steps: [
              { step: 1, tool: 'cad__extrude', title: 'Extrude', ok: true, code: null, line: 'Extruded 10 mm' },
              { step: 1, tool: 'cad__fillet', title: 'Fillet', ok: false, code: 'bad_values', line: 'Edge too short' },
            ],
            steps_left_out: 3,
          }),
          request({
            turn: 't2',
            prompt: 'And the hands',
            answer: 'Done: the hands. Left: the stand.',
            end: { state: 'capped', reason: 'conversation_full', message: 'This conversation is full: it holds 600 pictures. Start a new one.' },
            cut: ['answer'],
          }),
        ])}
      />,
    );
    const turns = [...container.querySelectorAll('[data-dock-saved-turn]')];
    expect(turns.map((t) => t.querySelector('[data-dock-prompt]')?.textContent)).toEqual(['Build the frame', 'And the hands']);
    expect(turns[0].querySelector('.dock-from')?.textContent).toBe('2 pictures sent (not saved)');
    expect(turns[0].querySelector('.dock-you-files')?.textContent).toBe('frame.step');
    expect([...turns[0].querySelectorAll('[data-dock-saved-step]')].map((p) => p.textContent)).toEqual(['✓ Extrude: Extruded 10 mm', '✗ Fillet: Edge too short (bad_values)']);
    expect(turns[0].textContent).toContain('3 more steps not saved');
    expect(turns[0].querySelector('[data-dock-text]')?.textContent).toBe('Built it.');
    expect(turns[0].querySelector('[data-turn-end="done"]')?.textContent).toBe('2 steps · $0.01');
    expect(turns[1].querySelector('[data-turn-end="capped"]')?.textContent).toBe('Limit reachedThis conversation is full: it holds 600 pictures. Start a new one.');
    expect(turns[1].textContent).toContain('Cut to fit what History keeps of one request.');
  });

  it('loading, an error, and Show more while there is a next page', () => {
    const { container, rerender } = render(<SavedChat saved={saved([], { state: 'loading', chat: null })} />);
    expect(container.textContent).toBe('Loading the saved chat…');
    rerender(<SavedChat saved={saved([request()], { next: 1, total: 2 })} />);
    expect(container.querySelector('[data-dock-saved-more]')?.textContent).toBe('Show more');
    rerender(<SavedChat saved={saved([], { state: 'error', error: 'No saved chat of that id here (History keeps 31 days).' })} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('No saved chat of that id here (History keeps 31 days).');
  });

  it('read only: Continue in a new chat carries it (its provider), New conversation leaves it; a coding agent\'s has no Continue', () => {
    const { container, rerender } = render(<SavedBar saved={saved([request()])} />);
    expect(container.querySelector('p')?.textContent).toMatch(/^A saved chat, last used 28 Oct, 09:05\. It is read only: Continue in a new chat takes up where it ended\.$/);
    fireEvent.click(container.querySelector('[data-dock-saved-continue]') as HTMLElement);
    expect(dockStoreSnapshot()).toMatchObject({ shown: null, saved: null, carry: { from: 'c-old', provider: 'anthropic', label: 'Cloud A' } });
    rerender(<SavedBar saved={saved([request()], { chat: { ...chat, provider: 'agent:helper', label: 'Helper' } })} />);
    expect(container.querySelector('[data-dock-saved-continue]')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('A saved chat, last used 28 Oct, 09:05. It is read only.');
    fireEvent.click(container.querySelector('[data-dock-new-line]') as HTMLElement);
    expect(dockStoreSnapshot()).toMatchObject({ shown: null, saved: null, carry: null });
  });
});
