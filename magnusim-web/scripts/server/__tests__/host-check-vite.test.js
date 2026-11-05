/**
 * The API under a real Vite server answers on exactly the hosts Vite's page does: the
 * allowedHosts Vite resolved (here a configured extra name and a ".domain" entry, as
 * vite.config.js lists the public tunnel), and refuses a DNS-rebinding page's own domain with
 * 403 on every route class. The app's middleware runs before Vite's own host check
 * (configureServer middlewares come first), so this is the API's check (http.ts refuseForeignHost),
 * reading server.config. The API is Magnusim CAD's (no Python); the check is the same for both.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-check-vite-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'assistant');
process.env.MAGNUSIM_PYTHON = join(ROOT, 'no-python.exe');
process.env.PATH = String(process.env.PATH || '')
  .split(delimiter)
  .filter((dir) => !/python|windowsapps/i.test(dir))
  .join(delimiter);
writeFileSync(process.env.MAGNUSIM_LOCAL_JSON, '{}');

// Magnusim CAD's edition and spawn guard (no Python, no WSL), as its server sets them.
await import('../cad-edition/serve.mjs');
const { createApiPlugin } = await import('../index.ts');
const { createServer } = await import('vite');
const { asPage, assertRefused } = await import('./host-page.js');

const EXTRA = 'extra.example';
const TUNNEL = 'sim.tunnel.example';
const EVIL = 'evil.example';

let vite;
let httpServer;
let port;

before(async () => {
  vite = await createServer({
    configFile: false,
    root: ROOT,
    cacheDir: join(ROOT, 'vite-cache'),
    appType: 'custom',
    logLevel: 'silent',
    plugins: [createApiPlugin()],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null, allowedHosts: [EXTRA, '.tunnel.example'] },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  httpServer = http.createServer(vite.middlewares);
  await new Promise((ok) => httpServer.listen(0, '127.0.0.1', ok));
  port = httpServer.address().port;
});

after(async () => {
  await vite?.close();
  await new Promise((ok) => (httpServer ? httpServer.close(() => ok()) : ok()));
});

describe('the API under Vite with allowedHosts set', () => {
  it('Vite resolved the list the API reads', () => {
    assert.deepEqual(vite.config.server.allowedHosts, [EXTRA, '.tunnel.example']);
  });

  it('a rebinding page\'s domain: Vite refuses its page, and the API refuses every route class', async () => {
    const page = await asPage(port, EVIL, { path: '/', origin: false });
    assert.equal(page.status, 403);
    assert.match(page.text, /Blocked request\. This host \("evil\.example"\) is not allowed/, 'Vite\'s own host check');
    for (const [method, path, body, origin] of [
      ['GET', '/api/projects', undefined, false],
      ['GET', '/api/projects', undefined, true],
      ['POST', '/api/project', { title: 'Rebound', units: 'Metric' }, true],
      ['GET', '/api/events?tab=rebind-tab-0002', undefined, false],
      ['GET', '/plugins/cad/workspace/index.html', undefined, false],
      ['GET', '/plugin-sdk/workspace.js', undefined, false],
    ]) {
      assertRefused(await asPage(port, EVIL, { method, path, body, origin }), EVIL, `${method} ${path}`);
    }
    const listed = await asPage(port, '127.0.0.1', { path: '/api/projects' });
    assert.deepEqual(listed.json.projects.map((p) => p.title).filter((t) => t === 'Rebound'), [], 'the write made nothing');
  });

  it('a configured extra host and a name under a ".domain" entry get the API (read, write, stream, plugin files)', async () => {
    for (const name of [EXTRA, TUNNEL, 'localhost', '127.0.0.1']) {
      const read = await asPage(port, name, { path: '/api/projects' });
      assert.equal(read.status, 200, `${name}: ${read.text.slice(0, 200)}`);
      assert.ok(Array.isArray(read.json.projects), name);
      const made = await asPage(port, name, { method: 'POST', path: '/api/project', body: { title: `From ${name}`, units: 'Metric' } });
      assert.equal(made.status, 201, `${name}: ${made.text.slice(0, 200)}`);
      const stream = await asPage(port, name, { path: `/api/events?tab=tab-${name.replace(/\W/g, '')}-01` });
      assert.equal(stream.status, 200, name);
      assert.match(stream.text, /event: hello/, name);
      const file = await asPage(port, name, { path: '/plugins/cad/workspace/index.html', origin: false });
      assert.equal(file.status, 200, `${name}: ${file.text.slice(0, 200)}`);
      assert.match(file.type, /text\/html/, name);
    }
  });
});
