import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAppKeysForTests } from '../../keybinds/appKeys';
import { ASSISTANT_FROM, KEYBINDS_PREF } from '../../keybinds/catalog';
import { fakeKeysServer } from '../../test/keybindsFake';
import { announcePref } from '../../workspace/prefsChannel';
import { KeybindsStep } from './KeybindsStep';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAppKeysForTests();
});

const row = (id: string) => document.querySelector(`[data-keybind="${id}"]`) as HTMLElement;
const keysIn = (id: string) => [...row(id).querySelectorAll('[data-keybind-keys] kbd')].map((k) => k.textContent);
const stored = (server: ReturnType<typeof fakeKeysServer>) => server.prefs.demo?.[KEYBINDS_PREF];
const live = () => document.querySelector('[data-keys-live]') as HTMLElement;
const button = (id: string, name: string) => within(row(id)).getByRole('button', { name });
/** A row's last word as shown (the live region reads it out). */
const noteIn = (id: string) => row(id).querySelector('[data-keybind-note]');
const conflictIn = (id: string) => row(id).querySelector('[data-keybind-conflict]') as HTMLElement | null;
/** What the live region says, without the mark that makes the same words twice a change. */
const MARKS = [String.fromCharCode(0x200b), String.fromCharCode(0x200c)];
const liveText = () => MARKS.reduce((t, m) => t.split(m).join(''), live().textContent!);
/** Demo's Reset all word, under its title. */
const demoNote = () => document.querySelector('[data-keys-plugin="demo"] [data-keys-plugin-note]');

/** The fake server's answers to `url` wait until the returned release is called. */
function hold(server: ReturnType<typeof fakeKeysServer>, url: string): () => void {
  const real = server.fetch.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === url) await held;
    return real(input, init);
  });
  return release;
}

/** Timers the test moves on itself (a row's Saved goes after 1.8 s); the rest of the page runs as it does. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

/** A press in the open recorder. */
function press(id: string, code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) {
  const capture = within(row(id)).getByRole('textbox');
  fireEvent.keyDown(capture, { code, key, ...mods });
}

async function open(prefs?: Record<string, unknown>) {
  const server = fakeKeysServer({ prefs: prefs ? { demo: { [KEYBINDS_PREF]: prefs } } : {} });
  render(<KeybindsStep />);
  await screen.findByText('Rectangle');
  return server;
}

/** The Assistant panel's row, the label its buttons name, and its default keys as the row shows them. */
const PANEL = 'app.assistant';
const PANEL_LABEL = 'Open or close the Assistant panel';
const PANEL_DEFAULTS = ['Ctrl+/', 'Ctrl+NumpadDivide'];

/** Settings with the Assistant panel's key the person chose (`app`), once the row shows it (`shown`). */
async function openWithPanelKey(app: Record<string, string[]>, shown: string[], prefs?: Record<string, unknown>) {
  const server = fakeKeysServer({ prefs: prefs ? { demo: { [KEYBINDS_PREF]: prefs } } : {}, app });
  render(<KeybindsStep />);
  await screen.findByText('Rectangle');
  await waitFor(() => expect(keysIn(PANEL)).toEqual(shown));
  return server;
}

/** A commands file whose Rename has F2 by default, a key the Assistant panel may have too. */
const F2_COMMANDS = {
  version: 1,
  contexts: [{ id: 'sketch', label: 'Sketch' }],
  commands: [
    { id: 'sketch.line', label: 'Line', group: 'Draw', context: 'sketch', keys: ['KeyL'] },
    { id: 'edit.rename', label: 'Rename', group: 'Edit', context: 'any', keys: ['F2'] },
  ],
};

/** Settings over F2_COMMANDS, with the person's Demo keys (`prefs`) and app keys (`app`). */
async function openF2(prefs?: Record<string, unknown>, app?: Record<string, string[]>) {
  const server = fakeKeysServer({ files: { '/plugins/demo/workspace/commands.json': F2_COMMANDS }, prefs: prefs ? { demo: { [KEYBINDS_PREF]: prefs } } : {}, app });
  render(<KeybindsStep />);
  await screen.findByText('Rename');
  return server;
}

