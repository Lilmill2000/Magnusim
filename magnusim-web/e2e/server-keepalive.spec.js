// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

// A test's API call a few seconds after its previous one failed now and then with
// "apiRequestContext.post: read ECONNRESET" (CAD e2e: view-kept on GitHub, reload-files and
// cadPluginRow's GET /api/plugins in the WSL mirror). With Node's defaults the server closed
// an idle keep-alive connection 6 s after its last response; a request that reached it while
// the server was busy across that moment was closed unread, and Playwright's request context
// (unlike a browser) does not send it again. The app server now keeps idle connections two
// minutes (scripts/server/keep-alive.ts); scripts/server/__tests__/keep-alive.test.js forces
// the old timing. Here: the real server (Vite with the API plugin) carries that setting, on a
// GET and a POST, which is what it tells every client in its Keep-Alive header.
test('server: idle keep-alive connections are kept two minutes, not Node\'s 5 s', async ({ request }) => {
  const get = await request.get('/api/plugins');
  expect(get.ok()).toBe(true);
  expect(get.headers()['keep-alive']).toBe('timeout=120');
  const post = await request.post('/api/plugin-prefs/get', { data: { plugin: 'cad', key: 'e2e-keepalive' } });
  expect(post.status()).toBeLessThan(500);
  expect(post.headers()['keep-alive']).toBe('timeout=120');
});
