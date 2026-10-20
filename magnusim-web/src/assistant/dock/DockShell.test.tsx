import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStatusStore } from '../status';
import { closeDock, dockSnapshot, openDock, resetDockForTests, setDockPill } from './dockState';
import { DockShell, dockShellState } from './DockShell';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));
const fullscreen = vi.hoisted(() => ({ exit: vi.fn(async () => undefined) }));
vi.mock('../../workspace/leaveGuard', () => ({ exitFrameFullscreen: fullscreen.exit }));

const REMOTE = 'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

/** Each status read answers with the next of `answers` (the last one again when they run out). */
let answers: Array<() => Response | Promise<Response>> = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const OFF = { ok: true, available: true, provider: 'off', default_provider: 'off', spent_today_usd: 0, providers_ready: {} };
const READY = {
  ...OFF,
  providers_ready: { openai_compatible: { label: 'Local server', kind: 'server', ready: true, reason: null, billing: 'free', detail: '' } },
};

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const panel = () => $('#assistant-dock');

beforeEach(() => {
  resetDockForTests();
  resetStatusStore();
  wizard.open.mockClear();
  answers = [() => json(200, OFF)];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0])()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDockForTests();
});

describe('dockShellState: what the status alone decides', () => {
  it('loading, error and remote as the status store says; off only with nothing ready and the default Off', () => {
    expect(dockShellState({ state: 'loading' })).toBe('loading');
    expect(dockShellState({ state: 'error', message: 'x' })).toBe('error');
    expect(dockShellState({ state: 'remote', message: REMOTE })).toBe('remote');
    const ready = (s: Record<string, unknown>) => dockShellState({ state: 'ready', status: s as never });
    expect(ready(OFF)).toBe('off');
    // An older server without per-provider rows, default Off.
    expect(ready({ ok: true, available: true, provider: 'off' })).toBe('off');
    // Default Off, but a conversation may name a provider that is ready.
    expect(ready(READY)).toBeNull();
    // A default that isn't Off: the conversation says what is missing (the composer's line).
    expect(ready({ ...OFF, provider: 'anthropic', default_provider: 'anthropic' })).toBeNull();
    expect(ready({ ...OFF, provider: 'off', default_provider: undefined, providers_ready: { anthropic: { ready: false } } })).toBe('off');
  });
});