describe('Settings → Keybinds', () => {
  it("lists the app's keys, the browser's in a fold, and each plugin's commands by group with their keys", async () => {
    await open({ 'sketch.line': ['Shift+KeyL'] });
    expect(keysIn('app.assistant')).toEqual(['Ctrl+/', 'Ctrl+NumpadDivide']);
    expect(within(row('app.close')).getByText('Escape')).toBeInTheDocument();
    const fold = document.querySelector('[data-keys-reserved]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText('Close the tab')).toBeInTheDocument();
    // The Assistant panel's key can be changed (no Reset while it has its defaults); the app's
    // other keys have nothing to press, and the section says so.
    expect(button('app.assistant', 'Change Open or close the Assistant panel')).toBeInTheDocument();
    expect(button('app.assistant', 'Clear Open or close the Assistant panel')).toBeInTheDocument();
    expect(within(row('app.assistant')).queryByRole('button', { name: /^Reset/ })).toBeNull();
    expect(within(row('app.close')).queryByRole('button')).toBeNull();
    expect(screen.getByText("The app's own keys work everywhere. You can change the Assistant panel's; the others can't be changed.")).toBeInTheDocument();
    const demo = document.querySelector('[data-keys-plugin="demo"]') as HTMLElement;
    expect(within(demo).getByText('Part workspace')).toBeInTheDocument();
    expect([...demo.querySelectorAll('.wiz-keys-group-title')].map((h) => h.textContent)).toEqual(['Draw', 'Features', 'View', 'Edit']);
    expect(keysIn('sketch.rectangle')).toEqual(['R']);
    expect(keysIn('sketch.line')).toEqual(['Shift+L']);
    expect(keysIn('edit.delete')).toEqual(['Delete', 'Backspace']);
    expect(within(row('view.fit')).getByText('Everywhere')).toBeInTheDocument();
    expect(within(row('sketch.rectangle')).getByText('Sketch')).toBeInTheDocument();
    // Each button names its command for a screen reader; Reset only where the keys are the person's own.
    expect(button('sketch.line', 'Change Line')).toBeInTheDocument();
    expect(button('sketch.line', 'Reset Line')).toBeInTheDocument();
    expect(within(row('sketch.rectangle')).queryByRole('button', { name: 'Reset Rectangle' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset all Demo keys' })).toBeEnabled();
  });

  it('Change takes the next key press and stores it at once; the keyboard goes back to Change', async () => {
    const server = await open();
    fireEvent.click(button('sketch.rectangle', 'Change Rectangle'));
    const capture = within(row('sketch.rectangle')).getByRole('textbox', { name: 'Press the new keys for Rectangle' });
    await waitFor(() => expect(document.activeElement).toBe(capture));
    // A modifier alone waits for the key.
    press('sketch.rectangle', 'ShiftLeft', 'Shift', { shiftKey: true });
    expect(capture).toHaveTextContent('Shift+…');
    press('sketch.rectangle', 'KeyR', 'R', { shiftKey: true });
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Shift+R']));
    expect(noteIn('sketch.rectangle')).toHaveTextContent('Saved');
    expect(liveText()).toBe('Saved');
    expect(stored(server)).toEqual({ 'sketch.rectangle': ['Shift+KeyR'] });
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.rectangle', 'Change Rectangle')));
  });

  it("refuses a key the app or the browser keeps and keeps listening; Escape cancels, its refusal goes, the keyboard is on Change", async () => {
    const server = await open();
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyW', 'w', { ctrlKey: true });
    expect(noteIn('sketch.line')).toHaveTextContent('Ctrl+W is kept for the browser and the system (Close the tab). Press another.');
    expect(liveText()).toBe('Ctrl+W is kept for the browser and the system (Close the tab). Press another.');
    press('sketch.line', 'Slash', '/', { ctrlKey: true });
    expect(noteIn('sketch.line')).toHaveTextContent("Ctrl+/ is the app's own key (Open or close the Assistant panel). Press another.");
    // Cmd counts as Ctrl.
    press('sketch.line', 'KeyR', 'r', { metaKey: true });
    expect(noteIn('sketch.line')).toHaveTextContent('Ctrl+R is kept for the browser and the system (Reload the page)');
    // A key no shortcut can name.
    press('sketch.line', 'CapsLock', 'Dead');
    expect(noteIn('sketch.line')).toHaveTextContent("Dead can't be a shortcut key. Press another.");
    expect(within(row('sketch.line')).getByRole('textbox')).toBeInTheDocument();
    press('sketch.line', 'Escape', 'Escape');
    expect(within(row('sketch.line')).queryByRole('textbox')).toBeNull();
    expect(noteIn('sketch.line')).toBeNull();
    expect(keysIn('sketch.line')).toEqual(['L']);
    expect(server.calls).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.line', 'Change Line')));
  });

  it("Escape in the recorder never reaches the Settings close; the recorder's Cancel and Tab change nothing", async () => {
    const server = await open();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'Escape', 'Escape');
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
    // Cancel: the recorder closes, the keyboard is on Change.
    fireEvent.click(button('sketch.line', 'Change Line'));
    fireEvent.click(button('sketch.line', 'Cancel changing Line'));
    expect(within(row('sketch.line')).queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.line', 'Change Line')));
    // Tab: the press is not taken; the person moves on, and the recorder lets go as it loses focus.
    fireEvent.click(button('sketch.line', 'Change Line'));
    const capture = within(row('sketch.line')).getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(capture));
    const tab = fireEvent.keyDown(capture, { code: 'Tab', key: 'Tab' });
    expect(tab).toBe(true);
    fireEvent.blur(capture);
    expect(within(row('sketch.line')).queryByRole('textbox')).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it('a key another command has asks Replace or Cancel (the keyboard on Replace); Replace takes it from that command', async () => {
    const server = await open();
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyF', 'f');
    await waitFor(() => expect(conflictIn('sketch.line')).toBeTruthy());
    const conflict = conflictIn('sketch.line')!;
    expect(conflict).toHaveTextContent('F is already the key of Fit (Everywhere).');
    await waitFor(() => expect(document.activeElement).toBe(within(conflict).getByRole('button', { name: 'Replace' })));
    expect(liveText()).toBe('F is already the key of Fit (Everywhere). Replace or Cancel.');
    expect(server.calls).toEqual([]);
    fireEvent.click(within(conflict).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['F']));
    expect(within(row('view.fit')).getByText('No key')).toBeInTheDocument();
    expect(noteIn('sketch.line')).toHaveTextContent('Saved. Taken from Fit.');
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyF'], 'view.fit': [] });
  });

  it("a taken key's Cancel changes nothing and puts the keyboard back on Change", async () => {
    const server = await open();
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyF', 'f');
    await waitFor(() => expect(conflictIn('sketch.line')).toBeTruthy());
    fireEvent.click(within(conflictIn('sketch.line')!).getByRole('button', { name: 'Cancel' }));
    expect(conflictIn('sketch.line')).toBeNull();
    expect([keysIn('sketch.line'), keysIn('view.fit')]).toEqual([['L'], ['F']]);
    expect(server.calls).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.line', 'Change Line')));
  });

  it('Tab from the recorder to its own Cancel closes it and leaves the keyboard on Change', async () => {
    await open();
    fireEvent.click(button('sketch.line', 'Change Line'));
    const capture = within(row('sketch.line')).getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(capture));
    fireEvent.blur(capture, { relatedTarget: button('sketch.line', 'Cancel changing Line') });
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.line', 'Change Line')));
  });

  it('the same words twice are read out twice: a second "Saved" is a change to the live region', async () => {
    await open();
    fireEvent.click(button('sketch.rectangle', 'Change Rectangle'));
    press('sketch.rectangle', 'KeyR', 'R', { shiftKey: true });
    await waitFor(() => expect(liveText()).toBe('Saved'));
    const first = live().textContent;
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyK', 'k');
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['K']));
    expect(liveText()).toBe('Saved');
    // One text, read whole, whose invisible ending alternates: a change screen readers read again.
    expect(live()).toHaveAttribute('aria-atomic', 'true');
    expect(live().childNodes).toHaveLength(1);
    expect(live().textContent).not.toBe(first);
    expect([first!.slice(-1), live().textContent!.slice(-1)].sort()).toEqual([String.fromCharCode(0x200b), String.fromCharCode(0x200c)]);
  });

  it('a save that answers after the person moved on leaves the keyboard where they are', async () => {
    const server = await open();
    const real = server.fetch.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/plugin-prefs/set') await held;
      return real(input, init);
    });
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyK', 'k');
    // They go to Search while the save is on its way.
    const search = screen.getByRole('searchbox', { name: 'Search keybinds' });
    search.focus();
    release();
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['K']));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(search);
  });

  it('a taken key writes nothing, so a refresh on its way still lands', async () => {
    const server = await open();
    const real = server.fetch.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/plugin-prefs/get') await held;
      return real(input, init);
    });
    // A workspace gives Rectangle Alt+R; its refresh is on its way when the person meets a taken key.
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.rectangle': ['Alt+KeyR'] } };
    const reads = () => server.fetch.mock.calls.filter(([u]) => String(u) === '/api/plugin-prefs/get').length;
    const before = reads();
    announcePref('demo', KEYBINDS_PREF, server.prefs.demo[KEYBINDS_PREF], 'bridge:elsewhere');
    await waitFor(() => expect(reads()).toBe(before + 1));
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyF', 'f');
    await waitFor(() => expect(conflictIn('sketch.line')).toBeTruthy());
    release();
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Alt+R']));
  });

  it('the same key in contexts that never meet is no conflict', async () => {
    const server = await open();
    fireEvent.click(button('model.extrude', 'Change Extrude'));
    press('model.extrude', 'KeyR', 'r');
    await waitFor(() => expect(keysIn('model.extrude')).toEqual(['R']));
    expect(stored(server)).toEqual({ 'model.extrude': ['KeyR'] });
  });

  it('Clear leaves no key, Reset puts the defaults back, Reset all every one; the keyboard stays in the row', async () => {
    const server = await open({ 'sketch.line': ['KeyK'] });
    fireEvent.click(button('edit.delete', 'Clear Delete'));
    await waitFor(() => expect(within(row('edit.delete')).getByText('No key')).toBeInTheDocument());
    // Clear went with the keys: the keyboard is on Change.
    await waitFor(() => expect(document.activeElement).toBe(button('edit.delete', 'Change Delete')));
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyK'], 'edit.delete': [] });
    fireEvent.click(button('edit.delete', 'Reset Delete'));
    await waitFor(() => expect(keysIn('edit.delete')).toEqual(['Delete', 'Backspace']));
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyK'] });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all Demo keys' }));
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['L']));
    expect(stored(server)).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Reset all Demo keys' })).toBeDisabled();
  });

  it("Reset all's word goes after a moment, as a row's Saved does", async () => {
    fakeTimers();
    await open({ 'sketch.line': ['KeyK'] });
    fireEvent.click(button('sketch.rectangle', 'Change Rectangle'));
    press('sketch.rectangle', 'KeyR', 'R', { shiftKey: true });
    await waitFor(() => expect(noteIn('sketch.rectangle')).toHaveTextContent('Saved'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all Demo keys' }));
    await waitFor(() => expect(demoNote()).toHaveTextContent('Every command has its default keys again.'));
    expect(demoNote()).toHaveAttribute('data-keys-plugin-note', 'saved');
    act(() => vi.advanceTimersByTime(2000));
    expect(noteIn('sketch.rectangle')).toBeNull();
    expect(demoNote()).toBeNull();
  });

  it('a change the app does not save keeps the keys shown as they were read, and says why', async () => {
    const server = await open();
    const real = server.fetch.getMockImplementation()!;
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/plugin-prefs/set' ? new Response(JSON.stringify({ ok: false, error: 'this plugin is not on' }), { status: 404 }) : real(input, init),
    );
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyK', 'k');
    await waitFor(() => expect(noteIn('sketch.line')).toHaveTextContent('Could not save the keys: this plugin is not on'));
    expect(keysIn('sketch.line')).toEqual(['L']);
    await waitFor(() => expect(document.activeElement).toBe(button('sketch.line', 'Change Line')));
  });

  it('Search finds commands by name, group, where and key', async () => {
    await open();
    const search = screen.getByRole('searchbox', { name: 'Search keybinds' });
    fireEvent.change(search, { target: { value: 'extr' } });
    expect(row('model.extrude')).toBeTruthy();
    expect(row('sketch.rectangle')).toBeNull();
    fireEvent.change(search, { target: { value: 'backspace' } });
    expect(row('edit.delete')).toBeTruthy();
    expect(row('model.extrude')).toBeNull();
    fireEvent.change(search, { target: { value: 'close the tab' } });
    expect((document.querySelector('[data-keys-reserved]') as HTMLDetailsElement).open).toBe(true);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No keybind matches “zzz”.')).toBeInTheDocument();
  });

  it('a change made in a workspace, by the Assistant in this page, or in another tab shows here as it happens', async () => {
    const server = await open();
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.rectangle': ['Alt+KeyR'] } };
    announcePref('demo', KEYBINDS_PREF, server.prefs.demo[KEYBINDS_PREF], 'bridge:elsewhere');
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Alt+R']));
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.rectangle': ['Alt+KeyT'] } };
    announcePref('demo', KEYBINDS_PREF, server.prefs.demo[KEYBINDS_PREF], ASSISTANT_FROM);
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Alt+T']));
  });

  it("keys that cannot be read are said so, and nothing can be changed until they are", async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    render(<KeybindsStep />);
    const alert = await screen.findByText(/^Your keys for Demo could not be read: /);
    expect(alert).toHaveTextContent('Changes wait until they can be read.');
    expect(button('sketch.line', 'Change Line')).toBeDisabled();
    server.failReads = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(button('sketch.line', 'Change Line')).toBeEnabled());
  });

  it("a workspace whose commands can't be read says why", async () => {
    fakeKeysServer({
      rows: [{ key: 'demo', name: 'Demo', status: 'enabled', workspaces: [{ key: 'part', title: 'Part', commands: '', commands_error: 'workspace/commands.json is missing' }] }],
    });
    render(<KeybindsStep />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Its keys can't be listed: workspace/commands.json is missing");
  });

  it('a plugin list the app could not read is said so, never as "no plugins"', async () => {
    const server = fakeKeysServer();
    server.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'worker restarted after a timeout' }), { status: 503 }));
    render(<KeybindsStep />);
    // Every read fails here: the app's keys say so too.
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('Could not read the plugin list: worker restarted after a timeout.'));
    expect(screen.queryByText('No plugin that is on lists its keys here yet.')).toBeNull();
  });
});

