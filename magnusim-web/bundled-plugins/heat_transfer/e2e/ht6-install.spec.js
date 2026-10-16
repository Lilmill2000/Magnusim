// Heat Transfer (HT6, release): the plugin as a package, the way `npm run plugin:pack`
// zips it, installed through Settings > Plugins > Install plugin from zip.
// - An app without Heat Transfer: the 0.1.0 zip installs (after Install), is on, and
//   Home opens its heat-sink sample, a conjugate heat transfer study. A 0.1.1 zip then
//   updates it ("Update Heat Transfer from 0.1.0 to 0.1.1.") and the sample still opens.
// - The app as it ships (Heat Transfer 0.1.0 bundled): a 0.1.1 zip installs as an update
//   that is used in place of the bundled copy (a newer copy wins).
// Each on a second app server of its own (startHost), with only the plugins it names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, e2eTemp, expect, prepareE2eProjectsRoot, startHost, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', '..', '..');
const PLUGIN = resolve(HERE, '..');
const PROJECT = 'sample-project-steady-state-e2e';
const CHT_LINE = 'Conjugate heat transfer with chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). Body1 is Air (fluid).';
// What a package leaves out (cfddesk.registry.plugin_package.PACK_SKIP_DIRS).
const SKIP = /[\\/](tests|e2e|node_modules|__pycache__|\.cache|\.pytest_cache|\.ruff_cache|\.mypy_cache)([\\/]|$)/;

/** This plugin's folder at `version`, zipped as plugin:pack zips it; the zip's path. */
function packed(tmp, version) {
  const src = join(tmp, `src-${version}`, 'heat_transfer');
  cpSync(PLUGIN, src, { recursive: true, filter: (p) => !SKIP.test(p.slice(PLUGIN.length)) });
  const swap = (rel, from, to) => {
    const path = join(src, rel);
    const text = readFileSync(path, 'utf8');
    if (!text.includes(from)) throw new Error(`${rel} has no ${from}`);
    writeFileSync(path, text.replace(from, to));
  };
  const now = /^version = "([^"]+)"/m.exec(readFileSync(join(src, 'manifest.toml'), 'utf8'))[1];
  if (version !== now) {
    swap('manifest.toml', `version = "${now}"`, `version = "${version}"`);
    swap(join('heat_transfer', '__init__.py'), `__version__ = "${now}"`, `__version__ = "${version}"`);
    swap(join('ui', 'version.ts'), `'${now}'`, `'${version}'`);
  }
  const code = [
    'import json, sys',
    'from cfddesk.registry.plugin_package import pack_plugin',
    'print(json.dumps(pack_plugin(sys.argv[1], sys.argv[2])))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, src, join(tmp, 'dist')], { cwd: join(WEB, 'python'), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pack failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).zip;
}

/** A bundled folder with Incompressible Flow, and Heat Transfer when `withHeat`. */
function bundledFolder(tmp, withHeat) {
  const bundled = join(tmp, 'bundled');
  const names = withHeat ? ['incompressible_flow', 'heat_transfer'] : ['incompressible_flow'];
  for (const name of names) {
    const from = join(WEB, 'bundled-plugins', name);
    cpSync(from, join(bundled, name), { recursive: true, filter: (p) => !SKIP.test(p.slice(from.length)) });
  }
  return bundled;
}

function settings(page) {
  const wizard = page.locator('#setup-wizard');
  return {
    wizard,
    row: wizard.locator('[data-plugin-key="heat_transfer"]'),
    note: wizard.locator('.wiz-plugin-note'),
    open: async () => {
      await page.locator('#wb-prefs').click();
      await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
      await expect(wizard.locator('[data-plugin-key="incompressible_flow"]')).toBeVisible();
    },
    close: async () => {
      await page.locator('#wiz-next').click();
      await expect(wizard).toBeHidden();
    },
    install: async (zip, summary, done) => {
      await wizard.locator('[data-plugin-zip-input]').setInputFiles(zip);
      const card = wizard.locator('[data-plugin-package="heat_transfer"]');
      await expect(card.locator('strong')).toHaveText(summary, { timeout: 60_000 });
      await card.locator('[data-plugin-package-confirm]').click();
      await expect(wizard.locator('.wiz-plugin-note')).toHaveText(done, { timeout: 120_000 });
    },
  };
}

/** Home → Open sample → Heat sink: the study panel of the new project says conjugate heat transfer. */
async function openTheSample(page, base) {
  await page.goto(`${base}/#/`);
  await page.locator('#home-sample-host [data-home-samples="1"]').click({ timeout: 60_000 });
  await page.locator('[data-home-sample="heat_transfer:heat-sink"]').click();
  await page.waitForURL(/#\/p\//, { timeout: 60_000 });
  const pid = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/p\//, '').split('/')[0]);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  const row = page.locator('#left-tree [data-w17-sim-id]').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const panel = page.locator('#panel-study-settings .cfd-island');
  if (!(await panel.isVisible())) await row.locator(':scope > .tree-row').first().click();
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 60_000 });
  return pid;
}

test('a fresh install from the 0.1.0 zip: on, its sample opens as conjugate heat transfer; the 0.1.1 zip updates it', async ({ page }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const tmp = e2eTemp('ht6-install');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const first = packed(tmp, readFileSync(join(PLUGIN, 'manifest.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1]);
  const next = packed(tmp, '0.1.1');
  const host = await startHost({ name: 'ht6-install', tmp, projects, bundledDir: bundledFolder(tmp, false) });
  const s = settings(page);
  try {
    await page.goto(`${host.base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await s.open();
    await expect(s.row).toHaveCount(0);
    await s.install(first, 'Install Heat Transfer 0.1.0.', 'Heat Transfer 0.1.0 is installed.');
    await expect(s.row.locator('.wiz-plugin-meta').first()).toHaveText(/v0\.1\.0/);
    expect(readdirSync(host.pluginsDir)).toEqual(['heat_transfer']);
    await s.close();
    // A page load reads the new plugin's panels.
    await openTheSample(page, host.base);

    await s.open();
    await s.install(next, 'Update Heat Transfer from 0.1.0 to 0.1.1.', 'Heat Transfer 0.1.1 is installed.');
    await expect(s.row.locator('.wiz-plugin-meta').first()).toHaveText(/v0\.1\.1/);
    await s.close();
    await page.reload();
    await openTheSample(page, host.base);
  } finally {
    host.stop();
  }
});

test('the app as it ships (Heat Transfer bundled): a 0.1.1 zip is used in place of the bundled copy', async ({ page }) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const tmp = e2eTemp('ht6-update');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const next = packed(tmp, '0.1.1');
  const host = await startHost({ name: 'ht6-update', tmp, projects, bundledDir: bundledFolder(tmp, true) });
  const s = settings(page);
  try {
    await page.goto(`${host.base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
    await s.open();
    await expect(s.row).toHaveAttribute('data-plugin-copy', 'app');
    await expect(s.row.locator('.wiz-plugin-meta').first()).toHaveText(/v0\.1\.0 · bundled/);
    await s.install(next, 'Update Heat Transfer from 0.1.0 to 0.1.1.', 'Heat Transfer 0.1.1 is installed.');
    await expect(s.row).toHaveAttribute('data-plugin-copy', 'update');
    await expect(s.row.locator('.wiz-plugin-meta').first()).toHaveText(/v0\.1\.1 · update/);
    await s.close();
    await page.reload();
    await openTheSample(page, host.base);
  } finally {
    host.stop();
  }
});
