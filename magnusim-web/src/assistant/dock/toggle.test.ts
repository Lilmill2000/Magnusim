import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantKeys, resetAppKeysForTests } from '../../keybinds/appKeys';
import { announcePref } from '../../workspace/prefsChannel';
import { resetStatusStore } from '../status';
import { AssistantDock } from './AssistantDock';
import { dockSnapshot, resetDockForTests, setDockPill } from './dockState';
import { dockShortcut, installDockToggle, isDockKey } from './toggle';

vi.mock('../../wizard/controller', () => ({ openSetupWizard: vi.fn() }));
// The frame and the keys only: no conversation (its store sets the pill itself).
vi.mock('./content', () => ({ useDockContent: () => null }));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

/** The page around the dock: a field and the app's dialogs (the corner button is the dock's own). */
const PAGE = `
  <div id="home"><input id="search" /></div>
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
  resetAppKeysForTests();
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
  resetAppKeysForTests();
});

describe('isDockKey: Ctrl+/ (Cmd+/ on macOS), or the keys the person chose', () => {
  const k = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it("the person's keys replace Ctrl+/ on every platform; [] is no key", () => {
    for (const mac of [false, true]) {
      expect(isDockKey(k({ key: 'k', code: 'KeyK', ctrlKey: true }), mac, ['Ctrl+KeyK'])).toBe(true);
      expect(isDockKey(k({ key: 'k', code: 'KeyK', metaKey: true }), mac, ['Ctrl+KeyK'])).toBe(true);
      expect(isDockKey(k({ key: '/', code: 'Slash', ctrlKey: true }), mac, ['Ctrl+KeyK'])).toBe(false);
      expect(isDockKey(k({ key: '/', code: 'Slash', ctrlKey: true, metaKey: true }), mac, [])).toBe(false);
      expect(isDockKey(k({ key: 'F9', code: 'F9' }), mac, ['F9'])).toBe(true);
    }
  });
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

describe('the corner button and Ctrl+/', () => {
  async function mount() {
    const view = render(createElement(AssistantDock));
    await act(async () => undefined);
    return view;
  }
  const settingsButton = () => $('[data-dock-open-settings]');

  it("the corner button is always there while the dock is closed and opens it; the page knows which shows (Daniel: no header button, a corner button that's always there)", async () => {
    await mount();
    const corner = $('[data-assistant-pill]');
    const open = $('[data-assistant-pill] .assistant-dock-pill-open');
    expect(corner).not.toHaveAttribute('hidden');
    expect(open).toHaveAccessibleName('Assistant');
    expect(open).toHaveTextContent('Assistant');
    expect(document.body).toHaveClass('assistant-corner-shown');
    act(() => open.click());
    expect(dockSnapshot().open).toBe(true);
    expect(corner).toHaveAttribute('hidden');
    expect(document.body).toHaveClass('assistant-dock-open');
    expect(document.body).not.toHaveClass('assistant-corner-shown');
    act(() => $('[data-dock-close]').click());
    expect(dockSnapshot().open).toBe(false);
    expect(corner).not.toHaveAttribute('hidden');
    expect(document.body).not.toHaveClass('assistant-dock-open');
    expect(document.body).toHaveClass('assistant-corner-shown');
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

  it("the person's key (Settings → Keybinds) opens and closes it instead of Ctrl+/, and a change made in another tab takes at once; no key leaves the corner button", async () => {
    const STATUS = { ok: true, available: true, provider: 'off', providers_ready: {} };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(JSON.stringify(String(url).startsWith('/api/prefs') ? { ok: true, keybinds: { 'app.assistant': ['Alt+KeyK'] } } : STATUS))),
    );
    await mount();
    await vi.waitFor(() => expect(assistantKeys()).toEqual(['Alt+KeyK']));
    $('#search').focus();
    expect(ctrlSlash().defaultPrevented).toBe(false);
    expect(dockSnapshot().open).toBe(false);
    expect(key({ key: 'k', code: 'KeyK', altKey: true }).defaultPrevented).toBe(true);
    expect(dockSnapshot().open).toBe(true);
    await vi.waitFor(() => expect(document.activeElement).toBe(settingsButton()));
    announcePref('', 'keybinds', { 'app.assistant': ['F9'] }, 'settings:other');
    await vi.waitFor(() => expect(assistantKeys()).toEqual(['F9']));
    key({ key: 'k', code: 'KeyK', altKey: true });
    expect(dockSnapshot().open).toBe(true);
    key({ key: 'F9', code: 'F9' });
    expect(dockSnapshot().open).toBe(false);
    expect(document.activeElement).toBe($('#search'));
    announcePref('', 'keybinds', { 'app.assistant': [] }, 'settings:other');
    await vi.waitFor(() => expect(assistantKeys()).toEqual([]));
    key({ key: 'F9', code: 'F9' });
    ctrlSlash();
    expect(dockSnapshot().open).toBe(false);
    act(() => $('[data-assistant-pill] .assistant-dock-pill-open').click());
    expect(dockSnapshot().open).toBe(true);
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

  it("the corner button says what is going on: a question, working, done; 'Assistant' when idle", async () => {
    await mount();
    const corner = $('[data-assistant-pill]');
    const words = () => [corner.getAttribute('data-pill'), $('.assistant-dock-pill-text').textContent];
    expect(words()).toEqual([null, 'Assistant']);
    act(() => setDockPill({ kind: 'question', text: 'Assistant asks: Reset?' }));
    expect(words()).toEqual(['question', 'Assistant asks: Reset?']);
    act(() => setDockPill({ kind: 'running', text: 'Assistant · Thinking…' }));
    expect(words()).toEqual(['running', 'Assistant · Thinking…']);
    act(() => setDockPill({ kind: 'done', text: 'Assistant: done' }));
    expect(words()).toEqual(['done', 'Assistant: done']);
    act(() => setDockPill(null));
    expect(words()).toEqual([null, 'Assistant']);
    expect(corner).not.toHaveAttribute('hidden');
  });

  it('unmounting unwires the key and the page classes', async () => {
    const view = await mount();
    view.unmount();
    ctrlSlash();
    expect(dockSnapshot().open).toBe(false);
    expect(document.body).not.toHaveClass('assistant-corner-shown');
  });

  it('installDockToggle works on a page with nothing else in it', () => {
    document.body.innerHTML = '';
    const undo = installDockToggle();
    ctrlSlash({}, document.body);
    expect(dockSnapshot().open).toBe(true);
    undo();
  });
});