describe("Settings → Keybinds: the Assistant panel's key", () => {
  it("Change takes Alt+K and stores it as the app's key; the row shows it with a Reset, the keyboard goes back to Change", async () => {
    const server = await open();
    expect(within(row(PANEL)).getByText('Everywhere')).toBeInTheDocument();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    const capture = within(row(PANEL)).getByRole('textbox', { name: `Press the new keys for ${PANEL_LABEL}` });
    await waitFor(() => expect(document.activeElement).toBe(capture));
    // A modifier alone waits for the key.
    press(PANEL, 'AltLeft', 'Alt', { altKey: true });
    expect(capture).toHaveTextContent('Alt+…');
    press(PANEL, 'KeyK', 'k', { altKey: true });
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+K']));
    expect(noteIn(PANEL)).toHaveTextContent('Saved');
    expect(liveText()).toBe('Saved');
    // Only the app's keys are written: no plugin command had it.
    expect(server.app).toEqual({ [PANEL]: ['Alt+KeyK'] });
    expect(server.calls).toEqual([['app', '', { [PANEL]: ['Alt+KeyK'] }]]);
    expect(row(PANEL)).toHaveAttribute('data-keybind-default', '0');
    expect(button(PANEL, `Reset ${PANEL_LABEL}`)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
  });

  it('its recorder refuses a key that types text, or one the browser keeps, says why and keeps listening; Escape cancels', async () => {
    const server = await open();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    const typesText = "types text: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24). Press another.";
    press(PANEL, 'KeyK', 'k');
    expect(noteIn(PANEL)!.textContent).toBe(`K ${typesText}`);
    expect(liveText()).toBe(`K ${typesText}`);
    press(PANEL, 'KeyK', 'K', { shiftKey: true });
    expect(noteIn(PANEL)!.textContent).toBe(`Shift+K ${typesText}`);
    expect(liveText()).toBe(`Shift+K ${typesText}`);
    press(PANEL, 'KeyW', 'w', { ctrlKey: true });
    expect(noteIn(PANEL)).toHaveTextContent('Ctrl+W is kept for the browser and the system (Close the tab). Press another.');
    expect(liveText()).toBe('Ctrl+W is kept for the browser and the system (Close the tab). Press another.');
    press(PANEL, 'F5', 'F5');
    expect(noteIn(PANEL)).toHaveTextContent('F5 is kept for the browser and the system (Reload the page). Press another.');
    expect(within(row(PANEL)).getByRole('textbox')).toBeInTheDocument();
    press(PANEL, 'Escape', 'Escape');
    expect(within(row(PANEL)).queryByRole('textbox')).toBeNull();
    expect(noteIn(PANEL)).toBeNull();
    expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS);
    expect(server.calls).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
  });

  it('pressing Ctrl+/ in its recorder gives it its defaults again', async () => {
    const server = await openWithPanelKey({ [PANEL]: ['Alt+KeyK'] }, ['Alt+K']);
    expect(button(PANEL, `Reset ${PANEL_LABEL}`)).toBeInTheDocument();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    press(PANEL, 'Slash', '/', { ctrlKey: true });
    await waitFor(() => expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS));
    expect(noteIn(PANEL)).toHaveTextContent('Saved');
    expect(server.app).toEqual({});
    expect(server.calls).toEqual([['app', '', {}]]);
    expect(row(PANEL)).toHaveAttribute('data-keybind-default', '1');
    expect(within(row(PANEL)).queryByRole('button', { name: `Reset ${PANEL_LABEL}` })).toBeNull();
  });

  it('Clear leaves it no key and Reset gives it Ctrl+/ again; the keyboard stays on its Change', async () => {
    const server = await open();
    const clear = button(PANEL, `Clear ${PANEL_LABEL}`);
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => expect(within(row(PANEL)).getByText('No key')).toBeInTheDocument());
    expect(noteIn(PANEL)).toHaveTextContent('Saved');
    expect(server.app).toEqual({ [PANEL]: [] });
    expect(within(row(PANEL)).queryByRole('button', { name: `Clear ${PANEL_LABEL}` })).toBeNull();
    // Clear went with the keys: the keyboard is on Change.
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
    const reset = button(PANEL, `Reset ${PANEL_LABEL}`);
    reset.focus();
    fireEvent.click(reset);
    await waitFor(() => expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS));
    expect(server.app).toEqual({});
    expect(within(row(PANEL)).queryByRole('button', { name: `Reset ${PANEL_LABEL}` })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
    expect(server.calls.map(([what]) => what)).toEqual(['app', 'app']);
  });

  it('a key a plugin command has asks Replace or Cancel (the keyboard on Replace); Replace takes it from that command first', async () => {
    const server = await open({ 'sketch.line': ['Alt+KeyL', 'Shift+KeyL'] });
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    press(PANEL, 'KeyL', 'l', { altKey: true });
    await waitFor(() => expect(conflictIn(PANEL)).toBeTruthy());
    const conflict = conflictIn(PANEL)!;
    expect(conflict).toHaveTextContent('Alt+L is already the key of Demo · Line (Sketch).');
    await waitFor(() => expect(document.activeElement).toBe(within(conflict).getByRole('button', { name: 'Replace' })));
    expect(liveText()).toBe('Alt+L is already the key of Demo · Line (Sketch). Replace or Cancel.');
    expect(server.calls).toEqual([]);
    fireEvent.click(within(conflict).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+L']));
    expect(keysIn('sketch.line')).toEqual(['Shift+L']);
    expect(noteIn(PANEL)).toHaveTextContent('Saved. Taken from Demo · Line (Sketch).');
    expect(liveText()).toBe('Saved. Taken from Demo · Line (Sketch).');
    // The command loses the key before the panel has it: never both at once.
    expect(server.calls).toEqual([
      ['set', 'demo', { 'sketch.line': ['Shift+KeyL'] }],
      ['app', '', { [PANEL]: ['Alt+KeyL'] }],
    ]);
    expect(stored(server)).toEqual({ 'sketch.line': ['Shift+KeyL'] });
    expect(server.app).toEqual({ [PANEL]: ['Alt+KeyL'] });
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
  });

  it("a taken key's Cancel changes neither and puts the keyboard back on its Change", async () => {
    const server = await open({ 'sketch.line': ['Alt+KeyL'] });
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    press(PANEL, 'KeyL', 'l', { altKey: true });
    await waitFor(() => expect(conflictIn(PANEL)).toBeTruthy());
    fireEvent.click(within(conflictIn(PANEL)!).getByRole('button', { name: 'Cancel' }));
    expect(conflictIn(PANEL)).toBeNull();
    expect([keysIn(PANEL), keysIn('sketch.line')]).toEqual([PANEL_DEFAULTS, ['Alt+L']]);
    expect(server.calls).toEqual([]);
    expect(server.app).toEqual({});
    await waitFor(() => expect(document.activeElement).toBe(button(PANEL, `Change ${PANEL_LABEL}`)));
  });

  it('a change made in another tab or by the Assistant shows here as it happens', async () => {
    const server = await open();
    server.app = { [PANEL]: ['Alt+KeyJ'] };
    announcePref('', 'keybinds', server.app, 'bridge:elsewhere');
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+J']));
    expect(button(PANEL, `Reset ${PANEL_LABEL}`)).toBeInTheDocument();
    server.app = {};
    announcePref('', 'keybinds', null, ASSISTANT_FROM);
    await waitFor(() => expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS));
    expect(within(row(PANEL)).queryByRole('button', { name: `Reset ${PANEL_LABEL}` })).toBeNull();
  });

  it("a plugin command's recorder refuses the panel's key the person chose, with the app's-own-key words; once the panel moves, the command may have it", async () => {
    const server = await openWithPanelKey({ [PANEL]: ['Alt+KeyK'] }, ['Alt+K']);
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyK', 'k', { altKey: true });
    expect(noteIn('sketch.line')).toHaveTextContent("Alt+K is the app's own key (Open or close the Assistant panel). Press another.");
    expect(liveText()).toBe("Alt+K is the app's own key (Open or close the Assistant panel). Press another.");
    // Its default stays the app's as well: no one sets it.
    press('sketch.line', 'Slash', '/', { ctrlKey: true });
    expect(noteIn('sketch.line')).toHaveTextContent("Ctrl+/ is the app's own key (Open or close the Assistant panel). Press another.");
    expect(within(row('sketch.line')).getByRole('textbox')).toBeInTheDocument();
    press('sketch.line', 'Escape', 'Escape');
    expect(server.calls).toEqual([]);
    fireEvent.click(button(PANEL, `Reset ${PANEL_LABEL}`));
    await waitFor(() => expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS));
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyK', 'k', { altKey: true });
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['Alt+K']));
    expect(stored(server)).toEqual({ 'sketch.line': ['Alt+KeyK'] });
  });

  it("F2 for the panel takes it from the command whose default it is; that command's Reset is then refused with why", async () => {
    const server = await openF2();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    press(PANEL, 'F2', 'F2');
    await waitFor(() => expect(conflictIn(PANEL)).toBeTruthy());
    expect(conflictIn(PANEL)).toHaveTextContent('F2 is already the key of Demo · Rename (Everywhere).');
    fireEvent.click(within(conflictIn(PANEL)!).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['F2']));
    expect(within(row('edit.rename')).getByText('No key')).toBeInTheDocument();
    expect(noteIn(PANEL)).toHaveTextContent('Saved. Taken from Demo · Rename (Everywhere).');
    expect(stored(server)).toEqual({ 'edit.rename': [] });
    const writes = server.calls.length;
    fireEvent.click(button('edit.rename', 'Reset Rename'));
    await waitFor(() => expect(noteIn('edit.rename')).toHaveTextContent("F2 is the app's own key (Open or close the Assistant panel)"));
    expect(noteIn('edit.rename')).toHaveAttribute('data-keybind-note', 'error');
    expect(liveText()).toBe("F2 is the app's own key (Open or close the Assistant panel)");
    expect(within(row('edit.rename')).getByText('No key')).toBeInTheDocument();
    expect(server.calls).toHaveLength(writes);
    // Nothing a Reset all would change: the panel keeps F2.
    expect(screen.getByRole('button', { name: 'Reset all Demo keys' })).toBeDisabled();
  });

  it("Reset all puts every default back but keeps the panel's key off the command whose default it is, and says so", async () => {
    const server = await openF2({ 'edit.rename': ['KeyN'], 'sketch.line': ['KeyK'] }, { [PANEL]: ['F2'] });
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['F2']));
    const resetAll = screen.getByRole('button', { name: 'Reset all Demo keys' });
    expect(resetAll).toBeEnabled();
    fireEvent.click(resetAll);
    const said = "Every command has its default keys again. F2 kept off Rename: the Assistant panel's key.";
    await waitFor(() => expect(document.querySelector('[data-keys-plugin="demo"] [data-keys-plugin-note]')).toHaveTextContent(said));
    expect(liveText()).toBe(said);
    expect(keysIn('sketch.line')).toEqual(['L']);
    expect(within(row('edit.rename')).getByText('No key')).toBeInTheDocument();
    expect(stored(server)).toEqual({ 'edit.rename': [] });
    expect(server.app).toEqual({ [PANEL]: ['F2'] });
    expect(screen.getByRole('button', { name: 'Reset all Demo keys' })).toBeDisabled();
  });

  it("Reset all's word that names the key it kept off stays after a row's Saved has gone", async () => {
    fakeTimers();
    await openF2({ 'edit.rename': ['KeyN'], 'sketch.line': ['KeyK'] }, { [PANEL]: ['F2'] });
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['F2']));
    fireEvent.click(button('sketch.line', 'Change Line'));
    press('sketch.line', 'KeyJ', 'j');
    await waitFor(() => expect(noteIn('sketch.line')).toHaveTextContent('Saved'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all Demo keys' }));
    const said = "Every command has its default keys again. F2 kept off Rename: the Assistant panel's key.";
    await waitFor(() => expect(demoNote()).toHaveTextContent(said));
    act(() => vi.advanceTimersByTime(2000));
    expect(noteIn('sketch.line')).toBeNull();
    expect(demoNote()).toHaveTextContent(said);
    act(() => vi.advanceTimersByTime(60_000));
    expect(demoNote()).toHaveTextContent(said);
  });

  it("its Change, Reset and Clear wait until every plugin's keys are read", async () => {
    const server = fakeKeysServer({ app: { [PANEL]: ['Alt+KeyK'] } });
    const release = hold(server, '/api/plugins');
    render(<KeybindsStep />);
    // Its own key is read; whether a command has the key it would get is not known yet.
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+K']));
    expect(row('sketch.line')).toBeNull();
    const buttons = () => ['Change', 'Reset', 'Clear'].map((b) => button(PANEL, `${b} ${PANEL_LABEL}`));
    for (const b of buttons()) expect(b).toBeDisabled();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    expect(within(row(PANEL)).queryByRole('textbox')).toBeNull();
    release();
    await screen.findByText('Rectangle');
    for (const b of buttons()) expect(b).toBeEnabled();
    expect(server.calls).toEqual([]);
  });

  it("its Change, Reset and Clear stay off when the plugin list can't be read", async () => {
    const server = fakeKeysServer({ app: { [PANEL]: ['Alt+KeyK'] } });
    const real = server.fetch.getMockImplementation()!;
    server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/plugins' ? new Response(JSON.stringify({ ok: false, error: 'worker restarted after a timeout' }), { status: 503 }) : real(input, init),
    );
    render(<KeybindsStep />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the plugin list: worker restarted after a timeout.');
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+K']));
    for (const b of ['Change', 'Reset', 'Clear']) expect(button(PANEL, `${b} ${PANEL_LABEL}`)).toBeDisabled();
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    expect(within(row(PANEL)).queryByRole('textbox')).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("a key that can't be read is said so with Try again, its buttons wait; Try again shows the stored key and lets them", async () => {
    const server = fakeKeysServer({ app: { [PANEL]: ['Alt+KeyK'] } });
    server.failAppReads = true;
    render(<KeybindsStep />);
    await screen.findByText('Rectangle');
    const alert = await screen.findByText(/^The Assistant panel's key could not be read: /);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent("The Assistant panel's key could not be read: the settings are not available right now. Changes wait until it can be read.");
    // The page's copy (its defaults) shows, and nothing can be changed from it.
    expect(keysIn(PANEL)).toEqual(PANEL_DEFAULTS);
    expect(button(PANEL, `Change ${PANEL_LABEL}`)).toBeDisabled();
    expect(button(PANEL, `Clear ${PANEL_LABEL}`)).toBeDisabled();
    // The commands wait too: the panel's key decides which keys they may have.
    expect(button('sketch.line', 'Change Line')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset all Demo keys' })).toBeDisabled();
    server.failAppReads = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+K']));
    expect(screen.queryByText(/^The Assistant panel's key could not be read: /)).toBeNull();
    for (const b of ['Change', 'Reset', 'Clear']) expect(button(PANEL, `${b} ${PANEL_LABEL}`)).toBeEnabled();
    expect(button('sketch.line', 'Change Line')).toBeEnabled();
    expect(server.calls).toEqual([]);
  });

  it('Search finds it by the key it has now: Alt+K once changed, and no longer Ctrl+/', async () => {
    await open();
    const search = screen.getByRole('searchbox', { name: 'Search keybinds' });
    fireEvent.change(search, { target: { value: 'ctrl+/' } });
    expect(row(PANEL)).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(button(PANEL, `Change ${PANEL_LABEL}`));
    press(PANEL, 'KeyK', 'k', { altKey: true });
    await waitFor(() => expect(keysIn(PANEL)).toEqual(['Alt+K']));
    fireEvent.change(search, { target: { value: 'alt+k' } });
    expect(row(PANEL)).toBeTruthy();
    expect(row('sketch.line')).toBeNull();
    fireEvent.change(search, { target: { value: 'ctrl+/' } });
    expect(row(PANEL)).toBeNull();
    expect(screen.getByText('No keybind matches “ctrl+/”.')).toBeInTheDocument();
  });

  it('a change of its key the page takes after Settings first drew, before Settings listens, still shows', async () => {
    const server = fakeKeysServer();
    // Settings' own read of the stored keys fails: only the page's copy can show the change.
    server.failAppReads = true;
    // Its layout effect runs after Settings' first draw and before Settings' effects: the page's
    // copy changes there and no listener hears it (as a read the dock started may land).
    function ChangedMeanwhile() {
      useLayoutEffect(() => {
        resetAppKeysForTests({ [PANEL]: ['Alt+KeyJ'] });
      }, []);
      return null;
    }
    render(
      <>
        <KeybindsStep />
        <ChangedMeanwhile />
      </>,
    );
    await screen.findByText(/^The Assistant panel's key could not be read: /);
    expect(keysIn(PANEL)).toEqual(['Alt+J']);
    expect(row(PANEL)).toHaveAttribute('data-keybind-default', '0');
    expect(button(PANEL, `Reset ${PANEL_LABEL}`)).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });
});
