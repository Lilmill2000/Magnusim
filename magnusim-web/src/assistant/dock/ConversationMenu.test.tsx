// The dock header's conversation menu (phase 4 spec 2.1, 2.2): groups, rows, Forget asked first.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow } from '../wire';
import { ConversationMenu, groupConversations } from './ConversationMenu';
import { resetDockStoreForTests } from './store';

const dialogs = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../workbench/dialogs', () => ({ confirmAction: dialogs.confirm }));

const row = (id: string, project: string | null, used: string, more: Partial<ConversationRow> = {}): ConversationRow => ({
  id,
  provider: 'openai_compatible',
  label: 'Local server',
  billing: 'free',
  model: 'm',
  project_id: project,
  project_title: project ? `Project ${project}` : null,
  created_at: used,
  last_used_at: used,
  running: null,
  full: null,
  title: `Title ${id}`,
  turns: [],
  dropped_turns: 0,
  ...more,
});

const LIST = [
  row('h1', null, '2026-10-20T09:00:00'),
  row('a1', 'A', '2026-10-20T10:00:00'),
  row('b1', 'B', '2026-10-20T11:00:00', { running: 't-1' }),
  row('a2', 'A', '2026-10-20T12:41:00'),
];

let posts: Array<{ url: string; status: number }> = [];
let answer = 200;

beforeEach(() => {
  resetDockStoreForTests();
  posts = [];
  answer = 200;
  dialogs.confirm.mockClear();
  dialogs.confirm.mockImplementation(async () => true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, status: answer });
        return new Response(JSON.stringify(answer === 200 ? { ok: true } : { ok: false, code: 'conversation_busy', error: 'busy' }), { status: answer });
      }
      return new Response(JSON.stringify({ ok: true, conversations: LIST }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDockStoreForTests();
});

describe('groupConversations', () => {
  it('Here (this project), Home, Other projects; newest first', () => {
    const g = groupConversations(LIST, 'A');
    expect([g.here, g.home, g.other].map((x) => x.map((r) => r.id))).toEqual([['a2', 'a1'], ['h1'], ['b1']]);
    // At Home, Here is Home's.
    const h = groupConversations(LIST, null);
    expect([h.here, h.home, h.other].map((x) => x.map((r) => r.id))).toEqual([['h1'], [], ['a2', 'b1', 'a1']]);
  });
});

describe('the menu', () => {
  const mount = (list = LIST, shown: ConversationRow | null = null) => {
    const onPick = vi.fn();
    const onNew = vi.fn();
    const r = render(<ConversationMenu list={list} shown={shown} projectId="A" onPick={onPick} onNew={onNew} />);
    return { ...r, onPick, onNew };
  };

  it('its button names the shown conversation, else "New conversation"; New has its label', () => {
    mount(LIST, null);
    expect(screen.getByText('New conversation', { selector: '.dock-menu-title' })).toBeTruthy();
    const neu = document.querySelector('[data-dock-new]') as HTMLElement;
    expect([neu.textContent, neu.getAttribute('aria-label')]).toEqual(['New', 'New conversation']);
  });

  it('lists the groups and rows with their provider, time and a working dot; a pick shows it and closes', async () => {
    const { container, onPick } = mount(LIST, LIST[1]);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    expect([...container.querySelectorAll('[data-dock-group]')].map((s) => s.getAttribute('data-dock-group'))).toEqual(['Here', 'Home', 'Other projects']);
    const a2 = container.querySelector('[data-dock-conversation="a2"]') as HTMLElement;
    expect(a2.querySelector('.dock-menu-row-meta')?.textContent).toBe('Local server · 12:41');
    expect(container.querySelector('[data-dock-conversation="b1"] [data-dock-working]')).toBeTruthy();
    expect(container.querySelector('[data-dock-conversation="a1"]')?.className).toBe('current');
    fireEvent.click(a2.querySelector('.dock-menu-row') as HTMLElement);
    expect(onPick).toHaveBeenCalledWith('a2');
    expect(container.querySelector('[data-dock-menu-list]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-dock-menu]'));
  });

  it('empty: says how long conversations last', () => {
    const { container } = mount([], null);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    expect(container.querySelector('.dock-menu-empty')?.textContent).toBe('No conversations yet. Magnusim keeps them while it runs; a restart clears them.');
  });

  it('Escape closes it and gives the keyboard back to its button, and goes no further', () => {
    const outer = vi.fn();
    const { container } = render(
      <div onKeyDown={(e) => outer(e.defaultPrevented)}>
        <ConversationMenu list={LIST} shown={null} projectId="A" onPick={() => undefined} onNew={() => undefined} />
      </div>,
    );
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    fireEvent.keyDown(container.querySelector('.dock-menu-row') as HTMLElement, { key: 'Escape' });
    expect(container.querySelector('[data-dock-menu-list]')).toBeNull();
    expect(outer).toHaveBeenLastCalledWith(true);
  });

  it('Forget asks first; Keep sends nothing; Forget posts and a shown one goes to a new one; 409 says to stop it first', async () => {
    const { container, onNew } = mount(LIST, LIST[1]);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    dialogs.confirm.mockImplementationOnce(async () => false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Forget Title a1' }));
    });
    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: 'Forget this conversation?',
      copy: "The Assistant forgets its messages; this can't be undone. What it changed in your projects stays.",
      yes: 'Forget',
      no: 'Keep',
      safe: true,
    });
    expect(posts).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Forget Title a1' }));
    });
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    expect(posts.map((p) => p.url)).toEqual(['/api/assistant/conversations/a1/forget']);
    answer = 409;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Forget Title b1' }));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A request is running in this conversation. Stop it first.'));
  });
});
