// Magnusim CAD's desktop settings: where its projects and prefs live, the server's
// environment, and which addresses stay in the app's window. Plain functions (no Electron)
// so desktop/test can check them.
// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';

export const APP_NAME = 'Magnusim CAD';

/**
 * The server's environment: the CAD edition; projects in Documents\Magnusim CAD (D5: the app's
 * own folder; MAGNUSIM_PROJECTS_ROOT set by the person wins, e.g. Magnusim's folder to share it);
 * prefs in the app's user data (%APPDATA%\Magnusim CAD\local.json). The Assistant's settings and
 * keys live beside them in the app's own folder (%APPDATA%\Magnusim CAD\local.assistant: the
 * Assistant's home follows MAGNUSIM_LOCAL_JSON, assistant/home.ts), not in Magnusim's, and the
 * uninstaller's "Also remove settings" (resources/uninstall.nsh) removes them too.
 * The server's console (the Assistant's [assistant] lines, a plugin's error, a crash) is kept
 * in %APPDATA%\Magnusim CAD\logs\server.log, on this PC only (server.mjs, server-log.mjs:
 * scrubbed of keys, moved on to server.1.log and server.2.log past 5 MiB; the server makes the
 * folder); MAGNUSIM_SERVER_LOG set already wins. Settings → Assistant's provider log for a problem
 * report goes in the same folder (assistant/debug-log.ts providerLogDir), and its Open log folder
 * opens it. desktop.log keeps the app's own start and stop.
 * MAGNUSIM_PACKAGED marks the desktop app (installed, or npm start: the same user data): its home
 * is the person's real folder, never a test one, so no Assistant test switch is honoured in it
 * (assistant/home.ts assistantHomeIsOverridden).
 * `documents` may be a function: it is asked only when MAGNUSIM_PROJECTS_ROOT does not say where
 * projects go (Windows can fail to name Documents, e.g. under another profile folder).
 * @param {{ documents: string | (() => string), userData: string, env?: NodeJS.ProcessEnv }} o
 */
export function serverEnv({ documents, userData, env = process.env }) {
  const projects = String(env.MAGNUSIM_PROJECTS_ROOT || '').trim() || join(typeof documents === 'function' ? documents() : documents, APP_NAME);
  return {
    ...env,
    MAGNUSIM_EDITION: 'cad',
    MAGNUSIM_PROJECTS_ROOT: projects,
    MAGNUSIM_LOCAL_JSON: String(env.MAGNUSIM_LOCAL_JSON || '').trim() || join(userData, 'local.json'),
    MAGNUSIM_SERVER_LOG: String(env.MAGNUSIM_SERVER_LOG || '').trim() || join(userData, 'logs', 'server.log'),
    MAGNUSIM_PACKAGED: '1',
  };
}

/**
 * The window's colour until the page paints: the person's theme (Settings → Appearance; 'system'
 * as Windows is), dark as the page's background (tokens.css --mg-app-bg), light as before.
 */
export function windowBackground(theme, systemDark) {
  return theme === 'dark' || (theme === 'system' && systemDark) ? '#12151b' : '#f9fafb';
}

/** The app's own pages: its server on this PC, at its port. Anything else opens in the browser. */
export function isAppUrl(url, port) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === Number(port);
  } catch {
    return false;
  }
}

/** A link the person may open in their browser (never a file, script or app address). */
export function isExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}
