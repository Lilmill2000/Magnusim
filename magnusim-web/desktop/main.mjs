// Magnusim CAD's desktop app (Electron): one window on the app's own server, which runs in a
// utility process with no Python and no WSL (server.mjs, scripts/server/cad-edition/serve.mjs).
// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, dialog, nativeTheme, shell, utilityProcess } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, isAppUrl, isExternalUrl, serverEnv, windowBackground } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUIT_WAIT_MS = 4000;

app.setName(APP_NAME);

/** desktop.log in the app's user data (and stderr): what start-up and the server did, for a problem report. */
function log(line) {
  const text = `${new Date().toISOString()} ${line}
`;
  process.stderr.write(text);
  try {
    appendFileSync(join(app.getPath('userData'), 'desktop.log'), text);
  } catch {
    /* no user data folder yet */
  }
}
if (!app.requestSingleInstanceLock()) app.quit();

/** @type {Electron.UtilityProcess | null} */
let server = null;
let serverPort = 0;
/** The person's theme as the server read it (Settings → Appearance). */
let serverTheme = 'light';
let quitting = false;
/** @type {BrowserWindow | null} */
let win = null;

function startServer() {
  const env = serverEnv({ documents: () => app.getPath('documents'), userData: app.getPath('userData') });
  mkdirSync(env.MAGNUSIM_PROJECTS_ROOT, { recursive: true });
  // Installed: the page built with the app (build.mjs); from a checkout: the page from source.
  const args = app.isPackaged ? ['--static', join(HERE, '..', 'page')] : ['--dev'];
  const child = utilityProcess.fork(join(HERE, 'server.mjs'), args, {
    env,
    serviceName: `${APP_NAME} server`,
    stdio: 'inherit',
  });
  server = child;
  log(`server starting (${args.join(' ')}), projects in ${env.MAGNUSIM_PROJECTS_ROOT}`);
  return new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m && m.type === 'ready') {
        serverPort = Number(m.port);
        serverTheme = String(m.theme || 'light');
        log(`server ready on ${serverPort}`);
        resolve(serverPort);
      }
    });
    child.once('exit', (code) => {
      log(`server exited (${code})`);
      if (server === child) server = null;
      if (!serverPort) reject(new Error(`the server stopped before it listened (exit ${code})`));
      else if (!quitting) void serverStopped(code);
    });
  });
}

/** The server ended while the app runs: say so, and start it again on Restart. */
async function serverStopped(code) {
  serverPort = 0;
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'error',
    title: APP_NAME,
    message: `${APP_NAME}'s server stopped (exit ${code}).`,
    detail: 'Your parts are saved as you work. Restart it to go on.',
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
  });
  if (response !== 0) return app.quit();
  const port = await startServer();
  win?.loadURL(`http://127.0.0.1:${port}/`);
}

function openWindow(port) {
  win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: windowBackground(serverTheme, nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.maximize();
  win.once('ready-to-show', () => win?.show());
  // The app's pages stay here; a web link opens in the person's browser; nothing else opens.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url, serverPort) && isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url, serverPort)) return;
    e.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  if (quitting || !server) return;
  // Close the server first: it ends the Assistant's coding agents and its open files.
  e.preventDefault();
  quitting = true;
  const child = server;
  const done = () => app.quit();
  child.once('exit', done);
  child.postMessage({ type: 'quit' });
  setTimeout(() => {
    child.kill();
    done();
  }, QUIT_WAIT_MS).unref();
});

log(`${APP_NAME} ${app.getVersion()} starting (Electron ${process.versions.electron})`);

app.whenReady().then(async () => {
  try {
    openWindow(await startServer());
  } catch (err) {
    log(`could not start: ${err instanceof Error ? err.stack : err}`);
    dialog.showErrorBox(APP_NAME, `${APP_NAME} could not start: ${err instanceof Error ? err.message : err}`);
    app.exit(1);
  }
});
