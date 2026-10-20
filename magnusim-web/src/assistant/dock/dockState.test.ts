import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDock, DONE_PILL_MS, dockSnapshot, focusDock, openDock, resetDockForTests, setDockPill, subscribeDock, toggleDock } from './dockState';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

beforeEach(() => {
  resetDockForTests();
  document.body.className = '';
  document.body.innerHTML = `
    <div id="home"><button type="button" id="home-assistant">Assistant</button><input id="search" /></div>
    <div id="app" hidden><button type="button" id="wb-assistant">Assistant</button></div>
    <aside id="assistant-dock" tabindex="-1"><button type="button" id="inside">Open Settings</button></aside>
    <div data-assistant-pill="1"><button type="button" id="pill">Assistant · working</button></div>`;
});

afterEach(() => {
  vi.useRealTimers();
  resetDockForTests();
});

describe("the dock's place: open, pill, closed", () => {
  it('starts closed with nothing to show; opens and closes', () => {
    expect(dockSnapshot()).toMatchObject({ open: false, size: 'closed', pill: null, badge: null });
    const heard = vi.fn();
    const off = subscribeDock(heard);
    openDock();
    expect(dockSnapshot()).toMatchObject({ open: true, size: 'open' });
    closeDock();
    expect(dockSnapshot()).toMatchObject({ open: false, size: 'closed' });
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    toggleDock();
    expect(dockSnapshot().open).toBe(true);
    toggleDock();
    expect(dockSnapshot().open).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('closed with something worth seeing is the pill; its kind is the buttons\' badge, open or not', () => {
    const stop = vi.fn();
    setDockPill({ kind: 'running', text: 'Assistant · Thinking…', onStop: stop });
    expect(dockSnapshot()).toMatchObject({ size: 'pill', badge: 'working' });
    openDock();
    expect(dockSnapshot()).toMatchObject({ size: 'open', badge: 'working' });
    closeDock();
    expect(dockSnapshot().size).toBe('pill');
    setDockPill({ kind: 'question', text: 'Assistant asks: Reset the counter?…' });
    expect(dockSnapshot()).toMatchObject({ size: 'pill', badge: 'question' });
    setDockPill(null);
    expect(dockSnapshot()).toMatchObject({ size: 'closed', badge: null });
  });

  it('an end shows the pill for 120 s, or until the dock opens', () => {
    vi.useFakeTimers();
    setDockPill({ kind: 'done', text: 'Assistant: done' });
    expect(dockSnapshot()).toMatchObject({ size: 'pill', badge: 'done' });
    vi.advanceTimersByTime(DONE_PILL_MS - 1);
    expect(dockSnapshot().size).toBe('pill');
    vi.advanceTimersByTime(1);
    expect(dockSnapshot()).toMatchObject({ size: 'closed', pill: null, badge: null });

    setDockPill({ kind: 'done', text: 'Assistant: stopped' });
    openDock();
    expect(dockSnapshot()).toMatchObject({ size: 'open', pill: null, badge: null });
    closeDock();
    expect(dockSnapshot().size).toBe('closed');

    // A newer pill is not taken away by an older end's timer.
    setDockPill({ kind: 'done', text: 'Assistant: done' });
    vi.advanceTimersByTime(DONE_PILL_MS / 2);
    setDockPill({ kind: 'running', text: 'Assistant · Starting…' });
    vi.advanceTimersByTime(DONE_PILL_MS);
    expect(dockSnapshot().pill?.kind).toBe('running');
  });

  it('opening asks for the keyboard once each time; focusDock asks again while open', () => {
    const seq = () => dockSnapshot().focusSeq;
    openDock();
    expect(seq()).toBe(1);
    focusDock();
    expect(seq()).toBe(2);
    closeDock();
    expect(seq()).toBe(2);
    openDock({ focus: false });
    expect(seq()).toBe(2);
  });
});

describe('closing gives the keyboard back', () => {
  it('to the opener when the keyboard was in the dock', () => {
    $('#search').focus();
    openDock();
    $('#inside').focus();
    closeDock();
    expect(document.activeElement).toBe($('#search'));
  });

  it("to the button that opened it, even when the click didn't focus it", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    toggleDock($('#home-assistant'));
    $('#inside').focus();
    toggleDock();
    expect(document.activeElement).toBe($('#home-assistant'));
  });

  it('leaves it alone when it is not in the dock', () => {
    openDock({ from: $('#home-assistant') });
    $('#search').focus();
    closeDock();
    expect(document.activeElement).toBe($('#search'));
  });

  it('with the opener gone: to the button the person can see', () => {
    openDock({ from: $('#home-assistant') });
    $('#inside').focus();
    // Home went away for the workbench.
    $('#home').hidden = true;
    $('#app').hidden = false;
    closeDock();
    expect(document.activeElement).toBe($('#wb-assistant'));
  });

  it('over a workspace with the opener gone: left in the panel, for the overlay to give to the frame', () => {
    document.body.classList.add('workspace-open');
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.focus();
    openDock();
    $('#inside').focus();
    frame.remove();
    closeDock();
    expect(document.activeElement).toBe($('#inside'));
  });

  it('opening from inside the dock or the pill keeps the earlier opener', () => {
    $('#search').focus();
    openDock();
    closeDock();
    setDockPill({ kind: 'question', text: 'Assistant asks: Reset?' });
    $('#pill').focus();
    openDock({ from: $('#pill') });
    expect(dockSnapshot().open).toBe(true);
    $('#inside').focus();
    focusDock();
    closeDock();
    // The pill isn't an opener: it hides as the dock opens. The button the person can see takes it.
    expect(document.activeElement).toBe($('#home-assistant'));
  });
});
