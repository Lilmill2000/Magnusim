// A workspace page's first paint has the app's look (1.9, unreleased): the server puts the
// person's look in the page's head (meta magnusim-look) as it serves it, and the host's pre-paint
// (LOOK_SCRIPT, allowed by its hash) shows it on html before the page's own styles and scripts:
// data-theme (a "system" choice decided by the frame's prefers-color-scheme), data-theme-pref and
// the scales. The SDK sets them again from the host's look once the page connects.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-workspace-look-'));
const LOCAL = join(ROOT, 'local.json');
process.env.MAGNUSIM_LOCAL_JSON = LOCAL;

const { resetPrefsCache } = await import('../../prefs.js');
const { injectWorkspaceHead, isPageLoad, LOOK_SCRIPT, workspaceCsp } = await import('../workspace-files.ts');
const { JobManager } = await import('../jobs.ts');
const { Router, dispatch } = await import('../router.ts');
const { registerPhase3Routes } = await import('../routes.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const PAGE = '<!doctype html><html><head><title>Bench</title></head><body>ok</body></html>';

/** The meta's content as the browser reads it (its entities decoded), or null when the head has none. */
function lookIn(html) {
  const m = html.match(/<meta name="magnusim-look" content="([^"]*)">/);
  if (!m) return null;
  return m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Run the pre-paint on a page whose head has `content` (null: no meta), the system light or dark. */
function prePaint(content, dark = false) {
  const attrs = {};
  const style = {};
  const meta = content === null ? null : { getAttribute: (name) => (name === 'content' ? content : null) };
  const document = {
    querySelector: (sel) => (sel === 'meta[name="magnusim-look"]' ? meta : null),
    documentElement: {
      setAttribute: (k, v) => void (attrs[k] = v),
      style: { setProperty: (k, v) => void (style[k] = v) },
    },
  };
  const window = { matchMedia: (q) => ({ matches: dark && q === '(prefers-color-scheme: dark)' }) };
  vm.runInNewContext(LOOK_SCRIPT, { document, window });
  return { attrs, style };
}

describe("a workspace page's first paint", () => {
  it('puts the look in the head before the pre-paint, and the CSP allows the pre-paint by its hash', () => {
    const html = injectWorkspaceHead(PAGE, { theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    assert.match(html, /^<!doctype html><html><head><meta name="magnusim-look" content="[^"]*"><script>/);
    assert.deepEqual(JSON.parse(lookIn(html)), { theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    const hash = createHash('sha256').update(LOOK_SCRIPT).digest('base64');
    assert.ok(html.includes(`<script>${LOOK_SCRIPT}</script>`));
    assert.ok(workspaceCsp('127.0.0.1:1', 'k').includes(`'sha256-${hash}'`));
    // Only the look's three fields go, and nothing in them leaves the attribute.
    const odd = injectWorkspaceHead(PAGE, { theme: '"><script>alert(1)</script>', text_scale: 1, icon_scale: 1, extra: 'x' });
    assert.doesNotMatch(odd, /"><script>alert/);
    assert.deepEqual(JSON.parse(lookIn(odd)), { theme: '"><script>alert(1)</script>', text_scale: 1, icon_scale: 1 });
    // A "$" in the look is text, never a replacement pattern of the head's insert.
    const dollar = injectWorkspaceHead(PAGE, { theme: "$'$&$`", text_scale: 1, icon_scale: 1 });
    assert.equal(JSON.parse(lookIn(dollar)).theme, "$'$&$`");
    assert.equal(dollar.match(/<title>Bench<\/title>/g).length, 1);
    assert.ok(dollar.endsWith('<body>ok</body></html>'));
    // No look (the dev sheet): no meta, and the pre-paint leaves the page light.
    assert.equal(lookIn(injectWorkspaceHead(PAGE)), null);
  });

  it("only a page load gets the look (no Origin; Sec-Fetch-Dest a frame or a document, or none): a fetch() from another site reads the file, never the person's look", () => {
    for (const dest of [undefined, '', 'iframe', 'frame', 'document', ['iframe']]) assert.equal(isPageLoad(dest, undefined), true, String(dest));
    for (const dest of ['empty', 'script', 'image', 'style', 'worker', 'object', 'embed', ['empty']]) assert.equal(isPageLoad(dest, undefined), false, String(dest));
    // A fetch() always sends Origin (a load's GET never does): with no Fetch Metadata too, or saying "iframe".
    for (const dest of [undefined, 'iframe', 'document']) assert.equal(isPageLoad(dest, 'https://elsewhere.example'), false, String(dest));
    assert.equal(isPageLoad(undefined, 'null'), false);
  });

  it('the pre-paint shows the look on html: dark, the system\'s, the scales; junk or none changes nothing', () => {
    const run = (look, dark) => prePaint(JSON.stringify(look), dark);
    assert.deepEqual(run({ theme: 'dark', text_scale: 1.3, icon_scale: 0.85 }), {
      attrs: { 'data-theme': 'dark', 'data-theme-pref': 'dark' },
      style: { '--mg-text-scale': '1.3', '--mg-icon-scale': '0.85' },
    });
    assert.deepEqual(run({ theme: 'system', text_scale: 1, icon_scale: 1 }, true).attrs, { 'data-theme': 'dark', 'data-theme-pref': 'system' });
    assert.deepEqual(run({ theme: 'system', text_scale: 1, icon_scale: 1 }, false).attrs, { 'data-theme': 'light', 'data-theme-pref': 'system' });
    assert.deepEqual(run({ theme: 'light', text_scale: 1, icon_scale: 1 }, true).attrs, { 'data-theme': 'light', 'data-theme-pref': 'light' });
    // A size outside 0.5 to 3, or not a number, is not set (the stylesheet's 1).
    assert.deepEqual(run({ theme: 'dark', text_scale: 9, icon_scale: '1.5' }).style, {});
    for (const content of [null, '', 'null', '{"theme":"neon"}', '{not json', '[]']) {
      assert.deepEqual(prePaint(content), { attrs: {}, style: {} }, String(content));
    }
  });

  it("the served page carries the person's look as it is now, and a change shows at the next load", async () => {
    writeFileSync(LOCAL, JSON.stringify({ theme: 'system', text_scale: 1.15, icon_scale: 1.25 }));
    resetPrefsCache();
    const saved = process.env.MAGNUSIM_BUNDLED_DIR;
    delete process.env.MAGNUSIM_BUNDLED_DIR;
    const folder = join(ROOT, 'bundled-plugins', 'look-demo');
    mkdirSync(join(folder, 'workspace'), { recursive: true });
    writeFileSync(join(folder, 'workspace', 'index.html'), PAGE);
    const worker = {
      async call(method) {
        if (method === 'plugins.list') return { plugins: [{ key: 'look-demo', tier: 'bundled', dir: 'look-demo', status: 'enabled' }] };
        return {};
      },
    };
    const router = new Router();
    registerPhase3Routes(router, {
      worker,
      jobs: new JobManager({ cacheDir: join(ROOT, 'cache-jobs') }),
      webRoot: ROOT,
      cacheDir: join(ROOT, 'cache'),
      serveLegacyFilter: async () => {},
      startMeshJob() {},
      startSolveJob() {},
      startCadImportJob() {},
      caseSnapshot: () => ({}),
      attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
      resetCaseIdle() {},
    });
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => dispatch(router, req, res));
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${server.address().port}/plugins/look-demo/workspace/index.html`;
    try {
      const first = await fetch(url);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.deepEqual(JSON.parse(lookIn(await first.text())), { theme: 'system', text_scale: 1.15, icon_scale: 1.25 });
      // Saved meanwhile (Settings, another tab, the Assistant): the next load has it.
      writeFileSync(LOCAL, JSON.stringify({ theme: 'dark', text_scale: 1, icon_scale: 1 }));
      resetPrefsCache();
      assert.deepEqual(JSON.parse(lookIn(await (await fetch(url)).text())), { theme: 'dark', text_scale: 1, icon_scale: 1 });
      // A fetch() of the page (another site's, which may read it: ACAO *) gets no look; the frame's load does.
      const fetched = await fetch(url, { headers: { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(fetched.status, 200);
      assert.equal(fetched.headers.get('access-control-allow-origin'), '*');
      assert.equal(lookIn(await fetched.text()), null);
      // A browser without Fetch Metadata: its fetch() still sends Origin.
      assert.equal(lookIn(await (await fetch(url, { headers: { Origin: 'https://elsewhere.example' } })).text()), null);
      assert.deepEqual(JSON.parse(lookIn(await (await fetch(url, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).text())), { theme: 'dark', text_scale: 1, icon_scale: 1 });
      // Junk in the prefs reads as the defaults.
      writeFileSync(LOCAL, JSON.stringify({ theme: 'neon', text_scale: 7 }));
      resetPrefsCache();
      assert.deepEqual(JSON.parse(lookIn(await (await fetch(url)).text())), { theme: 'light', text_scale: 1, icon_scale: 1 });
    } finally {
      server.close();
      if (saved === undefined) delete process.env.MAGNUSIM_BUNDLED_DIR;
      else process.env.MAGNUSIM_BUNDLED_DIR = saved;
    }
  });
});
