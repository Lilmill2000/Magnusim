import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startHost } from './support/host-server.mjs';

// A plugin's prefs for the user (host API 1.7, ws.prefs): the ws-demo workspace keeps a
// toolbar layout that holds in every project and after a reload, the app's other tab
// hears the change (the page that made it does not), a plugin keeps at most 64 KB, and
// the file is beside the machine prefs (this server's own, never this PC's).
const KEY = 'ws-demo';
const SEEDED = 'sample-project-steady-state-e2e';

function stage(t0, msg) {
  console.log(`[plugin-prefs +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

test('gate:prefs a plugin keeps the user\'s prefs in every project; another tab hears a change; 64 KB at most @plugins', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'prefs', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  const { base } = host;
  const context = await browser.newContext();
  try {
    const project = await request.post(`${base}/api/project`, { data: { title: 'Prefs B', folder: 'My Projects', units: 'Metric', category: 'Other' } });
    expect(project.ok(), await project.text()).toBe(true);
    const other = (await project.json()).id;
    const study = async (pid, title) => {
      const r = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: KEY, kind: 'bench_case', title } });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()).study.id;
    };
    const sa = await study(SEEDED, 'Bench A');
    const sb = await study(other, 'Bench B');
    /** A tab with the workspace open, its page's ws, and what its onChange heard. */
    const open = async (pid, sid, title) => {
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(`${base}/#/p/${pid}/ws/${KEY}/bench/${sid}`);
      await expect(page.frameLocator('#workspace-frame').locator('#bench-title')).toHaveText(title, { timeout: 60_000 });
      const frame = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
      expect(frame, 'workspace frame').toBeTruthy();
      await frame.evaluate(() => {
        window.__heard = [];
        window.__ws.prefs.onChange((key, value) => window.__heard.push([key, value]));
      });
      return { page, frame };
    };
    const a = await open(SEEDED, sa, 'Bench A');
    const b = await open(other, sb, 'Bench B');
    stage(t0, 'two tabs, two projects');
    expect(await a.frame.evaluate(() => typeof window.__ws.prefs)).toBe('object');
    expect(await b.frame.evaluate(() => window.__ws.prefs.get('toolbar-layout'))).toBeNull();

    // Tab A arranges its toolbar: tab B (another project) hears it; A does not hear its own.
    const layout = { order: ['extrude', 'sketch', 'fillet'], hidden: ['loft'] };
    await a.frame.evaluate((v) => window.__ws.prefs.set('toolbar-layout', v), layout);
    await expect.poll(() => b.frame.evaluate(() => window.__heard)).toEqual([['toolbar-layout', layout]]);
    expect(await a.frame.evaluate(() => window.__heard)).toEqual([]);
    expect(await b.frame.evaluate(() => window.__ws.prefs.get('toolbar-layout'))).toEqual(layout);
    stage(t0, 'set in A, heard and read in B');

    // On disk beside this server's machine prefs (startHost's MAGNUSIM_LOCAL_JSON).
    const file = join(dirname(host.prefs), '.magnusim-plugin-prefs', `${KEY}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'toolbar-layout': layout });

    // A reload of B reads it again.
    await b.page.reload();
    await expect(b.page.frameLocator('#workspace-frame').locator('#bench-title')).toHaveText('Bench B', { timeout: 60_000 });
    const b2 = b.page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
    expect(await b2.evaluate(() => window.__ws.prefs.get('toolbar-layout'))).toEqual(layout);
    await b2.evaluate(() => {
      window.__heard = [];
      window.__ws.prefs.onChange((key, value) => window.__heard.push([key, value]));
    });

    // 64 KB at most: the set is refused with its code and nothing changes.
    const big = await a.frame.evaluate(() =>
      window.__ws.prefs.set('big', 'x'.repeat(70 * 1024)).then(
        () => 'stored',
        (e) => e.code,
      ),
    );
    expect(big).toBe('too_large');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'toolbar-layout': layout });
    // A name the rule refuses.
    expect(await a.frame.evaluate(() => window.__ws.prefs.set('Bad Name', 1).then(() => 'stored', (e) => e.code))).toBe('invalid_key');

    // Reset: removing it reaches the other tab as null, and the file goes.
    await a.frame.evaluate(() => window.__ws.prefs.remove('toolbar-layout'));
    await expect.poll(() => b2.evaluate(() => window.__heard)).toEqual([['toolbar-layout', null]]);
    expect(await a.frame.evaluate(() => window.__ws.prefs.get('toolbar-layout'))).toBeNull();
    expect(existsSync(file)).toBe(false);
    stage(t0, 'cap, key rule and reset');
  } finally {
    await context.close();
    await host.stop();
  }
});
