import { expect, test } from '@playwright/test';
import { NO_GEOMETRY_PROJECT } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';

// H13, a plugin's full workspace as the user meets it: a study opens in the
// plugin's own page, in a sandboxed frame over the workbench, with the app's
// header (Back, the study's name, Queue, Settings); Back, reload, deep links and
// browser history work and leave the project as it was; the page loads its
// modules, WASM and a worker, talks to the app only through the bridge, and
// cannot reach the app's page, API or storage; a page that never connects
// shows an error card; a plugin that is off has no launcher, and its studies'
// Settings link looks like the app's other links; "+ New" in STUDIES offers the
// first free name and opens the new study. A second app server with the
// workspace fixture plugin (python/tests/fixtures/workspace-plugins).
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'ws-demo';

function stage(t0, msg) {
  console.log(`[h13 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

test('gate:h13-workspace-route, sandbox, assets, handshake error and launchers', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'h13', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  const { base } = host;
  const newStudy = async (kind, title) => {
    const r = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind, title } });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    return j.study;
  };
  try {
    const bench = await newStudy('bench_case', 'Wing section');
    const silent = await newStudy('silent_case', 'Quiet one');
    // Names taken (one in other letters), so "+ New Bench case" offers "Bench case 3".
    await newStudy('bench_case', 'Bench case 1');
    await newStudy('bench_case', 'bench case 2');
    stage(t0, `server up, studies ${bench.id} and ${silent.id}`);

    // The study opens from the tree, over the workbench.
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    const scopeBefore = await page.evaluate(() => ({ study: window.__CFD_W17__?.activeId || null, hash: location.hash }));
    const row = page.locator(`#plugin-studies-section [data-plugin-study="${bench.id}"] > .tree-row`);
    await row.click();
    const overlay = page.locator('#workspace-overlay');
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}/ws/${KEY}/bench/${bench.id}$`));
    await expect(overlay.locator('[data-ws-crumb]')).toHaveText(/Workspace demo\s*›\s*Wing section/);
    // The app's Queue and Settings stay in reach in the workspace header.
    await expect(overlay.locator('.ws-header-right #btn-queue')).toBeVisible();
    await expect(overlay.locator('.ws-header-right #wb-prefs')).toBeVisible();
    const frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#bench-title')).toHaveText('Wing section');
    await expect(frame.locator('#bench-status')).toHaveText('Connected to ' + (await page.evaluate(() => window.__CFD_W16__?.project?.title || '')));
    await expect(frame.locator('[data-react]')).toHaveText(`React in the frame: ${KEY} / bench`);
    await expect(overlay.locator('[data-ws-loading]')).toHaveCount(0);
    // gate:h13-assets: a module (this page), WASM and a worker from the plugin's folder;
    // messages posted right after spawnWorker() reach the worker's late listener, in order.
    await expect(frame.locator('#bench-checks')).toHaveText(JSON.stringify({ wasm: 42, worker: 42, early: ['first', 'second'], units: 'metric' }), {
      timeout: 15_000,
    });
    stage(t0, 'workspace open: module, WASM, worker, React');

    // gate:h13-sandbox: from inside the frame, nothing but the bridge.
    const inside = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
    expect(inside, 'workspace frame').toBeTruthy();
    const probe = await inside.evaluate(async () => {
      const out = {};
      try {
        void parent.document.title;
        out.parentDocument = 'readable';
      } catch (e) {
        out.parentDocument = e.name;
      }
      try {
        localStorage.setItem('x', '1');
        out.localStorage = 'available';
      } catch (e) {
        out.localStorage = e.name;
      }
      try {
        const r = await fetch('/api/plugins');
        out.api = 'answered ' + r.status;
      } catch (e) {
        out.api = 'blocked';
      }
      const ws = window.__ws;
      const refused = async (p) => p.then(() => 'allowed', (e) => e.message);
      out.unknownCall = await refused(ws.call('fs.read', { path: 'C:/' }));
      out.otherPlugin = await refused(ws.call('service.call', { plugin: 'other-plugin', method: 'echo', params: {} }));
      out.otherJob = await refused(ws.call('jobs.stop', { jobId: 'job-somebody-else' }));
      out.echo = await ws.service('echo', { text: 'hi' });
      await ws.data.write('notes/n.json', { text: 'kept' });
      out.readBack = await ws.data.read('notes/n.json');
      // A data file up to 8 MB goes through (the app's request limit is 2 MB elsewhere).
      await ws.data.write('big/b.json', 'x'.repeat(5 * 1024 * 1024));
      out.big = String(await ws.data.read('big/b.json')).length;
      out.tooBig = await refused(ws.data.write('big/c.json', 'x'.repeat(8.5 * 1024 * 1024)));
      out.studyRecordWrite = await refused(ws.data.write(`studies/${ws.context.study.id}/study.json`, {}));
      const study = await ws.study.get();
      const saved = await ws.study.update({ chord_mm: 120 }, study.rev);
      out.saved = [saved.chord_mm, saved.rev === study.rev + 1];
      out.stale = await refused(ws.study.update({ chord_mm: 1 }, study.rev));
      out.info = await ws.project.info();
      return out;
    });
    expect(probe.parentDocument).toBe('SecurityError');
    expect(probe.localStorage).toBe('SecurityError');
    expect(probe.api).toBe('blocked');
    expect(probe.unknownCall).toBe('not allowed: "fs.read"');
    expect(probe.otherPlugin).toBe("not allowed: another plugin's service");
    expect(probe.otherJob).toBe('not allowed: a job this workspace did not start');
    expect(probe.echo).toEqual({ echo: 'hi', project_id: PROJECT });
    expect(probe.readBack).toEqual({ text: 'kept' });
    expect(probe.big).toBe(5 * 1024 * 1024);
    expect(probe.tooBig).toMatch(/larger than 8 MB/);
    expect(probe.studyRecordWrite).toMatch(/only through the study calls/);
    expect(probe.saved).toEqual([120, true]);
    expect(probe.stale).toMatch(/changed in another tab/);
    expect(probe.info).toMatchObject({ id: PROJECT, units: 'metric' });
    // Unit changes reach the frame live.
    const units = inside.evaluate(() => new Promise((r) => window.__ws.on('units', r)));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:units')));
    expect(await units).toBe('metric');
    stage(t0, 'sandbox and bridge allowlist');

    // Renaming from the header: the header, the page and the tree follow, and the
    // page's next save (with the rev the host pushed) is not refused as stale.
    await overlay.locator('[data-ws-title]').click();
    await page.locator('#pm-input').fill('Wing section B');
    await page.locator('#pm-confirm').click();
    await expect(overlay.locator('[data-ws-title]')).toHaveText('Wing section B');
    await expect(frame.locator('#bench-title')).toHaveText('Wing section B');
    const afterRename = await inside.evaluate(async () => {
      const ws = window.__ws;
      const s = await ws.study.update({ span_mm: 900 }, ws.context.study.rev);
      return [s.title, s.span_mm, s.chord_mm];
    });
    expect(afterRename).toEqual(['Wing section B', 900, 120]);
    await expect(page.locator(`#plugin-studies-section [data-plugin-study="${bench.id}"]`)).toContainText('Wing section B');
    stage(t0, 'rename from the header');

    // Back: the workbench as it was (same study, header controls back in place).
    await overlay.locator('[data-ws-back]').click();
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}$`));
    await expect(page.locator('#top-header .top-right #btn-queue')).toBeVisible();
    await expect(page.locator('#top-header .top-right #wb-prefs')).toBeVisible();
    // The header is usable again (not left inert by the workspace).
    expect(await page.evaluate(() => document.getElementById('top-header').inert)).toBe(false);
    expect(await page.evaluate(() => window.__CFD_W17__?.activeId || null)).toBe(scopeBefore.study);
    // The row's own Rename asks for a name and does not open the workspace.
    await page.locator(`#plugin-studies-section [data-plugin-study="${bench.id}"] [data-plugin-study-act="rename"]`).click();
    await expect(page.locator('#pm-input')).toHaveValue('Wing section B');
    await expect(overlay).toBeHidden();
    await page.locator('#pm-cancel').click();
    await expect(page.locator('#pm-input')).toBeHidden();
    // Browser back reopens it, forward closes it again.
    await page.goBack();
    await expect(overlay).toBeVisible();
    await expect(frame.locator('#bench-title')).toHaveText('Wing section B');
    await page.goForward();
    await expect(overlay).toBeHidden();
    // A deep link, reloaded, opens the workspace with the project.
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/bench/${bench.id}`);
    await page.reload();
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator('#bench-title')).toHaveText('Wing section B', { timeout: 60_000 });
    expect(await page.evaluate(() => window.__CFD_W17__?.activeId || null)).toBe(scopeBefore.study);
    stage(t0, 'back, history, deep link');

    // Opening another project directly closes the workspace. (The compute queue runs
    // in Node and never switches the browser's project; that is not this path.)
    await page.evaluate((pid) => window.__CFD_HOME__.open(pid, { reloadIfNeeded: false }), NO_GEOMETRY_PROJECT);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, NO_GEOMETRY_PROJECT, { timeout: 60_000 });
    await expect(overlay).toBeHidden();
    await expect(page.locator('#top-header .top-right #btn-queue')).toBeVisible();
    stage(t0, 'another project closes it');

    // gate:h13-handshake-error: a page that never connects shows the error card.
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/silent/${silent.id}`);
    await expect(overlay.locator('[data-ws-loading]')).toHaveText('Starting Workspace demo…', { timeout: 60_000 });
    const card = overlay.locator('[data-ws-error]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('h2')).toHaveText("Workspace demo didn't start.");
    await expect(card).toContainText('did not connect within 5 seconds');
    await expect(card.locator('[data-ws-settings]')).toHaveText('Open Settings → Plugins');
    await expect(card.locator('[data-ws-retry]')).toHaveText('Try again');
    stage(t0, 'handshake error card');

    // gate:h13-no-launcher-when-disabled.
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await expect(page.locator('#btn-workspaces')).toBeVisible();
    const off = await request.post(`${base}/api/plugins/${KEY}/disable`);
    expect(off.ok()).toBe(true);
    await request.post(`${base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await expect(row.locator('xpath=..')).toHaveAttribute('data-unavailable', '1');
    // gate:h13-reason-link: the greyed study's "Open Settings → Plugins" is an inline link in
    // the app's font and link colour, not the browser's default button (Arial, 2 px outset
    // border, grey face, black text).
    const settingsLink = row.locator('xpath=..').locator('[data-plugin-study-reason] button');
    await expect(settingsLink).toHaveText('Open Settings → Plugins');
    const look = await settingsLink.evaluate((b) => {
      const s = getComputedStyle(b);
      // The link colour token, resolved where the link is.
      const probe = document.createElement('span');
      probe.style.color = 'var(--mg-primary-hover)';
      b.parentElement.appendChild(probe);
      const linkColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        font: s.fontFamily,
        appFont: getComputedStyle(document.body).fontFamily,
        borders: [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle],
        background: s.backgroundColor,
        color: s.color,
        linkColor,
        reasonColor: getComputedStyle(b.parentElement).color,
      };
    });
    expect(look.font).toBe(look.appFont);
    expect(look.borders, JSON.stringify(look.borders)).toEqual(['none', 'none', 'none', 'none']);
    expect(look.background).toBe('rgba(0, 0, 0, 0)');
    expect(look.linkColor).not.toBe(look.reasonColor);
    expect(look.color).toBe(look.linkColor);
    await expect(page.locator('#btn-workspaces')).toHaveCount(0);
    await row.click();
    await expect(overlay).toBeHidden();
    expect((await request.get(`${base}/plugins/${KEY}/workspace/index.html`)).status()).toBe(404);
    // A link into its workspace says why it does not open (and where to turn it on).
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/bench/${bench.id}`);
    await expect(overlay.locator('[data-ws-error] h2')).toHaveText('Workspace demo is off.', { timeout: 60_000 });
    await expect(overlay.locator('[data-ws-settings]')).toHaveText('Open Settings → Plugins');
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    await page.goto(`${base}/#/p/${PROJECT}`);
    await expect(overlay).toBeHidden();
    // Turned on in Settings → Plugins, its launchers come back at once (no reload).
    await page.locator('#wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const pluginRow = wizard.locator(`[data-plugin-key="${KEY}"]`);
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'disabled');
    await pluginRow.locator(`[data-plugin-toggle="${KEY}"]`).click();
    await expect(pluginRow).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    await expect(page.locator('#btn-workspaces')).toBeVisible();
    await expect(row.locator('xpath=..')).not.toHaveAttribute('data-unavailable', '1');
    // gate:h13-studies-new: STUDIES "+ New Bench case" asks with the first free name and
    // opens the new study in its workspace, as the Workspaces menu does.
    await page.locator(`#plugin-studies-section [data-plugin-study-new="${KEY}:bench_case"]`).click();
    await expect(page.locator('#modal-prompt')).toBeVisible();
    await expect(page.locator('#pm-input')).toHaveValue('Bench case 3');
    await page.locator('#pm-confirm').click();
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}/ws/${KEY}/bench/st-[a-z0-9-]+$`));
    await expect(overlay.locator('[data-ws-title]')).toHaveText('Bench case 3');
    await expect(frame.locator('#bench-title')).toHaveText('Bench case 3');
    const fromTree = await page.evaluate(() => location.hash.split('/').pop());
    await expect(page.locator(`#plugin-studies-section [data-plugin-study="${fromTree}"] .tl`)).toHaveText('Bench case 3');
    await overlay.locator('[data-ws-back]').click();
    await expect(overlay).toBeHidden();
    // The Workspaces menu: a new study of a kind opens in its workspace. Its name prompt
    // offers the next free name too ("Bench case 3" is taken now).
    await page.locator('#btn-workspaces').click();
    await page.locator(`[data-ws-new="${KEY}:bench_case"]`).click();
    await expect(page.locator('#pm-input')).toHaveValue('Bench case 4');
    await page.locator('#pm-input').fill('From the menu');
    await page.locator('#pm-confirm').click();
    await expect(overlay).toBeVisible();
    await expect(frame.locator('#bench-title')).toHaveText('From the menu');
    stage(t0, 'launchers follow the plugin on/off');

    // A study deleted elsewhere (another tab): its workspace closes into a card,
    // Back returns to the project and the tree no longer lists it.
    const madeId = await page.evaluate(() => location.hash.split('/').pop());
    await expect(page.locator(`#plugin-studies-section [data-plugin-study="${madeId}"]`)).toHaveCount(1);
    const del = await request.post(`${base}/api/plugin-studies/delete`, { data: { project_id: PROJECT, plugin: KEY, study_id: madeId } });
    expect(del.ok()).toBe(true);
    const menuFrame = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/index.html`));
    // The page's next study call finds it gone; the host closes the frame at once
    // (before the call's answer could reach it), so do not wait on the answer.
    await menuFrame.evaluate(() => {
      void window.__ws.study.get().catch(() => undefined);
    });
    await expect(card.locator('h2')).toHaveText('This study no longer exists.');
    await expect(overlay.locator('#workspace-frame')).toHaveCount(0);
    await expect(card.locator('[data-ws-settings]')).toHaveCount(0);
    await card.locator('[data-ws-error-back]').click();
    await expect(overlay).toBeHidden();
    await expect(page.locator(`#plugin-studies-section [data-plugin-study="${madeId}"]`)).toHaveCount(0);
    // Its old link says the same, after a reload too.
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/bench/${madeId}`);
    await page.reload();
    await expect(card.locator('h2')).toHaveText('This study no longer exists.', { timeout: 60_000 });
    stage(t0, 'deleted study');
  } finally {
    host.stop();
  }
});
