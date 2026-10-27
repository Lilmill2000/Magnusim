// Magnusim CAD's server, as the desktop app runs it: in an Electron utility process (main.mjs),
// so a crash of the server never takes the window down. It tells the app its port when it
// listens, and closes (ending the Assistant's coding agents) when the app quits.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';

// A program the server starts with its own executable (the Assistant's MCP bridge, run with
// process.execPath) runs as Node, not as a second app. Set here, in the running server: in the
// utility process's own environment it would start that process as Node too, which then
// refuses Electron's own switches.
if (process.versions.electron) process.env.ELECTRON_RUN_AS_NODE = '1';

const { startCadServer } = await import('../scripts/server/cad-edition/serve.mjs');
const staticArg = process.argv.indexOf('--static');
const server = await startCadServer({
  port: 0,
  dev: process.argv.includes('--dev'),
  staticDir: staticArg > 0 ? process.argv[staticArg + 1] : undefined,
});
const port = process.parentPort;
port?.postMessage({ type: 'ready', port: server.port });
port?.on('message', (e) => {
  if (e?.data?.type !== 'quit') return;
  server.close().finally(() => process.exit(0));
});
if (!port) console.log(`Magnusim CAD server (${fileURLToPath(import.meta.url)}) on ${server.port}`);
