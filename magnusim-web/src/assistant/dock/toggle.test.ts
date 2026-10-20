import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStatusStore } from '../status';
import { AssistantDock } from './AssistantDock';
import { dockSnapshot, resetDockForTests, setDockPill } from './dockState';
import { dockShortcut, installDockToggle, isDockKey } from './toggle';

vi.mock('../../wizard/controller', () => ({ openSetupWizard: vi.fn() }));
// The frame and the keys only: no conversation (its store sets the pill itself).
vi.mock('./content', () => ({ useDockContent: () => null }));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

/** The page around the dock: Home's and the workbench's buttons, a field, and the app's dialogs. */
const PAGE = `
  <div id="home"><button type="button" id="home-assistant" aria-controls="assistant-dock" aria-expanded="false">Assistant</button><input id="search" /></div>
  <div id="app" hidden><button type="button" id="wb-assistant" aria-controls="assistant-dock" aria-expanded="false">Assistant</button></div>
  <div id="modal-confirm" hidden></div>
  <div id="modal-prompt" hidden></div>
  <div id="modal-link-choice" hidden></div>
  <div id="setup-wizard" hidden></div>`;

function key(init: KeyboardEventInit, target: EventTarget = document.activeElement || document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}
const ctrlSlash = (extra: KeyboardEventInit = {}) => key({ key: '/', code: 'Slash', ctrlKey: true, ...extra });

beforeEach(() => {
  resetDockForTests();
  resetStatusStore();
  document.body.className = '';
  document.body.innerHTML = PAGE;
  // The status: Off, so the open dock's entry is its Open Settings button.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, available: true, provider: 'off', providers_ready: {} }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDockForTests();
});

describe('isDockKey: Ctrl+/ (Cmd+/ on macOS)', () => {
  const k = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('takes Ctrl+/ elsewhere and Cmd+/ on a Mac, nothing else', () => {
    expect(isDockKey(k({ key: '/', code: 'Slash', ctrlKey: true }), false)).toBe(true);
    // A layout where / is Shift+7: the key says it.
    expect(isDockKey(k({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isDockKey(k({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isDockKey(k({ key: '/', code: 'Slash' }), false)).toBe(false);
    expect(isDockKey(k({ key: '/', code: 'Slash', ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isDockKey(k({ key: '/', code: 'Slash', metaKey: true }), false)).toBe(false);
    expect(isDockKey(k({ key: '/', code: 'Slash', metaKey: true }), true)).toBe(true);
    expect(isDockKey(k({ key: '/', code: 'Slash', ctrlKey: true }), true)).toBe(false);
  });
});

describe('the header buttons and Ctrl+/', () => {
  async function mount() {
    const view = render(createElement(AssistantDock));
    await act(async () => undefined);
    return view;
  }
  const settingsButton = () => $('[data-dock-open-settings]');

  it('a button toggles the dock and both say whether it is open', async () => {
    await mount();
    const home = $('#home-assistant');
    expect(home).toHaveAttribute('aria-expanded', 'false');
    act(() => home.click());
    expect(dockSnapshot().open).toBe(true);
    expect(home).toHaveAttribute('aria-expanded', 'true');
    expect($('#wb-assistant')).toHaveAttribute('aria-expanded', 'true');
    expect(document.body).toHaveClass('assistant-dock-open');
    act(() => home.click());
    expect(dockSnapshot().open).toBe(false);
    expect(home).toHaveAttribute('aria-expanded', 'false');
    expect(document.body).not.toHaveClass('assistant-dock-open');
  });

  it('Ctrl+/: open and focus, focus again from elsewhere, close from inside and give the keyboard back', async () => {
    await mount();
    $('#search').focus();
    const e = ctrlSlash();
    expect(e.defaultPrevented).toBe(true);
    expect(dockSnapshot().open).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(settingsButton()));
    // Open, the keyboard elsewhere: it comes back to the dock.
    $('#search').focus();
    ctrlSlash();
    expect(dockSnapshot().open).toBe(true);
    expect(document.activeElement).toBe(settingsButton());
    // Open, the keyboard in it: closed, and the keyboard back where it was.
    ctrlSlash();
    expect(dockSnapshot().open).toBe(false);
    expect(document.activeElement).toBe($('#search'));
    expect($('#assistant-dock')).toHaveAttribute('hidden');
  });

  it('does nothing while a dialog or Settings shows, or while composing', async () => {
    await mount();
    for (const id of ['modal-confirm', 'modal-prompt', 'modal-link-choice', 'setup-wizard']) {
      $(`#${id}`).hidden = false;
      const e = ctrlSlash();
      expect(e.defaultPrevented, id).toBe(false);
      expect(dockSnapshot().open, id).toBe(false);
      expect(dockShortcut(), id).toBe(false);
      $(`#${id}`).hidden = true;
    }
    $('#search').focus();
    ctrlSlash({ isComposing: true });
    expect(dockSnapshot().open).toBe(false);
    ctrlSlash();
    expect(dockSnapshot().open).toBe(true);
  });

  it('dockShortcut (the key a workspace frame forwards) does the same as the key', async () => {
    await mount();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.focus();
    let did = false;
    act(() => {
      did = dockShortcut();
    });
    expect(did).toBe(true);
    expect(dockSnapshot().open).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(settingsButton()));
    act(() => {
      did = dockShortcut();
    });
    expect(did).toBe(true);
    expect(dockSnapshot().open).toBe(false);
    expect(document.activeElement).toBe(frame);
  });

  it('badges: a question, working, done; none when idle', async () => {
    await mount();
    const badges = () => [$('#home-assistant'), $('#wb-assistant')].map((b) => b.getAttribute('data-assistant-badge'));
    expect(badges()).toEqual([null, null]);
    act(() => setDockPill({ kind: 'question', text: 'Assistant asks: Reset?' }));
    expect(badges()).toEqual(['question', 'question']);
    // The pill shows: the toasts keep clear of it (style.css).
    expect(document.body).toHaveClass('assistant-dock-pill');
    act(() => $('#home-assistant').click());
    expect(document.body).not.toHaveClass('assistant-dock-pill');
    expect(document.body).toHaveClass('assistant-dock-open');
    act(() => $('#home-assistant').click());
    expect(document.body).toHaveClass('assistant-dock-pill');
    act(() => setDockPill({ kind: 'running', text: 'Assistant · Thinking…' }));
    expect(badges()).toEqual(['working', 'working']);
    act(() => setDockPill({ kind: 'done', text: 'Assistant: done' }));
    expect(badges()).toEqual(['done', 'done']);
    act(() => setDockPill(null));
    expect(badges()).toEqual([null, null]);
    expect(document.body).not.toHaveClass('assistant-dock-pill');
  });

  it('unmounting unwires the buttons and the key', async () => {
    const view = await mount();
    view.unmount();
    act(() => $('#home-assistant').click());
    ctrlSlash();
    expect(dockSnapshot().open).toBe(false);
  });

  it('installDockToggle copes with a page without the buttons', () => {
    document.body.innerHTML = '';
    const undo = installDockToggle();
    ctrlSlash({}, document.body);
    expect(dockSnapshot().open).toBe(true);
    undo();
  });
});
