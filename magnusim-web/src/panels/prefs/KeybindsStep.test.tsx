import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYBINDS_PREF } from '../../keybinds/catalog';
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
    // The app's rows have nothing to press.
    expect(within(row('app.assistant')).queryByRole('button')).toBeNull();
    const demo = document.querySelector('[data-keys-plugin="demo"]') as HTMLElement;
    expect(within(demo).getByText('Part workspace')).toBeInTheDocument();
    expect([...demo.querySelectorAll('.wiz-keys-group-title')].map((h) => h.textContent)).toEqual(['Draw', 'Features', 'View', 'Edit']);
    expect(keysIn('sketch.rectangle')).toEqual(['R']);
    expect(keysIn('sketch.line')).toEqual(['Shift+L']);
    expect(keysIn('edit.delete')).toEqual(['Delete', 'Backspace']);
    expect(within(row('view.fit')).getByText('Everywhere')).toBeInTheDocument();
    expect(within(row('sketch.rectangle')).getByText('Sketch')).toBeInTheDocument();
    // Reset only where the keys are the person's own.
    expect(within(row('sketch.line')).getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(within(row('sketch.rectangle')).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('Change takes the next key press and stores it at once', async () => {
    const server = await open();
    fireEvent.click(within(row('sketch.rectangle')).getByRole('button', { name: 'Change' }));
    const capture = within(row('sketch.rectangle')).getByRole('textbox', { name: 'Press the new keys for Rectangle' });
    await waitFor(() => expect(document.activeElement).toBe(capture));
    // A modifier alone waits for the key.
    press('sketch.rectangle', 'ShiftLeft', 'Shift', { shiftKey: true });
    expect(capture).toHaveTextContent('Shift+…');
    press('sketch.rectangle', 'KeyR', 'R', { shiftKey: true });
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Shift+R']));
    expect(within(row('sketch.rectangle')).getByRole('status')).toHaveTextContent('Saved');
    expect(stored(server)).toEqual({ 'sketch.rectangle': ['Shift+KeyR'] });
  });

  it("refuses a key the app or the browser keeps and keeps listening; Escape cancels", async () => {
    const server = await open();
    fireEvent.click(within(row('sketch.line')).getByRole('button', { name: 'Change' }));
    press('sketch.line', 'KeyW', 'w', { ctrlKey: true });
    expect(within(row('sketch.line')).getByRole('alert')).toHaveTextContent('Ctrl+W is kept for the browser and the system (Close the tab). Press another.');
    press('sketch.line', 'Slash', '/', { ctrlKey: true });
    expect(within(row('sketch.line')).getByRole('alert')).toHaveTextContent("Ctrl+/ is the app's own key (Open or close the Assistant panel). Press another.");
    // Cmd counts as Ctrl.
    press('sketch.line', 'KeyR', 'r', { metaKey: true });
    expect(within(row('sketch.line')).getByRole('alert')).toHaveTextContent('Ctrl+R is kept for the browser and the system (Reload the page)');
    expect(within(row('sketch.line')).getByRole('textbox')).toBeInTheDocument();
    press('sketch.line', 'Escape', 'Escape');
    expect(within(row('sketch.line')).queryByRole('textbox')).toBeNull();
    expect(keysIn('sketch.line')).toEqual(['L']);
    expect(server.calls).toEqual([]);
  });

  it('a key the press does not hand Settings stays where it was (Escape never reaches the Settings close)', async () => {
    await open();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.click(within(row('sketch.line')).getByRole('button', { name: 'Change' }));
    press('sketch.line', 'Escape', 'Escape');
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });

  it('a key another command has asks Replace or Cancel; Replace takes it from that command', async () => {
    const server = await open();
    fireEvent.click(within(row('sketch.line')).getByRole('button', { name: 'Change' }));
    press('sketch.line', 'KeyF', 'f');
    const conflict = await within(row('sketch.line')).findByRole('alert');
    expect(conflict).toHaveTextContent('F is already the key of Fit (Everywhere).');
    expect(server.calls).toEqual([]);
    fireEvent.click(within(conflict).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['F']));
    expect(within(row('view.fit')).getByText('No key')).toBeInTheDocument();
    expect(within(row('sketch.line')).getByRole('status')).toHaveTextContent('Saved. Taken from Fit.');
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyF'], 'view.fit': [] });
  });

  it('the same key in contexts that never meet is no conflict', async () => {
    const server = await open();
    fireEvent.click(within(row('model.extrude')).getByRole('button', { name: 'Change' }));
    press('model.extrude', 'KeyR', 'r');
    await waitFor(() => expect(keysIn('model.extrude')).toEqual(['R']));
    expect(stored(server)).toEqual({ 'model.extrude': ['KeyR'] });
  });

  it('Clear leaves no key, Reset puts the defaults back, Reset all every one', async () => {
    const server = await open({ 'sketch.line': ['KeyK'] });
    fireEvent.click(within(row('edit.delete')).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(within(row('edit.delete')).getByText('No key')).toBeInTheDocument());
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyK'], 'edit.delete': [] });
    fireEvent.click(within(row('edit.delete')).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(keysIn('edit.delete')).toEqual(['Delete', 'Backspace']));
    expect(stored(server)).toEqual({ 'sketch.line': ['KeyK'] });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    await waitFor(() => expect(keysIn('sketch.line')).toEqual(['L']));
    expect(stored(server)).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled();
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

  it('a change made in a workspace or another tab shows here as it happens', async () => {
    const server = await open();
    server.prefs.demo = { [KEYBINDS_PREF]: { 'sketch.rectangle': ['Alt+KeyR'] } };
    announcePref('demo', KEYBINDS_PREF, server.prefs.demo[KEYBINDS_PREF], 'bridge:elsewhere');
    await waitFor(() => expect(keysIn('sketch.rectangle')).toEqual(['Alt+R']));
  });

  it("keys that cannot be read are said so, and nothing can be changed until they are", async () => {
    const server = fakeKeysServer();
    server.failReads = true;
    render(<KeybindsStep />);
    const alert = await screen.findByText(/^Your keys for Demo could not be read: /);
    expect(alert).toHaveTextContent('Changes wait until they can be read.');
    expect(within(row('sketch.line')).getByRole('button', { name: 'Change' })).toBeDisabled();
    server.failReads = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(row('sketch.line')).getByRole('button', { name: 'Change' })).toBeEnabled());
  });

  it("a workspace whose commands can't be read says why", async () => {
    fakeKeysServer({
      rows: [{ key: 'demo', name: 'Demo', status: 'enabled', workspaces: [{ key: 'part', title: 'Part', commands: '', commands_error: 'workspace/commands.json is missing' }] }],
    });
    render(<KeybindsStep />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Its keys can't be listed: workspace/commands.json is missing");
  });
});