describe('the dock frame', () => {
  it('is always in the page, hidden until opened, with its sizes and the live region outside the panel', async () => {
    render(<DockShell />);
    expect(panel()).toHaveAttribute('hidden');
    expect(panel()).toHaveAttribute('aria-label', 'Assistant');
    expect(panel()).toHaveAttribute('data-dock-size', 'closed');
    expect(panel().tagName).toBe('ASIDE');
    const live = $('#assistant-dock-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(panel().contains(live)).toBe(false);
    expect($('[data-assistant-pill]')).toHaveAttribute('hidden');
    act(() => openDock());
    expect(panel()).not.toHaveAttribute('hidden');
    expect(panel()).toHaveAttribute('data-dock-size', 'open');
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'off'));
  });

  it('loading → off: the line, Open Settings (Settings → Assistant), and the keyboard moves to it from the panel', async () => {
    let answer: (r: Response) => void = () => undefined;
    answers = [() => new Promise<Response>((r) => (answer = r))];
    render(<DockShell />);
    act(() => openDock());
    expect(panel()).toHaveAttribute('data-assistant-dock-state', 'loading');
    expect(panel()).toHaveTextContent('Loading the Assistant…');
    expect(document.activeElement).toBe(panel());
    await act(async () => answer(json(200, OFF)));
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'off'));
    expect(panel()).toHaveTextContent('The Assistant is off. Choose a provider in Settings → Assistant.');
    const settings = screen.getByRole('button', { name: 'Open Settings' });
    expect(document.activeElement).toBe(settings);
    fireEvent.click(settings);
    expect(wizard.open).toHaveBeenCalledWith({ required: false, step: 'assistant' });
    // No conversation parts in this state.
    expect(panel().querySelector('[role="log"], .assistant-dock-composer, [data-dock-questions]')).toBeNull();
  });

  it("the server didn't answer: Try again reads the status again, showing Loading meanwhile", async () => {
    answers = [() => Promise.reject(new TypeError('fetch failed')), () => new Promise<Response>(() => undefined)];
    render(<DockShell />);
    act(() => openDock());
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'error'));
    expect(panel()).toHaveTextContent("Magnusim's server didn't answer.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'loading'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('over remote access: only the remote sentence, no conversation parts', async () => {
    answers = [() => json(403, { ok: false, available: false, reason: 'remote', error: REMOTE })];
    render(<DockShell content={{ state: 'ready', header: <button type="button">Menu</button>, log: <p>Hi</p>, composer: <textarea aria-label="Message to the Assistant" /> }} />);
    act(() => openDock());
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'remote'));
    expect($('[data-dock-remote]')).toHaveTextContent(REMOTE);
    expect($('[data-dock-remote]').textContent).toBe(REMOTE);
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(panel().querySelector('textarea, [role="log"]')).toBeNull();
  });

  it("with a provider ready, a conversation's parts fill it; empty without one", async () => {
    answers = [() => json(200, READY)];
    const view = render(<DockShell />);
    act(() => openDock());
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'empty'));
    const log = panel().querySelector('.assistant-dock-log') as HTMLElement;
    expect(log).toHaveAttribute('role', 'log');
    expect(log).toHaveAttribute('aria-live', 'off');
    expect(log).toBeEmptyDOMElement();
    view.rerender(
      <DockShell
        content={{
          state: 'running',
          header: <button type="button">New conversation</button>,
          questions: <div>Card</div>,
          log: <p>Working</p>,
          composer: <textarea aria-label="Message to the Assistant" />,
        }}
      />,
    );
    expect(panel()).toHaveAttribute('data-assistant-dock-state', 'running');
    expect($('.assistant-dock-head')).toContainElement(screen.getByRole('button', { name: 'New conversation' }));
    expect($('[data-dock-questions]')).toHaveTextContent('Card');
    expect($('.assistant-dock-log')).toHaveTextContent('Working');
    expect($('footer.assistant-dock-composer textarea')).not.toBeNull();
  });

  it('opening gives the keyboard to the composer, or to a marked entry (a question card)', async () => {
    answers = [() => json(200, READY)];
    const view = render(<DockShell content={{ state: 'ready', composer: <textarea aria-label="Message to the Assistant" /> }} />);
    await act(async () => openDock());
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message to the Assistant' }));
    act(() => closeDock());
    view.rerender(
      <DockShell
        content={{
          state: 'question',
          questions: (
            <button type="button" data-dock-autofocus="1">
              No
            </button>
          ),
          composer: <textarea aria-label="Message to the Assistant" />,
        }}
      />,
    );
    await act(async () => openDock());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'No' }));
  });

  it('the gear opens Settings → Assistant; × closes', async () => {
    render(<DockShell />);
    act(() => openDock());
    fireEvent.click(screen.getByRole('button', { name: 'Assistant settings' }));
    expect(wizard.open).toHaveBeenCalledWith({ required: false, step: 'assistant' });
    fireEvent.click(screen.getByRole('button', { name: 'Close the Assistant' }));
    expect(dockSnapshot().open).toBe(false);
    expect(panel()).toHaveAttribute('hidden');
  });

  it('Escape inside closes it, unless something inside used it first, or while composing', async () => {
    const used = (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    render(
      <DockShell
        content={{
          state: 'question',
          questions: (
            <button type="button" onKeyDown={used}>
              No
            </button>
          ),
          composer: <textarea aria-label="Message to the Assistant" />,
        }}
      />,
    );
    answers = [() => json(200, READY)];
    act(() => openDock());
    await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'question'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'No' }), { key: 'Escape' });
    expect(dockSnapshot().open).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(dockSnapshot().open).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(dockSnapshot().open).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(dockSnapshot().open).toBe(false);
  });

  it("an Escape that closed it goes no further; one used inside does (the workbench's own Escape keys)", async () => {
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    try {
      const used = (e: ReactKeyboardEvent) => {
        if (e.key === 'Escape') e.preventDefault();
      };
      render(
        <DockShell
          content={{
            state: 'ready',
            questions: (
              <button type="button" onKeyDown={used}>
                Menu
              </button>
            ),
            composer: <textarea aria-label="Message to the Assistant" />,
          }}
        />,
      );
      answers = [() => json(200, READY)];
      act(() => openDock());
      await waitFor(() => expect(panel()).toHaveAttribute('data-assistant-dock-state', 'ready'));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), { key: 'Escape' });
      expect(heard).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(dockSnapshot().open).toBe(false);
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', heard);
    }
  });

  it("reads the status again each time it opens, and ends a workspace frame's full screen", async () => {
    fullscreen.exit.mockClear();
    render(<DockShell />);
    expect(fullscreen.exit).not.toHaveBeenCalled();
    await act(async () => openDock());
    expect(fullscreen.exit).toHaveBeenCalledTimes(1);
    await act(async () => closeDock());
    await act(async () => openDock());
    expect(fullscreen.exit).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url) === '/api/assistant/status')).toBe(true);
  });
});

describe('the pill', () => {
  it('shows only while closed with something worth seeing: its words open the dock, its Stop stops', () => {
    render(<DockShell />);
    const pill = $('[data-assistant-pill]');
    expect(pill).toHaveAttribute('hidden');
    const stop = vi.fn();
    act(() => setDockPill({ kind: 'running', text: 'Assistant · Thinking… · 2 of 120 steps', onStop: stop }));
    expect(pill).not.toHaveAttribute('hidden');
    expect(pill).toHaveAttribute('data-pill', 'running');
    const open = screen.getByRole('button', { name: 'Assistant · Thinking… · 2 of 120 steps' });
    expect(open).toHaveTextContent('Assistant · Thinking… · 2 of 120 steps');
    fireEvent.click(screen.getByRole('button', { name: 'Stop the Assistant' }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dockSnapshot().open).toBe(false);
    fireEvent.click(open);
    expect(dockSnapshot().open).toBe(true);
    expect(pill).toHaveAttribute('hidden');
    act(() => closeDock());
    act(() => setDockPill({ kind: 'question', text: 'Assistant asks: Reset the counter?…' }));
    expect(pill).toHaveAttribute('data-pill', 'question');
    expect(screen.queryByRole('button', { name: 'Stop the Assistant' })).toBeNull();
  });
});
