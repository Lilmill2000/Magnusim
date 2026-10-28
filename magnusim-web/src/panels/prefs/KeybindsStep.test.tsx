import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_FROM, KEYBINDS_PREF } from '../../keybinds/catalog';
import { fakeKeysServer } from '../../test/keybindsFake';
import { announcePref } from '../../workspace/prefsChannel';
import { KeybindsStep } from './KeybindsStep';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe('Settings → Keybinds', () => {
  it("lists the app's keys, the browser's in a fold, and each plugin's commands by group with their keys", async () => {
    await open({ 'sketch.line': ['Shift+KeyL'] });
    expect(keysIn('app.assistant')).toEqual(['Ctrl+/', 'Ctrl+NumpadDivide']);
    expect(within(row('app.close')).getByText('Escape')).toBeInTheDocument();
    const fold = document.querySelector('[data-keys-reserved]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText('Close the tab')).toBeInTheDocument();
    // The app's rows have nothing to press, and say so.
    expect(within(row('app.assistant')).queryByRole('button')).toBeNull();
    expect(screen.getByText("The app's own keys work everywhere and can't be changed.")).toBeInTheDocument();
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the plugin list: worker restarted after a timeout.');
    expect(screen.queryByText('No plugin that is on lists its keys here yet.')).toBeNull();
  });
});
