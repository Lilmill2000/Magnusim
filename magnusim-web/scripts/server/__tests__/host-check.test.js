/**
 * DNS rebinding: a page on http://evil.example:PORT whose domain re-resolves to 127.0.0.1
 * reaches the app with Host and Origin both evil.example:PORT (so the same-origin check finds
 * them equal). The app's API middleware runs before Vite's own host check, so it checks the Host
 * itself (http.ts refuseForeignHost, first in index.ts): such a page gets 403 and nothing else,
 * on every route class, while this PC's own names get the answer as before.
 *
 * The rule (isAllowedHost / hostRuleOf) is Vite's; the server here is Magnusim CAD's
 * (no Vite config: this PC's names only). host-check-vite.test.js runs it under a real Vite
 * server with configured allowedHosts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-check-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'assistant');
process.env.MAGNUSIM_PYTHON = join(ROOT, 'no-python.exe');
process.env.PATH = String(process.env.PATH || '')
  .split(delimiter)
  .filter((dir) => !/python|windowsapps/i.test(dir))
  .join(delimiter);
writeFileSync(process.env.MAGNUSIM_LOCAL_JSON, '{}');

const { startCadServer } = await import('../cad-edition/serve.mjs');
const { foreignHostBody, hostRuleOf, isAllowedHost, LOOPBACK_ONLY } = await import('../http.ts');
const { asPage, assertRefused } = await import('./host-page.js');

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('isAllowedHost (Vite\'s host rule)', () => {
  it('this PC\'s names and any IP address pass with no list; a domain does not', () => {
    for (const h of ['127.0.0.1:8082', '127.0.0.1', 'localhost:8082', 'LOCALHOST:1', 'app.localhost:8082', '[::1]:8082', '[::1]', '192.168.1.5:8082', '0.0.0.0:80']) {
      assert.equal(isAllowedHost(h, LOOPBACK_ONLY), true, h);
    }
    for (const h of ['evil.example:8082', 'evil.example', 'localhost.evil.example:8082', '127.0.0.1.nip.io:8082', 'simulation.lilmill2000.com:8082', '[evil]:1', '', undefined]) {
      assert.equal(isAllowedHost(h, LOOPBACK_ONLY), false, String(h));
    }
  });

  it('a listed name passes; ".domain" passes the domain and every name under it, not a look-alike', () => {
    const rule = { allowed: ['extra.example', '.lilmill2000.com'], extra: [] };
    for (const h of ['extra.example:8082', 'EXTRA.example', 'lilmill2000.com', 'simulation.lilmill2000.com:443', 'a.b.lilmill2000.com']) {
      assert.equal(isAllowedHost(h, rule), true, h);
    }
    for (const h of ['evil-lilmill2000.com', 'lilmill2000.com.evil.example', 'xextra.example', 'extra.example.evil', 'evil.example']) {
      assert.equal(isAllowedHost(h, rule), false, h);
    }
  });

  it('true lets every host through (Vite\'s allowedHosts: true)', () => {
    assert.equal(isAllowedHost('evil.example:1', { allowed: true, extra: [] }), true);
  });

  it('the refusal names the host without its port', () => {
    assert.match(foreignHostBody('evil.example:8082').error, /this host \("evil\.example"\) is not allowed/);
    assert.match(foreignHostBody(undefined).error, /this host \(""\) is not allowed/);
  });
});

describe('hostRuleOf (the list as Vite resolved it)', () => {
  it('no config (Magnusim CAD): this PC only', () => {
    assert.equal(hostRuleOf(undefined, 'server'), LOOPBACK_ONLY);
    assert.equal(hostRuleOf(null, 'preview'), LOOPBACK_ONLY);
  });

  it('the dev server reads server.allowedHosts; vite preview reads preview.allowedHosts, else the dev server\'s', () => {
    const config = { server: { allowedHosts: ['dev.example'] }, preview: { allowedHosts: ['prod.example'] } };
    assert.deepEqual(hostRuleOf(config, 'server').allowed, ['dev.example']);
    assert.deepEqual(hostRuleOf(config, 'preview').allowed, ['prod.example']);
    assert.deepEqual(hostRuleOf({ server: { allowedHosts: ['dev.example'] }, preview: {} }, 'preview').allowed, ['dev.example']);
    assert.equal(hostRuleOf({ server: { allowedHosts: true } }, 'server').allowed, true);
  });

  it('adds the names Vite adds (its host, the HMR host, the origin\'s hostname); HTTPS checks no host, as Vite', () => {
    const rule = hostRuleOf({ server: { allowedHosts: [], host: 'mypc.lan', hmr: { host: 'hmr.lan' }, origin: 'http://origin.lan:9000' }, preview: { host: 'preview.lan' } }, 'server');
    assert.deepEqual([...rule.extra].sort(), ['hmr.lan', 'mypc.lan', 'origin.lan', 'preview.lan']);
    assert.equal(isAllowedHost('origin.lan:8082', rule), true);
    assert.equal(isAllowedHost('evil.example:8082', rule), false);
    assert.equal(hostRuleOf({ server: { allowedHosts: [], https: {} } }, 'server').allowed, true);
    assert.deepEqual(hostRuleOf({ server: { allowedHosts: [], https: {} }, preview: {} }, 'preview').allowed, []);
  });

  it('vite.config.js gives the dev server and vite preview one list, with the public tunnel\'s host in it', () => {
    const src = readFileSync(join(WEB, 'vite.config.js'), 'utf8');
    assert.match(src, /const defaultAllowedHosts = \['simulation\.lilmill2000\.com', '\.lilmill2000\.com'\];/);
    assert.match(src, /const allowedHosts = \[\.\.\.new Set\(\[\.\.\.defaultAllowedHosts, \.\.\.envHosts\]\)\];/);
    assert.equal(src.match(/^\s+allowedHosts,$/gm)?.length, 2, 'server.allowedHosts and preview.allowedHosts');
  });

  it('index.ts refuses a foreign host first: before the frame-file exemption, the same-origin check and dispatch', () => {
    const src = readFileSync(join(WEB, 'scripts', 'server', 'index.ts'), 'utf8');
    const prefix = src.indexOf("!url.startsWith('/plugin-sdk/')");
    const host = src.indexOf('if (refuseForeignHost(req, res, hostRule)) return;');
    const frame = src.indexOf('if (!isFrameAssetRequest(req.method, url)) assertSameOrigin(req);');
    const dispatchAt = src.indexOf('await dispatch(router, req, res)');
    assert.ok(prefix > 0 && host > prefix && frame > host && dispatchAt > frame, 'path prefix, then the host check, then the rest');
    assert.match(src, /const hostRule = hostRuleOf\(server\.config, sdkVariant === 'prod' \? 'preview' : 'server'\);/);
  });
});

describe('Magnusim CAD\'s server (no Vite config): a rebinding page gets 403 on every route class', () => {
  let server;
  let port;
  const EVIL = 'evil.example';

  before(async () => {
    server = await startCadServer({});
    port = server.port;
  });

  after(async () => {
    await server?.close();
  });

  const projects = async () => (await asPage(port, '127.0.0.1', { path: '/api/projects' })).json.projects.map((p) => p.id).sort();

  it('API read: GET /api/projects and the project tree', async () => {
    for (const path of ['/api/projects', '/api/project/tree?project_id=none', '/api/plugins']) {
      assertRefused(await asPage(port, EVIL, { path }), EVIL, `${path} with Origin`);
      // A same-origin GET carries no Origin at all.
      assertRefused(await asPage(port, EVIL, { path, origin: false }), EVIL, `${path} without Origin`);
    }
    for (const name of ['127.0.0.1', 'localhost']) {
      const ok = await asPage(port, name, { path: '/api/projects' });
      assert.equal(ok.status, 200, name);
      assert.ok(Array.isArray(ok.json.projects), name);
    }
  });

  it('API write: POST /api/project makes no project for the foreign host, and one for this PC', async () => {
    const before = await projects();
    const refused = await asPage(port, EVIL, { method: 'POST', path: '/api/project', body: { title: 'Rebound', units: 'Metric' } });
    assertRefused(refused, EVIL, 'POST /api/project');
    assert.deepEqual(await projects(), before, 'no project was made');
    const made = await asPage(port, '127.0.0.1', { method: 'POST', path: '/api/project', body: { title: 'Local', units: 'Metric' } });
    assert.equal(made.status, 201, made.text.slice(0, 200));
    assert.equal((await projects()).length, before.length + 1);
  });

  it('event stream: GET /api/events opens no stream for the foreign host', async () => {
    const refused = await asPage(port, EVIL, { path: '/api/events?tab=rebind-tab-0001' });
    assertRefused(refused, EVIL, 'GET /api/events');
    assert.doesNotMatch(refused.text, /event: hello/);
    const ok = await asPage(port, '127.0.0.1', { path: '/api/events?tab=local-tab-0001' });
    assert.equal(ok.status, 200);
    assert.match(ok.type, /text\/event-stream/);
    assert.match(ok.text, /event: hello/);
  });

  it('plugin files: a workspace page and an SDK file (the frame\'s own GETs, which skip the same-origin check)', async () => {
    for (const path of ['/plugins/cad/workspace/index.html', '/plugin-sdk/workspace.js']) {
      assertRefused(await asPage(port, EVIL, { path, origin: false }), EVIL, path);
    }
    const page = await asPage(port, '127.0.0.1', { path: '/plugins/cad/workspace/index.html', origin: false });
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.match(page.type, /text\/html/);
    const sdk = await asPage(port, 'localhost', { path: '/plugin-sdk/workspace.js', origin: false });
    assert.equal(sdk.status, 200, sdk.text.slice(0, 200));
    assert.match(sdk.type, /text\/javascript/);
  });

  it('a name only this server\'s Vite would know is still foreign here (no config: this PC only)', async () => {
    assertRefused(await asPage(port, 'simulation.lilmill2000.com', { path: '/api/projects' }), 'simulation.lilmill2000.com', 'tunnel host');
  });
});
