/**
 * The app's own keys, each in the shape of a command of a workspace's commands file (commands.ts),
 * for Settings → Keybinds and for plugins. Data only: scripts/server/plugin-sdk.ts publishes them as
 * docs/plugins/plugin-sdk.json `app_keys` ({app, local, reserved}), which plugin:check and a
 * plugin's own build read. Combos as commands.ts writes them (Cmd counts as Ctrl).
 *
 * - app: keys the app acts on wherever the person is. No workspace command may have one.
 * - local: keys the app acts on only while something of its own is open (a dialog, a menu,
 *   Settings, a pick or capture mode). Settings shows them; a workspace may use them in its page.
 * - reserved: keys the browser, the desktop app or the system takes before the page gets them, so a
 *   command could never have them. No workspace command's default may be one. The same plugin runs
 *   in a browser tab (Magnusim) and in the desktop app (whose window keeps Electron's default menu:
 *   reload, developer tools, zoom, full screen, close), so a key either one takes stays here.
 */
const shown = (id: string, label: string, group: string, keys: string[]) => ({ id, label, group, context: 'any', keys });

export const APP_COMMANDS = [
  // The key that types "/" with Ctrl (Cmd on macOS): src/assistant/dock/toggle.ts isDockKey on the
  // page, and in a workspace the SDK's forward (src/plugin-sdk/workspace.ts: Ctrl or Cmd or both, no
  // Alt or Shift). Slash and NumpadDivide type "/" on every layout; on a layout where another key
  // types it, that key with Ctrl does too, which no code can name. The Meta forms are for a page that
  // reads Cmd as Meta.
  shown('app.assistant', 'Open or close the Assistant panel', 'Assistant', [
    'Ctrl+Slash',
    'Meta+Slash',
    'Ctrl+NumpadDivide',
    'Meta+NumpadDivide',
    'Ctrl+Meta+Slash',
    'Ctrl+Meta+NumpadDivide',
  ]),
];

export const APP_LOCAL_KEYS = [shown('app.close', 'Close the open dialog, menu or mode', 'App', ['Escape'])];

export const RESERVED_KEYS = [
  shown('browser.close-tab', 'Close the tab', 'Browser', ['Ctrl+KeyW', 'Ctrl+F4']),
  shown('browser.close-window', 'Close the window', 'Browser', ['Ctrl+Shift+KeyW', 'Alt+F4']),
  shown('browser.new-tab', 'Open a new tab', 'Browser', ['Ctrl+KeyT', 'Ctrl+Shift+KeyT']),
  shown('browser.new-window', 'Open a new window', 'Browser', ['Ctrl+KeyN', 'Ctrl+Shift+KeyN']),
  shown('browser.switch-tab', 'Switch tabs', 'Browser', [
    'Ctrl+Tab',
    'Ctrl+Shift+Tab',
    'Ctrl+PageUp',
    'Ctrl+PageDown',
    ...'123456789'.split('').map((d) => `Ctrl+Digit${d}`),
  ]),
  shown('browser.reload', 'Reload the page', 'Browser', ['Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'F5', 'Ctrl+F5']),
  shown('browser.devtools', 'Open the developer tools', 'Browser', ['Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ', 'F12']),
  shown('browser.full-screen', 'Full screen', 'Browser', ['F11']),
  shown('browser.print', 'Print the page', 'Browser', ['Ctrl+KeyP']),
  shown('browser.zoom', 'Zoom the page', 'Browser', ['Ctrl+Equal', 'Ctrl+Shift+Equal', 'Ctrl+Minus', 'Ctrl+Digit0', 'Ctrl+NumpadAdd', 'Ctrl+NumpadSubtract']),
  shown('focus.next', 'Move between controls', 'Keyboard', ['Tab', 'Shift+Tab']),
];

/** All three groups, as plugin-sdk.json publishes them. */
export const APP_KEYS = { app: APP_COMMANDS, local: APP_LOCAL_KEYS, reserved: RESERVED_KEYS };
