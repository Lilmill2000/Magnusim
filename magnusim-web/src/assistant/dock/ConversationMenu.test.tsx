// The dock header's conversation menu (phase 4 spec 2.1, 2.2): groups, rows, Forget asked first;
// History (the chats saved here, 31 days) and Clear history, asked first.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow, HistoryChat } from '../wire';
import { ConversationMenu, groupConversations } from './ConversationMenu';
import { dockStoreSnapshot, resetDockStoreForTests, setDockContext } from './store';

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

let posts: Array<{ url: string; status: number; body: unknown }> = [];
let answer = 200;
const saved = (id: string, title: string, prompt: string, ended: string): HistoryChat => ({
  id,
  title,
  provider: 'openai_compatible',
  label: 'Local server',
  model: 'm',
  started_at: ended,
  ended_at: ended,
  first_prompt: prompt,
  end_state: 'done',
  full: false,
});
/** The chats History lists for project A (newest first), until Clear history empties it. */
let historyA: HistoryChat[] = [];
let gets: string[] = [];

beforeEach(() => {
  resetDockStoreForTests();
  posts = [];
  answer = 200;
  gets = [];
  historyA = [saved('old-1', 'The clock', 'Build the clock frame', '2026-10-28T09:05:00'), saved('a1', 'Title a1', 'Hello', '2026-10-27T10:00:00')];
  dialogs.confirm.mockClear();
  dialogs.confirm.mockImplementation(async () => true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, status: answer, body: JSON.parse(String(init.body ?? '{}')) });
        if (url === '/api/assistant/history/clear' && answer === 200) {
          const removed = historyA.length;
          historyA = [];
          return new Response(JSON.stringify({ ok: true, removed }), { status: 200 });
        }
        return new Response(JSON.stringify(answer === 200 ? { ok: true } : { ok: false, code: 'conversation_busy', error: 'busy' }), { status: answer });
      }
      gets.push(url);
      if (url.startsWith('/api/assistant/history?')) return new Response(JSON.stringify({ ok: true, kept_days: 31, chats: historyA, total: historyA.length }), { status: 200 });
      if (url.startsWith('/api/assistant/history/')) return new Response(JSON.stringify({ ok: true, chat: historyA[0], total: 1, from: 0, next: null, requests: [] }), { status: 200 });
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

  it('empty: says how long conversations last, and History is still there', () => {
    const { container } = mount([], null);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    expect(container.querySelector('.dock-menu-empty')?.textContent).toBe('No conversations yet. Magnusim keeps them while it runs; History keeps what they said for 31 days.');
    expect([...container.querySelectorAll('.dock-menu-foot button')].map((b) => b.textContent)).toEqual(['History', 'Clear history']);
  });

  it("History lists this project's saved chats with their title, provider, when and first prompt; a saved one opens read only, an open one live", async () => {
    setDockContext({ project_id: 'A', workspace: null });
    const { container, onPick } = mount(LIST, null);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelector('[data-dock-history-list="ready"]')).not.toBeNull());
    expect(gets).toContain('/api/assistant/history?project=A');
    expect(container.querySelector('.dock-subhead')?.textContent).toBe('Chats saved in this project, newest first. Kept 31 days.');
    const rows = [...container.querySelectorAll('[data-dock-saved-chat]')];
    expect(rows.map((r) => r.getAttribute('data-dock-saved-chat'))).toEqual(['old-1', 'a1']);
    expect([...rows[0].querySelectorAll('span')].map((x) => x.textContent)).toEqual(['The clock', 'Local server · 28 Oct, 09:05', 'Build the clock frame']);
    // The conversations' groups give way to History; Back brings them again.
    expect(container.querySelector('[data-dock-group="Here"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-dock-history-back]') as HTMLElement);
    expect(container.querySelector('[data-dock-group="Here"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelector('[data-dock-saved-chat="a1"]')).not.toBeNull());
    // a1 is still open in this server: it shows live.
    fireEvent.click(container.querySelector('[data-dock-saved-chat="a1"] .dock-menu-row') as HTMLElement);
    expect(onPick).toHaveBeenCalledWith('a1');
    expect(container.querySelector('[data-dock-menu-list]')).toBeNull();
    // old-1 is not: read only, from History.
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelector('[data-dock-saved-chat="old-1"]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-saved-chat="old-1"] .dock-menu-row') as HTMLElement);
    });
    expect(dockStoreSnapshot().saved).toMatchObject({ project: 'A', id: 'old-1' });
    expect(gets).toContain('/api/assistant/history/old-1?project=A&from=0');
  });

  it('Clear history asks first; Keep sends nothing; Clear empties History and says how many went', async () => {
    const { container } = mount(LIST, null);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelectorAll('[data-dock-saved-chat]').length).toBe(2));
    dialogs.confirm.mockImplementationOnce(async () => false);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-clear-history]') as HTMLElement);
    });
    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: "Clear this project's chat history?",
      copy: "Magnusim deletes the chats it saved here; this can't be undone. Conversations still open stay, and what the Assistant changed in your projects stays.",
      yes: 'Clear history',
      no: 'Keep',
      safe: true,
    });
    expect(posts).toEqual([]);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-clear-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelector('[data-dock-history-empty]')?.textContent).toBe('No saved chats here in the last 31 days.'));
    expect(posts.map((p) => [p.url, p.body])).toEqual([['/api/assistant/history/clear', { project: 'A' }]]);
    expect(container.querySelector('[data-dock-history-notice]')?.textContent).toBe('Cleared 2 saved chats.');
  });

  it("on Home, History and Clear history are Home's", async () => {
    const onPick = vi.fn();
    const { container } = render(<ConversationMenu list={LIST} shown={null} projectId={null} onPick={onPick} onNew={() => undefined} />);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-history]') as HTMLElement);
    });
    await waitFor(() => expect(container.querySelector('[data-dock-history-list="ready"]')).not.toBeNull());
    expect(gets).toContain('/api/assistant/history?project=home');
    expect(container.querySelector('.dock-subhead')?.textContent).toBe('Chats saved on Home, newest first. Kept 31 days.');
    await act(async () => {
      fireEvent.click(container.querySelector('[data-dock-clear-history]') as HTMLElement);
    });
    expect(dialogs.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Clear Home's chat history?" }));
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ project: 'home' }]));
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
      copy: "The Assistant forgets its messages; this can't be undone. Its saved copy stays in History, and what it changed in your projects stays.",
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

  it("a mouse answers the confirm dialog (its click lands outside the menu, which closes): a 409 opens the menu again to say why; the next opening doesn't show it again", async () => {
    const { container } = mount(LIST, LIST[1]);
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    answer = 409;
    dialogs.confirm.mockImplementationOnce(async () => {
      // The dialog's Forget button: a pointerdown outside the menu.
      fireEvent.pointerDown(document.body);
      return true;
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Forget Title b1' }));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A request is running in this conversation. Stop it first.'));
    expect(container.querySelector('[data-dock-menu-list]')).not.toBeNull();
    // Closed by a click elsewhere, then opened again: no stale line.
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(container.querySelector('[data-dock-menu-list]')).toBeNull());
    fireEvent.click(container.querySelector('[data-dock-menu]') as HTMLElement);
    expect(container.querySelector('[data-dock-menu-list]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
