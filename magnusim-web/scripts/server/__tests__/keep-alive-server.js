// SPDX-License-Identifier: GPL-3.0-or-later
// A child process of keep-alive.test.js: an http server with the app's keep-alive timeouts
// (argv "app") or Node's defaults (argv "node"). GET /busy?ms=N keeps its event loop busy
// for N ms inside the request's callback, as a sync step in a real request does.
import http from 'node:http';
import { keepIdleConnectionsOpen } from '../keep-alive.ts';

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/busy') {
    const until = performance.now() + Number(url.searchParams.get('ms') || 0);
    while (performance.now() < until) {
      /* busy */
    }
  }
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});
if (process.argv[2] === 'app') keepIdleConnectionsOpen(server);
server.listen(0, '127.0.0.1', () => process.send?.(/** @type {import('node:net').AddressInfo} */ (server.address()).port));
