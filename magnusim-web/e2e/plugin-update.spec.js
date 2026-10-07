import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { PYTHON } from '../scripts/python-env.js';

// Plugin updates, as the user meets them in Settings > Plugins: a zip made like
// `npm run plugin:pack` makes it is checked first (one that is not newer than the
// copy that ships with the app is refused, saying why), installed only after
// Install, listed as an update, and used (its workspace is the new version);
// Remove update brings the version that ships with the app back.
// A second app server whose bundled folder holds Incompressible Flow and the
// opt-demo fixture (python/tests/fixtures/optional-plugins), turned on.
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'opt-demo';

function stage(t0, msg) {
  console.log(`[plugin-update +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

/** A copy of opt-demo at `version` whose workspace says `says`, zipped by plugin_package.pack_plugin. */
function packedOptDemo(tmp, version, says) {
  const src = join(tmp, `src-${version}`, KEY);
  cpSync(resolve('python/tests/fixtures/optional-plugins/opt-demo'), src, { recursive: true });
  const manifest = join(src, 'manifest.toml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version = "1.0.0"', `version = "${version}"`));
  const main = join(src, 'workspace', 'main.js');
  writeFileSync(main, readFileSync(main, 'utf8').replace('Optional demo connected', says));
  return pack(src, join(tmp, 'dist'));
}

/** A plugin folder zipped as `npm run plugin:pack` zips it (plugin_package.pack_plugin); the zip's path. */
function pack(src, out) {
  const code = [
    'import json, sys',
    'from cfddesk.registry.plugin_package import pack_plugin',
    'print(json.dumps(pack_plugin(sys.argv[1], sys.argv[2])))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, src, out], { cwd: resolve('python'), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pack failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).zip;
}

test('a newer copy of a bundled plugin installs from a zip, is used, and Remove update brings the app copy back', async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const tmp = e2eTemp('plugin-update');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  cpSync(resolve('python/tests/fixtures/optional-plugins/opt-demo'), join(bundled, KEY), { recursive: true });
  const same = packedOptDemo(tmp, '1.0.0', 'Optional demo connected');
  const newer = packedOptDemo(tmp, '1.1.0', 'Optional demo 1.1 connected');
  const host = await startHost({ name: 'plugin-update', tmp, projects, bundledDir: bundled, enablePlugins: [KEY] });
  const { base, pluginsDir } = host;
  const wizard = page.locator('#setup-wizard');
  const row = wizard.locator(`[data-plugin-key="${KEY}"]`);
  const note = wizard.locator('.wiz-plugin-note');
  const openPlugins = async () => {
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    await expect(row).toBeVisible();
  };
  const closeSettings = async () => {
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
  };
  const newStudy = async (title) => {
    await page.locator('#btn-workspaces').click();
    await page.locator(`[data-ws-new="${KEY}:opt_case"]`).click();
    await page.locator('#pm-input').fill(title);
    await page.locator('#pm-confirm').click();
  };
  try {
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await openPlugins();
    await expect(row).toHaveAttribute('data-plugin-copy', 'app');
    await expect(row.locator('.wiz-plugin-meta').first()).toHaveText(/v1\.0\.0 · bundled/);
    stage(t0, 'the app copy is listed');

    // Not newer than the copy that ships with the app: refused, saying why; nothing is written.
    await wizard.locator('[data-plugin-zip-input]').setInputFiles(same);
    await expect(note).toHaveText(
      `${KEY}-v1.0.0.zip cannot be installed: Optional demo 1.0.0 is not newer than the copy that comes with Magnusim (1.0.0), so it would not be used.`,
    );
    await expect(wizard.locator('[data-plugin-package]')).toHaveCount(0);
    expect(readdirSync(pluginsDir)).toEqual([]);
    stage(t0, 'a same-version zip is refused');

    // Newer: checked, shown, installed only after Install.
    await wizard.locator('[data-plugin-zip-input]').setInputFiles(newer);
    const card = wizard.locator(`[data-plugin-package="${KEY}"]`);
    await expect(card.locator('strong')).toHaveText('Update Optional demo from 1.0.0 to 1.1.0.');
    await expect(card).toContainText('A plugin runs its own code on this PC.');
    expect(readdirSync(pluginsDir)).toEqual([]);
    await card.locator('[data-plugin-package-confirm]').click();
    await expect(note).toHaveText('Optional demo 1.1.0 is installed.', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-plugin-copy', 'update');
    await expect(row.locator('.wiz-plugin-meta').first()).toHaveText(/v1\.1\.0 · update/);
    await expect(row.locator('[data-plugin-update-note]')).toHaveText(
      'An update from the plugins folder, used in place of the version that ships with Magnusim (1.0.0).',
    );
    // Its screens are in its workspace, not in this page: nothing asks for a page reload.
    await expect(row.locator('[data-plugin-stale]')).toHaveCount(0);
    expect(readdirSync(pluginsDir)).toEqual([KEY]);
    expect(existsSync(join(pluginsDir, KEY, 'workspace', 'main.js'))).toBe(true);
    stage(t0, 'the update is installed and listed');

    // Used: its workspace is the new version.
    await closeSettings();
    await newStudy('First part');
    await expect(page.frameLocator('#workspace-frame').locator('#opt-status')).toHaveText('Optional demo 1.1 connected: First part', {
      timeout: 60_000,
    });
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    stage(t0, 'the update runs');

    // Remove update: asks first, then the copy that ships with the app is back.
    await openPlugins();
    await row.locator(`[data-plugin-remove="${KEY}"]`).click();
    const confirm = wizard.locator(`[data-plugin-remove-confirm="${KEY}"]`);
    await expect(confirm.locator('strong')).toHaveText('Remove the Optional demo 1.1.0 update?');
    expect(readdirSync(pluginsDir)).toEqual([KEY]);
    await confirm.locator('[data-plugin-remove-ok]').click();
    await expect(note).toHaveText('Removed. Optional demo is back to the version that ships with Magnusim (1.0.0).', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-plugin-copy', 'app');
    await expect(row.locator('.wiz-plugin-meta').first()).toHaveText(/v1\.0\.0 · bundled/);
    expect(readdirSync(pluginsDir)).toEqual([]);
    await closeSettings();
    await newStudy('Second part');
    await expect(page.frameLocator('#workspace-frame').locator('#opt-status')).toHaveText('Optional demo connected: Second part', {
      timeout: 60_000,
    });
    stage(t0, 'removed: the app copy runs again');
  } finally {
    host.stop();
  }
});

/** The flood-demo fixture (a job plugin) at `version`, its register() raising when `broken`, packed. */
function packedFloodDemo(tmp, version, { broken = false } = {}) {
  const src = join(tmp, `flood-${version}${broken ? '-broken' : ''}`, 'flood-demo');
  cpSync(resolve('python/tests/fixtures/flood-plugins/flood-demo'), src, { recursive: true, filter: (p) => !p.includes('__pycache__') });
  const manifest = join(src, 'manifest.toml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version = "1.0.0"', `version = "${version}"`));
  if (broken) writeFileSync(join(src, 'plugin.py'), 'def register(hub):\n    raise RuntimeError("v2 is broken")\n');
  return pack(src, join(tmp, 'dist'));
}

test('a user plugin: installed from a zip, a new version that does not load keeps the old one, Remove names the job it stops', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const tmp = e2eTemp('plugin-user-pkg');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  const v1 = packedFloodDemo(tmp, '1.0.0');
  const v2 = packedFloodDemo(tmp, '2.0.0', { broken: true });
  const host = await startHost({ name: 'plugin-user-pkg', tmp, projects, bundledDir: bundled });
  const { base, pluginsDir } = host;
  const wizard = page.locator('#setup-wizard');
  const row = wizard.locator('[data-plugin-key="flood-demo"]');
  const note = wizard.locator('.wiz-plugin-note');
  try {
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    await expect(wizard.locator('[data-plugin-key="incompressible_flow"]')).toBeVisible();

    await wizard.locator('[data-plugin-zip-input]').setInputFiles(v1);
    const card = wizard.locator('[data-plugin-package="flood-demo"]');
    await expect(card.locator('strong')).toHaveText('Install Flood demo 1.0.0.');
    await expect(card.locator('[data-plugin-work]')).toHaveCount(0);
    await card.locator('[data-plugin-package-confirm]').click();
    await expect(note).toHaveText('Flood demo 1.0.0 is installed.', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-plugin-copy', 'user');
    stage(t0, 'a user plugin is installed');

    // Its new version fails in register(): taken away again, the old one stays and runs.
    await wizard.locator('[data-plugin-zip-input]').setInputFiles(v2);
    await expect(card.locator('strong')).toHaveText('Update Flood demo from 1.0.0 to 2.0.0.');
    await card.locator('[data-plugin-package-confirm]').click();
    await expect(note).toHaveText('Flood demo 2.0.0 did not load (v2 is broken); the previous version 1.0.0 is kept.', {
      timeout: 60_000,
    });
    await expect(row.locator('.wiz-plugin-meta').first()).toHaveText(/v1\.0\.0 · local/);
    await expect(row).toHaveAttribute('data-plugin-status', 'enabled');
    expect(readdirSync(pluginsDir)).toEqual(['flood-demo']);
    expect(readFileSync(join(pluginsDir, 'flood-demo', 'manifest.toml'), 'utf8')).toContain('version = "1.0.0"');
    stage(t0, 'a broken new version kept the old one');

    // A job of it runs: Remove says it stops it, and does.
    const started = await request.post(`${base}/api/jobs`, {
      data: { kind: 'flood_demo_events', params: { project_id: PROJECT, steps: 240000, rate: 20 } },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const jobId = (await started.json()).job.id;
    const jobStatus = async () => (await (await request.get(`${base}/api/jobs/${jobId}?project_id=${PROJECT}`)).json()).job?.status;
    await expect.poll(jobStatus, { timeout: 30_000 }).toBe('running');
    await row.locator('[data-plugin-remove="flood-demo"]').click();
    const confirm = wizard.locator('[data-plugin-remove-confirm="flood-demo"]');
    await expect(confirm.locator('strong')).toHaveText('Remove Flood demo?');
    await expect(confirm.locator('[data-plugin-work]')).toHaveText(
      'Removing it stops what runs on this plugin now: 1 running (flood_demo_events) stops.',
    );
    expect(await jobStatus()).toBe('running');
    await confirm.locator('[data-plugin-remove-ok]').click();
    await expect(note).toHaveText('Flood demo was removed.', { timeout: 60_000 });
    await expect(row).toHaveCount(0);
    await expect.poll(jobStatus, { timeout: 30_000 }).toBe('stopped');
    expect(readdirSync(pluginsDir)).toEqual([]);
    stage(t0, 'removed, and its job stopped');
  } finally {
    host.stop();
  }
});
