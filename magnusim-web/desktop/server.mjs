// Magnusim CAD's server, as the desktop app runs it: in an Electron utility process (main.mjs),
// so a crash of the server never takes the window down. It tells the app its port when it
// listens, and closes (ending the Assistant's coding agents) when the app quits. Its console
// is also kept in its log (serverLog), for a problem report.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { formatWithOptions, inspect } from 'node:util';
import { openServerLog } from './server-log.mjs';

// A program the server starts with its own executable (the Assistant's MCP bridge, run with
// process.execPath) runs as Node, not as a second app. Set here, in the running server: in the
// utility process's own environment it would start that process as Node too, which then
// refuses Electron's own switches.
if (process.versions.electron) process.env.ELECTRON_RUN_AS_NODE = '1';

/** Errors already in the log (a start-up error is written once, not again as the crash it becomes). */
const logged = new WeakSet();

/**
 * The server's console, also kept in the file MAGNUSIM_SERVER_LOG names (config.mjs serverEnv;
 * unset: no file): the Assistant's [assistant] lines, a plugin's error, what ended the server.
 * Every line goes through the Assistant's redact (each key this server has registered, and
 * anything shaped like a key), and the console still says it all. Made before the server
 * loads, so an error at start-up is kept. Returns the log, or null.
 */
async function serverLog(file) {
  file = String(file || '').trim();
  if (!file) return null;
  let redact;
  try {
    ({ redact } = await import('../scripts/server/assistant/redact.ts'));
  } catch (err) {
    // Nothing to scrub with, so no file: a log that could hold a key is never written.
    process.stderr.write(`no server log: the Assistant's redact did not load (${err instanceof Error ? err.message : err})\n`);
    return null;
  }
  const log = openServerLog({ file, redact });
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']]) {
    const original = console[method];
    console[method] = (...args) => {
      try {
        log.write(level, formatWithOptions({ colors: false }, ...args));
      } catch {
        /* the log never stops the console */
      }
      return original.apply(console, args);
    };
  }
  // What would end the server (an uncaught exception, or a rejection nobody handles): watched,
  // never handled, so the server ends as it would without its log. Once the server's own guards
  // are in (scripts/server/index.ts), they catch it, say it on the console (so here) and go on.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    if (globalThis.__CFD_PROCESS_GUARDS__ || (err && typeof err === 'object' && logged.has(err))) return;
    log.write('error', `${origin === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception'}; the server stops: ${inspect(err)}`);
  });
  // The last line, and a last try for any line still waiting (the file was held open elsewhere).
  process.on('exit', (code) => {
    log.write('info', `server exited (${code})`);
    log.close();
  });
  return log;
}

const log = await serverLog(process.env.MAGNUSIM_SERVER_LOG);
const dev = process.argv.includes('--dev');
const staticArg = process.argv.indexOf('--static');
const staticDir = staticArg > 0 ? process.argv[staticArg + 1] : undefined;
const versions = `Node ${process.version}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''}`;
log?.write('info', `Magnusim CAD server starting (${dev ? 'the page from source' : staticDir ? 'the built page' : 'the API only'}; pid ${process.pid}, ${versions})`);

let server;
let appearancePrefs;
try {
  const { startCadServer } = await import('../scripts/server/cad-edition/serve.mjs');
  ({ appearancePrefs } = await import('../scripts/prefs.js'));
  server = await startCadServer({ port: 0, dev, staticDir });
} catch (err) {
  log?.write('error', `the server could not start: ${inspect(err)}`);
  if (err && typeof err === 'object') logged.add(err);
  throw err;
}
log?.write('info', `server listening on 127.0.0.1:${server.port}`);
const port = process.parentPort;
// With the person's theme: the window takes its colour before the page paints.
port?.postMessage({ type: 'ready', port: server.port, theme: appearancePrefs().theme });
port?.on('message', (e) => {
  if (e?.data?.type !== 'quit') return;
  log?.write('info', 'server closing: the app quits');
  server.close().finally(() => process.exit(0));
});
if (!port) console.log(`Magnusim CAD server (${fileURLToPath(import.meta.url)}) on ${server.port}`);
